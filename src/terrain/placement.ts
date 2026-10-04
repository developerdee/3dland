import type { Heightmap } from './heightmap';
import { sampleHeight } from './heightmap';
import { hashSeed, mulberry32 } from './random';

/** One placed object. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Uniform scale, varied per instance so a forest is not cloned. */
  scale: number;
  /** Rotation about the vertical axis, in radians. */
  rotation: number;
  /** Which variant of the species to use, for a little visual variety. */
  variant: number;
}

/** Rules for where one kind of object belongs. */
export interface SpeciesRules {
  /** Objects per 10,000 square world units, before rules reject any. */
  density: number;
  /** Altitude band, as fractions (0-1) of the terrain's vertical range. */
  minAltitude: number;
  maxAltitude: number;
  /** Softness of the altitude limits, so bands fade rather than cut. */
  altitudeFade: number;
  /** Maximum slope (0 flat, 1 vertical) this can grow or rest on. */
  maxSlope: number;
  /** Scale range, sampled per instance. */
  minScale: number;
  maxScale: number;
  /** How many mesh variants this species has. */
  variants: number;
  /** Clearance above the waterline, in world units. Negative allows wading. */
  waterClearance: number;
}

export interface ScatterParams {
  /** Multiplies every species' density. The performance dial. */
  densityScale: number;
  trees: SpeciesRules;
  rocks: SpeciesRules;
  shrubs: SpeciesRules;
}

export const defaultScatter: ScatterParams = {
  densityScale: 1,
  trees: {
    // Density is a render budget, not an ecological one: a real square
    // kilometre holds tens of thousands of trees, but ~45 triangles each puts
    // that far past what a phone will draw. These counts aim for a few
    // thousand objects total, which reads as woodland at this scale.
    density: 22,
    // Trees stop below the shoreline and above a treeline, which is the
    // single most recognisable pattern in real landscape.
    minAltitude: 0.46,
    maxAltitude: 0.74,
    altitudeFade: 0.07,
    maxSlope: 0.52,
    minScale: 0.8,
    maxScale: 1.7,
    variants: 3,
    waterClearance: 0.8,
  },
  rocks: {
    density: 11,
    // Rocks sit anywhere, but favour high ground where soil has eroded away.
    minAltitude: 0.3,
    maxAltitude: 1,
    altitudeFade: 0.12,
    maxSlope: 0.78,
    minScale: 0.45,
    maxScale: 2.1,
    variants: 3,
    // Allowed slightly into the water, so boulders break the shoreline.
    waterClearance: -1.2,
  },
  shrubs: {
    density: 30,
    minAltitude: 0.44,
    maxAltitude: 0.68,
    altitudeFade: 0.06,
    maxSlope: 0.6,
    minScale: 0.5,
    maxScale: 1.1,
    variants: 2,
    waterClearance: 0.4,
  },
};

export interface ScatterContext {
  map: Heightmap;
  /** Water surface height in world units, or null when water is off. */
  waterLevel: number | null;
  /** Seed, so a world's vegetation is reproducible with its terrain. */
  seed: string;
}

/**
 * Surface slope at a world position, as 0 (flat) to 1 (vertical).
 *
 * Derived by sampling the heightmap either side — the same numerical gradient
 * the water shader uses for its normals. Done on the CPU here because
 * placement is a one-off cost, not per-frame.
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

/**
 * Chooses positions for one species.
 *
 * Candidates are drawn from a jittered grid rather than pure random points.
 * Uniform random placement clumps — you get bare patches next to thickets,
 * because random points are not evenly spread. Jittering a grid keeps a
 * minimum spacing while staying irregular enough to look unplanned, which is
 * the cheap approximation of Poisson-disc sampling.
 *
 * Rules then reject candidates: too steep, too high, too low, underwater.
 * Rejection rather than adjustment is deliberate — nudging a tree off a cliff
 * to the nearest valid spot produces visible lines of trees along cliff edges.
 */
