/**
 * OPEN A PROJECT FROM A URL — one pipeline, two surfaces.
 *
 * THE USER'S QUESTION: "If I give the static website a reference to a link to a
 * zip somewhere on the web, can it use it? That way I could share a link like
 * https://…/SvelteLib/?zip=<url-to-zip>". So: a shareable deck is a URL, and the
 * two ways to hand one over — the `?zip=` boot param and the "Open Project from
 * URL…" command — are the SAME code path, differing only in where progress is
 * drawn.
 *
 * WHAT THIS FILE IS NOT: a second importer, and not an opener either. It ends at
 * BYTES. Everything downstream — archive adoption (7f52bae), `repairedDocument`
 * at the load boundary, staging into the draft keyspace — belongs to
 * web/projectDraft.js and `app.openDraftFromZipBytes`. A URL is a TRANSPORT for
 * a .zip and nothing more.
 *
 * TWO THINGS THAT ARE ONLY TRUE HERE:
 *
 *  1. CORS IS THE EXPECTED FAILURE, not an exotic one. A browser fetching
 *     someone else's host gets blocked unless that host opted in. In HTTP mode
 *     there is a server to ask instead (see the proxy below); on the STATIC site
 *     there is not, and the honest answer is a message that NAMES CORS, states
 *     the one header the host owner can add, and offers the manual path (a
 *     clickable link — download it, drag it onto the page). A bare "Failed to
 *     fetch" would be a true statement that teaches nothing.
 *
 *  2. THE URL IS CONTENT, NEVER A COMMAND. It is fetched and its bytes are
 *     parsed as a zip; nothing in it is ever evaluated. `http(s)` only, so a
 *     `javascript:` or `data:` share link is refused before any fetch.
 *
 * THE IDEMPOTENCY MEMO IS GONE, and its absence is the design. An earlier draft
 * of this file remembered url → project name in localStorage so that a share
 * link visited five times would not leave five projects behind. THE WORKING-COPY
 * MODEL made that unnecessary: opening a link creates a DRAFT and writes nothing
 * to the library, so five visits leave ZERO projects, every time, with no cache
 * to go stale and no "the remembered project was deleted" case to reason about.
 * A structural answer beat a remembered one.
 */

import { BACKEND } from "./projectApi.js";

/** The share-link query parameter. Short and self-explanatory: `?zip=<url>`.
 *  Exported so the boot path, the tests and the docs cannot drift apart. */
export const ZIP_PARAM = "zip";

/**
 * Pure function. Validate a user-supplied project-zip URL, returning the
 * normalized absolute URL string.
 *
 * ONLY http(s). The share param is attacker-reachable by construction (it is in
 * a link someone clicked), so the scheme check happens BEFORE any fetch and is a
 * refusal, not a filter — `javascript:` and `data:` never reach the network path
 * and never reach an evaluator, because nothing here evaluates anything.
 *
 * A relative URL is resolved against `base` when one is given, so a deck hosted
 * beside the app can be shared as `?zip=decks/talk.zip`.
 *
 * @param {string} raw The URL as typed or as read from the query string.
 * @param {string} [base] Absolute base for resolving a relative `raw`.
 * @returns {string} The absolute URL.
 * @throws {Error} Loudly, with the reason, on anything not http(s).
 *
 * @example validatedZipUrl("https://example.com/deck.zip")
 * 'https://example.com/deck.zip'
 * @example validatedZipUrl("decks/talk.zip", "https://host.dev/app/")
 * 'https://host.dev/app/decks/talk.zip'
 * @example // refuses a scheme that is not http(s):
 * // validatedZipUrl("javascript:alert(1)")  → throws "only http:// and https:// …"
 */
export function validatedZipUrl(raw, base = undefined) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("No URL given — paste a link to a project .zip.");
  let url;
  try {
    url = base ? new URL(text, base) : new URL(text);
  } catch {
    throw new Error(`Not a valid URL: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http:// and https:// links are supported — got "${url.protocol}" in ${text}`);
  }
  return url.href;
}

/**
 * Pure function. The message shown when a fetch was blocked and there is no
 * proxy to fall back on (the static site).
 *
 * WHY THIS EXISTS AS A FUNCTION: it is the ONE place the CORS explanation is
 * worded, it is asserted by a probe, and its three parts are the contract — name
 * the cause, give the host owner the one-line fix, give the reader a manual path
 * that works today. `zipUrl` is echoed so the message is also the link.
 *
 * @param {string} zipUrl The URL that was blocked.
 * @returns {{title: string, cause: string, hostFix: string, manual: string, url: string}}
 *
 * @example corsHelp("https://example.com/deck.zip").hostFix
 * 'Access-Control-Allow-Origin: *'
 * @example corsHelp("https://example.com/deck.zip").cause.includes("CORS")
 * true
 */
