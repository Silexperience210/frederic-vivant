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

export function initChat(opts = {}) {
  onTalkingChange = opts.onTalkingChange || (() => {});

  // Précharge une voix française pour le fallback
  const pick = () => {
    const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("fr"));
    voiceFR = vs.find((v) => /google|thomas|amélie|audrey/i.test(v.name)) || vs[0] || null;
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
      await audio.play();
      return;
    }
  } catch { /* fallback ci-dessous */ }

  // 2) Fallback : synthèse vocale du navigateur
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR";
  if (voiceFR) u.voice = voiceFR;
  u.rate = 0.96; u.pitch = 1.02;
  u.onend = () => onTalkingChange(false);
  u.onerror = () => onTalkingChange(false);
  speechSynthesis.speak(u);
}

function showText(text) {
  $("speech-band").hidden = false;
  $("speech-text").textContent = text;
}
