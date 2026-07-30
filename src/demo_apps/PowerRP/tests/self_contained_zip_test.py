# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
SELF-CONTAINED .ZIP EXPORT round-trip test — export → inspect → import → resolve.

THE DEFECT (user report, verbatim): "the robotsim.zip references a video file, but
that video file is not in that zip. If I were to load that zip into the browser, it
wouldn't know where the video file was… The zip should be basically the whole
project folder."

ROOT CAUSE. A document stores media as "/asset/<project>/<file>", with the project
NAME baked into every one of those strings — and nothing keeps that name equal to
the folder the document lives in. SAVE-AS is how they diverge: the client renames
doc.meta.name and saves the document to a NEW folder while the assets stay in the
folder they were uploaded to, so every src keeps naming the OLD project. Because
this server serves /asset/<any project>/… to anyone, the deck keeps working and the
divergence is INVISIBLE — until zip_project_bytes walks one folder and ships a doc
whose refs name a folder that is not in the archive.

WHY THE ROUND TRIP IS THE TEST, and not just "is the file in the zip". Three things
can each be individually right and still leave the user broken: the bytes present,
the archived ref rewritten, and the IMPORTED project's ref actually resolving to a
real file on disk. So this drives the whole loop through the LIVE HTTP endpoints —
GET /api/download/, POST /api/import-zip/, then GET /asset/<new>/<file> — and
asserts the imported deck's own reference serves the ORIGINAL bytes back. That last
GET is the user's "load this zip into the browser", reduced to one request.

CHECKS:
  1. THE USER'S CASE      — a project whose ONLY reference is another project's
                            video: the archive carries the video and the archived
                            doc.json's ref is LOCAL.
  2. SOURCE UNTOUCHED     — the exporting project's on-disk doc.json still says
                            what the author wrote (only the archive is rewritten).
  3. IMPORT + RESOLVE     — import the archive as a NEW project, then fetch the
                            imported doc's own ref: 200, and byte-identical to the
                            original video.
  4. THE FOREIGN SOURCE MAY VANISH — delete the lender project entirely; the
                            imported deck still resolves, which is the property that
                            was missing before (the whole point of localizing).
  5. COLLISION-SAFE       — a foreign file whose basename is already taken locally
                            lands beside it ("logo-2.png"), and the ref points at
                            the copy, not the incumbent.
  6. ALREADY LOCAL        — a self-contained project exports BYTE-FOR-BYTE the doc
                            it stores (no gratuitous rewrite) with no warnings.
  7. MISSING SOURCE IS LOUD — a foreign ref whose file does not exist exports
                            anyway, keeps the original ref (still findable), and is
                            NAMED in an X-PowerRP-Warning header. Never silent.
  8. NON-REFS SURVIVE     — equations and http/data URLs sitting next to a real src
                            are untouched by the walk.

Run (exit code gated):
    /opt/homebrew/opt/python@3.10/bin/python3.10 tests/self_contained_zip_test.py
"""

import http.client
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import zipfile
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(os.path.dirname(HERE), "server")
sys.path.insert(0, SERVER_DIR)
import server  # noqa: E402

# Stand-in for the user's Video_20260726_224007_045.mp4 — the test cares that the
# BYTES arrive intact, not that they decode, so a recognizable blob is enough.
VIDEO_BYTES = b"\x00\x00\x00\x18ftypmp42" + bytes(range(256)) * 8


def write_project(name, doc, assets=()):
    """Command (mutates the temp PROJECTS_DIR). Create a project folder with a doc and assets."""
    d = os.path.join(server.PROJECTS_DIR, name)
    os.makedirs(os.path.join(d, server.ASSETS_SUBDIR), exist_ok=True)
    with open(os.path.join(d, server.DOC_FILENAME), "w") as f:
        json.dump(doc, f, indent=2)
    for filename, data in assets:
        with open(os.path.join(d, server.ASSETS_SUBDIR, filename), "wb") as f:
            f.write(data)
    return d


def doc_with(items, meta_name):
    """Pure function. A minimal one-slide document whose slide-0 delta creates `items`."""
    return {
        "meta": {"name": meta_name, "script": ""},
        "slides": [{"id": "s1", "name": "Slide 1",
                    "transition": {"type": "cut", "seconds": 0, "curve": "smooth", "sound": None},
                    "delta": {"items": items}}],
    }


def get(port, path):
    """Query. GET path → (status, body_bytes, headers)."""
    conn = http.client.HTTPConnection("127.0.0.1", port)
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, resp.read(), dict(resp.getheaders())


def post(port, path, body):
    """Command. POST raw bytes → (status, parsed_json)."""
    conn = http.client.HTTPConnection("127.0.0.1", port)
    conn.request("POST", path, body=body, headers={"Content-Type": "application/zip"})
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())


def archive_of(port, project):
    """Query. Download a project's .zip → (ZipFile, warning header or None)."""
    status, body, headers = get(port, f"/api/download/{project}/")
    assert status == 200, f"download {project}: status {status}"
    return zipfile.ZipFile(io.BytesIO(body)), headers.get("X-PowerRP-Warning")


