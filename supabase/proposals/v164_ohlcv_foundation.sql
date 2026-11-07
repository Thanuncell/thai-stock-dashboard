-- WS6-B review proposal. Run only on an explicitly approved isolated database.
-- Production installation requires separate Owner approval.
begin;
create schema screener_private;
revoke all on schema screener_private from public, anon, authenticated;
grant usage on schema screener_private to service_role;

create function screener_private.fingerprint(value text) returns text
language sql immutable strict security invoker set search_path = ''
as $$ select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(value,'UTF8')),'hex') $$;

create function screener_private.valid_daily(value text) returns boolean
language plpgsql immutable strict security invoker set search_path = ''
as $$
declare
  d jsonb := value::jsonb;
  p jsonb := d->'confirmationProof';
  m jsonb := d->'sourceMetadata';
  opened bigint; fetched bigint; available bigint; next_time bigint; ended bigint; started bigint;
  trade_day date; o double precision; h double precision; l double precision; c double precision; v double precision;
  k text; expected bigint := null;
begin
  if jsonb_typeof(d) <> 'object' or (select count(*) from jsonb_object_keys(d)) <> 21
    or not d ?& array['schemaVersion','symbol','providerSymbol','provider','interval','timeZone','tradingDate','sessionStatus',
      'time','open','high','low','close','volume','sourceFetchedAt','availableAt','complete','guardStatus',
      'confirmationBasis','confirmationProof','sourceMetadata'] then return false; end if;
  foreach k in array array['schemaVersion','symbol','providerSymbol','provider','interval','timeZone',
    'tradingDate','sessionStatus','guardStatus','confirmationBasis'] loop
    if jsonb_typeof(d->k) <> 'string' then return false; end if;
  end loop;
  if jsonb_typeof(d->'availableAt') not in ('number','null') then return false; end if;
  if d->>'schemaVersion' <> 'setscope-daily-1' or d->>'provider' <> 'Yahoo Finance'
    or d->>'interval' <> '1d' or d->>'timeZone' <> 'Asia/Bangkok'
    or d->>'symbol' !~ '^[A-Z0-9&.-]{1,20}$' or d->>'providerSymbol' <> (d->>'symbol')||'.BK'
    or d->>'guardStatus' not in ('accepted','delayed')
    or d->>'sessionStatus' not in ('SESSION_VERIFIED','SESSION_UNVERIFIED')
    or jsonb_typeof(d->'complete') <> 'boolean' then return false; end if;
  foreach k in array array['time','open','high','low','close','volume','sourceFetchedAt'] loop
    if jsonb_typeof(d->k) <> 'number' then return false; end if;
  end loop;
  opened := (d->>'time')::bigint; fetched := (d->>'sourceFetchedAt')::bigint;
  if opened <= 0 or fetched < opened or (d->>'time')::numeric <> opened or (d->>'sourceFetchedAt')::numeric <> fetched
    or d->>'tradingDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  trade_day := (d->>'tradingDate')::date;
  if to_char(trade_day,'YYYY-MM-DD') <> d->>'tradingDate' or extract(dow from trade_day) in (0,6)
    or (to_timestamp(opened/1000.0) at time zone 'Asia/Bangkok')::date <> trade_day then return false; end if;
  o := (d->>'open')::double precision; h := (d->>'high')::double precision;
  l := (d->>'low')::double precision; c := (d->>'close')::double precision; v := (d->>'volume')::double precision;
  if not (l > 0 and h >= l and o between l and h and c between l and h and h < 'Infinity'::double precision
    and v >= 0 and v < 'Infinity'::double precision) then return false; end if;
  if jsonb_typeof(m) <> 'object' or (select count(*) from jsonb_object_keys(m)) <> 3
    or not m ?& array['symbol','currency','exchange'] or m->>'symbol' <> d->>'providerSymbol'
    or m->>'currency' is not null and m->>'currency' <> 'THB'
    or m->>'exchange' is not null and m->>'exchange' !~* '(SET|Thailand|BKK)' then return false; end if;
  if jsonb_typeof(p) <> 'object' or (select count(*) from jsonb_object_keys(p)) <> 3
    or not p ?& array['regularStart','regularEnd','nextObservedAt'] then return false; end if;
  foreach k in array array['regularStart','regularEnd','nextObservedAt'] loop
    if jsonb_typeof(p->k) not in ('number','null') then return false; end if;
  end loop;
  started := (p->>'regularStart')::bigint; ended := (p->>'regularEnd')::bigint;
  next_time := (p->>'nextObservedAt')::bigint;
  if started <= 0 or ended <= 0 or next_time <= opened or next_time > fetched then return false; end if;
  if ended > opened and (to_timestamp((ended-1)/1000.0) at time zone 'Asia/Bangkok')::date = trade_day
    and (started is null or started <= opened and started < ended and
      (to_timestamp(started/1000.0) at time zone 'Asia/Bangkok')::date = trade_day) then
    expected := ended;
    if d->>'confirmationBasis' <> 'provider-session-end' then return false; end if;
  elsif next_time > opened and (to_timestamp(next_time/1000.0) at time zone 'Asia/Bangkok')::date > trade_day then
    expected := next_time;
    if d->>'confirmationBasis' <> 'next-session-observation' then return false; end if;
  elsif d->>'confirmationBasis' <> 'unconfirmed' then return false;
  end if;
  available := (d->>'availableAt')::bigint;
  return available is not distinct from expected
    and (d->>'complete')::boolean = (expected is not null and expected <= fetched);
