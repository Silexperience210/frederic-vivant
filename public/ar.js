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
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { initChat, fredericSpeaks } from "./chat.js";

const TARGET_FILE = "targets/frederic.mind";
const GLB_FILE = "frederic.glb";

const $ = (id) => document.getElementById(id);
const landing = $("landing"), stage = $("ar-stage"), scanGuide = $("scan-guide");

let renderer, scene, camera, clock;
let frederic;                 // groupe du personnage
let mixer = null;             // si GLB animé
let anchorGroup;              // groupe attaché au marqueur (ou au monde en démo)
let charPivot;                // pivot du personnage + FX "debout" (pivoté seulement en mode livre)
// Angle de redressement en mode livre : l'ancre MindAR a la couverture en XY local
// et sa normale en +Z. Le contenu "debout" du code est Y-up (monde démo).
// Rx(+90°) envoie +Y (haut du personnage) → +Z (hors de la couverture = debout)
// et +Z (face du personnage) → -Y (bas de la page = vers le lecteur).
// NB : -90° mettrait le personnage SOUS la couverture (Y → -Z).
const BOOK_CHAR_ROT_X = Math.PI / 2;
let particles;                // système de particules "flammes de chandelle"
let revealT = -1;             // progression de l'apparition magique
let talking = false;
let prevTalking = false;        // détection du front montant de `talking`
let greetT = -10;               // temps du début de parole (geste de salutation)
let bookMode = false;         // true = ancré au livre (pas de billboard total)

/* ─────────────────── Rendu 3D relief (depth-displacement mesh) ───────────────────
   Charge frederic-depth.png (blanc = proche) et déplace les vertices d'un plan
   finement tessellé en Z : l'illustration devient un vrai relief qui reçoit les
   lumières de la scène (MeshStandardMaterial). Retourne une Promise<Mesh|null>. */
function buildFrederic3D(g, W, H) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        // 1) Échantillonne la depth map dans un canvas (downscale raisonnable)
        const DW = 176, DH = 82;              // ~1/10, largement assez pour 96x160 segments
        const cv = document.createElement("canvas");
        cv.width = DW; cv.height = DH;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0, DW, DH);
        const data = cx.getImageData(0, 0, DW, DH).data;
        const depthAt = (u, v) => {           // u,v ∈ [0,1], v=0 = haut de l'image
          const px = Math.min(DW - 1, Math.max(0, Math.round(u * (DW - 1))));
          const py = Math.min(DH - 1, Math.max(0, Math.round(v * (DH - 1))));
          return data[(py * DW + px) * 4] / 255;   // grayscale : canal R
        };

        // 1b) Charge l'image couleur en parallèle pour lire son alpha :
        //     les zones quasi transparentes ne doivent PAS être déplacées
        //     (sinon les pixels de bord semi-transparents "drippent" vers l'extérieur).
        const colorImg = new Image();
        const finish = (alphaAt) => {
          // 2) Géométrie tessellée + displacement CPU
          const geo = new THREE.PlaneGeometry(W, H, 96, 160);
          const pos = geo.attributes.position;
          const uv = geo.attributes.uv;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i);
            const uu = uv.getX(i), vv = 1 - uv.getY(i);
            let d = depthAt(uu, vv);
            // alpha faible → contour : on neutralise le displacement (plan plat)
            if (alphaAt && alphaAt(uu, vv) < 0.3) d = 0;
            // relief + léger bombé cylindrique (effet figurine)
            pos.setZ(i, d * 0.18 + (x * x) * 0.02);
            // inset UV ~2% pour éviter les franges transparentes étirées aux bords
            uv.setXY(i, 0.02 + uv.getX(i) * 0.96, 0.02 + uv.getY(i) * 0.96);
          }
          pos.needsUpdate = true;
          uv.needsUpdate = true;
          geo.computeVertexNormals();

          // 2b) Animation de vertices : positions de base + poids par zones.
          //     v = fraction de hauteur depuis le bas de l'image (0 pieds, 1 tête).
          //     NB : on recalcule u/v depuis la position (l'UV a été inset à 2%).
          const n = pos.count;
          const basePos = pos.array.slice();
          const wHead = new Float32Array(n), wBook = new Float32Array(n),
                wQuill = new Float32Array(n), wTorso = new Float32Array(n),
                wCoat = new Float32Array(n), uArr = new Float32Array(n);
          const gauss = (u, cu, su, v, cv, sv) => {
            const du = (u - cu) / su, dv = (v - cv) / sv;
            return Math.exp(-0.5 * (du * du + dv * dv));
          };
          for (let i = 0; i < n; i++) {
            const uu = basePos[i * 3] / W + 0.5;
            const vv = basePos[i * 3 + 1] / H + 0.5;   // 0 bas, 1 haut
            uArr[i] = uu;
            wHead[i]  = gauss(uu, 0.52, 0.16, vv, 0.915, 0.07);   // tête
            wBook[i]  = gauss(uu, 0.55, 0.14, vv, 0.645, 0.08);   // livre + main
            wQuill[i] = gauss(uu, 0.40, 0.07, vv, 0.665, 0.06);   // main à la plume
            wTorso[i] = gauss(uu, 0.45, 0.22, vv, 0.70, 0.14);    // torse (large)
            // bas du manteau : bande verticale 0.15–0.45, bords latéraux (tissu libre)
            const vMask = Math.min(1, Math.max(0, (vv - 0.15) / 0.04)) *
                          Math.min(1, Math.max(0, (0.45 - vv) / 0.04));
            const sideMask = Math.min(1, Math.max(0, (Math.abs(uu - 0.44) - 0.10) / 0.06));
            wCoat[i] = vMask * sideMask;
          }
          geo.userData.anim = { basePos, wHead, wBook, wQuill, wTorso, wCoat, uArr, H };

          // 3) Matériau éclairé : l'illustration s'auto-éclaire (emissive = texture)
          //    pour garder ses couleurs d'origine, tout en recevant la lumière
          //    chaude de la scène qui accentue le relief.
          const mat = new THREE.MeshStandardMaterial({
            transparent: true, side: THREE.DoubleSide,
            alphaTest: 0.35,                     // coupe les pixels semi-transparents des contours
            roughness: 0.7, metalness: 0.0,
            emissive: 0xffffff, emissiveIntensity: 0.55,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(0, H / 2, 0);
          new THREE.TextureLoader().load("frederic.png", (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            mat.map = tex; mat.emissiveMap = tex; mat.needsUpdate = true;
          });
          g.add(mesh);
          resolve(mesh);
        };
        colorImg.onload = () => {
          try {
            const ac = document.createElement("canvas");
            ac.width = DW; ac.height = DH;
            const ax = ac.getContext("2d", { willReadFrequently: true });
            ax.drawImage(colorImg, 0, 0, DW, DH);
            const adata = ax.getImageData(0, 0, DW, DH).data;
            const alphaAt = (u, v) => {
              const px = Math.min(DW - 1, Math.max(0, Math.round(u * (DW - 1))));
              const py = Math.min(DH - 1, Math.max(0, Math.round(v * (DH - 1))));
              return adata[(py * DW + px) * 4 + 3] / 255;   // canal alpha
            };
            finish(alphaAt);
          } catch { finish(null); }
        };
        colorImg.onerror = () => finish(null);
        colorImg.src = "frederic.png";
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);        // depth map absente → fallback 2.5D
    img.src = "frederic-depth.png";
  });
}

