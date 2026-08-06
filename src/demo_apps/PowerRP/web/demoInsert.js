/**
 * INSERTING A DEMO — ONE stamp for every multi-item template, and ONE table of
 * the sections they are grouped under (manifest R7-18).
 *
 * ── WHAT THE USER ASKED FOR, AND WHY IT IS TWO THINGS ───────────────────────
 * USER, 2026-08-06: *"we need a demo audio patches submenu like demo widgets btw
 * cause we gonna have a lot of them."* R7-17 puts fifty patches behind that
 * sentence, so a flat insert list is finished as a design. R7-18 also asks the
 * question the double pendulum poses in miniature — *"it's just like an alias for
 * creating two rectangles with the proper equations"* — and answers it: **a demo
 * patch and a demo preset must share one mechanism.** They did not. There were two
 * inserts (`app.insertDemoPatch`, `insertDemoPreset`) doing one job, and two
 * unrelated ways of reaching a menu. This file is both halves of the fix.
 *
 * ── THE ONE MECHANISM: AN INSERTABLE TEMPLATE ───────────────────────────────
 * A demo patch is items + WIRES. A demo preset is items + EQUATIONS. Written out,
 * the two inserts differed in four lines of data and agreed on everything that is
 * actually hard: mint every id before any state is written, assemble the whole rig
 * into ONE document, commit once so one Cmd+Z takes it all back, then select what
 * arrived. `insertDemoTemplate` is that agreement, and a TEMPLATE RECORD is the
 * difference — `build(app, idFor)` returns `{states, order}` plus, optionally, a
 * project-script fragment and a group to wrap the whole thing in.
 *
 * ── ONE UNDO UNIT, WHICH IS WHY THIS IS NOT addItem IN A LOOP ───────────────
 * Both kinds need it and for the same reason stated two ways. A preset's items
 * REFERENCE EACH OTHER by id, so every intermediate state of an item-at-a-time
 * insert is a rig whose equations name items that do not exist yet — exactly the
 * references `repairedDocument` is entitled to strip. A patch is up to eleven
 * widgets and a dozen wires, so the author would need eleven Cmd+Z to take it
 * back, and each intermediate state is a partially-wired patch the audio mirror
 * dutifully reflects into the engine.
 *
 * ── IDS ARE MINTED BEFORE ANY STATE IS WRITTEN ──────────────────────────────
 * `demoIdMinter` resolves symbolic names ("rod1", "filter") to real item ids, so
 * wires and equations are written with real ids the FIRST time rather than with
 * placeholders rewritten afterwards. It MEMOIZES because a name is asked for
 * several times — once per reference to it.
 *
 * ── THE ONE GROUPING: DEMO_SECTIONS ─────────────────────────────────────────
 * `DEMO_SECTIONS` is the whole answer to "which submenu does this go in", and
 * `demoInsertMenus` turns it into the palette entries. A TEMPLATED section's
 * children are GENERATED from the roster, so authoring patch #51 is one record in
 * core/audio_patches.js and its menu entry follows — the rule DEMO_PATCHES and
 * DEMO_PRESETS already followed, now with a home to follow it into.
 *
 * WHY THE WIDGET SECTION IS NOT TEMPLATED, stated because it is the one asymmetry
 * here: inserting a demo WIDGET is a different verb. It ARMS a crosshair and waits
 * for the author to place one item; it stamps nothing and commits nothing, so it
 * has no `build` and cannot be a template without inventing a fiction. Its
 * children are therefore supplied by web/App.svelte, and the drift that costs is
 * GATED RED instead: tests/demo_insert_test.js reads plugins/demo/ off the DISK and
 * fails when a widget in that directory is missing from the menu. That gate is
 * stronger than a declared field would be — it cannot be defeated by forgetting the
 * declaration either — and it found `demo_video_time_scrub`, which had been shipped
 * and unreachable.
 */

import { cameraRect } from "../core/derive.js";
import { keyframed, uuid, withNewItem, withNormalizedZ } from "../core/document.js";
import { rotatedBBoxAABB } from "../core/view.js";
import { DEMO_PATCHES, PATCH_ROW, buildPatchItems, patchBounds } from "../core/audio_patches.js";
import { DEMO_PRESETS, buildPresetItems, withPresetScript } from "../plugins/demo_presets.js";

