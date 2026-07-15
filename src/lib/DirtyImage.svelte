<!--
  DirtyImage [visual, general] — a lazy, dirty-tracked raster tile.

  A box that renders a raster image ON DEMAND via a caller-supplied `render`
  callback, but only when it actually needs to: when it is (or scrolls) into
  view AND either its dirty key changed or its displayed size changed. This is
  what lets a list of a MILLION tiles stay cheap — an edit marks every tile
  dirty, yet only the handful on screen re-render; the rest wait, showing their
  last (stale) image, until scrolled into view. Off-screen + dirty = wait.

  It measures its OWN displayed CSS width (ResizeObserver) and the device pixel
  ratio, and calls `render(widthPx, heightPx)` at displayed-size × dpr — so the
  bitmap is exactly as crisp as the screen can show, never up- or down-scaled by
  the browser (the classic "fixed 256px thumbnail upscaled → blurry" bug). The
  box reserves height via `aspect` (height / width) so the list doesn't reflow
  before the first render lands.

  Resize-settle: while the box is actively resizing (e.g. dragging a split
  pane), it does NOT re-render every frame — it waits for the size to stop
  changing (`settleMs`) and renders once at the final size. The stale image is
  simply CSS-scaled to fill in the meantime.

  Visibility is an IntersectionObserver against the viewport (configurable
  `rootMargin` pre-renders tiles just before they scroll in). A tile that goes
  dirty while off-screen renders the moment it next becomes visible.

  render contract:
    render(widthPx, heightPx) → HTMLCanvasElement | string(dataURL/URL) | null
                                | Promise of any of those (async renderers —
                                  e.g. GPU readback; stale resolutions are
                                  dropped when a newer render superseded them)
  Return a canvas (drawn to <img> via toDataURL), a data/blob URL string, or
  null / "" to show nothing. widthPx/heightPx are DEVICE pixels (already × dpr).

  Usage:
    <DirtyImage
      render={(w, h) => paintTileCanvas(w, h, tile)}
      dirtyKey={tile.version}   {/* re-render when this value CHANGES */}
      aspect={9 / 16}           {/* 16:9 box: height = width * 9/16 */}
      alt="Slide 3 preview"
    />

  CSS custom properties:
    --di-bg      placeholder/letterbox background (← transparent)
    --di-radius  corner radius                    (← 0; rounding reads sloppy)
-->
<script module>
  /**
   * Pure function. The device-pixel target size to render a tile at, given its
   * displayed CSS width, its aspect (height / width), and the device pixel
   * ratio. Height derives from width × aspect so the bitmap matches the box's
   * displayed shape exactly. Dimensions are floored to whole device pixels and
   * clamped to a minimum of 1 (a canvas may never be 0×0).
   *
   * @param {number} cssW  Displayed width in CSS pixels.
   * @param {number} aspect Height / width ratio the box reserves.
   * @param {number} dpr    Device pixels per CSS pixel (window.devicePixelRatio).
   * @returns {{w: number, h: number}} Device-pixel render size.
   *
   * @example
   * // A 200px-wide 16:9 tile on a 2× retina display renders at 400×225 device px.
   * deviceSizeFor(200, 9 / 16, 2)
   * // => { w: 400, h: 225 }
   * @example
   * // A 1px-wide box never yields a zero dimension.
   * deviceSizeFor(0.2, 1, 1)
   * // => { w: 1, h: 1 }
   */
  export function deviceSizeFor(cssW, aspect, dpr) {
    return {
      w: Math.max(1, Math.floor(cssW * dpr)),
      h: Math.max(1, Math.floor(cssW * aspect * dpr)),
    };
  }

  /**
   * Pure function. Do two device-pixel sizes differ (either dimension)? Used to
   * decide whether a size change alone should mark a tile dirty. `null` (no
   * previous render) always counts as different — the first render is needed.
   *
   * @param {{w:number,h:number}|null} prev Size of the last render, or null.
   * @param {{w:number,h:number}} next Proposed render size.
   * @returns {boolean} True if a re-render at `next` would change the bitmap size.
   *
   * @example
   * // Same size: no re-render needed on size grounds.
   * sizeChanged({ w: 400, h: 226 }, { w: 400, h: 226 })
   * // => false
   * @example
   * // Wider after a pane drag: re-render at the new size.
   * sizeChanged({ w: 400, h: 226 }, { w: 512, h: 288 })
   * // => true
   * @example
   * // No prior render: always "changed" so the first paint happens.
   * sizeChanged(null, { w: 400, h: 226 })
   * // => true
   */
  export function sizeChanged(prev, next) {
    return prev === null || prev.w !== next.w || prev.h !== next.h;
  }

  /**
   * Pure function. Normalizes a render() result into an <img> src string.
   * A canvas becomes a data URL; a string passes through; null / "" / undefined
   * become "" (show nothing). Anything else is a caller bug and throws loudly —
   * silent fallbacks are forbidden.
   *
   * @param {HTMLCanvasElement|string|null|undefined} result render()'s return value.
   * @returns {string} A src for the <img>, or "" for nothing.
   *
   * @example
   * // A URL string passes straight through.
   * toSrc("data:image/png;base64,AAAA")
   * // => "data:image/png;base64,AAAA"
   * @example
   * // Null / empty means "nothing to show yet".
   * toSrc(null)
   * // => ""
   * @example
   * // # A canvas is converted via toDataURL:
   * // toSrc(document.createElement("canvas")) // => "data:image/png;base64,..."
   */
  export function toSrc(result) {
    if (result == null || result === "") return "";
    if (typeof result === "string") return result;
    if (typeof result.toDataURL === "function") return result.toDataURL("image/png");
    throw new Error(
      "DirtyImage: render() must return a canvas, a URL string, or null — got " + typeof result,
    );
  }
