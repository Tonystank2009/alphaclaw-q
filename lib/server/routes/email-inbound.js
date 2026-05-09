const { getAdmin } = require("../supabase");

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
        .select("user_id")
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

      console.log(`[email-inbound] stored email for ${toAddr}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("[email-inbound] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
};

module.exports = { registerEmailInboundRoutes };
