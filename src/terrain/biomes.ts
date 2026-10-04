import { createNoise2D } from 'simplex-noise';
import type { Heightmap } from './heightmap';
import { hashSeed, mulberry32 } from './random';

/**
 * Biome classification, by altitude and moisture.
 *
 * Real biome maps are driven by temperature and rainfall, and on a single
 * island temperature tracks altitude closely enough to stand in for it. A
 * second noise field supplies moisture, so wet lowlands become grassland, dry
 * lowlands desert, and high ground tundra — coherent regions without needing
 * to place them by hand.
 */
export type BiomeId = 'aquatic' | 'desert' | 'grassland' | 'forest' | 'tundra';

export interface BiomeSettings {
  /** Whether this biome appears at all. */
  enabled: boolean;
  /**
   * Relative share of the map this biome claims, 0-2. Raising one biome's
   * weight takes territory from the others rather than adding area.
   */
  weight: number;
  /** Multiplies the vegetation this biome would otherwise carry. */
  vegetation: number;
}

export interface BiomeParams {
  /** Size of the moisture regions. Lower is broader. */
  moistureScale: number;
  /** Softness of the transition between neighbouring biomes, in 0-1 units. */
  blend: number;
  aquatic: BiomeSettings;
  desert: BiomeSettings;
  grassland: BiomeSettings;
  forest: BiomeSettings;
  tundra: BiomeSettings;
}

export const defaultBiomes: BiomeParams = {
  moistureScale: 1.5,
  blend: 0.08,
  aquatic: { enabled: true, weight: 1, vegetation: 0.35 },
  desert: { enabled: true, weight: 1, vegetation: 0.25 },
  grassland: { enabled: true, weight: 1, vegetation: 0.7 },
  forest: { enabled: true, weight: 1, vegetation: 1 },
  tundra: { enabled: true, weight: 1, vegetation: 0.4 },
};

export const BIOME_IDS: readonly BiomeId[] = [
  'aquatic',
  'desert',
  'grassland',
  'forest',
  'tundra',
];

/**
 * Where each biome sits in altitude/moisture space.
 *
 * `altitude` and `moisture` are the band centres; `altitudeSpread` and
 * `moistureSpread` how far the biome's influence reaches. Classification picks
 * whichever biome scores highest at a point, so these are preferences rather
 * than hard boundaries and the map is always fully covered.
 */
interface BiomeNiche {
  altitude: number;
  altitudeSpread: number;
  moisture: number;
  moistureSpread: number;
}

const NICHES: Record<BiomeId, BiomeNiche> = {
  // Altitudes are fractions of the LAND's own range: 0 is the shoreline, 1
  // the highest peak. See BiomeField.landAltitude for why.
  //
  // Coastal strip: beach and salt flat, wide moisture spread since a coast is
  // a coast whether wet or dry.
  aquatic: { altitude: 0.0, altitudeSpread: 0.17, moisture: 0.5, moistureSpread: 2 },
  // Dry low ground, inland of the beach.
  desert: { altitude: 0.3, altitudeSpread: 0.3, moisture: 0.16, moistureSpread: 0.26 },
  // Wet-to-moderate lowlands and gentle hills: the default landscape.
  grassland: { altitude: 0.36, altitudeSpread: 0.28, moisture: 0.56, moistureSpread: 0.24 },
  // The wettest mid-to-upper ground, where woodland takes hold.
  forest: { altitude: 0.52, altitudeSpread: 0.26, moisture: 0.86, moistureSpread: 0.26 },
  // Cold high ground, any moisture.
  tundra: { altitude: 1.0, altitudeSpread: 0.3, moisture: 0.5, moistureSpread: 2 },
};

/** Ground colours per biome, low to high within the biome. */
export const BIOME_COLORS: Record<BiomeId, { low: number; high: number }> = {
  aquatic: { low: 0xc2b393, high: 0xa89c7c }, // wet sand and silt
  desert: { low: 0xcbb285, high: 0xb09a6e }, // dune sand to dry rock
  grassland: { low: 0x6f8f49, high: 0x87975a }, // green sward to dry grass
  forest: { low: 0x3f5c32, high: 0x4e6b3a }, // deep green
  tundra: { low: 0x8d9288, high: 0xd7dde2 }, // lichen grey to snow
};

export interface BiomeField {
  /** Biome weights at a world position, one per id, summing to 1. */
  sample(x: number, z: number, map: Heightmap): Float32Array;
  /** The dominant biome at a position. */
  dominant(x: number, z: number, map: Heightmap): BiomeId;
  /** Raw moisture at a position, 0-1. */
  moistureAt(x: number, z: number): number;
  /**
   * Altitude rescaled against the land's own range, 0 at the shoreline and 1
   * at the highest peak.
   *
   * Raw altitude is a poor classifier because dry land occupies a narrow slice
   * of the full height range — measured at 0.37 to 0.98, with 59% of it inside
   * a single tenth. Niches spread over 0-1 would aim most of their range at
   * altitudes holding no land, which is why tundra appeared on 1.5% of the map
   * and grassland on 59%. Rescaling spreads the biomes across the terrain that
   * actually exists.
   */
  landAltitude(x: number, z: number, map: Heightmap): number;
}

