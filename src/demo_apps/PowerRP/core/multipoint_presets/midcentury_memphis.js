/**
 * "Mid-century to Memphis" — native Multipoint presets. Cut-paper title design, Swiss posters, 70s album-art prisms and Memphis furniture.
 * Authored by the 2026-09-30 Sonnet research frenzy from real references (sources: concerns.md,
 * "round-3 preset merge"), curated and merged by the lead. Family-specific geometry lives here;
 * shared geometry is ../multipoint_shapes.js and the builders are ./builders.js.
 */
import { preset, boundary, point } from "./builders.js";
import { polylineNodes, mixHex } from "../multipoint_shapes.js";
import { polyShape, smoothShape, disc, groundFrame, annularSectorNodes } from "./midcentury_helpers.js";

// ── Bass: Anatomy of a Murder (1959) ─────────────────────────────────────────────────
const MURDER = { gold: "#f5a41f", red: "#ee2a27", black: "#100d0c" };

// ── Müller-Brockmann: Beethoven (1955) ───────────────────────────────────────────────
const BROCKMANN = { ink: "#0c0c0d", paper: "#f7f6f2" };

// ── Sottsass: Carlton (1981) ─────────────────────────────────────────────────────────
const CARLTON = { wall: "#a89f88", green: "#4ea95c", butter: "#eee89c", pink: "#f3cbc6", red: "#ea4a2a", blue: "#3a5fb0", black: "#17151a" };

// ── Hipgnosis: prism (1973) ──────────────────────────────────────────────────────────
const SPECTRUM = ["#e8262b", "#f47a1f", "#f7d51b", "#3fae49", "#2a7fd6", "#6a3fb0"];

/**
 * Pure function. Ray i of a fan leaving a vertical slit on x = x0: from (x0, slit y) to (1, edge y).
 * @param {number} x0 - Slit x.
 * @param {number} y0 - Slit y.
 * @param {number} y1 - Height where the ray meets the right box edge.
 * @returns {number[][]} [2,6] straight ray nodes.
 * @example fanRay(0.6, 0.5, 0.2).map((n) => n.slice(0, 2)) // [[0.6,0.5],[1,0.2]]
 */
const fanRay = (x0, y0, y1) => polylineNodes([[x0, y0], [1, y1]]);

const PRISM = { ink: "#08090c", glass: "#1b2029", rim: "#f4f6fa" };

export const PRESETS = [
  preset("cutout-figure", "Cut-paper figure", "Late-1950s cut-paper title design: a black figure broken into angular pieces on a mustard-orange field over a red block.", [
    boundary(polylineNodes([[0, 0.66], [1, 0.635]]), [MURDER.gold], [MURDER.red]),
    ...[
      [[0.53, 0.27], [0.71, 0.25], [0.73, 0.43], [0.51, 0.44]],
      [[0.31, 0.3], [0.5, 0.29], [0.49, 0.43], [0.3, 0.45]],
      [[0.08, 0.33], [0.29, 0.31], [0.27, 0.44], [0.09, 0.47]],
      [[0.06, 0.5], [0.24, 0.47], [0.21, 0.57], [0.15, 0.61], [0.05, 0.59]],
      [[0.56, 0.2], [0.7, 0.07], [0.83, 0.09], [0.91, 0.15], [0.79, 0.17], [0.66, 0.225]],
      [[0.58, 0.47], [0.72, 0.46], [0.79, 0.56], [0.86, 0.6], [0.76, 0.62], [0.66, 0.58]],
    ].map((pts) => polyShape(pts, MURDER.gold, MURDER.black)),
    smoothShape([[0.75, 0.31], [0.83, 0.3], [0.88, 0.36], [0.85, 0.43], [0.78, 0.44], [0.74, 0.37]], MURDER.gold, MURDER.black),
  ]),
  preset("beethoven-arcs", "Beethoven arcs", "Müller-Brockmann's 1955 Tonhalle poster: black arc bands with radial cuts circling a white disc on black.", [
    groundFrame(BROCKMANN.ink),
    disc(0.46, 0.54, 0.44, 0.44, BROCKMANN.ink, BROCKMANN.paper),
    point(0.46, 0.54, BROCKMANN.paper),
    ...[[0.33, 0.405, 0.15, 2.3], [0.255, 0.315, 2.1, 4.75], [0.185, 0.235, 0.6, 3.5], [0.125, 0.16, 3.7, 5.9]].map(([r0, r1, a0, a1]) =>
      boundary(annularSectorNodes(0.46, 0.54, r0, r1, a0, a1), [BROCKMANN.paper], [BROCKMANN.ink], true)),
  ]),
  preset("carlton-shelves", "Carlton shelves", "Sottsass's 1981 Carlton bookcase as a flat composition: pastel slats, green shelf and red drawer on taupe.", [
    groundFrame(CARLTON.wall),
    polyShape([[0.04, 0.5], [0.96, 0.5], [0.96, 0.57], [0.04, 0.57]], CARLTON.wall, CARLTON.green),
    polyShape([[0.3, 0.12], [0.7, 0.12], [0.7, 0.18], [0.3, 0.18]], CARLTON.wall, CARLTON.butter),
    polyShape([[0.3, 0.46], [0.5, 0.22], [0.7, 0.46]], CARLTON.wall, CARLTON.pink),
    polyShape([[0.06, 0.24], [0.12, 0.22], [0.26, 0.46], [0.2, 0.48]], CARLTON.wall, CARLTON.butter),
    polyShape([[0.94, 0.24], [0.88, 0.22], [0.74, 0.46], [0.8, 0.48]], CARLTON.wall, CARLTON.butter),
    polyShape([[0.14, 0.6], [0.22, 0.58], [0.34, 0.74], [0.26, 0.76]], CARLTON.wall, CARLTON.red),
    polyShape([[0.86, 0.6], [0.78, 0.58], [0.66, 0.74], [0.74, 0.76]], CARLTON.wall, CARLTON.red),
    polyShape([[0.36, 0.62], [0.64, 0.62], [0.64, 0.82], [0.36, 0.82]], CARLTON.wall, CARLTON.red),
  ]),
  preset("prism-beam", "Prism beam", "Early-1970s album-art prism: a white beam strikes a glass triangle on black and leaves as a six-colour spectrum.", (() => {
    const faceX = (y) => 0.4 + 0.26 * (y - 0.2) / 0.46 + 0.012;
    const rays = [0.13, 0.26, 0.39, 0.52, 0.65, 0.78, 0.91].map((y, i) => { const y0 = 0.415 + i * 0.011; return [faceX(y0), y0, y]; });
    const bands = rays.map(([x0, y0, y1], i) => {
      const above = i ? SPECTRUM[i - 1] : PRISM.ink, below = i < SPECTRUM.length ? SPECTRUM[i] : PRISM.ink;
      return boundary(fanRay(x0, y0, y1), [mixHex(above, "#ffffff", i ? 0.55 : 0), above], [mixHex(below, "#ffffff", i < SPECTRUM.length ? 0.55 : 0), below]);
    });
    return [
      boundary(polylineNodes([[1, 0], [0, 0], [0, 1], [1, 1]]), [PRISM.ink]),
      polyShape([[0.4, 0.2], [0.14, 0.66], [0.66, 0.66]], PRISM.ink, PRISM.rim),
      polyShape([[0.4, 0.26], [0.19, 0.63], [0.61, 0.63]], PRISM.rim, PRISM.glass),
      polyShape([[0, 0.55], [0.21, 0.505], [0.21, 0.525], [0, 0.575]], PRISM.ink, "#ffffff"),
      ...bands,
    ];
  })()),
];
