import './style.css';
import { playbackRate, shouldSkip } from './playback-policy.js';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'),
  start: $('start'),
  lastLat: $('lastLat'),
  avgLat: $('avgLat'),
  count: $('count'),
  breakdown: $('breakdown'),
  final: document.querySelector('#hindi .final'),
  interim: document.querySelector('#hindi .interim'),
  level: $('level'),
  segments: $('segments'),
  modeHint: $('modeHint'),
};

let ctx = null; // one AudioContext for mic capture and playback
let micStream = null;
let micSource = null;
let ws = null;
let running = false;
let ready = false;
let retries = 0;
let reconnectTimer = null;
let closeTimer = null;
let wakeLock = null;
let mode = 'earbuds';

// Mic timeline: which wall-clock moment each sent sample was captured at.
let sampleCount = 0;
let chunkTimes = []; // [firstSample, performance.now() of that sample]

// Playback: segments play strictly in order, each as soon as its first audio arrives.
let segs = new Map();
let nextSeg = 0;
let playHead = 0; // AudioContext time when queued audio ends
let sources = [];

const lats = [];
let finalText = '';

// ---------- status ----------
function setStatus(text, cls) {
  ui.status.textContent = text;
  ui.status.className = `pill ${cls}`;
}

function setStartButton(isRunning) {
  ui.start.classList.toggle('stop', isRunning);
  ui.start.innerHTML = isRunning
    ? '<span class="button-icon">■</span><span>Stop translating</span><span class="button-arrow">→</span>'
    : '<span>Start translating</span><span class="button-arrow">→</span>';
}

// ---------- start / stop ----------
ui.start.addEventListener('click', () => (running ? stop() : start()));
document.querySelectorAll('input[name=mode]').forEach((r) =>
  r.addEventListener('change', () => {
    mode = r.value;
    ui.modeHint.textContent =
      mode === 'earbuds' ? 'Earbuds: mic stays on the whole time.' : 'Speaker: mic is muted while English is playing, so it doesn’t translate itself.';
  }),
);

async function start() {
  try {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
    }
    await ctx.resume(); // must happen inside the tap for iOS
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    console.error(err);
    setStatus('Mic blocked', 'err');
    alert('Microphone access is needed. On a phone, open this page over https and allow the mic.');
    return;
  }
  micSource = ctx.createMediaStreamSource(micStream);
  const worklet = new AudioWorkletNode(ctx, 'pcm-capture');
  const silent = ctx.createGain();
  silent.gain.value = 0;
  micSource.connect(worklet);
  worklet.connect(silent).connect(ctx.destination); // keeps the worklet running on all browsers
  worklet.port.onmessage = (e) => onMic(new Int16Array(e.data));
  micSource.worklet = worklet;

  running = true;
  setStartButton(true);
  clearTimeout(closeTimer);
  if (!ws || ws.readyState > 1) connect();
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}

function stop() {
  running = false;
  setStartButton(false);
  micStream?.getTracks().forEach((t) => t.stop());
  micSource?.disconnect();
  micSource?.worklet?.disconnect();
  wakeLock?.release?.().catch(() => {});
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'flush' }));
  setStatus('Finishing…', 'warn');
  // Keep the connection open briefly so the last sentence still gets spoken.
  closeTimer = setTimeout(() => {
    if (!running) ws?.close();
  }, 5000);
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running) {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {}
  }
});

// ---------- connection (auto-reconnect) ----------
function connect() {
  clearTimeout(reconnectTimer);
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ready = false;
  setStatus(retries ? 'Reconnecting…' : 'Connecting…', 'warn');
  const sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onmessage = onMessage;
  sock.onclose = () => {
    if (ws !== sock) return;
    ready = false;
    if (running) {
      const delay = Math.min(400 * 2 ** retries++, 5000);
      setStatus('Reconnecting…', 'warn');
      reconnectTimer = setTimeout(connect, delay);
    } else setStatus('Idle', 'idle');
  };
}
window.addEventListener('online', () => running && ws?.readyState > 1 && connect());

