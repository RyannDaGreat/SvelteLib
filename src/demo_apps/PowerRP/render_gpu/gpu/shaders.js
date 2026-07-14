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
    // Ellipse: scaled-space approximation — exact for circles, visually fine
    // for moderate aspect ellipses (true ellipse SDF needs an iterative solve).
    let radii = max(in.params.zw, vec2f(1e-6));
    let k = length((in.local - in.params.xy) / radii);
    d = (k - 1.0) * min(radii.x, radii.y);
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

/** TEX modes (misc.x). */
export const TEX_MODE = { glyph: 0, image: 1 };

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
    c = vec4f(in.color.rgb, 1.0) * (in.color.a * s.a); // glyph: alpha mask × color
  } else {
    c = s; // image: uploaded premultiplied
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

// 3σ kernel support, capped at 96 taps each side: gigantic radii degrade
// (kernel truncates, still normalized) instead of stalling the GPU.
const MAX_HALF_KERNEL: i32 = 96;

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
 * fragment samples the backdrop texture at UVs contracted about the lens
 * center by 1/magnification, masked by a circle SDF, plus a rim ring.
 * params are DEVICE px (computed CPU-side from the lens's world transform).
 */
export const MAGNIFY_WGSL = VIEW_WGSL + /* wgsl */ `
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var backdrop: texture_2d<f32>;

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
  @location(3) i_params: vec4f,
  @location(4) i_rim: vec4f,
  @location(5) i_misc: vec4f,
) -> MagOut {
  let local = i_quad.xy + corner * i_quad.zw;
  var out: MagOut;
  out.pos = world_to_clip(apply_xform(i_xform, local));
  out.params = i_params;
  out.rim = i_rim;
  out.misc = i_misc;
  return out;
}

@fragment
fn fs(in: MagOut) -> @location(0) vec4f {
  let p = in.pos.xy; // framebuffer coords = device px
  let center = in.params.xy;
  let r = in.params.z;
  let mag = max(in.params.w, 0.01);
  let d = length(p - center) - r;

  let uv = (center + (p - center) / mag) / view.resolution.xy;
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
