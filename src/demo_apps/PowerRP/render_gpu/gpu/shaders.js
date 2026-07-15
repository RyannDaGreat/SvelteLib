/**
 * WGSL shaders for the WebGPU IR compositor.
 *
 * All raster work happens in five pipelines:
 *   SHAPE   — instanced unit quads; the fragment shader evaluates an SDF per
 *             instance kind (rounded rect / ellipse / capsule segment) with
 *             fwidth()-based antialiasing and a centered stroke band. This is
 *             DiskVis's instanced-quad pattern generalized from "rect with
 *             border" to "any SDF shape".
 *   MESH    — plain colored triangles (convex polygon fills, e.g. arrowheads);
 *             vertices are pre-transformed to world space on the CPU.
 *   TEX     — instanced textured quads: glyph-atlas runs (alpha mask × color)
 *             and images (premultiplied rgba).
 *   VIDEO   — one textured quad sampling a texture_external (zero-copy video
 *             frames via importExternalTexture).
 *   Effects — fullscreen separable Gaussian blur (H, V) and the magnifier
 *             lens quad, both sampling the offscreen scene/backdrop textures
 *             (replacing the canvas2D full-canvas snapshot).
 *
 * Shared conventions:
 *   - group(0) binding(0) is the View uniform: world → device px mapping
 *     (device = world * zoom * dpr + pan * dpr) plus the device resolution.
 *   - Color outputs are PREMULTIPLIED alpha; pipelines blend with
 *     (one, one-minus-src-alpha).
 *   - The similarity transform per instance is packed as (a, b, tx, ty) with
 *     world = (a·x − b·y + tx,  b·x + a·y + ty); a = s·cosθ, b = s·sinθ —
 *     4 floats suffice because core/transform.js forbids skew.
 */

/** Shared view uniform + helpers, prefixed onto shaders that need them. */
export const VIEW_WGSL = /* wgsl */ `
struct View {
  scale_pan: vec4f,   // (zoom*dpr, panX*dpr, panY*dpr, unused)
  resolution: vec4f,  // (deviceW, deviceH, unused, unused)
};
@group(0) @binding(0) var<uniform> view: View;

fn world_to_clip(world: vec2f) -> vec4f {
  let device = world * view.scale_pan.x + view.scale_pan.yz;
  var clip = device / view.resolution.xy * 2.0 - 1.0;
  clip.y = -clip.y;
  return vec4f(clip, 0.0, 1.0);
}

fn apply_xform(xf: vec4f, p: vec2f) -> vec2f {
  return vec2f(xf.x * p.x - xf.y * p.y + xf.z,
               xf.y * p.x + xf.x * p.y + xf.w);
}

// Screen-space antialiased coverage of signed distance d (d < 0 inside).
fn coverage(d: f32) -> f32 {
  let aa = max(fwidth(d), 1e-5);
  return clamp(0.5 - d / aa, 0.0, 1.0);
}
`;

/** SHAPE kinds (misc.x) — mirrored by the compositor's instance builder. */
export const SHAPE_KIND = { rect: 0, ellipse: 1, segment: 2 };

