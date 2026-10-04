import * as THREE from 'three';

/** Live-tunable water controls. */
export interface WaterParams {
  /**
   * Surface height, relative to the median height of the island's interior.
   *
   * 0.5 puts the sea at the median, drowning about half the interior. Lower
   * means more land. Expressed this way rather than as a fraction of the
   * height range because the range's endpoints move with every seed, which
   * made a fixed fraction flood some islands and barely wet others.
   */
  level: number;
  /** Colour of deep water. */
  deepColor: number;
  /** Colour where water meets land. */
  shallowColor: number;
  /** Depth, in world units, over which deep colour fully takes over. */
  depthFade: number;
  /** Ripple height. 0 is glass. */
  waveHeight: number;
  /** Ripple size; higher is choppier. */
  waveScale: number;
  /** Ripple animation rate. */
  waveSpeed: number;
  /** Strength of the mirrored sky and sun on the surface. */
  reflectivity: number;
  /** Width of the foam band at the shoreline, in world units. */
  foamWidth: number;
}

export const defaultWater: WaterParams = {
  // Below the median, so the majority of the island stays dry while the low
  // ground gives inlets, bays and the odd inland lake.
  level: 0.34,
  deepColor: 0x0f3550,
  shallowColor: 0x3f8fa8,
  depthFade: 14,
  waveHeight: 0.26,
  waveScale: 0.11,
  waveSpeed: 0.55,
  reflectivity: 0.55,
  foamWidth: 1.6,
};

/**
 * An animated water plane.
 *
 * Convincing water needs more than a blue surface: it needs to be transparent
 * in the shallows and opaque in the deeps, to ripple, to reflect the sky, and
 * to foam where it meets land. All of that is done here in one shader pass
 * against the terrain's own heightmap, rather than with render-to-texture
 * reflections — a planar reflection pass means drawing the whole scene twice,
 * which is a poor trade on a phone.
 *
 * Depth comes from a heightmap texture rather than the depth buffer, which
 * keeps the shader independent of render order and works without reading back
 * the framebuffer.
 */
