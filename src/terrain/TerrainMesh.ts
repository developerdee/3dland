import * as THREE from 'three';
import { generateHeightmap, type Heightmap, type TerrainParams } from './heightmap';

/**
 * The terrain as a renderable object: a plane whose vertices are displaced by
 * a generated heightmap.
 *
 * Owns its geometry and materials, and rebuilds them on demand when the GUI
 * changes a parameter. Because every rebuild allocates new GPU buffers, the
 * old ones are explicitly disposed — WebGL resources are not garbage
 * collected, so skipping that leaks memory until the context dies.
 */
export class TerrainMesh {
  readonly group = new THREE.Group();

  private geometry: THREE.PlaneGeometry | null = null;
  private readonly surfaceMaterial: THREE.MeshStandardMaterial;
  private readonly wireframeMaterial: THREE.MeshBasicMaterial;
  private surface: THREE.Mesh | null = null;
  private wireframe: THREE.Mesh | null = null;
  private map: Heightmap | null = null;

  constructor(params: TerrainParams) {
    // Placeholder vertex colours until stage 4 does slope/altitude shading
    // properly; a flat colour makes the relief very hard to read.
    this.surfaceMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
    });

    this.wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x8fb4ff,
      wireframe: true,
      transparent: true,
      opacity: 0.22,
      visible: false,
    });

    this.rebuild(params);
  }

  /** The heightmap currently displayed. */
  get heightmap(): Heightmap {
    if (!this.map) throw new Error('TerrainMesh has no heightmap yet');
    return this.map;
  }

  get triangleCount(): number {
    const res = this.map?.resolution ?? 0;
    return res > 1 ? 2 * (res - 1) * (res - 1) : 0;
  }

  set wireframeVisible(visible: boolean) {
    this.wireframeMaterial.visible = visible;
  }

  /** Regenerates heights and geometry from scratch. */
  rebuild(params: TerrainParams): void {
    this.map = generateHeightmap(params);
    this.disposeGeometry();

    const { resolution, size } = this.map;

    // PlaneGeometry is built in the XY plane, so rotate it flat. Doing this on
    // the geometry rather than the mesh means vertex positions are already in
    // world orientation, which keeps the height lookups in stage 6 simple.
    const geometry = new THREE.PlaneGeometry(size, size, resolution - 1, resolution - 1);
    geometry.rotateX(-Math.PI / 2);

    this.displaceVertices(geometry, this.map);
    this.applyVertexColors(geometry, this.map);

    // Lighting needs normals, and they are only correct once the vertices have
    // moved — so this must come after displacement, not before.
    geometry.computeVertexNormals();

    this.geometry = geometry;
    this.surface = new THREE.Mesh(geometry, this.surfaceMaterial);
    this.wireframe = new THREE.Mesh(geometry, this.wireframeMaterial);

    this.group.add(this.surface, this.wireframe);
  }

  /** Frees GPU resources. Call when discarding the terrain for good. */
  dispose(): void {
    this.disposeGeometry();
    this.surfaceMaterial.dispose();
    this.wireframeMaterial.dispose();
  }

  private disposeGeometry(): void {
    if (this.surface) this.group.remove(this.surface);
    if (this.wireframe) this.group.remove(this.wireframe);
    this.geometry?.dispose();
    this.geometry = null;
    this.surface = null;
    this.wireframe = null;
  }

  /**
   * Writes heightmap values into the geometry's y coordinates.
   *
   * PlaneGeometry's vertex order matches our row-major heightmap exactly —
   * both iterate x fastest — so index i of one corresponds to index i of the
   * other, and no coordinate mapping is needed.
   */
  private displaceVertices(geometry: THREE.PlaneGeometry, map: Heightmap): void {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const count = position.count;

    for (let i = 0; i < count; i++) {
      position.setY(i, map.heights[i]!);
    }

    position.needsUpdate = true;
  }

  /**
   * Colours vertices by altitude, so relief is legible before real shading
   * arrives in stage 4. Interpolating through a few bands gives sand, grass,
   * rock and snow without any texture loading.
   */
  private applyVertexColors(geometry: THREE.PlaneGeometry, map: Heightmap): void {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const count = position.count;
    const colors = new Float32Array(count * 3);

    const range = map.max - map.min || 1;
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const t = (position.getY(i) - map.min) / range; // 0 at lowest, 1 at peak
      bandColor(t, color);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
}

/** Altitude bands, low to high, as [threshold, color]. */
const BANDS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x3f6d4e], // deep valley green
  [0.28, 0x5f8a4a], // grassland
  [0.48, 0x7a7355], // scrub / dry earth
  [0.66, 0x6e6a67], // exposed rock
  [0.84, 0x9a9792], // high scree
  [1.0, 0xf2f4f7], // snow
];

/** Picks a colour for normalised altitude `t`, blending between bands. */
function bandColor(t: number, out: THREE.Color): void {
  const clamped = Math.min(Math.max(t, 0), 1);

  for (let i = 1; i < BANDS.length; i++) {
    const [upperStop, upperColor] = BANDS[i]!;
    if (clamped > upperStop) continue;

    const [lowerStop, lowerColor] = BANDS[i - 1]!;
    const span = upperStop - lowerStop || 1;
    const local = (clamped - lowerStop) / span;

    out.set(lowerColor).lerp(new THREE.Color(upperColor), local);
    return;
  }

  out.set(BANDS[BANDS.length - 1]![1]);
}
