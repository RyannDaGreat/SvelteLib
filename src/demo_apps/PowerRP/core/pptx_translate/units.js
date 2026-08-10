/**
 * UNITS — the EMU→px and rotation/flip conversions every other translate
 * module leans on. DOM-free pure JS (bare-node + browser), matching
 * core/pptx/*'s own convention.
 *
 * px = EMU / 9525 (914400 EMU/in ÷ 96 dpi) — this app's CLAUDE.md states the
 * exact ratio for the translator; deck 1 (12192000×6858000 EMU) lands on
 * exactly 1280×720 px, the historical PowerRP default camera size.
 *
 * ROTATION: PPT's `rot60k` is 60,000ths of a degree, CLOCKWISE, measured from
 * the shape's un-rotated pose — the same clockwise convention PowerRP's own
 * `rotation` property uses (canvas y-down), so the conversion is a bare
 * division, no sign flip.
 *
 * FLIP → NEGATIVE EXTENTS (the app's own "negative extents are a reflection"
 * contract, CLAUDE.md "HANDLE CONSTRAINTS"/"NEGATIVE EXTENTS"): a similarity
 * transform {x,y,rotation,scale} cannot express a mirror, so PowerRP encodes
 * a flip as a negative stored w/h instead. flipH negates w, flipV negates h;
 * both negates both. The negated axis's ORIGIN must also move to the far
 * corner (a negative w with an unmoved x would draw the box growing
 * LEFTWARD off of x, not mirrored in place) — emuBoxToPx below does that.
 */

const EMU_PER_PX = 9525;

/**
 * Pure function. EMU integer → px (canvas units).
 *
 * @param {number} emu
 * @returns {number}
 *
 * @example emuToPx(9525) // 1
 * @example emuToPx(12192000) // 1280
 */
export function emuToPx(emu) {
  return emu / EMU_PER_PX;
}

/**
 * Pure function. PPT's clockwise 60,000ths-of-a-degree rotation → PowerRP
 * degrees (same clockwise/y-down convention, so no sign flip).
 *
 * @param {number} rot60k
 * @returns {number}
 *
 * @example rot60kToDegrees(5400000) // 90
 * @example rot60kToDegrees(0) // 0
 */
export function rot60kToDegrees(rot60k) {
  return rot60k / 60000;
}

/**
 * Pure function. A ShapeIR xfrm's `{offEmu, extEmu, flipH, flipV}` → a
 * PowerRP-space box `{x, y, w, h}` in px, applying the negative-extents flip
 * contract: a flipped axis's stored size goes negative AND its origin shifts
 * to the far edge, so the box's PAINTED footprint (the visual rectangle) is
 * unchanged from the unflipped box — only the stored sign encodes the mirror
 * for the widget's local-space paint to read back out.
 *
 * @param {{offEmu:{x:number,y:number}, extEmu:{w:number,h:number}, flipH:boolean, flipV:boolean}} xfrm
 * @returns {{x:number, y:number, w:number, h:number}}
 *
 * @example emuBoxToPx({offEmu:{x:457200,y:457200}, extEmu:{w:2743200,h:1371600}, flipH:false, flipV:false}) // {x: 48, y: 48, w: 288, h: 144}
 * @example emuBoxToPx({offEmu:{x:0,y:0}, extEmu:{w:9525,h:9525}, flipH:true, flipV:false}) // {x: 1, y: 0, w: -1, h: 1}
 */
export function emuBoxToPx(xfrm) {
  const x = emuToPx(xfrm.offEmu.x);
  const y = emuToPx(xfrm.offEmu.y);
  const w = emuToPx(xfrm.extEmu.w);
  const h = emuToPx(xfrm.extEmu.h);
  return {
    x: xfrm.flipH ? x + w : x,
    y: xfrm.flipV ? y + h : y,
    w: xfrm.flipH ? -w : w,
    h: xfrm.flipV ? -h : h,
  };
}

/**
 * Pure function. Composes a GROUP's child transform onto its slide-space
 * placement — the `off/ext ÷ chOff/chExt` scale ECMA-376 defines for
 * `<a:xfrm>` group children (core/pptx/shapes.js's header documents this as
 * stage 2's job). Deck 1 has no groups, but the math is exercised by the
 * fixture-independent unit test per the task spec.
 *
 * `chOff`/`chExt` are NOT EMU — ECMA-376 defines them as the group's
 * arbitrary "child coordinate space" (an author-chosen local unit every
 * child's own `off`/`ext` is expressed in), used ONLY as the denominator of
 * a scale ratio against the group's REAL on-slide `ext` (which IS EMU).
 * Running them through `emuToPx` would be a unit error — this function
 * takes them as raw numbers and a child's own `off`/`ext` the SAME way
 * (also raw child-space numbers, not pre-converted px), converting to px
 * only at the very end via the group's own EMU->px scale factor.
 *
 * @param {{x:number,y:number}} childOff - the child's OWN off, in the group's child-coordinate-space units (NOT px, NOT EMU)
 * @param {{w:number,h:number}} childExt - the child's OWN ext, same units as childOff
 * @param {{offEmu:{x:number,y:number}, extEmu:{w:number,h:number}, chOffEmu:{x:number,y:number}, chExtEmu:{w:number,h:number}}} groupXfrm - offEmu/extEmu ARE real EMU (the group's own slide placement); chOffEmu/chExtEmu are child-space numbers despite the "Emu" suffix DeckIR's field naming carries (core/pptx/shapes.js parses them as bare numbers off `<a:chOff>`/`<a:chExt>`, never claiming they are EMU)
 * @returns {{x:number, y:number, w:number, h:number}} in px
 *
 * @example composeGroupChildBox({x: 10, y: 10}, {w: 20, h: 20}, {offEmu:{x:0,y:0}, extEmu:{w:952500,h:952500}, chOffEmu:{x:0,y:0}, chExtEmu:{w:50,h:50}}) // {x: 20, y: 20, w: 40, h: 40} (group ext 952500 EMU = 100px, chExt 50 -> scale 2x)
 */
export function composeGroupChildBox(childOff, childExt, groupXfrm) {
  const groupX = emuToPx(groupXfrm.offEmu.x);
  const groupY = emuToPx(groupXfrm.offEmu.y);
  const groupW = emuToPx(groupXfrm.extEmu.w);
  const groupH = emuToPx(groupXfrm.extEmu.h);
  const chOffX = groupXfrm.chOffEmu ? groupXfrm.chOffEmu.x : 0;
  const chOffY = groupXfrm.chOffEmu ? groupXfrm.chOffEmu.y : 0;
  const chExtW = groupXfrm.chExtEmu ? groupXfrm.chExtEmu.w : groupW;
  const chExtH = groupXfrm.chExtEmu ? groupXfrm.chExtEmu.h : groupH;
  const scaleX = chExtW === 0 ? 1 : groupW / chExtW;
  const scaleY = chExtH === 0 ? 1 : groupH / chExtH;
  return {
    x: groupX + (childOff.x - chOffX) * scaleX,
    y: groupY + (childOff.y - chOffY) * scaleY,
    w: childExt.w * scaleX,
    h: childExt.h * scaleY,
  };
}