/* ─────────────────────────── Personnage procédural ─────────────────────────── */
/* Frédéric = billboard illustré (l'illustration du livre, façon conte animé "cut-out").
   Utilise public/frederic.png (l'illustration détourée sur fond transparent).
   Si l'image manque, on garde un fallback procédural simple. */
function buildFrederic() {
  const g = new THREE.Group();
  const H = 0.95;                       // hauteur du personnage
  const RATIO = 588 / 1641;             // ratio de l'illustration source (nouvelle version HD)
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

  // ── Rendu 3D relief prioritaire : si frederic-depth.png est présente,
  //    on remplace les couches 2.5D par un vrai mesh déplacé en profondeur.
  //    Sinon (échec de chargement), les couches 2.5D restent = fallback. ──
  buildFrederic3D(g, W, H).then((mesh) => {
    if (!mesh) return;                        // pas de depth map → 2.5D conservée
    const keepOpacity = layers[0]?.mesh.material.opacity ?? 1;  // fondu reveal éventuel
    for (const L of layers) { g.remove(L.mesh); L.mesh.geometry.dispose(); L.mesh.material.dispose(); }
    mesh.material.opacity = keepOpacity;
    g.userData.plane = mesh;
    g.userData.layers = null;                 // tick() : plus de parallaxe par couches
    g.userData.is25D = false;
    g.userData.is3DRelief = true;
  });
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

/* Texture d'étoile à 4 branches, dessinée sur canvas (aucun asset externe) */
function makeStarTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  const cx = 32, cy = 32;
  // croix à 4 branches effilées
  x.translate(cx, cy);
  const grad = x.createRadialGradient(0, 0, 0, 0, 0, 30);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,240,200,0.9)");
  grad.addColorStop(1, "rgba(255,220,150,0)");
  x.fillStyle = grad;
  x.beginPath(); x.arc(0, 0, 30, 0, Math.PI * 2); x.fill();
  // branches longues
  x.globalCompositeOperation = "lighter";
  for (let k = 0; k < 4; k++) {
    x.save();
    x.rotate((Math.PI / 2) * k);
    const b = x.createLinearGradient(0, 0, 0, -30);
    b.addColorStop(0, "rgba(255,255,240,0.95)");
    b.addColorStop(1, "rgba(255,255,240,0)");
    x.fillStyle = b;
    x.beginPath();
    x.moveTo(0, -30); x.lineTo(3.2, 0); x.lineTo(-3.2, 0);
    x.closePath(); x.fill();
    x.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ─────────────────── Poussière d'étoiles magique (GPU, ShaderMaterial) ─────────────────── */
let sparkBurst = null;        // étincelles explosives de l'apparition
let fireflies = null;         // lucioles + traînées
let talkBoost = 0;            // 0→1 quand Frédéric parle (intensifie la magie)

function buildParticles() {
  const N = 400;
  const geo = new THREE.BufferGeometry();
  // position = (rayon de base, hauteur de départ, inutilisé) — le mouvement est fait dans le shader
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N), speed = new Float32Array(N);
  const psize = new Float32Array(N), colMix = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = 0.16 + Math.random() * 0.3;          // rayon de la spirale
    pos[i * 3 + 1] = Math.random() * 1.25;            // hauteur initiale
    pos[i * 3 + 2] = Math.random() * Math.PI * 2;     // angle initial
    seed[i] = Math.random();
    speed[i] = 0.4 + Math.random() * 1.1;
    psize[i] = 0.02 + Math.random() * 0.035;
    colMix[i] = Math.random() < 0.82 ? Math.random() * 0.25 : 0.55 + Math.random() * 0.45; // or → bleuté
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  geo.setAttribute("speed", new THREE.BufferAttribute(speed, 1));
  geo.setAttribute("psize", new THREE.BufferAttribute(psize, 1));
  geo.setAttribute("colMix", new THREE.BufferAttribute(colMix, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uBoost: { value: 0 },
      uTex: { value: makeStarTexture() },
    },
    vertexShader: /* glsl */`
      attribute float seed; attribute float speed; attribute float psize; attribute float colMix;
      uniform float uTime; uniform float uBoost;
      varying float vTw; varying float vMix;
      void main() {
        float ang = position.z + uTime * speed * (0.5 + uBoost * 0.5);
        float r = position.x * (1.0 + 0.08 * sin(uTime * 1.3 + seed * 20.0));
        float y = mod(position.y + uTime * (0.05 + speed * 0.07) * (1.0 + uBoost * 0.6), 1.25);
        vec3 p = vec3(cos(ang) * r, y, sin(ang) * r);
        // scintillement par bruit sinusoïdal
        vTw = 0.5 + 0.5 * sin(uTime * (2.0 + seed * 6.0) + seed * 40.0);
        vTw *= 0.7 + 0.3 * sin(uTime * 7.3 + seed * 91.0);
        vMix = colMix;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = psize * (150.0 / -mv.z) * (0.75 + 0.5 * vTw) * (1.0 + uBoost * 0.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex; uniform float uBoost;
      varying float vTw; varying float vMix;
      void main() {
        vec4 tex = texture2D(uTex, gl_PointCoord);
        vec3 gold = vec3(1.0, 0.78, 0.35);
        vec3 blue = vec3(0.62, 0.75, 1.0);
        vec3 col = mix(gold, blue, vMix);
        gl_FragColor = vec4(col, tex.a * vTw * (0.75 + uBoost * 0.6));
      }`,
  });
  return new THREE.Points(geo, mat);
}

function animateParticles(t) {
  if (!particles) return;
  particles.material.uniforms.uTime.value = t;
  particles.material.uniforms.uBoost.value = talkBoost;
}

/* ─────────────── Étincelles explosives (burst d'apparition, CPU + gravité) ─────────────── */
function buildSparkBurst() {
  const N = 140;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.045, map: makeStarTexture(), transparent: true, opacity: 0,
    vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.visible = false;
  pts.userData = { vel: new Float32Array(N * 3), life: new Float32Array(N), active: false, t: 0 };
  return pts;
}

