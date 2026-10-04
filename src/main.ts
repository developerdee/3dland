import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Viewer } from './engine/Viewer';
import { FlyControls } from './engine/FlyControls';
import { CameraModes, type CameraMode } from './engine/CameraModes';
import { Sky } from './engine/Sky';
import { TouchControls } from './engine/TouchControls';
import { ModeButtons } from './engine/ModeButtons';
import {
  defaultParams,
  randomSeed,
  sampleHeight,
  QUALITY,
  type QualityLevel,
  type TerrainParams,
} from './terrain/heightmap';
import { TerrainMesh } from './terrain/TerrainMesh';
import { defaultShading, type TerrainShadingParams } from './terrain/TerrainMaterial';
import { Water, defaultWater, type WaterParams } from './terrain/Water';
import { Collision } from './engine/Collision';
import { Shadows, type ShadowQuality } from './engine/Shadows';
import { Scatter } from './terrain/Scatter';
import { defaultScatter, type ScatterParams } from './terrain/placement';
import { createTerrainGui } from './terrain/gui';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('#scene canvas not found');

const viewer = new Viewer(canvas);

// --- Sky and atmosphere ---

const sky = new Sky();
viewer.scene.add(sky.mesh);
viewer.onUpdate(() => sky.follow(viewer.camera));

// Backstop behind the dome. Viewer's default is near-black, which looks like a
// shader failure rather than a gap if the dome is ever clipped or culled.
viewer.scene.background = sky.horizonColor.clone();

// Fog matched to the horizon colour, so the terrain edge dissolves into the
// sky instead of ending at a visible line. Exponential-squared falls off more
// naturally with distance than linear fog.
viewer.scene.fog = new THREE.FogExp2(sky.horizonColor.getHex(), 0.0022);

// Filmic tone mapping: the default (none) clips bright sunlit slopes to flat
// white. This compresses highlights the way a camera does.
viewer.renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewer.renderer.toneMappingExposure = 1.05;

// --- Lighting ---

// Sky above, warm bounced ground light below: cheap outdoor ambient that keeps
// shadowed slopes readable rather than black.
const ambient = new THREE.HemisphereLight(sky.horizonColor.getHex(), 0x4a3f33, 0.85);
viewer.scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff2d8, 2.6);
sun.position.set(-70, 90, 50);
viewer.scene.add(sun);
// A directional light aims at its target object, so that target has to be in
// the scene graph for its world matrix to be maintained.
viewer.scene.add(sun.target);

/**
 * The sun's direction, held separately from `sun.position`.
 *
 * Shadows move the light every frame to keep its shadow camera near the
 * viewer, so its position no longer encodes the direction. Anything needing
 * "where is the sun" — the water shader — must read this instead.
 */
const sunDirection = new THREE.Vector3(-70, 90, 50).normalize();

const shadows = new Shadows(viewer.renderer, sun);

// --- Terrain ---

// A fresh world each load, unless a seed is pinned in the URL — so a world
// worth keeping can be bookmarked or shared, and a bug can be reproduced.
const urlSeed = new URLSearchParams(location.search).get('seed');
const touchDevice = TouchControls.isTouchDevice();

// Phones are usually fill-rate bound well before they are vertex bound, but
// 500k triangles is a lot to ask of one either way; start them low.
const initialQuality: QualityLevel = touchDevice ? 'low' : 'medium';

const params: TerrainParams = {
  ...defaultParams,
  seed: urlSeed ?? randomSeed(),
  resolution: QUALITY[initialQuality],
};
const quality = { level: initialQuality };
const shading: TerrainShadingParams = { ...defaultShading };
const water: WaterParams = { ...defaultWater };
const waterEnabled = { on: true };
// Vegetation density is the main render-cost dial after mesh detail, so touch
// devices start lighter.
/** Vegetation density per detail level, paired with the mesh resolutions. */
const DENSITY_BY_QUALITY: Record<QualityLevel, number> = {
  low: 0.45,
  medium: 1,
  high: 1.5,
};

