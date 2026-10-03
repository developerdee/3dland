import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { FlyControls } from './FlyControls';

export type CameraMode = 'orbit' | 'fly' | 'walk';

/**
 * Switches between the camera modes, keeping position and orientation
 * continuous across a switch.
 *
 * Orbit and fly both want to own the camera, so exactly one is enabled at a
 * time. The subtlety is handing over cleanly: orbit stores a target it looks
 * at, fly stores yaw/pitch. Switching without translating between the two
 * snaps the view, which is disorienting enough to feel like a bug.
 */
export class CameraModes {
  private current: CameraMode = 'orbit';

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly orbit: OrbitControls,
    private readonly fly: FlyControls,
    /** Terrain height lookup, used to place the camera in walk mode. */
    private readonly sampleGround: (x: number, z: number) => number,
    /** Eye height above the surface when walking. */
    private readonly eyeHeight = 1.8,
  ) {
    this.fly.sampleGround = sampleGround;
    this.apply();
  }

  get mode(): CameraMode {
    return this.current;
  }

  set(mode: CameraMode): void {
    if (mode === this.current) return;
    const previous = this.current;
    this.current = mode;

    if (previous === 'orbit') {
      // Orbit aims the camera via its target; adopt that heading so the view
      // does not jump when fly takes over.
      this.fly.syncFromCamera();
    }

    if (mode === 'walk') {
      // Drop to the surface at the current horizontal position. Without this
      // the first frame would snap from flying altitude to eye height, which
      // reads as falling through the world.
      //
      // Clamp inside the terrain first: switching to walk from high above and
      // outside the mesh would otherwise land on the flat plateau that edge-
      // clamped height lookups produce.
      const bounds = this.fly.walkBounds;
      if (bounds !== null) {
        const p = this.camera.position;
        p.x = Math.min(Math.max(p.x, -bounds), bounds);
        p.z = Math.min(Math.max(p.z, -bounds), bounds);
      }
      const { x, z } = this.camera.position;
      this.camera.position.y = this.sampleGround(x, z) + this.eyeHeight;
    }

    if (mode === 'orbit') {
      this.fly.unlock();
      // Give orbit something sensible to pivot around: a point ahead of where
      // the camera is already looking, rather than wherever it last orbited.
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      this.orbit.target.copy(this.camera.position).addScaledVector(forward, 60);
    }

    this.apply();
  }

  update(dt: number): void {
    if (this.current === 'orbit') {
      this.orbit.update();
    } else {
      this.fly.update(dt);
    }
  }

  private apply(): void {
    const orbiting = this.current === 'orbit';
    this.orbit.enabled = orbiting;
    this.fly.enabled = !orbiting;
    this.fly.groundOffset = this.current === 'walk' ? this.eyeHeight : null;
    if (orbiting) this.orbit.update();
  }
}
