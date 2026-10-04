import { createNoise2D } from 'simplex-noise';
import { hashSeed, mulberry32 } from './random';

/** Tunable shape of the landscape. Every field is live-editable from the GUI. */
export interface TerrainParams {
  /** Any string; the same seed always rebuilds the same world. */
  seed: string;
  /** World-space width and depth of the terrain, in units. */
  size: number;
  /** Vertices per side. Triangle count is roughly 2 * (resolution - 1)^2. */
  resolution: number;
  /** Peak-to-trough height, in world units, before `ridged` is applied. */
  amplitude: number;
  /** Size of the largest features: lower is broader. Try 0.5 - 3. */
  frequency: number;
  /** How many noise layers to sum. Each adds finer detail and costs time. */
  octaves: number;
  /** Amplitude multiplier per octave. Below 0.5 is smooth, above is rough. */
  persistence: number;
  /** Frequency multiplier per octave. ~2 is conventional. */
  lacunarity: number;
  /** Shapes the summed noise: 1 is linear, higher carves valleys flatter. */
  exponent: number;
  /** Fold troughs upward into sharp ridges, for mountainous terrain. */
  ridged: boolean;
  /**
   * Rescale the result so it spans exactly `amplitude`. Summed octaves rarely
   * peak together, so raw fBm reaches only ~60-70% of the nominal amplitude;
   * normalising makes the slider mean what it says, at the cost of coupling
   * the output range to whatever extremes this particular seed happens to hit.
   */
  normalizeRange: boolean;
  /**
   * Pull the terrain down toward the edges, so the land is an island in open
   * ocean rather than a square slab that stops abruptly.
   */
  island: boolean;
  /**
   * Fraction of the half-width over which the falloff acts. 0.35 leaves the
   * middle 65% unaffected and shapes a coast in the outer third.
   */
  islandFalloff: number;
  /**
   * How far below the lowest land the sea floor drops at the very edge, as a
   * fraction of amplitude. Deep enough that the shore reads as a coast rather
   * than a puddle rim.
   */
  islandDepth: number;
}

export const defaultParams: TerrainParams = {
  seed: 'landfall',
  size: 1000,
  resolution: 256,
  // Tuned together against a 1000-unit world: 90 units of relief reads as
  // dramatic, while keeping under 3% of the surface steeper than 45 degrees
  // so walk mode is usable nearly everywhere. Raising amplitude or frequency
  // much past this makes the terrain alpine and unpleasant on foot.
  amplitude: 90,
  frequency: 1.1,
  octaves: 6,
  persistence: 0.5,
  lacunarity: 2.0,
  exponent: 1.9,
  ridged: false,
  normalizeRange: true,
  island: true,
  islandFalloff: 0.38,
  islandDepth: 0.55,
};

/**
 * Mesh density presets. The world is the same size in every case — only the
 * vertex count changes, so quality trades detail against frame rate without
 * altering the terrain's shape.
 *
 * Triangle counts: low 32k, medium 130k, high 523k.
 */
export const QUALITY = {
  low: 128,
  medium: 256,
  high: 512,
} as const;

export type QualityLevel = keyof typeof QUALITY;

/** Generates a short random seed, for a fresh world each load. */
export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Noise units traversed at frequency 1. Simplex features are roughly one unit
 * across, so a span of ~4 shows a handful of large landforms while still
 * covering enough of the field to reach its full range.
 */
const FIELD_SPAN = 4;

