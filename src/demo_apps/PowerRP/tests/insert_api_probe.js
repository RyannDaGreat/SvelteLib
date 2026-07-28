/**
 * APP-API INSERTION PROBE — confirms the COMIC and GLITCH demo widgets are
 * reachable through the app's own registry/document/derive wiring and actually
 * LAND in app.nodes() when inserted.
 *
 * The web app (web/app.svelte.js) can't import in bare node (Svelte runes), so
 * this mirrors its two relevant methods with the SAME core functions they call:
 *
 *   registry  = createRegistry(); registerAll(registry, createCommands())   // constructor
 *   addItem(defaults):  state = {...defaults, active:true, z:max+1};
 *                       [doc,id] = withNewItem(doc, 0, state);
 *                       doc = withNormalizedZ(doc)
 *   nodes():  deriveRenderTree(evaluateState(foldState(doc,0,1), registry).state, registry)
 *
 * For each widget it resolves the plugin exactly as the "Add Demo Widget"
 * menu does (registry.get("demo_comic")), inserts it, and asserts a node with
 * the new itemId + correct type appears in nodes() AND that node's plugin.emit
 * yields a non-empty display list (what sceneIR feeds the renderer). Loud throw
 * on any miss.
 *
 * Run: node src/demo_apps/PowerRP/tests/insert_api_probe.js
 */
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { newDocument, foldState, withNewItem, withNormalizedZ } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { deriveRenderTree } from "../core/derive.js";

const SLIDE = 0; // insertion happens on the current slide; a fresh doc has one

/** Query. app.nodes() — the derived render tree for the current slide. */
function nodes(doc, registry) {
  return deriveRenderTree(evaluateState(foldState(doc, SLIDE, 1), registry).state, registry);
}

/** Command. app.addItem(defaults) reproduced: folds one item onto SLIDE and
 * returns [nextDoc, newId]. */
function addItem(doc, registry, defaults) {
  const zs = nodes(doc, registry).map((n) => n.state.z ?? 0);
  const state = { ...defaults, active: true, z: (zs.length ? Math.max(...zs) : 0) + 1 };
  const [next, id] = withNewItem(doc, SLIDE, state);
  return [withNormalizedZ(next), id];
}

const registry = createRegistry();
registerAll(registry, createCommands());

let doc = newDocument();
for (const type of ["demo_comic", "demo_glitch"]) {
  const plugin = registry.get(type); // lazy resolve — exactly what the menu does at click time
  const before = nodes(doc, registry).length;
  let id;
  [doc, id] = addItem(doc, registry, plugin.defaults);

  const all = nodes(doc, registry);
  const node = all.find((n) => n.itemId === id);
  if (!node) throw new Error(`${type}: inserted item ${id} is ABSENT from app.nodes()`);
  if (node.type !== type) throw new Error(`${type}: node type is "${node.type}", expected "${type}"`);
  if (all.length !== before + 1) throw new Error(`${type}: node count went ${before} → ${all.length} (expected +1)`);

  const display = node.plugin.emit(node.state);
  if (!Array.isArray(display) || display.length === 0) throw new Error(`${type}: emit() produced no display commands`);

  console.log(`  ok  ${type} — landed in app.nodes() as ${id} (${display.length} display op(s))`);
}

console.log("OK insert_api_probe — demo_comic and demo_glitch both insert via the app API and appear in app.nodes()");
