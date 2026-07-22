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

/* ─────────────────────────── Personnage procédural ─────────────────────────── */
function buildFrederic() {
  const g = new THREE.Group();
  const M = (color, opts = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...opts });

  const bleu = M(0x1f4d7a), bleuNuit = M(0x16385c), jaune = M(0xe8c76a);
  const peau = M(0xf0c8a0), cheveux = M(0x9a4f22), brun = M(0x3a2a1c);
  const blanc = M(0xf3e9d2), noir = M(0x1a1a1a), cuir = M(0x5c3a22);
  const livre = M(0x7e2b20), page = M(0xf3e9d2, { roughness: 0.9 });

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = g) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    parent.add(m); return m;
  };

  // Jambes + bottes
  add(new THREE.CylinderGeometry(0.055, 0.065, 0.42, 10), brun, -0.075, 0.21, 0);
  add(new THREE.CylinderGeometry(0.055, 0.065, 0.42, 10), brun,  0.075, 0.21, 0);
  add(new THREE.BoxGeometry(0.11, 0.07, 0.19), cuir, -0.075, 0.035, 0.03);
  add(new THREE.BoxGeometry(0.11, 0.07, 0.19), cuir,  0.075, 0.035, 0.03);

  // Torse : gilet jaune + chemise
  const torso = add(new THREE.CylinderGeometry(0.13, 0.155, 0.34, 12), jaune, 0, 0.59, 0);
  add(new THREE.CylinderGeometry(0.065, 0.075, 0.1, 10), blanc, 0, 0.79, 0);
  // Cravate noire
  add(new THREE.BoxGeometry(0.05, 0.12, 0.02), noir, 0, 0.72, 0.125);

  // Redingote : deux pans + dos
  add(new THREE.CylinderGeometry(0.145, 0.19, 0.36, 12, 1, true, Math.PI * 0.62, Math.PI * 1.76), bleu, 0, 0.58, -0.005);
  const panL = add(new THREE.BoxGeometry(0.075, 0.34, 0.03), bleuNuit, -0.1, 0.28, -0.055, 0.12, 0, 0.08);
  const panR = add(new THREE.BoxGeometry(0.075, 0.34, 0.03), bleuNuit,  0.1, 0.28, -0.055, 0.12, 0, -0.08);
  // Col
  add(new THREE.TorusGeometry(0.085, 0.022, 8, 14, Math.PI), bleuNuit, 0, 0.77, 0.01, Math.PI * 0.5, 0, 0);

  // Tête + visage
  const head = new THREE.Group(); head.position.set(0, 0.92, 0); g.add(head);
  add(new THREE.SphereGeometry(0.105, 18, 14), peau, 0, 0, 0, 0, 0, 0, head);
  // Chevelure rousse ébouriffée
  add(new THREE.SphereGeometry(0.112, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), cheveux, 0, 0.022, -0.012, -0.15, 0, 0, head);
  add(new THREE.SphereGeometry(0.045, 8, 6), cheveux, -0.08, 0.06, 0.02, 0, 0, 0, head);
  add(new THREE.SphereGeometry(0.045, 8, 6), cheveux,  0.08, 0.055, 0.03, 0, 0, 0, head);
  add(new THREE.SphereGeometry(0.04, 8, 6), cheveux, 0, 0.1, 0.05, 0, 0, 0, head);
  // Favoris (rouflaquettes d'époque !)
  add(new THREE.BoxGeometry(0.02, 0.07, 0.03), cheveux, -0.098, -0.02, 0.02, 0, 0, 0.1, head);
  add(new THREE.BoxGeometry(0.02, 0.07, 0.03), cheveux,  0.098, -0.02, 0.02, 0, 0, -0.1, head);
  // Yeux + sourire
  add(new THREE.SphereGeometry(0.011, 8, 6), noir, -0.038, 0.012, 0.098, 0, 0, 0, head);
  add(new THREE.SphereGeometry(0.011, 8, 6), noir,  0.038, 0.012, 0.098, 0, 0, 0, head);
  const mouth = add(new THREE.TorusGeometry(0.024, 0.006, 6, 10, Math.PI), M(0xa05a48), 0, -0.045, 0.095, Math.PI, 0, 0, head);

  // Bras gauche : tient le livre ouvert
  const armL = new THREE.Group(); armL.position.set(-0.15, 0.72, 0); g.add(armL);
  add(new THREE.CylinderGeometry(0.035, 0.03, 0.24, 8), bleu, -0.03, -0.1, 0.09, 0.9, 0, 0.5, armL);
  const book = new THREE.Group(); book.position.set(-0.02, -0.16, 0.22); book.rotation.set(-0.5, 0.15, 0); armL.add(book);
  add(new THREE.BoxGeometry(0.16, 0.02, 0.12), livre, 0, 0, 0, 0, 0, 0, book);
  add(new THREE.BoxGeometry(0.15, 0.012, 0.11), page, 0, 0.014, 0, 0, 0, 0.06, book);

  // Bras droit : plume levée
  const armR = new THREE.Group(); armR.position.set(0.15, 0.72, 0); g.add(armR);
  add(new THREE.CylinderGeometry(0.035, 0.03, 0.22, 8), bleu, 0.04, -0.08, 0.08, 0.7, 0, -0.7, armR);
  const quill = new THREE.Group(); quill.position.set(0.1, -0.13, 0.18); armR.add(quill);
  add(new THREE.ConeGeometry(0.018, 0.16, 6), blanc, 0, 0.08, 0, 0, 0, 0.25, quill);
  add(new THREE.CylinderGeometry(0.004, 0.004, 0.05, 5), cuir, 0.012, -0.02, 0, 0, 0, 0.25, quill);

  g.userData = { head, mouth, armR, panL, panR };
  g.scale.setScalar(1.15);
  return g;
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
  // Apparition magique
  if (revealT >= 0 && revealT < 1) {
    revealT = Math.min(1, revealT + dt / 1.4);
    const e = 1 - Math.pow(1 - revealT, 3);      // ease-out cubic
    frederic.scale.setScalar(0.001 + e * 1.149);
    frederic.rotation.y = (1 - e) * Math.PI * 2;
    if (particles) particles.material.size = 0.035 + (1 - e) * 0.09;
  }

  // Vie du personnage procédural
  const u = frederic?.userData;
  if (u?.head) {
    frederic.position.y = Math.sin(t * 1.6) * 0.012;              // respiration
    u.head.rotation.y = Math.sin(t * 0.6) * 0.22;                 // regarde autour
    u.head.rotation.x = Math.sin(t * 0.9) * 0.05;
    u.armR.rotation.z = Math.sin(t * 1.1) * 0.12;                 // plume vivante
    u.panL.rotation.x = 0.12 + Math.sin(t * 1.4) * 0.04;          // pans au vent
    u.panR.rotation.x = 0.12 + Math.cos(t * 1.3) * 0.04;
    if (talking) {
      u.mouth.scale.y = 0.6 + Math.abs(Math.sin(t * 14)) * 1.4;   // bouche animée
      u.head.rotation.z = Math.sin(t * 5) * 0.04;
      u.armR.rotation.x = Math.sin(t * 4) * 0.2;                  // gestes
    } else {
      u.mouth.scale.y = 1;
    }
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
  anchorGroup.rotation.x = -Math.PI / 2 * 0;   // MindAR : le plan cible est déjà orienté

  anchor.onTargetFound = () => {
    scanGuide.hidden = true;
    if (revealT < 0) {
      revealT = 0;
      fredericSpeaks("Oh ! Bonjour toi ! Je suis Frédéric. Appuie sur le sceau rouge et pose-moi ta question !");
    }
  };
  anchor.onTargetLost = () => { scanGuide.hidden = false; };

  await mindar.start();
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
