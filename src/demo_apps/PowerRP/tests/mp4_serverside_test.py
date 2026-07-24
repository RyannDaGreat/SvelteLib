# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "fire==0.7.1"]
# ///
# (fire is needed because this test imports server/server.py, which imports fire
# at module load; numpy builds the test frames.)
"""
MP4 SERVER-SIDE EXPORT TEST — proves the server-side MP4 export end to end over
PLAIN HTTP (no secure context, which is the whole point: the browser's WebCodecs
VideoEncoder is unavailable on plain-HTTP LAN origins, so encoding moved to the
server's ffmpeg).

It stands up the REAL server (server/server.py Handler) on a ThreadingHTTPServer
bound to 127.0.0.1 over plain HTTP, then drives the three new routes exactly as
the browser encoder (web/serverMp4Encoder.js) does:
  1. POST /api/export-mp4/                      → mint a session
  2. POST /api/export-mp4/<sid>/frame/<i>/      → upload N rendered PNG frames
  3. POST /api/export-mp4/<sid>/encode/         → {fps, crf} → the .mp4 bytes
Then it ffprobes the returned MP4 and asserts dimensions, exact frame count, and
frame rate, saves one decoded frame for a VLM (a red box that moves left→right),
and checks the LOUD failure paths (bad CRF → 400; no frames → 500).

Run:  uv run src/demo_apps/PowerRP/tests/mp4_serverside_test.py
Exits non-zero on any failed check.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import zlib
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)  # src/demo_apps/PowerRP
SERVER_DIR = os.path.join(APP_DIR, "server")
VLM_DIR = os.path.join(APP_DIR, ".claude_vlm_checks")
sys.path.insert(0, SERVER_DIR)

# Isolate the projects store (the export routes never touch it, but keep the real
# store untouched regardless — set BEFORE importing server, which reads the env).
TMP_PROJECTS = tempfile.mkdtemp(prefix="powerrp_test_projects_")
os.environ["POWERRP_PROJECTS_DIR"] = TMP_PROJECTS

import numpy as np  # noqa: E402
import server  # noqa: E402  (server/server.py)

# ── Test deck: a red box sliding left→right on a dark field (even dims for 4:2:0) ──
WIDTH, HEIGHT, FRAMES, FPS, CRF = 96, 64, 12, 12, 23
BOX = 16  # box edge in px


def make_frame(i):
    """
    Pure function. The i-th test frame: a dark field with a BOX×BOX red square
    whose left edge sweeps 0 → WIDTH-BOX across the FRAMES-frame clip.

    Returns:
        np.ndarray: (HEIGHT, WIDTH, 3) uint8 RGB

    Examples:
        >>> make_frame(0).shape
        (64, 96, 3)
        >>> int(make_frame(0)[HEIGHT // 2, 0, 0])   # red at the left on frame 0
        255
    """
    img = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    img[:, :, 2] = 24  # dark blue-ish background so the frame is not pure black
    x = round((WIDTH - BOX) * i / (FRAMES - 1))
    y = HEIGHT // 2 - BOX // 2
    img[y:y + BOX, x:x + BOX, 0] = 255  # red square (RGB channel 0)
    return img


def png_bytes(img):
    """
    Pure function. Encode an (H, W, 3) uint8 RGB array to PNG bytes using only
    the stdlib (zlib + struct) — no third-party image lib. One 'None' filter
    byte per scanline, a single IDAT, and the three required chunks.

    Args:
        img (np.ndarray): (H, W, 3) uint8 RGB

    Returns:
        bytes: a valid PNG file

    Examples:
        >>> png_bytes(np.zeros((2, 2, 3), dtype=np.uint8))[:8]
        b'\\x89PNG\\r\\n\\x1a\\n'
    """
    h, w, _ = img.shape
    raw = bytearray()
    for row in img:
        raw.append(0)  # PNG filter type 0 (None) per scanline
        raw.extend(row.tobytes())

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8 bits/channel, color type 2 (RGB)
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def post(base, path, data=None, content_type=None):
    """
    Command (HTTP round-trip over plain HTTP). POST to base+path; returns
    (status, body_bytes). Raises urllib HTTPError for a >=400 status (the caller
    catches it where a failure is the expected outcome).
    """
    req = urllib.request.Request(base + path, data=data, method="POST")
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req) as r:
        return r.status, r.read()


def ffprobe_stream(mp4_path):
    """Query (runs ffprobe). The first video stream's {width, height,
    nb_read_frames, avg_frame_rate} for an MP4 file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate",
         "-of", "json", mp4_path],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)["streams"][0]


