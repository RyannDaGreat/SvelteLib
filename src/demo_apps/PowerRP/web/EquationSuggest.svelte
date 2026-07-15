<!--
  EquationSuggest — the equation autocomplete dropdown (manifest "EQUATION
  DISCOVERABILITY — Blender data-path standard": typing `self.` or `<slug>.`
  offers the item's ACTUAL properties; bare identifiers offer slugs +
  variables). Ranking/candidate discovery is core/equationSuggest.js (pure,
  DOM-free); this component is presentation only — an absolutely-positioned
  list anchored UNDER a caller-supplied anchor element.

  DECOUPLED FROM THE INPUT ON PURPOSE (manifest DESIGN BOUND: the equation
  language "might eventually expand into a whole language type thing" with
  multi-line — "don't corner the field"). This component takes only
  `{candidates, anchor}` — no reference to an <input>'s internals, no
  assumption about single-line text. NumericField (today's ONE consumer)
  computes the candidates from its own cursor position and re-renders this
  as a plain overlay; a future multi-line editor could reuse it unchanged by
  supplying candidates + an anchor rect from wherever its own caret lives.

  WHY NOT SvelteLib's Dropdown: Dropdown owns its OWN trigger button and
  closes on select (a single-shot picker idiom) — it has no notion of
  "stay open while the caller keeps typing, re-rank every keystroke,
  Tab/Enter accepts without closing the KEYBOARD FOCUS" (focus must stay in
  the text input the whole time, never move to the dropdown). Retrofitting
  those semantics onto Dropdown would fight its trigger-owns-open-state
  design more than a small purpose-built list costs. Styled directly by
  app.css tokens (--a-*) rather than Dropdown's --dd-* custom properties,
  since this isn't a Dropdown instance — no visual drift risk either way,
  both chain to the same --a-* ambient tokens the rest of the Inspector uses.

  Keyboard is owned by the CALLER (NumericField's onkeydown already handles
  Enter/Escape for commit/revert) — this component exposes highlighted index
  navigation as plain props/callbacks so one keydown handler stays authoritative
  (avoids the two-listeners-fighting-over-one-keystroke class of bug).
-->
<script>
  import "iconify-icon";

  let { candidates = [], highlighted = 0, anchorEl = null, onhover, onpick } = $props();

  let listEl = $state(null);

  // Keep the keyboard-highlighted row in view as `highlighted` moves —
  // mirrors CommandPalette's scrollHighlightedIntoView precedent.
  $effect(() => {
    highlighted;
    listEl?.querySelectorAll(".eqs-item")[highlighted]?.scrollIntoView({ block: "nearest" });
  });

  const KIND_ICON = { property: "mdi:cube-outline", slug: "mdi:shape-outline", variable: "mdi:variable", keyword: "mdi:key-variant" };
</script>

{#if candidates.length && anchorEl}
  <div class="eqs-menu" bind:this={listEl} role="listbox">
    {#each candidates as c, i}
      <!-- onmousedown preventDefault: a normal click would BLUR the text input
           first (focus moves to this button on mousedown, before the click
           event fires) — that blur would commit/revert the field before
           onpick ever runs. Blocking the default mousedown focus-steal keeps
           focus in the input the whole time, so accepting a suggestion feels
           like it never left the field (spec: keyboard focus stays put). -->
      <button
        type="button"
        class="eqs-item"
        class:eqs-active={i === highlighted}
        role="option"
        aria-selected={i === highlighted}
        tabindex="-1"
        onpointerenter={() => onhover?.(i)}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => onpick?.(c)}
      >
        <iconify-icon icon={KIND_ICON[c.kind] ?? "mdi:help"} width="13" height="13"></iconify-icon>
        <span class="eqs-text">{c.text}</span>
      </button>
    {/each}
  </div>
{/if}
