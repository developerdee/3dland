import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Viewer } from './engine/Viewer';
import { defaultParams, type TerrainParams } from './terrain/heightmap';
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

const controls = new OrbitControls(viewer.camera, canvas);
controls.enableDamping = true; // inertia; needs controls.update() each frame
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495; // stop just above horizontal
controls.minDistance = 10;
controls.maxDistance = 600;

function frameTerrain(): void {
  // Pull back proportionally to terrain size so a resize still fits on screen.
  const d = params.size;
  viewer.camera.position.set(d * 0.55, d * 0.42, d * 0.75);
  controls.target.set(0, params.amplitude * 0.2, 0);
  controls.update();
}
frameTerrain();

viewer.onUpdate(() => controls.update());

// --- Debug GUI ---

const hud = document.querySelector<HTMLDivElement>('#hud');

function regenerate(): void {
  const started = performance.now();
  terrain.rebuild(params);
  lastRebuildMs = performance.now() - started;
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
});

// --- HUD: FPS and terrain stats ---

let lastRebuildMs = 0;
let framesSinceSample = 0;
let timeSinceSample = 0;

viewer.onUpdate((dt) => {
  framesSinceSample += 1;
  timeSinceSample += dt;
  if (timeSinceSample < 0.5 || !hud) return;

  const fps = Math.round(framesSinceSample / timeSinceSample);
  const { min, max } = terrain.heightmap;
  const tris = terrain.triangleCount.toLocaleString();

  hud.textContent =
    `${fps} fps · ${tris} tris · height ${min.toFixed(1)} to ${max.toFixed(1)} · ` +
    `rebuild ${lastRebuildMs.toFixed(1)} ms`;

  framesSinceSample = 0;
  timeSinceSample = 0;
});

viewer.start();
