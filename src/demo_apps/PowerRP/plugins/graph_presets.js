/**
 * GRAPH FAMILY PRESETS — plain preset DATA for the graph* widgets, shared here so
 * the four plugin files stay focused on behaviour. This is NOT a plugin: it
 * exports no plugin object, registers nothing, and imports no plugin — it is a
 * data module the way core/shapes.js is, so it does not touch the one-plugin-per-
 * file / no-plugin-imports-another convention. Each entry is `{name, description,
 * props}` (the registry preset shape), applied as one undo unit via
 * app.applyPreset (the mermaid MERMAID_DEMO_PRESETS precedent).
 *
 * The presets mantra (manifest item 70): ≥10 genuinely distinct presets per
 * knob-rich widget, from many angles. The graphLine roster is the equation zoo
 * (frenzy digest 04) — heart, roses, both spirals + the λ-morph, catenary,
 * cycloid, Lissajous, superellipse, sum-of-sines, and the user's explicitly-asked
 * iterative Fibonacci. It is the one roster that applies a SUBSET of its authored
 * props — the curve definition only, per the 2026-08-02 ruling documented at
 * `curveDefinitionOnly` below; its Manim-palette styling (digest 02) survives as
 * reference data in GRAPH_LINE_TUNING. The graphBars roster
 * is digest 10's eleven designs. graphTickMarks/graphGrid rosters come at their
 * widgets from mathematical, Manim-aesthetic, and practical-chart angles.
 *
 * Powers use `**`/`pow()` — `^` is JavaScript XOR (see the widgets' help text).
 */

// ── Manim palette (frenzy digest 02) ─────────────────────────────────────────
const BLUE_C = "#58C4DD", YELLOW_C = "#F7D96F", RED_C = "#FC6255", GREEN_C = "#83C167";
const PINK = "#D147BD", TEAL = "#5CD0B3", PURPLE = "#9A72AC", GOLD = "#F0AC5F";
const ORANGE = "#FF862F", BLUE_B = "#9CDCEB", MAROON = "#C55F73";

const TWO_PI = 6.2832, FOUR_PI = 12.5664, SIX_PI = 18.8496, EIGHT_PI = 25.1327;

/**
 * THE EQUATION ZOO WRITES ONLY THE EQUATION (user ruling, 2026-08-02: "The
 * equation zoo should only, in the presets, should only affect the equation. It
 * shouldn't affect whether or not it's closed or other stuff like that.")
 *
 * A graphLine preset therefore commits ONLY the CURVE DEFINITION — the keys in
 * CURVE_DEFINITION_KEYS. The author's styling (stroke, strokeWidth, fill, bloom),
 * their `closed` choice, and their framing (xRange/yRange) SURVIVE a preset
 * switch, so the zoo is a menu of equations rather than a menu of whole looks.
 *
 * THE FULL TUNING IS KEPT IN THE TABLE BELOW ON PURPOSE. `GRAPH_LINE_TUNING`
 * is the authored data — the stroke colours, closed flags and framing windows
 * each curve was designed with — and remains the reference for the equation-zoo
 * deck and for anyone hand-authoring a slide. The FILTER is applied at the
 * export (`GRAPH_LINE_PRESETS`), not by deleting the data, so nothing is lost
 * and the ruling is one visible line rather than 24 silent deletions.
 *
 * CONSEQUENCE, ACCEPTED BY THE RULING: the closed curves (heart, roses,
 * epicycloid, superellipse, Lissajous, butterfly, breathing flower) land as OPEN
 * paths, and every curve lands in the author's current window rather than its
 * tuned one. That is the requested behaviour, not a defect.
 */
const CURVE_DEFINITION_KEYS = ["mode", "source", "tStart", "tEnd", "numPoints", "jumpThreshold"];

/**
 * Pure function. Restricts a preset's props to the curve-definition keys, keeping
 * only the ones the entry actually declares (applyPreset writes exactly the keys
 * it is given, so an absent key must stay absent rather than become undefined).
 *
 * @param {{name: string, description: string, props: Object}} preset
 * @returns {{name: string, description: string, props: Object}} the same preset with a filtered props map
 *
 * @example
 * curveDefinitionOnly({name: "Heart", description: "…", props: {mode: "parametric", source: "[x,y]", tStart: 0, tEnd: 6.28, numPoints: 300, closed: true, stroke: "#FC6255", xRange: "[-20, 20, 5]"}}).props
 * // {mode: 'parametric', source: '[x,y]', tStart: 0, tEnd: 6.28, numPoints: 300}
 */
function curveDefinitionOnly(preset) {
  const props = {};
  for (const key of CURVE_DEFINITION_KEYS) if (key in preset.props) props[key] = preset.props[key];
  return { ...preset, props };
}

/**
 * graphLine preset TUNING — the equation zoo (digest 04) as authored, including
 * the styling and framing each curve was designed with. Ranges are tuned
 * symmetric windows that comfortably frame each curve's natural amplitude at a
 * ~400×300 box. Only the curve-definition subset is applied — see
 * `curveDefinitionOnly` above; this table is the reference for the rest.
 */
