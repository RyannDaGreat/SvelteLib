# SvelteComponentPlayground

A GitHub library of reusable Svelte 5 components.

## Structure

- `index.html` — Hub page listing all components with links to their demos
- `src/lib/<ComponentName>/` — Each component gets its own folder
  - `<ComponentName>.svelte` — The component itself
  - `demo.html` — Standalone demo page showing basic usage
- Every demo page links back to the hub (`index.html`)

## Dev

- Svelte 5 + Vite
- `npm run dev` to start dev server
