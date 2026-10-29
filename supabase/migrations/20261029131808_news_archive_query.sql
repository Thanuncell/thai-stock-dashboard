-- WS7 additive proposal: derived query index only. Never modifies News Archive rows.
-- Owner approval required before Production installation, bootstrap or activation.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
create table public.news_archive_query_state(singleton boolean primary key default true check(singleton),source_revision bigint not null default 0,index_revision bigint not null default 0,policy text);
insert into public.news_archive_query_state(singleton) values(true);
create table public.news_archive_query_dirty(fingerprint text primary key);
create table public.news_archive_query_groups(
 group_key text primary key check(group_key ~ '^[a-f0-9]{64}$'),aliases text[] not null,
 order_published_at timestamptz not null,order_id bigint not null,winner_published_at timestamptz not null,
 winner_fingerprint text not null,source text not null,publisher text not null,blocked boolean not null,broker boolean not null,symbols text[] not null,
 search_fields text[] not null,url_identity text not null,source_tier integer not null
);
create table public.news_archive_query_rows(
 fingerprint text primary key,group_key text references public.news_archive_query_groups(group_key) on delete set null,
 row_digest text not null,quality_status text not null check(quality_status in ('VERIFIED','UNVERIFIED','REJECTED'))
);
create index news_archive_query_members_idx on public.news_archive_query_rows(group_key);
create index news_archive_query_alias_idx on public.news_archive_query_groups using gin(aliases);
create index news_archive_query_order_idx on public.news_archive_query_groups(order_published_at desc,order_id desc);
create index news_archive_query_publisher_idx on public.news_archive_query_groups(publisher,order_published_at desc,order_id desc);
create index news_archive_query_url_idx on public.news_archive_query_groups(url_identity);
create index news_archive_query_symbol_idx on public.news_archive_query_groups using gin(symbols);
create index news_archive_query_broker_idx on public.news_archive_query_groups(order_published_at desc,order_id desc) where broker;

create function public.news_archive_query_changed() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 insert into public.news_archive_query_dirty(fingerprint) values(case when TG_OP='DELETE' then OLD.fingerprint else NEW.fingerprint end) on conflict do nothing;
 return null;
end $$;
create trigger news_archive_query_changed after insert or update or delete on public.news_archive for each row execute function public.news_archive_query_changed();
create function public.news_archive_query_revision() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 update public.news_archive_query_state set source_revision=source_revision+1;
 if TG_OP='TRUNCATE' then insert into public.news_archive_query_dirty select fingerprint from public.news_archive_query_rows on conflict do nothing;end if;
 return null;
end $$;
create trigger news_archive_query_revision after insert or update or delete or truncate on public.news_archive for each statement execute function public.news_archive_query_revision();
insert into public.news_archive_query_dirty select fingerprint from public.news_archive;

