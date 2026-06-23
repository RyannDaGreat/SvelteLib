/**
 * segments.js — pure interval algebra for labelled time ranges.
 *
 * A "segment" is { start, end, label } in seconds. `label` is an ARBITRARY
 * string — these helpers never assume specific values; they only group/merge by
 * equality. (The annotator UI currently uses 'good'/'bad', but the model is
 * label-agnostic, so adding more labels needs no change here.) A segment list is
 * kept sorted and disjoint (normalised). No I/O, no state — all pure & reusable.
 */

const EPS = 1e-6;

/**
 * Pure function, general. Clamp value to [min, max].
 *
 * @example clamp(5, 0, 10) // 5
 * @example clamp(-3, 0, 10) // 0
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pure function, general. Remove the time range [lo, hi] from every segment,
 * clipping any that straddle it. Segments keep their labels.
 *
 * @param {{start:number,end:number,label:string}[]} segs
 * @returns {{start:number,end:number,label:string}[]}
 *
 * @example
 * // subtractRange([{start:0,end:10,label:'good'}], 4, 6)
 * // -> [{start:0,end:4,label:'good'}, {start:6,end:10,label:'good'}]
 */
export function subtractRange(segs, lo, hi) {
  const out = [];
  for (const s of segs) {
    if (s.end <= lo || s.start >= hi) {
      out.push(s);
      continue;
    }
    if (s.start < lo) out.push({ start: s.start, end: lo, label: s.label });
    if (s.end > hi) out.push({ start: hi, end: s.end, label: s.label });
  }
  return out;
}

/**
 * Pure function, general. Sort segments and merge ones that touch or overlap
 * and share a label, yielding a disjoint, normalised list.
 *
 * @example
 * // mergeSegments([{start:2,end:4,label:'good'},{start:0,end:2,label:'good'}])
 * // -> [{start:0,end:4,label:'good'}]
 */
export function mergeSegments(segs) {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out = [];
  for (const seg of sorted) {
    const last = out[out.length - 1];
    if (last && last.label === seg.label && seg.start <= last.end + EPS) {
      last.end = Math.max(last.end, seg.end);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/**
 * Pure function, general. Apply one paint stroke to a segment list.
 * 'good'/'bad' overwrite the range with that label; 'erase' clears it.
 * A zero-width stroke is a no-op (so a plain click only scrubs).
 *
 * @param {{start:number,end:number,label:string}[]} segs
 * @param {'good'|'bad'|'erase'} mode
 * @param {number} a - stroke endpoint (s)
 * @param {number} b - stroke endpoint (s)
 *
 * @example
 * // paintSegments([], 'good', 5, 2) -> [{start:2,end:5,label:'good'}]
 * // paintSegments([{start:0,end:10,label:'good'}], 'erase', 3, 6)
 * //   -> [{start:0,end:3,label:'good'},{start:6,end:10,label:'good'}]
 */
export function paintSegments(segs, mode, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi - lo < EPS) return segs;
  const cleared = subtractRange(segs, lo, hi);
  if (mode === "erase") return mergeSegments(cleared);
  cleared.push({ start: lo, end: hi, label: mode });
  return mergeSegments(cleared);
}

/**
 * Pure function, general. Label of the segment containing t, or null.
 *
 * @example
 * // labelAt([{start:0,end:5,label:'bad'}], 3) -> 'bad'
 * // labelAt([{start:0,end:5,label:'bad'}], 7) -> null
 */
export function labelAt(segs, t) {
  for (const s of segs) if (t >= s.start && t < s.end) return s.label;
  return null;
}

/**
 * Pure function, general. From segments of one label (sorted, disjoint), find
 * where playback should be at time t: the segment containing t, else the next
 * one after t, else null (nothing left to play).
 *
 * @example
 * // segmentToPlay([{start:2,end:4,label:'good'}], 1) -> {start:2,end:4,...}
 * // segmentToPlay([{start:2,end:4,label:'good'}], 3) -> {start:2,end:4,...}
 * // segmentToPlay([{start:2,end:4,label:'good'}], 5) -> null
 */
export function segmentToPlay(allowed, t) {
  let next = null;
  for (const s of allowed) {
    if (t >= s.start && t < s.end) return s;
    if (s.start > t && (next === null || s.start < next.start)) next = s;
  }
  return next;
}
