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
  const H = 0.95;                       // hauteur du personnage
  const RATIO = 857 / 1800;             // ratio de l'illustration source
  const W = H * RATIO;

  // Chaque couche est un plan plein-cadre (même UV que l'image entière),
  // ne montrant que sa tranche grâce à la transparence pré-découpée.
  // On les décale en Z pour créer la profondeur (parallaxe quand on bouge le tel).
  const loader = new THREE.TextureLoader();
  const layers = [];
  const makeLayer = (file, z, renderOrder) => {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, side: THREE.DoubleSide,
      alphaTest: 0.02, depthTest: false, depthWrite: false, opacity: 1,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
    mesh.position.set(0, H / 2, z);
    mesh.renderOrder = renderOrder;
    g.add(mesh);
    loader.load(file, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; mat.map = tex; mat.needsUpdate = true; });
    layers.push({ mesh, z0: z });
    return mesh;
  };

  // arrière → avant : corps/manteau, puis buste+bras+livre, puis tête
  let use25D = true;
  makeLayer("frederic-layer-body.png",  -0.02, 2);
  makeLayer("frederic-layer-torso.png",  0.02, 3);
  makeLayer("frederic-layer-head.png",   0.05, 4);

  // Filet de sécurité : si les couches n'existent pas, on charge l'image entière
  // sur un plan unique (et on masque les couches). Détecté via échec de la 1re couche.
  loader.load(
    "frederic.png",
    () => { /* image complète dispo : on la garde en réserve, les couches priment si chargées */ },
    undefined,
    () => { use25D = false; }
  );

  // Ombre elliptique plaquée sur la couverture
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.26, 28),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2.2;
  shadow.position.set(0, -0.01, 0.02);
  shadow.scale.set(1, 0.5, 1);
  shadow.renderOrder = 1;
  g.add(shadow);

  // plane = la couche du milieu (pour la pulsation "parle"), layers = pour la parallaxe
  g.userData = { plane: layers[1]?.mesh, layers, shadow, billboard: true, is25D: true };
  return g;
}

