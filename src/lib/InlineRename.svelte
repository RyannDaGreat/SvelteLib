<!--
  InlineRename [visual, general] — in-place text editing for a name.

  Renders the consumer's OWN display markup (the `children` snippet, so the
  host keeps its typography, ellipsis rules and layout) until the editor is
  ACTIVATED; then that markup is swapped for an `<input>` pre-filled with
  `value`, focused, and with ALL TEXT SELECTED.

  SELECT-ALL IS THE POINT (user ruling): "When I click to rename, or I double
  click a slide to edit the name, it should by default select all the text — so
  that if I simply start typing it would rename the whole thing. Of course I
  could always press the arrow key to rename part of it, but that should be the
  default." Typing therefore REPLACES the name; ArrowLeft/ArrowRight or a click
  collapse the selection natively and typing then appends/inserts. That second
  half needs no code — it is what a browser already does to a selected range —
  but it is asserted in the demo's probe so a future focus rewrite cannot
  silently break it.

  THE FOCUS/SELECT TIMING IS THE WHOLE IMPLEMENTATION, and it is why this is a
  component rather than three lines copied into each consumer. In Svelte 5 the
  `<input>` does not exist until the `{#if editing}` block renders, and its
  `value` is not on the DOM node until the binding lands. `autofocus` alone
  focuses but selects nothing; an `$effect` that reads `editing` runs BEFORE the
  DOM is updated, so `inputEl` is either null or still carries the PREVIOUS
  value — selecting an empty or stale range. The fix is to defer to a
  microtask AFTER the DOM flush (`tick()`), then focus and select in that
  order. Verified empirically in the demo probe, not assumed.

  CANCEL SEMANTICS (user ruling): "When I'm renaming a slide, clicking away
  should cancel." Enter commits (fires `onrename` with the new value — the
  CONSUMER owns the actual write, this component never mutates anything);
  Escape cancels; BLUR cancels. A half-typed name must never be committed by
  wandering focus, so blur is a cancel and not a commit. Nothing at all is
  emitted on cancel — no `onrename`, no empty-string call — so a consumer can
  treat any `onrename` it receives as an intentional commit.

  A commit whose trimmed value is EMPTY or UNCHANGED is also a no-op: renaming a
  thing to "" or to what it already was is not an edit, and firing `onrename`
  for it would push a pointless undo entry in every consumer.

  Trigger (`trigger` prop) — which gesture opens the editor:
    - "dblclick" (DEFAULT) for a display that already OWNS its single click
      (a slide card whose click SELECTS the slide; rename must be the second
      gesture or it would fight navigation).
    - "click" for a display with no first gesture to lose (a toolbar title).
    - "none" for programmatic-only opening: bind the component and call
      `open()` from a menu item or command.
  Keyboard: Enter or F2 activates from the display when it is focused, on every
  trigger including "none", so the editor is always reachable without a pointer.

  Usage (double-click a slide name; the consumer performs the write):
    <InlineRename
      value={slide.name}
      onrename={(name) => app.renameSlide(i, name)}
      ariaLabel={`Rename slide ${i + 1}`}
    >
      {#snippet children()}<span class="name">{slide.name}</span>{/snippet}
    </InlineRename>

  Usage (single click, as the toolbar title):
    <InlineRename value={name} trigger="click" onrename={rename}>
      {#snippet children()}<h1>{name}</h1>{/snippet}
    </InlineRename>

  Usage (opened from a command; no pointer trigger of its own):
    <InlineRename bind:this={editor} value={name} trigger="none" onrename={rename}>
      {#snippet children()}<span>{name}</span>{/snippet}
    </InlineRename>
    <button onclick={() => editor.open()}>Rename…</button>

  Styling — the input is deliberately MINIMAL and inherits the surrounding
  font/color so it lands where the display text was. Override per consumer:

    --inline-rename-bg        input background   (← --control-bg → transparent)
    --inline-rename-fg        input text color   (inherit)
    --inline-rename-border    input border color (← --accent → currentColor)
    --inline-rename-radius    corner radius      (2px)
    --inline-rename-padding   input padding      (0 2px)
-->
<script>
  import { tick } from "svelte";

  let {
    value = "",
    trigger = "dblclick",
    onrename = undefined,
    ariaLabel = "Rename",
    children,
  } = $props();

  let editing = $state(false);
  let draft = $state("");
  let inputEl = $state(null);

  /**
   * Command. Opens the editor: seeds the draft from `value`, then — AFTER the
   * DOM flush that creates the input — focuses it and selects ALL of its text.
   *
   * The `await tick()` is load-bearing, not defensive: before it, `inputEl` is
   * null on the first open and holds the PREVIOUS render's value on a reopen,
   * so selecting there would select nothing or a stale range.
   *
   * Exported so a consumer can open the editor from a menu item or command
   * (`trigger="none"`), which is the only way to open one that has no gesture.
   *
   * Examples:
   *     >>> // editor.open() → input appears, focused, "Slide 1" fully selected
   */
  export async function open() {
    if (editing) return;
    draft = value;
    editing = true;
    await tick();
    if (!inputEl) return;
    inputEl.focus();
    inputEl.select();
  }

  /**
   * Command. Closes the editor WITHOUT emitting — the cancel path for Escape
   * and for blur. Emits nothing at all, so any `onrename` a consumer sees is an
   * intentional commit.
   */
  function cancel() {
    editing = false;
  }

  /**
   * Command. Closes the editor and emits the trimmed draft via `onrename`,
   * unless it is empty or unchanged — neither is an edit, and emitting would
   * push a no-op undo entry in the consumer.
   */
  function commit() {
    const name = draft.trim();
    editing = false;
    if (name && name !== value) onrename?.(name);
  }

  /** Command. Enter commits, Escape cancels; both are consumed so neither also
   *  reaches the host app's global keys (Escape especially — it would otherwise
   *  deselect or close a panel behind this editor). */
  function editorKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else {
      // Typing must never trigger the host's single-key shortcuts.
      e.stopPropagation();
    }
  }

  /** Command. Enter/F2 opens the editor from the focused DISPLAY, so rename is
   *  reachable by keyboard under every trigger, "none" included. */
  function displayKeydown(e) {
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      open();
    }
  }
</script>

{#if editing}
  <input
    class="inline-rename-input"
    type="text"
    bind:this={inputEl}
    bind:value={draft}
    onkeydown={editorKeydown}
    onblur={cancel}
    onclick={(e) => e.stopPropagation()}
    ondblclick={(e) => e.stopPropagation()}
    autocomplete="off"
    spellcheck="false"
    aria-label={ariaLabel}
  />
{:else}
  <!-- The display is a plain span wrapper, NOT a button: the consumer's snippet
       supplies its own markup and may itself contain interactive elements, and
       nesting those inside a button is invalid HTML. It takes a tabindex so the
       Enter/F2 keyboard path has something to focus; role="button" names what
       that focus does. -->
  <span
    class="inline-rename-display"
    role="button"
    tabindex="0"
    aria-label={ariaLabel}
    onclick={trigger === "click" ? (e) => { e.stopPropagation(); open(); } : undefined}
    ondblclick={trigger === "dblclick" ? (e) => { e.stopPropagation(); open(); } : undefined}
    onkeydown={displayKeydown}
  >{@render children?.()}</span>
{/if}

<style>
  /* `display: contents` so the wrapper adds NO box of its own — the consumer's
     snippet lands in the host's layout exactly as if this component were not
     here, which is what lets a flex/grid row keep working unchanged. */
  .inline-rename-display {
    display: contents;
  }

  .inline-rename-input {
    --inline-rename-bg: var(--control-bg, transparent);
    --inline-rename-fg: inherit;
    --inline-rename-border: var(--accent, currentColor);
    --inline-rename-radius: 2px;
    --inline-rename-padding: 0 2px;

    /* Inherit the surrounding typography so the editor sits where the display
       text was instead of jumping to the browser's default input font. */
    font: inherit;
    color: var(--inline-rename-fg);
    background: var(--inline-rename-bg);
    border: 1px solid var(--inline-rename-border);
    border-radius: var(--inline-rename-radius);
    padding: var(--inline-rename-padding);
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
</style>
