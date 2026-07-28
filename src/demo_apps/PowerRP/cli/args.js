/**
 * The CLI argument parser, shared by cli/render.js and cli/render_job.js.
 *
 * It lives in its own module rather than in render.js because the two entry
 * points now have very different weights: render.js pulls the whole bare-node
 * Skia stack (node_render.js `require`s the canvaskit-wasm binary at module
 * load), while render_job.js drives a browser and needs none of it. Importing
 * one function from the other would have loaded a WASM runtime into every
 * render worker for the sake of twelve lines of string handling.
 *
 * DOM-free and dependency-free: runnable in bare node.
 */

/**
 * Pure function. Parses `[<positional>…, --flag value …]` into positionals +
 * flags. Flag values are coerced with Number EXCEPT the ones named in
 * `stringFlags`, which stay strings — a `--quality proxy` coerced to NaN would
 * be a silently ignored request.
 *
 * @param {string[]} argv Args after the script name (process.argv.slice(2)).
 * @param {Set<string>} stringFlags Flag names whose value must NOT be coerced.
 * @returns {{positional: string[], flags: Object<string, number|string>}}
 *
 * @example parseArgs(["d.json", "o.png", "--slide", "2", "--alpha", "0.5"]) // {positional: ["d.json", "o.png"], flags: {slide: 2, alpha: 0.5}}
 * @example parseArgs(["d.json", "o.png", "--quality", "proxy"], new Set(["quality"])) // {positional: ["d.json", "o.png"], flags: {quality: "proxy"}}
 * @example parseArgs(["job"], new Set()) // {positional: ["job"], flags: {}}
 */
export function parseArgs(argv, stringFlags = new Set(["quality"])) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const name = argv[i].slice(2);
      const raw = argv[++i];
      flags[name] = stringFlags.has(name) ? raw : Number(raw);
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}
