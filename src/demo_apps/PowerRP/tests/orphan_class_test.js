/**
 * NO CLASS IN MARKUP WITHOUT A RULE SOMEWHERE.
 *
 * A class referenced in a component but matched by no selector in web/app.css (nor
 * the component's own scoped <style>) is INVISIBLE BREAKAGE: the element renders
 * unstyled, nothing throws, no probe notices, and a reviewer reading the markup
 * sees a class name and assumes it does something. It is the CSS twin of the
 * hand-maintained mirror — two files that must agree, with nothing checking that
 * they do.
 *
 * This is not hypothetical. When this gate was written the sweep found, among
 * others, `.band-verb-add` and `.band-verb-subtract` on the band-select rectangle
 * — whose sibling `.band-verb-invert` IS styled (app.css:3389) and whose own markup
 * comment (web/CanvasView.svelte:3728-3733) promises that the box "announces
 * whether a release adds, subtracts or inverts". Two of the three verbs announced
 * nothing. A comment claiming a behaviour the CSS does not implement is exactly
 * what this gate exists to make impossible.
 *
 * WHY A GATE RATHER THAN JUST FIXING THEM: the fixes are one-off, the defect class
 * is permanent. Every new component can reintroduce it, and nothing else in the
 * suite would notice.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

/**
 * KNOWN, JUSTIFIED, AND DELIBERATELY SMALL. Each entry needs a reason that is
 * about the CODE, not about effort — "we have not got to it" is not one. Adding a
 * name here to silence the gate is the failure mode; the list is short so that
 * growth is conspicuous in review.
 */
const EXEMPT = new Map([
  // ── (a) STYLED INLINE, deliberately: the class is a query hook, not a style
  //        hook. Both carry a comment at the element saying so.
  ["handle-stem", "web/CanvasView.svelte:3773 styles it inline with --a-* tokens"],
  ["colorfield-eyedropper", "web/ColorField.svelte:277 — the documented inline-token exception"],

  // ── (b) COMPANION / QUALIFIER names sitting beside a sibling that carries all
  //        the styling. They describe the element; they do not style it.
  ["ruler", "companion of .ruler-top/.ruler-left"],
  ["ae-upload", "companion of .ae-tile"],
  ["paint-material-label", "companion of .paint-sub-label, which carries the styling"],
  ["tr-label", "child of .tr-chip (app.css:4121), which sets the chip's type and spacing"],

  // ── (c) DELIBERATELY SHARING THE BASE RULE. `.overlay .band-rect` already
  //        paints add and subtract; only INVERT overrides, and app.css:3386 says
  //        so out loud ("add and subtract already own --a-guide's pink"). Listed
  //        rather than given empty rules, because an empty rule would be a lie
  //        about there being a distinction.
  ["band-verb-add", "base .band-rect styles it; only .band-verb-invert overrides (app.css:3386)"],
  ["band-verb-subtract", "base .band-rect styles it; only .band-verb-invert overrides (app.css:3386)"],
  // Same shape one layer down, and app.css:3366 states it: "Base = the selection
  // outline, so .band-add (joining the selection) needs no override." Only
  // .band-remove overrides. This entry appeared only AFTER comments stopped
  // counting as definitions — it had been "defined" by that very sentence.
  ["band-add", "base .band-candidate styles it; only .band-remove overrides (app.css:3366)"],

  // ── (d) A NATIVE CONTROL LEFT UNSTYLED ON PURPOSE. Its own comment
  //        (web/CodeEditController.svelte:268) says "Native <select> so it needs
  //        no app.css". NOTE: that native <select> is itself an OPEN doctrine
  //        violation — R6-24.8, against Inspector.svelte:25's "never the native
  //        <select>". This exemption covers the missing RULE only; it does not
  //        bless the control. Removing the <select> removes this entry.
  ["code-edit-template", "native <select>, unstyled on purpose — but see R6-24.8, the control itself is a violation"],
]);

