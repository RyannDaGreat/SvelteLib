# Video Slice Annotator

A small app for annotating a flat folder of videos: mark **good/bad** time ranges
and drop **comments** at specific timecodes, across many clips, with the results
saved as one JSON per video.

It is a Python backend (stdlib `http.server`, no framework) plus a Svelte
frontend built from the reusable components in this repo's `src/lib/`
(`ScrubSelect`/`AnnotateBar` timeline, `PanZoom`, `SplitView`/`SplitPane`,
`MiniMap`, `Dropdown`, …).

> Status: backend is complete and tested. Frontend is in progress — see
> `../.claude_todo.md` for the live task list.

---

## Glossary

- **Timeline cursor** — the white playhead bar on the timeline marking the
  currently-displayed frame. Comments are inserted at the timeline cursor.
- **Capture mode** — Pointer-Lock scrub mode: click the timeline to lock the
  cursor to its mid-line; horizontal motion scrubs, `Esc` exits.
- **Proposed selection** — the striped range under an active paint drag (not yet
  committed).
- **Proxy / low-res** — a tiny (~1/30 size) re-encode of a source video used for
  instant scrubbing while the full-res stream catches up. Built lazily into the
  cache.
- **Cache** (`./cache/`) — gitignored, regenerable: holds low-res proxies
  (`cache/lowres_videos/<name>-lowres.mp4`) and extracted frame JPEGs
  (`cache/frames/<name>/<frame_index>.jpg`).
- **Outputs** (`./outputs/`) — one annotation JSON per video
  (`outputs/<name>.json`). This is the actual work product.

## Assumptions

- The videos directory is a **flat** folder of `.mp4` files (no recursion).
- **Every video filename is unique** — names are treated as globally-unique,
  hashed IDs (the source pipeline guarantees this), so `<name>` is the single
  key tying together the source video, its cache artifacts, and its annotation
  JSON. The same name must never refer to two different videos, ever.
- A video's **name** is its filename without the `.mp4` extension.

## Annotation JSON shape

`outputs/<name>.json`:

```json
{
  "labels":   [ { "label": "good", "start": 1.0, "end": 3.0 } ],
  "comments": [ { "text": "blurry here", "time": 2.4 } ]
}
```

`label` is `"good"` or `"bad"`; `start`/`end`/`time` are seconds.

---

## Running

Backend (resolves deps via `uv` + the PEP-723 block in `server.py`):

```bash
./start_server.sh                          # default videos dir, port 8000
./start_server.sh --videos_dir=/my/clips   # any flat folder of .mp4
./start_server.sh --port=9000
```

Optionally pre-build every proxy up front (the server also builds them lazily on
first request):

```bash
uv run server.py pre_compute_small_videos --videos_dir=/my/clips
```

Frontend: run the repo's Vite dev server (`npm run dev`) and open the app; it
talks to the backend at `http://localhost:8000` (CORS-enabled).

## HTTP API

| Method | Route | Returns |
| --- | --- | --- |
| GET | `/api/videos` | `[{name, duration, hasAnnotations}]` for every clip |
| GET | `/api/annotation/<name>` | the annotation JSON (or empty `{labels,comments}`) |
| PUT | `/api/annotation/<name>` | writes the JSON body to `outputs/<name>.json` |
| GET | `/video/<name>` | full source MP4, **HTTP Range** supported (seeking) |
| GET | `/lowres/<name>` | low-res proxy MP4 (built into cache on first request) |
| GET | `/frame/<name>?t=<sec>` | JPEG of the frame nearest `t` (cached) |

Proxies use ffmpeg (`scale=-2:180, fps=12, libx264 crf 32`, frequent keyframes).
Frames are decoded with `rp.load_video_via_rs` (fast Rust+FFmpeg) and encoded
with `rp.encode_image_to_bytes`. On any failure the server prints the full
traceback and returns a 500 with the error message — never a silent fallback.

## Portability / WOM

The **code is portable** — it works against any folder passed with
`--videos_dir`, and detects `ffmpeg`/`uv` at runtime. The only machine-specific
bit is `DEFAULT_VIDEOS_DIR` in `server.py` (a convenience default pointing at a
local Downloads folder); always override it with `--videos_dir`. `ffmpeg` must
be on `PATH` (override per-run with `--ffmpeg=...`). `cache/` and `outputs/*.json`
are gitignored and regenerable.

## Planned GUI (from design notes)

- **Left pane**: scrollable list of video thumbnails (frame JPEG + duration),
  yellow-outlined if annotated; filter + sort dropdowns; draggable/resizable
  split from the main area. Click a thumbnail to load that video.
- **Main pane**: a pan/zoom video area (with minimap via the `/frame` endpoint,
  click-to-reset), a draggable split above the timeline, the `ScrubSelect`
  timeline, and a control bar (play/pause, speed, undo/redo, comment).
- **Comments**: press `C` (or the comment button) to insert at the timeline
  cursor; new comment is auto-focused, `Enter` commits; a comment expands
  (≤512px wide) when hovered or when the playhead is on its timecode; clicking a
  comment animates the timeline to its time (decelerating, ~0.1s).
- **Undo/redo** writes through to the annotation JSON immediately.
- **Scroll scoping**: the page no longer captures wheel everywhere — only the
  timeline (and capture mode) consume wheel; elsewhere the video pan/zoom does.
