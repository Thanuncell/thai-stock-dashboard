-- Local verification draft. Disable issuance and drain app users before use.
-- Keep the app guard and registry until upstream revocation and expiry are proven.
begin;

lock table public.user_watchlists in access exclusive mode;
lock table setscope_private.remembered_sessions in access exclusive mode;
do $$
begin
  if exists (select 1 from setscope_private.remembered_sessions) then
    raise exception 'Remembered session registry is not empty. Keep the replay guards installed.';
  end if;
end;
$$;

drop policy remembered_session_guard on public.user_watchlists;
set local role setscope_session_guard;
drop function setscope_private.watchlist_session_allowed(text, uuid);
reset role;
drop table setscope_private.remembered_sessions;
drop function setscope_private.keep_session_revoked();
drop schema setscope_private;
drop role setscope_session_guard;
drop role setscope_session_store;

commit;
