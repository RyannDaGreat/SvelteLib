# Frontend CSS rules (demo_app/web)

These rules are specific to this app's frontend and are enforced.

## One centralized stylesheet

- **All styling for the app components lives in `app.css`.** The `.svelte`
  components here (`App`, `ThumbList`, `VideoPane`) carry **no `<style>` block** —
  they only emit class names that `app.css` targets.
- Reusable library components under `src/lib/` are exempt: they keep their own
  scoped `<style>` (they're shared, not app-specific). `app.css` styles only the
  app shell, and themes the library components via their documented CSS custom
  properties (e.g. `--sp-handle-color`).

## No magic values — everything is a named token

- Every color, size, spacing, radius, opacity, font-size, and mix-percentage is
  a named custom property declared in `:root` in `app.css`. **Do not inline a
  literal** like `rgba(0,0,0,0.75)`, `28px`, or `50%` — define a token and use it.
- **Degenerate values may stay bare:** `0`, `1`, `100%`, `white`, `black`,
  `transparent`, and `1px` hairlines. Anything else (e.g. `50%`, `8px`, a hex
  color) must be a token.
- **Reuse, never duplicate.** If two rules need the same value, they reference
  the same token. Spacing comes from the `--a-sp-*` scale.

## Token naming

App-specific tokens are prefixed `--a-` (e.g. `--a-good`, `--a-sp-4`,
`--a-glow-blur`). Tokens already provided by `theme.css` (`--bg`, `--fg`,
`--fg-dim`, `--border`, `--radius`, `--accent`, `--control-bg`) are reused as-is,
not redefined.

## Why

One source of truth for the look, trivial re-theming, and no drift between
copy-pasted values. A reviewer can audit `app.css` alone.
