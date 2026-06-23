# /// script
# requires-python = ">=3.10"
# dependencies = ["rp", "fire", "numpy", "pillow", "video-reader-rs", "easydict", "opencv-python-headless", "moviepy"]
# ///
"""
Video Slice Annotator — backend.

A deliberately small server (stdlib http.server, no Flask) for annotating a flat
folder of videos. It serves the source videos with HTTP Range support, lazily
builds low-res proxies and single-frame JPEGs into a gitignored cache, and reads
/ writes one annotation JSON per video under ./outputs.

Run:
    uv run server.py serve --videos_dir="/path/to/videos" --port=8000
    uv run server.py pre_compute_small_videos --videos_dir="/path/to/videos"

See README.md for the full contract (endpoints, JSON shape, assumptions).
"""

import json
import os
import subprocess
import sys
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fire

# -- Paths & config ----------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "cache")
LOWRES_DIR = os.path.join(CACHE_DIR, "lowres_videos")
FRAMES_DIR = os.path.join(CACHE_DIR, "frames")
OUTPUTS_DIR = os.path.join(HERE, "outputs")
WEB_DIR = os.path.join(HERE, "web")

# Local-only default; always overridable with --videos_dir. See README "Portability".
DEFAULT_VIDEOS_DIR = "/Users/rburgert/Downloads/compressed_pairs copy"

# Low-res proxy encode: small frame (360p) + frequent keyframes = fast scrubbing.
# CRF-driven so quality stays consistent; keyframe every 6 frames (~0.5s) for snappy seeks.
LOWRES_FFMPEG_ARGS = [
    "-an", "-vf", "scale=-2:360,fps=12",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "34",
    "-g", "6", "-keyint_min", "6", "-sc_threshold", "0",
    "-movflags", "+faststart",
]
FRAME_JPEG_QUALITY = 80

# Mutable run config, set by serve(). The handler reads these.
CONFIG = {"videos_dir": DEFAULT_VIDEOS_DIR, "ffmpeg": "ffmpeg"}
_duration_cache = {}  # stem -> (mtime, seconds)


# -- Pure / query helpers ----------------------------------------------------

def video_path(stem):
    """Query. Absolute path of the source video for a stem (no existence check)."""
    return os.path.join(CONFIG["videos_dir"], stem + ".mp4")


def lowres_path(stem):
    """Pure-ish query. Cache path for a stem's low-res proxy."""
    return os.path.join(LOWRES_DIR, stem + "-lowres.mp4")


def output_path(stem):
    """Pure-ish query. Annotation JSON path for a stem."""
    return os.path.join(OUTPUTS_DIR, stem + ".json")


def list_stems():
    """Query. Sorted stems of every .mp4 directly in the videos dir (flat)."""
    try:
        names = os.listdir(CONFIG["videos_dir"])
    except FileNotFoundError:
        print(f"[videos] dir not found: {CONFIG['videos_dir']}", file=sys.stderr)
        return []
    return sorted(n[:-4] for n in names if n.lower().endswith(".mp4"))


def probe_duration(stem):
    """
    Query. Source video duration in seconds via ffprobe, memoised by mtime.
    Returns None if the file is missing or ffprobe fails (logged, not raised).
    """
    path = video_path(stem)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    cached = _duration_cache.get(stem)
    if cached and cached[0] == mtime:
        return cached[1]
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        print(f"[ffprobe] failed for {stem}: {out.stderr.strip()}", file=sys.stderr)
        return None
    seconds = float(out.stdout.strip())
    _duration_cache[stem] = (mtime, seconds)
    return seconds


def has_annotations(stem):
    """Query. True if a non-empty annotation JSON exists for this stem."""
    path = output_path(stem)
    if not os.path.exists(path):
        return False
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    return bool(data.get("labels") or data.get("comments"))


# -- Commands (side effects: build cache artifacts) --------------------------

def ensure_lowres(stem):
    """
    Command. Build the low-res proxy into the cache if missing; return its path.
    Raises on ffmpeg failure (caller logs + returns 500) — never silent.
    """
    out = lowres_path(stem)
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return out
    src = video_path(stem)
    if not os.path.exists(src):
        raise FileNotFoundError(f"source video missing: {src}")
    os.makedirs(LOWRES_DIR, exist_ok=True)
    tmp = out + ".tmp.mp4"
    cmd = [CONFIG["ffmpeg"], "-y", "-i", src, *LOWRES_FFMPEG_ARGS, tmp]
    print(f"[lowres] encoding {stem} …", file=sys.stderr)
    proc = subprocess.run(cmd)  # ffmpeg progress streams straight to the terminal
    if proc.returncode != 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError(f"ffmpeg lowres failed for {stem} (exit {proc.returncode}); see ffmpeg output above")
    os.replace(tmp, out)
    return out