export const SHAPE_WGSL = VIEW_WGSL + /* wgsl */ `
struct ShapeOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) fill: vec4f,
  @location(2) @interpolate(flat) stroke: vec4f,
  @location(3) @interpolate(flat) params: vec4f,
  @location(4) @interpolate(flat) misc: vec4f, // (kind, strokeWidth, opacity, cornerRadius)
};

@vertex
fn vs(
  @location(0) corner: vec2f,   // unit quad corner (0..1)
  @location(1) i_quad: vec4f,   // local-space quad (x, y, w, h) — covers shape + stroke + AA margin
  @location(2) i_xform: vec4f,  // similarity (a, b, tx, ty)
  @location(3) i_fill: vec4f,
  @location(4) i_stroke: vec4f,
  @location(5) i_params: vec4f, // rect: (cx, cy, hw, hh); ellipse: (cx, cy, rx, ry); segment: (x0, y0, x1, y1)
  @location(6) i_misc: vec4f,
) -> ShapeOut {
  let local = i_quad.xy + corner * i_quad.zw;
  var out: ShapeOut;
  out.pos = world_to_clip(apply_xform(i_xform, local));
  out.local = local;
  out.fill = i_fill;
  out.stroke = i_stroke;
  out.params = i_params;
  out.misc = i_misc;
  return out;
}

@fragment
fn fs(in: ShapeOut) -> @location(0) vec4f {
  let kind = in.misc.x;
  let sw = in.misc.y;
  let opacity = in.misc.z;
  var d: f32;
  if (kind < 0.5) {
    // Rounded rect SDF (Inigo Quilez's sdRoundBox)
    let half_size = in.params.zw;
    let r = min(in.misc.w, min(half_size.x, half_size.y));
    let q = abs(in.local - in.params.xy) - half_size + vec2f(r);
    d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
  } else if (kind < 1.5) {
    // Ellipse: gradient-corrected distance d = F/|∇F| (Inigo Quilez's
    // ellipse approximation). The old scaled-space form was exact only for
    // circles — squashed ellipses got thinned/chopped strokes at the pointy
    // ends (user-reported). This form keeps strokes uniform at any aspect
    // ratio; near the center (k2 → 0, gradient vanishes) fall back to the
    // scaled-space value, which is only used deep inside the fill.
    let radii = max(in.params.zw, vec2f(1e-6));
    let q = in.local - in.params.xy;
    let k1 = length(q / radii);
    let k2 = length(q / (radii * radii));
    let scaled = (k1 - 1.0) * min(radii.x, radii.y);
    d = select(k1 * (k1 - 1.0) / k2, scaled, k2 < 1e-6);
  } else {
    // Capsule around segment a→b (round caps/joins for polylines)
    let a = in.params.xy;
    let b = in.params.zw;
    let pa = in.local - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
    d = length(pa - ba * h) - sw * 0.5;
  }

  // Derivative ops (fwidth in coverage) must stay in uniform control flow, so
  // both coverages are computed unconditionally after the branches reconverge.
  let cov_fill = coverage(d);
  let cov_stroke = coverage(abs(d) - sw * 0.5);
  let fill_p = vec4f(in.fill.rgb, 1.0) * (in.fill.a * cov_fill);
  // Centered stroke band, matching canvas2D stroke semantics. Segments carry a
  // zero-alpha stroke, and sw <= 0 disables the band via select.
  let stroke_p = select(vec4f(0.0), vec4f(in.stroke.rgb, 1.0) * (in.stroke.a * cov_stroke), sw > 0.0 && kind < 1.5);
  let out_color = stroke_p + fill_p * (1.0 - stroke_p.a);
  return out_color * opacity;
}
`;

export const MESH_WGSL = VIEW_WGSL + /* wgsl */ `
struct MeshOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) color: vec4f, // premultiplied, opacity baked in
};

@vertex
fn vs(@location(0) pos: vec2f, @location(1) color: vec4f) -> MeshOut {
  var out: MeshOut;
  out.pos = world_to_clip(pos);
  out.color = color;
  return out;
}

@fragment
fn fs(in: MeshOut) -> @location(0) vec4f {
  return in.color;
}
`;

/** TEX modes (misc.x). `glyph` tints a white alpha-mask glyph by the run's
 * text color (monochrome text — the original path). `colorGlyph` samples the
 * atlas texel AS-IS (the glyph's own rasterized color, e.g. emoji artwork)
 * modulated only by opacity — bypassing the tint entirely, because the
 * glyph already supplies correct RGB (glyph_atlas.js isColorGlyph). `image`
 * is unrelated — an uploaded premultiplied texture. */
export const TEX_MODE = { glyph: 0, image: 1, colorGlyph: 2 };

export const TEX_WGSL = VIEW_WGSL + /* wgsl */ `
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;

struct TexOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
  @location(2) @interpolate(flat) misc: vec4f, // (mode, opacity, 0, 0)
};

@vertex
fn vs(
  @location(0) corner: vec2f,
  @location(1) i_quad: vec4f,
  @location(2) i_xform: vec4f,
  @location(3) i_uv: vec4f,    // (u0, v0, du, dv)
  @location(4) i_color: vec4f,
  @location(5) i_misc: vec4f,
) -> TexOut {
  let local = i_quad.xy + corner * i_quad.zw;
  var out: TexOut;
  out.pos = world_to_clip(apply_xform(i_xform, local));
  out.uv = i_uv.xy + corner * i_uv.zw;
  out.color = i_color;
  out.misc = i_misc;
  return out;
}

@fragment
fn fs(in: TexOut) -> @location(0) vec4f {
  let s = textureSample(tex, samp, in.uv);
  var c: vec4f;
  if (in.misc.x < 0.5) {
    c = vec4f(in.color.rgb, 1.0) * (in.color.a * s.a); // glyph: alpha mask × color (tinted)
  } else if (in.misc.x < 1.5) {
    c = s; // image: uploaded premultiplied
  } else {
    c = s; // colorGlyph: the atlas texel's OWN color (premultiplied) — no tint
  }
  return c * in.misc.y;
}
`;

