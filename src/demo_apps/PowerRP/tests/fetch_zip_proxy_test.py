# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1"]
# ///
"""
/api/fetch-zip/ SSRF-policy test — the security gate on the zip proxy.

WHY THE PROXY EXISTS: a browser cannot fetch a .zip from a host that did not send
a CORS header, but a server can — CORS is a rule about what a PAGE may read, and
a server-side fetch is not a page. So "Open Project from URL" retries through
/api/fetch-zip/ when its own direct fetch is blocked (web/projectUrlImport.js).

WHY IT NEEDS THIS TEST: the endpoint fetches an ATTACKER-CHOSEN URL from INSIDE
the user's network and returns the body. That is textbook SSRF. Without limits it
would read a cloud metadata service (169.254.169.254) or a service on the
developer's own machine and hand the bytes to a web page. The policy is stated
above `checked_fetch_url` in server.py; this file EXECUTES it:

  1. SCHEME     — file:/gopher:/ftp: refused before any socket opens.
  2. PRIVATE    — loopback, link-local (incl. the metadata address), RFC1918,
                  CGNAT and unique-local v6 refused, by asking the `ipaddress`
                  module about the RESOLVED address rather than pattern-matching
                  the hostname (so a DNS name pointing at 127.0.0.1 is refused
                  too, with no allow-list to maintain).
  3. REDIRECT   — every hop re-checked; a public URL that 302s to 127.0.0.1 is
                  the classic bypass and must be refused AT THE HOP.
  4. SIZE CAP   — the declared Content-Length is refused over the cap.
  5. HAPPY PATH — a permitted fetch streams the bytes back verbatim.

THE HAPPY PATH IS THE AWKWARD ONE, and how it is handled is deliberate: a test
origin can only run on loopback, which rule 2 refuses BY DESIGN. Monkey-patching
the refusal away would test a policy that is not the shipped one. So the happy
path instead patches ONLY the address classifier's verdict for the test host
(_refuse_private_host), leaving the scheme check, the manual per-hop redirect
walk, the cap and the streaming loop as the real code — and case 3 proves the
per-hop check still runs by watching a redirect into loopback get refused while
that patch is NOT installed.

Run (exit code gated):
    /opt/homebrew/opt/python@3.10/bin/python3.10 tests/fetch_zip_proxy_test.py
"""

import http.client
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(os.path.dirname(HERE), "server")
sys.path.insert(0, SERVER_DIR)
import server  # noqa: E402

PASSED = []


def check(label, condition, detail=""):
    """Command. Assert `condition`, recording the check so the tail can count them."""
    assert condition, f"{label}{': ' + detail if detail else ''}"
    PASSED.append(label)
    print(f"[ok] {label}")