export function corsHelp(zipUrl) {
  return {
    title: "The browser blocked this download (CORS)",
    cause:
      "This page could not read that file because the server hosting it did not send a CORS header. " +
      "The file may well exist and be perfectly fine — the browser refuses to hand it to a page on a different site unless that server opts in.",
    hostFix: "Access-Control-Allow-Origin: *",
    manual: "Download the .zip yourself, then drag the file onto this page — that path does not involve CORS at all.",
    url: zipUrl,
  };
}

/** Thrown when the direct fetch was blocked and no proxy could be used. Carries
 *  the structured help so the UI can render the link as a link, rather than
 *  parsing prose back out of an Error message. */
export class ZipFetchBlockedError extends Error {
  constructor(zipUrl, cause) {
    const help = corsHelp(zipUrl);
    super(`${help.title}: ${zipUrl}`);
    this.name = "ZipFetchBlockedError";
    this.help = help;
    this.cause = cause;
  }
}

/**
 * Query (network). Fetch `url`'s bytes with REAL byte progress.
 *
 * The progress mechanism is deliberately the boot splash's: Content-Length when
 * the server sends one, bytes-so-far when it does not, and NEVER a synthetic
 * percentage. `onProgress` receives `{loaded, total}` with `total` 0 when
 * unknown — the same honesty contract bootProgress.js documents.
 *
 * @param {string} url An already-validated absolute http(s) URL.
 * @param {(p: {loaded: number, total: number}) => void} onProgress
 * @returns {Promise<Uint8Array>}
 */
async function fetchBytesWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const header = res.headers.get("content-length");
  const total = header ? Number(header) : 0;
  if (!res.body?.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress({ loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  onProgress({ loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Query (network). The zip bytes for `url`, trying the browser DIRECTLY first
 * and the server proxy only if that is blocked and a proxy exists.
 *
 * DIRECT FIRST, ALWAYS. A CORS-friendly host (GitHub releases, S3, most CDNs)
 * works everywhere with no server involved, which is the case the static site
 * depends on. The proxy is the FALLBACK for HTTP mode, never the default: it
 * would otherwise route every byte of a large deck through the project server
 * for no reason.
 *
 * A blocked fetch is indistinguishable from an offline one at the JS level —
 * both are a bare TypeError with no detail, by web-security design. So this does
 * not try to tell them apart: it retries through the proxy when there is one,
 * and when there is not, it reports the CORS case because that is the actionable
 * one (and the message's manual path fixes an offline mistake too).
 *
 * @param {string} url Validated absolute http(s) URL.
 * @param {(p: {loaded: number, total: number}) => void} onProgress
 * @param {{proxy?: boolean}} [opts] `proxy: false` forbids the fallback (static mode).
 * @returns {Promise<Uint8Array>}
 * @throws {ZipFetchBlockedError} when direct failed and no proxy was available.
 */
export async function fetchZipBytes(url, onProgress, { proxy = true } = {}) {
  try {
    return await fetchBytesWithProgress(url, onProgress);
  } catch (direct) {
    if (!proxy) throw new ZipFetchBlockedError(url, direct);
    // The server has no same-origin policy — CORS is a browser rule about what a
    // PAGE may read, and a server-side fetch is not a page. It applies its own
    // scheme/size/SSRF rules instead (server.py _handle_fetch_zip).
    console.warn(`Open Project from URL: direct fetch of ${url} failed (${direct.message ?? direct}) — retrying through the project server's proxy.`);
    const proxied = `${BACKEND}/api/fetch-zip/?${new URLSearchParams({ url })}`;
    try {
      return await fetchBytesWithProgress(proxied, onProgress);
    } catch (viaProxy) {
      // The proxy answers JSON {error} on a refusal, so its reason is real text
      // worth showing — unlike the browser's opaque failure above.
      throw new Error(`Could not download ${url}. Direct: ${direct.message ?? direct}. Via the project server: ${viaProxy.message ?? viaProxy}`);
    }
  }
}

/**
 * Pure function. A filename for the File we hand to the existing importer.
 *
 * The importer names the project from the FILE name (projectZipName), so the
 * URL's last path segment is what makes `…/RobotSim.zip` open as "RobotSim"
 * rather than as the archive root's name. A URL with no usable segment falls
 * back to a name the importer will accept.
 *
 * @param {string} url Validated absolute URL.
 * @returns {string} A `.zip` filename.
 *
 * @example zipFileNameFromUrl("https://x.dev/decks/Robot%20Sim.zip?v=2")
 * 'Robot Sim.zip'
 * @example zipFileNameFromUrl("https://x.dev/download?id=7")
 * 'Shared Project.zip'
 */
export function zipFileNameFromUrl(url) {
  const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
  return /\.zip$/i.test(last) ? last : "Shared Project.zip";
}
