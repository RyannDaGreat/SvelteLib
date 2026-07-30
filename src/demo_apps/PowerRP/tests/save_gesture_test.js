/**
 * SAVE-GESTURE tests — plain node, no framework, no DOM.
 * Run: node src/demo_apps/PowerRP/tests/save_gesture_test.js
 *
 * WHAT IS UNDER TEST is the user's SAVE / SAVE-AS ruling, in the four decisions
 * it reduces to (web/draftKeys.js): which Save is available, what Cmd+S does,
 * what the save indicator says, and whether an open must ask first.
 *
 * THE RULING, verbatim in intent: "When we are renaming the Untitled project,
 * that should be the same as saving a new project. Untitled is a special project
 * — I shouldn't be allowed to just save it; it needs to Save-As-New, just like
 * every other editor. There should be a quick-save button. Make the distinction
 * between Save and Save-As for every modality, including server and browser
 * side." Plus, for the guard: "if I've been working on something and then
 * suddenly I open a new URL, what happens? Can opening a link break my project?"
 *
 * WHY THESE FOUR ARE PURE FUNCTIONS AND NOT COMPONENT LOGIC. Each is a decision
 * that FOUR different surfaces have to agree on — the command's `when` gate, the
 * keybinding, the indicator's hover text, and the open guard. Four agreeing
 * copies is four chances to disagree, and the disagreement would be invisible:
 * a gate that says "saveable" while the indicator says "not saved yet" produces
 * no error, just a library entry the user never named. Written as pure rules,
 * the BARE-NODE gate executes them; the browser only renders their answers.
 *
 * THE LOAD-BEARING TEST HERE IS "renamed-but-never-saved is STILL A DRAFT". An
 * earlier version of isUnsavedDraft also required a placeholder NAME, which made
 * typing a title into a new document silently grant it a quick-Save — the exact
 * "I shouldn't be allowed to just save it" case, one keystroke later.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SAVE_NEEDS_SAVE_AS, UNTITLED_NAME, isUnsavedDraft, openNeedsConfirm, saveCommandFor, saveText } from "../web/draftKeys.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", rel), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── THE UNIFIED DRAFT STATE ────────────────────────────────────────────────
// "not in the library yet" has TWO causes and ONE meaning.

test("THE RULING: a never-saved document is a draft NO MATTER WHAT IT IS CALLED", () => {
  // The regression this pins. A user makes a new document, types "Draft ideas"
  // into the title, and has still never saved: quick-Save must stay unavailable,
  // because naming is not saving. The earlier name-clause version returned false
  // here and handed them a ceremony-free write to a library entry they never
  // agreed to create.
  assert.equal(isUnsavedDraft(null, false), true, "everSaved=false alone makes it a draft — the name is not consulted");
  // And the reason it cannot be consulted: the function does not TAKE a name.
  assert.equal(isUnsavedDraft.length, 2, "isUnsavedDraft must take (draftMode, everSaved) only — a name parameter is how the defect came back");
});

test("a fresh untouched document is a draft", () => {
  assert.equal(isUnsavedDraft(null, false), true);
});

test("an IMPORTED draft is a draft on the marker alone", () => {
  // A .zip or share link sets draftMode. It answers regardless of everSaved, so
  // that a draft opened over a previously-saved project is still a draft.
  assert.equal(isUnsavedDraft({ name: "RobotSim", sourceUrl: "" }, false), true);
  assert.equal(isUnsavedDraft({ name: "RobotSim", sourceUrl: "https://x/y.zip" }, true), true);
});

test("an ordinary library project is NOT a draft — quick-Save writes in place", () => {
  assert.equal(isUnsavedDraft(null, true), false);
});

test("a library project genuinely NAMED \"Untitled\" is saved like any other", () => {
  // The other direction of the same defect: gating on the NAME would have made a
  // real project called "Untitled" permanently unsaveable-in-place, demanding
  // Save-As every time the user pressed Cmd+S.
  assert.equal(isUnsavedDraft(null, true), false);
  assert.equal(UNTITLED_NAME, "Untitled", "the placeholder has one spelling, used for DISPLAY only");
});

// ── CMD+S DISPATCH ─────────────────────────────────────────────────────────

test("Cmd+S is quick-Save when saved, Save-As when a draft", () => {
  assert.equal(saveCommandFor(false), "save-project");
  assert.equal(saveCommandFor(true), "save-project-as");
});

test("Cmd+S dispatch is a FUNCTION OF THE DRAFT STATE and nothing else", () => {
  // Same input, same answer, for every state the app could otherwise smuggle in.
  // This is what makes the key safe to press blind: it cannot depend on which
  // panel has focus, how dirty the document is, or which storage mode is live.
  assert.equal(saveCommandFor(isUnsavedDraft(null, true)), "save-project");
  assert.equal(saveCommandFor(isUnsavedDraft(null, false)), "save-project-as");
  assert.equal(saveCommandFor(isUnsavedDraft({ name: "X", sourceUrl: "" }, true)), "save-project-as");
});

// ── THE SAVE INDICATOR: four sentences, not three ──────────────────────────

test("a DRAFT and a DIRTY SAVED PROJECT say different things", () => {
  const draft = saveText("unsaved", null, true, "server");
  const dirty = saveText("unsaved", null, false, "server");
  assert.notEqual(draft, dirty, "the dot is a ring in both cases, so the sentence is the ONLY place the difference can be told");
  assert.match(draft, /not saved yet/i, "a draft has no library copy, so it has no 'changes' — it has nothing there at all");
  assert.match(draft, /Save As/, "and it must name the gesture that fixes it");
  assert.match(dirty, /Unsaved changes/, "a saved project HAS a copy, which its edits have drifted from");
});

test("the indicator names the STORAGE MODE it is talking about, in both modes", () => {
  // The STORAGE_NOUN convention: "server" in HTTP mode, "browser" in static.
  // Both save gestures exist in both modalities (the ruling says "for every
  // modality, including server and browser side"), so both must be sayable.
  assert.match(saveText("saved", null, false, "server"), /server/);
  assert.match(saveText("saved", null, false, "browser"), /browser/);
  assert.match(saveText("unsaved", null, true, "browser"), /browser/);
  assert.match(saveText("unsaved", null, false, "browser"), /browser/);
});

test("SAVING is one sentence regardless of draft state", () => {
  // Mid-flight, the honest answer is the same either way: the outcome is not
  // known yet, so the sentence must not claim a destination.
  assert.equal(saveText("saving", null, true, "server"), "Saving…");
  assert.equal(saveText("saving", 1750000000000, false, "browser"), "Saving…");
});

test("SAVED carries the time when there is one", () => {
  assert.equal(saveText("saved", null, false, "server"), "Saved to server");
  assert.ok(saveText("saved", 1750000000000, false, "server").startsWith("Saved to server at "));
});

// ── THE UNSAVED-WORK GUARD ─────────────────────────────────────────────────

test("both ways of having work at risk prompt; clean-and-saved does not", () => {
  assert.equal(openNeedsConfirm(true, "unsaved"), true, "a draft loses ALL of itself");
  assert.equal(openNeedsConfirm(true, "saved"), true, "a draft is at risk even when its autosave is current — the library has nothing");
  assert.equal(openNeedsConfirm(false, "unsaved"), true, "a dirty saved project loses the edits since its last write");
  assert.equal(openNeedsConfirm(false, "saved"), false, "reopening restores it, so no ceremony — this exemption is what keeps the prompt meaningful");
});

test("an IN-FLIGHT save counts as dirty", () => {
  // Its outcome is unknown; treating it as clean would let an open race a write.
  assert.equal(openNeedsConfirm(false, "saving"), true);
});

// ── THE WIRING: the rules are actually READ by the surfaces ────────────────
// Pure rules nothing consumes are decoration. These check the four surfaces
// import them rather than restating them — the exact drift the split prevents.

test("the QUICK-SAVE command is gated on isDraft() and states the reason", () => {
  const app = read("web/App.svelte");
  assert.match(app, /id:\s*"save-project"/, "the quick-save command must exist");
  assert.match(app, /when:\s*\(a\)\s*=>\s*!a\.isDraft\(\)/, "gated to saved projects only");
  assert.match(app, /requires:\s*SAVE_NEEDS_SAVE_AS/, "and it must state WHY, from the one shared string");
  assert.match(SAVE_NEEDS_SAVE_AS, /Save As/, "the reason must name the gesture that works instead");
});

test("Cmd+S is REGISTERED, so the HintBar knows it exists", () => {
  // The shortcut registry is the single source of truth for inputs: a shortcut
  // that is not registered there does not exist (CLAUDE.md).
  const entries = read("core/shortcut_entries.js");
  assert.match(entries, /command:\s*"save-dispatch",\s*keys:\s*\["Cmd",\s*"S"\]/, "Cmd+S must be a registered binding");
  assert.match(entries, /"save-dispatch":\s*"Save"/, "and it must carry a HintBar label");
});

test("the TOOLBAR gives quick-save the primary spot, Save As beside it", () => {
  const toolbar = read("web/Toolbar.svelte");
  const group = toolbar.match(/\["save-project",\s*"save-to-server",[^\]]*\]/);
  assert.ok(group, "the file-ops group must start with save-project then save-to-server (Save As)");
});

test("the INDICATOR reads the shared sentence, not its own copy", () => {
  const toolbar = read("web/Toolbar.svelte");
  assert.match(toolbar, /import \{ saveText \} from "\.\/draftKeys\.js"/, "the sentence must come from the tested rule");
  assert.match(toolbar, /saveText\(state,\s*app\.lastSavedAt,\s*app\.isDraft\(\),\s*STORAGE_NOUN\)/, "and be passed the draft state + the storage noun");
  assert.ok(!/function saveText\(/.test(toolbar), "no local redefinition may shadow it");
});

test("THE GUARD IS ONE SEAM: every replacing open routes through guardedOpen", () => {
  const app = read("web/app.svelte.js");
  const main = read("web/main.js");
  // The five gestures the ruling names, plus the ?repo= boot param.
  for (const [what, pattern] of [
    ["a dropped .zip", /importProjectZip\(file\)[\s\S]{0,900}?this\.guardedOpen\(/],
    ["Open from URL (and the ?zip= boot param, which calls it)", /openProjectFromUrl\(rawUrl[\s\S]{0,900}?this\.guardedOpen\(/],
    ["Open Project from the library", /async openProjectNamed\(name\)\s*\{\s*return this\.guardedOpen\(/],
    ["New Document", /async newDocument\(\)\s*\{[\s\S]{0,900}?this\.guardedOpen\(/],
  ])
    assert.match(app, pattern, `${what} must pass through the ONE gate`);
  assert.match(main, /app\.guardedOpen\(/, "the ?repo= boot param must wait for the answer too — a boot param is exactly the case the ruling names");
});

test("THE GESTURE IS GUARDED, THE API IS NOT — and the UI calls the gesture", () => {
  // The split that keeps the gate from deadlocking every non-interactive caller.
  // `loadProject`/`clearDoc` are plain programmatic operations with ~a dozen
  // callers (probes, fixtures, boot paths) that have no user to answer a dialog;
  // guarding THOSE hung project_rename_probe on a CDP timeout. So the guard sits
  // on the gesture, and the two UI surfaces must reach for the gesture — a
  // regression here is silent, because calling the API still works, it just stops
  // asking.
  const app = read("web/app.svelte.js");
  const ui = read("web/App.svelte");
  assert.ok(!/async loadProject\(name\)\s*\{\s*return this\.guardedOpen\(/.test(app), "loadProject itself must stay UNGUARDED — it is the programmatic API");
  assert.ok(!/async clearDoc\(\)\s*\{\s*return this\.guardedOpen\(/.test(app), "clearDoc itself must stay UNGUARDED — same reason");
  assert.match(ui, /app\.openProjectNamed\(name\)/, "the Open Project picker must call the GUARDED gesture");
  assert.match(ui, /id: "clear-doc"[^}]*a\.newDocument\(\)/, "the New Empty Document command must call the GUARDED gesture");
});

test("the guard's three answers are all real, and CANCEL aborts the open", () => {
  const app = read("web/app.svelte.js");
  assert.match(app, /if \(answer === "cancel"\) return false/, "Cancel must abandon the open, not fall through to it");
  assert.match(app, /if \(!\(await this\.saveForGuard\(\)\)\) return false/, "a save that did not complete must also abandon it — proceeding would destroy the work the user just asked to keep");
  assert.match(app, /throw new Error\(`guardedOpen: unknown answer/, "an unrecognized answer must fail LOUDLY rather than defaulting to a destructive branch");
});

test("RENAMING A DRAFT does not touch storage — the name waits for Save", () => {
  const app = read("web/app.svelte.js");
  // The rename-as-move machinery (c2e1bbf) applies to SAVED projects only. A
  // draft has no folder to move, and moving one would BE the library entry the
  // working-copy model exists to refuse.
  assert.match(app, /if \(this\.isDraft\(\)\) \{[\s\S]{0,600}?return trimmed;/, "renameProject must return early for a draft, before projectStore().rename");
  const draftBranch = app.slice(app.indexOf("async renameProject("), app.indexOf("// STEP 1 —"));
  assert.ok(!draftBranch.includes("projectStore().rename"), "the draft branch must not reach the storage move");
});

test("everSaved is set ONLY on a successful write or a library open", () => {
  const app = read("web/app.svelte.js");
  // A failed first save must leave a draft a draft: if it set the flag anyway,
  // the user would be handed a quick-Save pointing at an entry that was never
  // created, and the next Cmd+S would fail with no way back to the naming flow.
  const save = app.slice(app.indexOf("async saveToServer("), app.indexOf("async saveToServer(") + 1400);
  const setPos = save.indexOf("this.everSaved = true");
  assert.ok(setPos > save.indexOf("await projectStore().save("), "everSaved must be set AFTER the awaited write, so a throw skips it");
  assert.ok(setPos < save.indexOf("} finally {"), "and INSIDE the try, so only success sets it");
  assert.match(app, /this\.savedDoc = this\.doc;[\s\S]{0,500}?this\.everSaved = true;[\s\S]{0,200}?this\.slideIndex = 0;/, "loadProject must set it too — an opened project IS in the library");
});

console.log(`\n${passed} passed`);