/**
 * Pure function. A memoizing symbolic-name → item-id minter: the same name always
 * answers with the same freshly-minted id, a different name never does.
 *
 * @returns {function(string): string}
 *
 * @example // const id = demoIdMinter(); id("rod1") === id("rod1") // true
 * @example // id("rod1") !== id("rod2") // true
 */
export function demoIdMinter() {
  const minted = new Map();
  return (name) => {
    if (!minted.has(name)) minted.set(name, uuid());
    return minted.get(name);
  };
}

/**
 * Query (reads the live document). The world point a demo centres itself on — the
 * middle of what the author is looking at.
 *
 * A RIG TAKES THE CENTRE RATHER THAN A CORNER because every one of these is centred
 * on something that needs room in every direction: a pivot, a barycentre, a signal
 * chain that reads outward from its middle.
 *
 * @param {object} app - the live PowerRPApp
 * @returns {{x: number, y: number}}
 *
 * @example // viewCentre(app) // {x: 640, y: 360} on an untouched 1280x720 deck
 */
function viewCentre(app) {
  const rect = cameraRect(app.state(), app.doc.meta);
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * Query (reads the live document). Where a PATCH's top-left corner goes.
 *
 * Centred on the view, then PUSHED CLEAR OF WHAT IS ALREADY THERE. Measured:
 * inserting two patches in a row landed both on the view centre, on top of each
 * other — eleven nodes interleaved with seven, which reads as one incomprehensible
 * tangle rather than as two patches. So the origin drops BELOW the lowest existing
 * audio node. Only AUDIO nodes are avoided, deliberately: a patch is meant to sit on
 * top of the slide's ordinary content (that is what it is FOR — ambience under a
 * figure), and dodging every rectangle would push it off the canvas.
 *
 * @param {object} app - the live PowerRPApp
 * @param {object} patch - a DEMO_PATCHES blueprint
 * @returns {{x: number, y: number}}
 *
 * @example // patchOrigin(app, WHOOSH) // the view centre, less half the patch's box
 */
function patchOrigin(app, patch) {
  const centre = viewCentre(app);
  const probe = patchBounds(patch, app.registry, { x: 0, y: 0 });
  const existing = app.nodes().filter((n) => n.plugin?.audioModule).map(rotatedBBoxAABB).filter(Boolean);
  const below = existing.length ? Math.max(...existing.map((b) => b.y + b.h)) + PATCH_ROW : null;
  return { x: centre.x - probe.w / 2, y: below ?? centre.y - probe.h / 2 };
}

/**
 * Pure function. The template record for one demo PATCH.
 *
 * A patch is the kind that GROUPS: the user's standing directive asks for it by
 * name (ADDENDUM 10, *"insert a demo patch in a group that is just a fully patched
 * audio thing"*), and a dozen nodes the author has not seen yet are far easier to
 * move as one thing. The group's bbox is the patch's own bounds and its bind pose is
 * that box, so it sits exactly at its bind pose the instant it is made and moves
 * nothing until the user transforms it — the contract groupSelection establishes.
 *
 * @param {object} patch - a DEMO_PATCHES blueprint
 * @returns {object} a template record
 *
 * @example // patchTemplate(WHOOSH).id // "demo-patch-whoosh"
 * @example // patchTemplate(WHOOSH).section // "patch"
 */
function patchTemplate(patch) {
  return {
    // THE COMMAND ID IS THE TEMPLATE ID, unchanged from when these were top-level
    // entries: `commands.get` resolves submenu children too, so every probe and
    // script that names `demo-patch-whoosh` keeps working.
    id: `demo-patch-${patch.id}`,
    section: "patch",
    // NO "Demo Patch: " PREFIX ANY MORE — the submenu it now lives in says that, and
    // `patch.title` already carries the mandatory "Audio " prefix (WORKSTREAM BZ).
    title: patch.title,
    icon: "mdi:music-box-multiple-outline",
    aliases: ["demo patch", "demo patches", "audio patch", "synth patch", patch.title.toLowerCase()],
    help: patch.help,
    build(app, idFor) {
      const origin = patchOrigin(app, patch);
      const { states, order } = buildPatchItems(patch, app.registry, origin, idFor);
      return { states, order, group: { name: patch.title, bounds: patchBounds(patch, app.registry, origin) } };
    },
  };
}

