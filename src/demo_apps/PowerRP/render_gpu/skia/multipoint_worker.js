/** Numerical refinement only. Never creates a renderer/context or touches documents. */
import { solvedField } from "./multipoint.js";

/**
 * Command. Solves one requested field at its requested size and transfers the
 * upload-ready (size,size,4) F16 texels back, so the owning surface's main thread
 * never solves or converts a refined field. The message boundary reports failures
 * to the owning surface; they are never replaced by another paint.
 * @param {MessageEvent} event - {key, features, size} from the owning SkiaSurface.
 * @returns {undefined}
 */
self.onmessage = ({data:{key,features,size}}) => {
  try {
    const field = solvedField(features,size);
    self.postMessage({key,field},[field.half.buffer]);
  } catch (error) {
    self.postMessage({key,error:String(error?.stack ?? error)});
  }
};
