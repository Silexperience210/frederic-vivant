/* ═══════════════════════════════════════════════════════════════
   Frédéric Vivant — moteur AR
   - Mode LIVRE  : tracking d'image MindAR sur la couverture (targets/frederic.mind)
   - Mode DÉMO   : caméra + scène flottante, sans marqueur (tant que le .mind
                   n'est pas compilé, ou pour montrer l'app sans le livre)
   - Frédéric    : personnage 3D procédural (redingote bleue, gilet jaune,
                   livre + plume) avec animations idle / salut / parole.
                   Si public/frederic.glb existe, il remplace automatiquement
                   le personnage procédural (rig Mixamo supporté).
   ═══════════════════════════════════════════════════════════════ */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { initChat, fredericSpeaks } from "./chat.js";

const TARGET_FILE = "targets/frederic.mind";
const GLB_FILE = "frederic.glb";

const $ = (id) => document.getElementById(id);
const landing = $("landing"), stage = $("ar-stage"), scanGuide = $("scan-guide");

let renderer, scene, camera, clock;
let frederic;                 // groupe du personnage
let mixer = null;             // si GLB animé
let anchorGroup;              // groupe attaché au marqueur (ou au monde en démo)
let particles;                // système de particules "flammes de chandelle"
let revealT = -1;             // progression de l'apparition magique
let talking = false;
let bookMode = false;         // true = ancré au livre (pas de billboard total)

/* ─────────────────────────── Personnage procédural ─────────────────────────── */
/* Frédéric = billboard illustré (l'illustration du livre, façon conte animé "cut-out").
   Utilise public/frederic.png (l'illustration détourée sur fond transparent).
   Si l'image manque, on garde un fallback procédural simple. */
function buildFrederic() {
  const g = new THREE.Group();

  // Le plan qui portera l'illustration
  const W = 0.62, H = 0.95;
  const geo = new THREE.PlaneGeometry(W, H);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, side: THREE.DoubleSide,
    alphaTest: 0.5, opacity: 1,
  });
  const plane = new THREE.Mesh(geo, mat);
  plane.position.y = H / 2;          // pose les pieds au sol
  plane.renderOrder = 2;             // toujours rendu au-dessus de la couverture
  mat.depthTest = false;             // pas de conflit de profondeur avec le livre
  g.add(plane);

  // Ombre douce au sol
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  shadow.scale.set(1, 0.6, 1);
  g.add(shadow);

  // Charge l'illustration
  new THREE.TextureLoader().load(
    "frederic.png",
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      // ajuste le ratio du plan à l'image réelle
      const ratio = tex.image.width / tex.image.height;
      plane.geometry.dispose();
      plane.geometry = new THREE.PlaneGeometry(H * ratio, H);
      mat.map = tex;
      mat.needsUpdate = true;
    },
    undefined,
    () => {
      // Pas d'illustration : petit fallback coloré (mieux que rien, en attendant frederic.png)
      mat.map = makeFallbackTexture();
      mat.needsUpdate = true;
    }
  );

  g.userData = { plane, shadow, billboard: true };
  return g;
}

/* Texture de secours dessinée sur un canvas : une silhouette d'époque stylisée
   (redingote bleue, gilet jaune) — utilisée seulement si frederic.png est absent. */
function makeFallbackTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 384;
  const x = c.getContext("2d");
  // redingote
  x.fillStyle = "#1f4d7a";
  x.beginPath();
  x.moveTo(128, 70); x.lineTo(196, 130); x.lineTo(180, 340); x.lineTo(76, 340); x.lineTo(60, 130);
  x.closePath(); x.fill();
  // gilet jaune
  x.fillStyle = "#e8c76a";
  x.beginPath(); x.moveTo(128, 110); x.lineTo(160, 150); x.lineTo(150, 250); x.lineTo(106, 250); x.lineTo(96, 150); x.closePath(); x.fill();
  // tête
  x.fillStyle = "#f0c8a0"; x.beginPath(); x.arc(128, 60, 34, 0, Math.PI * 2); x.fill();
  // cheveux roux
  x.fillStyle = "#9a4f22"; x.beginPath(); x.arc(128, 46, 36, Math.PI, 0); x.fill();
  // cravate
  x.fillStyle = "#1a1a1a"; x.fillRect(122, 96, 12, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ─────────────────────── Particules : flammes de chandelle ─────────────────────── */
function buildParticles() {
  const N = 90;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, r = 0.12 + Math.random() * 0.3;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * 1.1;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = Math.random();
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.PointsMaterial({
    color: 0xf5b942, size: 0.035, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

function animateParticles(t) {
  if (!particles) return;
  const pos = particles.geometry.attributes.position;
  const seed = particles.geometry.attributes.seed;
  for (let i = 0; i < pos.count; i++) {
    const s = seed.getX(i);
    let y = pos.getY(i) + 0.0035 + s * 0.003;
    if (y > 1.25) y = 0;
    pos.setY(i, y);
    pos.setX(i, pos.getX(i) + Math.sin(t * 1.8 + s * 20) * 0.0007);
  }
  pos.needsUpdate = true;
  particles.material.opacity = 0.55 + Math.sin(t * 3) * 0.2;
}

/* ─────────────────────────── Scène commune ─────────────────────────── */
function buildSceneContent(parent) {
  anchorGroup = new THREE.Group();
  parent.add(anchorGroup);

  // Lumière de chandelle : chaude, vivante
  const warm = new THREE.PointLight(0xffc36b, 2.4, 6); warm.position.set(0.4, 1.2, 0.8);
  const fill = new THREE.AmbientLight(0x8898c8, 0.9);
  const rim = new THREE.DirectionalLight(0xf5b942, 1.2); rim.position.set(-1, 2, -1);
  anchorGroup.add(warm, fill, rim);
  anchorGroup.userData.warm = warm;

  // Anneau doré au sol (le cercle magique du livre)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.5, 48),
    new THREE.MeshBasicMaterial({ color: 0xf5b942, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.005;
  anchorGroup.add(ring);
  anchorGroup.userData.ring = ring;

  frederic = buildFrederic();
  frederic.scale.setScalar(0.001);       // il apparaîtra en grandissant
  anchorGroup.add(frederic);

  particles = buildParticles();
  anchorGroup.add(particles);

  // Si un vrai modèle GLB existe, on remplace le personnage procédural
  new GLTFLoader().load(GLB_FILE, (gltf) => {
    anchorGroup.remove(frederic);
    frederic = gltf.scene;
    frederic.scale.setScalar(0.001);
    anchorGroup.add(frederic);
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(frederic);
      mixer.clipAction(gltf.animations[0]).play();
    }
  }, undefined, () => { /* pas de GLB : le personnage procédural reste — parfait */ });
}

/* ─────────────────────────── Animation ─────────────────────────── */
function tick(dt, t) {
  const u = frederic?.userData;

  // Apparition magique
  if (revealT >= 0 && revealT < 1) {
    revealT = Math.min(1, revealT + dt / 1.4);
    const e = 1 - Math.pow(1 - revealT, 3);      // ease-out cubic
    frederic.scale.setScalar(0.001 + e * 1.0);
    if (!u?.billboard) frederic.rotation.y = (1 - e) * Math.PI * 2;  // le GLB tournoie
    if (particles) particles.material.size = 0.035 + (1 - e) * 0.09;
  }

  // Vie du billboard illustré : respire, se balance, "parle"
  if (u?.billboard) {
    const bob = Math.sin(t * 1.6) * 0.014;                 // respiration verticale
    const sway = Math.sin(t * 0.9) * 0.03;                 // léger balancement
    frederic.position.y = bob;
    u.plane.rotation.z = sway;

    if (bookMode) {
      // Ancré au livre : Fred reste PLANTÉ debout sur la couverture, il ne pivote pas.
      // On le laisse regarder à peine à gauche/droite pour la vie, sans casser l'ancrage.
      frederic.rotation.y = Math.sin(t * 0.5) * 0.12;
    } else if (camera) {
      // Mode démo (flottant) : billboard doux face à la caméra
      const target = Math.atan2(camera.position.x - frederic.position.x,
                                camera.position.z - frederic.position.z);
      frederic.rotation.y += (target - frederic.rotation.y) * 0.08;
    }

    // parle : petit rebond énergique + pulsation d'échelle
    if (talking) {
      frederic.position.y = bob + Math.abs(Math.sin(t * 9)) * 0.03;
      const p = 1 + Math.sin(t * 9) * 0.02;
      u.plane.scale.set(p, 1 / p, 1);
    } else {
      u.plane.scale.set(1, 1, 1);
    }
    if (u.shadow) u.shadow.material.opacity = 0.28 - Math.abs(bob) * 4;
  }
  if (mixer) mixer.update(dt);

  const a = anchorGroup?.userData;
  if (a?.warm) a.warm.intensity = 2.2 + Math.sin(t * 7) * 0.35 + Math.sin(t * 13) * 0.15; // flamme
  if (a?.ring) { a.ring.rotation.z = t * 0.3; a.ring.material.opacity = 0.35 + Math.sin(t * 2) * 0.15; }
  animateParticles(t);
}

/* ─────────────────────────── Mode LIVRE (MindAR) ─────────────────────────── */
async function startBookMode() {
  const { MindARThree } = await import("mindar-image-three");
  const mindar = new MindARThree({
    container: $("ar-container"),
    imageTargetSrc: TARGET_FILE,
    uiScanning: "no", uiLoading: "no",
  });
  ({ renderer, scene, camera } = mindar);
  const anchor = mindar.addAnchor(0);
  buildSceneContent(anchor.group);

  // MindAR : le repère de l'ancre a le plan du livre dans le plan XY (Z sort de la couverture).
  // On redresse tout le groupe de -90° sur X pour que "debout" pointe hors de la page,
  // et que le sol du personnage coïncide avec la surface du livre.
  anchorGroup.rotation.x = -Math.PI / 2;

  // Taille & position relatives à la cible (la largeur cible MindAR = 1 unité).
  // Fred fait ~0.85 de haut = il domine gentiment la couverture sans la masquer,
  // posé légèrement vers le haut du livre pour laisser voir le titre.
  anchorGroup.scale.setScalar(0.85);
  anchorGroup.position.set(0, 0.12, 0);
  bookMode = true;

  anchor.onTargetFound = () => {
    scanGuide.hidden = true;
    if (revealT < 0) {
      revealT = 0;
      fredericSpeaks("Oh ! Bonjour toi ! Je suis Frédéric. Appuie sur le sceau rouge et pose-moi ta question !");
    }
  };
  anchor.onTargetLost = () => { scanGuide.hidden = false; };

  await mindar.start();

  // MindAR applique des styles inline qui laissent des bandes noires : on force le plein écran.
  const fill = () => {
    $("ar-container").querySelectorAll("video, canvas").forEach((el) => {
      el.style.position = "absolute";
      el.style.left = "50%";
      el.style.top = "50%";
      el.style.transform = "translate(-50%, -50%)";
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "cover";
      el.style.maxWidth = "none";
      el.style.maxHeight = "none";
    });
  };
  fill();
  setTimeout(fill, 300);
  setTimeout(fill, 1000);
  addEventListener("resize", fill);

  runLoop();
}

/* ─────────────────────────── Mode DÉMO (sans marqueur) ─────────────────────────── */
async function startDemoMode() {
  const container = $("ar-container");

  // Flux caméra en fond
  const video = document.createElement("video");
  video.setAttribute("playsinline", ""); video.muted = true;
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }, audio: false,
    });
    await video.play();
    Object.assign(video.style, { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" });
    container.appendChild(video);
  } catch { container.style.background = "radial-gradient(circle at 50% 70%, #3A2A18, #0E1526)"; }

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  Object.assign(renderer.domElement.style, { position: "absolute", inset: 0 });
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.01, 20);
  camera.position.set(0, 0.75, 1.9);
  camera.lookAt(0, 0.55, 0);

  buildSceneContent(scene);
  scanGuide.hidden = true;
  revealT = 0;
  fredericSpeaks("Bonjour ! Je suis Frédéric Bastiat. Pose-moi une question en appuyant sur le sceau rouge !");

  // Légère parallaxe au gyroscope
  addEventListener("deviceorientation", (e) => {
    if (e.gamma == null) return;
    camera.position.x = THREE.MathUtils.clamp(e.gamma / 90, -0.3, 0.3);
    camera.lookAt(0, 0.55, 0);
  });
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  runLoop();
}

function runLoop() {
  clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta(), t = clock.elapsedTime;
    tick(dt, t);
    renderer.render(scene, camera);
  });
}

/* ─────────────────────────── Lancement ─────────────────────────── */
async function launch(mode) {
  landing.hidden = true;
  stage.hidden = false;
  initChat({ onTalkingChange: (v) => (talking = v) });
  try {
    if (mode === "book") await startBookMode();
    else await startDemoMode();
  } catch (err) {
    console.error(err);
    if (mode === "book") {
      // .mind absent ou tracking indisponible → bascule douce en démo
      fredericSpeaks("Le marqueur du livre n'est pas encore prêt sur ce serveur, je viens quand même te voir !");
      await startDemoMode();
    }
  }
}

$("btn-start").addEventListener("click", () => launch("book"));
$("btn-demo").addEventListener("click", () => launch("demo"));
$("btn-quit").addEventListener("click", () => location.reload());
