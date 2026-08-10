#!/usr/bin/env bash
# export_deck_pptx.sh — headless PowerPoint-fidelity export pipeline.
#
# Usage:
#   export_deck_pptx.sh <deck.pptx> <outdir> [--dpi 150] [--kinds png,pdf,mp4]
#
# Pure Apple Events + shell. Drives the ExportDeck VBA macro embedded in
# exporter.pptm (same directory as this script) via `osascript ... run VB
# macro`, then rasterizes the resulting PDF at the requested DPI with
# pdftoppm (poppler). No GUI scripting, no simulated mouse/keyboard input --
# see exporter_macro.bas's header and
# .frenzy/research_05_powerpoint_render.md ROUND 4 for why this is safe:
# the sandbox's per-folder Grant Access consent is a ONE-TIME, PERSISTENT
# grant (Microsoft's own GrantAccessToMultipleFiles docs, confirmed here by
# direct double-run test), so every run after the first exchange-folder and
# first per-deck output-folder grant is fully non-interactive.
#
# Output, in <outdir>:
#   SlideNN.png   one per slide, rasterized from the PDF at --dpi (default 150),
#                 zero-padded to the slide count's own digit width
#   deck.pdf      the vector export PowerPoint itself produced
#   deck.mp4      only if --kinds included mp4 AND PowerPoint's SaveAs
#                 actually produced it (see MP4 caveat below)
#   report.txt    this script's own summary: what ran, what didn't, timings
#
# MP4 CAVEAT (measured, not theoretical): Mac PowerPoint 16.110.3's VBA
# `Presentation.SaveAs outPath, ppSaveAsMP4` throws "Invalid enumeration
# value" at RUNTIME even though `ppSaveAsMP4` compiles as a valid named
# constant -- i.e. Mac's SaveAs implementation rejects the MP4 file-type
# value outright, independent of any sandbox/GUI concern. The macro's own
# On Error handler is written to catch and log this like any other failure,
# but this host's VBE has a sticky break-on-error setting from interactive
# debugging that intercepts it before the handler runs, hanging the
# synchronous Apple Event forever. This script therefore treats a timeout
# as evidence of that hang (not a generic pipeline bug): it prints a clear
# diagnosis and exits nonzero rather than hanging the caller forever, and
# --kinds should omit mp4 for this host until that VBE flag is cleared
# (Tools > Options > error trapping is not exposed in Mac VBE's menu; a
# fresh, never-interactively-debugged copy of exporter.pptm should not have
# this problem, since the flag is a debug-session artifact, not a saved
# document property -- unverified on a truly fresh machine).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPORTER_PPTM="$SCRIPT_DIR/exporter.pptm"
EXCHANGE_DIR="$HOME/Library/Application Support/PowerRP-PPTExportExchange"
CONTROL_FILE="$EXCHANGE_DIR/control.txt"

DPI=150
KINDS="png,pdf"
DECK=""
OUTDIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dpi) DPI="$2"; shift 2 ;;
    --kinds) KINDS="$2"; shift 2 ;;
    *)
      if [[ -z "$DECK" ]]; then DECK="$1";
      elif [[ -z "$OUTDIR" ]]; then OUTDIR="$1";
      else echo "Unexpected argument: $1" >&2; exit 1; fi
      shift ;;
  esac
done

if [[ -z "$DECK" || -z "$OUTDIR" ]]; then
  echo "Usage: $0 <deck.pptx> <outdir> [--dpi 150] [--kinds png,pdf,mp4]" >&2
  exit 1
fi

DECK="$(cd "$(dirname "$DECK")" && pwd)/$(basename "$DECK")"
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"

if [[ ! -f "$EXPORTER_PPTM" ]]; then
  echo "FATAL: exporter.pptm not found at $EXPORTER_PPTM" >&2
  echo "Run the one-time setup first (see exporter_macro.bas header)." >&2
  exit 1
