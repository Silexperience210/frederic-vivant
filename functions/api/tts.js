/* ═══════════════════════════════════════════════════════════════
   /api/tts — voix de Frédéric (OPTIONNEL)
   Si ELEVENLABS_API_KEY n'est pas défini → 204, et le navigateur
   utilise sa propre synthèse vocale (gratuit).
   Secrets optionnels : ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
   Cache KV : les phrases déjà dites ne sont jamais re-facturées.
   ═══════════════════════════════════════════════════════════════ */

export async function onRequestPost({ request, env }) {
  if (!env.ELEVENLABS_API_KEY) return new Response(null, { status: 204 });

  let text;
  try { text = (await request.json()).text?.slice(0, 600); } catch { /* noop */ }
  if (!text) return new Response(null, { status: 400 });

  const voiceId = env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // "Adam" — grave, clairement masculin

  // ── Cache : hash du texte + voix (sinon les anciennes voix restent servies 30 jours) ──
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(voiceId + "|" + text));
  const key = "tts:" + [...new Uint8Array(digest)].slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  try {
    const cached = await env.FREDERIC_KV.get(key, "arrayBuffer");
    if (cached) return new Response(cached, { headers: { "Content-Type": "audio/mpeg" } });
  } catch { /* KV absent */ }

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 },
    }),
  });
  if (!r.ok) return new Response(null, { status: 204 });   // fallback silencieux

  const audio = await r.arrayBuffer();
  try { await env.FREDERIC_KV.put(key, audio, { expirationTtl: 60 * 60 * 24 * 30 }); } catch { /* noop */ }
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
}
