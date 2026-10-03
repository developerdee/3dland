import * as THREE from 'three';

export interface FlyControlsOptions {
  /** Horizontal movement speed, world units per second. */
  speed?: number;
  /** Multiplier while the boost key (shift) is held. */
  boostMultiplier?: number;
  /** Radians of rotation per pixel of mouse movement. */
  lookSensitivity?: number;
}

/**
 * First-person camera: pointer-lock mouse look plus WASD movement.
 *
 * Three.js ships `FirstPersonControls` and `PointerLockControls`, but neither
 * does quite what a game needs — the former has no pointer lock, the latter no
 * movement. This is small enough to own, and owning it means stage 6 can add
 * collision without fighting a library's assumptions.
 *
 * Rotation is stored as explicit yaw/pitch rather than accumulated onto the
 * camera's quaternion. Accumulating introduces roll as soon as yaw and pitch
 * interact, which tilts the horizon — and once roll creeps in it is awkward to
 * remove. Rebuilding the orientation from two angles each frame makes roll
 * structurally impossible.
 */
export class FlyControls {
  enabled = false;

  /** Horizontal speed in units/second. */
  speed: number;
  boostMultiplier: number;
  lookSensitivity: number;

  /**
   * When set, the camera is held this many units above the terrain surface
   * instead of moving freely in Y — a cheap walking mode. Stage 6 replaces it
   * with real collision.
   */
  groundOffset: number | null = null;
  /** Supplies terrain height at a world position, for `groundOffset`. */
  sampleGround: ((x: number, z: number) => number) | null = null;
  /**
   * Half-extent of the walkable area. Height lookups clamp at the terrain
   * edge, so without this you walk off the mesh onto an invisible plateau at
   * the edge's height — no error, just a confusing void. Null disables it.
   */
  walkBounds: number | null = null;

  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();

  // Reused each frame: allocating vectors inside the render loop generates
  // garbage 60 times a second, and GC pauses show up as stutter.
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly motion = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  private readonly onPointerMove: (e: MouseEvent) => void;
  private readonly onPointerLockChange: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onCanvasClick: () => void;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    options: FlyControlsOptions = {},
  ) {
    this.speed = options.speed ?? 40;
    this.boostMultiplier = options.boostMultiplier ?? 3;
    this.lookSensitivity = options.lookSensitivity ?? 0.0022;

    this.onPointerMove = (e) => {
      if (!this.isLocked) return;

      this.yaw -= e.movementX * this.lookSensitivity;
      this.pitch -= e.movementY * this.lookSensitivity;

      // Clamp just short of straight up/down. At exactly +/-90 degrees the
      // forward vector becomes parallel to world up and yaw loses meaning.
      const limit = Math.PI / 2 - 0.001;
      this.pitch = Math.min(Math.max(this.pitch, -limit), limit);

      this.applyRotation();
    };

    this.onPointerLockChange = () => {
      // Releasing the pointer (Esc, or alt-tab) must clear held keys —
      // otherwise a key down at that moment never receives its keyup and the
      // camera drifts forever.
      if (!this.isLocked) this.keys.clear();
    };

    this.onKeyDown = (e) => {
      if (!this.enabled) return;
      this.keys.add(e.code);
      // Space scrolls the page by default, which fights with flying upward.
      if (e.code === 'Space') e.preventDefault();
    };

    this.onKeyUp = (e) => {
      this.keys.delete(e.code);
    };

    this.onCanvasClick = () => {
      if (this.enabled && !this.isLocked) {
        void this.domElement.requestPointerLock();
      }
    };

    document.addEventListener('mousemove', this.onPointerMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    this.domElement.addEventListener('click', this.onCanvasClick);
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.domElement;
  }

  /** Adopts the camera's current orientation, so toggling modes doesn't jump. */
  syncFromCamera(): void {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = this.euler.y;
    this.pitch = this.euler.x;
  }

  /** Releases the pointer, if held. */
  unlock(): void {
    if (this.isLocked) document.exitPointerLock();
  }

  update(dt: number): void {
    if (!this.enabled) return;

    // Guard against absurd steps: alt-tabbing away pauses
    // requestAnimationFrame, and the first frame back can report several
    // seconds, teleporting the camera across the map.
    const step = Math.min(dt, 0.1);

    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, THREE.Object3D.DEFAULT_UP).normalize();

    this.motion.set(0, 0, 0);

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.motion.add(this.forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.motion.sub(this.forward);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.motion.add(this.right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.motion.sub(this.right);

    const walking = this.groundOffset !== null;

    if (walking) {
      // On foot, looking up must not slow you down, so discard the vertical
      // component and renormalise.
      this.motion.y = 0;
    } else {
      if (this.keys.has('Space')) this.motion.y += 1;
      if (this.keys.has('KeyC') || this.keys.has('ControlLeft')) this.motion.y -= 1;
    }

    if (this.motion.lengthSq() > 0) {
      // Normalise so diagonal movement isn't faster than cardinal.
      this.motion.normalize();

      const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      this.motion.multiplyScalar(this.speed * (boost ? this.boostMultiplier : 1) * step);
      this.camera.position.add(this.motion);
    }

    if (walking) {
      if (this.walkBounds !== null) {
        const b = this.walkBounds;
        const p = this.camera.position;
        p.x = Math.min(Math.max(p.x, -b), b);
        p.z = Math.min(Math.max(p.z, -b), b);
      }

      if (this.sampleGround) {
        const ground = this.sampleGround(this.camera.position.x, this.camera.position.z);
        this.camera.position.y = ground + this.groundOffset!;
      }
    }
  }

  dispose(): void {
    this.unlock();
    document.removeEventListener('mousemove', this.onPointerMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    this.domElement.removeEventListener('click', this.onCanvasClick);
  }

  private applyRotation(): void {
    // YXZ order means yaw is applied before pitch, which is what keeps the
    // horizon level — the camera turns, then tilts within its own frame.
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.euler);
  }
}
