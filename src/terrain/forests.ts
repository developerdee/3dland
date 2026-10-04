import { createNoise2D } from 'simplex-noise';
import type { Heightmap } from './heightmap';
import { sampleHeight } from './heightmap';
import { hashSeed, mulberry32 } from './random';
import { slopeAt } from './surface';

/**
 * Minimum centre-to-centre distance between trees inside a forest.
 *
 * The player is 0.42 units in radius and the widest trunk is 0.58, so two
 * trees 2.0 units apart leave exactly no room to pass between them. 3.0 keeps
 * a comfortable 1.8-unit gap against a 0.84-unit body, so a forest is always
 * navigable however dense the slider is set. This is a hard floor, not a
 * tunable: an impassable forest is a bug, not a style.
 */
export const MIN_TREE_GAP = 3.0;

export interface ForestParams {
  /** How many forests to place. Few and large reads better than many small. */
  count: number;
  /** Mean radius in world units. Individual forests vary around this. */
  radius: number;
  /** Variation in radius, as a fraction: 0.4 means 60%-140% of `radius`. */
  radiusVariation: number;
  /**
   * Tree spacing at the forest core, in world units. Clamped to MIN_TREE_GAP,
   * so the densest setting is still walkable.
   */
  spacing: number;
  /** How irregular the boundary is. 0 is a circle, 1 is deeply lobed. */
  edgeRoughness: number;
  /** Fraction of the radius over which density fades to nothing. */
  edgeSoftness: number;
}

export const defaultForests: ForestParams = {
  count: 6,
  radius: 90,
  radiusVariation: 0.45,
  // Wide enough that a full world stays within budget, narrow enough to read
  // as a wood rather than an orchard. The walkability floor is 3.0.
  spacing: 5.0,
  edgeRoughness: 0.55,
  edgeSoftness: 0.35,
};

/** Terrain conditions a forest will take root in. */
const SITING = {
  /** Forests avoid steep ground: soil and seedlings do not hold on cliffs. */
  maxSlope: 0.38,
  /** Gentle to moderate ground is preferred outright. */
  idealSlope: 0.16,
  /** Clearance above the waterline for the forest centre, in world units. */
  waterClearance: 2.5,
  /** Altitude band as fractions of the terrain range: lowlands to treeline. */
  minAltitude: 0.45,
  maxAltitude: 0.72,
  /**
   * Weight given to sitting in a hollow rather than on a rise. Forests
   * gather in valleys and basins where water and soil collect, so candidates
   * lower than their surroundings score better.
   */
  basinWeight: 0.55,
};

export interface Forest {
  x: number;
  z: number;
  radius: number;
  /** Per-forest seed offset, so each has its own boundary shape. */
  shapeSeed: number;
}

/**
 * Chooses forest locations.
 *
 * Candidates are scored rather than merely accepted or rejected: many random
 * points are sampled, each scored on slope, altitude and how much of a hollow
 * it sits in, and the best are kept. Taking the best of many candidates is
 * what makes forests appear in valleys and on rolling ground rather than
 * wherever the first valid sample happened to land.
 */
