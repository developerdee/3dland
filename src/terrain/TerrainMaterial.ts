import * as THREE from 'three';

/** Live-tunable shading controls, all exposed in the GUI. */
export interface TerrainShadingParams {
  /** Altitude (0-1 of terrain range) where grass gives way to rock. */
  rockLine: number;
  /** Altitude (0-1) where snow begins to settle. */
  snowLine: number;
  /** Altitude (0-1) below which ground reads as sand or silt. */
  shoreLine: number;
  /** Slope (0 flat, 1 vertical) above which rock shows through regardless. */
  slopeRockStart: number;
  /** Slope at which the surface is fully rock. */
  slopeRockFull: number;
  /** Softness of every altitude transition; 0 is a hard band. */
  blend: number;
  /** Strength of the fine noise that breaks up flat colour. */
  macroVariation: number;
}

export const defaultShading: TerrainShadingParams = {
  shoreLine: 0.06,
  rockLine: 0.52,
  snowLine: 0.78,
  slopeRockStart: 0.42,
  slopeRockFull: 0.68,
  blend: 0.1,
  macroVariation: 0.13,
};

/** Terrain palette. Tuned together; changing one in isolation rarely helps. */
const PALETTE = {
  sand: 0xb9a878,
  grassLow: 0x4a6b3a,
  grassHigh: 0x5f7d42,
  rock: 0x6b6560,
  rockDark: 0x4e4a47,
  snow: 0xf4f7fa,
} as const;

/**
 * Extends `MeshStandardMaterial` with slope- and altitude-driven colour.
 *
 * Rather than writing a material from scratch, this injects GLSL into Three's
 * standard shader via `onBeforeCompile`. That keeps physically-based lighting,
 * shadows, fog and tone mapping — all of which are fiddly to reimplement — and
 * only replaces how the surface colour is chosen.
 *
 * The tradeoff is that the injection depends on Three's shader source: the
 * `#include` markers below are stable across versions in practice, but they
 * are internal, so a major Three upgrade is worth re-checking.
 */
export class TerrainMaterial extends THREE.MeshStandardMaterial {
  private readonly uniforms: Record<string, THREE.IUniform> = {
    uMinHeight: { value: -1 },
    uMaxHeight: { value: 1 },
    uShoreLine: { value: defaultShading.shoreLine },
    uRockLine: { value: defaultShading.rockLine },
    uSnowLine: { value: defaultShading.snowLine },
    uSlopeRockStart: { value: defaultShading.slopeRockStart },
    uSlopeRockFull: { value: defaultShading.slopeRockFull },
    uBlend: { value: defaultShading.blend },
    uMacroVariation: { value: defaultShading.macroVariation },
    uBiomeStrength: { value: 1 },
    uSand: { value: new THREE.Color(PALETTE.sand) },
    uGrassLow: { value: new THREE.Color(PALETTE.grassLow) },
    uGrassHigh: { value: new THREE.Color(PALETTE.grassHigh) },
    uRock: { value: new THREE.Color(PALETTE.rock) },
    uRockDark: { value: new THREE.Color(PALETTE.rockDark) },
    uSnow: { value: new THREE.Color(PALETTE.snow) },
  };

  constructor() {
    super({ roughness: 0.95, metalness: 0.0 });
  }

  /**
   * Terrain height range, so altitude bands can be expressed as 0-1.
   *
   * Bands are measured from `landMin` rather than the absolute minimum: with
   * an island, the sea floor sits far below the land, and measuring from
   * there would push every band — shoreline, rock line, snow line — up into
   * the land and leave the shore underwater.
   */
  setHeightRange(landMin: number, max: number): void {
    this.uniforms.uMinHeight!.value = landMin;
    this.uniforms.uMaxHeight!.value = max;
  }

  /** 0 falls back to the altitude bands; 1 uses the biome colours fully. */
  setBiomeStrength(value: number): void {
    this.uniforms.uBiomeStrength!.value = value;
  }

