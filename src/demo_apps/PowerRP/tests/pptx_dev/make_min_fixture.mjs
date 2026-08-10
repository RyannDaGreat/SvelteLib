#!/usr/bin/env node
/**
 * BUILD tests/fixtures/pptx/minimal.pptx — a tiny, hand-authored .pptx that
 * exercises every feature core/pptx/* claims to parse, so
 * tests/pptx_parse_test.js has a small, COMMITTED, deterministic fixture
 * instead of depending on the (gitignored, 100MB+) real deck in .frenzy/.
 *
 * Run: node tests/pptx_dev/make_min_fixture.mjs
 * (writes tests/fixtures/pptx/minimal.pptx; NOT part of the test gate itself —
 * the fixture it produces is committed, this script is the recipe for
 * regenerating it if the fixture's content ever needs to change.)
 *
 * WHAT'S IN IT (per the task spec):
 *   Slide size 1280x720 (EMU: 12192000 x 6858000... wait, 1280x720 PIXELS at
 *   96dpi = 1280/96*914400 = 12192000 EMU x 720/96*914400 = 6858000 EMU — same
 *   physical size as the real deck's 16:9, expressed in the task's own units).
 *   Slide 1: a rectangle with a solid fill, and a text box with TWO
 *     differently-styled runs (tests run-level property resolution + the
 *     slide->layout->master->theme inheritance chain end to end, since the
 *     text box is placed on a layout/master that itself sets theme-token
 *     fonts/colors the runs partially override).
 *   Slide 1 also: a picture shape referencing the tiny embedded PNG.
 *   Slide 2: a morph transition wrapped in mc:AlternateContent (Choice/p159 +
 *     Fallback/fade) — the alternate-content selection rule's own test.
 *   Slide 2 also: a timing tree with 2 click steps — one plain clickEffect,
 *     one step containing a withEffect PLUS an afterEffect chained to it with
 *     a delay (afterEffect does NOT appear anywhere in the real deck's own
 *     timing trees, so this fixture is the ONLY place that chain is pinned).
 *   Slide 3: minimal, exists mainly to prove multi-slide sldIdLst walking
 *     works (and deliberately uses a NON-SEQUENTIAL r:id, so a parser that
 *     assumed rIdN == slide N would be wrong — same trap research_10 flagged
 *     for filename order, applied here to relationship ids instead).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "fixtures", "pptx", "minimal.pptx");

const NS = {
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  r_pkg: "http://schemas.openxmlformats.org/package/2006/relationships",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  p159: "http://schemas.microsoft.com/office/powerpoint/2015/09/main",
  p14: "http://schemas.microsoft.com/office/powerpoint/2010/main",
};

// A real, minimal, valid 1x1 red PNG (70 bytes) — small enough to inline as
// base64 directly in this recipe rather than shipping a separate binary
// fixture-of-a-fixture.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS.ct}">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.r_pkg}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

// Deliberately non-sequential r:ids (rId9/rId2/rId5) for the three slides, so
// a parser that assumed r:id order == slide order (rather than walking
// sldIdLst's OWN order, which this presentation.xml also deliberately does
// not write in rId-ascending order) would misorder them.
const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>
<p:sldId id="256" r:id="rId9"/>
<p:sldId id="257" r:id="rId2"/>
<p:sldId id="258" r:id="rId5"/>
</p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;

const presentationRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.r_pkg}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`;

const themeXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS.a}" name="FixtureTheme">
<a:themeElements>
<a:clrScheme name="Fixture">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F2A44"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Fixture">
<a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Verdana"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
</a:themeElements>
</a:theme>`;

// The master declares a title + body placeholder and txStyles level-1 defaults
// (titleStyle: 44pt bold theme-major-font tx1; bodyStyle: 24pt theme-minor-font
// tx1) — the fixture's slide1 text box is NOT a placeholder (it's a plain
// textbox, matching the REAL deck's own dominant pattern per research_10), so
// its runs inherit via otherStyle, not titleStyle/bodyStyle; a placeholder
// path is exercised implicitly by the layout/master's own title/body shapes
// existing and being resolvable, per inherit.js's contract, even though this
// minimal fixture's slide CONTENT doesn't route through them. Kept minimal
// deliberately — a placeholder-routed run is exactly what inherit.js's own
// pure-function doctests already pin in isolation; the fixture's job is the
// FULL PARSE PATH, not re-proving each unit twice.
const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">
<p:cSld>
<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="11277600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Master title</a:t></a:r></a:p></p:txBody>
</p:sp>
<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="Body Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="11277600" cy="4525963"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Master body</a:t></a:r></a:p></p:txBody>
</p:sp>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles>
<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle>
</p:txStyles>
</p:sldMaster>`;

const masterRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.r_pkg}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;

const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

const layoutRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.r_pkg}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

// SLIDE 1: a rectangle with solid fill, and a text box with two
// differently-styled runs (bold+larger vs plain), plus a picture referencing
// the embedded PNG.
const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Rect 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="457200" y="457200"/><a:ext cx="2743200" cy="1371600"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
<a:solidFill><a:srgbClr val="336699"/></a:solidFill>
<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>
</p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>
</p:sp>
<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="TextBox 2"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="457200" y="2286000"/><a:ext cx="5486400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody>
<a:bodyPr wrap="square"/>
<a:lstStyle/>
<a:p>
<a:r><a:rPr lang="en-US" sz="3200" b="1"><a:solidFill><a:srgbClr val="CC0000"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>Bold Red Run</a:t></a:r>
<a:r><a:rPr lang="en-US" sz="1800" i="1"/><a:t> and a plain italic run</a:t></a:r>
</a:p>
</p:txBody>
</p:sp>
<p:pic>
<p:nvPicPr><p:cNvPr id="4" name="Picture 3"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="6400800" y="457200"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;

const slide1RelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.r_pkg}">
<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`;

// SLIDE 2: a morph transition in mc:AlternateContent (Choice/p159 + Fallback),
// and a timing tree with 2 click steps: step 1 is a plain clickEffect; step 2
// contains a withEffect PLUS an afterEffect chained to it with a 750ms delay
// (this exact chain does not occur in the real deck, per research_04/research_10
// — it is exercised HERE, deliberately, since the spec requires it pinned).
const slide2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" xmlns:mc="${NS.mc}">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Circle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="1500000" cy="1500000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>
</p:sp>
<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="Square 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="4000000" y="1000000"/><a:ext cx="1500000" cy="1500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>
</p:sp>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
<mc:AlternateContent xmlns:p159="${NS.p159}">
<mc:Choice Requires="p159">
<p:transition spd="slow" xmlns:p14="${NS.p14}" p14:dur="1500"><p159:morph option="byObject"/></p:transition>
</mc:Choice>
<mc:Fallback>
<p:transition spd="slow"><p:fade/></p:transition>
</mc:Fallback>
</mc:AlternateContent>
<p:timing>
<p:tnLst>
<p:par>
<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">
<p:childTnLst>
<p:seq concurrent="1" nextAc="seek">
<p:cTn id="2" dur="indefinite" nodeType="mainSeq">
<p:childTnLst>
<p:par>
<p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>
<p:childTnLst>
<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>
<p:childTnLst>
<p:par><p:cTn id="5" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst>
<p:childTnLst>
<p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>
<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="7" dur="500" fill="hold"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cBhvr></p:animEffect>
</p:childTnLst>
</p:cTn></p:par>
</p:childTnLst>
</p:cTn></p:par>
</p:childTnLst>
</p:cTn>
</p:par>
<p:par>
<p:cTn id="8" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>
<p:childTnLst>
<p:par><p:cTn id="9" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>
<p:childTnLst>
<p:par><p:cTn id="10" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" nodeType="withEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst>
<p:childTnLst>
<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="11" dur="500" fill="hold"/><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cBhvr></p:animEffect>
</p:childTnLst>
</p:cTn></p:par>
<p:par><p:cTn id="12" presetID="1" presetClass="emph" presetSubtype="0" fill="hold" nodeType="afterEffect"><p:stCondLst><p:cond delay="750"><p:tn val="10"/></p:cond></p:stCondLst>
<p:childTnLst>
<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="13" dur="300" fill="hold"/><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cBhvr></p:animEffect>
</p:childTnLst>
</p:cTn></p:par>
</p:childTnLst>
</p:cTn></p:par>
</p:childTnLst>
</p:cTn>
</p:par>
</p:childTnLst>
</p:cTn>
<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>
<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>
</p:seq>
</p:childTnLst>
</p:cTn>
</p:par>
</p:tnLst>
</p:timing>
</p:sld>`;

const slide2RelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.r_pkg}">
<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;

// SLIDE 3: minimal — exists to prove multi-slide sldIdLst walking (in
// AUTHORED order, via a non-sequential r:id) works end to end.
const slide3Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Last Slide Marker"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="2743200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Slide Three</a:t></a:r></a:p></p:txBody>
</p:sp>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;

const slide3RelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.r_pkg}">
<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function utf8(text) {
  return new TextEncoder().encode(text);
}

const entries = {
  "[Content_Types].xml": utf8(contentTypesXml),
  "_rels/.rels": utf8(rootRelsXml),
  "ppt/presentation.xml": utf8(presentationXml),
  "ppt/_rels/presentation.xml.rels": utf8(presentationRelsXml),
  "ppt/theme/theme1.xml": utf8(themeXml),
  "ppt/slideMasters/slideMaster1.xml": utf8(masterXml),
  "ppt/slideMasters/_rels/slideMaster1.xml.rels": utf8(masterRelsXml),
  "ppt/slideLayouts/slideLayout1.xml": utf8(layoutXml),
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels": utf8(layoutRelsXml),
  "ppt/slides/slide1.xml": utf8(slide1Xml),
  "ppt/slides/_rels/slide1.xml.rels": utf8(slide1RelsXml),
  "ppt/slides/slide2.xml": utf8(slide2Xml),
  "ppt/slides/_rels/slide2.xml.rels": utf8(slide2RelsXml),
  "ppt/slides/slide3.xml": utf8(slide3Xml),
  "ppt/slides/_rels/slide3.xml.rels": utf8(slide3RelsXml),
  "ppt/media/image1.png": b64ToBytes(TINY_PNG_BASE64),
};

const zipped = zipSync(entries, { level: 6 });
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, zipped);
console.log(`wrote ${OUT_PATH} (${zipped.length} bytes, ${Object.keys(entries).length} parts)`);
