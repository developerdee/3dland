import * as THREE from 'three';
import { generateHeightmap, type Heightmap, type TerrainParams } from './heightmap';
import { TerrainMaterial, type TerrainShadingParams } from './TerrainMaterial';

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
  private readonly surfaceMaterial: TerrainMaterial;
  private readonly wireframeMaterial: THREE.MeshBasicMaterial;
  private surface: THREE.Mesh | null = null;
  private wireframe: THREE.Mesh | null = null;
  private map: Heightmap | null = null;

  constructor(params: TerrainParams) {
    // Slope- and altitude-driven shading, evaluated per-pixel on the GPU.
    this.surfaceMaterial = new TerrainMaterial();

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

  /**
   * Updates shading parameters. Cheap — these are uniforms, so the change
   * takes effect next frame with no geometry rebuild.
   */
  applyShading(shading: TerrainShadingParams): void {
    this.surfaceMaterial.apply(shading);
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

    // Lighting needs normals, and they are only correct once the vertices have
    // moved — so this must come after displacement, not before. The shader
    // also derives slope from these normals, so shading depends on it too.
    geometry.computeVertexNormals();

    // The shader expresses its bands as 0-1 of the terrain's range, so it
    // needs to know what that range currently is.
    this.surfaceMaterial.setHeightRange(this.map.min, this.map.max);

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
}