// ---------- mic -> server ----------
function onMic(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 8) sum += (pcm[i] / 32768) ** 2;
  ui.level.style.width = `${Math.min(100, Math.sqrt(sum / (pcm.length / 8)) * 400)}%`;

  if (!ready || ws.readyState !== 1) return;
  if (mode === 'speaker' && isPlaying()) pcm.fill(0); // don't let the mic hear the translation
  chunkTimes.push([sampleCount, performance.now() - pcm.length / 16]);
  if (chunkTimes.length > 3000) chunkTimes.splice(0, 600);
  sampleCount += pcm.length;
  ws.send(pcm.buffer);
}

// Wall-clock time at which the speaker said audio second `sec` of this session.
function wallAt(sec) {
  const s = sec * 16000;
  let lo = 0;
  let hi = chunkTimes.length - 1;
  if (hi < 0) return performance.now();
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunkTimes[mid][0] <= s) lo = mid;
    else hi = mid - 1;
  }
  const [first, t] = chunkTimes[lo];
  return t + (s - first) / 16;
}

// ---------- server -> page ----------
function onMessage(e) {
  if (e.data instanceof ArrayBuffer) return onAudio(e.data);
  const m = JSON.parse(e.data);
  const s = segs.get(m.seg);
  switch (m.type) {
    case 'ready':
      ready = true;
      retries = 0;
      sampleCount = 0;
      chunkTimes = [];
      segs = new Map();
      nextSeg = 0;
      setStatus(running ? 'Live' : 'Idle', running ? 'live' : 'idle');
      break;
    case 'transcript':
      if (m.isFinal) {
        finalText = `${finalText} ${m.text}`.slice(-180);
        ui.interim.textContent = '';
      } else ui.interim.textContent = ` ${m.text}`;
      ui.final.textContent = finalText;
      break;
    case 'segment':
      addSegment(m);
      break;
    case 'translation':
      if (!s) break;
      s.en = m.delta === null ? '' : s.en + m.delta;
      renderSeg(s);
      break;
    case 'translation_done':
      if (!s) break;
      s.en = m.en;
      renderSeg(s);
      break;
    case 'metrics':
      if (!s) break;
      s.metrics = m;
      ui.breakdown.textContent = `STT ${m.sttMs} ms · Translate ${m.translateMs} ms · Voice ${m.ttsMs} ms`;
      renderSeg(s);
      break;
    case 'tts_done':
      if (!s) break;
      s.done = true;
      pump();
      break;
    case 'error':
      console.warn('server:', m.message);
      break;
  }
}

function addSegment(m) {
  ui.segments.querySelector('.placeholder')?.remove();
  const li = document.createElement('li');
  li.innerHTML = '<div class="seg-en"></div><div class="seg-hi"></div><div class="seg-meta"></div>';
  ui.segments.prepend(li);
  while (ui.segments.children.length > 60) ui.segments.lastChild.remove();
  const s = { seg: m.seg, hi: m.hi, en: '', speechWall: wallAt(m.speechEnd), chunks: [], scheduled: 0, done: false, el: li };
  segs.set(m.seg, s);
  renderSeg(s);
}

function renderSeg(s) {
  s.el.querySelector('.seg-hi').textContent = s.hi;
  s.el.querySelector('.seg-en').textContent = s.en || '…';
  const parts = [];
  if (s.latency != null) parts.push(`<b class="${grade(s.latency)}">${s.latency.toFixed(2)} s</b>`);
  if (s.metrics) parts.push(`STT ${s.metrics.sttMs} · LLM ${s.metrics.translateMs} · TTS ${s.metrics.ttsMs} ms`);
  if (s.rate > 1) parts.push(`${s.rate}× catch-up`);
  if (s.skipped) parts.push('skipped to catch up');
  s.el.querySelector('.seg-meta').innerHTML = parts.join(' · ');
  s.el.classList.toggle('skipped', !!s.skipped);
}

const grade = (sec) => (sec < 1.5 ? 'good' : sec < 3 ? 'ok' : 'bad');

