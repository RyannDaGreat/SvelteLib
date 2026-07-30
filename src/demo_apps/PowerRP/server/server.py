# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1", "numpy>=1.26"]
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

import http.cookies
import io
import ipaddress
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fire

# -- Paths & config ----------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)  # src/demo_apps/PowerRP
# The SvelteLib checkout root (where package.json + node_modules live). Derived
# from this file so the dump stays portable. The render worker must be spawned
# from here: it starts a Vite dev server and resolves vite/puppeteer/svelte from
# these node_modules, exactly as the editor's own launcher does.
REPO_ROOT = os.path.normpath(os.path.join(APP_DIR, "..", "..", ".."))
# Storage root: beside this file by default (the annotator's outputs/-beside-
# server.py precedent), overridable via POWERRP_PROJECTS_DIR so a test harness
# can point at a throwaway root without touching real projects (loud, explicit —
# not a silent behavior change; the default path is unchanged when unset).
PROJECTS_DIR = os.environ.get("POWERRP_PROJECTS_DIR") or os.path.join(APP_DIR, "projects")
WEB_DIR = os.path.join(APP_DIR, "web")

DOC_FILENAME = "doc.json"
ASSETS_SUBDIR = "assets"
# The ONE prefix an ABSOLUTE in-document asset reference starts with — the twin of
# core/asset_ref.js ASSET_REF_PREFIX. Named here because the server both MINTS these
# strings (list_assets' "url") and PARSES them (parse_asset_ref, for the
# self-contained export), and the two must never be spelled differently.
#
# THE GRAMMAR HAS TWO FORMS and this constant is only about one of them. A document
# `src` may be RELATIVE ("clip.mp4" — a file of whatever project owns the document)
# or ABSOLUTE ("/asset/<project>/<file>" — a file of a specifically named project).
# The SERVER only ever deals with the absolute form: it is what list_assets mints,
# and it is the only form document_asset_refs recognizes. Resolution of the relative
# form happens entirely CLIENT-SIDE, at core/derive.js, against the project the
# document belongs to — the server never needs to, because every asset request that
# reaches it already names its project in the path. Relative refs are what WRITERS
# now store and what localization_plan emits, precisely so that a project rename or
# a de-collided import cannot invalidate them.
ASSET_REF_PREFIX = "/asset/"
# Filmstrip frame-extraction cache (the seam the server author reserved): the
# frames endpoint extracts N evenly-spread frames from a project VIDEO asset and
# caches them under assets/frames/<video>/<N>/frame_000.png … so a re-request for
# the same (video, N) is a pure cache hit (no re-extraction). list_assets skips
# subdirs (frames never pollute the asset library); the ZIP includes them.
FRAMES_SUBDIR = "frames"
# Asset THUMBNAIL cache (manifest #25): a small cached preview bitmap + a corner
# badge for assets that need one rendered (PDF first-page raster + page count).
# Lives under assets/.thumbs/<file>/ (a subdir, so list_assets skips it — never an
# asset itself; the ZIP includes it). Keyed by the source asset's mtime so a
# replaced file regenerates (stale thumbs are ignored, then overwritten on store).
# The bitmap itself is rasterized CLIENT-SIDE (the server has no PDF engine) and
# POSTed back here to persist; list_assets attaches a fresh cached thumb inline.
THUMBS_SUBDIR = ".thumbs"
THUMB_META_FILENAME = "meta.json"
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
    ".pdf": "application/pdf",
    ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
    ".json": "application/json",
    # TABULAR DATA a widget plots. The charset is explicit because the text-asset
    # registry reads these with response.text(), which honours it -- without one a
    # UTF-8 label ("Montréal") would decode as latin-1 mojibake in the chart.
    ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
    # A PLUGIN ASSET (*.plugin.js) is served as PLAIN TEXT, deliberately, not as
    # text/javascript. The client reads it with .text() and evaluates it inside the
    # plugin sandbox (core/plugin_assets.js); nothing ever loads it as a script.
    # Declaring it text/plain means a browser that somehow navigated straight to
    # the URL would DISPLAY the source rather than run it on this origin.
    ".js": "text/plain; charset=utf-8",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov"}
SOUND_EXTS = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}
PDF_EXTS = {".pdf"}
# Uploadable FONT assets (manifest #26 "fonts as an asset"): a user-supplied
# font file becomes a project asset of kind "font" and is registered as a
# selectable family client-side (render_gpu/fonts.js dynamic registry).
FONT_EXTS = {".ttf", ".otf", ".woff", ".woff2"}
# TEXTUAL DATA assets: a table a widget PLOTS rather than a file it displays
# (core/plugin_assets.js assetText -> render_gpu/gpu/text_asset_registry.js).
# Classified as its own kind so an AssetField declaring assetKinds ["data"] can
# offer exactly the spreadsheets in a project and nothing else -- as kind "other"
# a CSV was invisible to every picker, which is why a chart widget could not name
# its own data file. ".txt" is deliberately excluded: a notes file is not a table,
# and offering one in a chart's picker is a worse error than omitting it.
DATA_EXTS = {".csv", ".tsv", ".json"}
# PLUGIN ASSETS: a widget delivered as a project asset rather than a source file
# (core/plugin_assets.js). The marker is the COMPOUND suffix ".plugin.js", not the
# ".js" extension -- a plain ".js" asset stays kind "other", so dropping a script
# into a project cannot accidentally make it a widget. Classified server-side only
# so the Asset Explorer can show these tiles distinctly; the CLIENT decides what to
# register, and does so through its own suffix check (isPluginAssetName), which is
# the one that must agree with this string.
PLUGIN_ASSET_SUFFIX = ".plugin.js"

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


def res_segment(frame_h, frame_w):
    """
    Pure function. The cache-folder RESOLUTION segment for a per-frame extraction
    size (manifest 14.1 frameH/frameW). Native (both None/0) → "" (no segment, so
    a native-size cache is byte-compatible with the pre-14.1 layout). A set size →
    "<w>x<h>" with "native" for an unset axis (ffmpeg's -1 keeps aspect for that
    axis). The value is a single safe path component (digits + 'x' + 'native').

    Examples:
        >>> res_segment(None, None)
        ''
        >>> res_segment(240, None)
        'nativex240'
        >>> res_segment(240, 320)
        '320x240'
        >>> res_segment(0, 0)
        ''
    """
    h = int(frame_h) if frame_h else 0
    w = int(frame_w) if frame_w else 0
    if not h and not w:
        return ""
    return f"{w or 'native'}x{h or 'native'}"


def frames_cache_dir(name, video, n, frame_h=None, frame_w=None):
    """
    Query. Absolute path of the frame-cache folder for (project, video, N) at an
    optional per-frame resolution: assets/frames/<video>/<N>/[<WxH>/]. `video` is
    validated as a single safe component (it is a filename, never a path); `n` is
    an int folder name; a non-native (frame_h/frame_w) request adds a resolution
    subfolder so a resolution change re-extracts into its own cache (a native
    request keeps the original two-level layout, unchanged).
    """
    base = os.path.join(assets_dir(name), FRAMES_SUBDIR, safe_name(video), str(int(n)))
    seg = res_segment(frame_h, frame_w)
    return os.path.join(base, seg) if seg else base


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
            capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL,
        ).stdout.strip()
    except FileNotFoundError:
        raise RuntimeError("ffprobe not found on PATH — install ffmpeg (brew install ffmpeg)")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffprobe failed on {os.path.basename(video_path)}: {exc.stderr.strip()}")
    if not out.isdigit() or int(out) <= 0:
        raise RuntimeError(f"no video frames found in {os.path.basename(video_path)} (ffprobe: {out!r})")
    return int(out)


