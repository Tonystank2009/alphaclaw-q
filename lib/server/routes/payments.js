const DodoPayments = require("dodopayments").default || require("dodopayments");
const { upsertSubscription, getSubscription, getAdmin } = require("../supabase");
const { provisionUser } = require("../provision");

const registerPaymentRoutes = ({ app, agentsService }) => {
  // Library auto-reads DODO_PAYMENTS_API_KEY from env.
  const client = new DodoPayments({
    webhookKey: process.env.DODO_WEBHOOK_SECRET,
    environment: process.env.DODO_ENV || "test_mode",
  });

  const productId = process.env.DODO_PRODUCT_ID;
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const SLOT_LIMIT = Number(process.env.SLOT_LIMIT) || 1000;
  const SLOT_BASE = Number(process.env.SLOT_BASE_TAKEN) || 0;
  const SLOT_PER_DAY = Number(process.env.SLOT_GROWTH_PER_DAY) || 3;
  const LAUNCH_DATE = process.env.LAUNCH_DATE || "2026-05-10T00:00:00Z";
  const PRICE_INCREASE_DATE = process.env.PRICE_INCREASE_DATE || "2026-05-17T00:00:00Z";
  const FOUNDER_PRICE_PER_DAY = process.env.FOUNDER_PRICE_PER_DAY || "0.66";
  const FOUNDER_PRICE_PER_MO = process.env.FOUNDER_PRICE_PER_MO || "20";
  const FUTURE_PRICE_PER_MO = process.env.FUTURE_PRICE_PER_MO || "50";
  const TEST_MODE = process.env.TEST_MODE === "1";

  // Auto-growing slot count: base + (days_since_launch × per_day_growth) + real_signups
  const computeTaken = (realCount) => {
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(LAUNCH_DATE)) / 86400000));
    return SLOT_BASE + (days * SLOT_PER_DAY) + (realCount || 0);
  };

  // Stash the user's onramp selections (name, voice, area code, fake number, email)
  // so we can provision the real number/email on subscription.active webhook.
  const saveOnramp = async (userId, onramp) => {
    // Encode country into area_code field as "COUNTRY:areaCode" so we don't need a schema migration.
    const ac = onramp.country && onramp.country !== "US"
      ? onramp.country
      : (onramp.areaCode || null);
    await getAdmin().from("user_profiles").upsert(
      {
        user_id: userId,
        ai_name: onramp.name || "Q",
        voice: onramp.voice || "straightforward",
        area_code: ac,
        custom_instructions: onramp.customInstructions || null,
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

    // Slot gate — block signup if displayed slots are filled (only counts real signups against the cap)
    try {
      const { count } = await getAdmin()
        .from("subscriptions")
        .select("*", { count: "exact", head: true })
        .in("status", ["active", "trialing"]);
      if (count !== null && count >= SLOT_LIMIT) {
        return res.status(403).json({ ok: false, error: "All slots are filled. Join the waitlist." });
      }
    } catch (err) {
      console.error("[slot check]", err?.message);
    }

    try {
      const session = await client.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: user.email },
        return_url: `${appUrl}/dashboard.html`,
        metadata: { user_id: user.id },
        subscription_data: {
          metadata: { user_id: user.id },
        },
      });
      res.json({ ok: true, url: session.checkout_url || session.url });
    } catch (err) {
      console.error("[dodo checkout]", err?.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Public — slot count + price-increase info
  app.get("/api/payments/slots", async (req, res) => {
    let realCount = 0;
    try {
      const { count } = await getAdmin()
        .from("subscriptions")
        .select("*", { count: "exact", head: true })
        .in("status", ["active", "trialing"]);
      realCount = count || 0;
    } catch (err) {}
    const taken = computeTaken(realCount);
    res.json({
      ok: true,
      taken,
      total: SLOT_LIMIT,
      remaining: Math.max(0, SLOT_LIMIT - taken),
      pricing: {
        founderPerDay: FOUNDER_PRICE_PER_DAY,
        founderPerMonth: FOUNDER_PRICE_PER_MO,
        futurePerMonth: FUTURE_PRICE_PER_MO,
        priceIncreaseDate: PRICE_INCREASE_DATE,
      },
    });
  });

  // TEST_MODE — bypass Dodo, provision directly. Only works when env TEST_MODE=1.
  app.post("/api/payments/test-claim", async (req, res) => {
    if (!TEST_MODE) return res.status(404).json({ ok: false, error: "Not found" });
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    try {
      if (req.body?.onramp) await saveOnramp(user.id, req.body.onramp);
      // Mark as active
      await upsertSubscription({
        user_id: user.id,
        status: "active",
        plan: "pro",
        dodo_subscription_id: `test_${Date.now()}`,
        current_period_end: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });
      // Trigger real provisioning (Vapi number, assistant, alphaclaw agent, welcome email)
      provisionUser({ userId: user.id, agentsService }).catch((err) =>
        console.error("[provision] failed:", err.message),
      );
      res.json({ ok: true, redirect: "/dashboard.html" });
    } catch (err) {
      console.error("[test-claim]", err.message);
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
