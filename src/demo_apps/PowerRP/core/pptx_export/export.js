/**
 * PowerRP -> PPTX. `exportDeck(doc, {assetBytes}) -> {bytes, report}`, the
 * export direction's single entry point, symmetric with core/pptx/deck.js's
 * `parsePptx(bytes) -> DeckIR` on the import side.
 *
 * ARCHITECTURE (the lead's decision, .frenzy/research_09_export_pptx.md):
 * NO pptxgenjs dependency. We already ship fflate and know the OPC/OOXML
 * anatomy from the parser (core/pptx/*), so this writes the .pptx zip
 * DIRECTLY — content types, rels, presentation.xml, slide XML, media parts —
 * with a small writer of our own (core/pptx_export/xml_writer.js +
 * package_parts.js). This keeps export dependency-free, symmetric with
 * import, and able to emit ANYTHING (morph, timing) a library would refuse.
 *
 * v1 SCOPE (task spec): "deck-1-class documents" — one document, no
 * cross-document refs, PER-SLIDE full-fold snapshots only (no click-step /
 * mid-slide timing trees — see the DEFERRED note at the bottom of this file).
 * Each PowerRP slide -> one PPT slide, at alpha 1 (`slideState`, the FOLDED
 * end-state every slide settles into — the picture a viewer sees once its own
 * transition finishes, which is the only "one slide, one static picture"
 * reading that makes sense for a deck that also carries continuous
 * mid-transition tweens PowerPoint's morph reproduces on ITS OWN, not ours to
 * pre-bake).
 *
 * THE PIPELINE MIRRORS cli/render.js's OWN (repair -> evaluate -> derive),
 * because that is this app's one canonical fold+evaluate+derive recipe and
 * cli/render.js already proves it runs in bare node: `repairedDocument` ->
 * `evaluatedStateAt` (web/cameraFrame.js — DOM-free despite living in web/,
 * confirmed by cli/render.js's own bare-node import of it) -> `deriveRenderTree`
 * (core/derive.js) for z-order + resolved world transform + flip per item.
 *
 * COORDINATE FRAME: THE CAMERA's rect at (slide, alpha=1) becomes the PPT
 * slide's origin+size — i.e. this exports exactly what the camera FRAMES, not
 * the raw meta.slideW/H canvas (an author may pan/zoom the camera per slide;
 * exporting the un-cropped canvas would silently show content the presenter
 * never displays). Every item's world position is expressed relative to that
 * camera rect before EMU conversion.
 */

import { slideState, repairedDocument, deserialize, serialize } from "../document.js";
import { createRegistry } from "../registry.js";
import { registerAll } from "../../plugins/index.js";
import { deriveRenderTree, cameraRect } from "../derive.js";
import { evaluateState } from "../expressions.js";
import { resolveTransition } from "../transitions.js";

import { zipSync } from "fflate";
import { pxToEmu } from "./units.js";
import { contentTypesXml, presentationXml, presentationRelsXml, rootRelsXml, themeXml, slideMasterXml, slideMasterRelsXml, slideLayoutXml, slideLayoutRelsXml, REL_TYPE } from "./package_parts.js";
import { slideTransitionXml } from "./transition_xml.js";
import { SHAPE_BUILDERS, imageShapeXml, placeholderShapeXml } from "./shape_xml.js";
import { tag, xmlDocument } from "./xml_writer.js";

/**
 * Pure function. A render-tree node re-expressed relative to `cameraOrigin`
 * (subtracted from its world x/y — scale/rotation untouched, a pure
 * translation) — the one seam that makes the camera rect the export's origin
 * without touching any shape builder's own math (they all read
 * `node.world`/`node.state` uniformly).
 *
 * @param {object} node
 * @param {{x:number,y:number}} cameraOrigin
 * @returns {object}
 */
function nodeRelativeToCamera(node, cameraOrigin) {
  return { ...node, world: { ...node.world, x: node.world.x - cameraOrigin.x, y: node.world.y - cameraOrigin.y } };
}

/**
 * Command (pushes to `report`; reads/writes `deckMedia`). One PowerRP item ->
 * its shape/pic XML, plus a per-slide media relationship (if any).
 *
 * `deckMedia` is a DECK-WIDE cache (`Map<src, {deckFileName, ext, bytes}>`,
 * owned by exportDeck and threaded through every slide's call) — an item
 * persisting across the slides it appears on IS the "symlink" (this app's
 * CLAUDE.md: "An item appearing across slides IS the symlink... same UUID,
 * same object"), so the SAME image widget seen on slide 1 and slide 5 must
 * embed its bytes exactly ONCE — the same principle core/pptx/deck.js's own
 * importer states for the read direction ("image3.png reused across 8 slides
 * must be counted ONCE, not once per referencing shape"). Deduping by `src`
 * string (not itemId) also catches two DIFFERENT items sharing one
 * copy-pasted `src`. `spId` is a per-slide unique numeric id (OOXML's own
 * `cNvPr id` requirement).
 *
 * @returns {{xml: string, media: {relId:string, deckFileName:string}|null}}
 */