def video_duration_seconds(video_path):
    """
    Query (reads the file via ffprobe). The video's intrinsic duration in SECONDS
    (float), read from the container's `format=duration` — a codec-reported
    property of the FILE, not of any decoder, so it is deterministic and stable
    across machines/browsers (the `self.length` behind PowerRP's time-driven
    scrubber presets, e.g. `time % self.length`). Unlike video_frame_count this
    does NOT pass -count_frames, so it does not decode a single frame — it reads
    the container header only, so it is O(1) and cheap enough to run per-asset in
    list_assets. Raises loudly if ffprobe is missing or the file has no duration.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL,
        ).stdout.strip()
    except FileNotFoundError:
        raise RuntimeError("ffprobe not found on PATH — install ffmpeg (brew install ffmpeg)")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffprobe failed on {os.path.basename(video_path)}: {exc.stderr.strip()}")
    try:
        seconds = float(out)
    except ValueError:
        raise RuntimeError(f"no duration reported for {os.path.basename(video_path)} (ffprobe: {out!r})")
    if not (seconds > 0):
        raise RuntimeError(f"non-positive duration for {os.path.basename(video_path)} (ffprobe: {out!r})")
    return seconds


def _extract_indices(video_path, indices, out_dir, frame_h=None, frame_w=None):
    """
    Command. Extract the given frame INDICES from a video to
    out_dir/frame_000.png … in the SAME order as `indices` (ascending), optionally
    RESIZED to (frame_w × frame_h) pixels (manifest 14.1). Uses one ffmpeg
    `select` pass (validated: outputs sequential files in select order). A set
    resolution appends a `scale` filter; an unset axis is -1 (keep aspect,
    rounded to an even number ffmpeg's PNG encoder accepts). Mutates the
    filesystem; raises loudly on ffmpeg failure.
    """
    os.makedirs(out_dir, exist_ok=True)
    # select='eq(n,i0)+eq(n,i1)+...' keeps exactly those frames; -vsync 0 (a.k.a.
    # -fps_mode passthrough) prevents duplication so N frames -> N files.
    terms = "+".join("eq(n\\,{})".format(i) for i in indices)
    select = "select='{}'".format(terms)
    h = int(frame_h) if frame_h else 0
    w = int(frame_w) if frame_w else 0
    vf = select if not (h or w) else f"{select},scale={w or -2}:{h or -2}"
    tmpl = os.path.join(out_dir, "frame_%0{}d.png".format(FRAME_INDEX_PAD))
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vf", vf,
             "-vsync", "0", tmpl],
            capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found on PATH — install ffmpeg (brew install ffmpeg)")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffmpeg frame extraction failed: {exc.stderr.strip()[-500:]}")


def _frame_urls(name, video, dir_n, count, frame_h=None, frame_w=None):
    """
    Query. The served URLs for the cached frames of (project, video, N) at an
    optional per-frame resolution, in order. ffmpeg writes 1-based
    frame_001.png … frame_00N.png; the URL path goes through the /asset seam
    under assets/frames/<video>/<N>/[<WxH>/].

    `dir_n` is the REQUESTED frame count (the cache FOLDER name — always the
    request's N so a repeat request is a cache hit); `count` is how many frames
    actually exist there (== dir_n normally, fewer for a video shorter than N
    frames). A non-native resolution adds the same <WxH> segment the cache dir
    uses (res_segment), so the URLs point at the resolution-specific cache.
    """
    q = urllib.parse.quote
    seg = res_segment(frame_h, frame_w)
    sub = f"{FRAMES_SUBDIR}/{video}/{int(dir_n)}" + (f"/{seg}" if seg else "")
    return [
        f"/asset/{q(name)}/{q(sub, safe='/')}/frame_{i + 1:0{FRAME_INDEX_PAD}d}.png"
        for i in range(count)
    ]


def _cached_pngs(cache):
    """Query. Sorted PNG filenames directly in `cache` (skips subdirs, e.g. a
    native cache's resolution subfolders), or [] if the folder is absent."""
    return sorted(f for f in os.listdir(cache) if f.endswith(".png")) if os.path.isdir(cache) else []


def extract_frames(name, video, n, frame_h=None, frame_w=None):
    """
    Command (idempotent — cache-first). Ensure N evenly-spread frames of a
    project video at an optional per-frame resolution (frame_h/frame_w, manifest
    14.1) are cached under assets/frames/<video>/<N>/[<WxH>/], and return
    {count, frames: [url,...]}. A cache HIT (the folder already holds exactly N
    PNGs) does NO re-extraction. Native (both None) keeps the original two-level
    cache; a set resolution caches independently so switching resolution
    re-extracts. Raises loudly for a bad N, a missing video, or an ffmpeg/ffprobe
    failure. Mutates the filesystem on a cache miss.

    Args:
        name (str): project name
        video (str): a video asset filename inside the project's assets/ folder
        n (int): number of frames (1..1000)
        frame_h, frame_w (int|None): per-frame pixel size; None/0 = native
    """
    if n < 1 or n > 1000:
        raise ValueError(f"frame count out of range (1..1000): {n}")
    video_file = os.path.join(assets_dir(name), safe_name(video))
    if not os.path.isfile(video_file):
        raise FileNotFoundError(f"video asset not found: {name}/{video}")

    cache = frames_cache_dir(name, video, n, frame_h, frame_w)
    urls = lambda count: _frame_urls(name, video, n, count, frame_h, frame_w)
    cached = _cached_pngs(cache)
    if len(cached) == n:  # full cache hit — no ffprobe, no re-extraction
        return {"count": n, "frames": urls(n)}

    # The cache folder is keyed by the REQUESTED n; a video with fewer than n
    # frames legitimately holds total-frames files there. ffprobe tells us
    # which case a not-exactly-n cache is (short-video hit vs corrupt/partial).
    total = video_frame_count(video_file)
    n_eff = min(n, total)  # a video shorter than N frames yields total frames
    if cached and len(cached) == n_eff:  # short-video cache hit — complete
        return {"count": n_eff, "frames": urls(n_eff)}

    # Cache miss (or partial/corrupt cache): rebuild from scratch so a crashed
    # prior run never yields a short strip. total>=1 guaranteed by ffprobe check.
    if os.path.isdir(cache):
        shutil.rmtree(cache)
    indices = evenly_spread_indices(total, n_eff)
    _extract_indices(video_file, indices, cache, frame_h, frame_w)
    produced = _cached_pngs(cache)
    if len(produced) != n_eff:
        raise RuntimeError(
            f"frame extraction produced {len(produced)} files, expected {n_eff} "
            f"(video {video}, total {total} frames)")
    return {"count": n_eff, "frames": urls(n_eff)}


# -- Server-side MP4 export (client renders frames -> server encodes) ---------
#
# WHY this is server-side (the CORE reason): the browser renders every frame of
# the presentation DETERMINISTICALLY (web/videoExport.js) but cannot ENCODE an
# MP4 without the WebCodecs VideoEncoder API, which browsers expose ONLY in a
# secure context (HTTPS / http://localhost). PowerRP runs on plain HTTP on a LAN
# IP, so VideoEncoder is undefined there and in-browser MP4 export is impossible.
# The fix: the client POSTs its rendered PNG frames here and the server encodes
# them with libx264 via ffmpeg -- no secure context needed, works over plain HTTP
# everywhere. This mirrors the frame-EXTRACTION ffmpeg idiom above (the same loud
# "ffmpeg not found on PATH" + CalledProcessError-with-stderr error pattern).
#
# Per-export scratch is EPHEMERAL, so it lives under the OS temp dir (NOT a
# project folder): one sub-folder per export SESSION (a server-minted uuid),
# holding frame_000000.png ... and the produced out.mp4, all deleted the moment
# the encode finishes (success OR failure).
EXPORT_SESSIONS_DIR = os.path.join(tempfile.gettempdir(), "powerrp_mp4_export")
EXPORT_OUTPUT_FILENAME = "out.mp4"
# Zero-padding for uploaded frame filenames (frame_000000.png). 6 digits covers
# 1_000_000 frames -- far beyond any sane presentation export -- and makes the
# names sort lexicographically == numerically, which the ffmpeg %06d input
# pattern relies on. The single knob if a longer export is ever needed.
EXPORT_FRAME_PAD = 6
# libx264 CRF (Constant Rate Factor) valid range: 0 = lossless (huge), 51 =
# worst. The client sends a CRF in this range (ExportMp4Modal quality->CRF); the
# server validates it defensively and rejects anything outside loudly.
H264_CRF_MIN = 0
H264_CRF_MAX = 51


def export_session_dir(session_id):
    """
    Query. Absolute path of ONE export session's scratch folder under
    EXPORT_SESSIONS_DIR. The id is validated as a single safe component AND
    containment-checked (normpath startswith), so a crafted id can never escape
    the base. Does not create the folder -- begin_export_session does.
    """
    safe = safe_name(session_id)
    full = os.path.normpath(os.path.join(EXPORT_SESSIONS_DIR, safe))
    if not full.startswith(EXPORT_SESSIONS_DIR + os.sep):
        raise ValueError(f"unsafe export session id: {session_id!r}")
    return full


def begin_export_session():
    """
    Command (mutates the filesystem). Mint a fresh export session: create its
    scratch folder under EXPORT_SESSIONS_DIR and return the new session id (a
    uuid4 hex -- a single safe path component). The SERVER mints the id, not the
    client, so the client needs no secure-context-only crypto (crypto.randomUUID
    is unavailable on plain HTTP). The client then POSTs frames + an encode
    request keyed by this id.
    """
    session_id = uuid.uuid4().hex
    os.makedirs(export_session_dir(session_id), exist_ok=True)
    return session_id


def export_frame_path(session_id, index):
    """
    Query. Absolute path of frame `index` (0-based) in an export session:
    <session>/frame_<index:06d>.png. Raises for a negative index or an unknown
    session (the session dir must already exist -- begin_export_session made it).
    """
    if index < 0:
        raise ValueError(f"frame index must be >= 0: {index}")
    d = export_session_dir(session_id)
    if not os.path.isdir(d):
        raise FileNotFoundError(f"unknown export session: {session_id}")
    return os.path.join(d, f"frame_{index:0{EXPORT_FRAME_PAD}d}.png")


def save_export_frame(session_id, index, data):
    """
    Command (mutates the filesystem). Write one PNG frame (raw bytes `data`) as
    frame `index` of an export session. Overwrites a re-POSTed index (an
    idempotent retry). Raises loudly for an unknown session or a bad index.
    """
    with open(export_frame_path(session_id, index), "wb") as f:
        f.write(data)


def encode_export_mp4(session_id, fps, crf):
    """
    Command (reads the session's PNG frames, runs ffmpeg, then DELETES the
    session scratch). Encode the session's frame_000000.png ... sequence into an
    H.264 MP4 with libx264 at `fps` and Constant Rate Factor `crf`, and return
    the .mp4 bytes. yuv420p + even dimensions (a scale guard) make the file play
    universally; +faststart moves the moov atom to the front so the file is
    instantly seekable/streamable (the old in-browser muxer's fastStart intent).

    The session scratch dir is removed in a finally -- on success AND after a
    failure's error is captured -- so a failed export never leaks temp frames.
    Raises loudly if ffmpeg is missing, no frames were uploaded, or ffmpeg fails.

    Args:
        session_id (str): the session minted by begin_export_session
        fps (float): output frames per second (> 0)
        crf (int): libx264 CRF in [H264_CRF_MIN, H264_CRF_MAX] (lower = better)

    Returns:
        bytes: the encoded video/mp4 file
    """
    d = export_session_dir(session_id)
    if not os.path.isdir(d):
        raise FileNotFoundError(f"unknown export session: {session_id}")
    try:
        frames = [f for f in os.listdir(d) if f.startswith("frame_") and f.endswith(".png")]
        if not frames:
            raise RuntimeError(f"export session {session_id} has no frames to encode")
        out_path = os.path.join(d, EXPORT_OUTPUT_FILENAME)
        pattern = os.path.join(d, f"frame_%0{EXPORT_FRAME_PAD}d.png")
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-framerate", str(fps), "-start_number", "0",
                 "-i", pattern,
                 "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p",
                 "-crf", str(crf), "-movflags", "+faststart",
                 "-loglevel", "error", out_path],
                capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            raise RuntimeError("ffmpeg not found on PATH -- install ffmpeg (brew install ffmpeg)")
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"ffmpeg MP4 encode failed: {exc.stderr.strip()[-500:]}")
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        # Ephemeral scratch: always cleaned. ignore_errors so a stray unlink can
        # never mask (replace) the real ffmpeg error propagating out of the try.
        shutil.rmtree(d, ignore_errors=True)


# -- Detached RENDER JOBS (survive the browser) -------------------------------
#
# THE PROBLEM THIS SOLVES. The export above makes the BROWSER the renderer: it
# walks frames on the client GPU and POSTs each PNG. So closing the dialog,
# refreshing, or an editor hot-reload destroyed an in-flight export with no way
# to get it back -- a five-hour render lost to a stray reload. A render must
# instead be a JOB the server owns: the browser submits and then has no further
# role, and progress is SERVER state, so any tab (or a tab opened tomorrow) can
# ask how far along it is.
#
# ONE JOB SHAPE, TWO FRAME PRODUCERS. The ENCODE was already server-side in both
# designs (ffmpeg; WebCodecs needs a secure context, which plain HTTP cannot
# give). The only thing that ever differed is WHO fills the frame directory, so
# `backend` is a FIELD on one job record, not a second system:
#   "server" -- this server spawns cli/render_job.js (detached; survives
#               everything, and the only backend that keeps running with the
#               laptop shut).
#   "client" -- the user's own browser fills the same directory by POSTing frames,
#               then asks for the same encode. Kept because that browser may have
#               a real GPU the server does not.
#
# THE SERVER BACKEND RUNS THE FRONTEND'S CODE (user ruling, 2026-07-28: "the
# renderer is one code path"). cli/render_job.js used to be a BARE-NODE renderer
# on a software Skia surface -- a SECOND renderer, which silently lacked
# everything the editor has: image/video/PDF/filmstrip drew NOTHING (no
# createImageBitmap in node), LaTeX threw, Mermaid died on a font load, motion
# blur was refused, and it could never use a GPU. It now boots the real editor in
# headless Chrome and asks IT for frames, so the backend inherits the frontend's
# capabilities by construction rather than by reimplementation. Measured against
# the bare-node path it replaced: a Mandelbrot+metaball deck went 166 s/frame ->
# 0.67 s/frame at 640x360, and a 16-widget material deck >600 s -> 6.5 s for one
# 1080p frame, with the media actually present.
#
# ON-DISK LAYOUT, and why outputs go where they do:
#     projects/<name>/renders/<file>.mp4      the finished movies -- PLAINLY
#                                             visible in the project folder,
#                                             which is what the user asked for
#     projects/<name>/renders/.jobs/<id>/
#         job.json    the record (persists after the job ends -- it IS the list)
#         doc.json    THE SNAPSHOT (see below)
#         frames/     frame_000000.png ... -- scratch, deleted after the encode
# `renders/` is a SIBLING of `assets/`, not inside it, because assets/ is the
# project's asset LIBRARY and list_assets treats every file there as a library
# entry: writing movies into it would silently grow the asset browser. A dotted
# `.jobs/` keeps the bookkeeping out of the way of the movies themselves.
#
# THE SNAPSHOT IS THE WHOLE CORRECTNESS ARGUMENT. A render is
# pure(document, [slide, alpha]). If the user edits the deck while a job runs, an
# unsnapshotted job would splice pre-edit and post-edit frames into one video and
# report success -- a silently wrong output, the worst failure mode available
# here. So submit COPIES the document into the job dir and every worker reads
# that copy; the live project can be edited freely.
#
# CONCURRENCY: exactly ONE job renders at a time, from a FIFO queue. Not a
# limitation to apologise for -- a single job already fans out across
# RENDER_WORKER_COUNT processes and saturates the machine, so running two
# concurrently would only make both slower and multiply peak RAM. A second
# submit is honestly reported as "queued".
#
# SERVER RESTART: a job is a directory, so nothing is lost. On boot,
# resume_interrupted_jobs() re-queues every server-backend job that was mid-flight
# (its already-written frames are kept and skipped -- frames are written
# atomically via a .part rename, so a half-written PNG can never be mistaken for a
# finished one). A CLIENT-backend job cannot resume, because its frame producer
# was the page that went away, so it is marked "interrupted" LOUDLY rather than
# left spinning at 47% forever.

RENDERS_SUBDIR = "renders"
JOBS_SUBDIR = ".jobs"
JOB_RECORD_FILENAME = "job.json"
JOB_DOC_FILENAME = "doc.json"
JOB_FRAMES_SUBDIR = "frames"
JOB_OUTPUT_EXT = ".mp4"
# States in which a job is not finished. Used by the list (badge counts), by the
# restart sweep, and to reject a cancel of something already over.
JOB_ACTIVE_STATES = ("queued", "rendering", "encoding")
# How many BROWSERS one server-backend job renders on. Frame-range parallelism is
# sound because no widget is autoregressive (see the sharding note in
# cli/render_job.js), and it is ESSENTIAL rather than optional: a material-heavy
# slide measures seconds per frame even on the GPU-or-SwiftShader path, so this is
# the difference between a usable render and an overnight one.
#
# ONE PROCESS, N BROWSERS -- not N processes. Measured (cli/render_job.js header):
# concurrent worker PROCESSES each start their own Vite dev server, share
# node_modules/.vite, and 504 each other's module graph out mid-render; and N tabs
# of ONE browser barely parallelise because Chrome hosts same-origin tabs on one
# renderer thread (4 tabs = 1.5x, 8 tabs = WORSE than 4). N separate browsers
# scale (4 = 2.6x, 8 = 3.5x). So the supervisor spawns ONE worker process and
# passes it --workers N.
#
# Default: half the cores, capped. The cap exists because each browser is a real
# Chrome with its own GPU process and CanvasKit heap, and this often runs on a
# laptop; it also stops being a win on short jobs, where N browser boots (~1.7 s
# each) cost more than they save. POWERRP_RENDER_WORKERS overrides it.
RENDER_WORKERS_CAP = 8
RENDER_WORKER_COUNT = max(1, min(RENDER_WORKERS_CAP, (os.cpu_count() or 2) // 2))
if os.environ.get("POWERRP_RENDER_WORKERS"):
    RENDER_WORKER_COUNT = max(1, int(os.environ["POWERRP_RENDER_WORKERS"]))
# The frame worker, resolved relative to this file so the dump stays portable.
RENDER_JOB_SCRIPT = os.path.join(APP_DIR, "cli", "render_job.js")
# Widget types whose content is NOT a function of the presentation timeline: a
# video PLAYER is an HTML <video> on the browser's OWN playback clock, and the
# manifest is explicit that its playing is not document state. It RENDERS in a
# server-side job (same code as the editor), but which frame of the clip lands on
# which frame of the video is not reproducible -- so submit attaches a warning
# naming them and points at the deterministic alternative. This is not a headless
# limitation: the client backend has exactly the same property.
NON_DETERMINISTIC_TYPES = ("video", "video_v5")
# The deterministic alternatives, named in that warning so it is actionable.
DETERMINISTIC_VIDEO_TYPES = ("video_scrub", "video_v5_scrub")
# How much of the worker's stderr a job record may carry. The record is re-read by
# the UI on every poll, so it must stay small; this is generous enough for the
# document-repair notices and asset failures that actually appear there (a few
# hundred characters each) and small enough that a runaway report cannot bloat the
# poll. Exceeding it is reported in the text, never silently dropped.
WORKER_REPORT_MAX_CHARS = 4000


def renders_dir(name):
    """Query. Absolute path of a project's renders/ folder (the finished movies)."""
    return os.path.join(project_dir(name), RENDERS_SUBDIR)


def jobs_dir(name):
    """Query. Absolute path of a project's render-job bookkeeping folder."""
    return os.path.join(renders_dir(name), JOBS_SUBDIR)


def job_dir(name, job_id):
    """
    Query. Absolute path of ONE render job's folder. The id is validated as a
    single safe component AND containment-checked, so a crafted id can never
    escape the project's jobs folder.
    """
    base = jobs_dir(name)
    full = os.path.normpath(os.path.join(base, safe_name(job_id)))
    if not full.startswith(base + os.sep):
        raise ValueError(f"unsafe render job id: {job_id!r}")
    return full


def job_frames_dir(name, job_id):
    """Query. Absolute path of a job's frame scratch folder."""
    return os.path.join(job_dir(name, job_id), JOB_FRAMES_SUBDIR)


def count_job_frames(name, job_id):
    """
    Query. How many finished frames a job has written -- THE progress signal.
    Counting a directory is deliberate: it needs no IPC, no heartbeat and no
    client-held handle, so any tab can read it at any time, and a killed worker
    cannot leave a stale "80%" behind. Partial writes are invisible because the
    worker renames a .part file into place only once complete.
    """
    d = job_frames_dir(name, job_id)
    if not os.path.isdir(d):
        return 0
    return sum(1 for f in os.listdir(d) if f.startswith("frame_") and f.endswith(".png"))


def read_job(name, job_id):
    """Query. One job's record, or raise FileNotFoundError if there is no such job."""
    path = os.path.join(job_dir(name, job_id), JOB_RECORD_FILENAME)
    if not os.path.exists(path):
        raise FileNotFoundError(f"unknown render job: {job_id}")
    with open(path) as f:
        return json.load(f)


def write_job(name, job_id, record):
    """
    Command (mutates the filesystem). Persist a job record ATOMICALLY (write a
    temp file then os.replace), so a reader that lists jobs while the supervisor
    is updating one can never see a half-written JSON.
    """
    d = job_dir(name, job_id)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, JOB_RECORD_FILENAME)
    tmp = path + ".part"
    with open(tmp, "w") as f:
        json.dump(record, f, indent=2)
    os.replace(tmp, path)


def update_job(name, job_id, **fields):
    """Command. Read-modify-write a job record with `fields`. Returns the new record."""
    record = read_job(name, job_id)
    record.update(fields)
    write_job(name, job_id, record)
    return record


def job_view(name, record):
    """
    Query. A job record decorated for the client: live `framesDone` (counted off
    disk for an unfinished job) and the output's current size. A finished job
    keeps the counts frozen in its record -- its frames folder is gone.
    """
    view = dict(record)
    if record["state"] in JOB_ACTIVE_STATES:
        view["framesDone"] = count_job_frames(name, record["id"])
    out = record.get("output")
    if out:
        path = os.path.join(renders_dir(name), out)
        view["bytes"] = os.path.getsize(path) if os.path.exists(path) else 0
        view["outputPath"] = path
    return view


def list_jobs(name):
    """
    Query. A project's render jobs, newest first, each decorated by job_view. A
    project with no renders/ folder simply has none.

    A job.json that fails to PARSE (a crashed or hand-authored external writer;
    the server's own write_job is atomic tmp+replace) is reported as a LOUD
    "corrupt" entry naming the file and the parse error, instead of 500ing the
    whole list: one bad record must not brick every other job's visibility, and
    the entry keeps the corruption visible to the user (never silently skipped).
    """
    base = jobs_dir(name)
    if not os.path.isdir(base):
        return []
    out = []
    for job_id in os.listdir(base):
        path = os.path.join(base, job_id, JOB_RECORD_FILENAME)
        if not os.path.exists(path):
            continue
        with open(path) as f:
            raw = f.read()
        try:
            record = json.loads(raw)
        except ValueError as e:
            out.append({
                # Shaped like a failed job_view so the existing UI renders it
                # as a failed row with the parse error visible.
                "id": job_id,
                "project": name,
                "name": "corrupt record %s" % job_id[:8],
                "state": "failed",
                "backend": "server",
                "error": "job.json does not parse: %s (file: %s)" % (e, path),
                "createdAt": os.path.getmtime(path),
            })
            continue
        out.append(job_view(name, record))
    return sorted(out, key=lambda j: j.get("createdAt", 0), reverse=True)


def widget_types(doc):
    """
    Pure function. The distinct widget `type` values appearing anywhere in a
    document, found by walking the whole structure -- items live inside per-slide
    DELTAS, not a flat item table, so a shallow scan would miss most of them.

    Examples:
        >>> sorted(widget_types({"slides": [{"delta": {"items": {"a": {"type": "text"}}}}]}))
        ['text']
        >>> widget_types({})
        set()
    """
    found = set()

    def walk(node):
        if isinstance(node, dict):
            kind = node.get("type")
            if isinstance(kind, str):
                found.add(kind)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(doc)
    return found


def playback_clock_warning(doc):
    """
    Pure function. A warning naming the widgets whose content is NOT a function of
    the presentation timeline, or None when every widget in the deck is
    reproducible. Applies to BOTH backends -- a video PLAYER runs on the browser's
    own playback clock in either one.

    It exists because the alternative is a user who renders the same deck twice
    and gets two different videos with no explanation.

    Examples:
        >>> playback_clock_warning({"slides": [{"delta": {"items": {"a": {"type": "text"}}}}]}) is None
        True
        >>> "video" in playback_clock_warning({"slides": [{"delta": {"items": {"a": {"type": "video"}}}}]})
        True
        >>> playback_clock_warning({"slides": [{"delta": {"items": {"a": {"type": "video_scrub"}}}}]}) is None
        True
    """
    present = sorted(widget_types(doc) & set(NON_DETERMINISTIC_TYPES))
    if not present:
        return None
    return (f"This deck contains video PLAYER widgets ({', '.join(present)}). A player follows the "
            f"browser's own playback clock, not the presentation timeline, so which frame of the clip "
            f"lands on which frame of the render is not reproducible -- re-rendering can give a "
            f"different result. For a deterministic export use a video SCRUBBER instead "
            f"({', '.join(DETERMINISTIC_VIDEO_TYPES)}), whose current time IS tweened document state.")


def merged_warning(existing, reports):
    """
    Pure function. The job's warning text after a worker run: whatever it already
    carried, plus the DISTINCT lines the worker reported. None when there is
    nothing to say.

    Deduplicated because every browser rendering the job repairs the same snapshot
    and therefore prints the same repair notices, and truncated because a job
    record is read by the UI on every poll -- a runaway report must not turn it
    into a megabyte of JSON. Truncation is ANNOUNCED, never silent.

    Examples:
        >>> merged_warning(None, "") is None
        True
        >>> merged_warning(None, "a\\na\\nb\\n")
        'The render worker reported:\\na\\nb'
        >>> merged_warning("careful", "a\\n")
        'careful\\n\\nThe render worker reported:\\na'
    """
    seen = list(dict.fromkeys(line for line in (l.strip() for l in reports.splitlines()) if line))
    parts = [existing] if existing else []
    if seen:
        text = "\n".join(seen)
        if len(text) > WORKER_REPORT_MAX_CHARS:
            text = text[:WORKER_REPORT_MAX_CHARS] + f"\n... (truncated at {WORKER_REPORT_MAX_CHARS} characters)"
        parts.append("The render worker reported:\n" + text)
    return "\n\n".join(parts) or None


def unique_output_name(name, base):
    """
    Query. A free "<base>.mp4" (or "<base> (2).mp4", ...) inside the project's
    renders/ folder, so a re-render never silently overwrites an earlier movie the
    user may still want.
    """
    d = renders_dir(name)
    candidate = base + JOB_OUTPUT_EXT
    n = 2
    while os.path.exists(os.path.join(d, candidate)):
        candidate = f"{base} ({n}){JOB_OUTPUT_EXT}"
        n += 1
    return candidate


def create_job(name, params, doc, job_name, backend):
    """
    Command (mutates the filesystem). Register a render job for a project and
    SNAPSHOT `doc` into it, returning the new record.

    The snapshot is the point: the job renders the deck AS IT WAS AT SUBMIT, so
    editing (or even deleting) the project afterwards cannot splice two different
    documents into one video.

    Args:
        name (str): project name
        params (dict): width/height/fps/crf/background/range/... (validated by caller)
        doc (dict): the document to snapshot
        job_name (str): human label, also the output filename stem
        backend (str): "server" (this server renders) or "client" (browser renders)

    Returns:
        dict: the job record
    """
    job_id = uuid.uuid4().hex
    d = job_dir(name, job_id)
    os.makedirs(os.path.join(d, JOB_FRAMES_SUBDIR), exist_ok=True)
    with open(os.path.join(d, JOB_DOC_FILENAME), "w") as f:
        json.dump(doc, f)
    record = {
        "id": job_id,
        "project": name,
        "name": job_name,
        "backend": backend,
        "state": "queued",
        "framesTotal": 0,       # filled by the worker's plan (server) or the client
        "framesDone": 0,
        "params": params,
        "output": None,
        "error": None,
        "warning": playback_clock_warning(doc),
        "workers": RENDER_WORKER_COUNT if backend == "server" else 1,
        "createdAt": time.time(),
        "startedAt": None,
        "finishedAt": None,
        "seen": False,
    }
    write_job(name, job_id, record)
    return record


def delete_job(name, job_id):
    """
    Command (mutates the filesystem). Remove a job's bookkeeping folder AND its
    output movie. Refuses LOUDLY while the job is still active -- cancel it first,
    so a running worker can never be left writing into a deleted directory.
    """
    record = read_job(name, job_id)
    if record["state"] in JOB_ACTIVE_STATES:
        raise RuntimeError(f"render job {job_id} is {record['state']} -- cancel it before deleting")
    out = record.get("output")
    if out:
        path = os.path.join(renders_dir(name), out)
        if os.path.exists(path):
            os.remove(path)
    shutil.rmtree(job_dir(name, job_id), ignore_errors=True)


# The render queue and its single supervisor thread. ONE job at a time (see the
# section header); `_job_procs` holds a running job's worker Popens so a cancel
# can kill them, and `_job_cancelled` marks ids the supervisor must abandon --
# including one cancelled while still QUEUED, which has no processes to kill.
_job_queue = queue.Queue()
_job_procs = {}
_job_cancelled = set()
_job_lock = threading.Lock()


def encode_job_output(name, job_id, record):
    """
    Command (runs ffmpeg, writes the movie, deletes the frame scratch). Mux a
    job's rendered PNG sequence into the project's renders/ folder and return the
    output's basename.

    This is the ONE encode step, shared by both backends -- the browser-rendered
    and server-rendered paths differ only in who wrote the frames. Mirrors
    encode_export_mp4's ffmpeg invocation (yuv420p + even dimensions so it plays
    everywhere, +faststart so it is instantly seekable) but writes to a PERSISTENT
    location instead of returning bytes and deleting everything.

    Raises loudly if ffmpeg is missing, no frames exist, or ffmpeg fails.
    """
    frames = job_frames_dir(name, job_id)
    if not os.path.isdir(frames) or not any(f.endswith(".png") for f in os.listdir(frames)):
        raise RuntimeError(f"render job {job_id} has no frames to encode")
    os.makedirs(renders_dir(name), exist_ok=True)
    out_name = unique_output_name(name, record["name"])
    out_path = os.path.join(renders_dir(name), out_name)
    pattern = os.path.join(frames, f"frame_%0{EXPORT_FRAME_PAD}d.png")
    # stdin=DEVNULL on this and every other ffmpeg/ffprobe call: ffmpeg reads its
    # inherited stdin for interactive commands, and when this server runs as a
    # background job under the launcher's job control (start_server.sh `set -m`),
    # that read from the terminal raises SIGTTIN — which STOPS the entire process
    # group: python, uv, and ffmpeg all freeze mid-encode, the job sticks at
    # "encoding", and the port stops accepting while the process still looks alive.
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-framerate", str(record["params"]["fps"]), "-start_number", "0",
             "-i", pattern,
             "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
             "-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-crf", str(record["params"]["crf"]), "-movflags", "+faststart",
             "-loglevel", "error", out_path],
            capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found on PATH -- install ffmpeg")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffmpeg MP4 encode failed: {exc.stderr.strip()[-500:]}")
    # The movie exists now, so the PNG sequence (1-2 GB for a 1080p minute) is
    # dead weight and goes immediately. The job RECORD stays -- it is the list.
    shutil.rmtree(frames, ignore_errors=True)
    return out_name


