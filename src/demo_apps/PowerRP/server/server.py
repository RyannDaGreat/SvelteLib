# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1"]
# ///
"""
PowerRP — project server.

Projects are FOLDERS (manifest Round 12: "Projects are now folders and the
server must take care of that"). Each project on disk is:

    projects/<name>/
        doc.json          the presentation document (the old .powerrp.json body)
        assets/           images, videos, SOUNDS — the SOURCE OF TRUTH for the
                          project's asset library (a manual file drop here is
                          picked up by the list-assets endpoint → refresh button)
        assets/frames/    (reserved) filmstrip frame-extraction cache — the
                          filmstrip endpoint (out of scope here) slots in here

A deliberately small server: stdlib http.server (no Flask), stdlib zipfile for
the Download-as-ZIP, and rp only for free-port discovery. All errors surface
LOUDLY to the client (JSON {error}) and the console (traceback) — no silent
fallbacks (manifest error-handling rule).

Storage root choice (the WHY): `projects/` lives BESIDE this server file, exactly
as the video_slice_annotator keeps `outputs/` + `cache/` beside its server.py.
That keeps a project store self-contained in the demo app, portable (the path is
relative to __file__, never absolute), and gitignored. See the dump's README /
.gitignore.

Run:
    uv run server.py serve --port=8000
    uv run server.py ports            # print two free ports for start_server.sh
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fire

# -- Paths & config ----------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)  # src/demo_apps/PowerRP
# Storage root: beside this file by default (the annotator's outputs/-beside-
# server.py precedent), overridable via POWERRP_PROJECTS_DIR so a test harness
# can point at a throwaway root without touching real projects (loud, explicit —
# not a silent behavior change; the default path is unchanged when unset).
PROJECTS_DIR = os.environ.get("POWERRP_PROJECTS_DIR") or os.path.join(APP_DIR, "projects")
WEB_DIR = os.path.join(APP_DIR, "web")

DOC_FILENAME = "doc.json"
ASSETS_SUBDIR = "assets"
# Filmstrip frame-extraction cache (the seam the server author reserved): the
# frames endpoint extracts N evenly-spread frames from a project VIDEO asset and
# caches them under assets/frames/<video>/<N>/frame_000.png … so a re-request for
# the same (video, N) is a pure cache hit (no re-extraction). list_assets skips
# subdirs (frames never pollute the asset library); the ZIP includes them.
FRAMES_SUBDIR = "frames"
# Zero-padding width for cached frame filenames (frame_000.png). 3 digits covers
# 1000 frames — a filmstrip control that exceeds that is nonsensical, and if it
# ever needs more this is the single knob. Filenames sort lexicographically ==
# numerically because of the padding, which the URL list relies on.
FRAME_INDEX_PAD = 3

# Content types for served assets (Range-supported binary serve covers all).
ASSET_CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
    ".json": "application/json",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov"}
SOUND_EXTS = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}

# A project/asset name component: no path separators, no traversal. Enforced on
# every write path so a crafted name can never escape PROJECTS_DIR.
_SAFE_NAME = re.compile(r"^[^/\\\x00]+$")


# -- Pure / query helpers ----------------------------------------------------

def safe_name(name):
    """
    Query. The name if it is a single safe path component, else raise.

    Rejects empty, ".", "..", and anything containing a path separator or NUL —
    so a name can never traverse out of PROJECTS_DIR.

    Examples:
        >>> safe_name("My Talk")
        'My Talk'
        >>> safe_name("../etc")           # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ValueError: ...
    """
    if name in (".", "..") or not _SAFE_NAME.match(name or ""):
        raise ValueError(f"unsafe name: {name!r}")
    return name


def project_dir(name):
    """Query. Absolute path of a project's folder (name validated)."""
    return os.path.join(PROJECTS_DIR, safe_name(name))


def doc_path(name):
    """Query. Absolute path of a project's doc.json."""
    return os.path.join(project_dir(name), DOC_FILENAME)


def assets_dir(name):
    """Query. Absolute path of a project's assets/ folder."""
    return os.path.join(project_dir(name), ASSETS_SUBDIR)


def frames_cache_dir(name, video, n):
    """
    Query. Absolute path of the frame-cache folder for (project, video, N):
    assets/frames/<video>/<N>/. `video` is validated as a single safe component
    (it is a filename, never a path); `n` is an int folder name.
    """
    return os.path.join(assets_dir(name), FRAMES_SUBDIR, safe_name(video), str(int(n)))


