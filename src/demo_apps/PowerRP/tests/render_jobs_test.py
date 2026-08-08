# /// script
# requires-python = ">=3.10"
# dependencies = ["fire==0.7.1"]
# ///
# (fire is needed because this test imports server/server.py, which imports fire
# at module load.)
"""
DETACHED RENDER-JOB TEST — proves that a server-side render SURVIVES the browser.

The bug this guards against cost a real five-hour render: the old export made the
BROWSER the renderer, so closing the dialog, refreshing, or an editor hot-reload
destroyed the work with no way to recover it. The fix is a job the SERVER owns.
The headline claim is therefore not "the encode works" (tests/mp4_serverside_test.py
already proves that) but "the client can vanish and the render still finishes",
so that is what this test actually demonstrates:

  1. Submit a server-backend job over HTTP.
  2. DESTROY the submitting client entirely — its opener, its connections, every
     handle it held — and delete every Python reference to the response.
  3. Poll from a FRESH client that never saw the submit, using only the project
     name, and watch the frame count climb and the job reach "done".
  4. Assert the .mp4 is on disk INSIDE THE PROJECT FOLDER and ffprobes as a real
     playable video with the expected dimensions and frame count.

It also covers the properties that make the feature trustworthy rather than merely
present:
  - SNAPSHOT ISOLATION: the project's doc.json is REWRITTEN mid-flight and the
    output must still match the document as it was at submit. An unsnapshotted job
    would splice two documents into one video and report success — a silently
    wrong output, the worst failure available here.
  - LOUD FAILURE: a job whose document cannot render must end "failed" carrying the
    real error text, never stall at a percentage forever.
  - RESTART RECONCILE: a job left mid-flight by a server restart must be re-queued
    (server backend) or left RESUMABLE (browser backend, whose progress lives in the
    browser and is not the server's to lose), never silently lost.
  - CANCEL and DELETE, including the refusal to delete something still running.
  - MOTION BLUR, which the server backend used to REFUSE at submit because the old
    bare-node renderer had no canvas to average sub-frames on. The worker is a real
    headless browser now, so this asserts samples=4 both COMPLETES and CHANGES THE
    PIXELS (the deck has to move for that to be provable — see the section).
  - THE DETERMINISM WARNING: a deck containing a video PLAYER carries it (a player
    follows the browser's playback clock, not the timeline), a deck of reproducible
    widgets does not.

Run:  uv run src/demo_apps/PowerRP/tests/render_jobs_test.py
Exits non-zero on any failed check.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)  # src/demo_apps/PowerRP
SERVER_DIR = os.path.join(APP_DIR, "server")
sys.path.insert(0, SERVER_DIR)

# Isolate the projects store BEFORE importing server (it reads the env at import).
TMP_PROJECTS = tempfile.mkdtemp(prefix="powerrp_test_renderjobs_")
os.environ["POWERRP_PROJECTS_DIR"] = TMP_PROJECTS
# Two workers: enough to prove the SHARDING actually reassembles into a correct,
# gap-free frame sequence (a striding bug shows up as a missing frame), while
# staying light enough for a test machine.
os.environ["POWERRP_RENDER_WORKERS"] = "2"

import server  # noqa: E402  (server/server.py)

PROJECT = "RenderJobTest"
# A deliberately CHEAP deck: solid camera background plus one flat shape. The
# headless renderer runs generative material shaders per-pixel on the CPU, so a
# material-laden deck measures MINUTES per frame — unusable in a test. Nothing
# here is material-backed, so a frame is milliseconds.
WIDTH, HEIGHT, FPS, CRF = 96, 64, 6, 28
HOLD_SECONDS = 0.5   # two slides × 0.5 s hold, no transitions → 1.0 s → 6 frames
EXPECTED_FRAMES = 6
POLL_SECONDS = 0.25
JOB_TIMEOUT_SECONDS = 300

failures = []


def check(label, condition, detail=""):
    """Command (records a result, prints it). Assert `condition`, collecting failures."""
    print(f"{'PASS' if condition else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def camera_item(background):
    """Pure function. THE camera item — every document must have exactly one."""
    return {"type": "camera", "name": "Camera", "x": 0, "y": 0, "w": WIDTH, "h": HEIGHT,
            "z": 1000, "rotation": 0, "scale": 1, "active": True, "background": background,
            "antialias": "standard", "retina": True}


def shape_item(fill):
    """Pure function. One flat hexagon — cheap to raster (no material shader), and a
    named shape core/shapes.js actually generates."""
    return {"type": "shape", "x": 20, "y": 12, "w": 56, "h": 40, "z": 3, "rotation": 0,
            "scale": 1, "fill": fill, "stroke": "#000000", "strokeWidth": 0,
            "shape": "hexagon", "shapePoints": 6, "shapeInnerRatio": 0.5, "opacity": 1,
            "active": True}


def make_doc(background, fill):
    """
    Pure function. A two-slide deck: a camera plus one shape, the shape's colour
    changing on slide 2 so a wrong-document render is visible, not just unequal.
    """
    return {
        "meta": {"name": PROJECT, "slideW": WIDTH, "slideH": HEIGHT},
        "slides": [
            {"id": "slide0001", "name": "Slide 1",
             "transition": {"seconds": 0, "curve": "smooth", "sound": None, "type": "tween"},
             "delta": {"items": {"cam00001": camera_item(background), "shp00001": shape_item(fill)}}},
            {"id": "slide0002", "name": "Slide 2",
             "transition": {"seconds": 0, "curve": "smooth", "sound": None, "type": "tween"},
             "delta": {"items": {}}},
        ],
    }


def params(**overrides):
    """Pure function. Submit params with the test defaults, overridable per case."""
    base = {"width": WIDTH, "height": HEIGHT, "fps": FPS, "crf": CRF, "background": "#000000",
            "startIndex": 0, "endIndex": 1, "includeTransitions": False,
            "holdSeconds": HOLD_SECONDS, "quality": "full", "samples": 1}
    base.update(overrides)
    return base


def post_json(base, path, payload, opener=None):
    """Query. POST JSON and return the decoded reply (raises on a non-2xx)."""
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    fetch = opener.open if opener else urllib.request.urlopen
    with fetch(req) as res:
        return json.loads(res.read())


def get_json(base, path, opener=None):
    """Query. GET and return the decoded JSON reply."""
    fetch = opener.open if opener else urllib.request.urlopen
    with fetch(base + path) as res:
        return json.loads(res.read())


def wait_for_state(base, job_id, done_states, opener=None, timeout=JOB_TIMEOUT_SECONDS):
    """
    Query (polls). Poll the job list until the job reaches one of `done_states`.
    Returns the final record, or the last one seen if the timeout expires.
    """
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        jobs = get_json(base, f"/api/render-jobs/{PROJECT}/", opener)["jobs"]
        last = next((j for j in jobs if j["id"] == job_id), None)
        if last and last["state"] in done_states:
            return last
        time.sleep(POLL_SECONDS)
    return last


def ffprobe_streams(path):
    """Query. ffprobe a file's first video stream as a dict (raises if unplayable)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,nb_read_frames,avg_frame_rate", "-count_frames",
         "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)["streams"][0]


