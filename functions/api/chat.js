/* ═══════════════════════════════════════════════════════════════
   /api/chat — Cloudflare Pages Function
   Proxy vers l'API Anthropic. La clé reste côté serveur.
   Binding KV requis : FREDERIC_KV  (rate-limit par IP)
   Secret requis     : ANTHROPIC_API_KEY
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

const MAX_PER_DAY = 40;          // requêtes par IP et par jour
const MAX_MSG_LEN = 500;         // longueur max d'une question

export async function onRequestPost({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // ── Rate limit par IP (KV) ──
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    const day = new Date().toISOString().slice(0, 10);
    const key = `rl:${day}:${ip}`;
    const count = parseInt((await env.FREDERIC_KV.get(key)) || "0", 10);
    if (count >= MAX_PER_DAY) {
      return json({ reply: "Oh là là, que de questions aujourd'hui ! Ma plume a besoin de repos. Reviens me voir demain, promis je serai là !" });
    }
    await env.FREDERIC_KV.put(key, String(count + 1), { expirationTtl: 90000 });
  } catch { /* KV absent : on laisse passer, mais pense à créer le binding ! */ }

  // ── Validation ──
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const messages = (body.messages || [])
    .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_LEN) }))
    .slice(-12);
  if (!messages.length) return json({ error: "no messages" }, 400);

  // ── Appel Claude ──
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",   // rapide + économique, parfait pour 2-3 phrases
      max_tokens: 220,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!r.ok) {
    console.error("Anthropic error", r.status, await r.text());
    return json({ reply: "Ma plume a fait un pâté d'encre ! Repose-moi ta question dans un instant." });
  }

  const data = await r.json();
  const reply = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();

  return json({ reply });
}
