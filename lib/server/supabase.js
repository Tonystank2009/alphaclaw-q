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

const incrementDailyUsage = async (userId, date) => {
  await getAdmin().rpc("increment_daily_usage", { p_user_id: userId, p_date: date });
};

module.exports = { getAdmin, verifyToken, getSubscription, upsertSubscription, getDailyUsage, incrementDailyUsage };