export class Water {
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.ShaderMaterial;
  private heightTexture: THREE.DataTexture | null = null;
  private params: WaterParams = { ...defaultWater };
  /** Lowest land height, and the interior's median, for sea level. */
  private landMin = 0;
  private landMedian = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      // Water is a surface, not a volume: writing depth would stop the terrain
      // beneath it from showing through where it is transparent.
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uWaterLevel: { value: 0 },
        uTerrainSize: { value: 1 },
        uMinHeight: { value: -1 },
        uMaxHeight: { value: 1 },
        uHeightMap: { value: null },
        uDeepColor: { value: new THREE.Color(defaultWater.deepColor) },
        uShallowColor: { value: new THREE.Color(defaultWater.shallowColor) },
        uDepthFade: { value: defaultWater.depthFade },
        uWaveHeight: { value: defaultWater.waveHeight },
        uWaveScale: { value: defaultWater.waveScale },
        uWaveSpeed: { value: defaultWater.waveSpeed },
        uReflectivity: { value: defaultWater.reflectivity },
        uFoamWidth: { value: defaultWater.foamWidth },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(0xfff2d8) },
        uSkyColor: { value: new THREE.Color(0xbcd3e8) },
        uHorizonColor: { value: new THREE.Color(0xbcd3e8) },
        uFogDensity: { value: 0.0022 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWaveHeight;
        uniform float uWaveScale;
        uniform float uWaveSpeed;

        varying vec3 vWorldPos;
        varying vec3 vNormal;

        // Two crossing wave trains at different angles and rates. A single
        // sine reads as corrugated iron; crossing them breaks the pattern up
        // enough to look like open water.
        float waveHeightAt(vec2 p, float t) {
          float a = sin(p.x * uWaveScale + t) * cos(p.y * uWaveScale * 0.82 - t * 0.78);
          float b = sin((p.x + p.y) * uWaveScale * 1.71 - t * 1.33);
          return a * 0.62 + b * 0.38;
        }

        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          float t = uTime * uWaveSpeed;

          world.y += waveHeightAt(world.xz, t) * uWaveHeight;

          // Derive the normal by sampling the wave function either side, so
          // lighting matches the displacement without a normal map. The step
          // is in world units and deliberately coarse: finer sampling gives a
          // noisier normal, not a better one.
          float e = 1.2;
          float hL = waveHeightAt(world.xz - vec2(e, 0.0), t) * uWaveHeight;
          float hR = waveHeightAt(world.xz + vec2(e, 0.0), t) * uWaveHeight;
          float hD = waveHeightAt(world.xz - vec2(0.0, e), t) * uWaveHeight;
          float hU = waveHeightAt(world.xz + vec2(0.0, e), t) * uWaveHeight;
          vNormal = normalize(vec3(hL - hR, 2.0 * e, hD - hU));

          vWorldPos = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uWaterLevel;
        uniform float uTerrainSize;
        uniform float uMinHeight;
        uniform float uMaxHeight;
        uniform sampler2D uHeightMap;
        uniform vec3 uDeepColor;
        uniform vec3 uShallowColor;
        uniform float uDepthFade;
        uniform float uReflectivity;
        uniform float uFoamWidth;
        uniform float uTime;
        uniform float uWaveSpeed;
        uniform vec3 uSunDirection;
        uniform vec3 uSunColor;
        uniform vec3 uSkyColor;
        uniform vec3 uHorizonColor;
        uniform float uFogDensity;

        varying vec3 vWorldPos;
        varying vec3 vNormal;

        void main() {
          // Terrain height beneath this pixel, from the heightmap texture.
          vec2 uv = vWorldPos.xz / uTerrainSize + 0.5;
          float encoded = texture2D(uHeightMap, uv).r;
          float groundHeight = mix(uMinHeight, uMaxHeight, encoded);

          float depth = uWaterLevel - groundHeight;

          // Discard rather than blend above the shoreline: a transparent
          // fringe over dry land looks like a rendering error.
          if (depth < 0.0) discard;

          vec3 normal = normalize(vNormal);
          vec3 viewDir = normalize(cameraPosition - vWorldPos);

          // Deeper water is darker and less transparent.
          float depthMix = clamp(depth / max(uDepthFade, 0.001), 0.0, 1.0);
          vec3 base = mix(uShallowColor, uDeepColor, depthMix);

          // Schlick's approximation of the Fresnel term: water is nearly
          // transparent looking straight down and mirror-like at a glancing
          // angle. This single term does most of the work of looking wet.
          float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);

          // Mirrored sky, tinted toward the horizon as the view flattens.
          float upness = clamp(normal.y, 0.0, 1.0);
          vec3 reflected = mix(uHorizonColor, uSkyColor, upness);

          vec3 color = mix(base, reflected, fresnel * uReflectivity);

          // Diffuse sun, plus a tight specular highlight for glitter.
          vec3 sunDir = normalize(uSunDirection);
          float diffuse = max(dot(normal, sunDir), 0.0);
          color += uSunColor * diffuse * 0.16;

          vec3 halfway = normalize(sunDir + viewDir);
          float specular = pow(max(dot(normal, halfway), 0.0), 96.0);
          color += uSunColor * specular * 0.85;

          // Foam at the shoreline, where depth approaches zero. Animated so
          // it reads as surf rather than a painted outline.
          float ripple = 0.74 + 0.26 * sin(
            (vWorldPos.x + vWorldPos.z) * 0.55 - uTime * uWaveSpeed * 2.3
          );
          float foam = 1.0 - smoothstep(0.0, max(uFoamWidth, 0.001) * ripple, depth);
          color = mix(color, vec3(0.93, 0.96, 0.98), foam * 0.8);

          // Shallow water is see-through; deep water and foam are not.
          float alpha = mix(0.52, 0.96, depthMix);
          alpha = max(alpha, foam * 0.9);

          // Match the scene's exponential-squared fog by hand: this is a raw
          // ShaderMaterial, so Three's fog chunks are not included.
          float dist = length(cameraPosition - vWorldPos);
          float fogFactor = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
          color = mix(color, uHorizonColor, clamp(fogFactor, 0.0, 1.0));

          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    // A modest grid is enough: waves are displaced per-vertex, so this sets
    // ripple resolution. 128 segments over the world keeps vertices a few
    // units apart, which the wave scale is tuned against.
    const geometry = new THREE.PlaneGeometry(1, 1, 128, 128);
    geometry.rotateX(-Math.PI / 2);

    this.mesh = new THREE.Mesh(geometry, this.material);
    // Draw after the terrain so blending reads correct colours beneath.
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  set visible(value: boolean) {
    this.mesh.visible = value;
  }

  /** Surface height in world units, for spawn and camera logic. */
  get surfaceY(): number {
    return this.material.uniforms.uWaterLevel!.value as number;
  }

  /**
   * Rebuilds the depth lookup from a heightmap. Call whenever the terrain
   * changes, or the water will be shaped by the previous landscape.
   */
  setTerrain(
    heights: Float32Array,
    resolution: number,
    size: number,
    min: number,
    max: number,
    landMin: number,
    landMedian: number,
  ): void {
    // Encode height as a normalised single channel. A DataTexture avoids any
    // image decoding, and linear filtering smooths the depth gradient between
    // samples so the shoreline is not stair-stepped.
    const data = new Float32Array(resolution * resolution);
    const range = max - min || 1;
    for (let i = 0; i < heights.length; i++) {
      data[i] = (heights[i]! - min) / range;
    }

    this.heightTexture?.dispose();
    const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.FloatType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // Clamp, so sampling past the terrain edge repeats the edge rather than
    // wrapping the far side of the world into the shoreline.
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this.heightTexture = texture;

    const u = this.material.uniforms;
    u.uHeightMap!.value = texture;
    u.uTerrainSize!.value = size;
    u.uMinHeight!.value = min;
    u.uMaxHeight!.value = max;

    // The plane is a unit square scaled to the world, so one geometry serves
    // any terrain size. Slightly oversized to hide the seam at the edge.
    this.mesh.scale.set(size * 1.02, 1, size * 1.02);

    this.landMin = landMin;
    this.landMedian = landMedian;
    this.applyLevel();
  }

  apply(params: WaterParams): void {
    this.params = params;
    const u = this.material.uniforms;
    (u.uDeepColor!.value as THREE.Color).set(params.deepColor);
    (u.uShallowColor!.value as THREE.Color).set(params.shallowColor);
    u.uDepthFade!.value = params.depthFade;
    u.uWaveHeight!.value = params.waveHeight;
    u.uWaveScale!.value = params.waveScale;
    u.uWaveSpeed!.value = params.waveSpeed;
    u.uReflectivity!.value = params.reflectivity;
    u.uFoamWidth!.value = params.foamWidth;

    this.applyLevel();
  }

  /** Keeps lighting and atmosphere in step with the rest of the scene. */
  setEnvironment(sunDirection: THREE.Vector3, skyColor: THREE.Color, horizonColor: THREE.Color): void {
    (this.material.uniforms.uSunDirection!.value as THREE.Vector3).copy(sunDirection).normalize();
    (this.material.uniforms.uSkyColor!.value as THREE.Color).copy(skyColor);
    (this.material.uniforms.uHorizonColor!.value as THREE.Color).copy(horizonColor);
  }

  update(elapsed: number): void {
    this.material.uniforms.uTime!.value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.heightTexture?.dispose();
  }

  private applyLevel(): void {
    // Anchored to the interior's median height, scaled by `level`. The median
    // is stable across seeds where the range's endpoints are not, so the same
    // setting gives a comparable coastline on every world.
    const max = this.material.uniforms.uMaxHeight!.value as number;
    const span = Math.max(max - this.landMin, 1e-6);
    const medianFraction = (this.landMedian - this.landMin) / span;
    const y = this.landMin + span * (medianFraction * (this.params.level / 0.5));
    this.material.uniforms.uWaterLevel!.value = y;
    this.mesh.position.y = y;
  }
}
