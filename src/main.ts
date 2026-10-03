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
const terrain = new TerrainMesh(params);
terrain.applyShading(shading);
viewer.scene.add(terrain.group);

// Sun azimuth/elevation are more intuitive to tune than a position vector.
const sunAngles = { azimuth: 135, elevation: 42 };

function placeSun(): void {
  const az = THREE.MathUtils.degToRad(sunAngles.azimuth);
  const el = THREE.MathUtils.degToRad(sunAngles.elevation);
  const d = 400;
  sun.position.set(
    Math.cos(el) * Math.sin(az) * d,
    Math.sin(el) * d,
    Math.cos(el) * Math.cos(az) * d,
  );
}
placeSun();

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
fly.walkBounds = params.size / 2;

function speedForMode(mode: CameraMode): number {
  return mode === 'walk' ? WALK_SPEED : params.size * FLY_SPEED_FRACTION;
}

// Height lookup reads the live terrain, so walk mode follows a regenerated
// surface rather than a stale copy.
const groundAt = (x: number, z: number) => sampleHeight(terrain.heightmap, x, z);

const EYE_HEIGHT = 1.8;
const cameraModes = new CameraModes(viewer.camera, orbit, fly, groundAt, EYE_HEIGHT);
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

// --- Debug GUI ---

const hud = document.querySelector<HTMLDivElement>('#hud');

function regenerate(): void {
  const started = performance.now();
  terrain.rebuild(params);
  lastRebuildMs = performance.now() - started;

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
    p.y = groundAt(p.x, p.z) + EYE_HEIGHT;
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
    regenerate();
  },
  onShareSeed: () => {
    const url = `${location.origin}${location.pathname}?seed=${encodeURIComponent(params.seed)}`;
    void navigator.clipboard?.writeText(url).then(
      () => flash('link copied'),
      () => flash(url),
    );
  },
});

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

// Open on foot in the landscape rather than on a debug overview: walking is
// the point, and orbit is for inspecting the terrain. Spawn near the middle
// looking outward — frameTerrain() left the camera outside the world, which
// walk mode would clamp to a corner.
viewer.camera.position.set(0, 0, 0);
viewer.camera.lookAt(params.size * 0.25, 0, params.size * 0.25);
setMode('walk');

// --- HUD: FPS and terrain stats ---

let lastRebuildMs = 0;
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

  hud.textContent =
    `${fps} fps · ${tris} tris · ${cameraModes.mode} · ` +
    `x ${p.x.toFixed(0)} y ${p.y.toFixed(1)} z ${p.z.toFixed(0)} · ` +
    `ground ${ground.toFixed(1)} · rebuild ${lastRebuildMs.toFixed(1)} ms`;

  framesSinceSample = 0;
  timeSinceSample = 0;
});

viewer.start();
