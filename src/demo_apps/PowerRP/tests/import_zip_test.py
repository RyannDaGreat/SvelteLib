# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1"]
# ///
"""
Project .zip IMPORT round-trip test (the inverse of the Download-as-ZIP seam).

The user's question was "I can export a zip — can I OPEN one?". The answer is
POST /api/import-zip/, and the contract it must hold is that an archive that
LEFT this app comes back as a NEW project of the same name, with its assets,
and never as a silent overwrite of something already there. This drives that
against a LIVE server (ThreadingHTTPServer + server.Handler), the way
clipboard_endpoint_test.py drives the clipboard:

  1. ROUND TRIP  — save a project with assets, GET /api/download/, POST those
                   exact bytes to /api/import-zip/ under a free name → a new
                   project whose doc.json and asset bytes match the original.
  2. COLLISION   — importing again under a name that EXISTS lands as "<Name> 2",
                   the original is untouched, and the response reports BOTH the
                   requested and the final name (so the UI can say so out loud).
  3. NAME SOURCE — with no ?name=, the archive's own root folder names it.
  4. TRAVERSAL   — a hand-crafted archive with a "../" member is a 400 {error}
                   and writes NOTHING outside the projects root.
  5. NOT A DECK  — a valid .zip with no doc.json is a 400 {error} (an archive of
                   holiday photos is not a presentation), and leaves no folder.
  6. NOT A ZIP   — garbage bytes are a 400 {error}, never a 500.

Run (exit code gated):
    /opt/homebrew/opt/python@3.10/bin/python3.10 tests/import_zip_test.py
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

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"fake-pixels-for-the-asset-round-trip"
DOC = {"meta": {"name": "Zip Deck", "width": 1920, "height": 1080},
       "slides": [{"id": "s0", "name": "Title", "delta": {"items": {}}}]}


def _req(conn, method, path, body=None, content_type="application/json"):
    """Command/Query. method path over a connection → (status, body_bytes)."""
    headers = {"Content-Type": content_type} if body is not None else {}
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    return resp.status, resp.read()


def main():
    tmp_root = tempfile.mkdtemp(prefix="powerrp_import_zip_test_")
    server.PROJECTS_DIR = tmp_root  # never touch real projects

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # A real source project: doc.json + one asset, written through the same
        # commands the app uses (not by hand), so the archive is the real format.
        server.save_project("Zip Deck", DOC)
        server.save_asset("Zip Deck", "logo.png", PNG_BYTES)

        # 1. ROUND TRIP — download, then import under a free name.
        status, archive = _req(conn, "GET", "/api/download/Zip%20Deck/")
        assert status == 200 and archive[:2] == b"PK", f"download status {status}"
        status, body = _req(conn, "POST", "/api/import-zip/?name=Imported%20Deck",
                            body=archive, content_type="application/zip")
        assert status == 200, f"import status {status}: {body!r}"
        got = json.loads(body)
        assert got["name"] == "Imported Deck", got
        with open(os.path.join(tmp_root, "Imported Deck", "doc.json")) as f:
            assert json.load(f) == DOC, "imported doc.json differs from the exported one"
        with open(os.path.join(tmp_root, "Imported Deck", "assets", "logo.png"), "rb") as f:
            assert f.read() == PNG_BYTES, "imported asset bytes differ"
        names = {p["name"] for p in server.list_projects()}
        assert "Imported Deck" in names, names
        print("[1] ROUND TRIP ok: exported .zip → new project 'Imported Deck' with doc.json + logo.png byte-identical")

        # 2. COLLISION — the same name again becomes "Imported Deck 2", and the
        #    first import is left exactly as it was (never a clobber).
        status, body = _req(conn, "POST", "/api/import-zip/?name=Imported%20Deck",
                            body=archive, content_type="application/zip")
        assert status == 200, body
        got = json.loads(body)
        assert got["name"] == "Imported Deck 2", got
        assert got["requested"] == "Imported Deck", f"response must report the requested name too: {got}"
        assert os.path.isfile(os.path.join(tmp_root, "Imported Deck", "doc.json")), "original was destroyed"
        assert os.path.isfile(os.path.join(tmp_root, "Imported Deck 2", "assets", "logo.png"))
        print("[2] COLLISION ok: second import → 'Imported Deck 2', original untouched, both names reported")

        # 3. NAME SOURCE — no ?name=: the archive's root folder ("Zip Deck")
        #    names it, and that itself collides with the source project → " 2".
        status, body = _req(conn, "POST", "/api/import-zip/", body=archive, content_type="application/zip")
        assert status == 200, body
        got = json.loads(body)
        assert got["name"] == "Zip Deck 2", f"archive root should name the import: {got}"
        print("[3] NAME SOURCE ok: with no ?name=, the archive's root folder names the project ('Zip Deck 2')")

        # 4. TRAVERSAL — a crafted archive must fail loudly and write nothing.
        outside = os.path.join(os.path.dirname(tmp_root), "powerrp_import_escape.json")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("doc.json", json.dumps(DOC))
            zf.writestr("../powerrp_import_escape.json", "pwned")
        status, body = _req(conn, "POST", "/api/import-zip/?name=Evil", body=buf.getvalue(),
                            content_type="application/zip")
        assert status == 400, f"traversal must be a 400, got {status}: {body!r}"
        assert "error" in json.loads(body), body
        assert not os.path.exists(outside), f"traversal ESCAPED: wrote {outside}"
        assert not os.path.exists(os.path.join(tmp_root, "Evil")), "a refused import must leave no folder"
        print("[4] TRAVERSAL ok: '../' member → 400 {error}, nothing written outside the projects root")

        # 5. NOT A DECK — a valid zip with no doc.json is not a presentation.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("holiday/beach.png", PNG_BYTES)
        status, body = _req(conn, "POST", "/api/import-zip/?name=Holiday", body=buf.getvalue(),
                            content_type="application/zip")
        assert status == 400, f"a doc.json-less archive must 400, got {status}: {body!r}"
        assert "doc.json" in json.loads(body)["error"], body
        assert not os.path.exists(os.path.join(tmp_root, "Holiday")), "a refused import must leave no folder"
        print("[5] NOT A DECK ok: archive without doc.json → 400 naming doc.json, no folder created")

        # 6. NOT A ZIP — garbage is a 400, not an uncaught 500.
        status, body = _req(conn, "POST", "/api/import-zip/?name=Junk", body=b"this is not a zip",
                            content_type="application/zip")
        assert status == 400, f"garbage bytes must 400, got {status}: {body!r}"
        print("[6] NOT A ZIP ok: garbage bytes → 400 {error}")

        print("\nALL IMPORT-ZIP CHECKS PASSED")
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
