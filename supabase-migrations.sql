-- Run in Supabase SQL editor.

-- 1. Subscriptions (Dodo-backed)
create table if not exists public.subscriptions (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  dodo_customer_id          text,
  dodo_subscription_id      text,
  status               text not null default 'inactive',
  -- 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled' | 'inactive'
  plan                 text not null default 'pro',
  current_period_end   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
create policy "users read own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);
create policy "service role full access subscriptions" on public.subscriptions
  for all using (true) with check (true);


-- 2. User profile (onramp choices: name, voice, number, email)
create table if not exists public.user_profiles (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  ai_name          text,
  voice            text,
  area_code        text,
  reserved_number  text,    -- displayed at signup; real number bought after payment
  reserved_email   text,    -- the @yourdomain.ai alias
  real_number      text,    -- actual provisioned Twilio/Vapi number
  agent_id         text,    -- alphaclaw agent id once created
  vapi_assistant_id text,   -- Vapi assistant for inbound calls
  custom_instructions text, -- user-supplied "tell your AI about you" textarea
  provisioned_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- For existing deployments — add new column if missing
alter table public.user_profiles add column if not exists custom_instructions text;

alter table public.user_profiles enable row level security;
create policy "users read own profile" on public.user_profiles
  for select using (auth.uid() = user_id);
create policy "service role full access profiles" on public.user_profiles
  for all using (true) with check (true);


-- 3. Daily usage (rate limit counter)
create table if not exists public.usage_daily (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  date          date not null,
  message_count int not null default 0,
  unique (user_id, date)
);

alter table public.usage_daily enable row level security;
create policy "users read own usage" on public.usage_daily
  for select using (auth.uid() = user_id);
create policy "service role full access usage" on public.usage_daily
  for all using (true) with check (true);


-- 4. Inbound emails (forwarded to AI agent context)
create table if not exists public.inbound_emails (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  from_addr     text,
  to_addr       text,
  subject       text,
  text_body     text,
  html_body     text,
  message_id    text,
  in_reply_to   text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

create index if not exists inbound_emails_user_received_idx
  on public.inbound_emails (user_id, received_at desc);

alter table public.inbound_emails enable row level security;
create policy "users read own inbound emails" on public.inbound_emails
  for select using (auth.uid() = user_id);
create policy "service role full access inbound" on public.inbound_emails
  for all using (true) with check (true);


-- 5. Atomic increment (race-safe)
create or replace function public.increment_daily_usage(p_user_id uuid, p_date date)
returns void language plpgsql security definer as $$
begin
  insert into public.usage_daily (user_id, date, message_count)
  values (p_user_id, p_date, 1)
  on conflict (user_id, date)
  do update set message_count = usage_daily.message_count + 1;
end;
$$;
