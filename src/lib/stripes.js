/**
 * stripes.js — generate crisp, seamless 45° stripe textures as tileable data-URLs.
 *
 * A `repeating-linear-gradient` blurs and drifts at 45° (the rasterizer
 * anti-aliases the diagonal unevenly, so line weight wobbles). Rendering the
 * tile ourselves at device resolution gives pixel-uniform stripes. One function
 * serves both the video-pane backdrop (1px line on a base) and the timeline's
 * proposed-selection hatch (white/black bands) — just different `bands`.
 */

/**
 * Query (browser). Parse any CSS color string to [r, g, b, a] (channels 0-255)
 * by painting one pixel and reading it back.
 *
 * @param {CanvasRenderingContext2D} ctx - a scratch 2D context
 * @param {string} color - any CSS color (hex, rgb(), rgba(), named)
 * @returns {[number, number, number, number]}
 *
 * @example parseColor(ctx, "#ff0000")        // [255, 0, 0, 255]
 * @example parseColor(ctx, "rgba(0,0,0,0.2)") // [0, 0, 0, 51]
 */
function parseColor(ctx, color) {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

/**
 * Query (browser). Build a seamless 45° stripe tile as a PNG data-URL.
 *
 * Stripes run perpendicular to the down-right diagonal: each pixel's band is
 * picked by (x + y) mod period, which tiles without seams when the tile side
 * equals the period. Band widths are given in PERPENDICULAR CSS px; the √2 of
 * the diagonal and the device-pixel-ratio are folded in here, so on-screen
 * spacing matches the given widths and lines stay ~1 device-px crisp.
 *
 * @param {{color:string,width:number}[]} bands - consecutive stripes, CSS px wide
 * @param {number} dpr - devicePixelRatio
 * @returns {{url:string, cssSize:number}} data-URL + background-size (CSS px, square)
 *
 * @example
 * // a 1px faint line every 10px over a base fill, on a 2× display:
 * makeStripeCanvas([{color:"#1c1c1c",width:1},{color:"#141414",width:9}], 2)
 * // -> { url: "data:image/png;base64,…", cssSize: ~14.14 }
 */
export function makeStripeCanvas(bands, dpr = 1) {
  const scratch = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  const dev = bands.map((b) => ({
    rgba: parseColor(scratch, b.color),
    w: Math.max(1, Math.round(b.width * Math.SQRT2 * dpr)),
  }));
  const period = dev.reduce((s, b) => s + b.w, 0);
  const ends = [];
  let acc = 0;
  for (const b of dev) {
    acc += b.w;
    ends.push(acc);
  }

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = period;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(period, period);
  for (let y = 0; y < period; y++) {
    for (let x = 0; x < period; x++) {
      const d = (x + y) % period;
      let bi = 0;
      while (bi < ends.length - 1 && d >= ends[bi]) bi++;
      const [r, g, b, a] = dev[bi].rgba;
      const o = (y * period + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL(), cssSize: period / dpr };
}
