// Decides when a piece of Hindi is "ready" to translate.
//
// The problem: Hindi is verb-final ("मैं कल बाज़ार जाऊँगा" = "I tomorrow market will-go").
// Translating word by word gives broken English, but waiting for the whole sentence adds
// seconds of delay. So we commit at Hindi clause boundaries:
//   - punctuation from the STT (। . ? ! ,)
//   - a clause-final verb/auxiliary (है, था, जाऊँगा ...) that isn't followed by more verb parts
//   - right before a conjunction (और, लेकिन, क्योंकि ...), which starts a new clause
//   - silence (the STT's endpointing) or a max window, so nothing waits forever
// Partial transcripts change as more audio arrives, so we never trust their last
// `holdWords` words (the "stable text" rule).

const STRONG_PUNCT = /[।॥.?!]$/;
const SOFT_PUNCT = /[,;:]$/;
const strip = (w) => w.replace(/[।॥.?!,;:"'“”‘’()]/g, '').toLowerCase();

// Words that end a clause when nothing verb-like follows.
const CLAUSE_FINAL = new Set(['है', 'हैं', 'था', 'थी', 'थे', 'हूँ', 'हूं', 'हो', 'चाहिए', 'लगा', 'लगी', 'लगे']);
// Words that continue a verb group, so we must not cut before them.
const VERB_CONTINUES = new Set([
  'है', 'हैं', 'था', 'थी', 'थे', 'हूँ', 'हूं', 'हो', 'गया', 'गई', 'गए', 'गयी', 'रहा', 'रही', 'रहे',
  'सकता', 'सकती', 'सकते', 'चाहिए', 'दिया', 'दी', 'दिए', 'लिया', 'ली', 'लिए', 'चुका', 'चुकी', 'चुके',
  'जाएगा', 'जाएगी', 'जाएंगे', 'पड़ेगा', 'पड़ा', 'पाया', 'करता', 'करती', 'करते',
]);
// Words that start a new clause.
const CONJUNCTIONS = new Set([
  'और', 'लेकिन', 'मगर', 'परंतु', 'क्योंकि', 'कि', 'तो', 'जब', 'अगर', 'इसलिए', 'बल्कि', 'फिर', 'जबकि',
  'ताकि', 'वरना', 'यानी', 'and', 'but', 'because', 'so', 'then', 'or',
]);
const NOT_FUTURE = new Set(['आगे', 'लोगे', 'भागे', 'जागे', 'मांगे']);

/** True if a chunk may end after `word`, given the following word (if known). */
export function isClauseEnd(word, next) {
  if (STRONG_PUNCT.test(word) || SOFT_PUNCT.test(word)) return true;
  const w = strip(word);
  const n = next ? strip(next) : undefined;
  if (CONJUNCTIONS.has(w)) return false; // a conjunction belongs to the clause after it
  if (n && VERB_CONTINUES.has(n)) return false;
  if (CLAUSE_FINAL.has(w)) return true;
  // Future tense verbs: जाऊँगा, करेंगे, आएगी ...
  if (w.length > 2 && /(गा|गी|गे)$/.test(w) && !NOT_FUTURE.has(w)) return true;
  if (n && CONJUNCTIONS.has(n)) return true;
  return false;
}

export class Chunker {
  /**
   * @param {{holdWords:number,minWords:number,maxWindow:number}} opts
   * @param {(words:{w:string,end:number}[], reason:string) => void} onCommit
   */
  constructor(opts, onCommit) {
    this.hold = opts.holdWords;
    this.min = opts.minWords;
    this.max = opts.maxWindow;
    this.onCommit = onCommit;
    this.pending = []; // finalized words not yet committed
    this.interimCommitted = 0; // words of the current (unfinalized) STT segment already committed
  }

  /** Feed one STT result: { isFinal, speechFinal, words: [{w, end}] } */
  onResult({ isFinal, speechFinal, words }) {
    if (isFinal) {
      const fresh = words.slice(this.interimCommitted);
      this.interimCommitted = 0;
      this.pending.push(...fresh);
      if (speechFinal) return this.flush('silence');
      this.#commitBoundaries(this.pending, null, 'clause');
    } else {
      const stableEnd = Math.max(this.interimCommitted, words.length - this.hold);
      const stable = words.slice(this.interimCommitted, stableEnd);
      const lookahead = words[stableEnd]?.w ?? null; // unstable, but a useful hint
      this.#commitBoundaries(this.pending.concat(stable), lookahead, 'clause');
    }
  }

  /** Commit whatever is waiting (silence, end of utterance, stop). */
  flush(reason = 'flush') {
    if (this.pending.length) this.#emit(this.pending.length, this.pending, reason);
  }

  #commitBoundaries(cand, lookahead, reason) {
    for (;;) {
      let cut = -1;
      for (let i = this.min - 1; i < cand.length; i++) {
        const next = i + 1 < cand.length ? cand[i + 1].w : lookahead;
        if (isClauseEnd(cand[i].w, next)) cut = i;
      }
      let why = reason;
      if (cut < 0 && cand.length >= this.max) {
        cut = this.max - 1;
        why = 'window';
      }
      if (cut < 0) return;
      cand = this.#emit(cut + 1, cand, why);
    }
  }

  // Commit the first n words of cand; returns the rest. Words come from `pending` first,
  // then from the current interim segment.
  #emit(n, cand, reason) {
    const words = cand.slice(0, n);
    const fromPending = Math.min(n, this.pending.length);
    this.pending.splice(0, fromPending);
    this.interimCommitted += n - fromPending;
    this.onCommit(words, reason);
    return cand.slice(n);
  }
}
