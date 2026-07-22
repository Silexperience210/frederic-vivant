/* ═══════════ Frédéric Vivant — Accueil immersif (vanilla, canvas 2D) ═══════════
   Parallaxe doigt/gyroscope, traînée d'étincelles, braises ambiantes,
   sceau de cire press-and-hold, titre vivant. Aucune dépendance. */

const landing = document.getElementById("landing");
if (!landing) throw new Error("landing.js: #landing introuvable");

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

const heroBg = landing.querySelector(".hero-bg");
const portrait = landing.querySelector(".frederic-portrait");
const card = landing.querySelector(".souvenir-card");
const canvas = document.getElementById("magic-canvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const btnStart = document.getElementById("btn-start");

/* ───────────────────────── 1. Titre vivant (lettres staggered) ───────────────────────── */
(function splitTitle() {
  const h1 = document.getElementById("landing-title");
  if (!h1 || REDUCED) return;
  let i = 0;
  const wrap = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const frag = document.createDocumentFragment();
      for (const ch of node.textContent) {
        if (ch.trim() === "") { frag.append(ch); continue; }
        const s = document.createElement("span");
        s.className = "lt";
        s.textContent = ch;
        s.style.setProperty("--d", `${0.25 + i * 0.045}s`);
        i++;
        frag.append(s);
      }
      node.replaceWith(frag);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== "BR") {
      [...node.childNodes].forEach(wrap);
    }
  };
  [...h1.childNodes].forEach(wrap);
})();

/* ───────────────────────── 2. Mots-clés surlignés au toucher ───────────────────────── */
landing.querySelectorAll(".kw").forEach((kw) => {
  const light = () => {
    kw.classList.add("lit");
    setTimeout(() => kw.classList.remove("lit"), 900);
  };
  kw.addEventListener("pointerdown", light);
  kw.addEventListener("click", light);
});

/* ───────────────────────── 3. Parallaxe 3D (gyroscope / pointeur / drag) ───────────────────────── */
/* target : valeurs normalisées -1..1 ; current : lissées */
const par = { tx: 0, ty: 0, cx: 0, cy: 0 };
let lastPointerT = 0;

function setTargetFromPoint(clientX, clientY) {
  par.tx = (clientX / window.innerWidth) * 2 - 1;
  par.ty = (clientY / window.innerHeight) * 2 - 1;
}

if (!REDUCED) {
  /* Desktop : pointermove ; Mobile : drag tactile suit aussi pointermove */
  landing.addEventListener("pointermove", (e) => {
    lastPointerT = performance.now();
    setTargetFromPoint(e.clientX, e.clientY);
  }, { passive: true });

  /* Gyroscope (avec permission iOS au premier toucher) */
  const askGyro = () => {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().catch(() => {});
    }
    landing.removeEventListener("pointerdown", askGyro);
  };
  landing.addEventListener("pointerdown", askGyro, { passive: true });

  window.addEventListener("deviceorientation", (e) => {
    if (e.gamma == null || e.beta == null) return;
    /* Ne pas se battre avec le doigt : le drag tactile prime */
    if (performance.now() - lastPointerT < 600) return;
    /* gamma : gauche/droite (-90..90), beta : avant/arrière (-180..180) */
    par.tx = Math.max(-1, Math.min(1, e.gamma / 30));
    par.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
  }, { passive: true });
}

function applyParallax() {
  /* Lissage exponentiel */
  par.cx += (par.tx - par.cx) * 0.07;
  par.cy += (par.ty - par.cy) * 0.07;
  const { cx, cy } = par;
  if (heroBg) heroBg.style.transform = `translate3d(${cx * -8}px, ${cy * -6}px, 0)`;
  if (card) card.style.transform = `rotate(6deg) translate3d(${cx * -14}px, ${cy * -10}px, 0)`;
  if (portrait) {
    /* Portrait : couche proche → bouge plus + tilt 3D + léger suivi du pointeur (max 6px) */
    const px = Math.max(-6, Math.min(6, cx * 20));
    const py = Math.max(-6, Math.min(6, cy * 14));
    portrait.style.transform =
      `translate3d(${px}px, ${py}px, 0) rotateY(${cx * 10}deg) rotateX(${cy * -8}deg)`;
  }
}