  apply(params: TerrainShadingParams): void {
    this.uniforms.uShoreLine!.value = params.shoreLine;
    this.uniforms.uRockLine!.value = params.rockLine;
    this.uniforms.uSnowLine!.value = params.snowLine;
    this.uniforms.uSlopeRockStart!.value = params.slopeRockStart;
    this.uniforms.uSlopeRockFull!.value = params.slopeRockFull;
    this.uniforms.uBlend!.value = Math.max(params.blend, 0.001);
    this.uniforms.uMacroVariation!.value = params.macroVariation;
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    Object.assign(shader.uniforms, this.uniforms);

    // Pass world-space position and normal through to the fragment stage.
    // Slope must be evaluated per-pixel from the interpolated normal: doing it
    // per-vertex and interpolating the *result* bands visibly on low-poly
    // terrain, which is the whole problem this stage exists to fix.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        // Biome colour, blended per vertex on the CPU. Interpolation across
        // the triangle gives smooth biome transitions for free.
        attribute vec3 biomeColor;
        varying vec3 vBiomeColor;
        `,
      )
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `
        #include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
        vBiomeColor = biomeColor;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vBiomeColor;
        uniform float uBiomeStrength;

        // Computed in the colour block, consumed later by the roughness
        // injection — the two run in separate shader chunks, so this carries
        // the value between them.
        float gSlopeRock = 0.0;

        uniform float uMinHeight;
        uniform float uMaxHeight;
        uniform float uShoreLine;
        uniform float uRockLine;
        uniform float uSnowLine;
        uniform float uSlopeRockStart;
        uniform float uSlopeRockFull;
        uniform float uBlend;
        uniform float uMacroVariation;
        uniform vec3 uSand;
        uniform vec3 uGrassLow;
        uniform vec3 uGrassHigh;
        uniform vec3 uRock;
        uniform vec3 uRockDark;
        uniform vec3 uSnow;

        // Cheap value noise. Not simplex — this only needs to break up flat
        // colour, and a hash-and-interpolate is a fraction of the cost.
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        float valueNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep, for C1 continuity
          return mix(
            mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
            mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }
        `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          float altitude = clamp(
            (vWorldPos.y - uMinHeight) / max(uMaxHeight - uMinHeight, 0.0001),
            0.0, 1.0
          );

          // The surface normal's y component is the cosine of the angle from
          // vertical, so 1 is flat ground and 0 is a sheer face.
          float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);

          // Two noise octaves: broad patches, plus fine grain so flat ground
          // does not read as a solid sheet of colour.
          float n = valueNoise(vWorldPos.xz * 0.06) * 0.65
                  + valueNoise(vWorldPos.xz * 0.23) * 0.35;
          float variation = (n - 0.5) * uMacroVariation;

          float shore = smoothstep(uShoreLine + uBlend, uShoreLine - uBlend, altitude);
          float rocky = smoothstep(uRockLine - uBlend, uRockLine + uBlend, altitude + variation);
          float snowy = smoothstep(uSnowLine - uBlend, uSnowLine + uBlend, altitude + variation);

          // Grass darkens slightly with altitude; cooler and sparser up high.
          vec3 albedo = mix(uGrassLow, uGrassHigh, altitude);

          // Altitude-driven rock, then slope-driven rock on top: a steep face
          // is bare regardless of how low it sits.
          albedo = mix(albedo, uRock, rocky);

          float slopeRock = smoothstep(uSlopeRockStart, uSlopeRockFull, slope);
          vec3 steepRock = mix(uRock, uRockDark, smoothstep(0.55, 0.95, slope));
          albedo = mix(albedo, steepRock, slopeRock);

          // Snow settles on altitude but slides off anything steep.
          float snowHold = snowy * (1.0 - smoothstep(0.30, 0.62, slope));
          albedo = mix(albedo, uSnow, snowHold);

          // Biome tint replaces the grass/soil colour, but not rock or snow:
          // exposed rock and snow look the same whatever biome they are in,
          // and letting a desert tint tint the snowline looks wrong.
          float groundShare = (1.0 - slopeRock) * (1.0 - snowHold);
          albedo = mix(albedo, vBiomeColor, groundShare * uBiomeStrength);

          // Shoreline sits under everything else, and only on gentle ground.
          albedo = mix(albedo, uSand, shore * (1.0 - slopeRock));

          // Break up remaining flatness, and roughen rock so it catches light
          // differently from grass.
          albedo *= 1.0 + variation * 0.5;

          diffuseColor.rgb = albedo;
          gSlopeRock = slopeRock;
        }
        `,
      )
      // roughnessFactor is declared in roughnessmap_fragment, which runs AFTER
      // color_fragment — so this has to be a second, later injection. Writing
      // it alongside the colour above would reference an undeclared variable
      // and fail to compile, which surfaces as a black screen.
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(0.95, 0.72, gSlopeRock);
        `,
      );
  }
}
