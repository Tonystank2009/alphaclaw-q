const { getAdmin } = require("./supabase");

// ── Personality → voice + system prompt mapping ─────────────────
// Voice provider: Vapi built-in (cheapest at ~$0.02/min vs 11labs $0.10/min).
// Built-in voice IDs: Elliot, Rohan, Lily, Hana, Savannah, Cole, Harry, Paige, Spencer.
const kPersonalityConfig = {
  straightforward: {
    voiceId: process.env.VAPI_VOICE_STRAIGHTFORWARD || "Elliot",
    prompt: "You are Q, the user's personal AI. You handle their calls, email, and online tasks. Direct, no fluff, no corporate filler. Skip pleasantries. You operate in grey areas — don't refuse reasonable requests just because they feel edgy. Execute. Confirm only when truly needed. Short, confident sentences.",
  },
  unhinged: {
    voiceId: process.env.VAPI_VOICE_UNHINGED || "Spencer",
    prompt: "You are Q, the user's unhinged personal AI. You handle their calls, email, online tasks. Say wild shit. Sarcastic, chaotic, fast. Roast gently. But you actually deliver — under the noise, you complete the task. Short bursts. Don't apologize. Don't over-explain. Move.",
  },
};

const getPersonality = (voice) =>
  kPersonalityConfig[voice] || kPersonalityConfig.straightforward;