/** A square grid of heights, plus the range actually produced. */
export interface Heightmap {
  /** Row-major, `resolution * resolution` entries. Index as `z * res + x`. */
  readonly heights: Float32Array;
  readonly resolution: number;
  readonly size: number;
  readonly min: number;
  readonly max: number;
  /**
   * Lowest height excluding the island falloff — the floor of the terrain the
   * noise actually generated.
   *
   * Sea level is expressed as a fraction of the *land's* range, not the full
   * range: the island's sea floor can sit far below everything else, and
   * anchoring to that would drag the shoreline down with it, flooding the
   * island whenever the falloff depth changed.
   */
  readonly landMin: number;
  /**
   * Median height of the island's interior, excluding the falloff skirt.
   *
   * Sea level anchors to this rather than to a fraction of the range, because
   * the range's endpoints move with every seed: a fixed fraction flooded some
   * islands to 77% and others to 26%. The median is stable, so the same
   * setting yields a comparable coastline on every world.
   */
  readonly landMedian: number;
}

/**
 * Builds a heightmap by summing octaves of simplex noise — "fractal Brownian
 * motion". One octave of noise is too smooth to read as landscape; summing
 * several, each at double the frequency and half the amplitude, produces the
 * self-similar detail real terrain has:
 *
 *   octave 1 (broad, tall)    continental shapes
 *   octave 2 (2x finer, half) hills
 *   octave 3 (4x finer, 1/4)  rocks and texture
 *   ...                       summed, a convincing landscape
 */
