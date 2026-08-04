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
import { SAVE_NEEDS_CHANGES, SAVE_NEEDS_FLIGHT_DONE, SAVE_NEEDS_SAVE_AS, UNTITLED_NAME, draftStateFromJson, isUnsavedDraft, openNeedsConfirm, projectSourceKind, quickSaveBlocker, saveCommandFor, saveText } from "../web/draftKeys.js";
import { commandUnavailableReason } from "../core/commands.js";
// The repo transport's share-link shape + its grammar, for the branch tests.
import { parseRepoSlug, shareLink as repoShareLink } from "../web/githubProject.js";

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

test("the QUICK-SAVE command's gate AND its reason are the one shared rule", () => {
  const app = read("web/App.svelte");
  assert.match(app, /id:\s*"save-project"/, "the quick-save command must exist");
  // BOTH from quickSaveBlocker, which is the point: the enablement and the
  // sentence are two readings of one function, so they cannot describe different
  // states. The old shape had `when` here and a fixed string beside it, which was
  // fine while there was exactly one way to be blocked and became a lie the
  // moment there were three.
  assert.match(app, /when:\s*\(a\)\s*=>\s*quickSaveBlocker\(a\.isDraft\(\),\s*a\.saveState\(\)\)\s*===\s*null/, "gated by the shared rule, not a re-derived copy");
  assert.match(app, /requires:\s*\(a\)\s*=>\s*quickSaveBlocker\(a\.isDraft\(\),\s*a\.saveState\(\)\)/, "and the REASON comes from the same call, so the live condition is the one named");
  assert.match(SAVE_NEEDS_SAVE_AS, /Save As/, "the draft reason must name the gesture that works instead");
});

// ── THE CLEAN-STATE GATE (user ruling) ────────────────────────────────────
// "Should the save button be enabled when there are no changes?" — NO. A Save
// that is lit with nothing to save invites a click that does nothing AND
// withholds the fact the user hovered it to learn.
test("quick-Save is UNAVAILABLE on a clean working copy, with its own reason", () => {
  assert.equal(quickSaveBlocker(false, "saved"), SAVE_NEEDS_CHANGES);
  assert.match(SAVE_NEEDS_CHANGES, /changes/i, "the reason must be about CHANGES, not about being unsaved");
  assert.notEqual(SAVE_NEEDS_CHANGES, SAVE_NEEDS_SAVE_AS, "…and it must be a DIFFERENT sentence from the draft's — one string could not tell both truths");
});

test("quick-Save IS available on a dirty saved project — the one state it is for", () => {
  assert.equal(quickSaveBlocker(false, "unsaved"), null);
});

test("a DRAFT still loses to the draft reason, even though it is also dirty", () => {
  // A never-saved document reports "unsaved" (nothing of it is stored), so both
  // conditions could fire; the draft's sentence is the true one and must win.
  assert.equal(quickSaveBlocker(true, "unsaved"), SAVE_NEEDS_SAVE_AS);
  assert.equal(quickSaveBlocker(true, "saved"), SAVE_NEEDS_SAVE_AS);
});

test("an IN-FLIGHT save blocks quick-Save with its own third reason", () => {
  // Not clean (the outcome is unknown) and not runnable (do not invite a second
  // write on top of an unresolved one).
  assert.equal(quickSaveBlocker(false, "saving"), SAVE_NEEDS_FLIGHT_DONE);
  // THREE DISTINCT SENTENCES, asserted as a set rather than pairwise: the whole
  // reason `requires` had to become a function is that one string cannot tell
  // three truths, so a collision here would silently undo that.
  const all = [SAVE_NEEDS_SAVE_AS, SAVE_NEEDS_CHANGES, SAVE_NEEDS_FLIGHT_DONE];
  assert.equal(new Set(all).size, 3, `the three block reasons must be distinct: ${JSON.stringify(all)}`);
});

