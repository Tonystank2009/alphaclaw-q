const kEmailDomain = process.env.AI_EMAIL_DOMAIN || "aiemployeeplatform.com";

// Display-only "reserved" indicator during onramp.
// We do NOT show a fake number — confusing if the real one is different after payment.
// Real Vapi number is purchased + assigned by provision.js on subscription.active webhook.
const previewNumber = (areaCode) => {
  const ac = String(areaCode || "415").replace(/\D/g, "").slice(0, 3) || "415";
  return `+1 (${ac}) ××× ××××`;
};

const slugifyName = (name) =>
  String(name || "ai").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "ai";

const registerOnrampRoutes = ({ app }) => {
  // Public — anyone can hit this during the onramp flow, signed-in or not.
  app.post("/api/onramp/generate", (req, res) => {
    const { name, areaCode } = req.body || {};
    const number = previewNumber(areaCode);
    const email = `${slugifyName(name)}@${kEmailDomain}`;
    res.json({ ok: true, number, email });
  });
};

module.exports = { registerOnrampRoutes };
