/* ═══════════════════════════════════════════════════════════════
   /api/tts — voix de Frédéric
   Chaîne de voix (avec cache KV pour ne rien re-générer) :
   1) ElevenLabs "Adam" si ELEVENLABS_API_KEY (quota !)
   2) Edge TTS Microsoft "fr-FR-HenriNeural" — GRATUIT, voix
      masculine naturelle française (fallback illimité)
   3) 204 → synthèse du navigateur (dernier recours)
   ═══════════════════════════════════════════════════════════════ */

const EDGE_VOICE = "fr-FR-HenriNeural";   // homme, naturel, chaleureux
const EDGE_TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

function uuid() {
  return crypto.randomUUID().replace(/-/g, "");
}

/* ── Jeton Sec-MS-GEC pour Edge TTS ── */
async function secMsGec() {
  // ticks Windows (100ns depuis 1601), arrondis aux 300 secondes
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  const str = (ticks * 10000000).toString() + EDGE_TRUSTED_TOKEN;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* ── Edge TTS via WebSocket (protocole readaloud) ── */
async function edgeTTS(text) {
  const gec = await secMsGec();
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-143.0.3650.75&ConnectionId=${uuid()}`;

  // Handshake WebSocket via fetch() : permet les en-têtes Origin/User-Agent
  // exigés par le service (impossible avec new WebSocket() dans un Worker)
  const resp = await fetch(url, {
    headers: {
      "Upgrade": "websocket",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (resp.status !== 101) throw new Error("edge-handshake-" + resp.status);
  const ws = resp.webSocket;
  ws.accept();

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => { try { ws.close(); } catch {} ; reject(new Error("edge-timeout")); }, 15000);

    ws.addEventListener("open", () => {
      const ts = new Date().toISOString();
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='fr-FR'>` +
        `<voice name='${EDGE_VOICE}'><prosody pitch='-4Hz' rate='-4%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`
      );
    });

    ws.addEventListener("message", (ev) => {
      // Binaire : [2 octets longueur header][header ascii][données mp3]
      if (ev.data instanceof ArrayBuffer) {
        const buf = new Uint8Array(ev.data);
        if (buf.length < 2) return;
        const hlen = (buf[0] << 8) | buf[1];
        const header = new TextDecoder().decode(buf.subarray(2, 2 + hlen));
        if (header.includes("Path:audio")) chunks.push(buf.subarray(2 + hlen));
        return;
      }
      // Texte : fin du tour ?
      if (typeof ev.data === "string" && ev.data.includes("Path:turn.end")) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (!chunks.length) return reject(new Error("edge-no-audio"));
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        resolve(out.buffer);
      }
    });

    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("edge-ws-error")); });
    ws.addEventListener("close", (e) => {
      clearTimeout(timer);
      if (!chunks.length) reject(new Error("edge-closed-" + e.code));
    });
  });
}

export async function onRequestPost({ request, env }) {
  let text, dbg = false;
  const dbgErrors = [];
  try { const j = await request.json(); text = j.text?.slice(0, 600); dbg = !!j.debug; } catch { /* noop */ }
  if (!text) return new Response(null, { status: 400 });

  const elVoice = env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // "Adam"

  // ── Cache KV : voix+moteur+texte (jamais re-généré 2×) ──
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(elVoice + "|" + EDGE_VOICE + "|" + text));
  const key = "tts:" + [...new Uint8Array(digest)].slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  try {
    const cached = await env.FREDERIC_KV.get(key, "arrayBuffer");
    if (cached) return new Response(cached, { headers: { "Content-Type": "audio/mpeg" } });
  } catch { /* KV absent */ }

  let audio = null;

  // 1) ElevenLabs si la clé est là (et quota restant)
  if (env.ELEVENLABS_API_KEY) {
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elVoice}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 },
        }),
      });
      if (r.ok) audio = await r.arrayBuffer();
      else dbgErrors.push("elevenlabs:" + r.status);
      // 401/429 = quota épuisé -> on tombe en douceur sur Edge TTS
    } catch (e) { dbgErrors.push("elevenlabs-exc:" + (e?.message || e)); }
  }

  // 2) Edge TTS Microsoft — GRATUIT et illimité, voix masculine naturelle
  if (!audio) {
    try { audio = await edgeTTS(text); } catch (e) { dbgErrors.push("edge:" + (e?.message || e)); }
  }

  if (!audio) {
    // Diagnostic : {"text":"...","debug":true} -> renvoie les erreurs au lieu d'un 204 muet
    if (dbg) return Response.json({ errors: dbgErrors }, { status: 500 });
    return new Response(null, { status: 204 }); // 3) dernier recours : navigateur
  }

  try { await env.FREDERIC_KV.put(key, audio, { expirationTtl: 60 * 60 * 24 * 30 }); } catch { /* noop */ }
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
}
