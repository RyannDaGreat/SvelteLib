# ryohey/signal, vendored

The MIDI editor PowerRP's piano roll IS — not a lookalike. Built from
ryohey/signal and patched to be embeddable; see `PROVENANCE.txt` for the exact
commit and `LICENSE` (MIT) beside it.

## Why it lives in `web/public/` and not in `vendor/`

Every other vendored artifact in this app (`vendor/websurge/`) is reached by a
Vite `?url` import, because it is a MODULE or a BINARY that JavaScript loads.
This one is an **HTML PAGE loaded into an iframe**, which needs a stable URL that
exists identically in `npm run dev` and in the built bundle. `public/` is Vite's
one mechanism for exactly that: served at the app's base in dev, copied verbatim
into the build output. `/@fs/` was the alternative and is wrong here — Vite
TRANSFORMS HTML it serves, so the app would be framing a rewritten page rather
than the artifact that was tested.

## Do not edit anything here by hand

It is a build output. Changes belong in WebSurge's `patches/signal-embed.patch`,
which is where the embed seam (`ParentPortOutput`, `isEmbedded()`) is defined and
where the reasoning for it is written down.
