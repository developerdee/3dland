import GUI from 'lil-gui';
import type { TerrainParams } from './heightmap';
import type { TerrainShadingParams } from './TerrainMaterial';

/** Mutable holder so the dropdown and the keyboard shortcuts stay in sync. */
export interface ModeRef {
  value: 'orbit' | 'fly' | 'walk';
}

export interface TerrainGuiOptions {
  params: TerrainParams;
  /** Called after any parameter change, to regenerate the terrain. */
  onChange: () => void;
  /** Toggles the wireframe overlay. */
  onWireframeChange: (visible: boolean) => void;
  /** Re-seeds with a random value and regenerates. */
  onRandomSeed: () => void;
  /** Current camera mode, kept current so `updateDisplay()` reflects hotkeys. */
  mode: ModeRef;
  onModeChange: (mode: 'orbit' | 'fly' | 'walk') => void;
  /** Movement speed, exposed as a slider. */
  flySpeed: { speed: number };
  /** Shading controls. Uniform-only, so changes need no terrain rebuild. */
  shading: TerrainShadingParams;
  onShadingChange: () => void;
  /** Sun azimuth and elevation, in degrees. */
  sun: { azimuth: number; elevation: number };
  onSunChange: () => void;
  /** Mesh density preset. Changing it rebuilds the terrain. */
  quality: { level: 'low' | 'medium' | 'high' };
  onQualityChange: () => void;
  /** Copies a shareable URL pinning the current seed. */
  onShareSeed: () => void;
}

/**
 * Builds the parameter panel.
 *
 * Terrain parameters have no correct values — only values that look right,
 * found by sweeping a slider and watching the hills change. Sliders plus
 * hot reload turn that from a recompile-per-guess chore into something you
 * can do by feel in a couple of minutes.
 *
 * Note `onFinishChange` rather than `onChange` for the expensive controls:
 * regenerating a 256x256 heightmap takes a few milliseconds, and doing that
 * on every pixel of slider drag makes the UI feel sticky. Firing on release
 * keeps dragging smooth.
 */
export function createTerrainGui(options: TerrainGuiOptions): GUI {
  const { params, onChange, onWireframeChange, onRandomSeed } = options;
  const gui = new GUI({ title: '3dland' });

  const view = { wireframe: false };

  // Quality first: it is the control most likely to be wanted, especially on
  // a phone where the default is deliberately conservative.
  gui
    .add(options.quality, 'level', ['low', 'medium', 'high'])
    .name('detail')
    .onChange(options.onQualityChange);

  const camera = gui.addFolder('Camera');
  camera
    .add(options.mode, 'value', ['orbit', 'fly', 'walk'])
    .name('mode (O / F / G)')
    .onChange((m: 'orbit' | 'fly' | 'walk') => options.onModeChange(m));
  camera.add(options.flySpeed, 'speed', 5, 200, 1).name('speed (units/s)');

  const shape = gui.addFolder('Shape');
  shape.add(params, 'amplitude', 0, 80, 0.5).name('amplitude (height)').onChange(onChange);
  shape.add(params, 'frequency', 0.1, 6, 0.05).name('frequency (scale)').onFinishChange(onChange);
  shape.add(params, 'exponent', 0.5, 4, 0.05).name('exponent (valleys)').onFinishChange(onChange);
  shape.add(params, 'ridged').name('ridged (mountains)').onChange(onChange);
  shape.add(params, 'normalizeRange').name('fill amplitude').onChange(onChange);

  const detail = gui.addFolder('Detail');
  detail.add(params, 'octaves', 1, 8, 1).name('octaves').onFinishChange(onChange);
  detail.add(params, 'persistence', 0.2, 0.8, 0.01).name('persistence').onFinishChange(onChange);
  detail.add(params, 'lacunarity', 1.2, 4, 0.1).name('lacunarity').onFinishChange(onChange);

  const world = gui.addFolder('World');
  world.add(params, 'seed').name('seed').onFinishChange(onChange);
  world.add({ randomize: onRandomSeed }, 'randomize').name('new world');
  world.add({ share: options.onShareSeed }, 'share').name('copy link to world');
  world.add(params, 'size', 200, 2000, 50).name('size (units)').onFinishChange(onChange);

  // Shading is uniform-only, so these fire on every drag frame rather than on
  // release — the feedback is immediate and costs nothing.
  const { shading, onShadingChange: s } = options;
  const look = gui.addFolder('Shading');
  look.add(shading, 'shoreLine', 0, 0.4, 0.01).name('shore line').onChange(s);
  look.add(shading, 'rockLine', 0, 1, 0.01).name('rock line').onChange(s);
  look.add(shading, 'snowLine', 0, 1, 0.01).name('snow line').onChange(s);
  look.add(shading, 'slopeRockStart', 0, 1, 0.01).name('slope rock from').onChange(s);
  look.add(shading, 'slopeRockFull', 0, 1, 0.01).name('slope rock full').onChange(s);
  look.add(shading, 'blend', 0.001, 0.3, 0.005).name('band blend').onChange(s);
  look.add(shading, 'macroVariation', 0, 0.4, 0.01).name('colour variation').onChange(s);

  const light = gui.addFolder('Sun');
  light.add(options.sun, 'azimuth', 0, 360, 1).name('azimuth°').onChange(options.onSunChange);
  light.add(options.sun, 'elevation', 2, 88, 1).name('elevation°').onChange(options.onSunChange);

  const display = gui.addFolder('Display');
  display.add(view, 'wireframe').name('wireframe').onChange(onWireframeChange);

  detail.close();
  world.close();
  light.close();
  display.close();

  return gui;
}
