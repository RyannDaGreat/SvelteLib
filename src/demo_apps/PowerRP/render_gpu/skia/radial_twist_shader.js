/**
 * THE TWISTED RADIAL — a radial gradient whose lines of equal colour are spirals or
 * spokes rather than rings (the paint's `twist`, render_gpu/ir.js radialTwistField).
 * Skia has no native spiral or sweep-with-spiral gradient, so ONE runtime effect
 * computes the ramp coordinate t (the SkSL twin of ir.js radialTwistT, line for
 * line) and samples a child LINEAR gradient of the same stops along x at t. Using
 * Skia's own gradient for the ramp means stop interpolation, premultiplication and
 * clamping are exactly what the native radial does — only the coordinate changes.
 *
 * The same SkSL runs on the browser's WebGL2 surface and on bare-node software Skia
 * (cli/render.js), so there is one implementation. A 90° twist never reaches this
 * file: parsePaint omits it and gradient.js keeps the native MakeRadialGradient.
 *
 * WAVELENGTH, PHASE, SPREAD AND DIRECTION (ir.js radialRampT is the definition):
 * direction rotates where the turn fraction b starts; the twisted t is then scaled by
 * 1/wavelength and shifted by the phase (in ramps), and the SPREAD is the child ramp's
 * own TileMode — Skia tiles the ramp exactly as it does for a native gradient, so no
 * tiling is re-implemented in SkSL. At the defaults every uniform is an identity
 * (dirTurns 0, invW 1, shift 0, Clamp), so a pre-feature twisted radial is unchanged.
 */
import { radialTwistCoefficients, radialRampRender } from "../ir.js";
import { RADIAL_DEFAULT_ANGLE, FULL_TURN_DEG } from "../../core/properties.js";

// A zero radius would divide by zero in a = ρ/r; the plain radial treats r = 0 as a
// degenerate hair, and a hair-width radius is the same picture here (everything
// past it clamps to the end colour). Same idiom as gradient.js's `bounds.w || 1e-6`.
const MIN_RADIUS = 1e-6;
// The ramp child spans x ∈ [0,1] in the effect's local (unit-box) space; sampling
// it at a fixed mid-height keeps the lookup purely a function of t.
const RAMP_SAMPLE_Y = 0.5;

const TWIST_SKSL = `
uniform shader ramp;
uniform float2 center;
uniform float invR;
uniform float s;
uniform float c;
uniform float offset;
uniform float scale;
uniform float dirTurns;
uniform float invW;
uniform float shift;
const float TURN = 6.283185307179586;
half4 main(float2 p) {
  float2 d = p - center;
  float a = length(d) * invR;
  // Clockwise from 12 o'clock with y down. atan(0,0) is undefined; the one centre
  // pixel takes angle 0 rather than NaN.
  float theta = (d.x == 0.0 && d.y == 0.0) ? 0.0 : atan(d.x, -d.y);
  float b0 = (theta < 0.0 ? theta + TURN : theta) / TURN - dirTurns;
  float b = b0 < 0.0 ? b0 + 1.0 : b0;
  float t = (s * a + c * b + offset) * scale;
  return ramp.eval(float2(t * invW - shift, ${RAMP_SAMPLE_Y}));
}`;

let _effect = null;   // cached compiled RuntimeEffect
let _effectCK = null; // the CanvasKit instance it was compiled against

/**
 * Query→build (compiles once, memoized per CanvasKit instance). Throws with the SkSL
 * compiler error on failure — a shader that will not compile is a hard bug.
 * @param {object} CanvasKit - The CanvasKit module.
 * @returns {object} The compiled RuntimeEffect.
 */
function twistEffect(CanvasKit) {
  if (_effect && _effectCK === CanvasKit) return _effect;
  let err = null;
  const effect = CanvasKit.RuntimeEffect.Make(TWIST_SKSL, (e) => { err = e; });
  if (!effect) throw new Error(`radial_twist_shader: SkSL failed to compile:\n${err}`);
  _effect = effect;
  _effectCK = CanvasKit;
  return effect;
}

/**
 * Query→build (allocates a Shader — caller deletes). The twisted radial for a parsed
 * radial paint carrying `twist`, over the same unit-box → local matrix the native
 * radial uses, so centre/radius mean exactly what they mean on a ring radial.
 * @param {object} CanvasKit - The CanvasKit module.
 * @param {object} paint - Parsed radial paint {stops, center, r, twist, wavelength?, phase?, spread?, angle?}.
 * @param {object[]} colors - CanvasKit Color4f per stop, opacity already folded in.
 * @param {number[]} positions - Stop offsets in [0,1].
 * @param {number[]} localMatrix - Unit-box → local 3x3 (gradient.js builds it).
 * @param {object} tileMode - CanvasKit TileMode for the paint's spread (gradient.js
 *   resolves it with skTileMode; passed in so this module does not import gradient.js back).
 * @returns {object} Shader.
 */
export function twistedRadialShader(CanvasKit, paint, colors, positions, localMatrix, tileMode) {
  // A collapsed (wavelength-0) radial never reaches here: gradient.js paints its
  // average colour first, so 1/w below is always finite.
  const { w, shift } = radialRampRender(paint);
  const ramp = CanvasKit.Shader.MakeLinearGradient([0, 0], [1, 0], colors, positions, tileMode);
  if (!ramp) throw new Error("twistedRadialShader: the ramp gradient could not be built");
  const { s, c, offset, scale } = radialTwistCoefficients(paint.twist);
  const dirTurns = (paint.angle ?? RADIAL_DEFAULT_ANGLE) / FULL_TURN_DEG;
  const uniforms = [paint.center.x, paint.center.y, 1 / Math.max(paint.r, MIN_RADIUS), s, c, offset, scale, dirTurns, 1 / w, shift];
  const shader = twistEffect(CanvasKit).makeShaderWithChildren(uniforms, [ramp], localMatrix);
  ramp.delete(); // the runtime shader holds its own reference to the child
  if (!shader) throw new Error("twistedRadialShader: makeShaderWithChildren returned null");
  return shader;
}
