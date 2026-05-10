const { getAdmin } = require("../supabase");
const { recordUsage, estimateTokens, todayUtc } = require("../rate-limit");

// Draft an email reply via the user's OpenClaw agent.
const generateEmailReplyViaAgent = async ({ gatewayCaller, agentId, subject, body, fromAddr }) => {
  if (!gatewayCaller || !agentId) return null;
  const wrapped =
    `[Channel: Email — draft a natural reply body, under 150 words, no subject line, no markdown.]\n\n` +
    `From: ${fromAddr || "(unknown)"}\n` +
    `Subject: ${subject || "(no subject)"}\n\n` +
    `Body:\n${body || ""}\n\n` +
    `Draft the reply.`;
  try {
    const reply = await gatewayCaller.callAgent({
      agentId,
      message: wrapped,
      timeoutMs: 60000,
    });
    return reply || null;
  } catch (err) {
    console.error("[email-inbound] gateway error:", err.message);
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

const registerEmailInboundRoutes = ({ app, gatewayCaller }) => {
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
        .select("user_id, voice, custom_instructions, reserved_email, agent_id")
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

      // Auto-reply: AI drafts + sends a reply via the user's OpenClaw agent.
      try {
        const replyText = await generateEmailReplyViaAgent({
          gatewayCaller,
          agentId: profile.agent_id,
          subject: payload.subject || "(no subject)",
          body: payload.text || "",
          fromAddr: payload.from || "",
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
          // Record usage: 2 emails (inbound + reply) + estimated tokens
          try {
            const tokens =
              estimateTokens(payload.text || "") +
              estimateTokens(replyText);
            await recordUsage(profile.user_id, todayUtc(), { emails: 2, tokens });
          } catch (err) {
            console.error("[email-inbound] usage record failed:", err.message);
          }
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