export function placeForests(
  map: Heightmap,
  waterLevel: number | null,
  seed: string,
  params: ForestParams,
): Forest[] {
  if (params.count <= 0) return [];

  const random = mulberry32(hashSeed(`${seed}:forests`));
  // Measured from the lowest land, so the island's sea floor does not skew
  // the altitude band forests are allowed to sit in.
  const range = map.max - map.landMin || 1;
  const half = map.size / 2;

  interface Candidate {
    x: number;
    z: number;
    score: number;
  }

  const candidates: Candidate[] = [];
  // Sample generously: the scoring only has value if it has a field to choose
  // from, and this runs once per world rather than per frame.
  const samples = Math.max(220, params.count * 45);

  for (let i = 0; i < samples; i++) {
    // Inset so a forest's bulk stays inside the world.
    const margin = half - params.radius * 0.6;
    const x = (random() * 2 - 1) * margin;
    const z = (random() * 2 - 1) * margin;

    const height = sampleHeight(map, x, z);

    if (waterLevel !== null && height < waterLevel + SITING.waterClearance) continue;

    const altitude = (height - map.landMin) / range;
    if (altitude < SITING.minAltitude || altitude > SITING.maxAltitude) continue;

    const slope = slopeAt(map, x, z);
    if (slope > SITING.maxSlope) continue;

    // Prefer gentle ground, tapering to zero at the slope limit.
    const slopeScore = 1 - Math.min(slope / SITING.maxSlope, 1);
    // Reward being near the ideal rather than merely flat: dead-flat plains
    // and gentle rolling ground both qualify, but rolling scores higher.
    const gentleScore = 1 - Math.abs(slope - SITING.idealSlope) / SITING.maxSlope;

    // Basins: compare this point against a ring around it. Lower than its
    // surroundings means a valley or hollow, where soil and water gather.
    const probe = Math.max(12, map.size * 0.02);
    let surrounding = 0;
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * Math.PI * 2;
      surrounding += sampleHeight(map, x + Math.cos(angle) * probe, z + Math.sin(angle) * probe);
    }
    surrounding /= 6;
    // Normalised by relief so the measure is scale-independent.
    const basinScore = Math.min(Math.max((surrounding - height) / (range * 0.06), -1), 1);

    const score =
      slopeScore * 0.9 +
      Math.max(gentleScore, 0) * 0.5 +
      basinScore * SITING.basinWeight +
      // A little noise, so repeated worlds with similar terrain do not all
      // put their forests in identical places.
      random() * 0.25;

    candidates.push({ x, z, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const forests: Forest[] = [];

  for (const candidate of candidates) {
    if (forests.length >= params.count) break;

    const radius =
      params.radius * (1 - params.radiusVariation + random() * params.radiusVariation * 2);

    // Keep forests apart, so they read as distinct woods rather than one
    // sprawl. Allowing a little overlap keeps the result organic.
    const tooClose = forests.some((existing) => {
      const distance = Math.hypot(existing.x - candidate.x, existing.z - candidate.z);
      return distance < (existing.radius + radius) * 0.62;
    });
    if (tooClose) continue;

    forests.push({
      x: candidate.x,
      z: candidate.z,
      radius,
      shapeSeed: Math.floor(random() * 65536),
    });
  }

  return forests;
}

/**
 * Tests how strongly a point belongs to a forest, from 0 (outside) to 1
 * (core).
 *
 * The boundary is a circle perturbed by noise sampled around its perimeter,
 * which gives the lobes and inlets real woodland has. A plain circle is
 * obvious from above, and this costs almost nothing to avoid.
 */
export function forestDensityAt(
  forests: Forest[],
  noise: (x: number, y: number) => number,
  x: number,
  z: number,
  params: ForestParams,
): number {
  let strongest = 0;

  for (const forest of forests) {
    const dx = x - forest.x;
    const dz = z - forest.z;
    const distance = Math.hypot(dx, dz);

    // Cheap reject before any noise sampling: nothing beyond the roughest
    // possible boundary can belong.
    if (distance > forest.radius * (1 + params.edgeRoughness)) continue;

    // Perturb the radius by noise in the direction of this point, so the
    // boundary wanders in and out as you travel around the forest.
    const angle = Math.atan2(dz, dx);
    const wobble =
      noise(
        Math.cos(angle) * 1.7 + forest.shapeSeed * 0.013,
        Math.sin(angle) * 1.7 + forest.shapeSeed * 0.017,
      ) *
        0.62 +
      noise(
        Math.cos(angle) * 4.1 + forest.shapeSeed * 0.031,
        Math.sin(angle) * 4.1 + forest.shapeSeed * 0.037,
      ) *
        0.38;

    const effectiveRadius = forest.radius * (1 + wobble * params.edgeRoughness);
    if (distance > effectiveRadius) continue;

    // Fade from full density at the core to nothing at the boundary, so a
    // forest thins into scattered trees rather than ending at a wall.
    const softness = Math.max(params.edgeSoftness, 0.02);
    const edgeStart = effectiveRadius * (1 - softness);
    const density =
      distance <= edgeStart
        ? 1
        : 1 - (distance - edgeStart) / (effectiveRadius - edgeStart || 1);

    if (density > strongest) strongest = density;
  }

  return strongest;
}

/** Builds the boundary noise function for a world. */
export function createForestNoise(seed: string): (x: number, y: number) => number {
  return createNoise2D(mulberry32(hashSeed(`${seed}:forest-shape`)));
}
