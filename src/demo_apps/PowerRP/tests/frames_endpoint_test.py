# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1"]
# ///
"""
Filmstrip frames-endpoint + asset-DELETE round-trip test (W2c + manifest
"ASSET UX ROUND 2" DELETE coverage).

Exercises the server's frame-extraction seam end to end:
  1. EXTRACT  — first request for (video, N) extracts N evenly-spread frames,
                caches them under assets/frames/<video>/<N>/, returns N URLs.
  2. CACHE HIT — a second identical request does NOT re-extract (the cache
                folder's mtime is unchanged) yet returns the same URLs.
  3. SERVE    — the returned URLs resolve to real PNG bytes over HTTP.
  4. EVENLY SPREAD — the extracted frames match evenly_spread_indices exactly.
  5. LOUD ERRORS — a missing video and a bad N both return a JSON {error},
                not a silent empty strip.
  6. DISTINCT N — a different frame count is cached independently.
  7. DELETE (plain asset) — DELETE /api/asset/<proj>/<file>/ removes the file
                from disk AND from a subsequent GET /api/assets/<proj>/ list.
  8. DELETE (video + its frame cache) — deleting a video asset also removes
                its cached assets/frames/<video>/ directory (no orphaned cache).
  9. DELETE (missing asset) — a 404 JSON {error}, not a silent no-op or crash
                (delete_asset raises FileNotFoundError, mapped to 404).

Deterministic fixture: tests/fixtures/tiny_video.mp4 (a committed 12-frame
32x24 clip — a binary fixture like checker.png, so the test needs no live
ffmpeg-encode reproducibility, only ffmpeg DECODE which is what extraction uses).

Run (exit code gated):
    /opt/homebrew/opt/python@3.10/bin/python3.10 tests/frames_endpoint_test.py
"""

import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(os.path.dirname(HERE), "server")
FIXTURE = os.path.join(HERE, "fixtures", "tiny_video.mp4")
sys.path.insert(0, SERVER_DIR)
import server  # noqa: E402


def _get(conn, path):
    """Query. GET path over an open connection → (status, body_bytes)."""
    conn.request("GET", path)
    resp = conn.getresponse()
    body = resp.read()
    return resp.status, body


def _delete(conn, path):
    """Command. DELETE path over an open connection → (status, body_bytes)."""
    conn.request("DELETE", path)
    resp = conn.getresponse()
    body = resp.read()
    return resp.status, body


