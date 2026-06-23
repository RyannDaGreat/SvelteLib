<!--
  App — Video Slice Annotator shell.

  Layout (matches the design notes): a horizontal split [thumbnail list | main],
  and a vertical split inside main [pan/zoom video | timeline + transport]. A
  Blender-style HintBar runs along the bottom. The headless Player drives the
  video in VideoPane while the AnnotateBar timeline + transport drive the Player.
  Edits (segments + comments) go through an undo/redo transaction log and are
  persisted to the backend per video.
-->
<script>
  import "iconify-icon";
  import SplitPane from "../../../lib/SplitPane.svelte";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import AnnotateBar from "../../../lib/AnnotateBar.svelte";
  import HintBar from "../../../lib/HintBar.svelte";
  import { Player } from "../../../lib/player.svelte.js";
  import { paintSegments } from "../../../lib/segments.js";
  import { formatTimeMinSec, speedItems } from "../../../lib/format.js";
  import * as api from "./api.js";
  import ThumbList from "./ThumbList.svelte";
  import VideoPane from "./VideoPane.svelte";

  const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8, 16];

  let videos = $state([]);
  let currentName = $state(null);
  let segments = $state([]);
  let comments = $state([]);
  let captured = $state(false);

  let hSplits = $state([0.2]); // [thumbnails | main]
  let vSplits = $state([0.62]); // [video | timeline]

  const player = new Player(() => segments);
  /** @type {ReturnType<typeof AnnotateBar>|undefined} */
  let bar = $state(undefined);

  // -- Load / save ------------------------------------------------------------

  $effect(() => {
    api.listVideos().then((v) => (videos = v)).catch((e) => console.error(e));
  });

  async function loadVideo(name) {
    player.pause();
    currentName = name;
    const data = await api.loadAnnotation(name);
    segments = data.labels ?? [];
    comments = (data.comments ?? []).map((c) => ({ id: crypto.randomUUID(), time: c.time, text: c.text }));
    past = [];
    future = [];
    prevState = snapshot();
    player.seekTo(0);
  }

  let saveTimer = null;
  function scheduleSave() {
    if (!currentName) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.saveAnnotation(currentName, {
        labels: segments,
        comments: comments.map((c) => ({ time: c.time, text: c.text })),
      }).catch((e) => console.error(e));
    }, 400);
    // reflect annotated state in the thumbnail list immediately
    const annotated = segments.length > 0 || comments.length > 0;
    videos = videos.map((v) => (v.name === currentName ? { ...v, hasAnnotations: annotated } : v));
  }

  // -- Undo / redo (transaction log over {segments, comments}) -----------------

  let past = $state([]);
  let future = $state([]);
  let prevState = null;

  const snapshot = () => JSON.parse(JSON.stringify({ segments, comments }));

  function commitTx() {
    const now = snapshot();
    if (prevState && JSON.stringify(now) === JSON.stringify(prevState)) return;
    if (prevState) {
      past = [...past, prevState];
      future = [];
    }
    prevState = now;
    scheduleSave();
  }
  function applyState(s) {
    segments = JSON.parse(JSON.stringify(s.segments));
    comments = JSON.parse(JSON.stringify(s.comments));
    prevState = snapshot();
    scheduleSave();
  }
  function undo() {
    if (!past.length) return;
    future = [...future, snapshot()];
    const s = past[past.length - 1];
    past = past.slice(0, -1);
    applyState(s);
  }
  function redo() {
    if (!future.length) return;
    past = [...past, snapshot()];
    const s = future[future.length - 1];
    future = future.slice(0, -1);
    applyState(s);
  }

  // -- AnnotateBar callbacks --------------------------------------------------

  let paintBase = [];
  let wasPlaying = false;

  function onPaintStart() {
    paintBase = segments;
    wasPlaying = player.playing;
    if (player.playing) player.pause();
  }
  function onPaint(mode, t0, t1) {
    segments = paintSegments(paintBase, mode, t0, t1);
  }
  function onPaintEnd() {
    commitTx();
    if (wasPlaying) player.play();
  }
  function onScrub(t) {
    player.seekTo(t, true);
  }
  function onHover(t) {
    if (!player.playing) player.seekTo(t, true);
  }

  // -- Keyboard: undo / redo --------------------------------------------------

  $effect(() => {
    function onKey(e) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // -- Context hints ----------------------------------------------------------

  let hints = $derived(
    captured
      ? [
          [["mouse_left"], "Scrub"],
          [["Shift"], "Fine 4×"],
          [["mouse_left"], "Good"],
          [["mouse_right"], "Bad"],
          [["alt", "mouse_left"], "Erase"],
          [["mouse_middle"], "Pan"],
          [["Esc"], "Exit"],
        ]
      : [
          [["mouse_left"], "Good"],
          [["mouse_right"], "Bad"],
          [["alt", "mouse_left"], "Erase"],
          [["mouse_middle"], "Pan"],
          [["mouse_scroll"], "Zoom"],
          [["mouse_left"], "Scrub-lock"],
          [["C"], "Comment"],
          [["Ctrl", "Z"], "Undo"],
        ],
  );
</script>

<div class="app">
  <div class="main-split">
    <SplitPane orientation="horizontal" bind:splits={hSplits} minPaneSize={0.12}>
      {#snippet children(i)}
        {#if i === 0}
          <ThumbList {videos} {currentName} onselect={loadVideo} />
        {:else}
          <SplitPane orientation="vertical" bind:splits={vSplits} minPaneSize={0.18}>
            {#snippet children(j)}
              {#if j === 0}
                {#if currentName}
                  <VideoPane {player} src={api.videoUrl(currentName)} proxySrc={api.lowresUrl(currentName)} />
                {:else}
                  <div class="placeholder">Pick a clip from the list →… ←</div>
                {/if}
              {:else}
                <div class="timeline-pane">
                  <AnnotateBar
                    bind:this={bar}
                    bind:captured
                    duration={player.duration}
                    currentTime={player.currentTime}
                    {segments}
                    bind:comments
                    onseek={onScrub}
                    onpaintstart={onPaintStart}
                    onpaint={onPaint}
                    onpaintend={onPaintEnd}
                    onhover={onHover}
                    oncommentjump={(t) => player.animateSeekTo(t)}
                    oncommentschange={commitTx}
                  />

                  <div class="transport">
                    <button onclick={() => player.seekTo(0)} title="Rewind to start">
                      <iconify-icon icon="mdi:skip-previous" width="20" height="20"></iconify-icon>
                    </button>
                    <button class="play-all" class:active={player.playing && player.playMode === "all"} onclick={() => player.toggleMode("all")} title="Play all">
                      <iconify-icon icon={player.playing && player.playMode === "all" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
                    </button>
                    <button class="play-good" class:active={player.playing && player.playMode === "good"} onclick={() => player.toggleMode("good")} title="Play good regions">
                      <iconify-icon icon={player.playing && player.playMode === "good" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
                    </button>
                    <button class="play-bad" class:active={player.playing && player.playMode === "bad"} onclick={() => player.toggleMode("bad")} title="Play bad regions">
                      <iconify-icon icon={player.playing && player.playMode === "bad" ? "mdi:pause" : "mdi:play"} width="22" height="22"></iconify-icon>
                    </button>
                    <button class:active={player.looped} onclick={player.toggleLoop} title="Toggle loop">
                      <iconify-icon icon={player.looped ? "mdi:repeat" : "mdi:repeat-off"} width="20" height="20"></iconify-icon>
                    </button>

                    <span class="sep"></span>
                    <button onclick={undo} disabled={!past.length} title="Undo (Ctrl+Z)">
                      <iconify-icon icon="mdi:undo" width="20" height="20"></iconify-icon>
                    </button>
                    <button onclick={redo} disabled={!future.length} title="Redo (Ctrl+Shift+Z)">
                      <iconify-icon icon="mdi:redo" width="20" height="20"></iconify-icon>
                    </button>
                    <button onclick={() => bar?.addCommentAt(player.currentTime)} title="Add comment (C)" disabled={!currentName}>
                      <iconify-icon icon="mdi:comment-plus" width="20" height="20"></iconify-icon>
                    </button>

                    <span class="spacer"></span>
                    <Dropdown items={speedItems(SPEEDS)} value={player.playbackRate} onchange={player.setRate} />
                    <span class="time">{formatTimeMinSec(player.currentTime)} / {formatTimeMinSec(player.duration)}</span>
                  </div>
                </div>
              {/if}
            {/snippet}
          </SplitPane>
        {/if}
      {/snippet}
    </SplitPane>
  </div>

  <HintBar {hints} />
</div>