def backend_origin():
    """
    Query. The origin the render worker's dev server must proxy /api and /asset
    to, i.e. THIS server. Set by serve(); a caller that runs Handler itself (the
    render-job test) sets BACKEND_URL before submitting.

    Missing is a hard error, not a default: a project's image/video/PDF assets are
    stored as "/asset/<project>/<file>" URLs, so a worker with the wrong origin
    would 404 every one of them and render a deck full of holes. Guessing a port
    would turn that into a silent wrong picture.
    """
    url = os.environ.get("BACKEND_URL")
    if not url:
        raise RuntimeError("BACKEND_URL is not set, so a render worker could not resolve this "
                           "project's /asset URLs -- serve() sets it; a harness that runs Handler "
                           "directly must set it before submitting a server-backend job")
    return url


def run_server_job(name, job_id):
    """
    Command (spawns the worker process, waits, then encodes). Render a
    server-backend job: ONE `cli/render_job.js` process fanning the frame range
    across `record["workers"]` headless browsers, then encode.

    ONE process, N browsers -- see the RENDER_WORKER_COUNT note for the
    measurements that forced that shape.

    Raises loudly if node is missing or the worker exits non-zero (with its
    stderr), so a failed render surfaces the real reason instead of stalling at a
    percentage. The worker's stderr is RETURNED even on success, because the page's
    own loud-failure reports (a failed asset fetch, a repaired document, a refused
    surface) arrive there and must not be thrown away just because the job finished.

    Returns:
        str: the worker's stderr (possibly empty)
    """
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node not found on PATH -- the server-side renderer needs Node.js")
    record = read_job(name, job_id)
    d = job_dir(name, job_id)
    # The worker starts a Vite dev server, which reads BACKEND_URL for its /api and
    # /asset proxy -- that is how a project's assets reach the render page.
    env = {**os.environ, "BACKEND_URL": backend_origin()}
    proc = subprocess.Popen(
        [node, RENDER_JOB_SCRIPT, d, "--workers", str(record["workers"])],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=REPO_ROOT, env=env,
        # ITS OWN SESSION, so the worker leads its own process GROUP. Two reasons, and
        # the first is a foot-gun I nearly shipped: without this the worker shares THIS
        # SERVER's group, so reaping it with killpg would kill the server too. With it,
        # the group contains exactly the worker and the browsers it spawns -- which is
        # also the only way to take those browsers down with it instead of leaving them
        # holding ports. Same reasoning as the test runner's backend teardown.
        start_new_session=True,
    )
    # PERSIST THE PID, because _job_procs is IN-MEMORY and a restart empties it while
    # the OS process SURVIVES (reparented to init). Without this, a server restart
    # left an orphan worker rendering a job the server had already re-queued -- two
    # workers writing the same frames directory, and a job reporting "queued" while
    # its framesDone visibly climbed. Measured on a live server: 68cf3e78 sat at
    # state "queued" while going 634 -> 650 of 1620 frames.
    write_worker_pid(name, job_id, proc.pid)
    with _job_lock:
        _job_procs[job_id] = [proc]
    try:
        out, err = proc.communicate()
        if out and out.strip():
            print(f"PowerRP render job {job_id}: {out.strip()}", file=sys.stderr)
        # A cancel kills the worker, so a non-zero exit there is expected and is
        # NOT a failure to report -- the cancel path owns that outcome.
        if proc.returncode != 0 and job_id not in _job_cancelled:
            raise RuntimeError(f"render worker exited {proc.returncode}: {(err or '').strip()[-2000:]}")
        return err or ""
    finally:
        clear_worker_pid(name, job_id)
        with _job_lock:
            _job_procs.pop(job_id, None)


WORKER_PID_FILE = "worker.pid"


def write_worker_pid(name, job_id, pid):
    """Command. Records the live worker's pid beside its job, so a server restart can
    find and reap it. Written before the worker does any work; removed when it exits."""
    with open(os.path.join(job_dir(name, job_id), WORKER_PID_FILE), "w") as f:
        f.write(str(pid))


def clear_worker_pid(name, job_id):
    """Command. Forgets a worker's pid. Missing is the normal case (already cleared, or
    a job that never spawned one), so only that is tolerated."""
    try:
        os.remove(os.path.join(job_dir(name, job_id), WORKER_PID_FILE))
    except FileNotFoundError:
        pass


def reap_orphan_worker(name, job_id):
    """
    Command (runs at boot, before a job is re-queued). Kills a worker left over from a
    previous server process, and returns True if it killed one.

    IDENTITY IS CHECKED, NOT ASSUMED. A bare pid is not enough -- pids are reused, and
    killing a stranger would be far worse than leaving an orphan. So the recorded pid
    is only killed if /proc says its command line still names THIS job's directory.
    That makes the check exact rather than probabilistic.

    The whole process GROUP is signalled, for the same reason the test runner does it:
    the worker spawns browsers of its own, and killing only the parent leaves those
    behind holding ports.
    """
    path = os.path.join(job_dir(name, job_id), WORKER_PID_FILE)
    try:
        with open(path) as f:
            pid = int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return False
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read().decode("utf-8", "replace")
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        clear_worker_pid(name, job_id)
        return False
    if job_id not in cmdline:
        # The pid was recycled by an unrelated process. Forget it; kill nothing.
        clear_worker_pid(name, job_id)
        return False
    print(f"PowerRP: reaping orphaned render worker pid {pid} for job {job_id} "
          f"(it outlived the server that started it)", file=sys.stderr)
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except ProcessLookupError:
        pass  # exited between our read and our signal -- the outcome we wanted
    clear_worker_pid(name, job_id)
    return True


def _supervise():
    """
    Command (the render supervisor thread; runs forever). Takes one job id at a
    time off the queue, renders it (server backend) and encodes it, recording
    every outcome on the job record.

    Every failure is written to the record's `error` and printed with a traceback:
    a job must end in a state the user can SEE, never linger as a lie.
    """
    while True:
        name, job_id = _job_queue.get()
        try:
            record = read_job(name, job_id)
            if job_id in _job_cancelled or record["state"] == "cancelled":
                update_job(name, job_id, state="cancelled", finishedAt=time.time())
                continue
            update_job(name, job_id, state="rendering", startedAt=time.time())
            reports = run_server_job(name, job_id)
            if job_id in _job_cancelled:
                shutil.rmtree(job_frames_dir(name, job_id), ignore_errors=True)
                update_job(name, job_id, state="cancelled", finishedAt=time.time())
                continue
            # A SUCCEEDED job that reported problems must still say so. The render
            # page reports a failed asset fetch, a document repair or a refused
            # surface on stderr; dropping that on the floor because the job finished
            # is how a frame with a hole in it gets called green.
            merged = merged_warning(record.get("warning"), reports)
            record = update_job(name, job_id, state="encoding", warning=merged,
                                framesDone=count_job_frames(name, job_id))
            out_name = encode_job_output(name, job_id, record)
            update_job(name, job_id, state="done", output=out_name,
                       finishedAt=time.time(), seen=False)
        except Exception as exc:  # report loudly on the record AND the console
            traceback.print_exc()
            try:
                update_job(name, job_id, state="failed", error=f"{type(exc).__name__}: {exc}",
                           finishedAt=time.time())
            except Exception:
                traceback.print_exc()  # the record itself is unwritable -- console is all we have
        finally:
            _job_cancelled.discard(job_id)
            _job_queue.task_done()


def enqueue_job(name, job_id):
    """Command. Hand a server-backend job to the supervisor thread."""
    _job_queue.put((name, job_id))