function triggerSparkBurst() {
  if (!sparkBurst) return;
  const u = sparkBurst.userData;
  const pos = sparkBurst.geometry.attributes.position.array;
  const col = sparkBurst.geometry.attributes.color.array;
  const N = u.life.length;
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;          // jaillit depuis la couverture (y≈0)
    const r = Math.random() * 0.14;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.02;
    pos[i * 3 + 2] = Math.sin(a) * r;
    const v = 0.5 + Math.random() * 0.9;
    const spread = 0.35 + Math.random() * 0.5;
    u.vel[i * 3] = Math.cos(a) * spread * v;
    u.vel[i * 3 + 1] = (0.8 + Math.random() * 1.1) * v;   // vers le haut
    u.vel[i * 3 + 2] = Math.sin(a) * spread * v;
    u.life[i] = 0.7 + Math.random() * 0.7;
    const blue = Math.random() < 0.2;
    col[i * 3] = blue ? 0.65 : 1.0;
    col[i * 3 + 1] = blue ? 0.75 : 0.8;
    col[i * 3 + 2] = blue ? 1.0 : 0.4;
  }
  sparkBurst.geometry.attributes.position.needsUpdate = true;
  sparkBurst.geometry.attributes.color.needsUpdate = true;
  sparkBurst.material.opacity = 1;
  sparkBurst.visible = true;
  u.active = true;
}

function updateSparkBurst(dt) {
  if (!sparkBurst?.userData.active) return;
  const u = sparkBurst.userData;
  const pos = sparkBurst.geometry.attributes.position.array;
  const col = sparkBurst.geometry.attributes.color.array;
  let alive = 0;
  for (let i = 0; i < u.life.length; i++) {
    if (u.life[i] <= 0) continue;
    u.life[i] -= dt;
    if (u.life[i] <= 0) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
    alive++;
    u.vel[i * 3 + 1] -= 1.6 * dt;                    // gravité
    pos[i * 3] += u.vel[i * 3] * dt;
    pos[i * 3 + 1] += u.vel[i * 3 + 1] * dt;
    pos[i * 3 + 2] += u.vel[i * 3 + 2] * dt;
    const f = Math.min(1, u.life[i] / 0.6);          // fondu
    const g = blueBase(i);
    col[i * 3] = g[0] * f; col[i * 3 + 1] = g[1] * f; col[i * 3 + 2] = g[2] * f;
  }
  sparkBurst.geometry.attributes.position.needsUpdate = true;
  sparkBurst.geometry.attributes.color.needsUpdate = true;
  if (!alive) { u.active = false; sparkBurst.visible = false; }
}
// couleur de base d'une étincelle (stable pendant la vie)
function blueBase(i) {
  return (i * 7919) % 5 === 0 ? [0.65, 0.75, 1.0] : [1.0, 0.8, 0.4];
}

/* ─────────────────── Lucioles magiques + traînées ─────────────────── */
function buildFireflies() {
  const NF = 7, TRAIL = 12;
  const geo = new THREE.BufferGeometry();
  const total = NF * TRAIL;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.05, map: makeStarTexture(), transparent: true,
    vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  const ffs = [];
  for (let i = 0; i < NF; i++) {
    ffs.push({
      a: 0.35 + Math.random() * 0.35, b: 0.5 + Math.random() * 0.5, c: 0.3 + Math.random() * 0.4,
      p1: Math.random() * 6.28, p2: Math.random() * 6.28, p3: Math.random() * 6.28,
      r: 0.3 + Math.random() * 0.25,
      hist: new Float32Array(TRAIL * 3),
      hue: Math.random() < 0.25 ? [0.6, 0.75, 1.0] : [1.0, 0.82, 0.45],
    });
  }
  pts.userData = { ffs, NF, TRAIL };
  return pts;
}

function updateFireflies(t) {
  if (!fireflies) return;
  const { ffs, NF, TRAIL } = fireflies.userData;
  const pos = fireflies.geometry.attributes.position.array;
  const col = fireflies.geometry.attributes.color.array;
  const speedUp = 1 + talkBoost * 0.8;
  for (let i = 0; i < NF; i++) {
    const f = ffs[i];
    // courbe de Lissajous autour de Frédéric
    const x = Math.sin(t * f.a * speedUp + f.p1) * f.r;
    const y = 0.55 + Math.sin(t * f.b * speedUp + f.p2) * 0.45;
    const z = Math.sin(t * f.c * speedUp + f.p3) * f.r;
    // décale l'historique (traînée)
    const h = f.hist;
    for (let k = TRAIL - 1; k > 0; k--) {
      h[k * 3] = h[(k - 1) * 3]; h[k * 3 + 1] = h[(k - 1) * 3 + 1]; h[k * 3 + 2] = h[(k - 1) * 3 + 2];
    }
    h[0] = x; h[1] = y; h[2] = z;
    const tw = 0.7 + 0.3 * Math.sin(t * 5 + i * 2.3);
    for (let k = 0; k < TRAIL; k++) {
      const idx = (i * TRAIL + k) * 3;
      pos[idx] = h[k * 3]; pos[idx + 1] = h[k * 3 + 1]; pos[idx + 2] = h[k * 3 + 2];
      const fade = (1 - k / TRAIL) * tw * (0.8 + talkBoost * 0.5);
      col[idx] = f.hue[0] * fade; col[idx + 1] = f.hue[1] * fade; col[idx + 2] = f.hue[2] * fade;
    }
  }
  fireflies.geometry.attributes.position.needsUpdate = true;
  fireflies.geometry.attributes.color.needsUpdate = true;
}

