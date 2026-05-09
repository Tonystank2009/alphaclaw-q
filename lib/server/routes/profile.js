const { getAdmin, getSubscription } = require("../supabase");

const registerProfileRoutes = ({ app }) => {
  // Returns the signed-in user's AI profile + subscription status.
  // Used by dashboard.html to render the post-payment hub.
  app.get("/api/profile/me", async (req, res) => {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    try {
      const [{ data: profile }, sub] = await Promise.all([
        getAdmin()
          .from("user_profiles")
          .select("ai_name, voice, area_code, reserved_number, reserved_email, real_number, agent_id, provisioned_at")
          .eq("user_id", user.id)
          .maybeSingle(),
        getSubscription(user.id),
      ]);

      res.json({
        ok: true,
        user: { id: user.id, email: user.email },
        profile: profile || null,
        subscription: sub || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};

module.exports = { registerProfileRoutes };