test("a FUNCTION `requires` is resolved by the shared reason reader", () => {
  // The widening that makes a three-reason gate expressible at all. Every
  // surfacing (Toolbar, ToolsPane, palette) asks commandUnavailableReason, so
  // this one function is what keeps a function-valued `requires` from rendering
  // as source text.
  const cmd = { id: "x", when: (a) => a.ok, requires: (a) => a.why };
  assert.equal(commandUnavailableReason(cmd, { ok: false, why: "a reason" }), "a reason");
  assert.equal(commandUnavailableReason(cmd, { ok: true, why: "a reason" }), null, "a runnable command has no reason, whatever `requires` would say");
  assert.equal(commandUnavailableReason({ id: "y", when: () => false, requires: "a literal" }, {}), "a literal", "a plain string still works — this is a widening, not a replacement");
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

test("the SAVE BUTTON reads the shared sentence, not its own copy", () => {
  // Retitled from "the INDICATOR" because the indicator IS the button now (user:
  // "the unsaved-changes dot is kind of the same thing as the save button — the
  // same state"). What is asserted is unchanged: the sentence comes from the one
  // tested rule and nothing shadows it. Only its anchor moved.
  const toolbar = read("web/Toolbar.svelte");
  assert.match(toolbar, /import \{ saveText \} from "\.\/draftKeys\.js"/, "the sentence must come from the tested rule");
  assert.match(toolbar, /saveText\(state,\s*app\.lastSavedAt,\s*app\.isDraft\(\),\s*STORAGE_NOUN\)/, "and be passed the draft state + the storage noun");
  assert.ok(!/function saveText\(/.test(toolbar), "no local redefinition may shadow it");
  assert.match(toolbar, /<Tooltip text=\{saveIndicator\.text\}>/, "and it must reach the standalone dot's tooltip — that is where the save-state sentence lives");
});

test("THE GUARD IS ONE SEAM: every replacing open routes through guardedOpen", () => {
  const app = read("web/app.svelte.js");
  const main = read("web/main.js");
  // The five gestures the ruling names, plus the two boot params.
  for (const [what, pattern] of [
    ["a dropped .zip", /importProjectZip\(file\)[\s\S]{0,900}?this\.guardedOpen\(/],
    ["Open from URL (and the ?zip= boot param, which calls it)", /openProjectFromUrl\(rawUrl[\s\S]{0,900}?this\.guardedOpen\(/],
    ["Open from a GitHub repo (and the ?repo= boot param, which calls it)", /async openProjectFromRepo\(slug[\s\S]{0,900}?this\.guardedOpen\(/],
    ["Open Project from the library", /async openProjectNamed\(name\)\s*\{\s*return this\.guardedOpen\(/],
    ["New Document", /async newDocument\(\)\s*\{[\s\S]{0,900}?this\.guardedOpen\(/],
  ])
    assert.match(app, pattern, `${what} must pass through the ONE gate`);
  // THE ?repo= BOOT PARAM'S GUARD MOVED, and this assertion moved with it. It
  // used to look for `app.guardedOpen(` in main.js, because main.js held a COPY
  // of the repo-open body — fetch, synthesize, guard, open. That copy is why
  // `?repo=` came to lack the branch-aware share link the modal path has, so it
  // was deleted and main.js now just reads the query parameter and delegates.
  // The invariant is unchanged and is asserted one line up (openProjectFromRepo
  // guards); what is checked HERE is that the boot path really does go through
  // that guarded gesture rather than reaching past it into the raw fetch.
  assert.match(main, /await app\.openProjectFromRepo\(slug,/, "the ?repo= boot param must call the GUARDED gesture — a boot param is exactly the case the ruling names");
  assert.ok(!/fetchProjectFromRepo\(/.test(main), "…and must not reach past it to the raw fetch, which would re-create the duplicate that lost the branch");
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

// ── ONE INPUT, BOTH GRAMMARS (user ruling) ────────────────────────────────
// "Open Project from URL should have a github link example in it — literally the
// one we have now — saying it can be a zip from anywhere or a github
// repository/branch", and "it should support branches too".
//
// THE GRAMMAR TABLE, as a table: every shape the single field must classify,
// including the ones that must be REFUSED. The refusals matter as much as the
// acceptances — a string pushed at the wrong loader fails as a confusing network
// error instead of a sentence about what was typed.
test("the open-from field classifies every input shape", () => {
  const TABLE = [
    // [input, expected kind, why this row exists]
    ["https://example.com/decks/RobotSim.zip", "url", "a .zip anywhere on the web — the original transport"],
    ["https://example.com/a b.zip", "url", "spaces and all: this file does not judge the URL, validatedZipUrl does"],
    ["RyannDaGreat/PowerRP-RobotSim-Demo", "repo", "THE demo repo, exactly as the modal's hint shows it"],
    ["RyannDaGreat/PowerRP-RobotSim-Demo@main", "repo", "…at an explicit branch"],
    ["RyannDaGreat/PowerRP-RobotSim-Demo@branch-fixture", "repo", "…at the standing test branch the live probe loads"],
    ["owner/name@release/1.2", "repo", "a ref may contain a slash; the @ is split off FIRST, as parseRepoSlug does"],
    ["https://github.com/owner/name", "repo", "the URL a repo's address bar shows IS the repo grammar"],
    ["https://www.github.com/owner/name", "repo", "…with or without the www"],
    ["https://github.com/owner/name@main", "repo", "…and it carries a branch too"],
    // A .zip PATH OUTRANKS THE HOST (user ruling, 2026-08-03: "it should check if
    // it's a zip file first"). The host rule alone pushed this real link at
    // parseRepoSlug, which refused a good zip with a sentence about owner/name.
    ["https://github.com/RyannDaGreat/ClarapointPresentations/raw/refs/heads/main/DogCatMorph2%20(3).zip", "url", "a raw FILE link on github.com is a zip fetch — the regression that pinned this"],
    ["https://github.com/owner/name/archive/refs/heads/main.zip", "url", "…and github's own source-archive link is a zip too"],
    ["https://github.com/owner/name/raw/main/deck.zip?download=1", "url", "the query string does not hide the .zip"],
    ["owner", "unknown", "a bare word names nothing — refused with a sentence, never guessed"],
    ["a/b/c", "unknown", "two slashes is not owner/name"],
    ["robot sim deck", "unknown", "prose"],
    ["", "unknown", "empty"],
    // A COLON DISQUALIFIES A SCHEME-LESS STRING. `data:text/html,x` has no "://"
    // and exactly one slash, so a naive rule reads it as the repo `data:text/html,x`
    // — parseRepoSlug does refuse it, but while talking about GitHub OWNER NAMES,
    // which tells someone who pasted a data: URL nothing. Refusing it here is the
    // honest answer, and this row is why the colon check exists.
    ["data:text/html,x", "unknown", "an unsupported scheme is not a slug"],
    ["javascript:alert(1)", "unknown", "…and neither is this one"],
    // These DO reach a loader, and each refuses loudly on its own terms —
    // validatedZipUrl rejects a non-http(s) scheme, parseRepoSlug an empty @ref.
    // Classified, not validated: this function decides WHO judges, not whether.
    ["ftp://host/deck.zip", "url", "a scheme we do not take is still a URL question — validatedZipUrl answers it"],
    ["owner/name@", "repo", "an empty @ref is a REPO question — parseRepoSlug answers it, loudly"],
  ];
  for (const [input, want, why] of TABLE) {
    assert.equal(projectSourceKind(input), want, `${JSON.stringify(input)} must be ${want} — ${why}`);
  }
});

test("the MODAL routes through the shared grammar, and shows BOTH forms", () => {
  const app = read("web/App.svelte");
  assert.match(app, /await app\.openProjectFromAnySource\(url,/, "the modal must route through the one router, not call a single loader");
  // The hint the ruling asked for, using the REAL demo repo rather than an
  // invented placeholder — so what it shows is something a reader can paste.
  assert.match(app, /RyannDaGreat\/PowerRP-RobotSim-Demo@main/, "the modal must show the real repo example, with a branch");
  assert.match(app, /https:\/\/example\.com\/deck\.zip/, "…and a .zip example beside it");
  assert.match(app, /@branch<\/code> for a branch, tag or commit/, "…and say that @ref means branch/tag/commit");
});

test("the ROUTER hands each grammar to its own loader and refuses the rest", () => {
  const app = read("web/app.svelte.js");
  const router = app.slice(app.indexOf("async openProjectFromAnySource("), app.indexOf("async openProjectFromAnySource(") + 900);
  assert.match(router, /if \(kind === "repo"\) return this\.openProjectFromRepo\(/, "a repo slug goes to the GitHub loader");
  assert.match(router, /if \(kind === "url"\) return this\.openProjectFromUrl\(/, "a URL goes to the zip fetcher");
  assert.match(router, /throw new Error\(/, "and anything else is refused LOUDLY, here, with a sentence about the INPUT");
});

test("A REPO DRAFT'S SHARE LINK CARRIES THE BRANCH", () => {
  // The defect this pins: shareLink() built `owner/name` from a target that had
  // its `ref` right there, so sharing a deck opened from a branch handed the
  // recipient the DEFAULT branch — a different document, under a link that looked
  // correct. Round-tripped through parseRepoSlug, because writing a link nothing
  // can read back is the other half of the same bug.
  const link = repoShareLink({ owner: "RyannDaGreat", repo: "PowerRP-RobotSim-Demo", ref: "branch-fixture" }, "https://x.dev/app/");
  const back = new URL(link).searchParams.get("repo");
  assert.deepEqual(parseRepoSlug(back), { owner: "RyannDaGreat", repo: "PowerRP-RobotSim-Demo", ref: "branch-fixture" });
  // No ref = the DEFAULT branch, deliberately: "whatever main says today" is a
  // real thing to share, and pinning it to today's default would freeze it.
  const bare = new URL(repoShareLink({ owner: "o", repo: "n" }, "https://x.dev/app/")).searchParams.get("repo");
  assert.equal(bare, "o/n");
  assert.equal(parseRepoSlug(bare).ref, null);
});

test("a repo DRAFT remembers its slug across a reload, so the link survives", () => {
  const state = draftStateFromJson('{"name":"RobotSim","sourceUrl":"","repoSlug":"o/n@main"}');
  assert.equal(state.repoSlug, "o/n@main");
  // A ZIP draft must NOT gain the key — shareLink() tells the two transports
  // apart by its presence, so a stray "" would route a zip draft at ?repo=.
  assert.ok(!("repoSlug" in draftStateFromJson('{"name":"D","sourceUrl":"https://x.dev/a.zip"}')), "a zip draft carries no repoSlug key");
});

test("web/projectDraft.js re-exports EVERY draftKeys rule, not a stale subset", () => {
  // projectDraft.js is the browser-side barrel over draftKeys.js (the DOM-free
  // half). Its re-export list is written by hand, so it silently goes stale every
  // time a rule is added — which it HAD, by three names, before this test existed:
  // a consumer importing from the barrel would have got an undefined and a
  // confusing runtime error rather than a missing-export failure at load.
  const barrel = read("web/projectDraft.js");
  const listed = new Set((barrel.match(/export \{([^}]*)\} from "\.\/draftKeys\.js"/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const declared = [...read("web/draftKeys.js").matchAll(/^export (?:const|function) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
  const missing = declared.filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], `web/projectDraft.js does not re-export: ${missing.join(", ")}. Add them to its \`export { … } from "./draftKeys.js"\` line, or the barrel lies about what the model offers.`);
});

console.log(`\n${passed} passed`);
