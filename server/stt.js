// Deepgram live speech-to-text over WebSocket.
// Input: 16 kHz mono 16-bit PCM. Output events:
//   'results'      { isFinal, speechFinal, transcript, words: [{ w, end }] }  (end = seconds since session start)
//   'utteranceEnd' {}
//   'error'        Error
// Reconnects by itself if Deepgram drops, keeping word timestamps on one continuous timeline.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const SAMPLE_RATE = 16000;
const MAX_BUFFERED_BYTES = SAMPLE_RATE * 2 * 5; // keep up to 5 s while reconnecting

export class DeepgramStream extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.closed = false;
    this.samplesSent = 0; // total samples sent across all connections
    this.offsetSec = 0; // timeline offset of the current connection
    this.pending = [];
    this.pendingBytes = 0;
    this.retries = 0;
    this.#connect();
    this.keepAlive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 5000);
  }

  #connect() {
    const c = this.cfg;
    const params = new URLSearchParams({
      model: c.sttModel,
      language: c.sttLanguage,
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      endpointing: String(c.endpointingMs),
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    this.offsetSec = this.samplesSent / SAMPLE_RATE;
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${c.deepgramKey}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.retries = 0;
      for (const buf of this.pending) this.#sendNow(buf);
      this.pending = [];
      this.pendingBytes = 0;
    });

    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m.type === 'Results') {
        const alt = m.channel?.alternatives?.[0];
        if (!alt) return;
        const words = (alt.words || []).map((x) => ({
          w: x.punctuated_word || x.word,
          end: this.offsetSec + x.end,
        }));
        this.emit('results', {
          isFinal: !!m.is_final,
          speechFinal: !!m.speech_final,
          transcript: alt.transcript || '',
          words,
        });
      } else if (m.type === 'UtteranceEnd') {
        this.emit('utteranceEnd', {});
      } else if (m.type === 'Error' || m.err_code) {
        this.emit('error', new Error(`Deepgram: ${m.description || m.err_msg || JSON.stringify(m)}`));
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => this.emit('error', new Error(`Deepgram HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
    });
    ws.on('error', () => {}); // 'close' follows and handles reconnect
    ws.on('close', () => {
      if (this.closed) return;
      if (this.retries++ > 5) return this.emit('error', new Error('Deepgram connection lost'));
      setTimeout(() => !this.closed && this.#connect(), Math.min(250 * 2 ** this.retries, 3000));
    });
  }

  #sendNow(buf) {
    this.ws.send(buf);
    this.samplesSent += buf.length / 2;
  }

  /** @param {Buffer} buf 16 kHz PCM16LE mono */
  send(buf) {
    if (this.closed) return;
    if (this.ws.readyState === WebSocket.OPEN) return this.#sendNow(buf);
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    while (this.pendingBytes > MAX_BUFFERED_BYTES) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped.length;
      this.samplesSent += dropped.length / 2; // keep the timeline aligned with the client
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.keepAlive);
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      this.ws.close();
    } catch {}
  }
}
