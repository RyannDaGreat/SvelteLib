# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
ANIMATED GIFs ARE VIDEOS — the server half (workstream GIFVID_).

The defect (user, verbatim): "how does our powerrp handle gifs? as videos
hopefully?" The measured answer was no — `.gif` is in IMAGE_EXTS, so an animated
GIF became an image widget and the canvas showed a FROZEN FIRST FRAME with nothing
to say it had frozen. No browser element plays a GIF as a timed stream, so the fix
is a server-side ffmpeg transcode at upload (server.py transcode_uploaded_gif).

What this proves, against a REAL upload through the real HTTP handler:

  1. ANIMATED GIF -> MP4 SIBLING. The upload reply carries a `transcode` block
     naming an .mp4 that exists on disk, lists as kind "video", and is a real
     playable h264/yuv420p file.
  2. EVEN DIMENSIONS. The fixture is deliberately 11x7 — ODD on both axes, which
     yuv420p cannot encode. The mp4 must come out 10x6. A pad/crop bug or a
     dropped filter shows up here and nowhere else.
  3. SINGLE-FRAME GIF IS UNTOUCHED. A one-frame GIF reports {animated: False},
     writes NO sibling, and the library holds exactly one file — byte-identical
     to the behaviour before this feature.
  4. LOUD FAILURE, NEVER A SILENT STILL. A .gif that ffprobe cannot decode is a
     500 whose message names the file; the bytes are still stored (it is the
     user's file) but nothing pretends the conversion happened.

Deterministic fixtures: tests/fixtures/gifvid_animated.gif (4 frames, 11x7) and
tests/fixtures/gifvid_still.gif (1 frame, 11x7) — under 1KB each, generated with
ffmpeg's `testsrc`.

Run (exit code gated):
    /opt/homebrew/opt/python@3.10/bin/python3.10 tests/gifvid_server_test.py
"""

import http.client
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(os.path.dirname(HERE), "server")
ANIMATED = os.path.join(HERE, "fixtures", "gifvid_animated.gif")
STILL = os.path.join(HERE, "fixtures", "gifvid_still.gif")
ANIMATED_FRAMES = 4          # the committed fixture is exactly 4 frames
FIXTURE_DIMS = (11, 7)       # ODD on BOTH axes, on purpose (see check 2)
EXPECTED_MP4_DIMS = (10, 6)  # each axis rounded DOWN to even by GIF_EVEN_DIMS_FILTER
sys.path.insert(0, SERVER_DIR)
import server  # noqa: E402


def _upload(conn, project, filename, data):
    """Command. POST bytes to the upload endpoint -> (status, parsed JSON body)."""
    path = f"/api/upload/{project}/?filename={filename}"
    conn.request("POST", path, body=data, headers={"Content-Type": "application/octet-stream"})
    resp = conn.getresponse()
    body = resp.read()
    return resp.status, json.loads(body)


def _get(conn, path):
    """Query. GET path over an open connection -> (status, parsed JSON body)."""
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())


def _probe_stream(path):
    """Query (ffprobe). {width, height, pix_fmt, codec_name} of a video file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,pix_fmt,codec_name",
         "-of", "json", path],
        capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL,
    ).stdout
    return json.loads(out)["streams"][0]


