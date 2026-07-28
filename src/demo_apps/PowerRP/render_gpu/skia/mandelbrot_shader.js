/**
 * THE mandelbrot material — a GENERATIVE (backdrop:false) FOREGROUND material
 * (materialFill) that renders a DEEP-ZOOM Mandelbrot set per pixel, far past the
 * depth ordinary floating point can reach, and colours it with the modern
 * orbit-average / distance-estimate palette stack.
 *
 * ── WHY THIS FILE ALSO HOLDS CPU CODE ────────────────────────────────────────
 * Everything the shader cannot compute itself lives here beside it: the
 * arbitrary-precision REFERENCE ORBIT (BigInt fixed point) and the OKLab PALETTE
 * BAKE. Both are pure functions of widget state and both produce plain float
 * arrays that ride to the GPU as ordinary op params — the same "baked data asset
 * beside its shader" shape as blue_noise_64.js beside dither_shader.js. The
 * plugin (plugins/demo/mandelbrot.js) stays a thin declarative widget.
 *
 * ── 1. WHY NAIVE ITERATION DIES, AND WHAT PERTURBATION FIXES ─────────────────
 * A view of half-width w across W pixels spaces adjacent pixels by 2w/W. A float
 * with a p-bit mantissa spaces representables near |c| ≈ 1 by 2^(1-p), so once
 * 2w/W < 2^(1-p) adjacent pixels round to the SAME c and the image degenerates
 * into flat blocks. For W = 1920 that wall is w ≈ 1.1e-4 in float32 and
 * w ≈ 2.1e-13 in float64 — and a GPU shader has no float64 at all (probed: SkSL
 * rejects both `double` and `float64`).
 *
 * PERTURBATION (K. I. Martin, SuperFractalThing, 2013) removes the wall
 * SYMBOLICALLY. Take one reference point C, iterate its orbit Zn once in high
 * precision, and write each pixel's c as C + dc, z_n as Z_n + d_n. Substituting
 * into z' = z^2 + c and cancelling Z_{n+1} = Z_n^2 + C from both sides leaves
 *
 *                           2
 *     d_{n+1} = 2⋅Zn⋅dn + dn  + dc
 *
 * EXACTLY — nothing is approximated. The two long numbers cancel BEFORE any
 * arithmetic happens. What is left needs only the RELATIVE precision to tell one
 * pixel from another (about log2(W) ≈ 11 bits) and the EXPONENT RANGE to hold dc,
 * so the entire per-pixel loop runs in ordinary hardware floats. Only C and the
 * COMPUTATION of Zn need long numbers, and that happens once, on the CPU, for one
 * point (referenceOrbit below). The escape test must be on the FULL value
 * |Z_n + d_n|, never |d_n| — a delta is a difference, not a position.
 *
 * ── 2. REBASING, AND WHY IT MAKES THE SHADER POSSIBLE AT ALL ─────────────────
 * Perturbation's one hazard is CANCELLATION: when the pixel's orbit passes much
 * nearer zero than the reference's, z = Z + d is a small number written as the
 * sum of two large ones and its leading digits are destroyed (a "glitch"). The
 * classic fix DETECTS glitched pixels and re-renders them against extra
 * references — multi-pass, and NON-DETERMINISTIC (the blobs depend on the pixel
 * grid, so the same view at another resolution picks other references).
 *
 * REBASING (Zhuoran, 2021) removes the failure instead. z_n is itself a point on
 * the orbit of c and Z_0 = 0, so (0, z_n) is a perfectly valid (reference index,
 * delta) pair. Therefore whenever |z| < |d| — or the reference runs out — set
 * d := z and reset the reference index to 0. The invariant |d| ≤ |z| then holds
 * at the top of every iteration, so |Z_m| = |z - d| ≤ 2|z| and the
 * reconstruction's relative error is at most 2⋅eps UNCONDITIONALLY. Glitches
 * become structurally impossible, and the output becomes REFERENCE-INDEPENDENT —
 * verified, but with ONE measured caveat that MANDELBROT_REF_LEN documents in
 * full: the reference must be long enough that rebasing is triggered by `|z| < |d|`
 * and never by running out of reference, because in single precision the latter
 * destroys the per-pixel offset.
 *
 * THE SHADER STRUCTURE THIS BUYS. SkSL may index a uniform array ONLY by a loop
 * INDUCTION VARIABLE (probed: `uArr[i]` and `uArr[i*3]` compile, `uArr[m]` with a
 * mutable counter does not). A rebase resets the reference index to EXACTLY ZERO
 * — which is precisely what re-entering an inner loop does. So the whole
 * algorithm is a NEST: the outer loop counts rebase RUNS, the inner loop's
 * induction variable IS the reference index, and a rebase is `break`. Measured:
 * the nest compiles at 8192x2048 in 0.3 ms (no unrolling) and runs on both the
 * GL and the software raster backend.
 *
 * ── 3. WHAT MAKES IT LOOK LIKE SOMETHING ─────────────────────────────────────
 * SMOOTH ITERATION COUNT. Outside the escape radius |z'| ≈ |z|^2, so log2 log|z|
 * advances by exactly 1 per step and subtracting it removes the integer
 * staircase:
 *
 *            ⎛log(absz)⎞
 *         log⎜─────────⎟
 *            ⎝ log(R)  ⎠
 *     ν = n - ────────────── + 1
 *             log(2)
 *
 * The error is O(1/R^2) — measured 3.14 iterations at R = 2 but 4.7e-6 at
 * R = 256, which is why the default escape radius is 256 and not 2.
 *
 * DERIVATIVE, in PIXEL units. F_n = (dz/dc)⋅halfWidth satisfies
 * F_{n+1} = 2⋅Fn⋅zn + halfWidth (update F BEFORE z — it uses the OLD z), which is
 * the ordinary recurrence with z reconstructed from the perturbation, so NO
 * reference derivative is needed. Scaling by halfWidth rather than seeding with 1
 * is what keeps |F| ≈ O(1) instead of overflowing at depth. The exterior distance
 * estimate then comes out already in device pixels:
 *
 *                2⋅absz⋅halfWidthPx⋅log(absz)
 *     dePixels = ────────────────────────────
 *                            absF
 *
 * STRIPE AVERAGE COLOURING (Härkönen, 2007) — the biggest visual win and cheap:
 * a running mean of a periodic function of the orbit's ARGUMENT,
 *
 *          sin(argzk⋅density)   1
 *     tk = ────────────────── + ─
 *                  2            2
 *
 * reads as silk or brushed metal draped over the escape-time field. TRIANGLE
 * INEQUALITY AVERAGE is its modulus counterpart — where |z_{k+1}| falls inside
 * the bracket the triangle inequality puts on it,
 *
 *          abszNext - mk
 *     tk = ─────────────
 *             Mk - mk
 *
 * with mk = | |z_k|^2 - |c| | and Mk = |z_k|^2 + |c| — so the two look nothing
 * alike and mix well. Both averages JUMP when a pixel's escape iteration ticks
 * over, which is exactly the banding they exist to remove, so both are carried at
 * N and N-1 and blended by frac(ν):
 *
 *         sumPrev⋅(1 - frac)   frac⋅sumN
 *     S = ────────────────── + ─────────
 *               N - 1              N
 *
 * NORMAL SHADING from the derivative gives the 3-D lit relief with NO neighbour
 * samples (the only kind a per-pixel shader can afford): u = z/(dz/dc) points
 * along the field's gradient, so
 *
 *             lightHeight + uDotV
 *     shade = ───────────────────
 *               lightHeight + 1
 *
 * CYCLIC PALETTE — not a style choice, a REQUIREMENT. Measured: at a 1e-12 view
 * the smooth count across the WHOLE frame spans 2.4 iterations riding on an
 * offset of 1117, so any palette(ν/maxIter) is one flat colour. A cyclic palette
 * indexed by frac(ν/scale) is invariant to that offset modulo the scale. Stops
 * are interpolated in OKLab on the CPU (bakeMandelbrotPalette) because an sRGB
 * lerp of red→blue passes through a dark desaturated mud.
 *
 * ANALYTIC BAND-LIMIT — the free antialias. Verified numerically:
 *
 *                 1
 *     absGradNu = ─────────
 *                 DE⋅log(2)
 *
 * so one pixel spans
 *
 *                       1
 *     footprint = ──────────────────────
 *                 dePixels⋅period⋅log(2)
 *
 * palette cycles — exact, with no screen-space derivative and free because the
 * distance estimate is already computed. Fading the palette toward its MEAN as
 * that footprint approaches Nyquist is what a mipmap would do.
 *
 * ── 4. INTERIOR EARLY-OUT ────────────────────────────────────────────────────
 * The multiplier q_{n+1} = 2⋅z_n⋅q_n (note: no "+1") shrinks to zero for a point
 * attracted to a cycle, so |q| < threshold certifies the interior long before
 * maxIter. Measured 77x fewer iterations with zero false interiors. It needs no
 * absolute c and no stored history, and it survives perturbation because every
 * factor 2(Z_k + d_k) is O(1) — unlike epsilon-periodicity checking, which tests
 * the wrong quantity once the reference is not a nucleus. The cardioid and
 * period-2 closed forms are deliberately NOT used: they need the ABSOLUTE c,
 * which no fp32 shader has at depth, and this test subsumes them (a point deep
 * inside the main cardioid is certified in a handful of iterations).
 *
 * ── 5. WHAT THIS SHADER CANNOT DO, STATED PLAINLY ────────────────────────────
 * PRECISION. The deltas are fp32, so the reachable depth is bounded by fp32's
 * exponent range (|dc| must stay above the ~1.2e-38 smallest normal) and the
 * accuracy is fp32 accuracy. Measured against the float64 kernel on the same grid
 * and the same reference: 4% of pixels at 1e-3 and 23% at 1e-11 differ, ALL of
 * them isolated single pixels on the chaotic set boundary (no seams, no blobs),
 * and the two images are visually indistinguishable. An experiment splitting the
 * error between orbit STORAGE and delta ARITHMETIC found the two contribute
 * equally (600 vs 747 pixels of 19200), so a split-float orbit would buy almost
 * nothing — fp32 is fp32.
 *
 * COST ON THE SOFTWARE RASTER BACKEND. Measured 3.1 microseconds per iteration
 * per pixel — about 300x what the same arithmetic costs in plain JS float64, and
 * it is NOT the uniform-array read (cost is flat across reference lengths 64 to
 * 4096, measured). That makes this by a wide margin the most expensive material in
 * the app on every path that rasters in software: PNG export, PDF raster regions,
 * and the headless CLI. Thumbnails and the minimap are covered by the proxyFill
 * below (measured 1500x to 69000x cheaper at 256x144); the full-quality software
 * paths are not, and a full-slide render there is minutes, not seconds. The
 * editor and presenter use the GL backend, where this is the fast path.
 *
 * UNIFORM SPACE, and the bug it caused. The reference orbit is the largest uniform
 * block in the app, and GL charges uniform arrays BY THE ROW: one float4 row per
 * element, whatever the element's type. The first shipped version declared
 * `float2 uOrbit[2048]` and asked for ~2110 rows — renderable on the 10% of devices
 * that report 2048+ rows and SILENTLY BLANK on the other 90%, because a GL program
 * the driver refuses is dropped at draw time with no exception, no report and no
 * pixels. MANDELBROT_UNIFORM_ROW_BUDGET carries the full account.
 *
 * ITERATION AND DEPTH CEILING. maxIterations is capped at
 * MANDELBROT_MAX_ITERATIONS, twice the reference length, because past the reference
 * length every iteration is driven by an exhaustion rebase and 2x is as far as that
 * was measured. The DEPTH ceiling is the reference length itself
 * (MANDELBROT_REF_LEN), which the UNIFORM ROW BUDGET pins — verified with structure
 * to 1e-10.5, unverified past 1e-11, and the failure past it is a FLAT frame rather
 * than a noisy one.
 *
 * DOM-free at import (string SkSL + pure packers/builders), like every material.
 */