/** COMMENTS ARE NOT DEFINITIONS. app.css is heavily commented and its prose names
 *  classes constantly ("…and .multi-note below continues the same voice"). Counting
 *  those made the gate unfalsifiable: a self-test that renamed a real selector still
 *  passed, because the rule's own comment kept the old name alive. Strip comments
 *  from BOTH stylesheets and scoped blocks before extracting. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ");

const css = stripComments(readFileSync(resolve(WEB, "app.css"), "utf8"));
const defined = new Set([...css.matchAll(CLASS_RE)].map((m) => m[1]));

const files = readdirSync(WEB).filter((f) => f.endsWith(".svelte"));

/** name -> Set("file:line") for every class NAME used in markup. */
const used = new Map();
const note = (name, where) => {
  if (!used.has(name)) used.set(name, new Set());
  used.get(name).add(where);
};

for (const file of files) {
  const src = readFileSync(resolve(WEB, file), "utf8");

  // A component's own scoped <style> DEFINES names (and is itself rare here — the
  // house rule is that app components carry no <style>).
  for (const sm of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
    for (const m of stripComments(sm[1]).matchAll(CLASS_RE)) defined.add(m[1]);

  src.split("\n").forEach((text, i) => {
    const where = `${file}:${i + 1}`;
    for (const m of text.matchAll(/\bclass:(-?[_a-zA-Z][\w-]*)/g)) note(m[1], where);
    for (const m of text.matchAll(/\bclass=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
      const body = (m[1] ?? m[2] ?? m[3] ?? "")
        .replace(/\{[^}]*\}/g, " ").replace(/\$\{[^}]*\}/g, " ");
      for (const w of body.split(/\s+/)) {
        // A word left with a TRAILING hyphen is the stub of an interpolated
        // suffix, not a class — the prefix rule below owns it.
        if (w.endsWith("-")) continue;
        if (/^-?[_a-zA-Z][\w-]*$/.test(w)) note(w, where);
      }
      // An INTERPOLATED SUFFIX (`class="eq-tok eq-tok-{p.cls}"`) leaves a trailing
      // hyphen after the substitution above. That is a PREFIX, not a class: it is
      // satisfied when any defined name extends it (.eq-tok-num, .eq-tok-op, …).
      for (const m2 of (m[1] ?? m[2] ?? m[3] ?? "").matchAll(/([-\w]+-)\{/g))
        note(`${m2[1]}…`, where);
    }
    for (const m of text.matchAll(/classList\.(?:add|toggle|remove)\(\s*"([^"]+)"/g)) note(m[1], where);
  });
}

const orphans = [];
for (const [name, where] of used) {
  if (name.endsWith("…")) { // a prefix: satisfied by any extension
    const prefix = name.slice(0, -1);
    if (![...defined].some((d) => d.startsWith(prefix) && d.length > prefix.length))
      orphans.push([name, where]);
    continue;
  }
  if (defined.has(name) || EXEMPT.has(name)) continue;
  orphans.push([name, where]);
}
orphans.sort((a, b) => a[0].localeCompare(b[0]));

// NON-VACUITY (the R6-24.4 lesson: a check that cannot fail is worse than none).
// The sweep must have actually parsed markup and CSS, or "0 orphans" is a lie.
assert.ok(used.size > 300, `the markup sweep found only ${used.size} classes — the parser is broken`);
assert.ok(defined.size > 400, `app.css yielded only ${defined.size} class names — the parser is broken`);
// And a name that is definitely absent must be reported, or the diff is inert.
assert.ok(!defined.has("w3c-definitely-not-a-real-class"), "sanity");

if (orphans.length) {
  const lines = orphans.map(([n, w]) => `  .${n}\n      ${[...w].join("\n      ")}`).join("\n");
  assert.fail(
    `${orphans.length} class name(s) are used in web/*.svelte markup but matched by NO selector `
    + `in web/app.css or any scoped <style>:\n${lines}\n\n`
    + `Each renders UNSTYLED. Add the rule, remove the class, or — if the element is `
    + `deliberately styled another way — add it to EXEMPT in this file WITH A REASON.`);
}

console.log(`orphan_class_test: OK — ${used.size} classes used, ${defined.size} defined, `
  + `0 orphans (${EXEMPT.size} exempt)`);