/* ───────────────────────── 4. Canvas d'étincelles magiques ───────────────────────── */
let W = 0, H = 0;
const particles = [];
const MAX_PARTICLES = 220;

function resizeCanvas() {
  if (!canvas) return;
  W = landing.clientWidth; H = landing.clientHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

function spawnSpark(x, y, opts = {}) {
  if (particles.length >= MAX_PARTICLES) particles.shift();
  const a = Math.random() * Math.PI * 2;
  const sp = opts.speed ?? (0.3 + Math.random() * 1.6);
  particles.push({
    x, y,
    vx: Math.cos(a) * sp + (opts.vx ?? 0),
    vy: Math.sin(a) * sp + (opts.vy ?? 0),
    life: 1,
    decay: opts.decay ?? (0.012 + Math.random() * 0.02),
    size: opts.size ?? (1 + Math.random() * 2.4),
    hue: 38 + Math.random() * 14,          /* doré */
    grav: opts.grav ?? 0.012,              /* gravité légère */
    tw: Math.random() * Math.PI * 2,       /* phase du scintillement */
    twSpd: 0.15 + Math.random() * 0.25,
    depth: 0.5 + Math.random() * 1.2,      /* profondeur → parallaxe */
  });
}

/* Explosion d'étincelles (cachetage du sceau) */
function burst(x, y, n = 46) {
  for (let i = 0; i < n; i++) {
    spawnSpark(x, y, { speed: 1.5 + Math.random() * 5, size: 1.4 + Math.random() * 3,
      decay: 0.015 + Math.random() * 0.02, grav: 0.05 });
  }
}

let lastTrail = 0;
if (!REDUCED) {
  landing.addEventListener("pointermove", (e) => {
    const now = performance.now();
    if (now - lastTrail < 16) return;      /* ~60 émissions/s max */
    lastTrail = now;
    const n = e.pointerType === "touch" ? 4 : 2;
    for (let i = 0; i < n; i++) spawnSpark(e.clientX, e.clientY, { vy: -0.4 });
  }, { passive: true });
}

let emberTimer = 0;
function stepParticles(dt) {
  if (!ctx) return;
  /* Braises ambiantes : montent doucement comme au-dessus d'un feu */
  emberTimer += dt;
  if (emberTimer > 380 && particles.length < MAX_PARTICLES - 20) {
    emberTimer = 0;
    spawnSpark(Math.random() * W, H + 6, {
      vx: (Math.random() - 0.5) * 0.2, vy: -(0.25 + Math.random() * 0.45),
      speed: 0, size: 1 + Math.random() * 2, decay: 0.004 + Math.random() * 0.005,
      grav: -0.002,
    });
  }
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = "lighter";   /* fondu additif */
  const px = par.cx * 20, py = par.cy * 14;   /* les étincelles bougent le plus */
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.grav;
    p.x += p.vx; p.y += p.vy;
    p.life -= p.decay * (dt / 16.7);
    if (p.life <= 0 || p.y < -20) { particles.splice(i, 1); continue; }
    p.tw += p.twSpd;
    const twinkle = 0.55 + 0.45 * Math.sin(p.tw);
    const alpha = Math.max(0, p.life) * twinkle;
    const sx = p.x + px * p.depth, sy = p.y + py * p.depth;
    const r = p.size * (0.6 + 0.4 * p.life);
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3);
    g.addColorStop(0, `hsla(${p.hue}, 95%, 72%, ${alpha})`);
    g.addColorStop(0.4, `hsla(${p.hue}, 90%, 55%, ${alpha * 0.55})`);
    g.addColorStop(1, "hsla(40, 90%, 50%, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/* ───────────────────────── 5. Sceau de cire press-and-hold ───────────────────────── */
const HOLD_MS = 700;
const TAP_ANIM_MS = 260;
let allowNativeClick = false;   /* laisse passer le click synthétique final */
let holding = false, holdStart = 0, holdDone = false, launching = false;

function sealCenter() {
  const r = btnStart.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function setHold(v) { btnStart.style.setProperty("--hold", v.toFixed(3)); }

function launchSeal() {
  if (launching) return;
  launching = true;
  holdDone = true;
  setHold(1);
  const { x, y } = sealCenter();
  btnStart.classList.add("stamped");
  if (!REDUCED) burst(x, y);
  /* Laisse l'ondulation + le flash se voir, puis déclenche le vrai click (handler ar.js) */
  setTimeout(() => {
    allowNativeClick = true;
    btnStart.click();
    allowNativeClick = false;
  }, REDUCED ? 60 : 420);
}

if (btnStart) {
  /* Intercepte le click brut : on veut l'animer nous-mêmes avant de lancer.
     Sauf : clavier (detail === 0) → accessibilité, on laisse passer direct. */
  btnStart.addEventListener("click", (e) => {
    if (allowNativeClick || e.detail === 0) return;   /* synthétique final ou clavier */
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!launching && !holdDone) {
      /* Tap rapide sans maintien : micro-animation puis lancement (ne bloque pas) */
      if (!REDUCED) {
        const { x, y } = sealCenter();
        burst(x, y, 14);
        btnStart.classList.add("stamped");
        setTimeout(() => btnStart.classList.remove("stamped"), 560);
      }
      launching = true;
      setTimeout(() => {
        allowNativeClick = true;
        btnStart.click();
        allowNativeClick = false;
      }, REDUCED ? 0 : TAP_ANIM_MS);
    }
  }, true);   /* capture : passe avant le listener d'ar.js */

  btnStart.addEventListener("pointerdown", (e) => {
    if (launching || e.button > 0) return;
    holding = true; holdDone = false;
    holdStart = performance.now();
    try { btnStart.setPointerCapture(e.pointerId); } catch {}
  });
  const endHold = () => {
    if (!holding) return;
    holding = false;
    if (!holdDone) setHold(0);   /* relâché avant la fin → jauge retombe */
  };
  btnStart.addEventListener("pointerup", endHold);
  btnStart.addEventListener("pointercancel", endHold);
  btnStart.addEventListener("lostpointercapture", endHold);
  /* Évite le menu contextuel pendant le maintien long */
  btnStart.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ───────────────────────── 6. Boucle rAF unique + pause intelligente ───────────────────────── */
let rafId = null, lastT = 0, landingVisible = !landing.hidden;

function frame(t) {
  rafId = null;
  const dt = Math.min(50, t - lastT || 16.7);
  lastT = t;

  if (!REDUCED) {
    applyParallax();
    stepParticles(dt);
  }
  /* Jauge du sceau pendant le maintien */
  if (holding && !holdDone) {
    const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
    setHold(p);
    if (p >= 1) { holding = false; launchSeal(); }
  }
  if (landingVisible && !document.hidden) rafId = requestAnimationFrame(frame);
}

function startLoop() {
  if (rafId == null && landingVisible && !document.hidden) {
    lastT = performance.now();
    rafId = requestAnimationFrame(frame);
  }
}
function stopLoop() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
}

/* ar.js met landing.hidden = true → on coupe tout */
new MutationObserver(() => {
  landingVisible = !landing.hidden;
  if (landingVisible) { resizeCanvas(); startLoop(); }
  else stopLoop();
}).observe(landing, { attributes: true, attributeFilter: ["hidden"] });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLoop(); else startLoop();
});

/* En reduced-motion : tout est statique, mais une frame pour peaufiner les tailles */
if (REDUCED && ctx) { resizeCanvas(); }
startLoop();