exception when others then return false;
end;
$$;

create table screener_private.stock_ohlcv_daily (
  record_text text not null check(octet_length(record_text) <= 4096),
  provider_symbol text generated always as (record_text::jsonb->>'providerSymbol') stored,
  symbol text generated always as (record_text::jsonb->>'symbol') stored,
  trading_date text generated always as (record_text::jsonb->>'tradingDate') stored,
  source_fetched_ms bigint generated always as ((record_text::jsonb->>'sourceFetchedAt')::bigint) stored,
  content_sha256 text generated always as (screener_private.fingerprint(record_text)) stored,
  primary key(provider_symbol,trading_date),
  check(screener_private.valid_daily(record_text))
);
create index stock_ohlcv_daily_symbol_date on screener_private.stock_ohlcv_daily(symbol,trading_date desc);
create index stock_ohlcv_daily_retention on screener_private.stock_ohlcv_daily(trading_date);

create table screener_private.snapshots (
  payload_text text not null check(octet_length(payload_text) <= 1048576),
  content_sha256 text generated always as (screener_private.fingerprint(payload_text)) stored primary key
);
create table screener_private.snapshot_candidates (
  payload_text text not null check(octet_length(payload_text) <= 1048576),
  content_sha256 text generated always as (screener_private.fingerprint(payload_text)) stored primary key
);
create table screener_private.state (
  singleton boolean primary key default true check(singleton),
  history_revision bigint not null default 0 check(history_revision >= 0),
  snapshot_revision bigint not null default 0 check(snapshot_revision >= 0),
  current_hash text references screener_private.snapshots(content_sha256),
  previous_hash text references screener_private.snapshots(content_sha256),
  cooldown_until bigint not null default 0 check(cooldown_until >= 0)
);
insert into screener_private.state(singleton) values(true);

create function screener_private.cleanup_daily() returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare removed bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('setscope-daily-retention',0));
  delete from screener_private.stock_ohlcv_daily
    where trading_date < to_char((current_timestamp at time zone 'Asia/Bangkok')::date - 364,'YYYY-MM-DD');
  get diagnostics removed = row_count;
  if removed > 0 then update screener_private.state set history_revision=history_revision+1 where singleton; end if;
  return removed;
end;
$$;

