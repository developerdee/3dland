import type { Heightmap } from '../terrain/heightmap';
import { sampleHeight } from '../terrain/heightmap';

/** A prop's collision volume: an upright cylinder. */
export interface Obstacle {
  x: number;
  z: number;
  radius: number;
  /** Top of the volume, in world units. Below this, the obstacle blocks. */
  top: number;
  /** Base, so you can fly over a boulder but not through it. */
  bottom: number;
}

/**
 * Collision against the terrain, the world edge, and scattered props.
 *
 * Props are indexed into a uniform grid rather than tested exhaustively: with
 * several thousand obstacles, checking every one per frame would cost more
 * than rendering them. A grid lookup touches only the handful in neighbouring
 * cells.
 *
 * Volumes are cylinders, not meshes. A tree trunk is round, a boulder is
 * roughly round, and the player is a vertical capsule — so cylinder tests are
 * both cheap and close enough that the difference is not felt. Per-triangle
 * collision against 5,000 props would be a different project.
 */
export class Collision {
  /** Half-extent of the traversable world. */
  private bounds = Infinity;
  private map: Heightmap | null = null;

  /** Uniform grid of obstacle indices, for broad-phase lookup. */
  private cells = new Map<number, number[]>();
  private obstacles: Obstacle[] = [];
  private cellSize = 8;
  private enabled = true;

  /** Highest obstacle top, so vertical tests can exit early. */
  private maxTop = -Infinity;

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  setTerrain(map: Heightmap): void {
    this.map = map;
    // Keep the camera a little inside the mesh edge: exactly at the boundary,
    // the terrain's final triangle is half outside the sampled region.
    this.bounds = map.size / 2 - 1.5;
  }

