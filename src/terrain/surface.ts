import type { Heightmap } from './heightmap';
import { sampleHeight } from './heightmap';

/**
 * Surface slope at a world position, as 0 (flat) to 1 (vertical).
 *
 * Derived by sampling the heightmap either side — the same numerical gradient
 * the water shader uses for its normals. Done on the CPU because placement is
 * a one-off cost, not per-frame.
 *
 * Lives in its own module because both `placement` and `forests` need it, and
 * importing it from either would make them circular.
 */
export function slopeAt(map: Heightmap, x: number, z: number): number {
  const step = map.size / (map.resolution - 1);
  const hL = sampleHeight(map, x - step, z);
  const hR = sampleHeight(map, x + step, z);
  const hD = sampleHeight(map, x, z - step);
  const hU = sampleHeight(map, x, z + step);

  // Gradient magnitude, converted to a 0-1 measure via the surface normal's
  // vertical component — matching how the terrain shader defines slope.
  const dx = (hR - hL) / (2 * step);
  const dz = (hU - hD) / (2 * step);
  const normalY = 1 / Math.sqrt(dx * dx + dz * dz + 1);
  return 1 - normalY;
}
