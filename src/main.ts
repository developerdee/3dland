import * as THREE from 'three';
import { Viewer } from './engine/Viewer';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('#scene canvas not found');

const viewer = new Viewer(canvas);

// --- Placeholder scene: stage 2 replaces this with generated terrain. ---

viewer.scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x2b2118, 1.2));

const sun = new THREE.DirectionalLight(0xfff0d4, 2.0);
sun.position.set(4, 6, 3);
viewer.scene.add(sun);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.4, 1.4, 1.4),
  new THREE.MeshStandardMaterial({ color: 0x4f7cff, roughness: 0.45, metalness: 0.1 }),
);
cube.position.y = 0.7;
viewer.scene.add(cube);

const grid = new THREE.GridHelper(20, 20, 0x3a4a6b, 0x1e2636);
viewer.scene.add(grid);

viewer.onUpdate((dt) => {
  cube.rotation.y += dt * 0.6;
  cube.rotation.x += dt * 0.25;
});

// --- FPS readout, so performance regressions in later stages are obvious. ---

const hud = document.querySelector<HTMLDivElement>('#hud');
let framesSinceSample = 0;
let timeSinceSample = 0;

viewer.onUpdate((dt) => {
  framesSinceSample += 1;
  timeSinceSample += dt;
  if (timeSinceSample < 0.5 || !hud) return;
  const fps = Math.round(framesSinceSample / timeSinceSample);
  hud.textContent = `stage 1 — scaffold · ${fps} fps`;
  framesSinceSample = 0;
  timeSinceSample = 0;
});

viewer.start();
