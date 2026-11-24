-- Review candidate only; execution against hosted data needs separate approval.
-- Restore the reviewed application first. Legacy Archive reads remain available;
-- no Archive rows, derived tables, revision state, indexes or existing grants change.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
drop function if exists public.list_news_archive_cursor(text,text[],text,text,text[],integer,timestamptz,jsonb,text,text,jsonb,jsonb,integer,integer,text[],boolean);
drop function if exists public.news_archive_cursor_candidates(text[],text,text,text[],timestamptz,jsonb);
notify pgrst,'reload schema';
commit;
