# /// script
# requires-python = ">=3.10"
# dependencies = ["rp==0.1.1421", "fire==0.7.1", "numpy>=1.26"]
# ///
"""
Asset thumbnail-cache + font-kind server test (manifest #25 + #26).

Direct-call test (no live HTTP server needed): drives the server module's pure
helpers + filesystem commands against a THROWAWAY POWERRP_PROJECTS_DIR, so it is
fast and self-contained. Covers:

  1. asset_kind classifies font files as "font" (the #26 upload kind).
  2. list_assets attaches `mtime` to every entry (the client thumbnail cache key).
  3. A fresh PDF asset lists with NO thumbnail (nothing cached yet).
  4. save_thumb persists a client-rendered PNG + badge; list_assets then attaches
     {thumbnail, badge} inline, and the thumbnail URL resolves to the stored bytes.
  5. STALE INVALIDATION: after the source asset's mtime changes, the old thumb is
     NOT attached (regenerate-if-stale), then a re-store refreshes it.
  6. The .thumbs/ cache dir is NEVER listed as an asset.
  7. delete_asset removes the asset AND its cached thumbnail dir (no orphan).

Run:  uv run tests/asset_thumbnail_test.py      (from the PowerRP dir)
"""

import importlib.util
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_PY = os.path.join(HERE, "..", "server", "server.py")

_tmp = tempfile.mkdtemp(prefix="powerrp_thumb_test_")
os.environ["POWERRP_PROJECTS_DIR"] = _tmp  # MUST be set before importing (PROJECTS_DIR is import-time)

spec = importlib.util.spec_from_file_location("powerrp_server", SERVER_PY)
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

passed = 0


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1
    print(f"  ok  {msg}")


def find(assets, name):
    for a in assets:
        if a["name"] == name:
            return a
    return None


PROJ = "ThumbTest"
PNG = bytes.fromhex("89504e470d0a1a0a")  # PNG magic header — enough to prove byte round-trip
srv.save_project(PROJ, {"slides": [], "meta": {"name": PROJ}})

# 1. font kind
check(srv.asset_kind("Handwriting.ttf") == "font", "asset_kind('.ttf') == 'font'")
check(srv.asset_kind("Body.woff2") == "font", "asset_kind('.woff2') == 'font'")

# 2 + 3. a fresh PDF asset lists with mtime and no thumbnail
srv.save_asset(PROJ, "paper.pdf", b"%PDF-1.4 fake pdf bytes")
assets = srv.list_assets(PROJ)
pdf = find(assets, "paper.pdf")
check(pdf is not None and pdf["kind"] == "pdf", "pdf asset present, kind 'pdf'")
check("mtime" in pdf and isinstance(pdf["mtime"], (int, float)), "list_assets entry carries mtime")
check("thumbnail" not in pdf, "fresh pdf asset has NO thumbnail attached")

# 4. store a client-rendered thumbnail + badge; it now attaches inline
mtime = pdf["mtime"]
url = srv.save_thumb(PROJ, "paper.pdf", mtime, "5", PNG)
assets = srv.list_assets(PROJ)
pdf = find(assets, "paper.pdf")
check(pdf.get("thumbnail") == url, "cached thumbnail attached to the listing")
check(pdf.get("badge") == "5", "page-count badge attached to the listing")
# the thumbnail URL resolves to the stored bytes on disk
rel = pdf["thumbnail"].split(f"/asset/{PROJ}/", 1)[1]
import urllib.parse
disk = os.path.join(srv.assets_dir(PROJ), urllib.parse.unquote(rel))
check(os.path.isfile(disk) and open(disk, "rb").read() == PNG, "thumbnail URL maps to the stored PNG bytes")

# 5. stale invalidation: bump the source asset's mtime → old thumb not attached
time.sleep(0.01)
os.utime(os.path.join(srv.assets_dir(PROJ), "paper.pdf"), None)
assets = srv.list_assets(PROJ)
pdf = find(assets, "paper.pdf")
check("thumbnail" not in pdf, "stale thumb (mtime changed) is NOT attached — regenerate")
srv.save_thumb(PROJ, "paper.pdf", pdf["mtime"], "6", PNG)
pdf = find(srv.list_assets(PROJ), "paper.pdf")
check(pdf.get("thumbnail") and pdf.get("badge") == "6", "re-stored thumb (fresh mtime) attaches again")

# 6. the .thumbs cache dir is never listed as an asset
check(find(srv.list_assets(PROJ), srv.THUMBS_SUBDIR) is None, ".thumbs/ is never listed as an asset")

# 7. delete removes the asset AND its cached thumbnail dir
srv.delete_asset(PROJ, "paper.pdf")
check(not os.path.isdir(srv.thumb_entry_dir(PROJ, "paper.pdf")), "delete_asset removes the thumbnail cache dir")
check(find(srv.list_assets(PROJ), "paper.pdf") is None, "deleted asset gone from the listing")

import shutil
shutil.rmtree(_tmp, ignore_errors=True)
print(f"\n{passed} asset-thumbnail server tests passed.")
