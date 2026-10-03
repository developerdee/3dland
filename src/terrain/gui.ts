import GUI from 'lil-gui';
import type { TerrainParams } from './heightmap';

export interface TerrainGuiOptions {
  params: TerrainParams;
  /** Called after any parameter change, to regenerate the terrain. */
  onChange: () => void;
  /** Toggles the wireframe overlay. */
  onWireframeChange: (visible: boolean) => void;
  /** Re-seeds with a random value and regenerates. */
  onRandomSeed: () => void;
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
  const gui = new GUI({ title: '3dland — terrain' });

  const view = { wireframe: false };

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
  world.add({ randomize: onRandomSeed }, 'randomize').name('random seed');
  world.add(params, 'size', 50, 500, 10).name('size (units)').onFinishChange(onChange);
  world
    .add(params, 'resolution', [64, 128, 256, 512])
    .name('resolution')
    .onChange(onChange);

  const display = gui.addFolder('Display');
  display.add(view, 'wireframe').name('wireframe').onChange(onWireframeChange);

  detail.close();
  world.close();
  display.close();

  return gui;
}