def main():
    checks = []

    def need(cond, msg):
        checks.append((bool(cond), msg))

    # Start the REAL handler on a random free port over PLAIN HTTP.
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    base = f"http://127.0.0.1:{port}"
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    out_mp4 = os.path.join(tempfile.gettempdir(), "powerrp_serverside_out.mp4")
    try:
        need(base.startswith("http://"), f"served over PLAIN HTTP (no TLS): {base}")

        # 1. begin a session
        status, body = post(base, "/api/export-mp4/")
        session = json.loads(body)["sessionId"]
        need(status == 200 and bool(session), f"begin → sessionId ({session!r})")

        # 2. upload N rendered PNG frames (one at a time, in order — as the browser does)
        for i in range(FRAMES):
            png = png_bytes(make_frame(i))
            fstatus, fbody = post(base, f"/api/export-mp4/{session}/frame/{i}/", data=png, content_type="image/png")
            if fstatus != 200:
                need(False, f"frame {i} upload (status {fstatus})")
                break
        else:
            need(True, f"uploaded {FRAMES} PNG frames")

        # 3. encode → the .mp4 bytes
        enc_body = json.dumps({"fps": FPS, "crf": CRF}).encode()
        estatus, mp4 = post(base, f"/api/export-mp4/{session}/encode/", data=enc_body, content_type="application/json")
        need(estatus == 200 and len(mp4) > 500, f"encode → non-trivial mp4 ({len(mp4)} bytes)")
        need(mp4[4:8] == b"ftyp", "MP4 begins with an ftyp box")
        need(mp4.find(b"moov") != -1 and (mp4.find(b"moov") < mp4.find(b"mdat")), "faststart: moov before mdat (seekable)")

        with open(out_mp4, "wb") as f:
            f.write(mp4)
        info = ffprobe_stream(out_mp4)
        need(info["width"] == WIDTH and info["height"] == HEIGHT, f"dims {WIDTH}×{HEIGHT} (got {info['width']}×{info['height']})")
        need(int(info["nb_read_frames"]) == FRAMES, f"frame count = {FRAMES} (ffprobe {info['nb_read_frames']})")
        need(info["avg_frame_rate"] == f"{FPS}/1", f"frame rate = {FPS} fps (ffprobe {info['avg_frame_rate']})")

        # scratch must be gone after a successful encode
        need(not os.path.isdir(server.export_session_dir(session)), "session scratch cleaned up after encode")

        # Save one frame for a VLM (the box should be near the middle at frame 6).
        os.makedirs(VLM_DIR, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-y", "-i", out_mp4, "-vf", "select=eq(n\\,6)", "-vframes", "1",
             "-loglevel", "error", os.path.join(VLM_DIR, "mp4_serverside_mid.png")],
            check=True, capture_output=True,
        )

        # ── LOUD failure paths (no silent fallback) ──
        # bad CRF (out of [0,51]) → 400
        s2, _ = post(base, "/api/export-mp4/")
        bad_session = json.loads(_)["sessionId"]
        png = png_bytes(make_frame(0))
        post(base, f"/api/export-mp4/{bad_session}/frame/0/", data=png, content_type="image/png")
        try:
            post(base, f"/api/export-mp4/{bad_session}/encode/", data=json.dumps({"fps": FPS, "crf": 99}).encode(), content_type="application/json")
            need(False, "bad CRF rejected with 400 (got 200)")
        except urllib.error.HTTPError as e:
            need(e.code == 400, f"bad CRF rejected with 400 (got {e.code})")

        # no frames → loud error (>=400)
        s3, b3 = post(base, "/api/export-mp4/")
        empty_session = json.loads(b3)["sessionId"]
        try:
            post(base, f"/api/export-mp4/{empty_session}/encode/", data=json.dumps({"fps": FPS, "crf": CRF}).encode(), content_type="application/json")
            need(False, "encode with no frames errors loudly (got 200)")
        except urllib.error.HTTPError as e:
            need(e.code >= 400, f"encode with no frames errors loudly (got {e.code})")

    finally:
        httpd.shutdown()
        shutil.rmtree(TMP_PROJECTS, ignore_errors=True)
        if os.path.isfile(out_mp4):
            os.remove(out_mp4)

    print("\nMP4 SERVER-SIDE EXPORT TEST")
    ok = True
    for passed, msg in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {msg}")
        ok = ok and passed
    print(f"  VLM frame written to {VLM_DIR}/mp4_serverside_mid.png")
    print("\nMP4 SERVER-SIDE EXPORT OK" if ok else "\nMP4 SERVER-SIDE EXPORT FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
