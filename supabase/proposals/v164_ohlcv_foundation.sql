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
      where excluded.source_fetched_ms > stock_ohlcv_daily.source_fetched_ms
        and ((excluded.record_text::jsonb->>'complete')::boolean or not (stock_ohlcv_daily.record_text::jsonb->>'complete')::boolean);
    get diagnostics affected = row_count;
    changed := changed+affected;
  end loop;
  if changed > 0 then update screener_private.state set history_revision=history_revision+1 where singleton; end if;
  if jsonb_array_length(records) > expired then removed := screener_private.cleanup_daily(); else removed := 0; end if;
  return jsonb_build_object('changed',changed,'removed',removed,'expired',expired);
end;
$$;

create function screener_private.assert_snapshot(body text) returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  d jsonb := body::jsonb; r jsonb; counts jsonb; k text;
  generated timestamptz; candle timestamptz; fetched timestamptz; session_day date;
  eligible integer := 0; excluded integer := 0;
  symbol text; previous_symbol text := '';
  n numeric;
  count_keys text[] := array['registered','eligible','ready','coverageIneligible','unavailable','staleSession','guardBlocked'];
  price_keys text[] := array['close','previousClose','changePercent'];
  technical_keys text[] := array['ema20','ema50','rsi14','macd','macdSignal'];
  availability_keys text[] := array['price','changePercent','ema20','ema50','rsi14','macd'];
  instant_pattern text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
  instant_format text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
begin
  if jsonb_typeof(d) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(d)) <> 8 then raise exception 'INVALID_SNAPSHOT'; end if;
  foreach k in array array['schemaVersion','id','state','sessionDate','latestCompletedSessionDate','generatedAt'] loop
    if jsonb_typeof(d->k) is distinct from 'string' then raise exception 'INVALID_SNAPSHOT'; end if;
  end loop;
  if d->>'schemaVersion' <> 'setscope-screener-1' or d->>'state' <> 'COMPLETE'
    or d->>'sessionDate' is distinct from d->>'latestCompletedSessionDate'
    or d->>'sessionDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or d->>'id' !~ ('^setscope-screener-1:' || (d->>'sessionDate') || ':[a-f0-9]{8}$')
    or d->>'generatedAt' !~ instant_pattern
    or jsonb_typeof(d->'rows') is distinct from 'array'
    or jsonb_typeof(d->'counts') is distinct from 'object' then raise exception 'INVALID_SNAPSHOT'; end if;
  session_day := (d->>'sessionDate')::date;
  generated := (d->>'generatedAt')::timestamptz;
  counts := d->'counts';
  if to_char(generated at time zone 'UTC',instant_format) is distinct from d->>'generatedAt'
    or generated > clock_timestamp() or extract(isodow from session_day) in (6,7)
    or session_day > (generated at time zone 'Asia/Bangkok')::date
    or jsonb_array_length(d->'rows') > 1000
    or (select count(*) from jsonb_object_keys(counts)) <> cardinality(count_keys) then raise exception 'INVALID_SNAPSHOT'; end if;
  foreach k in array count_keys loop
    if jsonb_typeof(counts->k) is distinct from 'number' then raise exception 'INVALID_SNAPSHOT_COUNTS'; end if;
    n := (counts->>k)::numeric;
    if n < 0 or n > 1000 or n <> trunc(n) then raise exception 'INVALID_SNAPSHOT_COUNTS'; end if;
  end loop;
  for r in select jsonb_array_elements(d->'rows') loop
    if jsonb_typeof(r) is distinct from 'object' or (select count(*) from jsonb_object_keys(r)) <> 10
      or jsonb_typeof(r->'symbol') is distinct from 'string'
      or jsonb_typeof(r->'eligible') is distinct from 'boolean'
      or jsonb_typeof(r->'state') is distinct from 'string'
      or jsonb_typeof(r->'exclusionReasons') is distinct from 'array'
      or jsonb_typeof(r->'confirmedBars') is distinct from 'number'
      or jsonb_typeof(r->'price') is distinct from 'object'
      or jsonb_typeof(r->'technical') is distinct from 'object'
      or jsonb_typeof(r->'available') is distinct from 'object' then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
    symbol := r->>'symbol';
    if symbol !~ '^[A-Z0-9&.-]{1,20}$' or symbol collate "C" <= previous_symbol collate "C"
      or (select count(*) from jsonb_object_keys(r->'price')) <> cardinality(price_keys)
      or (select count(*) from jsonb_object_keys(r->'technical')) <> cardinality(technical_keys)
      or (select count(*) from jsonb_object_keys(r->'available')) <> cardinality(availability_keys)
      then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
    previous_symbol := symbol;
    foreach k in array price_keys loop
      if jsonb_typeof(r->'price'->k) is distinct from 'number'
        and jsonb_typeof(r->'price'->k) is distinct from 'null' then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
      perform (r->'price'->>k)::double precision;
    end loop;
    foreach k in array technical_keys loop
      if jsonb_typeof(r->'technical'->k) is distinct from 'number'
        and jsonb_typeof(r->'technical'->k) is distinct from 'null' then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
      perform (r->'technical'->>k)::double precision;
    end loop;
    foreach k in array availability_keys loop
      if jsonb_typeof(r->'available'->k) is distinct from 'boolean' then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
    end loop;
    n := (r->>'confirmedBars')::numeric;
    if r->>'state' = 'READY' and (r->>'eligible')::boolean then
      eligible := eligible+1;
      if jsonb_typeof(r->'candleTime') is distinct from 'string' or jsonb_typeof(r->'sourceAsOf') is distinct from 'string'
        or r->>'candleTime' !~ instant_pattern or r->>'sourceAsOf' !~ instant_pattern
        or jsonb_array_length(r->'exclusionReasons') <> 0 or n < 1 or n > 300 or n <> trunc(n)
        or jsonb_typeof(r->'price'->'close') is distinct from 'number' or (r->'price'->>'close')::double precision <= 0
        or coalesce((r->'price'->>'previousClose')::double precision <= 0,false)
        or coalesce((r->'technical'->>'ema20')::double precision <= 0,false)
        or coalesce((r->'technical'->>'ema50')::double precision <= 0,false)
        or coalesce((r->'technical'->>'rsi14')::double precision not between 0 and 100,false)
        then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
      candle := (r->>'candleTime')::timestamptz;
      fetched := (r->>'sourceAsOf')::timestamptz;
      if to_char(candle at time zone 'UTC',instant_format) is distinct from r->>'candleTime'
        or to_char(fetched at time zone 'UTC',instant_format) is distinct from r->>'sourceAsOf'
        or candle >= fetched or fetched > generated
        or (candle at time zone 'Asia/Bangkok')::date is distinct from session_day
        or (r->'available'->>'price')::boolean is distinct from true
        or (r->'available'->>'changePercent')::boolean is distinct from (r->'price'->>'changePercent' is not null)
        or (r->'available'->>'macd')::boolean is distinct from
          (r->'technical'->>'macd' is not null and r->'technical'->>'macdSignal' is not null)
        then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
      foreach k in array array['ema20','ema50','rsi14'] loop
        if (r->'available'->>k)::boolean is distinct from (r->'technical'->>k is not null)
          then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
      end loop;
    elsif r->>'state' = 'COVERAGE_INELIGIBLE' and not (r->>'eligible')::boolean then
      excluded := excluded+1;
      if n <> 0 or r->'exclusionReasons' is distinct from '["COVERAGE_INELIGIBLE"]'::jsonb
        or r->'candleTime' is distinct from 'null'::jsonb or r->'sourceAsOf' is distinct from 'null'::jsonb
        or exists (select 1 from jsonb_each(r->'price') where value is distinct from 'null'::jsonb)
        or exists (select 1 from jsonb_each(r->'technical') where value is distinct from 'null'::jsonb)
        or exists (select 1 from jsonb_each(r->'available') where value is distinct from 'false'::jsonb)
        then raise exception 'INVALID_SNAPSHOT_ROW'; end if;
    else raise exception 'INVALID_SNAPSHOT_ROW'; end if;
  end loop;
  if eligible=0 or (counts->>'registered')::numeric is distinct from eligible+excluded
    or (counts->>'eligible')::numeric is distinct from eligible or (counts->>'ready')::numeric is distinct from eligible
    or (counts->>'coverageIneligible')::numeric is distinct from excluded
    or (counts->>'unavailable')::numeric is distinct from 0 or (counts->>'staleSession')::numeric is distinct from 0
    or (counts->>'guardBlocked')::numeric is distinct from 0 then raise exception 'INVALID_SNAPSHOT_COUNTS'; end if;
