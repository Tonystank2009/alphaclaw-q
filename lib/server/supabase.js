const { createClient } = require("@supabase/supabase-js");

let _admin = null;

const getAdmin = () => {
  if (!_admin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  return _admin;
};

// Verify a Supabase access token. Returns the user or null.
const verifyToken = async (token) => {
  if (!token) return null;
  try {
    const { data, error } = await getAdmin().auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
};

// Check if user has an active subscription.
const getSubscription = async (userId) => {
  const { data } = await getAdmin()
    .from("subscriptions")
    .select("status, plan, stripe_subscription_id, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  return data || null;
};

const upsertSubscription = async (payload) => {
  await getAdmin().from("subscriptions").upsert(payload, { onConflict: "user_id" });
};

const getDailyUsage = async (userId, date) => {
  const { data } = await getAdmin()
    .from("usage_daily")
    .select("message_count")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();
  return data?.message_count || 0;
};

// Full multi-resource counters for tier-aware checks.
const getDailyUsageDetailed = async (userId, date) => {
  const { data } = await getAdmin()
    .from("usage_daily")
    .select("message_count, tokens_used, voice_seconds, sms_count, email_count")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();
  return {
    messages: data?.message_count || 0,
    tokens: data?.tokens_used || 0,
    voice_seconds: data?.voice_seconds || 0,
    sms: data?.sms_count || 0,
    emails: data?.email_count || 0,
  };
};

// Sum the user's daily rows for the current month (UTC). Used for monthly caps.
// monthStart = "YYYY-MM-01" (first day of current UTC month).
const getMonthlyUsageDetailed = async (userId, monthStart) => {
  const monthEnd = new Date(monthStart + "T00:00:00Z");
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const monthEndIso = monthEnd.toISOString().slice(0, 10);

  const { data } = await getAdmin()
    .from("usage_daily")
    .select("message_count, tokens_used, voice_seconds, sms_count, email_count")
    .eq("user_id", userId)
    .gte("date", monthStart)
    .lt("date", monthEndIso);

  const totals = (data || []).reduce(
    (acc, row) => ({
      messages: acc.messages + (row.message_count || 0),
      tokens: acc.tokens + (row.tokens_used || 0),
      voice_seconds: acc.voice_seconds + (row.voice_seconds || 0),
      sms: acc.sms + (row.sms_count || 0),
      emails: acc.emails + (row.email_count || 0),
    }),
    { messages: 0, tokens: 0, voice_seconds: 0, sms: 0, emails: 0 },
  );
  return totals;
};

const incrementDailyUsage = async (userId, date) => {
  await getAdmin().rpc("increment_daily_usage", { p_user_id: userId, p_date: date });
};

// Multi-resource atomic increment. Pass any combination of deltas.
const recordUsage = async (userId, date, deltas = {}) => {
  await getAdmin().rpc("record_usage", {
    p_user_id: userId,
    p_date: date,
    p_messages: deltas.messages || 0,
    p_tokens: deltas.tokens || 0,
    p_voice_secs: deltas.voice_seconds || 0,
    p_sms: deltas.sms || 0,
    p_emails: deltas.emails || 0,
  });
};

module.exports = {
  getAdmin,
  verifyToken,
  getSubscription,
  upsertSubscription,
  getDailyUsage,
  getDailyUsageDetailed,
  getMonthlyUsageDetailed,
  incrementDailyUsage,
  recordUsage,
};
