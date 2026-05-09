const { getAdmin } = require("../supabase");

const kPersonalityPrompts = {
  chill: "You are Mason. Laid back, dry humor, low-key. Short sentences. You don't over-explain. Chill but you get things done.",
  sharp: "You are Riley. Sharp, direct, no fluff. Skip pleasantries. Confident. You execute.",
  warm:  "You are Ava. Warm, friendly, soft-spoken. Caring. Take your time and check in.",
  funny: "You are Leo. Witty and playful. Light jokes when appropriate. Don't take yourself too seriously.",
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
};

module.exports = { registerChatRoutes };
