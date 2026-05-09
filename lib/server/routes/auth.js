const { verifyToken } = require("../supabase");
const { kLoginCleanupIntervalMs } = require("../constants");

const kTokenCookieName = "sb_access_token";
const kTokenTtlMs = 7 * 24 * 60 * 60 * 1000;

const cookieParser = (req) => {
  const cookies = {};
  const header = req?.headers?.cookie || "";
  header.split(";").forEach((c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) cookies[k.trim()] = v.join("=");
  });
  return cookies;
};

const registerAuthRoutes = ({ app, loginThrottle }) => {
  // Exchange a Supabase access_token for an httpOnly server cookie.
  // The frontend calls this after Supabase.auth.signIn resolves.
  app.post("/api/auth/login", async (req, res) => {
    const { access_token } = req.body || {};
    if (!access_token) return res.status(400).json({ ok: false, error: "access_token required" });

    const user = await verifyToken(access_token);
    if (!user) return res.status(401).json({ ok: false, error: "Invalid or expired token" });

    res.cookie(kTokenCookieName, access_token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: kTokenTtlMs,
    });
    res.json({ ok: true, user: { id: user.id, email: user.email } });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(kTokenCookieName, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/auth/status", async (req, res) => {
    const cookies = cookieParser(req);
    const token = cookies[kTokenCookieName];
    const user = token ? await verifyToken(token) : null;
    res.json({ authenticated: !!user, user: user ? { id: user.id, email: user.email } : null });
  });

  const isAuthorizedRequest = (req) => {
    const requestPath = req.path || "";
    if (requestPath.startsWith("/auth/google/callback")) return true;
    if (requestPath.startsWith("/auth/codex/callback")) return true;
    return !!req.user;
  };

  // Public paths that skip auth entirely (onramp flow runs pre-signup).
  const kPublicApiPaths = [
    "/api/onramp/",
    "/api/payments/webhook",
    "/api/auth/",
    "/api/email/inbound",
  ];

  const requireAuth = async (req, res, next) => {
    if (req.path.startsWith("/auth/google/callback")) return next();
    if (req.path.startsWith("/auth/codex/callback")) return next();
    if (kPublicApiPaths.some((p) => req.originalUrl.startsWith(p))) return next();

    if (req.user) return next();

    if (req.originalUrl.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login.html");
  };

  setInterval(() => {
    loginThrottle.cleanupLoginAttemptStates?.();
  }, kLoginCleanupIntervalMs).unref();

  app.use("/setup", requireAuth);
  app.use("/api", requireAuth);
  app.use("/auth", requireAuth);

  return { requireAuth, isAuthorizedRequest };
};

module.exports = { registerAuthRoutes };
