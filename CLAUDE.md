# SvelteComponentPlayground

A GitHub library of reusable Svelte 5 components.

## Structure

```
src/lib/<Component>.svelte   — The components (what consumers import)
src/styles/theme.css         — Unified dark theme for all demos
src/demos/<Component>/       — Demo for each component
  demo.html                    Entry HTML
  demo.js                     Imports theme.css, mounts Demo.svelte
  Demo.svelte                 Demo page using theme classes
index.html                   — Hub page listing all components
public/videos/               — Test video assets (gitignored)
```

- `src/lib/` stays clean — just `.svelte` files, no demo cruft
- Each demo links back to the hub (`/`), hub links to each demo
- Vite auto-discovers demos via `src/demos/*/demo.html`
- Unified theme: demos use classes from `theme.css` (`.demo-page`, `.demo-frame`, `.demo-hint`, `.demo-back`, `.demo-controls`, `.demo-label`) — no per-demo CSS for common layout
- Components style themselves internally (scoped `<style>`) and don't depend on the theme
- Icons: `iconify-icon` web component (npm), `import 'iconify-icon'` in components that need icons

## Dev

- Svelte 5 + Vite
- `npm run dev` to start dev server