const GRAPH_LINE_TUNING = [
  {
    name: "Sine wave",
    description: "The friendly default — two periods of y = sin(x). Keyframe strokeEnd 0→1 to draw it on.",
    props: { mode: "explicit", source: "Math.sin(x)", tStart: -TWO_PI, tEnd: TWO_PI, numPoints: 256, xRange: "[-6.2832, 6.2832, 1.5708]", yRange: "[-1.5, 1.5, 0.5]", closed: false, stroke: BLUE_C, strokeWidth: 3, fill: null, jumpThreshold: 0 },
  },
  {
    name: "The Valentine Curve",
    description: "16·sin³t and four cosines conspire into a heart. Closed, glowing pink.",
    props: { mode: "parametric", source: "[16*Math.sin(t)**3, 13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t)]", tStart: 0, tEnd: TWO_PI, numPoints: 300, xRange: "[-20, 20, 5]", yRange: "[-20, 17, 5]", closed: true, stroke: RED_C, strokeWidth: 4, fill: null, bloom: { radius: 14, strength: 0.7 } },
  },
  {
    name: "Rose (5 petals)",
    description: "r = 250·cos(5θ). Odd k ⇒ k petals — the parity rule, live.",
    props: { mode: "polar", source: "250*Math.cos(5*t)", tStart: 0, tEnd: 3.1416, numPoints: 400, xRange: "[-270, 270, 50]", yRange: "[-270, 270, 50]", closed: true, stroke: PINK, strokeWidth: 3, fill: null },
  },
  {
    name: "Rose (8 petals)",
    description: "r = 250·cos(4θ). Even k ⇒ 2k petals — needs a full turn to close.",
    props: { mode: "polar", source: "250*Math.cos(4*t)", tStart: 0, tEnd: TWO_PI, numPoints: 512, xRange: "[-270, 270, 50]", yRange: "[-270, 270, 50]", closed: true, stroke: PURPLE, strokeWidth: 3, fill: null },
  },
  {
    name: "Archimedean spiral",
    description: "r = 10 + 12θ — every ring the same distance apart, like a vinyl groove.",
    props: { mode: "polar", source: "10 + 12*t", tStart: 0, tEnd: EIGHT_PI, numPoints: 700, xRange: "[-330, 330, 100]", yRange: "[-330, 330, 100]", closed: false, stroke: TEAL, strokeWidth: 3, fill: null },
  },
  {
    name: "Logarithmic spiral",
    description: "r = 5·e^{0.3θ} — self-similar growth, the shape nature uses for shells.",
    props: { mode: "polar", source: "5*Math.exp(0.3*t)", tStart: 0, tEnd: FOUR_PI, numPoints: 512, xRange: "[-230, 230, 50]", yRange: "[-230, 230, 50]", closed: false, stroke: GOLD, strokeWidth: 3, fill: null, bloom: { radius: 12, strength: 0.5 } },
  },
  {
    name: "Golden spiral",
    description: "The log spiral whose radius scales by φ every quarter turn (b = ln φ / (π/2)).",
    props: { mode: "polar", source: "4*Math.exp((Math.log((1+Math.sqrt(5))/2)/(Math.PI/2))*t)", tStart: 0, tEnd: FOUR_PI, numPoints: 512, xRange: "[-200, 200, 50]", yRange: "[-200, 200, 50]", closed: false, stroke: YELLOW_C, strokeWidth: 3, fill: null },
  },
  {
    name: "Fermat spiral",
    description: "r = 40·√θ — rings crowd together as they grow; the sunflower-seed spiral.",
    props: { mode: "polar", source: "40*Math.sqrt(t)", tStart: 0, tEnd: EIGHT_PI, numPoints: 600, xRange: "[-210, 210, 50]", yRange: "[-210, 210, 50]", closed: false, stroke: GREEN_C, strokeWidth: 2.5, fill: null },
  },
  {
    name: "Spiral morph (λ over time)",
    description: "One ODE, one exponent: λ sweeps 0→1 over time, morphing Archimedean into logarithmic. RECORDABLE (reads time).",
    props: { mode: "polar", source: "(()=>{const p=(Math.sin(time*0.4)+1)/2; if(p>0.98) return 10*Math.exp(0.3*t); return Math.pow(Math.pow(10,1-p)+0.3*(1-p)*t, 1/(1-p));})()", tStart: 0, tEnd: SIX_PI, numPoints: 600, xRange: "[-260, 260, 50]", yRange: "[-260, 260, 50]", closed: false, stroke: BLUE_C, strokeWidth: 3, fill: null },
  },
  {
    name: "Catenary",
    description: "A hanging chain: y = a·cosh(x/a). Looks like a parabola near the bottom, secretly isn't.",
    props: { mode: "explicit", source: "-250*Math.cosh(t/250) + 250", tStart: -300, tEnd: 300, numPoints: 256, xRange: "[-320, 320, 100]", yRange: "[-240, 40, 50]", closed: false, stroke: ORANGE, strokeWidth: 3, fill: null },
  },
  {
    name: "Cycloid",
    description: "The path of a point on a rolling wheel: x = rt − r·sin t, y = r − r·cos t.",
    props: { mode: "parametric", source: "[60*t - 60*Math.sin(t), 60 - 60*Math.cos(t)]", tStart: 0, tEnd: FOUR_PI, numPoints: 400, xRange: "[0, 760, 100]", yRange: "[-20, 140, 40]", closed: false, stroke: BLUE_B, strokeWidth: 3, fill: null },
  },
  {
    name: "Epicycloid (5 cusps)",
    description: "A gear of radius r rolling OUTSIDE a ring R (5:1) — a Spirograph flower.",
    props: { mode: "parametric", source: "[(250+50)*Math.cos(t)-50*Math.cos((250+50)/50*t), (250+50)*Math.sin(t)-50*Math.sin((250+50)/50*t)]", tStart: 0, tEnd: TWO_PI, numPoints: 512, xRange: "[-320, 320, 100]", yRange: "[-320, 320, 100]", closed: true, stroke: PINK, strokeWidth: 2.5, fill: null },
  },
  {
    name: "Superellipse (squircle)",
    description: "|x/a|ⁿ + |y/b|ⁿ = 1 at n = 4 — the Apple-icon shape between circle and square.",
    props: { mode: "parametric", source: "[200*Math.sign(Math.cos(t))*Math.abs(Math.cos(t))**0.5, 200*Math.sign(Math.sin(t))*Math.abs(Math.sin(t))**0.5]", tStart: 0, tEnd: TWO_PI, numPoints: 400, xRange: "[-220, 220, 50]", yRange: "[-220, 220, 50]", closed: true, stroke: GREEN_C, strokeWidth: 3, fill: null },
  },
  {
    name: "Lissajous (3:2)",
    description: "Two perpendicular sines: x = sin(3t + π/2), y = sin(2t) — the oscilloscope classic.",
    props: { mode: "parametric", source: "[200*Math.sin(3*t + Math.PI/2), 200*Math.sin(2*t)]", tStart: 0, tEnd: TWO_PI, numPoints: 400, xRange: "[-220, 220, 50]", yRange: "[-220, 220, 50]", closed: true, stroke: YELLOW_C, strokeWidth: 3, fill: null },
  },
  {
    name: "Harmonograph",
    description: "A Lissajous figure bleeding energy: two decaying sines spiral inward to rest.",
    props: { mode: "parametric", source: "[250*Math.exp(-0.03*t)*Math.sin(2*t), 250*Math.exp(-0.03*t)*Math.sin(3*t + Math.PI/2)]", tStart: 0, tEnd: 60, numPoints: 1000, xRange: "[-260, 260, 50]", yRange: "[-260, 260, 50]", closed: false, stroke: TEAL, strokeWidth: 2, fill: null },
  },
  {
    name: "Sum of sines",
    description: "Any wiggle is a sum of sines: 80sin(x) + 40sin(2.7x+1) + 20sin(5.3x+2).",
    props: { mode: "explicit", source: "80*Math.sin(x) + 40*Math.sin(2.7*x+1) + 20*Math.sin(5.3*x+2)", tStart: -6.2832, tEnd: 6.2832, numPoints: 400, xRange: "[-6.2832, 6.2832, 1.5708]", yRange: "[-150, 150, 50]", closed: false, stroke: MAROON, strokeWidth: 3, fill: null },
  },
  {
    name: "Fibonacci staircase (iterative)",
    description: "An IIFE with a for-loop: y = Fibonacci(round(x)). The user's iterative example — a staircase of 0,1,1,2,3,5,8…",
    props: { mode: "explicit", source: "(()=>{let n=Math.max(0,Math.round(x)),a=0,b=1;for(let k=0;k<n;k++){const c=a+b;a=b;b=c;}return a;})()", tStart: 0, tEnd: 11, numPoints: 400, xRange: "[0, 11, 1]", yRange: "[0, 100, 10]", closed: false, stroke: GOLD, strokeWidth: 3, fill: null, jumpThreshold: 0 },
  },
  // ── enrichment round (mini-frenzy, practical-chart + playful/maximal angles) ──
  {
    name: "Damped-driven oscillator",
    description: "A decaying transient cos(3t) riding a steady sinusoidal drive — the classic RLC / spring-mass response curve.",
    props: { mode: "explicit", source: "Math.exp(-0.18*t)*Math.cos(3*t) + 0.55*Math.sin(0.6*t)", tStart: 0, tEnd: 24, numPoints: 400, xRange: "[0, 24, 4]", yRange: "[-1, 1.5, 0.5]", closed: false, stroke: ORANGE, strokeWidth: 3, fill: null, jumpThreshold: 0 },
  },
  {
    name: "Gaussian bell curve",
    description: "The bell curve behind every normal-distribution slide: 180·exp(−x²/(2·1.4²)).",
    props: { mode: "explicit", source: "180*Math.exp(-((x)**2)/(2*1.4**2))", tStart: -5, tEnd: 5, numPoints: 300, xRange: "[-5, 5, 1]", yRange: "[0, 200, 50]", closed: false, stroke: PURPLE, strokeWidth: 3, fill: null, jumpThreshold: 0 },
  },
  {
    name: "Sigmoid / logistic",
    description: "The S-curve 200/(1+e^−x) — adoption curves, neural activations, capped growth.",
    props: { mode: "explicit", source: "200/(1+Math.exp(-1*(x-0)))", tStart: -8, tEnd: 8, numPoints: 300, xRange: "[-8, 8, 2]", yRange: "[0, 200, 50]", closed: false, stroke: GREEN_C, strokeWidth: 3, fill: null, jumpThreshold: 0 },
  },
  {
    name: "Fourier square wave (Gibbs)",
    description: "A for-loop IIFE sums 8 odd harmonics of sin(kx)/k into a square wave — keeping the Gibbs overshoot at the jumps.",
    props: { mode: "explicit", source: "(()=>{let s=0;for(let k=1;k<=15;k+=2){s+=Math.sin(k*x)/k;}return (4/Math.PI)*120*s;})()", tStart: -6.2832, tEnd: 6.2832, numPoints: 500, xRange: "[-6.2832, 6.2832, 1.5708]", yRange: "[-150, 150, 50]", closed: false, stroke: RED_C, strokeWidth: 2.5, fill: null, jumpThreshold: 0 },
  },
  {
    name: "Butterfly curve (Fay)",
    description: "Fay's butterfly: e^{cos t} − 2cos(4t) − sin⁵(t/12) modulating sin/cos — a self-crossing silhouette that closes at t=12π.",
    props: { mode: "parametric", source: "(()=>{const e=Math.exp(Math.cos(t))-2*Math.cos(4*t)-Math.pow(Math.sin(t/12),5); return [40*Math.sin(t)*e, 40*Math.cos(t)*e];})()", tStart: 0, tEnd: 37.699, numPoints: 1000, xRange: "[-130, 130, 50]", yRange: "[-90, 140, 50]", closed: true, stroke: BLUE_B, strokeWidth: 2.5, fill: null, jumpThreshold: 0 },
  },
  {
    name: "Breathing flower (time)",
    description: "A 5-lobed polar curve whose radius swells and ripples on two time-driven frequencies — RECORDABLE, alive without keyframes.",
    props: { mode: "polar", source: "150 + 40*Math.sin(time*1.2) + 20*Math.sin(5*t)*Math.sin(time*0.7)", tStart: 0, tEnd: 6.2832, numPoints: 500, xRange: "[-220, 220, 50]", yRange: "[-220, 220, 50]", closed: true, stroke: TEAL, strokeWidth: 2.5, fill: null, jumpThreshold: 0 },
  },
];

