-- Disable the application query flag first; no Archive/evidence/AI rows or columns are removed.
-- Review-only rollback of derived WS7 objects. Requires separate Owner approval on Production.
begin;
set local lock_timeout='2s';
drop trigger if exists news_archive_query_revision on public.news_archive;
drop function if exists public.news_archive_query_revision();
drop trigger if exists news_archive_query_changed on public.news_archive;
drop function if exists public.list_news_archive_query(text,integer,integer,text[],text,text,text[],integer,timestamptz,jsonb);
drop function if exists public.news_archive_query_reset(text);
drop function if exists public.news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb);
drop function if exists public.news_archive_query_components(text[],text[]);
drop function if exists public.news_archive_query_work(integer);
drop function if exists public.news_archive_query_changed();
drop table if exists public.news_archive_query_rows;
drop table if exists public.news_archive_query_groups;
drop table if exists public.news_archive_query_dirty;
drop table if exists public.news_archive_query_state;
notify pgrst,'reload schema';
commit;
