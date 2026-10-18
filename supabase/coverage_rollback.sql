-- DESTRUCTIVE manual rollback for SETscope v1.5.2 Coverage Truth tables.
-- Back up coverage audit state before use. Do not run during normal application rollback.

drop table if exists public.coverage_runs;
drop table if exists public.security_coverage;
