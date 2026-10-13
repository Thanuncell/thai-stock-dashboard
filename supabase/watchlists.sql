-- Run once in Supabase Dashboard > SQL Editor for cross-device Watchlist sync.
create table if not exists public.user_watchlists (
  user_id uuid primary key references auth.users (id) on delete cascade,
  watchlists jsonb not null default '[]'::jsonb,
  active_watchlist_id text not null default 'list-1',
  updated_at timestamptz not null default now()
);

alter table public.user_watchlists enable row level security;

drop policy if exists "Users can read their own watchlists" on public.user_watchlists;
create policy "Users can read their own watchlists"
  on public.user_watchlists for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own watchlists" on public.user_watchlists;
create policy "Users can insert their own watchlists"
  on public.user_watchlists for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own watchlists" on public.user_watchlists;
create policy "Users can update their own watchlists"
  on public.user_watchlists for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.user_watchlists to authenticated;

create or replace function public.set_user_watchlists_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_watchlists_updated_at on public.user_watchlists;
create trigger user_watchlists_updated_at
  before update on public.user_watchlists
  for each row execute function public.set_user_watchlists_updated_at();
