-- Additive metadata only. No backfill, status changes, RLS or grant changes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.security_coverage
 ADD COLUMN company_name_en text CHECK (company_name_en IS NULL OR char_length(company_name_en) BETWEEN 4 AND 200),
 ADD COLUMN name_source text CHECK (name_source IS NULL OR char_length(name_source) BETWEEN 1 AND 600),
 ADD COLUMN name_checked_at timestamptz;
COMMIT;