fi
if ! command -v pdftoppm >/dev/null; then
  echo "FATAL: pdftoppm not found. Install poppler: brew install poppler" >&2
  exit 1
fi
if ! command -v osascript >/dev/null; then
  echo "FATAL: osascript not found (this pipeline requires macOS)." >&2
  exit 1
fi

mkdir -p "$EXCHANGE_DIR"
{
  echo "$DECK"
  echo "$OUTDIR"
  echo "$KINDS"
} > "$CONTROL_FILE"

echo "=== export_deck_pptx.sh ==="
echo "deck:   $DECK"
echo "outdir: $OUTDIR"
echo "dpi:    $DPI"
echo "kinds:  $KINDS"
echo "control file: $CONTROL_FILE"
echo

rm -f "$OUTDIR/export_done.marker" "$OUTDIR/export_log.txt"

TIMEOUT_SECS=180

echo "Opening exporter.pptm and running VB macro ExportDeck via pure Apple Events..."
# `open` is not sandbox-gated (per R5) so this never needs a grant of its own.
osascript -e "tell application \"Microsoft PowerPoint\" to open POSIX file \"$EXPORTER_PPTM\"" >/dev/null

# Fire the macro asynchronously (background osascript) so we can poll the
# marker file with our own timeout, rather than being bound by osascript's
# own ~2-minute default AppleEvent timeout (which fires with "AppleEvent
# timed out (-1712)" while a Grant Access dialog is still legitimately
# waiting on the user during first-run setup, well before our own
# TIMEOUT_SECS budget is exhausted). `with timeout` raises osascript's
# ceiling so our own polling loop is the one authority on when to give up.
osascript -e "with timeout of $((TIMEOUT_SECS + 30)) seconds
	tell application \"Microsoft PowerPoint\" to run VB macro macro name \"ExportDeck\"
end timeout" >/tmp/export_deck_macro_stdout.$$ 2>&1 &
MACRO_PID=$!

WAITED=0
echo "Waiting for export_done.marker (timeout ${TIMEOUT_SECS}s)..."
while [[ ! -f "$OUTDIR/export_done.marker" ]]; do
  if ! kill -0 "$MACRO_PID" 2>/dev/null && [[ ! -f "$OUTDIR/export_done.marker" ]]; then
    # osascript process exited without the marker ever appearing -- real failure
    echo "FATAL: run VB macro process exited without writing export_done.marker." >&2
    [[ -f /tmp/export_deck_macro_stdout.$$ ]] && cat /tmp/export_deck_macro_stdout.$$ >&2
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  if [[ $WAITED -ge $TIMEOUT_SECS ]]; then
    echo "FATAL: timed out after ${TIMEOUT_SECS}s waiting for export_done.marker." >&2
    if [[ -f "$OUTDIR/export_log.txt" ]]; then
      echo "--- partial export_log.txt (steps completed before the hang) ---" >&2
      cat "$OUTDIR/export_log.txt" >&2
      echo "--- end partial log ---" >&2
      if grep -q "kinds=.*mp4" "$OUTDIR/export_log.txt" 2>/dev/null && ! grep -q "^MP4:" "$OUTDIR/export_log.txt" 2>/dev/null; then
        echo "DIAGNOSIS: log stops before an MP4 line -- this matches the documented" >&2
        echo "Mac VBE break-on-error hang on ppSaveAsMP4 (see this script's header)." >&2
        echo "Re-run with --kinds png,pdf to avoid it." >&2
      fi
    else
      echo "No export_log.txt was written at all -- PowerPoint may be showing an" >&2
      echo "unexpected dialog (Grant Access, a compile error, etc). Check manually." >&2
    fi
    kill "$MACRO_PID" 2>/dev/null || true
    exit 1
  fi
done
rm -f /tmp/export_deck_macro_stdout.$$