/* ─────────────────── Cercle magique runique (texture canvas) ─────────────────── */
function makeRuneCircleTexture(inner = false) {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  const cx = S / 2, cy = S / 2;
  const gold = (a) => `rgba(245,185,66,${a})`;
  x.translate(cx, cy);
  const R = S * 0.46;
  // anneaux concentriques
  x.strokeStyle = gold(0.9); x.lineWidth = 5;
  x.beginPath(); x.arc(0, 0, R, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = gold(0.55); x.lineWidth = 2.5;
  x.beginPath(); x.arc(0, 0, R * 0.9, 0, Math.PI * 2); x.stroke();
  if (!inner) {
    // "runes" d'enluminure de conte : petites étoiles à 4 branches, points et arcs doux
    const NR = 24;
    x.strokeStyle = gold(0.95); x.fillStyle = gold(0.95);
    x.lineWidth = 2.2; x.lineCap = "round";
    const rr = (i, n) => ((i * 2654435761 + n * 40503) >>> 0) % 1000 / 1000;
    for (let i = 0; i < NR; i++) {
      const ang = (i / NR) * Math.PI * 2;
      x.save();
      x.rotate(ang);
      x.translate(0, -R * 0.95);
      const kind = i % 3;
      if (kind === 0) {
        // petite étoile à 4 branches douces
        const s = R * 0.045;
        x.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2;
          const c = Math.cos(a), sn = Math.sin(a);
          x.moveTo(c * s, sn * s);
          x.quadraticCurveTo(c * s * 0.25 - sn * s * 0.18, sn * s * 0.25 + c * s * 0.18, 0, 0);
          x.moveTo(0, 0);
          x.quadraticCurveTo(c * s * 0.25 + sn * s * 0.18, sn * s * 0.25 - c * s * 0.18, c * s, sn * s);
        }
        x.stroke();
        x.beginPath(); x.arc(0, 0, 1.6, 0, Math.PI * 2); x.fill();
      } else if (kind === 1) {
        // arc souriant + point (petit croissant doux)
        const s = R * 0.05;
        x.beginPath();
        x.arc(0, 0, s, Math.PI * (0.15 + rr(i, 1) * 0.3), Math.PI * (0.85 + rr(i, 2) * 0.3));
        x.stroke();
        x.beginPath(); x.arc(s * 0.9, -s * 0.2, 1.8, 0, Math.PI * 2); x.fill();
      } else {
        // grappe de 3 points scintillants
        const s = R * 0.04;
        x.beginPath(); x.arc(-s, s * 0.4, 1.7, 0, Math.PI * 2); x.fill();
        x.beginPath(); x.arc(0, -s * 0.6, 2.1, 0, Math.PI * 2); x.fill();
        x.beginPath(); x.arc(s, s * 0.4, 1.7, 0, Math.PI * 2); x.fill();
      }
      x.restore();
    }
    // petits points entre les motifs
    x.fillStyle = gold(0.8);
    for (let i = 0; i < NR; i++) {
      const ang = ((i + 0.5) / NR) * Math.PI * 2;
      x.beginPath();
      x.arc(Math.cos(ang) * R * 0.82, Math.sin(ang) * R * 0.82, 3, 0, Math.PI * 2);
      x.fill();
    }
  } else {
    // anneau intérieur féerique : spirale d'étoile à 8 branches douce,
    // petites étoiles à 4 branches en cercle, et un livre ouvert au centre
    x.lineCap = "round";

    // spirale à 8 branches : 8 courbes douces qui s'enroulent depuis le centre
    x.strokeStyle = gold(0.7); x.lineWidth = 1.8;
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * Math.PI * 2;
      x.beginPath();
      for (let t = 0; t <= 20; t++) {
        const f = t / 20;                              // 0 → 1 le long de la branche
        const rad = R * (0.3 + 0.5 * f);               // s'éloigne du centre
        const a = a0 + f * 0.9;                        // s'enroule doucement
        const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
        t === 0 ? x.moveTo(px, py) : x.lineTo(px, py);
      }
      x.stroke();
      // point lumineux au bout de chaque branche
      const ae = a0 + 0.9, re = R * 0.8;
      x.beginPath(); x.arc(Math.cos(ae) * re, Math.sin(ae) * re, 2.2, 0, Math.PI * 2);
      x.fillStyle = gold(0.85); x.fill();
    }

    // petites étoiles à 4 branches disposées en cercle
    const NS = 8;
    x.strokeStyle = gold(0.85); x.lineWidth = 1.6;
    for (let i = 0; i < NS; i++) {
      const ang = (i / NS) * Math.PI * 2 + Math.PI / 8;
      const sx = Math.cos(ang) * R * 0.55, sy = Math.sin(ang) * R * 0.55;
      const s = R * 0.07;
      x.beginPath();
      x.moveTo(sx, sy - s); x.lineTo(sx, sy + s);
      x.moveTo(sx - s, sy); x.lineTo(sx + s, sy);
      x.stroke();
      x.beginPath(); x.arc(sx, sy, 1.8, 0, Math.PI * 2);
      x.fillStyle = gold(0.9); x.fill();
    }

    // livre ouvert au centre (traits dorés fins)
    const bw = R * 0.2, bh = R * 0.13;                 // demi-largeur / hauteur du livre
    x.strokeStyle = gold(0.95); x.lineWidth = 2.2;
    x.beginPath();
    // couverture : deux "ailes" qui remontent vers l'extérieur
    x.moveTo(-bw, -bh * 0.7);
    x.quadraticCurveTo(-bw * 0.5, -bh * 1.25, 0, -bh * 0.7);   // bord haut gauche
    x.quadraticCurveTo(bw * 0.5, -bh * 1.25, bw, -bh * 0.7);   // bord haut droit
    x.lineTo(bw, bh * 0.55);
    x.quadraticCurveTo(bw * 0.5, bh * 0.05, 0, bh * 0.55);     // bas droit
    x.quadraticCurveTo(-bw * 0.5, bh * 0.05, -bw, bh * 0.55);  // bas gauche
    x.closePath();
    x.stroke();
    // reliure centrale
    x.beginPath(); x.moveTo(0, -bh * 0.7); x.lineTo(0, bh * 0.55); x.stroke();
    // lignes de texte suggérées (2 par page)
    x.strokeStyle = gold(0.6); x.lineWidth = 1.3;
    for (const sgn of [-1, 1]) {
      for (let l = 0; l < 2; l++) {
        const ly = -bh * 0.25 + l * bh * 0.45;
        x.beginPath();
        x.moveTo(sgn * bw * 0.18, ly);
        x.quadraticCurveTo(sgn * bw * 0.55, ly - bh * 0.15, sgn * bw * 0.82, ly - bh * 0.05);
        x.stroke();
      }
    }
    // éclat au-dessus du livre (petit point magique)
    x.fillStyle = gold(0.9);
    x.beginPath(); x.arc(0, -bh * 1.7, 3, 0, Math.PI * 2); x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* Dégradé radial lumineux au sol (fondu magique) */
function makeGroundGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(128, 128, 5, 128, 128, 128);
  g.addColorStop(0, "rgba(255,220,140,0.75)");
  g.addColorStop(0.35, "rgba(245,185,66,0.3)");
  g.addColorStop(0.7, "rgba(180,140,255,0.08)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* Rayons de lumière (god rays simplifiés) : triangles allongés additifs derrière Frédéric */
function buildGodRays() {
  const grp = new THREE.Group();
  const NR = 7;
  for (let i = 0; i < NR; i++) {
    const len = 0.75 + Math.random() * 0.35, wid = 0.05 + Math.random() * 0.06;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      -wid, 0, 0,  wid, 0, 0,  0, len, 0,
    ]), 3));
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.z = (i / NR) * Math.PI * 2 + Math.random() * 0.4;
    grp.add(m);
  }
  return grp;
}