// ---------- playback ----------
function onAudio(buf) {
  const seg = new DataView(buf).getUint32(0, true);
  const s = segs.get(seg);
  if (!s || s.skipped) return;
  const pcm = new Int16Array(buf, 4);
  const audio = ctx.createBuffer(1, pcm.length, 24000);
  const ch = audio.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  s.chunks.push(audio);
  pump();
}

function pump() {
  for (;;) {
    const s = segs.get(nextSeg);
    if (!s) return;
    while (s.scheduled < s.chunks.length) schedule(s, s.chunks[s.scheduled++]);
    if (!s.done) return;
    s.chunks = [];
    nextSeg++;
  }
}

function schedule(s, audio) {
  if (s.skipped) return;
  const now = ctx.currentTime;
  let backlog = Math.max(0, playHead - now);
  if (!s.started && shouldSkip(backlog)) {
    skipQueued();
    backlog = Math.max(0, playHead - now);
  }
  if (!s.started) s.rate = playbackRate(backlog);
  const startAt = Math.max(playHead, now + 0.04);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.playbackRate.value = s.rate;
  src.connect(ctx.destination);
  src.start(startAt);
  playHead = startAt + audio.duration / s.rate;
  const entry = { src, start: startAt, end: playHead, seg: s };
  sources.push(entry);
  src.onended = () => (sources = sources.filter((x) => x !== entry));

  if (!s.started) {
    s.started = true;
    const playWall = performance.now() + (startAt - now) * 1000;
    s.latency = (playWall - s.speechWall) / 1000;
    lats.push(s.latency);
    ui.lastLat.textContent = s.latency.toFixed(2);
    ui.lastLat.className = `value ${grade(s.latency)}`;
    const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
    ui.avgLat.textContent = avg.toFixed(2);
    ui.avgLat.className = `value ${grade(avg)}`;
    ui.count.textContent = lats.length;
    renderSeg(s);
  }
}

// The speaker kept talking and English fell far behind: drop audio that hasn't started yet.
function skipQueued() {
  const now = ctx.currentTime;
  for (const x of sources) {
    if (x.start > now + 0.01) {
      x.src.onended = null;
      try {
        x.src.stop();
      } catch {}
      if (!x.seg.skipped) {
        x.seg.skipped = true;
        renderSeg(x.seg);
      }
    }
  }
  sources = sources.filter((x) => x.start <= now + 0.01);
  playHead = Math.max(now, ...sources.map((x) => x.end));
}

// ---------- sample clips (no mic needed) ----------
// Streams the recorded Hindi test clips through the exact same path as the microphone.
$('demo').addEventListener('click', async () => {
  if (running) return;
  const btn = $('demo');
  btn.disabled = true;
  btn.textContent = 'Loading clips…';
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
  }
  await ctx.resume();
  const list = await (await fetch('/test_clips/clips.json')).json();
  const parts = [];
  for (const c of list) {
    const wav = await (await fetch(`/test_clips/${c.id}.wav`)).arrayBuffer();
    parts.push(wavData(wav), new Int16Array(12800)); // 0.8 s pause between sentences
  }
  parts.push(new Int16Array(32000));
  const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) pcm.set(p, o), (o += p.length);

  running = true;
  setStartButton(true);
  btn.textContent = 'Playing sample clips…';
  if (!ws || ws.readyState > 1) connect();
  let pos = 0;
  const timer = setInterval(() => {
    if (!running || pos >= pcm.length) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = 'No Hindi speaker nearby? Play sample clips instead';
      if (running) stop();
      return;
    }
    if (!ready) return; // wait for the connection; the clip timeline waits too
    onMic(pcm.slice(pos, pos + 1600));
    pos += 1600;
  }, 100);
});

function wavData(buf) {
  const v = new DataView(buf);
  let p = 12;
  while (p < buf.byteLength) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    const size = v.getUint32(p + 4, true);
    if (id === 'data') return new Int16Array(buf.slice(p + 8, p + 8 + size));
    p += 8 + size + (size % 2);
  }
  return new Int16Array(0);
}

function isPlaying() {
  return ctx && playHead + 0.25 > ctx.currentTime;
}
