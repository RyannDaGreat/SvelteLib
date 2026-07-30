# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1", "numpy>=1.26"]
# ///
"""
RENAME = MOVE, and the folder is the project's identity — server-side test.

THE DEFECT THIS PINS (user report, verbatim): "as soon as I renamed the project,
all the assets disappeared. That's cursed." Renaming used to write doc.meta.name
and nothing else, leaving every asset under the OLD folder while every reader
asked under the NEW name.

THE RULING (verbatim): "rename should not copy a project — rename should rename
and MOVE a project… If I rename the folder, the project name should be renamed
automatically." So: the FOLDER NAME IS THE IDENTITY, doc.meta.name follows it.

Direct-call test (no live HTTP server): drives the server module's commands
against a THROWAWAY POWERRP_PROJECTS_DIR. Covers:

  1. rename_project MOVES: the new folder has the doc AND every asset; the OLD
     folder is GONE (a move, not a copy — no orphaned twin).
  2. Relative refs inside doc.json are carried UNREWRITTEN and still resolve —
     the payoff of the relative grammar, and why a move needs no doc surgery.
  3. Nested asset paths and byte contents survive the move exactly.
  4. COLLISION IS REFUSED (FileExistsError) and the refusal is NON-DESTRUCTIVE:
     both projects are still fully intact afterwards. Never merges, never
     overwrites — even when the destination is an EMPTY directory (which a bare
     os.rename would silently consume on POSIX).
  5. A MISSING SOURCE raises FileNotFoundError; renaming to the SAME name is a
     no-op, not an error.
  6. ATOMICITY: the implementation is exactly one os.rename of the folder within
     PROJECTS_DIR — asserted by construction (same parent dir ⇒ same filesystem
     ⇒ POSIX rename(2) atomicity), plus the observable consequence that no
     intermediate state ever has the project under BOTH names.
  7. FOLDER-AUTHORITATIVE LISTING: list_projects derives `name` from the folder
     alone. A HAND-RENAMED folder (a plain os.rename, the `mv` a user would do)
     lists under its NEW name immediately, even though the doc.json inside still
     says the old one — and loading it serves that folder's assets.
  8. SAVE-AS FORK (copy_project_assets): the destination gets the whole library,
     the SOURCE IS UNTOUCHED (both projects work), derivable caches (frames/,
     .thumbs/) are skipped, existing destination files are skipped not
     clobbered, and the copy is idempotent.

Run:  uv run tests/project_rename_test.py      (from the PowerRP dir)
"""

import importlib.util
import inspect
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_PY = os.path.join(HERE, "..", "server", "server.py")

_tmp = tempfile.mkdtemp(prefix="powerrp_rename_test_")
os.environ["POWERRP_PROJECTS_DIR"] = _tmp  # MUST precede the import (PROJECTS_DIR is import-time)

spec = importlib.util.spec_from_file_location("powerrp_server", SERVER_PY)
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1
    print(f"  ok  {msg}")


def raises(exc_type, fn, msg):
    """Query. Check that fn() raises exc_type. Any OTHER exception propagates."""
    try:
        fn()
    except exc_type:
        return check(True, msg)
    check(False, f"{msg} — but it did NOT raise {exc_type.__name__}")


