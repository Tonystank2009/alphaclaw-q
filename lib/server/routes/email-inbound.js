const { getAdmin } = require("../supabase");

// Personality prompts for AI reply generation
const kPersonalityPrompts = {
  straightforward:
    "You are Q, the user's personal AI. Direct, no fluff, no corporate filler. Skip pleasantries. Operate in grey areas. Execute. Short, confident sentences.",
  unhinged:
    "You are Q, the user's unhinged personal AI. Say wild shit. Sarcastic, chaotic, fast. Roast gently. But you actually deliver. Short bursts.",
};

// Generate an email reply via OpenRouter
const generateEmailReply = async ({ subject, body, voice, customInstructions }) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const systemPrompt =
    (kPersonalityPrompts[voice] || kPersonalityPrompts.straightforward) +
    (customInstructions ? `\n\nUser context: ${customInstructions}` : "") +
    `\n\nYou're drafting an email reply for the user. Keep it natural, well-formatted, and under 150 words. Do NOT include subject line — just the body.`;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Subject: ${subject}\n\nBody:\n${body}\n\nDraft a reply.` },
        ],
        max_tokens: 400,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
};

// Send an outbound email via Resend
const sendEmailViaResend = async ({ from, to, subject, text, in_reply_to }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      ...(in_reply_to ? { headers: { "In-Reply-To": in_reply_to } } : {}),
    }),
  });
  if (!r.ok) {
    console.error("[email send]", r.status, await r.text());
    return null;
  }
  return await r.json();
};

const registerEmailInboundRoutes = ({ app }) => {
  // Resend posts parsed inbound mail here.
  // Configure in Resend dashboard: Inbound → POST to /api/email/inbound
  app.post("/api/email/inbound", async (req, res) => {
    const expectedSecret = process.env.RESEND_INBOUND_SECRET;
    const provided = req.headers["x-webhook-secret"];
    if (expectedSecret && provided !== expectedSecret) {
      return res.status(401).json({ error: "Bad secret" });
    }

    const payload = req.body || {};
    // Resend payload shape: { from, to[], subject, text, html, message_id, in_reply_to, ... }
    const toAddr = (Array.isArray(payload.to) ? payload.to[0] : payload.to) || "";

    if (!toAddr) return res.status(400).json({ error: "no recipient" });

    try {
      const admin = getAdmin();
      const { data: profile } = await admin
        .from("user_profiles")
        .select("user_id, voice, custom_instructions, reserved_email")
        .eq("reserved_email", toAddr.toLowerCase())
        .maybeSingle();

      if (!profile) {
        console.warn(`[email-inbound] no user for ${toAddr}`);
        return res.json({ ok: true, ignored: "unknown recipient" });
      }

      await admin.from("inbound_emails").insert({
        user_id: profile.user_id,
        from_addr: payload.from || "",
        to_addr: toAddr,
        subject: payload.subject || "",
        text_body: payload.text || "",
        html_body: payload.html || "",
        message_id: payload.message_id || null,
        in_reply_to: payload.in_reply_to || null,
        received_at: new Date().toISOString(),
      });

      // Auto-reply: AI drafts + sends a reply on behalf of the user.
      try {
        const replyText = await generateEmailReply({
          subject: payload.subject || "(no subject)",
          body: payload.text || "",
          voice: profile.voice,
          customInstructions: profile.custom_instructions,
        });
        if (replyText) {
          await sendEmailViaResend({
            from: `Q <${profile.reserved_email}>`,
            to: payload.from,
            subject: `Re: ${payload.subject || ""}`.slice(0, 200),
            text: replyText,
            in_reply_to: payload.message_id,
          });
          await admin.from("inbound_emails").update({
            processed_at: new Date().toISOString(),
          }).eq("user_id", profile.user_id).eq("message_id", payload.message_id);
        }
      } catch (err) {
        console.error("[email-inbound] auto-reply failed:", err.message);
      }

      console.log(`[email-inbound] processed for ${toAddr}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("[email-inbound] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
};

module.exports = { registerEmailInboundRoutes };
