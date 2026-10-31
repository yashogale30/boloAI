/**
 * Aceternity-style 3D Container Scroll & Rolling Tilt Controller
 *
 * Implements the signature Aceternity UI scroll-driven 3D animation:
 * - At the top of the hero, the card is tilted backward in 3D perspective (~22deg) and slightly scaled down (0.92).
 * - As the user scrolls down, the card smoothly "rolls" and unrolls forward into flat perspective (0deg, scale 1.0).
 * - Interactive mouse tilt provides subtle live depth and glare reflection.
 */

export function initTiltEffect(containerEl) {
  if (!containerEl) return null;

  const card = containerEl.querySelector('.perspective-card') || containerEl;
  const glare = containerEl.querySelector('.tilt-glare');

  // Scroll rolling animation state
  let scrollProgress = 0; // 0 = at top (tilted back), 1 = scrolled to focus (flat)
  let targetScrollRotateX = 22; // Initial back-tilt angle
  let targetScrollScale = 0.92;
  let targetScrollTranslateY = 0;

  // Mouse hover tilt state
  let mouseTiltX = 0;
  let mouseTiltY = 0;
  let targetMouseTiltX = 0;
  let targetMouseTiltY = 0;

  // Rendered spring state
  let currentRotateX = 22;
  let currentRotateY = 0;
  let currentScale = 0.92;
  let currentTranslateY = 0;

  let glareOpacity = 0;
  let currentGlareOpacity = 0;
  let glareX = 50;
  let glareY = 50;
  let currentGlareX = 50;
  let currentGlareY = 50;

  let rafId = null;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Calculate scroll progress for the rolling effect
  function updateScrollProgress() {
    const rect = containerEl.getBoundingClientRect();
    const windowHeight = window.innerHeight || 800;

    // When the top of container is around 65% down the viewport, it starts unrolling
    // When the container is centered in viewport, progress reaches 1.0 (flat 3D)
    const startOffset = windowHeight * 0.95;
    const endOffset = windowHeight * 0.35;

    const rawProgress = (startOffset - rect.top) / (startOffset - endOffset);
    scrollProgress = Math.max(0, Math.min(1, rawProgress));

    if (prefersReduced) {
      targetScrollRotateX = 0;
      targetScrollScale = 1;
      targetScrollTranslateY = 0;
      return;
    }

    // Smooth cosine easing for natural roll
    const eased = 0.5 - 0.5 * Math.cos(scrollProgress * Math.PI);

    // From 22deg tilted away down to 0deg flat
    targetScrollRotateX = (1 - eased) * 22;
    // From 0.92 scale up to 1.0
    targetScrollScale = 0.92 + eased * 0.08;
    // Subtle glide up
    targetScrollTranslateY = (1 - eased) * 30;
  }

  // Animation frame loop with spring damping
  function tick() {
    const ease = 0.08;

    // Combine scroll roll and mouse tilt
    const targetX = targetScrollRotateX + targetMouseTiltX;
    const targetY = targetMouseTiltY;

    currentRotateX += (targetX - currentRotateX) * ease;
    currentRotateY += (targetY - currentRotateY) * ease;
    currentScale += (targetScrollScale - currentScale) * ease;
    currentTranslateY += (targetScrollTranslateY - currentTranslateY) * ease;

    currentGlareOpacity += (glareOpacity - currentGlareOpacity) * ease;
    currentGlareX += (glareX - currentGlareX) * ease;
    currentGlareY += (glareY - currentGlareY) * ease;

    card.style.transform = `perspective(1200px) rotateX(${currentRotateX.toFixed(2)}deg) rotateY(${currentRotateY.toFixed(2)}deg) scale(${currentScale.toFixed(3)}) translateY(${currentTranslateY.toFixed(1)}px)`;

    if (glare) {
      glare.style.opacity = currentGlareOpacity.toFixed(3);
      glare.style.background = `radial-gradient(circle 450px at ${currentGlareX.toFixed(1)}% ${currentGlareY.toFixed(1)}%, rgba(255, 255, 255, 0.20), transparent 70%)`;
    }

    rafId = requestAnimationFrame(tick);
  }

  function onMouseMove(e) {
    if (prefersReduced || isTouchDevice) return;
    const rect = containerEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    const normX = Math.max(-1, Math.min(1, (x - 0.5) * 2));
    const normY = Math.max(-1, Math.min(1, (y - 0.5) * 2));

    // Interactive mouse tilt dampens when card is still heavily rolled by scroll
    const influence = 0.4 + scrollProgress * 0.6;
    targetMouseTiltX = -normY * 4.0 * influence;
    targetMouseTiltY = normX * 4.0 * influence;

    glareX = x * 100;
    glareY = y * 100;
    glareOpacity = 1;
  }

  function onMouseLeave() {
    targetMouseTiltX = 0;
    targetMouseTiltY = 0;
    glareOpacity = 0;
  }

  // Bind scroll and mouse listeners
  window.addEventListener('scroll', updateScrollProgress, { passive: true });
  window.addEventListener('resize', updateScrollProgress, { passive: true });
  updateScrollProgress();

  if (!prefersReduced && !isTouchDevice) {
    containerEl.addEventListener('mousemove', onMouseMove, { passive: true });
    containerEl.addEventListener('mouseleave', onMouseLeave, { passive: true });
  }

  rafId = requestAnimationFrame(tick);

  return {
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', updateScrollProgress);
      window.removeEventListener('resize', updateScrollProgress);
      containerEl.removeEventListener('mousemove', onMouseMove);
      containerEl.removeEventListener('mouseleave', onMouseLeave);
    },
  };
}