  /**
   * Replaces the obstacle set and rebuilds the spatial index.
   *
   * Cell size is derived from the obstacles themselves: cells much smaller
   * than the largest radius would mean an obstacle spanning many cells, and
   * cells much larger would defeat the point of the index.
   */
  setObstacles(obstacles: Obstacle[]): void {
    this.obstacles = obstacles;
    this.cells.clear();
    this.maxTop = -Infinity;

    if (obstacles.length === 0) return;

    let largestRadius = 0;
    for (const obstacle of obstacles) {
      if (obstacle.radius > largestRadius) largestRadius = obstacle.radius;
      if (obstacle.top > this.maxTop) this.maxTop = obstacle.top;
    }
    this.cellSize = Math.max(4, largestRadius * 3);

    obstacles.forEach((obstacle, index) => {
      // Register in every cell the obstacle's footprint touches, so a lookup
      // of one cell cannot miss an obstacle overlapping from a neighbour.
      const minX = Math.floor((obstacle.x - obstacle.radius) / this.cellSize);
      const maxX = Math.floor((obstacle.x + obstacle.radius) / this.cellSize);
      const minZ = Math.floor((obstacle.z - obstacle.radius) / this.cellSize);
      const maxZ = Math.floor((obstacle.z + obstacle.radius) / this.cellSize);

      for (let cz = minZ; cz <= maxZ; cz++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const key = this.key(cx, cz);
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(index);
          else this.cells.set(key, [index]);
        }
      }
    });
  }

  get obstacleCount(): number {
    return this.obstacles.length;
  }

  /** Terrain height at a position, clamped to the world. */
  groundAt(x: number, z: number): number {
    if (!this.map) return 0;
    return sampleHeight(this.map, x, z);
  }

  /**
   * Resolves a desired move into a legal one.
   *
   * Takes the current position and where the mover wants to be, and returns a
   * position that respects the ground, the world edge and any props. Writes
   * into `out` to avoid allocating in the render loop.
   *
   * `fromX`/`fromZ` are only needed to recover a push direction when the
   * mover ends up exactly at an obstacle's centre, where there is no radial
   * direction to push along.
   *
   * `radius` is the mover's horizontal size, `height` how far above its feet
   * the position sits (eye height when walking), and `minGroundGap` how far
   * above the terrain the point must stay.
   */
  resolve(
    fromX: number,
    fromZ: number,
    toX: number,
    toY: number,
    toZ: number,
    radius: number,
    height: number,
    minGroundGap: number,
    out: { x: number; y: number; z: number; hit: boolean },
  ): void {
    out.x = toX;
    out.y = toY;
    out.z = toZ;
    out.hit = false;

    if (!this.enabled) return;

    // --- World edge ---
    const limit = this.bounds - radius;
    if (out.x < -limit) {
      out.x = -limit;
      out.hit = true;
    } else if (out.x > limit) {
      out.x = limit;
      out.hit = true;
    }
    if (out.z < -limit) {
      out.z = -limit;
      out.hit = true;
    } else if (out.z > limit) {
      out.z = limit;
      out.hit = true;
    }

    // --- Props ---
    // Resolved before the ground, because pushing out of an obstacle changes
    // the horizontal position and therefore which ground height applies.
    if (this.obstacles.length > 0 && toY - height <= this.maxTop) {
      this.resolveObstacles(fromX, fromZ, out, radius, height);
    }

    // --- Ground ---
    // The ground is a hard floor: the feet may never be below the surface.
    const ground = this.groundAt(out.x, out.z);
    const floor = ground + minGroundGap + height;
    if (out.y < floor) {
      out.y = floor;
      out.hit = true;
    }
  }

  /**
   * Pushes the mover out of any overlapping obstacle.
   *
   * Resolution is horizontal only: being lifted onto a tree by walking into it
   * would be worse than being stopped by it. Several passes, because pushing
   * clear of one obstacle can push into another in dense woodland.
   */
  private resolveObstacles(
    fromX: number,
    fromZ: number,
    out: { x: number; y: number; z: number; hit: boolean },
    radius: number,
    height: number,
  ): void {
    const feet = out.y - height;

    for (let pass = 0; pass < 3; pass++) {
      let moved = false;

      for (const index of this.candidatesAt(out.x, out.z, radius)) {
        const obstacle = this.obstacles[index]!;

        // Vertical overlap first: it rejects most candidates cheaply, and
        // lets you stand on top of a boulder or fly above a canopy.
        if (feet >= obstacle.top || out.y <= obstacle.bottom) continue;

        const dx = out.x - obstacle.x;
        const dz = out.z - obstacle.z;
        const combined = obstacle.radius + radius;
        const distanceSq = dx * dx + dz * dz;

        if (distanceSq >= combined * combined) continue;

        const distance = Math.sqrt(distanceSq);

        if (distance < 1e-5) {
          // Dead centre: no direction to push, so retreat along the approach
          // vector instead. Without this the mover would be stuck inside.
          const bx = out.x - fromX;
          const bz = out.z - fromZ;
          const backLength = Math.hypot(bx, bz);
          if (backLength > 1e-5) {
            out.x -= (bx / backLength) * combined;
            out.z -= (bz / backLength) * combined;
          } else {
            out.x += combined;
          }
        } else {
          // Push radially out to the surface of the cylinder.
          const push = (combined - distance) / distance;
          out.x += dx * push;
          out.z += dz * push;
        }

        out.hit = true;
        moved = true;
      }

      if (!moved) break;
    }
  }

  /** Obstacle indices in the cells a circle at (x, z) touches. */
  private candidatesAt(x: number, z: number, radius: number): number[] {
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize);
    const maxZ = Math.floor((z + radius) / this.cellSize);

    // Single cell is the common case; return its bucket directly rather than
    // building a new array every frame.
    if (minX === maxX && minZ === maxZ) {
      return this.cells.get(this.key(minX, minZ)) ?? EMPTY;
    }

    const found: number[] = [];
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.cells.get(this.key(cx, cz));
        if (!bucket) continue;
        for (const index of bucket) {
          // Spanning cells can list the same obstacle twice; a duplicate push
          // would double the correction.
          if (!found.includes(index)) found.push(index);
        }
      }
    }
    return found;
  }

  /** Hashes a cell coordinate pair into a single map key. */
  private key(cx: number, cz: number): number {
    // Interleaving via a large prime stride avoids collisions for any
    // plausible world size while staying a single integer.
    return cx * 73856093 + cz * 19349663;
  }
}

const EMPTY: number[] = [];
