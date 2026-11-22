
-- Add columns required by the current API.
alter table public.github_accounts
  add column if not exists email text;

alter table public.github_accounts
  add column if not exists token_expires_at timestamptz;

-- Index for OAuth state expiration cleanup.
create index if not exists github_oauth_states_expires_at_idx
  on public.github_oauth_states(expires_at);

-- Atomically consume a valid OAuth state.
create or replace function public.consume_github_oauth_state(
  p_state text
)
returns table (
  user_id uuid,
  expires_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  delete from public.github_oauth_states
  where state = p_state
    and expires_at > now()
  returning
    github_oauth_states.user_id,
    github_oauth_states.expires_at;
$$;

-- Only the backend service role can execute this function.
revoke all on function public.consume_github_oauth_state(text)
  from public, anon, authenticated;

grant execute on function public.consume_github_oauth_state(text)
  to service_role;
