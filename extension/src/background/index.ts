import { AudioCapture } from './audio-capture';
import { WsClient } from './ws-client';
import type { ServerMessage, StreamConfig } from '../lib/types';

const DEFAULT_CONFIG: StreamConfig = {
  chunkSec: 10,
  model: 'base',
};

let wsClient: WsClient;
let audioCapture: AudioCapture;
let currentConfig: StreamConfig = { ...DEFAULT_CONFIG };
let activeTabId: number | null = null;

function sendToContent(tabId: number, msg: unknown): void {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function onServerMessage(msg: ServerMessage): void {
  if (!activeTabId) return;

  switch (msg.type) {
    case 'transcript':
      sendToContent(activeTabId, {
        type: 'subtitles',
        chunkIdx: msg.chunkIdx,
        chunkStartMs: msg.chunkStartMs,
        cues: msg.cues,
      });
      break;
    case 'status':
      sendToContent(activeTabId, { type: 'status', state: msg.state });
      break;
    case 'error':
      sendToContent(activeTabId, { type: 'status', state: 'error' });
      console.error('[Subcast Live] Server error:', msg.code, msg.msg);
      break;
  }
}

function onStatusChange(status: string): void {
  console.log('[Subcast Live] WS status:', status);
}

function startCapture(tabId: number): void {
  if (audioCapture?.active) {
    audioCapture.stop();
  }

  activeTabId = tabId;
  wsClient = new WsClient(onServerMessage, onStatusChange);
  audioCapture = new AudioCapture((pcm) => {
    wsClient.sendAudio(pcm);
  });

  wsClient.connect();
  setTimeout(() => {
    wsClient.sendStart(currentConfig);
    audioCapture.start(tabId).catch((err) => {
      console.error('[Subcast Live] Audio capture failed:', err);
    });
  }, 500);
}

function stopCapture(): void {
  audioCapture?.stop();
  wsClient?.sendStop();
  wsClient?.disconnect();
  if (activeTabId) {
    sendToContent(activeTabId, { type: 'stop' });
  }
  activeTabId = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (tabId) {
      startCapture(tabId);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'No tab ID' });
    }
    return true;
  }
  if (msg.type === 'stop') {
    stopCapture();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'status') {
    sendResponse({
      active: audioCapture?.active ?? false,
      wsStatus: wsClient?.status ?? 'disconnected',
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    stopCapture();
  }
});
