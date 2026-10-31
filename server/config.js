// All tunables in one place. Every value can be overridden with an env var.
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const cfg = {
  // `--port N` wins (used by `npm run dev`), then PORT (set by hosts like Render), then 3000.
  port: num(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : env.PORT, 3000),

  deepgramKey: env.DEEPGRAM_API_KEY,
  groqKey: env.GROQ_API_KEY,
  cartesiaKey: env.CARTESIA_API_KEY,
  sarvamKey: env.SARVAM_API_KEY,

  // Speech to text (Deepgram streaming)
  sttModel: env.STT_MODEL || 'nova-3',
  sttLanguage: env.STT_LANGUAGE || 'hi',
  endpointingMs: num(env.ENDPOINTING_MS, 300), // silence that ends a phrase

  // Chunking (see server/chunker.js)
  holdWords: num(env.HOLD_WORDS, 2), // ignore the last N words of a partial transcript
  minWords: num(env.MIN_WORDS, 2), // smallest chunk we commit on a clause boundary
  maxWindow: num(env.MAX_WINDOW, 8), // force a commit once this many words are waiting
  idleFlushMs: num(env.IDLE_FLUSH_MS, 1500), // backstop: commit leftovers if STT goes quiet

  // Translation (Groq, OpenAI-compatible)
  llmModel: env.LLM_MODEL || 'qwen/qwen3.8-27b',
  llmFallbackModel: env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-20b',
  llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 4000),
  historySize: num(env.HISTORY_SIZE, 6),

  // Text to speech (Cartesia streaming)
  ttsModel: env.TTS_MODEL || 'sonic-2',
  ttsVoice: env.TTS_VOICE || '47c38ca4-5f35-497b-b1a3-415245fb35e1', // "Daniel"
  ttsSampleRate: 24000,
  cartesiaVersion: '2025-04-16',
};

export function missingKeys() {
  return ['deepgramKey', 'groqKey', 'cartesiaKey'].filter((k) => !cfg[k]);
}