const scatterParams: ScatterParams = {
  ...defaultScatter,
  densityScale: DENSITY_BY_QUALITY[initialQuality],
};
const scatterEnabled = { on: true };
const collisionEnabled = { on: true };
// Shadows are the most expensive single feature here — they re-render the
// casters from the sun's point of view each frame — so phones start lower.
const shadowQuality: { level: ShadowQuality } = {
  level: touchDevice ? 'low' : 'medium',
};
const terrain = new TerrainMesh(params);
terrain.applyShading(shading);
viewer.scene.add(terrain.group);

// Declared before the rebuild helpers that assign them: `let` is not hoisted,
// so assigning from a function called during startup would otherwise throw.
let lastRebuildMs = 0;
let lastScatterMs = 0;

// Declared with the world objects it serves, ahead of the startup block that
// feeds it the first terrain.
const collision = new Collision();

const scatter = new Scatter();
viewer.scene.add(scatter.group);

const sea = new Water();
viewer.scene.add(sea.mesh);
viewer.onUpdate((_dt, elapsed) => sea.update(elapsed));

// Feed the initial terrain in: regenerate() handles later changes, but it is
// only called on a parameter change, so without this the water would stay
// invisible until the first slider was touched.
{
  const hm = terrain.heightmap;
  sea.setTerrain(hm.heights, hm.resolution, hm.size, hm.min, hm.max);
  sea.apply(water);
  sea.visible = waterEnabled.on;
  syncShoreline();
  collision.setTerrain(terrain.heightmap);
  rebuildScatter();
}

// Sun azimuth/elevation are more intuitive to tune than a position vector.
const sunAngles = { azimuth: 135, elevation: 42 };

function placeSun(): void {
  const az = THREE.MathUtils.degToRad(sunAngles.azimuth);
  const el = THREE.MathUtils.degToRad(sunAngles.elevation);
  sunDirection
    .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
    .normalize();

  // Without shadows nothing moves the light, so place it once here. With
  // shadows on, follow() overrides this every frame.
  sun.position.copy(sunDirection).multiplyScalar(400);

  // Water does its own lighting in a raw ShaderMaterial, so it has to be told
  // where the sun is — otherwise its specular highlight contradicts the
  // terrain's shading.
  sea.setEnvironment(sunDirection, sky.zenithColor, sky.horizonColor);
}
placeSun();

// Apply the initial quality: constructing Shadows configures nothing on its
// own, so without this shadows would stay off until the dropdown was touched.
shadows.set(shadowQuality.level);
shadows.follow(viewer.camera, sunDirection);

// --- Camera controls ---

const orbit = new OrbitControls(viewer.camera, canvas);
orbit.enableDamping = true; // inertia; needs orbit.update() each frame
orbit.dampingFactor = 0.08;
orbit.maxPolarAngle = Math.PI * 0.495; // stop just above horizontal
orbit.minDistance = 10;
orbit.maxDistance = 600;

// Walking and flying want very different speeds: a human pace makes a 1000-unit
// world feel like a landscape, while flying at that speed is tedious. Each mode
// sets its own, scaled to the world so a resize keeps them proportionate.
const WALK_SPEED = 6.5;
const FLY_SPEED_FRACTION = 0.085; // of world size per second

const fly = new FlyControls(viewer.camera, canvas, { speed: WALK_SPEED });
fly.collision = collision;
fly.walkBounds = params.size / 2;

function speedForMode(mode: CameraMode): number {
  return mode === 'walk' ? WALK_SPEED : params.size * FLY_SPEED_FRACTION;
}

// Height lookup reads the live terrain, so walk mode follows a regenerated
// surface rather than a stale copy.
const groundAt = (x: number, z: number) => sampleHeight(terrain.heightmap, x, z);

/**
 * Walking surface: the terrain, but never far below the waterline — so you
 * wade into the shallows and stop, rather than strolling along the seabed
 * with the surface overhead.
 */