import { parseColor } from "../ir.js";

// ── sizes (compile-time in the SkSL, so exported for the plugin and the tests) ─

/**
 * THE BINDING CONSTRAINT: uniform ROWS a fragment program may declare.
 *
 * A GL uniform is charged by the ROW (one float4), and the GLSL ES packing rules
 * give EVERY ARRAY ELEMENT A FULL ROW OF ITS OWN — arrays are never packed across
 * elements. So `uniform float2 uOrbit[2048]` costs 2048 rows and throws away half
 * of every one of them. Measured directly (WebGL2 link probe, one array at a time):
 * float, float2, float3 and float4 arrays ALL cost exactly 1 row per element.
 *
 * WHAT HAPPENS WHEN THE BUDGET IS EXCEEDED IS THE WORST POSSIBLE THING, and it is
 * why this constant exists. SkSL compiles (RuntimeEffect.Make succeeds) and
 * makeShader succeeds — those only build Skia objects. The GL program is not
 * compiled until DRAW time, inside Ganesh, and when the driver refuses it Skia
 * DROPS THE DRAW: no exception reaches JS, nothing reports, and the widget's
 * region is simply never painted. Reproduced in a real browser: the fractal panel
 * renders as a BLANK page-coloured rectangle while the thumbnail (which takes the
 * proxyFill path) still shows its gradient, with nothing in the app to explain it.
 * The only trace is Skia's own console dump ending in
 *
 *     FRAGMENT shader uniforms count exceeds MAX_FRAGMENT_UNIFORM_VECTORS(N)
 *
 * THE BUDGET IS SET FROM MEASURED HARDWARE, not from a guess. The WebGL survey
 * distribution of MAX_FRAGMENT_UNIFORM_VECTORS (web3dsurvey.com) is a step
 * function: 256 rows are supported by 100% of surveyed devices, everything from
 * 300 through 1024 by the SAME 95%, and 2048 or more by only 10%. So there are
 * exactly two meaningful budgets — 256 (universal) and 1024 (95%) — and no reason
 * to sit anywhere between 300 and 1024. This ships 1024 and spends barely half of
 * it. WebGL2's SPEC minimum is 224, so the residual ~5% must be told out loud
 * rather than shown a blank square; see MANDELBROT_MATERIAL.uniformRows.
 */
export const MANDELBROT_UNIFORM_ROW_BUDGET = 1024;

/**
 * Reference-orbit length: how many points of the high-precision orbit ride to the
 * GPU. It is bounded ABOVE by the uniform row budget and BELOW by a measured
 * precision cliff, and it sits at the largest power of two that satisfies both.
 *
 * THE TRAP THAT SETS THE LOWER BOUND. Rebasing has two triggers: `|z| < |d|` (the
 * real one) and "the reference ran out". The received wisdom is that the second
 * makes a SHORT reference sufficient — Fraktaler 3 ships a 1024-iteration cap and
 * the theory says a short reference drives million-iteration pixels. That is true
 * in double precision. In SINGLE precision it is only true up to a depth.
 *
 * On an exhaustion rebase the code sets `d := z`, so the delta becomes an O(1)
 * quantity. The next step adds `dc` to it — and `dc` is one view half-width. Once
 * the half-width falls below the single-precision ulp of an O(1) number (about
 * 6e-8), `d + dc == d`: THE PER-PIXEL OFFSET IS ANNIHILATED and every pixel in the
 * frame follows the identical trajectory. The image does not glitch, it goes FLAT,
 * which is the hardest kind of wrong to notice.
 *
 * MEASURED IN THE REAL SHADER, IN REAL fp32 (the `refCount` uniform forced down
 * while the array stayed long, which exercises the exhaustion branch exactly),
 * 500x380 device px, mean |dRGB| against the same view with the full reference:
 *
 *     seahorse tail, 1e-2.94, 900 iterations     refCount 128 -> 0.17   (identical)
 *     embedded Julia, 1e-10.5, 2048 iterations   refCount 1024 -> 0.84  (identical)
 *                                                refCount  512 -> 77.4  (destroyed)
 *                                                refCount  256 -> 71.0  (destroyed)
 *
 * Three facts fall out. At SHALLOW zoom exhaustion is harmless, exactly as the ulp
 * argument predicts — a 128-point reference drives a 900-iteration render. At
 * 1e-10.5 the cliff sits between 512 and 1024, so 1024 is the shortest power of two
 * that keeps the deepest shipped preset intact. And 1024 points DO drive a
 * 2048-iteration render at that depth (the 0.84 row above is the deep preset's
 * shipped configuration, and the two images are indistinguishable), which is why
 * MANDELBROT_MAX_ITERATIONS is no longer tied to this number.
 *
 * THE COST, and why it is not 2048. 1024 complex points packed TWO PER ROW is 512
 * uniform rows; the whole program is MANDELBROT_UNIFORM_ROWS. At 2048 points it
 * would be 1088 rows — over the 1024 budget, i.e. renderable on the 10% of devices
 * that report 2048+ and INVISIBLE on the rest. That is precisely the bug this
 * number fixes, so the reference length is what gives way, not the budget.
 *
 * WHAT IS NOT VERIFIED: whether 1024 points still suffice past 1e-11. The cliff
 * moved from "below 512" to "below 1024" between 1e-3 and 1e-10.5, so it plainly
 * moves with depth, and nothing here measures where it goes next. A view deep
 * enough to cross it goes FLAT rather than glitching — see the trap above.
 */
