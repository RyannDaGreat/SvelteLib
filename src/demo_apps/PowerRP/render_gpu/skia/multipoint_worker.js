/** Numerical refinement only. Never creates a renderer/context or touches documents. */
import { solveMultipoint } from "../../core/multipoint_diffusion.js";
import { MULTIPOINT_FINAL_SIZE } from "./multipoint.js";

/**
 * Command. Solves one requested field, transferring (512,512,4) Float32 RGBA back.
 * The message boundary reports failures to the owning surface; they are never
 * replaced by another paint. Stale jobs may finish but cannot overwrite a key.
 * @param {MessageEvent} event - {key,features} from the owning SkiaSurface.
 * @returns {undefined}
 */
self.onmessage = ({data:{key,features}}) => {
  try {
    const result = solveMultipoint(features,{size:MULTIPOINT_FINAL_SIZE});
    if (!result.converged) throw new Error(`Multipoint refinement did not converge (residual ${result.relativeResidual}).`);
    self.postMessage({key,result},[result.pixels.buffer]);
  } catch (error) {
    self.postMessage({key,error:String(error?.stack ?? error)});
  }
};
