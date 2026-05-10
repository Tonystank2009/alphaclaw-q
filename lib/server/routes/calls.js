const { getAdmin } = require("../supabase");
const { recordUsage, todayUtc } = require("../rate-limit");

// Place an outbound call via Vapi using the user's assistant + phone number.
// The assistant carries the personality + custom instructions baked at provision time.
const placeOutboundCall = async ({ phoneNumberId, assistantId, customer, instructions }) => {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) throw new Error("VAPI_API_KEY not set");

  const body = {
    phoneNumberId,
    assistantId,
    customer,
  };
  if (instructions) {
    // Pass per-call goal as assistantOverrides → firstMessage and a system-prompt addendum
    body.assistantOverrides = {
      firstMessage: `Hey, this is calling on behalf of someone — quick thing: ${instructions}`,
      model: {
        messages: [
          { role: "system", content: `For this call, your goal: ${instructions}\n\nKeep it tight, polite, and human.` },
        ],
      },
    };
  }

  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Vapi call failed: ${res.status} ${txt}`);
  }
  return await res.json();
};

const findVapiNumberId = async (phoneNumber) => {
  const apiKey = process.env.VAPI_API_KEY;
  const r = await fetch("https://api.vapi.ai/phone-number", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error("Vapi list failed");
  const numbers = await r.json();
  const norm = (s) => String(s || "").replace(/\s/g, "");
  return numbers.find((n) => norm(n.number) === norm(phoneNumber))?.id || null;
};

const registerCallRoutes = ({ app }) => {
  // Authenticated user asks their AI to make a call.
  // Body: { to: "+15551234567", goal: "ask if they take dogs" }
  app.post("/api/call/place", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const { to, goal } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: "`to` required" });

    try {
      const { data: profile } = await getAdmin()
        .from("user_profiles")
        .select("real_number, vapi_assistant_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!profile?.real_number || !profile?.vapi_assistant_id) {
        return res.status(400).json({ ok: false, error: "AI not fully provisioned yet" });
      }

      const phoneNumberId = await findVapiNumberId(profile.real_number);
      if (!phoneNumberId) return res.status(500).json({ ok: false, error: "Phone number not found in Vapi" });

      const result = await placeOutboundCall({
        phoneNumberId,
        assistantId: profile.vapi_assistant_id,
        customer: { number: to },
        instructions: goal,
      });
      res.json({ ok: true, callId: result?.id, status: result?.status });
    } catch (err) {
      console.error("[call place] error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Vapi end-of-call webhook — records actual voice seconds against the user.
  // Configure in Vapi: Phone Numbers → Server URL → /api/call/vapi-webhook
  // Or per-org server URL. Vapi posts call events; we only care about end-of-call-report.
  app.post("/api/call/vapi-webhook", async (req, res) => {
    try {
      const body = req.body || {};
      // Vapi wraps payloads in `message`. Type field varies by event.
      const msg = body.message || body;
      const type = String(msg?.type || "").toLowerCase();
      // Track on completion only.
      if (type !== "end-of-call-report" && type !== "status-update") {
        return res.json({ ok: true, ignored: type });
      }
      const status = String(msg?.status || msg?.endedReason || "").toLowerCase();
      const isEnded =
        type === "end-of-call-report" ||
        status === "ended" ||
        status === "completed";
      if (!isEnded) return res.json({ ok: true, ignored: "not ended" });

      const call = msg?.call || {};
      const assistantId = call?.assistantId || msg?.assistantId;
      // Duration: Vapi gives `duration` in seconds at end-of-call-report. Fallback to (endedAt - startedAt).
      const startedAt = call?.startedAt || msg?.startedAt;
      const endedAt = call?.endedAt || msg?.endedAt;
      let seconds =
        Number(msg?.durationSeconds || msg?.duration) ||
        (startedAt && endedAt
          ? Math.max(0, Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
          : 0);
      if (!seconds || !assistantId) {
        return res.json({ ok: true, ignored: "missing seconds or assistantId" });
      }

      // Look up the user by their Vapi assistant id.
      const { data: profile } = await getAdmin()
        .from("user_profiles")
        .select("user_id")
        .eq("vapi_assistant_id", assistantId)
        .maybeSingle();
      if (!profile) {
        console.warn("[vapi webhook] no user for assistant", assistantId);
        return res.json({ ok: true, skipped: "no user" });
      }
      await recordUsage(profile.user_id, todayUtc(), { voice_seconds: seconds });
      return res.json({ ok: true, recorded_seconds: seconds });
    } catch (err) {
      console.error("[vapi webhook] error:", err.message);
      // Vapi will retry on non-2xx; respond 200 to acknowledge regardless.
      return res.json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerCallRoutes, placeOutboundCall };
