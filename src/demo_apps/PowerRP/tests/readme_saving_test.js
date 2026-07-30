/**
 * README "Saving & loading" tests — plain node, no framework, no network.
 * Run: node src/demo_apps/PowerRP/tests/readme_saving_test.js
 *
 * WHAT IS UNDER TEST is not prose quality — it is that the README's promises and
 * the CODE'S CONSTANTS are the same facts. A README is the first thing a new
 * reader trusts and the last thing anyone updates, so the two drift silently:
 * the share parameter gets renamed, the demo repo gets moved, and the document
 * that told people how to use the app keeps confidently describing the old
 * behaviour. Every assertion here is a link between a sentence and a symbol.
 *
 * IT DOES NOT ASSERT WORDING. Checking exact sentences would make every edit a
 * test failure and teach people to delete the test. It checks the FACTS: the
 * parameter names, the demo repo slug, and that all five mechanisms are listed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_PARAM } from "../web/githubProject.js";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(APP_ROOT, "../../..");
const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");

/** ZIP_PARAM is read out of its SOURCE rather than imported, because
 *  projectUrlImport.js pulls in projectApi.js, which touches `location` at module
 *  scope and therefore cannot load in bare node. Importing it would make this
 *  test require a DOM to check a string — and would drag a browser dependency
 *  into the fast node lane for no benefit. githubProject.js has no such
 *  dependency and is imported normally, which is the property worth keeping. */
const ZIP_PARAM = (() => {
  const src = readFileSync(resolve(APP_ROOT, "web/projectUrlImport.js"), "utf8");
  const m = src.match(/export const ZIP_PARAM\s*=\s*"([^"]+)"/);
  assert.ok(m, "projectUrlImport.js must export a literal ZIP_PARAM");
  return m[1];
})();

/** The demo repo the README points at. Also pinned by github_live_probe.js, which
 *  actually loads it — this test only proves the README and the probe agree. */
const DEMO_SLUG = "RyannDaGreat/PowerRP-RobotSim-Demo";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const section = (() => {
  const start = readme.indexOf("## Saving & loading");
  assert.ok(start >= 0, "README must have a '## Saving & loading' section");
  const rest = readme.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next >= 0 ? rest.slice(0, next) : rest;
})();

test("every saving/loading mechanism is listed, one line each", () => {
  // The five mechanisms that exist. If a sixth is built, it belongs here AND in
  // the README — this assertion is the reminder.
  for (const [label, pattern] of [
    ["browser storage", /browser storage/i],
    ["server", /\*\*Server\*\*/],
    ["zip export + drag to open", /\*\*Zip\*\*/],
    ["?zip= share links", new RegExp(`\\?${ZIP_PARAM}=`)],
    ["GitHub repos", /GitHub repo/i],
  ]) {
    assert.match(section, pattern, `the README must list ${label}`);
  }
  // ONE LINE EACH, per the user's standing objection to essays: no bullet in
  // this section may run past a single line.
  const bullets = section.split("\n").filter((l) => l.trimStart().startsWith("- "));
  assert.ok(bullets.length >= 5, `expected at least 5 bullets, got ${bullets.length}`);
  for (const b of bullets) {
    assert.ok(b.length < 140, `bullet is too long to be one line: ${JSON.stringify(b.slice(0, 80))}…`);
  }
});

test("the share parameters in the README are the ones the code reads", () => {
  // The whole point of this file: a renamed constant must break the README test
  // rather than silently invalidate the documentation.
  assert.match(section, new RegExp(`\\?${REPO_PARAM}=`), `README must document ?${REPO_PARAM}=`);
  assert.match(section, new RegExp(`\\?${ZIP_PARAM}=`), `README must document ?${ZIP_PARAM}=`);
  assert.equal(REPO_PARAM, "repo");
  assert.equal(ZIP_PARAM, "zip");
});

test("the repo layout named in the README is the layout the loader expects", () => {
  assert.match(section, /doc\.json/, "README must name doc.json");
  assert.match(section, /assets\//, "README must name the assets/ folder");
});

test("the RobotSim demo is linked as the worked example, and is openable", () => {
  assert.ok(section.includes(`https://github.com/${DEMO_SLUG}`), "README must link the demo repo itself");
  // The OPEN link must be a real ?repo= share link for that same repo — a
  // worked example that points somewhere else is worse than none.
  assert.ok(
    section.includes(`?${REPO_PARAM}=${DEMO_SLUG}`),
    `README must include the openable share link ?${REPO_PARAM}=${DEMO_SLUG}`,
  );
});

console.log(`\n${passed} passed`);
