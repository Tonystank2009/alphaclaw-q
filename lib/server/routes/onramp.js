const crypto = require("crypto");

const kEmailDomain = process.env.AI_EMAIL_DOMAIN || "jerome.ai";

// Cryptographically random but display-only number.
// We DO NOT buy this from Twilio yet — that happens after payment.
const generateNumber = (areaCode) => {
  const ac = String(areaCode || "415").replace(/\D/g, "").slice(0, 3) || "415";
  const exchange = 200 + (crypto.randomBytes(1)[0] % 800); // 200-999
  const line = String(crypto.randomBytes(2).readUInt16BE(0) % 10000).padStart(4, "0");
  return `+1 (${ac}) ${exchange}-${line}`;
};

const slugifyName = (name) =>
  String(name || "ai").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "ai";

const registerOnrampRoutes = ({ app }) => {
  // Public — anyone can hit this during the onramp flow, signed-in or not.
  app.post("/api/onramp/generate", (req, res) => {
    const { name, areaCode } = req.body || {};
    const number = generateNumber(areaCode);
    const email = `${slugifyName(name)}@${kEmailDomain}`;
    res.json({ ok: true, number, email });
  });
};

module.exports = { registerOnrampRoutes };
