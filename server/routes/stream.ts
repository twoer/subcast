// server/routes/stream.ts
// WebSocket endpoint for live audio transcription.
// Nitro auto-registers files in server/routes/ as WebSocket handlers when
// experimental.websocket is enabled in nuxt.config.ts.
//
// Protocol:
//   Client -> Server (binary frames) : raw PCM audio (16kHz mono s16le)
//   Client -> Server (text frames)   : JSON control messages (start/config/stop)
//   Server -> Client                 : JSON messages (status/transcript/error)

import { StreamPipeline, DEFAULT_STREAM_CONFIG, type StreamConfig } from '../utils/stream-pipeline';
import { logEvent } from '../utils/log';

/** Track the single active pipeline so we reject concurrent connections. */
let activePipeline: { pipeline: StreamPipeline; close: () => void } | null = null;

export default defineWebSocketHandler({
  open(peer) {
    logEvent({ level: 'info', event: 'ws_stream_open', peerId: peer.id });

    // Only one live stream at a time
    if (activePipeline) {
      peer.send(JSON.stringify({ type: 'error', code: 'BUSY', msg: 'Another stream is active' }));
      peer.close(1000, 'BUSY');
      return;
    }

    const config: StreamConfig = { ...DEFAULT_STREAM_CONFIG };

    // Helper to safely send JSON to the client
    const send = (data: Record<string, unknown>) => {
      try {
        peer.send(JSON.stringify(data));
      } catch {
        // Peer may have already closed -- swallow the error
      }
    };

    const pipeline = new StreamPipeline(config, send);
    activePipeline = {
      pipeline,
      close: () => {
        pipeline.abort();
        activePipeline = null;
      },
    };

    peer.send(JSON.stringify({ type: 'status', state: 'idle', config }));

    // Store references on peer context for use in message/close hooks
    peer.context.pipeline = pipeline;
    peer.context.config = config;
  },

  message(peer, message) {
    const pipeline = peer.context.pipeline as StreamPipeline | undefined;
    const config = peer.context.config as StreamConfig | undefined;
    if (!pipeline || !config) return;

    // Binary frame = PCM audio data
    if (message.rawData instanceof ArrayBuffer || message.rawData instanceof SharedArrayBuffer) {
      const buf = Buffer.from(message.arrayBuffer());
      pipeline.appendAudio(buf);
      return;
    }

    // Text frame = JSON control message
    try {
      const msg = message.json<Record<string, unknown>>();

      if (msg.type === 'start' || msg.type === 'config') {
        if (typeof msg.chunkSec === 'number' && msg.chunkSec >= 3 && msg.chunkSec <= 60) {
          config.chunkSec = msg.chunkSec;
        }
        if (typeof msg.model === 'string') {
          config.model = msg.model;
        }
        peer.send(JSON.stringify({ type: 'status', state: 'idle', config }));
      }

      if (msg.type === 'stop') {
        pipeline.flush();
      }
    } catch {
      // Ignore malformed messages
    }
  },

  close(peer, _details) {
    logEvent({ level: 'info', event: 'ws_stream_close', peerId: peer.id });
    if (activePipeline) {
      activePipeline.pipeline.flush();
      activePipeline.close();
    }
  },

  error(peer, error) {
    logEvent({ level: 'error', event: 'ws_stream_error', peerId: peer.id, error: String(error) });
    if (activePipeline) {
      activePipeline.close();
    }
  },
});