def cancel_job(name, job_id):
    """
    Command (kills the job's workers). Cancel a queued or running job. Marks the
    id cancelled FIRST so a job still sitting in the queue is abandoned when it
    comes up, then kills any live worker processes. Refuses loudly for a job that
    has already finished.
    """
    record = read_job(name, job_id)
    if record["state"] not in JOB_ACTIVE_STATES:
        raise RuntimeError(f"render job {job_id} is already {record['state']}")
    _job_cancelled.add(job_id)
    with _job_lock:
        for proc in _job_procs.get(job_id, []):
            proc.kill()
    # A CLIENT-backend job has no server-side process to kill: marking the record
    # is the whole cancel, and the browser stops when its next POST is refused.
    if record["backend"] == "client":
        shutil.rmtree(job_frames_dir(name, job_id), ignore_errors=True)
        update_job(name, job_id, state="cancelled", finishedAt=time.time())
    return read_job(name, job_id)


def resume_interrupted_jobs():
    """
    Command (runs once at boot). Reconcile jobs left mid-flight by a server
    restart, so a restart can never silently lose one.

    A SERVER-backend job is re-queued: its frames are on disk and the worker skips
    the ones already written, so it picks up roughly where it stopped.

    A CLIENT (browser) job is LEFT ALONE, and that is a correction of what this
    function used to do. It used to mark such a job "interrupted" on the grounds
    that its frame producer was a tab that had gone away -- but a browser job is
    now RESUMABLE (web/browserRenderJobs.js): its progress is either the PNG frames
    already in this job's own directory or encoded segments in the browser's
    IndexedDB, and neither is touched by a server restart. Marking it terminal here
    would have destroyed a render that the next page load could have finished, and
    would have made the endpoint that delivers its movie refuse it. A browser job
    whose browser really is gone is reconciled by the CLIENT, which can see whether
    it holds that job's resume data -- the server cannot.
    """
    if not os.path.isdir(PROJECTS_DIR):
        return
    for name in os.listdir(PROJECTS_DIR):
        base = os.path.join(PROJECTS_DIR, name, RENDERS_SUBDIR, JOBS_SUBDIR)
        if not os.path.isdir(base):
            continue
        for job_id in os.listdir(base):
            try:
                record = read_job(name, job_id)
            except (FileNotFoundError, ValueError):
                continue
            if record["state"] not in JOB_ACTIVE_STATES:
                continue
            if record["backend"] == "server":
                # stderr, like every other server report: stdout is block-buffered
                # when the server is launched with its output redirected to a log,
                # so a "loud" notice printed there would sit unseen in a buffer.
                print(f"PowerRP: resuming interrupted render job {record['name']} ({job_id}) in {name}", file=sys.stderr)
                # REAP FIRST, THEN RE-QUEUE. The old worker is not our child any more,
                # so nothing reaps it for us; re-queueing without killing it puts a
                # SECOND worker on the same frames directory, and leaves a job whose
                # state says "queued" while its frame count climbs.
                reap_orphan_worker(name, job_id)
                update_job(name, job_id, state="queued", error=None)
                enqueue_job(name, job_id)
            else:
                print(f"PowerRP: browser render job {record['name']} ({job_id}) in {name} is still "
                      f"unfinished after a server restart -- left resumable (its progress is the "
                      f"browser's, not this server's)", file=sys.stderr)


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
        >>> asset_kind("paper.pdf")
        'pdf'
        >>> asset_kind("Handwriting.ttf")
        'font'
        >>> asset_kind("gear.plugin.js")
        'plugin'
        >>> asset_kind("sales.CSV")
        'data'
        >>> asset_kind("helper.js")
        'other'
        >>> asset_kind("notes.txt")
        'other'
    """
    # The compound suffix is checked FIRST and on the whole name: os.path.splitext
    # sees only ".js", which cannot tell a widget from any other script.
    if filename.lower().endswith(PLUGIN_ASSET_SUFFIX):
        return "plugin"
    ext = os.path.splitext(filename)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in SOUND_EXTS:
        return "sound"
    if ext in PDF_EXTS:
        return "pdf"
    if ext in FONT_EXTS:
        return "font"
    if ext in DATA_EXTS:
        return "data"
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

    THE FOLDER NAME IS THE PROJECT'S IDENTITY. `name` comes from os.listdir and
    NOTHING ELSE — doc.json is opened only to count slides, never to name the
    project. That is what makes a hand-run `mv projects/Old projects/New` a fully
    supported rename: the listing shows "New" immediately, and opening it makes
    doc.meta.name follow (the client's loadProject stamps the folder name onto
    the document it just read). A listing that preferred a stale stored
    meta.name would show a name no path uses, and every asset lookup under it
    would find nothing.
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


def mtime_key(mtime):
    """
    Pure function. The canonical MICROSECOND-integer key for a file mtime, used
    to key the thumbnail cache. Whole seconds are too coarse (a file replaced
    within the same second would not invalidate); microseconds survive the
    float→JSON→query-string→float round trip the client key makes.

    Examples:
        >>> mtime_key(1690000000.123456)
        1690000000123456
        >>> mtime_key(0)
        0
    """
    return round(float(mtime) * 1_000_000)


def thumbs_dir(name):
    """Query. Absolute path of a project's asset-thumbnail cache folder."""
    return os.path.join(assets_dir(name), THUMBS_SUBDIR)


def thumb_entry_dir(name, filename):
    """Query. Absolute path of ONE asset's thumbnail-cache folder (name+file
    validated as single safe components — never a traversal)."""
    return os.path.join(thumbs_dir(name), safe_name(filename))


def asset_thumb(name, filename, mtime):
    """
    Query. The cached thumbnail metadata for an asset if one exists AND is fresh
    (its stored mtime matches the asset's current mtime), else {} — a stale or
    absent thumb is simply not attached (the client re-renders + re-stores it).

    Returns {thumbnail: <served url>, badge: <str|None>} on a fresh hit.
    """
    meta_path = os.path.join(thumb_entry_dir(name, filename), THUMB_META_FILENAME)
    if not os.path.isfile(meta_path):
        return {}
    try:
        with open(meta_path) as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return {}  # a corrupt meta = a cache miss; the client rebuilds it
    if int(meta.get("mtime", -1)) != mtime_key(mtime):
        return {}  # stale: the asset was replaced since this thumb was cached
    thumb_file = meta.get("thumb")
    if not thumb_file or not os.path.isfile(os.path.join(thumb_entry_dir(name, filename), thumb_file)):
        return {}
    q = urllib.parse.quote
    sub = f"{THUMBS_SUBDIR}/{filename}/{thumb_file}"
    return {"thumbnail": f"/asset/{q(name)}/{q(sub, safe='/')}", "badge": meta.get("badge")}


def save_thumb(name, filename, mtime, badge, data):
    """
    Command (mutates the filesystem). Persist a client-rendered thumbnail PNG for
    an asset under assets/.thumbs/<file>/, keyed by the asset's mtime, plus a
    meta.json ({mtime, badge, thumb}). Overwrites any prior thumb for the file
    (only the freshest is kept). Returns the served thumbnail url.
    """
    entry = thumb_entry_dir(name, filename)
    if os.path.isdir(entry):
        shutil.rmtree(entry)  # drop the stale thumb + meta before writing the new one
    os.makedirs(entry, exist_ok=True)
    key = mtime_key(mtime)
    thumb_file = f"{key}.png"
    with open(os.path.join(entry, thumb_file), "wb") as f:
        f.write(data)
    meta = {"mtime": key, "badge": badge, "thumb": thumb_file}
    with open(os.path.join(entry, THUMB_META_FILENAME), "w") as f:
        json.dump(meta, f)
    q = urllib.parse.quote
    sub = f"{THUMBS_SUBDIR}/{filename}/{thumb_file}"
    return f"/asset/{q(name)}/{q(sub, safe='/')}"


def list_assets(name):
    """
    Query. Files directly in a project's assets/ folder (NOT recursive — the
    frames/ and .thumbs/ cache subfolders are skipped). Each:
    {name, size, mtime, kind, url, thumbnail?, badge?, durationSec?}. The assets/
    folder IS the source of truth, so this reflects manual drops too (manifest
    Round 12B: "manually dropping a file into the folder must appear in the
    library — a refresh button is acceptable"). `mtime` lets the client key its
    own thumbnail cache and regenerate on a replaced file; `thumbnail`/`badge` are
    attached when a FRESH cached thumb exists (manifest #25 — PDF first-page
    preview + page-count badge), so a returning session shows the preview with no
    client re-render. `durationSec` is the ffprobe container duration for VIDEO
    assets (the deterministic `self.length` behind the time-driven scrubber) —
    O(1) to read (no frame decode). A video that fails to probe is REPORTED to
    stderr and simply omits the key (an honest "unknown length"), so one bad
    upload never breaks listing the whole library.
    """
    d = assets_dir(name)
    if not os.path.isdir(d):
        return []
    out = []
    for fn in sorted(os.listdir(d)):
        full = os.path.join(d, fn)
        if not os.path.isfile(full):
            continue  # skip frames/, .thumbs/, and any other subdir
        mtime = os.path.getmtime(full)
        kind = asset_kind(fn)
        entry = {
            "name": fn,
            "size": os.path.getsize(full),
            "mtime": mtime,
            "kind": kind,
            "url": f"/asset/{urllib.parse.quote(name)}/{urllib.parse.quote(fn)}",
            **asset_thumb(name, fn, mtime),
        }
        if kind == "video":
            try:
                entry["durationSec"] = video_duration_seconds(full)
            except Exception as exc:  # report, never crash the whole listing
                print(f"[list_assets] duration probe failed for {name}/{fn}: {exc}", file=sys.stderr)
        out.append(entry)
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


def delete_asset(name, filename):
    """
    Command. Delete one asset file from a project's assets/ folder, plus its
    filmstrip frame cache (assets/frames/<filename>/, all N variants) if any —
    cached frames of a deleted video would otherwise be orphaned on disk.
    Both name parts are traversal-guarded via safe_name. Raises loudly
    (FileNotFoundError) if the asset does not exist; the HTTP layer maps that
    to a 404. Mutates the filesystem.
    """
    path = os.path.join(assets_dir(name), safe_name(filename))
    if not os.path.isfile(path):
        raise FileNotFoundError(f"asset not found: {name}/{filename}")
    os.remove(path)
    frame_cache = os.path.join(assets_dir(name), FRAMES_SUBDIR, safe_name(filename))
    if os.path.isdir(frame_cache):
        shutil.rmtree(frame_cache)
    thumb_cache = thumb_entry_dir(name, filename)
    if os.path.isdir(thumb_cache):
        shutil.rmtree(thumb_cache)  # a deleted asset's cached thumbnail would otherwise orphan
    return filename


# -- RENAME IS A MOVE, AND THE FOLDER IS THE IDENTITY -----------------------
# THE DEFECT THIS EXISTS FOR (user report, verbatim): "as soon as I renamed the
# project, all the assets disappeared. That's cursed."
#
# Nothing was deleted. A rename wrote doc.meta.name and NOTHING ELSE, while every
# asset stayed on disk under projects/<OLD>/assets/. Every reader — the Asset
# Explorer's listing, and the resolution of every relative widget `src` — asks
# under the document's CURRENT name, so the library read empty and the canvas
# painted the loud missing-asset sentinel.
#
# THE USER'S RULING (verbatim): "rename should not copy a project — rename should
# rename and MOVE a project. Rename moves things, and it should carry all the
# references automatically because they're all relative references. If I rename a
# project it should rename the folder and everything inside it is implicitly
# renamed. If I rename the folder manually I shouldn't have to worry about it — if
# I rename the folder, the project name should be renamed automatically."
#
# THE DEEP PRINCIPLE, stated once: THE FOLDER NAME IS THE PROJECT'S IDENTITY.
# doc.meta.name FOLLOWS the folder, never the other way around. That is why
# list_projects() derives every name from os.listdir and never opens doc.json for
# it, why _handle_load reports the folder name back, and why a `mv` done by hand
# in a terminal is a fully supported way to rename a project.
#
# WHY MOVE BEATS COPY, which an earlier attempt got wrong: the refs inside
# doc.json are RELATIVE ("clip.mp4"), so they name no project at all and survive
# the move untouched — that is the entire payoff of the relative grammar. A copy
# would double every byte of a deck holding a 2 GB video, and would leave a stale
# twin whose edits silently diverge. Save-As is the operation that WANTS a copy,
# and it is a different verb (copy_project_assets, below).

def rename_project(old, new):
    """
    Command (mutates the filesystem). MOVE projects/<old> → projects/<new>.

    ONE os.rename of the folder. Within a filesystem that is ATOMIC — the
    directory either has the old name or the new one, never both and never
    neither — so an interrupted rename cannot strand half a project's assets
    under one name and half under the other. Both names are traversal-guarded by
    safe_name, and both resolve under PROJECTS_DIR, so the move is always
    same-filesystem and the atomicity holds.

    REFUSES LOUDLY, NEVER MERGES: a missing source and an occupied destination are
    both errors. os.rename on POSIX would silently replace an empty destination
    directory and raise on a full one — an inconsistent rule for an operation that
    must never consume a project the user still has — so the destination is
    checked explicitly first and refused whatever its contents.

    Renaming to the SAME name is a no-op, not an error: the caller (a rename
    modal that was confirmed unchanged) has nothing to do, and raising would make
    a harmless gesture report a failure.

    Nothing inside the folder is rewritten. Relative asset refs ("clip.mp4") name
    no project, so they resolve against the NEW folder for free; legacy ABSOLUTE
    self-refs would not, which is why the client relativizes them BEFORE calling
    this (see web/app.svelte.js renameProject for that ordering).

    Args:
        old (str): the project's current folder name
        new (str): the folder name to move it to

    Returns:
        str: the new name

    Examples:
        >>> # rename_project("Deck", "Deck v2")   → "Deck v2"; projects/Deck is gone
        >>> rename_project("Deck", "Deck")        # same name: nothing to do
        'Deck'
    """
    src, dst = project_dir(old), project_dir(new)
    if src == dst:
        return new
    if not os.path.isdir(src):
        raise FileNotFoundError(f"rename_project({old!r} → {new!r}): no such project")
    if os.path.exists(dst):
        raise FileExistsError(f"rename_project({old!r} → {new!r}): {new!r} already exists — rename never merges or overwrites")
    os.rename(src, dst)
    return new


def copy_project_assets(src, dst):
    """
    Command (writes files). Copy every asset of project `src` into project `dst`.

    THIS IS SAVE-AS, NOT RENAME. Save-As FORKS: the original project must stay
    intact and fully working, so its library is duplicated rather than moved. It
    runs SERVER-SIDE so a fork of a deck holding a large video never pulls those
    bytes down to the browser and pushes them back.

    The whole assets/ tree travels — subfolders included, because an author's
    nested path ("icons/logo.svg") is a legal relative ref. The frames/ and
    .thumbs/ caches are SKIPPED: they are derivable, can be large, and the fork
    regenerates them on demand.

    A missing source assets/ folder is an empty library, not an error (a project
    with no assets forks fine). Existing destination files are SKIPPED, never
    overwritten — the destination file may be a different asset the user put
    there, and a fork must never destroy it — which also makes this idempotent.

    Args:
        src (str): source project name
        dst (str): destination project name (created if new)

    Returns:
        dict: {"copied": [...], "skipped": [...]}, both sorted, paths relative to
              assets/ with "/" separators.

    Examples:
        >>> # copy_project_assets("Deck", "Deck fork")
        >>> # {'copied': ['clip.mp4', 'icons/logo.svg'], 'skipped': []}
        >>> copy_project_assets("Deck", "Deck")   # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ValueError: ...
    """
    if safe_name(src) == safe_name(dst):
        raise ValueError(f"copy_project_assets: source and destination are the same project ({src!r})")
    src_dir, dst_dir = assets_dir(src), assets_dir(dst)
    copied, skipped = [], []
    if not os.path.isdir(src_dir):
        return {"copied": copied, "skipped": skipped}  # no library to carry — not an error
    os.makedirs(dst_dir, exist_ok=True)
    derivable = (os.path.join(src_dir, FRAMES_SUBDIR), os.path.join(src_dir, THUMBS_SUBDIR))
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if os.path.join(root, d) not in derivable]
        rel_root = os.path.relpath(root, src_dir)
        for fn in sorted(files):
            rel = fn if rel_root == "." else f"{rel_root}/{fn}".replace(os.sep, "/")
            target = os.path.join(dst_dir, *rel.split("/"))
            if os.path.exists(target):
                skipped.append(rel)  # destination wins — reported, never clobbered
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(os.path.join(root, fn), target)
            copied.append(rel)
    return {"copied": sorted(copied), "skipped": sorted(skipped)}


