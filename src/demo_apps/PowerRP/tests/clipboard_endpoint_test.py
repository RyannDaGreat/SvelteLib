# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1"]
# ///
"""
Session-clipboard endpoint round-trip test (manifest 14.10 AMENDED — OpusK).

The COPY→PASTE-across-presentations story lives on the server: a per-browser
clipboard the server keys by a session cookie, so two open presentations of the
same browser share the last-copied item. This drives the two endpoints end to
end against a LIVE server (ThreadingHTTPServer + server.Handler), the same way
frames_endpoint_test.py drives the frames seam:

  1. EMPTY   — a fresh browser (no cookie) GET /api/clipboard/ returns
               {payload:null} and gets a Set-Cookie minting its session.
  2. SET+GET — PUT /api/clipboard/ {payload:<json str>} then GET (carrying the
               cookie) returns the exact payload — the copy→paste round-trip.
  3. TWO TABS — a SECOND connection reusing the SAME cookie reads the payload:
               two presentations of one browser share the clipboard.
  4. ISOLATED — a THIRD connection with NO cookie (a different browser) gets a
               fresh session and sees {payload:null}, never tab 1's copy.
  5. OVERWRITE — a second PUT replaces the payload (last copy wins).
  6. LOUD ERROR — PUT with a non-string payload is a 400 JSON {error}, not a
               silent accept (manifest error-handling rule).

No fixtures, no disk: the clipboard is in-memory. A throwaway PROJECTS_DIR is
still set so the imported server never touches real projects.

Run (exit code gated):
    /opt/homebrew/opt/python@3.10/bin/python3.10 tests/clipboard_endpoint_test.py
"""

import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(os.path.dirname(HERE), "server")
sys.path.insert(0, SERVER_DIR)
import server  # noqa: E402

SESSION_COOKIE = "powerrp_session"


def _req(conn, method, path, cookie=None, body=None):
    """Command/Query. method path over a connection → (status, body_bytes, set_cookie_session_or_None)."""
    headers = {}
    if cookie:
        headers["Cookie"] = f"{SESSION_COOKIE}={cookie}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    set_cookie = resp.getheader("Set-Cookie")
    session = None
    if set_cookie and set_cookie.startswith(f"{SESSION_COOKIE}="):
        session = set_cookie.split(";", 1)[0].split("=", 1)[1]
    return resp.status, data, session


def main():
    tmp_root = tempfile.mkdtemp(prefix="powerrp_clipboard_test_")
    server.PROJECTS_DIR = tmp_root  # never touch real projects (defensive)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # 1. EMPTY — fresh browser, no cookie: null payload + a minted session.
        status, body, session = _req(conn, "GET", "/api/clipboard/")
        assert status == 200, f"empty GET status {status}: {body!r}"
        assert json.loads(body) == {"payload": None}, body
        assert session, "server did not mint a session cookie for a fresh browser"
        print(f"[1] EMPTY ok: fresh browser → payload null, session minted ({session[:8]}…)")

        # 2. SET + GET — the copy→paste round-trip (item JSON as an opaque str).
        item = json.dumps({"powerrp_item": {
            "type": "filmstrip", "frameUrls": [f"/asset/p/frames/v/18/frame_{i:03d}.png" for i in range(1, 19)],
            "shadow": {"dx": 0, "dy": 0, "blur": 0, "color": "#000000", "opacity": 0},
            "rotationAnchor": {"x": "self.anchors.center.x", "y": "self.anchors.center.y"},
        }})
        status, body, _ = _req(conn, "PUT", "/api/clipboard/", cookie=session, body=json.dumps({"payload": item}))
        assert status == 200 and json.loads(body) == {"ok": True}, body
        status, body, _ = _req(conn, "GET", "/api/clipboard/", cookie=session)
        assert status == 200, body
        assert json.loads(body)["payload"] == item, "round-trip payload mismatch"
        # And the payload really is the 18-frame filmstrip item we copied.
        got = json.loads(json.loads(body)["payload"])["powerrp_item"]
        assert got["type"] == "filmstrip" and len(got["frameUrls"]) == 18, got
        print("[2] SET+GET ok: 18-frame filmstrip item round-trips (frameUrls array + nested shadow + equation anchor)")

        # 3. TWO TABS — a second connection reusing the SAME cookie sees the copy.
        conn2 = http.client.HTTPConnection("127.0.0.1", port)
        status, body, _ = _req(conn2, "GET", "/api/clipboard/", cookie=session)
        assert status == 200 and json.loads(body)["payload"] == item, "second tab did not share the clipboard"
        print("[3] TWO TABS ok: a second presentation of the same browser reads the copy")

        # 4. ISOLATED — a different browser (no cookie) sees nothing.
        conn3 = http.client.HTTPConnection("127.0.0.1", port)
        status, body, other = _req(conn3, "GET", "/api/clipboard/")
        assert status == 200 and json.loads(body) == {"payload": None}, body
        assert other and other != session, "a different browser must get its own session"
        print("[4] ISOLATED ok: a different browser session sees payload null (no cross-session leak)")

        # 5. OVERWRITE — last copy wins.
        item2 = json.dumps({"powerrp_item": {"type": "rect", "x": 5, "y": 5}})
        _req(conn, "PUT", "/api/clipboard/", cookie=session, body=json.dumps({"payload": item2}))
        status, body, _ = _req(conn, "GET", "/api/clipboard/", cookie=session)
        assert json.loads(body)["payload"] == item2, "overwrite did not replace the payload"
        print("[5] OVERWRITE ok: a second copy replaces the first")

        # 6. LOUD ERROR — a non-string payload is a 400 {error}, never a silent OK.
        status, body, _ = _req(conn, "PUT", "/api/clipboard/", cookie=session, body=json.dumps({"payload": {"not": "a string"}}))
        assert status == 400, f"non-string payload should 400, got {status}: {body!r}"
        assert "error" in json.loads(body), body
        print("[6] LOUD ERROR ok: non-string payload → 400 JSON {error}")

        print("\nALL CLIPBOARD-ENDPOINT CHECKS PASSED")
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
