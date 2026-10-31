// How the player keeps the English voice from falling behind the speaker.
// Shared by the browser client and tools/run-clip.mjs so test numbers match real playback.
//   backlog = seconds of English audio already queued but not yet heard
export const POLICY = {
  speedUpAt: 1.5, // more than this queued -> play a bit faster
  fastAt: 3.0, // more than this queued -> play faster still
  skipAt: 6.0, // more than this queued -> drop the stale queue and jump to the newest chunk
  speed: 1.12,
  fast: 1.25,
};

export function playbackRate(backlogSec) {
  if (backlogSec > POLICY.fastAt) return POLICY.fast;
  if (backlogSec > POLICY.speedUpAt) return POLICY.speed;
  return 1;
}

export function shouldSkip(backlogSec) {
  return backlogSec > POLICY.skipAt;
}