# -- SELF-CONTAINED EXPORT: the asset-reference walk ------------------------
# THE DEFECT THIS SECTION EXISTS FOR (user report, verbatim): "the robotsim.zip
# references a video file, but that video file is not in that zip. If I were to
# load that zip into the browser, it wouldn't know where the video file was… The
# zip should be basically the whole project folder."
#
# A document stores media as "/asset/<project>/<file>", and the project NAME is
# baked into every one of those strings — but nothing keeps it equal to the folder
# the document lives in. SAVE-AS is how they diverge: the client renames
# doc.meta.name and saves to a NEW folder (web/App.svelte's save modal calls
# renameProject then saveToServer), while every src still names the OLD project.
# On this server the deck keeps working, because /asset/<any project>/… is served
# to anyone — so the divergence is INVISIBLE until the project leaves the machine.
# zip_project_bytes walked ONE folder, shipped a doc whose refs named a folder not
# in the archive, and the import opened a deck with a hole where a video was.
#
# The fix is not to forbid the divergence (a cross-project ref is useful while both
# projects are on one server) but to LOCALIZE at the archive boundary: copy the
# foreign bytes IN and rewrite the ARCHIVED doc.json. The on-disk source project is
# never touched — the author's document keeps saying exactly what the author wrote.
#
# THE WALK IS BLIND (every string leaf) rather than a list of known keys, and the
# reason is the same one web/assetLocalize.js gives: `src` is not the only
# ref-bearing property (svgUrl, a slide's transition.sound, a filmstrip frame
# list, any property a FUTURE widget invents), so a curated key list would be
# wrong the day someone adds a widget — silently, and in the direction that loses
# data. This is the PYTHON TWIN of web/assetLocalize.js; the two must agree, and
# tests/asset_localize_test.py pins them against the same expected plan.

def asset_ref(project, file):
    """
    Pure function. Build the portable in-document reference for one asset — the
    twin of web/assetRef.js assetRef, and the INVERSE of parse_asset_ref.

    Each PATH SEGMENT of `file` is quoted separately so a nested path keeps its
    slashes as separators (that is how parse_asset_ref reads them back), while a
    space or a "#" inside a segment is still encoded.

    Args:
        project: project name (unencoded)
        file: asset path within the project's assets/ (unencoded)

    Returns:
        str

    Examples:
        >>> asset_ref("RobotSim", "clip.mp4")
        '/asset/RobotSim/clip.mp4'
        >>> asset_ref("My Talk", "a b.png")
        '/asset/My%20Talk/a%20b.png'
        >>> asset_ref("Deck", "icons/logo.svg")
        '/asset/Deck/icons/logo.svg'
        >>> parse_asset_ref(asset_ref("My Talk", "icons/a b.svg"))
        ('My Talk', 'icons/a b.svg')
    """
    q = urllib.parse.quote
    return f"{ASSET_REF_PREFIX}{q(project)}/" + "/".join(q(p) for p in file.split("/"))


def parse_asset_ref(ref):
    """
    Pure function. Split an in-document asset reference into (project, file), or
    None when `ref` is not one (an http URL, a data: URI, a bare filename, an
    equation). The twin of web/assetRef.js parseAssetRef, decoding each segment
    exactly once because that is how the refs were minted (urllib.parse.quote).

    Only the FIRST segment after the prefix is the project; the remainder stays in
    `file`, which is how a thumbnail path (".thumbs/p.pdf/thumb.png") remains
    addressable through the same grammar.

    Args:
        ref: any string leaf from a document

    Returns:
        tuple[str, str] | None

    Examples:
        >>> parse_asset_ref("/asset/Untitled/clip.mp4")
        ('Untitled', 'clip.mp4')
        >>> parse_asset_ref("/asset/My%20Talk/a%20b.png")
        ('My Talk', 'a b.png')
        >>> parse_asset_ref("/asset/Deck/icons/logo.svg")
        ('Deck', 'icons/logo.svg')
        >>> parse_asset_ref("https://example.com/a.png") is None
        True
        >>> parse_asset_ref('= "/asset/X/a.png" + name') is None
        True
    """
    if not isinstance(ref, str) or not ref.startswith(ASSET_REF_PREFIX):
        return None
    rest = ref[len(ASSET_REF_PREFIX):]
    project, sep, file_part = rest.partition("/")
    if not sep or not project or not file_part:
        return None
    project = urllib.parse.unquote(project)
    file = "/".join(urllib.parse.unquote(p) for p in file_part.split("/"))
    if not project or not file:
        return None
    return project, file


def document_asset_refs(doc):
    """
    Pure function. Every asset REFERENCE in a document, in document order, one
    entry per OCCURRENCE (the same file referenced twice yields two entries — a
    rewrite must touch both). `path` is a "/"-joined JSON path so a warning can
    point a human at the exact leaf.

    Args:
        doc: a serialized document {meta, slides: [{delta: {items}}]}

    Returns:
        list[dict]: [{"path", "ref", "project", "file"}]

    Examples:
        >>> doc = {"slides": [{"delta": {"items": {"v": {"src": "/asset/Untitled/clip.mp4"}}}}]}
        >>> document_asset_refs(doc) == [{"path": "slides/0/delta/items/v/src",
        ...                               "ref": "/asset/Untitled/clip.mp4",
        ...                               "project": "Untitled", "file": "clip.mp4"}]
        True
        >>> document_asset_refs({"slides": [{"delta": {"items": {"t": {"text": "= 1 + 2"}}}}]})
        []
    """
    found = []

    def walk(value, path):
        if isinstance(value, str):
            parsed = parse_asset_ref(value)
            if parsed:
                found.append({"path": "/".join(path), "ref": value,
                              "project": parsed[0], "file": parsed[1]})
        elif isinstance(value, list):
            for i, v in enumerate(value):
                walk(v, path + [str(i)])
        elif isinstance(value, dict):
            for k, v in value.items():
                walk(v, path + [str(k)])

    walk(doc, [])
    return found


def rewritten_asset_refs(doc, ref_map):
    """
    Pure function. A DEEP COPY of `doc` with every asset ref found in `ref_map`
    replaced. A ref absent from the map is left exactly as authored, which is how
    only the FOREIGN refs move. The input is never mutated: the archive's doc.json
    is rewritten while the on-disk document stays as the author wrote it.

    Args:
        doc: a serialized document
        ref_map: {old ref string: new ref string}

    Returns:
        dict: a new document

    Examples:
        >>> doc = {"slides": [{"delta": {"items": {"v": {"src": "/asset/Untitled/clip.mp4"}}}}]}
        >>> out = rewritten_asset_refs(doc, {"/asset/Untitled/clip.mp4": "/asset/RobotSim/clip.mp4"})
        >>> out["slides"][0]["delta"]["items"]["v"]["src"]
        '/asset/RobotSim/clip.mp4'
        >>> doc["slides"][0]["delta"]["items"]["v"]["src"]      # input untouched
        '/asset/Untitled/clip.mp4'
    """
    def convert(value):
        if isinstance(value, str):
            return ref_map.get(value, value)
        if isinstance(value, list):
            return [convert(v) for v in value]
        if isinstance(value, dict):
            return {k: convert(v) for k, v in value.items()}
        return value

    return convert(doc)


def localization_plan(refs, project, local_names):
    """
    Pure function. THE PLAN for making a document self-contained as `project`:
    which foreign files must be copied in, under what LOCAL name, and which ref
    string maps to which new ref. The twin of web/assetLocalize.js
    localizationPlan — the two must produce the SAME names, or a server archive
    and a client archive of the same deck would not be interchangeable, which the
    zip round-trip explicitly promises they are.

    De-collision is the ASSET scheme ("logo.png" → "logo-2.png"), matching
    unique_asset_name, and `taken` grows as the plan is built so two foreign files
    with the same basename cannot collide with each other either. Two refs to the
    SAME file share ONE copy.

    THE NEW REF IS RELATIVE ("clip.mp4"), not "/asset/<project>/clip.mp4", and that
    is the point of localizing rather than merely copying bytes. A localized asset is
    BY DEFINITION a file of the project the document is becoming, so naming that
    project inside the ref adds nothing and costs everything: the name is not stable
    across the archive's future. This function writes the folder under whatever name
    the export was asked for, and the IMPORT de-collides again ("RobotSim" →
    "RobotSim 2" when one already exists), so an absolute ref minted here is stale as
    soon as the zip is opened anywhere that already holds that project. The user
    proved it: a RobotSim archive dropped on the static site imported its assets and
    still rendered no video, because the refs named a project that browser had never
    heard of. A relative ref is rename-proof and import-proof by construction. See
    core/asset_ref.js for the two-form grammar; this is its python twin.

    An ALREADY-RELATIVE ref never appears in `refs` at all — document_asset_refs only
    recognizes the absolute form — so it is not planned, not copied and not
    rewritten. That is correct: it already points at this project, and it round-trips
    through an export byte-identically.

    `ref_map` IS KEYED BY THE REF STRING AS THE DOCUMENT SPELLS IT, never by a
    re-minted one: a file part holding a "/" would re-mint as "icons%2Flogo.svg"
    and match nothing, silently leaving the foreign ref in place — the exact class
    of silent hole this whole section closes.

    Args:
        refs: document_asset_refs output
        project: the project the document is becoming
        local_names: asset basenames already present in the project

    Each copy carries its own `ref` (the document's spelling) and `to` (the new
    ref), so a caller that must DROP one copy — the missing-source case in
    zip_project_bytes — can remove exactly its mapping without reverse-engineering
    the key from the name. `ref_map` is the same information flattened for the
    rewrite.

    Returns:
        tuple[list[dict], dict]: ([{"project", "file", "as", "ref", "to"}], {old ref: new ref})

    Examples:
        >>> refs = [{"ref": "/asset/Untitled/clip.mp4", "project": "Untitled", "file": "clip.mp4"},
        ...         {"ref": "/asset/Untitled/clip.mp4", "project": "Untitled", "file": "clip.mp4"}]
        >>> copies, ref_map = localization_plan(refs, "RobotSim", [])
        >>> [(c["file"], c["as"]) for c in copies]
        [('clip.mp4', 'clip.mp4')]
        >>> ref_map
        {'/asset/Untitled/clip.mp4': 'clip.mp4'}
        >>> localization_plan(refs, "RobotSim", ["clip.mp4"])[0][0]["to"]
        'clip-2.mp4'
        >>> localization_plan([{"ref": "/asset/D/a.png", "project": "D", "file": "a.png"}], "D", [])
        ([], {})
    """
    taken = list(local_names)
    copies = []
    ref_map = {}
    for r in refs:
        if r["project"] == project or r["ref"] in ref_map:
            continue  # local, or this exact ref is already planned
        # Only a BASENAME can land in a flat assets/ folder, which is the layout
        # both zip halves write.
        as_name = unique_name_among(os.path.basename(r["file"]), taken)
        taken.append(as_name)
        # THE RELATIVE FORM (see the docstring): the copy lands in THIS project's
        # assets/, so its ref is the bare name — rename-proof and import-proof.
        to = as_name
        copies.append({"project": r["project"], "file": r["file"], "as": as_name,
                       "ref": r["ref"], "to": to})
        ref_map[r["ref"]] = to
    return copies, ref_map


def unique_name_among(filename, taken):
    """
    Pure function. A filename that does not collide with `taken` — the PURE half
    of unique_asset_name, which asks the filesystem. Same "a-2.png" scheme, so a
    localized copy is named the way an upload into the same folder would be.

    Args:
        filename: the wanted basename
        taken: names already used

    Returns:
        str

    Examples:
        >>> unique_name_among("logo.png", [])
        'logo.png'
        >>> unique_name_among("logo.png", ["logo.png"])
        'logo-2.png'
        >>> unique_name_among("logo.png", ["logo.png", "logo-2.png"])
        'logo-3.png'
        >>> unique_name_among("README", ["README"])
        'README-2'
    """
    if filename not in taken:
        return filename
    stem, ext = os.path.splitext(filename)
    n = 2
    while f"{stem}-{n}{ext}" in taken:
        n += 1
    return f"{stem}-{n}{ext}"


def header_safe_warning(warnings):
    """
    Pure function. Warning lines joined into ONE value an HTTP header can carry.

    TWO CONSTRAINTS, both learned by breaking the download:
      * http.server encodes header values as LATIN-1 and raises on anything else.
        An em-dash in a warning (our prose uses them) crashed send_header mid-response,
        so the client got a TRUNCATED body — a warning about a missing asset destroyed
        the archive it was attached to. Non-latin-1 characters are therefore replaced,
        not passed through and not silently dropped.
      * A newline would split the response into forged headers, so lines are joined
        with a separator instead.

    Args:
        warnings (list[str]): warning lines

    Returns:
        str: a single-line latin-1-encodable value

    Examples:
        >>> header_safe_warning(["asset not found: a.png"])
        'asset not found: a.png'
        >>> header_safe_warning(["a", "b"])
        'a | b'
        >>> header_safe_warning(["gone \\u2014 really"])       # em-dash: not latin-1
        'gone ? really'
        >>> header_safe_warning(["one\\ntwo"]).encode("latin-1")
        b'one two'
    """
    joined = " | ".join(w.replace("\n", " ").replace("\r", " ") for w in warnings)
    return joined.encode("latin-1", "replace").decode("latin-1")


def zip_project_bytes(name):
    """
    Query (reads the filesystem, no mutation). ZIP archive bytes of the WHOLE
    project folder (doc.json + every asset, frames cache included), entries
    rooted at "<name>/…" so unzipping recreates the folder. This is the
    user-facing Download format (manifest: "these will just be .zip files").

    THE ARCHIVE IS SELF-CONTAINED. Any ref pointing at ANOTHER project has that
    file COPIED INTO this archive's assets/ under a non-colliding name, and the
    ARCHIVED doc.json's ref rewritten to the local path. The on-disk project is
    untouched — only the archive is rewritten. See the section docblock above for
    the defect and why the ref walk is blind.

    A foreign ref whose SOURCE FILE IS MISSING still exports (a half-broken deck is
    the author's to fix, and refusing the download would strand them), but it is
    REPORTED — never silent. That is the second return value.

    Returns:
        tuple[bytes, list[str]]: the .zip bytes, and warnings naming every foreign
        ref that could not be localized (empty list = fully self-contained).
    """
    d = project_dir(name)
    if not os.path.isdir(d):
        raise FileNotFoundError(f"project not found: {name}")

    warnings = []
    localized_doc = None
    copies = []
    if os.path.isfile(doc_path(name)):
        with open(doc_path(name)) as f:
            doc = json.load(f)
        local_names = [a["name"] for a in list_assets(name)]
        planned, ref_map = localization_plan(document_asset_refs(doc), name, local_names)
        # A planned copy whose source file is gone must NOT be rewritten: pointing
        # the archive at a local file that will not exist trades a findable broken
        # ref for an unfindable one. So it is dropped from the plan and reported.
        for c in planned:
            try:
                src = os.path.join(assets_dir(c["project"]), *c["file"].split("/"))
            except ValueError as exc:
                # safe_name refused the project part: a hand-edited document can
                # name "../.." and must not be allowed to read outside PROJECTS_DIR.
                # Reported, not silently skipped, and the ref stays as authored.
                del ref_map[c["ref"]]
                warnings.append(f"unsafe asset reference {c['ref']!r} in {name}'s document: {exc}")
                continue
            if os.path.isfile(src):
                copies.append({**c, "src": src})
            else:
                del ref_map[c["ref"]]
                warnings.append(
                    f"asset not found: /asset/{c['project']}/{c['file']} — referenced by "
                    f"{name}'s document but missing from that project's assets/; the archive "
                    f"keeps the original reference, which will not resolve after import")
        if ref_map:
            localized_doc = rewritten_asset_refs(doc, ref_map)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(d):
            for fn in files:
                full = os.path.join(root, fn)
                if full.endswith(".tmp"):
                    continue  # never ship an in-flight atomic-write temp
                arcname = os.path.join(name, os.path.relpath(full, d))
                if localized_doc is not None and os.path.samefile(full, doc_path(name)):
                    continue  # the rewritten copy is written below instead
                zf.write(full, arcname)
        if localized_doc is not None:
            zf.writestr(os.path.join(name, DOC_FILENAME), json.dumps(localized_doc, indent=2))
        for c in copies:
            zf.write(c["src"], os.path.join(name, ASSETS_SUBDIR, c["as"]))
    return buf.getvalue(), warnings


