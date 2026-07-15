/**
 * THE UNIFICATION — expressions over variables, item properties, and anchors.
 *
 * "The properties can all be strings. If a numerical property is a string, it
 * means it's an equation. If it's an equation, it can read from variables.
 * And anchors are just variables that can be visualized." (manifest, round 5)
 *
 * WHAT IS AN EQUATION: a property is an equation slot iff the plugin's default
 * for that (possibly nested) key is a NUMBER and the folded value is a STRING.
 * That single rule keeps `name`, `text`, and `fill` (string defaults) out of
 * the expression system with no per-plugin annotations. Variables (state.vars)
 * are numbers by definition, so every string var is an equation.
 *
 * GRAMMAR (tiny recursive descent — arithmetic over references):
 *   expr   := term (("+" | "-") term)*
 *   term   := factor (("*" | "/") factor)*
 *   factor := NUMBER | REF | "(" expr ")" | "-" factor
 *
 * REFERENCE SYNTAX (display form — what the user types and sees):
 *   speed                bare identifier         → variable state.vars.speed
 *   circle.x             <itemSlug>.<prop...>    → item property (world state)
 *   circle_tm.x          <itemSlug>_<anchorId>.x → anchor world coordinate
 *   circle_closest.x     the computed closest-point anchor (arrow endpoints)
 * Ambiguity rule (documented, deterministic): a dotted head resolves as an
 * item slug FIRST; only if no item has that slug is it split on its LAST "_"
 * and tried as <itemSlug>_<anchorId>. Bare names are ALWAYS variables.
 *
 * STORED SYNTAX (what lives in the document): identical grammar, but item
 * references use "@<itemId>" in place of the slug: "@ab12cd34.x + 10",
 * "@ab12cd34_tm.x". DESIGN DECISION — store by itemId, display as slugs:
 * renames then need NO document rewrites (a slug is derived from the current
 * name at display time), which is the failure-proof option; slug-at-parse
 * with rename-rewrites would silently break any reference a rewrite missed.
 * Variables are referenced by NAME in both forms (a variable's name IS its
 * identity, like a CSS custom property), so variable renames DO rewrite
 * equations — see withVariableRenamed. Display-form refs inside stored docs
 * are also legal (hand-written save files resolve against current slugs);
 * the editor always stores the @id form.
 *
 * EVALUATION lives in the derivation stage, post-fold: evaluateState() takes
 * a folded state, builds the dependency graph over all equation slots,
 * topo-sorts (Kahn), and evaluates. Cycles are a LOUD error: every slot on
 * the cycle gets an error message (rendered as the Property Panel's error
 * affordance), the console explains the cycle once, and the slot falls back
 * to its plugin default (never a silent NaN). RenderTree stays
 * pure(Document, [[delta, alpha]]) — evaluation is deterministic.
 *
 * The "closest" computed anchor needs a toward-point (closest to WHAT?), so
 * after the main pass (closest refs use the owner plugin's closestToward()
 * with still-unevaluated coords roughed to 0) the closest-bearing slots are
 * re-evaluated in Gauss-Seidel sweeps UNTIL the estimated residual error
 * drops under CLOSEST_EPS_PX. Mutual-closest pairs (both endpoints computed,
 * each aiming at the other) converge geometrically, and the contraction
 * weakens as the two shapes approach tangency — probe-measured: a 1px gap
 * needs ~82 sweeps where ordinary layouts need 2-4 — so a FIXED sweep count
 * cannot hold the tolerance (the original two fixed sweeps left a visible
 * ~10px error at a 1px gap).
 */

import { isTree, copied, getPath, setPath, leaves } from "./deltas.js";
import * as T from "./transform.js";

// ── Tokenizer ────────────────────────────────────────────────────────────────

const OP_CHARS = "+-*/()";
const NUM_RE = /^(?:\d+\.?\d*|\.\d+)/;
// A reference token: optional "@" (stored item ref), then an identifier chain.
const REF_RE = /^@?[A-Za-z0-9_]+(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

/**
 * Pure function. Tokenizes an expression source string.
 *
 * Returns [{kind: "num"|"ref"|"op", value, start, end}] with source
 * positions (so display↔stored conversion can rewrite refs in place).
 * Throws on any character outside the grammar.
 *
 * @example tokenize("speed * 2").map((t) => t.kind) // ["ref", "op", "num"]
 * @example tokenize("@ab12_tm.x + 10")[0].value // "@ab12_tm.x"
 * @example // tokenize("3 $ 4") throws: Unexpected character "$" at 2
 */
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (OP_CHARS.includes(ch)) {
      tokens.push({ kind: "op", value: ch, start: i, end: i + 1 });
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = NUM_RE.exec(src.slice(i));
      if (!m) throw new Error(`Malformed number at ${i} in "${src}"`);
      tokens.push({ kind: "num", value: parseFloat(m[0]), start: i, end: i + m[0].length });
      i += m[0].length;
    } else if (ch === "@" || /[A-Za-z_]/.test(ch)) {
      const m = REF_RE.exec(src.slice(i));
      if (!m || m[0] === "@") throw new Error(`Malformed reference at ${i} in "${src}"`);
      tokens.push({ kind: "ref", value: m[0], start: i, end: i + m[0].length });
      i += m[0].length;
    } else {
      throw new Error(`Unexpected character "${ch}" at ${i} in "${src}"`);
    }
  }
  return tokens;
}

