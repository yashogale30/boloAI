// Generates the 10 Hindi test clips (16 kHz mono WAV) with Sarvam text-to-speech.
// Replace any of them with your own recordings (same file name, 16 kHz mono 16-bit WAV)
// to test with a real voice.
//   npm run clips
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('test_clips');
const clips = JSON.parse(await fs.readFile(path.join(dir, 'clips.json'), 'utf8'));
const speaker = process.env.CLIP_SPEAKER || 'rahul';

for (const c of clips) {
  const file = path.join(dir, `${c.id}.wav`);
  if (!process.argv.includes('--force')) {
    try {
      await fs.access(file);
      console.log('exists', c.id);
      continue;
    } catch {}
  }
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: c.hi, target_language_code: 'hi-IN', speech_sample_rate: 16000, model: 'bulbul:v3', speaker }),
  });
  if (!res.ok) throw new Error(`${c.id}: Sarvam HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  await fs.writeFile(file, Buffer.concat(json.audios.map((a) => Buffer.from(a, 'base64'))));
  console.log('wrote ', c.id);
}
