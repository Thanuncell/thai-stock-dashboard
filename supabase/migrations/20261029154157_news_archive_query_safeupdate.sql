-- Additive WS7 compatibility patch for an already installed query index.
-- Preserve function identities, grants, RLS and all original/archive/index data.
-- Owner approval required before Production installation; no bootstrap or reset here.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $$
begin
 if to_regclass('public.news_archive_query_state') is null
 or to_regprocedure('public.news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb)') is null
 or to_regprocedure('public.news_archive_query_revision()') is null
 or to_regprocedure('public.news_archive_query_reset(text)') is null then
  raise exception 'WS7_QUERY_BASE_REQUIRED';
 end if;
end $$;

create or replace function public.news_archive_query_revision() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 update public.news_archive_query_state set source_revision=source_revision+1 where singleton=true;
 if TG_OP='TRUNCATE' then insert into public.news_archive_query_dirty select fingerprint from public.news_archive_query_rows on conflict do nothing;end if;
 return null;
end $$;

create or replace function public.news_archive_query_commit(p_source_revision bigint,p_index_revision bigint,p_policy text,p_dirty text[],p_removed text[],p_groups jsonb,p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare state public.news_archive_query_state; entry jsonb; raw public.news_archive; expected integer;
begin
 select * into state from public.news_archive_query_state for update;
 if state.source_revision<>p_source_revision or state.index_revision<>p_index_revision then return jsonb_build_object('committed',false,'reason','REVISION_CONFLICT');end if;
 if p_policy !~ '^news-query-1:(legacy|read|write):(metadata|article)$' or (state.policy is not null and state.policy<>p_policy) then raise exception 'NEWS_QUERY_POLICY_MISMATCH';end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_typeof(p_groups)<>'array' or jsonb_array_length(p_rows)>2500 or jsonb_array_length(p_groups)>2500 or cardinality(p_dirty)>500 then raise exception 'NEWS_QUERY_BATCH_LIMIT';end if;
 if exists(select 1 from public.news_archive_query_rows r join public.news_archive a using(fingerprint) where r.group_key=any(p_removed) and not exists(select 1 from jsonb_array_elements(p_rows) x where x->>'fingerprint'=r.fingerprint)) then raise exception 'NEWS_QUERY_COMPONENT_INCOMPLETE';end if;
 if exists(select 1 from public.news_archive a where a.fingerprint=any(p_dirty) and not exists(select 1 from jsonb_array_elements(p_rows) x where x->>'fingerprint'=a.fingerprint)) then raise exception 'NEWS_QUERY_BATCH_INCOMPLETE';end if;
 for entry in select value from jsonb_array_elements(p_rows) loop
  select * into raw from public.news_archive where fingerprint=entry->>'fingerprint';
  if not found or encode(sha256(convert_to(to_jsonb(raw)::text,'UTF8')),'hex')<>entry->>'row_digest' then raise exception 'NEWS_QUERY_SUBJECT_CHANGED';end if;
 end loop;
 delete from public.news_archive_query_rows where group_key=any(p_removed) or fingerprint=any(p_dirty);
 delete from public.news_archive_query_groups where group_key=any(p_removed);
 insert into public.news_archive_query_groups select * from jsonb_populate_recordset(null::public.news_archive_query_groups,p_groups);
 insert into public.news_archive_query_rows select * from jsonb_populate_recordset(null::public.news_archive_query_rows,p_rows)
 on conflict(fingerprint) do update set group_key=excluded.group_key,row_digest=excluded.row_digest,quality_status=excluded.quality_status;
 delete from public.news_archive_query_dirty where fingerprint=any(p_dirty) or fingerprint in (select x->>'fingerprint' from jsonb_array_elements(p_rows) x);
 update public.news_archive_query_state set policy=p_policy,index_revision=index_revision+1 where singleton=true;
 return jsonb_build_object('committed',true,'pending',(select count(*) from public.news_archive_query_dirty));
end $$;

create or replace function public.news_archive_query_reset(p_policy text) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare indexed_keys text[]; group_keys text[]; dirty_keys text[];
begin
 if p_policy !~ '^news-query-1:(legacy|read|write):(metadata|article)$' then raise exception 'NEWS_QUERY_POLICY_MISMATCH';end if;
 perform 1 from public.news_archive_query_state where singleton=true for update;
 -- Reset only the keys captured from this locked derived index; never original news.
 select coalesce(array_agg(fingerprint),'{}'::text[]) into indexed_keys from public.news_archive_query_rows;
 select coalesce(array_agg(group_key),'{}'::text[]) into group_keys from public.news_archive_query_groups;
 select coalesce(array_agg(fingerprint),'{}'::text[]) into dirty_keys from public.news_archive_query_dirty;
 delete from public.news_archive_query_rows where fingerprint=any(indexed_keys);
 delete from public.news_archive_query_groups where group_key=any(group_keys);
 delete from public.news_archive_query_dirty where fingerprint=any(dirty_keys);
 insert into public.news_archive_query_dirty select fingerprint from public.news_archive;
 update public.news_archive_query_state set policy=p_policy,index_revision=index_revision+1 where singleton=true;
 return true;
end $$;

notify pgrst,'reload schema';
commit;
