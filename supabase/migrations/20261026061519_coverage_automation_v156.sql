-- Approved v1.5.6 additive checkpoint state. Apply only in an approved target.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '10s';
alter table public.coverage_runs add column automation_state jsonb
  constraint coverage_runs_automation_state_shape check (
    automation_state is null or (jsonb_typeof(automation_state) = 'object'
      and octet_length(automation_state::text) <= 1048576));
commit;
