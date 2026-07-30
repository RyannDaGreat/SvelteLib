<!--
  CodeEditorModal — THE reusable full-screen (90vw × 90vh) code editor, hosting
  Monaco (the VS Code editor core) for any widget property that is "a lot of
  code": a Mermaid diagram's `definition`, a LaTeX equation's `latex` source, and
  any future code-ish widget (manifest ROUND 2 #32/#33). It is deliberately
  DUMB and PROP-DRIVEN — it owns Monaco's lifecycle and nothing about the
  document — so one component serves every language:

    value     the initial source string (read ONCE at mount; the editor then owns
              its own buffer — later prop changes do NOT clobber what the user typed)
    language  a Monaco language id this app has registered ("mermaid" / "latex" /
              "javascript"), or "plaintext" / null for none
    title     the modal header text
    problem   a problem with the STORED source, shown in the footer (null = none).
              REACTIVE, unlike `value`: the caller recomputes it after each save, so a
              source that will not compile explains itself in the dialog the author is
              looking at instead of only in the console. THE PROJECT SCRIPT
              (core/project_script.js) is the caller that uses it — the app keeps the
              modal OPEN while it is non-null, so a broken script cannot be dismissed
              silently.
    readOnly  Monaco refuses edits. Save is STILL offered (and relabeled "Save a
              Copy"), because the caller may have somewhere else to put the text: a
              BUILT-IN widget's source is read-only here and its Save writes a copy
              into the project. That is why this is not simply "hide Save".
    note      a standing fact about the buffer shown in the footer (e.g. "Built-in —
              Save copies into this project"). Neutral tone; unlike `problem` it is
              not a failure and is always true of what is open.
    onsave    called with the current editor text on Save / Cmd+Enter — the caller
              turns that into ONE undo unit through the app's commit seam
    oncancel  called on Cancel / Esc / backdrop — the caller drops the edit, no undo

  WHY A FULL MODAL, NOT THE INLINE CodeEditController OVERLAY. The user asked for
  "the full VS Code stuff — syntax highlighting, autocomplete, minimap, everything"
  for entering large amounts of code, and pinned it to a 90%×90% modal. Monaco is
  that editor; the inline textarea overlay (web/CodeEditController.svelte) stays as
  the lightweight in-place path but is not what a big diagram wants.

  DIALOG MECHANICS ARE THE SHARED lib/Modal.svelte's, on purpose: it owns the
  backdrop, the portal-to-body (so nothing clips the 90% panel), the focus trap,
  body-scroll lock, and Escape/backdrop dismissal — and because its panel carries
  role="dialog", web/App.svelte's focusContext sees `dialog: true` and the canvas
  shortcut chips stand down while it is open (no app command fires behind the
  editor). Monaco ALSO binds Escape→cancel and Cmd/Ctrl+Enter→save as editor
  commands, so those work while the caret is inside the editor (where Monaco would
  otherwise swallow the key); the Modal's own panel-Escape covers the case where
  focus is on a footer button. Nesting is correct either way: a Monaco widget that
  is open (the suggest/find popup) consumes its own Escape first.

  MONACO + VITE WIRING lives in web/monacoSetup.js (imported for its side effects):
  it wires the editor web worker and registers the Mermaid + LaTeX + JavaScript
  Monarch grammars ONCE. All THREE are this app's own: `editor.api` ships no
  built-in languages at all, so a `language` id it has not registered silently
  renders as uncoloured plaintext (see MONACO_LANGUAGES).

  `monaco-editor` is a real npm dependency (self-contained, offline, no CDN) and is
  pre-bundled in web/vite.config.js's optimizeDeps so its first use never triggers a
  mid-session dep re-optimize (which would reload the page and kill a render/probe —
  the same flake class pdfjs/mathjax/mermaid are pinned for).

  Styling: app.css `.code-modal-*` + `--a-code-modal-*` tokens (the annotator
  convention: web app components carry no <style> block; Monaco draws its own
  vs-dark theme inside the editor host).
-->
<script>
  import { onMount } from "svelte";
  import Modal from "../../../lib/Modal.svelte";
  import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
  import { setupMonacoOnce } from "./monacoSetup.js";
  import { THEMES } from "./app.svelte.js";

  /** Query. Monaco theme for the CURRENT UI theme via its catalog `kind` —
   * "vs-dark" for dark themes, "vs" for light (user ruling: the code editor's
   * dark/light must match the UI theme). data-theme absent = graphite (dark). */
  function monacoThemeForUi() {
    const id = document.documentElement.getAttribute("data-theme") ?? "graphite";
    const kind = THEMES.find((t) => t.id === id)?.kind ?? "dark";
    return kind === "light" ? "vs" : "vs-dark";
  }

  let {
    /** @type {string} Initial source, read once at mount. */
    value = "",
    /** @type {string|null} Monaco language id ("mermaid"/"latex"/"javascript"/null → plaintext). */
    language = null,
    /** @type {string} Modal header title. */
    title = "Code",
    /** @type {string|null} A compile/validation problem with the CURRENTLY STORED
     *  source, shown in the footer. Reactive on purpose (unlike `value`, which the
     *  editor takes ownership of): the caller recomputes it after each save, so the
     *  same dialog that took a broken script reports why it is broken instead of the
     *  author having to hunt for a console line. Null = nothing wrong. */
    problem = null,
    /** @type {boolean} When true Monaco refuses edits (the buffer is a READ-ONLY
     *  view of source this dialog cannot write back to). Save is still offered and
     *  still meaningful — the caller decides what it does with an unmodified buffer;
     *  a BUILT-IN widget's Save COPIES the source into the project, which is the whole
     *  reason a read-only editor is not a dead end here (app.svelte.js's asset scope). */
    readOnly = false,
    /** @type {string|null} A standing NOTE about this buffer's provenance, shown in
     *  the footer (e.g. "Built-in — Save copies into this project"). Unlike `problem`
     *  it is not a failure: it is always true of the thing being edited, so it renders
     *  in a neutral tone and does not displace the keyboard hint. */
    note = null,
    /** @type {(text: string) => void} Called with the current text on Save/Cmd+Enter. */
    onsave = undefined,
    /** @type {() => void} Called on Cancel/Esc/backdrop. */
    oncancel = undefined,
  } = $props();

  // Modal `open` is bindable but we never set it false ourselves: dismissal always
  // routes through oncancel/onsave (which unmount us by clearing app.codeModal), so
  // there is exactly one close path. `true` for our whole lifetime.
  let open = $state(true);
  let hostEl = $state(null); // the div Monaco takes over
  let editor = null;         // the monaco editor instance (plain, not $state — never rendered)

  /** Command. Reads the editor's current text and hands it to the caller as the
   *  value to commit (one undo unit is the caller's concern). Falls back to the
   *  seed `value` if the editor never mounted. */
  function save() {
    onsave?.(editor ? editor.getValue() : value);
  }

  /** Command. Abandons the edit (no commit). */
  function cancel() {
    oncancel?.();
  }

  // Ctrl/Cmd label for the footer hint — cosmetic only (Monaco binds BOTH).
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
  const cmdLabel = isMac ? "⌘" : "Ctrl";

  onMount(() => {
    setupMonacoOnce(monaco); // idempotent: wires the worker + registers grammars once
    // Follow UI theme switches while the modal is open (data-theme is stamped
    // on <html>; the observer dies with the modal via onMount's cleanup).
    const themeObserver = new MutationObserver(() => monaco.editor.setTheme(monacoThemeForUi()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (!hostEl) return themeObserver.disconnect.bind(themeObserver);
    editor = monaco.editor.create(hostEl, {
      value: value ?? "",
      language: language ?? "plaintext",
      theme: monacoThemeForUi(),
      // READ-ONLY when the caller says the buffer cannot be written back (a built-in
      // widget's bundled source). `domReadOnly` as well as `readOnly`: the former makes
      // the underlying textarea itself read-only, so the OS/browser also refuses paste
      // and IME composition rather than swallowing them silently.
      readOnly,
      domReadOnly: readOnly,
      automaticLayout: true,          // track the modal's size (it is 90vw×90vh)
      minimap: { enabled: true },     // the user asked for the minimap explicitly
      fontSize: 14,
      lineNumbers: "on",
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "off",
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      quickSuggestions: true,         // autocomplete as you type (the user's ask)
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: "currentDocument",
      bracketPairColorization: { enabled: true },
    });
    // Editor-scoped keybindings so they work while the caret is INSIDE Monaco
    // (where the plain DOM Escape/Enter would be Monaco's own). Cmd/Ctrl+Enter
    // commits; Escape cancels — matching CodeEditController's contract.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, save);
    editor.addCommand(monaco.KeyCode.Escape, cancel);
    editor.focus();

    // Headless test/dev seam (mirrors window.__powerrp_codeEdit): a probe drives
    // the REAL Monaco model — read/replace the text and commit — without simulating
    // keystrokes. Cleared on unmount.
    window.__powerrp_codeModal = {
      getValue: () => (editor ? editor.getValue() : ""),
      setValue: (v) => editor?.setValue(v),
      save,
      cancel,
      hostRect: () => hostEl?.getBoundingClientRect(),
      // Read off the LIVE editor, not off the prop: the probe's question is "did Monaco
      // actually refuse the edit", and only the editor's own option answers that.
      isReadOnly: () => !!editor?.getOption(monaco.editor.EditorOption.readOnly),
    };

    return () => {
      themeObserver.disconnect();
      editor?.dispose();
      editor = null;
      if (window.__powerrp_codeModal) delete window.__powerrp_codeModal;
    };
  });
</script>

<Modal bind:open size="large" {title} titleIcon="mdi:code-braces" onclose={cancel}>
  <div class="code-modal-root">
    <!-- Monaco takes over this element entirely; kept empty so its internal DOM
         is the only child. -->
    <div class="code-modal-editor" bind:this={hostEl}></div>
    <div class="code-modal-footer">
      <!-- THE PROBLEM LINE, when the caller reports one about the stored source (a
           project script that will not compile). It REPLACES the keyboard hint
           rather than sitting beside it: the hint is standing ceremony the reader
           has already learned by the time anything is broken, and two competing
           lines in a one-line footer is how a real error goes unread. -->
      {#if problem}
        <span class="code-modal-problem" role="alert">{problem}</span>
      {:else if note}
        <!-- A standing fact about the buffer, not a failure: a READ-ONLY built-in
             saying that Save copies it into the project. It takes the hint's slot
             because it is strictly more informative than the keyboard ceremony here —
             the keys still work, but what Save DOES is the thing a reader of a
             read-only editor needs told. -->
        <span class="code-modal-note">{note}</span>
      {:else}
        <span class="code-modal-hint">Esc to cancel · {cmdLabel}+Enter to save</span>
      {/if}
      <span class="code-modal-actions">
        <button type="button" class="code-modal-btn" onclick={cancel}>Cancel</button>
        <!-- The primary action's LABEL names what it will actually do. On a read-only
             built-in that is not "Save" (there is nowhere to save to) but "Save a
             Copy" — a button announcing an outcome it cannot perform is the same class
             of lie as an aria-label that names the wrong gesture. -->
        <button type="button" class="code-modal-btn code-modal-primary" onclick={save}>
          {readOnly ? "Save a Copy" : "Save"}
        </button>
      </span>
    </div>
  </div>
</Modal>