exception when data_exception then raise exception 'INVALID_SNAPSHOT';
end;
$$;

create function screener_private.publish_snapshot(candidate_hash text, expected_revision bigint) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare s screener_private.state; body text; d jsonb;
begin
  select * into s from screener_private.state where singleton for update;
  if not found or expected_revision is null or s.snapshot_revision is distinct from expected_revision
    then raise exception 'SNAPSHOT_REVISION_CONFLICT' using errcode='40001'; end if;
  select payload_text into body from screener_private.snapshot_candidates where content_sha256=candidate_hash;
  if body is null then raise exception 'SNAPSHOT_CANDIDATE_MISSING'; end if;
  if screener_private.fingerprint(body) is distinct from candidate_hash then raise exception 'INVALID_SNAPSHOT_CHECKSUM'; end if;
  perform screener_private.assert_snapshot(body);
  d := body::jsonb;
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
declare s screener_private.state; body text;
begin
  select * into s from screener_private.state where singleton for update;
  if not found or expected_revision is null or s.snapshot_revision is distinct from expected_revision
    then raise exception 'SNAPSHOT_REVISION_CONFLICT' using errcode='40001'; end if;
  if s.previous_hash is null then raise exception 'SNAPSHOT_ROLLBACK_UNAVAILABLE'; end if;
  select payload_text into body from screener_private.snapshots where content_sha256=s.previous_hash;
  if screener_private.fingerprint(body) is distinct from s.previous_hash then raise exception 'INVALID_SNAPSHOT_CHECKSUM'; end if;
  perform screener_private.assert_snapshot(body);
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
