-- Prefer application rollback while retaining these nullable columns and any reviewed names.
-- Destructive schema rollback: separate Owner approval and a name-metadata backup required.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.security_coverage
 DROP COLUMN company_name_en,
 DROP COLUMN name_source,
 DROP COLUMN name_checked_at;
COMMIT;