export const MANDELBROT_REF_LEN = 1024;

/**
 * Complex points per uniform row. A row is a float4 and a complex point is two
 * floats, so the orbit ships as `float4 uOrbit[REF_LEN/2]` — the DENSEST layout
 * possible, and exactly 2x the reach of the float2 array it replaces for the same
 * hardware. The float MEMORY layout is unchanged (interleaved re, im, re, im …),
 * so referenceOrbit and packMandelbrot are untouched by the repack; only the
 * DECLARATION the driver counts differs.
 */
const ORBIT_POINTS_PER_ROW = 2;

/** Rows the orbit array occupies. @see ORBIT_POINTS_PER_ROW */
export const MANDELBROT_ORBIT_ROWS = MANDELBROT_REF_LEN / ORBIT_POINTS_PER_ROW;

/**
 * Iterations past the reference length that `maxIterations` may ask for. Beyond
 * MANDELBROT_REF_LEN every further iteration is reached by REUSING the reference
 * from index 0 after an exhaustion rebase, which is the mechanism with the measured
 * cliff — so this is a factor bounded by evidence, not a round number: the deepest
 * shipped view was measured correct at 2x (2048 iterations on a 1024-point
 * reference, indistinguishable from a 2048-point reference), and nothing was
 * measured beyond that.
 */
const MAX_ITERATIONS_PER_REFERENCE = 2;

/**
 * Hard cap on `maxIterations`. It is ALSO the outer (rebase-run) trip count,
 * because a run always advances the iteration count by at least one, so
 * MAX_RUNS ≥ cap is what makes the cap reachable even in the pathological case of
 * a rebase on every iteration.
 *
 * IT IS DELIBERATELY LARGER THAN MANDELBROT_REF_LEN, and that is a reversal worth
 * recording. Equal was the safe reading of the exhaustion trap, but it costs the
 * deep preset everything: the embedded-Julia view at 1e-10.5 needs about 2000
 * iterations and renders as a SOLID BLACK RECTANGLE at 1024 (every pixel hits the
 * ceiling and is declared interior). Since the reference length is now pinned by
 * the uniform budget rather than free to grow, capping iterations at it would trade
 * a blank square for a black one. Measured instead: 2048 iterations on the
 * 1024-point reference reproduce the 2048-point reference to a mean |dRGB| of 0.84
 * over 500x380 px — visually identical. @see MAX_ITERATIONS_PER_REFERENCE
 */
export const MANDELBROT_MAX_ITERATIONS = MANDELBROT_REF_LEN * MAX_ITERATIONS_PER_REFERENCE;

/** Baked cyclic-palette entries. 32 is smooth enough that the shader's linear
 *  gather between neighbours is invisible. Being an ARRAY it costs one uniform ROW
 *  per stop (32), not 96/4 — see MANDELBROT_UNIFORM_ROW_BUDGET. */
export const MANDELBROT_PALETTE_STOPS = 32;

/** Escape radius default. Large (not 2) because the smooth-iteration and stripe
 *  colourings assume |z| is already deep in the |z'| ≈ |z|^2 regime; 2^8 is what
 *  the smooth-colouring literature standardizes on and measures at 4.7e-6 error. */
export const MANDELBROT_ESCAPE_RADIUS = 256;

/** Colour-axis codes (the `colorAxis` select's numeric form). */
export const MANDELBROT_AXIS_CODE = { iteration: 0, logIteration: 1, distance: 2 };

// scalars 27 + float4 4 + float3 3 + palette 3N + orbit 2M
const MANDELBROT_UNIFORM_FLOATS = 27 + 4 + 3 + 3 * MANDELBROT_PALETTE_STOPS + 2 * MANDELBROT_REF_LEN;

/**
 * Uniform ROWS everything that is NOT one of the two arrays costs: this shader's
 * 21 scalars, 3 float2s, 1 float4 and 1 float3 after the GLSL ES packing rules
 * squeeze them together, PLUS the two uniforms Skia adds to every runtime-effect
 * program (`sk_RTAdjust`, one row, and the `umatrix` mat3, three). MEASURED at 30
 * by link-probing the exact declaration list Skia emitted for this material and
 * subtracting the array rows. Adding a scalar may or may not cost a row (it fills a
 * gap first), so this is a floor, not a formula — which is why the row total is
 * checked against a budget with room to spare rather than to the last row.
 */
const MANDELBROT_FIXED_UNIFORM_ROWS = 30;

/**
 * Uniform rows the compiled fragment program declares. This is the number the GL
 * driver compares against MAX_FRAGMENT_UNIFORM_VECTORS at DRAW time, and the number
 * whose overrun paints nothing at all — see MANDELBROT_UNIFORM_ROW_BUDGET.
 */
export const MANDELBROT_UNIFORM_ROWS = MANDELBROT_FIXED_UNIFORM_ROWS + MANDELBROT_PALETTE_STOPS + MANDELBROT_ORBIT_ROWS;

// THE GUARD THAT MAKES THE BLANK-SQUARE BUG UNREPEATABLE. Import-time, because the
// failure it prevents is invisible at run time on the machines that suffer it: a
// program over the row budget is dropped by the driver with no exception, no report
// and no pixels. Anyone raising MANDELBROT_REF_LEN or MANDELBROT_PALETTE_STOPS past
// the budget now fails HERE, loudly, on every platform including this one.
if (MANDELBROT_UNIFORM_ROWS > MANDELBROT_UNIFORM_ROW_BUDGET)
  throw new Error(`mandelbrot_shader: the shader declares ${MANDELBROT_UNIFORM_ROWS} uniform rows, past the ${MANDELBROT_UNIFORM_ROW_BUDGET}-row budget (orbit ${MANDELBROT_ORBIT_ROWS} + palette ${MANDELBROT_PALETTE_STOPS} + fixed ${MANDELBROT_FIXED_UNIFORM_ROWS}). A GL driver whose MAX_FRAGMENT_UNIFORM_VECTORS is below that DROPS THE DRAW SILENTLY — the widget renders as a blank rectangle with no error anywhere. Lower MANDELBROT_REF_LEN (2 orbit points per row) or MANDELBROT_PALETTE_STOPS (1 row each).`);

