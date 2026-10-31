// One live translation session = one client WebSocket.
//
// Client -> server
//   binary frames : 16 kHz mono PCM16LE microphone audio (send every ~100 ms)
//   {type:"flush"}: translate whatever has been heard so far (e.g. when the user taps Stop)
//
// Server -> client (JSON)
//   {type:"ready"}
//   {type:"transcript", text, isFinal}                 live Hindi captions
//   {type:"segment", seg, hi, speechEnd, reason}       a chunk was committed for translation
//   {type:"translation", seg, delta}                   streamed English text (delta=null: reset)
//   {type:"translation_done", seg, en, provider}
//   {type:"metrics", seg, sttMs, translateMs, ttsMs, serverMs}
//   {type:"tts_done", seg}                             no more audio for this segment
//   {type:"error", message}
// Server -> client (binary)
//   [uint32 LE seg][PCM16LE mono 24 kHz audio]
//
// speechEnd is in seconds of audio since the session started, so the client can map it to
// the moment the speaker actually stopped saying that chunk and measure mouth-to-ear latency.
import { Chunker } from './chunker.js';
import { DeepgramStream } from './stt.js';
import { translate, warmUp } from './translator.js';
import { CartesiaTTS } from './tts.js';

let sessionCounter = 0;

export function startSession(ws, cfg) {
  const sid = ++sessionCounter;
  const log = (...a) => console.log(`[s${sid}]`, ...a);
  const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
  const sendAudio = (seg, pcm) => {
    if (ws.readyState !== 1) return;
    const head = Buffer.alloc(4);
    head.writeUInt32LE(seg, 0);
    ws.send(Buffer.concat([head, pcm]));
  };

  let nextSeg = 0;
  let history = [];
  let chain = Promise.resolve(); // translations run in order so each sees the previous context
  let idleTimer = null;

  // When did the server receive each piece of audio? Used for the per-stage breakdown.
  const receipts = []; // [endSample, wallMs]
  let samplesIn = 0;
  const receivedAt = (sec) => {
    const s = sec * 16000;
    for (const [end, t] of receipts) if (end >= s) return t;
    return Date.now();
  };

  const stt = new DeepgramStream(cfg);
  const tts = new CartesiaTTS(cfg);
  const chunker = new Chunker(cfg, onCommit);
  tts.warmUp();
  warmUp(cfg);

  stt.on('results', (r) => {
    if (r.transcript) send({ type: 'transcript', text: r.transcript, isFinal: r.isFinal });
    chunker.onResult(r);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => chunker.flush('idle'), cfg.idleFlushMs);
  });
  stt.on('utteranceEnd', () => chunker.flush('utterance_end'));
  stt.on('error', (err) => {
    log(err.message);
    send({ type: 'error', message: err.message });
  });

  function onCommit(words, reason) {
    const seg = nextSeg++;
    const hi = words.map((w) => w.w).join(' ');
    const speechEnd = words[words.length - 1].end;
    const t = { heard: receivedAt(speechEnd), commit: Date.now() };
    send({ type: 'segment', seg, hi, speechEnd, reason });
    chain = chain.then(() => translateAndSpeak(seg, hi, t));
  }

  async function translateAndSpeak(seg, hi, t) {
    let en = '';
    let provider = '';
    try {
      const r = await translate({
        cfg,
        hi,
        history,
        onDelta: (delta) => {
          if (!t.firstToken) t.firstToken = Date.now();
          send({ type: 'translation', seg, delta });
        },
      });
      en = r.en;
      provider = r.provider;
    } catch (err) {
      log('translate failed:', err.message);
      send({ type: 'error', message: `Translation failed: ${err.message}` });
    }
    t.translated = Date.now();
    send({ type: 'translation_done', seg, en, provider });
    if (en) history = [...history, { hi, en }].slice(-cfg.historySize);
    log(`#${seg} "${hi}" -> "${en}" (${provider})`);

    if (!en) return send({ type: 'tts_done', seg });
    // Not awaited: the next chunk can start translating while this one is being spoken.
    tts.speak(en, {
      onFirstAudio: () => {
        const now = Date.now();
        send({
          type: 'metrics',
          seg,
          sttMs: t.commit - t.heard,
          translateMs: (t.firstToken ?? t.translated) - t.commit,
          ttsMs: now - t.translated,
          serverMs: now - t.heard,
        });
      },
      onAudio: (pcm) => sendAudio(seg, pcm),
      onDone: () => send({ type: 'tts_done', seg }),
    });
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      samplesIn += data.length / 2;
      receipts.push([samplesIn, Date.now()]);
      if (receipts.length > 1200) receipts.splice(0, 200); // ~2 min of history
      return stt.send(data);
    }
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.type === 'flush') chunker.flush('stop');
  });

  ws.on('close', () => {
    clearTimeout(idleTimer);
    stt.close();
    tts.close();
    log('closed');
  });

  log('started');
  send({ type: 'ready', sampleRate: 16000, ttsSampleRate: cfg.ttsSampleRate });
}
