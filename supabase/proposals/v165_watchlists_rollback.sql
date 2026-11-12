-- Fresh Dev foundation rollback only. Remove the session layer first.
-- Never discard Watchlist rows or touch auth.users. No CASCADE.
begin;

lock table public.user_watchlists in access exclusive mode;
do $$
begin
  if to_regnamespace('setscope_private') is not null then
    raise exception 'Remove the session layer safely before the Watchlist foundation.';
  end if;
  if exists (select 1 from public.user_watchlists) then
    raise exception 'Watchlist is not empty. Preserve its rows; foundation rollback is blocked.';
  end if;
end;
$$;

drop table public.user_watchlists;
drop function public.set_user_watchlists_updated_at();

commit;
