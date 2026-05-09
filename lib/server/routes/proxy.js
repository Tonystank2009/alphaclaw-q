const registerProxyRoutes = ({
  app,
  proxy,
  getGatewayUrl,
  SETUP_API_PREFIXES,
  requireAuth,
  oauthCallbackMiddleware,
  webhookMiddleware,
  rateLimitMiddleware,
}) => {
  const kOpenClawPathPattern = /^\/openclaw\/.+/;
  const kAssetsPathPattern = /^\/assets\/.+/;
  const kHooksPathPattern = /^\/hooks\/.+/;
  const kWebhookPathPattern = /^\/webhook\/.+/;
  const kApiPathPattern = /^\/api\/.+/;

  // Chat paths that count toward rate limit
  const kRateLimitedPaths = ["/openclaw", "/api/run", "/api/chat"];
  const isRateLimited = (req) =>
    rateLimitMiddleware && kRateLimitedPaths.some((p) => req.path.startsWith(p));

  app.all("/openclaw", requireAuth, async (req, res, next) => {
    if (isRateLimited(req)) await rateLimitMiddleware(req, res, () => {});
    if (res.headersSent) return;
    req.url = "/";
    proxy.web(req, res, { target: getGatewayUrl() });
  });
  app.all(kOpenClawPathPattern, requireAuth, async (req, res, next) => {
    if (isRateLimited(req)) await rateLimitMiddleware(req, res, () => {});
    if (res.headersSent) return;
    req.url = req.url.replace(/^\/openclaw/, "");
    proxy.web(req, res, { target: getGatewayUrl() });
  });
  app.all(kAssetsPathPattern, requireAuth, (req, res) =>
    proxy.web(req, res, { target: getGatewayUrl() }),
  );

  app.all("/oauth/:id", oauthCallbackMiddleware);
  app.all(kHooksPathPattern, webhookMiddleware);
  app.all(kWebhookPathPattern, webhookMiddleware);

  app.all(kApiPathPattern, async (req, res, next) => {
    if (SETUP_API_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (isRateLimited(req) && req.user) {
      await rateLimitMiddleware(req, res, () => {});
      if (res.headersSent) return;
    }
    proxy.web(req, res, { target: getGatewayUrl() });
  });
};

module.exports = { registerProxyRoutes };
