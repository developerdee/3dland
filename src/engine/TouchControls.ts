/**
 * On-screen twin-stick controls for touch devices.
 *
 * Left: a circular dial giving a 2D movement vector. Right: a free drag area
 * for looking, plus a vertical pair for ascend/descend when flying.
 *
 * This reports *intent* as plain numbers and owns no camera state, so the same
 * values can drive FlyControls regardless of how they were produced. Keyboard
 * and touch therefore compose rather than compete.
 */

export interface TouchState {
  /** Movement intent: x is strafe, y is forward. Each in [-1, 1]. */
  moveX: number;
  moveY: number;
  /** Look delta accumulated since the last read, in pixels. */
  lookDX: number;
  lookDY: number;
  /** Vertical intent for fly mode: 1 up, -1 down. */
  vertical: number;
  /** True while the movement dial is held beyond its boost threshold. */
  boost: boolean;
}

const DIAL_RADIUS = 58;
const KNOB_RADIUS = 26;
/** Dial deflection beyond this fraction of full travel engages boost. */
const BOOST_THRESHOLD = 0.92;

export class TouchControls {
  readonly root: HTMLDivElement;

  private readonly state: TouchState = {
    moveX: 0,
    moveY: 0,
    lookDX: 0,
    lookDY: 0,
    vertical: 0,
    boost: false,
  };

  private readonly dial: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly lookPad: HTMLDivElement;
  private readonly verticalPad: HTMLDivElement;

  /** Pointer currently driving the dial, and the one driving look. */
  private dialPointer: number | null = null;
  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };

  private verticalHeld = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'touch-controls';

    // --- Movement dial ---
    this.dial = document.createElement('div');
    this.dial.className = 'tc-dial';
    this.knob = document.createElement('div');
    this.knob.className = 'tc-knob';
    this.dial.appendChild(this.knob);

    // Eight direction ticks, purely visual: they make the dial read as a
    // control rather than a blank circle.
    for (let i = 0; i < 8; i++) {
      const tick = document.createElement('span');
      tick.className = 'tc-tick';
      tick.style.transform = `rotate(${i * 45}deg) translateY(-${DIAL_RADIUS - 11}px)`;
      this.dial.appendChild(tick);
    }

    // --- Look area ---
    this.lookPad = document.createElement('div');
    this.lookPad.className = 'tc-look';
    this.lookPad.innerHTML = '<span class="tc-look-hint">drag to look</span>';

    // --- Vertical (fly only) ---
    this.verticalPad = document.createElement('div');
    this.verticalPad.className = 'tc-vertical';
    this.verticalPad.appendChild(this.makeVerticalButton('▲', 1));
    this.verticalPad.appendChild(this.makeVerticalButton('▼', -1));

    this.root.append(this.lookPad, this.dial, this.verticalPad);

    this.bindDial();
    this.bindLook();
  }

  /** Whether this device reports touch support. */
  static isTouchDevice(): boolean {
    return (
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      window.matchMedia('(pointer: coarse)').matches
    );
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  set visible(value: boolean) {
    this.root.classList.toggle('hidden', !value);
    if (!value) this.reset();
  }

  /** Shows the ascend/descend pair only when it does something. */
  set verticalEnabled(value: boolean) {
    this.verticalPad.classList.toggle('hidden', !value);
    if (!value) this.verticalHeld = 0;
  }

  /**
   * Returns current intent and clears the accumulated look delta, so each
   * frame consumes only the movement since the last one.
   */
  consume(): TouchState {
    const snapshot: TouchState = {
      ...this.state,
      vertical: this.verticalHeld,
    };
    this.state.lookDX = 0;
    this.state.lookDY = 0;
    return snapshot;
  }

  dispose(): void {
    this.root.remove();
  }

  private reset(): void {
    this.state.moveX = 0;
    this.state.moveY = 0;
    this.state.lookDX = 0;
    this.state.lookDY = 0;
    this.state.boost = false;
    this.verticalHeld = 0;
    this.dialPointer = null;
    this.lookPointer = null;
    this.knob.style.transform = 'translate(-50%, -50%)';
  }

  private makeVerticalButton(label: string, direction: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'tc-btn tc-vbtn';
    button.textContent = label;
    button.type = 'button';

    // Hold-to-move: pointerdown starts, and release *or* leaving the button
    // stops. Without the cancel/leave handlers a finger sliding off would
    // leave the button stuck down and the camera climbing forever.
    const press = (e: PointerEvent) => {
      e.preventDefault();
      this.verticalHeld = direction;
      button.classList.add('active');
      button.setPointerCapture(e.pointerId);
    };
    const release = () => {
      if (this.verticalHeld === direction) this.verticalHeld = 0;
      button.classList.remove('active');
    };

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);

    return button;
  }

  private bindDial(): void {
    const update = (e: PointerEvent) => {
      const rect = this.dial.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      let dx = e.clientX - cx;
      let dy = e.clientY - cy;

      // Clamp to the dial's travel, so dragging far away holds full tilt in
      // that direction rather than scaling past 1.
      const distance = Math.hypot(dx, dy);
      const travel = DIAL_RADIUS - KNOB_RADIUS / 2;
      if (distance > travel) {
        dx = (dx / distance) * travel;
        dy = (dy / distance) * travel;
      }

      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

      const nx = dx / travel;
      const ny = dy / travel;
      this.state.moveX = nx;
      // Screen y grows downward; forward is negative y on screen.
      this.state.moveY = -ny;
      this.state.boost = Math.hypot(nx, ny) > BOOST_THRESHOLD;
    };

    this.dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dialPointer = e.pointerId;
      this.dial.setPointerCapture(e.pointerId);
      this.dial.classList.add('active');
      update(e);
    });

    this.dial.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dialPointer) return;
      e.preventDefault();
      update(e);
    });

    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.dialPointer) return;
      this.dialPointer = null;
      this.dial.classList.remove('active');
      this.state.moveX = 0;
      this.state.moveY = 0;
      this.state.boost = false;
      this.knob.style.transform = 'translate(-50%, -50%)';
    };

    this.dial.addEventListener('pointerup', end);
    this.dial.addEventListener('pointercancel', end);
    this.dial.addEventListener('lostpointercapture', end);
  }

  private bindLook(): void {
    this.lookPad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.lookPointer = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      this.lookPad.setPointerCapture(e.pointerId);
      this.lookPad.classList.add('active');
    });

    this.lookPad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookPointer) return;
      e.preventDefault();
      // Accumulate rather than assign: several move events can arrive between
      // frames, and dropping all but the last would lose motion.
      this.state.lookDX += e.clientX - this.lookLast.x;
      this.state.lookDY += e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
    });

    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.lookPointer) return;
      this.lookPointer = null;
      this.lookPad.classList.remove('active');
    };

    this.lookPad.addEventListener('pointerup', end);
    this.lookPad.addEventListener('pointercancel', end);
    this.lookPad.addEventListener('lostpointercapture', end);
  }
}