def main():
    for f in (ANIMATED, STILL):
        assert os.path.isfile(f), f"fixture missing: {f}"

    # The PURE QUERY agrees with the fixtures before any HTTP is involved.
    assert server.gif_frame_count(ANIMATED) == ANIMATED_FRAMES, server.gif_frame_count(ANIMATED)
    assert server.gif_frame_count(STILL) == 1, server.gif_frame_count(STILL)
    assert server.gif_mp4_sibling_name("spinner.gif") == "spinner.mp4"
    assert server.gif_mp4_sibling_name("my.logo.GIF") == "my.logo.mp4"
    print(f"[0] gif_frame_count ok: animated={ANIMATED_FRAMES}, still=1; sibling naming ok")

    tmp_root = tempfile.mkdtemp(prefix="powerrp_gifvid_test_")
    server.PROJECTS_DIR = tmp_root  # redirect storage root (module global)
    proj = "gifvidtest"
    os.makedirs(server.assets_dir(proj), exist_ok=True)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # 1. ANIMATED GIF -> MP4 SIBLING ------------------------------------
        with open(ANIMATED, "rb") as f:
            status, reply = _upload(conn, proj, "spinner.gif", f.read())
        assert status == 200, f"upload status {status}: {reply}"
        assert reply["name"] == "spinner.gif", reply
        t = reply.get("transcode")
        assert t, f"upload reply carries no transcode block: {reply}"
        assert t["animated"] is True, t
        assert t["frames"] == ANIMATED_FRAMES, t
        assert t["name"] == "spinner.mp4", t
        assert t["url"] == f"/asset/{proj}/spinner.mp4", t
        mp4_path = os.path.join(server.assets_dir(proj), "spinner.mp4")
        assert os.path.isfile(mp4_path), f"transcode reported {t['name']} but it is not on disk"
        print(f"[1] ANIMATED -> MP4 ok: {t}")

        # The mp4 lists as a VIDEO asset, so every video affordance reaches it.
        status, assets = _get(conn, f"/api/assets/{proj}/")
        assert status == 200, assets
        by_name = {a["name"]: a for a in assets}
        assert by_name["spinner.gif"]["kind"] == "image", by_name["spinner.gif"]
        assert by_name["spinner.mp4"]["kind"] == "video", by_name["spinner.mp4"]
        assert by_name["spinner.mp4"].get("durationSec", 0) > 0, by_name["spinner.mp4"]
        print(f"[1b] LISTING ok: the .gif stays an image, the .mp4 is a video "
              f"({by_name['spinner.mp4']['durationSec']:.2f}s)")

        # 2. EVEN DIMENSIONS ------------------------------------------------
        stream = _probe_stream(mp4_path)
        assert (stream["width"], stream["height"]) == EXPECTED_MP4_DIMS, (
            f"an {FIXTURE_DIMS} GIF must transcode to {EXPECTED_MP4_DIMS} (yuv420p needs even "
            f"dimensions), got {(stream['width'], stream['height'])}")
        assert stream["pix_fmt"] == "yuv420p", stream
        assert stream["codec_name"] == "h264", stream
        print(f"[2] EVEN DIMS ok: {FIXTURE_DIMS} GIF -> {EXPECTED_MP4_DIMS} h264/yuv420p")

        # 3. SINGLE-FRAME GIF IS UNTOUCHED ----------------------------------
        before = set(os.listdir(server.assets_dir(proj)))
        with open(STILL, "rb") as f:
            status, reply = _upload(conn, proj, "logo.gif", f.read())
        assert status == 200, f"upload status {status}: {reply}"
        assert reply["transcode"] == {"animated": False, "frames": 1}, reply
        after = set(os.listdir(server.assets_dir(proj)))
        assert after - before == {"logo.gif"}, (
            f"a still GIF must write ONLY itself, but the upload added {sorted(after - before)}")
        print("[3] SINGLE-FRAME ok: {animated: False, frames: 1}, no sibling written")

        # 4. LOUD FAILURE ---------------------------------------------------
        # A .gif extension over bytes ffprobe cannot decode. The file must still be
        # stored (it is the user's), and the reply must be an ERROR naming it —
        # never a 200 that omits the block and reads as "a still image".
        status, reply = _upload(conn, proj, "broken.gif", b"GIF89a this is not a gif")
        assert status == 500, f"an undecodable GIF must fail loudly, got {status}: {reply}"
        assert "broken.gif" in reply.get("error", ""), reply
        assert os.path.isfile(os.path.join(server.assets_dir(proj), "broken.gif")), (
            "the uploaded bytes must be kept even when the transcode fails")
        assert not os.path.exists(os.path.join(server.assets_dir(proj), "broken.mp4")), (
            "a failed transcode must leave NO half-written mp4 (it would list as a playable video)")
        print(f"[4] LOUD FAILURE ok: 500 — {reply['error'][:90]}…")

        print("\nALL GIF-TRANSCODE SERVER CHECKS PASSED")
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