/* ─────────────────────────── Scène commune ─────────────────────────── */
function buildSceneContent(parent) {
  anchorGroup = new THREE.Group();
  parent.add(anchorGroup);

  // Pivot "monde Y-up du personnage" : en mode démo il reste neutre (rotation 0) ;
  // en mode livre on lui applique BOOK_CHAR_ROT_X pour dresser Frédéric sur la
  // couverture. Tout ce qui doit entourer le personnage DEBOUT (lumières locales,
  // halo, rayons, particules, lucioles, burst) y est parenté. Tout ce qui doit
  // rester plaqué sur la couverture (anneaux runiques, glow au sol) reste dans
  // anchorGroup (ces plans sont déjà dans le plan XY de l'ancre, normale +Z).
  charPivot = new THREE.Group();
  anchorGroup.add(charPivot);

  // Lumière de chandelle : chaude, vivante (positions dans le repère Y-up du personnage)
  const warm = new THREE.PointLight(0xffc36b, 2.4, 6); warm.position.set(0.4, 1.2, 0.8);
  const fill = new THREE.AmbientLight(0x8898c8, 1.6);
  const hemi = new THREE.HemisphereLight(0xfff2d8, 0x8a7a6a, 0.9);  // ciel chaud / sol doux
  const rim = new THREE.DirectionalLight(0xf5b942, 1.2); rim.position.set(-1, 2, -1);
  charPivot.add(warm, fill, hemi, rim);
  anchorGroup.userData.warm = warm;

  // Cercle magique runique : anneau doré gravé de runes qui tourne lentement
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({
      map: makeRuneCircleTexture(false), transparent: true, opacity: 0.6,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  ring.position.set(0, -0.12, 0.01);   // au niveau des pieds, dans le plan de la couverture
  ring.renderOrder = 1;
  anchorGroup.add(ring);
  anchorGroup.userData.ring = ring;

  // Anneau intérieur contre-rotatif (spirale d'étoiles + livre ouvert)
  const ringInner = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.62),
    new THREE.MeshBasicMaterial({
      map: makeRuneCircleTexture(true), transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  ringInner.position.set(0, -0.12, 0.012);
  ringInner.renderOrder = 1;
  anchorGroup.add(ringInner);
  anchorGroup.userData.ringInner = ringInner;

  // Fondu magique du sol : dégradé radial lumineux sous Frédéric
  const groundGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({
      map: makeGroundGlowTexture(), transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  groundGlow.position.set(0, -0.13, 0.005);
  groundGlow.renderOrder = 0;
  anchorGroup.add(groundGlow);
  anchorGroup.userData.groundGlow = groundGlow;

  // Halo lumineux doux DERRIÈRE Frédéric (disque dégradé) — donne l'aura magique
  const haloTex = makeHaloTexture();
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  halo.position.set(0, 0.28, -0.02);   // derrière le personnage (repère Y-up → suit le pivot)
  halo.renderOrder = 0;
  charPivot.add(halo);
  anchorGroup.userData.halo = halo;

  // Rayons de lumière tournant doucement derrière Frédéric (god rays stylisés)
  const rays = buildGodRays();
  rays.position.set(0, 0.25, -0.03);
  rays.renderOrder = 0;
  charPivot.add(rays);
  anchorGroup.userData.rays = rays;

  frederic = buildFrederic();
  frederic.scale.setScalar(0.001);       // il apparaîtra en grandissant
  charPivot.add(frederic);

  particles = buildParticles();
  charPivot.add(particles);

  sparkBurst = buildSparkBurst();
  charPivot.add(sparkBurst);

  fireflies = buildFireflies();
  charPivot.add(fireflies);

  // Si un vrai modèle GLB existe (frederic.glb), il remplace le personnage 2.5D.
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/");
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(draco);
  gltfLoader.load(GLB_FILE, (gltf) => {
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

    // 3) Matériaux : rendu fiable en scène (faces arrière visibles, alpha MASK,
    //    auto-éclairage léger pour conserver les couleurs de l'illustration).
    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (!mat) continue;
        mat.side = THREE.DoubleSide;
        if (mat.transparent) mat.alphaTest = 0.4;   // alpha MASK seulement si le matériau a de l'alpha
        if ("metalness" in mat) mat.metalness = 0;
        if ("emissive" in mat && mat.map) {           // évite le modèle trop sombre
          mat.emissive = new THREE.Color(0xffffff);
          mat.emissiveMap = mat.map;
          mat.emissiveIntensity = 0.35;               // modéré : la texture Tripo a déjà son éclairage baked
        }
        mat.needsUpdate = true;
      }
    });

    // 3b) Rigging : le GLB n'a ni squelette ni clips, on crée un squelette
    //     procédural avec skinning (voir plus bas, après création du wrap).
    //     Si le skinning échoue, fallback sur l'ancienne animation vertex (glbAnims).
    const glbAnims = [];
    let glbBones = null;

    // 4) Enrober dans un groupe pour garder les mêmes userData/animation que la 2.5D.
    const wrap = new THREE.Group();
    wrap.add(model);

    // Ombre douce sous le modèle (même cercle que la 2.5D, animée avec le bob)
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.26, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2.2;
    shadow.position.set(0, -0.01, 0.02);
    shadow.scale.set(1, 0.5, 1);
    shadow.renderOrder = 1;
    wrap.add(shadow);

    // 3c) Squelette procédural + skinning par régions. Les os vivent dans
    //     l'espace LOCAL du wrap = coordonnées normalisées (y∈[0,1], x/z≈0).
    //     Le skinning tourne sur GPU (75k verts, 6 os : OK).
    try {
      const mkBone = (name, x, y, z) => {
        const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); return b;
      };
      const bSpine = mkBone("spine", 0, 0.55, 0);                    // taille
      const bHead  = mkBone("head", 0, 0.86 - 0.55, 0);              // pivot du cou
      const bArmL  = mkBone("armL", -0.09, 0.72 - 0.55, 0);          // épaule gauche
      const bArmR  = mkBone("armR",  0.09, 0.72 - 0.55, 0);          // épaule droite (livre/plume)
      const bCoatL = mkBone("coatL", -0.08, 0.35 - 0.55, 0);         // pan gauche du manteau
      const bCoatR = mkBone("coatR",  0.08, 0.35 - 0.55, 0);         // pan droit du manteau
      bSpine.add(bHead, bArmL, bArmR, bCoatL, bCoatR);
      wrap.add(bSpine);
      wrap.updateMatrixWorld(true);
      const boneList = [bSpine, bHead, bArmL, bArmR, bCoatL, bCoatR];
      const skeleton = new THREE.Skeleton(boneList);   // inverses depuis les bind poses
      glbBones = { spine: bSpine, head: bHead, armL: bArmL, armR: bArmR, coatL: bCoatL, coatR: bCoatR };

      // Poids lissés par région, depuis la position du vertex en espace wrap.
      const sstep = (a0, b0, x) => {
        const q = THREE.MathUtils.clamp((x - a0) / (b0 - a0), 0, 1);
        return q * q * (3 - 2 * q);                     // smoothstep : pas de plis durs
      };
      const vTmp = new THREE.Vector3();
      const toSkin = [];
      model.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) toSkin.push(o); });
      for (const o of toSkin) {
        const geo = o.geometry.clone();                 // Draco : géométrie souvent partagée
        const pos = geo.attributes.position;
        if (!pos) continue;
        const n = pos.count;
        const skinIndex = new Uint16Array(n * 4);
        const skinWeight = new Float32Array(n * 4);
        o.updateWorldMatrix(true, false);
        for (let i = 0; i < n; i++) {
          vTmp.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);  // → espace wrap
          const x = vTmp.x, y = vTmp.y;
          const wHeadV = sstep(0.80, 0.88, y);                            // tête (blend cou 0.80→0.88)
          const yBand = sstep(0.48, 0.56, y) * (1 - sstep(0.80, 0.88, y)); // zone bras
          const wArmLV = sstep(0.05, 0.10, -x) * yBand * (1 - wHeadV);    // bras gauche
          const wArmRV = sstep(0.05, 0.10,  x) * yBand * (1 - wHeadV);    // bras droit
          const cMask = (1 - sstep(0.30, 0.40, y)) * (1 - wHeadV);        // bas du manteau
          const wCoatLV = cMask * sstep(0.05, 0.09, -x);
          const wCoatRV = cMask * sstep(0.05, 0.09,  x);
          const wSpineV = Math.max(0, 1 - wHeadV - wArmLV - wArmRV - wCoatLV - wCoatRV);
          // Top-4 influences, poids normalisés (somme = 1)
          const ws = [[0, wSpineV], [1, wHeadV], [2, wArmLV], [3, wArmRV], [4, wCoatLV], [5, wCoatRV]]
            .filter((e) => e[1] > 1e-4).sort((a2, b2) => b2[1] - a2[1]).slice(0, 4);
          let sum = 0; for (const e of ws) sum += e[1];
          if (sum <= 0) { ws.length = 0; ws.push([0, 1]); sum = 1; }
          const i4 = i * 4;
          for (let k = 0; k < ws.length; k++) {
            skinIndex[i4 + k] = ws[k][0];
            skinWeight[i4 + k] = ws[k][1] / sum;
          }
        }
        geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
        geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
        const sm = new THREE.SkinnedMesh(geo, o.material);  // matériau intact (WebP, emissive 0.35)
        sm.name = o.name;
        sm.frustumCulled = false;      // le mesh se déplace avec les os
        o.matrixWorld.decompose(sm.position, sm.quaternion, sm.scale);
        o.parent.add(sm);
        o.removeFromParent();
        sm.updateMatrixWorld(true);
        sm.bind(skeleton, sm.matrixWorld);
      }
      wrap.updateMatrixWorld(true);
    } catch (rigErr) {
      // Fallback : ancienne animation de vertices pondérés (CPU).
      console.warn("[AR] Skinning GLB échoué, animation vertex conservée :", rigErr?.message || rigErr);
      glbBones = null;
      const invS = s > 0 ? 1 / s : 1;   // déplacement normalisé → local mesh
      model.traverse((o) => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position;
        if (!pos) return;
        const n = pos.count;
        const basePos = pos.array.slice();
        const wHead = new Float32Array(n), wTorso = new Float32Array(n);
        const wArmR = new Float32Array(n), wCoat = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          const xn = s * (basePos[i3] - center.x);      // position normalisée
          const yn = s * (basePos[i3 + 1] - box.min.y); // y∈[0,1], pieds à 0
          const zn = s * (basePos[i3 + 2] - center.z);
          const dHy = (yn - 0.92) / 0.12, dHx = xn / 0.08;
          wHead[i] = Math.exp(-0.5 * (dHy * dHy + dHx * dHx));        // gaussienne tête
          const dTy = (yn - 0.62) / 0.14, dTx = xn / 0.16;
          wTorso[i] = Math.exp(-0.5 * (dTy * dTy + dTx * dTx));       // torse
          const zMask = THREE.MathUtils.clamp((zn - 0.05) / 0.05, 0, 1);
          const yMask = THREE.MathUtils.clamp((yn - 0.55) / 0.05, 0, 1)
                      * THREE.MathUtils.clamp((0.75 - yn) / 0.05, 0, 1);
          wArmR[i] = zMask * yMask;                                   // bras/livre devant
          wCoat[i] = THREE.MathUtils.clamp((0.35 - yn) / 0.15, 0, 1); // bas du manteau
        }
        glbAnims.push({
          pos, basePos, wHead, wTorso, wArmR, wCoat, invS,
          neckY: box.min.y + 0.85 * invS,   // pivot du cou en coords locales
          phaseK: 8 * s,                    // phase manteau : x*8 en coords normalisées
        });
      });
    }

    wrap.userData = { model, glb: true, is3D: true, shadow, glbAnims, glbBones };

    charPivot.remove(frederic);
    frederic = wrap;
    frederic.scale.setScalar(0.001);   // apparaîtra en grandissant
    charPivot.add(frederic);           // hérite du pivot livre (idle/reveal ne touchent que y/z)

    // 4) Animations : joue "idle" en priorité, sinon la première dispo.
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(model);
      const idle = gltf.animations.find((a) => /idle|breath|stand/i.test(a.name)) || gltf.animations[0];
      mixer.clipAction(idle).play();
    }
    // En mode livre, on NE lance PAS l'apparition tant que la couverture
    // n'a pas été détectée (sinon la salutation vocale ne part jamais).
    if (!bookMode) revealT = Math.max(revealT, 0);
    else if (revealT >= 0) triggerSparkBurst();   // déjà en cours d'apparition
    if (!bookMode) triggerSparkBurst();
  }, undefined, (err) => {
    // Pas de GLB ou échec Draco/réseau : le relief 2.5D (buildFrederic3D) reste le fallback.
    console.warn("[AR] Chargement GLB échoué, relief 2.5D conservé :", err?.message || err);
  });
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
    if (particles) particles.material.uniforms.uBoost.value = (1 - e) * 1.5;  // explosion d'étoiles
  }

  // ── Vie du personnage illustré : respire, se balance, "parle" ──
  if (u?.billboard && revealT >= 1) {
    const bob = Math.sin(t * 1.6) * 0.014;                 // respiration
    const sway = Math.sin(t * 0.9) * 0.025;                // balancement doux
    frederic.position.y = bob;
    frederic.scale.set(1, 1, 1);
    frederic.rotation.z = sway;

    if (u.is3DRelief) {
      // ── Rotation vivante : montre le relief en oscillant lentement,
      //    + parallaxe caméra (mode démo gyro : camera.position.x bouge) ──
      const camPar = camera ? THREE.MathUtils.clamp(camera.position.x * 0.6, -0.25, 0.25) : 0;
      frederic.rotation.y = Math.sin(t * 0.5) * 0.35 + camPar;

      // ── Animation de vertices vivante (respiration, tête, plume, manteau) ──
      const anim = u.plane?.geometry?.userData?.anim;
      if (anim) {
        // impulsion de salutation quand `talking` passe à true
        if (talking && !prevTalking) greetT = t;
        prevTalking = talking;

        const { basePos, wHead, wBook, wQuill, wTorso, wCoat, uArr, H } = anim;
        const arr = u.plane.geometry.attributes.position.array;
        const neckY = 0.83 * H - H / 2;          // pivot du cou (coordonnées locales)
        const breath = Math.sin(t * 1.4);
        // hochement de tête : lent + micro-vie ; plus marqué/rapide en parlant,
        // + salutation (impulsion amortie) au début de la parole
        let nod = Math.sin(t * 0.7) * 0.05 + Math.sin(t * 1.3) * 0.02;
        if (talking) nod += Math.sin(t * 6) * 0.06;
        const gd = t - greetT;
        if (gd < 1.5) nod += Math.exp(-gd * 3.5) * Math.sin(gd * 9) * 0.09;
        const bookZ = Math.sin(t * 1.4 + 0.5) * 0.006;
        const qF = talking ? 1.8 : 1;            // la plume écrit plus vite en parlant
        const qCos = Math.cos(t * 5 * qF) * 0.008, qSin = Math.sin(t * 10 * qF) * 0.004;
        for (let i = 0; i < wHead.length; i++) {
          const i3 = i * 3;
          let x = basePos[i3], y = basePos[i3 + 1], z = basePos[i3 + 2];
          const wh = wHead[i];
          if (wh > 0.003) {                       // tête : rotation autour du cou (axe X)
            const a = nod * wh;
            const dy = y - neckY;
            y = neckY + dy * Math.cos(a) - z * Math.sin(a);
            z = dy * Math.sin(a) + z * Math.cos(a);
          }
          const wq = wQuill[i];
          if (wq > 0.003) { x += wq * qCos; y += wq * qSin; }   // plume qui écrit
          z += wTorso[i] * breath * 0.012;        // respiration du torse
          z += wBook[i] * bookZ;                  // livre qui suit la respiration
          const wc = wCoat[i];
          if (wc > 0.003) x += wc * Math.sin(t * 1.1 + uArr[i] * 6) * 0.01; // manteau ondulant
          arr[i3] = x; arr[i3 + 1] = y; arr[i3 + 2] = z;
        }
        u.plane.geometry.attributes.position.needsUpdate = true;
        // normales initiales conservées : mouvement subtil, computeVertexNormals()
        // par frame serait trop coûteux (15k vertices, mobile).
      }
    } else {
      frederic.rotation.y = Math.sin(t * 0.4) * 0.06;
    }

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
      // pulsation "parle" du relief 3D : léger étirement vertical rythmé
      if (u.is3DRelief && u.plane) {
        u.plane.scale.y = 1 + Math.abs(Math.sin(t * 9)) * 0.02;
      }
    } else if (u.is3DRelief && u.plane) {
      u.plane.scale.y = 1;
    }
    if (u.shadow) u.shadow.material.opacity = 0.26 - Math.abs(bob) * 4;
  }

  // ── Vie du GLB volumétrique : respire, se balance, et tourne lentement
  //    pour qu'on admire le volume (c'est le but du vrai modèle 3D). ──
  if (u?.glb && revealT >= 1) {
    if (u.idleStart == null) u.idleStart = t;        // fondu d'entrée : pas de saut de rotation.y à la fin du reveal (qui finit à 0)
    const blend = Math.min(1, (t - u.idleStart) / 1.2);
    const breath = Math.sin(t * 1.4);
    frederic.position.y = breath * 0.012;            // respiration (bob vertical)
    frederic.scale.set(1, 1 + breath * 0.006, 1);    // très léger scale y
    frederic.rotation.z = Math.sin(t * 0.9) * 0.02;  // balancement doux
    frederic.rotation.x = Math.sin(t * 0.6) * 0.01;
    // oscillation qui dévoile le volume 3D + parallaxe caméra (mode démo gyro)
    const camPar = camera ? THREE.MathUtils.clamp(camera.position.x * 0.6, -0.25, 0.25) : 0;
    frederic.rotation.y = (Math.sin(t * 0.45) * 0.4 + camPar) * blend;

    if (talking) {
      frederic.position.y += Math.sin(t * 9) * 0.02;   // bob plus marqué
      frederic.rotation.x += Math.sin(t * 6) * 0.03;   // léger hochement
    }

    // ── Animation du squelette procédural (skinning GPU) : mouvements
    //    articulés crédibles. Se combine au reveal (groupe, indépendant des os). ──
    const B = u.glbBones;
    if (B) {
      B.spine.rotation.x = Math.sin(t * 1.4) * 0.015;          // respiration
      let nod = Math.sin(t * 0.7) * 0.06;                      // hochement de tête
      if (talking) nod += Math.sin(t * 6) * 0.08;              // nods marqués en parlant
      B.head.rotation.x = nod;
      B.head.rotation.y = Math.sin(t * 0.3) * 0.1;             // il regarde autour de lui
      B.armL.rotation.x = Math.sin(t * 1.4) * 0.02;            // suit la respiration
      // Geste de la plume (écriture lente) + salutation oratoire en parlant
      B.armR.rotation.z = Math.sin(t * 2.2) * 0.05;
      B.armR.rotation.x = Math.sin(t * 2.2 + 0.7) * 0.05 + talkBoost * Math.sin(t * 3) * 0.15;
      B.coatL.rotation.x = Math.sin(t * 1.1) * 0.03;           // ondulation du tissu
      B.coatR.rotation.x = Math.sin(t * 1.1 + 0.9) * 0.03;
    } else {
    // ── Fallback : animation de vertices du GLB (si le skinning a échoué) ──
    const anims = u.glbAnims;
    if (anims?.length) {
      let nod = Math.sin(t * 0.7) * 0.04 + Math.sin(t * 1.3) * 0.015;  // hochement lent + micro-vie
      if (talking) nod += Math.sin(t * 6) * 0.05;
      const kBr = breath * 0.010;                        // amplitude torse (normalisée)
      const kArm = Math.sin(t * 1.4 + 0.6) * 0.006;      // bob du livre/bras
      const kCoatT = t * 1.1;
      for (let a = 0; a < anims.length; a++) {
        const an = anims[a];
        const { pos, basePos, wHead, wTorso, wArmR, wCoat, invS, neckY, phaseK } = an;
        const arr = pos.array;
        const n = wHead.length;
        const kBrL = kBr * invS, kArmL = kArm * invS, kCoatL = 0.008 * invS;
        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          let x = basePos[i3], y = basePos[i3 + 1], z = basePos[i3 + 2];
          const wh = wHead[i];
          if (wh > 0.003) {                     // tête : rotation autour du cou (axe X)
            const ang = nod * wh;
            const dy = y - neckY;
            const c = Math.cos(ang), sn = Math.sin(ang);
            y = neckY + dy * c - z * sn;
            z = dy * sn + z * c;
          }
          const wt = wTorso[i];
          if (wt > 0.003) z += wt * kBrL;       // respiration : le torse se gonfle vers l'avant
          const wa = wArmR[i];
          if (wa > 0.003) y += wa * kArmL;      // livre/bras qui suivent la respiration
          const wc = wCoat[i];
          if (wc > 0.003) x += wc * Math.sin(kCoatT + basePos[i3] * phaseK) * kCoatL; // manteau ondulant
          arr[i3] = x; arr[i3 + 1] = y; arr[i3 + 2] = z;
        }
        pos.needsUpdate = true;
        // PAS de computeVertexNormals() par frame : mouvement subtil, trop coûteux (~75k verts).
      }
    }
    }   // fin du fallback animation vertex (glbAnims)

    if (u.shadow) {
      u.shadow.position.y = -0.01 - frederic.position.y;  // reste plaquée au sol pendant le bob
      u.shadow.material.opacity = 0.26 - Math.abs(frederic.position.y) * 4;
    }
  }
  if (mixer) mixer.update(dt);

  // ── Ambiance magique : lumière vivante, cercles runiques, halo, rayons ──
  // talkBoost monte/descend doucement selon que Frédéric parle
  talkBoost += ((talking ? 1 : 0) - talkBoost) * Math.min(1, dt * 5);

  const a = anchorGroup?.userData;
  if (a?.warm && revealT >= 1) {
    a.warm.intensity = 2.2 + Math.sin(t * 7) * 0.35 + Math.sin(t * 13) * 0.15 + talkBoost * 1.2;
    // variation de couleur subtile : or ↔ bleuté
    const hueShift = 0.5 + 0.5 * Math.sin(t * 0.5);
    a.warm.color.setHSL(0.09 + hueShift * 0.05 + talkBoost * 0.04, 0.85, 0.62 + talkBoost * 0.06);
  }
  if (a?.ring) {
    a.ring.rotation.z = t * 0.22;                            // rotation lente du cercle runique
    // pulsation + scintillement double fréquence
    const twinkle = 0.45 + Math.sin(t * 2.2) * 0.15 + Math.sin(t * 5.7) * 0.08 + talkBoost * 0.25;
    a.ring.material.opacity = Math.max(0.2, twinkle);
    a.ring.scale.setScalar(1 + Math.sin(t * 1.8) * 0.035 + talkBoost * 0.05);
  }
  if (a?.ringInner) {
    a.ringInner.rotation.z = -t * 0.45;                      // contre-rotation
    a.ringInner.material.opacity = 0.35 + Math.abs(Math.sin(t * 2.8)) * 0.25 + talkBoost * 0.2;
    a.ringInner.scale.setScalar(1 + Math.sin(t * 2.3 + 1.5) * 0.05);
  }
  if (a?.halo) {
    a.halo.rotation.z = -t * 0.5;
    a.halo.material.opacity = 0.18 + Math.abs(Math.sin(t * 1.5)) * 0.16 + talkBoost * 0.25;
    a.halo.scale.setScalar(1 + Math.sin(t * 2.1) * 0.04 + talkBoost * 0.12);
  }
  if (a?.rays) {
    a.rays.rotation.z = t * 0.12;                            // rayons qui tournent doucement
    a.rays.children.forEach((m, i) => {
      m.material.opacity = (0.08 + Math.abs(Math.sin(t * 1.7 + i * 1.3)) * 0.1) * (1 + talkBoost);
    });
  }
  if (a?.groundGlow) {
    a.groundGlow.material.opacity = 0.4 + Math.sin(t * 1.6) * 0.1 + talkBoost * 0.3;
    a.groundGlow.scale.setScalar(1 + Math.sin(t * 1.2) * 0.05 + talkBoost * 0.1);
  }
  animateParticles(t);
  updateSparkBurst(dt);
  updateFireflies(t);
}

