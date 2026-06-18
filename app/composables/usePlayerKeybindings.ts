/* SPDX-License-Identifier: Apache-2.0 */
import { onMounted, onBeforeUnmount, type Ref } from 'vue';

export interface PlayerKeybindingsOptions {
  /** Move focus to the search input (handler for `/` and Cmd/Ctrl+F). */
  focusSearch: () => void;
  /** Help dialog open state — escape closes it while open. */
  showHelp: Ref<boolean>;
  /** Settings dialog open state — escape closes it while open. */
  showSettings: Ref<boolean>;
  togglePlay: () => void;
  seekBy: (deltaSeconds: number) => void;
  bumpVolume: (delta: number) => void;
  bumpSpeed: (delta: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  toggleSubs: () => void;
  /** Jump to a percentage of duration (1-9 → 10-90%). */
  jumpPercent: (pct: number) => void;
}

function shouldIgnore(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.getAttribute('role') === 'button' || tag === 'BUTTON' || tag === 'A') return true;
  return false;
}

/**
 * Player keyboard shortcuts. Mirrors YouTube/VLC conventions:
 *   space/k = play/pause, ←/→ = ±5s, j/l = ±10s, ↑/↓ = ±10% volume,
 *   m = mute, f = fullscreen, c = subs, <>/, . = speed, 1-9 = seek %, ? = help.
 *   / and Cmd/Ctrl+F focus the search bar.
 */
export function usePlayerKeybindings(opts: PlayerKeybindingsOptions): void {
  function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

    if (!inInput && e.key === '/') {
      e.preventDefault();
      opts.focusSearch();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      opts.focusSearch();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (shouldIgnore(e)) return;

    if (opts.showHelp.value || opts.showSettings.value) {
      if (e.key === 'Escape') {
        e.preventDefault();
        opts.showHelp.value = false;
        opts.showSettings.value = false;
      }
      return;
    }

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        opts.togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        opts.seekBy(-5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        opts.seekBy(5);
        break;
      case 'j':
      case 'J':
        e.preventDefault();
        opts.seekBy(-10);
        break;
      case 'l':
      case 'L':
        e.preventDefault();
        opts.seekBy(10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        opts.bumpVolume(0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        opts.bumpVolume(-0.1);
        break;
      case '<':
      case ',':
        e.preventDefault();
        opts.bumpSpeed(-1);
        break;
      case '>':
      case '.':
        e.preventDefault();
        opts.bumpSpeed(1);
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        opts.toggleMute();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        opts.toggleFullscreen();
        break;
      case 'c':
      case 'C':
        e.preventDefault();
        opts.toggleSubs();
        break;
      case '?':
        e.preventDefault();
        opts.showHelp.value = true;
        break;
      default:
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault();
          opts.jumpPercent(parseInt(e.key, 10) * 10);
        }
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown));
}
