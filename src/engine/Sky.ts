import * as THREE from 'three';

export interface SkyColors {
  /** Colour at the zenith, directly overhead. */
  top: number;
  /** Colour at the horizon. */
  horizon: number;
  /** Ground haze below the horizon, seen when looking down from altitude. */
  bottom: number;
}

export const defaultSky: SkyColors = {
  top: 0x3f74c4,
  horizon: 0xbcd3e8,
  bottom: 0x7d8a96,
};

/**
 * A gradient sky dome.
 *
 * A flat background colour reads as a void: real sky is much paler near the
 * horizon, and that vertical gradient is most of what sells distance. This is
 * a large inverted sphere with a two-stop gradient, which is the cheapest
 * convincing option — no cubemap to load, no atmospheric scattering to
 * compute.
 *
 * `depthWrite: false` and a low render order keep it behind everything else
 * without relying on its radius exceeding the far plane.
 */
export class Sky {
  readonly mesh: THREE.Mesh;

  private readonly uniforms = {
    uTop: { value: new THREE.Color(defaultSky.top) },
    uHorizon: { value: new THREE.Color(defaultSky.horizon) },
    uBottom: { value: new THREE.Color(defaultSky.bottom) },
  };

  constructor(radius = 4000) {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide, // we are inside the sphere
      depthWrite: false,
      fog: false, // fogging the sky would wash the gradient flat
      vertexShader: /* glsl */ `
        varying vec3 vLocalPos;
        void main() {
          vLocalPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vLocalPos;
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uBottom;

        void main() {
          // Normalising per-pixel rather than using the interpolated length
          // keeps the gradient even; interpolation across a coarse sphere
          // would otherwise bulge the horizon band.
          float h = normalize(vLocalPos).y;

          vec3 color;
          if (h > 0.0) {
            // Bias the blend so the pale horizon band stays narrow, which is
            // what makes it read as atmosphere rather than a smooth ramp.
            color = mix(uHorizon, uTop, pow(h, 0.42));
          } else {
            color = mix(uHorizon, uBottom, pow(-h, 0.6));
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    // Low segment counts are fine: the gradient is computed per-pixel, so the
    // geometry only has to be round enough not to show facets at the silhouette.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
    this.mesh.renderOrder = -1;
    // The dome follows the camera, so it must never be culled by its bounds.
    this.mesh.frustumCulled = false;
  }

  /** The horizon colour, which fog should match so the terrain edge dissolves. */
  get horizonColor(): THREE.Color {
    return this.uniforms.uHorizon.value;
  }

  set(colors: SkyColors): void {
    this.uniforms.uTop.value.set(colors.top);
    this.uniforms.uHorizon.value.set(colors.horizon);
    this.uniforms.uBottom.value.set(colors.bottom);
  }

  /**
   * Keeps the dome centred on the camera, so it behaves like an infinitely
   * distant sky rather than a sphere you can fly out of.
   */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