</script>

<script>
  let {
    /** @type {(widthPx:number, heightPx:number) => HTMLCanvasElement|string|null} Renders the tile at a device-pixel size. Required. */
    render,
    /** @type {any} Dirty key: when its VALUE changes (!==), the tile is dirty. */
    dirtyKey = undefined,
    /** @type {number} Height / width ratio the box reserves (e.g. 9/16). Required, > 0. */
    aspect,
    /** @type {string} Alt text for the rendered image. */
    alt = "",
    /** @type {number} ms the displayed size must hold steady before re-rendering (resize-settle). */
    settleMs = 120,
    /** @type {string} IntersectionObserver rootMargin — pre-render this far outside the viewport. */
    rootMargin = "200px",
    /** @type {string} Extra class on the outer box. */
    class: klass = "",
  } = $props();

  // Loud validation of the required props (re-checked if they ever change).
  $effect(() => {
    if (typeof render !== "function")
      throw new Error("DirtyImage: `render` prop is required and must be a function.");
    if (!(aspect > 0))
      throw new Error("DirtyImage: `aspect` prop is required and must be a positive number (height / width).");
  });

  let box = $state(null); // the outer element we measure + observe
  let src = $state(""); // current (possibly stale) image src
  let cssW = $state(0); // last measured displayed CSS width
  let dpr = $state(devicePixelRatioNow());
  let visible = $state(false); // intersecting the viewport (± rootMargin)

  // Non-reactive render bookkeeping: the size we last rendered at, and the
  // dirtyKey value that render reflects. Kept as plain (non-$state) fields
  // because writing them must NOT retrigger the effects that read the reactive
  // inputs — they record "what the current bitmap already represents".
  let renderedSize = null; // {w, h} device px of the current src, or null
  let renderedKey = Symbol("never"); // dirtyKey the current src reflects (never equals a real key at first)
  let settleTimer = 0;

  /** Query. The current devicePixelRatio (1 in non-browser test contexts). */
  function devicePixelRatioNow() {
    return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  }

  /** Pure function. The device-pixel size this tile should render at right now. */
  function targetSize() {
    return deviceSizeFor(cssW, aspect, dpr);
  }

  /**
   * Command. Is the tile dirty — does its current bitmap fail to reflect the
   * requested dirtyKey or the current displayed size? (Query over reactive
   * state + render bookkeeping; named "dirty" for the protocol.)
   */
  function isDirty() {
    return renderedKey !== dirtyKey || sizeChanged(renderedSize, targetSize());
  }

  /**
   * Command. Renders the tile now (visible + dirty path only) and records what
   * the resulting bitmap represents. Mutates src + render bookkeeping.
   * Async renderers: the bookkeeping is stamped immediately (the render is IN
   * FLIGHT — don't re-fire), and only the NEWEST in-flight result is adopted;
   * a rejection surfaces as an unhandled rejection (loud, caller's bug).
   */
  let renderSeq = 0;
  function renderNow() {
    const size = targetSize();
    const seq = ++renderSeq;
    renderedSize = size;
    renderedKey = dirtyKey;
    const result = render(size.w, size.h);
    if (result && typeof result.then === "function") {
      result.then((r) => {
        if (seq === renderSeq) src = toSrc(r);
      });
    } else {
      src = toSrc(result);
    }
  }

  /**
   * Command. The dirty-tracking gate: render iff visible AND dirty. Off-screen
   * or clean tiles do nothing (the stale image stays). Called whenever any
   * input (visibility, size, dpr, dirtyKey) changes.
   */
  function maybeRender() {
    if (!visible || cssW <= 0 || !isDirty()) return;
    renderNow();
  }

  // ── Measure displayed CSS width + resize-settle ─────────────────────────────
  // While the box is actively resizing we update cssW every frame (so the box
  // reserves the right height) but DEFER the re-render until the size holds
  // steady for settleMs — no per-frame repaint during a pane drag.
  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w === cssW) return;
      cssW = w;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(maybeRender, settleMs);
    });
    ro.observe(box);
    cssW = box.clientWidth;
    return () => {
      ro.disconnect();
      clearTimeout(settleTimer);
    };
  });

  // ── Visibility (lazy gate) ──────────────────────────────────────────────────
  $effect(() => {
    if (!box) return;
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        if (visible) maybeRender(); // became visible → catch up if dirty
      },
      { rootMargin },
    );
    io.observe(box);
    return () => io.disconnect();
  });

  // ── devicePixelRatio changes (moving a window between displays) ─────────────
  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      dpr = devicePixelRatioNow();
      maybeRender();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });

  // ── React to dirtyKey (and any reactive input) changes ──────────────────────
  // Reading dirtyKey here subscribes this effect to it; when a commit swaps the
  // key, every mounted tile runs maybeRender — visible ones repaint, off-screen
  // ones stay dirty until scrolled in. cssW/dpr/visible are read inside
  // maybeRender via isDirty()/targetSize(), so this also covers those.
  $effect(() => {
    dirtyKey; // subscribe
    maybeRender();
  });
</script>

<div class="di {klass}" bind:this={box} style="aspect-ratio: {1 / aspect};">
  {#if src}
    <img class="di-img" {src} {alt} draggable="false" />
  {/if}
</div>

<style>
  .di {
    /* --di-* themeable props; standalone fallbacks so it works with no host theme. */
    --di-bg: transparent;
    --di-radius: 0; /* square by default; rounding reads sloppy */

    display: block;
    width: 100%;
    background: var(--di-bg);
    border-radius: var(--di-radius);
    overflow: hidden;
  }

  .di-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill; /* box shape == render shape (aspect matched), so no distortion */
  }
</style>