/**
 * Pure function. Parses an expression into an AST.
 *
 * AST nodes: {kind: "num", value} | {kind: "ref", name} |
 * {kind: "neg", arg} | {kind: "bin", op, left, right}. Throws (with
 * position) on syntax errors. A leading "=" is tolerated and ignored —
 * the spreadsheet-style equation affordance.
 *
 * @example parseExpression("2 + 3 * x") // {kind: "bin", op: "+", left: {kind: "num", value: 2}, right: {kind: "bin", op: "*", left: {kind: "num", value: 3}, right: {kind: "ref", name: "x"}}}
 * @example parseExpression("-(a.x)") // {kind: "neg", arg: {kind: "ref", name: "a.x"}}
 * @example // parseExpression("1 +") throws: Unexpected end of expression
 */
export function parseExpression(src) {
  const clean = src.replace(/^\s*=\s*/, ""); // spreadsheet-style leading "="
  const tokens = tokenize(clean);
  let pos = 0;
  const peek = () => tokens[pos];
  const takeOp = (...ops) => {
    const t = tokens[pos];
    if (t?.kind === "op" && ops.includes(t.value)) return tokens[pos++].value;
    return null;
  };
  function expr() {
    let node = term();
    let op;
    while ((op = takeOp("+", "-"))) node = { kind: "bin", op, left: node, right: term() };
    return node;
  }
  function term() {
    let node = factor();
    let op;
    while ((op = takeOp("*", "/"))) node = { kind: "bin", op, left: node, right: factor() };
    return node;
  }
  function factor() {
    if (takeOp("-")) return { kind: "neg", arg: factor() };
    if (takeOp("(")) {
      const inner = expr();
      if (!takeOp(")")) throw new Error(`Missing ")" at ${peek()?.start ?? clean.length} in "${clean}"`);
      return inner;
    }
    const t = peek();
    if (!t) throw new Error(`Unexpected end of expression in "${clean}"`);
    if (t.kind === "num") return { kind: "num", value: tokens[pos++].value };
    if (t.kind === "ref") return { kind: "ref", name: tokens[pos++].value };
    throw new Error(`Unexpected "${t.value}" at ${t.start} in "${clean}"`);
  }
  const ast = expr();
  if (pos < tokens.length)
    throw new Error(`Unexpected "${tokens[pos].value}" at ${tokens[pos].start} in "${clean}"`);
  return ast;
}

const parseCache = new Map(); // src → {ast, refs} (parse is pure; cache is safe)

/**
 * Near-pure function (memoizes into a module cache). Parsed form of an
 * expression: {ast, refs} where refs is the unique reference tokens.
 *
 * @example compiled("speed * 2 + speed").refs // ["speed"]
 */
export function compiled(src) {
  let c = parseCache.get(src);
  if (!c) {
    const ast = parseExpression(src);
    const refs = [];
    (function walk(n) {
      if (n.kind === "ref" && !refs.includes(n.name)) refs.push(n.name);
      if (n.kind === "neg") walk(n.arg);
      if (n.kind === "bin") { walk(n.left); walk(n.right); }
    })(ast);
    parseCache.set(src, (c = { ast, refs }));
  }
  return c;
}

/**
 * Pure function. Evaluates an AST; lookup(refToken) supplies reference values
 * (and throws on unknown references).
 *
 * @example evalAst(parseExpression("2 + x * 3"), () => 4) // 14
 * @example evalAst(parseExpression("-(1 + 1)"), () => 0) // -2
 */
export function evalAst(ast, lookup) {
  switch (ast.kind) {
    case "num": return ast.value;
    case "ref": return lookup(ast.name);
    case "neg": return -evalAst(ast.arg, lookup);
    case "bin": {
      const a = evalAst(ast.left, lookup);
      const b = evalAst(ast.right, lookup);
      switch (ast.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
      }
    }
  }
  throw new Error(`Unknown AST node: ${JSON.stringify(ast)}`);
}

// ── Slugs (identifier naming) ────────────────────────────────────────────────

/**
 * Pure function. Item name → identifier slug: lowercase, runs of
 * non-alphanumerics collapse to "_", trimmed; a leading digit gets a "_"
 * prefix (identifiers can't start with a digit); empty names become "item".
 *
 * @example slugify("Circle Top") // "circle_top"
 * @example slugify("2nd Box!") // "_2nd_box"
 * @example slugify("---") // "item"
 */
export function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return "item";
  return /^\d/.test(s) ? `_${s}` : s;
}

/**
 * Pure function. The slug↔itemId maps for a folded state. Named items slug
 * from their name; unnamed items get "<type>_<id-prefix>" (stable across
 * sessions — the id prefix never changes). Collisions dedupe in items-map
 * iteration order (fold order = creation order) by appending _2, _3, ...
 *
 * @example slugMap({items: {ab12cd34: {type: "rect", name: "Box"}}}).toId.get("box") // "ab12cd34"
 * @example slugMap({items: {ab12cd34: {type: "rect"}}}).toSlug.get("ab12cd34") // "rect_ab12"
 */