/** The equation zoo as the app APPLIES it: curve definition only (see above). */
export const GRAPH_LINE_PRESETS = GRAPH_LINE_TUNING.map(curveDefinitionOnly);

/**
 * graphTickMarks (ruler) presets — from a MATHEMATICAL angle (centered axes,
 * number line), a matplotlib/PRACTICAL-CHART angle (boxed plot, financial,
 * scientific, percent, time), and a Manim AESTHETIC angle (arrowed axes,
 * centered straddling ticks).
 */
export const GRAPH_TICK_PRESETS = [
  {
    name: "Centered axes (Manim)",
    description: "Both axes crossing at 0 with arrow tips and straddling ticks — the 3Blue1Brown coordinate frame.",
    props: { xRange: "[-5, 5, 1]", yRange: "[-5, 5, 1]", axes: "both", spine: "zero", includeTip: true, tickDirection: "inout", excludeOriginTick: true, axisColor: "#DDEEFF", tickColor: "#DDEEFF", labelColor: "#DDEEFF" },
  },
  {
    name: "Boxed plot (matplotlib)",
    description: "Axes on the bottom/left edges with outward ticks and minor subdivisions — a classic mpl frame.",
    props: { xRange: "[0, 10, 2]", yRange: "[0, 10, 2]", axes: "both", spine: "edge", includeTip: false, tickDirection: "out", showMinorTicks: true, minorSubdivisions: 0, axisColor: "#b0b0b0", tickColor: "#b0b0b0", labelColor: "#e8e8e8" },
  },
  {
    name: "Number line",
    description: "A single horizontal axis 0..10 with an arrow tip — for a one-dimensional demo.",
    props: { xRange: "[0, 10, 1]", yRange: "[0, 1, 1]", axes: "x", spine: "zero", includeTip: true, tickDirection: "inout", majorTickLength: 12 },
  },
  {
    name: "Percentage axis",
    description: "A vertical axis labelled 0%..100% (a 0..1 fraction shown as percent).",
    props: { xRange: "[0, 1, 0.1]", yRange: "[0, 1, 0.2]", axes: "y", spine: "edge", labelFormat: "percent", labelDecimals: 0 },
  },
  {
    name: "Degrees",
    description: "A horizontal axis in degrees, 0°..360° every 45°.",
    props: { xRange: "[0, 360, 45]", yRange: "[0, 1, 1]", axes: "x", spine: "edge", labelSuffix: "°", labelSize: 14 },
  },
  {
    name: "Fine ruler",
    description: "Dense minor ticks with labels thinned to every second major — a precise scale bar.",
    props: { xRange: "[0, 20, 5]", yRange: "[0, 20, 5]", axes: "both", spine: "edge", showMinorTicks: true, minorSubdivisions: 5, skipEveryN: 1, tickDirection: "out" },
  },
  {
    name: "Minimal (ticks only)",
    description: "Short ticks, no axis line, no labels — an unobtrusive scale under other art.",
    props: { xRange: "[0, 10, 1]", yRange: "[0, 10, 1]", axes: "both", spine: "edge", showAxisLine: false, showLabels: false, majorTickLength: 6, tickColor: "#888888" },
  },
  {
    name: "Financial ($)",
    description: "A dollar-denominated vertical axis on the left edge.",
    props: { xRange: "[0, 12, 1]", yRange: "[0, 100, 20]", axes: "y", spine: "edge", labelPrefix: "$", labelColor: "#83C167" },
  },
  {
    name: "Scientific",
    description: "Tiny values shown in 1e-3 scientific notation.",
    props: { xRange: "[0, 0.001, 0.0002]", yRange: "[0, 0.001, 0.0002]", axes: "both", spine: "edge", labelFormat: "scientific", labelDecimals: 1, labelSize: 12 },
  },
  {
    name: "Time (ms)",
    description: "A horizontal time axis in milliseconds, 0..500 every 100.",
    props: { xRange: "[0, 500, 100]", yRange: "[0, 1, 1]", axes: "x", spine: "edge", labelSuffix: " ms", includeTip: true },
  },
  {
    name: "Big centered frame",
    description: "A large symmetric ±10 frame with tips and inward+outward ticks — a hero axis for a title slide.",
    props: { xRange: "[-10, 10, 2]", yRange: "[-10, 10, 2]", axes: "both", spine: "zero", includeTip: true, tickDirection: "inout", majorTickLength: 14, tipSize: 16, axisWidth: 3, excludeOriginTick: true },
  },
  // ── enrichment round (mini-frenzy) ──
  {
    name: "Decade axis (log-style)",
    description: "Evenly-stepped exponents labelled 10^0, 10^1, 10^2… — the standard trick for a log-looking axis with honest, evenly-spaced tick values.",
    props: { xRange: "[0, 5, 1]", yRange: "[0, 1, 1]", axes: "x", spine: "edge", labelPrefix: "10^", labelFormat: "fixed", labelDecimals: 0, tickDirection: "out", majorTickLength: 10 },
  },
  {
    name: "Likert scale (1-5)",
    description: "A five-point survey axis, 1 through 5, integer ticks only — for satisfaction/agreement charts.",
    props: { xRange: "[1, 5, 1]", yRange: "[0, 1, 1]", axes: "x", spine: "edge", showMinorTicks: false, tickDirection: "out", majorTickLength: 8, labelSize: 14 },
  },
  {
    name: "Depth axis (metres)",
    description: "A vertical axis from 0 at the surface down to −100 m — ocean-depth / below-sea-level style, every label negative.",
    props: { xRange: "[0, 1, 1]", yRange: "[-100, 0, 20]", axes: "y", spine: "edge", labelSuffix: " m", tickDirection: "out", axisColor: TEAL, tickColor: TEAL, labelColor: TEAL },
  },
  {
    name: "Temperature axis (°C)",
    description: "A horizontal Celsius axis from cold to hot with a degree suffix and an arrow tip at the hot end.",
    props: { xRange: "[-20, 40, 10]", yRange: "[0, 1, 1]", axes: "x", spine: "edge", labelSuffix: "°C", includeTip: true, tickDirection: "out", axisColor: RED_C, tickColor: RED_C, labelColor: RED_C },
  },
];

