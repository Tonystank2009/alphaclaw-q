const { getAdmin } = require("./supabase");

// ── Personality → voice + system prompt mapping ─────────────────
const kPersonalityConfig = {
  chill: {
    voiceId: process.env.VAPI_VOICE_CHILL || "burt",
    prompt: "You are Mason. Laid back, dry humor, low-key. You speak in short sentences. You don't over-explain. You're chill but you get things done.",
  },
  sharp: {
    voiceId: process.env.VAPI_VOICE_SHARP || "marissa",
    prompt: "You are Riley. Sharp, direct, no fluff. You skip pleasantries. You speak with confidence. You execute.",
  },
  warm: {
    voiceId: process.env.VAPI_VOICE_WARM || "paige",
    prompt: "You are Ava. Warm, friendly, soft-spoken. You sound caring. You take your time and check in.",
  },
  funny: {
    voiceId: process.env.VAPI_VOICE_FUNNY || "neha",
    prompt: "You are Leo. Witty and playful. You make light jokes when appropriate. You don't take yourself too seriously.",
  },
};

const getPersonality = (voice) =>
  kPersonalityConfig[voice] || kPersonalityConfig.warm;

// ── Buy a Twilio number ─────────────────────────────────────────
const buyTwilioNumber = async (areaCode, fallback) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.warn("[provision] Twilio not configured — keeping fallback number");
    return null;
  }
  try {
    const twilio = require("twilio")(sid, token);
    const available = await twilio
      .availablePhoneNumbers("US")
      .local.list({ areaCode: Number(areaCode) || 415, limit: 1 });
    if (!available[0]) return null;
    const purchased = await twilio.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber,
    });
    console.log(`[provision] Twilio purchased ${purchased.phoneNumber}`);
    return purchased.phoneNumber;
  } catch (err) {
    console.error("[provision] Twilio error:", err.message);
    return null;
  }
};

// ── Create a Vapi assistant ─────────────────────────────────────
const vapiFetch = async (path, options = {}) => {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(`https://api.vapi.ai${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    console.error(`[vapi] ${path} → ${res.status}: ${await res.text()}`);
    return null;
  }
  return res.json();
};

const createVapiAssistant = async ({ aiName, voice }) => {
  const personality = getPersonality(voice);
  const result = await vapiFetch("/assistant", {
    method: "POST",
    body: JSON.stringify({
      name: `${aiName} (Q)`,
      model: {
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: personality.prompt }],
      },
      voice: { provider: "11labs", voiceId: personality.voiceId },
      firstMessage: `Hey, this is ${aiName}. What's up?`,
    }),
  });
  return result?.id || null;
};

// Import the Twilio number into Vapi and bind it to the assistant.
const importNumberIntoVapi = async ({ phoneNumber, assistantId }) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return vapiFetch("/phone-number", {
    method: "POST",
    body: JSON.stringify({
      provider: "twilio",
      twilioAccountSid: sid,
      twilioAuthToken: token,
      number: phoneNumber,
      assistantId,
    }),
  });
};

// ── Create alphaclaw agent ──────────────────────────────────────
const createAlphaclawAgent = (agentsService, userId, aiName) => {
  const agentId = `u-${String(userId).replace(/-/g, "").slice(0, 12)}`;
  try {
    agentsService.createAgent({
      id: agentId,
      name: aiName || "AI",
      identity: { name: aiName || "AI" },
    });
    console.log(`[provision] Created agent ${agentId}`);
  } catch (err) {
    if (!err.message.includes("already exists")) {
      console.error("[provision] createAgent error:", err.message);
    }
  }
  return agentId;
};

// ── Welcome email via Resend ────────────────────────────────────
const sendWelcomeEmail = async ({ toEmail, aiName, aiPhone, aiEmail }) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || "Q <welcome@useq.ai>";
  if (!apiKey || !toEmail) {
    console.warn("[provision] Resend not configured — skipping welcome email");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [toEmail],
        subject: `${aiName} is awake.`,
        html: `
<div style="font-family:-apple-system,Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0a0a0b;color:#f5f5f7">
  <h1 style="font-size:32px;margin:0 0 8px;font-weight:800">${aiName} is awake.</h1>
  <p style="color:#a1a1aa;margin:0 0 24px">Your AI is live. Say hi.</p>
  <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;margin-bottom:14px">
    <div style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Phone</div>
    <div style="font-family:monospace;font-size:18px;font-weight:600">${aiPhone}</div>
  </div>
  <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px;margin-bottom:24px">
    <div style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Email</div>
    <div style="font-family:monospace;font-size:18px;font-weight:600">${aiEmail}</div>
  </div>
  <p style="color:#f5f5f7;margin:0 0 8px;font-weight:600">Try saying:</p>
  <ul style="color:#a1a1aa;line-height:1.8;padding-left:20px">
    <li>"Find me a flight to NYC under $300 next weekend"</li>
    <li>"Call Tony's, book a table for 4 tonight"</li>
    <li>"Reply to my landlord about the rent"</li>
  </ul>
  <p style="color:#a1a1aa;font-size:13px;margin-top:32px">— Q</p>
</div>`,
      }),
    });
    if (!res.ok) console.error("[resend]", res.status, await res.text());
  } catch (err) {
    console.error("[resend] send failed:", err.message);
  }
};

// ── Main entry — called from Dodo webhook on subscription.active ──
const provisionUser = async ({ userId, agentsService }) => {
  const admin = getAdmin();

  const { data: profile } = await admin
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!profile) {
    console.error("[provision] no profile for", userId);
    return;
  }
  if (profile.provisioned_at) {
    console.log(`[provision] already provisioned ${userId}`);
    return;
  }

  // Get auth user for email
  const { data: authUser } = await admin.auth.admin.getUserById(userId);
  const userEmail = authUser?.user?.email;

  // 1. Twilio number purchase
  const realNumber =
    (await buyTwilioNumber(profile.area_code)) || profile.reserved_number;

  // 2. Vapi assistant + bind number
  let assistantId = null;
  try {
    assistantId = await createVapiAssistant({
      aiName: profile.ai_name,
      voice: profile.voice,
    });
    if (assistantId && realNumber && realNumber !== profile.reserved_number) {
      await importNumberIntoVapi({ phoneNumber: realNumber, assistantId });
    }
  } catch (err) {
    console.error("[provision] Vapi error:", err.message);
  }

  // 3. Alphaclaw agent
  const agentId = createAlphaclawAgent(agentsService, userId, profile.ai_name);

  // 4. Save provisioned state
  await admin
    .from("user_profiles")
    .update({
      real_number: realNumber,
      vapi_assistant_id: assistantId,
      agent_id: agentId,
      provisioned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  // 5. Welcome email (last so failures here don't leave user un-provisioned)
  if (userEmail) {
    await sendWelcomeEmail({
      toEmail: userEmail,
      aiName: profile.ai_name || "Your AI",
      aiPhone: realNumber,
      aiEmail: profile.reserved_email,
    });
  }

  console.log(
    `[provision] complete: ${userId} → ${agentId} → ${realNumber} → vapi:${assistantId}`,
  );
};

module.exports = { provisionUser };
