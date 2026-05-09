const { getDailyUsage, incrementDailyUsage } = require("./supabase");

const kDailyMessageLimit = Number(process.env.DAILY_MESSAGE_LIMIT) || 500;

const todayUtc = () => new Date().toISOString().slice(0, 10);

// Express middleware — attaches after requireAuth populates req.user.
// Counts every proxied message and enforces daily cap.
const createRateLimitMiddleware = () => async (req, res, next) => {
  const user = req.user;
  if (!user) return next();

  const date = todayUtc();
  try {
    const count = await getDailyUsage(user.id, date);
    if (count >= kDailyMessageLimit) {
      return res.status(429).json({
        ok: false,
        error: `Daily limit of ${kDailyMessageLimit} messages reached. Resets at midnight UTC.`,
        limit: kDailyMessageLimit,
        used: count,
      });
    }
    await incrementDailyUsage(user.id, date);
  } catch (err) {
    // Never block the user on a rate-limit DB error — log and continue.
    console.error("[rate-limit] error:", err?.message);
  }
  next();
};

module.exports = { createRateLimitMiddleware };
