# 3dland

A browser-based 3D landscape, built in stages. Possibly the basis of a game.

**Live:** https://developerdee.github.io/3dland/

## Stack

- **TypeScript** — strict mode, for the vector/matrix-heavy code ahead
- **Three.js** — WebGL rendering (WebGL2 via `WebGLRenderer`)
- **Vite** — dev server with HMR, and the production build
- **GitHub Pages** — deployed from `main` by `.github/workflows/deploy.yml`

Three.js is used directly rather than through React Three Fiber: a game loop
wants imperative control of per-frame work, without a reconciler in between.
React may come later for menus and HUD only.

New to this stack? [`docs/TUTORIAL.md`](docs/TUTORIAL.md) explains it from the
ground up — how 3D rendering works, what each tool does, and a walkthrough of
this codebase — for a technical reader who hasn't used these technologies.

## Requirements

- **Node.js 20 or newer** (built and CI-tested on 22; developed on 24).
  Check with `node --version`. If you need to install or manage versions,
  [nvm](https://github.com/nvm-sh/nvm) is the usual tool.
- **npm 10 or newer** — ships with Node. Check with `npm --version`.
- **A browser with WebGL2** — any current Chrome, Firefox, Safari or Edge.
  Visit [webglreport.com](https://webglreport.com/?v=2) if you need to confirm.
- **git**, to clone.

No GPU beyond what the browser already uses, and no global installs: every tool
this project needs is a local dev dependency.

## Setup

```bash
git clone https://github.com/developerdee/3dland.git
cd 3dland
npm install
```

`npm install` reads `package.json` and `package-lock.json` and populates
`node_modules/` (26 packages, a few seconds). You only need to re-run it when
dependencies change — for example after pulling a commit that touches
`package.json`.

## Running the dev server

```bash
npm run dev
```

Then open **http://localhost:5173**. You should see a blue cube rotating on a
grid, with an FPS readout in the top-left corner.

The server keeps running and holds that terminal — it is not a command that
finishes. Leave the window open and **open a second terminal** for git, builds
and anything else.

**To stop it: press `Ctrl+C` in that same window.**

Edits to files under `src/` appear in the browser almost immediately, without a
reload, via hot module replacement. Two exceptions need a restart:
`vite.config.ts` and `package.json`.

### If the server won't stop, or the port is taken

`npm run dev` spawns a child `vite` process. If the parent is killed in a way
that orphans the child (which happens when backgrounding it, rather than using
`Ctrl+C`), vite keeps running and keeps port 5173:

```bash
lsof -i:5173              # check what is listening
kill $(lsof -ti:5173)     # stop it
```

Note that an already-open browser tab keeps rendering the scene after the server
dies, because the JavaScript is loaded and running client-side. Reload the tab to
see whether the server is genuinely up.

## Other commands

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server with hot reload, on port 5173 |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run preview` | Serve the built `dist/` on port 4173 |
| `npm run typecheck` | Types only, no build — fast correctness check |

`npm run build` runs `tsc --noEmit` first, so a type error fails the build
rather than shipping. The same command runs in CI, which is what gates deploys.

Use `npm run preview` when you want to check the production build specifically —
minification and the `/3dland/` base path are only exercised there, not in dev.
Note it serves on **4173**, a different port from the dev server, so both can
run at once. `Ctrl+C` stops it the same way.

## Deploying

Pushing to `main` triggers `.github/workflows/deploy.yml`, which typechecks,
builds, and publishes `dist/` to GitHub Pages. No manual step; takes about 30
seconds. Check progress with `gh run list` or the repo's Actions tab.

If a deploy fails, it is most often a type error — reproduce it locally with
`npm run typecheck`.

### Forking this

The `base` path in `vite.config.ts` is hardcoded to `/3dland/`, because GitHub
Pages serves project sites from a subdirectory. If you fork under a different
repo name, change it to match, or built asset URLs will 404 on the deployed
site while working fine in dev.

## Layout

```
index.html             page shell: canvas and HUD
src/main.ts            scene assembly and entry point
src/engine/Viewer.ts   renderer, camera, resize handling, render loop
src/style.css          page and HUD styling
docs/TUTORIAL.md       stack explainer for newcomers to 3D/JS tooling
vite.config.ts         dev vs. production base path, build options
tsconfig.json          strict TypeScript settings
```

`Viewer` owns the plumbing every stage needs. Feature code touches it through
two things only: add objects to `viewer.scene`, and register per-frame work with
`viewer.onUpdate(fn)` — which receives `dt`, the seconds elapsed since the last
frame. Scale any rate of change by `dt`, or motion speed will vary with the
viewer's refresh rate.

The intent is that stages 2 onward add modules without modifying `Viewer`.

## Stages

- [x] **1 — Scaffold.** Vite + TS + Three, render loop, FPS readout, CI deploy.
- [ ] **2 — Terrain.** Heightmap from seeded noise, with a debug GUI for params.
- [ ] **3 — Camera.** Orbit controls, then first-person / fly navigation.
- [ ] **4 — Shading.** Slope- and altitude-based materials, lighting, sky, fog.
- [ ] **5 — Scale.** Water plane; chunked terrain with LOD for large worlds.
- [ ] **6 — Interaction.** Terrain collision and character movement.

Everything in the current scene except the FPS counter is placeholder, and gets
replaced in stage 2.
