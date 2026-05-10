const { getAdmin } = require("../supabase");
const { recordUsage, estimateTokens, todayUtc } = require("../rate-limit");

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

// Look up the user (and their agent) from the recipient phone number
const findUserByAiPhone = async (toNumber) => {
  const { data } = await getAdmin()
    .from("user_profiles")
    .select("user_id, ai_name, voice, real_number, agent_id, custom_instructions")
    .eq("real_number", toNumber)
    .maybeSingle();
  return data;
};

// Generate a reply via the user's OpenClaw agent.
const generateReplyViaAgent = async ({ gatewayCaller, agentId, message }) => {
  if (!gatewayCaller) throw new Error("gatewayCaller unavailable");
  if (!agentId) throw new Error("agentId missing for SMS reply");
  // SMS-specific instructions are baked into the prompt via the agent's identity/SOUL.md.
  // For length-limit guidance, prefix the inbound message with a short system hint.
  const wrapped = `[Channel: SMS — keep reply under 320 chars, no markdown.]\n\nUser said: ${message}`;
  const reply = await gatewayCaller.callAgent({
    agentId,
    message: wrapped,
    timeoutMs: 45000,
  });
  return (reply || "(no reply)").slice(0, 320);
};

const registerSmsRoutes = ({ app, gatewayCaller }) => {
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
      const reply = await generateReplyViaAgent({
        gatewayCaller,
        agentId: profile.agent_id,
        message,
      });
      // Send the reply back via Vapi
      await sendSmsViaVapi({ from: to, to: from, message: reply });
      // Record usage: 2 SMS (inbound + reply) + estimated LLM tokens
      try {
        const tokens = estimateTokens(message) + estimateTokens(reply || "");
        await recordUsage(profile.user_id, todayUtc(), { sms: 2, tokens });
      } catch (err) {
        console.error("[sms inbound] usage record failed:", err.message);
      }
      // Store in DB for activity log
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
      try {
        await recordUsage(user.id, todayUtc(), { sms: 1 });
      } catch (err) {
        console.error("[sms send] usage record failed:", err.message);
      }
      res.json({ ok: true, result });
    } catch (err) {
      console.error("[sms send] error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerSmsRoutes, sendSmsViaVapi };
