-- SETscope v1.5.1 non-destructive News Archive least-privilege hardening.
-- This migration intentionally changes only existing News Archive object grants.

revoke all on table public.news_archive from anon, authenticated, service_role;
grant select, insert, update, delete on table public.news_archive to service_role;

revoke all on sequence public.news_archive_id_seq from anon, authenticated, service_role;
grant usage, select on sequence public.news_archive_id_seq to service_role;

revoke all on function public.cleanup_news_archive(integer) from public, anon, authenticated, service_role;
grant execute on function public.cleanup_news_archive(integer) to service_role;