const WADE_DEPTH = 1.1;

function walkSurfaceAt(x: number, z: number): number {
  const ground = groundAt(x, z);
  if (!sea.visible) return ground;
  return Math.max(ground, sea.surfaceY - WADE_DEPTH);
}

const EYE_HEIGHT = 1.8;
const cameraModes = new CameraModes(viewer.camera, orbit, fly, walkSurfaceAt, EYE_HEIGHT);
const modeRef = { value: cameraModes.mode };

function frameTerrain(): void {
  // Pull back proportionally to terrain size so a resize still fits on screen.
  const d = params.size;
  viewer.camera.position.set(d * 0.55, d * 0.42, d * 0.75);
  orbit.target.set(0, params.amplitude * 0.2, 0);
  orbit.update();
}
frameTerrain();

viewer.onUpdate((dt) => cameraModes.update(dt));

// Keep the shadow region centred on the viewer.
viewer.onUpdate(() => shadows.follow(viewer.camera, sunDirection));

// --- Debug GUI ---

const hud = document.querySelector<HTMLDivElement>('#hud');

function regenerate(): void {
  const started = performance.now();
  terrain.rebuild(params);
  lastRebuildMs = performance.now() - started;

  // Water reads depth from the terrain, so it must be re-fed or it keeps the
  // shape of the previous landscape.
  const hm = terrain.heightmap;
  sea.setTerrain(hm.heights, hm.resolution, hm.size, hm.min, hm.max);
  sea.apply(water);
  sea.visible = waterEnabled.on;
  // A rebuild resets the material's height range, so the beach band has to be
  // re-derived against it.
  syncShoreline();

  // Collision reads the live heightmap, so it must be re-pointed at the new
  // one — and the world edge moves with `size`.
  collision.setTerrain(terrain.heightmap);

  // Props are placed against the terrain and the waterline, so both must be
  // settled before this runs.
  rebuildScatter();

  // Terrain `size` may have changed, so the walkable area and the fly speed
  // that is scaled to it both move with it.
  fly.walkBounds = params.size / 2;
  fly.speed = speedForMode(cameraModes.mode);

  // A smaller world can leave the camera outside it, or buried under new
  // terrain. Lift it back to the surface rather than stranding it.
  if (cameraModes.mode === 'walk') {
    const p = viewer.camera.position;
    const b = params.size / 2;
    p.x = Math.min(Math.max(p.x, -b), b);
    p.z = Math.min(Math.max(p.z, -b), b);
    p.y = walkSurfaceAt(p.x, p.z) + EYE_HEIGHT;
  }
}

const gui = createTerrainGui({
  params,
  onChange: regenerate,
  onWireframeChange: (visible) => {
    terrain.wireframeVisible = visible;
  },
  onRandomSeed: () => {
    params.seed = Math.random().toString(36).slice(2, 10);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    regenerate();
  },
  mode: modeRef,
  onModeChange: (mode) => setMode(mode),
  flySpeed: fly,
  shading,
  onShadingChange: () => terrain.applyShading(shading),
  sun: sunAngles,
  onSunChange: placeSun,
  quality,
  onQualityChange: () => {
    params.resolution = QUALITY[quality.level];
    // Vegetation is the other half of the render cost, so the detail control
    // moves it too — otherwise dropping to low would still leave thousands of
    // props to draw.
    scatterParams.densityScale = DENSITY_BY_QUALITY[quality.level];
    regenerate();
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  },
  shadows: shadowQuality,
  onShadowChange: () => {
    shadows.set(shadowQuality.level);
    shadows.follow(viewer.camera, sunDirection);
  },
  collisionEnabled,
  onCollisionChange: (on) => collision.setEnabled(on),
  scatter: scatterParams,
  scatterEnabled,
  onScatterChange: rebuildScatter,
  water,
  waterEnabled,
  onWaterChange: () => {
    sea.visible = waterEnabled.on;
    sea.apply(water);
    syncShoreline();
    // Props avoid the water, so moving sea level must replace them.
    rebuildScatter();
    // Sea level moves the walking surface, so a walker standing in the
    // shallows must be lifted or dropped to match.
    if (cameraModes.mode === 'walk') {
      const p = viewer.camera.position;
      p.y = walkSurfaceAt(p.x, p.z) + EYE_HEIGHT;
    }
  },
  onShareSeed: () => {
    const url = `${location.origin}${location.pathname}?seed=${encodeURIComponent(params.seed)}`;
    void navigator.clipboard?.writeText(url).then(
      () => flash('link copied'),
      () => flash(url),
    );
  },
});