export function slugMap(state) {
  const toId = new Map();
  const toSlug = new Map();
  for (const [id, item] of Object.entries(state.items ?? {})) {
    // Not-yet-created items (type hasn't folded in — imaginary-slide
    // semantics) are unreferencable: no slug. References to them resolve as
    // unknown and fall back LOUDLY in evaluation — correct, not silent.
    if (typeof item?.type !== "string") continue;
    const base = item.name ? slugify(item.name) : `${item.type}_${id.slice(0, 4)}`;
    let slug = base;
    for (let n = 2; toId.has(slug); n++) slug = `${base}_${n}`;
    toId.set(slug, id);
    toSlug.set(id, slug);
  }
  return { toId, toSlug };
}

/**
 * Pure function. The referencable display name of an anchor —
 * "<itemSlug>_<anchorId>" (what the hover tooltip shows and what the user
 * types before ".x"/".y").
 *
 * @example anchorRefName({items: {ab12cd34: {type: "circle", name: "Moon"}}}, "ab12cd34", "tm") // "moon_tm"
 */
export function anchorRefName(state, itemId, anchorId) {
  return `${slugMap(state).toSlug.get(itemId) ?? itemId}_${anchorId}`;
}

// ── Reference resolution ─────────────────────────────────────────────────────

/**
 * Pure function. Parses a STORED "@"-form reference token.
 *
 * Forms: "@<itemId>.<prop...>" (item property) and "@<itemId>_<anchorId>.x|y"
 * (anchor coordinate). Item ids never contain "_", so the split is
 * unambiguous. Returns {kind: "prop", itemId, path} or
 * {kind: "anchor", itemId, anchorId, coord}.
 *
 * @example parseStoredRef("@ab12cd34.x") // {kind: "prop", itemId: "ab12cd34", path: ["x"]}
 * @example parseStoredRef("@ab12cd34_tm.y") // {kind: "anchor", itemId: "ab12cd34", anchorId: "tm", coord: "y"}
 */
export function parseStoredRef(token) {
  const dot = token.indexOf(".");
  if (dot === -1) throw new Error(`Item reference needs a property: "${token}"`);
  const head = token.slice(1, dot);
  const path = token.slice(dot + 1).split(".");
  const us = head.indexOf("_");
  if (us === -1) return { kind: "prop", itemId: head, path };
  const anchorId = head.slice(us + 1);
  if (path.length !== 1 || (path[0] !== "x" && path[0] !== "y"))
    throw new Error(`Anchor reference must end in .x or .y: "${token}"`);
  return { kind: "anchor", itemId: head.slice(0, us), anchorId, coord: path[0] };
}

/** "center" reads far better than the internal "cm" anchor id in the default
 * rotation pivot self.anchors.center — the two name the same point. */
const CENTER_ANCHOR_ALIAS = "cm";

/**
 * Pure function. Parses a `self.…` reference for the item that OWNS the slot.
 * `selfId` is that owner's itemId (the derivation stage knows it — the
 * expression lives in items.<selfId>.…). `self` is IDENTITY-STABLE: it names
 * the owner directly, so it needs NO document rewrite on rename (unlike a slug
 * reference), and it is stored LITERALLY as "self" (never rewritten to @id).
 *
 * Forms:
 *   self.<prop...>              → {kind: "prop", itemId: selfId, path}
 *   self.anchors.<id>.x|y       → {kind: "anchor", itemId: selfId, anchorId,
 *                                   coord, selfBase: true}
 * "center" is an alias for the "cm" center anchor. selfBase marks the anchor
 * for BASE-FRAME (rotation-zeroed) evaluation: a self anchor used as the
 * rotation pivot must be a FIXED point, not one that spins with the object.
 *
 * @example parseSelfRef("self.w", "a1") // {kind: "prop", itemId: "a1", path: ["w"]}
 * @example parseSelfRef("self.anchors.center.x", "a1") // {kind: "anchor", itemId: "a1", anchorId: "cm", coord: "x", selfBase: true}
 */
export function parseSelfRef(token, selfId) {
  if (selfId == null) throw new Error(`"self" is only valid in an item's own equation: "${token}"`);
  const parts = token.split(".");
  const path = parts.slice(1); // drop "self"
  if (path.length === 0) throw new Error(`"self" needs a property: "${token}"`);
  if (path[0] === "anchors") {
    const coord = path[path.length - 1];
    if (path.length !== 3 || (coord !== "x" && coord !== "y"))
      throw new Error(`Self anchor reference must be self.anchors.<id>.x|y: "${token}"`);
    const anchorId = path[1] === "center" ? CENTER_ANCHOR_ALIAS : path[1];
    return { kind: "anchor", itemId: selfId, anchorId, coord, selfBase: true };
  }
  return { kind: "prop", itemId: selfId, path };
}

