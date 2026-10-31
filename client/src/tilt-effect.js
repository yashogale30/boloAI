/**
 * Aceternity-style 3D Container Scroll & Rolling Tilt Controller
 *
 * Implements the signature Aceternity UI scroll-driven 3D animation:
 * - At the top of the page, the card is tilted backward in 3D perspective (~16deg, scale 0.94).
 * - As the user scrolls down toward the card, it smoothly "rolls" and unrolls forward into flat perspective (0deg, scale 1.0).
 * - When in interactive focus, the transform settles cleanly to 'none' so all buttons, clicks,
 *   inputs, and audio controls are 100% clickable and responsive without 3D hit-test distortion.
 */

export function initTiltEffect(containerEl) {
  if (!containerEl) return null;

  const card = containerEl.querySelector('.perspective-card') || containerEl;

  let ticking = false;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function update() {
    ticking = false;
    if (prefersReduced) {
      card.style.transform = 'none';
      return;
    }

    const rect = containerEl.getBoundingClientRect();
    const windowHeight = window.innerHeight || 800;

    // Start rolling when the container top enters 95% of viewport
    // Fully flatten to 0deg when container top reaches 25% of viewport
    const startOffset = windowHeight * 0.95;
    const endOffset = windowHeight * 0.25;

    const rawProgress = (startOffset - rect.top) / (startOffset - endOffset);
    const progress = Math.max(0, Math.min(1, rawProgress));

    if (progress >= 0.98) {
      // In interactive focus: remove transform so clicks are 100% direct and unhindered
      card.style.transform = 'none';
      return;
    }

    // Smooth cosine easing
    const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI);

    const rotateX = (1 - eased) * 16; // from 16deg to 0deg
    const scale = 0.94 + eased * 0.06; // from 0.94 to 1.0
    const translateY = (1 - eased) * 20;

    card.style.transform = `perspective(1200px) rotateX(${rotateX.toFixed(2)}deg) scale(${scale.toFixed(3)}) translateY(${translateY.toFixed(1)}px)`;
  }

  function onScroll() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();

  return {
    destroy() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      card.style.transform = 'none';
    },
  };
}
