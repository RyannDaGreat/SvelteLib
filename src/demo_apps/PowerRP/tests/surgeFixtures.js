/**
 * SURGE'S BIG BINARIES, CACHED FOR TESTS — fetched once, served from disk.
 *
 * `synth/surge_remote.js` fetches Surge's 5.4 MB engine wasm and 30 MB patch
 * archive from an upstream Pages deploy at runtime, and states the ruling and the
 * three costs behind that. For a TEST those costs bite differently: a 35 MB
 * download per run is slow, and cost #2 (a third-party host staying up) would make
 * an audio suite red whenever someone else's site blinked.
 *
 * So this caches them into a GITIGNORED fixture directory and serves them to the
 * page by request interception. The module under test is completely unmodified —
 * it still fetches the real upstream URLs and does not know it is being tested,
 * which is the property that makes an audio measurement mean anything.
 *
 * SHARED BY BOTH AUDIO HARNESSES (`tests/surge_audio_probe.mjs`, which asserts, and
 * `tests/renderPatchAudio.mjs`, which writes WAVs to listen to) rather than copied
 * into each: the CORS header below is one line and forgetting it fails as "surge
 * never became ready", which cost a debugging pass to find once already.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURGE_DATA_BIN_URL, SURGE_ENGINE_WASM_URL, SURGE_REMOTE_BASE } from "../synth/surge_remote.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SURGE_CACHE_DIR = join(HERE, "fixtures", "surge");

/** The two binaries an AUDIO render needs. The 18.9 MB GUI wasm is deliberately
 *  NOT among them — no headless render opens the GUI, and fetching it would cost
 *  another 19 MB per cold run for nothing. */
const WANTED = [
  { url: SURGE_ENGINE_WASM_URL, name: "surge-engine.wasm" },
  { url: SURGE_DATA_BIN_URL, name: "surge-data.bin" },
];

/**
 * Command. Ensure both binaries are on disk, downloading any that are missing.
 *
 * @param {(msg: string) => void} [log] - progress sink (a cold run takes a while,
 *     and a harness that sits silent for a minute looks hung)
 * @returns {Promise<{ok: boolean, reason?: string, files?: Map<string, Buffer>}>}
 *     Never throws: a caller decides whether a missing fixture is fatal.
 */
export async function ensureSurgeFixtures(log = () => {}) {
  await mkdir(SURGE_CACHE_DIR, { recursive: true });
  const files = new Map();
  for (const w of WANTED) {
    const path = join(SURGE_CACHE_DIR, w.name);
    const have = await stat(path).then((s) => s.size > 0).catch(() => false);
    if (!have) {
      log(`  … caching ${w.name} from ${w.url} (first run only)`);
      let res;
      try {
        res = await fetch(w.url);
      } catch (e) {
        return { ok: false, reason: `could not reach ${w.url}: ${e.message}` };
      }
      if (!res.ok) return { ok: false, reason: `${w.url} answered HTTP ${res.status}` };
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
    }
    files.set(w.url, await readFile(path));
  }
  log(`  … surge fixtures ready (${(([...files.values()].reduce((n, b) => n + b.length, 0)) / 1e6).toFixed(1)} MB from ${SURGE_CACHE_DIR})`);
  return { ok: true, files };
}

/**
 * Command. Serve the cached binaries to a puppeteer page.
 *
 * THE CORS HEADER IS REQUIRED, NOT DECORATION. These are CROSS-ORIGIN fetches (the
 * page is 127.0.0.1, the URL is github.io) and the real host answers
 * `access-control-allow-origin: *` — `synth/surge_remote.js` measured that and
 * depends on it. A fulfilled response WITHOUT the header is blocked by CORS exactly
 * as a hostile one would be, and surfaces as the unhelpful "surge never became
 * ready" rather than as anything about headers.
 *
 * Anything else under the upstream base is ABORTED rather than passed through: the
 * only other artifact there is the GUI wasm, which no render needs.
 *
 * @param {object} page - a puppeteer Page
 * @param {Map<string, Buffer>} files - from ensureSurgeFixtures
 */
export async function installSurgeInterception(page, files) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const hit = files.get(req.url());
    if (hit) {
      return req.respond({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "access-control-allow-origin": "*" },
        body: Buffer.from(hit),
      });
    }
    if (req.url().startsWith(SURGE_REMOTE_BASE)) return req.abort();
    return req.continue();
  });
}
