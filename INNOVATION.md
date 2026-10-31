# Anuvaad: What's New

> **Anuvaad is a live Hindi-to-English interpreter for your earbuds. It understands that Hindi puts the verb last, so it translates clause by clause, about 1.5 seconds behind you, and the delay doesn't grow however long you talk.**

Built for the **Bolna Buildathon** (Symphony 2026). For the architecture and progress, see [PROJECT.md](PROJECT.md). For setup, see [README.md](README.md).

---

## The problem

Hundreds of millions of Indians speak Hindi or Hinglish, not English. Today's translation tools make you **speak, stop, wait, then listen**, which kills a natural conversation.

Real-time interpreting is especially hard for Hindi because **the verb comes last**:

> मैं कल बाज़ार जाऊँगा → literally *"I tomorrow market will-go"*

A live translator has two bad options:

| Approach | Result |
|---|---|
| Wait for the whole sentence | Correct English, but **several seconds** of silence |
| Translate word by word as you speak | Fast, but **broken English** and wrong guesses |

Anuvaad takes a third path.

---

## Our innovations

The building blocks (Deepgram, Groq, Cartesia) are off-the-shelf services. The new work is in **how they are joined**, which is what makes live Hindi interpreting work.

### 1. Clause-aware chunking for a verb-last language (the core idea)

Speech is cut at natural Hindi clause boundaries, not by word count or pauses alone:

- **after** a clause-ending verb or helper word: `है, था, थे, चाहिए, जाऊँगा, करेंगे`
- **but not** in the middle of a verb group: `गया है`, `कर सकते हैं`
- **just before** a joining word: `और, लेकिन, क्योंकि, तो, अगर, वरना`, so each piece keeps its own verb
- the last 2 words of every partial transcript are ignored until the recognizer settles on them
- silence or an 8-word cap acts as a safety net, so nothing waits forever

**Result:** a long sentence comes out as 2–3 clean English clauses, each about 1–2 s behind the speaker, instead of one long wait.

| Hindi, as spoken | Chunk sent | English heard |
|---|---|---|
| कल की meeting cancel हो गई क्योंकि client की flight delay थी | `कल की meeting cancel हो गई` | *Yesterday's meeting got canceled* |
| | `क्योंकि client की flight delay थी` | *because the client's flight was delayed* |

Code: [`server/chunker.js`](server/chunker.js) · Tests: [`server/chunker.test.js`](server/chunker.test.js)

### 2. Translation that remembers the conversation

Each piece is translated with the previous ones as context, so the English:
- **flows as one stream** instead of disconnected fragments
- **never repeats** what was already said
- **resolves ambiguous words**: कल means *yesterday* or *tomorrow* depending on the verb tense, and the system picks correctly ("कल की meeting cancel हो गई" → "**Yesterday's** meeting got canceled")

Code: [`server/translator.js`](server/translator.js)

### 3. An honest "mouth to ear" delay

Most demos show server processing time. Anuvaad measures **the moment the speaker stops saying a phrase** to **the moment the English starts playing in the earbuds**.

How it works: the browser records when each 100 ms of mic audio was captured. The recognizer's word timestamps are mapped back to that clock, and when the English starts playing the browser takes the difference. The number on screen includes network time and any waiting in the playback queue.

Code: [`client/src/main.js`](client/src/main.js)

### 4. Delay that doesn't pile up

English usually takes longer to say than Hindi, so most live translators drift further behind the longer someone talks. Anuvaad's player:

| English waiting in the queue | What happens |
|---|---|
| under 1.5 s | normal speed |
| over 1.5 s | plays at 1.12× |
| over 3 s | plays at 1.25× |
| over 6 s | skips stale audio and jumps to the newest phrase |

**Proof:** in a 90-second nonstop monologue, the **second half was faster than the first** (1.55 s vs 1.87 s average).

Code: [`client/src/playback-policy.js`](client/src/playback-policy.js), shared with the test runner so test numbers match real playback.

### 5. Hinglish works as is

