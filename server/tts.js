// Cartesia streaming text-to-speech over one shared WebSocket per session.
// Each translated chunk gets its own context; audio comes back as raw PCM16LE at 24 kHz
// in small pieces, so playback can start before the whole sentence is synthesized.
import WebSocket from 'ws';

export class CartesiaTTS {
  constructor(cfg) {
    this.cfg = cfg;
    this.contexts = new Map(); // context_id -> handlers
    this.ws = null;
    this.ready = null;
    this.closed = false;
    this.counter = 0;
  }

  /** Connect now so the first sentence doesn't wait for the handshake. */
  warmUp() {
    this.#open().catch(() => {});
  }

  #open() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://api.cartesia.ai/tts/websocket', {
        headers: { 'X-API-Key': this.cfg.cartesiaKey, 'Cartesia-Version': this.cfg.cartesiaVersion },
      });
      this.ws = ws;
      ws.on('open', () => {
        this.ready = null;
        resolve();
      });
      ws.on('message', (data) => this.#onMessage(data));
      ws.on('error', (err) => {
        this.ready = null;
        reject(err);
      });
      ws.on('close', () => {
        this.ready = null;
        // Finish anything in flight so the client's playback queue never stalls.
        for (const [id, h] of this.contexts) this.#finish(id, h, new Error('Cartesia connection closed'));
      });
    });
    return this.ready;
  }

  #onMessage(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const h = this.contexts.get(m.context_id);
    if (!h) return;
    if (m.type === 'chunk' && m.data) {
      let pcm = Buffer.from(m.data, 'base64');
      if (h.carry) {
        pcm = Buffer.concat([h.carry, pcm]);
        h.carry = null;
      }
      if (pcm.length % 2) {
        h.carry = pcm.subarray(pcm.length - 1);
        pcm = pcm.subarray(0, pcm.length - 1);
      }
      if (pcm.length) {
        if (!h.gotAudio) {
          h.gotAudio = true;
          h.onFirstAudio?.();
        }
        h.onAudio(pcm);
      }
    }
    if (m.type === 'error') return this.#finish(m.context_id, h, new Error(`Cartesia: ${m.error || m.title || 'error'}`));
    if (m.type === 'done' || m.done) this.#finish(m.context_id, h);
  }

  #finish(id, h, err) {
    if (!this.contexts.has(id)) return;
    this.contexts.delete(id);
    clearTimeout(h.timer);
    if (err) console.warn(`[tts] ${err.message}`);
    h.onDone(err);
  }

  /**
   * Speak `text`. Calls onFirstAudio once, onAudio(pcm Buffer) per piece, onDone(err?) exactly once.
   */
  async speak(text, { onFirstAudio, onAudio, onDone }) {
    const id = `c${Date.now().toString(36)}-${this.counter++}`;
    const h = { onFirstAudio, onAudio, onDone, gotAudio: false, carry: null };
    this.contexts.set(id, h);
    h.timer = setTimeout(() => this.#finish(id, h, new Error('Cartesia timeout')), 15000);
    try {
      await this.#open();
      this.ws.send(
        JSON.stringify({
          model_id: this.cfg.ttsModel,
          transcript: text,
          voice: { mode: 'id', id: this.cfg.ttsVoice },
          language: 'en',
          context_id: id,
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: this.cfg.ttsSampleRate },
          continue: false,
        }),
      );
    } catch (err) {
      this.#finish(id, h, err);
    }
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }
}