/**
 * Pure function. Resolves any reference token (display or stored form) to a
 * descriptor: {kind: "var", name} | {kind: "prop", itemId, path} |
 * {kind: "anchor", itemId, anchorId, coord}. Throws with a helpful message
 * when nothing matches. `slugs` is a slugMap(state). `selfId` (optional) is
 * the owner item's id, enabling `self.…` references.
 *
 * @example resolveRef("speed", slugMap({items: {}})) // {kind: "var", name: "speed"}
 * @example resolveRef("box.x", slugMap({items: {a1: {type: "rect", name: "Box"}}})) // {kind: "prop", itemId: "a1", path: ["x"]}
 * @example resolveRef("box_tm.x", slugMap({items: {a1: {type: "rect", name: "Box"}}})) // {kind: "anchor", itemId: "a1", anchorId: "tm", coord: "x"}
 * @example resolveRef("self.w", slugMap({items: {}}), "a1") // {kind: "prop", itemId: "a1", path: ["w"]}
 */
export function resolveRef(token, slugs, selfId = null) {
  if (token.startsWith("@")) return parseStoredRef(token);
  if (token === "self" || token.startsWith("self.")) return parseSelfRef(token, selfId);
  const [head, ...path] = token.split(".");
  if (path.length === 0) return { kind: "var", name: token };
  if (slugs.toId.has(head)) return { kind: "prop", itemId: slugs.toId.get(head), path };
  const us = head.lastIndexOf("_");
  if (us > 0) {
    const itemSlug = head.slice(0, us);
    if (slugs.toId.has(itemSlug)) {
      if (path.length !== 1 || (path[0] !== "x" && path[0] !== "y"))
        throw new Error(`Anchor reference must end in .x or .y: "${token}"`);
      return { kind: "anchor", itemId: slugs.toId.get(itemSlug), anchorId: head.slice(us + 1), coord: path[0] };
    }
  }
  throw new Error(`Unknown reference "${token}" — no item slug or variable named "${head}"`);
}

/**
 * Pure function. Rewrites an expression's reference tokens via mapToken,
 * preserving all spacing/operators exactly (tokens carry positions).
 *
 * @example mapRefTokens("a + b", (t) => t.toUpperCase()) // "A + B"
 */
export function mapRefTokens(src, mapToken) {
  let out = "";
  let last = 0;
  for (const t of tokenize(src)) {
    if (t.kind !== "ref") continue;
    out += src.slice(last, t.start) + mapToken(t.value);
    last = t.end;
  }
  return out + src.slice(last);
}

/**
 * Pure function. Display form → stored form: item slugs become @itemIds
 * (variables stay bare). Throws on syntax errors, unresolvable slugs, and
 * UNKNOWN VARIABLES (typo protection at entry time; eval-time still reports
 * vars that disappear later) — the equation field surfaces the throw as its
 * invalid affordance. A leading "=" (spreadsheet affordance) is stripped.
 *
 * `self.…` tokens are IDENTITY-STABLE (they name the owner, not a slug) and
 * are stored VERBATIM — no @id rewrite, so they survive renames untouched.
 *
 * @example displayToStored("box.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) // "@a1.x + 10"
 * @example displayToStored("speed * 2", {vars: {speed: 5}, items: {}}) // "speed * 2"
 * @example displayToStored("self.w / 2", {items: {}}) // "self.w / 2"
 * @example // displayToStored("sped * 2", {vars: {speed: 5}}) throws: Unknown variable "sped"
 */
export function displayToStored(src, state) {
  const clean = src.replace(/^\s*=\s*/, "");
  parseExpression(clean); // validate the full grammar, not just the tokens
  const slugs = slugMap(state);
  return mapRefTokens(clean, (token) => {
    if (token === "self" || token.startsWith("self.")) return token; // stored verbatim
    const d = resolveRef(token, slugs); // throws on unknown refs
    if (d.kind === "var") {
      if (!(d.name in (state.vars ?? {}))) throw new Error(`Unknown variable "${d.name}"`);
      return token;
    }
    if (d.kind === "prop") return `@${d.itemId}.${d.path.join(".")}`;
    return `@${d.itemId}_${d.anchorId}.${d.coord}`;
  });
}

/**
 * Pure function. Stored form → display form: @itemIds become current slugs.
 * Unknown ids (purged items) are left in @-form so the user can still see
 * and fix the reference. Never throws on resolvable syntax; malformed
 * sources are returned unchanged (the error affordance reports them).
 *
 * @example storedToDisplay("@a1.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) // "box.x + 10"
 * @example storedToDisplay("@a1_tm.y", {items: {a1: {type: "rect", name: "Box"}}}) // "box_tm.y"
 */
export function storedToDisplay(src, state) {
  const slugs = slugMap(state);
  let tokens;
  try {
    tokens = tokenize(src);
  } catch {
    return src; // malformed stays visible verbatim; evaluateState reports it
  }
  let out = "";
  let last = 0;
  for (const t of tokens) {
    if (t.kind !== "ref" || !t.value.startsWith("@")) continue;
    let mapped = t.value;
    try {
      const d = parseStoredRef(t.value);
      const slug = slugs.toSlug.get(d.itemId);
      if (slug) mapped = d.kind === "prop" ? `${slug}.${d.path.join(".")}` : `${slug}_${d.anchorId}.${d.coord}`;
    } catch {
      // Unparseable @token: keep it verbatim (evaluateState reports it).
    }
    out += src.slice(last, t.start) + mapped;
    last = t.end;
  }
  return out + src.slice(last);
}

