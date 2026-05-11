const WS_URL = 'ws://localhost:3000/stream';
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

export type WsStatus = 'disconnected' | 'connecting' | 'connected';
export type OnMessage = (msg: any) => void;
export type OnStatusChange = (status: WsStatus) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private onMessage: OnMessage;
  private onStatusChange: OnStatusChange;
  private reconnectCount = 0;

  constructor(onMessage: OnMessage, onStatusChange: OnStatusChange) {
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  get status(): WsStatus {
    if (!this.ws) return 'disconnected';
    if (this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
    if (this.ws.readyState === WebSocket.OPEN) return 'connected';
    return 'disconnected';
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }
    this.onStatusChange('connecting');
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      this.reconnectCount = 0;
      this.onStatusChange('connected');
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.onMessage(msg);
      } catch {
        // ignore non-JSON messages
      }
    });

    ws.addEventListener('close', () => {
      this.onStatusChange('disconnected');
      this.tryReconnect();
    });

    ws.addEventListener('error', () => {
      this.onStatusChange('disconnected');
    });

    this.ws = ws;
  }

  disconnect(): void {
    this.reconnectCount = RECONNECT_ATTEMPTS;
    this.ws?.close();
    this.ws = null;
    this.onStatusChange('disconnected');
  }

  sendStart(config: { chunkSec: number; model: string }): void {
    this.sendJson({ type: 'start', chunkSec: config.chunkSec, model: config.model });
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  sendStop(): void {
    this.sendJson({ type: 'stop' });
  }

  sendConfig(config: Partial<{ chunkSec: number; model: string }>): void {
    this.sendJson({ type: 'config', ...config });
  }

  private sendJson(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private tryReconnect(): void {
    if (this.reconnectCount >= RECONNECT_ATTEMPTS) return;
    this.reconnectCount++;
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}
