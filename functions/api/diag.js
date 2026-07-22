/* Endpoint de diagnostic temporaire — à supprimer après */
export async function onRequestGet({ env }) {
  const out = { has_key: !!env.MOONSHOT_API_KEY, key_prefix: (env.MOONSHOT_API_KEY || "").slice(0, 6), key_len: (env.MOONSHOT_API_KEY || "").length, model: env.MOONSHOT_MODEL || "moonshot-v1-8k" };
  try {
    const r = await fetch("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.MOONSHOT_API_KEY}` },
      body: JSON.stringify({ model: out.model, max_tokens: 30, messages: [{ role: "user", content: "test" }] }),
    });
    out.moonshot_status = r.status;
    out.moonshot_body = (await r.text()).slice(0, 400);
  } catch (e) {
    out.fetch_error = String(e);
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
}