export const MANDELBROT_SKSL = `
const int   REF_LEN        = ${MANDELBROT_REF_LEN};
const int   ORBIT_ROWS     = ${MANDELBROT_ORBIT_ROWS};
const int   MAX_RUNS       = ${MANDELBROT_MAX_ITERATIONS};
const int   PALETTE_STOPS  = ${MANDELBROT_PALETTE_STOPS};
// Orbit-average terms skipped at the start: while N is small each term is a large
// fraction of the mean, which paints a hard halo hugging the set (Härkönen's own
// remedy).
const float AVERAGE_SKIP   = 2.0;
const float EDGE_AA        = 1.0;
// Once the interior multiplier |q|^2 passes this, tracking stops: the certificate
// is only ever used to declare a pixel interior EARLY, so abandoning it can cost
// iterations but can never change a pixel — and stopping keeps 2*z*q from reaching
// infinity and turning the next complex multiply into a not-a-number.
const float MULT_CEILING   = 1e30;
// Palette cycles per pixel at which the analytic band-limit STARTS fading the
// palette toward its mean, and at which the fade is COMPLETE. Nyquist puts the
// hard limit at half a cycle, so the ramp is centred there; a hard switch at one
// cycle leaves a visible ring where the aliased region meets the flat one.
const float BANDLIMIT_START = 0.25;
const float BANDLIMIT_FULL  = 1.0;
// Smallest positive value fed to a log or a division, so a degenerate pixel
// yields a finite colour instead of a not-a-number.
const float TINY = 1e-30;
// The sRGB transfer function (IEC 61966-2-1) — the palette and all compositing
// are LINEAR light; this is applied once, last.
const float SRGB_CUTOFF = 0.0031308;
const float SRGB_SLOPE  = 12.92;
const float SRGB_SCALE  = 1.055;
const float SRGB_OFFSET = 0.055;

uniform float2 uCenter;            // region centre, device px
uniform float2 uHalfSize;          // region half-size, device px
uniform float  uCornerRadius;      // device px
uniform float  uAngle;             // region rotation, radians
uniform float2 uCenterApprox;      // the complex centre to fp32 — the TRIANGLE average's |c| only
uniform float  uHalfWidth;         // complex-plane half-width of the view
uniform float  uMaxIter;
uniform float  uRefCount;          // valid entries in uOrbit
uniform float  uEscapeRadius;
uniform float  uInteriorTest;      // 0 = off, 1 = derivative-multiplier certificate
uniform float  uInteriorThreshold;
uniform float  uColorAxis;         // 0 = iteration, 1 = log iteration, 2 = screen-space distance
uniform float  uPaletteScale;      // iterations (or DE octaves) per palette cycle
uniform float  uPaletteOffset;
uniform float  uStripeAmount;
uniform float  uStripeDensity;
uniform float  uTriangleAmount;
uniform float  uShadeAmount;
uniform float  uLightAngle;        // radians
uniform float  uLightHeight;
uniform float  uGlowAmount;
uniform float  uGlowWidth;         // glow falloff, in device px of distance estimate
uniform float  uBandLimit;         // 0/1
uniform float  uBoundaryAA;        // 0/1 — distance-estimate coverage blend into the interior
uniform float4 uInteriorColor;     // LINEAR rgb + alpha
uniform float3 uPaletteMean;       // LINEAR — the band-limit fade target
uniform float3 uPalette[PALETTE_STOPS];   // LINEAR, cyclic
// THE REFERENCE ORBIT, TWO COMPLEX POINTS PER ROW: row r holds (Z_2r, Z_2r+1) as
// (.xy, .zw). Flattened point k therefore lives at uOrbit[k / 2], half k odd. A
// float2 array would hold ONE point per row and cost twice the uniform space for
// the same reach — the packing rules charge a full row per array element whatever
// its type (measured). Same float memory the packer already writes.
uniform float4 uOrbit[ORBIT_ROWS];

float2 cmul(float2 a, float2 b) { return float2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
float2 rot2(float2 v, float a) { float c = cos(a), s = sin(a); return float2(c * v.x - s * v.y, s * v.x + c * v.y); }
float sdRoundRect(float2 p, float2 h, float r) { float2 q = abs(p) - (h - r); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }

// Cyclic palette lookup as a GATHER: SkSL forbids indexing a uniform array by
// anything but a loop induction variable, so instead of picking two neighbours the
// loop visits every stop and sums a triangular (linear-interpolation) weight,
// wrapped in BOTH directions so the last stop blends back into the first.
float3 samplePalette(float t) {
  float x = fract(t) * float(PALETTE_STOPS);
  float3 acc = float3(0.0);
  for (int i = 0; i < PALETTE_STOPS; i++) {
    float dd = abs(x - float(i));
    float w = max(0.0, 1.0 - min(dd, float(PALETTE_STOPS) - dd));
    acc += w * uPalette[i];
  }
  return acc;
}

float3 encodeSrgb(float3 c) {
  c = clamp(c, 0.0, 1.0);
  float3 lo = c * SRGB_SLOPE;
  float3 hi = SRGB_SCALE * pow(c, float3(1.0 / 2.4)) - SRGB_OFFSET;
  return mix(hi, lo, step(c, float3(SRGB_CUTOFF)));
}

// One triangle-inequality term, or a negative value when the bracket is
// degenerate (which happens at c = 0) so the caller can SKIP it rather than fold
// a fabricated value into the average.
float triangleTerm(float prevAbs2, float cAbs, float nextAbs) {
  float m = abs(prevAbs2 - cAbs);
  float M = prevAbs2 + cAbs;
  float span = M - m;
  if (span <= TINY) return -1.0;
  return clamp((nextAbs - m) / span, 0.0, 1.0);
}

// THE KERNEL. Perturbation + rebasing for one pixel offset dc.
// Returns the smooth iteration count, or -1.0 for an interior pixel.
//   zOut  the orbit point at escape            (stripe / triangle / normal)
//   fOut  (dz/dc)*halfWidth at escape          (distance estimate + relief)
//   sOut  the smoothed stripe average in 0..1
//   tOut  the smoothed triangle average in 0..1
float iterate(float2 dc, out float2 zOut, out float2 fOut, out float sOut, out float tOut) {
  float escapeSq = uEscapeRadius * uEscapeRadius;
  float thresholdSq = uInteriorThreshold * uInteriorThreshold;
  float cAbs = length(uCenterApprox + dc);
  int refCount = int(uRefCount);
  float2 d = float2(0.0);
  float2 f = float2(0.0);
  float2 q = float2(1.0, 0.0);
  float2 z = float2(0.0);
  bool multAlive = uInteriorTest > 0.5;
  bool escaped = false;
  bool interior = false;
  float n = 0.0;
  float sumS = 0.0, prevSumS = 0.0, sumT = 0.0, prevSumT = 0.0, avgN = 0.0;
  bool wantStripe = uStripeAmount != 0.0;
  bool wantTriangle = uTriangleAmount != 0.0;
  bool wantAverages = wantStripe || wantTriangle;

  for (int run = 0; run < MAX_RUNS; run++) {
    // Z_0 IS IDENTICALLY ZERO — the Mandelbrot critical orbit starts at the origin
    // and referenceOrbit writes that unconditionally — so the run needs no load to
    // begin, and re-entering this loop IS the rebase's "reference index := 0".
    float2 Z = float2(0.0);
    // The packed row's half for the NEXT point. Flattened point k = i + 1 starts at
    // 1, which is ODD, so the first read is the .zw half of row 0. SkSL has no
    // remainder operator (probed: "operator '%' is not allowed") and a mutable
    // counter cannot index a uniform array at all, so a toggled bool is the parity
    // that survives both rules.
    bool nextIsLowHalf = false;
    for (int i = 0; i < REF_LEN - 1; i++) {
      // ONE row load per iteration, serving BOTH points this step needs: Z_n
      // (carried from the previous step) and Z_{n+1}. The index arithmetic is on
      // the loop INDUCTION VARIABLE, the only thing SkSL lets a uniform array be
      // indexed by (probed: uOrbit[(i + 1) / 2] compiles, uOrbit[m] with a mutable
      // m does not). This is the hottest code in the app.
      float4 pair = uOrbit[(i + 1) / 2];
      float2 Znext = nextIsLowHalf ? pair.xy : pair.zw;
      nextIsLowHalf = !nextIsLowHalf;
      float2 zPrev = Z + d;                         // z_n, the value BEFORE this step
      // derivative FIRST: it uses the OLD z
      f = 2.0 * cmul(zPrev, f) + float2(uHalfWidth, 0.0);
      // The interior certificate is the running product q = prod 2*z_k. It must
      // START AT k = 1: z_0 is identically zero for the Mandelbrot set, so a
      // product including it is zero for every pixel and would certify the whole
      // image as interior.
      if (multAlive && n > 0.0) {
        q = 2.0 * cmul(zPrev, q);
        float qm = dot(q, q);
        if (qm < thresholdSq) { interior = true; break; }
        if (qm > MULT_CEILING) multAlive = false;
      }
      // d' = 2*Z*d + d^2 + dc — BOTH new components from the OLD pair (assigning
      // one then reading it for the other is the classic complex-update bug, and
      // it shows up as a hard straight SEAM across the image).
      d = 2.0 * cmul(Z, d) + cmul(d, d) + dc;
      z = Znext + d;
      Z = Znext;                                    // Z_{n+1} becomes the next step's Z_n
      n += 1.0;
      float zm = dot(z, z);
      if (wantAverages && n > AVERAGE_SKIP) {
        prevSumS = sumS; prevSumT = sumT;
        if (wantStripe) sumS += 0.5 * (sin(uStripeDensity * atan(z.y, z.x)) + 1.0);
        if (wantTriangle) {
          float tt = triangleTerm(dot(zPrev, zPrev), cAbs, sqrt(zm));
          if (tt >= 0.0) sumT += tt;
        }
        avgN += 1.0;
      }
      if (zm > escapeSq) { escaped = true; break; }
      if (n >= uMaxIter) break;
      // REBASE: the delta is no longer the small quantity, or the reference is
      // exhausted. d := z, and re-entering the inner loop IS the index reset.
      if (zm < dot(d, d) || i + 2 >= refCount) { d = z; break; }
    }
    if (escaped || interior || n >= uMaxIter) break;
  }

  zOut = z; fOut = f; sOut = 0.0; tOut = 0.0;
  if (!escaped) return -1.0;
  float logZ = 0.5 * log(max(TINY, dot(z, z)));
  float nu = n - log2(max(TINY, logZ / log(uEscapeRadius)));
  float frac = nu - floor(nu);
  if (avgN > 0.0) {
    float invN = 1.0 / avgN;
    float invPrev = avgN > 1.0 ? 1.0 / (avgN - 1.0) : invN;
    sOut = frac * sumS * invN + (1.0 - frac) * prevSumS * invPrev;
    tOut = frac * sumT * invN + (1.0 - frac) * prevSumT * invPrev;
  }
  return nu;
}

half4 main(float2 fragCoord) {
  float2 pl = rot2(fragCoord - uCenter, -uAngle);
  float boxCov = 1.0 - smoothstep(-EDGE_AA, EDGE_AA, sdRoundRect(pl, uHalfSize, uCornerRadius));
  if (boxCov <= 0.0) return half4(0.0);

  // The fractal window is defined ENTIRELY in the widget's own local frame: uv is
  // the normalized position in the region and uHalfWidth the complex half-width,
  // so the same document renders the same complex points at any camera zoom or
  // output resolution. Only the SAMPLING RATE (and hence the band-limit and the
  // distance-estimate glow, both measured in device px) tracks the device grid,
  // which is what an antialias is supposed to do.
  float2 half2d = max(uHalfSize, float2(1.0));
  float2 uv = pl / half2d;                                  // [-1,1]
  float aspect = half2d.y / half2d.x;
  float2 dc = float2(uv.x, uv.y * aspect) * uHalfWidth;
  float halfWidthPx = half2d.x;

  float2 z, f;
  float stripe, triangle;
  float nu = iterate(dc, z, f, stripe, triangle);

  float3 interiorRgb = uInteriorColor.rgb;
  if (nu < 0.0) {
    float a = boxCov * uInteriorColor.a;
    return half4(half3(encodeSrgb(interiorRgb)) * half(a), half(a));
  }

  float absZ = sqrt(max(TINY, dot(z, z)));
  float absF = sqrt(max(TINY, dot(f, f)));
  float dePixels = 2.0 * absZ * log(absZ) * halfWidthPx / absF;

  // THE COLOUR AXIS. "iteration" is the familiar one; "log iteration" makes the
  // band n..2n one cycle at every depth; "distance" is -log2(DE in pixels), which
  // is identically distributed at 1e-3 and at 1e-300 and therefore needs no
  // per-depth retuning.
  float t = nu / uPaletteScale;
  if (uColorAxis > 1.5) t = -log2(max(TINY, dePixels)) / uPaletteScale;
  else if (uColorAxis > 0.5) t = log2(1.0 + nu) / uPaletteScale;
  float3 rgb = samplePalette(t + uPaletteOffset);

  // ANALYTIC BAND-LIMIT: as one pixel comes to span a whole palette cycle the
  // bands are unresolvable, so fade toward the palette's mean instead of aliasing.
  // The footprint identity is derived for the ITERATION axis; on the log-iteration
  // and screen-distance axes the palette position has a different gradient, so this
  // is an approximation there — conservative (it over-estimates the footprint on a
  // compressed axis, i.e. it fades slightly early) rather than under-filtering.
  if (uBandLimit > 0.5) {
    float footprint = 1.0 / (log(2.0) * max(TINY, dePixels) * max(TINY, uPaletteScale));
    float fade = clamp((footprint - BANDLIMIT_START) / (BANDLIMIT_FULL - BANDLIMIT_START), 0.0, 1.0);
    rgb = mix(rgb, uPaletteMean, fade);
  }

  // SILK + CLOTH: the two orbit averages modulate brightness multiplicatively,
  // centred on 1 so an amount of 0 is exactly a no-op.
  float modulate = (1.0 + uStripeAmount * (2.0 * stripe - 1.0)) * (1.0 + uTriangleAmount * (2.0 * triangle - 1.0));

  // RELIEF: Lambert shading from the ANALYTIC normal u = z/(dz/dc). The halfWidth
  // scaling in f is a positive scalar, so it cancels in the direction.
  float2 u = cmul(z, float2(f.x, -f.y)) / max(TINY, dot(f, f));
  float2 uHat = u / max(TINY, length(u));
  float uDotV = uHat.x * cos(uLightAngle) + uHat.y * sin(uLightAngle);
  float shade = clamp((uDotV + uLightHeight) / (1.0 + uLightHeight), 0.0, 1.0);
  float lit = 1.0 + uShadeAmount * (2.0 * shade - 1.0);

  // GLOW: the boundary, brightened where the distance estimate says the set is
  // within a pixel or so. This is the filament detail point sampling loses.
  float dw = dePixels / max(TINY, uGlowWidth);
  float glow = uGlowAmount * exp(-dw * dw);

  float3 col = rgb * max(0.0, modulate * lit) + glow;
  // BOUNDARY COVERAGE: the distance estimate in pixels is an analytic estimate of
  // how much of this pixel the set covers, so blending toward the interior colour
  // below one pixel antialiases the set's edge with no extra samples.
  //
  // DEFAULT OFF, and that is a measured decision rather than timidity. The Koebe
  // quarter theorem only brackets the true distance within a factor of four from
  // BELOW, so this systematically OVERSTATES the coverage — and the regions where
  // it bites hardest are exactly the dense filament fields, whose true average is a
  // bright mix of set and exterior, not the interior colour. Measured at 320x180 it
  // turned the seahorse-tail preset's cream lace into black lace. The boundary glow
  // (which BRIGHTENS the same band) is the aesthetically right treatment; this stays
  // available for anyone who wants the physical reading instead.
  float coverage = uBoundaryAA > 0.5 ? clamp(dePixels, 0.0, 1.0) : 1.0;
  col = mix(interiorRgb, col, coverage);
  float alpha = boxCov * mix(uInteriorColor.a, 1.0, coverage);
  return half4(half3(encodeSrgb(col)) * half(alpha), half(alpha));
}
`;

