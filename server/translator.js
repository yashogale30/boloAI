// Streaming Hindi -> English translation with Groq (OpenAI-compatible API).
// Each chunk is translated with the previous chunks as context, so fragments that
// were cut before the Hindi verb still join into natural English.

const SYSTEM_PROMPT = `You are a live simultaneous interpreter from Hindi (including Hinglish) into English.
The speaker is still talking, so you receive their speech in small fragments, in order.
Translate ONLY the NEW fragment into natural, spoken English that continues smoothly from the English already spoken.
Rules:
- Output only the English words to be spoken aloud. No quotes, labels, notes, or explanations.
- Do not repeat English that was already spoken.
- Hindi puts the verb at the end, so a fragment may be incomplete. Translate what is there naturally; never invent words the speaker did not say.
- Keep English words the speaker already used (Hinglish) as they are.
- "कल" means "yesterday" with past tense and "tomorrow" with future tense; "परसों" works the same way.
- Speech recognition can mishear words. If a word makes no sense, use the most likely meaning from context.
- Use simple, conversational English, the way a person would say it out loud.
- If the fragment has nothing to translate (only filler like "उम्म", "मतलब", "हाँ तो"), output nothing.`;

function buildUserMessage(hi, history) {
  if (!history.length) return `New Hindi fragment: ${hi}`;
  const ctx = history.map((h) => `Hindi: ${h.hi}\nEnglish: ${h.en}`).join('\n');
  return `Already translated (for context only):\n${ctx}\n\nNew Hindi fragment: ${hi}`;
}

function cleanOutput(s) {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*(english|translation)\s*:\s*/i, '')
    .replace(/^["“'\s]+|["”'\s]+$/g, '')
    .trim();
}

async function streamGroq({ cfg, model, hi, history, onDelta }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.llmTimeoutMs);
  const extra = /qwen/i.test(model) ? { reasoning_effort: 'none' } : /gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {};
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${cfg.groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(hi, history) },
        ],
        ...extra,
      }),
    });
    if (!res.ok) throw new Error(`Groq ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const dec = new TextDecoder();
    let buf = '';
    let out = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;
        if (delta) {
          out += delta;
          onDelta?.(delta);
        }
      }
    }
    return cleanOutput(out);
  } finally {
    clearTimeout(timer);
  }
}

// Last resort: Sarvam's translate API (not streaming, but reliable for Hindi).
async function sarvamTranslate(cfg, hi) {
  const res = await fetch('https://api.sarvam.ai/translate', {
    method: 'POST',
    headers: { 'api-subscription-key': cfg.sarvamKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: hi, source_language_code: 'hi-IN', target_language_code: 'en-IN' }),
  });
  if (!res.ok) throw new Error(`Sarvam HTTP ${res.status}`);
  return cleanOutput((await res.json()).translated_text || '');
}

/** Opens the HTTPS connection to Groq early so the first real chunk doesn't pay for it. */
export function warmUp(cfg) {
  fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${cfg.groqKey}` } }).catch(() => {});
}

/**
 * Translate one Hindi chunk. Tries the main model, then the fallback model, then Sarvam.
 * @returns {Promise<{en: string, provider: string}>}
 */
export async function translate({ cfg, hi, history, onDelta }) {
  const models = [cfg.llmModel, cfg.llmFallbackModel];
  for (const model of models) {
    let streamed = false;
    try {
      const en = await streamGroq({
        cfg,
        model,
        hi,
        history,
        onDelta: (d) => {
          streamed = true;
          onDelta?.(d);
        },
      });
      return { en, provider: model };
    } catch (err) {
      console.warn(`[translate] ${model} failed: ${err.message}`);
      if (streamed) onDelta?.(null); // tell the caller to reset partial text
    }
  }
  if (cfg.sarvamKey) {
    const en = await sarvamTranslate(cfg, hi);
    return { en, provider: 'sarvam' };
  }
  throw new Error('All translation providers failed');
}
