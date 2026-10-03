import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Viewer } from './engine/Viewer';
import { FlyControls } from './engine/FlyControls';
import { CameraModes, type CameraMode } from './engine/CameraModes';
import { defaultParams, sampleHeight, type TerrainParams } from './terrain/heightmap';
import { TerrainMesh } from './terrain/TerrainMesh';
import { createTerrainGui } from './terrain/gui';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('#scene canvas not found');

const viewer = new Viewer(canvas);

// --- Sky and atmosphere ---

const SKY = 0x8fb8e8;
viewer.scene.background = new THREE.Color(SKY);
// Fog hides the hard edge where the terrain stops, and gives distance cues.
viewer.scene.fog = new THREE.Fog(SKY, 180, 460);

// --- Lighting ---

// Sky above, warm bounced ground light below: cheap outdoor ambient that keeps
// shadowed slopes readable rather than black.
viewer.scene.add(new THREE.HemisphereLight(SKY, 0x5a4a38, 1.1));

const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
sun.position.set(-70, 90, 50);
viewer.scene.add(sun);

// --- Terrain ---

const params: TerrainParams = { ...defaultParams };
const terrain = new TerrainMesh(params);
viewer.scene.add(terrain.group);

// --- Camera controls ---

const orbit = new OrbitControls(viewer.camera, canvas);
orbit.enableDamping = true; // inertia; needs orbit.update() each frame
orbit.dampingFactor = 0.08;
orbit.maxPolarAngle = Math.PI * 0.495; // stop just above horizontal
orbit.minDistance = 10;
orbit.maxDistance = 600;

const fly = new FlyControls(viewer.camera, canvas, { speed: 40 });
fly.walkBounds = params.size / 2;

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
  // Terrain `size` may have changed, so the walkable area moves with it.
  fly.walkBounds = params.size / 2;
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
});

// --- Camera modes ---

const hint = document.querySelector<HTMLDivElement>('#hint');

function setMode(mode: CameraMode): void {
  cameraModes.set(mode);
  // Keep the dropdown's bound value current, or a hotkey switch would leave
  // the GUI showing the old mode.
  modeRef.value = cameraModes.mode;
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  updateHint();
}

function updateHint(): void {
  if (!hint) return;
  const mode = cameraModes.mode;

  if (mode === 'orbit') {
    hint.innerHTML =
      '<b>orbit</b> — drag to turn, scroll to zoom · ' +
      'press <kbd>F</kbd> to fly, <kbd>G</kbd> to walk';
    hint.classList.remove('hidden');
    return;
  }

  if (!fly.isLocked) {
    hint.innerHTML =
      `<b>${mode}</b> — <b>click to look around</b> · ` +
      '<kbd>O</kbd> for orbit, <kbd>Esc</kbd> to release';
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
updateHint();

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