// ── CPU side: the arbitrary-precision reference orbit ─────────────────────────

/** log2(10) — decimal digits to bits. */
const BITS_PER_DECIMAL_DIGIT = Math.log2(10);

/**
 * Guard bits beyond the digits the view itself needs. The reference orbit's error
 * grows by roughly one bit per iteration in the worst case (the map doubles the
 * derivative near |Z| = 1), so this must cover the orbit length; 64 covers a
 * 2^64-iteration orbit and costs a few percent of the BigInt time.
 */
const GUARD_BITS = 64;

/**
 * Decimal places kept for the COARSE part of a split centre, BEYOND the fine
 * part's exponent. This single number sets how deep the widget can go, and the
 * reasoning is worth spelling out because it is easy to get backwards.
 *
 * `coarse.toFixed(d)` is EXACT, but a float64's true value is a dyadic rational
 * whose decimal expansion runs to hundreds of places, so truncating it at `d`
 * places introduces an absolute error of about 10^(-d). The fine part supplies
 * digits down to about 10^(-fineExponent-17) (a float64 fine value carries ~17
 * significant digits). For the coarse truncation not to swamp the fine part,
 * `d` must therefore exceed `fineExponent + 17` — which is exactly what
 * `fineExponent + 18` does, with one decimal to spare.
 *
 * The consequence to remember: at fineExponent 0 the centre resolves to about
 * 1e-18, so a zoom past that needs a NON-ZERO fine exponent. centreResolutionDecades
 * states that bound and the plugin reports it out loud.
 */