# -- Filmstrip frame extraction ----------------------------------------------
#
# Tool choice (the WHY, per the manifest "pick what works, justify" ruling):
# ffmpeg + ffprobe, NOT rp.load_video_via_rs. rp's loader decodes frames into
# numpy arrays in memory, which I would then have to RE-ENCODE to PNG — an extra
# encode pass and full-frame RAM. ffmpeg's `select` filter pulls exactly the N
# wanted frame indices straight to PNG files on disk in ONE pass (the cache
# format IS the output format), and ffprobe gives an exact, codec-independent
# frame count. Both are on PATH (setup.sh candidate — flagged in the report).
# rp.load_video_via_rs remains the fallback if a codec ever defeats the system
# ffmpeg; it is not needed for the deterministic-fixture path this ships with.

def evenly_spread_indices(total, n):
    """
    Pure function. N frame indices evenly spread first->last over `total`
    frames. First index is always 0; the last is total-1 (for n>=2). n==1 -> the
    first frame only. Caller clamps n to total so the result has no duplicates.

    Args:
        total (int): total frames in the video (>=1)
        n (int): number of frames to sample (>=1, already clamped to <= total)

    Returns:
        list[int]: n ascending frame indices, first=0 and last=total-1

    Examples:
        >>> evenly_spread_indices(10, 4)
        [0, 3, 6, 9]
        >>> evenly_spread_indices(10, 1)
        [0]
        >>> evenly_spread_indices(10, 2)
        [0, 9]
        >>> evenly_spread_indices(5, 5)
        [0, 1, 2, 3, 4]
        >>> evenly_spread_indices(100, 5)
        [0, 25, 50, 74, 99]
    """
    if n <= 1:
        return [0]
    return [round(i * (total - 1) / (n - 1)) for i in range(n)]


