/*
  equationSuggestKeys — the ONE keyboard for an equation autocomplete input.

  WHY THIS FILE EXISTS. The same five-branch keydown handler was written THREE
  times: web/AngleField.svelte, web/NumericField.svelte and web/Inspector.svelte.
  Not three variations — three token-for-token copies, differing only in
  identifier names (`suggestionsOpen` vs `eqSuggestOpen`, `candidates` vs
  `eqCandidates`). Inspector's own docblock said "NumericField's handler,
  unchanged in behavior", so the third copy was made deliberately and labelled as
  a copy, which is the clearest possible evidence that a shared home was needed
  and could not be found from where the author was standing.

  THE COUNT ITSELF IS THE LESSON. An earlier survey found TWO and missed the
  AngleField copy. Consolidating "both" would have left the third behind, looking
  canonical — one dialect presented as the standard. The set here was derived by
  grepping the handler's SHAPE rather than its name (it has three different
  names), and cross-checked against every importer of core/equationSuggest.js,
  every live `ArrowUp`/`ArrowDown` site, and every suggestion-index identifier in
  the app. Three, and the third is why this is a module and not a patch.

  WHY A FACTORY AND NOT A PURE HELPER. The handler must WRITE `$state` that lives
  in the component (the highlighted index, the open flag), and Svelte 5 runes
  cannot be passed by reference. web/hoverPreview.js's makeHoverPreview set the
  precedent for exactly this situation — a shared behaviour lifted out of one
  field, handed back as plain callbacks the consumer wires itself, owning no
  Svelte effect. Same shape here.

  WHY web/ AND NOT core/. It calls e.target.blur() and e.preventDefault(). core/
  is DOM-free and tests enforce that; the DOM-touching half of a behaviour
  belongs beside the components, which is where makeHoverPreview lives too. The
  DOM-free half — which candidates a partial expression yields — already lives in
  core/equationSuggest.js and is untouched.
*/

/**
 * Command factory. Returns the ONE keydown handler an equation-autocomplete
 * input wires to `onkeydown`. Not pure: the returned handler calls the accessors
 * it is given (which mutate component `$state`), calls the caller's
 * commit/revert commands, and blurs the event target.
 *
 * THE BEHAVIOUR, unchanged from the three copies it replaces:
 *   Up/Down   move the highlight, WRAPPING at both ends — only while the list is
 *             genuinely showing
 *   Tab/Enter accept the highlighted candidate while the list is open; accepting
 *             does NOT commit the field
 *   Enter     with the list CLOSED, commit and blur
 *   Escape    dismiss an OPEN list first, field untouched; a SECOND Escape
 *             reverts and blurs. Both Escapes stopPropagation so the key never
 *             bubbles into Deselect
 *
 * "Open" means `isOpen() && candidates().length > 0` — gated on the LIST being
 * non-empty, not merely on the flag, so Escape reverts IMMEDIATELY when nothing
 * is on screen rather than eating an invisible keystroke.
 *
 * @param {object} io - the component's accessors and commands
 * @param {() => boolean} io.isOpen - is the suggestion list flagged open
 * @param {() => any[]} io.candidates - the current candidate list
 * @param {() => number} io.highlighted - the highlighted index
 * @param {(i: number) => void} io.setHighlighted - move the highlight
 * @param {(open: boolean) => void} io.setOpen - open/close the list
 * @param {(candidate: any) => void} io.accept - take the highlighted candidate
 * @param {() => void} io.commit - commit the typed text (Enter, list closed)
 * @param {() => void} io.revert - discard the draft (Escape, list closed)
 * @returns {(e: KeyboardEvent) => void}
 *
 * @example
 * // const onEqKeydown = makeEquationSuggestKeydown({
 * //   isOpen: () => suggestionsOpen,       candidates: () => candidates,
 * //   highlighted: () => highlighted,      setHighlighted: (i) => (highlighted = i),
 * //   setOpen: (v) => (suggestionsOpen = v), accept: acceptCandidate,
 * //   commit: commitText,                  revert: revertDraft,
 * // });
 * // <input onkeydown={onEqKeydown} />
 * @example
 * // ArrowUp on the FIRST of three candidates wraps to the last:
 * // setHighlighted receives 2, and the event is preventDefault()ed so the
 * // caret does not jump to the start of the input.
 */
export function makeEquationSuggestKeydown(io) {
  return function onEquationSuggestKeydown(e) {
    const list = io.candidates();
    const showing = io.isOpen() && list.length > 0;

    if (showing && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const step = e.key === "ArrowDown" ? 1 : -1;
      io.setHighlighted((io.highlighted() + step + list.length) % list.length);
      e.preventDefault();
    } else if (showing && (e.key === "Tab" || e.key === "Enter")) {
      io.accept(list[io.highlighted()]);
      e.preventDefault();
    } else if (e.key === "Enter") {
      io.commit();
      e.target.blur();
    } else if (e.key === "Escape" && showing) {
      io.setOpen(false);
      e.stopPropagation(); // dismiss-only: field/draft untouched, don't bubble into Deselect
    } else if (e.key === "Escape") {
      io.revert();
      e.target.blur();
      e.stopPropagation(); // don't let Escape bubble into Deselect
    }
  };
}