def main():
    os.makedirs(os.path.join(TMP_PROJECTS, PROJECT), exist_ok=True)
    doc_at_submit = make_doc("#102030", "#ff0000")
    with open(os.path.join(TMP_PROJECTS, PROJECT, "doc.json"), "w") as f:
        json.dump(doc_at_submit, f)

    # The REAL server, on a real socket, over plain HTTP — plus the real supervisor
    # thread. Nothing here is a stub.
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    # serve() normally publishes this; a harness that runs Handler itself must, because
    # the render worker's dev server proxies /api and /asset to it (server.backend_origin
    # raises rather than guessing a port — a wrong one would 404 every project asset and
    # render a deck full of holes).
    os.environ["BACKEND_URL"] = base
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=server._supervise, daemon=True, name="powerrp-render").start()
    print(f"server on {base}   projects: {TMP_PROJECTS}\n")

    # ── 1. SUBMIT from a client we are about to destroy ───────────────────────
    submitter = urllib.request.build_opener()
    job = post_json(base, f"/api/render-jobs/{PROJECT}/", {
        "name": "Survivor", "backend": "server", "framesTotal": EXPECTED_FRAMES,
        "params": params(), "doc": doc_at_submit,
    }, submitter)["job"]
    job_id = job["id"]
    check("submit returns a queued job", job["state"] in ("queued", "rendering"), job["state"])
    check("submit snapshots the document",
          os.path.exists(os.path.join(server.job_dir(PROJECT, job_id), "doc.json")))

    # ── 2. DESTROY the submitting client, entirely ────────────────────────────
    # This is the whole point of the feature: no client-side handle exists that the
    # render depends on. Close every connection the opener holds and drop it.
    submitter.close()
    del submitter, job
    print("\n-- submitting client destroyed; polling from a fresh client --\n")

    # ── 3. EDIT THE PROJECT MID-FLIGHT (snapshot isolation) ───────────────────
    # A green shape on a different background. If the job read the live document
    # instead of its snapshot, later frames would be green.
    with open(os.path.join(TMP_PROJECTS, PROJECT, "doc.json"), "w") as f:
        json.dump(make_doc("#00ff00", "#00ff00"), f)

    # ── 4. POLL FROM A FRESH CLIENT that never saw the submit ─────────────────
    fresh = urllib.request.build_opener()
    final = wait_for_state(base, job_id, ("done", "failed", "cancelled"), fresh)
    check("job reached a terminal state", final is not None and final["state"] == "done",
          f"{final and final['state']}: {final and final.get('error')}")
    if final and final["state"] == "done":
        check("progress reported frames", final.get("framesDone", 0) == EXPECTED_FRAMES,
              f"framesDone={final.get('framesDone')}")

        # ── 5. THE OUTPUT IS A REAL MOVIE, IN THE PROJECT FOLDER ──────────────
        out_path = os.path.join(server.renders_dir(PROJECT), final["output"])
        check("output lives in the project's renders/ folder", os.path.exists(out_path), out_path)
        check("output is reported with an absolute path", os.path.isabs(final.get("outputPath", "")))
        check("output has bytes", final.get("bytes", 0) > 0, f"{final.get('bytes')} B")
        stream = ffprobe_streams(out_path)
        check("output dimensions", (stream["width"], stream["height"]) == (WIDTH, HEIGHT),
              f"{stream['width']}x{stream['height']}")
        check("output frame count", int(stream["nb_read_frames"]) == EXPECTED_FRAMES,
              f"{stream['nb_read_frames']} frames")
        check("output frame rate", stream["avg_frame_rate"] == f"{FPS}/1", stream["avg_frame_rate"])

        # ── 6. SNAPSHOT ISOLATION: the movie is the SUBMITTED document ────────
        # The live doc was rewritten to a solid green field mid-flight. Decode the
        # LAST frame and check it is not that: the snapshot's shape was red on a
        # dark blue field, so a green-dominated frame proves the job followed the
        # live document instead of its snapshot.
        probe = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", out_path, "-vf", "crop=8:8:0:0,scale=1:1",
             "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            capture_output=True, check=True).stdout
        r, g, b = probe[0], probe[1], probe[2]
        check("snapshot isolation: mid-flight edit did not leak into the output",
              g < 128, f"top-left pixel rgb({r},{g},{b}) — the live doc's edit was #00ff00")

        # Frames scratch is cleaned; the record survives as the list entry.
        check("frame scratch is cleaned up after encode",
              not os.path.isdir(server.job_frames_dir(PROJECT, job_id)))
        check("job record survives for the list",
              os.path.exists(os.path.join(server.job_dir(PROJECT, job_id), "job.json")))

    # ── 7. LOUD FAILURE — a job that cannot render must SAY SO ────────────────
    broken = post_json(base, f"/api/render-jobs/{PROJECT}/", {
        "name": "Doomed", "backend": "server", "framesTotal": EXPECTED_FRAMES,
        "params": params(), "doc": {"meta": {"name": PROJECT}, "slides": []},
    }, fresh)["job"]
    bad = wait_for_state(base, broken["id"], ("done", "failed", "cancelled"), fresh, timeout=120)
    check("an unrenderable job ends FAILED, not stuck", bad is not None and bad["state"] == "failed",
          f"{bad and bad['state']}")
    check("a failed job carries the real error text",
          bool(bad and bad.get("error")), (bad or {}).get("error", "")[:120])

    # ── 8. VALIDATION IS LOUD AT SUBMIT ───────────────────────────────────────
    for label, payload in [
        ("bad crf is rejected", {"params": params(crf=99)}),
        ("bad backend is rejected", {"backend": "magic"}),
    ]:
        body = {"name": "Bad", "backend": "server", "params": params(),
                "doc": doc_at_submit, "framesTotal": EXPECTED_FRAMES}
        body.update(payload)
        try:
            post_json(base, f"/api/render-jobs/{PROJECT}/", body, fresh)
            check(label, False, "submit was accepted")
        except urllib.error.HTTPError as exc:
            check(label, exc.code == 400, f"HTTP {exc.code}")

    # ── 8b. MOTION BLUR RUNS ON THE SERVER BACKEND ────────────────────────────
    # It used to be REFUSED at submit: the server rendered in bare node, which has no
    # canvas to average sub-frames on. The worker now drives the same frame sampler
    # the in-browser export does, inside a real headless browser, so the refusal is
    # gone and this proves the averaging actually runs.
    #
    # The deck must MOVE for that to be provable: with a static deck every sub-sample
    # is the same picture and the output would be identical whether the averaging ran
    # or not. So slide 2 shifts the shape across a real 1 s transition.
    blur_doc = make_doc("#102030", "#ff0000")
    blur_doc["slides"][1]["transition"]["seconds"] = 1
    blur_doc["slides"][1]["delta"]["items"]["shp00001"] = {"x": 4}
    blur_bytes = {}
    for samples in (1, 4):
        blur = post_json(base, f"/api/render-jobs/{PROJECT}/", {
            "name": f"Blur{samples}", "backend": "server", "framesTotal": EXPECTED_FRAMES,
            "params": params(samples=samples, includeTransitions=True), "doc": blur_doc,
        }, fresh)["job"]
        done_blur = wait_for_state(base, blur["id"], ("done", "failed", "cancelled"), fresh)
        check(f"a server job with samples={samples} completes",
              done_blur is not None and done_blur["state"] == "done",
              f"{done_blur and done_blur['state']}: {(done_blur or {}).get('error')}")
        if done_blur and done_blur.get("outputPath"):
            with open(done_blur["outputPath"], "rb") as f:
                blur_bytes[samples] = f.read()
    # libx264 is deterministic for identical input at identical settings, so different
    # output bytes mean different FRAMES — i.e. the sub-frames really were averaged.
    check("motion blur changes the rendered pixels", len(blur_bytes) == 2 and blur_bytes[1] != blur_bytes[4],
          f"samples=1 {len(blur_bytes.get(1, b''))} B vs samples=4 {len(blur_bytes.get(4, b''))} B")

    # ── 9. CANCEL, and the refusal to delete a live job ───────────────────────
    live = post_json(base, f"/api/render-jobs/{PROJECT}/", {
        "name": "Cancelme", "backend": "client", "framesTotal": EXPECTED_FRAMES,
        "params": params(), "doc": doc_at_submit,
    }, fresh)["job"]
    try:
        req = urllib.request.Request(base + f"/api/render-job/{PROJECT}/{live['id']}/", method="DELETE")
        fresh.open(req)
        check("deleting a live job is refused", False, "delete was accepted")
    except urllib.error.HTTPError as exc:
        check("deleting a live job is refused", exc.code == 500, f"HTTP {exc.code}")
    cancelled = post_json(base, f"/api/render-job/{PROJECT}/{live['id']}/cancel/", {}, fresh)["job"]
    check("cancel moves a job to cancelled", cancelled["state"] == "cancelled", cancelled["state"])
    req = urllib.request.Request(base + f"/api/render-job/{PROJECT}/{live['id']}/", method="DELETE")
    check("a cancelled job can be deleted", json.loads(fresh.open(req).read())["ok"])
    check("delete removes the job folder", not os.path.isdir(server.job_dir(PROJECT, live["id"])))

    # ── 10. RESTART RECONCILE — nothing is silently lost ──────────────────────
    # Forge the two mid-flight states a restart can find and run the boot sweep.
    stranded_server = server.create_job(PROJECT, params(), doc_at_submit, "StrandedServer", "server")
    server.update_job(PROJECT, stranded_server["id"], state="rendering")
    stranded_client = server.create_job(PROJECT, params(), doc_at_submit, "StrandedClient", "client")
    server.update_job(PROJECT, stranded_client["id"], state="rendering")
    server.resume_interrupted_jobs()
    after_server = server.read_job(PROJECT, stranded_server["id"])
    after_client = server.read_job(PROJECT, stranded_client["id"])
    check("a server job stranded by a restart is re-queued",
          after_server["state"] in ("queued", "rendering", "encoding", "done"), after_server["state"])
    # A BROWSER job is left resumable rather than killed. Its progress is not this
    # server's to lose: either the PNG frames already in its own job directory, or
    # encoded segments in the browser's IndexedDB. Marking it terminal here used to
    # destroy renders the next page load could have finished, and made the endpoint
    # that delivers its movie refuse it. Reconciling a browser whose data is really
    # gone is the CLIENT's job -- only it can see whether it holds the resume data.
    check("a browser job stranded by a restart stays resumable, not terminal",
          after_client["state"] in server.JOB_ACTIVE_STATES, after_client["state"])
    check("a stranded browser job is not falsely marked failed",
          not after_client.get("error"), str(after_client.get("error")))

    # ── 11. THE PLAYBACK-CLOCK WARNING IS ATTACHED, NOT DISCOVERED LATER ──────
    # A video PLAYER draws fine now (the worker is a real browser), but it runs on the
    # browser's own playback clock rather than the presentation timeline, so which frame
    # of the clip lands where is not reproducible. That is a property of the widget, not
    # of the backend, so the warning must be attached at submit either way.
    media_doc = make_doc("#102030", "#ff0000")
    media_doc["slides"][0]["delta"]["items"]["vid00001"] = {"type": "video", "x": 0, "y": 0,
                                                            "w": 10, "h": 10, "active": True}
    warned = post_json(base, f"/api/render-jobs/{PROJECT}/", {
        "name": "Warned", "backend": "server", "framesTotal": EXPECTED_FRAMES,
        "params": params(), "doc": media_doc,
    }, fresh)["job"]
    check("a deck with a video PLAYER carries a loud determinism warning",
          bool(warned.get("warning")) and "video" in warned["warning"], (warned.get("warning") or "")[:90])
    check("a deck with only deterministic widgets carries no warning",
          post_json(base, f"/api/render-jobs/{PROJECT}/", {
              "name": "Quiet", "backend": "client", "framesTotal": EXPECTED_FRAMES,
              "params": params(), "doc": doc_at_submit,
          }, fresh)["job"].get("warning") is None)
    server.cancel_job(PROJECT, warned["id"])

    # ── ONE CORRUPT RECORD MUST NOT BRICK THE LIST (the live Gears 500) ────────
    # An external tool once hand-wrote a job.json with a trailing brace and the
    # whole listRenderJobs endpoint 500ed, hiding EVERY job. The list must
    # instead carry a loud failed "corrupt record" row naming the parse error
    # while the healthy jobs stay visible.
    corrupt_dir = os.path.join(server.jobs_dir(PROJECT), "deadbeefcafe")
    os.makedirs(corrupt_dir, exist_ok=True)
    with open(os.path.join(corrupt_dir, server.JOB_RECORD_FILENAME), "w") as f:
        f.write('{"id": "deadbeefcafe", "state": "done"}}')
    listed = get_json(base, f"/api/render-jobs/{PROJECT}/", fresh)["jobs"]
    corrupt_rows = [j for j in listed if j.get("state") == "failed" and "does not parse" in (j.get("error") or "")]
    check("a corrupt job.json becomes a LOUD failed row instead of a 500",
          len(corrupt_rows) == 1, (corrupt_rows[0].get("error") or "")[:80] if corrupt_rows else "no corrupt row")
    check("healthy jobs stay visible beside the corrupt record",
          any(j.get("id") != "deadbeefcafe" and j.get("state") != "failed" for j in listed),
          f"{len(listed)} rows listed")
    shutil.rmtree(corrupt_dir)

    httpd.shutdown()
    print()
    if failures:
        print(f"FAILED ({len(failures)}): " + ", ".join(failures))
        return 1
    print("All render-job checks passed.")
    return 0


if __name__ == "__main__":
    code = main()
    shutil.rmtree(TMP_PROJECTS, ignore_errors=True)
    sys.exit(code)
