import * as THREE from 'three';

export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';

interface QualitySettings {
  /** Shadow map side length in texels. */
  mapSize: number;
  /** World units covered by the shadow camera, edge to edge. */
  span: number;
  /** Three's shadow filtering mode. */
  type: THREE.ShadowMapType;
}

/**
 * Shadow map size against coverage is the whole problem.
 *
 * A single map stretched over a 1000-unit world gives roughly half a unit per
 * texel, so a half-unit tree trunk casts a one-texel shadow — unrecognisable
 * mush. Fitting the camera to a region around the viewer instead gives about
 * six texels per trunk, which reads properly; beyond that region shadows are
 * faded out rather than drawn badly.
 */
const QUALITY: Record<Exclude<ShadowQuality, 'off'>, QualitySettings> = {
  low: { mapSize: 1024, span: 110, type: THREE.PCFShadowMap },
  medium: { mapSize: 2048, span: 160, type: THREE.PCFSoftShadowMap },
  high: { mapSize: 4096, span: 240, type: THREE.PCFSoftShadowMap },
};

/**
 * Sun shadows, with the shadow camera tracking the viewer.
 *
 * The directional light's shadow camera is orthographic and finite, so it can
 * only cover part of a large world. Rather than compromise quality everywhere,
 * it follows the camera and covers a high-detail region around it.
 */
export class Shadows {
  private quality: ShadowQuality = 'medium';
  private span = QUALITY.medium.span;

  /** Reused each frame: this runs in the render loop. */
  private readonly target = new THREE.Vector3();
  private readonly sunOffset = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly sun: THREE.DirectionalLight,
  ) {
    // The light's shadow camera is positioned relative to the light, so the
    // light needs an explicit target object in the scene graph.
    this.sun.castShadow = false;
    this.sun.shadow.bias = -0.0008;
    // Normal bias offsets the sample along the surface normal, which fixes
    // the acne that plain depth bias leaves on steep slopes without the peter-
    // panning that a larger depth bias would cause.
    this.sun.shadow.normalBias = 0.6;
  }

  get level(): ShadowQuality {
    return this.quality;
  }

  /** The region radius currently covered, for fading shadows at its edge. */
  get radius(): number {
    return this.span / 2;
  }

  set(quality: ShadowQuality): void {
    this.quality = quality;

    if (quality === 'off') {
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
      return;
    }

    const settings = QUALITY[quality];
    this.span = settings.span;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = settings.type;
    this.sun.castShadow = true;

    const shadow = this.sun.shadow;

    // Changing map size after the first render needs the old target disposed,
    // or the previous framebuffer leaks.
    if (shadow.mapSize.width !== settings.mapSize) {
      shadow.mapSize.setScalar(settings.mapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }

    const camera = shadow.camera;
    const half = settings.span / 2;
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.near = 1;
    camera.far = settings.span * 3;
    camera.updateProjectionMatrix();

    // Three caches the shadow camera's matrices; without this the first frame
    // after a quality change uses stale bounds.
    shadow.needsUpdate = true;
  }

  /**
   * Centres the shadow region on the viewer.
   *
   * Called each frame. The light is moved, rather than only its target,
   * because a directional light's shadow camera sits at the light's position
   * looking at its target — so both must travel together.
   */
  follow(viewer: THREE.Camera, sunDirection: THREE.Vector3): void {
    if (this.quality === 'off') return;

    // Centre slightly ahead of the viewer: shadows matter in front of you, and
    // biasing forward buys roughly a third more useful range for free.
    viewer.getWorldDirection(this.target);
    this.target.multiplyScalar(this.span * 0.18);
    this.target.add(viewer.position);

    // Snap the centre to shadow-texel increments. Without this the shadow map
    // shifts by a fraction of a texel every frame as you walk, and every
    // shadow edge crawls and shimmers — the most noticeable shadow artefact
    // there is.
    const texelSize = this.span / this.sun.shadow.mapSize.width;
    this.target.x = Math.round(this.target.x / texelSize) * texelSize;
    this.target.z = Math.round(this.target.z / texelSize) * texelSize;

    this.sunOffset.copy(sunDirection).normalize();

    // At a low sun the light is nearly horizontal, so the region's footprint
    // stretches far along the light's view axis — and terrain outside that
    // depth range silently stops casting, exactly when shadows are longest
    // and most visible. Size the depth range from the actual elevation.
    //
    // sunDirection.y is the sine of the elevation, so this is half the span
    // divided by sin(elevation): the depth the region spans from this angle.
    const elevationSine = Math.max(Math.abs(this.sunOffset.y), 0.08);
    const depthSpan = this.span / 2 / elevationSine;

    const distance = Math.max(this.span * 1.2, depthSpan + this.span * 0.5);
    this.sun.position.copy(this.target).addScaledVector(this.sunOffset, distance);

    const camera = this.sun.shadow.camera;
    const near = Math.max(1, distance - depthSpan - this.span * 0.5);
    const far = distance + depthSpan + this.span * 0.5;

    // Updating the projection matrix every frame would be wasteful, so only
    // when the range has actually moved meaningfully.
    if (Math.abs(camera.far - far) > 1 || Math.abs(camera.near - near) > 1) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }

    this.sun.target.position.copy(this.target);
    this.sun.target.updateMatrixWorld();
  }
}