create function screener_private.ingest_daily(records jsonb) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare value text; prior text; d jsonb; changed bigint := 0; affected bigint; expired bigint := 0; removed bigint;
  floor_day text := to_char((current_timestamp at time zone 'Asia/Bangkok')::date - 364,'YYYY-MM-DD');
begin
  if jsonb_typeof(records) <> 'array' or jsonb_array_length(records) > 6000 then raise exception 'DAILY_BATCH_BOUNDS'; end if;
  perform pg_advisory_xact_lock(hashtextextended('setscope-daily-retention',0));
  if (select count(distinct v::jsonb->>'symbol') from jsonb_array_elements_text(records) v) > 20 then raise exception 'DAILY_BATCH_BOUNDS'; end if;
  if exists(select 1 from jsonb_array_elements_text(records) v
    group by v::jsonb->>'providerSymbol',v::jsonb->>'tradingDate' having count(distinct v)>1) then
    raise exception 'DAILY_BATCH_CONFLICT';
  end if;
  -- Validate the entire batch before any mutation. Identity conflicts abort the transaction.
  for value in select jsonb_array_elements_text(records) loop
    if not screener_private.valid_daily(value) then raise exception 'DAILY_CONTRACT'; end if;
    d := value::jsonb;
    if (d->>'sourceFetchedAt')::numeric > extract(epoch from clock_timestamp())*1000 then raise exception 'DAILY_FUTURE_SOURCE'; end if;
    select record_text into prior from screener_private.stock_ohlcv_daily
      where provider_symbol=d->>'providerSymbol' and trading_date=d->>'tradingDate';
    if prior is not null and (prior::jsonb->>'sourceFetchedAt')::bigint = (d->>'sourceFetchedAt')::bigint
      and prior <> value then raise exception 'DAILY_VERSION_CONFLICT'; end if;
  end loop;
  for value in select jsonb_array_elements_text(records) loop
    d := value::jsonb;
    if d->>'tradingDate' < floor_day then expired := expired+1; continue; end if;
    insert into screener_private.stock_ohlcv_daily(record_text) values(value)
      on conflict(provider_symbol,trading_date) do update set record_text=excluded.record_text
      where excluded.source_fetched_ms > stock_ohlcv_daily.source_fetched_ms;
    get diagnostics affected = row_count;
    changed := changed+affected;
  end loop;
  if changed > 0 then update screener_private.state set history_revision=history_revision+1 where singleton; end if;
  if jsonb_array_length(records) > expired then removed := screener_private.cleanup_daily(); else removed := 0; end if;
  return jsonb_build_object('changed',changed,'removed',removed,'expired',expired);
end;
$$;