# -- Project IMPORT: the inverse of zip_project_bytes ------------------------
# A .zip that LEFT this app comes back as a NEW project folder — never as an
# overwrite of an existing one (a dropped archive is not a save gesture, and the
# user cannot be assumed to have meant "clobber the project of that name"). The
# collision rule is the "Name 2" scheme the request named, deliberately NOT the
# assets' "name-2.png": a project name is prose the toolbar shows, a filename is
# not. The archive is UNTRUSTED input, so every entry is re-validated here
# (zip_relative_path) rather than trusted because we wrote the format: a
# hand-edited archive with "../../etc/passwd" or an absolute member must land
# inside the new folder or be refused loudly. Nothing outside PROJECTS_DIR/<new>
# is ever written.

def zip_root_name(names):
    """
    Pure function. The single top-level folder every archive entry sits under,
    or None when the entries are not rooted in one folder. Our own export roots
    everything at "<project>/…", so that root IS the exported project's name —
    which is how a dropped .zip knows what it wants to be called.

    Args:
        names (list[str]): archive member names (zipfile.namelist()).

    Returns:
        str | None

    Examples:
        >>> zip_root_name(["My Talk/doc.json", "My Talk/assets/a.png"])
        'My Talk'
        >>> zip_root_name(["doc.json", "assets/a.png"])   # flat: no root folder
        >>> zip_root_name(["A/doc.json", "B/doc.json"])   # two roots
    """
    roots = {n.replace("\\", "/").split("/", 1)[0] for n in names if n.strip()}
    if len(roots) != 1:
        return None
    root = roots.pop()
    return root if any(n.replace("\\", "/").startswith(root + "/") for n in names) else None


def zip_relative_path(member, root):
    """
    Pure function. A zip member's path RELATIVE to `root`, validated as a
    contained relative path, or None for entries to skip (directories, the root
    itself, archive metadata). Raises ValueError on a member that tries to
    ESCAPE — absolute paths, drive letters, or any ".." segment — because a
    crafted archive must fail loudly rather than write outside the new project.

    Args:
        member (str): the archive member name
        root (str | None): the archive's single root folder, or None if flat

    Returns:
        str | None: a relative path using "/" separators, or None to skip

    Examples:
        >>> zip_relative_path("My Talk/assets/a.png", "My Talk")
        'assets/a.png'
        >>> zip_relative_path("My Talk/", "My Talk")      # the root dir entry
        >>> zip_relative_path("doc.json", None)
        'doc.json'
        >>> zip_relative_path("__MACOSX/._doc.json", None)
        >>> zip_relative_path("../escape.json", None)     # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ValueError: ...
    """
    path = member.replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise ValueError(f"unsafe zip member (absolute path): {member!r}")
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if ".." in parts:
        raise ValueError(f"unsafe zip member (traversal): {member!r}")
    if root is not None:
        if not parts or parts[0] != root:
            raise ValueError(f"zip member outside the archive root {root!r}: {member!r}")
        parts = parts[1:]
    if not parts or path.endswith("/"):
        return None  # a directory entry — makedirs handles the tree
    if parts[0] == "__MACOSX":
        return None  # Finder's resource-fork sidecar, never a project file
    return "/".join(parts)


def unique_project_name(base):
    """
    Query (reads PROJECTS_DIR). A project name that does not collide: "Talk" if
    free, else "Talk 2", "Talk 3", … — the space-numbered PROSE scheme, distinct
    from unique_asset_name's "a-2.png" filename scheme. An import NEVER
    overwrites, so the caller reports the returned name back to the UI when it
    differs from what the user dropped.

    Examples:
        >>> #  projects/ holding "Talk"  →  unique_project_name("Talk") == "Talk 2"
        >>> unique_project_name("A Name No Project Has")
        'A Name No Project Has'
    """
    safe_name(base)
    candidate = base
    n = 2
    while os.path.exists(os.path.join(PROJECTS_DIR, candidate)):
        candidate = f"{base} {n}"
        n += 1
    return candidate


# ── The zip PROXY for "Open Project from URL" (SSRF surface — read this) ──────
#
# WHY IT EXISTS: a browser cannot fetch a .zip from a host that did not send a
# CORS header, but a SERVER can — CORS is a rule about what a PAGE may read, and
# a server-side fetch is not a page. So in HTTP mode a blocked download retries
# through here. (The static site has no server and therefore no proxy; it shows
# the CORS explanation instead. web/projectUrlImport.js is the client half.)
#
# WHY IT IS DANGEROUS, STATED PLAINLY: this endpoint fetches a URL that an
# ATTACKER may have chosen, from INSIDE the user's network, and returns the body.
# That is textbook SSRF — without limits it would happily read a cloud metadata
# service (169.254.169.254) or a service on the developer's own machine and hand
# the bytes to a web page. THE POLICY SHIPPED, in full:
#
#   1. http(s) ONLY. file:, gopher:, ftp: and friends are refused before any
#      socket is opened.
#   2. NO PRIVATE DESTINATIONS. Every resolved IP for the host must be global —
#      loopback, link-local (incl. the metadata range), RFC1918, CGNAT, unique-
#      local v6 and reserved space are all refused, by asking the `ipaddress`
#      module rather than by pattern-matching the hostname (so "localtest.me"
#      and a DNS name that resolves to 127.0.0.1 are refused too, and there is
#      no allow-list of names to keep up to date).
#   3. NO REDIRECT ESCAPES. Redirects are followed MANUALLY, at most
#      FETCH_ZIP_MAX_REDIRECTS, and every hop is re-checked by 1 and 2 — a
#      public URL that 302s to 127.0.0.1 is the classic bypass and is refused at
#      the hop.
#   4. SIZE CAP. FETCH_ZIP_MAX_BYTES, enforced on the declared Content-Length AND
#      again while streaming (a lying or absent header is the normal case), so a
#      URL pointing at an endless stream cannot exhaust memory or disk.
#   5. STREAMED, not buffered twice: chunks go straight to the client socket.
#
# NOT SHIPPED, deliberately: there is no allow-list of hosts, because the feature
# is "open a deck someone shared with me" and a list would make that useless. The
# refusals above are what makes the open destination set safe.
FETCH_ZIP_MAX_BYTES = 512 * 1024 * 1024  # 512 MB — decks with video are large; endless streams are not welcome
FETCH_ZIP_MAX_REDIRECTS = 5
FETCH_ZIP_CHUNK = 256 * 1024
FETCH_ZIP_TIMEOUT_SEC = 30


def _refuse_private_host(host):
    """
    Query (resolves DNS). Raise ValueError unless every IP `host` resolves to is
    a GLOBAL address. This is rule 2 of the proxy policy above.

    Asking `ipaddress` about the RESOLVED addresses — not about the name — is the
    point: a hostname check can be defeated by a name that simply resolves to
    127.0.0.1, and this cannot.

    Args:
        host (str): Hostname or literal IP from the URL.

    Raises:
        ValueError: loudly naming the address that was refused.

    Examples:
        >>> _refuse_private_host("127.0.0.1")
        Traceback (most recent call last):
            ...
        ValueError: refusing to fetch from a private/loopback address: 127.0.0.1 (127.0.0.1)
        >>> _refuse_private_host("169.254.169.254")
        Traceback (most recent call last):
            ...
        ValueError: refusing to fetch from a private/loopback address: 169.254.169.254 (169.254.169.254)
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"cannot resolve host {host!r}: {exc}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError(f"refusing to fetch from a private/loopback address: {host} ({ip})")


def checked_fetch_url(raw_url):
    """
    Query (DNS). Validate one URL against proxy policy rules 1 and 2, returning
    the parsed result. Every redirect hop is re-checked through this same
    function, which is what makes rule 3 hold.

    Args:
        raw_url (str): The URL to check.

    Returns:
        urllib.parse.ParseResult

    Raises:
        ValueError: on a non-http(s) scheme, a missing host, or a private target.

    Examples:
        >>> checked_fetch_url("file:///etc/passwd")
        Traceback (most recent call last):
            ...
        ValueError: only http:// and https:// URLs can be fetched, got 'file'
        >>> checked_fetch_url("https://example.com/deck.zip").netloc
        'example.com'
    """
    parsed = urllib.parse.urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"only http:// and https:// URLs can be fetched, got {parsed.scheme!r}")
    if not parsed.hostname:
        raise ValueError(f"no host in URL: {raw_url!r}")
    _refuse_private_host(parsed.hostname)
    return parsed


def open_checked_url(raw_url):
    """
    Query (network). Open `raw_url`, following redirects MANUALLY so that every
    hop is re-validated by checked_fetch_url (proxy policy rules 1-3).

    urllib's own redirect handling is what we are avoiding: it would follow a
    302 to 127.0.0.1 without asking anyone, which is exactly the bypass the
    per-hop check closes.

    Args:
        raw_url (str): The (already client-validated) URL to fetch.

    Returns:
        http.client.HTTPResponse: an OPEN response — the caller must close it.

    Raises:
        ValueError: on a policy refusal or too many redirects.

    Examples:
        >>> # resp = open_checked_url("https://example.com/deck.zip")
        >>> # resp.status, resp.headers.get("Content-Length")
        >>> # (200, '10485760')
    """
    url = raw_url
    for _ in range(FETCH_ZIP_MAX_REDIRECTS + 1):
        checked_fetch_url(url)
        # No auto-redirect: `_NoRedirect.redirect_request` returning None makes
        # urllib STOP at the 3xx instead of following it, which is what lets us
        # check the Location before going there.
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(url, headers={"User-Agent": "PowerRP/1.0 (project zip proxy)"})
        try:
            resp = opener.open(req, timeout=FETCH_ZIP_TIMEOUT_SEC)
        except urllib.error.HTTPError as exc:
            # A STOPPED REDIRECT ARRIVES AS AN EXCEPTION, not as a return value —
            # urllib raises HTTPError for any 4xx/5xx AND for a 3xx it was told
            # not to follow. The HTTPError IS the response (same .status,
            # .headers, .read()), so the redirect walk continues from it.
            #
            # THIS WAS A REAL BUG, caught by tests/fetch_zip_proxy_test.py: the
            # loop below used to read `resp.status` from a value that never
            # arrived, so the per-hop re-check was DEAD CODE and every redirect —
            # including a legitimate one to a public CDN, which is exactly how
            # GitHub release downloads work — failed outright instead of being
            # followed and re-validated.
            if exc.status not in (301, 302, 303, 307, 308):
                raise
            resp = exc
        if resp.status not in (301, 302, 303, 307, 308):
            return resp
        location = resp.headers.get("Location")
        resp.close()
        if not location:
            raise ValueError(f"redirect with no Location from {url}")
        # RESOLVED AGAINST THE CURRENT HOP so a relative Location works, and fed
        # back to the top of the loop where checked_fetch_url re-applies rules 1
        # and 2 — that re-check is the whole of policy rule 3.
        url = urllib.parse.urljoin(url, location)
    raise ValueError(f"too many redirects (more than {FETCH_ZIP_MAX_REDIRECTS}) starting at {raw_url}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Handler that does NOT follow redirects, so open_checked_url can check each
    hop itself (proxy policy rule 3)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def import_project_zip(data, requested_name=None):
    """
    Command (mutates the filesystem). Unpack an exported project .zip into a
    NEW project folder and return its name. `requested_name` (the dropped
    file's stem) wins when given; otherwise the archive's own root folder names
    it; a flat archive with neither falls back to "Imported Project". The name
    is de-collided by unique_project_name — an existing project is never
    touched. Every member is re-validated by zip_relative_path, so a crafted
    archive raises rather than writing outside the folder.

    Raises ValueError for a non-zip body, an archive with no doc.json (that is
    not a PowerRP project export), or an unsafe member. Nothing is left behind
    on failure: the partial folder is removed before the error propagates.

    Args:
        data (bytes): the .zip file's bytes
        requested_name (str | None): preferred project name (no extension)

    Returns:
        str: the project name actually created
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"not a .zip archive: {exc}") from exc
    with zf:
        names = zf.namelist()
        root = zip_root_name(names)
        entries = {}
        for member in names:
            rel = zip_relative_path(member, root)
            if rel is not None:
                entries[rel] = member
        if DOC_FILENAME not in entries:
            raise ValueError(f"archive has no {DOC_FILENAME} — not a PowerRP project export")
        base = (requested_name or root or "Imported Project").strip()
        name = unique_project_name(safe_name(base))
        d = os.path.join(PROJECTS_DIR, name)
        try:
            for rel, member in entries.items():
                dest = os.path.join(d, *rel.split("/"))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(member) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
            os.makedirs(os.path.join(d, ASSETS_SUBDIR), exist_ok=True)  # an assetless export still gets the folder
            # AN IMPORT THAT RENAMES MUST REPOINT THE REFS AT THE NEW NAME.
            # The archive's refs name the project it was EXPORTED as, but the
            # folder it lands in is `name` — different whenever the user dropped a
            # renamed .zip or a collision forced "Deck 2". Left alone, every ref
            # becomes FOREIGN the instant it is imported: the assets sit right there
            # in the new folder while the document points at the exporter's name.
            # That resolves anyway on a server holding both projects (which is what
            # made this invisible), 404s on one that does not, and re-creates
            # exactly the dangling-reference bug the self-contained export just
            # fixed. Only refs naming the ARCHIVE'S OWN root move — a deliberately
            # cross-project ref that survived localization (an unreadable source) is
            # not silently re-pointed at a file that does not exist.
            _rename_imported_refs(d, root, name)
            # ARCHIVE ADOPTION, after the rename repoint: an absolute ref whose
            # FILE the archive itself carries goes RELATIVE — the archive is the
            # authority for its own files. This is what heals every
            # pre-localization export (doc says "/asset/Untitled/clip.mp4",
            # archive ships assets/clip.mp4 — the user's real zips), which
            # _rename_imported_refs alone cannot: it only translates the
            # ARCHIVE'S OWN root name. Refs to files the archive does NOT carry
            # stay untouched (deliberate cross-project borrows, loud when
            # missing). Client twin: web/assetLocalize.adoptedArchiveRefs.
            _adopt_archive_refs(d)
        except Exception:
            shutil.rmtree(d, ignore_errors=True)  # never leave a half-written project behind
            raise
    return name


def _adopt_archive_refs(project_path):
    """
    Command (rewrites the imported doc.json in place, only when needed).
    Rewrite every absolute asset ref whose file exists in THIS project's own
    assets/ folder to the RELATIVE form. Runs only at zip import, on the freshly
    unpacked folder — so "this project's assets" IS the archive's contents.
    """
    doc_file = os.path.join(project_path, DOC_FILENAME)
    assets_dir = os.path.join(project_path, ASSETS_SUBDIR)
    have = set()
    if os.path.isdir(assets_dir):
        for base, _dirs, files in os.walk(assets_dir):
            for fn in files:
                have.add(os.path.relpath(os.path.join(base, fn), assets_dir).replace(os.sep, "/"))
    if not have:
        return
    with open(doc_file) as f:
        doc = json.load(f)
    ref_map = {}
    for r in document_asset_refs(doc):
        if r["file"] in have:
            ref_map[r["ref"]] = r["file"]
    if not ref_map:
        return
    doc = rewritten_asset_refs(doc, ref_map)
    with open(doc_file, "w") as f:
        json.dump(doc, f, indent=2)