export const VIDEO_WGSL = VIEW_WGSL + /* wgsl */ `
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var tex: texture_external;

struct VideoOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) misc: vec4f, // (unused, opacity, 0, 0)
};

@vertex
fn vs(
  @location(0) corner: vec2f,
  @location(1) i_quad: vec4f,
  @location(2) i_xform: vec4f,
  @location(3) i_uv: vec4f,
  @location(4) i_color: vec4f,
  @location(5) i_misc: vec4f,
) -> VideoOut {
  let local = i_quad.xy + corner * i_quad.zw;
  var out: VideoOut;
  out.pos = world_to_clip(apply_xform(i_xform, local));
  out.uv = i_uv.xy + corner * i_uv.zw;
  out.misc = i_misc;
  return out;
}

@fragment
fn fs(in: VideoOut) -> @location(0) vec4f {
  let rgb = textureSampleBaseClampToEdge(tex, samp, in.uv).rgb;
  return vec4f(rgb, 1.0) * in.misc.y;
}
`;

/**
 * 3σ kernel support cap, each side: gigantic radii degrade (kernel truncates,
 * still normalized) instead of stalling the GPU. ONE constant, interpolated
 * into the WGSL and imported by the compositor (which pads blur scissors by
 * the same tap reach so bounded blur passes stay artifact-free).
 */
export const MAX_HALF_KERNEL = 96;

/**
 * Separable Gaussian blur pass (fullscreen triangle). Run twice: H over the
 * backdrop snapshot into temp, then V over temp back onto the scene with
 * opacity blending — mix(scene, blurred, opacity), the canvas2D
 * `globalAlpha + drawImage(blurred)` equivalence.
 */
export const BLUR_WGSL = /* wgsl */ `
struct BlurU {
  dir_sigma: vec4f,   // (dirX, dirY, sigmaDevicePx, unused) — dir in texels
  opacity: vec4f,     // (opacity, unused, unused, unused)
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: BlurU;

struct BlurOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> BlurOut {
  // Fullscreen triangle: (-1,-1), (3,-1), (-1,3)
  let corner = vec2f(f32(vi % 2u) * 4.0 - 1.0, f32(vi / 2u) * 4.0 - 1.0);
  var out: BlurOut;
  out.pos = vec4f(corner, 0.0, 1.0);
  out.uv = vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  return out;
}

// 3σ support, capped (see the exported MAX_HALF_KERNEL doc above).
const MAX_HALF_KERNEL: i32 = ${MAX_HALF_KERNEL};

@fragment
fn fs(in: BlurOut) -> @location(0) vec4f {
  let sigma = max(u.dir_sigma.z, 0.01);
  let half_kernel = min(i32(ceil(sigma * 3.0)), MAX_HALF_KERNEL);
  let texel = 1.0 / vec2f(textureDimensions(src));
  var sum = vec4f(0.0);
  var weight_sum = 0.0;
  for (var i = -half_kernel; i <= half_kernel; i++) {
    let x = f32(i) / sigma;
    let w = exp(-0.5 * x * x);
    sum += textureSampleLevel(src, samp, in.uv + u.dir_sigma.xy * texel * f32(i), 0.0) * w;
    weight_sum += w;
  }
  return (sum / weight_sum) * u.opacity.x;
}
`;

