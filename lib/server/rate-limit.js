const { getDailyUsageDetailed, recordUsage, getSubscription } = require("./supabase");

// ── Plan limits (env-overridable) ──────────────────────────────
// Daily caps tuned so max monthly COGS per Pro user stays under $13:
//   $2 number + $4.90 voice (70 min) + $2.31 tokens (1.05M) + $2.93 SMS (390)
//   + $0.20 email = $12.34/mo absolute ceiling on Haiku 4.5.
// Average user (10% utilization) costs ~$3/mo → 85% gross margin.
// Free tier has no Vapi number — caps are LLM-only and tiny.
const kPlans = {
  free: {
    tokens: Number(process.env.PLAN_FREE_TOKENS_DAILY) || 2_000,
    voice_seconds: Number(process.env.PLAN_FREE_VOICE_SECONDS_DAILY) || 30,
    sms: Number(process.env.PLAN_FREE_SMS_DAILY) || 3,
    emails: Number(process.env.PLAN_FREE_EMAILS_DAILY) || 5,
    messages: Number(process.env.PLAN_FREE_MESSAGES_DAILY) || 20,
  },
  pro: {
    // At $30/mo plan + Vapi built-in voice ($0.07/min), max COGS = $13.41 → 55% margin floor.
    tokens: Number(process.env.PLAN_PRO_TOKENS_DAILY) || 30_000,        // 900k/mo, ~$1.98 max
    voice_seconds: Number(process.env.PLAN_PRO_VOICE_SECONDS_DAILY) || 180, // 3 min/day, 90 min/mo, $6.30 max
    sms: Number(process.env.PLAN_PRO_SMS_DAILY) || 13,                  // 390/mo, $2.93 max
    emails: Number(process.env.PLAN_PRO_EMAILS_DAILY) || 50,            // 1500/mo, $0.20 max
    messages: Number(process.env.PLAN_PRO_MESSAGES_DAILY) || 200,
  },
};

const todayUtc = () => new Date().toISOString().slice(0, 10);

const planForUser = async (userId) => {
  try {
    const sub = await getSubscription(userId);
    if (sub?.status === "active" || sub?.status === "trialing") return "pro";
  } catch {}
  return "free";
};

// Rough token count from a string. ~4 chars per token. Round up.
const estimateTokens = (text = "") => Math.ceil(String(text).length / 4);

// Check whether user has budget for a given resource. Returns { ok, used, limit, plan }.
const checkBudget = async (userId, resource) => {
  const plan = await planForUser(userId);
  const limits = kPlans[plan] || kPlans.free;
  const usage = await getDailyUsageDetailed(userId, todayUtc());
  const used = usage[resource] || 0;
  const limit = limits[resource] || 0;
  return { ok: used < limit, used, limit, plan, remaining: Math.max(0, limit - used) };
};

// Express middleware factory. Pass the resource being consumed.
// Pre-flight checks tokens AND messages caps. Post-call recording is done
// by the route itself via `recordUsage` once it knows the actual cost.
const createRateLimitMiddleware = ({ resource = "messages" } = {}) => async (req, res, next) => {
  const user = req.user;
  if (!user) return next();
  try {
    const budget = await checkBudget(user.id, resource);
    if (!budget.ok) {
      return res.status(429).json({
        ok: false,
        error: `Daily ${resource} limit reached (${budget.used}/${budget.limit}). Resets at midnight UTC.`,
        plan: budget.plan,
        used: budget.used,
        limit: budget.limit,
        upgrade: budget.plan === "free" ? "/subscribe.html" : null,
      });
    }
    // Annotate req so the route can record actual usage after the LLM call.
    req.rateLimit = { plan: budget.plan, remaining: budget.remaining };
  } catch (err) {
    // Never block on rate-limit DB error — log and let through.
    console.error("[rate-limit] error:", err?.message);
  }
  next();
};

module.exports = {
  createRateLimitMiddleware,
  checkBudget,
  estimateTokens,
  recordUsage,
  todayUtc,
  planForUser,
  kPlans,
};