def frame_jpeg_bytes(stem, t_seconds, max_dim=0):
    """
    Command. JPEG bytes of the frame nearest t_seconds, caching to disk. Encodes
    once with rp.encode_image_to_bytes and serves those same bytes (a cache hit
    just reads the file back). Frames come from rp.load_video_via_rs (fast
    Rust+FFmpeg decoder). When max_dim > 0 the frame is downscaled so its longest
    side is max_dim px, aspect preserved (small thumbnails don't need full res).
    Cached per (frame index, max_dim). Raises on failure (caller logs → 500).
    """
    import rp
    src = video_path(stem)
    if not os.path.exists(src):
        raise FileNotFoundError(f"source video missing: {src}")
    fps = rp.get_video_file_framerate(src)
    idx = max(0, round(float(t_seconds) * fps))
    name = f"{idx}-{max_dim}" if max_dim else str(idx)
    out = os.path.join(FRAMES_DIR, stem, f"{name}.jpg")
    if os.path.exists(out) and os.path.getsize(out) > 0:
        with open(out, "rb") as f:
            return f.read()
    frames = rp.load_video_via_rs(src, [idx])  # (1, H, W, C) uint8 RGB
    if len(frames) == 0:
        raise RuntimeError(f"no frame at index {idx} (t={t_seconds}s) in {stem}")
    frame = frames[0]  # (H, W, C) uint8 RGB
    h, w = frame.shape[:2]
    if max_dim and max(h, w) > max_dim:
        import cv2
        scale = max_dim / max(h, w)
        frame = cv2.resize(frame, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    jpeg = rp.encode_image_to_bytes(frame, "jpg", quality=FRAME_JPEG_QUALITY)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(jpeg)
    return jpeg


# -- HTTP handler ------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """Routes: /api/videos, /api/annotation/<stem> (GET/PUT), /video/<stem>,
       /lowres/<stem>, /frame/<stem>?t=, and static files from ./web."""

    server_version = "VideoSliceAnnotator/0.1"

    # -- low-level response helpers --

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        print(f"[{status}] {message}", file=sys.stderr)
        self._json({"error": message}, status)

    def _send_bytes(self, data, content_type):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_file(self, path, content_type):
        """Serve a file with HTTP Range support (needed for video seeking)."""
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng and rng.startswith("bytes="):
            lo, _, hi = rng[6:].partition("-")
            start = int(lo) if lo else 0
            end = int(hi) if hi else size - 1
            end = min(end, size - 1)
            status = 206
        length = end - start + 1
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return  # client seeked away / closed — normal for video
                remaining -= len(chunk)

    # -- routing --

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = [urllib.parse.unquote(p) for p in parsed.path.split("/") if p]
        try:
            if parsed.path == "/api/videos":
                return self._handle_videos()
            if len(parts) == 3 and parts[:2] == ["api", "annotation"]:
                return self._handle_get_annotation(parts[2])
            if len(parts) == 2 and parts[0] == "video":
                return self._serve_video(parts[1], lowres=False)
            if len(parts) == 2 and parts[0] == "lowres":
                return self._serve_video(parts[1], lowres=True)
            if len(parts) == 2 and parts[0] == "frame":
                q = urllib.parse.parse_qs(parsed.query)
                t = float(q.get("t", ["0"])[0])
                size = int(q.get("size", ["0"])[0])
                return self._serve_frame(parts[1], t, size)
            # This process is the API/media backend only; the app is the Vite
            # dev server. If APP_URL is set (start_server.sh does), bounce stray
            # visitors straight to it so a wrong-port open still lands on the app.
            app_url = os.environ.get("APP_URL")
            if app_url:
                self.send_response(302)
                self.send_header("Location", app_url)
                self._cors()
                self.end_headers()
                return
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Video Slice Annotator API backend</h2>"
                             b"<p>Open the app (the Vite dev server URL printed by start_server.sh).</p>")
        except Exception as exc:  # report loudly, never crash the server
            traceback.print_exc()
            self._error(500, f"{type(exc).__name__}: {exc}")

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = [urllib.parse.unquote(p) for p in parsed.path.split("/") if p]
        try:
            if len(parts) == 3 and parts[:2] == ["api", "annotation"]:
                return self._handle_put_annotation(parts[2])
            self._error(404, f"no PUT route for {parsed.path}")
        except Exception as exc:
            traceback.print_exc()
            self._error(500, f"{type(exc).__name__}: {exc}")

    # -- route handlers --

    def _handle_videos(self):
        items = [
            {"name": stem, "duration": probe_duration(stem),
             "hasAnnotations": has_annotations(stem)}
            for stem in list_stems()
        ]
        self._json(items)

    def _handle_get_annotation(self, stem):
        path = output_path(stem)
        if os.path.exists(path):
            with open(path) as f:
                self._json(json.load(f))
        else:
            self._json({"labels": [], "comments": []})

    def _handle_put_annotation(self, stem):
        length = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(length) or b"{}")
        os.makedirs(OUTPUTS_DIR, exist_ok=True)
        with open(output_path(stem), "w") as f:
            json.dump(data, f, indent=2)
        self._json({"ok": True})

    def _serve_video(self, stem, lowres):
        path = ensure_lowres(stem) if lowres else video_path(stem)
        if not os.path.exists(path):
            return self._error(404, f"video not found: {stem}")
        self._serve_file(path, "video/mp4")

    def _serve_frame(self, stem, t_seconds, max_dim=0):
        self._send_bytes(frame_jpeg_bytes(stem, t_seconds, max_dim), "image/jpeg")

    def _serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._error(404, f"not found: {path}")
        ext = os.path.splitext(full)[1]
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css", ".json": "application/json"}.get(ext, "application/octet-stream")
        self._serve_file(full, ctype)

    def log_message(self, fmt, *args):
        # Quieter default log; still visible, just one line.
        sys.stderr.write(f"[http] {self.address_string()} {fmt % args}\n")


# -- Fire entrypoints --------------------------------------------------------

def serve(videos_dir=DEFAULT_VIDEOS_DIR, port=8000, ffmpeg="ffmpeg"):
    """
    Command. Start the annotation server.

    Args:
        videos_dir: flat folder of source .mp4 files to annotate.
        port: TCP port to listen on.
        ffmpeg: ffmpeg executable (default: the one on PATH).
    """
    CONFIG["videos_dir"] = os.path.abspath(os.path.expanduser(videos_dir))
    CONFIG["ffmpeg"] = ffmpeg
    os.makedirs(OUTPUTS_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)
    print(f"Videos:  {CONFIG['videos_dir']}  ({len(list_stems())} clips)", file=sys.stderr)
    print(f"Cache:   {CACHE_DIR}", file=sys.stderr)
    print(f"Outputs: {OUTPUTS_DIR}", file=sys.stderr)
    print(f"Serving on http://localhost:{port}", file=sys.stderr)
    ThreadingHTTPServer(("", port), Handler).serve_forever()


def pre_compute_small_videos(videos_dir=DEFAULT_VIDEOS_DIR, ffmpeg="ffmpeg"):
    """
    Command. Build the low-res proxy for every video up front (optional — the
    server also builds them lazily on first request).
    """
    CONFIG["videos_dir"] = os.path.abspath(os.path.expanduser(videos_dir))
    CONFIG["ffmpeg"] = ffmpeg
    stems = list_stems()
    print(f"Pre-computing {len(stems)} low-res proxies …", file=sys.stderr)
    for i, stem in enumerate(stems, 1):
        try:
            path = ensure_lowres(stem)
            print(f"  [{i}/{len(stems)}] {stem} -> {os.path.getsize(path)//1024} KB", file=sys.stderr)
        except Exception as exc:
            # Log and keep going; one bad clip shouldn't abort the batch.
            print(f"  [{i}/{len(stems)}] {stem} FAILED: {exc}", file=sys.stderr)


def ports(start=3635):
    """
    Command. Print two free ports ("<app> <backend>") for start_server.sh, found
    via rp.get_next_free_ports so concurrent runs never collide.
    """
    import rp
    app_port, backend_port = rp.get_next_free_ports(start, 2)
    print(app_port, backend_port)


if __name__ == "__main__":
    fire.Fire({
        "serve": serve,
        "pre_compute_small_videos": pre_compute_small_videos,
        "ports": ports,
    })
