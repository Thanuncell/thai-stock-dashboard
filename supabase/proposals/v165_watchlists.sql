-- Fresh Dev foundation only. Apply once, before v165_remembered_sessions.sql.
-- Requires separate Owner approval for the selected Dev project.
begin;

-- Fail if the table exists; never replace accepted policies/data.
create table public.user_watchlists (
  user_id uuid primary key references auth.users (id) on delete cascade,
  watchlists jsonb not null default '[]'::jsonb,
  active_watchlist_id text not null default 'list-1',
  updated_at timestamptz not null default now()
);

alter table public.user_watchlists enable row level security;

-- Supabase public defaults may grant ALL. A narrower GRANT does not revoke it.
revoke all on table public.user_watchlists from public, anon, authenticated, service_role;
grant select, insert, update on public.user_watchlists to authenticated;

create policy "Users can read their own watchlists"
  on public.user_watchlists for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own watchlists"
  on public.user_watchlists for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own watchlists"
  on public.user_watchlists for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create function public.set_user_watchlists_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_user_watchlists_updated_at() from public, anon, authenticated, service_role;
create trigger user_watchlists_updated_at
  before update on public.user_watchlists
  for each row execute function public.set_user_watchlists_updated_at();

commit;