const COARSE_DECIMALS = 18;

/**
 * Pure function. Decades of the complex plane the split centre can resolve at a
 * given fine exponent — i.e. the deepest `zoomExponent` that still lands on the
 * intended point rather than on a quantized neighbour.
 *
 * @param {number} fineExponent - the widget's fineExponent (non-negative integer)
 * @returns {number} decades
 *
 * @example centreResolutionDecades(0)  // 17  (a plain float64 pair: about 1e-17)
 * @example centreResolutionDecades(16) // 33  (the recommended deep-zoom setting)
 * @example centreResolutionDecades(80) // 97  (the deepest the split can express)
 */
export function centreResolutionDecades(fineExponent) {
  return Math.max(0, Math.round(fineExponent)) + COARSE_DECIMALS - 1;
}

/** `Number.prototype.toFixed` is specified only to 100 fractional digits, which
 *  caps how far a split centre can reach. Past this the widget must be told
 *  LOUDLY rather than silently rendering the wrong location. */
const MAX_TO_FIXED_DECIMALS = 100;

/** The BigInt escape test compares |Z|^2 against this, in fixed point. */
const REFERENCE_ESCAPE_RADIUS_SQUARED = 4;

/**
 * Pure function. Fractional bits needed to resolve a view of half-width
 * 10^(-depthDecades), with GUARD_BITS of headroom.
 *
 * @param {number} depthDecades - the zoom depth in decades (a 1e-100 view is 100)
 * @returns {number} fractional bits
 *
 * @example bitsForDepth(0)   // 64  (guard bits only — a whole-set view)
 * @example bitsForDepth(15)  // 114 (about where float64 gives out)
 * @example bitsForDepth(100) // 397
 */
export function bitsForDepth(depthDecades) {
  return Math.ceil(Math.max(0, depthDecades) * BITS_PER_DECIMAL_DIGIT) + GUARD_BITS;
}

/**
 * Largest magnitude `toFixed` renders in PLAIN decimal. At 1e21 and above it
 * silently switches to EXPONENTIAL notation ((1e21).toFixed(2) === "1e+21",
 * while (1e20).toFixed(2) === "100000000000000000000.00"), and `BigInt` cannot
 * parse an exponent — so the digit-splicing below would hand it "1e+21" and it
 * would throw a bare SyntaxError from deep inside a render. This is a TECHNICAL
 * limit of the language's own formatter, not a taste cap on how far one may zoom:
 * a Mandelbrot centre lives in |c| < 2, so no legitimate coordinate is remotely
 * near it, and anything that is has already gone wrong upstream.
 */
const MAX_TO_FIXED_PLAIN = 1e21;

/**
 * Pure function. A finite number as an EXACT BigInt numerator over 10^decimals.
 * This is the only place a float64 coordinate becomes a long number, and it is
 * exact because `toFixed` is exact for the decimal places it accepts.
 *
 * REJECTS a magnitude `toFixed` would render in exponential notation. That was a
 * real crash: a fine-slot overflow produced a centre of ~1.9e84, `toFixed` handed
 * back "1.8967841688652096e+84", `BigInt` threw "Cannot convert
 * 18967841688652096e+68 to a BigInt", and because the throw happened inside
 * CanvasView's render $effect it tore down the Svelte reactive root and froze the
 * whole editor. The guard turns that into a named precondition failure naming the
 * culprit, which is diagnosable; fixing the overflow at its source is separate.
 *
 * @param {number} v - a finite number with |v| < 1e21
 * @param {number} decimals - fractional decimal places (0..100)
 * @returns {bigint} round(v * 10^decimals)
 *
 * @example scaledDecimal(0.5, 3) // 500n
 * @example scaledDecimal(-2, 2) // -200n
 * @example scaledDecimal(0.1234, 2) // 12n  (rounded, as toFixed rounds)
 * @example // scaledDecimal(1e21, 2) throws: toFixed would return "1e+21", which BigInt cannot parse
 */
export function scaledDecimal(v, decimals) {
  if (!Number.isFinite(v)) throw new Error(`scaledDecimal: expected a finite number, got ${v}`);
  if (Math.abs(v) >= MAX_TO_FIXED_PLAIN)
    throw new Error(`scaledDecimal: |${v}| is at or above ${MAX_TO_FIXED_PLAIN}, where toFixed switches to exponential notation and BigInt cannot parse the result. A Mandelbrot coordinate lives in |c| < 2, so this value overflowed upstream — check the split centre (centerX/centerFineX/fineExponent).`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TO_FIXED_DECIMALS)
    throw new Error(`scaledDecimal: decimals must be an integer in 0..${MAX_TO_FIXED_DECIMALS}, got ${decimals}`);
  const s = v.toFixed(decimals);
  const neg = s.startsWith("-");
  const [ip, fp = ""] = (neg ? s.slice(1) : s).split(".");
  return (neg ? -1n : 1n) * BigInt(ip + fp.padEnd(decimals, "0"));
}

/**
 * Pure function. THE SPLIT CENTRE, resolved to fixed point. A deep-zoom centre
 * needs far more digits than a float64 holds, but every property must stay a
 * plain NUMBER so it keeps and tweens keyframes and accepts `=` equations. So the
 * coordinate is carried as `coarse + fine·10^(-fineExponent)` and summed HERE, in
 * exact decimal arithmetic, before being rounded once onto the 2^(-bits) grid.
 * Two float64s at a chosen exponent give about 32 significant digits.
 *
 * @param {number} coarse - the leading digits
 * @param {number} fine - the fine offset, in units of 10^(-fineExponent)
 * @param {number} fineExponent - a non-negative integer; 0 disables the fine part
 * @param {number} bits - fractional bits of the fixed-point result
 * @returns {bigint} the fixed-point numerator (value = result / 2^bits)
 *
 * @example splitCentreFixed(0.5, 0, 0, 8) // 128n
 * @example splitCentreFixed(-2, 0, 0, 8) // -512n
 * @example splitCentreFixed(0.5, 5, 1, 8) // 256n  (0.5 + 5e-1 = 1)
 */
export function splitCentreFixed(coarse, fine, fineExponent, bits) {
  if (!Number.isInteger(fineExponent) || fineExponent < 0)
    throw new Error(`splitCentreFixed: fineExponent must be a non-negative integer, got ${fineExponent}`);
  const decimals = fineExponent + COARSE_DECIMALS;
  if (decimals > MAX_TO_FIXED_DECIMALS)
    throw new Error(`splitCentreFixed: fineExponent ${fineExponent} needs ${decimals} decimal places, beyond the ${MAX_TO_FIXED_DECIMALS} this split can represent — the centre cannot be expressed that deep with two plain numbers.`);
  const scaled = scaledDecimal(coarse, decimals) + (fine === 0 ? 0n : scaledDecimal(fine, COARSE_DECIMALS));
  // scaled / 10^decimals, rounded onto the 2^-bits grid (round half away from zero)
  const scale10 = 10n ** BigInt(decimals);
  const neg = scaled < 0n;
  const a = (neg ? -scaled : scaled) << BigInt(bits);
  const q = a / scale10;
  const rounded = (a % scale10) * 2n >= scale10 ? q + 1n : q;
  return neg ? -rounded : rounded;
}

/**
 * Pure function. A fixed-point BigInt as the nearest float64. Exact for every
 * reference-orbit point (|Z| ≤ 2, and only the leading 53 bits reach the float).
 *
 * @param {bigint} n - the fixed-point numerator
 * @param {number} bits - fractional bits
 * @returns {number}
 *
 * @example fixedToFloat(128n, 8) // 0.5
 * @example fixedToFloat(-512n, 8) // -2
 */
export function fixedToFloat(n, bits) {
  // Number(n) overflows for large `bits`, so strip all but the top 64 bits and
  // re-apply the discarded scale with a power of two (exact in binary floating
  // point, since |Z| ≤ 2 keeps the exponent in range).
  const KEEP_BITS = 64;
  const neg = n < 0n;
  const a = neg ? -n : n;
  const width = a === 0n ? 0 : a.toString(2).length;
  const drop = Math.max(0, width - KEEP_BITS);
  const v = Number(a >> BigInt(drop)) * Math.pow(2, drop - bits);
  return neg ? -v : v;
}