function itemToShapeXml(node, spId, nextMediaRelId, deckMedia, report) {
  if (node.type === "image") return imageShapeXml(node, spId, nextMediaRelId, deckMedia, report);
  const builder = SHAPE_BUILDERS[node.type];
  if (builder) return { xml: builder(node, spId, report), media: null };
  report.push(`shape "${node.state.name || node.itemId}" (type "${node.type}"): no PPTX equivalent for this widget type — downgraded to a placeholder rect naming it`);
  return { xml: placeholderShapeXml(node, spId, node.type), media: null };
}

/**
 * Command (reads/writes `deckMedia` — see itemToShapeXml's docstring). One
 * slide's `<p:sld>` XML + its `.rels` XML. `isFirstSlide` gates transition
 * emission (slide 0 has no predecessor — core/transitions.js).
 *
 * @param {object} doc
 * @param {number} slideIndex
 * @param {object} registry
 * @param {Map<string,{deckFileName:string,ext:string,bytes:Uint8Array}>} deckMedia
 * @param {string[]} report - mutated
 * @returns {{sldXml: string, relsXml: string}}
 */
function buildSlide(doc, slideIndex, registry, deckMedia, report) {
  const folded = slideState(doc, slideIndex); // alpha-1 fold — see file header
  const evaluated = evaluateState(folded, registry, doc.meta.script ?? "", null, doc.meta?.varKinds ?? null).state;
  const cam = cameraRect(evaluated, doc.meta);
  const tree = deriveRenderTree(evaluated, registry).map((n) => nodeRelativeToCamera(n, cam));

  let spId = 2; // 1 is reserved for the spTree's own group shape (package_parts.js convention)
  let mediaRelCounter = 0;
  const nextMediaRelId = () => `rIdImg${++mediaRelCounter}`;
  const slideMediaRefs = []; // {relId, deckFileName} — THIS slide's own references, for its .rels

  let spTreeShapes = "";
  for (const node of tree) {
    // THE CAMERA ITSELF is the view, not a drawn shape — never exported as a
    // shape (it has no visual ink of its own; its rect IS this slide's frame).
    if (node.type === "camera") continue;
    const { xml, media } = itemToShapeXml(node, spId, nextMediaRelId, deckMedia, report);
    spTreeShapes += xml;
    if (media) slideMediaRefs.push(media);
    spId++;
  }

  const grpSpPr = tag("p:nvGrpSpPr", {}, tag("p:cNvPr", { id: 1, name: "" }) + tag("p:cNvGrpSpPr") + tag("p:nvPr")) +
    tag("p:grpSpPr", {}, tag("a:xfrm", {}, tag("a:off", { x: 0, y: 0 }) + tag("a:ext", { cx: 0, cy: 0 }) + tag("a:chOff", { x: 0, y: 0 }) + tag("a:chExt", { cx: 0, cy: 0 })));
  const cSld = tag("p:cSld", {}, tag("p:spTree", {}, grpSpPr + spTreeShapes));
  const clrMapOvr = tag("p:clrMapOvr", {}, tag("a:masterClrMapping"));

  const isFirstSlide = isFirstIndex(slideIndex);
  const transition = isFirstSlide ? null : resolveTransition(doc, slideIndex);
  const transitionXml = isFirstSlide ? "" : slideTransitionXml(transition, doc.slides[slideIndex].autoAdvance, false);

  const sldXml = xmlDocument(
    tag(
      "p:sld",
      { "xmlns:a": "http://schemas.openxmlformats.org/drawingml/2006/main", "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "xmlns:p": "http://schemas.openxmlformats.org/presentationml/2006/main" },
      cSld + clrMapOvr + transitionXml,
    ),
  );

  let rels = tag("Relationship", { Id: "rIdL1", Type: REL_TYPE.slideLayout, Target: "../slideLayouts/slideLayout1.xml" });
  for (const m of slideMediaRefs) rels += tag("Relationship", { Id: m.relId, Type: REL_TYPE.image, Target: `../media/${m.deckFileName}` });
  const relsXml = xmlDocument(tag("Relationships", { xmlns: "http://schemas.openxmlformats.org/package/2006/relationships" }, rels));

  return { sldXml, relsXml };
}

function isFirstIndex(i) {
  return i === 0;
}

/**
 * Command (throws on structural failure — an unrepairable document, an
 * unrecognized transition/align/paint type; never on a merely-unsupported
 * WIDGET TYPE, which downgrades to a placeholder + report line instead, per
 * this app's extensibility law). PowerRP document -> `.pptx` bytes.
 *
 * @param {object} doc - a PowerRP document ({meta, slides})
 * @param {{assetBytes?: Record<string,Uint8Array>}} [opts] - reserved for a
 *   future non-data-URI asset resolution path (assets referenced by a project
 *   asset path rather than an inline data: URI); UNUSED in v1 — every
 *   embeddable image in v1 must be a `data:` URI already inline in the
 *   document, which is how every image widget's `src` is stored today
 *   (plugins/image.js's own header: "self-contained... works offline").
 * @returns {{bytes: Uint8Array, report: string[]}}
 */
export function exportDeck(doc, { assetBytes = {} } = {}) {
  void assetBytes; // reserved — see docstring
  const registry = createRegistry();
  registerAll(registry, { add() {} }); // a command registry stub: exportDeck never runs a command, only reads plugin defs

  const report = [];
  const slideCount = doc.slides.length;
  if (slideCount === 0) throw new Error("exportDeck: document has no slides");

  const cam0 = cameraRect(evaluateState(slideState(doc, 0), registry, doc.meta.script ?? "", null, doc.meta?.varKinds ?? null).state, doc.meta);
  const slideSizeEmu = { w: pxToEmu(cam0.w), h: pxToEmu(cam0.h) };

  const entries = {};
  // DECK-WIDE media dedup cache (see itemToShapeXml's docstring): shared by
  // EVERY slide's buildSlide call, so the same image `src` embeds exactly
  // once no matter how many slides an image item appears on.
  const deckMedia = new Map();

  for (let i = 0; i < slideCount; i++) {
    const { sldXml, relsXml } = buildSlide(doc, i, registry, deckMedia, report);
    entries[`ppt/slides/slide${i + 1}.xml`] = new TextEncoder().encode(sldXml);
    entries[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = new TextEncoder().encode(relsXml);
  }

  const imageExtensions = new Set();
  for (const { deckFileName, ext, bytes } of deckMedia.values()) {
    imageExtensions.add(ext);
    entries[`ppt/media/${deckFileName}`] = bytes;
  }

  entries["[Content_Types].xml"] = new TextEncoder().encode(contentTypesXml(slideCount, [...imageExtensions]));
  entries["_rels/.rels"] = new TextEncoder().encode(rootRelsXml());
  entries["ppt/presentation.xml"] = new TextEncoder().encode(presentationXml(slideCount, slideSizeEmu));
  entries["ppt/_rels/presentation.xml.rels"] = new TextEncoder().encode(presentationRelsXml(slideCount));
  entries["ppt/theme/theme1.xml"] = new TextEncoder().encode(themeXml());
  entries["ppt/slideMasters/slideMaster1.xml"] = new TextEncoder().encode(slideMasterXml());
  entries["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = new TextEncoder().encode(slideMasterRelsXml());
  entries["ppt/slideLayouts/slideLayout1.xml"] = new TextEncoder().encode(slideLayoutXml());
  entries["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = new TextEncoder().encode(slideLayoutRelsXml());

  const bytes = zipSync(entries, { level: 6 });
  return { bytes, report };
}

/**
 * Command (reads nothing itself; console.errors repair reports — the
 * cli/render.js boundary precedent). Parses + repairs a `.powerrp.json`
 * document's text in one step, so cli/export_pptx.js never re-implements
 * this boundary. exportDeck itself does NOT call this — it expects an
 * already-repaired document, matching cli/render.js's own division of labor
 * (see exportDeck's own docstring).
 *
 * @param {string} docJson
 * @returns {object} repaired PowerRP document
 */
export function loadAndRepairDocJson(docJson) {
  const registry = createRegistry();
  registerAll(registry, { add() {} });
  const { doc, reports } = repairedDocument(deserialize(docJson), registry);
  for (const line of reports) console.error(line);
  return doc;
}

// Re-exported for tests/dev scripts that hand-build a minimal fixture
// document and want to serialize it without importing core/document.js
// separately.
export { serialize };

/**
 * DEFERRED TO v2 (stated per the task spec, not merely omitted): CLICK-STEP
 * TIMING TREES. PowerRP's own click-step/animation model (this app does not
 * yet model per-item entrance/exit "click to reveal" — the closest analogue
 * is a slide's own tween transition, which this exporter DOES export, via
 * morph) has no v1 representation, so nothing here builds a `<p:timing>`
 * tree. Building one needs: (1) a PowerRP-side concept of "step N reveals
 * item X" to iterate over — core/presentation.js's playback model is
 * per-SLIDE, not per-click-within-a-slide, so this is a PowerRP feature gap
 * before it is an exporter gap; (2) per-effect `spid` targeting, which needs
 * shape ids stable across the SAME slide's own steps (already have this — the
 * per-slide `spId` counter here) but ALSO a target-selection scheme distinct
 * from morph's cross-slide `!!id` naming (timing targets a `spid` INTEGER, not
 * a name). Out of scope for v1's "deck-1-class documents" (static per-slide
 * snapshots only).
 */
