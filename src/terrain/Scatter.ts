import * as THREE from 'three';
import { buildProps, disposeProps, type PropSet } from './props';
import {
  scatterAll,
  speciesCollision,
  type Placement,
  type ScatterContext,
  type ScatterParams,
} from './placement';
import type { Obstacle } from '../engine/Collision';

/**
 * Renders scattered props as instanced meshes.
 *
 * `InstancedMesh` draws many copies of one geometry in a single draw call,
 * with a per-instance transform matrix. Thousands of trees therefore cost
 * roughly what one tree costs in CPU overhead — without it, 5,000 separate
 * meshes would be 5,000 draw calls and the frame rate would collapse long
 * before the GPU was troubled by the triangles.
 *
 * One mesh per variant, so a dozen draw calls cover the whole landscape.
 */
export class Scatter {
  readonly group = new THREE.Group();

  private readonly props: PropSet;
  private readonly material: THREE.MeshLambertMaterial;
  private meshes: THREE.InstancedMesh[] = [];
  private count = 0;
  private obstacles: Obstacle[] = [];

  constructor() {
    this.props = buildProps();

    // Lambert rather than Standard: props have no roughness or metalness worth
    // simulating, and the cheaper shading model matters when it covers a large
    // part of the screen. Vertex colours carry the per-part tinting baked in
    // by props.ts.
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
  }

  /** Total instances currently placed, for the HUD. */
  get instanceCount(): number {
    return this.count;
  }

  /** Collision volumes for the solid props, for the physics to index. */
  get collisionVolumes(): Obstacle[] {
    return this.obstacles;
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Regenerates placement and rebuilds the instanced meshes. */
  rebuild(context: ScatterContext, params: ScatterParams): void {
    this.clear();

    const result = scatterAll(context, params);
    this.count = result.trees.length + result.rocks.length + result.shrubs.length;

    this.addSpecies(result.trees, this.props.trees);
    this.addSpecies(result.rocks, this.props.rocks);
    this.addSpecies(result.shrubs, this.props.shrubs);

    // Build collision volumes from the same placements that were drawn, so
    // what blocks you is always what you can see.
    this.obstacles = [
      ...toObstacles(result.trees, speciesCollision.trees),
      ...toObstacles(result.rocks, speciesCollision.rocks),
      ...toObstacles(result.shrubs, speciesCollision.shrubs),
    ];
  }

  dispose(): void {
    this.clear();
    disposeProps(this.props);
    this.material.dispose();
  }

  /**
   * Builds one InstancedMesh per variant and writes a transform per instance.
   */
  private addSpecies(placements: Placement[], variants: THREE.BufferGeometry[]): void {
    if (placements.length === 0 || variants.length === 0) return;

    // Bucket by variant, since each needs its own mesh.
    const buckets: Placement[][] = variants.map(() => []);
    for (const placement of placements) {
      const index = Math.min(placement.variant, variants.length - 1);
      buckets[index]!.push(placement);
    }

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    buckets.forEach((bucket, variantIndex) => {
      if (bucket.length === 0) return;

      const geometry = variants[variantIndex]!;
      const mesh = new THREE.InstancedMesh(geometry, this.material, bucket.length);

      bucket.forEach((placement, i) => {
        position.set(placement.x, placement.y, placement.z);
        quaternion.setFromAxisAngle(up, placement.rotation);
        scale.setScalar(placement.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
      });

      // Static for the lifetime of the mesh, so tell Three not to re-upload
      // the matrix buffer each frame.
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      // Frustum culling on the whole mesh would hide every instance as soon as
      // the group's bounds left the view; the instances span the world, so the
      // bounding sphere is effectively the whole terrain and culling it is
      // both wrong and pointless.
      mesh.frustumCulled = false;

      this.meshes.push(mesh);
      this.group.add(mesh);
    });
  }

  private clear(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      // The geometry and material are shared and reused, so only the
      // per-instance buffers belong to this mesh.
      mesh.dispose();
    }
    this.meshes = [];
    this.count = 0;
    this.obstacles = [];
  }
}

/** Converts placements into collision cylinders, skipping non-solid species. */
function toObstacles(
  placements: Placement[],
  rules: { radius: number; height: number; solid: boolean },
): Obstacle[] {
  if (!rules.solid) return [];
  return placements.map((p) => ({
    x: p.x,
    z: p.z,
    radius: rules.radius * p.scale,
    bottom: p.y,
    top: p.y + rules.height * p.scale,
  }));
}