/**
 * Builds the biome field for a world.
 *
 * Classification scores every enabled biome at a point and normalises, so the
 * map is always fully covered whichever biomes are switched off — disabling
 * grassland widens its neighbours rather than leaving bare patches.
 */
export function createBiomeField(
  seed: string,
  params: BiomeParams,
  /** Height of the waterline, so altitude can be measured from the shore. */
  waterLevel: number | null,
  map: Heightmap,
): BiomeField {
  const noise = createNoise2D(mulberry32(hashSeed(`${seed}:moisture`)));

  // Establish the land's own altitude range once, rather than per sample.
  const shore = waterLevel ?? map.landMin;
  const peak = map.max;
  const landSpan = Math.max(peak - shore, 1e-6);

  // Two octaves: broad wet and dry regions, plus finer variation so the
  // boundaries are not smooth arcs.
  const moistureAt = (x: number, z: number): number => {
    const s = params.moistureScale / 400;
    const broad = noise(x * s, z * s);
    const fine = noise(x * s * 2.7 + 31.7, z * s * 2.7 - 11.3);
    // Map from [-1, 1] to [0, 1].
    return Math.min(Math.max((broad * 0.7 + fine * 0.3 + 1) / 2, 0), 1);
  };

  const scratch = new Float32Array(BIOME_IDS.length);

  const landAltitude = (x: number, z: number, m: Heightmap): number => {
    const height = sampleHeightFast(m, x, z);
    // Compressed toward the low end, because land area falls off sharply with
    // height: a linear measure would give the sparse high ground as much of
    // the biome range as the crowded lowlands.
    const raw = Math.min(Math.max((height - shore) / landSpan, 0), 1);
    return Math.pow(raw, 0.55);
  };

  const score = (x: number, z: number, map: Heightmap): Float32Array => {
    const altitude = landAltitude(x, z, map);
    const moisture = moistureAt(x, z);

    let total = 0;

    for (let i = 0; i < BIOME_IDS.length; i++) {
      const id = BIOME_IDS[i]!;
      const settings = params[id];

      if (!settings.enabled || settings.weight <= 0) {
        scratch[i] = 0;
        continue;
      }

      const niche = NICHES[id];

      // Gaussian-ish falloff from the niche centre in both dimensions. The
      // blend parameter widens every spread together, softening all the
      // boundaries at once.
      const altitudeSpread = niche.altitudeSpread + params.blend;
      const moistureSpread = niche.moistureSpread + params.blend;

      const da = (altitude - niche.altitude) / altitudeSpread;
      const dm = (moisture - niche.moisture) / moistureSpread;

      const fit = Math.exp(-(da * da + dm * dm));
      const value = fit * settings.weight;

      scratch[i] = value;
      total += value;
    }

    if (total <= 0) {
      // Everything disabled, or all weights zero: fall back to the first
      // enabled biome rather than returning a field of zeroes that callers
      // would have to special-case.
      for (let i = 0; i < BIOME_IDS.length; i++) {
        scratch[i] = params[BIOME_IDS[i]!].enabled ? 1 : 0;
        if (scratch[i] === 1) return scratch;
      }
      scratch[0] = 1;
      return scratch;
    }

    for (let i = 0; i < scratch.length; i++) scratch[i]! /= total;
    return scratch;
  };

  return {
    sample: score,
    moistureAt,
    landAltitude,
    dominant(x, z, map) {
      const weights = score(x, z, map);
      let best = 0;
      let bestIndex = 0;
      for (let i = 0; i < weights.length; i++) {
        if (weights[i]! > best) {
          best = weights[i]!;
          bestIndex = i;
        }
      }
      return BIOME_IDS[bestIndex]!;
    },
  };
}

/**
 * Nearest-sample height lookup.
 *
 * Biome classification runs for every prop candidate and every terrain
 * vertex, and does not need the bilinear interpolation `sampleHeight` does —
 * a biome boundary half a vertex out is invisible.
 */
function sampleHeightFast(map: Heightmap, x: number, z: number): number {
  const { heights, resolution, size } = map;
  const half = size / 2;
  const gx = Math.round(((x + half) / size) * (resolution - 1));
  const gz = Math.round(((z + half) / size) * (resolution - 1));
  const cx = Math.min(Math.max(gx, 0), resolution - 1);
  const cz = Math.min(Math.max(gz, 0), resolution - 1);
  return heights[cz * resolution + cx]!;
}
