import type { BackgroundToContentMessage, StreamCue } from '../lib/types';
import './subtitle.css';

const CUE_DISPLAY_DURATION_MS = 5000;
const MAX_VISIBLE_CUES = 3;

interface TimedCue extends StreamCue {
  absoluteStartMs: number;
  absoluteEndMs: number;
  chunkStartMs: number;
}

let overlayEl: HTMLDivElement | null = null;
let cueEls: HTMLSpanElement[] = [];
let activeCues: TimedCue[] = [];
let videoEl: HTMLVideoElement | null = null;

function createOverlay(video: HTMLVideoElement): HTMLDivElement {
  const parent = video.parentElement;
  if (!parent) {
    const overlay = document.createElement('div');
    overlay.className = 'subcast-live-overlay';
    overlay.style.position = 'fixed';
    document.body.appendChild(overlay);
    return overlay;
  }

  const parentPos = getComputedStyle(parent).position;
  if (parentPos === 'static') {
    parent.style.position = 'relative';
  }

  const overlay = document.createElement('div');
  overlay.className = 'subcast-live-overlay';
  parent.appendChild(overlay);

  const observer = new ResizeObserver(() => {
    const rect = video.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    overlay.style.width = `${rect.width}px`;
    overlay.style.left = `${rect.left - parentRect.left}px`;
    overlay.style.top = `${rect.top - parentRect.top + rect.height * 0.85}px`;
  });
  observer.observe(video);

  return overlay;
}

function getOrCreateOverlay(): HTMLDivElement | null {
  if (overlayEl) return overlayEl;
  videoEl = document.querySelector('video');
  if (!videoEl) return null;
  overlayEl = createOverlay(videoEl);
  return overlayEl;
}

function showCues(cues: TimedCue[]): void {
  const overlay = getOrCreateOverlay();
  if (!overlay) return;

  cueEls.forEach((el) => el.remove());
  cueEls = [];

  const visible = cues.slice(-MAX_VISIBLE_CUES);
  for (const cue of visible) {
    const span = document.createElement('span');
    span.className = 'subcast-live-cue';
    span.textContent = cue.text;
    overlay.appendChild(span);
    cueEls.push(span);
  }
}

function clearCues(): void {
  cueEls.forEach((el) => el.remove());
  cueEls = [];
  activeCues = [];
}

function addSubtitles(chunkStartMs: number, cues: StreamCue[]): void {
  const now = Date.now();
  const timedCues: TimedCue[] = cues.map((cue) => ({
    ...cue,
    absoluteStartMs: now + cue.startMs,
    absoluteEndMs: now + cue.endMs,
    chunkStartMs,
  }));

  activeCues.push(...timedCues);
  showCues(activeCues);

  for (const cue of timedCues) {
    const displayMs = Math.max(cue.endMs - cue.startMs, CUE_DISPLAY_DURATION_MS);
    setTimeout(() => {
      activeCues = activeCues.filter((c) => c !== cue);
      showCues(activeCues);
    }, displayMs);
  }
}

chrome.runtime.onMessage.addListener(
  (msg: BackgroundToContentMessage, _sender, sendResponse) => {
    switch (msg.type) {
      case 'subtitles':
        addSubtitles(msg.chunkStartMs, msg.cues);
        break;
      case 'stop':
        clearCues();
        if (overlayEl) {
          overlayEl.remove();
          overlayEl = null;
        }
        break;
      case 'start':
        break;
    }
    sendResponse({ ok: true });
    return true;
  },
);

const mutationObserver = new MutationObserver(() => {
  if (videoEl && !document.contains(videoEl)) {
    clearCues();
    overlayEl?.remove();
    overlayEl = null;
    videoEl = null;
  }
});
mutationObserver.observe(document.body, { childList: true, subtree: true });