/**
 * Magnifier lens: an instanced quad (same layout family as SHAPE) whose
 * fragment samples the bound texture at UVs contracted about the lens center
 * by 1/magnification, masked by a circle SDF, plus a rim ring.
 *
 * TWO lens-fill paths share this ONE pipeline (no duplication):
 *   backdrop sampling — bind the backdrop snapshot, magnification = M: the
 *     contraction upscales the already-rasterized composite (soft).
 *   supersample — bind the lens re-render texture (the sub-list below the
 *     lens re-rendered at M·zoom, device-aligned so the lens circle sits at
 *     the same device pixels), magnification = 1: uv = p, a straight sample
 *     of the sharp re-render. M = 1 makes the contraction the identity, so
 *     one shader serves both paths.
 *
 * Instance params are WORLD units (center, radius, rim width); the vertex
 * shader converts to device px through the view uniform. View-independent
 * instances are what make lens re-renders NESTABLE: the same instance replays
 * correctly inside another lens's re-render, where the bound view differs.
 */
export const MAGNIFY_WGSL = VIEW_WGSL + /* wgsl */ `
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var backdrop: texture_2d<f32>;
// The sample rect: which device-px region of the CURRENT target the bound
// texture's texels cover, as (originX, originY, texW, texH). Backdrop
// sampling binds (0, 0, canvasW, canvasH); a lens re-render binds its
// visible-intersection origin + the lens texture size (the re-render fills
// only the intersection's corner of the texture — the manifest rule
// "Magnifier renders only the VISIBLE lens intersection").
struct MagU { rect: vec4f };
@group(1) @binding(2) var<uniform> u: MagU;

struct MagOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) params: vec4f, // (centerDevX, centerDevY, rDev, magnification)
  @location(1) @interpolate(flat) rim: vec4f,
  @location(2) @interpolate(flat) misc: vec4f,   // (rimWidthDev, opacity, 0, 0)
};

@vertex
fn vs(
  @location(0) corner: vec2f,
  @location(1) i_quad: vec4f,
  @location(2) i_xform: vec4f,
  @location(3) i_params: vec4f, // (centerWorldX, centerWorldY, rWorld, magnification)
  @location(4) i_rim: vec4f,
  @location(5) i_misc: vec4f,   // (rimWidthWorld, opacity, 0, 0)
) -> MagOut {
  let local = i_quad.xy + corner * i_quad.zw;
  var out: MagOut;
  out.pos = world_to_clip(apply_xform(i_xform, local));
  // world → device px, the same mapping as world_to_clip's first line.
  let center_dev = i_params.xy * view.scale_pan.x + view.scale_pan.yz;
  out.params = vec4f(center_dev, i_params.z * view.scale_pan.x, i_params.w);
  out.rim = i_rim;
  out.misc = vec4f(i_misc.x * view.scale_pan.x, i_misc.yzw);
  return out;
}

@fragment
fn fs(in: MagOut) -> @location(0) vec4f {
  let p = in.pos.xy; // framebuffer coords = device px
  let center = in.params.xy;
  let r = in.params.z;
  let mag = max(in.params.w, 0.01);
  let d = length(p - center) - r;

  // q = the device-px point this fragment shows, contracted about the lens
  // center by 1/mag. Backdrop path: mag = M upscales the composite (soft).
  // Supersample path: mag = 1 so q = p — the re-render is already magnified,
  // sampled 1:1 (sharp). u.rect maps q into the bound texture's UV space.
  let q = center + (p - center) / mag;
  let uv = (q - u.rect.xy) / u.rect.zw;
  let rim_w = in.misc.x;
  // Coverages before any branch — fwidth needs uniform control flow.
  let cov_lens = coverage(d);
  let cov_rim = coverage(abs(d) - rim_w * 0.5);
  var c = textureSampleLevel(backdrop, samp, uv, 0.0) * cov_lens;
  let rim_p = select(vec4f(0.0), vec4f(in.rim.rgb, 1.0) * (in.rim.a * cov_rim), rim_w > 0.0);
  c = rim_p + c * (1.0 - rim_p.a);
  return c * in.misc.y;
}
`;

