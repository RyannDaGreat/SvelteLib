# PowerRP built-in Gaussian-splat scenes (committed, offline)

These files ARE the splat scenes PowerRP ships with. They are committed on
purpose, on the same argument `fonts/README.md` makes for the typefaces: the app
must work with **no internet**, and R6-1.9 is explicit that a splat widget with no
example scene is a widget nobody can try. **Do NOT delete them.**

## Files

| file | bytes | splats | source | licence |
|---|---|---|---|---|
| `spz-test-scene.ply` | 144,648 | 1,566 | [`nianticlabs/spz`](https://github.com/nianticlabs/spz) — the SPZ format author's own repository, `test/data/combined_SPZv3` | **MIT**, Copyright (c) 2024 Niantic, Inc. — see [LICENSE-spz.txt](./LICENSE-spz.txt) |

## What this file is, and what it is NOT

`spz-test-scene.ply` is the SPZ round-trip **test fixture**: a small arrangement
of coloured Gaussians in the standard INRIA `.ply` layout. It renders correctly,
it is real splat data in the real format, and at 141 KB it decodes fast enough to
sit inside a browser probe (`tests/scene3d_probe.js` uses it as its subject).

It is **not a photographic capture**, so it does not yet satisfy the half of
R6-1.9 that wants "a real example … otherwise nobody can play with the demo
widget". Two candidates were measured and are ready to add the moment the size is
approved — both LOAD correctly in the shipped reader, verified first-hand:

| candidate | bytes | licence | note |
|---|---|---|---|
| `hornedlizard.spz` | 18,143,098 | MIT (same `nianticlabs/spz` repo) | 786,233 splats, a real object capture. Loads. |
| `FirePit.splat` | 16,003,424 | CC0 (bare tag only — weaker provenance than the MIT above) | the only genuinely CC0 splat W1-J's survey found anywhere |

For scale: `fonts/` already commits ~40 MB of licensed binaries on the offline
argument, and the whole repository packs to 33 MB today.

## Which formats the shipped reader actually accepts

Measured against `@sparkjsdev/spark` 2.1.0 on 2026-08-01, not taken from a spec.
This is the list `plugins/demo/scene3d.js`'s `src` help repeats to the user:

| format | result |
|---|---|
| `.ply` (INRIA, the standard training output) | **loads** |
| `.ply` (PlayCanvas compressed) | **loads** |
| `.splat` (antimatter15) | **loads** |
| `.spz` **version 3**, gzip-framed | **loads** |
| `.spz` **version 4** | REFUSED — `Unsupported SPZ version: 4` |
| `.spz` uncompressed (starts `NGSP`, no gzip header) | REFUSED — `Invalid gzip header` |
| `.sog` / SOGS bundle | REFUSED — `Failed to parse meta.json for SOGS` |

The last three matter because the round-6 research recommended `.sog` as the
delivery format and named an `.spz` scene as a ship candidate; the reader
disagrees, and the reader is the authority.
