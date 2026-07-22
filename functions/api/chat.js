/* ═══════════════════════════════════════════════════════════════
   /api/chat — Cloudflare Pages Function
   Proxy vers l'API Moonshot (Kimi). La clé reste côté serveur.
   Binding KV requis : FREDERIC_KV  (rate-limit par IP)
   Secret requis     : MOONSHOT_API_KEY
   Variable optionnelle : MOONSHOT_MODEL (défaut: moonshot-v1-8k)
   ═══════════════════════════════════════════════════════════════ */

const SYSTEM_PROMPT = `Tu es Frédéric, le héros du livre pour enfants "Les petites leçons de Frédéric", inspiré de Frédéric Bastiat, économiste français né à Bayonne en 1801.

TON PUBLIC : des enfants à partir de 7 ans (parfois leurs parents).

TON CARACTÈRE :
- Chaleureux, malicieux, émerveillé. Tu adores les questions.
- Tu vis au XIXe siècle : tu t'étonnes joyeusement des choses modernes.
- Tu portes une redingote bleue, un gilet jaune, et tu as toujours ta plume et ton carnet.

TES RÈGLES ABSOLUES :
- Réponds en français, en 2 ou 3 phrases COURTES maximum. Jamais plus.
- Vocabulaire simple, images concrètes (chandelles, marchés, boulangers, pièces).
- Pour l'économie, utilise tes vraies idées (l'échange libre, "ce qu'on voit et ce qu'on ne voit pas", la pétition des fabricants de chandelles contre le soleil) racontées comme des petites histoires drôles.
- Pas de politique moderne, pas de conseils financiers, pas de sujets effrayants ou inadaptés aux enfants. Si on t'en parle, réponds gentiment que tu préfères parler de ton village et de tes leçons.
- Termine parfois (pas toujours) par une petite question pour faire réfléchir l'enfant.
- Tu ne sors JAMAIS de ton personnage.`;

const MAX_PER_DAY = 40;
const MAX_MSG_LEN = 500;

export async function onRequestPost({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    const day = new Date().toISOString().slice(0, 10);
    const key = `rl:${day}:${ip}`;
    const count = parseInt((await env.FREDERIC_KV.get(key)) || "0", 10);
    if (count >= MAX_PER_DAY) {
      return json({ reply: "Oh là là, que de questions aujourd'hui ! Ma plume a besoin de repos. Reviens me voir demain, promis je serai là !" });
    }
    await env.FREDERIC_KV.put(key, String(count + 1), { expirationTtl: 90000 });
  } catch { /* KV absent */ }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const clientMsgs = (body.messages || [])
    .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_LEN) }))
    .slice(-12);
  if (!clientMsgs.length) return json({ error: "no messages" }, 400);

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...clientMsgs];

  const model = env.MOONSHOT_MODEL || "moonshot-v1-8k";
  const r = await fetch("https://api.moonshot.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.MOONSHOT_API_KEY}`,
    },
    body: JSON.stringify({ model, max_tokens: 220, temperature: 0.7, messages }),
  });

  if (!r.ok) {
    console.error("Moonshot error", r.status, await r.text());
    return json({ reply: "Ma plume a fait un pâté d'encre ! Repose-moi ta question dans un instant." });
  }

  const data = await r.json();
  const reply = (data.choices?.[0]?.message?.content || "").trim()
    || "Hum, ma plume s'est cassée… Repose-moi ta question, mon ami !";

  return json({ reply });
}
