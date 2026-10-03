# 3dland

A browser-based 3D landscape, built in stages. Possibly the basis of a game.

## Stack

- **TypeScript** — strict mode, for the vector/matrix-heavy code ahead
- **Three.js** — WebGL rendering
- **Vite** — dev server with HMR, and the production build
- **GitHub Pages** — deployed from `main` by `.github/workflows/deploy.yml`

Three.js is used directly rather than through React Three Fiber: a game loop
wants imperative control of per-frame work, without a reconciler in between.
React may come later for menus and HUD only.

## Running locally

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | Does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run preview` | Serve the built output locally |
| `npm run typecheck` | Types only, no build |

## Layout

```
index.html           page shell and canvas
src/main.ts          scene assembly and entry point
src/engine/Viewer.ts renderer, camera, resize handling, render loop
src/style.css        page and HUD styling
```

`Viewer` owns everything every stage needs; feature code adds objects to
`viewer.scene` and registers per-frame work with `viewer.onUpdate()`.

## Stages

- [x] **1 — Scaffold.** Vite + TS + Three, render loop, FPS readout, CI deploy.
- [ ] **2 — Terrain.** Heightmap from seeded noise, with a debug GUI for params.
- [ ] **3 — Camera.** Orbit controls, then first-person / fly navigation.
- [ ] **4 — Shading.** Slope- and altitude-based materials, lighting, sky, fog.
- [ ] **5 — Scale.** Water plane; chunked terrain with LOD for large worlds.
- [ ] **6 — Interaction.** Terrain collision and character movement.