/**
 * Replaces the vegetation. Placement depends on the terrain *and* the
 * waterline, so this must run after both are settled.
 */
function rebuildScatter(): void {
  const started = performance.now();
  scatter.rebuild(
    {
      map: terrain.heightmap,
      waterLevel: sea.visible ? sea.surfaceY : null,
      // Shares the terrain's seed, so a world's vegetation is as reproducible
      // as its landscape.
      seed: params.seed,
    },
    scatterParams,
  );
  scatter.visible = scatterEnabled.on;

  // Only what is drawn should block: hiding the props must also remove their
  // collision, or you would walk into invisible trees.
  collision.setObstacles(scatterEnabled.on ? scatter.collisionVolumes : []);

  lastScatterMs = performance.now() - started;
}

/**
 * Puts the sand band just above the waterline.
 *
 * The shading's shore band and the water's level are both fractions of the
 * terrain range, but nothing tied them together: at the default sea level the
 * sand sat well below the surface, so beaches were never visible. Deriving it
 * means moving sea level carries the beach with it.
 */
function syncShoreline(): void {
  const BEACH_BAND = 0.04;
  shading.shoreLine = waterEnabled.on
    ? Math.min(water.level + BEACH_BAND, 1)
    : defaultShading.shoreLine;
  terrain.applyShading(shading);
}

/** Brief toast, for feedback the GUI cannot give itself. */
function flash(message: string): void {
  if (!hint) return;
  hint.textContent = message;
  hint.classList.remove('hidden');
  window.setTimeout(updateHint, 1800);
}

// --- On-screen controls ---

const touch = new TouchControls();
document.body.appendChild(touch.root);
touch.visible = touchDevice;

const modeButtons = new ModeButtons((mode) => setMode(mode));
document.body.appendChild(modeButtons.root);

// Feed touch intent into the fly controller each frame, before it integrates.
viewer.onUpdate(() => {
  if (!touch.visible) return;
  const t = touch.consume();
  fly.setExternalMove(t.moveX, t.moveY, t.vertical, t.boost);
  fly.applyLookDelta(t.lookDX, t.lookDY);
});

// --- Camera modes ---

const hint = document.querySelector<HTMLDivElement>('#hint');

function setMode(mode: CameraMode): void {
  cameraModes.set(mode);
  // Keep the dropdown's bound value current, or a hotkey switch would leave
  // the GUI showing the old mode.
  modeRef.value = cameraModes.mode;
  fly.speed = speedForMode(cameraModes.mode);
  modeButtons.setActive(cameraModes.mode);

  // The touch sticks only make sense where they drive something, and the
  // vertical pair only in fly mode.
  touch.visible = touchDevice && cameraModes.mode !== 'orbit';
  touch.verticalEnabled = cameraModes.mode === 'fly';

  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  updateHint();
}

