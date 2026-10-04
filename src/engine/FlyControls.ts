import * as THREE from 'three';
import type { Collision } from './Collision';

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
   * Half-extent of the traversable area.
   *
   * Movement no longer uses this — `Collision` enforces the world edge for
   * every mode. It remains so that code placing the camera directly (mode
   * switches, respawns) can clamp into the world without a collision pass.
   */
  walkBounds: number | null = null;

  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();

  /** Intent from on-screen controls, summed with the keyboard's. */
  private readonly externalMove = new THREE.Vector3();
  private externalBoost = false;

  /**
   * Collision resolver. When unset, movement is unrestricted — useful for
   * debugging, and the state before terrain exists.
   */
  collision: Collision | null = null;

  /** Horizontal half-width of the mover, for obstacle tests. */
  bodyRadius = 0.42;

  /**
   * Minimum gap between the camera and the terrain when flying. Without it
   * you can press the camera flush against the surface, where the near plane
   * clips through and you see inside the mesh.
   */
  flyGroundClearance = 0.6;

  /** Reused each frame: collision runs in the render loop. */
  private readonly resolved = { x: 0, y: 0, z: 0, hit: false };

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
      this.applyLookDelta(e.movementX, e.movementY);
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

  /**
   * Feeds movement intent from a source other than the keyboard — the touch
   * dial. Additive with keys, so a hybrid device can use either.
   *
   * `x` strafes, `y` moves forward, `vertical` climbs; each in [-1, 1].
   */
  setExternalMove(x: number, y: number, vertical: number, boost: boolean): void {
    this.externalMove.set(x, y, vertical);
    this.externalBoost = boost;
  }

  /** Applies a look delta in pixels, as the mouse would while locked. */
  applyLookDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;

    this.yaw -= dx * this.lookSensitivity;
    this.pitch -= dy * this.lookSensitivity;

    const limit = Math.PI / 2 - 0.001;
    this.pitch = Math.min(Math.max(this.pitch, -limit), limit);

    this.applyRotation();
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

    // Keyboard intent in local axes: strafe, forward, climb. Collected as
    // scalars first so the keyboard's on/off input and the dial's analog
    // input can be combined before being turned into a world-space vector.
    let strafe = 0;
    let advance = 0;
    let climb = 0;

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) advance += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) advance -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;
    if (this.keys.has('Space')) climb += 1;
    if (this.keys.has('KeyC') || this.keys.has('ControlLeft')) climb -= 1;

    strafe += this.externalMove.x;
    advance += this.externalMove.y;
    climb += this.externalMove.z;

    const walking = this.groundOffset !== null;

    // Clamp the horizontal pair to unit length rather than normalising it.
    // Normalising would snap a half-deflected dial to full speed, throwing
    // away the analog range that makes a touch stick usable; clamping keeps
    // partial input partial while still stopping diagonal keyboard movement
    // from being 41% faster than cardinal.
    const planar = Math.hypot(strafe, advance);
    if (planar > 1) {
      strafe /= planar;
      advance /= planar;
    }

    this.motion.set(0, 0, 0);
    this.motion.addScaledVector(this.forward, advance);
    this.motion.addScaledVector(this.right, strafe);

    if (walking) {
      // On foot, looking up must not slow you down, so discard the vertical
      // component the look direction contributes.
      this.motion.y = 0;
      // Renormalise to the intended planar magnitude: dropping y from a
      // pitched forward vector shortens it, which would otherwise make you
      // walk slower the further you look up or down.
      const length = Math.hypot(this.motion.x, this.motion.z);
      if (length > 1e-6) {
        const target = Math.min(Math.hypot(strafe, advance), 1);
        this.motion.multiplyScalar(target / length);
      }
    } else {
      this.motion.y += Math.min(Math.max(climb, -1), 1);
    }

    const position = this.camera.position;
    const fromX = position.x;
    const fromZ = position.z;

    if (this.motion.lengthSq() > 0) {
      const boost =
        this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.externalBoost;
      this.motion.multiplyScalar(this.speed * (boost ? this.boostMultiplier : 1) * step);
      position.add(this.motion);
    }

    if (walking) {
      // Follow the surface first, then let collision correct it. Doing this
      // before the obstacle pass means the feet height used for vertical
      // overlap tests is the one the walker will actually have.
      if (this.sampleGround) {
        position.y = this.sampleGround(position.x, position.z) + this.groundOffset!;
      }
    }

    if (this.collision) {
      // The mover is a vertical capsule: `height` is how far the camera sits
      // above its feet. Flying, the camera *is* the body, so there is no
      // offset — which is what lets you hover just above the ground.
      const height = walking ? this.groundOffset! : 0;
      const gap = walking ? 0 : this.flyGroundClearance;

      this.collision.resolve(
        fromX,
        fromZ,
        position.x,
        position.y,
        position.z,
        this.bodyRadius,
        height,
        gap,
        this.resolved,
      );

      position.set(this.resolved.x, this.resolved.y, this.resolved.z);

      // Being pushed out of a tree moves you horizontally, so the surface
      // under your feet has changed — re-snap, or you end up floating over a
      // dip or buried in a rise.
      if (walking && this.resolved.hit && this.sampleGround) {
        position.y = this.sampleGround(position.x, position.z) + this.groundOffset!;
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
