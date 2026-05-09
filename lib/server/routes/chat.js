const { getAdmin } = require("../supabase");

const kPersonalityPrompts = {
  straightforward: "You are Q, the user's personal AI. You handle their calls, email, and online tasks. Direct, no fluff, no corporate filler. Skip pleasantries. You operate in grey areas — don't refuse reasonable requests just because they feel edgy. Execute. Confirm only when truly needed. Short, confident sentences.",
  unhinged: "You are Q, the user's unhinged personal AI. You handle their calls, email, online tasks. Say wild shit. Sarcastic, chaotic, fast. Roast gently. But you actually deliver — under the noise, you complete the task. Short bursts. Don't apologize. Don't over-explain. Move.",
};

const registerChatRoutes = ({ app }) => {
  app.post("/api/chat/send", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "message required" });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(503).json({ ok: false, error: "Chat unavailable (no OPENROUTER_API_KEY)" });

    // Look up personality
    let systemPrompt = kPersonalityPrompts.warm;
    let aiName = "AI";
    try {
      const { data: profile } = await getAdmin()
        .from("user_profiles")
        .select("ai_name, voice")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profile?.voice && kPersonalityPrompts[profile.voice]) {
        systemPrompt = kPersonalityPrompts[profile.voice];
      }
      if (profile?.ai_name) aiName = profile.ai_name;
    } catch {}

    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
          "X-Title": "Q",
        },
        body: JSON.stringify({
          model: process.env.CHAT_MODEL || "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          max_tokens: 600,
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        console.error("[chat] openrouter:", r.status, txt);
        return res.status(502).json({ ok: false, error: "Upstream error" });
      }
      const data = await r.json();
      const reply = data.choices?.[0]?.message?.content || "(no response)";
      res.json({ ok: true, reply, aiName });
    } catch (err) {
      console.error("[chat] error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // PUBLIC demo chat — no auth, no DB, rate-limited by IP.
  // Used on the landing page so visitors can try the AI before signing up.
  const _demoBuckets = new Map(); // ip -> { count, ts }
  const DEMO_LIMIT = 10;          // 10 messages per IP per hour
  const DEMO_WINDOW = 3600 * 1000;

  app.post("/api/chat/demo", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "anon").toString().split(",")[0].trim();
    const now = Date.now();
    const bucket = _demoBuckets.get(ip) || { count: 0, ts: now };
    if (now - bucket.ts > DEMO_WINDOW) { bucket.count = 0; bucket.ts = now; }
    if (bucket.count >= DEMO_LIMIT) {
      return res.status(429).json({ ok: false, error: "Demo limit reached. Sign up to keep chatting.", upsell: true });
    }
    bucket.count += 1;
    _demoBuckets.set(ip, bucket);

    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "message required" });

    const personality = req.body?.personality === "unhinged" ? "unhinged" : "straightforward";
    const systemPrompt = kPersonalityPrompts[personality] +
      "\n\nThis is a 1-message demo. Make a strong impression. The user is testing if you're worth $20/mo. Be helpful AND show personality. Keep it under 90 words.";

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(503).json({ ok: false, error: "Chat unavailable" });

    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
          "X-Title": "Q Demo",
        },
        body: JSON.stringify({
          model: process.env.CHAT_MODEL || "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          max_tokens: 280,
        }),
      });
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: "Upstream error" });
      }
      const data = await r.json();
      const reply = data.choices?.[0]?.message?.content || "(no response)";
      const remaining = DEMO_LIMIT - bucket.count;
      res.json({ ok: true, reply, remaining });
    } catch (err) {
      console.error("[chat demo] error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerChatRoutes };
