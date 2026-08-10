/**
 * MEDIA — video/audio detection and playback-settings assembly for `p:pic`
 * shapes, per research_08. A movie/sound is structurally a `<p:pic>` ("acts
 * very much like an image when it is not playing") — the media-ness comes
 * entirely from `<p:nvPicPr><p:nvPr>` carrying `<a:videoFile>`/`<a:audioFile>`,
 * and separately (PPT2010+, what this deck's own real videos ALL carry) a
 * `<p:extLst><p:ext uri="{DAA4B4D4-...}"><p14:media r:embed="…">` sibling.
 *
 * THE DUAL-RELATIONSHIP PATTERN (research_08 §1, confirmed structurally in
 * the real deck's slide2.xml.rels: `rId2` typed "video" AND `rId1` typed
 * "media" — the SDK's `AddVideoReferenceRelationship` +
 * `AddMediaReferenceRelationship`, two rels naming the SAME target file) —
 * this module resolves BOTH `a:videoFile`/`a:audioFile`'s `r:link`/`r:embed`
 * relationship AND `p14:media`'s `r:embed` relationship, and treats a
 * disagreement between their resolved targets as a REFUSAL (loud, not a
 * silent pick-one) rather than trusting either blindly.
 *
 * LINKED vs EMBEDDED is a property of the RELATIONSHIP's `TargetMode`, not of
 * which XML attribute (`r:link` vs `r:embed`) was used (research_01 §5,
 * research_08 §1) — this module always inspects `.rels`, never infers from
 * the attribute name.
 *
 * PLAYBACK SETTINGS (autoplay/loop/volume/mute/fullscreen) are NOT on the
 * shape at all — they live in the slide's `<p:timing>` tree, keyed by `spid`
 * (research_08 §3B). `mediaPlaybackSettings` (timing.js) reads that half;
 * this module's `resolveMediaForShape` MERGES it in, so a caller gets one
 * complete `media` record per shape regardless of which XML region each half
 * actually lived in.
 */

import { xmlChild, xmlAttr } from "./xml.js";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The `p:extLst/p:ext` uri that identifies a `p14:media` extension block
 * (ECMA-376/MS-PPTX §2.3.1.18's documented GUID for this extension). */
const P14_MEDIA_EXT_URI = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}";

/**
 * Pure function. Detect whether a `p:pic`'s `<p:nvPicPr><p:nvPr>` declares
 * video or audio media, and return the RAW reference info (relationship ids,
 * not yet resolved to archive paths — resolution needs the package's `.rels`,
 * which this function deliberately doesn't take so it stays a pure XML read).
 *
 * @param {object} picNode - a `<p:pic>` element
 * @returns {{kind: "video"|"audio", baseRId: string, baseTargetMode: "link"|"embed", p14RId: string|null}|null} null if this pic is not a media shape
 *
 * @example
 * >>> const pic = parseXml('<p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:nvPicPr><p:nvPr><a:videoFile r:link="rId2"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId1"/></p:ext></p:extLst></p:nvPr></p:nvPicPr></p:pic>');
 * >>> detectMediaReference(pic)
 * {"kind": "video", "baseRId": "rId2", "baseTargetMode": "link", "p14RId": "rId1"}
 * @example detectMediaReference(parseXml('<p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:nvPicPr><p:nvPr/></p:nvPicPr></p:pic>'))
 * null
 */
export function detectMediaReference(picNode) {
  const nvPicPr = xmlChild(picNode, P, "nvPicPr");
  const nvPr = nvPicPr ? xmlChild(nvPicPr, P, "nvPr") : null;
  if (!nvPr) return null;
  const videoFile = xmlChild(nvPr, A, "videoFile");
  const audioFile = xmlChild(nvPr, A, "audioFile");
  const kind = videoFile ? "video" : audioFile ? "audio" : null;
  if (!kind) return null;
  const fileNode = videoFile ?? audioFile;
  const rLink = xmlAttr(fileNode, R, "link");
  const rEmbed = xmlAttr(fileNode, R, "embed");
  const baseRId = rLink ?? rEmbed;
  const baseTargetMode = rLink ? "link" : "embed";
  if (!baseRId) throw new Error(`<a:${kind}File> has neither r:link nor r:embed`);

  let p14RId = null;
  const extLst = xmlChild(nvPr, P, "extLst");
  if (extLst) {
    const ext = extLst.children.find((c) => c.type === "element" && c.ns === P && c.local === "ext" && xmlAttr(c, null, "uri") === P14_MEDIA_EXT_URI);
    if (ext) {
      const p14media = xmlChild(ext, P14, "media");
      if (p14media) p14RId = xmlAttr(p14media, R, "embed", null);
    }
  }
  return { kind, baseRId, baseTargetMode, p14RId };
}

/**
 * Pure function. Resolve a detectMediaReference() result to archive-relative
 * asset info via the slide's relationship map: `{relTarget, embedded}` where
 * `relTarget` is the resolved archive path (for embedded) or the external
 * URI (for a `TargetMode="External"` link), and `embedded` is a bool.
 * REFUSES LOUDLY (per this file's header) when both `a:videoFile`/
 * `a:audioFile`'s relationship AND `p14:media`'s relationship exist but
 * resolve to DIFFERENT targets — never silently prefers one.
 *
 * @param {{kind: string, baseRId: string, baseTargetMode: string, p14RId: string|null}} ref - detectMediaReference() output
 * @param {Map<string, {targetMode: string, resolvedPath: string|null, target: string}>} slideRels - pkg.relationshipsFor(slidePartPath)
 * @param {{where: string}} context - for the thrown message if base and p14 disagree
 * @returns {{relTarget: string, embedded: boolean}}
 * @throws {Error} if the base relationship id is missing from slideRels, or if p14:media's target disagrees with the base
 */
export function resolveMediaTarget(ref, slideRels, context) {
  const baseRel = slideRels.get(ref.baseRId);
  if (!baseRel) throw new Error(`${context.where}: media reference r:${ref.baseTargetMode}="${ref.baseRId}" has no matching relationship in the slide's .rels`);
  const baseTarget = baseRel.targetMode === "External" ? baseRel.target : baseRel.resolvedPath;

  if (ref.p14RId) {
    const p14Rel = slideRels.get(ref.p14RId);
    if (p14Rel) {
      const p14Target = p14Rel.targetMode === "External" ? p14Rel.target : p14Rel.resolvedPath;
      if (p14Target !== baseTarget) {
        throw new Error(`${context.where}: a:${ref.kind}File's relationship (${ref.baseRId} -> ${baseTarget}) and p14:media's relationship (${ref.p14RId} -> ${p14Target}) resolve to DIFFERENT targets — this parser refuses to guess which one PowerPoint actually plays.`);
      }
    }
  }
  return { relTarget: baseTarget, embedded: baseRel.targetMode !== "External" };
}

/**
 * Pure function. Read `p14:trim`/`p14:fade` off a `p14:media` extension
 * element (research_08 §3A) into `{trim, fade}` — both null when absent.
 * Units are kept as the RAW XML milliseconds-with-fractional-precision the
 * spec documents (`p14:trim/@st`/`@end`, `p14:fade/@in`/`@out`), since the
 * exact semantics of `end` (absolute vs from-the-end) are an OPEN QUESTION
 * research_08 flags as unverified — resolving that ambiguity is a translator
 * concern, not this reader's; recording it raw keeps this parser honest about
 * what it actually knows.
 *
 * @param {object|null} p14MediaNode - the `<p14:media>` element, or null
 * @returns {{trim: {stMs: number, endMs: number}|null, fade: {inMs: number, outMs: number}|null}}
 *
 * @example
 * >>> readMediaTrimFade(parseXml('<p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p14:trim st="1000" end="2000"/><p14:fade in="500"/></p14:media>'))
 * {"trim": {"stMs": 1000, "endMs": 2000}, "fade": {"inMs": 500, "outMs": 0}}
 */
export function readMediaTrimFade(p14MediaNode) {
  if (!p14MediaNode) return { trim: null, fade: null };
  const trimNode = xmlChild(p14MediaNode, P14, "trim");
  const fadeNode = xmlChild(p14MediaNode, P14, "fade");
  return {
    trim: trimNode ? { stMs: Number(xmlAttr(trimNode, null, "st", "0")), endMs: Number(xmlAttr(trimNode, null, "end", "0")) } : null,
    fade: fadeNode ? { inMs: Number(xmlAttr(fadeNode, null, "in", "0")), outMs: Number(xmlAttr(fadeNode, null, "out", "0")) } : null,
  };
}

/**
 * Pure function. Read a `p:pic`'s `<p:blipFill><a:blip r:embed="…"/></p:blipFill>`
 * image reference, resolved to an archive path (or external URI). This is
 * the SAME element for THREE distinct roles a `p:pic` can play — an ordinary
 * static picture's own content, a video/audio shape's POSTER frame
 * (research_08 §4), or (rare, not exercised by this deck) a linked image —
 * so this one reader backs both `resolvePosterFrame` (video/audio call site)
 * and `resolvePictureImage` (plain-picture call site) below. Returns `null`
 * if the pic has no blipFill at all (research_08 §4: "A missing/None poster
 * frame is documented as uncommon but legal" — equally legal for a plain
 * picture with e.g. only a solid/gradient spPr fill and no blip).
 *
 * @param {object} picNode
 * @param {Map<string, object>} slideRels
 * @returns {{relTarget: string, embedded: boolean}|null}
 */
