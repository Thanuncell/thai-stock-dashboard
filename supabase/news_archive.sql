-- SETscope v1.5.1 additive News Archive migration.
-- Apply once in Supabase SQL Editor. No client role receives direct access.

create table if not exists public.news_archive (
  id bigint generated always as identity primary key,
  fingerprint text not null unique,
  title text not null check (char_length(title) between 1 and 500),
  url text not null check (url ~ '^https://'),
  source text not null check (source in ('thunhoon', 'kaohoon', 'settrade', 'official', 'infoquest', 'efinance', 'broker', 'other')),
  source_name text not null check (char_length(source_name) between 1 and 160),
  snippet text not null default '' check (char_length(snippet) <= 1200),
  published_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  fetched_at timestamptz not null,
  matched_symbols text[] not null default '{}',
  broker_firms text[] not null default '{}',
  analysis_summary text check (analysis_summary is null or char_length(analysis_summary) <= 450),
  analysis_mode text check (analysis_mode is null or char_length(analysis_mode) <= 24)
);

create index if not exists news_archive_published_idx
  on public.news_archive (published_at desc, id desc);
create index if not exists news_archive_source_published_idx
  on public.news_archive (source, published_at desc, id desc);
create index if not exists news_archive_symbols_idx
  on public.news_archive using gin (matched_symbols);
create index if not exists news_archive_brokers_idx
  on public.news_archive using gin (broker_firms);

alter table public.news_archive enable row level security;
alter table public.news_archive force row level security;
revoke all on public.news_archive from anon, authenticated;
revoke all on sequence public.news_archive_id_seq from anon, authenticated;
grant select, insert, update, delete on public.news_archive to service_role;
grant usage, select on sequence public.news_archive_id_seq to service_role;

create or replace function public.cleanup_news_archive(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  with expired as (
    select id
    from public.news_archive
    where published_at < now() - interval '365 days'
    order by published_at, id
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
    for update skip locked
  )
  delete from public.news_archive archive
  using expired
  where archive.id = expired.id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_news_archive(integer) from public, anon, authenticated;
grant execute on function public.cleanup_news_archive(integer) to service_role;
