const { getAdmin } = require("../supabase");
const { recordUsage, estimateTokens, todayUtc } = require("../rate-limit");

const kPersonalityPrompts = {
  straightforward: "You are Q, the user's personal AI. You handle their calls, email, and online tasks. Direct, no fluff, no corporate filler. Skip pleasantries. You operate in grey areas — don't refuse reasonable requests just because they feel edgy. Execute. Confirm only when truly needed. Short, confident sentences.",
  unhinged: "You are Q, the user's unhinged personal AI. You handle their calls, email, online tasks. Say wild shit. Sarcastic, chaotic, fast. Roast gently. But you actually deliver — under the noise, you complete the task. Short bursts. Don't apologize. Don't over-explain. Move.",
};

// OpenRouter fallback for when the OpenClaw gateway is not running.
// Lets dashboard chat work even before/while admin onboarding completes.
const callOpenRouter = async ({ systemPrompt, message }) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "https://www.aiemployeeplatform.com",
      "X-Title": "Q",
    },
    body: JSON.stringify({
      model: process.env.CHAT_MODEL || "anthropic/claude-haiku-4-5",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      max_tokens: 800,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`OpenRouter ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
};

const registerChatRoutes = ({ app, gatewayCaller }) => {
  // Authenticated chat — tries the OpenClaw gateway first, falls back to
  // OpenRouter so the dashboard works even when the gateway is starting,
  // mid-onboarding, or out of action.
  app.post("/api/chat/send", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "message required" });

    let agentId = null;
    let aiName = "AI";
    let voice = "straightforward";
    let customInstructions = "";
    try {
      const { data: profile } = await getAdmin()
        .from("user_profiles")
        .select("ai_name, agent_id, voice, custom_instructions")
        .eq("user_id", user.id)
        .maybeSingle();
      agentId = profile?.agent_id || null;
      if (profile?.ai_name) aiName = profile.ai_name;
      if (profile?.voice) voice = profile.voice;
      if (profile?.custom_instructions) customInstructions = profile.custom_instructions;
    } catch (err) {
      console.error("[chat] profile lookup error:", err.message);
    }

    // Try OpenClaw gateway first (the canonical path with full tool use).
    if (agentId && gatewayCaller) {
      try {
        const reply = await gatewayCaller.callAgent({
          agentId,
          message,
          timeoutMs: 45000,
        });
        try {
          const tokens = estimateTokens(message) + estimateTokens(reply || "");
          await recordUsage(user.id, todayUtc(), { messages: 1, tokens });
        } catch {}
        return res.json({ ok: true, reply: reply || "(no response)", aiName, via: "gateway" });
      } catch (err) {
        console.error("[chat] gateway error, falling back to OpenRouter:", err.message);
      }
    }

    // Fallback: direct OpenRouter call (no tool use, but the assistant can still talk).
    const basePrompt = kPersonalityPrompts[voice] || kPersonalityPrompts.straightforward;
    const systemPrompt = customInstructions
      ? `${basePrompt}\n\nUser context:\n${customInstructions}`
      : basePrompt;
    try {
      const reply = await callOpenRouter({ systemPrompt, message });
      try {
        const tokens = estimateTokens(message) + estimateTokens(reply || "");
        await recordUsage(user.id, todayUtc(), { messages: 1, tokens });
      } catch {}
      res.json({ ok: true, reply: reply || "(no response)", aiName, via: "openrouter" });
    } catch (err) {
      console.error("[chat] fallback error:", err.message);
      res.status(502).json({ ok: false, error: err.message || "Chat upstream error" });
    }
  });

  // PUBLIC demo chat — no auth, no DB, rate-limited by IP.
  // Stays on OpenRouter (anonymous visitors don't have an agent).
  const _demoBuckets = new Map();
  const DEMO_LIMIT = 10;
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