export function generateHeightmap(params: TerrainParams): Heightmap {
  const { resolution, size, octaves, persistence, lacunarity } = params;

  const noise2D = createNoise2D(mulberry32(hashSeed(params.seed)));
  const heights = new Float32Array(resolution * resolution);

  // Simplex noise returns exactly 0 at lattice origins, so sampling a window
  // centred on (0, 0) would pin the middle of every map to zero height and,
  // because each octave shares that origin, bias the whole result. Offsetting
  // each octave by a seeded amount decorrelates them and moves the terrain off
  // that degenerate point.
  const rand = mulberry32(hashSeed(params.seed + ':offset'));
  const offsets: Array<[number, number]> = [];
  for (let o = 0; o < octaves; o++) {
    offsets.push([rand() * 256 - 128, rand() * 256 - 128]);
  }

  // Normalise by the total amplitude so the summed result stays within
  // [-1, 1] regardless of octave count — otherwise adding an octave would
  // also change the overall height, making the sliders interact confusingly.
  let totalAmplitude = 0;
  for (let o = 0; o < octaves; o++) {
    totalAmplitude += Math.pow(persistence, o);
  }

  let min = Infinity;
  let max = -Infinity;
  // Defaults to `min`; the island pass overrides it with the pre-falloff
  // value before lowering `min` to the sea floor.
  let landMin = 0;

  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      // Map the grid to a window of noise space. FIELD_SPAN sets how many
      // noise units a frequency of 1 traverses: too narrow and we only ever
      // see a fraction of the field's range, giving flat, lopsided terrain.
      const nx = (x / (resolution - 1) - 0.5) * params.frequency * FIELD_SPAN;
      const nz = (z / (resolution - 1) - 0.5) * params.frequency * FIELD_SPAN;

      let sum = 0;
      let amplitude = 1;
      let freq = 1;

      for (let o = 0; o < octaves; o++) {
        const [ox, oz] = offsets[o]!;
        let n = noise2D(nx * freq + ox, nz * freq + oz); // in [-1, 1]

        if (params.ridged) {
          // Fold the trough upward and invert: valleys become sharp crests.
          n = 1 - Math.abs(n);
          n = n * 2 - 1; // back to [-1, 1] so the two modes share a scale
        }

        sum += n * amplitude;
        amplitude *= persistence;
        freq *= lacunarity;
      }

      let normalized = sum / totalAmplitude; // [-1, 1]

      if (params.exponent !== 1) {
        // Raise to a power while preserving sign, so peaks stay sharp and
        // low ground flattens out — rather than everything curving uniformly.
        const sign = Math.sign(normalized);
        normalized = sign * Math.pow(Math.abs(normalized), params.exponent);
      }

      const height = normalized * params.amplitude;
      heights[z * resolution + x] = height;

      if (height < min) min = height;
      if (height > max) max = height;
    }
  }

  if (params.normalizeRange && max > min) {
    // Stretch the observed range to fill [-amplitude/2, +amplitude/2].
    const scale = params.amplitude / (max - min);
    const mid = (max + min) / 2;
    for (let i = 0; i < heights.length; i++) {
      heights[i] = (heights[i]! - mid) * scale;
    }
    min = -params.amplitude / 2;
    max = params.amplitude / 2;
  }

  if (params.island) {
    // Applied after normalisation, not before: normalising would stretch the
    // range back out and undo the falloff entirely.
    //
    // The mask uses the larger of the two axis distances rather than radial
    // distance, so the drop-off follows the square edge of the mesh. A radial
    // mask would leave the four corners above water.
    const floor = min - params.amplitude * params.islandDepth;
    const falloff = Math.max(params.islandFalloff, 0.01);

    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        // 0 at the centre, 1 at the edge.
        const u = Math.abs((x / (resolution - 1)) * 2 - 1);
        const v = Math.abs((z / (resolution - 1)) * 2 - 1);
        const edge = Math.max(u, v);

        // Nothing happens until the falloff zone begins.
        const t = Math.max(0, (edge - (1 - falloff)) / falloff);
        if (t <= 0) continue;

        // Cubic easing: a gentle shelving beach near the land, steepening into
        // deeper water. Linear reads as a cone, which looks artificial.
        const blend = t * t * (3 - 2 * t);

        const i = z * resolution + x;
        heights[i] = heights[i]! * (1 - blend) + floor * blend;
      }
    }

    // The falloff only ever lowers terrain, so max is unchanged and min
    // becomes the sea floor at the edge. landMin keeps the pre-falloff floor,
    // which is what sea level is measured against.
    landMin = min;
    min = floor;
  }

  // Median of the interior, for a sea level that behaves consistently across
  // seeds. Sampled on a stride rather than sorting every height: a 512-grid
  // holds 262,144 values and the median does not need that precision.
  const interior: number[] = [];
  const skirt = params.island ? params.islandFalloff : 0;
  const stride = Math.max(1, Math.floor(resolution / 96));
  for (let z = 0; z < resolution; z += stride) {
    for (let x = 0; x < resolution; x += stride) {
      const u = Math.abs((x / (resolution - 1)) * 2 - 1);
      const v = Math.abs((z / (resolution - 1)) * 2 - 1);
      if (Math.max(u, v) > 1 - skirt) continue;
      interior.push(heights[z * resolution + x]!);
    }
  }
  interior.sort((a, b) => a - b);
  const landMedian = interior.length > 0 ? interior[Math.floor(interior.length / 2)]! : 0;

  return {
    heights,
    resolution,
    size,
    min,
    max,
    landMin: params.island ? landMin : min,
    landMedian,
  };
}

/**
 * Height at a world-space (x, z), by bilinear interpolation between the four
 * surrounding grid samples. Positions outside the terrain are clamped to the
 * edge. Stage 6 will need this for walking on the surface; for now it backs
 * the GUI readout.
 */
export function sampleHeight(map: Heightmap, x: number, z: number): number {
  const { heights, resolution, size } = map;
  const half = size / 2;

  // World space -> grid space, clamped to stay inside the array.
  const gx = Math.min(Math.max(((x + half) / size) * (resolution - 1), 0), resolution - 1);
  const gz = Math.min(Math.max(((z + half) / size) * (resolution - 1), 0), resolution - 1);

  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, resolution - 1);
  const z1 = Math.min(z0 + 1, resolution - 1);

  const tx = gx - x0;
  const tz = gz - z0;

  // Non-null assertions are safe: every index above is clamped into range.
  const h00 = heights[z0 * resolution + x0]!;
  const h10 = heights[z0 * resolution + x1]!;
  const h01 = heights[z1 * resolution + x0]!;
  const h11 = heights[z1 * resolution + x1]!;

  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * tz;
}