/**
 * Query (allocates one Float32Array). THE REFERENCE ORBIT: iterates
 * Z' = Z^2 + C in BigInt fixed point from Z_0 = 0 and stores each point
 * DOWN-CONVERTED to fp32, interleaved as [re, im, re, im, ...] — the layout the
 * shader's `uniform float2 uOrbit[]` expects. This is the ONLY long-number work in
 * the whole widget and it runs once per (centre, zoom).
 *
 * Stops early if the reference itself escapes (|Z|^2 > 4). `count` says how many
 * entries are valid; the shader rebases when it reaches that boundary, so a short
 * orbit is correct, merely less efficient.
 *
 * @param {bigint} cr - the reference point's real part, fixed point
 * @param {bigint} ci - the reference point's imaginary part, fixed point
 * @param {number} bits - fractional bits of cr/ci
 * @param {number} length - array length (MANDELBROT_REF_LEN)
 * @returns {{orbit: Float32Array, count: number, escaped: boolean}}
 *
 * @example referenceOrbit(0n, 0n, 32, 3) // {orbit: Float32Array [0,0,0,0,0,0], count: 3, escaped: false}  (C = 0: the orbit is identically zero)
 * @example referenceOrbit(1n << 32n, 0n, 32, 4).escaped // true  (C = 1 escapes)
 */
export function referenceOrbit(cr, ci, bits, length) {
  if (!Number.isInteger(length) || length < 2)
    throw new Error(`referenceOrbit: length must be an integer ≥ 2 (rebasing needs Z_0 and Z_1), got ${length}`);
  const orbit = new Float32Array(length * 2);
  const F = BigInt(bits);
  const escapeSq = BigInt(REFERENCE_ESCAPE_RADIUS_SQUARED) << F;
  let r = 0n, i = 0n, n = 0, escaped = false;
  for (; n < length; n++) {
    orbit[n * 2] = fixedToFloat(r, bits);
    orbit[n * 2 + 1] = fixedToFloat(i, bits);
    const rr = (r * r) >> F;
    const ii = (i * i) >> F;
    if (rr + ii > escapeSq) { escaped = true; n++; break; }
    const cross = (r * i) >> F;
    const nr = rr - ii + cr;
    i = 2n * cross + ci;
    r = nr;
  }
  return { orbit, count: n, escaped };
}

// ── CPU side: the OKLab palette bake ─────────────────────────────────────────

/**
 * Pure function. Linear sRGB to OKLab (Björn Ottosson, 2020). Interpolating a
 * palette in OKLab rather than sRGB is what stops a blue-to-orange ramp passing
 * through mud: OKLab is perceptually uniform, so a straight line in it is a
 * straight line to the eye.
 *
 * @param {number} r - linear sRGB red, 0..1
 * @param {number} g - linear sRGB green, 0..1
 * @param {number} b - linear sRGB blue, 0..1
 * @returns {[number, number, number]} [L, a, b]
 *
 * @example linearSrgbToOklab(1, 1, 1).map((v) => +v.toFixed(4)) // [1, 0, 0]
 * @example linearSrgbToOklab(0, 0, 0) // [0, 0, 0]
 */
export function linearSrgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/**
 * Pure function. OKLab back to linear sRGB — Ottosson's published inverse.
 *
 * @param {number} L - OKLab lightness
 * @param {number} a - OKLab green/red axis
 * @param {number} b - OKLab blue/yellow axis
 * @returns {[number, number, number]} linear sRGB (may leave the gamut; clamped downstream)
 *
 * @example oklabToLinearSrgb(1, 0, 0).map((v) => +v.toFixed(4)) // [1, 1, 1]
 * @example oklabToLinearSrgb(0, 0, 0) // [0, 0, 0]
 */
export function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** The sRGB transfer function's constants (IEC 61966-2-1) — the CPU twin of the
 *  shader's encodeSrgb, used here only in the DECODE direction. */
const SRGB_LINEAR_CUTOFF = 0.0031308;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_GAMMA_SCALE = 1.055;
const SRGB_GAMMA_OFFSET = 0.055;

/**
 * Pure function. Gamma-encoded sRGB to linear light — what a hex colour must pass
 * through before it can be interpolated perceptually.
 *
 * @param {number} v - encoded 0..1
 * @returns {number} linear light 0..1
 *
 * @example srgbToLinear(1) // 1
 * @example +srgbToLinear(0.7354).toFixed(4) // 0.5
 */
export function srgbToLinear(v) {
  const c = Math.min(1, Math.max(0, v));
  return c <= SRGB_LINEAR_CUTOFF * SRGB_LINEAR_SLOPE
    ? c / SRGB_LINEAR_SLOPE
    : Math.pow((c + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_SCALE, 2.4);
}

/**
 * Pure function. Bakes a list of colour stops into the shader's CYCLIC LINEAR
 * palette: MANDELBROT_PALETTE_STOPS entries interpolated in OKLab, with the last
 * stop blending back into the first so the palette tiles along the colour axis
 * with no seam. Also returns the palette MEAN, which is what a fully
 * band-limited (one-cycle-per-pixel) region must converge to.
 *
 * @param {string[]} stops - colour strings (anything parseColor accepts), in order
 * @returns {{palette: number[], mean: [number, number, number]}} palette is 3·N linear values
 *
 * @example bakeMandelbrotPalette(["#000000", "#ffffff"]).palette.length // 96
 * @example bakeMandelbrotPalette(["#000000", "#000000"]).mean // [0, 0, 0]
 * @example bakeMandelbrotPalette(["#ffffff", "#ffffff"]).palette[0] // 1
 */
export function bakeMandelbrotPalette(stops) {
  if (!Array.isArray(stops) || stops.length < 2)
    throw new Error(`bakeMandelbrotPalette: need at least 2 stops, got ${JSON.stringify(stops)}`);
  const lab = stops.map((s) => {
    const c = parseColor(s);
    return linearSrgbToOklab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]));
  });
  const palette = new Array(MANDELBROT_PALETTE_STOPS * 3);
  const acc = [0, 0, 0];
  for (let i = 0; i < MANDELBROT_PALETTE_STOPS; i++) {
    const x = (i / MANDELBROT_PALETTE_STOPS) * stops.length;
    const i0 = Math.floor(x) % stops.length;
    const i1 = (i0 + 1) % stops.length;
    const f = x - Math.floor(x);
    const rgb = oklabToLinearSrgb(
      lab[i0][0] + (lab[i1][0] - lab[i0][0]) * f,
      lab[i0][1] + (lab[i1][1] - lab[i0][1]) * f,
      lab[i0][2] + (lab[i1][2] - lab[i0][2]) * f,
    );
    for (let k = 0; k < 3; k++) {
      const v = Math.min(1, Math.max(0, rgb[k]));
      palette[i * 3 + k] = v;
      acc[k] += v;
    }
  }
  return { palette, mean: [acc[0] / MANDELBROT_PALETTE_STOPS, acc[1] / MANDELBROT_PALETTE_STOPS, acc[2] / MANDELBROT_PALETTE_STOPS] };
}

// ── the uniform packer ────────────────────────────────────────────────────────

function num(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`mandelbrot pack: "${name}" must be a finite number, got ${v}`);
  return v;
}

/** Query. A params array of exactly `length` finite numbers, or a LOUD error. */
function floats(name, v, length) {
  if (!Array.isArray(v) && !(v instanceof Float32Array)) throw new Error(`mandelbrot pack: "${name}" must be an array, got ${typeof v}`);
  if (v.length !== length) throw new Error(`mandelbrot pack: "${name}" must hold ${length} floats, got ${v.length}`);
  return v;
}

