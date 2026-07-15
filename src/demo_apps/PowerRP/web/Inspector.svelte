<!--
  Inspector — properties of the selected item, rows declared BY THE PLUGIN
  (plugin.inspector), rendered generically. Every row carries keyframe
  controls per the manifest spec:
    ◆/◇  insert/remove keyframe for this property on the CURRENT slide
    ‹ ›  jump to prev/next slide holding a keyframe for it
  Editing a value always writes a keyframe on the current slide.

  Item selection uses SvelteLib's Dropdown (never the native <select>) and
  includes non-bbox widgets (blur layers) — selection doesn't require canvas
  geometry. Items are user-renamable (name lives on the creation slide).
  Delete = deactivate on this slide; Purge = remove from existence.
-->
<script>
  import "iconify-icon";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import NumericField from "./NumericField.svelte";
  import { allDocumentItems, keyframeIndices } from "../core/document.js";

  let { app } = $props();

  let nodes = $derived(app.nodes());
  /** The selected item as the node-shaped {itemId, type, state, plugin} the
   * template consumes. The render tree derives only items VISIBLE on this
   * slide, but the picker lists EVERY document item (manifest: "Item picker
   * shows ALL objects on ALL slides") — an item that is active:false here
   * still has folded state, so build the same shape from the state and every
   * row keeps working (it just doesn't render on canvas). An item NOT YET
   * CREATED on this slide has no state at all → null (the template shows the
   * not-created notice instead; editing it here would write keyframes BEFORE
   * its creation slide, folding typeless partial items). */
  let sel = $derived.by(() => {
    const live = app.selectedNode();
    if (live || app.selection == null) return live;
    const state = app.state().items?.[app.selection];
    if (!state) return null;
    return { itemId: app.selection, type: state.type, state, plugin: app.registry.get(state.type) };
  });
  // Picker: items visible on this slide first (render-tree order, as before),
  // then every OTHER document item — not yet created here, or active:false —
  // at the BOTTOM, flagged `invisible` for the red style (manifest, round 11).
  // Invisible items have no state here, so their label derives from the
  // document (first-written name, else the displayName fallback format).
  let itemChoices = $derived.by(() => {
    const visible = nodes.map((n) => ({ value: n.itemId, label: app.displayName(n.itemId) }));
    const visibleIds = new Set(nodes.map((n) => n.itemId));
    const invisible = allDocumentItems(app.doc)
      .filter((it) => !visibleIds.has(it.id))
      .map((it) => ({
        value: it.id,
        label: it.name ?? `${app.registry.get(it.type).title} (${it.id.slice(0, 4)})`,
        invisible: true,
      }));
    return [...visible, ...invisible];
  });
  // Creation slide of the selected item (first slide keying its type) —
  // names the slide in the not-created-yet notice.
  let creationIndex = $derived(app.selection == null ? null
    : keyframeIndices(app.doc, ["items", app.selection, "type"])[0] ?? null);
  // Number of selected items — >1 shows the minimal multi-select placeholder
  // (the full intersection Property Panel is a SEPARATE milestone; manifest).
  let selCount = $derived(app.selectedIds().length);

  function coerce(kind, raw) {
    return kind === "number" ? Number(raw) : kind === "checkbox" ? Boolean(raw) : raw;
  }

  /**
   * Pure function. Normalizes a stored color to lowercase long-form hex —
   * "#rrggbb" or "#rrggbbaa" (Round 10: colors support ALPHA; plain #rrggbb
   * stays legal = opaque; shorthand "#rgb"/"#rgba" digits double). Returns
   * null for anything unparseable — the control then shows the RAW value in
   * its hex field (visible + fixable), never a silent blacken.
   *
   * Examples:
   *     >>> normalizedHex("#7AA2F7")
   *     '#7aa2f7'
   *     >>> normalizedHex("#7aa2f780")
   *     '#7aa2f780'
   *     >>> normalizedHex("#f08")
   *     '#ff0088'
   *     >>> normalizedHex("blue")
   *     null
   */
  function normalizedHex(value) {
    if (typeof value !== "string" || !/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return null;
    let h = value.slice(1).toLowerCase();
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return "#" + h;
  }

  /**
   * Pure function. The opaque "#rrggbb" part of a normalized hex color — the
   * only format the native RGB picker understands (it cannot carry alpha,
   * which is exactly why the alpha scrub exists beside it). Null (unparseable
   * stored value) reads as black in the picker, matching the pre-alpha
   * control's fallback; the hex field still shows the raw string.
   *
   * Examples:
   *     >>> rgbHex("#7aa2f780")
   *     '#7aa2f7'
   *     >>> rgbHex(null)
   *     '#000000'
   */
  function rgbHex(normalized) {
    return normalized ? normalized.slice(0, 7) : "#000000";
  }

  /**
   * Pure function. The alpha of a normalized hex color in 0..1 (1 when there
   * are no alpha digits — plain #rrggbb is opaque). Rounded to 3 decimals
   * (NumericField's round3 precedent) so 8-bit alpha bytes display cleanly.
   *
   * Examples:
   *     >>> alphaOf("#7aa2f780")
   *     0.502
   *     >>> alphaOf("#7aa2f7")
   *     1
   */
  function alphaOf(normalized) {
    if (!normalized || normalized.length !== 9) return 1;
    return Math.round((parseInt(normalized.slice(7, 9), 16) / 255) * 1000) / 1000;
  }

  /**
   * Pure function. Composes "#rrggbb" + alpha (0..1, clamped) into the stored
   * color string: plain "#rrggbb" at alpha 1 — fully-opaque colors stay
   * 6-digit, so documents that never touch alpha never change shape — and
   * "#rrggbbaa" otherwise.
   *
   * Examples:
   *     >>> composedHex("#7aa2f7", 1)
   *     '#7aa2f7'
   *     >>> composedHex("#7aa2f7", 0.5)
   *     '#7aa2f780'
   *     >>> composedHex("#7aa2f7", 0)
   *     '#7aa2f700'
   */
  function composedHex(rgb, alpha) {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    return a === 255 ? rgb : rgb + a.toString(16).padStart(2, "0");
  }

  // Hex-field draft while typing. Only one field is focused at a time, so a
  // single (key, text) pair serves every color row. WITHOUT this, a
  // mid-typing live preview re-renders the row and Svelte resets the input's
  // value from state, splicing stored text into the user's draft (e.g. a
  // momentary "#7aa" shorthand previews and clobbers the caret) — the same
  // fight NumericField's focused draft buffer solves.
  let hexEditing = $state(null); // row.key of the hex field being typed in, or null
  let hexDraft = $state("");

  /** Commits a hex-field draft; unparseable text is rejected LOUDLY and the
   * field reverts to the stored value (no silent fallback). */
  function commitHexField(key, e) {
    const n = normalizedHex(e.target.value.trim());
    if (!n) {
      console.error(`PowerRP: "${e.target.value}" is not a hex color (#rgb, #rgba, #rrggbb, or #rrggbbaa)`);
      app.cancelPreview();
      e.target.value = normalizedHex(sel.state[key]) ?? String(sel.state[key] ?? "");
      return;
    }
    commitField(key, "color", n);
  }

  /** Live preview while typing/dragging a field — viewport re-renders in real
   * time BEFORE commit (manifest rule); Enter/blur commits; Escape reverts. */
  function previewField(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) return;
    app.setPreview([[["items", app.selection, key], value]]);
  }

  function commitField(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) {
      app.cancelPreview();
      return;
    }
    app.setPreview([[["items", app.selection, key], value]]);
    app.commitPreview();
  }

  function fieldKeydown(e) {
    if (e.key === "Escape") {
      app.cancelPreview();
      e.target.blur();
      e.stopPropagation();
    }
  }

  function toggleKey(key) {
    // Dotted keys are nested paths (arrow "from.x"). Inserting a keyframe
    // copies the RAW stored value — an equation keyframes as the equation.
    const path = key.split(".");
    if (app.hasKey(key)) app.removeKey(app.slideIndex, ["items", app.selection, ...path]);
    else app.keyframePath(["items", app.selection, ...path], app.storedItemValue(app.selection, path));
  }
