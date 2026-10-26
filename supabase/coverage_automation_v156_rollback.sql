-- Application rollback can retain the nullable column. This schema rollback
-- refuses to destroy any checkpoint; archive/recovery requires separate review.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '10s';
do $$ begin
  if exists (select 1 from public.coverage_runs where automation_state is not null) then
    raise exception 'Checkpoint state exists; preserve it before schema rollback';
  end if;
end $$;
alter table public.coverage_runs drop column automation_state;
commit;
