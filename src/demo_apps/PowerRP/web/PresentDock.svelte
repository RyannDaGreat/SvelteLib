<!--
  PresentDock — THE PHONE'S GUARANTEE THAT PLAY IS REACHABLE.

  User ruling, 2026-08-01, and the ranking inside it is the whole spec:
  "most of the time somebody's on the phone, they're going to be presenting. So
  the play button needs to be easily accessible no matter what."

  WHAT WAS ACTUALLY WRONG — measured, not assumed (393x852, booted editor):
  the `present` button was not merely awkward, it was UNREACHABLE BY ANY TAP.
  It rendered at x=786.75 on a 393px-wide screen, ~420px past the edge, because
  the desktop toolbar is a single non-wrapping row 1107px wide. `.toolbar` is
  `overflow-x: visible` inside `.app`, which is `overflow: hidden` — so NO
  ancestor is user-scrollable (document scrollWidth === clientWidth === 393),
  and the HintBar that advertises "P Present" has zero interactive elements, so
  it is not a route either. There was no gesture on a phone that reached Play.

  THE CRUCIAL NEGATIVE, which is why this file is small: `present` declares no
  `when` and no `requires`, and `runCommand("present")` correctly enters present
  mode. THE FEATURE WAS NEVER BROKEN — only its surfacing was. So this component
  adds no behaviour whatsoever; it is one more SURFACING of one registry entry,
  exactly as the toolbar, the palette and the shortcut are.

  WHY A DOCK AND NOT A "FAB". App chrome here is SQUARE (--a-radius-control);
  "FAB" imports a rounded Material connotation the square-chrome rule rejects.
  This is docked chrome that happens to float, so it is a dock.

  WHY CSS-ONLY VISIBILITY. Whether this shows is decided entirely by a media
  query on --a-phone-max in web/app.css — there is no breakpoint in JS, no
  resize listener and no mirrored `isPhone` state. A JS copy of a CSS breakpoint
  is precisely the hand-maintained mirror this codebase keeps rediscovering as
  its worst defect class; here the stylesheet is the single source of truth and
  the component simply always renders.

  WHY IT HIDES IN PRESENT MODE. web/PresentMode.svelte takes the whole screen
  (.present, position:fixed inset:0) and owns its own navigation once running.
  A dock over it would be a second, redundant control on top of the surface it
  exists to reach — so the ONE piece of state this file reads is app.mode.

  NOTHING HERE NAMES THE COMMAND. The label and icon are read from the registry
  at render time, the same law web/Toolbar.svelte states in its header: this
  file declares only WHICH command appears, never what it is called or how it
  is drawn. A hardcoded "Play" here would be free to drift from the palette.
-->
<script>
  import "iconify-icon";
  import { commandUnavailable, commandUnavailableReason, unavailableMessage } from "../core/commands.js";

  let { app } = $props();

  /**
   * THE command this dock surfaces. A bare id, for the same reason
   * web/Toolbar.svelte's `groups` holds bare ids: anything else in this
   * position would be a copy of a field the registry already owns.
   */
  const PRESENT = "present";

  /**
   * Query. The registry entry for the command this dock surfaces.
   *
   * Read through the registry every render rather than captured once: a command
   * entry's gate is a function of live app state, so a snapshot would go stale.
   */
  let cmd = $derived(app.commands.get(PRESENT));

  /**
   * Query. Is `present` gated shut right now? This is the AVAILABILITY axis —
   * the button stays rendered and inert, it is never hidden, because hiding a
   * control makes the command unlearnable (core/registry.js's TOOL GROUPS rule).
   */
  let unavailable = $derived(commandUnavailable(cmd, app));

  /**
   * Query. WHY it is shut, as a finished sentence — or null.
   *
   * Read through `commandUnavailableReason`, NEVER `cmd.requires` directly:
   * `requires` MAY BE A FUNCTION of the app, and reading the field raw renders
   * a function's source text into the UI.
   *
   * The `reason !== null` guard is NOT defensive noise: `unavailableMessage`
   * THROWS on an empty clause by design (core/commands.js:241), because a
   * `when` with no `requires` is a registry defect that must be loud rather
   * than rendered as "Unavailable — requires .". web/Toolbar.svelte:247 guards
   * the identical call the identical way. `present` is ungated today, so this
   * is null in every current state — it is written now so that a gate added
   * later surfaces correctly without anyone remembering to revisit this file.
   */
  let blockedBecause = $derived.by(() => {
    const reason = commandUnavailableReason(cmd, app);
    return reason === null ? null : unavailableMessage(reason);
  });
</script>

<!-- Hidden in present mode: PresentMode owns the screen and its own controls. -->
{#if app.mode !== "present"}
  <!--
    aria-disabled + a handler guard, never the native `disabled` attribute —
    the house rule (web/Toolbar.svelte:304-311): a natively disabled button is
    not focusable, so nothing could ever reach the sentence saying why it is
    dead. The reason rides aria-description rather than a Tooltip because this
    surface exists for a touch device, where there is no hover to reveal one.
  -->
  <div class="present-dock">
    <button
      class="present-dock-btn"
      aria-label={cmd.title}
      aria-description={blockedBecause}
      aria-disabled={unavailable}
      onclick={() => { if (!unavailable) app.runCommand(PRESENT); }}
    >
      <iconify-icon icon={cmd.icon} width="24" height="24"></iconify-icon>
    </button>
  </div>
{/if}
