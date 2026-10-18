-- SETscope v1.5.2 additive Coverage Truth persistence.
-- Apply only after review. Browser roles receive no direct object privileges.

create table if not exists public.security_coverage (
  symbol text primary key check (symbol ~ '^[A-Z0-9&.-]{1,20}$'),
  provider_symbol text not null check (char_length(provider_symbol) between 1 and 32),
  provider text not null default 'Yahoo Finance' check (char_length(provider) between 1 and 80),
  symbol_verified boolean not null default false,
  chart_ready boolean not null default false,
  technical_ready boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'verified', 'partial', 'temporary_failed', 'inactive', 'unsupported')),
  last_verified_at timestamptz,
  last_success_at timestamptz,
  last_checked_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 120),
  guard_status text check (guard_status is null or guard_status in ('accepted', 'delayed', 'stale', 'suspect', 'quarantined', 'unavailable')),
  guard_reason text check (guard_reason is null or char_length(guard_reason) <= 120),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists security_coverage_active_oldest_idx
  on public.security_coverage (last_checked_at asc nulls first, symbol)
  where active = true;
create index if not exists security_coverage_verified_idx
  on public.security_coverage (technical_ready, symbol)
  where active = true and symbol_verified = true and chart_ready = true;

create table if not exists public.coverage_runs (
  run_key text primary key check (char_length(run_key) between 1 and 120),
  provider text not null default 'Yahoo Finance' check (char_length(provider) between 1 and 80),
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz,
  batch_size integer not null check (batch_size between 1 and 200),
  concurrency integer not null check (concurrency between 1 and 10),
  attempted integer not null default 0 check (attempted >= 0),
  verified integer not null default 0 check (verified >= 0),
  temporary_failed integer not null default 0 check (temporary_failed >= 0),
  partial integer not null default 0 check (partial >= 0),
  configured_symbols integer not null default 0 check (configured_symbols >= 0),
  universe integer not null default 0 check (universe >= 0),
  inactive integer not null default 0 check (inactive >= 0),
  unsupported integer not null default 0 check (unsupported >= 0),
  stale integer not null default 0 check (stale >= 0),
  error integer not null default 0 check (error >= 0),
  current_verified integer not null default 0 check (current_verified >= 0),
  technical_ready integer not null default 0 check (technical_ready >= 0),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 240)
);

create index if not exists coverage_runs_finished_idx
  on public.coverage_runs (finished_at desc)
  where status = 'completed';

alter table public.security_coverage enable row level security;
alter table public.security_coverage force row level security;
alter table public.coverage_runs enable row level security;
alter table public.coverage_runs force row level security;

revoke all on table public.security_coverage from public, anon, authenticated, service_role;
revoke all on table public.coverage_runs from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.security_coverage to service_role;
grant select, insert, update, delete on table public.coverage_runs to service_role;