/**
 * graphGrid presets — a Manim NumberPlane angle (faded sub-lines, snake-in
 * reveals), a matplotlib angle (light-gray reference grid), and PRACTICAL looks
 * (blueprint, graph paper, ledger rules). Snake presets tune stagger/ease/order;
 * the author keyframes `growth` 0→1 to play the entrance.
 */
export const GRAPH_GRID_PRESETS = [
  {
    name: "NumberPlane (Manim)",
    description: "Muted-blue major lines with dimmer faded sub-lines — the 3Blue1Brown coordinate plane.",
    props: { xRange: "[-5, 5, 1]", yRange: "[-5, 5, 1]", gridAxis: "both", gridColor: "#5C7A99", gridWidth: 1.5, gridOpacity: 0.85, showMinor: true, minorSubdivisions: 0, fadedLineOpacity: 0.3, growth: 1 },
  },
  {
    name: "Snake-in (columns then rows)",
    description: "Tuned for the staggered Manim entrance — keyframe the Snake-in knob 0→1 and columns sweep in, then rows.",
    props: { xRange: "[0, 10, 1]", yRange: "[0, 10, 1]", gridAxis: "both", gridColor: "#58C4DD", gridWidth: 2, growLagRatio: 0.7, growEase: "cubic", growDirection: "index-ascending", growth: 1 },
  },
  {
    name: "Matplotlib grid",
    description: "Light-gray major reference lines, no sub-lines — a plain plot backdrop.",
    props: { xRange: "[0, 10, 2]", yRange: "[0, 10, 2]", gridAxis: "both", gridColor: "#b0b0b0", gridWidth: 0.8, gridOpacity: 1, showMinor: false },
  },
  {
    name: "Blueprint",
    description: "Cyan lines with fine faded sub-lines on a dark deck — a drafting-paper look.",
    props: { xRange: "[0, 12, 1]", yRange: "[0, 9, 1]", gridAxis: "both", gridColor: "#4FC3F7", gridWidth: 1, gridOpacity: 0.7, showMinor: true, minorSubdivisions: 4, fadedLineOpacity: 0.25, minorWidth: 0.6 },
  },
  {
    name: "Graph paper",
    description: "Green engineering-paper grid: faint majors and 5 finer sub-lines per cell.",
    props: { xRange: "[0, 10, 1]", yRange: "[0, 10, 1]", gridAxis: "both", gridColor: "#7FBF7F", gridWidth: 1, gridOpacity: 0.6, showMinor: true, minorSubdivisions: 5, fadedLineOpacity: 0.3, minorWidth: 0.5 },
  },
  {
    name: "Ledger rules",
    description: "Horizontal lines only — a ruled-page / accounting look.",
    props: { xRange: "[0, 1, 1]", yRange: "[0, 12, 1]", gridAxis: "y", gridColor: "#8899AA", gridWidth: 1, gridOpacity: 0.6 },
  },
  {
    name: "Column guides",
    description: "Vertical lines only — layout column guides.",
    props: { xRange: "[0, 12, 1]", yRange: "[0, 1, 1]", gridAxis: "x", gridColor: "#8899AA", gridWidth: 1, gridOpacity: 0.6 },
  },
  {
    name: "Fine mesh",
    description: "Dense faded sub-lines (5 per cell) over subtle majors — a technical mesh.",
    props: { xRange: "[0, 8, 1]", yRange: "[0, 8, 1]", gridAxis: "both", gridColor: "#6C7A89", gridWidth: 1, gridOpacity: 0.5, showMinor: true, minorSubdivisions: 5, fadedLineOpacity: 0.2, minorWidth: 0.5 },
  },
  {
    name: "Center-out reveal",
    description: "Snake-in from the middle outward — keyframe Snake-in 0→1 for a grid that grows from its center.",
    props: { xRange: "[-6, 6, 1]", yRange: "[-6, 6, 1]", gridAxis: "both", gridColor: "#D147BD", gridWidth: 1.5, growDirection: "center-out", growLagRatio: 0.8, growth: 1 },
  },
  {
    name: "Edges-in reveal",
    description: "Snake-in from the outer edges toward the middle — a converging entrance.",
    props: { xRange: "[-6, 6, 1]", yRange: "[-6, 6, 1]", gridAxis: "both", gridColor: "#F0AC5F", gridWidth: 1.5, growDirection: "edges-in", growLagRatio: 0.8, growth: 1 },
  },
  {
    name: "Subtle backdrop",
    description: "Very faint thin lines — an unobtrusive grid behind other content.",
    props: { xRange: "[0, 20, 2]", yRange: "[0, 20, 2]", gridAxis: "both", gridColor: "#556677", gridWidth: 0.75, gridOpacity: 0.3 },
  },
  // ── enrichment round (mini-frenzy) ──
  {
    name: "Drafting grid (tight)",
    description: "Fine 0.5-unit spacing with thin uniform lines and no fade — a technical drafting mesh.",
    props: { xRange: "[0, 8, 0.5]", yRange: "[0, 8, 0.5]", gridAxis: "both", gridColor: "#9FB8C7", gridWidth: 0.6, gridOpacity: 0.5, showMinor: false, growth: 1 },
  },
  {
    name: "Terminal grid (phosphor)",
    description: "Matrix-green lines with faint scanline-like minor subdivisions — a CRT/terminal graph look.",
    props: { xRange: "[0, 10, 1]", yRange: "[0, 10, 1]", gridAxis: "both", gridColor: "#39FF6A", gridWidth: 1, gridOpacity: 0.55, showMinor: true, minorSubdivisions: 4, fadedLineOpacity: 0.15, minorWidth: 0.4, growth: 1 },
  },
  {
    name: "Sepia paper grid",
    description: "Warm tan/brown lines echoing old graph paper — dimmer minors under solid ochre majors.",
    props: { xRange: "[0, 10, 1]", yRange: "[0, 10, 1]", gridAxis: "both", gridColor: "#C9A66B", gridWidth: 1, gridOpacity: 0.65, showMinor: true, minorSubdivisions: 5, fadedLineOpacity: 0.28, minorWidth: 0.5, growth: 1 },
  },
  {
    name: "Bold majors, faint minors",
    description: "Thick high-contrast major lines over barely-there minor subdivisions — an emphasis grid that reads at a glance.",
    props: { xRange: "[0, 8, 2]", yRange: "[0, 8, 2]", gridAxis: "both", gridColor: "#DDEEFF", gridWidth: 3, gridOpacity: 0.9, showMinor: true, minorSubdivisions: 4, fadedLineOpacity: 0.12, minorWidth: 0.5, growth: 1 },
  },
];

