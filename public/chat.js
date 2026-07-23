/* ═══════════════════════════════════════════════════════════════
   Frédéric Vivant — voix & cerveau
   Micro (Web Speech API fr-FR) → Worker Cloudflare (/api/chat, Claude)
   → voix : ElevenLabs via /api/tts si configuré, sinon speechSynthesis.
   ═══════════════════════════════════════════════════════════════ */

const API = "/api";               // même domaine (Cloudflare Pages Functions/Worker)
const $ = (id) => document.getElementById(id);

let history = [];                 // mémoire de conversation (envoyée au worker)
let recognizing = false;
let onTalkingChange = () => {};
let voiceFR = null;
let audioUnlocked = false;        // politique autoplay : un geste a-t-il amorcé le contexte ?
let pendingSpeak = null;          // { text, url } salutation bloquée, à rejouer au prochain geste

// WAV 16-bit mono 8kHz, 0.1 s de silence (amorçage autoplay)
const SILENT_WAV =
  "data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/* ── Déblocage autoplay : à appeler dans un geste utilisateur ── */
export function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  // 1) amorce l'élément audio (autoplay policy)
  try {
    const audio = $("tts-audio") || new Audio();
    audio.src = SILENT_WAV;
    audio.play().catch(() => {});
  } catch { /* ignore */ }
  // 2) amorce speechSynthesis (Chrome Android) + charge les voix
  try {
    speechSynthesis.getVoices();
    speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
    speechSynthesis.cancel();
  } catch { /* ignore */ }
  // 3) si une salutation était bloquée, la rejouer tout de suite
  if (pendingSpeak) replayPending();
}

function installUnlockListeners() {
  const onGesture = () => unlockAudio();
  document.addEventListener("pointerdown", onGesture, true);
  document.addEventListener("touchstart", onGesture, true);
  document.addEventListener("keydown", onGesture, true);
}

/* ── Rejeu d'une parole bloquée au prochain geste ── */
function replayPending() {
  const p = pendingSpeak;
  if (!p) return;
  pendingSpeak = null;
  onTalkingChange(true);
  if (p.url) {
    const audio = $("tts-audio");
    audio.src = p.url;
    audio.onended = () => { onTalkingChange(false); URL.revokeObjectURL(p.url); };
    audio.play()
      .then(() => console.debug("[Frédéric] rejeu de la salutation (audio)"))
      .catch(() => { onTalkingChange(false); speakViaTTS(p.text); });
  } else {
    speakViaTTS(p.text);
  }
}

/* ── Mode diagnostic : ?debug=1 → badge indiquant quel moteur vocal joue ── */
const DEBUG_VOICE = new URLSearchParams(location.search).get("debug") === "1";
function debugVoice(msg) {
  console.debug("[Frédéric]", msg);
  if (!DEBUG_VOICE) return;
  let el = document.getElementById("voice-debug");
  if (!el) {
    el = document.createElement("div");
    el.id = "voice-debug";
    el.style.cssText = "position:fixed;top:8px;left:8px;z-index:9999;background:rgba(0,0,0,.75);color:#F5B942;font:12px monospace;padding:6px 10px;border-radius:8px;max-width:80vw";
    document.body.appendChild(el);
  }
  el.textContent = "🔊 " + msg;
}

function storePending(text, url) {
  if (pendingSpeak?.url && pendingSpeak.url !== url) URL.revokeObjectURL(pendingSpeak.url);
  pendingSpeak = { text, url };
  console.debug("[Frédéric] audio bloqué -> rejeu au prochain toucher");
}

function speakViaTTS(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR";
  if (voiceFR) u.voice = voiceFR;
  u.rate = 0.98;                    // posé, prestance d'époque
  u.pitch = 0.6;                    // très grave = clairement masculin
  u.onend = () => onTalkingChange(false);
  u.onerror = () => onTalkingChange(false);
  speechSynthesis.speak(u);
  // Garde-fou Chrome Android : speak() sans geste récent peut rester muet
  setTimeout(() => {
    if (!speechSynthesis.speaking && !speechSynthesis.pending) {
      console.debug("[Frédéric] speechSynthesis bloqué -> rejeu au prochain toucher");
      onTalkingChange(false);
      storePending(text, null);
    }
  }, 800);
}

