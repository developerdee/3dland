import GUI from 'lil-gui';
import type { TerrainParams } from './heightmap';
import type { TerrainShadingParams } from './TerrainMaterial';
import type { WaterParams } from './Water';
import type { ScatterParams } from './placement';
import { BIOME_IDS, type BiomeParams } from './biomes';

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
  /** Water surface controls. Uniform-only, bar the on/off toggle. */
  water: WaterParams;
  waterEnabled: { on: boolean };
  onWaterChange: () => void;
  /** Biome distribution and per-biome settings. */
  biomes: BiomeParams;
  biomesEnabled: { on: boolean };
  onBiomeChange: () => void;
  /** Shadow quality. Higher covers more ground at finer resolution. */
  shadows: { level: 'off' | 'low' | 'medium' | 'high' };
  onShadowChange: () => void;
  /** Collision on or off, for inspecting the world unobstructed. */
  collisionEnabled: { on: boolean };
  onCollisionChange: (on: boolean) => void;
  /** Vegetation density and limits. Changing these replaces the props. */
  scatter: ScatterParams;
  scatterEnabled: { on: boolean };
  onScatterChange: () => void;
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
  world.add(params, 'island').name('island').onFinishChange(onChange);
  world.add(params, 'islandFalloff', 0.1, 0.6, 0.02).name('coast width').onFinishChange(onChange);
  world.add(params, 'islandDepth', 0.1, 1.2, 0.05).name('ocean depth').onFinishChange(onChange);

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

  // Scatter rebuilds geometry, so these fire on release rather than on drag.
  // Biomes: a folder per biome, each independently switchable with its own
  // share of the map and its own vegetation density.
  const ob = options.onBiomeChange;
  const bio = gui.addFolder('Biomes');
  bio.add(options.biomesEnabled, 'on').name('biomes on').onFinishChange(ob);
  bio.add(options.biomes, 'moistureScale', 0.4, 4, 0.1).name('region size').onFinishChange(ob);
  bio.add(options.biomes, 'blend', 0, 0.3, 0.01).name('edge blend').onFinishChange(ob);
  for (const id of BIOME_IDS) {
    const folder = bio.addFolder(id);
    folder.add(options.biomes[id], 'enabled').name('enabled').onFinishChange(ob);
    folder.add(options.biomes[id], 'weight', 0, 2, 0.05).name('share of map').onFinishChange(ob);
    folder.add(options.biomes[id], 'vegetation', 0, 1.5, 0.05).name('vegetation').onFinishChange(ob);
    folder.close();
  }
  bio.close();

  const { scatter: sc, onScatterChange: os } = options;
  const plants = gui.addFolder('Vegetation');
  plants.add(options.scatterEnabled, 'on').name('show all vegetation').onChange(os);

  // Forests
  const woods = plants.addFolder('Forests');
  woods.add(sc, 'forestsEnabled').name('show forests').onFinishChange(os);
  woods.add(sc.forests, 'count', 0, 20, 1).name('how many').onFinishChange(os);
  woods.add(sc.forests, 'radius', 30, 220, 5).name('size (units)').onFinishChange(os);
  woods.add(sc.forests, 'radiusVariation', 0, 0.8, 0.05).name('size variation').onFinishChange(os);
  // Spacing is clamped to the walkability floor internally, so the slider
  // cannot produce an impassable forest however far it is pushed. Lower is
  // denser, hence the inverted reading of this control.
  woods.add(sc.forests, 'spacing', 3, 14, 0.2).name('tree spacing (low=dense)').onFinishChange(os);
  woods.add(sc.forests, 'edgeRoughness', 0, 1, 0.05).name('edge roughness').onFinishChange(os);
  woods.add(sc.forests, 'edgeSoftness', 0.05, 0.8, 0.05).name('edge fade').onFinishChange(os);

  // Lone trees, independent of the forests above.
  const lone = plants.addFolder('Lone trees');
  lone.add(sc, 'looseTrees').name('show lone trees').onFinishChange(os);
  lone.add(sc.trees, 'density', 0, 30, 0.5).name('density').onFinishChange(os);

  // These limit where any tree will grow, in a forest or alone — a treeline is
  // a property of the climate, not of a tree's sociability — so they sit apart
  // from either group rather than inside one and silently affecting both.
  const limits = plants.addFolder('Tree limits (both)');
  limits.add(sc.trees, 'maxAltitude', 0, 1, 0.01).name('treeline').onFinishChange(os);
  limits.add(sc.trees, 'maxSlope', 0.1, 1, 0.02).name('max slope').onFinishChange(os);

  const ground = plants.addFolder('Rocks and shrubs');
  ground.add(sc.rocks, 'density', 0, 40, 1).name('rocks').onFinishChange(os);
  ground.add(sc.shrubs, 'density', 0, 80, 1).name('shrubs').onFinishChange(os);

  woods.open();
  lone.open();
  limits.close();
  ground.close();

  const { water: w, onWaterChange: ow } = options;
  const sea = gui.addFolder('Water');
  sea.add(options.waterEnabled, 'on').name('enabled').onChange(ow);
  sea.add(w, 'level', 0, 0.8, 0.005).name('sea level').onChange(ow);
  sea.addColor(w, 'shallowColor').name('shallow').onChange(ow);
  sea.addColor(w, 'deepColor').name('deep').onChange(ow);
  sea.add(w, 'depthFade', 1, 60, 0.5).name('depth fade').onChange(ow);
  sea.add(w, 'waveHeight', 0, 1.5, 0.02).name('wave height').onChange(ow);
  sea.add(w, 'waveScale', 0.02, 0.5, 0.01).name('wave scale').onChange(ow);
  sea.add(w, 'waveSpeed', 0, 2, 0.05).name('wave speed').onChange(ow);
  sea.add(w, 'reflectivity', 0, 1, 0.02).name('reflectivity').onChange(ow);
  sea.add(w, 'foamWidth', 0, 6, 0.1).name('foam width').onChange(ow);

  const light = gui.addFolder('Sun');
  light.add(options.sun, 'azimuth', 0, 360, 1).name('azimuth°').onChange(options.onSunChange);
  light.add(options.sun, 'elevation', 2, 88, 1).name('elevation°').onChange(options.onSunChange);
  light
    .add(options.shadows, 'level', ['off', 'low', 'medium', 'high'])
    .name('shadows')
    .onChange(options.onShadowChange);

  const display = gui.addFolder('Display');
  display.add(view, 'wireframe').name('wireframe').onChange(onWireframeChange);
  display
    .add(options.collisionEnabled, 'on')
    .name('collision')
    .onChange(options.onCollisionChange);

  detail.close();
  world.close();
  plants.close();
  sea.close();
  light.close();
  display.close();

  return gui;
}