/* Redresse le contenu "debout" (personnage + FX associés) pour le mode livre :
   la couverture est le plan XY de l'ancre MindAR (normale +Z). Le pivot porte la
   rotation, donc les animations idle/reveal (rotation.y / rotation.z / position.y
   locales du personnage) restent valides et relatives à la couverture. Les effets
   plaqués sur la page (anneaux runiques, glow) restent dans anchorGroup, déjà
   dans le plan XY — rien à changer pour eux. */
function applyBookOrientation() {
  if (charPivot) charPivot.rotation.x = BOOK_CHAR_ROT_X;
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

  // MindAR : le repère de l'ancre est aligné sur la couverture (X droite, Y haut de la page,
  // Z vers la caméra). Le personnage est construit Y-up (monde démo) : on le dresse via le
  // charPivot (rotation.x = +90°) pour que son "haut" suive la normale +Z de la couverture
  // et que sa face regarde le bas de la page (le lecteur). anchorGroup reste neutre.
  anchorGroup.rotation.x = 0;
  anchorGroup.scale.setScalar(0.42);          // taille figurine sur la couverture (×2)
  anchorGroup.position.set(0, -0.2, 0.02);    // pieds vers le bas de page, posés sur la couverture (z≈0)
  bookMode = true;
  applyBookOrientation();

  // Deuxième marqueur (cible 1) : la couverture officielle du livre.
  // Le même contenu (anchorGroup) est déplacé vers l'ancre détectée.
  const anchor2 = mindar.addAnchor(1);
  const onFound = (targetGroup) => {
    if (anchorGroup && anchorGroup.parent !== targetGroup) targetGroup.add(anchorGroup);
    scanGuide.hidden = true;
    if (revealT < 0) {
      revealT = 0;
      triggerSparkBurst();
      fredericSpeaks("Oh ! Bonjour toi ! Je suis Frédéric Bastiat — oui, en personne, sorti des pages ! Dis-moi : y a-t-il une chose que tu aimerais explorer avec moi ? Appuie sur le sceau rouge et parlons !");
    }
  };
  anchor.onTargetFound = () => onFound(anchor.group);
  anchor2.onTargetFound = () => onFound(anchor2.group);
  anchor.onTargetLost = () => { scanGuide.hidden = false; };
  anchor2.onTargetLost = () => { scanGuide.hidden = false; };

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
  triggerSparkBurst();
  fredericSpeaks("Bonjour ! Je suis Frédéric Bastiat, économiste et ami des questions ! Y a-t-il une chose que tu aimerais explorer avec moi ? Appuie sur le sceau rouge et dis-la-moi !");

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