function updateHint(): void {
  if (!hint) return;
  const mode = cameraModes.mode;

  if (touchDevice) {
    // The sticks are self-explanatory once seen, so only orbit needs a word.
    if (mode === 'orbit') {
      hint.innerHTML = '<b>overview</b> — drag to turn, pinch to zoom';
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
    return;
  }

  if (mode === 'orbit') {
    hint.innerHTML =
      '<b>overview</b> — drag to turn, scroll to zoom · ' +
      'press <kbd>F</kbd> to fly, <kbd>G</kbd> to walk';
    hint.classList.remove('hidden');
    return;
  }

  if (!fly.isLocked) {
    hint.innerHTML =
      `<b>${mode}</b> — <b>click to look around</b> · ` +
      'WASD to move · <kbd>Esc</kbd> to release';
    hint.classList.remove('hidden');
    return;
  }

  // Pointer is locked and the user is moving: get out of the way.
  hint.classList.add('hidden');
}

document.addEventListener('keydown', (e) => {
  // Don't steal keys while a GUI text field (the seed box) has focus.
  const target = e.target as HTMLElement | null;
  if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

  if (e.code === 'KeyO') setMode('orbit');
  else if (e.code === 'KeyF') setMode('fly');
  else if (e.code === 'KeyG') setMode('walk');
});

// The hint depends on pointer-lock state, which can change without a keypress.
document.addEventListener('pointerlockchange', updateHint);

/**
 * Finds dry ground to start on, spiralling out from the centre.
 *
 * With water covering around a fifth of an average world, roughly one load in
 * five would otherwise begin underwater. Dry land is found within a handful of
 * samples, so this is far cheaper than it looks.
 */
function findSpawn(): { x: number; z: number } {
  const half = params.size / 2;
  const minimumHeight = sea.visible ? sea.surfaceY + 1.5 : -Infinity;

  for (let ring = 0; ring <= 12; ring++) {
    const radius = ring * params.size * 0.045;
    const samples = Math.max(1, ring * 6);
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      if (groundAt(x, z) > minimumHeight) return { x, z };
    }
  }

  // Every sample was underwater — a fully flooded world. Start at the centre
  // and let the wade clamp handle it rather than failing.
  return { x: 0, z: 0 };
}

// Open on foot in the landscape rather than on a debug overview: walking is
// the point, and orbit is for inspecting the terrain.
const spawn = findSpawn();
viewer.camera.position.set(spawn.x, 0, spawn.z);
// Face inward, so there is terrain ahead rather than the world's edge. At the
// exact centre any direction is equivalent, and lookAt on your own position is
// undefined — so pick an arbitrary heading there.
const inward = Math.hypot(spawn.x, spawn.z) > 1
  ? new THREE.Vector3(0, 0, 0)
  : new THREE.Vector3(params.size * 0.25, 0, params.size * 0.25);
viewer.camera.lookAt(inward);
setMode('walk');

// --- HUD: FPS and terrain stats ---

let framesSinceSample = 0;
let timeSinceSample = 0;

viewer.onUpdate((dt) => {
  framesSinceSample += 1;
  timeSinceSample += dt;
  if (timeSinceSample < 0.5 || !hud) return;

  const fps = Math.round(framesSinceSample / timeSinceSample);
  const tris = terrain.triangleCount.toLocaleString();
  const p = viewer.camera.position;
  const ground = groundAt(p.x, p.z);

  // Depth under the camera, when there is water above the seabed there.
  const depth = sea.visible ? sea.surfaceY - ground : 0;
  const depthLabel = depth > 0.05 ? ` · depth ${depth.toFixed(1)}` : '';

  const props = scatter.visible ? ` · ${scatter.instanceCount.toLocaleString()} props` : '';
  const solid = collisionEnabled.on ? '' : ' · noclip';

  hud.textContent =
    `${fps} fps · ${tris} tris${props} · ${cameraModes.mode}${solid} · ` +
    `x ${p.x.toFixed(0)} y ${p.y.toFixed(1)} z ${p.z.toFixed(0)} · ` +
    `ground ${ground.toFixed(1)}${depthLabel} · ` +
    `rebuild ${lastRebuildMs.toFixed(0)}+${lastScatterMs.toFixed(0)} ms`;

  framesSinceSample = 0;
  timeSinceSample = 0;
});

viewer.start();
