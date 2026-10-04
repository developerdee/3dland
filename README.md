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

## Using it

A new random world each time you load. Three modes, switchable by the buttons
top-left or the keyboard:

| Mode | What it's for |
| --- | --- |
| **Walk** | Held at eye height over the terrain. The default, and the point |
| **Fly** | Free movement in all three axes, for covering ground |
| **Overview** | Orbit the whole terrain. For inspecting and tuning it |

**On desktop:** click to capture the mouse, then WASD to move, mouse to look,
Space/C for vertical in fly mode, Shift to boost. <kbd>Esc</kbd> releases the
pointer. <kbd>G</kbd> / <kbd>F</kbd> / <kbd>O</kbd> switch modes.

**On touch:** a dial bottom-left moves you — it's analog, so a half-tilt walks
and a full tilt sprints. Drag anywhere else to look around. Two buttons
bottom-right climb and descend when flying. Both thumbs work at once.

The **detail** control at the top of the panel trades triangles for frame rate:

| Level | Mesh | Triangles |
| --- | --- | --- |
| low | 128² | 32k + ~2.4k props |
| medium | 256² | 130k + ~5.4k props |
| high | 512² | 523k + ~8.2k props |

Touch devices default to low, desktop to medium. The world is the same size at
every level — only the density changes.

The panel also tunes terrain shape, shading, sun angle and camera speed. Shading
and sun are uniform-only, so they apply instantly; terrain shape triggers a
rebuild (14ms at low, 190ms at high).

**New world** rerolls the seed. **Copy link to world** gives you a URL with
`?seed=` pinned, so a world worth keeping can be bookmarked or shared — and a
bug can be reproduced on the exact terrain that caused it.

### Terrain parameters

| Parameter | Effect |
| --- | --- |
| `amplitude` | Total height, in world units, peak to trough |
| `frequency` | Feature size — low is broad continents, high is busy hills |
| `exponent` | Above 1 flattens low ground and keeps peaks sharp |
| `ridged` | Folds troughs upward into sharp crests; mountainous |
| `octaves` | Noise layers summed. More detail, more time |
| `persistence` | How fast octaves fade. Low is smooth, high is rough |
| `lacunarity` | How fast octaves get finer. ~2 is conventional |
| `size` | World extent in units. Fly speed scales with it |
| `seed` | Any string. The same seed always rebuilds the same world |
| `island` | Terrain falls away to ocean at the edges |
| `coast width` | How much of the map the falloff occupies |
| `ocean depth` | How deep the sea floor drops at the edge |

The world is an island in open ocean. The travel limit sits a short wade beyond
the furthest shoreline, so you can walk into the shallows and stop there rather
than swimming to an invisible wall far out at sea.

Sea level is measured against the median height of the island's interior rather
than a fraction of the height range. The range's endpoints move with every
seed, so a fixed fraction flooded some islands and barely wet others; anchoring
to the median gives a comparable coastline every time — around 48% dry land,
with a standard deviation under 1%.

The defaults are tuned together: 90 units of relief over a 1000-unit world
reads as dramatic while keeping under 3% of the surface steeper than 45°, so
walking works nearly everywhere. Pushing amplitude or frequency much higher
makes it alpine and unpleasant on foot.

### Biomes

Five biomes — **aquatic**, **desert**, **grassland**, **forest**, **tundra** —
each with its own ground colours and vegetation density. Every one is
independently switchable, with its own share of the map and its own vegetation
multiplier.

Distribution follows altitude and moisture, which is how real biome maps work.
A second noise field supplies moisture; combined with height above the
shoreline it picks the biome, so wet lowlands become grassland, dry lowlands
desert, and high ground tundra — coherent regions without placing anything by
hand.

| Parameter | Effect |
| --- | --- |
| `biomes on` | All biome colouring and density, on or off |
| `region size` | Size of the moisture regions; lower is broader |
| `edge blend` | Softness of the transitions between biomes |
| per biome: `enabled` | Whether it appears at all |
| per biome: `share of map` | Its weight against the others |
| per biome: `vegetation` | Multiplies what grows there |

Classification scores every enabled biome and normalises, so the map is always
fully covered: disabling grassland widens its neighbours rather than leaving
bare patches.