Mixed sentences are recognized and translated as one sentence, keeping the English words. That's how people in India actually speak:

> मैंने तुम्हें WhatsApp पर location भेज दी है → *"I've sent you the location on WhatsApp."*

### 6. No app, no special hardware, and a reusable API

- Runs in **any phone browser** with **any earbuds**. No install.
- **Earbuds / Speaker modes:** speaker mode mutes the mic while English plays, so it never translates itself.
- **Recovers from network drops** on its own, for walking around on mobile data.
- The whole pipeline is a **documented streaming WebSocket API** (`/ws`) that other apps, call systems or devices can plug into.

### 7. A repeatable test setup

Ten Hindi and Hinglish sentences (5 short, 3 long, 2 Hinglish) are streamed **in real time** through the full pipeline, with a per-phrase delay report. Every number in the pitch can be reproduced on the spot:

```bash
npm run test:clips                         # 10 sentences, translation + delay table
node tools/run-clip.mjs --all --loops 2    # 90 s nonstop monologue
```

Code: [`tools/run-clip.mjs`](tools/run-clip.mjs)

---

## Measured results

| Test | Phrases | Average delay | Worst |
|---|---|---|---|
| 10 sentences, test runner | 17 | **1.33 s** | 2.52 s |
| 10 sentences, real browser | 17 | **1.56 s** | 2.70 s |
| 90 s nonstop monologue | 34 | **1.71 s** | 3.76 s |

- Short sentences: **0.8–1.2 s**
- Long sentences are split into clauses that each land in **1–2.5 s**
- **Where the time goes:** speech recognition 0.5–1.0 s · translation ~0.1 s · voice ~0.1 s

---

## How Anuvaad compares

| | Typical "conversation mode" translators | Anuvaad |
|---|---|---|
| Speaking style | Speak, stop, wait, listen | Keep talking; English follows ~1.5 s behind |
| Hindi verb-last word order | Waits for the full sentence | Translates clause by clause |
| Hinglish | Often treated as errors | Handled as normal speech |
| Long monologues | Delay tends to grow | Catch-up rules keep it bounded |
| Latency | Rarely shown | Live mouth-to-ear counter on screen |
| Platform | Tied to an app or device | Any phone browser + a streaming API |

**Note:** Google Translate's conversation mode, Samsung's Interpreter and Apple's Live Translation with AirPods all offer live translation. Anuvaad's angle is **Hindi and Hinglish first, any device, and open latency numbers**. Check each product's current language support before naming it in the pitch.

---

## What we don't claim

- We did not build our own speech recognition, translation or voice models. We use sponsor and partner services (Deepgram, Groq, Cartesia, Sarvam).
- Rule-based chunking is a **practical engineering approach**, not a research breakthrough. The claim is: *we solved Hindi's word-order problem well enough for live use, and here are the numbers.*
- Translation quality depends on recognition. If a word is misheard, the English can be off.

---

## Next steps

| Next step | Why it matters |
|---|---|
| **Live phone call translation** via Bolna voice agents or Plivo telephony: a Hindi speaker and an English speaker each hear the other in their own language | Matches the hosts' and sponsors' core business; the most memorable finale demo |
| **Two-way mode** (English → Hindi) | Turns a one-way interpreter into a real conversation tool |
| **Voice cloning**, so the English sounds like the speaker | A more personal, natural experience |
| **More Indian languages** (Tamil, Telugu, Marathi, Bengali) | The approach carries over; each language needs its own clause rules |
| **Speaker-adaptive chunking** | Lower delay for fast talkers, better English for slow ones |

---

## The pitch in 30 seconds

> "Live translators make you speak, stop and wait. Hindi makes it harder, because the verb comes last.
> Anuvaad translates **clause by clause** as you talk, using Hindi grammar to know when a thought is complete, and speaks natural English in your earbuds **about 1.5 seconds behind you**.
> It handles Hinglish, it keeps up through a nonstop monologue, and the delay counter on screen is measured mouth to ear.
> It runs in any phone browser, and it's a streaming API, so the next step is live phone calls."
