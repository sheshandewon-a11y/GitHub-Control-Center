create extension if not exists pgcrypto;

create table if not exists public.github_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  github_id bigint not null,
  login text not null,
  name text,
  avatar_url text not null,
  profile_url text not null,
  account_type text not null default 'User',
  scopes text[] not null default '{}',
  encrypted_token jsonb not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, github_id)
);
create index if not exists github_accounts_user_id_idx on public.github_accounts(user_id);
alter table public.github_accounts enable row level security;
drop policy if exists "read own github accounts" on public.github_accounts;
create policy "read own github accounts" on public.github_accounts for select to authenticated using ((select auth.uid())=user_id);
revoke all on public.github_accounts from anon, authenticated;
grant select on public.github_accounts to authenticated;

create table if not exists public.github_oauth_states (
 state text primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
alter table public.github_oauth_states enable row level security;
revoke all on public.github_oauth_states from anon, authenticated;

create table if not exists public.audit_logs (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 action text not null,
 resource_type text,
 resource_id text,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists audit_logs_user_created_idx on public.audit_logs(user_id,created_at desc);
alter table public.audit_logs enable row level security;
drop policy if exists "read own audit logs" on public.audit_logs;
create policy "read own audit logs" on public.audit_logs for select to authenticated using ((select auth.uid())=user_id);
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;
