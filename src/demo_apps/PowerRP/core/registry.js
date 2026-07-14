/**
 * Plugin registry — per-document-session, NOT a process global (BirdsEye
 * lesson: global singletons make multiple live documents impossible).
 *
 * A widget plugin is a declarative object:
 *   {
 *     type: "rect",                         // unique type string
 *     title: "Rectangle",                   // human name
 *     capabilities: {                       // tools/UI dispatch on these — NEVER on type
 *       bbox: true,        // state has x,y,w,h (w/h in LOCAL units, pre-transform)
 *       transform: true,   // state has x,y (+optional rotation, scale)
 *       resizable: true,   // resize handles allowed
 *       backdrop: false,   // paint() receives the composite-so-far snapshot
 *     },
 *     defaults: { ... },                    // initial state for a new instance
 *     inspector: [{key, label, kind}],      // kind: "number"|"color"|"text"|"checkbox"
 *     paint(ctx, state, env) { ... },       // draw in LOCAL coords; compositor
 *                                           // has already applied the similarity
 *                                           // transform. env: see compositor.js
 *     anchors(state) → [{id, x, y}]         // preset anchor points, LOCAL coords
 *     closestAnchor?(state, wx, wy)         // computed anchor: closest point on
 *                                           // outline to a WORLD point (local out)
 *     snapFeatures?(state) → [...]          // extra snap features (LOCAL); bbox
 *                                           // widgets get standard ones for free
 *     canSkip?(state, viewRectWorld) → bool // CULLING protocol: return true iff
 *                                           // this widget contributes nothing to
 *                                           // the given world-space view rect
 *                                           // {x,y,w,h} and may be skipped when
 *                                           // painting. Absent → the compositor's
 *                                           // default rule (bbox AABB outside the
 *                                           // view → skip; non-bbox never skips).
 *                                           // Backdrop samplers are ALWAYS painted
 *                                           // regardless of this hook.
 *     commands?: [{id, title, run(app)}]    // palette commands this plugin adds
 *   }
 *
 * No plugin may import another plugin. Composition happens through
 * tests/conventions_test.js).
 */

export function createRegistry() {
  const plugins = new Map();
  return {
    /** Command. Registers a plugin; loud on collision or malformed plugin. */
    register(plugin) {
      for (const field of ["type", "title", "capabilities", "defaults", "paint"])
        if (!(field in plugin)) throw new Error(`Plugin missing "${field}": ${plugin.type ?? "?"}`);
      if (plugins.has(plugin.type)) throw new Error(`Duplicate plugin type "${plugin.type}"`);
      plugins.set(plugin.type, plugin);
    },
    /** Query. Plugin by type; loud when unknown. */
    get(type) {
      const p = plugins.get(type);
      if (!p) throw new Error(`Unknown widget type "${type}". Registered: ${[...plugins.keys()].join(", ")}`);
      return p;
    },
    /** Query. All plugins, registration order. */
    all() {
      return [...plugins.values()];
    },
  };
}