def video_frame_count(video_path):
    """
    Query (reads the file via ffprobe). Total decodable frames in a video.
    Raises loudly if ffprobe is missing or the file is not a decodable video.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-count_frames", "-show_entries", "stream=nb_read_frames",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except FileNotFoundError:
        raise RuntimeError("ffprobe not found on PATH — install ffmpeg (brew install ffmpeg)")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffprobe failed on {os.path.basename(video_path)}: {exc.stderr.strip()}")
    if not out.isdigit() or int(out) <= 0:
        raise RuntimeError(f"no video frames found in {os.path.basename(video_path)} (ffprobe: {out!r})")
    return int(out)


def _extract_indices(video_path, indices, out_dir):
    """
    Command. Extract the given frame INDICES from a video to
    out_dir/frame_000.png … in the SAME order as `indices` (ascending). Uses one
    ffmpeg `select` pass (validated: outputs sequential files in select order).
    Mutates the filesystem; raises loudly on ffmpeg failure.
    """
    os.makedirs(out_dir, exist_ok=True)
    # select='eq(n,i0)+eq(n,i1)+...' keeps exactly those frames; -vsync 0 (a.k.a.
    # -fps_mode passthrough) prevents duplication so N frames -> N files.
    select = "+".join(f"eq(n\\,{i})" for i in indices)
    tmpl = os.path.join(out_dir, "frame_%0{}d.png".format(FRAME_INDEX_PAD))
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vf", f"select='{select}'",
             "-vsync", "0", tmpl],
            capture_output=True, text=True, check=True,
        )
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found on PATH — install ffmpeg (brew install ffmpeg)")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffmpeg frame extraction failed: {exc.stderr.strip()[-500:]}")


def _frame_urls(name, video, n):
    """
    Query. The served URLs for the cached frames of (project, video, N), in
    order. ffmpeg writes 1-based frame_001.png … frame_00N.png; the URL path
    goes through the /asset seam under assets/frames/<video>/<N>/.
    """
    q = urllib.parse.quote
    sub = f"{FRAMES_SUBDIR}/{video}/{int(n)}"
    return [
        f"/asset/{q(name)}/{q(sub, safe='/')}/frame_{i + 1:0{FRAME_INDEX_PAD}d}.png"
        for i in range(n)
    ]


def extract_frames(name, video, n):
    """
    Command (idempotent — cache-first). Ensure N evenly-spread frames of a
    project video are cached under assets/frames/<video>/<N>/, and return
    {count, frames: [url,...]}. A cache HIT (the folder already holds exactly N
    PNGs) does NO re-extraction. Raises loudly for a bad N, a missing video, or
    an ffmpeg/ffprobe failure. Mutates the filesystem on a cache miss.

    Args:
        name (str): project name
        video (str): a video asset filename inside the project's assets/ folder
        n (int): number of frames (1..1000)
    """
    if n < 1 or n > 1000:
        raise ValueError(f"frame count out of range (1..1000): {n}")
    video_file = os.path.join(assets_dir(name), safe_name(video))
    if not os.path.isfile(video_file):
        raise FileNotFoundError(f"video asset not found: {name}/{video}")

    cache = frames_cache_dir(name, video, n)
    cached = sorted(f for f in os.listdir(cache)) if os.path.isdir(cache) else []
    if len(cached) == n:  # cache hit — every frame present, no re-extraction
        return {"count": n, "frames": _frame_urls(name, video, n)}

    # Cache miss (or partial/corrupt cache): rebuild from scratch so a crashed
    # prior run never yields a short strip. total>=1 guaranteed by ffprobe check.
    if os.path.isdir(cache):
        shutil.rmtree(cache)
    total = video_frame_count(video_file)
    n_eff = min(n, total)  # a video shorter than N frames yields total frames
    indices = evenly_spread_indices(total, n_eff)
    _extract_indices(video_file, indices, cache)
    produced = sorted(f for f in os.listdir(cache) if f.endswith(".png"))
    if len(produced) != n_eff:
        raise RuntimeError(
            f"frame extraction produced {len(produced)} files, expected {n_eff} "
            f"(video {video}, total {total} frames)")
    return {"count": len(produced), "frames": _frame_urls(name, video, len(produced))}


def asset_kind(filename):
    """
    Pure function. Classify an asset filename by extension.

    Examples:
        >>> asset_kind("logo.PNG")
        'image'
        >>> asset_kind("clip.mp4")
        'video'
        >>> asset_kind("ding.wav")
        'sound'
        >>> asset_kind("notes.txt")
        'other'
    """
    ext = os.path.splitext(filename)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in SOUND_EXTS:
        return "sound"
    return "other"


def content_type_for(path):
    """Query. HTTP Content-Type for an asset path (octet-stream fallback)."""
    ext = os.path.splitext(path)[1].lower()
    return ASSET_CONTENT_TYPES.get(ext, "application/octet-stream")


def list_projects():
    """
    Query. Every project folder under PROJECTS_DIR, newest-modified first.
    Each: {name, mtime, slideCount}. slideCount is None if doc.json is
    missing/unreadable (a folder created by a manual mkdir is still listed).
    """
    if not os.path.isdir(PROJECTS_DIR):
        return []
    out = []
    for name in os.listdir(PROJECTS_DIR):
        d = os.path.join(PROJECTS_DIR, name)
        if not os.path.isdir(d):
            continue
        out.append({"name": name, "mtime": os.path.getmtime(d),
                    "slideCount": _slide_count(os.path.join(d, DOC_FILENAME))})
    out.sort(key=lambda p: p["mtime"], reverse=True)
    return out


def _slide_count(doc_json_path):
    """Query. Number of slides in a doc.json, or None if unreadable."""
    try:
        with open(doc_json_path) as f:
            doc = json.load(f)
        return len(doc["slides"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def list_assets(name):
    """
    Query. Files directly in a project's assets/ folder (NOT recursive — the
    frames/ cache subfolder is skipped). Each: {name, size, kind, url}. The
    assets/ folder IS the source of truth, so this reflects manual drops too
    (manifest Round 12B: "manually dropping a file into the folder must appear
    in the library — a refresh button is acceptable").
    """
    d = assets_dir(name)
    if not os.path.isdir(d):
        return []
    out = []
    for fn in sorted(os.listdir(d)):
        full = os.path.join(d, fn)
        if not os.path.isfile(full):
            continue  # skip frames/ and any other subdir
        out.append({
            "name": fn,
            "size": os.path.getsize(full),
            "kind": asset_kind(fn),
            "url": f"/asset/{urllib.parse.quote(name)}/{urllib.parse.quote(fn)}",
        })
    return out


# -- Commands (side effects: write files) ------------------------------------

def save_project(name, doc):
    """
    Command. Write doc.json into the project folder, creating the folder (and
    its assets/) if new. `doc` is the already-parsed document object. Returns
    the project name. Mutates the filesystem.
    """
    d = project_dir(name)
    os.makedirs(os.path.join(d, ASSETS_SUBDIR), exist_ok=True)
    # Atomic write: tmp then replace, so a crash mid-write never leaves a
    # truncated doc.json (a project's document is the irreplaceable work).
    tmp = doc_path(name) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2)
    os.replace(tmp, doc_path(name))
    return name


def unique_asset_name(name, filename):
    """
    Query. A filename that does not collide in the project's assets/ folder.
    "a.png" → "a.png" if free, else "a-2.png", "a-3.png", … (never overwrites a
    manually-placed asset). Returns just the basename.
    """
    base = os.path.basename(safe_name(filename))
    stem, ext = os.path.splitext(base)
    d = assets_dir(name)
    candidate = base
    n = 2
    while os.path.exists(os.path.join(d, candidate)):
        candidate = f"{stem}-{n}{ext}"
        n += 1
    return candidate


def save_asset(name, filename, data):
    """
    Command. Write bytes into the project's assets/ folder under a
    non-colliding name; return that final basename. Mutates the filesystem.
    """
    d = assets_dir(name)
    os.makedirs(d, exist_ok=True)
    final = unique_asset_name(name, filename)
    with open(os.path.join(d, final), "wb") as f:
        f.write(data)
    return final


def zip_project_bytes(name):
    """
    Query (reads the filesystem, no mutation). ZIP archive bytes of the WHOLE
    project folder (doc.json + every asset, frames cache included), entries
    rooted at "<name>/…" so unzipping recreates the folder. This is the
    user-facing Download format (manifest: "these will just be .zip files").
    """
    d = project_dir(name)
    if not os.path.isdir(d):
        raise FileNotFoundError(f"project not found: {name}")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(d):
            for fn in files:
                full = os.path.join(root, fn)
                if full.endswith(".tmp"):
                    continue  # never ship an in-flight atomic-write temp
                arcname = os.path.join(name, os.path.relpath(full, d))
                zf.write(full, arcname)
    return buf.getvalue()


# -- HTTP handler ------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """
    Routes (every /api prefix keeps a TRAILING SLASH so the Vite proxy never
    swallows the app's own /api*.js modules — see vite.config.js):

      GET  /api/projects/            → [{name, mtime, slideCount}]
      GET  /api/project/<name>/      → {doc, assets}
      PUT  /api/project/<name>/      → body = doc JSON; {ok, name}
      GET  /api/assets/<name>/       → [{name, size, kind, url}]
      POST /api/upload/<name>/?filename=…  → raw body bytes; {ok, name: file}
      GET  /api/download/<name>/     → application/zip of the whole folder
      GET  /api/frames/<name>/<video>/<N>/  → {count, frames:[url,…]}
                                     (extract N evenly-spread frames, cached)
      GET  /asset/<name>/<file…>     → the asset file (Range-supported; a file
                                       may be a frames/<video>/<N>/… subpath)
    """

    server_version = "PowerRPProjectServer/0.1"

    # -- low-level response helpers --

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
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
        """Serve a file with HTTP Range support (needed for video/audio seek)."""
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end, status = 0, size - 1, 200
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
                    return  # client seeked away / closed — normal for media
                remaining -= len(chunk)

    # -- routing --

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _parts(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = [urllib.parse.unquote(p) for p in parsed.path.split("/") if p]
        return parsed, parts

    def do_GET(self):
        parsed, parts = self._parts()
        try:
            if parts == ["api", "projects"]:
                return self._json(list_projects())
            if len(parts) == 3 and parts[:2] == ["api", "project"]:
                return self._handle_load(parts[2])
            if len(parts) == 3 and parts[:2] == ["api", "assets"]:
                return self._json(list_assets(parts[2]))
            if len(parts) == 3 and parts[:2] == ["api", "download"]:
                return self._handle_download(parts[2])
            if len(parts) == 5 and parts[:2] == ["api", "frames"]:
                return self._handle_frames(parts[2], parts[3], parts[4])
            if len(parts) >= 3 and parts[0] == "asset":
                # parts[1] = project, parts[2:] = a file path inside assets/
                # (a plain file, or a frames/<video>/<N>/frame_NNN.png subpath).
                return self._serve_asset(parts[1], "/".join(parts[2:]))
            # Not an API route: the app is the Vite dev server. Bounce stray
            # visitors to it if APP_URL is known (start_server.sh sets it).
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
            self.wfile.write(b"<h2>PowerRP project server</h2>"
                             b"<p>Open the app (the Vite dev server URL from start_server.sh).</p>")
        except Exception as exc:  # report loudly, never crash the server
            traceback.print_exc()
            self._error(500, f"{type(exc).__name__}: {exc}")

    def do_PUT(self):
        parsed, parts = self._parts()
        try:
            if len(parts) == 3 and parts[:2] == ["api", "project"]:
                return self._handle_save(parts[2])
            self._error(404, f"no PUT route for {parsed.path}")
        except Exception as exc:
            traceback.print_exc()
            self._error(500, f"{type(exc).__name__}: {exc}")

    def do_POST(self):
        parsed, parts = self._parts()
        try:
            if len(parts) == 3 and parts[:2] == ["api", "upload"]:
                return self._handle_upload(parts[2], parsed)
            self._error(404, f"no POST route for {parsed.path}")
        except Exception as exc:
            traceback.print_exc()
            self._error(500, f"{type(exc).__name__}: {exc}")

    # -- route handlers --

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _handle_load(self, name):
        path = doc_path(name)
        if not os.path.exists(path):
            return self._error(404, f"project not found: {name}")
        with open(path) as f:
            doc = json.load(f)
        self._json({"doc": doc, "assets": list_assets(name)})

    def _handle_save(self, name):
        doc = json.loads(self._read_body() or b"{}")
        save_project(name, doc)
        self._json({"ok": True, "name": name})

    def _handle_upload(self, name, parsed):
        # Raw-body upload: the filename rides in ?filename= (the client sends
        # the file bytes directly — no multipart parsing needed). See
        # projectApi.uploadAsset.
        q = urllib.parse.parse_qs(parsed.query)
        filename = q.get("filename", [""])[0]
        if not filename:
            return self._error(400, "upload requires ?filename=")
        data = self._read_body()
        if not data:
            return self._error(400, "empty upload body")
        final = save_asset(name, filename, data)
        self._json({"ok": True, "name": final,
                    "url": f"/asset/{urllib.parse.quote(name)}/{urllib.parse.quote(final)}"})

    def _handle_download(self, name):
        data = zip_project_bytes(name)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{name}.zip"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_frames(self, name, video, n_str):
        # Filmstrip: N evenly-spread frames of a project video, cached under
        # assets/frames/<video>/<N>/ (cache hit = no re-extraction). Errors
        # (bad N, missing video, ffmpeg/ffprobe failure) surface loudly.
        try:
            n = int(n_str)
        except ValueError:
            return self._error(400, f"frame count must be an integer: {n_str!r}")
        self._json(extract_frames(name, video, n))

    def _serve_asset(self, name, filename):
        # `filename` may be a plain asset OR a frames/<video>/<N>/frame_NNN.png
        # subpath. `d` is the project's assets/ root; NUL is rejected, and the
        # normpath + startswith(d + os.sep) guard defeats any ".." traversal
        # (a path that resolves outside assets/ fails the containment check).
        if "\x00" in filename:
            return self._error(400, f"bad asset path: {name}/{filename}")
        d = assets_dir(name)
        full = os.path.normpath(os.path.join(d, filename))
        if not full.startswith(d + os.sep) or not os.path.isfile(full):
            return self._error(404, f"asset not found: {name}/{filename}")
        self._serve_file(full, content_type_for(full))

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[http] {self.address_string()} {fmt % args}\n")


# -- Fire entrypoints --------------------------------------------------------

def serve(port=8000):
    """
    Command. Start the project server on `port`. Projects live under
    ./projects (beside this file). Errors are reported, never swallowed.
    """
    os.makedirs(PROJECTS_DIR, exist_ok=True)
    print(f"Projects: {PROJECTS_DIR}  ({len(list_projects())} projects)", file=sys.stderr)
    print(f"Serving on http://localhost:{port}", file=sys.stderr)
    ThreadingHTTPServer(("", port), Handler).serve_forever()


def ports(start=3637):
    """
    Command. Print two free ports ("<app> <backend>") for start_server.sh,
    via rp.get_next_free_ports so concurrent runs never collide. (3637 is
    PowerRP's editor port; the annotator uses 3635.)
    """
    import rp
    app_port, backend_port = rp.get_next_free_ports(start, 2)
    print(app_port, backend_port)


if __name__ == "__main__":
    fire.Fire({"serve": serve, "ports": ports})
