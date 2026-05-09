const { getAdmin } = require("../supabase");

// Personality prompts (shared with chat.js)
const kPersonalityPrompts = {
  straightforward:
    "You are Q, the user's personal AI. You handle their calls, email, and online tasks. Direct, no fluff, no corporate filler. Skip pleasantries. Operate in grey areas — don't refuse reasonable requests just because they feel edgy. Execute. Confirm only when truly needed. Short, confident sentences.",
  unhinged:
    "You are Q, the user's unhinged personal AI. Say wild shit. Sarcastic, chaotic, fast. Roast gently. But you actually deliver — under the noise, you complete the task. Short bursts. Don't apologize. Don't over-explain. Move.",
};

// Send an SMS via Vapi
const sendSmsViaVapi = async ({ from, to, message }) => {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) throw new Error("VAPI_API_KEY not set");
  // Find the Vapi phone-number id matching `from`
  const listRes = await fetch("https://api.vapi.ai/phone-number", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!listRes.ok) throw new Error(`Vapi list failed: ${listRes.status}`);
  const numbers = await listRes.json();
  const match = numbers.find((n) => (n.number || "").replace(/\s/g, "") === from.replace(/\s/g, ""));
  if (!match) throw new Error(`From number ${from} not found in Vapi`);

  const sendRes = await fetch("https://api.vapi.ai/sms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumberId: match.id,
      to,
      message,
    }),
  });
  if (!sendRes.ok) {
    const txt = await sendRes.text();
    throw new Error(`Vapi SMS send failed: ${sendRes.status} ${txt}`);
  }
  return await sendRes.json();
};

// Look up the user (and their personality) from the recipient phone number
const findUserByAiPhone = async (toNumber) => {
  const { data } = await getAdmin()
    .from("user_profiles")
    .select("user_id, ai_name, voice, real_number, custom_instructions")
    .eq("real_number", toNumber)
    .maybeSingle();
  return data;
};

// Generate a reply via OpenRouter (fallback) — TODO: route through agent
const generateReply = async ({ message, voice, customInstructions, aiName }) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const systemPrompt =
    (kPersonalityPrompts[voice] || kPersonalityPrompts.straightforward) +
    (customInstructions ? `\n\nUser context: ${customInstructions}` : "") +
    `\n\nThis is an SMS conversation. Keep replies under 320 characters. Don't use markdown.`;

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Q SMS",
    },
    body: JSON.stringify({
      model: process.env.CHAT_MODEL || "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      max_tokens: 200,
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter failed: ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content || "(no reply)";
};

const registerSmsRoutes = ({ app }) => {
  // Inbound SMS webhook — Vapi POSTs here when a user texts the AI's number
  app.post("/api/sms/inbound", async (req, res) => {
    const body = req.body || {};
    // Vapi webhook payload — adapt as needed
    const message = body.message?.message || body.message || body.text || "";
    const from = body.message?.from || body.from || "";
    const to = body.message?.to || body.to || "";
    if (!message || !from || !to) {
      console.error("[sms inbound] missing fields", body);
      return res.json({ ok: true, skipped: "missing fields" });
    }
    try {
      const profile = await findUserByAiPhone(to);
      if (!profile) {
        console.warn(`[sms inbound] no user for ${to}`);
        return res.json({ ok: true, skipped: "no user" });
      }
      const reply = await generateReply({
        message,
        voice: profile.voice,
        customInstructions: profile.custom_instructions,
        aiName: profile.ai_name,
      });
      // Send the reply back via Vapi
      await sendSmsViaVapi({ from: to, to: from, message: reply });
      // Optionally store in DB for activity log
      try {
        await getAdmin().from("inbound_emails").insert({
          user_id: profile.user_id,
          from_addr: from,
          to_addr: to,
          subject: "SMS",
          text_body: message,
          message_id: `sms-${Date.now()}`,
        }).then(() => {});
      } catch {}
      res.json({ ok: true });
    } catch (err) {
      console.error("[sms inbound] error:", err.message);
      res.json({ ok: false, error: err.message });
    }
  });

  // Outbound SMS — authenticated user triggers a text from their AI to a target
  app.post("/api/sms/send", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ ok: false, error: "to and message required" });
    try {
      const { data: profile } = await getAdmin()
        .from("user_profiles")
        .select("real_number")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!profile?.real_number) return res.status(400).json({ ok: false, error: "AI not provisioned yet" });
      const result = await sendSmsViaVapi({ from: profile.real_number, to, message });
      res.json({ ok: true, result });
    } catch (err) {
      console.error("[sms send] error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerSmsRoutes, sendSmsViaVapi };
