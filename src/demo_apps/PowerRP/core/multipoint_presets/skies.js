/**
 * "Skies & atmospheres" — native Multipoint presets. Atmospheric optics and weather: sunsets, halos, rainbows, rays, mammatus and aurorae.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point, closedRamp, glow } from "./builders.js";
import { catmullRomNodes, ellipseNodes, polylineNodes, mixHex } from "../multipoint_shapes.js";
import { sideRails, polarArcNodes } from "./minerals_phenomena.js";
import { skyField, ridge, streak, floor, row, tint, polar, reach, lensNodes, scallopNodes } from "./skies_helpers.js";

export const PRESETS = [
  (() => {
    const sky = skyField(["#1b2a6b", "#8a4f9a", "#f39a52", "#ffd77a"], [0, 0.45, 0.8, 1], 0.86);
    const glowAt = (y, k) => [sky.at(y), tint(sky.at(y), "#fff0c0", k), sky.at(y)];
    return preset("clear-sunset", "Clear-sky sunset", "A cloudless sunset: ultramarine zenith through violet and rose to a molten orange-yellow horizon with a low sun.", [
      ...sky.rails, row(0.25, [sky.at(0.25)]), row(0.48, glowAt(0.48, 0.12)), row(0.68, glowAt(0.68, 0.3)),
      point(0.5, 0.82, "#fff3c4"),
      ridge([0.86, 0.86, 0.86], [sky.at(0.86)], ["#1a1224"]), floor(["#0d0912"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#0a1740", "#18397a", "#5a7fb5", "#f0b077"], [0, 0.4, 0.75, 1], 0.8);
    const skyline = [[0, 0.77], [0.16, 0.77], [0.16, 0.86], [0.27, 0.86], [0.27, 0.72], [0.36, 0.72], [0.36, 0.82], [0.62, 0.82],
      [0.62, 0.75], [0.74, 0.75], [0.74, 0.81], [1, 0.81]];
    return preset("blue-hour", "Blue hour", "The blue hour after sunset: cobalt sky, a last amber seam at the horizon and a dark skyline dotted with lit windows.", [
      ...sky.rails, row(0.2, [sky.at(0.2)]), row(0.42, [sky.at(0.42)]), row(0.62, [sky.at(0.62), tint(sky.at(0.62), "#f0b077", 0.2), sky.at(0.62)]),
      boundary(polylineNodes(skyline), ["#f0b077"], ["#0a0f22"]),
      point(0.2, 0.9, "#ffcf7a"), point(0.32, 0.8, "#ffd98c"), point(0.66, 0.86, "#ffcf7a"), point(0.75, 0.9, "#f5b25c"),
      floor(["#070a18"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#6f8fcf", "#a9b8dc", "#f2c2b6", "#ffe3ae"], [0, 0.4, 0.75, 1], 0.86);
    const wisp = (a, b, bow, hi, lo) => { const f = sky.at((a[1] + b[1]) / 2); return boundary(lensNodes(a, b, bow), closedRamp([hi, lo, hi]), closedRamp([f, f, f]), true); };
    return preset("cirrus-dawn", "Cirrus dawn", "Sunrise lighting high cirrus: periwinkle sky, long combed streaks of rose and gold, a pale peach horizon.", [
      ...sky.rails, row(0.62, [sky.at(0.62)]), row(0.7, [sky.at(0.7), tint(sky.at(0.7), "#fff2c8", 0.35), sky.at(0.7)]),
      wisp([0.06, 0.15], [0.86, 0.09], 0.016, "#f6b1c8", "#ffd3b4"),
      wisp([0.02, 0.26], [0.7, 0.2], 0.02, "#f7b8bd", "#ffd9b0"),
      wisp([0.24, 0.35], [0.98, 0.29], 0.018, "#ffcfae", "#f29aa8"),
      wisp([0.05, 0.46], [0.6, 0.41], 0.014, "#ffe1b0", "#f6a9b0"),
      point(0.5, 0.84, "#fff6d0"),
      ridge([0.86, 0.85, 0.86], [sky.at(0.86)], ["#3a3552"]), floor(["#211e33"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#231a4a", "#7a2a5c", "#d9482f", "#f2a23e"], [0, 0.4, 0.75, 1], 0.86);
    return preset("krakatoa-afterglow", "Volcanic afterglow", "The 1883 Krakatoa afterglow: ash-veiled sky in blood crimson and magenta with a sickly olive-green band above the sun.", [
      ...sky.rails, row(0.16, [sky.at(0.16)]), row(0.36, [sky.at(0.36)]),
      row(0.56, [sky.at(0.56), "#b0a04c", sky.at(0.56)], { sag: -0.03 }),
      row(0.72, [sky.at(0.72), tint(sky.at(0.72), "#ffd070", 0.4), sky.at(0.72)]),
      point(0.5, 0.84, "#ffe7a0"),
      ridge([0.86, 0.86, 0.86], [sky.at(0.86)], ["#1c0d18"]), floor(["#100610"]),
    ]);
  })(),
  (() => {
    const fog = skyField(["#8fa2b8", "#c9d0d6", "#f2e8d2", "#d5d8d6"], [0, 0.4, 0.7, 1], 0.9);
    return preset("fog-bank", "Fog bank", "A dawn fog bank: blue-grey sky sinking into luminous cream mist, a pale sun and the ghost of a far ridge.", [
      ...fog.rails, row(0.16, [fog.at(0.16)]), row(0.38, [fog.at(0.38)]),
      row(0.58, [fog.at(0.58), tint(fog.at(0.58), "#fff4d6", 0.5), fog.at(0.58)]), row(0.76, [fog.at(0.76), tint(fog.at(0.76), "#fff4d6", 0.4), fog.at(0.76)]),
      boundary(catmullRomNodes([[0, 0.7], [0.22, 0.66], [0.48, 0.69], [0.75, 0.64], [1, 0.68]]), [fog.at(0.68), fog.at(0.66)], ["#a9b5b8", "#c5cbca"]),
      point(0.42, 0.56, "#fffbe8"),
      floor(["#7f8f92"]),
    ]);
  })(),
  (() => {
    const CY = 0.87, sky = skyField(["#3b4658", "#566476", "#7a8798", "#91a0ae"], [0, 0.4, 0.8, 1], CY);
    const arc = (r, colors) => {
      const half = r <= 0.5 ? Math.PI / 2 : Math.acos(0.5 / r);   // half-opening angle where circle meets the side edges (clipped above the horizon)
      const dy = r <= 0.5 ? 0 : Math.sqrt(r * r - 0.25);
      return boundary(polarArcNodes({ cx: 0.5, cy: CY, from: -Math.PI + (r <= 0.5 ? 0 : Math.acos(0.5 / r)), to: -(r <= 0.5 ? 0 : Math.acos(0.5 / r)), radius: () => r, maxStep: Math.PI / 2 }), colors);
    };
    // Two-sided arcs: rightColor (inside the arc, toward the centre) and left colour (outside) supply the two bands they bound.
    const two = (r, outside, inside) => { const f = arc(r, [outside]); return boundary(f.nodes, [outside], [inside]); };
    const veil = (c) => mixHex(c, "#9fb0c4", 0.3), faint = (c) => mixHex(c, "#56657a", 0.55);
    return preset("double-rainbow", "Double rainbow", "A primary rainbow with a fainter, colour-reversed secondary, the dark Alexander's band between them, over a stormy sky and dark hills.", [
      ...sky.rails,
      two(0.4, veil("#e0524a"), veil("#f0a548")), two(0.365, veil("#f4e26a"), veil("#6cc783")), two(0.33, veil("#4f9fe0"), veil("#7a62c4")),
      arc(0.2, ["#dbe3ec"]), arc(0.435, ["#465367"]),
      two(0.5, faint("#6f65b0"), faint("#4a8ad0")), two(0.54, faint("#d8d070"), faint("#e09a55")), arc(0.6, ["#5a687b"]),
      ridge([0.91, 0.895, 0.91], [sky.at(0.9)], ["#1f2f2a"]), floor(["#0f1a17"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#3f78c8", "#78aee6", "#bcd9f0", "#e9f1f7"], [0, 0.4, 0.8, 1], 0.88);
    return preset("sun-dog-halo", "Sun dogs and halo", "A 22-degree ice-crystal halo around a winter sun: darker sky inside a pale red-rimmed ring, with a bright sun dog on either side.", [
      ...sky.rails, row(0.1, [sky.at(0.1)]),
      boundary(ellipseNodes(0.5, 0.5, 0.27), ["#ffffff"], ["#d9b8b0"], true),
      boundary(ellipseNodes(0.5, 0.5, 0.235), ["#5a92d8"], null, true),
      ...glow(0.5, 0.5, 0.15, ["#ffffff", "#e4f0ff", "#79aee8"]),
      point(0.2, 0.5, "#ffe6bf"), point(0.8, 0.5, "#ffe6bf"),
      ridge([0.88, 0.875, 0.88], [sky.at(0.88)], ["#dfe8f2"]), floor(["#b9c8dc"]),
    ]);
  })(),
  (() => {
    const HORIZON = 0.86, C = [0.5, 0.3];
    const sky = skyField(["#26355c", "#4d5f8c", "#c9866f", "#f2c084"], [0, 0.4, 0.8, 1], HORIZON);
    const lobes = [[0.5, 0.13], [0.6, 0.15], [0.68, 0.2], [0.72, 0.29], [0.66, 0.36], [0.57, 0.38], [0.5, 0.36], [0.42, 0.38], [0.33, 0.35], [0.28, 0.28], [0.32, 0.19], [0.4, 0.15]];
    const ray = (deg, bright) => {
      const a = deg * Math.PI / 180, end = reach(C[0], C[1], a, [0, 0, 1, HORIZON]), yEnd = C[1] + end * Math.sin(a);
      const from = polar(...C, a, 0.22), to = polar(...C, a, end);
      const fld = sky.at(yEnd), lit = bright ? "#ffe7b0" : "#2f3d68";
      return boundary(polylineNodes([from, to]), [lit, tint(lit, fld, 0.55), fld]);
    };
    return preset("crepuscular-rays", "Crepuscular rays", "Sunbeams fanning from behind a dark cloud: alternating shafts of pale gold and shadow blue across a dusk sky.", [
      ...sky.rails,
      boundary(catmullRomNodes(lobes, true), ["#ffe9b8", "#ffcf7a", "#ffe9b8", "#ffe9b8"], ["#283250", "#1f2846", "#33406a", "#283250"], true),
      ...[24, 42, 58, 74, 106, 122, 138, 156].map((d, i) => ray(d, i % 2 === 0)),
      ridge([HORIZON, HORIZON, HORIZON], [sky.at(HORIZON)], ["#171a2c"]),
    ]);
  })(),
  (() => {
    const HORIZON = 0.9, O = [0.86, 0.88];
    const sky = skyField(["#39468a", "#7f7fbb", "#d9a0bd", "#e9b8bd"], [0, 0.4, 0.8, 1], HORIZON);
    const ray = (deg, bright) => {
      const a = deg * Math.PI / 180, end = reach(O[0], O[1], a, [0, 0, 1, HORIZON]), yEnd = O[1] + end * Math.sin(a);
      const fld = sky.at(yEnd), lit = bright ? "#ffc7d0" : "#3a4890";
      return boundary(polylineNodes([polar(...O, a, 0.06), polar(...O, a, end)]), [lit, tint(lit, fld, 0.5), fld]);
    };
    return preset("anticrepuscular-rays", "Anticrepuscular rays", "Rose-pink and blue shadow rays converging on the antisolar point at the far horizon, fanning across a lavender dusk.", [
      ...sky.rails,
      ...[184, 198, 212, 226, 240, 254, 268].map((d, i) => ray(d, i % 2 === 0)),
      row(0.9, [sky.at(0.9), "#c890b8", sky.at(0.9)]).nodes && ridge([0.905, 0.9, 0.905], [sky.at(0.9)], ["#2b2c5a"]), floor(["#171a3c"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#3d3350", "#8a5a78", "#e6935c", "#f5c27a"], [0, 0.45, 0.8, 1], 0.9);
    return preset("mammatus-dusk", "Mammatus", "Mammatus pouches hanging from a dark anvil at sunset: scalloped lobes lit coral on the sun side, violet in shadow, over a golden gap.", [
      ...sky.rails,
      boundary(scallopNodes(0.3, [0.5, 0.56, 0.48, 0.55, 0.5], 0.9), ["#2b2238", "#3f3050", "#59405f", "#7a5068"], ["#8f5a72", "#c8707a", "#f09a72", "#ffc890"]),
      boundary(scallopNodes(0.56, [0.78, 0.74, 0.8, 0.75], 0.9), ["#4b3a5e", "#634a6a", "#845a72", "#a86a74"], ["#c98a86", "#f2a276", "#ffc27c", "#ffd58a"]),
      floor(["#3a2230"]),
    ]);
  })(),
  (() => {
    const H = 0.66, sky = skyField(["#070b2a", "#1c2c6a", "#4a68a8", "#d98ba0"], [0, 0.45, 0.85, 1], H);
    return preset("polar-twilight", "Polar twilight", "Midwinter noon above the Arctic circle: a thin band of rose and peach under an indigo sky, blue-violet snow below.", [
      ...sky.rails, row(0.25, [sky.at(0.25)]), row(0.46, [sky.at(0.46)]),
      boundary(catmullRomNodes([[0, H], [0.3, H - 0.012], [0.65, H + 0.006], [1, H - 0.008]]), ["#f6c0a4", "#f3b0a8", "#e59aa8"], ["#8c96c8", "#7a86bc", "#8c96c8"]),
      row(0.82, ["#5a68a8", "#6a76b6", "#5a68a8"]), floor(["#232c62"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#9cc4e0", "#dfe9ee", "#fbf0cf", "#f6e4b0"], [0, 0.4, 0.8, 1], 0.6);
    const haze = (y, a, b, amp) => streak([[0, y], [0.25, y - amp], [0.5, y + amp], [0.75, y - amp], [1, y]], [a, b, a]);
    return preset("desert-heat-haze", "Desert heat haze", "Noon over a salt-and-sand plain: a white-hot horizon, a trembling blue mirage lake, and ochre ground wobbling in rippled bands.", [
      ...sky.rails, row(0.25, [sky.at(0.25)]),
      boundary(catmullRomNodes([[0, 0.6], [0.2, 0.585], [0.4, 0.6], [0.62, 0.58], [0.8, 0.6], [1, 0.59]]), ["#fbf0cf", "#f6e4b0"], ["#c9b190", "#d3bc90"]),
      boundary(lensNodes([0.12, 0.665], [0.88, 0.665], 0.016), closedRamp(["#c5def0", "#a9cce4", "#c5def0"]), closedRamp(["#e2cf9c", "#e2cf9c", "#e2cf9c"]), true),
      haze(0.72, "#ecd39c", "#cfa870", 0.005), haze(0.79, "#e2b884", "#bc8e58", 0.008), haze(0.87, "#d0a468", "#b3814c", 0.01), haze(0.95, "#c29558", "#9e703c", 0.013), floor(["#96693a"]),
    ]);
  })(),
  (() => {
    const H = 0.8, field = (y) => mixHex("#040914", "#0b2a36", Math.min(1, y / H));
    const bases = [0.6, 0.57, 0.54, 0.56, 0.6, 0.63, 0.61, 0.57], tops = [0.14, 0.08, 0.22, 0.12, 0.26, 0.1, 0.2, 0.16];
    const tipOf = ["#d0306a", "#9a3aa6", "#e0405a", "#a03aa0", "#d0306a", "#9a3aa6", "#e0405a", "#b03a9a"];
    const ray = (x, i) => {
      const dx = (i % 2 ? -1 : 1) * 0.03;
      return boundary(catmullRomNodes([[x, bases[i]], [x + dx / 2, (bases[i] + tops[i]) / 2], [x + dx, tops[i]]]),
        [i % 2 ? "#a4ffc8" : "#7dffa8", i % 2 ? "#2aa97a" : "#26a86a", tipOf[i], mixHex(tipOf[i], "#12081e", 0.7)]);
    };
    return preset("aurora-crimson-crown", "Crimson aurora rays", "A storm-night aurora: tall rays burn emerald at their bright lower edge and fade through violet to crimson tips, over black pines.", [
      ...sideRails(["#040914", "#08202c", "#0b2a36"], H).map((f) => f),
      ...[0.09, 0.22, 0.34, 0.46, 0.58, 0.7, 0.82, 0.93].map((x, i) => ray(x, i)),
      boundary(polylineNodes([[0, 0.83], [0.08, 0.83], [0.1, 0.76], [0.13, 0.83], [0.3, 0.83], [0.33, 0.74], [0.36, 0.83], [0.7, 0.83], [0.73, 0.75], [0.76, 0.83], [1, 0.83]]), ["#0b2a36"], ["#020408"]),
    ]);
  })(),
  (() => {
    const H = 0.8, sky = skyField(["#03060f", "#0a1330", "#1a2a5a"], [0, 0.5, 1], H);
    const post = (x, h) => boundary(polylineNodes([[x, 0.68], [x, h]]), ["#2a8a74", "#57f0a8", "#8dffc8", "#5a86c0"]);
    return preset("steve-ribbon", "STEVE ribbon", "STEVE: a narrow mauve-white ribbon arcing across the night with a row of green picket-fence rays beneath it.", [
      ...sky.rails, row(0.3, [sky.at(0.3)]),
      boundary(catmullRomNodes([[0, 0.5], [0.3, 0.45], [0.7, 0.42], [1, 0.42]]), [sky.at(0.5), "#c58bff", "#efd6ff", sky.at(0.42)]),
      ...[[0.14, 0.53], [0.26, 0.52], [0.38, 0.5], [0.5, 0.49], [0.62, 0.48], [0.74, 0.48], [0.86, 0.47]].map(([x, h]) => post(x, h)),
      boundary(polylineNodes([[0, 0.82], [0.1, 0.82], [0.13, 0.74], [0.16, 0.82], [0.4, 0.82], [0.43, 0.75], [0.46, 0.82], [0.8, 0.82], [0.83, 0.73], [0.86, 0.82], [1, 0.82]]), [sky.at(0.8)], ["#02040a"]),
    ]);
  })(),
  (() => {
    const sky = skyField(["#030713", "#0d2b33", "#030a12"], [0, 0.5, 1], 1);
    const lift = (pts) => pts.map(([x, y]) => [x, 1 - y]);
    const arcA = [[0, 0.38], [0.3, 0.3], [0.7, 0.27], [1, 0.36]], arcB = [[0, 0.24], [0.4, 0.17], [0.75, 0.14], [1, 0.2]];
    const dim = (c) => mixHex(c, "#06121c", 0.45);
    const ramp = (a, b, y0, y1, k) => [sky.at(y0), k(a), k(b), sky.at(y1)];
    return preset("aurora-mirror-lake", "Aurora on still water", "An aurora arching over a windless lake: emerald and violet curtains above the shoreline, repeated fainter in the black water.", [
      ...sky.rails,
      streak(arcA, ramp("#4af0a0", "#b9ffdc", 0.38, 0.36, (c) => c)), streak(arcB, ramp("#7a4ad0", "#c290ff", 0.24, 0.2, (c) => c)),
      boundary(polylineNodes([[0, 0.5], [0.08, 0.5], [0.1, 0.46], [0.13, 0.5], [0.45, 0.5], [0.48, 0.47], [0.5, 0.5], [0.82, 0.5], [0.85, 0.455], [0.88, 0.5], [1, 0.5]]), ["#0d2b33"], ["#0a2028"]),
      streak(lift(arcA), ramp("#4af0a0", "#b9ffdc", 0.62, 0.64, dim)), streak(lift(arcB), ramp("#7a4ad0", "#c290ff", 0.76, 0.8, dim)),
    ]);
  })(),
  (() => {
    const H = 0.86, sky = skyField(["#26336e", "#6e6aa6", "#e9a08a", "#f8c8a0"], [0, 0.4, 0.8, 1], H);
    const lens = (cx, cy, half, bow, lit, mid, dark) => boundary(lensNodes([cx - half, cy], [cx + half, cy], bow), closedRamp([lit, mid, dark]), closedRamp([sky.at(cy), sky.at(cy), sky.at(cy)]), true);
    return preset("lenticular-dusk", "Lenticular dusk", "Stacked lenticular clouds hovering over a volcano at dusk, their rims lit rose and their bellies violet against a peach afterglow.", [
      ...sky.rails, row(0.18, [sky.at(0.18)]), row(0.66, [sky.at(0.66)]),
      lens(0.56, 0.3, 0.27, 0.035, "#ffcdbf", "#b08ab4", "#7a6aa8"), lens(0.56, 0.41, 0.2, 0.03, "#ffc0b0", "#a07aa8", "#6f62a0"), lens(0.56, 0.5, 0.12, 0.022, "#ffb8a6", "#9a72a4", "#6a5a9c"),
      boundary(catmullRomNodes([[0, 0.86], [0.25, 0.83], [0.42, 0.72], [0.56, 0.6], [0.7, 0.72], [0.85, 0.83], [1, 0.86]]), [sky.at(0.8)], ["#221a3c"]),
      floor(["#150f28"]),
    ]);
  })(),
];