Altitude is measured from the shoreline and rescaled against the land's own
range. Raw altitude is a poor classifier here because dry land occupies a
narrow slice of the full height range — measured at 0.37 to 0.98, with 59% of
it inside a single tenth — so niches spread over 0–1 would aim most of their
range at altitudes holding no land.

Biome colour replaces the ground tint but not rock or snow: exposed rock looks
the same whatever biome it is in, and a desert tint on the snowline looks
wrong.

### Vegetation parameters

Trees grow in **forests**, not scattered evenly: real distribution is driven by
where seeds land and survive, so it clusters. Six forests by default hold about
80% of the trees while covering a fifth of the map — roughly 4× the density of
the surrounding land.

**Forests**

| Parameter | Effect |
| --- | --- |
| `how many` | Number of forests |
| `size` / `size variation` | Mean radius, and how much individual forests differ |
| `tree spacing` | Metres between trees at the forest core |
| `edge roughness` | 0 is a circle; higher gives lobes and inlets |
| `edge fade` | How far the canopy thins toward the boundary |

Forests are sited where woodland actually grows: gentle to moderate slopes,
rolling ground, valleys and basins where soil and water collect. Candidates are
scored on slope, altitude and how much of a hollow they sit in, and the best are
kept — so forests appear in valleys rather than wherever the first valid sample
landed. They also keep their distance from one another, though a little overlap
is allowed so neighbouring woods can merge.

**Forests are always walkable.** Tree centres are never closer than 3 units,
which leaves a 1.8-unit gap against a 0.84-unit body — more than double what is
needed. This is a hard floor in the code, not a slider: however far `tree
spacing` is pushed down, an impassable forest cannot be generated.

**Lone trees**

| Parameter | Effect |
| --- | --- |
| `show lone trees` | Isolated trees between forests, on or off |
| `density` | How many — independent of forest density |

Lone trees are rejected inside a forest boundary, so they read as genuinely
isolated rather than as a halo around the woodland. Turning forests off
therefore yields slightly more lone trees, since that rejection no longer
applies.

**Tree limits (both)** holds the treeline and maximum slope. These apply to
every tree, in a forest or alone — a treeline is a property of the climate, not
of a tree's sociability — so they sit apart from either group rather than
inside one and silently affecting both.

**Rocks and shrubs** are scattered across the whole map as before.

Forests and lone trees are independently switchable, and their densities are
separate controls: `tree spacing` inside a forest, `density` for lone trees.
The detail setting still scales everything globally as the performance dial.

Around 6,000 trees at medium detail, drawn in 8 draw calls — `InstancedMesh`
renders many copies of one geometry at once, so thousands of trees cost about
what one tree costs in CPU overhead. The `density` slider widens forest spacing
rather than deleting trees at random, so lower settings give an evenly sparser
wood instead of a moth-eaten one.

The prop meshes are built in code, not loaded — no assets, no download, and a
variant is a parameter rather than another file.

### Collision

Solid in every mode: the ground is a floor you cannot pass through, the world
edge is a wall, and tree trunks and boulders block you. Flying still takes you
up and over mountains freely — you simply cannot fly inside one, and flying
into a slope rides you up it rather than stopping dead.

Collision volumes are upright cylinders, not meshes. A trunk is narrower than
its canopy, deliberately: matching the silhouette would make woodland feel like
a maze of invisible walls. Shrubs do not block at all — stopping dead at
knee-high scrub feels broken rather than realistic.

Props are indexed into a uniform grid, so a check touches only the handful of
obstacles in neighbouring cells rather than all 2,900. Measured at 0.38µs per
resolve, against a 16,700µs frame budget.

There is a **collision** switch under Display for inspecting the world
unobstructed; the HUD shows `noclip` while it is off.

### Water parameters

| Parameter | Effect |
| --- | --- |
| `enabled` | Water on or off entirely |
| `sea level` | Surface height, as a fraction of the terrain's range |
| `shallow` / `deep` | Colour at the shore and in deep water |
| `depth fade` | How quickly deep colour takes over, in world units |
| `wave height` / `scale` / `speed` | Ripple size, choppiness and rate |
| `reflectivity` | Strength of the mirrored sky on the surface |
| `foam width` | Width of the surf band at the shoreline |

The default sea level submerges about 22% of an average world, though it varies
widely between seeds — some get islands, others inland lakes. The curve is
steep because the terrain's `exponent` flattens low ground: 0.34 leaves
puddles, 0.50 floods nearly half the map.

