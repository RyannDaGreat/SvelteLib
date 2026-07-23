/**
 * humanReadableFileSize tests — plain node, no framework (SvelteLib has none).
 * Run: node src/demo_apps/PowerRP/tests/filesize_test.js
 *
 * The expected strings below were captured from rp.human_readable_file_size
 * itself (rp/r.py, the library the project owner maintains) so this asserts a
 * BYTE-FOR-BYTE port, not a guess:
 *   python3 -c "from rp import human_readable_file_size as h; print(h(1024))"
 */

import assert from "node:assert/strict";
import { humanReadableFileSize as h } from "../web/fileSize.js";

let passed = 0;
function eq(bytes, mib, expected) {
  const got = mib === undefined ? h(bytes) : h(bytes, mib);
  assert.equal(got, expected, `humanReadableFileSize(${bytes}${mib === undefined ? "" : ", " + mib}) = ${got}, expected ${expected}`);
  passed++;
  console.log(`  ok  ${bytes}${mib === undefined ? "" : " (mib=" + mib + ")"} -> ${got}`);
}

// ── mib=true (rp default): 1024-based, KB/MB labels ──────────────────────────
// Boundary: whole numbers get NO decimal, fractional get exactly one.
eq(0, undefined, "0B");
eq(100, undefined, "100B");
eq(512, undefined, "512B");
eq(1023, undefined, "1023B"); // just under 1KB — still bytes
eq(1024, undefined, "1KB"); // exact KB boundary — whole, no decimal
eq(1025, undefined, "1.0KB"); // just over — fractional, one decimal
eq(1536, undefined, "1.5KB");
eq(2048, undefined, "2KB");
eq(1000000, undefined, "976.6KB"); // still KB at 1e6 bytes (binary)
eq(10000000, undefined, "9.5MB"); // MB boundary crossed
eq(1000000000, undefined, "953.7MB");
eq(10000000000, undefined, "9.3GB"); // GB
eq(12300000, undefined, "11.7MB"); // a realistic mid-upload "loaded"
eq(27100000, undefined, "25.8MB"); // a realistic "total"

// ── mib=false: 1000-based decimal (Finder/Google style) ──────────────────────
eq(1000000, false, "1MB"); // exact decimal MB — whole, no decimal
eq(1000000000, false, "1GB");
eq(10000000, false, "10MB");
eq(1023, false, "1.0KB");
eq(12300000, false, "12.3MB"); // the prompt's illustrative decimal numbers
eq(27100000, false, "27.1MB");

console.log(`\nfilesize_test OK (${passed} assertions)`);