/**
 * Pure function. Packs the mandelbrot uniforms in SkSL declaration order.
 * `u` carries the framework's device-space region geometry plus the plugin's
 * params — including `orbit` (2·MANDELBROT_REF_LEN interleaved fp32 values from
 * referenceOrbit) and `palette`/`paletteMean` (from bakeMandelbrotPalette).
 *
 * @param {object} u - geometry {cx, cy, halfW, halfH, cornerRadius, angle} + the op params
 * @returns {Float32Array} length MANDELBROT_UNIFORM_FLOATS
 *
 * @example packMandelbrot({cx: 0, cy: 0, halfW: 100, halfH: 100, cornerRadius: 0, angle: 0,
 *   centerApproxX: -0.5, centerApproxY: 0, halfWidth: 1, maxIter: 100, refCount: 512,
 *   escapeRadius: 256, interiorTest: 1, interiorThreshold: 1e-3, colorAxis: 0,
 *   paletteScale: 16, paletteOffset: 0, stripeAmount: 0, stripeDensity: 4,
 *   triangleAmount: 0, shadeAmount: 0, lightAngle: 0, lightHeight: 1.5,
 *   glowAmount: 0, glowWidth: 1, bandLimit: 1, boundaryAA: 1, interiorColor: "#000000",
 *   palette: new Array(96).fill(0), paletteMean: [0, 0, 0],
 *   orbit: new Float32Array(1024)}).length // 1154
 */
export function packMandelbrot(u) {
  const interior = parseColor(u.interiorColor);
  const out = new Float32Array([
    num("cx", u.cx), num("cy", u.cy), num("halfW", u.halfW), num("halfH", u.halfH),
    num("cornerRadius", u.cornerRadius), num("angle", u.angle),
    num("centerApproxX", u.centerApproxX), num("centerApproxY", u.centerApproxY),
    num("halfWidth", u.halfWidth),
    num("maxIter", u.maxIter), num("refCount", u.refCount), num("escapeRadius", u.escapeRadius),
    num("interiorTest", u.interiorTest), num("interiorThreshold", u.interiorThreshold),
    num("colorAxis", u.colorAxis),
    num("paletteScale", u.paletteScale), num("paletteOffset", u.paletteOffset),
    num("stripeAmount", u.stripeAmount), num("stripeDensity", u.stripeDensity),
    num("triangleAmount", u.triangleAmount),
    num("shadeAmount", u.shadeAmount), num("lightAngle", u.lightAngle), num("lightHeight", u.lightHeight),
    num("glowAmount", u.glowAmount), num("glowWidth", u.glowWidth),
    num("bandLimit", u.bandLimit), num("boundaryAA", u.boundaryAA),
    srgbToLinear(interior[0]), srgbToLinear(interior[1]), srgbToLinear(interior[2]), interior[3],
    ...floats("paletteMean", u.paletteMean, 3),
    ...floats("palette", u.palette, MANDELBROT_PALETTE_STOPS * 3),
    ...floats("orbit", u.orbit, MANDELBROT_REF_LEN * 2),
  ]);
  if (out.length !== MANDELBROT_UNIFORM_FLOATS) throw new Error(`packMandelbrot: ${out.length} floats, expected ${MANDELBROT_UNIFORM_FLOATS}`);
  return out;
}

// ── PROXY stand-in (thumbnail / minimap quality) ──────────────────────────────
// This is the HEAVIEST material in the app by a wide margin: hundreds to thousands
// of iterations PER PIXEL, and on the software raster surface (thumbnails, minimap,
// PNG export, PDF raster, the headless CLI) an iteration costs about a microsecond
// per pixel. At thumbnail size that is tens of seconds of detail nobody can read at
// ~100 px. The proxy is a RADIAL gradient reading the baked palette at three
// positions — bright rim, mid-tone, interior colour at the centre — so a thumbnail
// says "a fractal in these colours is here" for the cost of one Skia gradient.
const PROXY_MID_STOP = 0.55;         // radial stop where the palette mid-tone sits
const PROXY_RIM_PALETTE_T = 0.15;    // palette position sampled for the outer rim
const PROXY_MID_PALETTE_T = 0.5;     // palette position sampled for the mid-tone
const PROXY_ALPHA = 1;               // opaque: a foreground material occupies its region

/** Pure function. Linear light to gamma-encoded sRGB — the CPU twin of the
 *  shader's encodeSrgb, needed because a proxy gradient's stops are ORDINARY
 *  Skia colours (already display-encoded), not the shader's linear working space.
 *  @example linearToSrgb(0) // 0
 *  @example +linearToSrgb(0.5).toFixed(4) // 0.7354 */
function linearToSrgb(v) {
  const c = Math.min(1, Math.max(0, v));
  return c <= SRGB_LINEAR_CUTOFF ? SRGB_LINEAR_SLOPE * c : SRGB_GAMMA_SCALE * Math.pow(c, 1 / 2.4) - SRGB_GAMMA_OFFSET;
}

/** Query. The baked palette sampled at cyclic position `t`, display-encoded. */
function proxyPaletteColor(palette, t) {
  const n = Math.floor(palette.length / 3);
  const i = ((Math.round(t * n) % n) + n) % n;
  return [linearToSrgb(palette[i * 3]), linearToSrgb(palette[i * 3 + 1]), linearToSrgb(palette[i * 3 + 2]), PROXY_ALPHA];
}

/**
 * Pure function. The mandelbrot PROXY stand-in spec: a radial gradient from the
 * interior colour at the centre out through a palette mid-tone to a palette rim
 * tone, so a thumbnail reads as "a fractal in these colours" with no iteration at
 * all. Coordinates are the region's LOCAL space (paint_skia.js applies the
 * view+world transform); colours are display-encoded [r,g,b,a] in 0..1.
 *
 * @param {object} params - the op params ({palette, interiorColor, ...})
 * @param {{cx: number, cy: number, halfW: number, halfH: number}} region - local-space geometry
 * @returns {{kind: "radial", cx: number, cy: number, radius: number, stops: Array<{offset: number, color: number[]}>}}
 *
 * @example mandelbrotProxyFill({palette: new Array(96).fill(1), interiorColor: "#000000"}, {cx: 100, cy: 80, halfW: 100, halfH: 80}).kind // "radial"
 * @example mandelbrotProxyFill({palette: new Array(96).fill(1), interiorColor: "#000000"}, {cx: 100, cy: 80, halfW: 100, halfH: 80}).stops.length // 3
 * @example mandelbrotProxyFill({palette: new Array(96).fill(0), interiorColor: "#ffffff"}, {cx: 0, cy: 0, halfW: 10, halfH: 10}).stops[0].color // [1, 1, 1, 1]
 */
export function mandelbrotProxyFill(params, region) {
  const palette = params.palette ?? new Array(MANDELBROT_PALETTE_STOPS * 3).fill(0.5);
  const inside = parseColor(params.interiorColor ?? "#000000");
  return {
    kind: "radial",
    cx: region.cx, cy: region.cy,
    radius: Math.hypot(region.halfW, region.halfH),
    stops: [
      { offset: 0, color: [inside[0], inside[1], inside[2], PROXY_ALPHA] },
      { offset: PROXY_MID_STOP, color: proxyPaletteColor(palette, PROXY_MID_PALETTE_T) },
      { offset: 1, color: proxyPaletteColor(palette, PROXY_RIM_PALETTE_T) },
    ],
  };
}

/** FOREGROUND, GENERATIVE material: `backdrop: false` binds NO children and skips
 *  the below-content re-render — handleMaterialFill just makeShader+fill.
 *  `proxyFill` keeps the thumbnail/minimap path off the per-pixel iteration.
 *
 *  `uniformRows` DECLARES what the compiled program costs the GL driver, because
 *  this material is the one whose cost can exceed a device's capability, and a
 *  driver that refuses the program drops the draw with NO error reaching JS (see
 *  MANDELBROT_UNIFORM_ROW_BUDGET — the shipped value spends about half the 95th
 *  percentile, but WebGL2's SPEC minimum is 224). Declaring it is what lets the
 *  framework compare it against the live MAX_FRAGMENT_UNIFORM_VECTORS and report a
 *  loud, explained failure instead of a blank rectangle; nothing in this file can
 *  see the GL context, and nothing in it may, because appearance must not depend on
 *  the machine. */
export const MANDELBROT_MATERIAL = {
  id: "mandelbrot",
  sksl: MANDELBROT_SKSL,
  pack: packMandelbrot,
  uniformFloats: MANDELBROT_UNIFORM_FLOATS,
  uniformRows: MANDELBROT_UNIFORM_ROWS,
  backdrop: false,
  proxyFill: mandelbrotProxyFill,
};
