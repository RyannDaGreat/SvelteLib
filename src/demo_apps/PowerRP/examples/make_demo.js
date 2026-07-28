/**
 * Builds examples/demo.powerrp.json through the core API — both a fixture
 * for the CLI renderer and a worked example of authoring a document in code.
 *
 * The deck: slide 1 lays out shapes with an arrow bound to the circle's
 * computed "closest" anchor via EQUATION endpoints (THE UNIFICATION:
 * "@<itemId>_<anchorId>.x" strings — the idiom the editor writes when an
 * endpoint is dropped on an anchor); slide 2 tweens positions/colors (the
 * arrow follows its bound circle automatically); slide 3 drops a blur layer
 * with a magnifier above it (backdrop-sampler stacking) and deactivates the
 * text (the `active` mechanism: same item lives on slides 1-2 but not 3).
 *
 * ── DO NOT RUN THIS TO "REFRESH" THE FIXTURE (measured, 2026-07-28) ──────────
 * It OVERWRITES examples/demo.powerrp.json with FRESH uuids, and nine probes
 * hardcode the committed ids (align_mirror, crosshair, flip, keyframe_freeze,
 * modal_xform, palette, registry_ui, theme, toolspane) — so one run turns nine
 * green probes red for a reason no diff explains. It also still emits two legacy
 * shapes that repairedDocument() migrates loudly: `text` as a bare string (→ rich
 * runs) and a magnifier built from the RAW plugin export, whose `defaults` lack the
 * universal-effects keys that only createRegistry().register() injects. That is
 * why PowerRP's CLAUDE.md calls this a worked example, not a fixture regenerator.
 *
 * To bring the committed fixture up to date with its plugins, re-serialize IT
 * through repairedDocument() instead — the ids survive and the diff is purely the
 * added defaults.
 *
 * Run (as an EXAMPLE, expecting the fixture to be overwritten):
 *   node src/demo_apps/PowerRP/examples/make_demo.js
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { newDocument, withNewItem, withNewSlide, keyframed, serialize } from "../core/document.js";
import { rectPlugin } from "../plugins/rect.js";
import { circlePlugin } from "../plugins/circle.js";
import { textPlugin } from "../plugins/text.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { magnifierPlugin } from "../plugins/magnifier.js";
import { blurPlugin } from "../plugins/blur.js";

let doc = newDocument();
doc = { ...doc, meta: { ...doc.meta, name: "PowerRP Demo" } };

let rect, circle, text, arrow, magnifier, blur;
[doc, rect] = withNewItem(doc, 0, { ...rectPlugin.defaults, x: 120, y: 160, w: 260, h: 160, z: 1 });
[doc, circle] = withNewItem(doc, 0, { ...circlePlugin.defaults, x: 760, y: 200, w: 180, h: 180, z: 2 });
[doc, text] = withNewItem(doc, 0, { ...textPlugin.defaults, x: 120, y: 60, text: "PowerRP V1", size: 48, z: 3 });
[doc, arrow] = withNewItem(doc, 0, {
  ...arrowPlugin.defaults,
  from: { x: `@${rect}_mr.x`, y: `@${rect}_mr.y` },
  to: { x: `@${circle}_closest.x`, y: `@${circle}_closest.y` },
  z: 4,
});

// Slide 2: move the circle far away and recolor the rect — the arrow's bound
// endpoints follow with zero keyframes of their own.
[doc] = withNewSlide(doc, 0);
doc = keyframed(doc, 1, ["items", circle, "x"], 300);
doc = keyframed(doc, 1, ["items", circle, "y"], 420);
doc = keyframed(doc, 1, ["items", rect, "fill"], "#2ac3a2");
doc = keyframed(doc, 1, ["items", rect, "rotation"], 0.3);

// Slide 2 also tweens THE CAMERA (newDocument created it on slide 0): zoom
// toward the circle's destination — a live demo of camera moves.
const camId = Object.entries(doc.slides[0].delta.items).find(([, s]) => s.type === "camera")[0];
doc = keyframed(doc, 1, ["items", camId, "x"], 100);
doc = keyframed(doc, 1, ["items", camId, "y"], 150);
doc = keyframed(doc, 1, ["items", camId, "w"], 800);
doc = keyframed(doc, 1, ["items", camId, "h"], 450);

// Slide 3: blur layer + magnifier stacked above it; text deactivates.
[doc] = withNewSlide(doc, 1);
doc = keyframed(doc, 2, ["items", text, "active"], false);
[doc, blur] = withNewItem(doc, 2, { ...blurPlugin.defaults, z: 10, blur: 5 });
[doc, magnifier] = withNewItem(doc, 2, { ...magnifierPlugin.defaults, x: 400, y: 380, radius: 110, magnification: 2.2, z: 11 });

const out = resolve(dirname(fileURLToPath(import.meta.url)), "demo.powerrp.json");
await writeFile(out, serialize(doc));
console.log(`Wrote ${out} (${doc.slides.length} slides, items: rect=${rect} circle=${circle} text=${text} arrow=${arrow} blur=${blur} magnifier=${magnifier})`);
