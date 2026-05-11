/** Messages sent from extension → server over WebSocket */
export type ClientMessage =
  | { type: 'start'; chunkSec: number; model: string }
  | { type: 'audio'; data: ArrayBuffer }
  | { type: 'stop' }
  | { type: 'config'; chunkSec?: number; model?: string };

/** Messages sent from server → extension over WebSocket */
export type ServerMessage =
  | { type: 'status'; state: 'idle' | 'processing' | 'error'; config?: StreamConfig; chunkIdx?: number }
  | { type: 'transcript'; chunkIdx: number; chunkStartMs: number; cues: StreamCue[] }
  | { type: 'error'; code: string; msg: string };

export interface StreamCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface StreamConfig {
  chunkSec: number;
  model: string;
}

/** Messages from background → content script (via chrome.tabs.sendMessage) */
export type BackgroundToContentMessage =
  | { type: 'subtitles'; chunkIdx: number; chunkStartMs: number; cues: StreamCue[] }
  | { type: 'status'; state: string }
  | { type: 'start' }
  | { type: 'stop' };

/** Messages from content script → background */
export type ContentToBackgroundMessage =
  | { type: 'video-paused' }
  | { type: 'video-playing' };
