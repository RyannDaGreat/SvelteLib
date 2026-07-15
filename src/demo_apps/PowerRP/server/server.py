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
import sys
import traceback
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fire

# -- Paths & config ----------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)  # src/demo_apps/PowerRP
PROJECTS_DIR = os.path.join(APP_DIR, "projects")
WEB_DIR = os.path.join(APP_DIR, "web")

DOC_FILENAME = "doc.json"
ASSETS_SUBDIR = "assets"
# Filmstrip frame-extraction cache (out of scope here — the seam for a future
# agent: extracted frames go under assets/frames/ so the ZIP + asset listing can
# choose to include/exclude them without touching the storage layout).
FRAMES_SUBDIR = "frames"

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
      GET  /asset/<name>/<file>      → the asset file (Range-supported)
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
            if len(parts) == 3 and parts[0] == "asset":
                return self._serve_asset(parts[1], parts[2])
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

    def _serve_asset(self, name, filename):
        d = assets_dir(name)
        full = os.path.normpath(os.path.join(d, safe_name(filename)))
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
