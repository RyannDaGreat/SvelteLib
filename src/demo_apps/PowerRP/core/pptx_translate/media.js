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
 * POSTER: RESOLVED — mapping spec open question #10 is CLOSED. `plugins/video.js`
 * now carries an optional `thumbnail` (an image asset) plus a `showThumbnail`
 * toggle, added for exactly this translation (user: "for powerpoint, they have
 * thumbnail files for their videos to be shown before playing … to faithfully
 * translate videos from pptx to ours"). The paragraph that used to sit here
 * recorded the gap and the fact that the poster PNG was copied into `assets/`
 * with nothing referencing it; `videoState` now sets `thumbnail` to that same
 * asset, so the bytes that were already being carried finally have a reader.
 *
 * `showThumbnail` IS LEFT FALSE, DELIBERATELY. PowerPoint shows the poster until
 * the clip is played, but OUR players are click-to-play and draw the video
 * themselves, so forcing the still on would replace a working video with a
 * picture on every imported slide. The poster is made AVAILABLE, not imposed: the
 * author flips one toggle (or a headless still renderer benefits from it — see
 * plugins/video.js's THUMBNAIL section). An imported deck therefore looks exactly
 * as it did before this feature, only with the poster now attached.
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
 * THE POSTER lands on `thumbnail` when the caller resolved one (see this file's
 * header for why `showThumbnail` is deliberately NOT set). `posterAssetName` is
 * OPTIONAL and its absence is spelled by OMITTING the key entirely rather than
 * writing `null`: an absent key and a null both fold to "no thumbnail", but only
 * the omission leaves an imported deck byte-identical to one translated before
 * this parameter existed.
 *
 * Args:
 *   projectName (string): the PowerRP project the assets land in
 *   assetName (string): the DE-COLLIDED name the video landed on in assets/
 *   mediaIR (object): {loop, mute, autoplay} from the DeckIR media record
 *   posterAssetName (string|null): the DE-COLLIDED name the POSTER landed on, or null
 *
 * Returns:
 *   object — video widget state (`thumbnail` present only when a poster was given)
 *
 * @example videoState("Deck", "clip.mp4", {loop:true, mute:false, autoplay:false}) // {src: "/asset/Deck/clip.mp4", loop: true, muted: false, autoplay: false}
 * @example videoState("Deck", "clip.mp4", {loop:false, mute:true, autoplay:true}, "image3.png").thumbnail // "/asset/Deck/image3.png"
 * @example "thumbnail" in videoState("Deck", "clip.mp4", {loop:false, mute:false, autoplay:false}) // false
 */
export function videoState(projectName, assetName, mediaIR, posterAssetName = null) {
  return {
    src: assetSrc(projectName, assetName),
    loop: !!mediaIR.loop,
    muted: !!mediaIR.mute,
    autoplay: !!mediaIR.autoplay,
    ...(posterAssetName ? { thumbnail: assetSrc(projectName, posterAssetName) } : {}),
  };
}
