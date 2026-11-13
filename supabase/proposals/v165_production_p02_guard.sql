-- P02 Production proposal ONLY. NOT APPLIED. Owner approval required.
-- Add AND protection; never replace the accepted owner policies or data.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
do $$
begin
  if not exists (select 1 from pg_class where oid='public.user_watchlists'::regclass and relrowsecurity)
    or (select count(*) from pg_policy where polrelid='public.user_watchlists'::regclass
      and polpermissive and polcmd in ('r','a','w') and
        (polname in ('Users can read their own watchlists',
          'Users can insert their own watchlists', 'Users can update their own watchlists'))) <> 3 then
    raise exception 'Expected existing owner policies required; inspect drift before retry';
  end if;
end $$;

-- TRUNCATE bypasses RLS. These are explicit grant deltas for Owner review.
-- Preserve SELECT/INSERT/UPDATE, existing DELETE denial, and service-role jobs.
revoke truncate, references, trigger on public.user_watchlists from public, anon, authenticated;
create policy remembered_session_guard on public.user_watchlists
as restrictive for all to authenticated
using ((select setscope_private.watchlist_session_allowed(auth.jwt() ->> 'session_id', auth.uid())))
with check ((select setscope_private.watchlist_session_allowed(auth.jwt() ->> 'session_id', auth.uid())));
commit;
