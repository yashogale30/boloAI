import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chunker, isClauseEnd } from './chunker.js';

const W = (s, t0 = 0) => s.split(' ').map((w, i) => ({ w, end: t0 + (i + 1) * 0.3 }));

function run(results) {
  const out = [];
  const c = new Chunker({ holdWords: 2, minWords: 2, maxWindow: 8 }, (words, reason) =>
    out.push([words.map((x) => x.w).join(' '), reason]),
  );
  for (const r of results) c.onResult(r);
  c.flush('end');
  return out;
}

test('clause boundaries', () => {
  assert.equal(isClauseEnd('जाऊँगा'), true);
  assert.equal(isClauseEnd('है।'), true);
  assert.equal(isClauseEnd('गया', 'है'), false);
  assert.equal(isClauseEnd('बीमार', 'था'), false);
  assert.equal(isClauseEnd('थे', 'और'), true);
  assert.equal(isClauseEnd('दोस्त', 'और'), true);
  assert.equal(isClauseEnd('आगे'), false);
  assert.equal(isClauseEnd('और', 'फिर'), false);
});

test('commits on silence and never repeats words', () => {
  const out = run([
    { isFinal: false, words: W('मैं कल') },
    { isFinal: false, words: W('मैं कल बाज़ार जाऊँगा') },
    { isFinal: true, speechFinal: true, words: W('मैं कल बाज़ार जाऊँगा') },
  ]);
  assert.deepEqual(out.map((o) => o[0]), ['मैं कल बाज़ार जाऊँगा']);
});

test('commits a clause from a partial before the speaker finishes', () => {
  const out = run([
    { isFinal: false, words: W('कल meeting cancel हो गई क्योंकि बॉस') },
    { isFinal: false, words: W('कल meeting cancel हो गई क्योंकि बॉस बीमार थे') },
    { isFinal: true, speechFinal: true, words: W('कल meeting cancel हो गई क्योंकि बॉस बीमार थे') },
  ]);
  assert.equal(out[0][0], 'कल meeting cancel हो गई');
  assert.equal(out.map((o) => o[0]).join(' '), 'कल meeting cancel हो गई क्योंकि बॉस बीमार थे');
});

test('max window forces a commit in long clauses', () => {
  const out = run([{ isFinal: false, words: W('एक दो तीन चार पांच छह सात आठ नौ दस ग्यारह') }]);
  assert.equal(out[0][1], 'window');
  assert.equal(out[0][0].split(' ').length, 8);
});