def _rename_imported_refs(project_path, archive_root, name):
    """
    Command (rewrites the imported doc.json in place). Repoint an imported
    document's asset references and `meta.name` from the archive's root name to
    `name`, the folder it actually landed in. A no-op when they already agree (the
    common case: a .zip imported under the name it was exported as) — including
    NOT rewriting the file, so an unchanged import leaves doc.json byte-identical
    to the archive's.

    `archive_root` may be None for a flat archive, which carries no name to
    translate FROM; the document's own meta.name is then the only candidate.
    """
    doc_file = os.path.join(project_path, DOC_FILENAME)
    with open(doc_file) as f:
        doc = json.load(f)
    old = archive_root or (doc.get("meta") or {}).get("name")
    if not old or old == name:
        return
    # Each PATH SEGMENT is quoted separately (quote(..., safe="/") would keep a
    # nested path's slashes as separators, which is how parse_asset_ref reads them
    # back), so a ref only ever changes its PROJECT part here.
    ref_map = {r["ref"]: asset_ref(name, r["file"]) for r in document_asset_refs(doc) if r["project"] == old}
    out = rewritten_asset_refs(doc, ref_map)
    # The one-name model: the document's meta.name must agree with the folder it
    # lives in (the client's loadProject asserts the same thing).
    out.setdefault("meta", {})["name"] = name
    with open(doc_file, "w") as f:
        json.dump(out, f, indent=2)


# -- Session clipboard (manifest 14.10 AMENDED) ------------------------------
# The user copies an item in one open presentation and pastes it in ANOTHER: a
# per-BROWSER clipboard the server tracks, keyed by a session cookie, so the two
# tabs share it (verbatim user ruling: "u can copy it into the browser cookie
# session thing in case i have two presentations open the server can keep track
# of that"). The item's serialized JSON lives HERE, not on the OS clipboard —
# the OS clipboard gets a rendered PNG instead (client side). Paste reads this.
#
# In-memory only (per-process): a server restart empties it, which is fine —
# the clipboard is a transient scratch, not saved state. FLAGGED for the user:
# no cross-restart persistence and no TTL eviction (an idle session's payload
# lingers until restart). ThreadingHTTPServer serves requests on many threads,
# so the store is guarded by a lock. Values are the RAW payload STRING the
# client sends (opaque JSON) — the server never parses it, so a future payload
# shape needs no server change.
SESSION_COOKIE = "powerrp_session"
_clipboard_lock = threading.Lock()
_session_clipboards = {}  # session id (str) -> last-copied payload (str)


def clipboard_set(session_id, payload):
    """Command (mutates the in-memory store). Store `payload` (str) for `session_id`."""
    with _clipboard_lock:
        _session_clipboards[session_id] = payload


def clipboard_get(session_id):
    """Query. The last payload stored for `session_id`, or None if the session never copied."""
    with _clipboard_lock:
        return _session_clipboards.get(session_id)