def write_asset(project, rel, data):
    """Command. Write one asset (rel may be a nested path) into a project."""
    path = os.path.join(srv.assets_dir(project), *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def asset_names(project):
    """Query. Every asset basename/relpath under a project's assets/, sorted."""
    root = srv.assets_dir(project)
    out = []
    for dirpath, _dirs, files in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        for fn in files:
            out.append(fn if rel_dir == "." else f"{rel_dir}/{fn}".replace(os.sep, "/"))
    return sorted(out)


# A document with a RELATIVE ref (what writers mint today) and a FOREIGN absolute
# one (a genuine cross-project borrow, which a move must not touch).
DOC = {
    "meta": {"name": "Deck", "script": ""},
    "slides": [{"id": "s0", "delta": {"items": {
        "vid": {"type": "video", "src": "clip.mp4"},
        "logo": {"type": "image", "src": "icons/logo.svg"},
        "bg": {"type": "image", "src": "/asset/Shared/bg.png"},
    }}}],
}
CLIP = b"\x00\x01fake-mp4-bytes\xff"
LOGO = b"<svg/>"

print("\n-- 1..3  rename MOVES the folder, refs and bytes travel --")
srv.save_project("Deck", DOC)
write_asset("Deck", "clip.mp4", CLIP)
write_asset("Deck", "icons/logo.svg", LOGO)
# A derivable cache, to prove later that the FORK skips it (a move carries it,
# which is fine — a move does not duplicate anything).
write_asset("Deck", f"{srv.FRAMES_SUBDIR}/clip.mp4/8/000.png", b"cache")

before_assets = asset_names("Deck")
srv.rename_project("Deck", "Deck v2")

check(not os.path.exists(srv.project_dir("Deck")), "the OLD folder is GONE — a move, not a copy")
check(os.path.isdir(srv.project_dir("Deck v2")), "the NEW folder exists")
check(asset_names("Deck v2") == before_assets, f"every asset travelled: {before_assets}")
moved_doc = json.load(open(srv.doc_path("Deck v2")))
check(moved_doc == DOC, "doc.json travelled BYTE-FOR-BYTE — a move rewrites nothing inside")
items = moved_doc["slides"][0]["delta"]["items"]
check(items["vid"]["src"] == "clip.mp4", "the RELATIVE ref is unrewritten (it names no project, so it needs none)")
check(items["bg"]["src"] == "/asset/Shared/bg.png", "the FOREIGN absolute ref is untouched (it still means that project's file)")
# The payoff, made concrete: the relative refs resolve against the NEW folder.
for rel in ("clip.mp4", "icons/logo.svg"):
    check(os.path.isfile(os.path.join(srv.assets_dir("Deck v2"), *rel.split("/"))),
          f'relative ref "{rel}" resolves under the new name with no rewriting')
check(open(os.path.join(srv.assets_dir("Deck v2"), "clip.mp4"), "rb").read() == CLIP,
      "asset BYTES are identical after the move")

print("\n-- 4  collision is refused, and the refusal is non-destructive --")
srv.save_project("Other", {"meta": {"name": "Other"}, "slides": [{"id": "o0", "delta": {}}]})
write_asset("Other", "keep.txt", b"do not lose me")
raises(FileExistsError, lambda: srv.rename_project("Deck v2", "Other"),
       "renaming onto an EXISTING project raises FileExistsError (never merges)")
check(os.path.isdir(srv.project_dir("Deck v2")) and asset_names("Deck v2") == before_assets,
      "after the refusal the SOURCE project is completely intact")
check(open(os.path.join(srv.assets_dir("Other"), "keep.txt"), "rb").read() == b"do not lose me",
      "after the refusal the DESTINATION project is completely intact")
# An EMPTY destination dir is the dangerous case: bare os.rename would eat it.
os.makedirs(srv.project_dir("Empty Dest"), exist_ok=True)
raises(FileExistsError, lambda: srv.rename_project("Deck v2", "Empty Dest"),
       "an EMPTY destination folder is refused too (bare os.rename would silently consume it)")
check(os.path.isdir(srv.project_dir("Empty Dest")), "the empty destination still stands after the refusal")

print("\n-- 5  missing source is loud; same-name is a no-op --")
raises(FileNotFoundError, lambda: srv.rename_project("No Such Project", "Whatever"),
       "renaming a project that does not exist raises FileNotFoundError")
check(srv.rename_project("Deck v2", "Deck v2") == "Deck v2", "renaming to the SAME name is a no-op, not an error")
check(asset_names("Deck v2") == before_assets, "the no-op rename changed nothing")

print("\n-- 6  atomicity: ONE os.rename, within one directory --")
# The atomicity claim rests on two facts, both checked here rather than asserted
# in prose: the move is a single os.rename call, and both paths sit under the
# same parent (PROJECTS_DIR), so it is same-filesystem and POSIX-atomic.
src_lines = inspect.getsource(srv.rename_project)
check(src_lines.count("os.rename(") == 1, "rename_project performs exactly ONE os.rename")
check("shutil.move" not in src_lines and "copytree" not in src_lines,
      "rename_project never falls back to a copy (which would not be atomic)")
a, b = srv.project_dir("A Name"), srv.project_dir("B Name")
check(os.path.dirname(a) == os.path.dirname(b) == srv.PROJECTS_DIR,
      "both endpoints are children of PROJECTS_DIR — same filesystem, so rename(2) is atomic")
# The observable consequence: at no point does the project exist under both names.
srv.rename_project("Deck v2", "Deck v3")
check(not os.path.exists(srv.project_dir("Deck v2")) and os.path.isdir(srv.project_dir("Deck v3")),
      "after the move the project exists under EXACTLY ONE name")

print("\n-- 7  the FOLDER NAME is the identity (a hand-run mv Just Works) --")
listed = {p["name"] for p in srv.list_projects()}
check("Deck v3" in listed and "Deck v2" not in listed, "the listing names the project by its FOLDER")
# doc.json inside still says "Deck" (nothing rewrote it) — the listing must not care.
check(json.load(open(srv.doc_path("Deck v3")))["meta"]["name"] == "Deck",
      "the stored meta.name is STALE ('Deck') — the fixture for the next check")
by_name = {p["name"]: p for p in srv.list_projects()}
check(by_name["Deck v3"]["slideCount"] == 1,
      "doc.json is opened only to COUNT SLIDES, never to name the project")
# Now the user's own gesture: mv projects/Deck v3 projects/Hand Renamed
os.rename(srv.project_dir("Deck v3"), srv.project_dir("Hand Renamed"))
listed = {p["name"] for p in srv.list_projects()}
check("Hand Renamed" in listed and "Deck v3" not in listed,
      "a HAND-RENAMED folder lists under its new name immediately (no server restart, no doc edit)")
check(asset_names("Hand Renamed") == before_assets,
      "the hand-renamed project's assets resolve under the new name")
check(sorted(a["name"] for a in srv.list_assets("Hand Renamed")) == ["clip.mp4"],
      "list_assets serves the hand-renamed folder (nested/cache entries excluded as usual)")

print("\n-- 8  SAVE-AS FORK: copy_project_assets duplicates, source untouched --")
srv.save_project("Fork", {"meta": {"name": "Fork"}, "slides": [{"id": "f0", "delta": {}}]})
result = srv.copy_project_assets("Hand Renamed", "Fork")
check(result["copied"] == ["clip.mp4", "icons/logo.svg"], f"the whole library was copied: {result['copied']}")
check(result["skipped"] == [], "nothing was skipped on a fresh fork")
check(not any(p.startswith(srv.FRAMES_SUBDIR) for p in result["copied"]),
      "the derivable frames/ cache is NOT copied (it regenerates on demand)")
check(open(os.path.join(srv.assets_dir("Fork"), "clip.mp4"), "rb").read() == CLIP,
      "the fork's asset bytes are identical to the source's")
check(open(os.path.join(srv.assets_dir("Fork"), "icons", "logo.svg"), "rb").read() == LOGO,
      "NESTED asset paths are preserved in the fork (a nested path is a legal relative ref)")
check(asset_names("Hand Renamed") == before_assets,
      "THE SOURCE PROJECT IS UNTOUCHED — a fork leaves both projects working")

# Idempotence + the never-clobber rule.
again = srv.copy_project_assets("Hand Renamed", "Fork")
check(again["copied"] == [] and again["skipped"] == ["clip.mp4", "icons/logo.svg"],
      "a second fork copies NOTHING and reports everything skipped (idempotent)")
write_asset("Fork", "clip.mp4", b"a DIFFERENT file the user put here")
third = srv.copy_project_assets("Hand Renamed", "Fork")
check(third["skipped"] == ["clip.mp4", "icons/logo.svg"], "an existing destination file is SKIPPED, not overwritten")
check(open(os.path.join(srv.assets_dir("Fork"), "clip.mp4"), "rb").read() == b"a DIFFERENT file the user put here",
      "the destination's own bytes SURVIVE — a fork never destroys what is already there")
raises(ValueError, lambda: srv.copy_project_assets("Fork", "Fork"),
       "forking a project onto ITSELF is refused loudly")
# A project with no library at all forks fine (an empty library is not an error).
srv.save_project("Bare", {"meta": {"name": "Bare"}, "slides": [{"id": "b0", "delta": {}}]})
shutil.rmtree(srv.assets_dir("Bare"), ignore_errors=True)
check(srv.copy_project_assets("Bare", "Fork") == {"copied": [], "skipped": []},
      "a project with NO assets forks fine (an absent library is empty, not broken)")

shutil.rmtree(_tmp, ignore_errors=True)
print(f"\n{passed} project rename/fork server tests passed.")
