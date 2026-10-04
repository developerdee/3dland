# 3dland: A Tutorial for the Curious Engineer

This document explains the technology behind `3dland` for someone who is
technically competent but hasn't worked with JavaScript tooling, TypeScript, or
3D graphics. It assumes you understand programming — variables, functions,
types, compilers, the shape of a build pipeline — but not this particular
corner of the world.

It is written to be read in order. Each section builds on the previous one.

---

## Table of contents

1. [The problem we're solving](#1-the-problem-were-solving)
2. [How 3D graphics actually work](#2-how-3d-graphics-actually-work)
3. [WebGL, and why we don't use it directly](#3-webgl-and-why-we-dont-use-it-directly)
4. [Three.js: the five concepts you need](#4-threejs-the-five-concepts-you-need)
5. [The render loop](#5-the-render-loop)
6. [JavaScript, TypeScript, and why we chose the latter](#6-javascript-typescript-and-why-we-chose-the-latter)
7. [npm and `package.json`](#7-npm-and-packagejson)
8. [Vite: the dev server and the build](#8-vite-the-dev-server-and-the-build)
9. [Reading our actual code](#9-reading-our-actual-code)
10. [Deployment: CI and GitHub Pages](#10-deployment-ci-and-github-pages)
11. [The dev server lifecycle](#11-the-dev-server-lifecycle)
11a. [How the terrain actually works](#11a-how-the-terrain-actually-works)
11b. [First-person camera control](#11b-first-person-camera-control)
11c. [Shading: slope, altitude, and injecting GLSL](#11c-shading-slope-altitude-and-injecting-glsl)
11d. [Touch controls and input abstraction](#11d-touch-controls-and-input-abstraction)
11e. [Water](#11e-water)
11f. [Scatter: placing thousands of objects](#11f-scatter-placing-thousands-of-objects)
11g. [Collision](#11g-collision)
11h. [Shadows](#11h-shadows)
11i. [Forests: clustering, and a constraint that cannot be violated](#11i-forests-clustering-and-a-constraint-that-cannot-be-violated)
11j. [Islands and biomes](#11j-islands-and-biomes)
12. [Where this goes next](#12-where-this-goes-next)
13. [Glossary](#13-glossary)

---

## 1. The problem we're solving

We want a 3D landscape that runs inside a web browser, with no plugin and no
install. Someone opens a URL and they're standing in a world.

That constraint — *the browser* — drives nearly every decision that follows.
A browser gives us a sandboxed environment where the only languages that run
natively are JavaScript and WebAssembly, and the only way to talk to the
graphics card is through a browser API called WebGL (or its successor, WebGPU).
Everything else in this document is a consequence of working inside those
limits.

---

## 2. How 3D graphics actually work

If you've never done graphics work, the mental model is worth building properly,
because every library you'll touch is a thin dressing over these ideas.

### Everything is triangles

A 3D object is a bag of **vertices** (points in space, each an x/y/z
coordinate) connected into **triangles**. A cube is 8 vertices forming 12
triangles — two per face. A detailed character model is hundreds of thousands of
them. Triangles specifically, because three points always define a flat plane,
which makes the maths unambiguous and the hardware simple.

A terrain heightmap, which is where we're heading, is a grid of vertices where
only the height varies:

```
    y (height)
    │     ___
    │   _/   \__
    │  /        \___
    └──────────────────> x
```

Lay that out as a grid in x and z, give each point a y from a noise function,
and you have a landscape. That's genuinely all terrain generation is — the art
is entirely in choosing the function.

### The pipeline

To get from "a list of triangles" to "pixels on screen", the GPU runs a
pipeline. Simplified:

1. **Vertex processing.** Every vertex is transformed from its own local
   coordinates into screen coordinates. This is matrix multiplication — object
   position, then camera position, then perspective projection, as three
   matrices multiplied together. The GPU does this for a million vertices in
   parallel without complaint.
2. **Rasterisation.** The hardware works out which screen pixels each triangle
   covers.
3. **Fragment processing.** For every covered pixel, a program computes its
   colour, accounting for lights, textures, and material properties.
4. **Output.** Pixels are written to a buffer, with a depth test so nearer
   triangles correctly hide farther ones.

The small programs in steps 1 and 3 are called **shaders**, and they run *on the
GPU*, written in a C-like language (GLSL). They are not JavaScript and they
cannot call your JavaScript. This is the single most important thing to
understand about graphics programming: your code and the GPU's code live in
separate worlds, and the only conversation they have is you uploading data
before the frame starts.

### Why it must be fast

For motion to feel smooth, you need 60 frames per second. That's **16.7
milliseconds per frame** for everything: your game logic, your scene updates,
and the entire pipeline above. Miss it and the user feels judder immediately.

That budget is why our `Viewer` class caps the pixel ratio, and why the FPS
counter was in stage 1 rather than bolted on later. In graphics, performance
isn't a polish task you defer — it's a constraint you design against from the
first commit.

---

## 3. WebGL, and why we don't use it directly

**WebGL** is the browser's API for talking to the GPU. It's a JavaScript binding
over OpenGL ES, and it is *brutally* low-level. Here is roughly what drawing a
single triangle requires:

```javascript
// Compile a vertex shader from source, check it compiled
// Compile a fragment shader from source, check it compiled
// Link them into a program, check it linked
// Allocate a buffer, bind it, upload the vertex array
// Describe the buffer's memory layout: stride, offset, type
// Look up each uniform's location by name
// Build your own projection and view matrices by hand
// Upload each matrix as a flat 16-float array
// Bind, set state, draw, unbind
```

That's a few hundred lines for one triangle, and you haven't got lighting, a
camera you can move, or a loaded model. WebGL is an excellent *target* and a
miserable *authoring environment* — much like writing a web app directly against
TCP sockets.

So we use a library. The main options:

| Library | Character | Verdict for us |
| --- | --- | --- |
| **Three.js** | General-purpose 3D, enormous ecosystem | **Chosen** |
| **Babylon.js** | Full game engine, more batteries, heavier | Viable, more to learn |
| **PlayCanvas** | Engine plus a hosted visual editor | Pulls you toward their tooling |
| **Unity WebGL** | Export from a desktop engine | Multi-MB downloads, opaque output |
| **Raw WebGL/WebGPU** | Total control | Months before you see a hill |

We picked **Three.js** because it's the most documented, has the largest body of
examples and community answers, stays close enough to the metal that you can
drop to custom shaders when needed, and keeps all your source readable. For
learning the domain — which is part of the point here — that readability matters
more than a feature checklist.

### A note on WebGPU

WebGPU is WebGL's successor: better performance, modern GPU features, compute
shaders. Three.js supports it via a separate renderer, and browser support is
now broad. We're on WebGL because it works everywhere today and the switch is
mostly confined to one class. Worth revisiting if we ever need compute shaders
for terrain or water.

---

## 4. Three.js: the five concepts you need

Three.js has a large API, but five concepts carry almost everything.

### Scene

The container — a tree of everything that exists. You add objects to it, and it
holds the parent/child relationships. Moving a parent moves its children, which
is how you'd attach a turret to a tank.

```typescript
const scene = new THREE.Scene();
scene.add(someObject);
```

### Camera

Your viewpoint. We use a `PerspectiveCamera`, which mimics a real lens — distant
things shrink. Four parameters:

```typescript
new THREE.PerspectiveCamera(
  60,    // field of view, degrees. 50-75 is natural; higher feels fish-eyed
  1,     // aspect ratio — must match the canvas or everything stretches
  0.1,   // near plane: closer than this is not drawn
  2000,  // far plane: farther than this is not drawn
);
```

Near and far exist because depth is stored with finite precision. Too wide a
range and distant surfaces flicker against each other — "z-fighting". Keep the
range only as large as your world needs.

### Geometry

The vertices and triangles — shape only, no appearance. Three.js ships
primitives (`BoxGeometry`, `SphereGeometry`, `PlaneGeometry`), and for terrain
we'll build a `PlaneGeometry` and then move its vertices ourselves.

### Material

How a surface responds to light. The main ones:

- `MeshBasicMaterial` — flat colour, ignores lights entirely. Debug use.
- `MeshStandardMaterial` — physically-based: `roughness` and `metalness`
  controls. Our default.
- `ShaderMaterial` — you supply the GLSL. Full control, full responsibility.

### Mesh

Geometry plus material equals a thing you can see.

```typescript
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.4, 1.4, 1.4),
  new THREE.MeshStandardMaterial({ color: 0x4f7cff, roughness: 0.45 }),
);
scene.add(cube);
```

That separation is deliberate and useful: one geometry can be shared by many
meshes with different materials, which saves a lot of memory when you have a
thousand identical rocks.

### Lights, briefly

`MeshStandardMaterial` is invisible without light. We use two:

- **`HemisphereLight`** — sky colour from above, ground colour from below. A
  cheap approximation of ambient outdoor light, and it stops shadowed faces
  reading as pure black.
- **`DirectionalLight`** — parallel rays from one direction. The sun. Position
  sets the *direction*, not a location, since the source is treated as
  infinitely distant.

---

## 5. The render loop

Nothing draws itself. A frame appears because you asked for one:

```typescript
renderer.render(scene, camera);
```

To animate, you ask repeatedly, via a browser API called
`requestAnimationFrame`:

```typescript
function tick() {
  requestAnimationFrame(tick);   // queue the next frame
  cube.rotation.y += 0.01;       // update the world
  renderer.render(scene, camera); // draw it
}
requestAnimationFrame(tick);
```

`requestAnimationFrame` runs your callback just before the browser's next
repaint — synced to the display's refresh rate, and paused entirely when the tab
is hidden. That last part is why you never use `setInterval` for this: a
background tab would keep burning GPU on frames nobody sees.

### Delta time, and why that `0.01` is a bug

The loop above rotates by a fixed amount *per frame*. On a 60Hz monitor that's
0.6 rad/sec; on a 144Hz gaming display it's 1.44 — the same code, and the world
spins more than twice as fast. Frame-rate-dependent motion is one of the classic
game programming bugs.

The fix is to scale every change by the time the frame actually took:

```typescript
const dt = clock.getDelta();   // seconds since last frame, e.g. 0.0167
cube.rotation.y += 0.6 * dt;   // 0.6 radians per *second*, on any hardware
```

This is why our `onUpdate` callbacks all receive `dt`, and why you'll see it
multiplied into every rate in the codebase. Any time you write a number that
means "per frame", it's almost certainly meant to be "per second" instead.

---

## 6. JavaScript, TypeScript, and why we chose the latter

**JavaScript** is the only language browsers run natively. It's dynamically
typed: variables have no declared type, and mistakes surface at runtime, if at
all.

**TypeScript** is JavaScript plus a static type system. You write types, a
compiler checks them, and then it *erases* them — the browser receives plain
JavaScript. The types are a development-time tool exclusively; nothing is
checked at runtime.

```typescript
// JavaScript — this is a bug, and it runs happily
function setHeight(mesh, height) {
  mesh.position.y = height;
}
setHeight(cube, "10");   // string, not number. Silent nonsense.

// TypeScript — the compiler rejects it before it runs
function setHeight(mesh: THREE.Mesh, height: number) {
  mesh.position.y = height;
}
setHeight(cube, "10");   // Error: string is not assignable to number
```

For 3D work this pays off constantly. Three.js has `Vector2`, `Vector3`,
`Euler`, `Quaternion`, `Matrix4` — all plausible-looking objects with
overlapping method names. Passing a `Vector2` where a `Vector3` belongs is an
easy mistake, and in JavaScript the symptom is geometry quietly collapsing
somewhere far from the cause. In TypeScript it's a red underline while you type.

### Our strict settings

`tsconfig.json` turns on `strict` plus some extras. Two deserve explanation:

**`strictNullChecks`** (part of `strict`) separates "a thing" from "possibly
nothing". `document.querySelector` returns `null` when nothing matches, so the
compiler makes you handle it:

```typescript
const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('#scene canvas not found');
// below this line, TypeScript knows canvas is real
```

That check in `main.ts` isn't ceremony. It converts a confusing downstream
`null` dereference into one clear message at startup.

**`noUncheckedIndexedAccess`** makes array indexing return `T | undefined`,
because the compiler can't know your index is in range. Terrain code is full of
flat arrays addressed by computed offsets:

```typescript
const height = heights[z * size + x];   // typed number | undefined
```

This is mildly irritating and genuinely valuable: get that arithmetic wrong and
you'd otherwise get `undefined`, then `NaN`, then an invisible hole in your
mesh, with nothing pointing at the offending line. The flag forces the question
at compile time.

---

## 7. npm and `package.json`

**npm** is the JavaScript package registry and its CLI. **`package.json`** is
the project manifest.

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build"
  },
  "dependencies":    { "three": "^0.186.1" },
  "devDependencies": { "vite": "^8.3.2", "typescript": "^7.0.2" }
}
```

**`dependencies` vs `devDependencies`.** The first ships to the browser; the
second only builds it. Three.js is in the user's download. Vite and TypeScript
never reach them.

**`"type": "module"`** opts into standard ES modules (`import`/`export`) rather
than Node's older CommonJS (`require`). Modern default; avoids a category of
confusing interop errors.

**`^0.186.1`** means "compatible with" — npm may install 0.186.2 but not
0.187.0. The caret's exact behaviour for `0.x` versions is unusual, which is why
the lockfile matters.

**`package-lock.json`** records the exact resolved version of every package,
including transitive ones. It's committed, and it's why CI builds what you
built. In CI we run `npm ci`, which installs the lockfile *exactly* and fails if
`package.json` disagrees — as opposed to `npm install`, which may update things.

**`scripts`** are shorthands, run via `npm run <name>`. Ours:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve `dist/` locally, to test the real build |
| `npm run typecheck` | Types only, no build |

Note the `&&` in `build`: `tsc --noEmit` checks types and emits nothing, then
Vite builds. If types fail, the build stops. Deliberate — Vite alone would
happily ship type-broken code, because it strips types without checking them.

**`node_modules/`** is where packages land. It is large, reproducible from the
lockfile, and therefore in `.gitignore`. Never commit it.

---

## 8. Vite: the dev server and the build

Browsers can't run TypeScript, and until recently couldn't efficiently load
hundreds of small modules. Vite solves both, wearing two quite different hats.

### Hat 1: the dev server (`npm run dev`)

Serves your files to the browser, transforming on demand. Its trick is
**native ES modules** — your browser requests `main.ts`, Vite strips the types
and returns JavaScript, and the browser then requests the imports it finds. No
bundling, so startup is near-instant regardless of project size.

The feature you'll feel most is **hot module replacement**: save a file, and
Vite pushes just that module to the running page. State is preserved where
possible, and for CSS the swap is seamless. Typical edit-to-visible latency is
under a tenth of a second, which changes how you work on anything visual — you
tweak a value, you see the hill change.

### Hat 2: the production build (`npm run build`)

Dev mode's unbundled approach would mean hundreds of requests for a real user.
So the build does the opposite:

- bundles everything into few files
- **minifies** — strips whitespace, shortens names
- **tree-shakes** — drops code nothing imports
- hashes filenames (`index-CkCbrBou.js`) so caches update correctly
- emits **source maps**, so browser devtools can show your original TypeScript
  when debugging the minified output

Output goes to `dist/`, which is a folder of static files. No server-side
runtime — any static host will do, which is what makes GitHub Pages viable.

### Our config, and the one subtlety

```typescript
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/3dland/' : '/',
  build: { target: 'es2022', sourcemap: true },
}));
```

`base` is the URL prefix for generated asset links. GitHub Pages serves this
project from `https://developerdee.github.io/3dland/` — note the subdirectory —
so built HTML must request `/3dland/assets/index-abc.js`. But the local dev
server runs at the root, where that prefix would 404.

Hardcoding either value breaks the other environment, so we switch on the
command. This is a small thing that causes a *lot* of confusion with project
Pages sites, and it's exactly the kind of bug that only shows up after deploy —
which is why we verified the deployed asset URLs returned 200 rather than
trusting the config.

---

## 9. Reading our actual code

Four files, about 150 lines total.

```
index.html             the page: a canvas and a HUD div
src/style.css          fullscreen canvas, HUD overlay
src/engine/Viewer.ts   renderer, camera, resize, render loop
src/main.ts            builds the scene, starts the loop
```

### `index.html`

Deliberately almost empty:

```html
<canvas id="scene"></canvas>
<div id="hud">stage 1 — scaffold</div>
<script type="module" src="/src/main.ts"></script>
```

A `<canvas>` is a rectangle of pixels that JavaScript draws into — the surface
WebGL renders to. The HUD is ordinary HTML layered on top with CSS, which is the
normal way to do interface in a browser game: DOM for text and menus, canvas for
the world.

`type="module"` enables `import`, and makes the script load without blocking
page parse.

### `src/engine/Viewer.ts`

This holds what every future stage needs: the renderer, the camera, resize
handling, and the loop. The design goal is that stages 2 through 6 never have to
modify it.

**The two-method interface.** Feature code interacts through exactly two things:
add objects to `viewer.scene`, and register per-frame work with
`viewer.onUpdate(fn)`. Registered functions go in an array, and the loop calls
each one with `dt`:

```typescript
onUpdate(fn: UpdateFn): void {
  this.updates.push(fn);
}
```

So terrain, camera controls, and water each own their per-frame logic without
any of them knowing about the others — and without a growing central `tick()`
function that touches everything.

**Pixel ratio cap.** `window.devicePixelRatio` is 1 on an old monitor, 2 on a
Mac Retina, 3 on many phones. Rendering at full 3x means nine times the pixels
of 1x — for a difference your eye can barely resolve:

```typescript
this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
```

Cheapest performance decision in the file. On phones it's often the difference
between 30 and 60 fps.

**The resize guard.** This looks like paranoia and isn't:

```typescript
const width = this.canvas.clientWidth;
const height = this.canvas.clientHeight;
if (width === 0 || height === 0) return;
```

A hidden or not-yet-laid-out canvas reports zero dimensions. Compute
`aspect = 0 / 0`, get `NaN`, write it into the camera's projection matrix, and
every vertex transform now produces `NaN`. The screen goes black, no error is
thrown, and nothing indicates why. Three lines to prevent a genuinely nasty
debugging session.

We watch for size changes with a `ResizeObserver` rather than the `window`
resize event, because it fires for *any* layout change affecting the canvas —
including a sidebar opening, which `window.resize` would miss.

### `src/main.ts`

Assembles the placeholder scene: two lights, a cube, a grid, and a rotation
update using `dt` as discussed. Stage 2 deletes most of it.

The part that survives is the FPS counter, which samples over 0.5-second
windows rather than reporting instantaneous frame time — per-frame numbers
jitter too much to read:

```typescript
framesSinceSample += 1;
timeSinceSample += dt;
if (timeSinceSample < 0.5 || !hud) return;
const fps = Math.round(framesSinceSample / timeSinceSample);
```

It's there from the start because terrain is where frame budget starts to bite,
and a visible number means you notice a regression the moment you cause it,
rather than discovering it three stages later.

---

## 10. Deployment: CI and GitHub Pages

**GitHub Pages** serves static files from a repository. **GitHub Actions** is
GitHub's CI: run commands on their machines when something happens in the repo.

Our workflow lives in `.github/workflows/deploy.yml` and runs on every push to
`main`. Two jobs: *build* (checkout, install Node, `npm ci`, `npm run build`,
upload `dist/`) and *deploy* (publish it).

Three details worth noting:

**`npm ci` not `npm install`.** Installs the lockfile exactly, and errors if
`package.json` and the lockfile disagree. Reproducible builds.

**The typecheck runs in CI too**, because `npm run build` starts with `tsc`. A
type error fails the deploy rather than shipping.

**`concurrency: cancel-in-progress: false`.** Most CI setups cancel a running
job when a newer commit arrives — sensible for tests, bad for deploys, where
interrupting a publish mid-write can leave the site inconsistent. So pushes
queue instead.

### Verifying a deploy

The deployed site is the first place environment-specific bugs appear — the
`base` path problem from section 8 being the obvious one. "The workflow went
green" only proves the build ran, not that the page works. So we checked the
page *and* its hashed assets:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://developerdee.github.io/3dland/
```

All 200, which proves the base path is genuinely right.

Worth being precise about the limits of that, though: HTTP 200 means the files
were served, not that anything rendered. A WebGL failure, a shader error, a
blank screen — all of those still return 200. Only a human looking at the page
confirms it draws. Automated checks are worth having and worth not
over-trusting.

---

## 11. The dev server lifecycle

Brief, because it caused real friction already.

`npm run dev` starts a long-running process. It does not finish; it holds your
terminal and serves until stopped.

**In a normal shell window:**

```bash
cd /home/dee/projects/3dland
npm run dev        # occupies this window
                   # Ctrl+C to stop
```

Open a second window for git and everything else.

**The orphan trap.** `npm run dev` is actually two processes: an `npm` wrapper
and the `vite` process it spawns. Kill only the wrapper and vite can get
reparented rather than dying — still running, still holding port 5173, no longer
attached to anything you can `Ctrl+C`. This is exactly what happened in this
project: killing the npm PID left vite alive serving the old build.

To find and kill a server you've lost track of:

```bash
lsof -i:5173            # what's listening
kill $(lsof -ti:5173)   # kill it
```

**One more trap.** A browser tab keeps displaying the scene after the server
dies, because the JavaScript is already loaded and running client-side. The page
looking alive doesn't mean the server is. Reload to find out.

---

## 11a. How the terrain actually works

Stage 2 is built, so here is what it does.

### Seeded randomness, and why `Math.random()` won't do

`Math.random()` cannot be seeded. Every reload would give a different world, so
a hill that reveals a bug could never be revisited — which makes debugging
nearly impossible.

So `src/terrain/random.ts` implements **mulberry32**, a small PRNG with 32 bits
of state. Give it the same seed, get the same sequence. `hashSeed` turns a
string into that seed, so worlds can be named (`'landfall'`) rather than
numbered.

### Fractal Brownian motion

One layer of simplex noise is too smooth to read as landscape — it looks like
rolling fabric. Real terrain is **self-similar**: mountains have hills on them,
hills have rocks, rocks have texture. You get that by summing several layers:

```
octave 1:  amplitude 1.00, frequency 1x   →  continental shapes
octave 2:  amplitude 0.50, frequency 2x   →  hills
octave 3:  amplitude 0.25, frequency 4x   →  rocks
octave 4:  amplitude 0.12, frequency 8x   →  texture
                                   summed →  landscape
```

Each octave is half the height and twice the detail of the last. Two parameters
control that: **persistence** (the amplitude multiplier, 0.5 above) and
**lacunarity** (the frequency multiplier, 2). This is the standard recipe, and
it's remarkable how convincing it is for how simple it is.

### Two bugs worth knowing about

Both of these were caught by checking the generated numbers rather than by
looking at the screen — which is exactly why it's worth doing.

**Bug 1: simplex noise is exactly zero at the origin.** This is inherent to how
the algorithm works — lattice origins evaluate to 0. Since the heightmap was
sampled on a window centred at (0, 0), the middle of every map was pinned to
height zero. Worse, *every octave* shared that origin, so their contributions
were correlated rather than independent.

The fix: offset each octave by a seeded random amount, so they sample different
parts of the noise field.

**Bug 2: the sampling window was far too small.** At frequency 1.1 the code
traversed only ±0.55 units of noise space. Simplex features are about one unit
across, so that window never encountered enough of the field to reach its
extremes — measured output spanned ±0.80 instead of ±1.0, giving flat,
lopsided terrain. The fix was a `FIELD_SPAN` constant scaling the window to
something useful.

The general lesson: both bugs produced *plausible-looking* output. Terrain that
is flatter than intended still looks like terrain. Only measuring the numbers
revealed it.

### Why `normalizeRange` exists

Even correct fBm reaches only ~64% of its nominal amplitude, because summed
octaves rarely peak simultaneously — they partly cancel. So an `amplitude` of
28 produced terrain spanning 18 units, which makes the slider a lie.

`normalizeRange` rescales the finished heightmap to span exactly `amplitude`.
The tradeoff, which is why it's a toggle rather than always-on: it couples the
output range to whatever extremes that particular seed happened to hit, so two
seeds get the same total height even if one is intrinsically more dramatic.

### From heights to geometry

`TerrainMesh` turns the number grid into something renderable:

1. Build a `PlaneGeometry` subdivided into `resolution - 1` segments per side.
2. Rotate it flat — planes are created standing up in the XY plane.
3. Write each height into the corresponding vertex's **y** coordinate.
4. Assign a colour per vertex by altitude band, so relief is visible.
5. Call `computeVertexNormals()`.

Step 5 **must** come after step 3. Normals describe which way a surface faces,
and lighting depends on them entirely. Compute them before moving the vertices
and you get the normals of a flat plane — every triangle facing straight up,
terrain lit as though it were a billiard table.

One convenient accident: `PlaneGeometry`'s vertex order matches a row-major
heightmap exactly, since both iterate x fastest. So vertex *i* corresponds to
height *i*, with no coordinate mapping needed.

### Disposal, and why it matters

GPU resources are **not** garbage collected. Allocate a geometry, drop your
last reference, and the VRAM stays allocated until the WebGL context dies. Since
every GUI change rebuilds the terrain, that would leak a few megabytes per
slider nudge — so `TerrainMesh.rebuild()` explicitly calls `.dispose()` on the
old geometry first. Any time you replace a geometry, material or texture in
Three.js, dispose the old one.

---

## 11b. First-person camera control

Stage 3 added fly and walk modes. Four ideas carry it.

### Pointer lock

A web page normally sees only where the cursor *is*, which is useless for
mouse-look — the cursor hits the screen edge and stops. **Pointer Lock** hides
the cursor and switches the browser to reporting *relative* movement
(`movementX`/`movementY`), unbounded in any direction.

Two constraints the browser imposes, both for good reason:

- It requires a **user gesture**. You cannot grab the mouse on page load; the
  user must click. Hence the "click to look around" prompt.
- <kbd>Esc</kbd> always releases it, and the page cannot prevent that.

The trap worth knowing: when lock is released mid-keypress, the `keyup` never
arrives, so a held key stays "down" forever and the camera drifts off on its
own. `FlyControls` listens for `pointerlockchange` and clears its key set.

### Yaw and pitch, not accumulated rotation

The obvious implementation is to rotate the camera by the mouse delta each
frame. It produces a subtle, maddening bug: once yaw and pitch interact,
**roll** creeps in, and the horizon tilts. Worse, roll accumulates — it never
self-corrects.

The fix is to store two angles and rebuild the orientation from scratch:

```typescript
this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
this.camera.quaternion.setFromEuler(this.euler);
```

Roll is hardcoded to 0, so it is structurally impossible. The `'YXZ'` order
matters: yaw is applied first, then pitch *within the camera's own frame* —
which is exactly how a head turns, and what keeps the horizon level.

Pitch is also clamped just short of ±90°. At exactly vertical, the forward
vector aligns with world up, the cross product used for the right vector
degenerates, and the camera flips unpredictably.

### Delta time, again — and why a clamp is needed

Movement is `speed * dt`, so it's frame-rate independent as discussed in
section 5. But `dt` has a failure mode: `requestAnimationFrame` **pauses** in
a background tab. Alt-tab away for thirty seconds, come back, and the first
frame reports `dt = 30`. At 40 units/second that teleports you 1,200 units
across the map.

```typescript
const step = Math.min(dt, 0.1);
```

Any single frame contributing more than 100ms of movement is a glitch, not
real elapsed time. This is standard practice in game loops, and the symptom it
prevents — "I tabbed back and I'm in the void" — is otherwise baffling.

### Normalising the movement vector

Pressing W and D adds two unit vectors, giving a vector of length √2 — so
diagonal movement would be 41% faster than cardinal. Players discover this
immediately and zigzag everywhere. Normalising the summed direction before
scaling by speed fixes it:

```typescript
this.motion.normalize();
this.motion.multiplyScalar(this.speed * step);
```

### Walk mode, and what it isn't

Walk mode clamps the camera to `sampleHeight(x, z) + 1.8` every frame, using
the bilinear interpolation written in stage 2. It feels surprisingly like
walking, for about ten lines of code.

It is **not** collision. There is nothing stopping you walking up a vertical
cliff — you simply glide up its face at constant horizontal speed. Real
movement needs slope limits, step heights, and a notion of being blocked.
That's stage 6.

One edge case worth noting, because it was a real bug: `sampleHeight` clamps
coordinates to the terrain's bounds, so walking past the edge returns the edge
height forever. You stride out over nothing, on an invisible plateau, with no
error. Walk mode now clamps to the terrain extent; fly mode deliberately
doesn't, so you can still get an outside view.

### Two vectors, allocated once

```typescript
private readonly forward = new THREE.Vector3();
private readonly motion = new THREE.Vector3();
```

These are instance fields, reused every frame, rather than locals created
inside `update()`. At 60fps, allocating a handful of vectors per frame means
thousands of short-lived objects per second, and the resulting garbage
collection shows up as periodic stutter. Reusing scratch objects in hot paths
is routine in game code, and this is the first place in the project where it
genuinely matters.

---

## 11c. Shading: slope, altitude, and injecting GLSL

Stage 4 replaced the placeholder vertex colours with per-pixel shading.

### Why slope is the key input

Altitude alone cannot distinguish a cliff face from a meadow at the same
height — and real landscapes distinguish them sharply, because loose soil and
vegetation cannot cling to steep rock. Slope is what makes terrain read as
geology rather than a contour map.

It is nearly free to compute. The surface normal is a unit vector pointing away
from the surface, so its **y component is the cosine of the angle from
vertical**: 1 on flat ground, 0 on a sheer face.

```glsl
float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);
```

### Extending a material instead of writing one

Three offers three levels of control:

| Approach | You get | You give up |
| --- | --- | --- |
| Vertex colours (stage 2) | Trivial, no shader code | Per-vertex only; bands visibly |
| `onBeforeCompile` injection | PBR lighting, fog, shadows free | Depends on Three's shader internals |
| Full `ShaderMaterial` | Total control | Reimplement lighting, fog, tone mapping |

We chose the middle one. `onBeforeCompile` hands you Three's shader source
before it compiles, and you string-replace its `#include` markers to splice in
your own GLSL. Roughly forty lines buys slope-aware shading on top of a full
physically-based lighting model.

The cost is honest coupling: those markers are Three's internals. They have
been stable for years, but a major upgrade is worth re-checking.

### The bug this technique invites

Here is the mistake, which I made and caught before it ran:

```glsl
// In the color_fragment injection:
diffuseColor.rgb = albedo;
roughnessFactor = mix(0.95, 0.72, slopeRock);   // <-- broken
```

That looks reasonable. It does not compile, because `roughnessFactor` is
*declared* in the `roughnessmap_fragment` chunk, which Three includes **after**
`color_fragment`. You are assigning to a variable that does not exist yet.

The symptom is the worst kind: the shader fails to compile, the mesh renders as
solid black or vanishes, and the explanation is buried in a console warning
rather than thrown as an error.

The fix is two injections at two markers, passing the value between them via a
file-scope global:

```glsl
float gSlopeRock = 0.0;              // file scope, before main()
// ...in color_fragment:   gSlopeRock = slopeRock;
// ...in roughnessmap_fragment:  roughnessFactor = mix(0.95, 0.72, gSlopeRock);
```

The general lesson: when injecting into someone else's shader, **the include
order is part of the API**. Verifying which chunk declares what — and in what
order they run — is not optional.

### How the bands compose

Order matters, because each layer paints over the last:

```
grass (altitude-tinted)
  → rock, by altitude          a high plateau is bare
  → rock, by slope             a steep face is bare at any height
  → snow, by altitude × flatness   snow settles, then slides off steep ground
  → sand, by low altitude × flatness
```

Snow multiplied by flatness is the detail that sells it: snow on a vertical
cliff looks wrong immediately, and nobody can say why until it is fixed.

Every transition uses `smoothstep` rather than a comparison, so the boundary is
a gradient whose width is tunable. Noise added to the altitude *before*
thresholding makes the lines irregular — a straight horizontal snow line is the
most obvious tell of procedural terrain.

### Sky, fog, and tone mapping

Three small changes, disproportionate effect:

**Gradient sky.** A flat background colour reads as a void, because real sky is
much paler at the horizon. The dome is an inverted sphere with a two-stop
gradient, following the camera so you can never fly out of it.

**Fog matched to the horizon.** `FogExp2` falls off with the square of
distance, which approximates atmospheric scattering better than linear fog.
Matching its colour to the sky's horizon makes the terrain edge dissolve rather
than end at a line.

**ACES filmic tone mapping.** Without tone mapping, any surface brighter than
1.0 clips to flat white, so sunlit slopes lose all detail. ACES compresses
highlights the way film does. This is the single cheapest improvement in the
stage — one line.

---

## 11d. Touch controls and input abstraction

Pointer lock and WASD are desktop-only; on a phone there was no way to move at
all. Stage 4b added on-screen twin sticks.

### Why the controller reports intent, not camera changes

The naive fix is to make the touch handlers move the camera directly. That
gives you two independent movement implementations to keep in sync, and they
fight on a hybrid device like an iPad with a keyboard.

Instead `TouchControls` owns no camera state. It reports plain numbers —
"strafe 0.4, forward 1.0, climbing, boosting" — and `FlyControls` sums them
with whatever the keyboard contributed:

```typescript
strafe  += this.externalMove.x;
advance += this.externalMove.y;
climb   += this.externalMove.z;
```

One movement implementation, two input sources, no conflict.

### Clamping, not normalising

Stage 3 normalised the movement vector so diagonal keyboard input wasn't 41%
faster than cardinal. That is exactly wrong for an analog stick: normalising a
half-deflected dial snaps it to full speed, destroying the gradation that makes
a touch stick usable.

```typescript
const planar = Math.hypot(strafe, advance);
if (planar > 1) { strafe /= planar; advance /= planar; }
```

Clamping keeps partial input partial while still capping the diagonal. A
half-tilt now walks and a full tilt sprints — verified: 0.5 on the dial gives
exactly half speed.

### Pointer events, and the stuck-key problem

Touch uses **Pointer Events** rather than touch events — one API covering
mouse, touch and stylus, with each contact assigned a `pointerId`. Tracking
those ids is what makes genuine two-thumb control work: the dial ignores
events whose id isn't the one that grabbed it, so a second finger on the look
area can't hijack movement.

The trap is the same one from stage 3, in a new guise. A finger sliding off a
hold-to-move button never fires `pointerup`, leaving the button stuck down and
the camera climbing forever. Three handlers are needed, not one:

```typescript
button.addEventListener('pointerup', release);
button.addEventListener('pointercancel', release);        // system interruption
button.addEventListener('lostpointercapture', release);   // slid off
```

Any held-input control needs all three. This is the single most common bug in
hand-rolled touch controls.

### Accumulating look deltas

Several `pointermove` events can arrive between two frames. Assigning the
delta keeps only the last one and discards the rest, which feels like the
camera dropping input:

```typescript
this.state.lookDX += e.clientX - this.lookLast.x;   // += not =
```

`consume()` then returns the total and resets it, so each frame gets exactly
the motion since the previous frame.

### The CSS that actually matters

Four declarations do most of the work, and omitting any one breaks touch:

| Declaration | Without it |
| --- | --- |
| `touch-action: none` | The browser scrolls or zooms instead of steering |
| `user-scalable=no` | Pinch-zooms the page, fighting the sticks |
| `overscroll-behavior: none` | iOS rubber-banding drags the whole page |
| `env(safe-area-inset-*)` | Controls sit under the notch or home bar |

Also `height: 100dvh` rather than `100vh`: dynamic viewport units track mobile
browser chrome appearing and disappearing, where `vh` leaves a gap when the
address bar hides.

### Sizing the world for walking

Scaling the world to 1000 units exposed a tuning problem the numbers caught
before any of it was visible. At amplitude 130, **17% of the surface was
steeper than 45°**, with peaks at 81° — fine to fly over, miserable to walk.

Sweeping the parameters found amplitude 90 / frequency 1.1: still 90 units of
relief, but only 2.7% of the ground too steep to walk. The lesson is that
"looks dramatic" and "is traversable" are different objectives, and the second
one is measurable.

Speeds then needed splitting per mode. A single value cannot serve both: 6.5
units/second makes a 1000-unit world a two-minute walk, while flying wants
~85, scaled as a fraction of world size so resizing keeps crossing times
constant.

---

## 11e. Water

Water is the first thing in this project that cannot be done convincingly with
geometry and a colour. It needs four effects at once, and omitting any one
makes it read as a blue plane.

### Depth without the depth buffer

The usual way to find how deep water is at a pixel is to read the depth buffer
— what the terrain wrote before the water drew over it. That works, but it
means either a second render pass or a depth-texture copy, and it couples the
water to render order.

Since we *generated* the terrain, we already know its height everywhere. So the
heightmap is uploaded once as a single-channel float texture, and the shader
reads the seabed directly:

```glsl
vec2 uv = vWorldPos.xz / uTerrainSize + 0.5;
float groundHeight = mix(uMinHeight, uMaxHeight, texture2D(uHeightMap, uv).r);
float depth = uWaterLevel - groundHeight;
if (depth < 0.0) discard;
```

That `discard` matters: without it, the water plane extends over dry land as a
transparent film, which looks like a bug rather than like water.

`FloatType` rather than the usual 8-bit texture, because 256 height levels
across a 90-unit range would band the depth gradient visibly at the shore.

### Fresnel: the term that makes it look wet

Look straight down into clear water and you see the bottom. Look across it at a
glancing angle and it is a mirror. That shift is the **Fresnel effect**, and
Schlick's approximation of it is one line:

```glsl
float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);
color = mix(base, reflected, fresnel * uReflectivity);
```

If you implement only one thing from this section, implement this. It does more
for believability than waves, foam and colour combined.

### Waves, and deriving their normals

Two crossing sine trains at different angles and rates. A single sine reads as
corrugated iron; crossing them breaks up the periodicity enough to pass as open
water.

The subtlety is lighting. Displacing vertices without updating their normals
leaves the surface lit as though it were still flat — all the ripples, none of
the glint. Rather than supply a normal map, the shader samples the wave
function either side of each vertex and takes the difference:

```glsl
float hL = waveHeightAt(world.xz - vec2(e, 0.0), t) * uWaveHeight;
float hR = waveHeightAt(world.xz + vec2(e, 0.0), t) * uWaveHeight;
// ...same for the z axis
vNormal = normalize(vec3(hL - hR, 2.0 * e, hD - hU));
```

This is numerical differentiation — the gradient of the height field, which is
exactly what a normal is. The step `e` is deliberately coarse: sampling finer
gives a noisier normal, not a more accurate one.

### What a raw ShaderMaterial costs you

The terrain extends `MeshStandardMaterial`, so it inherits lighting and fog.
Water is a `ShaderMaterial` written from scratch, which means **fog is not
included** — and the water would have stayed sharp and bright at a distance
where the terrain had faded into haze, which looks badly wrong.

So the fog equation is reimplemented by hand to match the scene's `FogExp2`:

```glsl
float fogFactor = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
color = mix(color, uHorizonColor, clamp(fogFactor, 0.0, 1.0));
```

Same for the sun: the material has no idea where the `DirectionalLight` is, so
its direction is passed in as a uniform and kept in sync whenever the sun
moves. This is the recurring tax on bespoke shaders — every piece of scene
state you want, you wire up yourself.

### Three bugs the numbers caught

None of these would have thrown an error.

**The default sea level left puddles.** At 0.34 of the terrain range, only 5% of
an average world was submerged. Measuring across random seeds showed the curve
is steep — 0.40 gives 11%, 0.50 gives 42% — because the terrain's `exponent`
flattens low ground into a narrow band. 0.44 gives a 22% mean, which is real
coastline.

**Beaches were invisible.** The shading's sand band sat at 0.06 of the range
while the water sat at 0.44 — the entire beach was 38% of the range below the
surface. Two systems expressing heights in the same units, with nothing tying
them together. The shore band is now derived from sea level, so moving the
water carries the beach with it.

**One load in five started underwater.** With a fifth of the world submerged,
spawning at the origin put you on the seabed about 18% of the time. A spiral
search outward from the centre finds dry land in about four samples.

The pattern across all three: each system was individually correct, and the
bugs lived in the relationships between them. Unit tests on `Water` in
isolation would have passed.

---

## 11f. Scatter: placing thousands of objects

Vegetation is what gives a landscape scale. Without it a hill could be ten
metres or a hundred, and walking gives you no sense of covering ground.

### Instancing, or: why 5,000 trees is cheap

The naive approach — one `Mesh` per tree — fails at a few hundred objects. Not
because of triangles, but because of **draw calls**: each mesh is a separate
instruction to the GPU, each with its own state setup and CPU overhead. A
thousand of those per frame will stall you well before the triangle count
matters.

`InstancedMesh` draws many copies of one geometry in a single call, each with
its own transform matrix:

```typescript
const mesh = new THREE.InstancedMesh(geometry, material, count);
matrix.compose(position, quaternion, scale);
mesh.setMatrixAt(i, matrix);
```

Measured result: **5,434 objects in 8 draw calls** — one per prop variant. This
is the single most important technique for populating a world, and it is why
games can show forests at all.

Two details that matter:

- `setUsage(THREE.StaticDrawUsage)` tells the driver the matrices will not
  change, so they are uploaded once rather than every frame.
- `frustumCulled = false`, because the instances span the entire world. Three
  culls on the *mesh's* bounding volume, which here encompasses everything — so
  culling can only ever hide all of it or none, and testing it is wasted work.

### Placement: why random is wrong

Scattering by picking uniform random coordinates looks bad, and the reason is
counterintuitive: **random points are not evenly spread**. You get thickets
next to bare patches, because nothing stops two points landing on top of each
other.

The proper fix is Poisson-disc sampling, which guarantees a minimum spacing.
The cheap approximation that gets you most of the way is a **jittered grid**:
divide the area into cells, place one candidate at a random offset within each.

```typescript
const jx = 0.1 + random() * 0.8;   // inset, so neighbours cannot touch
const x = -half + (gx + jx) * cellSize;
```

Measured nearest-neighbour distance: minimum 6 units, mean 15. Irregular
enough to look unplanned, even enough to avoid clumping.

### Rules, and probabilistic edges

Each species has limits — altitude band, maximum slope, clearance above water.
The important subtlety is how the edges behave. A hard cut-off at the treeline
draws a visible contour line across the hillside, which is instantly
artificial. So the limits are *probabilistic*:

```typescript
const lowEdge  = smoothstep(min - fade, min + fade, altitude);
const highEdge = 1 - smoothstep(max - fade, max + fade, altitude);
if (random() > lowEdge * highEdge * slopeFactor) continue;
```

Deep inside the band almost everything survives; near the edge the chance
tapers. The treeline becomes a scattering of stragglers rather than a line.

Rejection rather than adjustment, too. Nudging a tree off a cliff to the
nearest valid spot sounds helpful and produces rows of trees along every cliff
edge — a worse artefact than the gap it fixed.

### Seeding per species

Each species seeds its PRNG with the world seed *plus its own name*:

```typescript
mulberry32(hashSeed(`${seed}:${label}`))
```

Without that, all three species would draw from one stream, and changing tree
density would reshuffle the rocks. Independent streams mean each slider affects
only what it names — verified.

### Procedural geometry, and merging for one draw call

The props are built in code: cones stacked into conifers, offset spheres into
crowns, a jittered sphere into a boulder. No assets to load, no download cost,
and a new variant is a parameter rather than a file.

The catch is that a tree has a brown trunk and green needles, and two materials
would mean two draw calls per tree — defeating the instancing. So the parts are
merged into one buffer with **colour baked into vertex attributes**, which
needs index rebasing as parts are concatenated:

```typescript
indices[indexOffset + i] = source[i] + vertexOffset;
```

Each part's indices are local to itself; appending them into a shared buffer
means every index shifts by however many vertices came before. Forget this and
the geometry renders as spaghetti.

### Density is a render budget, not an ecology

The first pass produced **73,667 objects** — which is ecologically plausible for
a square kilometre, and completely unusable. At ~45 triangles each that is 3.3
million triangles on top of the terrain's own.

Retuned to around 5,400 objects for ~250k triangles, which reads as open
woodland rather than dense forest. The lesson is that "realistic" and
"renderable" are different targets, and the constraint is almost always the
budget rather than the biology.

---

## 11g. Collision

Collision is where a landscape becomes a place you are *in* rather than one you
look at. It is also where naive implementations fall apart.

### Cylinders, not meshes

The obvious approach is to test the player against the prop geometry. Don't:
2,900 obstacles at ~60 triangles each is 174,000 triangles to test per frame,
and the result would be *worse* — catching on individual branches.

Every obstacle is an upright cylinder instead. A trunk is round, a boulder is
roughly round, and the player is a vertical capsule, so a cylinder test is both
trivially cheap and close enough that the difference is not felt.

The radius is deliberately **narrower than the visible mesh**. A conifer's
canopy is wide, but you walk through branches, not the trunk. Matching the
silhouette would make woodland feel like a maze of invisible walls. Shrubs are
not solid at all — being stopped dead by knee-high scrub reads as a bug.

### Broad phase: the uniform grid

Testing every obstacle every frame is O(n) per check, which at a few thousand
obstacles costs more than drawing them. So obstacles are indexed into a grid of
cells, and a check looks up only the cells its footprint touches:

```typescript
const minX = Math.floor((x - radius) / this.cellSize);
// ...registered in every cell its footprint overlaps
```

Two details matter. An obstacle is registered in **every** cell it overlaps,
not just the one containing its centre — otherwise a tree straddling a boundary
would be missed from one side. And because of that, a lookup spanning cells can
return the same obstacle twice, so duplicates must be filtered or the push gets
applied twice.

Cell size is derived from the largest obstacle radius. Cells much smaller means
one obstacle spanning many cells; much larger defeats the index.

Measured: **0.38µs per resolve** with 5,400 obstacles, against a 16,700µs frame
budget. Roughly 43,000 checks would fit in one frame.

### Resolution order, and why it matters

The sequence is: world edge, then obstacles, then ground. That order is not
arbitrary.

Pushing out of a tree changes your horizontal position, which changes **which
ground height applies**. Resolve the ground first and you are standing at the
height of where you *were*, not where you ended up — so you float over dips and
sink into rises near every tree.

Same reason the walk-mode surface snap runs again after an obstacle push.

### Push out, don't stop

The tempting fix for a collision is to reject the move — keep the previous
position. This feels terrible: you stick to walls, and a glancing brush against
a tree halts you completely.

Instead, push radially out to the cylinder's surface:

```typescript
const push = (combined - distance) / distance;
out.x += dx * push;
out.z += dz * push;
```

This gives **sliding** for free. The component of your movement along the
surface survives; only the component into it is cancelled. Measured on a
glancing pass of a tree: 11.4 of 12 requested units travelled, rather than
stopping at 6.

Three passes, because pushing clear of one tree can push you into another in
dense woodland. And resolution is **horizontal only** — being lifted onto a
tree by walking into it would be worse than being blocked by it.

### The degenerate case

If you end up exactly at an obstacle's centre, `dx` and `dz` are both zero and
there is no radial direction to push along. Divide by that distance and you get
`NaN`, which propagates into the camera matrix and blanks the screen.

```typescript
if (distance < 1e-5) {
  // Retreat along the approach vector instead.
}
```

Any radial push-out needs this branch. It is rare — but "rare" at 60fps means
it happens.

### What was actually verified

Collision is easier to test numerically than most things in this project,
because the question is precise: can the player ever be somewhere illegal?

Simulating **120,000 walking steps** across 40 traverses of a real populated
world gave zero penetration of any obstacle and zero fully-stuck frames.
Separately: asking to be 50 units underground returns you exactly to the
surface, all four world edges and corners clamp inside, flying keeps a 0.6-unit
ground clearance, you can climb freely above the terrain, and flying into a
mountainside rides you up its slope rather than passing through.

That last one is the specification working as intended: gliding over a mountain
is fine, passing through it is not.

---

## 11h. Shadows

Shadows anchor objects to the ground. Without them trees appear to float, and
terrain reads as a painted surface rather than something with form.

### The resolution problem

A directional light's shadow camera is **orthographic and finite** — it covers
a box, and everything inside it shares one shadow map. So the question is how
much world that box covers.

Stretch one map over the whole 1000-unit world:

| Map size | Units per texel |
| --- | --- |
| 1024² | 0.98 |
| 2048² | 0.49 |
| 4096² | 0.24 |

A tree trunk is about half a unit wide, so its shadow is one or two texels:
unrecognisable blocky mush. Even a 4096² map — 16MB of depth data — does not
fix it.

The answer is not a bigger map but a **smaller region**. Fit the shadow camera
to a 160-unit area around the viewer and 2048² gives 6.4 texels per trunk, a
properly readable shadow. Beyond that region there are no shadows, which looks
far better than bad ones.

This is a simplified form of what real engines do with **cascaded shadow maps**
— several maps at increasing scales, so near shadows are crisp and distant ones
coarse but present. One cascade is enough here.

### Texel snapping, and shimmer

Move the shadow camera continuously as the viewer walks, and the shadow map
shifts by a fraction of a texel each frame. Every shadow edge then crawls and
shimmers — the most noticeable shadow artefact there is, and much worse than a
slightly misplaced shadow.

The fix is to quantise the region centre to texel increments:

```typescript
const texelSize = this.span / this.sun.shadow.mapSize.width;
this.target.x = Math.round(this.target.x / texelSize) * texelSize;
this.target.z = Math.round(this.target.z / texelSize) * texelSize;
```

The shadow map now moves in discrete texel steps rather than sliding, so
shadow edges stay put relative to the ground. Verified: 40 sub-texel movements
produced 5 distinct centre positions rather than 40.

### Shadow acne, and the two biases

A surface lit at a glancing angle samples its own depth with limited
precision, so parts of it conclude they are in shadow. The result is dark
stippling — "shadow acne" — all over sunlit slopes.

The classic fix is a depth bias, pushing samples away from the light. Overdo it
and shadows detach from their casters, so a tree appears to hover above its own
shadow: "peter-panning".

```typescript
this.sun.shadow.bias = -0.0008;
this.sun.shadow.normalBias = 0.6;
```

`normalBias` is the better tool: it offsets the sample along the **surface
normal** rather than toward the light, which scales naturally with how glancing
the angle is. Steep terrain needs it most, and gets it automatically.

### The bug the numbers caught

The shadow camera's depth range was originally a fixed multiple of the region
span. That works for a high sun, and fails badly for a low one.

At a 2° elevation the light is nearly horizontal, so the region's footprint
stretches **2,292 units** along the light's view axis — against a depth range
of only 480. Terrain outside that range silently stops casting, precisely when
shadows are longest and most dramatic.

The depth range is now derived from the elevation itself:

```typescript
const elevationSine = Math.max(Math.abs(sunOffset.y), 0.08);
const depthSpan = this.span / 2 / elevationSine;
```

Verified across elevations from 2° to 88°: the region is fully inside the
shadow volume at every angle, and the near plane never goes non-positive.

Worth noting what is *not* a problem: at 2° the far/near ratio reaches 2160,
which would be alarming for a perspective camera. Orthographic depth is
**linear**, so precision depends on the range rather than the ratio — even that
case resolves to a fraction of a millimetre at 24-bit depth.

### A coupling that had to be broken

The water shader needs to know where the sun is, and had been reading
`sun.position`. That worked until shadows started moving the light every frame
to keep its shadow camera near the viewer.

With the light now following you, its *position* no longer encodes its
*direction* — so the water's specular highlight would have swung around as you
walked. The sun direction is now held separately, and the light's position is
derived from it rather than being the source of truth.

This is a recurring shape in graphics code: one object's state means two
different things to two different systems, and the day one system starts
mutating it, the other breaks silently.

---

## 11i. Forests: clustering, and a constraint that cannot be violated

Stage 5b scattered trees evenly across the whole map. That was wrong, and the
reason is ecological: tree distribution is driven by where seeds land and
survive, so it clusters. Even spacing reads as an orchard.

The irony is that stage 5b's jittered grid was solving the *opposite* problem —
avoiding clumps within a patch. Both are needed: clustered at the scale of
hundreds of units, evenly spaced at the scale of metres.

### Scoring candidates, not accepting them

Forests need to appear where woodland actually grows — gentle slopes, valleys,
basins where soil and water collect. The naive approach picks random points and
rejects invalid ones, which puts forests at the first *acceptable* spot rather
than a *good* one.

Instead, hundreds of candidates are sampled and **scored**:

```typescript
const score =
  slopeScore * 0.9 +                      // gentle ground
  Math.max(gentleScore, 0) * 0.5 +        // rolling beats dead flat
  basinScore * SITING.basinWeight +       // hollows over rises
  random() * 0.25;                        // so similar terrain varies
```

The basin term is the interesting one. It compares each candidate against a
ring of samples around it: lower than its surroundings means a valley. Measured
result — all six forests sat at or below their surroundings.

### Irregular boundaries

A circular forest is obvious from above. The boundary is a circle whose radius
is perturbed by noise sampled *around its perimeter*:

```typescript
const angle = Math.atan2(dz, dx);
const wobble = noise(cos(angle) * 1.7 + seed, sin(angle) * 1.7 + seed) * 0.62
             + noise(cos(angle) * 4.1 + seed, sin(angle) * 4.1 + seed) * 0.38;
const effectiveRadius = forest.radius * (1 + wobble * params.edgeRoughness);
```

Two octaves again: broad lobes plus finer inlets. Measured on an isolated
forest of nominal radius 100: the actual boundary ranges 64–141 units at
default roughness, and exactly 100–100 at roughness zero.

Density also fades toward the edge, so a forest thins into scattered trees
rather than stopping at a wall. And because `forestDensityAt` takes the maximum
across all forests, neighbouring woods merge naturally where they touch.

### The constraint that cannot be violated

The requirement was that a forest must always be walkable. This is unusual and
worth dwelling on: most parameters are a matter of taste, but an impassable
forest is a **bug**, not a style choice.

The numbers are knowable. The player is 0.42 units in radius and the widest
trunk is 0.58, so two trees 2.0 units apart leave exactly zero room to pass. A
3.0-unit minimum leaves 1.84 units for a 0.84-unit body.

So `MIN_TREE_GAP = 3.0` is a hard floor in the code, and the spacing slider is
clamped to it:

```typescript
const spacing = Math.max(forestParams.spacing / Math.sqrt(densityScale), MIN_TREE_GAP);
```

But a jittered grid alone **cannot** guarantee this — two trees in adjacent
cells can both jitter toward their shared edge. So separation is additionally
enforced against a spatial hash, cell size equal to the minimum gap, checking
the eight neighbours. An all-pairs check would be quadratic on several thousand
trees.

### The bug that needed the constraint tested, not assumed

Measuring found exactly one violation across a world: 2.834 units where 3.0 was
required. The forest pass was correct — forest trees alone measured exactly
3.000 with zero violations.

The culprit was the *lone* trees, added afterwards. A lone tree can fall just
outside a forest boundary yet still land within 3 units of a tree inside it.
The separation index now spans both passes. Verified across ten random worlds:
minimum separation exactly 3.000 units, zero violations.

One violation in several thousand trees would have been nearly impossible to
find by walking around, and would have produced exactly one mysterious spot in
one world where the player got stuck.

### A circular import, caught at runtime

Splitting forests into their own module created a cycle: `placement` imported
`defaultForests` from `forests`, and `forests` imported `slopeAt` from
`placement`. TypeScript compiled it happily. At runtime:

```
ReferenceError: Cannot access 'defaultForests' before initialization
```

ES module cycles are resolved by hoisting, so a `const` in a partially-
initialised module reads as uninitialised. The fix was to extract the shared
function into `surface.ts`, which neither imports.

Worth noting what caught this: **not** the typecheck, and not the build — both
passed. Only executing the code did. It is a reminder that a green build is
weaker evidence than it feels.

---

## 11j. Islands and biomes

Two changes that interact more than they look like they should.

### Making an island

The falloff that pulls terrain down at the edges is simple — but three details
each break it if got wrong.

**Use the axis distance, not the radius.** A radial mask leaves the four
corners of a square mesh above water, because the corners are further from the
centre than the edge midpoints. `Math.max(|u|, |v|)` follows the square.

**Apply it after range normalisation.** Normalising stretches the result to
span the requested amplitude, so a falloff applied first is simply stretched
back out and undone.

**Ease it cubically.** Linear interpolation from land to sea floor reads as a
cone. `t * t * (3 - 2 * t)` gives a shelving beach that steepens into deep
water.

### The two bugs an island causes elsewhere

Neither would have thrown an error, and both were caught by measuring.

**Sea level broke.** It was a fraction of the full height range, and an island
drops its sea floor far below the land — so the previous default put the sea
at -33 and drowned 56% of the map. Worse, the range's endpoints move with
every seed: a fixed fraction flooded some islands to 77% and others to 26%.

Sea level now anchors to the **median height of the island's interior**, which
is stable where the endpoints are not. Measured across ten islands: 48% dry
land, standard deviation 0.7%, against roughly 20% before.

**Every altitude band broke.** Shoreline, rock line, snow line, treeline,
forest siting — all measured altitude from the absolute minimum, which the
island's sea floor had just moved hundreds of units downward. The tree band
would have sat underwater and the snowline part-way down the land.

They all now measure from `landMin`, the pre-falloff floor. The general shape
here is worth noting: **one system changed the meaning of a number five other
systems were reading.** No interface changed, nothing failed to compile.

### Biomes by altitude and moisture

Real biome maps are driven by temperature and rainfall. On a single island
temperature tracks altitude closely enough to substitute, so a second noise
field supplies moisture and the pair picks the biome.

Each biome gets a **niche** — a preferred altitude and moisture with a spread —
and classification scores every enabled biome, then normalises:

```typescript
const fit = Math.exp(-(da * da + dm * dm));   // Gaussian falloff
scratch[i] = fit * settings.weight;
// ...then divide every entry by the total
```

Normalising is what makes the toggles work properly: because the weights always
sum to 1, the map is **always fully covered**. Disabling grassland widens its
neighbours rather than leaving bare patches. Verified — with any one biome
disabled, coverage stays at 100%.

### The measurement that fixed the distribution

The first attempt gave tundra 1.5% of the map and grassland 59%. The niches
looked reasonable, so the obvious move was to adjust them by feel.

Measuring the terrain explained it instead. Dry land occupies a *narrow slice*
of the full height range:

```
altitude 0.3-0.4:   3.8%
altitude 0.4-0.5:  21.8%
altitude 0.5-0.6:  58.8%   <-- most of the island
altitude 0.6-0.7:  12.6%
```

Land spans 0.37 to 0.98, with 59% of it inside a single tenth. Niches spread
across 0–1 were aiming most of their range at altitudes where no land exists.

So altitude is now rescaled against the land's own range — 0 at the shoreline,
1 at the highest peak — with a `pow(raw, 0.55)` curve, because land area falls
off sharply with height and a linear measure would give sparse high ground as
much of the biome range as the crowded lowlands. All five biomes then appear,
consistently across seeds.

The lesson: a distribution that looks wrong is often a *measurement* problem
rather than a tuning problem, and tuning by feel would have chased it forever.

### Colouring: CPU per vertex, not GPU per pixel

The biome colour is computed on the CPU, written into a vertex attribute, and
interpolated across each triangle. The alternative — classifying per pixel in
the fragment shader — would mean sampling the moisture noise and running the
weighted blend for every pixel on screen, for a value that varies over tens of
world units. Vertex interpolation also smooths the biome boundaries for free.

One detail in the shader: the biome tint replaces the ground colour but **not**
rock or snow.

```glsl
float groundShare = (1.0 - slopeRock) * (1.0 - snowHold);
albedo = mix(albedo, vBiomeColor, groundShare * uBiomeStrength);
```

Exposed rock looks the same whatever biome surrounds it, and a desert tint
bleeding into the snowline looks obviously wrong.

---

## 12. Where this goes next

- [x] **1 — Scaffold.** Build tooling, render loop, CI deploy.
- [x] **2 — Terrain.** Seeded fBm heightmap, debug GUI, orbit controls, fog.
- [x] **3 — Camera.** Pointer-lock fly and walk modes.
- [x] **4 — Shading.** Slope/altitude materials, gradient sky, tone mapping.
- [x] **5a — Water.** Depth colour, waves, Fresnel, shore foam.
- [x] **5b — Scatter.** Instanced trees, rocks and shrubs, placed by rule.
- [x] **6 — Collision.** Solid ground, world edges, trees and rocks.
- [x] **7 — Shadows.** Sun shadows with a viewer-following shadow map.
- [x] **8 — Forests.** Clustered woodland with irregular, walkable boundaries.
- [x] **9 — Island.** Terrain falls away to ocean; travel limit offshore.
- [x] **10 — Biomes.** Five configurable biomes by altitude and moisture.
- [ ] **Chunking.** Terrain tiles with LOD, for an endless world.


Two things worth previewing, both from stage 5 — the point where the current
single-mesh approach stops scaling.

**Chunking and LOD.** Right now the terrain is one mesh at a fixed resolution.
At 512x512 that's half a million triangles for a 200-unit square, and a larger
world at the same detail would be unusable. The standard answer is to split the
terrain into chunks, generate them around the viewer, and render distant chunks
at lower resolution — a hill 400 units away doesn't need per-metre detail. The
hard part is the seams where differing resolutions meet.

**Water.** Deceptively involved. A flat blue plane at a fixed height is twenty
minutes' work and looks like a flat blue plane. Convincing water needs a moving
normal map for ripples, reflection, refraction through the surface, and depth-
based colour so shallows differ from deep. It's the first stage where custom
shaders become unavoidable — and so the point where the WebGPU question from
earlier becomes a real decision rather than a theoretical one.

---

## 13. Glossary

| Term | Meaning |
| --- | --- |
| **Albedo** | A surface's base colour, before lighting |
| **Canvas** | HTML element that is a drawable pixel rectangle |
| **CI** | Continuous integration — automated builds on push |
| **Delta time (`dt`)** | Seconds elapsed since the previous frame |
| **Dependency** | External package your project uses |
| **Dispose** | Explicitly free a GPU resource; not automatic |
| **Biome** | A region defined by climate; here altitude plus moisture |
| **Broad phase** | Cheap first pass narrowing what needs a real collision test |
| **Cascaded shadows** | Several shadow maps at increasing scales |
| **Circular import** | Two modules importing each other; fails at runtime |
| **Draw call** | One instruction to the GPU; the real cost of many meshes |
| **ES module** | Standard JavaScript `import`/`export` system |
| **fBm** | Fractal Brownian motion — summed octaves of noise |
| **Fragment shader** | GPU program computing one pixel's colour |
| **Fresnel** | Reflectivity rising at glancing view angles |
| **Frustum** | The truncated pyramid of space a camera can see |
| **Geometry** | Vertices and triangles; shape without appearance |
| **GLSL** | C-like language shaders are written in |
| **Heightmap** | Grid of heights defining a surface's relief |
| **HMR** | Hot module replacement — live code swap without reload |
| **Lacunarity** | Frequency multiplier between successive octaves |
| **LOD** | Level of detail — simpler geometry at distance |
| **dvh** | Dynamic viewport height; tracks mobile browser chrome |
| **Instancing** | Drawing many copies of one geometry in a single call |
| **Moisture field** | Noise standing in for rainfall, to place biomes |
| **Peter-panning** | Shadow detached from its caster, from excess bias |
| **Shadow acne** | Self-shadowing stipple from depth imprecision |
| **Shadow map** | Depth buffer rendered from the light's point of view |
| **Spatial hash** | Grid of buckets keyed by cell, for fast proximity queries |
| **Uniform grid** | Space divided into cells, for fast spatial lookup |
| **Jittered grid** | Even-ish random placement; cheap Poisson-disc stand-in |
| **Lockfile** | Exact recorded versions of every installed package |
| **Material** | How a surface responds to light |
| **Mesh** | Geometry + material; a visible object |
| **Minify** | Shrink code by removing whitespace and renaming |
| **Normal** | Vector describing which way a surface faces |
| **Pitch** | Rotation about the lateral axis; looking up and down |
| **npm** | JavaScript package registry and CLI |
| **Octave** | One layer of noise at a given frequency/amplitude |
| **Persistence** | Amplitude multiplier between successive octaves |
| **Pointer events** | Unified API for mouse, touch and stylus input |
| **Pointer lock** | Browser API giving relative mouse motion, cursor hidden |
| **PRNG** | Pseudo-random number generator; seedable, repeatable |
| **Roll** | Rotation about the view axis; tilting the horizon |
| **smoothstep** | Smooth 0-1 ramp between two thresholds |
| **Scene graph** | Tree of objects, parents transforming children |
| **Shader** | Small program that runs on the GPU |
| **Simplex noise** | Smooth seeded pseudo-random function |
| **Slope** | Steepness, derived from the surface normal's y component |
| **Source map** | File mapping built code back to original source |
| **Tone mapping** | Compressing bright values so highlights keep detail |
| **Tree-shaking** | Removing code nothing imports |
| **TypeScript** | JavaScript plus compile-time types |
| **Vertex** | A point in 3D space |
| **Vertex shader** | GPU program transforming one vertex |
| **Yaw** | Rotation about the vertical axis; turning left and right |
| **Vite** | Our dev server and build tool |
| **WebGL** | Browser API for GPU-accelerated graphics |
| **WebGPU** | WebGL's more capable successor |
| **z-fighting** | Flickering when surfaces are too close in depth |

---

## Further reading

- [Three.js manual](https://threejs.org/manual/) — start here; excellent
- [Three.js examples](https://threejs.org/examples/) — hundreds, with source
- [WebGL Fundamentals](https://webglfundamentals.org/) — what the library hides
- [Vite guide](https://vite.dev/guide/)
- [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Red Blob Games](https://www.redblobgames.com/) — superb interactive
  explanations of terrain, noise and pathfinding
