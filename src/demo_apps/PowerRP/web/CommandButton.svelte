<script>
  /**
   * THE ICON BUTTON FOR A COMMAND-REGISTRY ENTRY — one control that reads its own
   * icon, its own label and its own reason-for-being-dead from the registry, and
   * that obeys the app's disabled law by construction.
   *
   * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
   * The law (CLAUDE.md, and web/Toolbar.svelte:304-311): a gated button uses
   * `aria-disabled` + A HANDLER GUARD, never the native `disabled` attribute,
   * because A NATIVELY DISABLED BUTTON IS NOT FOCUSABLE — so the keyboard can never
   * reach the sentence saying why it is dead, and for a control whose tooltip is
   * the only place that reason is written down, the native attribute makes the
   * explanation unreachable rather than merely unstyled.
   *
   * Every surface re-implemented that by hand, and one of them got it wrong:
   * web/SlideNav.svelte's footer used `disabled=` with the delete-slides gate
   * written inline in the markup, in a file whose OWN comment (:958) cites the
   * registry-surfacing rule the row beneath it was breaking. Hand-copying is what
   * let that drift; a component cannot drift, because the guard and the aria state
   * are written once, here.
   *
   * ── WHAT IT GUARANTEES ───────────────────────────────────────────────────────
   *  - `aria-disabled`, never `disabled` — the button stays focusable and tabbable.
   *  - The click handler is GUARDED, so an unavailable command cannot run even
   *    though the element is still live.
   *  - The reason is read through `commandUnavailableReason`, NEVER `cmd.requires`
   *    directly: `requires` MAY BE A FUNCTION of the app, and reading the field raw
   *    renders a function's SOURCE TEXT into the UI.
   *  - The icon comes from the registry entry, so a command's glyph is declared in
   *    ONE place (web/SlideNav.svelte's footer note states this ruling).
   *  - Greying is free: app.css already makes `[aria-disabled="true"]` read exactly
   *    as `:disabled` for `.btn` / `.btn-icon`.
   *
   * A caller with an EXTRA gate of its own (SlideNav's "this would delete every
   * remaining slide") passes `blocked` + `blockedReason`; they compose with the
   * registry's own verdict rather than replacing it, so a command that is
   * unavailable for BOTH reasons still explains itself.
   */
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { commandUnavailable, commandUnavailableReason, unavailableMessage } from "../core/commands.js";

  let {
    /** @type {object} The app (the registry's gates are functions of it). */
    app,
    /** @type {string} The command id to surface. */
    id,
    /** @type {string=} Override for the button's label/tooltip. Defaults to the
     *  entry's own `title` — pass one only when the surface says it better (a
     *  SlideNav footer label counts the selection). */
    label = undefined,
    /** @type {boolean} A CALLER-side gate, ANDed with the registry's own. */
    blocked = false,
    /** @type {string=} Why the caller-side gate is shut, as a `requires` clause
     *  ("more than one slide"). Required whenever `blocked` can be true: a dead
     *  control with no sentence is the thing this component exists to prevent. */
    blockedReason = undefined,
    /** @type {number} Icon size in px (square). */
    size = 16,
    /** @type {string} Classes for the button. Defaults to the app's standard
     *  `.btn-icon`; a surface with its own button skin passes that instead (see
     *  web/GatedIconButton.svelte for why this REPLACES rather than composes). */
    buttonClass = "btn-icon",
    /** @type {object=} Value for the `data-nav-action` attribute (probes key on it). */
    dataNavAction = undefined,
  } = $props();

  // Read the entry EVERY render, never captured once: a gate is a function of live
  // app state, so a snapshot would go stale (web/PresentDock.svelte:60).
  let cmd = $derived(app.commands.get(id));

  let unavailable = $derived(blocked || commandUnavailable(cmd, app));

  /**
   * Query. The finished "Unavailable — requires …" sentence, or null.
   *
   * The caller's own gate wins the explanation when it is the thing that is shut,
   * because it is the more specific answer; otherwise the registry's clause is
   * used. The `reason !== null` guard is NOT defensive noise — `unavailableMessage`
   * THROWS on an empty clause by design, so that a `when` with no `requires` is a
   * loud registry defect rather than a rendered "Unavailable — requires .".
   */
  let blockedBecause = $derived.by(() => {
    if (blocked && blockedReason) return unavailableMessage(blockedReason);
    const reason = commandUnavailableReason(cmd, app);
    return reason === null ? null : unavailableMessage(reason);
  });

  /** Query. The button's sentence: its caller-supplied label, else the entry's title. */
  let text = $derived(label ?? cmd.title);
</script>

<Tooltip text={blockedBecause ? `${text} — ${blockedBecause}` : text}>
  <button
    class={buttonClass}
    aria-label={text}
    aria-disabled={unavailable}
    data-nav-action={dataNavAction}
    onclick={() => { if (!unavailable) app.runCommand(id); }}
  >
    <iconify-icon icon={cmd.icon} width={size} height={size}></iconify-icon>
  </button>
</Tooltip>