/**
 * graphBars presets — digest 10's eleven designs, from a MATHEMATICAL angle
 * (Riemann sums, area-under-curve), a categorical DASHBOARD angle (named chart,
 * histogram, sparkbars), a generative angle (skyline noise), and RECORDABLE
 * time-driven angles (equalizer, traveling pulse). Author the grow-up by
 * keyframing `reveal` 0→1.
 */
export const GRAPH_BARS_PRESETS = [
  {
    name: "Riemann left sum",
    description: "The canonical Manim integral: flush x² rectangles, blue→green across the sequence.",
    props: { mode: "riemann", valueEquation: "x*x", xStart: 0, xEnd: 4, barCount: 8, inputSampleType: "left", yRange: "[0, 16, 2]", colorMode: "gradient-index", gradientFrom: BLUE_C, gradientTo: GREEN_C, fillOpacity: 1, strokeColor: "#000000", barStrokeWidth: 1, barWidthFraction: 1, barOverlapFudge: 1.001, reveal: 1, growLagRatio: 0.5 },
  },
  {
    name: "Area under sin(x)",
    description: "Midpoint-rule rectangles under sin(x)+2, semi-transparent so a companion curve reads through.",
    props: { mode: "riemann", valueEquation: "Math.sin(x) + 2", xStart: 0, xEnd: 6.28, barCount: 24, inputSampleType: "center", yRange: "[0, 3, 0.5]", colorMode: "gradient-index", gradientFrom: YELLOW_C, gradientTo: ORANGE, fillOpacity: 0.55, barWidthFraction: 1, barOverlapFudge: 1.001, colorByValueBelowZero: RED_C, reveal: 1 },
  },
  {
    name: "Refinement dx=1",
    description: "Coarse midpoint rectangles (4 bars) — slide 1 of a dx-halving story (keyframe barCount across slides).",
    props: { mode: "riemann", valueEquation: "x*x", xStart: 0, xEnd: 4, barCount: 4, inputSampleType: "center", yRange: "[0, 16, 4]", colorMode: "solid", barColor: BLUE_C, fillOpacity: 0.6, barWidthFraction: 1, barOverlapFudge: 1.001, reveal: 1 },
  },
  {
    name: "Classic histogram",
    description: "A static frequency histogram — flush bars, thin black outline.",
    props: { mode: "literal", barValues: "2, 5, 9, 14, 22, 31, 24, 12, 6, 2", yRange: "[0, 32, 4]", barWidthFraction: 1, colorMode: "solid", barColor: BLUE_B, strokeColor: "#000000", barStrokeWidth: 0.5, fillOpacity: 1, reveal: 1 },
  },
  {
    name: "Categorical chart",
    description: "A named quarterly BarChart with a cycling qualitative palette and a sequential grow-in.",
    props: { mode: "literal", barValues: "23, 45, 12, 37, 29", barNames: "Q1, Q2, Q3, Q4, Q5", yRange: "[0, 50, 10]", colorMode: "palette-cycle", paletteColors: "#003f5c, #58508d, #bc5090, #ff6361, #ffa600", barWidthFraction: 0.6, fillOpacity: 0.85, strokeColor: "#000000", barStrokeWidth: 3, reveal: 1, growLagRatio: 0.6 },
  },
  {
    name: "Audio equalizer (time)",
    description: "16 bars wiggling to a time-driven equation — RECORDABLE state (reads time, seekable).",
    props: { mode: "direct", barCount: 16, valueEquation: "2 + 3*Math.abs(Math.sin(i*0.9 + time*3)) * (1 + 0.4*Math.sin(time*7 + i))", yRange: "[0, 9, 1]", colorMode: "gradient-index", gradientFrom: PINK, gradientTo: TEAL, barWidthFraction: 0.5, cornerRadius: 4, reveal: 1 },
  },
  {
    name: "Traveling pulse (time)",
    description: "A single Gaussian pulse sweeping across the array over time, wrapping seamlessly. RECORDABLE.",
    props: { mode: "direct", barCount: 24, valueEquation: "1 + 8 * Math.exp(-1 * (((((i - 11.5 - time*4) % 24) + 24) % 24) - 11.5)**2 / (2 * 2.5**2))", yRange: "[0, 9, 1]", colorMode: "gradient-index", gradientFrom: PURPLE, gradientTo: GOLD, barWidthFraction: 0.85, reveal: 1 },
  },
  {
    name: "Procedural skyline",
    description: "48 flush bars from deterministic hash-noise — a city silhouette, fast-rise grow.",
    props: { mode: "direct", barCount: 48, valueEquation: "4 + 10*Math.abs(Math.sin(i*12.9898)*43758.5453 % 1)", yRange: "[0, 15, 5]", colorMode: "solid", barColor: "#1a2233", barWidthFraction: 1, barStrokeWidth: 0, fillOpacity: 1, reveal: 1, growLagRatio: 0.15, growEase: "quad_out" },
  },
  {
    name: "Signed area (±)",
    description: "cos over two periods, bars below zero flipped red — the signed-area convention.",
    props: { mode: "riemann", valueEquation: "3*Math.cos(x)", xStart: 0, xEnd: 12.566, barCount: 32, inputSampleType: "center", yRange: "[-3, 3, 1]", baselineY: 0, colorMode: "by-value", barColor: BLUE_C, colorByValueBelowZero: RED_C, barWidthFraction: 1, barOverlapFudge: 1.001, fillOpacity: 0.9, reveal: 1 },
  },
  {
    name: "Sparkbar KPI row",
    description: "A small inline pill-bar row in the app accent — deliberately not Manim-styled.",
    props: { mode: "literal", barValues: "3, 7, 4, 9, 6", yRange: "[0, 10, 2]", colorMode: "solid", barColor: "#7aa2f7", barWidthFraction: 0.5, cornerRadius: 999, barStrokeWidth: 0, fillOpacity: 1, reveal: 1, growLagRatio: 0, growEase: "quad_out", w: 200, h: 60 },
  },
  {
    name: "Horizontal ranking",
    description: "Bars growing rightward — a horizontal ranking/leaderboard chart.",
    props: { mode: "literal", barValues: "18, 14, 9, 6, 3", barNames: "A, B, C, D, E", orientation: "horizontal", yRange: "[0, 20, 5]", colorMode: "gradient-index", gradientFrom: TEAL, gradientTo: PURPLE, barWidthFraction: 0.7, fillOpacity: 0.9, reveal: 1, growLagRatio: 0.5 },
  },
  // ── enrichment round (mini-frenzy, dashboard + generative angles) ──
  {
    name: "Monthly revenue",
    description: "Formula-driven revenue with an upward trend and seeded (deterministic) noise, teal→green, month labels.",
    props: { mode: "direct", barCount: 6, valueEquation: "42 + i*4 + 10*Math.sin(i*1.7) + 6*random(0)", barNames: "Jan, Feb, Mar, Apr, May, Jun", yRange: "[0, 80, 20]", baselineY: 0, colorMode: "gradient-index", gradientFrom: "#4FC3F7", gradientTo: GREEN_C, barWidthFraction: 0.55, cornerRadius: 3, fillOpacity: 1, barStrokeWidth: 0, labelSize: 13, reveal: 1, growLagRatio: 0.4, growEase: "quad_out" },
  },
  {
    name: "Weekly temperature",
    description: "Seven daily highs straddling freezing: warm days grow up in orange, sub-zero days grow down in cold blue.",
    props: { mode: "literal", barValues: "-3, 2, 5, 9, 14, 18, 22", barNames: "Sun, Mon, Tue, Wed, Thu, Fri, Sat", yRange: "[-10, 25, 5]", baselineY: 0, colorMode: "by-value", barColor: ORANGE, colorByValueBelowZero: "#4FC3F7", barWidthFraction: 0.65, cornerRadius: 6, fillOpacity: 0.9, barStrokeWidth: 0, labelSize: 12, reveal: 1, growLagRatio: 0.3, growEase: "quad_out" },
  },
  {
    name: "Poll results",
    description: "Five percentages as pill-capped horizontal bars, one palette color per candidate.",
    props: { mode: "literal", barValues: "38, 27, 19, 11, 5", barNames: "Candidate A, Candidate B, Candidate C, Undecided, Other", orientation: "horizontal", yRange: "[0, 40, 10]", colorMode: "palette-cycle", paletteColors: "#4C6EF5, #F03E3E, #9775FA, #ADB5BD, #495057", barWidthFraction: 0.5, cornerRadius: 999, fillOpacity: 1, barStrokeWidth: 0, labelSize: 13, reveal: 1, growLagRatio: 0.5, growEase: "quad_out" },
  },
  {
    name: "Binomial distribution",
    description: "P(X=k) for Binomial(n=10, p=0.42) via an IIFE factorial nCr — 11 bars forming the classic bell bump, growing center-out.",
    props: { mode: "direct", barCount: 11, valueEquation: "(()=>{const n=10,p=0.42,fact=(x)=>{let r=1;for(let j=2;j<=x;j++)r*=j;return r;};const c=fact(n)/(fact(i)*fact(n-i));return 100*c*Math.pow(p,i)*Math.pow(1-p,n-i);})()", yRange: "[0, 28, 4]", baselineY: 0, colorMode: "gradient-index", gradientFrom: PINK, gradientTo: TEAL, barWidthFraction: 0.75, cornerRadius: 2, fillOpacity: 1, barStrokeWidth: 0, reveal: 1, growLagRatio: 0.5, growEase: "quad_out", growDirection: "center-out" },
  },
  {
    name: "Confetti burst",
    description: "20 bars at seeded random heights (deterministic property state), thin bright pills popping outward from the center.",
    props: { mode: "direct", barCount: 20, valueEquation: "3 + 9*random(0)", yRange: "[0, 12, 2]", baselineY: 0, colorMode: "palette-cycle", paletteColors: "#FF6B6B, #FFD93D, #6BCB77, #4D96FF, #9B5DE5, #F15BB5", barWidthFraction: 0.4, cornerRadius: 999, fillOpacity: 1, barStrokeWidth: 0, reveal: 1, growLagRatio: 0.85, growEase: "quad_out", growDirection: "center-out" },
  },
];
