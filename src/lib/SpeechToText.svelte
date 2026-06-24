<!--
  SpeechToText [headless, general] — live client-side speech-to-text.

  Wraps the browser-native Web Speech API (window.SpeechRecognition /
  webkitSpeechRecognition). No audio leaves the page through *our* code, but
  note Chrome routes recognition through a cloud service. Chromium-only
  (Chrome / Edge); reports `unsupported` elsewhere.

  Streaming model: with interimResults on, the engine emits a live, unstable
  "interim" transcript (words pop up as you speak) that it keeps revising, then
  promotes a stabilized "final" result once it's confident. Each final result is
  appended to `segments` (the log); `interim` always holds the current in-flight
  phrase. This interim→final promotion is the API's built-in equivalent of a
  short lookahead — the engine waits a beat to get the words right.

  Renders nothing itself — passes state + actions to a children snippet.

  Usage:
    <SpeechToText bind:segments bind:recording>
      {#snippet children(state, actions)}
        <button onclick={actions.toggle}>
          {state.recording ? 'Stop' : 'Record'}
        </button>
        <p>{state.interim}</p>
        <ul>{#each state.segments as s}<li>{s.text}</li>{/each}</ul>
      {/snippet}
    </SpeechToText>
-->
<script>
  /**
   * @typedef {Object} Segment
   * @property {string} text - A finalized (stabilized) transcript phrase
   * @property {number} at - Wall-clock timestamp (ms) when committed
   */

  /**
   * @typedef {Object} SttState
   * @property {'idle'|'listening'|'error'|'unsupported'} status
   * @property {boolean} recording
   * @property {string} interim - Live, still-changing transcript of the current phrase
   * @property {Segment[]} segments - Log of finalized phrases
   * @property {string|null} error
   * @property {boolean} supported
   */

  /**
   * @typedef {Object} SttActions
   * @property {() => void} start
   * @property {() => void} stop
   * @property {() => void} toggle
   * @property {() => void} clear - Clear the log and interim text
   */

  // -- Pure helpers (general) -------------------------------------------------

  /**
   * Pure function, general. Split recognition results (from a start index) into
   * committed final transcripts and the trailing interim text. Operates on a
   * plain array so it's testable without a live SpeechRecognitionEvent.
   *
   * @param {{isFinal: boolean, transcript: string}[]} results
   * @param {number} fromIndex - First result to read (event.resultIndex)
   * @returns {{finals: string[], interim: string}}
   *
   * @example
   * splitResults(
   *   [{isFinal: true, transcript: 'hello '}, {isFinal: false, transcript: 'wor'}],
   *   0,
   * ) // { finals: ['hello '], interim: 'wor' }
   *
   * @example
   * splitResults([{isFinal: false, transcript: 'um'}], 0) // { finals: [], interim: 'um' }
   */
  function splitResults(results, fromIndex) {
    const finals = [];
    let interim = "";
    for (let i = fromIndex; i < results.length; i++) {
      const r = results[i];
      if (r.isFinal) finals.push(r.transcript);
      else interim += r.transcript;
    }
    return { finals, interim };
  }

  /**
   * Query (reads window). The SpeechRecognition constructor, or null if the
   * browser lacks the Web Speech API.
   *
   * @returns {typeof SpeechRecognition | null}
   *
   * @example getRecognitionCtor() // window.SpeechRecognition in Chrome, null in Firefox
   */
  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  // Recognition errors that are part of normal continuous operation (the engine
  // stops on its own; we simply restart) vs. fatal ones that should halt.
  const FATAL_ERRORS = ["not-allowed", "service-not-allowed", "language-not-supported"];

  // -- Props ------------------------------------------------------------------

  let {
    /** BCP-47 language tag for recognition (e.g. 'en-US', 'es-ES'). */
    lang = "en-US",
    /** Keep listening across phrases (vs. stopping after the first). */
    continuous = true,
    /** Emit live interim transcripts (words appear as you speak). */
    interimResults = true,
    /** Restart automatically when the engine ends mid-session (it times out on silence). */
    autoRestart = true,
    /** Two-way: is the recognizer actively listening. */
    recording = $bindable(false),
    /** Two-way: the log of finalized phrases. */
    segments = $bindable([]),
    /** Called with each new finalized Segment. */
    onsegment,
    /** Called with the latest interim string on every revision. */
    oninterim,
    /** Called with an error message string. */
    onerror,
    children,
  } = $props();

  // -- State ------------------------------------------------------------------

  const supported = typeof window !== "undefined" && !!getRecognitionCtor();

  let status = $state(supported ? "idle" : "unsupported");
  let interim = $state("");
  let errorMsg = $state(null);

  /** @type {SpeechRecognition | null} */
  let rec = null;
  // True while we *want* to be listening — drives auto-restart after the engine
  // ends or hits a benign error. Distinct from `recording`, which mirrors the
  // engine's actual running state.
  let wantListening = false;

  // -- Engine wiring ----------------------------------------------------------

  /**
   * Command. Lazily construct the SpeechRecognition instance and bind handlers.
   * Mutates `rec`.
   */
  function ensureRec() {
    if (rec) return;
    const Ctor = getRecognitionCtor();
    rec = new Ctor();
    rec.continuous = continuous;
    rec.interimResults = interimResults;

    rec.onresult = (e) => {
      const arr = [];
      for (let i = 0; i < e.results.length; i++) {
        arr.push({ isFinal: e.results[i].isFinal, transcript: e.results[i][0].transcript });
      }
      const { finals, interim: live } = splitResults(arr, e.resultIndex);
      for (const t of finals) commit(t);
      interim = live;
      oninterim?.(live);
    };

    rec.onerror = (e) => {
      if (FATAL_ERRORS.includes(e.error)) {
        wantListening = false;
        fail(e.error);
      } else {
        // Benign (e.g. 'no-speech', 'aborted', 'network' blip) — onend restarts.
        console.warn("[SpeechToText] recognition error:", e.error);
      }
    };

    rec.onend = () => {
      if (wantListening && autoRestart) {
        rec.start();
      } else {
        recording = false;
        if (status === "listening") status = "idle";
      }
    };
  }

  /**
   * Command. Append a finalized phrase to the log. Mutates `segments`,
   * clears `interim`, fires onsegment. No-op for empty/whitespace text.
   */
  function commit(text) {
    const clean = text.trim();
    if (!clean) return;
    const seg = { text: clean, at: Date.now() };
    segments = [...segments, seg];
    interim = "";
    onsegment?.(seg);
  }

  /** Command. Record an error: set state, log, notify. Mutates status/errorMsg. */
  function fail(message) {
    errorMsg = message;
    status = "error";
    recording = false;
    console.error("[SpeechToText]", message);
    onerror?.(message);
  }

  // -- Actions ----------------------------------------------------------------

  function start() {
    if (!supported) {
      fail("Web Speech API not supported in this browser");
      return;
    }
    if (recording) return;
    ensureRec();
    rec.lang = lang;
    errorMsg = null;
    wantListening = true;
    status = "listening";
    recording = true;
    rec.start();
  }

  function stop() {
    if (!rec || !recording) return;
    wantListening = false;
    rec.stop();
    recording = false;
    status = "idle";
    interim = "";
  }

  function toggle() {
    recording ? stop() : start();
  }

  function clear() {
    segments = [];
    interim = "";
  }

  const actions = { start, stop, toggle, clear };

  // Also expose actions as instance methods (bind:this) for callers that drive
  // the recognizer from outside the children snippet (e.g. a global key handler).
  export { start, stop, toggle, clear };

  // Reactive view object — getters preserve reactivity when read inside the snippet.
  const view = {
    get status() {
      return status;
    },
    get recording() {
      return recording;
    },
    get interim() {
      return interim;
    },
    get segments() {
      return segments;
    },
    get error() {
      return errorMsg;
    },
    get supported() {
      return supported;
    },
  };
</script>

{@render children?.(view, actions)}
