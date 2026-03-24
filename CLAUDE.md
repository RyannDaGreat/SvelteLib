# SvelteComponentPlayground

A GitHub library of reusable Svelte 5 components.

## Structure

```
src/lib/<Component>.svelte   — The components (what consumers import)
src/demos/<Component>/       — Demo for each component
  demo.html                    Entry HTML
  demo.js                     Mounts the Demo.svelte
  Demo.svelte                 Demo page with back-link to hub
index.html                   — Hub page listing all components
```

- `src/lib/` stays clean — just `.svelte` files, no demo cruft
- Each demo links back to the hub (`/`), hub links to each demo
- Vite auto-discovers demos via `src/demos/*/demo.html`

## Dev

- Svelte 5 + Vite
- `npm run dev` to start dev server
