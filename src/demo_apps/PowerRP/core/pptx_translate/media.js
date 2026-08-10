/**
 * MEDIA — DeckIR `image`/`media` descriptors -> `plugins/image.js` /
 * `plugins/video.js` state, per the mapping spec §7.
 *
 * ASSET PATHS: `src` is `/asset/<projectName>/<assetName>` (this app's asset
 * grammar — server.py's `ASSET_REF_PREFIX`, confirmed against
 * tests/self_contained_zip_test.py's own fixtures), never a bare filename
 * and never a data: URI — the CLI writes the actual bytes to
 * `<outDir>/assets/<assetName>` separately (translate.js's `assets` output).
 *
 * POSTER: `plugins/video.js` has NO poster-image field (measured directly —
 * grepped the plugin's own state/docblock; the mapping spec's open question
 * #10 is confirmed unresolved in code as of this translator). A video's
 * poster PNG is still copied into `assets/` (so nothing is silently
 * dropped — a future poster feature can wire it with no re-import) but the
 * item state carries no reference to it; this is reported as a gap, not a
 * silent omission.
 *
 * TRIM: `plugins/video.js` also has no trim-in/trim-out state (measured the
 * same way). A `p14:trim` on a translated video is reported, not applied.
 */

/**
 * Pure function. De-collides a proposed asset basename against a set of
 * names already claimed — `"image1.png"`, `"image1_2.png"`, `"image1_3.png"`,
 * ... — so two PPTX media parts that would land on the same PowerRP asset
 * name (rare, since PPTX archive paths are already unique, but two
 * differently-cased or differently-pathed original names could still
 * collide after this translator's own basename-only convention) never
 * overwrite each other.
 *
 * @param {string} proposed
 * @param {Set<string>} claimed - mutated: the returned name is added
 * @returns {string}
 *
 * @example decollidedAssetName("image1.png", new Set()) // "image1.png"
 * @example decollidedAssetName("image1.png", new Set(["image1.png"])) // "image1_2.png"
 */
export function decollidedAssetName(proposed, claimed) {
  if (!claimed.has(proposed)) {
    claimed.add(proposed);
    return proposed;
  }
  const dot = proposed.lastIndexOf(".");
  const stem = dot === -1 ? proposed : proposed.slice(0, dot);
  const ext = dot === -1 ? "" : proposed.slice(dot);
  let n = 2;
  let candidate = `${stem}_${n}${ext}`;
  while (claimed.has(candidate)) { n++; candidate = `${stem}_${n}${ext}`; }
  claimed.add(candidate);
  return candidate;
}

/**
 * Pure function. The basename of a DeckIR media part's archive path (e.g.
 * "ppt/media/image1.png" -> "image1.png") — the proposed PowerRP asset name
 * before de-collision.
 *
 * @param {string} archivePath
 * @returns {string}
 *
 * @example assetBasename("ppt/media/image1.png") // "image1.png"
 */
export function assetBasename(archivePath) {
  const idx = archivePath.lastIndexOf("/");
  return idx === -1 ? archivePath : archivePath.slice(idx + 1);
}

/**
 * Pure function. `/asset/<projectName>/<assetName>` — this app's asset
 * reference grammar (server.py ASSET_REF_PREFIX).
 *
 * @param {string} projectName
 * @param {string} assetName
 * @returns {string}
 *
 * @example assetSrc("Deck", "logo.png") // "/asset/Deck/logo.png"
 */
export function assetSrc(projectName, assetName) {
  return `/asset/${projectName}/${assetName}`;
}

/**
 * Pure function. A DeckIR plain `image` descriptor -> `plugins/image.js`
 * extra state (just `src` — crop insets are a separate call, see
 * imageCropInsets below since deck 1 has no `a:srcRect` to exercise it).
 *
 * @param {string} projectName
 * @param {string} assetName - the DE-COLLIDED name this media part landed on in assets/
 * @returns {{src: string}}
 */
export function imageState(projectName, assetName) {
  return { src: assetSrc(projectName, assetName) };
}

/**
 * Pure function. A DeckIR `media` (video) descriptor -> `plugins/video.js`
 * extra state — DIRECT for src/loop/muted; `autoplay` maps the static
 * DeckIR flag directly (mapping spec §7/§8: "DIRECT for the boolean itself"
 * — the click-to-play TIMING semantics are handled by translate.js's
 * click-step expansion, not here, per the mapping spec's own split).
 *
 * @param {string} projectName
 * @param {string} assetName
 * @param {{loop:boolean, mute:boolean, autoplay:boolean}} mediaIR
 * @returns {{src: string, loop: boolean, muted: boolean, autoplay: boolean}}
 *
 * @example videoState("Deck", "clip.mp4", {loop:true, mute:false, autoplay:false}) // {src: "/asset/Deck/clip.mp4", loop: true, muted: false, autoplay: false}
 */
export function videoState(projectName, assetName, mediaIR) {
  return {
    src: assetSrc(projectName, assetName),
    loop: !!mediaIR.loop,
    muted: !!mediaIR.mute,
    autoplay: !!mediaIR.autoplay,
  };
}