echo "Marker found. export_log.txt:"
echo "---"
cat "$OUTDIR/export_log.txt"
echo "---"
echo

echo "Verifying slide PNGs from PowerPoint's own export..."
NATIVE_PNG_COUNT=$(find "$OUTDIR" -maxdepth 1 -name 'Slide*.png' | wc -l | tr -d ' ')
echo "Native PowerPoint PNGs found: $NATIVE_PNG_COUNT"

if [[ ! -f "$OUTDIR/deck.pdf" ]]; then
  echo "FATAL: deck.pdf was not produced (see export_log.txt above for the PDF step's error)." >&2
  exit 1
fi

echo
echo "Rasterizing deck.pdf at ${DPI} dpi via pdftoppm..."
PAGE_COUNT=$(pdfinfo "$OUTDIR/deck.pdf" | awk '/^Pages:/ {print $2}')
PAGE_WIDTH_PT=$(pdfinfo "$OUTDIR/deck.pdf" | awk '/^Page size:/ {print $3}')
# pdftoppm's -r takes a literal DPI against the PDF's own point-based page size,
# so no unit conversion is needed here -- --dpi 150 on this deck's 960pt-wide
# native page yields 150 * 960/72 = 2000px-wide PNGs. (An earlier version of
# this script mistakenly treated --dpi as a target PIXEL WIDTH and derived a
# DPI from it, which silently produced ~11 DPI thumbnails instead of real
# renders -- fixed by using -r "$DPI" directly.)
PIXEL_WIDTH=$(awk -v dpi="$DPI" -v pt="$PAGE_WIDTH_PT" 'BEGIN { printf "%d", dpi * pt / 72 }')
echo "PDF pages: $PAGE_COUNT, native page width: ${PAGE_WIDTH_PT}pt -> ${PIXEL_WIDTH}px at ${DPI} dpi"

mkdir -p "$OUTDIR/.pdf_render_tmp"
pdftoppm -png -r "$DPI" "$OUTDIR/deck.pdf" "$OUTDIR/.pdf_render_tmp/page"

DIGITS=${#PAGE_COUNT}
i=1
for f in "$OUTDIR"/.pdf_render_tmp/page-*.png; do
  [[ -e "$f" ]] || continue
  padded=$(printf "%0${DIGITS}d" "$i")
  mv "$f" "$OUTDIR/Slide${padded}.png"
  i=$((i + 1))
done
rmdir "$OUTDIR/.pdf_render_tmp" 2>/dev/null || true

RENDERED_COUNT=$(find "$OUTDIR" -maxdepth 1 -name 'Slide*.png' -newer "$OUTDIR/deck.pdf" | wc -l | tr -d ' ')
echo "Rasterized $RENDERED_COUNT PNGs from PDF at ${DPI} dpi (${PIXEL_WIDTH}px wide)."

if [[ "$RENDERED_COUNT" != "$PAGE_COUNT" ]]; then
  echo "FATAL: PDF page count ($PAGE_COUNT) does not match rasterized PNG count ($RENDERED_COUNT)." >&2
  exit 1
fi

MP4_STATUS="not requested"
if [[ "$KINDS" == *mp4* ]]; then
  if [[ -f "$OUTDIR/deck.mp4" ]]; then
    MP4_STATUS="produced"
  else
    MP4_STATUS="requested but not produced (see export_log.txt / this script's MP4 caveat)"
  fi
fi

{
  echo "export_deck_pptx.sh report"
  echo "deck:   $DECK"
  echo "outdir: $OUTDIR"
  echo "dpi: $DPI  (${PIXEL_WIDTH}px wide)"
  echo "pdf pages: $PAGE_COUNT"
  echo "rasterized PNGs: $RENDERED_COUNT"
  echo "mp4: $MP4_STATUS"
  echo "generated: $(date)"
} > "$OUTDIR/report.txt"

echo
echo "=== DONE ==="
cat "$OUTDIR/report.txt"
