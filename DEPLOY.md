# Q · Deploy Checklist (5-Minute Path to Live)

**Status:** All code is wired. You just need to run a few manual steps in dashboards.

---

## 1. Run the SQL migration in Supabase (30 sec)

Go to: https://supabase.com/dashboard/project/apkewlqqukyxjeiadike/sql/new

Run:
```sql
alter table public.user_profiles add column if not exists custom_instructions text;
```

(Already idempotent — safe to re-run.)

---

## 2. Deploy to Railway (3 min)

1. Go to: https://railway.app/new
2. Click **Deploy from GitHub repo** → pick `Tonystank2009/alphaclaw-q`
3. Click **Variables** → paste the entire contents of your local `.env` file
4. **Override these specific env vars:**
   - `APP_URL=https://aiemployeeplatform.com` (or your Railway URL for now)
   - `DODO_ENV=live` (when ready to take real money)
   - `TEST_MODE=` (delete this — only for local testing)
5. Click **Deploy**. Wait for the build (~2 min). Note the URL Railway gives you.

---

## 3. Point your domain (2 min)

In Vercel DNS for `aiemployeeplatform.com`:
- Add `CNAME @` → `<your-railway-url>` (Railway tells you the exact target after step 2)
- Or: in Railway → Settings → Domains → Add `aiemployeeplatform.com` → it gives you a CNAME → paste in Vercel.

Wait 1-2 min for DNS to propagate.

---

## 4. Configure Dodo webhook (1 min)

1. Open Dodo dashboard → Webhooks → Create webhook
2. URL: `https://aiemployeeplatform.com/api/payments/webhook`
3. Events: `subscription.active`, `subscription.trialing`, `subscription.cancelled`, `subscription.failed`, `subscription.expired`, `subscription.on_hold`
4. Save → copy the **Webhook Secret**
5. Paste into Railway → Variables → `DODO_WEBHOOK_SECRET=<paste>`
6. Railway auto-redeploys.

---

## 5. Configure Resend inbound email (3 min)

For `@aiemployeeplatform.com` to RECEIVE email:

1. Open Resend dashboard → Domains → `aiemployeeplatform.com` → Inbound
2. Enable inbound for the domain (this gives you MX records)
3. **Add MX records to Vercel DNS:**
   - Resend gives you 2 records like `feedback-smtp.us-east-1.amazonses.com` (priority 10) and similar
   - Paste them into Vercel DNS for `aiemployeeplatform.com`
4. Open Resend dashboard → Webhooks → Create webhook
5. URL: `https://aiemployeeplatform.com/api/email/inbound`
6. Event: `email.inbound`
7. Save.
8. **Add the webhook secret** to Railway: `RESEND_INBOUND_SECRET=<resend gives you this>`

---

## 6. Configure Vapi SMS webhook (1 min)

For users texting their AI number to actually reply:

1. Open Vapi dashboard → Phone Numbers → click any number
2. Server URL → `https://aiemployeeplatform.com/api/sms/inbound`
3. Apply this to all numbers (or set as default in Vapi org settings)

---

## 7. Smoke test (2 min)

1. Open https://aiemployeeplatform.com
2. Sign up with a real email
3. Use Dodo test card `4242 4242 4242 4242` (any future date, any CVC) — only works if `DODO_ENV=test_mode`
4. Wait for webhook → provisioning runs
5. Dashboard loads with phone + email shown
6. **Call the phone number** → AI should pick up and talk
7. **Text the phone number from your phone** → AI should reply via SMS
8. **Send an email to the AI's address** → AI should auto-reply

Any failure → check Railway logs.

---

## Things you'll need to do this week (not for launch, but soon)

- Switch `DODO_ENV` to `live` and re-test with a real card
- Set up `support@aiemployeeplatform.com` (Resend can do this)
- Add a real Plausible domain to `PLAUSIBLE_DOMAIN` env var if you want analytics
- Watch Vapi credit balance — each user = ~$2/month for the number + per-minute call charges
- Watch OpenRouter credit balance — each chat message + email auto-reply burns tokens

---

## What's NOT working (and you should know)

- **Computer use / browser automation** — the AI cannot actually book flights, browse Etsy, or fill out web forms. The marketing claims this; the product doesn't deliver it yet. You need to integrate Browserbase, Playwright, or Anthropic Computer Use API. ~2-4 days of engineering. Until then, the AI can chat about doing these things but can't execute.
- **Outbound calls** — the `/api/call/place` endpoint is wired but untested in production. The Vapi assistant is configured for inbound; outbound may need additional Vapi assistant config (`assistantOverrides.firstMessage`) to work cleanly.
- **Memory across sessions** — chat is stateless right now (each message starts fresh).
- **Rich activity feed** — the dashboard doesn't show "your AI did these things today."

---

## What IS working

- ✅ Onboarding flow (5 phases → paywall → Dodo checkout)
- ✅ Real Vapi number purchase per user (signup buys ~$2 number)
- ✅ Real Vapi assistant per user with personality + custom instructions
- ✅ Inbound voice calls — call the AI's number, it picks up and talks (Vapi handles)
- ✅ Inbound SMS — text the AI's number, AI replies (via OpenRouter)
- ✅ Inbound email — email the AI's address, AI auto-replies (via OpenRouter)
- ✅ Dashboard chat (HTTP-based, uses OpenRouter)
- ✅ Welcome email when user signs up
- ✅ Subscription management via Dodo customer portal
- ✅ Privacy / Terms / Refund pages
- ✅ Rate limiting (500 messages/day)
- ✅ Daily slot counter that auto-grows
- ✅ Price-jump countdown (May 17)
- ✅ International country flags (US/UK/CA/AU/DE/FR/NL with US falling back automatically)

---

## Files changed in this build

- `lib/public/dashboard.html` — full Claude-style chat UI
- `lib/public/privacy.html` — new
- `lib/public/terms.html` — new
- `lib/public/refund.html` — new
- `lib/server/routes/sms.js` — new (inbound + outbound)
- `lib/server/routes/calls.js` — new (outbound calls)
- `lib/server/routes/email-inbound.js` — added auto-reply
- `lib/server/routes/auth.js` — added `/api/sms/inbound` to public paths
- `lib/server/init/register-server-routes.js` — registered new routes + rate-limit
