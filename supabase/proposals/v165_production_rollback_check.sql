-- Read-only rollback prerequisite check, not a destructive down migration.
-- First stop NEW issuance with MODE=guard; keep REQUIRED=1, the key, pool and
-- guard-capable app on EVERY instance. Application redeploy needs Owner approval.
-- Never deploy the earlier unguarded OFF build once any session has been issued.
begin read only;
do $$
begin
  if not exists (select 1 from pg_policy where polrelid='public.user_watchlists'::regclass
    and polname='remembered_session_guard' and not polpermissive and polcmd='*')
    or not exists (select 1 from pg_trigger
      where tgrelid='setscope_private.remembered_sessions'::regclass
      and tgname='keep_session_revoked' and tgenabled='O') then
    raise exception 'Replay guards must remain installed';
  end if;
end $$;
select count(*) as registry_rows,
  count(*) filter (where revoked_at_ms is not null) as tombstones
from setscope_private.remembered_sessions;
commit;
-- Retain all provider IDs, including expired and revoked rows. No cleanup job.
-- A key replacement needs a separately approved drain/revocation or key-ring
-- change; this envelope deliberately never generates a new key on restart.