/**
 * The crop-box pipeline (manifest ARCHITECTURE PLAN #3) — the SAME "re-render
 * a sub-scene into a texture, then sample it through an SDF-masked quad" shape
 * as MAGNIFY_WGSL, with two differences: the SDF is a ROUNDED RECT (the exact
 * sdRoundBox formula SHAPE_WGSL's rect kind already uses — "reuse the lens
 * clip+replay machinery with a rounded-rect region", extended minimally) in
 * place of a circle, and there is no magnification (the crop box re-renders
 * its target 1:1 — q = p always; the "backdrop sampling" soft path doesn't
 * apply either, since a crop box's content is ONE named subtree, not
 * everything below it — see gpu/compositor.js's cropSubtree batch, which
 * therefore always re-renders and never falls back to a backdrop sample). A
 * dedicated pipeline (not a MAGNIFY_WGSL branch) because the params differ in
 * shape (half-size + corner radius vs. radius + magnification) and adding a
 * shape discriminator to the shared QUAD_FLOATS stride would touch the
 * tex/video pipelines that stride also serves — a fresh small instance layout
 * is the minimal, lowest-risk extension.
 */
export const CROP_WGSL = VIEW_WGSL + /* wgsl */ `
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var content: texture_2d<f32>;
// Same sample-rect convention as MAGNIFY_WGSL: (originX, originY, texW, texH)
// of the device-px region the bound texture's content occupies.
struct CropU { rect: vec4f };
@group(1) @binding(2) var<uniform> u: CropU;

struct CropOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) box: vec4f,   // (centerDevX, centerDevY, halfWDev, halfHDev)
  @location(1) @interpolate(flat) rDev: f32,
  @location(2) @interpolate(flat) fill: vec4f,
  @location(3) @interpolate(flat) stroke: vec4f,
  @location(4) @interpolate(flat) misc: vec4f,  // (strokeWidthDev, opacity, 0, 0)
};

@vertex
fn vs(
  @location(0) corner: vec2f,
  @location(1) i_quad: vec4f,
  @location(2) i_xform: vec4f,
  @location(3) i_box: vec4f,    // (centerWorldX, centerWorldY, halfWWorld, halfHWorld)
  @location(4) i_rWorld: vec4f, // (cornerRadiusWorld, 0, 0, 0)
  @location(5) i_fill: vec4f,
  @location(6) i_stroke: vec4f,
  @location(7) i_misc: vec4f,   // (strokeWidthWorld, opacity, 0, 0)
) -> CropOut {
  let local = i_quad.xy + corner * i_quad.zw;
  var out: CropOut;
  out.pos = world_to_clip(apply_xform(i_xform, local));
  let center_dev = i_box.xy * view.scale_pan.x + view.scale_pan.yz;
  out.box = vec4f(center_dev, i_box.zw * view.scale_pan.x);
  out.rDev = i_rWorld.x * view.scale_pan.x;
  out.fill = i_fill;
  out.stroke = i_stroke;
  out.misc = vec4f(i_misc.x * view.scale_pan.x, i_misc.yzw);
  return out;
}

@fragment
fn fs(in: CropOut) -> @location(0) vec4f {
  let p = in.pos.xy;
  let center = in.box.xy;
  let half_size = in.box.zw;
  // sdRoundBox (Inigo Quilez) — the SAME formula SHAPE_WGSL's rect kind uses,
  // so a crop box's clip edge is pixel-identical to a plain rounded rect's.
  let r = min(in.rDev, min(half_size.x, half_size.y));
  let q = abs(p - center) - half_size + vec2f(r);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;

  // The bound texture is the target's 1:1 re-render (no magnification — see
  // header); q maps straight through to its UV space.
  let uv = (p - u.rect.xy) / u.rect.zw;
  let sw = in.misc.x;
  let cov_region = coverage(d);
  let cov_stroke = coverage(abs(d) - sw * 0.5);
  // Fill first (premultiplied, like SHAPE_WGSL's fill_p), then the content
  // re-render composites OVER it (a transparent target region shows the
  // fill through, matching a plain box with nothing inside), then the stroke
  // on top — SAME z-order as the emit() doc comment: [fill, clipped target, border].
  var c = vec4f(in.fill.rgb, 1.0) * (in.fill.a * cov_region);
  let content_s = textureSampleLevel(content, samp, uv, 0.0) * cov_region;
  c = content_s + c * (1.0 - content_s.a);
  let stroke_p = select(vec4f(0.0), vec4f(in.stroke.rgb, 1.0) * (in.stroke.a * cov_stroke), sw > 0.0);
  c = stroke_p + c * (1.0 - stroke_p.a);
  return c * in.misc.y;
}
`;