export function initChat(opts = {}) {
  onTalkingChange = opts.onTalkingChange || (() => {});
  installUnlockListeners();
  // initChat est appelé depuis le handler du clic (launch()) : on débloque
  // l'audio SYNCHRONIQUEMENT pendant ce geste, sinon la salutation du reveal
  // (quelques secondes plus tard) sera bloquée par la politique autoplay.
  try { unlockAudio(); } catch { /* noop */ }

  // Précharge une voix française MASCULINE pour le fallback (Frédéric est un homme)
  const pick = () => {
    const fr = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("fr"));
    // 1) marqueurs masculins connus (Android/Chrome/iOS/desktop)
    //    Android TTS : fr-fr-x-frd-* = voix HOMME ; iOS : Thomas ; Windows : Paul/Henri/Claude
    const maleNames = /frd|thomas|nicolas|daniel|paul|henri|claude|guillaume|mathieu|antoine|homme|\bmale\b|\bman\b/i;
    // 2) marqueurs féminins à EXCLURE (Android : fr-fr-x-vlf-* = voix FEMME)
    const femaleNames = /vlf|fif|fpm|amélie|amelie|audrey|marie|julie|celine|céline|virginie|léa|lea|chloe|chloé|female|femme|woman|aurelie|aurélie|denise|hortense/i;
    const males = fr.filter((v) => maleNames.test(v.name) && !femaleNames.test(v.name));
    voiceFR =
      // priorité : voix masculine LOCALE (embarquée, meilleure qualité prosodie)
      males.find((v) => v.localService) ||
      males[0] ||
      // à défaut : une voix non-féminine quelconque
      fr.find((v) => !femaleNames.test(v.name) && v.localService) ||
      fr.find((v) => !femaleNames.test(v.name)) ||
      fr[0] || null;
    console.debug("[Frédéric] voix choisie :", voiceFR?.name || "défaut navigateur");
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;

  $("btn-mic").addEventListener("click", listen);
  $("btn-lesson").addEventListener("click", () =>
    ask("Donne-moi ta petite leçon du jour, avec un exemple rigolo de ton époque !"));
  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => ask(c.textContent)));
}

/* ── Écoute ── */
function listen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const q = prompt("Ton navigateur n'a pas de micro magique — écris ta question à Frédéric :");
    if (q) ask(q);
    return;
  }
  if (recognizing) return;

  const rec = new SR();
  rec.lang = "fr-FR"; rec.interimResults = false; rec.maxAlternatives = 1;

  rec.onstart = () => {
    recognizing = true;
    $("btn-mic").classList.add("recording");
    $("listening-badge").hidden = false;
  };
  const stopUI = () => {
    recognizing = false;
    $("btn-mic").classList.remove("recording");
    $("listening-badge").hidden = true;
  };
  rec.onerror = stopUI;
  rec.onend = stopUI;
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    stopUI();
    if (text?.trim()) ask(text.trim());
  };
  rec.start();
}

/* ── Question → Claude → parole ── */
async function ask(question) {
  speechSynthesis.cancel();
  showText("…");
  history.push({ role: "user", content: question });
  if (history.length > 12) history = history.slice(-12);   // fenêtre courte = coûts maîtrisés

  try {
    const r = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    const data = await r.json();
    const reply = data.reply || "Hum, ma plume s'est cassée… Repose-moi ta question !";
    history.push({ role: "assistant", content: reply });
    fredericSpeaks(reply);
  } catch (err) {
    console.error(err);
    fredericSpeaks("Oh là ! Le télégraphe est en panne. Vérifie ta connexion et réessaie, mon ami !");
  }
}

/* ── Frédéric parle : sous-titres + voix + animation ── */
export async function fredericSpeaks(text) {
  showText(text);
  onTalkingChange(true);

  // 1) ElevenLabs via le worker, si configuré
  try {
    const r = await fetch(`${API}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.ok && r.headers.get("content-type")?.includes("audio")) {
      const url = URL.createObjectURL(await r.blob());
      const audio = $("tts-audio");
      audio.src = url;
      audio.onended = () => { onTalkingChange(false); URL.revokeObjectURL(url); };
      try {
        await audio.play();
        debugVoice("ElevenLabs (voix masculine) ✓");
        return;
      } catch (err) {
        debugVoice("play() bloqué : " + (err?.name || err));
        if (err && err.name === "NotAllowedError") {
          // Autoplay bloqué (geste initial expiré) : rejouer au prochain toucher
          onTalkingChange(false);
          storePending(text, url);
          return;
        }
        URL.revokeObjectURL(url);
        throw err; // autre erreur -> fallback TTS
      }
    }
  } catch (e) { debugVoice("ElevenLabs indisponible : " + (e?.message || e)); }

  // 2) Fallback : synthèse vocale du navigateur
  debugVoice("FALLBACK voix navigateur (robotique)");
  speakViaTTS(text);
}

function showText(text) {
  $("speech-band").hidden = false;
  $("speech-text").textContent = text;
}
