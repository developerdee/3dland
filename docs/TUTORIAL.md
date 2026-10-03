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

## 12. Where this goes next

- [x] **1 — Scaffold.** Build tooling, render loop, CI deploy.
- [x] **2 — Terrain.** Seeded fBm heightmap, debug GUI, orbit controls, fog.
- [x] **3 — Camera.** Pointer-lock fly and walk modes.
- [x] **4 — Shading.** Slope/altitude materials, gradient sky, tone mapping.
- [ ] **5 — Scale.** Water; chunked terrain with LOD.
- [ ] **6 — Interaction.** Collision and character movement.

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
| **ES module** | Standard JavaScript `import`/`export` system |
| **fBm** | Fractal Brownian motion — summed octaves of noise |
| **Fragment shader** | GPU program computing one pixel's colour |
| **Frustum** | The truncated pyramid of space a camera can see |
| **Geometry** | Vertices and triangles; shape without appearance |
| **GLSL** | C-like language shaders are written in |
| **Heightmap** | Grid of heights defining a surface's relief |
| **HMR** | Hot module replacement — live code swap without reload |
| **Lacunarity** | Frequency multiplier between successive octaves |
| **LOD** | Level of detail — simpler geometry at distance |
| **Lockfile** | Exact recorded versions of every installed package |
| **Material** | How a surface responds to light |
| **Mesh** | Geometry + material; a visible object |
| **Minify** | Shrink code by removing whitespace and renaming |
| **Normal** | Vector describing which way a surface faces |
| **Pitch** | Rotation about the lateral axis; looking up and down |
| **npm** | JavaScript package registry and CLI |
| **Octave** | One layer of noise at a given frequency/amplitude |
| **Persistence** | Amplitude multiplier between successive octaves |
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
