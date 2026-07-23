/**
 * fileSize.js — human-readable byte-size formatting, a faithful JS port of
 * rp.human_readable_file_size (rp/r.py in the `rp` library the project owner
 * maintains). DEV-TIME REFERENCE ONLY: the Python is never imported at runtime;
 * this pure helper reproduces rp's exact output so the upload-progress overlay
 * reads e.g. "9.5MB / 25.8MB" exactly as rp would print it.
 *
 * rp's algorithm (verbatim): walk a unit ladder dividing by `divisor` while the
 * magnitude is >= the divisor; print a WHOLE number with no decimal ("1KB") and
 * a fractional one with exactly one decimal ("1.0KB", "976.6KB"). `mib` picks
 * the base: 1024 (default — KiB/MiB sizing relabeled as KB/MB, rp's default) or
 * 1000 (decimal/metric, matching Finder/Google).
 */

// Unit ladder, ascending. Long enough for any real file; a size beyond it is
// not a file (rp itself falls through to None there — see the clamp below).
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
const BINARY_DIVISOR = 1024; // rp mib=True: binary sizing, KB/MB labels
const DECIMAL_DIVISOR = 1000; // rp mib=False: decimal/metric (Finder/Google)

/**
 * Pure function. Human-readable size of `bytes`, byte-for-byte matching
 * rp.human_readable_file_size: whole magnitudes print with no decimal, others
 * with exactly one; units climb while |size| >= divisor. Default `mib=true`
 * reproduces rp's default (1024-based); `mib=false` is decimal.
 *
 * @param {number} bytes - Size in bytes (>= 0 for file sizes).
 * @param {boolean} [mib=true] - 1024-based (rp default) when true; 1000-based when false.
 * @returns {string} the formatted size, e.g. "0B", "1023B", "1KB", "9.5MB".
 *
 * @example humanReadableFileSize(0)             // "0B"
 * @example humanReadableFileSize(100)           // "100B"
 * @example humanReadableFileSize(1023)          // "1023B"
 * @example humanReadableFileSize(1024)          // "1KB"
 * @example humanReadableFileSize(1025)          // "1.0KB"
 * @example humanReadableFileSize(1000000)       // "976.6KB"
 * @example humanReadableFileSize(10000000)      // "9.5MB"
 * @example humanReadableFileSize(1000000000)    // "953.7MB"
 * @example humanReadableFileSize(10000000000)   // "9.3GB"
 * @example humanReadableFileSize(1000000, false)    // "1MB"   (decimal)
 * @example humanReadableFileSize(27100000, false)   // "27.1MB" (decimal)
 */
export function humanReadableFileSize(bytes, mib = true) {
  const divisor = mib ? BINARY_DIVISOR : DECIMAL_DIVISOR;
  let size = bytes;
  for (const unit of UNITS) {
    if (size > -divisor && size < divisor) {
      return Number.isInteger(size) ? `${size}${unit}` : `${size.toFixed(1)}${unit}`;
    }
    size /= divisor;
  }
  // Past yottabytes — not a real file size. rp falls through to None here; we
  // clamp to the last unit instead so a caption string never becomes "undefined".
  return `${size.toFixed(1)}${UNITS[UNITS.length - 1]}`;
}