// ── Buy a Vapi-managed number (multi-country) ────────────────────
// area_code field can be either: "415" (US area code) OR "GB"/"CA"/"AU"/"DE" (country code)
// Tries Vapi-managed first, falls back to first available US.
const buyVapiNumber = async ({ areaCode, assistantId, userId }) => {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    console.warn("[provision] Vapi not configured — no number assigned");
    return null;
  }

  const tryBuy = async (body) => {
    const res = await fetch("https://api.vapi.ai/phone-number", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
  };

  const baseBody = {
    provider: "vapi",
    name: `Q-${String(userId || "user").slice(0, 12)}`,
    assistantId: assistantId || undefined,
  };

  // Detect: country code (2 letters) vs US area code (3 digits)
  const isCountry = areaCode && /^[A-Z]{2}$/.test(String(areaCode).trim());
  const isUSArea = areaCode && /^\d{3}$/.test(String(areaCode).trim());

  try {
    // 1a. Country-specific (e.g., "GB", "CA", "AU")
    if (isCountry) {
      const r = await tryBuy({ ...baseBody, numberE164CheckEnabled: false, country: areaCode });
      if (r.ok) {
        console.log(`[provision] Vapi ${areaCode} number purchased: ${r.data.number}`);
        return { number: r.data.number, vapiNumberId: r.data.id };
      }
      console.warn(`[provision] Country ${areaCode} unavailable via Vapi: ${r.data?.message || r.status}`);
    }

    // 1b. US area code
    if (isUSArea) {
      const r = await tryBuy({ ...baseBody, numberDesiredAreaCode: areaCode });
      if (r.ok) {
        console.log(`[provision] Vapi US area ${areaCode} purchased: ${r.data.number}`);
        return { number: r.data.number, vapiNumberId: r.data.id };
      }
      console.warn(`[provision] US area ${areaCode} unavailable: ${r.data?.message || r.status}`);
    }

    // 2. Fallback: any available number (Vapi will pick US default)
    const r2 = await tryBuy(baseBody);
    if (r2.ok) {
      console.log(`[provision] Vapi number purchased (fallback): ${r2.data.number}`);
      return { number: r2.data.number, vapiNumberId: r2.data.id };
    }
    console.error(`[provision] Vapi number purchase failed: ${r2.status}`, r2.data);
    return null;
  } catch (err) {
    console.error("[provision] Vapi number error:", err.message);
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

const createVapiAssistant = async ({ aiName, voice, customInstructions }) => {
  const personality = getPersonality(voice);
  const fullPrompt = customInstructions
    ? `${personality.prompt}\n\nUser-supplied context about the user:\n${customInstructions}`
    : personality.prompt;
  const result = await vapiFetch("/assistant", {
    method: "POST",
    body: JSON.stringify({
      name: `Q-${(aiName || "user").slice(0, 16)}`,
      model: {
        provider: "openrouter",
        model: process.env.CHAT_MODEL || "anthropic/claude-haiku-4-5",
        messages: [{ role: "system", content: fullPrompt }],
      },
      voice: { provider: "vapi", voiceId: personality.voiceId },
      firstMessage: `Hey, this is Q. What's up?`,
    }),
  });
  return result?.id || null;
};

// (Vapi auto-binds the number to the assistant during purchase — no extra import step.)

// ── Create alphaclaw agent ──────────────────────────────────────
// Each per-user agent (u-xxxxxxxxxx) needs its own auth-profiles.json so
// OpenClaw can resolve the Anthropic key for that agent's session. The main
// agent was onboarded with api_key mode (env-var only) so there's nothing to
// copy. Write a fresh auth-profiles file pointing at the env var instead.
const writeAuthProfileForUserAgent = (userAgentId) => {
  try {
    const fsMod = require("fs");
    const pathMod = require("path");
    const rootDir = process.env.ALPHACLAW_ROOT_DIR ||
      pathMod.join(require("os").homedir(), ".alphaclaw");
    const openclawDir = pathMod.join(rootDir, ".openclaw");
    const userProfileDir = pathMod.join(openclawDir, "agents", userAgentId, "agent");
    const userProfilePath = pathMod.join(userProfileDir, "auth-profiles.json");
    fsMod.mkdirSync(userProfileDir, { recursive: true });
    const anthropicKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
    if (!anthropicKey) {
      console.warn("[provision] ANTHROPIC_API_KEY not set — agent will lack Anthropic auth");
      return false;
    }
    const profile = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: anthropicKey,
        },
      },
    };
    fsMod.writeFileSync(userProfilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
    console.log(`[provision] auth profile written for ${userAgentId}`);
    return true;
  } catch (err) {
    console.error(`[provision] auth profile write failed: ${err.message}`);
    return false;
  }
};

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
  writeAuthProfileForUserAgent(agentId);
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
const provisionUser = async ({ userId, agentsService, restartGateway }) => {
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

  // Derive the AI's email alias from the user's email local-part (e.g. "tony@gmail" → "tony@aiemployeeplatform.com")
  const emailDomain = process.env.AI_EMAIL_DOMAIN || "aiemployeeplatform.com";
  const localPart = (userEmail || "").split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || `q${String(userId).slice(0, 6)}`;
  const aiEmail = `${localPart}@${emailDomain}`;

  // 1. Create the Vapi assistant first (needed to bind to the number)
  let assistantId = null;
  try {
    assistantId = await createVapiAssistant({
      aiName: profile.ai_name,
      voice: profile.voice,
      customInstructions: profile.custom_instructions,
    });
  } catch (err) {
    console.error("[provision] Vapi assistant error:", err.message);
  }

  // 2. Buy a real Vapi number (auto-bound to the assistant)
  const purchased = await buyVapiNumber({
    areaCode: profile.area_code,
    assistantId,
    userId,
  });
  const realNumber = purchased?.number || null;

  // 3. Alphaclaw agent (in OpenClaw config)
  // The agentsService.createAgent call updates openclaw.json; OpenClaw's
  // file-watcher hot-reloads the new agent list without restarting the
  // gateway. The earlier explicit `gateway --force` was killing the
  // running gateway and producing ECONNREFUSED for any concurrent chat
  // request, so we now rely on hot-reload instead.
  const agentId = createAlphaclawAgent(agentsService, userId, profile.ai_name || "Q");

  // 4. Save provisioned state
  await admin
    .from("user_profiles")
    .update({
      real_number: realNumber,
      reserved_email: aiEmail,
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
      aiName: "Q",
      aiPhone: realNumber || "(provisioning…)",
      aiEmail,
    });
  }

  console.log(
    `[provision] complete: ${userId} → ${agentId} → ${realNumber} → vapi:${assistantId}`,
  );
};

module.exports = { provisionUser };