export function scatterSpecies(
  context: ScatterContext,
  rules: SpeciesRules,
  densityScale: number,
  label: string,
): Placement[] {
  const { map, waterLevel } = context;
  const placements: Placement[] = [];

  const area = map.size * map.size;
  const target = Math.max(0, Math.round((rules.density * densityScale * area) / 10000));
  if (target === 0) return placements;

  // Grid sized so one candidate per cell yields roughly the target count.
  const cells = Math.max(1, Math.ceil(Math.sqrt(target)));
  const cellSize = map.size / cells;
  const half = map.size / 2;

  // Seeded per species, so changing tree density does not reshuffle the rocks.
  const random = mulberry32(hashSeed(`${context.seed}:${label}`));

  const range = map.max - map.min || 1;

  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      // Jitter within the cell. Insetting slightly keeps neighbours from
      // touching, which is what preserves the minimum-spacing property.
      const jx = 0.1 + random() * 0.8;
      const jz = 0.1 + random() * 0.8;
      const x = -half + (gx + jx) * cellSize;
      const z = -half + (gz + jz) * cellSize;

      const height = sampleHeight(map, x, z);

      if (waterLevel !== null && height < waterLevel + rules.waterClearance) continue;

      const slope = slopeAt(map, x, z);
      if (slope > rules.maxSlope) continue;

      const altitude = (height - map.min) / range;

      // Probabilistic edges: inside the band an object almost always appears,
      // and the chance tapers across `altitudeFade`. A hard cut-off draws a
      // visible contour line across the hillside.
      const lowEdge = smoothstep(
        rules.minAltitude - rules.altitudeFade,
        rules.minAltitude + rules.altitudeFade,
        altitude,
      );
      const highEdge =
        1 -
        smoothstep(
          rules.maxAltitude - rules.altitudeFade,
          rules.maxAltitude + rules.altitudeFade,
          altitude,
        );

      // Thin out on steeper ground rather than cutting at the limit exactly.
      const slopeFactor = 1 - smoothstep(rules.maxSlope * 0.55, rules.maxSlope, slope);

      if (random() > lowEdge * highEdge * slopeFactor) continue;

      placements.push({
        x,
        y: height,
        z,
        scale: rules.minScale + random() * (rules.maxScale - rules.minScale),
        rotation: random() * Math.PI * 2,
        variant: Math.min(rules.variants - 1, Math.floor(random() * rules.variants)),
      });
    }
  }

  return placements;
}

export interface ScatterResult {
  trees: Placement[];
  rocks: Placement[];
  shrubs: Placement[];
}

/**
 * Collision volume for one species, in units of its base geometry.
 *
 * Deliberately narrower than the visible mesh: a conifer's canopy is wide but
 * you walk through the branches, not the trunk. Matching the silhouette would
 * make woodland feel like a maze of invisible walls.
 */
export interface SpeciesCollision {
  /** Horizontal radius, multiplied by each instance's scale. */
  radius: number;
  /** Height of the blocking volume, multiplied by instance scale. */
  height: number;
  /** Whether this species blocks movement at all. */
  solid: boolean;
}

export const speciesCollision: Record<'trees' | 'rocks' | 'shrubs', SpeciesCollision> = {
  // Trunk-width, not canopy-width.
  trees: { radius: 0.34, height: 4.2, solid: true },
  // Boulders are close to their visible size.
  rocks: { radius: 0.46, height: 0.72, solid: true },
  // Shrubs are brushed through, not blocked by — stopping dead at knee-high
  // scrub feels broken rather than realistic.
  shrubs: { radius: 0.3, height: 0.4, solid: false },
};

export function scatterAll(context: ScatterContext, params: ScatterParams): ScatterResult {
  return {
    trees: scatterSpecies(context, params.trees, params.densityScale, 'trees'),
    rocks: scatterSpecies(context, params.rocks, params.densityScale, 'rocks'),
    shrubs: scatterSpecies(context, params.shrubs, params.densityScale, 'shrubs'),
  };
}

/** Matches GLSL's smoothstep, for consistency with the shaders' band edges. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0 || 1e-6), 0), 1);
  return t * t * (3 - 2 * t);
}
