const DodoPayments = require("dodopayments").default || require("dodopayments");
const { upsertSubscription, getSubscription, getAdmin } = require("../supabase");
const { provisionUser } = require("../provision");

const registerPaymentRoutes = ({ app, agentsService }) => {
  const client = new DodoPayments({
    bearerToken: process.env.DODO_API_KEY,
    webhookKey: process.env.DODO_WEBHOOK_SECRET,
    environment: process.env.DODO_ENV || "test_mode",
  });

  const productId = process.env.DODO_PRODUCT_ID;
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const trialDays = Number(process.env.TRIAL_DAYS) || 7;

  // Stash the user's onramp selections (name, voice, area code, fake number, email)
  // so we can provision the real number/email on subscription.active webhook.
  const saveOnramp = async (userId, onramp) => {
    await getAdmin().from("user_profiles").upsert(
      {
        user_id: userId,
        ai_name: onramp.name,
        voice: onramp.voice,
        area_code: onramp.areaCode,
        reserved_number: onramp.number,
        reserved_email: onramp.email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  };

  // Create a Dodo checkout session with 7-day trial.
  app.post("/api/payments/checkout", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    // Persist onramp choices so we can provision after payment.
    if (req.body?.onramp) {
      try { await saveOnramp(user.id, req.body.onramp); } catch (err) {
        console.error("[onramp save]", err?.message);
      }
    }

    try {
      const session = await client.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: user.email },
        return_url: `${appUrl}/dashboard.html`,
        metadata: { user_id: user.id },
        subscription_data: {
          trial_period_days: trialDays,
          metadata: { user_id: user.id },
        },
      });
      res.json({ ok: true, url: session.checkout_url || session.url });
    } catch (err) {
      console.error("[dodo checkout]", err?.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Dodo webhook — verify signature, update subscription.
  // Mounted with raw body parser in server.js BEFORE express.json.
  app.post("/api/payments/webhook", async (req, res) => {
    const headers = {
      "webhook-id": req.headers["webhook-id"],
      "webhook-signature": req.headers["webhook-signature"],
      "webhook-timestamp": req.headers["webhook-timestamp"],
    };

    let event;
    try {
      event = await client.webhooks.unwrap(req.body.toString(), headers);
    } catch (err) {
      return res.status(400).json({ error: `Bad signature: ${err.message}` });
    }

    const data = event.data || {};
    const userId = data.metadata?.user_id;
    if (!userId) return res.json({ received: true, skipped: "no user_id" });

    const statusMap = {
      "subscription.active": "active",
      "subscription.trialing": "trialing",
      "subscription.on_hold": "past_due",
      "subscription.failed": "unpaid",
      "subscription.cancelled": "canceled",
      "subscription.expired": "canceled",
    };
    const newStatus = statusMap[event.type];

    if (newStatus) {
      await upsertSubscription({
        user_id: userId,
        dodo_customer_id: data.customer_id || data.customer?.customer_id,
        dodo_subscription_id: data.subscription_id || data.id,
        status: newStatus,
        plan: "pro",
        current_period_end: data.next_billing_date
          ? new Date(data.next_billing_date).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      });

      // Trigger provisioning the moment they're trialing or active.
      // Idempotent — safe to fire multiple times.
      if (newStatus === "active" || newStatus === "trialing") {
        provisionUser({ userId, agentsService }).catch((err) =>
          console.error("[provision] failed:", err.message),
        );
      }
    }

    res.json({ received: true });
  });

  app.get("/api/payments/status", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false });
    const sub = await getSubscription(user.id);
    res.json({ ok: true, subscription: sub });
  });

  // Returns a Dodo customer portal URL — for cancel/update payment method.
  app.post("/api/payments/portal", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false });
    const sub = await getSubscription(user.id);
    if (!sub?.dodo_customer_id) {
      return res.status(404).json({ ok: false, error: "No subscription yet" });
    }
    try {
      const portal = await client.customers.customerPortal.create(
        sub.dodo_customer_id,
        { send_email: false },
      );
      res.json({ ok: true, url: portal.link });
    } catch (err) {
      console.error("[dodo portal]", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Subscription gate: trialing OR active gets through.
  const requireSubscription = async (req, res, next) => {
    const user = req.user;
    if (!user) return next();

    const bypass = ["/api/payments/", "/api/auth/", "/api/onramp/", "/subscribe.html", "/login.html"];
    if (bypass.some((p) => req.originalUrl.startsWith(p))) return next();

    try {
      const sub = await getSubscription(user.id);
      if (sub?.status === "active" || sub?.status === "trialing") return next();
    } catch {
      return next();
    }

    if (req.originalUrl.startsWith("/api/")) {
      return res.status(402).json({ ok: false, error: "Subscription required", redirect: "/subscribe.html" });
    }
    return res.redirect("/subscribe.html");
  };

  return { requireSubscription };
};

module.exports = { registerPaymentRoutes };