def refs_of(doc):
    """Query. The ref strings a document contains, in document order."""
    return [r["ref"] for r in server.document_asset_refs(doc)]


def main():
    tmp_root = tempfile.mkdtemp(prefix="powerrp_selfcontained_test_")
    server.PROJECTS_DIR = tmp_root

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        # ── 1. THE USER'S CASE, reproduced ───────────────────────────────────
        # "Untitled" holds the video (where it was uploaded); "RobotSim" is what
        # Save-As produced — its own assets/ is EMPTY and its only ref is foreign.
        write_project("Untitled", doc_with({"v": {"type": "video", "src": "/asset/Untitled/clip.mp4"}}, "Untitled"),
                      [("clip.mp4", VIDEO_BYTES)])
        write_project("RobotSim", doc_with({
            "cam": {"type": "camera", "x": 0, "y": 0, "w": 1280, "h": 720},
            "v": {"type": "video", "src": "/asset/Untitled/clip.mp4", "loop": True},
        }, "RobotSim"))
        assert os.listdir(os.path.join(tmp_root, "RobotSim", "assets")) == [], "fixture: RobotSim must start assetless"

        zf, warning = archive_of(port, "RobotSim")
        members = sorted(zf.namelist())
        archived = json.loads(zf.read("RobotSim/doc.json"))
        assert warning is None, f"a localizable asset must not warn: {warning}"
        assert "RobotSim/assets/clip.mp4" in members, f"the borrowed video is NOT in the archive: {members}"
        assert zf.read("RobotSim/assets/clip.mp4") == VIDEO_BYTES, "archived video bytes differ from the source"
        assert refs_of(archived) == ["/asset/RobotSim/clip.mp4"], f"archived refs not localized: {refs_of(archived)}"
        print(f"[1] USER'S CASE ok: video present ({len(VIDEO_BYTES)}B) and the archived ref is /asset/RobotSim/clip.mp4")

        # ── 2. THE SOURCE PROJECT IS UNTOUCHED ───────────────────────────────
        # Only the ARCHIVE is rewritten — the author's document keeps saying
        # exactly what the author wrote, and Untitled keeps its own copy.
        with open(os.path.join(tmp_root, "RobotSim", server.DOC_FILENAME)) as f:
            on_disk = json.load(f)
        assert refs_of(on_disk) == ["/asset/Untitled/clip.mp4"], f"on-disk doc was rewritten: {refs_of(on_disk)}"
        assert os.listdir(os.path.join(tmp_root, "RobotSim", "assets")) == [], "export must not copy into the source project"
        assert os.path.isfile(os.path.join(tmp_root, "Untitled", "assets", "clip.mp4")), "the lender lost its asset"
        print("[2] SOURCE UNTOUCHED ok: RobotSim/doc.json still references /asset/Untitled/, assets/ still empty")

        # ── 3. IMPORT THE ARCHIVE AND RESOLVE ITS OWN REF ────────────────────
        # This is the user's "load that zip into the browser", reduced to the one
        # request that decides it.
        _, body, _ = get(port, "/api/download/RobotSim/")
        status, reply = post(port, "/api/import-zip/?name=RobotSimImported", body)
        assert status == 200 and reply["ok"], reply
        imported = reply["name"]
        with open(os.path.join(tmp_root, imported, server.DOC_FILENAME)) as f:
            imported_doc = json.load(f)
        ref = refs_of(imported_doc)[0]
        assert ref == f"/asset/{imported}/clip.mp4", f"imported ref is not local: {ref}"
        status, served, _ = get(port, ref)
        assert status == 200, f"the imported deck's own ref does not resolve: {status} for {ref}"
        assert served == VIDEO_BYTES, "the imported ref resolves to DIFFERENT bytes"
        print(f"[3] IMPORT+RESOLVE ok: {imported} → GET {ref} = 200, {len(served)}B byte-identical")

        # ── 4. THE LENDER MAY VANISH ─────────────────────────────────────────
        # The property that was missing: before localization the imported deck
        # depended on a folder the archive never carried.
        shutil.rmtree(os.path.join(tmp_root, "Untitled"))
        status, served, _ = get(port, ref)
        assert status == 200 and served == VIDEO_BYTES, f"imported deck broke when the lender vanished: {status}"
        status, _, _ = get(port, "/asset/Untitled/clip.mp4")
        assert status == 404, f"the vanished lender should 404, got {status} (fixture is not proving anything)"
        print("[4] LENDER VANISHED ok: /asset/Untitled/ is now 404, the imported deck still resolves")

        # ── 5. COLLISION-SAFE NAMING ─────────────────────────────────────────
        # A foreign basename already taken locally must land BESIDE the incumbent,
        # and the ref must point at the copy — repointing at the incumbent would
        # silently swap one image for another.
        write_project("Lender", doc_with({}, "Lender"), [("logo.png", b"FOREIGN-LOGO")])
        write_project("Deck", doc_with({
            "own": {"type": "image", "src": "/asset/Deck/logo.png"},
            "borrowed": {"type": "image", "src": "/asset/Lender/logo.png"},
        }, "Deck"), [("logo.png", b"LOCAL-LOGO")])
        zf, warning = archive_of(port, "Deck")
        archived = json.loads(zf.read("Deck/doc.json"))
        assert warning is None, warning
        assert refs_of(archived) == ["/asset/Deck/logo.png", "/asset/Deck/logo-2.png"], refs_of(archived)
        assert zf.read("Deck/assets/logo.png") == b"LOCAL-LOGO", "the local logo was overwritten by the copy"
        assert zf.read("Deck/assets/logo-2.png") == b"FOREIGN-LOGO", "the copy holds the wrong bytes"
        print("[5] COLLISION-SAFE ok: foreign logo.png landed as logo-2.png; the local one is intact")

        # ── 6. AN ALREADY-LOCAL PROJECT IS NOT REWRITTEN ─────────────────────
        # No gratuitous rewrite: a self-contained project's archived doc.json must
        # be the file it stores, byte for byte (indentation included), so an export
        # of an untouched project is reproducible.
        write_project("Solo", doc_with({"i": {"type": "image", "src": "/asset/Solo/a.png"}}, "Solo"),
                      [("a.png", b"A")])
        zf, warning = archive_of(port, "Solo")
        assert warning is None, warning
        with open(os.path.join(tmp_root, "Solo", server.DOC_FILENAME), "rb") as f:
            stored = f.read()
        assert zf.read("Solo/doc.json") == stored, "a self-contained doc.json must be archived verbatim"
        assert sorted(zf.namelist()) == ["Solo/assets/a.png", "Solo/doc.json"], zf.namelist()
        print("[6] ALREADY LOCAL ok: doc.json archived byte-for-byte, no extra members, no warnings")

        # ── 7. A MISSING FOREIGN SOURCE IS LOUD ──────────────────────────────
        # Exports anyway (a half-broken deck is the author's to fix, and refusing
        # the download would strand them), keeps the ORIGINAL ref (a findable
        # broken ref beats an unfindable one), and says so.
        write_project("Broken", doc_with({"v": {"type": "video", "src": "/asset/Ghost/gone.mp4"}}, "Broken"))
        zf, warning = archive_of(port, "Broken")
        archived = json.loads(zf.read("Broken/doc.json"))
        assert warning, "a missing foreign asset MUST warn — silence is the bug"
        assert "/asset/Ghost/gone.mp4" in warning, f"the warning must NAME the asset: {warning}"
        assert refs_of(archived) == ["/asset/Ghost/gone.mp4"], f"an uncopyable ref must be left as authored: {refs_of(archived)}"
        assert not any(m.startswith("Broken/assets/") for m in zf.namelist()), zf.namelist()
        print(f"[7] MISSING SOURCE ok: exported with the ref intact + header warning naming it\n        {warning}")

        # ── 8. NON-REFS ARE NOT TOUCHED ──────────────────────────────────────
        # The walk recognizes refs by grammar rather than by key name, so the risk
        # runs the other way too: an equation whose text merely CONTAINS "/asset/"
        # must survive verbatim.
        equation = '= "/asset/Lender/logo.png" + name'
        write_project("Mixed", doc_with({
            "t": {"type": "text", "text": "= 1 + 2", "caption": equation,
                  "remote": "https://example.com/a.png", "inline": "data:image/png;base64,iVBO"},
            "v": {"type": "video", "src": "/asset/Lender/logo.png"},
        }, "Mixed"))
        zf, warning = archive_of(port, "Mixed")
        archived = json.loads(zf.read("Mixed/doc.json"))
        t = archived["slides"][0]["delta"]["items"]["t"]
        assert warning is None, warning
        assert t["text"] == "= 1 + 2" and t["caption"] == equation, t
        assert t["remote"] == "https://example.com/a.png" and t["inline"].startswith("data:"), t
        assert archived["slides"][0]["delta"]["items"]["v"]["src"] == "/asset/Mixed/logo.png"
        print("[8] NON-REFS ok: equations, http and data: URLs untouched; only the real src moved")

        print("\nALL SELF-CONTAINED-ZIP CHECKS PASSED")
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
