-- Local verification draft. Requires separate approval before hosted use.
begin;

create role setscope_session_store nologin noinherit nobypassrls;
create role setscope_session_guard nologin noinherit nobypassrls;
-- Managed postgres is not SUPERUSER. Explicit SET permits ownership operations
-- with createrole_self_grant='', without inheriting guard privileges.
grant setscope_session_guard to current_user with inherit false;
grant setscope_session_guard to current_user with set true;
create schema setscope_private;
revoke all on schema setscope_private from public, anon, authenticated, service_role;

create table setscope_private.remembered_sessions (
  digest text primary key check (digest ~ '^[0-9a-f]{64}$'),
  provider_session_id uuid not null unique,
  owner_id uuid not null,
  generation text not null check (generation ~ '^[A-Za-z0-9_-]{43}$'),
  user_summary jsonb,
  issued_at_ms bigint not null,
  expires_at_ms bigint not null check (expires_at_ms = issued_at_ms + 604800000),
  access_expires_at_ms bigint not null,
  encrypted text,
  revoked_at_ms bigint,
  version integer not null default 0 check (version >= 0),
  lease_id text,
  lease_until_ms bigint,
  check ((lease_id is null) = (lease_until_ms is null)),
  check (
    (revoked_at_ms is null and encrypted is not null and user_summary is not null)
    or (revoked_at_ms is not null and encrypted is null and user_summary is null and lease_id is null)
  )
);

-- Keep the provider session ID as a deny record. Member deletion must not
-- cascade into this registry while an upstream credential can still exist.
create function setscope_private.keep_session_revoked()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.revoked_at_ms is not null then
    raise exception 'Remembered session is revoked' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function setscope_private.keep_session_revoked() from public, anon, authenticated, service_role;
create trigger keep_session_revoked
before update on setscope_private.remembered_sessions
for each row execute function setscope_private.keep_session_revoked();

revoke all on table setscope_private.remembered_sessions from public, anon, authenticated, service_role;
grant usage on schema setscope_private to setscope_session_store, setscope_session_guard;
grant select on setscope_private.remembered_sessions to setscope_session_store;
grant insert on setscope_private.remembered_sessions to setscope_session_store;
grant update (access_expires_at_ms, user_summary, encrypted, revoked_at_ms, version, lease_id, lease_until_ms)
  on setscope_private.remembered_sessions to setscope_session_store;
grant select (provider_session_id, owner_id, expires_at_ms, revoked_at_ms, lease_until_ms)
  on setscope_private.remembered_sessions to setscope_session_guard;

-- The API supplies verified JWT claims. Unknown valid session IDs remain legacy.
-- A lookup error propagates and must never be interpreted as an unknown ID.
create function setscope_private.watchlist_session_allowed(sid text, subject uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  allowed boolean;
  now_ms bigint := floor(extract(epoch from statement_timestamp()) * 1000)::bigint;
begin
  if subject is null or sid is null or sid !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    return false;
  end if;

  select owner_id = subject and revoked_at_ms is null and now_ms < expires_at_ms
    and (lease_until_ms is null or now_ms < lease_until_ms)
  into allowed
  from setscope_private.remembered_sessions
  where provider_session_id = sid::uuid;

  if not found then return true; end if;
  return allowed;
end;
$$;

grant create on schema setscope_private to setscope_session_guard;
alter function setscope_private.watchlist_session_allowed(text, uuid) owner to setscope_session_guard;
revoke create on schema setscope_private from setscope_session_guard;
set local role setscope_session_guard;
revoke all on function setscope_private.watchlist_session_allowed(text, uuid) from public, anon, authenticated, service_role;
-- The policy can call the stored function reference. No schema USAGE or
-- table grants are given to API roles, and the schema must remain unexposed.
grant execute on function setscope_private.watchlist_session_allowed(text, uuid) to authenticated;
reset role;

create policy remembered_session_guard on public.user_watchlists
as restrictive for all to authenticated
using ((select setscope_private.watchlist_session_allowed(auth.jwt() ->> 'session_id', auth.uid())))
with check ((select setscope_private.watchlist_session_allowed(auth.jwt() ->> 'session_id', auth.uid())));

commit;
