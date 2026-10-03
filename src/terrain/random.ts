/**
 * Deterministic pseudo-random number generation.
 *
 * `Math.random()` cannot be seeded, so it is useless for terrain: every reload
 * would give a different world, and a hill that reveals a bug could never be
 * revisited. These two functions give us "the same seed always produces the
 * same landscape" instead.
 */

/**
 * Hashes a string into a 32-bit integer, so seeds can be words rather than
 * numbers. Standard cyrb53-style mixing: multiply, xor, shift.
 */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Guarantee non-zero: mulberry32 degenerates if its state starts at 0.
  return (h >>> 0) || 1;
}

/**
 * mulberry32: a small, fast, well-distributed PRNG with 32 bits of state.
 *
 * Returns a function producing values in [0, 1), matching `Math.random`'s
 * contract so it can be handed straight to simplex-noise. Not
 * cryptographically secure — irrelevant here, where we want repeatability
 * rather than unpredictability.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