export function resolvePicBlip(picNode, slideRels) {
  const blipFill = xmlChild(picNode, P, "blipFill");
  if (!blipFill) return null;
  const blip = xmlChild(blipFill, A, "blip");
  if (!blip) return null;
  const rId = xmlAttr(blip, R, "embed");
  if (!rId) return null;
  const rel = slideRels.get(rId);
  if (!rel) return null;
  return { relTarget: rel.targetMode === "External" ? rel.target : rel.resolvedPath, embedded: rel.targetMode !== "External" };
}

/**
 * Pure function. Read a `p:pic`'s poster-frame reference (video/audio call
 * site) — see resolvePicBlip. Returns just the resolved path/URI (not the
 * `{relTarget, embedded}` pair) since a poster's embedded-ness has never
 * needed to be distinguished by any caller of this function specifically.
 *
 * @param {object} picNode
 * @param {Map<string, object>} slideRels
 * @returns {string|null}
 */
export function resolvePosterFrame(picNode, slideRels) {
  return resolvePicBlip(picNode, slideRels)?.relTarget ?? null;
}

/**
 * Pure function. Read a PLAIN (non-media) picture's own image reference —
 * `{relTarget, embedded}`, or `null` if the pic has no blipFill (e.g. a
 * shape-fill-only picture placeholder, or malformed input). Used by
 * deck.js/attachMedia for every `p:pic` that `detectMediaReference` found
 * was NOT video/audio, so a plain picture's bytes are discoverable the exact
 * same way a video's are — via `mediaParts` plus this shape's own `image`
 * field naming which entry is its own.
 *
 * @param {object} picNode
 * @param {Map<string, object>} slideRels
 * @returns {{relTarget: string, embedded: boolean}|null}
 *
 * @example
 * >>> const pic = parseXml('<p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>');
 * >>> const rels = new Map([["rId1", {targetMode: "Internal", resolvedPath: "ppt/media/image1.png"}]]);
 * >>> resolvePictureImage(pic, rels)
 * {"relTarget": "ppt/media/image1.png", "embedded": true}
 */
export function resolvePictureImage(picNode, slideRels) {
  return resolvePicBlip(picNode, slideRels);
}

/**
 * Query (pure given its inputs). Assemble the COMPLETE `media` record for a
 * `p:pic` shape — reference resolution (this module) MERGED with playback
 * settings (timing.mediaPlaybackSettings, keyed by shapeId) — or `null` if
 * the shape is not media at all. This is the one function deck.js calls per
 * `p:pic`.
 *
 * @param {object} picNode
 * @param {number} shapeId
 * @param {Map<string, object>} slideRels - pkg.relationshipsFor(slidePartPath)
 * @param {Map<number, object>} playbackByShapeId - timing.mediaPlaybackSettings() output
 * @param {{where: string}} context
 * @returns {object|null}
 */
export function resolveMediaForShape(picNode, shapeId, slideRels, playbackByShapeId, context) {
  const ref = detectMediaReference(picNode);
  if (!ref) return null;
  const { relTarget, embedded } = resolveMediaTarget(ref, slideRels, context);
  const nvPr = xmlChild(xmlChild(picNode, P, "nvPicPr"), P, "nvPr");
  const extLst = xmlChild(nvPr, P, "extLst");
  const ext = extLst ? extLst.children.find((c) => c.type === "element" && c.ns === P && c.local === "ext" && xmlAttr(c, null, "uri") === P14_MEDIA_EXT_URI) : null;
  const p14MediaNode = ext ? xmlChild(ext, P14, "media") : null;
  const { trim, fade } = readMediaTrimFade(p14MediaNode);
  const posterRel = resolvePosterFrame(picNode, slideRels);
  const playback = playbackByShapeId.get(shapeId) ?? null;

  return {
    kind: ref.kind,
    relTarget, embedded, posterRel, trim, fade,
    loop: playback ? playback.repeatCount === "indefinite" : false,
    autoplay: playback ? playback.autoplay : false,
    volume: playback ? playback.vol / 100000 : null, // ST_PositiveFixedPercentage: 100000 = 100%
    mute: playback ? playback.mute : false,
    fullScreen: playback ? playback.fullScrn : false,
    isNarration: playback ? playback.isNarration : false,
    showWhenStopped: playback ? playback.showWhenStopped : true,
  };
}
