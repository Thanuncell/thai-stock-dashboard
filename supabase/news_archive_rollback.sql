-- DESTRUCTIVE MANUAL ROLLBACK: back up public.news_archive before running.
-- Reverting application commits does not require dropping the table.

drop function if exists public.cleanup_news_archive(integer);
drop table if exists public.news_archive;