</script>

<!-- Picker row adapter: items flagged `invisible` (not visible on the current
     slide) render in the danger red — the signal that selecting them shows
     state without a canvas presence. Visible rows render exactly as before. -->
{#snippet pickerItem(it)}
  <span class:picker-invisible={it.invisible}>{it.label}</span>
{/snippet}

<div class="inspector">
  <div class="inspector-head">
    <Dropdown
      items={itemChoices}
      value={app.selection}
      placeholder="— select item —"
      onchange={(v) => (app.selection = v)}
      item={pickerItem}
    />
  </div>

  {#if selCount > 1}
    <!-- Minimal multi-select placeholder (manifest: the full intersection
         Property Panel is a SEPARATE milestone — do NOT build it here). Delete
         and Purge still act on the whole set via the command registry. -->
    <div class="multi-select">
      <div class="multi-count">{selCount} items selected</div>
      <div class="item-actions">
        <Tooltip text="Deactivate every selected item on this slide">
          <button class="btn" onclick={() => app.runCommand("delete-item")}>Delete here</button>
        </Tooltip>
        <Tooltip text="Remove every selected item from existence (all slides)">
          <button class="btn danger" onclick={() => app.runCommand("purge-item")}>Purge</button>
        </Tooltip>
      </div>
    </div>
  {:else if sel}
    {#if sel.plugin.capabilities.purgeable !== false}
      <!-- Visibility is a PARAMETER, not an action (user, round 11): every
           widget has `active`, so the old "Delete here" ACTION button is a
           TOGGLE now — it keyframes active true/false on the CURRENT slide
           (upsert) and KEEPS the selection, so a hidden item (red picker row)
           toggles right back. Eye = the SlideNav slide-toggle visual language;
           state shows via the icon, never a background fill (toggle ruling).
           Backspace / palette "Delete" still deactivates — that path is
           unchanged. Not-yet-created items never reach this row (sel is null
           for them): activating an item BEFORE its creation slide would fold
           a typeless partial item, so it stays impossible by construction. -->
      {@const visible = sel.state.active !== false}
      <div class="item-actions">
        <Tooltip text={visible ? "Visible on this slide — click to hide (keyframes active: false)" : "Hidden on this slide — click to show (keyframes active: true)"}>
          <button
            class="btn-icon"
            aria-label="Toggle visibility on this slide"
            aria-pressed={visible}
            onclick={() => app.keyframePath(["items", app.selection, "active"], !visible)}
          >
            <iconify-icon icon={visible ? "mdi:eye" : "mdi:eye-off"} width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
        <Tooltip text="Remove from existence (all keyframes, all slides)">
          <button class="btn danger" onclick={() => app.runCommand("purge-item")}>Purge</button>
        </Tooltip>
      </div>
    {/if}
    <div class="row name-row">
      <span class="label">Name</span>
      <input
        type="text"
        placeholder={app.displayName(sel.itemId)}
        value={sel.state.name ?? ""}
        onchange={(e) => app.renameSelection(e.target.value)}
      />
      <!-- The Name row has no keyframe controls, but reserves the trailing grid
           column (empty) so its value input's RIGHT edge aligns with the
           property rows below it. -->
      <span class="kf-controls" aria-hidden="true"></span>
    </div>
    <div class="rows">
      {#each sel.plugin.inspector ?? [] as row (row.key)}
        <div class="row">
          <!-- Label truncates in its fixed column; the tooltip carries the full
               text for the few long ones (never a native title= — manifest ban). -->
          <Tooltip text={row.label}>
            <span class="label">{row.label}</span>
          </Tooltip>
          {#if row.kind === "number"}
            <!-- NumericField: equation-aware (THE UNIFICATION). A number
                 renders as the DraggableNumber scrubber; an equation renders
                 as a monospace expression editor with live evaluation and the
                 error affordance. Click-without-drag on the scrubber opens
                 text entry; typed content decides number vs equation (no mode
                 toggle). `display` (e.g. "degrees") edits/shows in a unit
                 different from storage. Dotted keys ("from.x") = nested state. -->
            <NumericField
              {app}
              path={["items", app.selection, ...row.key.split(".")]}
              label={row.label}
              min={row.min ?? null}
              max={row.max ?? null}
              display={row.display ?? null}
            />
          {:else if row.kind === "color"}
            {@const norm = normalizedHex(sel.state[row.key])}
            <!-- Themed color control WITH ALPHA (Round 10, re-raised Round 11:
                 "I still am not able to input alpha"). Same growing width,
                 height, square corners as sibling inputs. Layout:
                 [swatch (opens the native RGB picker)] [hex text] [alpha scrub].
                 The native <input type=color> can't carry alpha, so it edits
                 ONLY the rgb part (invisible under the swatch); alpha lives in
                 the DraggableNumber scrub (0..1 — the opacity-row bounds rule)
                 and the full #rrggbbaa round-trips through the hex text. The
                 swatch shows the color WITH its alpha over a transparency
                 checkerboard. All paths keep the preview/commit wiring. -->
            <div class="color-control">
              <label class="color-pick">
                <input
                  type="color"
                  class="color-native"
                  aria-label={`${row.label} color picker`}
                  value={rgbHex(norm)}
                  oninput={(e) => previewField(row.key, row.kind, composedHex(e.target.value, alphaOf(norm)))}
                  onchange={(e) => commitField(row.key, row.kind, composedHex(e.target.value, alphaOf(norm)))}
                />
                <span class="color-swatch" style:--a-swatch-rgba={norm}></span>
              </label>
              <input
                type="text"
                class="color-hex"
                spellcheck="false"
                aria-label={`${row.label} hex`}
                value={hexEditing === row.key ? hexDraft : (norm ?? String(sel.state[row.key] ?? ""))}
                onfocus={(e) => {
                  hexEditing = row.key;
                  hexDraft = e.target.value;
                }}
                oninput={(e) => {
                  hexDraft = e.target.value;
                  const n = normalizedHex(hexDraft.trim());
                  if (n) previewField(row.key, row.kind, n);
                }}
                onchange={(e) => commitHexField(row.key, e)}
                onblur={() => (hexEditing = null)}
                onkeydown={fieldKeydown}
              />
              <Tooltip text="Alpha (0 transparent – 1 opaque); drag to scrub, click to type">
                <span class="color-alpha">
                  <!-- coefficient 0.01 for a [0,1]-bounded scrub: DraggableNumber's
                       own documented bounded-value usage (see its header example). -->
                  <DraggableNumber
                    label={`${row.label} alpha`}
                    value={alphaOf(norm)}
                    min={0}
                    max={1}
                    coefficient={0.01}
                    wheel={false}
                    oninput={(a) => previewField(row.key, row.kind, composedHex(rgbHex(norm), a))}
                    onchange={(a) => commitField(row.key, row.kind, composedHex(rgbHex(norm), a))}
                  />
                </span>
              </Tooltip>
            </div>
          {:else if row.kind === "checkbox"}
            <input
              type="checkbox"
              checked={Boolean(sel.state[row.key])}
              onchange={(e) => commitField(row.key, row.kind, e.target.checked)}
            />
          {:else}
            <input
              type="text"
              value={sel.state[row.key] ?? ""}
              oninput={(e) => previewField(row.key, row.kind, e.target.value)}
              onchange={(e) => commitField(row.key, row.kind, e.target.value)}
              onkeydown={fieldKeydown}
            />
          {/if}
          <!-- prev ◆ next — jumps hug the diamond (manifest spec); hollow =
               not keyed on this slide, filled = keyed. Iconify, never Unicode.
               Grouped in ONE .kf-controls span so they occupy a SINGLE grid
               cell (the row grid's trailing auto column) — the value column
               grows, these stay put and aligned across rows. -->
          <span class="kf-controls">
            <Tooltip text="Previous keyframe">
              <button class="jumpbtn" aria-label="Previous keyframe" onclick={() => app.jumpKeyframe(row.key, -1)}>
                <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
              </button>
            </Tooltip>
            <Tooltip text={app.hasKey(row.key) ? "Remove keyframe on this slide" : "Insert keyframe on this slide"}>
              <button
                class="keybtn"
                class:keyed={app.hasKey(row.key)}
                aria-label="Toggle keyframe on this slide"
                onclick={() => toggleKey(row.key)}
              >
                <iconify-icon icon={app.hasKey(row.key) ? "mdi:rhombus" : "mdi:rhombus-outline"} width="17" height="17"></iconify-icon>
              </button>
            </Tooltip>
            <Tooltip text="Next keyframe">
              <button class="jumpbtn" aria-label="Next keyframe" onclick={() => app.jumpKeyframe(row.key, +1)}>
                <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
              </button>
            </Tooltip>
          </span>
        </div>
      {/each}
    </div>
  {:else if app.selection != null}
    <!-- Picker-selected but NOT YET CREATED on this slide: there is no folded
         state to show or edit (keyframes here would predate creation). -->
    <div class="empty">
      Not created yet on this slide{#if creationIndex != null} — appears on slide {creationIndex + 1}{/if}
    </div>
  {:else}
    <div class="empty">Nothing selected</div>
  {/if}
</div>
