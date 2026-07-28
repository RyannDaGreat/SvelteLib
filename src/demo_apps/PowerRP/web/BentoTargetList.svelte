<!--
  BentoTargetList — STEP 1'S SECOND INPUT PATH: pick the widget to bind from a
  LIST instead of clicking it on the canvas.

  ── WHY A LIST EXISTS AT ALL ─────────────────────────────────────────────────
  A canvas-only picker fails exactly when you need it: the widget you want is
  occluded by something on top, or tiny, or scrolled off-screen, or sitting under
  the very grid you are binding into. web/bentoBind.js's step 0 already accounts
  for that (it reads the press as a point in the grid's frame rather than a
  hit-test, precisely because a widget is usually already on the grid); this is the
  same problem one step later. The user asked for it in those terms: "it would let
  me select from a list of objects too, in case I can't select the one I want
  inside the GUI."

  NOT a floating miniature of the bento — explicitly considered and rejected by the
  user ("Actually, no, no, no, it doesn't do that").

  ── WHAT IS REUSED, AND WHY THERE IS NO NEW LIST ─────────────────────────────
  The audit ruled against reinventing dropdown/scroll/list GUIs, and there is no
  headless list primitive in src/lib to build on. So this borrows the two things a
  list actually needs from the surface that already has them, by CLASS:

    .palette-item / .highlighted / .unavailable — the row, its hover state and its
      greyed state. Unscoped, generic (a flex row with a hover background and a
      disabled opacity), and already the app's one reading for "a row you can pick".
    .tool-tip-requires — the reason a greyed row is greyed. app.css documents this
      one as deliberately cross-surface: "the AVAILABILITY footnote is one sentence
      style wherever a disabled control explains itself".

  The SHELL is FloatingCanvasPanel (the widget toolbar and handle toolbar ride the
  same one), so placement, the above/below flip, the pointer-event discipline and
  the no-transform rule are not re-decided here.

  ONE new rule, `.canvas-toolbar-list`, for the scroll container — and it is capped
  by `--a-canvas-toolbar-max-h`, the SAME token FloatingCanvasPanel reads for its
  flip decision, exactly as `.canvas-toolbar-grid` is. Using the palette's own
  `--a-palette-max-h` here would let the panel grow past the height its flip
  threshold assumes, which is the drift the panel's docstring exists to prevent.

  WHAT IS NOT BUILT, and handed back rather than forked: a FILTER/search field.
  That is the part that genuinely needs the still-unpromoted headless
  FilterableList — a fourth hand-rolled fuzzy-filtered list is exactly what the
  audit forbids. The list is bounded by one slide's widget count and scrolls.

  ── AVAILABILITY GREYS, IT DOES NOT HIDE ─────────────────────────────────────
  A widget that cannot be bound (a group member, an endpoint widget) is SHOWN,
  greyed, with its reason — the palette's ruling, "Rendered DISABLED, never
  hidden", because hiding makes the tool unlearnable. A group member silently
  absent would leave the user hunting for a widget that is right there.
  `aria-disabled`, never the native `disabled` attribute: a disabled button fires
  no pointer events, so it could not report why it is disabled. The guard lives in
  the click handler instead — the palette's own note, for the same reason.

  ── HOVER FEEDBACK IS OWED, AND THE KIND IS *TARGET* ─────────────────────────
  Per the user ruling ("Everything that can give hover feedback should always have
  hover feedback"), hovering a NAME highlights that WIDGET on the canvas — which is
  the entire point of the list, since its premise is that you cannot pick the
  widget visually. It is delivered by handing the hovered node back to bentoBind's
  ONE `hover` record, so a row's highlight IS the canvas highlight rather than a
  second thing that resembles it.

  ONE `$effect` KEYED ON `activeIndex` drives it — the FontPicker's structure, and
  the reason is the doctrine's: "Keyboard focus is hover. Arrowing through a list
  must preview exactly as pointing does … Two paths would drift." Pointing sets
  `activeIndex` today; a future arrow-key binding sets the same variable and
  inherits the preview with no second path. (Those keys are NOT bound here: a key
  that fires inside a canvas mode has to be a registry entry scoped to that mode,
  which is a contract extension plus a keycap choice, and keycaps are not Claude's
  to invent.)

  Nothing here writes to the document — hovering and listing are questions. Leaving
  the list clears the candidate.

  No <style> block (app-shell convention: every rule in app.css, every value an
  --a-* token). No native title= (banned; Tooltip is the house affordance, and the
  greyed reason is inline here rather than in a tip because it must be readable
  without a second hover).
-->
<script>
  import FloatingCanvasPanel, { widgetPanelAnchor } from "./FloatingCanvasPanel.svelte";
  import { bindableTargets } from "./bentoBind.js";

  // `node` is the GRID widget's render node (the panel hangs off it and it owns the
  // cell anchor); `cellLabel` names the aimed cell in the header; `onhover(node|null)`
  // and `onpick(node)` hand the row back to the mode, which owns every write.
  let { app, node, cellLabel, worldToScreen, onhover, onpick } = $props();

  // NOT $derived over app.nodes() per event: this is the slide's widget list, which
  // changes only when the document does, and $derived already tracks exactly that.
  let rows = $derived(bindableTargets(app, node));
  let anchor = $derived(widgetPanelAnchor(node, worldToScreen));

  // Which row the pointer (or, later, the keyboard) is on. -1 = none.
  let activeIndex = $state(-1);

  // Has this list actually PUSHED a hover? See the effect below — this is the whole
  // reason the flag exists, and it is not a micro-optimisation.
  let pushedHover = false;

  // THE ONE PREVIEW PATH. Keyed on activeIndex so pointing and any future arrowing
  // share it. A greyed row previews NOTHING: it cannot be picked, so highlighting the
  // widget it names would promise an action that will not happen — the doctrine's "a
  // greyed row owes EXPLANATION but must not PREVIEW".
  //
  // IT NEVER CLEARS A HOVER IT DID NOT SET, and that guard is load-bearing: the hover
  // record is SHARED with the canvas, and this effect runs once on MOUNT with
  // activeIndex at -1. Without the guard, the list appearing the instant a cell is
  // aimed wiped the canvas's own hover candidate — measured, as a live probe failure
  // (the aimed cell drew hot with no ghost companion). The list owns only the hover it
  // pushed.
  $effect(() => {
    const row = rows[activeIndex];
    const target = row && !row.refusal ? row.node : null;
    if (!target && !pushedHover) return;
    pushedHover = !!target;
    onhover(target);
  });
</script>

<FloatingCanvasPanel x={anchor.x} topY={anchor.topY} bottomY={anchor.bottomY} label="Widgets to bind into this cell">
  <div class="palette-crumbs">Bind into {cellLabel}</div>
  <!-- onpointerleave on the CONTAINER, not per row: moving between rows must not
       flicker the canvas highlight off and on between them. -->
  <div class="canvas-toolbar-list" onpointerleave={() => (activeIndex = -1)}>
    {#each rows as row, i (row.itemId)}
      <button
        class="palette-item"
        data-item-id={row.itemId}
        class:highlighted={i === activeIndex}
        class:unavailable={!!row.refusal}
        aria-disabled={!!row.refusal}
        onpointermove={() => (activeIndex = i)}
        onclick={() => !row.refusal && onpick(row.node)}
      >
        <span class="title">{row.name}</span>
        {#if row.refusal}
          <span class="tool-tip-requires">{row.refusal}</span>
        {/if}
      </button>
    {/each}
    {#if !rows.length}
      <div class="palette-none">Nothing else on this slide to bind</div>
    {/if}
  </div>
</FloatingCanvasPanel>