// ── Equation slots ───────────────────────────────────────────────────────────

/**
 * Pure function. Is this (possibly nested) item property a NUMERIC slot —
 * i.e. may a string stored there be treated as an equation? True iff the
 * plugin's default for the path is a NUMBER, or a COMPUTED-DEFAULT equation
 * string (one beginning with "self." — e.g. rotationAnchor.x defaults to
 * "self.anchors.center.x"). The "self." form is the ONLY string default that
 * is itself an equation; every label/color default (name "Text", fill
 * "#7aa2f7") is a plain string that is NOT self-prefixed, so this stays
 * structural (derived from the default's form) with no per-plugin annotations
 * — the rule that keeps name/text/fill out of the expression system holds.
 *
 * @example isNumericSlot({defaults: {x: 100, name: "?"}}, ["x"]) // true
 * @example isNumericSlot({defaults: {name: "?"}}, ["name"]) // false
 * @example isNumericSlot({defaults: {from: {x: 0}}}, ["from", "x"]) // true
 * @example isNumericSlot({defaults: {rotationAnchor: {x: "self.anchors.center.x"}}}, ["rotationAnchor", "x"]) // true
 */
export function isNumericSlot(plugin, path) {
  const def = getPath(plugin.defaults, path);
  if (typeof def === "number") return true;
  return typeof def === "string" && def.startsWith("self.");
}

/** Command (mutates tree in place). Sets a leaf at path, creating nodes. */
function mutSetPath(tree, path, value) {
  let cur = tree;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isTree(cur[path[i]])) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

// ── Evaluation (the derivation-stage expression pass) ────────────────────────

const evalMemo = new WeakMap(); // state object → {registry, result}
const loggedErrors = new Set(); // messages already console.error'd (once each)
// The geometry a base-frame self anchor (rotation pivot) reads — never
// rotation or rotationAnchor, so the pivot is a stable fixed point.
const SELF_ANCHOR_DEP_PROPS = new Set(["x", "y", "w", "h", "scale"]);
// Mutual-closest fixpoint tolerance: the residual-error bound the sweeps
// converge to. LINKED PRECEDENT: the manifest's own convergence claim
// ("mutual-closest converges to <0.01px") — now enforced, not assumed.
const CLOSEST_EPS_PX = 0.01;
// Sweep cap. Probe-measured: the worst legitimate geometry (two circles
// 0.1px from tangent) settles in ~130 sweeps; ordinary layouts take 2-4.
// 1000 gives order-of-magnitude headroom at negligible cost (a sweep is a
// few trig evals per closest slot). Hitting the cap is REPORTED, never
// silent. (Safety bound, not tuned behavior — PENDING USER RATIFICATION.)
const MAX_CLOSEST_SWEEPS = 1000;

/**
 * Near-pure function (memoized on state identity; console.errors each NEW
 * error message once — never silently). THE derivation-stage expression
 * pass: folded state → same-shaped state with every equation slot replaced
 * by its evaluated number, plus an error map.
 *
 * Returns {state, errors} where errors maps "items.a1.x"-style joined paths
 * to human messages. Errored slots (syntax errors, unknown references,
 * cycles, non-finite results) fall back to the plugin default for the key
 * (0 for variables) — deterministic, never a silent NaN; the UI renders the
 * error affordance from the map.
 *
 * Dependency rules:
 *   - variable ref  → that vars slot (if it is itself an equation)
 *   - property ref  → that item-property slot (if it is an equation)
 *   - anchor ref    → ALL equation slots of the referenced item
 *     (conservative: anchors read the item's transform + bbox)
 *   - "closest" anchors additionally resolve by fixpoint sweeps to a
 *     < CLOSEST_EPS_PX residual (V1 resolveEndpoints semantics, now
 *     convergence-gated) using the owner plugin's
 *     closestToward(state, pathWithinItem) hook — the arrow supplies its
 *     other endpoint.
 *
 * @example evaluateState({vars: {speed: 5}, items: {a1: {type: "rect", x: "speed * 2"}}}, registry).state.items.a1.x // 10
 * @example // Cycle: {vars: {a: "b", b: "a"}} → errors.get("vars.a") mentions the cycle; values fall back to 0
 */
export function evaluateState(state, registry) {
  const memo = evalMemo.get(state);
  if (memo && memo.registry === registry) return memo.result;
  const result = computeEvaluatedState(state, registry);
  evalMemo.set(state, { registry, result });
  return result;
}

