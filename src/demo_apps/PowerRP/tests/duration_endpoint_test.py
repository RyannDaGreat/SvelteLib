# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1"]
# ///
"""
Video DURATION endpoint + list_assets `durationSec` test (manifest item 72 —
the deterministic `self.length` behind the time-driven scrubber presets).

The scrubber's dream equation is `currentTime = time % self.length`; `self.length`
is the clip's intrinsic duration, and the DETERMINISTIC source of that number is
ffprobe on the server (a codec-reported container property of the FILE, stable
across machines/browsers, unlike a browser `<video>.duration` read). This proves
that number reaches the document, two ways:

  1. DEDICATED ENDPOINT — GET /api/duration/<proj>/<video> -> {durationSec}, the
     exact value the scrubber's "Probe clip length" command writes onto its
     `length` prop.
  2. LIST METADATA — GET /api/assets/<proj>/ attaches `durationSec` to VIDEO
     entries (O(1) container read, no frame decode) and to NOTHING else, so the
     asset library carries the machine-stable length with no extra round-trip.
  3. LOUD ERRORS — a missing video is a 404 JSON {error}, never a silent 0.

Deterministic fixture: tests/fixtures/scrub_video.mp4 (a committed 3.0-second
RGB-per-second clip — a binary fixture like checker.png, needing only ffmpeg
DECODE, which is what ffprobe does).

Run (exit code gated):
    /opt/homebrew/opt/python@3.10/bin/python3.10 tests/duration_endpoint_test.py
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
FIXTURE = os.path.join(HERE, "fixtures", "scrub_video.mp4")
FIXTURE_SECONDS = 3.0  # the committed clip is exactly 3.0s (red/green/blue, 1s each)
EPS = 0.1  # container duration is exact for this clip, but allow codec rounding
sys.path.insert(0, SERVER_DIR)
import server  # noqa: E402


def _get(conn, path):
    """Query. GET path over an open connection -> (status, body_bytes)."""
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, resp.read()


def main():
    assert os.path.isfile(FIXTURE), f"fixture video missing: {FIXTURE}"
    tmp_root = tempfile.mkdtemp(prefix="powerrp_duration_test_")
    server.PROJECTS_DIR = tmp_root  # redirect storage root (module global)
    proj = "durationtest"
    video = "clip.mp4"

    os.makedirs(server.assets_dir(proj), exist_ok=True)
    shutil.copy(FIXTURE, os.path.join(server.assets_dir(proj), video))
    # A non-video asset, to prove durationSec is attached to videos ONLY.
    with open(os.path.join(server.assets_dir(proj), "note.txt"), "w") as f:
        f.write("not a video")

    # The pure query itself agrees with the fixture (no HTTP).
    dur = server.video_duration_seconds(os.path.join(server.assets_dir(proj), video))
    assert abs(dur - FIXTURE_SECONDS) < EPS, f"video_duration_seconds={dur}, expected ~{FIXTURE_SECONDS}"
    print(f"[0] video_duration_seconds ok: {dur}s")

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # 1. DEDICATED ENDPOINT ---------------------------------------------
        status, body = _get(conn, f"/api/duration/{proj}/{video}")
        assert status == 200, f"duration status {status}: {body!r}"
        res = json.loads(body)
        assert abs(res["durationSec"] - FIXTURE_SECONDS) < EPS, res
        print(f"[1] ENDPOINT ok: /api/duration -> {res}")

        # 2. LIST METADATA — video entry carries durationSec; note.txt does not.
        status, body = _get(conn, f"/api/assets/{proj}/")
        assert status == 200, body
        assets = {a["name"]: a for a in json.loads(body)}
        assert "durationSec" in assets[video], f"video entry missing durationSec: {assets[video]}"
        assert abs(assets[video]["durationSec"] - FIXTURE_SECONDS) < EPS, assets[video]
        assert "durationSec" not in assets["note.txt"], f"non-video wrongly got durationSec: {assets['note.txt']}"
        print(f"[2] LIST METADATA ok: video durationSec={assets[video]['durationSec']}, note.txt has none")

        # 3. LOUD ERRORS — a missing video is a 404 {error}, not a silent 0.
        s_missing, b_missing = _get(conn, f"/api/duration/{proj}/nope.mp4")
        assert s_missing == 404, f"missing video should 404, got {s_missing}: {b_missing!r}"
        assert "error" in json.loads(b_missing), b_missing
        print("[3] LOUD ERRORS ok: missing video -> 404 JSON {error}")

        print("\nALL DURATION-ENDPOINT CHECKS PASSED")
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
