import type { CameraMode } from './CameraModes';

/**
 * On-screen mode switcher. The keyboard shortcuts are unreachable on a phone,
 * so the three modes need buttons.
 *
 * Orbit is presented last and labelled as the overview: it exists for
 * inspecting the whole terrain rather than for moving through it.
 */
export class ModeButtons {
  readonly root: HTMLDivElement;

  private readonly buttons = new Map<CameraMode, HTMLButtonElement>();

  constructor(onSelect: (mode: CameraMode) => void) {
    this.root = document.createElement('div');
    this.root.id = 'mode-buttons';

    const modes: Array<[CameraMode, string, string]> = [
      ['walk', 'Walk', 'G'],
      ['fly', 'Fly', 'F'],
      ['orbit', 'Overview', 'O'],
    ];

    for (const [mode, label, key] of modes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tc-btn mode-btn';
      button.dataset.mode = mode;
      button.innerHTML = `${label}<kbd>${key}</kbd>`;

      // pointerdown rather than click: on touch, click waits for the browser
      // to rule out a double-tap, which reads as lag on a mode switch.
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onSelect(mode);
      });

      this.buttons.set(mode, button);
      this.root.appendChild(button);
    }
  }

  /** Marks the active mode. */
  setActive(mode: CameraMode): void {
    for (const [key, button] of this.buttons) {
      button.classList.toggle('active', key === mode);
    }
  }
}
