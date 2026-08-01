# PowerRP built-in 3D models (committed, offline)

The `scene3d_model` widget's shipped example. Committed for the same reason
`fonts/README.md` gives for the typefaces and `../splats/README.md` gives for the
splat sample: **the app must work with no internet**, and a viewer whose only
subjects live on a remote host is a viewer that shows nothing on a plane.

It is also what keeps the test gate OFFLINE-CLEAN. `tests/scene3d_probe.js`
renders this file, so proving that the glTF path works costs the gate no network
request — a gate that needs the internet is a gate that goes red for reasons that
have nothing to do with the code. Every OTHER model the widget offers is a preset
pointing at a URL (see `plugins/demo/scene3d.js`), verified once by hand and
listed there with its own licence.

**Do NOT delete this file.**

| file | bytes | source | licence |
|---|---|---|---|
| `clearcoat-car-paint.glb` | 116,948 | [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets), `Models/ClearCoatCarPaint/glTF-Binary/ClearCoatCarPaint.glb` | **CC0 1.0 Universal** — © 2023, Public; "Eric Chadwick for Everything", read off that model's own `README.md` Legal section, not inferred from the repository |

## Why this model and not a more famous one

It is the smallest CC0 `.glb` in the Khronos set that still exercises a real
material (a flake-and-clearcoat automotive finish over metal), so it proves the
loader, the light rig and the tone mapping in 117 KB.

**DamagedHelmet — the model everyone reaches for first — is NOT usable here.** Its
own `README.md` carries two attributions and the second is CC BY-NC 4.0
("theblueturtle\_ for Earlier version of model"): the 2018 rebuild is CC-BY but is
a derivative of a NonCommercial work. Sponza is under the Cryengine Limited
Licence, the Stanford scans are NonCommercial *and* NoDerivs, and Duck is
SCEA-licensed. None of those may be committed or shipped.