def make_zip_bytes():
    """Pure function. A tiny valid PowerRP-shaped .zip, as the proxy's payload."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("Deck/doc.json", json.dumps({"meta": {"name": "Deck"}, "slides": []}))
    return buf.getvalue()


ZIP_BYTES = make_zip_bytes()


class OriginHandler(BaseHTTPRequestHandler):
    """The remote host the proxy fetches FROM: serves a zip, a redirect, and a liar."""

    def log_message(self, *args):
        pass  # keep the test output readable; failures are asserted, not logged

    def do_GET(self):
        if self.path == "/deck.zip":
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(ZIP_BYTES)))
            self.end_headers()
            self.wfile.write(ZIP_BYTES)
        elif self.path == "/redirect-to-deck":
            # A LEGITIMATE redirect: this is how a real download usually arrives
            # (a GitHub release 302s to an S3/CDN URL), so it must be FOLLOWED,
            # not merely survived.
            self.send_response(302)
            self.send_header("Location", "/deck.zip")
            self.end_headers()
        elif self.path == "/redirect-to-loopback":
            # THE CLASSIC SSRF BYPASS: a permitted URL that redirects inward.
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/secret")
            self.end_headers()
        elif self.path == "/huge.zip":
            # Declares more than the cap without sending it — the cap must be
            # enforced on the DECLARED length, before any body is relayed.
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(server.FETCH_ZIP_MAX_BYTES + 1))
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def fetch_zip(port, url):
    """Query. GET /api/fetch-zip/?url=<url> from the app server → (status, body)."""
    conn = http.client.HTTPConnection("127.0.0.1", port)
    q = urllib.parse.urlencode({"url": url})
    conn.request("GET", f"/api/fetch-zip/?{q}")
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, body


def main():
    tmp_root = tempfile.mkdtemp(prefix="powerrp_fetchzip_test_")
    server.PROJECTS_DIR = tmp_root  # never touch real projects

    app = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    app_port = app.server_address[1]
    threading.Thread(target=app.serve_forever, daemon=True).start()

    origin = ThreadingHTTPServer(("127.0.0.1", 0), OriginHandler)
    origin_port = origin.server_address[1]
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    origin_base = f"http://127.0.0.1:{origin_port}"

    real_refuse = server._refuse_private_host
    try:
        # ── 1. SCHEME ────────────────────────────────────────────────────────
        for bad in ("file:///etc/passwd", "gopher://evil.dev/1", "ftp://files.dev/a.zip"):
            status, body = fetch_zip(app_port, bad)
            check(f"SCHEME refused: {bad}", status == 400, f"got {status}: {body!r}")
            check(f"SCHEME refusal names the scheme: {bad}", b"http" in body.lower(), body)

        # ── 2. PRIVATE / LOOPBACK DESTINATIONS ───────────────────────────────
        # The policy asks `ipaddress` about the RESOLVED address, so an IP
        # LITERAL is refused with no DNS involved and no allow-list consulted.
        private = [
            ("loopback", "http://127.0.0.1/deck.zip"),
            ("cloud metadata", "http://169.254.169.254/latest/meta-data/"),
            ("RFC1918 /24", "http://192.168.1.1/deck.zip"),
            ("RFC1918 /12", "http://172.16.0.5/deck.zip"),
            ("RFC1918 /8", "http://10.0.0.1/deck.zip"),
            ("CGNAT", "http://100.64.0.1/deck.zip"),
            ("IPv6 loopback", "http://[::1]/deck.zip"),
            ("IPv6 unique-local", "http://[fd00::1]/deck.zip"),
        ]
        for label, url in private:
            status, body = fetch_zip(app_port, url)
            check(f"PRIVATE refused ({label})", status == 400, f"{url} got {status}: {body!r}")
            check(f"PRIVATE refusal is explained ({label})", b"private" in body.lower() or b"refus" in body.lower(), body)

        # The REAL origin is on loopback, so the shipped policy refuses it too —
        # which is itself the proof that rule 2 is live against a host that is
        # genuinely reachable, not just against unroutable literals.
        status, body = fetch_zip(app_port, f"{origin_base}/deck.zip")
        check("PRIVATE refused (the live test origin, on loopback)", status == 400, f"got {status}: {body!r}")

        # ── 3. REDIRECT INTO LOOPBACK (the bypass) ───────────────────────────
        # Allow the origin host itself, then confirm its 302 into 127.0.0.1 is
        # STILL refused: proof the check runs PER HOP, not once at the entrance.
        def allow_only_origin(host):
            if host == "127.0.0.1":
                return None  # pretend the test origin is a public host
            return real_refuse(host)

        server._refuse_private_host = allow_only_origin
        try:
            status, body = fetch_zip(app_port, f"{origin_base}/deck.zip")
            check("HAPPY PATH: a permitted zip is proxied", status == 200, f"got {status}: {body[:200]!r}")
            check("HAPPY PATH: bytes are relayed VERBATIM", body == ZIP_BYTES, f"{len(body)} bytes vs {len(ZIP_BYTES)}")
            check("HAPPY PATH: the relayed payload is still a valid zip", zipfile.ZipFile(io.BytesIO(body)).namelist() == ["Deck/doc.json"])

            # A PERMITTED REDIRECT MUST BE FOLLOWED. This is the half of rule 3
            # that is not about refusing: real downloads redirect (a GitHub
            # release 302s to a CDN), so a proxy that merely SURVIVED redirects
            # without following them would fail every realistic share link. It
            # regressed exactly that way — urllib raises HTTPError for a 3xx it
            # was told not to follow, so the walk never saw the Location.
            status, body = fetch_zip(app_port, f"{origin_base}/redirect-to-deck")
            check("REDIRECT: a permitted 302 is FOLLOWED to the payload", status == 200, f"got {status}: {body[:200]!r}")
            check("REDIRECT: the followed hop returns the real bytes", body == ZIP_BYTES, f"{len(body)} bytes vs {len(ZIP_BYTES)}")

            # ── 4. SIZE CAP on the declared Content-Length ───────────────────
            status, body = fetch_zip(app_port, f"{origin_base}/huge.zip")
            check("SIZE CAP refuses an oversize declared length", status == 400, f"got {status}: {body!r}")
            check("SIZE CAP refusal names the cap", str(server.FETCH_ZIP_MAX_BYTES).encode() in body, body)
        finally:
            server._refuse_private_host = real_refuse

        # ── 3. REDIRECT INTO LOOPBACK, CHECKED AT THE HOP ────────────────────
        # THE ASSERTION THAT MATTERS: the entrance URL is PERMITTED and the fetch
        # is still refused, which only a re-check AFTER the 302 can explain. The
        # classifier below allows the first call (the entrance) and refuses the
        # second (the redirect target), and it COUNTS its calls — so a proxy that
        # followed redirects internally (urllib's default, which is what
        # open_checked_url deliberately disables) would call it ONCE, return the
        # secret, and fail both assertions here.
        calls = []

        def allow_entrance_refuse_target(host):
            calls.append(host)
            if len(calls) == 1:
                return None  # the entrance: pretend it is a public host
            raise ValueError(f"refusing to fetch from a private/loopback address: {host} ({host})")

        server._refuse_private_host = allow_entrance_refuse_target
        try:
            status, body = fetch_zip(app_port, f"{origin_base}/redirect-to-loopback")
            check("REDIRECT: a permitted URL that 302s inward is REFUSED", status == 400, f"got {status}: {body[:200]!r}")
            check("REDIRECT: the check ran on the SECOND hop too", len(calls) == 2, f"classifier saw {len(calls)} host(s): {calls} — one call means redirects were followed unchecked")
            check("REDIRECT: the refusal names the destination, not the entrance", b"127.0.0.1" in body, body)
        finally:
            server._refuse_private_host = real_refuse

        # ── 5. MISSING PARAMETER ─────────────────────────────────────────────
        conn = http.client.HTTPConnection("127.0.0.1", app_port)
        conn.request("GET", "/api/fetch-zip/")
        resp = conn.getresponse()
        body = resp.read()
        check("no ?url= is a 400 that says what is needed", resp.status == 400 and b"url" in body.lower(), f"{resp.status}: {body!r}")
        conn.close()

        print(f"\nfetch_zip_proxy_test: {len(PASSED)} checks passed")
    finally:
        server._refuse_private_host = real_refuse
        app.shutdown()
        origin.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