/**
 * Pure function. The template record for one demo PRESET.
 *
 * A preset does NOT group, and the asymmetry is the user's own framing: these are
 * *"normal basic ass vanilla widgets … with pre-filled equations"*, so they arrive
 * as loose widgets the author edits one at a time. A patch is a machine; a preset is
 * a starting point.
 *
 * @param {object} preset - a DEMO_PRESETS blueprint
 * @returns {object} a template record
 *
 * @example // presetTemplate(DOUBLE_PENDULUM).id // "demo-preset-double-pendulum"
 * @example // presetTemplate(DOUBLE_PENDULUM).section // "preset"
 */
function presetTemplate(preset) {
  return {
    id: `demo-preset-${preset.id}`,
    section: "preset",
    title: preset.title,
    icon: preset.icon,
    aliases: ["demo preset", "demo presets", "physics demo", "simulation", preset.title.toLowerCase()],
    help: preset.help,
    build(app, idFor) {
      const { states, order } = buildPresetItems(preset, app.registry, viewCentre(app), idFor);
      return { states, order, script: preset.script };
    },
  };
}

/**
 * EVERY INSERTABLE TEMPLATE, derived from the two blueprint rosters. Nothing is
 * written out here: a new patch or preset is one record in its own data file, and
 * this list, its palette entry and its submenu placement all follow.
 */
export const DEMO_TEMPLATES = [...DEMO_PATCHES.map(patchTemplate), ...DEMO_PRESETS.map(presetTemplate)];

/**
 * THE SECTIONS demo insertables are grouped under — one submenu each, and the ONLY
 * place that membership is decided.
 *
 * `templated: true` means the children are GENERATED from DEMO_TEMPLATES, so adding
 * a record to a roster is the whole job. `templated: false` is the widget section
 * alone; the header of this file says why it cannot be one and what is gated in its
 * place.
 */
export const DEMO_SECTIONS = [
  {
    id: "widget",
    templated: false,
    // The commandId is a stable reference (probes, ShapePicker's sibling); only the
    // TITLE says "Add" — the app's verb (user ruling).
    commandId: "insert-demo-widget",
    title: "Add Demo Widget",
    icon: "mdi:flask-outline",
    aliases: ["demo widget", "demo widgets", "showcase"],
    help: "The widgets in plugins/demo/ — shaders, materials, video backends and text effects that showcase what a plugin can do. Each one places a SINGLE widget with the crosshair.",
  },
  {
    id: "patch",
    templated: true,
    commandId: "insert-demo-patch",
    title: "Add Demo Audio Patch",
    icon: "mdi:music-box-multiple-outline",
    aliases: ["demo patch", "demo patches", "audio patch", "synth patch", "patch library"],
    help: "Fully-wired working audio graphs. Each one arrives as a GROUP of real node widgets you can drag, rewire and keyframe — the patch is the acceptance test for the modules in it, so it already sounds like something.",
  },
  {
    id: "preset",
    templated: true,
    commandId: "insert-demo-preset",
    title: "Add Demo Preset",
    // NOT `mdi:pendulum`, which was the obvious choice and DOES NOT EXIST — the API
    // answers "Not found" and iconify-icon then renders an EMPTY SLOT with no error,
    // so a wrong id is invisible in code review and visible only as a missing glyph.
    // Measured against api.iconify.design, which is how the miss was found at all.
    icon: "mdi:atom-variant",
    aliases: ["demo preset", "demo presets", "physics demo", "simulation", "rig"],
    help: "Ordinary widgets with pre-filled equations — a double pendulum is two rectangles that integrate each other. Nothing here is a special widget type, so every number in it is yours to edit.",
  },
];

/**
 * Pure function. One palette entry per template in a section. `help` is the
 * template's own sentence, so the palette explains what is about to arrive.
 *
 * NO `when` GATE: inserting a demo is always possible, exactly like inserting a
 * widget. It needs no selection and no precondition.
 *
 * @param {string} sectionId - a DEMO_SECTIONS id
 * @returns {object[]} command entries, in roster order
 *
 * @example // demoSectionChildren("preset").map((c) => c.id)
 * @example // ["demo-preset-double-pendulum", "demo-preset-three-body", "demo-preset-mouse-cursor"]
 */