create function public.news_archive_query_work(p_limit integer default 100) returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 with pending as (select fingerprint from public.news_archive_query_dirty order by fingerprint limit greatest(1,least(coalesce(p_limit,100),500)))
 select jsonb_build_object('sourceRevision',s.source_revision::text,'indexRevision',s.index_revision::text,'policy',s.policy,
 'fingerprints',coalesce((select jsonb_agg(fingerprint order by fingerprint) from pending),'[]'::jsonb),
 'rows',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('_query_digest',encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')) order by a.published_at desc,a.id desc) from public.news_archive a join pending p using(fingerprint)),'[]'::jsonb))
 from public.news_archive_query_state s;
$$;

create function public.news_archive_query_components(p_fingerprints text[],p_aliases text[]) returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare keys text[]; member_count integer;
begin
 if cardinality(p_fingerprints)>500 or cardinality(p_aliases)>1500 then raise exception 'NEWS_QUERY_BATCH_LIMIT';end if;
 select array_agg(g.group_key) into keys from public.news_archive_query_groups g where g.aliases&&p_aliases
 or g.group_key in (select r.group_key from public.news_archive_query_rows r where r.fingerprint=any(p_fingerprints));
 select count(*) into member_count from public.news_archive_query_rows r where r.group_key=any(keys);
 if member_count>2000 then raise exception 'NEWS_QUERY_COMPONENT_LIMIT';end if;
 return (select jsonb_build_object('sourceRevision',s.source_revision::text,'indexRevision',s.index_revision::text,
 'groups',coalesce(to_jsonb(keys),'[]'::jsonb),'rows',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('_query_digest',encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')) order by a.published_at desc,a.id desc)
 from public.news_archive a join public.news_archive_query_rows r using(fingerprint) where r.group_key=any(keys)),'[]'::jsonb)) from public.news_archive_query_state s);
end $$;

create function public.news_archive_query_commit(p_source_revision bigint,p_index_revision bigint,p_policy text,p_dirty text[],p_removed text[],p_groups jsonb,p_rows jsonb)
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
 update public.news_archive_query_state set policy=p_policy,index_revision=index_revision+1;
 return jsonb_build_object('committed',true,'pending',(select count(*) from public.news_archive_query_dirty));
end $$;

create function public.news_archive_query_reset(p_policy text) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_policy !~ '^news-query-1:(legacy|read|write):(metadata|article)$' then raise exception 'NEWS_QUERY_POLICY_MISMATCH';end if;
 perform 1 from public.news_archive_query_state for update;
 delete from public.news_archive_query_rows;delete from public.news_archive_query_groups;delete from public.news_archive_query_dirty;
 insert into public.news_archive_query_dirty select fingerprint from public.news_archive;
 update public.news_archive_query_state set policy=p_policy,index_revision=index_revision+1;
 return true;
end $$;

-- Read-only RPC. Counts and page rows use one MVCC snapshot; original overflow behavior stays unchanged.
create function public.list_news_archive_query(p_policy text,p_page integer default 1,p_page_size integer default 10,p_sources text[] default array['all'],p_symbol text default '',p_query text default '',p_exclude text[] default '{}',p_featured integer default 0,p_now timestamptz default now(),p_overlays jsonb default '[]'::jsonb)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare result jsonb; raw_count bigint; indexed_count bigint;
begin
 if not exists(select 1 from public.news_archive_query_state where policy=p_policy) then raise exception 'NEWS_QUERY_POLICY_NOT_READY';end if;
 if exists(select 1 from public.news_archive_query_dirty) then raise exception 'NEWS_QUERY_INDEX_NOT_READY';end if;
 select count(*) into raw_count from public.news_archive;select count(*) into indexed_count from public.news_archive_query_rows;
 if raw_count<>indexed_count then raise exception 'NEWS_QUERY_INDEX_NOT_READY';end if;
 if p_page<1 or p_page>100000 or p_page_size<1 or p_page_size>50 or p_featured<0 or p_featured>5 or cardinality(p_sources)>12 or cardinality(p_exclude)>410 or char_length(p_query)>80 or jsonb_typeof(p_overlays)<>'array' or jsonb_array_length(p_overlays)>200 then raise exception 'NEWS_QUERY_ARGUMENT_INVALID';end if;
 with runtime_symbols as materialized (
  select distinct on (g.group_key) g.group_key,o.symbols
  from jsonb_to_recordset(p_overlays) as o(url text,title text,published_at timestamptz,source text,source_name text,symbols text[])
  join public.news_archive a on a.url=o.url and a.title=o.title and a.source=o.source and a.source_name=o.source_name and date_trunc('milliseconds',a.published_at)=o.published_at
  join public.news_archive_query_groups g on g.winner_fingerprint=a.fingerprint
  where cardinality(o.symbols) between 1 and 10
 ), eligible as materialized (
  select g.* from public.news_archive_query_groups g left join runtime_symbols r using(group_key)
  where not g.blocked and g.winner_published_at>=p_now-interval '365 days' and g.winner_published_at<=p_now+interval '10 minutes'
   and ('all'=any(p_sources) or g.publisher=any(p_sources) or g.source=any(p_sources) or ('other'=any(p_sources) and g.source='other') or ('broker'=any(p_sources) and g.broker))
   and (p_symbol='' or coalesce(r.symbols,g.symbols) @> array[p_symbol])
   and (p_query='' or exists(select 1 from unnest(g.search_fields) field where strpos(field,p_query)>0) or exists(select 1 from unnest(r.symbols) symbol where strpos(lower(symbol),p_query)>0))
   and not(g.aliases&&p_exclude)
 ), featured as materialized (
  select group_key from eligible where winner_published_at>=p_now-interval '7 days'
  order by source_tier desc,winner_published_at desc,order_published_at desc,order_id desc limit p_featured
 ), latest as materialized (
  select * from eligible where group_key not in(select group_key from featured)
 ), page as materialized (
  select group_key from latest order by order_published_at desc,order_id desc limit p_page_size offset (p_page::bigint-1)*p_page_size
 ), picked as materialized (
  select group_key from featured union select group_key from page
 )
 select jsonb_build_object('total',(select count(*) from latest),'matchingTotal',(select count(*) from eligible),'countExact',true,
 'page',p_page,'pageSize',p_page_size,'rawTotal',raw_count,
 'qualityFiltered',(select count(*) from public.news_archive_query_rows where group_key is null),
 'rejected',(select count(*) from public.news_archive_query_rows where quality_status='REJECTED'),
 'quarantined',greatest((select count(*) from public.news_archive_query_rows where quality_status='UNVERIFIED'),(select count(*) from public.news_archive_query_rows where group_key is null)-(select count(*) from public.news_archive_query_rows where quality_status='REJECTED')),
 'deduplicated',(select count(*) from public.news_archive_query_rows where group_key is not null)-(select count(*) from public.news_archive_query_groups),
 'featuredKeys',coalesce((select jsonb_agg(f.group_key order by g.source_tier desc,g.winner_published_at desc,g.order_published_at desc,g.order_id desc) from featured f join public.news_archive_query_groups g using(group_key)),'[]'::jsonb),
 'pageKeys',coalesce((select jsonb_agg(p.group_key order by g.order_published_at desc,g.order_id desc) from page p join public.news_archive_query_groups g using(group_key)),'[]'::jsonb),
 'groups',coalesce((select jsonb_agg(jsonb_build_object('key',g.group_key,'projection',to_jsonb(g),'rows',(select jsonb_agg(to_jsonb(a) order by a.published_at desc,a.id desc) from public.news_archive a join public.news_archive_query_rows r using(fingerprint) where r.group_key=g.group_key))) from picked p join public.news_archive_query_groups g using(group_key)),'[]'::jsonb)) into result;
 if (select coalesce(sum(jsonb_array_length(x->'rows')),0) from jsonb_array_elements(result->'groups') x)>2000 then raise exception 'NEWS_QUERY_RESPONSE_LIMIT';end if;
 return result;
end $$;

alter table public.news_archive_query_state enable row level security;alter table public.news_archive_query_state force row level security;
alter table public.news_archive_query_dirty enable row level security;alter table public.news_archive_query_dirty force row level security;
alter table public.news_archive_query_groups enable row level security;alter table public.news_archive_query_groups force row level security;
alter table public.news_archive_query_rows enable row level security;alter table public.news_archive_query_rows force row level security;
revoke all on public.news_archive_query_state,public.news_archive_query_dirty,public.news_archive_query_groups,public.news_archive_query_rows from public,anon,authenticated,service_role;
grant select,update on public.news_archive_query_state to service_role;
grant select,insert,delete on public.news_archive_query_dirty,public.news_archive_query_groups to service_role;
grant select,insert,update,delete on public.news_archive_query_rows to service_role;
revoke all on function public.news_archive_query_revision(),public.news_archive_query_changed(),public.news_archive_query_work(integer),public.news_archive_query_components(text[],text[]),public.news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb),public.news_archive_query_reset(text),public.list_news_archive_query(text,integer,integer,text[],text,text,text[],integer,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.news_archive_query_work(integer),public.news_archive_query_components(text[],text[]),public.news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb),public.news_archive_query_reset(text),public.list_news_archive_query(text,integer,integer,text[],text,text,text[],integer,timestamptz,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
