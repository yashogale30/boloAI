# Anuvaad: speak Hindi, hear English

A live Hindi → English voice interpreter. You speak Hindi (or Hinglish) into your phone, and a natural English voice speaks the translation in your earbuds **about 1–2 seconds after you finish each phrase**, while you keep talking.

It is exposed as a **streaming WebSocket API** with a mobile-friendly web client and a live latency counter.

Built for the [Bolna Buildathon](https://www.bolna.ai/symphony/buildathon) (Symphony 2026).

## How it works

```
 phone mic ──16 kHz PCM, every 100 ms──▶ server ──▶ Deepgram Nova-3 (Hindi, streaming)
                                           │            │ partial + final words with timestamps
                                           │            ▼
                                           │        Chunker (Hindi clause rules)
                                           │            │ "कल की meeting cancel हो गई"
                                           │            ▼
                                           │        Groq · Qwen3 (streaming, previous chunks as context)
                                           │            │ "Yesterday's meeting got cancelled"
                                           │            ▼
                                           │        Cartesia Sonic (streaming TTS, 24 kHz PCM)
 earbuds ◀──in-order playback + catch-up───┘◀───────────┘
```

| Stage | Provider | Typical time |
|---|---|---|
| Speech to text | Deepgram `nova-3`, `language=hi`, interim results, 300 ms endpointing | 0.5–1.0 s after the phrase ends |
| Translation | Groq `qwen/qwen3.8-27b` (fallbacks: `gpt-oss-20b`, then Sarvam Translate) | ~100 ms to first token |
| Text to speech | Cartesia `sonic-2` over one WebSocket per session | ~105 ms to first audio |

## The hard part: Hindi word order

Hindi is verb-final. "मैं कल बाज़ार जाऊँगा" is literally *"I tomorrow market will-go"*. Translating word by word gives broken English, and waiting for the full sentence adds seconds of delay. Anuvaad handles this with three tools:

1. **Stable-text rule.** Partial transcripts change as more audio arrives, so the last 2 words of every partial are never trusted.
2. **Clause-aware chunking** (`server/chunker.js`). A chunk is sent for translation when the stable text reaches a Hindi clause boundary:
   - punctuation from the recognizer (`। . ? ! ,`)
   - a clause-final verb or auxiliary (`है, था, थे, चाहिए`, future forms like `जाऊँगा / करेंगे`), but **not** when more verb parts follow (`गया है`, `कर सकते हैं`)
   - right **before** a conjunction (`और, लेकिन, क्योंकि, तो, अगर, वरना…`), so each clause carries its own verb
   - ~300 ms of silence, or a hard window of 8 words so a long clause never stalls
3. **Context-aware translation.** Each chunk is translated with the previous chunks (Hindi + English) as context and an "interpreter" prompt: continue the English naturally, don't repeat, don't invent. That lets the model fix ambiguous words like **कल**, which means *yesterday* with past tense and *tomorrow* with future tense:
   `कल की meeting cancel हो गई` → *"Yesterday's meeting got canceled"*.

## Keeping up with a fast speaker

English often takes longer to say than Hindi, so a queue can build during a long monologue. The player (`client/playback-policy.js`, shared with the test runner):

- plays every chunk in order, starting as soon as its first audio arrives
- speeds up to **1.12×** when more than 1.5 s is queued, and to **1.25×** above 3 s
- above 6 s, **drops the stale queue** and jumps to the newest phrase

Other real-world handling:
- **Earbuds mode** keeps the mic open; **Speaker mode** mutes the mic while English is playing so it can't translate itself.
- **Auto-reconnect** with backoff on network drops (and the server reconnects to Deepgram on its own), plus server-side heartbeats to clean up dead phone connections.
- Screen wake lock while live, and safe-area layout for phones.

## Measured latency

"Delay" is the time from when the speaker **finishes saying a chunk** to when its **English audio starts playing**, measured with the in-order playback queue. The app shows it live, per chunk and as a running average.

On the 10 test sentences (5 short, 3 long, 2 Hinglish) streamed in real time as one 45-second monologue:

| Run | Chunks | Average | Median | Worst |
|---|---|---|---|---|
| Test runner (`npm run test:clips`) | 17 | **1.33 s** | 1.25 s | 2.52 s |
| Browser client, sample clips | 17 | **1.56 s** | 1.45 s | 2.70 s |
| 90 s nonstop monologue (`--loops 2`) | 34 | **1.71 s** | 1.72 s | 3.76 s |

In the 90-second monologue the delay **does not pile up**: the second half averaged 1.55 s vs 1.87 s for the first half, thanks to the catch-up rules below.

Short sentences land in **0.8–1.2 s**. Long sentences are split into clauses that each land in **1–2.5 s**.

Per stage (typical): STT 0.5–1.0 s · translation ~0.1 s · voice ~0.1 s. Speech recognition endpointing is most of the delay.

## Run it

Needs Node 22+ and keys for Deepgram, Groq and Cartesia (Sarvam is optional).

```bash
cp .env.example .env     # add your keys
npm install
npm run dev              # Vite on http://localhost:5173 + API server on :3000
```

For production: `npm run build` (Vite → `dist/`), then `npm start`, which serves the app and API together on `PORT` (default 3000).

Open the page, tap **Start** and speak Hindi. No Hindi speaker nearby? Tap **Play sample clips instead**.

**On a phone:** the mic needs https. Deploy (below), or `npm run build && npm start` and tunnel your laptop, e.g. `cloudflared tunnel --url http://localhost:3000`.

**Deploy:** `render.yaml` is included. On Render: New → Blueprint → this repo → paste the keys.

### Tests

```bash
npm run test:unit                                  # chunker rules
npm run test:clips                                 # stream the 10 Hindi clips through a running server
node tools/run-clip.mjs --all --loops 2            # ~90 s nonstop monologue: does the delay pile up?
node tools/run-clip.mjs --all --url wss://<your-app>/ws   # test the deployed server
```

`npm run clips` regenerates the test clips with Sarvam TTS. Drop your own 16 kHz mono WAV recordings into `test_clips/` to test a real voice.

## Streaming API

`wss://<host>/ws`

**Client → server**
- binary: 16 kHz mono PCM16LE audio, ~100 ms per frame
- `{"type":"flush"}`: translate whatever has been heard so far

**Server → client**
- `{"type":"ready"}`
- `{"type":"transcript","text","isFinal"}`: live Hindi captions
- `{"type":"segment","seg","hi","speechEnd","reason"}`: a chunk was sent for translation (`speechEnd` = seconds of audio since session start)
- `{"type":"translation","seg","delta"}` then `{"type":"translation_done","seg","en","provider"}`
- `{"type":"metrics","seg","sttMs","translateMs","ttsMs","serverMs"}`
- binary: `[uint32 LE seg][PCM16LE mono 24 kHz]` English audio
- `{"type":"tts_done","seg"}`

## Project layout

```
server/   index.js (HTTP + WebSocket) · session.js (pipeline) · chunker.js (Hindi clause rules)
          stt.js (Deepgram) · translator.js (Groq + fallbacks) · tts.js (Cartesia) · config.js
client/   Vite frontend (plain JS): index.html · src/main.js (mic, playback, latency)
          src/playback-policy.js · src/style.css · public/pcm-worklet.js (48k → 16k mic resampler)
tools/    run-clip.mjs (latency test runner) · make-clips.mjs (Sarvam test clip generator)
test_clips/  10 Hindi/Hinglish sentences + expected English
```

## Next steps

- Two-way mode (English → Hindi for the other person) on a phone call via Bolna + Plivo telephony
- Speaking the English in the speaker's own cloned voice
- Speaker-adaptive chunking (tune the window to how fast each person talks)
