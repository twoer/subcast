const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

export type OnAudioChunk = (pcm: ArrayBuffer) => void;

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onChunk: OnAudioChunk;
  private _active = false;

  constructor(onChunk: OnAudioChunk) {
    this.onChunk = onChunk;
  }

  get active(): boolean {
    return this._active;
  }

  start(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
        if (!stream) {
          reject(new Error('tabCapture failed — no stream returned'));
          return;
        }

        this.stream = stream;
        this.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        const source = this.audioContext.createMediaStreamSource(stream);

        this.processor = this.audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
        this.processor.onaudioprocess = (event) => {
          if (!this._active) return;
          const float32 = event.inputBuffer.getChannelData(0);
          const s16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]!));
            s16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.onChunk(s16.buffer);
        };

        source.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
        this._active = true;
        resolve();
      });
    });
  }

  stop(): void {
    this._active = false;
    this.processor?.disconnect();
    this.processor = null;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}
