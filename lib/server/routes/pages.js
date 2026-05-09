const path = require("path");
const fs = require("fs");

const kPublicDir = path.join(__dirname, "..", "..", "public");

// Inject Supabase public env vars into HTML templates at request time.
const injectEnv = (filename) => (req, res) => {
  try {
    let html = fs.readFileSync(path.join(kPublicDir, filename), "utf8");
    html = html
      .replace(/%%SUPABASE_URL%%/g, process.env.SUPABASE_URL || "")
      .replace(/%%SUPABASE_ANON_KEY%%/g, process.env.SUPABASE_ANON_KEY || "")
      .replace(/%%PLAUSIBLE_DOMAIN%%/g, process.env.PLAUSIBLE_DOMAIN || "");
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch {
    res.status(500).send("Page unavailable");
  }
};

const registerPageRoutes = ({ app, requireAuth, isGatewayRunning }) => {
  app.get("/health", async (req, res) => {
    const running = await isGatewayRunning();
    res.json({
      status: running ? "healthy" : "starting",
      gateway: running ? "running" : "starting",
    });
  });

  // Serve login + subscribe without auth (they ARE the auth/onramp pages)
  app.get("/login.html", injectEnv("login.html"));
  app.get("/subscribe.html", injectEnv("subscribe.html"));

  app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(kPublicDir, "setup.html"));
  });

  app.get("/setup", (req, res) => {
    res.sendFile(path.join(kPublicDir, "setup.html"));
  });
};

module.exports = { registerPageRoutes };