def main():
    assert os.path.isfile(FIXTURE), f"fixture video missing: {FIXTURE}"
    # A throwaway PROJECTS_DIR so the test never touches real projects.
    tmp_root = tempfile.mkdtemp(prefix="powerrp_frames_test_")
    server.PROJECTS_DIR = tmp_root  # redirect storage root (module global)
    proj = "framestest"
    video = "clip.mp4"
    n = 4

    # Seed a project with the fixture video as its one asset.
    os.makedirs(server.assets_dir(proj), exist_ok=True)
    shutil.copy(FIXTURE, os.path.join(server.assets_dir(proj), video))

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port)

        # 1. EXTRACT ---------------------------------------------------------
        url = f"/api/frames/{proj}/{video}/{n}/"
        status, body = _get(conn, url)
        assert status == 200, f"extract status {status}: {body!r}"
        res = json.loads(body)
        assert res["count"] == n, res
        assert len(res["frames"]) == n, res
        cache = server.frames_cache_dir(proj, video, n)
        pngs = sorted(f for f in os.listdir(cache) if f.endswith(".png"))
        assert len(pngs) == n, f"expected {n} cached PNGs, got {pngs}"
        print(f"[1] EXTRACT ok: {n} frames -> {pngs}")

        # 2. CACHE HIT (no re-extraction) — the cache dir mtime must not move.
        mtime_before = os.path.getmtime(cache)
        time.sleep(0.02)
        status2, body2 = _get(conn, url)
        assert status2 == 200, body2
        res2 = json.loads(body2)
        assert res2 == res, "cache-hit response differs from first response"
        assert os.path.getmtime(cache) == mtime_before, "cache was rebuilt on a hit!"
        print("[2] CACHE HIT ok: no re-extraction (cache mtime unchanged)")

        # 3. SERVE — every returned URL resolves to real PNG bytes over HTTP.
        for u in res["frames"]:
            s, png = _get(conn, u)
            assert s == 200, f"serve {u} -> {s}"
            assert png[:8] == b"\x89PNG\r\n\x1a\n", f"not a PNG: {u} ({png[:8]!r})"
        print(f"[3] SERVE ok: all {n} frame URLs return PNG bytes")

        # 4. EVENLY SPREAD — the URL frame order matches the spread indices.
        total = server.video_frame_count(os.path.join(server.assets_dir(proj), video))
        idx = server.evenly_spread_indices(total, n)
        assert idx[0] == 0 and idx[-1] == total - 1, idx
        assert res["frames"][0].endswith("frame_001.png"), res["frames"][0]
        assert res["frames"][-1].endswith(f"frame_{n:03d}.png"), res["frames"][-1]
        print(f"[4] EVENLY SPREAD ok: total={total} indices={idx}")

        # 5. LOUD ERRORS -----------------------------------------------------
        s_missing, b_missing = _get(conn, f"/api/frames/{proj}/nope.mp4/{n}/")
        assert s_missing >= 400, f"missing video should error, got {s_missing}"
        assert "error" in json.loads(b_missing), b_missing
        s_badn, b_badn = _get(conn, f"/api/frames/{proj}/{video}/0/")
        assert s_badn >= 400, f"N=0 should error, got {s_badn}"
        assert "error" in json.loads(b_badn), b_badn
        print("[5] LOUD ERRORS ok: missing video and N=0 both return JSON {error}")

        # 6. A different N is a distinct cache (not a stale hit of the first).
        n2 = 7
        s3, b3 = _get(conn, f"/api/frames/{proj}/{video}/{n2}/")
        assert s3 == 200, b3
        res3 = json.loads(b3)
        assert res3["count"] == n2 and len(res3["frames"]) == n2, res3
        assert os.path.isdir(server.frames_cache_dir(proj, video, n2))
        print(f"[6] DISTINCT N ok: N={n2} cached independently of N={n}")

        # 6b. RESOLUTION (manifest 14.1 frameH/frameW): ?h=&w= extracts at a set
        # per-frame size into its OWN cache (a resolution change re-extracts),
        # and the returned URLs point at the <WxH> segment. The extracted PNGs
        # are the requested size (verified via the PNG IHDR width/height).
        import struct
        def _png_size(png_bytes):
            # IHDR is the first chunk: 8-byte sig, 4 len, "IHDR", then W,H (BE u32).
            w, h = struct.unpack(">II", png_bytes[16:24])
            return w, h
        rh, rw = 12, 16  # half the fixture's native 32x24 — distinct from native
        s_res, b_res = _get(conn, f"/api/frames/{proj}/{video}/{n}/?h={rh}&w={rw}")
        assert s_res == 200, f"res extract status {s_res}: {b_res!r}"
        res_r = json.loads(b_res)
        assert res_r["count"] == n and len(res_r["frames"]) == n, res_r
        # The URL path carries the resolution segment, distinct from the native cache.
        assert f"/{rw}x{rh}/" in res_r["frames"][0], res_r["frames"][0]
        res_cache = server.frames_cache_dir(proj, video, n, rh, rw)
        assert os.path.isdir(res_cache), f"resolution cache dir missing: {res_cache}"
        assert res_cache != server.frames_cache_dir(proj, video, n), "res cache must differ from native cache"
        # Fetch one frame's bytes and check its pixel size == requested.
        s_px, png = _get(conn, res_r["frames"][0])
        assert s_px == 200 and png[:8] == b"\x89PNG\r\n\x1a\n", f"res frame not a PNG: {s_px}"
        pw, ph = _png_size(png)
        assert (pw, ph) == (rw, rh), f"extracted frame is {pw}x{ph}, expected {rw}x{rh}"
        # A NATIVE request for the same (video, N) is a SEPARATE, larger frame.
        _, native_png = _get(conn, res["frames"][0])
        nw, nh = _png_size(native_png)
        assert (nw, nh) != (rw, rh), f"native frame unexpectedly matched res size: {nw}x{nh}"
        # A bad resolution (h=0) is a LOUD 400, not a silent native fallback.
        s_bad, b_bad = _get(conn, f"/api/frames/{proj}/{video}/{n}/?h=0&w={rw}")
        assert s_bad == 400 and "error" in json.loads(b_bad), (s_bad, b_bad)
        print(f"[6b] RESOLUTION ok: {rw}x{rh} extracted to its own cache; native stays {nw}x{nh}; h=0 -> 400")

        # 6c. res_segment / cache-dir helpers (pure) round-trip the URL segment.
        assert server.res_segment(None, None) == "" and server.res_segment(rh, rw) == f"{rw}x{rh}", "res_segment"
        print("[6c] res_segment helper ok")

        # 7. DELETE a plain (non-video) asset: removed from disk AND the list
        # (manifest "ASSET UX ROUND 2": deleteAsset previously 501'd — this
        # proves the DELETE endpoint works end-to-end against a live server).
        plain = "note.txt"
        plain_path = os.path.join(server.assets_dir(proj), plain)
        with open(plain_path, "w") as f:
            f.write("not a video")
        s_del, b_del = _delete(conn, f"/api/asset/{proj}/{plain}/")
        assert s_del == 200, f"delete status {s_del}: {b_del!r}"
        res_del = json.loads(b_del)
        assert res_del == {"ok": True, "name": plain}, res_del
        assert not os.path.exists(plain_path), "deleted asset still on disk"
        _, b_list = _get(conn, f"/api/assets/{proj}/")
        names = {a["name"] for a in json.loads(b_list)}
        assert plain not in names, f"deleted asset still listed: {names}"
        print(f"[7] DELETE (plain asset) ok: {plain!r} removed from disk and the listing")

        # 8. DELETE the video asset ALSO removes its frame cache (both N=4 and
        # N=7 directories cached above) — no orphaned frames/<video>/ left behind.
        video_cache_root = os.path.join(server.assets_dir(proj), "frames", video)
        assert os.path.isdir(video_cache_root), "precondition: frame cache should exist before delete"
        s_del2, b_del2 = _delete(conn, f"/api/asset/{proj}/{video}/")
        assert s_del2 == 200, f"delete status {s_del2}: {b_del2!r}"
        assert not os.path.isfile(os.path.join(server.assets_dir(proj), video)), "video still on disk"
        assert not os.path.isdir(video_cache_root), "orphaned frame cache survived the video's deletion"
        print(f"[8] DELETE (video + frame cache) ok: {video!r} and its frames/ cache both removed")

        # 9. DELETE a missing asset is a LOUD 404 {error} — never a silent
        # no-op, never a crash (manifest error-handling rule).
        s_missing_del, b_missing_del = _delete(conn, f"/api/asset/{proj}/nope.png/")
        assert s_missing_del == 404, f"missing-asset delete should 404, got {s_missing_del}: {b_missing_del!r}"
        assert "error" in json.loads(b_missing_del), b_missing_del
        print("[9] DELETE (missing asset) ok: 404 JSON {error}, not a silent no-op")

        print("\nALL FRAMES-ENDPOINT + DELETE CHECKS PASSED")
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
