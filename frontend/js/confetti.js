// Dependency-free canvas particle burst for genuine milestone moments (e.g.
// crossing a macro goal) — no library, matches this repo's no-new-CDN-
// dependency pattern (same reasoning as the Sentry/Turnstile decisions in
// CLAUDE.md). A short-lived, full-viewport, pointer-events:none canvas
// overlay that removes itself from the DOM once every particle has faded —
// never left mounted between bursts, so repeated triggers can't stack up
// stale canvases.

const COLORS = ["#ff6b4a", "#33d6a6", "#ffc24b", "#8c9eff", "#8bc34a", "#4fc3f7"];
const PARTICLE_COUNT = 46;
const GRAVITY = 0.18;
const DRAG = 0.985;
const FADE_PER_FRAME = 0.012;

// originEl (optional): the element the burst should radiate from (e.g. the
// macro row that just crossed its target) — falls back to upper-center of
// the viewport when omitted, e.g. for a milestone with no obvious anchor.
export function fireConfetti(originEl) {
  // A celebratory particle burst is exactly the kind of motion
  // prefers-reduced-motion opts out of — skipping it entirely (not a
  // reduced/instant version) is the right call here since it's decorative,
  // never load-bearing information.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const rect = originEl?.getBoundingClientRect?.();
  const originX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const originY = rect ? rect.top + rect.height / 2 : window.innerHeight / 3;

  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const particles = Array.from({ length: PARTICLE_COUNT }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 6;
    return {
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2, // slight upward bias so the burst reads as a "pop", not a scatter
      size: 4 + Math.random() * 4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.3,
      life: 1,
    };
  });

  let raf;
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let anyAlive = false;
    for (const p of particles) {
      p.vx *= DRAG;
      p.vy = p.vy * DRAG + GRAVITY;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.rotationSpeed;
      p.life -= FADE_PER_FRAME;
      if (p.life <= 0) continue;
      anyAlive = true;
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    }
    if (anyAlive) {
      raf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(raf);
      canvas.remove();
    }
  }
  raf = requestAnimationFrame(tick);
}
