import * as THREE from 'three';

/** Called once per frame. `dt` is seconds since the last frame. */
export type UpdateFn = (dt: number, elapsed: number) => void;

/**
 * Owns the renderer, camera, scene and the render loop — the parts every stage
 * of the project needs. Feature code registers per-frame work via `onUpdate`
 * and adds objects to `scene`.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly clock = new THREE.Clock();
  private readonly updates: UpdateFn[] = [];
  private readonly resizeObserver: ResizeObserver;
  private frameHandle: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    // Cap at 2x: beyond that the fill-rate cost buys almost nothing visible.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d12);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    this.camera.position.set(3, 2.5, 5);
    this.camera.lookAt(0, 0, 0);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  onUpdate(fn: UpdateFn): void {
    this.updates.push(fn);
  }

  start(): void {
    if (this.frameHandle !== null) return;
    this.clock.start();
    const tick = () => {
      this.frameHandle = requestAnimationFrame(tick);
      const dt = this.clock.getDelta();
      const elapsed = this.clock.elapsedTime;
      for (const update of this.updates) update(dt, elapsed);
      this.renderer.render(this.scene, this.camera);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.clock.stop();
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }

  private resize(): void {
    // clientWidth/Height are 0 while the canvas is detached or hidden; a 0
    // aspect ratio poisons the projection matrix with NaN, so skip those.
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
