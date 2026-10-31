// Streams WAV clips into the running server in real time, exactly like the phone mic does,
// and reports what was heard, how it was translated, and the latency of each chunk.
//
//   node tools/run-clip.mjs --all                    every clip, one after another (a monologue)
//   node tools/run-clip.mjs test_clips/04-short-market.wav
//   node tools/run-clip.mjs --all --loops 3          ~1 minute monologue, checks delay doesn't pile up
//   node tools/run-clip.mjs --all --url wss://your-app.onrender.com/ws
//
// Latency = when the English audio would start playing (in-order playback, like the browser)
//           minus when the speaker finished saying that chunk.
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { playbackRate, shouldSkip } from '../client/src/playback-policy.js';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
const url = opt('--url', 'ws://localhost:3000/ws');
const loops = Number(opt('--loops', 1));
const gapMs = Number(opt('--gap', 800));
let files = args.filter((a, i) => !a.startsWith('--') && !['--url', '--loops', '--gap'].includes(args[i - 1]));
if (args.includes('--all') || !files.length) {
  files = (await fs.readdir('test_clips')).filter((f) => f.endsWith('.wav')).sort().map((f) => path.join('test_clips', f));
}

function readWav(buf) {
  let p = 12;
  let fmt;
  while (p < buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') {
      if (!fmt || fmt.rate !== 16000 || fmt.channels !== 1 || fmt.bits !== 16) throw new Error('WAV must be 16 kHz mono 16-bit');
      return buf.subarray(p + 8, p + 8 + size);
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const audio = [];
for (let l = 0; l < loops; l++) {
  for (const f of files) {
    audio.push(readWav(await fs.readFile(f)));
    audio.push(Buffer.alloc(Math.round((gapMs / 1000) * 16000) * 2)); // pause between sentences
  }
}
audio.push(Buffer.alloc(16000 * 2 * 2)); // 2 s of trailing silence
const pcm = Buffer.concat(audio);
const totalSec = pcm.length / 2 / 16000;

const segs = new Map();
const chunkTimes = []; // [startSample, wallMs] like the browser client
let sentSamples = 0;
const wallAt = (sec) => {
  const s = sec * 16000;
  let best = chunkTimes[0];
  for (const c of chunkTimes) if (c[0] <= s) best = c;
  return best[1] + ((s - best[0]) / 16000) * 1000;
};

const ws = new WebSocket(url);
ws.binaryType = 'nodebuffer';
let lastEvent = Date.now();
let streamingDone = false;

ws.on('message', (data, isBinary) => {
  lastEvent = Date.now();
  if (isBinary) {
    const seg = segs.get(data.readUInt32LE(0));
    if (!seg) return;
    seg.firstAudio ??= Date.now();
    seg.audioSec += (data.length - 4) / 2 / 24000;
    return;
  }
  const m = JSON.parse(data);
  if (m.type === 'ready') stream();
  if (m.type === 'segment') segs.set(m.seg, { hi: m.hi, reason: m.reason, speechWall: wallAt(m.speechEnd), en: '', audioSec: 0 });
  if (m.type === 'translation_done') segs.get(m.seg).en = m.en;
  if (m.type === 'metrics') Object.assign(segs.get(m.seg), { m });
  if (m.type === 'tts_done') segs.get(m.seg).done = true;
  if (m.type === 'error') console.log('server error:', m.message);
});
ws.on('error', (e) => {
  console.error('Cannot connect to', url, '-', e.message, '(is `npm start` running?)');
  process.exit(1);
});

function stream() {
  console.log(`Streaming ${files.length} clip(s) x${loops} = ${totalSec.toFixed(1)} s of audio to ${url}\n`);
  const t0 = Date.now();
  const step = 1600; // 100 ms
  const tick = () => {
    while (sentSamples * 1000 / 16000 <= Date.now() - t0 && sentSamples * 2 < pcm.length) {
      const chunk = pcm.subarray(sentSamples * 2, (sentSamples + step) * 2);
      chunkTimes.push([sentSamples, Date.now()]);
      ws.send(chunk);
      sentSamples += chunk.length / 2;
    }
    if (sentSamples * 2 >= pcm.length) {
      streamingDone = true;
      ws.send(JSON.stringify({ type: 'flush' }));
      return waitForEnd();
    }
    setTimeout(tick, 20);
  };
  tick();
}

function waitForEnd() {
  const all = [...segs.values()];
  if ((all.length && all.every((s) => s.done) && Date.now() - lastEvent > 1500) || Date.now() - lastEvent > 8000) return report();
  setTimeout(waitForEnd, 200);
}

function report() {
  ws.close();
  let playHead = 0;
  const rows = [];
  for (const [i, s] of [...segs.entries()].sort((a, b) => a[0] - b[0])) {
    if (!s.firstAudio) {
      rows.push({ i, s, lat: null });
      continue;
    }
    // Same catch-up rules as the browser player.
    let backlog = Math.max(0, playHead - s.firstAudio) / 1000;
    if (shouldSkip(backlog)) {
      playHead = s.firstAudio; // stale queue dropped
      s.skippedBefore = true;
      backlog = 0;
    }
    const rate = playbackRate(backlog);
    const start = Math.max(s.firstAudio, playHead);
    playHead = start + (s.audioSec / rate) * 1000;
    s.rate = rate;
    rows.push({ i, s, lat: (start - s.speechWall) / 1000 });
  }
  const pad = (x, n) => String(x).padEnd(n).slice(0, n);
  console.log(pad('#', 3), pad('why', 9), pad('e2e s', 6), pad('stt', 5), pad('llm', 5), pad('tts', 5), 'Hindi  ->  English');
  for (const { i, s, lat } of rows) {
    const m = s.m || {};
    console.log(
      pad(i, 3), pad(s.reason, 9), pad(lat == null ? '-' : lat.toFixed(2), 6),
      pad(m.sttMs ?? '-', 5), pad(m.translateMs ?? '-', 5), pad(m.ttsMs ?? '-', 5),
      `${s.rate > 1 ? `[x${s.rate}] ` : ''}${s.skippedBefore ? '[skip] ' : ''}${s.hi}  ->  ${s.en}`,
    );
  }
  const lats = rows.map((r) => r.lat).filter((x) => x != null);
  if (!lats.length) return console.log('\nNo audio came back.');
  const sorted = [...lats].sort((a, b) => a - b);
  const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
  const half = Math.floor(lats.length / 2);
  const firstHalf = lats.slice(0, half), secondHalf = lats.slice(half);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  console.log(
    `\nchunks ${lats.length} | avg ${avg.toFixed(2)} s | p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} s | max ${sorted.at(-1).toFixed(2)} s` +
      ` | first half ${mean(firstHalf).toFixed(2)} s vs second half ${mean(secondHalf).toFixed(2)} s`,
  );
  console.log('(stt/llm/tts = ms spent in each stage on the server; e2e = speaker stops -> English starts)');
  process.exit(0);
}