# -- HTTP handler ------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """
    Routes (every /api prefix keeps a TRAILING SLASH so the Vite proxy never
    swallows the app's own /api*.js modules — see vite.config.js):

      GET  /api/projects/            → [{name, mtime, slideCount}]
      GET  /api/clipboard/           → {payload:<str|null>} (this session's copy)
      PUT  /api/clipboard/           → body {payload:<str>}; {ok}; session-cookied
      GET  /api/project/<name>/      → {doc, assets}
      PUT  /api/project/<name>/      → body = doc JSON; {ok, name}
      GET  /api/assets/<name>/       → [{name, size, kind, url}]
      POST /api/upload/<name>/?filename=…  → raw body bytes; {ok, name: file}
      POST /api/thumb/<name>/<file>/?mtime=&badge=  → raw PNG body; caches an
                                     asset thumbnail (manifest #25); {ok, thumbnail}
      POST /api/export-mp4/          → mint an MP4-export session; {ok, sessionId}
      POST /api/export-mp4/<sid>/frame/<i>/  → raw PNG body; store frame i (0-based)
      POST /api/export-mp4/<sid>/encode/     → body {fps, crf}; ffmpeg-encode the
                                     session's PNGs → video/mp4 bytes; cleans up
      GET  /api/download/<name>/     → application/zip of the whole folder
      POST /api/import-zip/?name=…   → raw .zip body; unpacks it as a NEW
                                     project (never an overwrite); {ok, name,
                                     requested} — name != requested means the
                                     drop collided and was renamed
      POST /api/rename-project/<old>/<new>/  → MOVE projects/<old> → <new>
                                     (one os.rename); {ok, name}. 404 = no such
                                     source, 409 = destination taken (never
                                     merges or overwrites)
      POST /api/copy-assets/<src>/<dst>/  → SAVE-AS fork: duplicate <src>'s
                                     assets/ into <dst> server-side;
                                     {ok, copied:[…], skipped:[…]}
      GET  /api/frames/<name>/<video>/<N>/  → {count, frames:[url,…]}
                                     (extract N evenly-spread frames, cached)
      DELETE /api/asset/<name>/<file>/  → delete one asset (+ its frame cache);
                                     {ok, name: file}; 404 if absent
      GET  /asset/<name>/<file…>     → the asset file (Range-supported; a file
                                       may be a frames/<video>/<N>/… subpath)
    """

    server_version = "PowerRPProjectServer/0.1"

    # -- low-level response helpers --

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # A cross-origin fetch() cannot READ a response header unless it is
        # exposed. X-PowerRP-Warning is how the .zip download reports an asset it
        # could not localize (the body is the archive, so there is nowhere else to
        # put it) — unexposed, that warning would be silently unreadable in exactly
        # the ?backend= setup the probes and the desktop shell run in.
        self.send_header("Access-Control-Expose-Headers", "X-PowerRP-Warning")

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

    # -- session clipboard (manifest 14.10 AMENDED) --
    # Read the browser session id from the request cookie, minting a fresh one
    # when the browser has none yet. Returns (session_id, is_new): the caller
    # Set-Cookies it back only when new, so an existing session sticks. The
    # cookie is same-origin in normal use (the Vite proxy fronts /api), so it
    # round-trips without CORS-credentials gymnastics.
    def _session(self):
        raw = self.headers.get("Cookie")
        if raw:
            jar = http.cookies.SimpleCookie(raw)
            if SESSION_COOKIE in jar and jar[SESSION_COOKIE].value:
                return jar[SESSION_COOKIE].value, False
        return uuid.uuid4().hex, True

    def _set_session_cookie(self, session_id):
        # HttpOnly (JS never needs to read it) + SameSite=Lax + Path=/ so every
        # /api call carries it. No Secure flag: the dev server is plain HTTP on
        # localhost.
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}={session_id}; Path=/; HttpOnly; SameSite=Lax")

    def _handle_clipboard_get(self):
        """GET /api/clipboard/ → {payload: <str|null>}. Reads THIS session's clipboard."""
        session_id, is_new = self._session()
        payload = None if is_new else clipboard_get(session_id)
        body = json.dumps({"payload": payload}).encode()
        self.send_response(200)
        self._cors()
        if is_new:
            self._set_session_cookie(session_id)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_clipboard_set(self):
        """PUT /api/clipboard/ → body {payload: <str>}; stores it for THIS session; {ok:true}."""
        session_id, is_new = self._session()
        body = json.loads(self._read_body() or b"{}")
        payload = body.get("payload")
        if not isinstance(payload, str):
            return self._error(400, "clipboard set: body must be {payload: <string>}")
        clipboard_set(session_id, payload)
        out = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self._cors()
        if is_new:
            self._set_session_cookie(session_id)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        parsed, parts = self._parts()
        try:
            if parts == ["api", "projects"]:
                return self._json(list_projects())
            if parts == ["api", "clipboard"]:  # session clipboard (14.10 AMENDED)
                return self._handle_clipboard_get()
            if len(parts) == 3 and parts[:2] == ["api", "project"]:
                return self._handle_load(parts[2])
            if len(parts) == 3 and parts[:2] == ["api", "assets"]:
                return self._json(list_assets(parts[2]))
            if len(parts) == 3 and parts[:2] == ["api", "download"]:
                return self._handle_download(parts[2])
            if len(parts) == 5 and parts[:2] == ["api", "frames"]:
                return self._handle_frames(parts[2], parts[3], parts[4], parsed.query)
            if len(parts) == 4 and parts[:2] == ["api", "duration"]:
                return self._handle_duration(parts[2], parts[3])
            if len(parts) == 3 and parts[:2] == ["api", "render-jobs"]:
                return self._json({"jobs": list_jobs(parts[2])})
            if parts == ["api", "fetch-zip"]:
                # "Open Project from URL" when the browser's own fetch was blocked
                # by CORS. Attacker-supplied URL => read the SSRF policy block
                # above checked_fetch_url before touching this.
                return self._handle_fetch_zip(parsed.query)
            if len(parts) >= 3 and parts[0] == "render":
                # parts[1] = project, parts[2:] = a file inside renders/. Served
                # with Range support so the modal's <video> can seek the result.
                return self._serve_render(parts[1], "/".join(parts[2:]))
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
            if parts == ["api", "clipboard"]:  # session clipboard (14.10 AMENDED)
                return self._handle_clipboard_set()
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
            if len(parts) == 4 and parts[:2] == ["api", "thumb"]:
                return self._handle_thumb_store(parts[2], parts[3], parsed)
            if parts == ["api", "import-zip"]:  # a dropped/picked .zip → a new project
                return self._handle_import_zip(parsed)
            if len(parts) == 4 and parts[:2] == ["api", "rename-project"]:
                # RENAME = MOVE projects/<old> → projects/<new>. One request, one
                # os.rename; the relative refs inside travel unchanged.
                return self._handle_rename_project(parts[2], parts[3])
            if len(parts) == 4 and parts[:2] == ["api", "copy-assets"]:
                # SAVE-AS = FORK: duplicate <src>'s library into <dst> server-side,
                # so a large video never transits the browser. Rename does NOT use
                # this — it moves (above).
                return self._handle_copy_assets(parts[2], parts[3])
            if parts == ["api", "export-mp4"]:  # server-side MP4 export
                return self._handle_export_begin()
            if len(parts) == 5 and parts[:2] == ["api", "export-mp4"] and parts[3] == "frame":
                return self._handle_export_frame(parts[2], parts[4])
            if len(parts) == 4 and parts[:2] == ["api", "export-mp4"] and parts[3] == "encode":
                return self._handle_export_encode(parts[2])
            # -- detached render jobs --
            if len(parts) == 3 and parts[:2] == ["api", "render-jobs"]:
                return self._handle_job_submit(parts[2])
            if len(parts) == 5 and parts[:2] == ["api", "render-job"] and parts[4] in ("cancel", "seen", "finish"):
                return self._handle_job_action(parts[2], parts[3], parts[4])
            if len(parts) == 6 and parts[:2] == ["api", "render-job"] and parts[4] == "frame":
                return self._handle_job_frame(parts[2], parts[3], parts[5])
            if len(parts) == 5 and parts[:2] == ["api", "render-job"] and parts[4] == "output":
                return self._handle_job_output(parts[2], parts[3], parsed)
            self._error(404, f"no POST route for {parsed.path}")
        except Exception as exc:
            traceback.print_exc()
            self._error(500, f"{type(exc).__name__}: {exc}")

    def do_DELETE(self):
        parsed, parts = self._parts()
        try:
            if len(parts) == 4 and parts[:2] == ["api", "asset"]:
                return self._handle_delete_asset(parts[2], parts[3])
            if len(parts) == 4 and parts[:2] == ["api", "render-job"]:
                delete_job(parts[2], parts[3])
                return self._json({"ok": True, "id": parts[3]})
            self._error(404, f"no DELETE route for {parsed.path}")
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

    def _handle_thumb_store(self, name, filename, parsed):
        # Persist a client-rendered thumbnail PNG for an asset (manifest #25).
        # The server has no PDF engine, so the CLIENT rasterizes page 1 (pdfjs)
        # and POSTs the PNG here with ?mtime= (the asset's mtime, the cache key)
        # and an optional ?badge= (e.g. the page count). The asset must exist.
        q = urllib.parse.parse_qs(parsed.query)
        mtime_str = q.get("mtime", [""])[0]
        badge = q.get("badge", [None])[0]
        if not mtime_str:
            return self._error(400, "thumb store requires ?mtime=")
        try:
            mtime = float(mtime_str)  # save_thumb keys it to microseconds (mtime_key)
        except ValueError:
            return self._error(400, f"thumb mtime must be a number: {mtime_str!r}")
        asset_path = os.path.join(assets_dir(name), safe_name(filename))
        if not os.path.isfile(asset_path):
            return self._error(404, f"asset not found: {name}/{filename}")
        data = self._read_body()
        if not data:
            return self._error(400, "empty thumbnail body")
        url = save_thumb(name, filename, mtime, badge, data)
        self._json({"ok": True, "thumbnail": url, "badge": badge})

    def _handle_rename_project(self, old, new):
        # RENAME = MOVE the folder (see rename_project). The client has ALREADY
        # relativized the document's own-project absolute refs and saved, so
        # nothing inside the folder needs rewriting here.
        #
        # THE TWO REFUSALS ARE DISTINCT STATUSES because they are distinct client
        # states: a missing source is a stale listing (404); an occupied
        # destination is a name the user must choose again (409). Collapsing both
        # into a 500 would make "pick another name" look like a server fault.
        try:
            rename_project(old, new)
        except FileNotFoundError as exc:
            return self._error(404, str(exc))
        except FileExistsError as exc:
            return self._error(409, str(exc))
        self._json({"ok": True, "name": new})

    def _handle_copy_assets(self, src, dst):
        # SAVE-AS carrying the library: copy projects/<src>/assets/ →
        # projects/<dst>/assets/ SERVER-SIDE, so a fork of a deck holding a large
        # video never pulls those bytes through the browser. The destination
        # project's doc.json is written separately by the ordinary save.
        try:
            result = copy_project_assets(src, dst)
        except ValueError as exc:
            return self._error(400, str(exc))
        self._json({"ok": True, **result})

    def _handle_export_begin(self):
        # Mint a server-side MP4-export session (the server owns the uuid so the
        # client needs no secure-context crypto). The client POSTs frames + an
        # encode request keyed by the returned id.
        session_id = begin_export_session()
        self._json({"ok": True, "sessionId": session_id})

    def _handle_export_frame(self, session_id, index_str):
        # Store one rendered PNG frame (raw body) as frame <index> (0-based) of
        # the export session. Awaited per-frame by the client so RAM stays flat
        # and frames land in order. Unknown session → 404 (an expected client
        # state, e.g. a server restart between begin and frame).
        try:
            index = int(index_str)
        except ValueError:
            return self._error(400, f"frame index must be an integer: {index_str!r}")
        data = self._read_body()
        if not data:
            return self._error(400, "empty frame body")
        try:
            save_export_frame(session_id, index, data)
        except FileNotFoundError as exc:
            return self._error(404, str(exc))
        self._json({"ok": True, "index": index})

    def _handle_export_encode(self, session_id):
        # Encode the session's uploaded PNGs into an MP4 (libx264) and return the
        # video/mp4 bytes; the session scratch is deleted by encode_export_mp4.
        # fps/crf are validated defensively (never trust the client): fps must be
        # a positive number, crf an integer in the codec's [0,51] range.
        body = json.loads(self._read_body() or b"{}")
        fps = body.get("fps")
        crf = body.get("crf")
        if not isinstance(fps, (int, float)) or isinstance(fps, bool) or fps <= 0:
            return self._error(400, f"encode requires a positive numeric fps (got {fps!r})")
        if not isinstance(crf, (int, float)) or isinstance(crf, bool) or crf < H264_CRF_MIN or crf > H264_CRF_MAX:
            return self._error(400, f"encode requires a crf in [{H264_CRF_MIN},{H264_CRF_MAX}] (got {crf!r})")
        try:
            data = encode_export_mp4(session_id, fps, int(crf))
        except FileNotFoundError as exc:
            return self._error(404, str(exc))
        self._send_bytes(data, "video/mp4")

    def _handle_delete_asset(self, name, filename):
        # Asset delete (manifest Round 12C: trash can on the asset tile). A
        # missing asset is a 404, not a 500 — deleting twice / a stale list is
        # an expected client state, reported distinctly. delete_asset also
        # removes the asset's filmstrip frame cache.
        try:
            delete_asset(name, filename)
        except FileNotFoundError as exc:
            return self._error(404, str(exc))
        self._json({"ok": True, "name": filename})

    def _handle_download(self, name):
        # The archive is SELF-CONTAINED: zip_project_bytes copies in any asset the
        # document borrows from another project and rewrites the archived doc.json
        # (see its docblock for the defect that required it).
        #
        # WARNINGS TRAVEL AS A HEADER, not in the body, because the body IS the
        # .zip — there is nowhere else to put them. X-PowerRP-Warning carries them
        # for a client that reads it (fetch can, an <a download> cannot), and
        # stderr carries them unconditionally so an unlocalizable asset is never
        # silent even when the download was a plain link click.
        data, warnings = zip_project_bytes(name)
        for w in warnings:
            print(f"[download {name}] {w}", file=sys.stderr)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{name}.zip"')
        self.send_header("Content-Length", str(len(data)))
        if warnings:
            self.send_header("X-PowerRP-Warning", header_safe_warning(warnings))
        self.end_headers()
        self.wfile.write(data)

    def _handle_import_zip(self, parsed):
        # The inverse of _handle_download: a raw .zip body becomes a NEW project.
        # ?name= is the dropped file's stem (the client strips ".zip"); absent, the
        # archive's own root folder names it. A bad/unsafe archive is a 400 (the
        # client's fault, an expected condition), never a 500 — and the response
        # always carries BOTH the requested and the final name so the UI can say
        # "imported as 'Talk 2'" instead of silently landing somewhere else.
        q = urllib.parse.parse_qs(parsed.query)
        requested = q.get("name", [""])[0].strip() or None
        data = self._read_body()
        if not data:
            return self._error(400, "empty import body")
        try:
            name = import_project_zip(data, requested)
        except ValueError as exc:
            return self._error(400, str(exc))
        self._json({"ok": True, "name": name, "requested": requested or name})

    def _handle_fetch_zip(self, query):
        # GET /api/fetch-zip/?url=… -> the remote .zip's BYTES, streamed.
        #
        # THE ONLY REASON THIS EXISTS is CORS: the browser refuses to hand a page
        # bytes from a host that did not opt in, and a server is not subject to
        # that rule. It is therefore a FALLBACK the client tries only after its
        # own direct fetch failed (web/projectUrlImport.js fetchZipBytes), never
        # the default route — a large deck should not transit this server twice.
        #
        # Its refusals are the SSRF policy documented above checked_fetch_url: a
        # bad scheme, a private/loopback destination or a redirect into one is a
        # 400 with the reason (the client's URL is at fault, an expected
        # condition), and oversize is a 400 too. A 500 here would mean a bug.
        q = urllib.parse.parse_qs(query)
        raw_url = q.get("url", [""])[0].strip()
        if not raw_url:
            return self._error(400, "fetch-zip needs ?url=<http(s) url of a .zip>")
        try:
            resp = open_checked_url(raw_url)
        except ValueError as exc:
            return self._error(400, f"fetch-zip refused {raw_url}: {exc}")
        except Exception as exc:  # a dead host / TLS failure is the CALLER's URL being wrong
            return self._error(400, f"fetch-zip could not reach {raw_url}: {type(exc).__name__}: {exc}")
        with resp:
            if resp.status != 200:
                return self._error(400, f"fetch-zip: {raw_url} answered HTTP {resp.status}")
            declared = resp.headers.get("Content-Length")
            if declared and int(declared) > FETCH_ZIP_MAX_BYTES:
                return self._error(400, f"fetch-zip refused {raw_url}: {int(declared)} bytes exceeds the {FETCH_ZIP_MAX_BYTES} byte cap")
            # Headers go out BEFORE the body so the browser's progress bar has a
            # denominator whenever the origin gave us one. Content-Length is
            # forwarded only when it is trustworthy enough to matter; without it
            # the client reports bytes-so-far, which the boot splash already does.
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/zip")
            if declared:
                self.send_header("Content-Length", declared)
            self.end_headers()
            # STREAM. Never read the whole archive into memory: these are decks
            # with video in them, and the cap is 512 MB.
            total = 0
            while True:
                chunk = resp.read(FETCH_ZIP_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > FETCH_ZIP_MAX_BYTES:
                    # The response is already committed, so this cannot become a
                    # 400 — the connection is CUT and the reason is logged, which
                    # surfaces client-side as a truncated (invalid) zip plus this
                    # line in the server log. Loud in both places.
                    print(f"[fetch-zip] ABORTED {raw_url}: exceeded the {FETCH_ZIP_MAX_BYTES} byte cap mid-stream", file=sys.stderr)
                    raise ValueError(f"fetch-zip: {raw_url} exceeded the {FETCH_ZIP_MAX_BYTES} byte cap mid-stream")
                self.wfile.write(chunk)
            print(f"[fetch-zip] {raw_url} -> {total} bytes", file=sys.stderr)

    def _handle_frames(self, name, video, n_str, query=""):
        # Filmstrip: N evenly-spread frames of a project video, cached under
        # assets/frames/<video>/<N>/[<WxH>/] (cache hit = no re-extraction).
        # Optional ?h=&w= per-frame extraction resolution (manifest 14.1; absent
        # = native). Errors (bad N/H/W, missing video, ffmpeg/ffprobe failure)
        # surface loudly.
        try:
            n = int(n_str)
        except ValueError:
            return self._error(400, f"frame count must be an integer: {n_str!r}")
        qs = urllib.parse.parse_qs(query)
        try:
            frame_h = int(qs["h"][0]) if "h" in qs else None
            frame_w = int(qs["w"][0]) if "w" in qs else None
        except ValueError:
            return self._error(400, f"frame h/w must be integers: {query!r}")
        if (frame_h is not None and frame_h <= 0) or (frame_w is not None and frame_w <= 0):
            return self._error(400, f"frame h/w must be positive: {query!r}")
        self._json(extract_frames(name, video, n, frame_h, frame_w))

    def _handle_duration(self, name, video):
        # GET /api/duration/<project>/<video> -> {durationSec}. The deterministic
        # ffprobe container duration of ONE project video (the `self.length` a
        # time-driven scrubber's presets divide by). Same on-disk resolution +
        # containment as the frames endpoint; a missing/unprobeable file is loud.
        video_file = os.path.join(assets_dir(name), safe_name(video))
        if not os.path.isfile(video_file):
            return self._error(404, f"video asset not found: {name}/{video}")
        self._json({"durationSec": video_duration_seconds(video_file)})

    # -- detached render jobs --

    def _serve_render(self, name, filename):
        """Serve a finished movie out of a project's renders/ folder, Range-supported
        (the modal plays it inline). Same containment guard as _serve_asset."""
        if "\x00" in filename:
            return self._error(400, f"bad render path: {name}/{filename}")
        d = renders_dir(name)
        full = os.path.normpath(os.path.join(d, filename))
        if not full.startswith(d + os.sep) or not os.path.isfile(full):
            return self._error(404, f"render not found: {name}/{filename}")
        self._serve_file(full, content_type_for(full))

    def _handle_job_submit(self, name):
        """
        POST /api/render-jobs/<project>/ -- body {name, backend, framesTotal, params, doc}.
        SNAPSHOTS doc into the job and (server backend) queues it. Returns {job}.
        """
        body = json.loads(self._read_body() or b"{}")
        doc = body.get("doc")
        params = body.get("params")
        backend = body.get("backend")
        if not isinstance(doc, dict) or not isinstance(params, dict):
            return self._error(400, "render job submit: body needs {doc, params}")
        if backend not in ("server", "client"):
            return self._error(400, f"render job submit: backend must be 'server' or 'client', got {backend!r}")
        # NAME THE VALUE. This refusal used to omit it while its sibling in
        # _handle_export_encode already included one, and that asymmetry made a real
        # 400 unattributable: JSON.stringify DROPS an undefined key, so a client-side
        # lookup miss arrives as a *missing* crf and the server complained about "an
        # int" without saying it had received nothing at all. The producer side is now
        # loud too (RenderCenterModal.presetCrf).
        #
        # KNOWN ASYMMETRY, deliberately left: this endpoint demands a strict int,
        # while _handle_export_encode accepts (int, float) and narrows with int(crf).
        # The same value is therefore accepted by one route and refused by the other.
        # Every client currently sends an int on both, so tightening the other route
        # is an untested behaviour change rather than a fix — flagged, not guessed at.
        crf = params.get("crf")
        if not isinstance(crf, int) or isinstance(crf, bool) or not (H264_CRF_MIN <= crf <= H264_CRF_MAX):
            return self._error(400, f"render job submit: crf must be an int in [{H264_CRF_MIN}, {H264_CRF_MAX}] (got {crf!r})")
        if not params.get("fps", 0) > 0:
            return self._error(400, "render job submit: fps must be > 0")
        # MOTION BLUR used to be refused for the server backend, because the
        # bare-node renderer had no canvas to average sub-frames on. The worker now
        # drives the SAME createFrameSampler the in-browser export does, in a real
        # browser, so both backends blur identically and there is nothing to refuse.
        job_name = str(body.get("name") or "").strip() or "Render"
        try:
            safe_name(job_name)
        except ValueError:
            return self._error(400, f"render job submit: name is not a valid filename: {job_name!r}")
        record = create_job(name, params, doc, job_name, backend)
        frames_total = body.get("framesTotal")
        if isinstance(frames_total, int) and frames_total > 0:
            # The client already built the timeline for its own UI; the worker
            # recomputes the identical number from the same pure helpers on the
            # same snapshot. This copy exists only so the progress bar has a
            # denominator before the first frame lands.
            record = update_job(name, record["id"], framesTotal=frames_total)
        if backend == "server":
            enqueue_job(name, record["id"])
        else:
            record = update_job(name, record["id"], state="rendering", startedAt=time.time())
        self._json({"job": job_view(name, record)})

    def _handle_job_action(self, name, job_id, action):
        """POST /api/render-job/<project>/<id>/{cancel,seen,finish}/ → {job}."""
        if action == "cancel":
            return self._json({"job": job_view(name, cancel_job(name, job_id))})
        if action == "seen":
            return self._json({"job": job_view(name, update_job(name, job_id, seen=True))})
        # finish: the CLIENT backend has uploaded every frame and wants the shared
        # encode. Same ffmpeg step the server backend uses -- one encode, one
        # output location, one job list.
        record = read_job(name, job_id)
        if record["backend"] != "client":
            return self._error(400, f"render job {job_id} is a {record['backend']} job -- only a client job is finished by the browser")
        if record["state"] not in JOB_ACTIVE_STATES:
            return self._error(400, f"render job {job_id} is already {record['state']}")
        record = update_job(name, job_id, state="encoding", framesDone=count_job_frames(name, job_id))
        try:
            out_name = encode_job_output(name, job_id, record)
        except Exception as exc:
            traceback.print_exc()
            update_job(name, job_id, state="failed", error=f"{type(exc).__name__}: {exc}", finishedAt=time.time())
            raise
        record = update_job(name, job_id, state="done", output=out_name, finishedAt=time.time(), seen=False)
        self._json({"job": job_view(name, record)})

    def _handle_job_frame(self, name, job_id, index):
        """POST /api/render-job/<project>/<id>/frame/<n>/ -- one PNG from the CLIENT
        backend, written into the SAME frames dir the server workers would fill."""
        record = read_job(name, job_id)
        if record["state"] not in JOB_ACTIVE_STATES:
            return self._error(409, f"render job {job_id} is {record['state']} -- not accepting frames")
        data = self._read_body()
        if not data:
            return self._error(400, "empty frame body")
        frames = job_frames_dir(name, job_id)
        os.makedirs(frames, exist_ok=True)
        path = os.path.join(frames, f"frame_{int(index):0{EXPORT_FRAME_PAD}d}.png")
        # Atomic, exactly like the headless worker: the frame COUNT is the progress
        # signal, so a partially-received PNG must never be counted.
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
        self._json({"ok": True, "index": int(index)})

    def _handle_job_output(self, name, job_id, parsed):
        """
        POST /api/render-job/<project>/<id>/output/?frames=N -- the FINISHED MOVIE
        for a browser job that encoded IN THE PAGE (web/mp4Encoder.js: a wasm H.264
        encoder, so nothing was ever uploaded frame by frame). Body = the .mp4 bytes.

        WHY THIS EXISTS ALONGSIDE `finish`: `finish` means "the frames are on your
        disk, run ffmpeg"; this means "here is the encoded movie". Both end the SAME
        job record in the SAME renders/ folder, which is what keeps the two backends
        one list rather than two systems. The frame COUNT rides in the query string
        because a page-encoded job leaves no frames on disk for the server to count.

        Written atomically (.part then rename) so a half-received upload can never
        be served as a finished render, and refused loudly for a job that is not an
        active browser job.
        """
        record = read_job(name, job_id)
        if record["backend"] != "client":
            return self._error(400, f"render job {job_id} is a {record['backend']} job -- only a browser job delivers its own movie")
        if record["state"] not in JOB_ACTIVE_STATES:
            return self._error(400, f"render job {job_id} is already {record['state']}")
        frames = urllib.parse.parse_qs(parsed.query).get("frames", ["0"])[0]
        if not frames.isdigit() or int(frames) <= 0:
            return self._error(400, f"render job output: frames must be a positive integer, got {frames!r}")
        data = self._read_body()
        if not data:
            return self._error(400, "empty movie body")
        os.makedirs(renders_dir(name), exist_ok=True)
        out_name = unique_output_name(name, record["name"])
        out_path = os.path.join(renders_dir(name), out_name)
        with open(out_path + ".part", "wb") as f:
            f.write(data)
        os.replace(out_path + ".part", out_path)
        # The page-side encode leaves no PNG scratch, but a job that was RESUMED
        # from the upload encoder might have some -- drop it either way.
        shutil.rmtree(job_frames_dir(name, job_id), ignore_errors=True)
        record = update_job(name, job_id, state="done", output=out_name,
                            framesDone=int(frames), framesTotal=int(frames),
                            finishedAt=time.time(), seen=False)
        self._json({"job": job_view(name, record)})

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
    # PUBLISH OUR OWN ORIGIN for the render worker: its Vite dev server proxies
    # /api and /asset here, which is how a project's image/video/PDF assets reach
    # the render page. Set before the supervisor starts, so a job resumed by the
    # boot sweep below already has it. An explicit BACKEND_URL wins (a reverse
    # proxy or a non-localhost bind).
    os.environ.setdefault("BACKEND_URL", f"http://localhost:{port}")
    print(f"Projects: {PROJECTS_DIR}  ({len(list_projects())} projects)", file=sys.stderr)
    # THE render supervisor: one daemon thread draining one FIFO queue, so exactly
    # one job renders at a time (each already fans out across RENDER_WORKER_COUNT
    # processes). Started before the reconcile sweep so a resumed job has somewhere
    # to go. Daemon: a Ctrl-C must not be held up by an in-flight render, and
    # nothing is lost if it is killed — the job dir survives and the next boot
    # resumes it.
    threading.Thread(target=_supervise, daemon=True, name="powerrp-render").start()
    print(f"Render workers per job: {RENDER_WORKER_COUNT}", file=sys.stderr)
    resume_interrupted_jobs()
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