export function demoSectionChildren(sectionId) {
  return DEMO_TEMPLATES.filter((t) => t.section === sectionId).map((t) => ({
    id: t.id,
    title: t.title,
    icon: t.icon,
    aliases: t.aliases,
    help: t.help,
    run: (a) => insertDemoTemplate(a, t.id),
  }));
}

/**
 * Pure function. THE DEMO SUBMENUS, ready to spread into the command registry — a
 * container entry per DEMO_SECTIONS row, `children` generated for a templated
 * section and taken from `supplied` for one that is not.
 *
 * LOUD ON AN EMPTY SECTION rather than registering a submenu that opens onto
 * nothing: a container with no children is a dead end the palette will still let
 * you drill into, which is the same defect as an inert control.
 *
 * @param {object} supplied - `{[sectionId]: children}` for every non-templated section
 * @returns {object[]} one registry container entry per section
 *
 * @example // demoInsertMenus({widget: [{id: "x", title: "X", run: () => {}}]}).map((m) => m.id)
 * @example // ["insert-demo-widget", "insert-demo-patch", "insert-demo-preset"]
 */
export function demoInsertMenus(supplied) {
  return DEMO_SECTIONS.map((section) => {
    const children = section.templated ? demoSectionChildren(section.id) : supplied[section.id];
    if (!children?.length)
      throw new Error(`demoInsertMenus: section "${section.id}" has no children — a submenu that opens onto nothing is a dead end (templated: ${section.templated})`);
    return { id: section.commandId, title: section.title, icon: section.icon, aliases: section.aliases, help: section.help, children };
  });
}

/**
 * Command (ONE undo unit; mutates `app`). Stamps a DEMO TEMPLATE onto the current
 * slide — its items, its project-script fragment and its group if it declares one —
 * and selects what arrived so the author can see it.
 *
 * THE SCRIPT FRAGMENT RIDES IN THE SAME COMMIT as the items that call it. Split
 * across two commits there would be an undo state in which the equations are present
 * and their helpers are not — every one of them failing with "Unknown variable",
 * pointing at the equation instead of at what is missing.
 *
 * BLUEPRINT ORDER IS Z ORDER: a preset lists its trails first so they paint behind
 * their subjects, and a patch lists its sources before its sinks.
 *
 * @param {object} app - the live PowerRPApp
 * @param {string} templateId - a DEMO_TEMPLATES id (which is also its command id)
 * @returns {void}
 */
export function insertDemoTemplate(app, templateId) {
  const template = DEMO_TEMPLATES.find((t) => t.id === templateId);
  // A COMMAND THAT CANNOT ACT SAYS SO. The palette builds its entries from the same
  // array, so this is unreachable from the UI — it guards a script or a typo.
  if (!template) throw new Error(`insertDemoTemplate: no demo template with id ${JSON.stringify(templateId)} (have: ${DEMO_TEMPLATES.map((t) => t.id).join(", ")})`);

  const { states, order, script, group } = template.build(app, demoIdMinter());

  const stamped = withPresetScript(app.doc.meta.script ?? "", script);
  let doc = stamped === (app.doc.meta.script ?? "") ? app.doc : { ...app.doc, meta: { ...app.doc.meta, script: stamped } };

  const zs = app.nodes().map((n) => n.state.z ?? 0);
  let z = (zs.length ? Math.max(...zs) : 0) + 1;
  // The same write withNewItem makes, with ids we minted rather than ones it chose —
  // `keyframed(doc, slide, ["items", id], state)` IS creating an item, and slide 0's
  // delta creating everything is the document model's own rule.
  for (const id of order) doc = keyframed(doc, app.slideIndex, ["items", id], { ...states[id], active: true, z: z++ });

  let selection = order[order.length - 1];
  if (group) {
    const groupState = {
      ...app.registry.get("group").defaults,
      name: group.name,
      x: group.bounds.x, y: group.bounds.y, w: group.bounds.w, h: group.bounds.h,
      rotation: 0, scale: 1,
      members: [...order],
      bind: { x: group.bounds.x, y: group.bounds.y, rotation: 0, scale: 1 },
      active: true,
      z: z++,
    };
    const [withGroup, groupId] = withNewItem(doc, app.slideIndex, groupState);
    doc = withGroup;
    selection = groupId;
  }

  app.commit(withNormalizedZ(doc));
  app.selection = selection;
}