create function screener_private.publish_snapshot(candidate_hash text, expected_revision bigint) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare s screener_private.state; body text; d jsonb; r jsonb; eligible integer := 0; ready integer := 0; excluded integer := 0;
begin
  select * into s from screener_private.state where singleton for update;
  if s.snapshot_revision <> expected_revision then raise exception 'SNAPSHOT_REVISION_CONFLICT' using errcode='40001'; end if;
  select payload_text into body from screener_private.snapshot_candidates where content_sha256=candidate_hash;
  if body is null then raise exception 'SNAPSHOT_CANDIDATE_MISSING'; end if;
  d := body::jsonb;
  if not d ?& array['schemaVersion','state','sessionDate','latestCompletedSessionDate','generatedAt','counts','rows']
    or jsonb_typeof(d->'counts') <> 'object' or not (d->'counts') ?& array[
      'registered','eligible','ready','coverageIneligible','unavailable','staleSession','guardBlocked']
    or d->>'schemaVersion' is distinct from 'setscope-screener-1' or d->>'state' is distinct from 'COMPLETE'
    or d->>'sessionDate' <> d->>'latestCompletedSessionDate'
    or jsonb_typeof(d->'rows') <> 'array' or jsonb_array_length(d->'rows') > 1000
    or (d->>'generatedAt')::timestamptz > clock_timestamp() then raise exception 'INVALID_SNAPSHOT'; end if;
  for r in select jsonb_array_elements(d->'rows') loop
    if r->>'state' = 'READY' and (r->>'eligible')::boolean then
      eligible := eligible+1; ready := ready+1;
      if r->>'candleTime' is null or r->>'sourceAsOf' is null
        or jsonb_typeof(r->'price'->'close') is distinct from 'number' or (r->'price'->>'close')::double precision <= 0
        or (r->'technical'->>'rsi14')::double precision not between 0 and 100
        or (r->>'candleTime')::timestamptz >= (r->>'sourceAsOf')::timestamptz
        or (r->>'candleTime')::timestamptz at time zone 'Asia/Bangkok' >= (d->>'sessionDate')::date+1
        or ((r->>'candleTime')::timestamptz at time zone 'Asia/Bangkok')::date <> (d->>'sessionDate')::date
        or (r->>'sourceAsOf')::timestamptz > (d->>'generatedAt')::timestamptz then raise exception 'INVALID_SESSION'; end if;
    elsif r->>'state' = 'COVERAGE_INELIGIBLE' and not (r->>'eligible')::boolean then excluded := excluded+1;
    else raise exception 'INCOMPLETE_SNAPSHOT'; end if;
  end loop;
  if eligible=0 or (d->'counts'->>'registered')::integer <> eligible+excluded
    or (d->'counts'->>'eligible')::integer <> eligible or (d->'counts'->>'ready')::integer <> ready
    or (d->'counts'->>'coverageIneligible')::integer <> excluded
    or (d->'counts'->>'unavailable')::integer <> 0 or (d->'counts'->>'staleSession')::integer <> 0
    or (d->'counts'->>'guardBlocked')::integer <> 0 then raise exception 'INVALID_COUNTS'; end if;
  if s.current_hash is not null and
    (select (payload_text::jsonb->>'sessionDate') > (d->>'sessionDate')
      or (payload_text::jsonb->>'generatedAt')::timestamptz > (d->>'generatedAt')::timestamptz
      from screener_private.snapshots where content_sha256=s.current_hash) then raise exception 'SNAPSHOT_REGRESSION'; end if;
  insert into screener_private.snapshots(payload_text) values(body) on conflict do nothing;
  if s.current_hash is distinct from candidate_hash then
    update screener_private.state set previous_hash=current_hash,current_hash=candidate_hash,snapshot_revision=snapshot_revision+1 where singleton;
  end if;
  delete from screener_private.snapshot_candidates where content_sha256=candidate_hash;
  return (select snapshot_revision from screener_private.state where singleton);
end;
$$;

create function screener_private.rollback_snapshot(expected_revision bigint) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare s screener_private.state;
begin
  select * into s from screener_private.state where singleton for update;
  if s.snapshot_revision <> expected_revision then raise exception 'SNAPSHOT_REVISION_CONFLICT' using errcode='40001'; end if;
  if s.previous_hash is null then raise exception 'SNAPSHOT_ROLLBACK_UNAVAILABLE'; end if;
  update screener_private.state set current_hash=previous_hash,snapshot_revision=snapshot_revision+1 where singleton;
  return (select snapshot_revision from screener_private.state where singleton);
end;
$$;

alter table screener_private.stock_ohlcv_daily enable row level security;
alter table screener_private.snapshots enable row level security;
alter table screener_private.snapshot_candidates enable row level security;
alter table screener_private.state enable row level security;
revoke all on all tables in schema screener_private from public,anon,authenticated;
revoke execute on all functions in schema screener_private from public,anon,authenticated;
grant select,insert,update,delete on screener_private.stock_ohlcv_daily,screener_private.snapshot_candidates to service_role;
grant select,insert on screener_private.snapshots to service_role;
grant select,update on screener_private.state to service_role;
grant execute on all functions in schema screener_private to service_role;
commit;