In walk mode you wade into the shallows and stop, rather than strolling along
the seabed. The sand band in the shading tracks sea level automatically, so
beaches stay at the waterline when you move it.

### Shading parameters

| Parameter | Effect |
| --- | --- |
| `rock line` / `snow line` | Altitude (0-1 of range) where each material starts |
| `shore line` | Altitude below which ground reads as sand |
| `slope rock from` / `full` | Steepness at which rock breaks through, regardless of height |
| `band blend` | Softness of the transitions; 0 gives hard bands |
| `colour variation` | Noise that breaks up flat colour |
| `azimuth` / `elevation` | Sun direction, in degrees |
| `shadows` | off / low / medium / high |

Slope is the input altitude cannot give you: a cliff and a meadow at the same
height should not look alike. It comes from the surface normals, read per-pixel
in the fragment shader.

## Layout

```
index.html                  page shell: canvas, HUD, mode hint
src/main.ts                 scene assembly and entry point
src/engine/Viewer.ts        renderer, camera, resize handling, render loop
src/engine/FlyControls.ts   pointer-lock mouse look, WASD, ground following
src/engine/CameraModes.ts   orbit/fly/walk switching, kept continuous
src/engine/TouchControls.ts on-screen twin sticks for touch devices
src/engine/ModeButtons.ts   on-screen mode switcher
src/engine/Collision.ts     terrain, world-edge and prop collision
src/engine/Shadows.ts       sun shadows, with the map following the viewer
src/engine/Sky.ts           gradient sky dome, follows the camera
src/terrain/heightmap.ts    noise -> heights (the generation maths)
src/terrain/TerrainMesh.ts  heights -> renderable geometry
src/terrain/TerrainMaterial.ts  slope/altitude shading (GLSL injection)
src/terrain/Water.ts        animated water, depth from a heightmap texture
src/terrain/biomes.ts       biome classification by altitude and moisture
src/terrain/forests.ts      forest siting and irregular boundaries
src/terrain/surface.ts      slope sampling, shared by placement and forests
src/terrain/placement.ts    where props go: density, slope and altitude rules
src/terrain/props.ts        procedural low-poly tree, rock and shrub geometry
src/terrain/Scatter.ts      instanced rendering of the placements
src/terrain/random.ts       seeded PRNG, for reproducible worlds
src/terrain/gui.ts          lil-gui parameter panel
src/style.css               page and HUD styling
docs/TUTORIAL.md            stack explainer for newcomers to 3D/JS tooling
vite.config.ts              dev vs. production base path, build options
tsconfig.json               strict TypeScript settings
```

`Viewer` owns the plumbing every stage needs. Feature code touches it through
two things only: add objects to `viewer.scene`, and register per-frame work with
`viewer.onUpdate(fn)` — which receives `dt`, the seconds elapsed since the last
frame. Scale any rate of change by `dt`, or motion speed will vary with the
viewer's refresh rate.

The intent is that stages 2 onward add modules without modifying `Viewer`.

## Stages

- [x] **1 — Scaffold.** Vite + TS + Three, render loop, FPS readout, CI deploy.
- [x] **2 — Terrain.** Seeded fBm heightmap, vertex colours, debug GUI, orbit
      controls, sky and fog.
- [x] **3 — Camera.** Pointer-lock fly and walk modes, with mode switching.
- [x] **4 — Shading.** Slope/altitude materials, gradient sky, fog, tone mapping.
- [x] **5a — Water.** Depth-based colour, waves, Fresnel reflection, shore foam.
- [x] **5b — Scatter.** Instanced trees, rocks and shrubs placed by rule.
- [x] **6 — Collision.** Solid ground, world edges, trees and rocks.
- [x] **7 — Shadows.** Sun shadows with a viewer-following shadow map.
- [x] **8 — Forests.** Clustered woodland with irregular, walkable boundaries.
- [x] **9 — Island.** Terrain falls away to open ocean; travel limit offshore.
- [x] **10 — Biomes.** Five configurable biomes by altitude and moisture.
- [ ] **Chunking.** Terrain tiles with LOD, for a world without edges.


Shading is per-pixel in the fragment shader, injected into Three's standard
material so physically-based lighting, fog and tone mapping come for free.