/* Halo radial doré (dégradé transparent) pour l'aura magique derrière Frédéric */
function makeHaloTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0, "rgba(255,210,120,0.9)");
  g.addColorStop(0.4, "rgba(245,185,66,0.35)");
  g.addColorStop(1, "rgba(245,185,66,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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

  // Anneau doré scintillant, à plat sur la couverture (le cercle magique du livre)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.52, 48),
    new THREE.MeshBasicMaterial({ color: 0xf5b942, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.position.set(0, -0.12, 0.01);   // au niveau des pieds, dans le plan de la couverture
  ring.renderOrder = 1;
  anchorGroup.add(ring);
  anchorGroup.userData.ring = ring;

  // Halo lumineux doux DERRIÈRE Frédéric (disque dégradé) — donne l'aura magique
  const haloTex = makeHaloTexture();
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  halo.position.set(0, 0.28, -0.02);   // derrière le personnage
  halo.renderOrder = 0;
  anchorGroup.add(halo);
  anchorGroup.userData.halo = halo;

  frederic = buildFrederic();
  frederic.scale.setScalar(0.001);       // il apparaîtra en grandissant
  anchorGroup.add(frederic);

  particles = buildParticles();
  anchorGroup.add(particles);

  // Si un vrai modèle GLB existe (frederic.glb), il remplace le personnage 2.5D.
  new GLTFLoader().load(GLB_FILE, (gltf) => {
    const model = gltf.scene;

    // 1) Normaliser la taille : Tripo/Meshy exportent à des échelles très variables.
    //    On mesure la bounding box et on ramène la hauteur à ~1 unité (= même repère que la 2.5D).
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const targetH = 1.0;
    const s = size.y > 0 ? targetH / size.y : 1;
    model.scale.setScalar(s);

    // 2) Recentrer horizontalement et poser les pieds au sol (y=0).
    model.position.x = -center.x * s;
    model.position.z = -center.z * s;
    model.position.y = -box.min.y * s;

    // 3) Enrober dans un groupe pour garder les mêmes userData/animation que la 2.5D.
    const wrap = new THREE.Group();
    wrap.add(model);
    wrap.userData = { model, glb: true, is3D: true };

    anchorGroup.remove(frederic);
    frederic = wrap;
    frederic.scale.setScalar(0.001);   // apparaîtra en grandissant
    anchorGroup.add(frederic);

    // 4) Animations : joue "idle" en priorité, sinon la première dispo.
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(model);
      const idle = gltf.animations.find((a) => /idle|breath|stand/i.test(a.name)) || gltf.animations[0];
      mixer.clipAction(idle).play();
    }
    revealT = Math.max(revealT, 0);   // relance l'apparition avec le modèle 3D
  }, undefined, () => { /* pas de GLB : la 2.5D reste — parfait */ });
}

/* ─────────────────────────── Animation ─────────────────────────── */
function tick(dt, t) {
  const u = frederic?.userData;

  // ── Apparition : Frédéric ÉMERGE du livre (monte, grandit, flash de lumière) ──
  if (revealT >= 0 && revealT < 1) {
    revealT = Math.min(1, revealT + dt / 1.6);
    const e = 1 - Math.pow(1 - revealT, 3);      // ease-out cubic
    if (u?.billboard) {
      // sort du livre : part enfoncé/écrasé, puis se dresse à sa taille
      frederic.scale.set(1, 0.05 + e * 0.95, 1);
      frederic.position.y = -0.35 * (1 - e);     // remonte depuis la couverture
      if (u.layers) for (const L of u.layers) L.mesh.material.opacity = e;  // fondu de toutes les couches
      else if (u.plane) u.plane.material.opacity = e;
    } else {
      frederic.scale.setScalar(0.001 + e * 1.0);
      frederic.rotation.y = (1 - e) * Math.PI * 2; // le GLB tournoie
    }
    // flash de lumière chaude au moment de l'émergence
    const a0 = anchorGroup?.userData;
    if (a0?.warm) a0.warm.intensity = 2 + (1 - e) * 6;
    if (particles) particles.material.size = 0.035 + (1 - e) * 0.12;
  }

  // ── Vie du personnage illustré : respire, se balance, "parle" ──
  if (u?.billboard && revealT >= 1) {
    const bob = Math.sin(t * 1.6) * 0.014;                 // respiration
    const sway = Math.sin(t * 0.9) * 0.025;                // balancement doux
    frederic.position.y = bob;
    frederic.scale.set(1, 1, 1);
    frederic.rotation.z = sway;
    frederic.rotation.y = Math.sin(t * 0.4) * 0.06;

    // ── Parallaxe 2.5D : chaque couche se décale selon l'angle de vue ──
    // Les couches avant (tête) bougent plus que les couches arrière (corps) = profondeur.
    if (u.layers && camera) {
      // direction caméra relative au personnage (approx via sa position monde)
      const camX = camera.position.x, camY = camera.position.y;
      for (const L of u.layers) {
        const depth = L.z0;                    // plus la couche est en avant, plus elle réagit
        const px = camX * depth * 0.35 + Math.sin(t * 1.2) * depth * 0.4;
        const py = bob * depth * 6 + Math.sin(t * 1.6 + depth * 10) * depth * 0.3;
        L.mesh.position.x = px;
        L.mesh.position.y = (0.95 / 2) + py;
      }
    }

    if (talking) {
      frederic.position.y = bob + Math.abs(Math.sin(t * 9)) * 0.03;
      // la tête (dernière couche) rebondit un peu plus = il "parle" avec vie
      if (u.layers?.length) {
        const head = u.layers[u.layers.length - 1].mesh;
        head.position.y += Math.abs(Math.sin(t * 11)) * 0.012;
      }
    }
    if (u.shadow) u.shadow.material.opacity = 0.26 - Math.abs(bob) * 4;
  }
  if (mixer) mixer.update(dt);

  // ── Ambiance : flamme de chandelle + halo scintillant sur le livre ──
  const a = anchorGroup?.userData;
  if (a?.warm && revealT >= 1) a.warm.intensity = 2.2 + Math.sin(t * 7) * 0.35 + Math.sin(t * 13) * 0.15;
  if (a?.ring) {
    a.ring.rotation.z = t * 0.35;
    // halo qui scintille : opacité + échelle pulsées, double fréquence = "sparkle"
    const twinkle = 0.4 + Math.sin(t * 2.2) * 0.18 + Math.sin(t * 5.7) * 0.1;
    a.ring.material.opacity = Math.max(0.15, twinkle);
    a.ring.scale.setScalar(1 + Math.sin(t * 1.8) * 0.04);
  }
  if (a?.halo) {
    a.halo.rotation.z = -t * 0.5;
    a.halo.material.opacity = 0.18 + Math.abs(Math.sin(t * 1.5)) * 0.16;
  }
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

  // MindAR : le repère de l'ancre est aligné sur la couverture (X droite, Y haut de la page, Z vers la caméra).
  // Pour un "cut-out" qui se DRESSE sur le livre et fait face au lecteur, on garde le plan
  // vertical (surtout pas de bascule à plat) et on l'incline juste un peu vers l'arrière.
  anchorGroup.rotation.x = 0.3;               // léger recul du haut (comme un chevalet posé)
  anchorGroup.scale.setScalar(2.7);           // Frédéric ~3× plus grand, il domine la scène
  anchorGroup.position.set(0, -0.35, 0.05);   // pieds ancrés vers le bas de la couverture
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