/** Pure-core of evaluateState (see its docs); uncached. */
function computeEvaluatedState(state, registry) {
  const out = copied(state);
  const errors = new Map();
  const slugs = slugMap(state);
  const slots = new Map(); // key ("items.a1.x") → slot

  const fallbackFor = (path) => {
    if (path[0] !== "items") return 0; // variables have no plugin defaults
    const item = state.items[path[1]];
    return getPath(registry.get(item.type).defaults, path.slice(2)) ?? 0;
  };
  const fail = (slot, message) => {
    errors.set(slot.key, message);
    mutSetPath(out, slot.path, fallbackFor(slot.path));
    if (!loggedErrors.has(message)) {
      loggedErrors.add(message);
      console.error(`PowerRP expression error at ${slot.key}: ${message}`);
    }
  };

  // 1. Collect equation slots (string-valued numeric leaves).
  for (const [name, value] of Object.entries(state.vars ?? {}))
    if (typeof value === "string")
      slots.set(`vars.${name}`, { key: `vars.${name}`, path: ["vars", name], src: value });
  for (const [id, item] of Object.entries(state.items ?? {})) {
    // An item whose `type` hasn't folded in yet DOES NOT EXIST YET (the
    // imaginary-slide semantics) — legitimate mid-document state when a
    // creation slide sits BELOW a slide that keyframes the item (e.g. after
    // Move Slide Down; Opus3's 3-keystroke crash repro). Skip, never throw:
    // it "exists" again on folds that include its creation delta.
    if (typeof item?.type !== "string") continue;
    const plugin = registry.get(item.type);
    for (const [path, value] of leaves(item))
      if (typeof value === "string" && isNumericSlot(plugin, path)) {
        const key = ["items", id, ...path].join(".");
        slots.set(key, { key, path: ["items", id, ...path], src: value });
      }
  }

  // 2. Parse + resolve references → dependency edges.
  const itemSlotKeys = new Map(); // itemId → [slot keys] (for anchor deps)
  for (const slot of slots.values())
    if (slot.path[0] === "items") {
      if (!itemSlotKeys.has(slot.path[1])) itemSlotKeys.set(slot.path[1], []);
      itemSlotKeys.get(slot.path[1]).push(slot.key);
    }
  for (const slot of [...slots.values()]) {
    slot.deps = new Set();
    slot.descriptors = new Map(); // ref token → descriptor
    slot.hasClosest = false;
    // `self` resolves to the item that OWNS this slot (its equations live in
    // items.<selfId>.…). Variable slots have no self (self is meaningless
    // there); a `self.…` token in a variable throws, reported per-slot.
    const selfId = slot.path[0] === "items" ? slot.path[1] : null;
    try {
      const { ast, refs } = compiled(slot.src);
      slot.ast = ast;
      for (const token of refs) {
        const d = resolveRef(token, slugs, selfId);
        slot.descriptors.set(token, d);
        if (d.kind === "var") {
          if (!(d.name in (state.vars ?? {})))
            throw new Error(`Unknown variable "${d.name}"`);
          if (slots.has(`vars.${d.name}`)) slot.deps.add(`vars.${d.name}`);
        } else if (d.kind === "prop") {
          const item = state.items?.[d.itemId];
          if (!item) throw new Error(`Unknown item "@${d.itemId}" in "${token}"`);
          const raw = getPath(item, d.path);
          if (raw === undefined) throw new Error(`Item "${slugs.toSlug.get(d.itemId)}" has no property "${d.path.join(".")}"`);
          const depKey = ["items", d.itemId, ...d.path].join(".");
          if (typeof raw === "string" && !slots.has(depKey))
            throw new Error(`"${token}" is not a numeric property`);
          if (slots.has(depKey)) slot.deps.add(depKey);
        } else {
          // anchor
          const item = state.items?.[d.itemId];
          if (!item) throw new Error(`Unknown item "@${d.itemId}" in "${token}"`);
          const plugin = registry.get(item.type);
          if (d.anchorId === "closest") {
            if (!plugin.closestAnchor)
              throw new Error(`"${slugs.toSlug.get(d.itemId)}" has no computed closest anchor`);
            slot.hasClosest = true;
          } else if (!(plugin.anchors?.(item) ?? []).some((a) => a.id === d.anchorId)) {
            throw new Error(`"${slugs.toSlug.get(d.itemId)}" has no anchor "${d.anchorId}"`);
          }
          // A self anchor (rotation pivot) evaluates in the ROTATION-ZEROED base
          // frame from geometry only (x,y,w,h,scale) — never rotation or the
          // rotationAnchor slots — so it depends only on those geometry slots,
          // NOT conservatively on all of the owner's slots. This keeps the
          // default rotationAnchor {x,y} (both = self center) from spuriously
          // depending on each other (which would be a false cycle) and never
          // pivots the pivot on itself.
          const baseKeys = d.selfBase
            ? (itemSlotKeys.get(d.itemId) ?? []).filter((k) => SELF_ANCHOR_DEP_PROPS.has(k.split(".")[2]))
            : (itemSlotKeys.get(d.itemId) ?? []);
          for (const depKey of baseKeys)
            if (depKey !== slot.key) slot.deps.add(depKey);
        }
      }
    } catch (e) {
      fail(slot, e.message);
      slots.delete(slot.key);
    }
  }

  // 3. Evaluation lookup (reads the evolving `out` state).
  const lookupFor = (slot) => (token) => {
    const d = slot.descriptors.get(token);
    if (d.kind === "var") return out.vars[d.name];
    if (d.kind === "prop") return getPath(out.items[d.itemId], d.path);
    const item = out.items[d.itemId];
    const plugin = registry.get(item.type);
    // A self anchor used as a rotation pivot must be a FIXED point, so it maps
    // through the ROTATION-ZEROED base frame (self.anchors.center of a rotated
    // box is its geometric center, not a center that spins with the box).
    const world = d.selfBase ? { ...T.fromState(item), rotation: 0 } : T.fromState(item);
    if (d.anchorId === "closest") {
      const owner = getPath(out, slot.path.slice(0, 2));
      const ownerPlugin = slot.path[0] === "items" ? registry.get(owner.type) : null;
      const toward = ownerPlugin?.closestToward?.(owner, slot.path.slice(2));
      if (!toward)
        throw new Error(`"closest" anchor needs a toward context — only widgets with a closestToward hook (arrows) can use it`);
      // Rough pass: a still-unevaluated (string) coordinate reads as 0; the
      // closest-bearing slots are re-evaluated in pass 2 with final numbers
      // (V1 resolveEndpoints' two-pass fixpoint, reproduced).
      const tx = typeof toward.x === "number" ? toward.x : 0;
      const ty = typeof toward.y === "number" ? toward.y : 0;
      const local = plugin.closestAnchor(item, tx, ty, world);
      return T.apply(world, local.x, local.y)[d.coord];
    }
    const anchor = plugin.anchors(item).find((a) => a.id === d.anchorId);
    return T.apply(world, anchor.x, anchor.y)[d.coord];
  };
  const evalSlot = (slot) => {
    try {
      const v = evalAst(slot.ast, lookupFor(slot));
      if (!Number.isFinite(v)) throw new Error(`evaluates to ${v}`);
      mutSetPath(out, slot.path, v);
    } catch (e) {
      fail(slot, e.message);
    }
  };

  // 4. Kahn topo sort + evaluate. Dep errors don't block consumers — the
  //    errored dep already holds its fallback number (reported at its source).
  //    Prune deps that point to a slot which FAILED resolution and was deleted
  //    from `slots` (e.g. a rotation anchor reading a sibling w that has a bad
  //    reference): that dep already carries its fallback in `out`, so the edge
  //    is dropped — otherwise its indegree could never reach 0 and Kahn would
  //    stall, misreporting the survivor as a cycle.
  for (const slot of slots.values())
    slot.deps = new Set([...slot.deps].filter((dep) => slots.has(dep)));
  const dependents = new Map(); // key → [keys that depend on it]
  const indegree = new Map();
  for (const slot of slots.values()) indegree.set(slot.key, slot.deps.size);
  for (const slot of slots.values())
    for (const dep of slot.deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(slot.key);
    }
  const remaining = new Set(slots.keys());
  const queue = [...slots.values()].filter((s) => s.deps.size === 0).map((s) => s.key);
  const settle = (key) => {
    remaining.delete(key);
    for (const next of dependents.get(key) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  };
  for (;;) {
    while (queue.length) {
      const key = queue.shift();
      if (!remaining.has(key)) continue; // already settled (failed cycle member)
      evalSlot(slots.get(key));
      settle(key);
    }
    if (remaining.size === 0) break;
    // 5. A CYCLE blocks progress: fail exactly the slots ON the cycle (loud
    //    error naming the chain), then resume — slots merely DOWNSTREAM of a
    //    cycle still evaluate, reading the failed slots' fallback numbers.
    const chain = cycleChain(slots, remaining, remaining.values().next().value);
    const message = `Cyclic expressions: ${[...chain, chain[0]].join(" → ")}`;
    for (const key of chain) {
      fail(slots.get(key), message);
      settle(key);
    }
  }

  // 6. Closest fixpoint sweeps (see module docs). Gauss-Seidel: each sweep
  //    re-evaluates every closest-bearing slot against ever-fresher numbers.
  //    STOP RULE: successive sweep movements shrink geometrically (ratio r),
  //    so the remaining error is ≈ moved·r/(1−r) — movement ALONE understates
  //    the residual exactly when contraction is weak (nearly tangent shapes),
  //    which is why the estimate, not the raw movement, is compared against
  //    CLOSEST_EPS_PX. Ordinary layouts stop after 2 sweeps (same cost as the
  //    old fixed-two); near-tangency runs as long as it needs under the cap.
  let prevMoved = null;
  for (let sweep = 0; sweep < MAX_CLOSEST_SWEEPS; sweep++) {
    let moved = 0;
    for (const slot of slots.values()) {
      if (!slot.hasClosest || errors.has(slot.key)) continue;
      const before = getPath(out, slot.path);
      evalSlot(slot);
      const after = getPath(out, slot.path);
      if (typeof before === "number" && typeof after === "number")
        moved = Math.max(moved, Math.abs(after - before));
    }
    if (moved === 0) break; // exact fixpoint (or no closest slots at all)
    if (prevMoved !== null) {
      const r = Math.min(moved / prevMoved, 0.999); // clamp: early transients can overshoot
      if ((moved * r) / (1 - r) < CLOSEST_EPS_PX) break;
    }
    prevMoved = moved;
    if (sweep === MAX_CLOSEST_SWEEPS - 1) {
      // Degenerate geometry (e.g. exactly tangent circles) may never meet the
      // tolerance: keep the best iterate, but NEVER silently — report once.
      const message = `closest-anchor fixpoint still moving after ${MAX_CLOSEST_SWEEPS} sweeps — keeping the last iterate (near-degenerate geometry?)`;
      if (!loggedErrors.has(message)) {
        loggedErrors.add(message);
        console.error(`PowerRP expression warning: ${message}`);
      }
    }
  }

  return { state: out, errors };
}

/**
 * Pure function. Walks unresolved deps from `start` until a key repeats,
 * returning exactly the slots ON the cycle (a start that merely depends on
 * the cycle walks into it and is not included), e.g. ["vars.a", "vars.b"].
 * Every unresolved slot has ≥1 unresolved dep (else Kahn would have
 * processed it), so the walk always terminates at a repeat within N steps.
 */
function cycleChain(slots, remaining, start) {
  const chain = [start];
  let cur = start;
  for (;;) {
    const next = [...slots.get(cur).deps].find((d) => remaining.has(d));
    const at = chain.indexOf(next);
    if (at !== -1) return chain.slice(at);
    chain.push(next);
    cur = next;
  }
}

// ── Migration + variable rename ──────────────────────────────────────────────

/**
 * Pure function. Migrates legacy {item, anchor} endpoint bindings in every
 * slide delta to equation pairs — the load-time companion of
 * withCameraEnsured. {x, y} free endpoints stay plain. Any stale x/y keys
 * mixed into a binding subtree (the old detach-after-bind merge bug) are
 * dropped: the binding wins, matching V1 resolveBinding's precedence.
 *
 * @example // withBindingsMigrated(doc) turns delta items.A.from = {item: "c1", anchor: "tm"}
 * @example // into items.A.from = {x: "@c1_tm.x", y: "@c1_tm.y"}
 */
export function withBindingsMigrated(doc) {
  let changed = false;
  const slides = doc.slides.map((slide) => {
    let delta = slide.delta;
    for (const [itemId, sub] of Object.entries(delta.items ?? {})) {
      if (!isTree(sub)) continue;
      for (const [key, value] of Object.entries(sub)) {
        if (!isTree(value) || typeof value.item !== "string" || typeof value.anchor !== "string") continue;
        delta = setPath(delta, ["items", itemId, key], {
          x: `@${value.item}_${value.anchor}.x`,
          y: `@${value.item}_${value.anchor}.y`,
        });
        changed = true;
      }
    }
    return delta === slide.delta ? slide : { ...slide, delta };
  });
  return changed ? { ...doc, slides } : doc;
}

/**
 * Pure function. Renames a variable document-wide: every vars.<oldName>
 * keyframe moves to vars.<newName>, and every equation (numeric-slot string
 * in any slide delta, plus every vars equation) has its bare `oldName`
 * reference tokens rewritten. Variables are referenced BY NAME (their name
 * is their identity), so rename must rewrite — unlike items, which are
 * stored by id and never need this. Throws if newName is not a valid
 * identifier or already exists as a variable.
 *
 * @example // withVariableRenamed(doc, "speed", "velocity", registry):
 * @example //   delta.vars.speed: 5        → delta.vars.velocity: 5
 * @example //   items.a1.x: "speed * 2"    → items.a1.x: "velocity * 2"
 */
export function withVariableRenamed(doc, oldName, newName, registry) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName))
    throw new Error(`"${newName}" is not a valid variable name (letters, digits, _; not starting with a digit)`);
  for (const slide of doc.slides)
    if (slide.delta.vars && newName in slide.delta.vars)
      throw new Error(`A variable named "${newName}" already exists`);
  const renameRefs = (src) => {
    try {
      return mapRefTokens(src, (token) => (token === oldName ? newName : token));
    } catch {
      return src; // not a parseable equation — leave it (its own error affordance reports it)
    }
  };
  const slides = doc.slides.map((slide) => {
    let delta = slide.delta;
    if (delta.vars && oldName in delta.vars) {
      const vars = { ...delta.vars };
      vars[newName] = typeof vars[oldName] === "string" ? renameRefs(vars[oldName]) : vars[oldName];
      delete vars[oldName];
      delta = { ...delta, vars };
    }
    if (delta.vars) {
      const vars = Object.fromEntries(Object.entries(delta.vars).map(([k, v]) =>
        [k, typeof v === "string" ? renameRefs(v) : v]));
      delta = { ...delta, vars };
    }
    for (const [itemId, sub] of Object.entries(delta.items ?? {})) {
      if (!isTree(sub)) continue;
      const type = getPath(sub, ["type"]);
      // The item's plugin is needed for numeric-slot detection; the type may
      // be keyed on an earlier slide, so fall back to scanning all slides.
      const itemType = type ?? findItemType(doc, itemId);
      if (!itemType) continue;
      const plugin = registry.get(itemType);
      for (const [path, value] of leaves(sub))
        if (typeof value === "string" && isNumericSlot(plugin, path)) {
          const renamed = renameRefs(value);
          if (renamed !== value) delta = setPath(delta, ["items", itemId, ...path], renamed);
        }
    }
    return delta === slide.delta ? slide : { ...slide, delta };
  });
  return { ...doc, slides };
}

/** Pure function. The type an item is created with (first slide keying it), or null. */
function findItemType(doc, itemId) {
  for (const slide of doc.slides) {
    const t = getPath(slide.delta, ["items", itemId, "type"]);
    if (typeof t === "string") return t;
  }
  return null;
}
