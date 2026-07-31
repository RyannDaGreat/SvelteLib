/**
 * RAINY WINDOW — rain running down glass, as a plugin ASSET.
 *
 * The one departure from a straight pass-through is THE CLOCK. rainyWindowUniformParams
 * calls particleTime() for its `time` uniform, which a DATA-ONLY plugin cannot do, so
 * the uniform declares `fromClock: true` and the framework supplies it at pack time.
 * That keeps the material RECORDABLE state (CLAUDE.md's taxonomy) rather than ephemeral:
 * particleTime is the ONE seamed clock — frozen in the editor, overridden per frame by
 * both exporters — so Δt = 0 still yields a byte-identical frame, and the plugin has no
 * route to any other clock.
 *
 * `animated: true` is carried through so the presenter keeps a repaint loop alive
 * (materials.paintIsAnimated); tint packs as THREE floats (rgb, alpha dropped).
 *
 * GENERATED from the shipped module by scratchpad/gen_materials.mjs — the SkSL and the
 * knob schema are copied, never retyped, so they are byte-identical by construction.
 * COPY THIS FILE to start a new material: the Explorer's built-in tiles offer
 * "Save a Copy", which rewrites the id so the copy registers beside this one.
 */

return {
  "kind": "material",

  "id": "rainy_window",

  "title": "Rainy Window",

  "params": [
    {
      "name": "rain",
      "kind": "number",
      "default": 0.8,
      "min": 0,
      "max": 1,
      "help": "Rain AMOUNT (0..1): how much water is on the glass. Drives drop density/rate — low = a fine mist of static beads, high = heavy running drops with trails."
    },
    {
      "name": "fog",
      "kind": "number",
      "default": 0.5,
      "min": 0,
      "max": 1,
      "help": "Fog / steam amount (0..1): how steamed-up the dry pane is (a blurred, lifted, desaturated view). Running drops and trails wipe the fog clear."
    },
    {
      "name": "speed",
      "kind": "number",
      "default": 1,
      "min": 0,
      "scrub": 0.01,
      "help": "Fall-speed multiplier for the running drops. 0 = a frozen still; higher = faster running rain."
    },
    {
      "name": "dropSize",
      "kind": "number",
      "default": 1,
      "min": 0.1,
      "help": "Overall drop-size multiplier — scales both the running-drop heads and the static beads."
    },
    {
      "name": "columns",
      "kind": "number",
      "default": 6,
      "min": 1,
      "help": "Number of running-drop columns across the width — the density granularity. More = finer, more-numerous streaks."
    },
    {
      "name": "streakiness",
      "kind": "number",
      "default": 1,
      "min": 0,
      "scrub": 0.01,
      "help": "Trail LENGTH / persistence behind each running drop's head: how far up the fading refractive streak survives. Low = drops with barely a tail; high = long, slow-fading dribble streaks. NO UPPER CAP — the SkSL divides the fade exponent by max(streakiness, EPS) and the trail stays within [0,1] at any value, so a huge number just gives an ever-longer trail and 0 gives none."
    },
    {
      "name": "refraction",
      "kind": "number",
      "default": 0.06,
      "min": 0,
      "help": "Droplet refraction strength, as a fraction of the widget's short half-size: how strongly each drop bends the background behind it (the lens). 0 = flat wet patches."
    },
    {
      "name": "shine",
      "kind": "number",
      "default": 0.9,
      "min": 0,
      "help": "Droplet SHININESS — the strength of the specular glint + fresnel rim on each drop's curved surface. 0 = matte water."
    },
    {
      "name": "lightAngle",
      "kind": "angle",
      "display": "degrees",
      "default": -1.8849555921538759,
      "help": "Direction TO the light (screen space; -90° = straight above, 0° = from the right). Sets where the specular glints sit on each drop."
    },
    {
      "name": "tint",
      "kind": "color",
      "default": "#dfe8f0",
      "help": "The fog/steam colour cast — the tone the steamed-up glass is pulled toward (a cool near-white reads as cold-window condensation)."
    },
    {
      "name": "blurRadius",
      "kind": "number",
      "default": 8,
      "min": 0,
      "help": "Gaussian blur radius (world px) of the fog/steam source — how soft the steamed-up glass is.",
      "omit": true
    },
    {
      "name": "backdropScale",
      "kind": "number",
      "default": 1,
      "min": 0.25,
      "max": 2,
      "help": "RESOLUTION FACTOR the content beneath is re-rendered at for the distortion: 1 = screen resolution, 2 = supersample (crisper, slower), 0.5 = half res (faster, softer). The 0.25..2 bounds are a PERFORMANCE guard, not a look choice — below 0.25 the backdrop is uselessly coarse and above 2 the re-render cost balloons.",
      "omit": true
    }
  ],

  "uniforms": [
    {
      "name": "cx",
      "size": 1
    },
    {
      "name": "cy",
      "size": 1
    },
    {
      "name": "halfW",
      "size": 1
    },
    {
      "name": "halfH",
      "size": 1
    },
    {
      "name": "cornerRadius",
      "size": 1
    },
    {
      "name": "angle",
      "size": 1
    },
    {
      "name": "time",
      "size": 1,
      "fromClock": true
    },
    {
      "name": "speed",
      "size": 1
    },
    {
      "name": "rain",
      "size": 1
    },
    {
      "name": "fog",
      "size": 1
    },
    {
      "name": "refraction",
      "size": 1
    },
    {
      "name": "shine",
      "size": 1
    },
    {
      "name": "dropSize",
      "size": 1
    },
    {
      "name": "columns",
      "size": 1
    },
    {
      "name": "streakiness",
      "size": 1
    },
    {
      "name": "lightAngle",
      "size": 1
    },
    {
      "name": "tint",
      "size": 3
    }
  ],

  "animated": true,

  "sksl": "\n// ── structural constants (WHY each; only the CHARACTER knobs are uniforms) ────\nconst float AA_PX        = 1.0;    // rounded-rect coverage antialias half-width (device px)\nconst float TWO_PI       = 6.28318530718;\nconst half3  REC709      = half3(0.2126, 0.7152, 0.0722); // luma weights (fog desaturation)\nconst float EPS          = 1e-4;   // guards divide-by-zero on degenerate knobs\n\n// hash mixing constants (Dave Hoskins fract-hash family — backend-stable, sin-free)\nconst float H1_MUL = 0.1031;\nconst float H1_ADD = 33.33;\nconst float3 H3_MUL = float3(0.1031, 0.1030, 0.0973);\nconst float H3_ADD = 33.33;\n\n// ── runner-drop layer geometry ────────────────────────────────────────────────\n// Cells are TALLER than wide (screen w/h < 1) so a drop has vertical room to run\n// and streak. rows are derived from cols so cells keep this shape at any aspect.\nconst float CELL_WH      = 0.55;   // a runner cell's screen width/height (<1 ⇒ tall)\nconst float FALL_BASE    = 0.18;   // base drop cycles/sec (at speed 1, rate 1) — one top→bottom run per ~1/this sec\nconst float RUN_SPEED_LO = 0.60;   // per-drop fall-rate spread LO … (hashed; faster drops catch slower → merges)\nconst float RUN_SPEED_HI = 1.55;   //   … HI (so columns never fall in lockstep)\nconst float DROP_FADE_IN = 0.12;   // fraction of the cycle the head fades IN over (hides the top wrap)\nconst float DROP_FADE_OUT= 0.24;   // fraction it fades OUT over near the bottom (drop lingers then leaves)\nconst float DROP_GROW_LO = 0.55;   // head size at the START of a run …\nconst float DROP_GROW_HI = 1.15;   //   … and near the END (the drop accretes water as it slides)\nconst float HEAD_R       = 0.26;   // head blob radius (cell-WIDTH units; ×grow×dropSize)\nconst float HEAD_H       = 1.0;    // head contribution to the height field (the fattest, brightest lens)\nconst float X_SPREAD     = 0.5;    // how far (cell widths) a head sits off the column centre (±X_SPREAD/2)\nconst float WIGGLE_FREQ  = 5.0;    // spatial frequency of the snaking drop path\nconst float WIGGLE_AMP   = 0.06;   // amplitude of the snake (cell widths)\nconst float TRAIL_W      = 0.06;   // trail half-width at the head (cell-width units)\nconst float TRAIL_TAPER  = 0.35;   // trail width fraction remaining at the top of the wake (narrows upward)\nconst float TRAIL_H      = 0.55;   // trail contribution to the height field (thinner/shallower than the head)\nconst float TRAIL_FADE_EXP = 1.6;  // base streak fade exponent (divided by uStreakiness: bigger streakiness ⇒ longer streak)\nconst float TRAIL_BEADS  = 5.0;    // residual-bead slots per cell height along a trail\nconst float BEAD_R       = 0.05;   // residual-bead radius (cell-width units)\n\n// the SECOND runner layer (a smaller, faster, sparser sheet for depth)\nconst float RUN2_SCALE   = 1.6;    // finer grid (more/smaller drops)\nconst float RUN2_SPEED   = 1.35;   // falls faster\nconst float RUN2_SIZE    = 0.70;   // smaller drops\nconst float RUN2_SALT    = 137.0;  // hash offset so the two layers never coincide\n\n// ── static-bead (condensation) layer ──────────────────────────────────────────\nconst float STATIC_DENS  = 17.0;   // grid cells across the SHORT axis (square cells via aspect)\nconst float STATIC_WANDER= 0.80;   // random bead offset within its cell (3×3 sampling keeps it seamless)\nconst float STATIC_R     = 0.10;   // static-bead radius (cell units)\nconst float STATIC_RATE  = 0.25;   // fade-cycle rate (Hz at speed 1)\nconst float STATIC_H     = 0.5;    // static-bead contribution to the height field\nconst float STATIC_FADE_PEAK = 0.5;// saw() peak (fade in→out) of a static bead's life\nconst float STATIC_PRESENT = 0.4;  // rnd.z threshold — ~60% of cells ever host a bead\n\n// rain-amount → per-layer weight ramps (Heartfelt's l0/l1/l2, our thresholds)\nconst float STATIC_ON_HI = 0.35;  // static beads fully present by this rain amount\nconst float RUN1_ON_LO   = 0.10;  // layer-1 runner drops start appearing here …\nconst float RUN1_ON_HI   = 0.75;  //   … and are full here\nconst float RUN2_ON_LO   = 0.45;  // layer-2 (the extra sheet) fades in later\nconst float RUN2_ON_HI   = 1.0;\nconst float RUN_PRESENCE_LO = 0.35; // fraction of runner cells that host a drop at rain=0 …\nconst float RUN_PRESENCE_HI = 0.95; //   … and at rain=1 (density grows with rain)\n\n// refraction / fog / specular shaping\nconst float GRAD_EPS = 1.6;   // finite-difference step for the height gradient (device px)\nconst float BUMP     = 12.0;  // slope gain: how steep the droplet surface reads (bigger = stronger lens)\nconst float WET_LO   = 0.02;  // height at which a pixel starts counting as WET (clears fog, refracts) …\nconst float WET_HI   = 0.22;  //   … and is fully wet\nconst float FOG_DESAT= 0.55;  // how grey the steam gets (0 keeps colour, 1 fully grey)\nconst float FOG_TINT = 0.25;  // how much the fog is pulled toward the tint colour\nconst float FOG_LIFT = 0.06;  // brightness the steam adds (a foggy pane is lighter)\nconst float LIGHT_Z  = 0.7;   // z-height of the light for the droplet specular\nconst float SPEC_POWER = 28.0;// specular lobe tightness (bigger = tighter glint)\nconst float RIM_POWER  = 2.4; // fresnel rim falloff on the droplet edge\nconst float RIM_GAIN   = 0.7; // weight of the rim sparkle vs the specular glint (the bright wet edge on each bead)\n\n// ── framework-set geometry (device px) + time — NOT user knobs ────────────────\nuniform shader blurredBackdrop;  // child 0: Gaussian-blurred composite-so-far — the FOG / steam source\nuniform shader sharpBackdrop;    // child 1: the un-blurred composite-so-far — the crisp refracted view\nuniform float2 uCenter;          // widget centre (device px)\nuniform float2 uHalfSize;        // widget half-extents (device px)\nuniform float  uCornerRadius;    // rounded-rect radius (device px)\nuniform float  uAngle;           // widget world rotation (radians) — rain runs down the LOCAL frame\nuniform float  uTime;            // animation time (seconds) — frozen in editor/CLI, wall clock in presenter\n// ── user-tweakable knobs (self.* custom props) ────────────────────────────────\nuniform float  uSpeed;           // fall-speed multiplier (0 = frozen)\nuniform float  uRain;            // rain AMOUNT (0..1): drives drop density + which layers are active\nuniform float  uFog;             // fog / steam amount (0 = clear pane, 1 = fully steamed)\nuniform float  uRefraction;      // droplet refraction strength (fraction of the widget's short half-size)\nuniform float  uShine;           // droplet SHININESS (specular + rim sparkle strength)\nuniform float  uDropSize;        // overall drop-size multiplier\nuniform float  uColumns;         // number of runner-drop columns across the width (density granularity)\nuniform float  uStreakiness;     // trail LENGTH / persistence — how far up the streak behind a head survives\nuniform float  uLightAngle;      // direction TO the light (radians; -PI/2 = above) for the specular\nuniform float3 uTint;            // fog/steam colour cast\n\n// Pure. 1D fract-hash → [0,1). Same p ⇒ same value on a given backend.\nfloat hash11(float p) {\n  p = fract(p * H1_MUL);\n  p *= p + H1_ADD;\n  p *= p + p;\n  return fract(p);\n}\n\n// Pure. 2D fract-hash → [0,1).\nfloat hash21(float2 p) {\n  float3 p3 = fract(float3(p.xyx) * H3_MUL);\n  p3 += dot(p3, p3.yzx + H3_ADD);\n  return fract((p3.x + p3.y) * p3.z);\n}\n\n// Pure. 2D → 3 randoms in [0,1) (Hoskins hash23), one seed per grid cell.\nfloat3 hash23(float2 p) {\n  float3 p3 = fract(float3(p.xyx) * H3_MUL);\n  p3 += dot(p3, p3.yzx + H3_ADD);\n  return fract((p3.xxy + p3.yzz) * p3.zyx);\n}\n\n// Pure. Smooth triangular pulse peaking at b∈(0,1): 0 → 1 (at t=b) → 0. Heartfelt's\n// Saw, used for the appear/vanish life of a static bead.\nfloat sawPulse(float b, float t) {\n  return smoothstep(0.0, b, t) * smoothstep(1.0, b, t);\n}\n\n// Pure. Smooth UNION of two heights (probabilistic OR / \"screen\"): exactly 0 when\n// both are 0 (so empty glass stays flat — no spurious background refraction) and\n// BULGES where they overlap, forming the connecting neck that reads as a MERGE.\n// a, b assumed in [0,1]. uni(0.6,0.5)=0.8 (a bulge above either input).\nfloat uni(float a, float b) { return a + b - a * b; }\n\n// Pure. Signed distance to a rounded rect (iq). <0 inside. p LOCAL & centred.\nfloat sdRoundRect(float2 p, float2 h, float r) {\n  float2 q = abs(p) - (h - r);\n  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;\n}\n\n// Near-pure (reads uniforms). ONE runner drop's height for the cell (colF,rowF).\n// lxc = the sample's x in CELL-WIDTH units, centred on the cell (∈ ~[-1.5,1.5] when\n// a neighbour column is probed); ly = the sample's y within the row (0 top…1 bottom);\n// cellRatio = the cell's screen width/height (for the round distance metric); salt\n// desyncs stacked layers; sizeMul scales the drop; presence = P(cell hosts a drop).\nfloat runDrop(float colF, float rowF, float lxc, float ly, float cellRatio, float rate, float salt, float sizeMul, float presence) {\n  float2 id = float2(colF, rowF) + salt;\n  float here = hash21(id + 17.0);\n  if (here > presence) return 0.0;               // only some cells host a drop\n  float3 rnd = hash23(id);\n\n  // per-drop descent: ACCELERATING (yh = ph², velocity ∝ ph) with a hashed rate +\n  // phase; FADE IN near the top and OUT near the bottom so the fract wrap is unseen.\n  float speedVar = mix(RUN_SPEED_LO, RUN_SPEED_HI, rnd.z);\n  float ph = fract(uTime * uSpeed * rate * FALL_BASE * speedVar + rnd.y);\n  float yh = ph * ph;\n  float life = smoothstep(0.0, DROP_FADE_IN, ph) * smoothstep(1.0, 1.0 - DROP_FADE_OUT, ph);\n  if (life <= 0.0) return 0.0;\n\n  // drop GROWS as it descends (accretes water) → a fatter lens lower down\n  float grow = mix(DROP_GROW_LO, DROP_GROW_HI, ph);\n  float R = HEAD_R * sizeMul * grow * max(uDropSize, EPS);\n\n  // snaking column path (SAME expression drives head + trail so they line up)\n  float px = (rnd.x - 0.5) * X_SPREAD + sin(ly * WIGGLE_FREQ + rnd.z * TWO_PI) * WIGGLE_AMP;\n  float dxh = lxc - px;                           // horizontal distance to the path (cell widths)\n\n  // HEAD: a round blob at (px, yh); y delta divided by cellRatio → a round metric\n  float dyh = (ly - yh) / max(cellRatio, EPS);\n  float head = smoothstep(R, 0.0, length(float2(dxh, dyh))) * HEAD_H;\n\n  // TRAIL: the wake ABOVE the head. t01 = 0 at the cell TOP … 1 at the head, so the\n  // streak fades to EXACTLY 0 at the top edge (this is the seamless-across-rows key).\n  float above = yh - ly;                          // >0 above the head\n  float t01 = clamp(ly / max(yh, EPS), 0.0, 1.0);\n  float streak = pow(t01, TRAIL_FADE_EXP / max(uStreakiness, EPS));\n  float twdt = TRAIL_W * sizeMul * mix(TRAIL_TAPER, 1.0, t01); // narrows toward the top\n  float onTrail = step(0.0, above) * streak;\n  float trail = smoothstep(twdt, 0.0, abs(dxh)) * onTrail * TRAIL_H;\n\n  // residual BEADS speckling the trail — the head connects to the chain above it (merge)\n  float beadY = fract(ly * TRAIL_BEADS + rnd.z);  // repeating bead slots up the trail\n  float bdy = (beadY - 0.5) / (TRAIL_BEADS * max(cellRatio, EPS));\n  float bead = smoothstep(BEAD_R * sizeMul, 0.0, length(float2(dxh, bdy))) * onTrail * TRAIL_H;\n\n  return uni(head, uni(trail, bead)) * life;\n}\n\n// Near-pure (reads uniforms). One RUNNER layer's height at field uv∈[0,1]^2 (y-down).\n// Samples the 3 horizontal NEIGHBOUR columns so a head that wandered toward a column\n// edge is drawn whole from both sides, AND the 3 vertical NEIGHBOUR rows so a head\n// or trail near a row's own top/bottom is drawn whole from both sides too — the\n// layer is SEAMLESS across BOTH column and row edges. A drop's head has radius R in\n// ly units (R times cellRatio, up to ~0.08-0.16 of a cell height across the phase\n// range) centred at yh = ph squared; near spawn (small ph) or wrap (ph near 1) that\n// circle geometrically crosses ly=0 or ly=1 while life (a function of ph alone) is\n// already > 0 — so without this neighbour-row loop the head is hard-clipped FLAT\n// exactly at the row boundary (the reported seam: a drop sliced by a horizontal\n// line, or a trail spike terminating abruptly). Each neighbour row is queried with\n// ITS OWN drop id (rowF+dr) at the LOCAL ly that row would see this sample at\n// (ly - dr: one row up shifts the sample DOWN by a full cell in that row's frame,\n// symmetric with the column loop's colF+dc / lxc pairing).\nfloat runningLayer(float2 uv, float aspect, float cols, float rate, float salt, float sizeMul, float presence) {\n  float rows = max(1.0, cols * CELL_WH / max(aspect, EPS)); // tall cells at any aspect\n  float cellRatio = CELL_WH;\n  float gx = uv.x * cols;\n  float rowBase = floor(uv.y * rows);\n  float lyBase = fract(uv.y * rows);\n  float h = 0.0;\n  for (float dc = -1.0; dc <= 1.0; dc += 1.0) {\n    float colF = floor(gx) + dc;\n    float lxc = gx - (colF + 0.5);                // sample x relative to this column's centre\n    for (float dr = -1.0; dr <= 1.0; dr += 1.0) {\n      float rowF = rowBase + dr;\n      float ly = lyBase - dr;                     // this row's OWN local y for the same sample\n      h = uni(h, runDrop(colF, rowF, lxc, ly, cellRatio, rate, salt, sizeMul, presence));\n    }\n  }\n  return h;\n}\n\n// Near-pure (reads uniforms). The STATIC condensation layer at field coord uv.\n// 3×3 cell neighbourhood + smooth union so a bead whose centre wanders into a\n// neighbour cell is drawn WHOLE — never clipped at a cell edge (was the old seam).\nfloat staticLayer(float2 uv, float aspect, float t) {\n  float2 g = float2(STATIC_DENS * aspect, STATIC_DENS); // square cells (x scaled by aspect)\n  float2 gp = uv * g;\n  float2 base = floor(gp);\n  float h = 0.0;\n  for (float dy = -1.0; dy <= 1.0; dy += 1.0) {\n    for (float dx = -1.0; dx <= 1.0; dx += 1.0) {\n      float2 id = base + float2(dx, dy);\n      float3 rnd = hash23(id + 91.7);\n      float2 center = id + 0.5 + (rnd.xy - 0.5) * STATIC_WANDER;\n      float d = length(gp - center);              // grid units — square cells ⇒ round beads\n      float fade = sawPulse(STATIC_FADE_PEAK, fract(t * STATIC_RATE + rnd.z));\n      float present = step(STATIC_PRESENT, rnd.z);\n      float bead = smoothstep(STATIC_R * max(uDropSize, EPS), 0.0, d) * fade * present * STATIC_H;\n      h = uni(h, bead);\n    }\n  }\n  return h;\n}\n\n// Near-pure (reads uniforms). The combined WATER-HEIGHT field at a LOCAL px \"pl\".\n// Sampling this at pl and pl ± a few px gives the refraction normal.\nfloat waterHeight(float2 pl) {\n  float2 uv = (pl / uHalfSize) * 0.5 + 0.5;       // 0..1 across the widget, y-down\n  float aspect = uHalfSize.x / max(uHalfSize.y, EPS);\n  float rain = clamp(uRain, 0.0, 1.0);\n  float staticW = smoothstep(0.0, STATIC_ON_HI, rain);\n  float run1W = smoothstep(RUN1_ON_LO, RUN1_ON_HI, rain);\n  float run2W = smoothstep(RUN2_ON_LO, RUN2_ON_HI, rain);\n  float presence = mix(RUN_PRESENCE_LO, RUN_PRESENCE_HI, rain);\n\n  float s  = staticLayer(uv, aspect, uTime * uSpeed) * staticW;\n  float r1 = runningLayer(uv, aspect, uColumns, 1.0, 0.0, uDropSize, presence) * run1W;\n  float r2 = runningLayer(uv, aspect, uColumns * RUN2_SCALE, RUN2_SPEED, RUN2_SALT, uDropSize * RUN2_SIZE, presence) * run2W;\n  // smooth-union everything: a runner head passing a static bead MERGES with it.\n  return clamp(uni(s, uni(r1, r2)), 0.0, 1.0);\n}\n\nhalf4 main(float2 p) {\n  float ca = cos(uAngle), sa = sin(uAngle);\n  float2 d0 = p - uCenter;\n  float2 pl = float2(ca * d0.x + sa * d0.y, -sa * d0.x + ca * d0.y); // device → local (centred)\n  float r = min(uCornerRadius, min(uHalfSize.x, uHalfSize.y));       // capsule-safe clamp\n\n  float d = sdRoundRect(pl, uHalfSize, r);\n  float cov = 1.0 - smoothstep(-AA_PX, AA_PX, d);\n  if (cov <= 0.0) { return half4(0.0); }          // outside the pane ⇒ contribute nothing\n\n  float minHalf = min(uHalfSize.x, uHalfSize.y);\n\n  // height field + gradient (finite differences in the LOCAL frame → the normal)\n  float h0 = waterHeight(pl);\n  float hX = waterHeight(pl + float2(GRAD_EPS, 0.0));\n  float hY = waterHeight(pl + float2(0.0, GRAD_EPS));\n  float2 grad = float2(hX - h0, hY - h0) / GRAD_EPS;       // height per device px (local axes)\n  float3 nrm = normalize(float3(-grad * BUMP, 1.0));\n  float wet = smoothstep(WET_LO, WET_HI, h0);\n\n  // REFRACTION: displace the sample by the surface normal (a lens), bounded by\n  // uRefraction·shortHalf, only where wet; rotate the local offset back to device.\n  float2 dispL = nrm.xy * (uRefraction * minHalf) * wet;\n  float2 disp = float2(ca * dispL.x - sa * dispL.y, sa * dispL.x + ca * dispL.y);\n\n  half3 sharpDry  = sharpBackdrop.eval(p).rgb;            // dry clear glass = the backdrop as-is\n  half3 sharpRefr = sharpBackdrop.eval(p + disp).rgb;     // refracted through a droplet\n  half3 blur      = blurredBackdrop.eval(p).rgb;          // the fog/steam source\n\n  // FOG / STEAM: blurred, desaturated, tinted, lifted — the steamed-up dry pane.\n  half lum = dot(blur, REC709);\n  half3 steam = mix(blur, half3(lum), half(FOG_DESAT));\n  steam = mix(steam, half3(uTint), half(FOG_TINT)) + half3(FOG_LIFT);\n  half3 dry = mix(sharpDry, steam, half(clamp(uFog, 0.0, 1.0))); // clear → foggy by uFog\n  half3 col = mix(dry, sharpRefr, half(wet));             // drops/trails clear the fog + refract\n\n  // SPECULAR sparkle on the droplet surfaces (glint + fresnel rim), wet-only.\n  float3 L = normalize(float3(cos(uLightAngle), sin(uLightAngle), LIGHT_Z));\n  float spec = pow(max(dot(nrm, L), 0.0), SPEC_POWER);\n  float rim = pow(1.0 - clamp(nrm.z, 0.0, 1.0), RIM_POWER);\n  col += half3(half((spec + rim * RIM_GAIN) * uShine * wet));\n\n  return half4(clamp(col, 0.0, 1.0) * half(cov), half(cov)); // premultiplied\n}\n",
};
