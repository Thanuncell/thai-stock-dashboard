-- G2-B offline implementation. Production installation/activation is NOT authorized.
-- Additive read functions only; no tables, index rebuild, source writes or RLS changes.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function public.news_archive_cursor_candidates(
 p_sources text[],p_symbol text,p_query text,p_exclude text[],p_now timestamptz,p_overlays jsonb
) returns setof public.news_archive_query_groups language sql stable security invoker as $$
 select g.* from public.news_archive_query_groups g
 join public.news_archive a on a.fingerprint=g.winner_fingerprint
 -- Correlate only the selected winner's small overlay. A materialized global
 -- overlay join here prevents the caller's ordered LIMIT from using the index.
 left join lateral (
  select o.symbols from jsonb_to_recordset(p_overlays) as o(url text,title text,published_at timestamptz,source text,source_name text,symbols text[])
  where cardinality(o.symbols) between 1 and 10 and a.url=o.url and a.title=o.title
   and a.source=o.source and a.source_name=o.source_name and date_trunc('milliseconds',a.published_at)=o.published_at limit 1
 ) r on true
 where not g.blocked and g.winner_published_at>=p_now-interval '365 days' and g.winner_published_at<=p_now+interval '10 minutes'
  and ('all'=any(p_sources) or g.publisher=any(p_sources) or g.source=any(p_sources) or ('other'=any(p_sources) and g.source='other') or ('broker'=any(p_sources) and g.broker))
  and (p_symbol='' or coalesce(r.symbols,g.symbols) @> array[p_symbol])
  and (p_query='' or exists(select 1 from unnest(g.search_fields) field where strpos(field,p_query)>0) or exists(select 1 from unnest(r.symbols) symbol where strpos(lower(symbol),p_query)>0))
  and not(g.aliases&&p_exclude)
  -- Apply the accepted removed-publisher predicate before both keyset selections.
  -- No bounded URL enumeration and no archive snapshot fallback.
  and a.source<>'investing'
  and btrim(a.source_name) !~* '^(investing(\.com)?( ประเทศไทย)?|อินเวสติ้ง(\.คอม)?)$'
  and a.title !~* '[[:space:]][-–—][[:space:]]Investing\.com[[:space:]]*$'
  and not exists(select 1 from unnest(array[a.url,a.canonical_url]) value
    where value ~* '^https?://([^/@]*@)?([^/:?#]+\.)?investing\.com([:/?#]|$)')
$$;

create or replace function public.list_news_archive_cursor(
 p_policy text,p_sources text[] default array['all'],p_symbol text default '',p_query text default '',
 p_exclude text[] default '{}',p_featured integer default 0,p_now timestamptz default now(),p_overlays jsonb default '[]',
 p_source_revision text default null,p_index_revision text default null,p_after jsonb default null,
 p_window_after jsonb default null,p_window_start integer default 1,p_window_pages integer default 0,
 p_featured_keys text[] default null,p_include_featured boolean default true
) returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare state public.news_archive_query_state; featured_keys text[]; page_keys text[]; has_next boolean;
 result jsonb; window_result jsonb; after_time timestamptz; after_id bigint; window_time timestamptz; window_id bigint;
begin
 select * into state from public.news_archive_query_state where singleton=true;
 if state.policy is distinct from p_policy then raise exception 'NEWS_QUERY_POLICY_NOT_READY';end if;
 if exists(select 1 from public.news_archive_query_dirty) then raise exception 'NEWS_QUERY_INDEX_NOT_READY';end if;
 if (p_source_revision is not null and p_source_revision<>state.source_revision::text)
  or (p_index_revision is not null and p_index_revision<>state.index_revision::text) then raise exception 'NEWS_ARCHIVE_CURSOR_INDEX_CHANGED';end if;
 if p_featured<0 or p_featured>5 or cardinality(p_sources)>12 or cardinality(p_exclude)>410 or char_length(p_query)>80
  or jsonb_typeof(p_overlays)<>'array' or jsonb_array_length(p_overlays)>200
  or p_window_pages<0 or p_window_pages>5 or p_window_start<1 or p_window_start>100000
  or cardinality(p_featured_keys)>p_featured then raise exception 'NEWS_QUERY_ARGUMENT_INVALID';end if;
 if p_after is not null and (jsonb_typeof(p_after)<>'object' or not(p_after ?& array['publishedAt','id'])) then raise exception 'NEWS_ARCHIVE_CURSOR_INVALID';end if;
 if p_window_after is not null and (jsonb_typeof(p_window_after)<>'object' or not(p_window_after ?& array['publishedAt','id'])) then raise exception 'NEWS_ARCHIVE_CURSOR_INVALID';end if;
 after_time=coalesce((p_after->>'publishedAt')::timestamptz,'infinity'::timestamptz);
 after_id=coalesce((p_after->>'id')::bigint,9223372036854775807);
 window_time=coalesce((p_window_after->>'publishedAt')::timestamptz,'infinity'::timestamptz);
 window_id=coalesce((p_window_after->>'id')::bigint,9223372036854775807);
 if p_featured_keys is not null then featured_keys=p_featured_keys;
 elsif p_featured=0 then featured_keys='{}';
 else
  select coalesce(array_agg(group_key),'{}') into featured_keys from (
   select group_key from public.news_archive_cursor_candidates(p_sources,p_symbol,p_query,p_exclude,p_now,p_overlays)
   where winner_published_at>=p_now-interval '7 days'
   order by source_tier desc,winner_published_at desc,order_published_at desc,order_id desc limit p_featured
  ) f;
 end if;
 with scan as materialized (
  select group_key,order_published_at,order_id from public.news_archive_cursor_candidates(p_sources,p_symbol,p_query,p_exclude,p_now,p_overlays)
  where (order_published_at,order_id)<(after_time,after_id) and not(group_key=any(featured_keys))
  order by order_published_at desc,order_id desc limit 11
 ), picked as materialized (select * from scan order by order_published_at desc,order_id desc limit 10)
 select coalesce((select array_agg(group_key order by order_published_at desc,order_id desc) from picked),'{}'),
  exists(select 1 from scan where group_key not in(select group_key from picked)),
  jsonb_build_object('pagePosition',(select jsonb_build_object('publishedAt',order_published_at,'id',order_id::text) from picked order by order_published_at,order_id limit 1))
 into page_keys,has_next,result;

 if p_window_pages>0 then
  with scan as materialized (
   select order_published_at,order_id from public.news_archive_cursor_candidates(p_sources,p_symbol,p_query,p_exclude,p_now,p_overlays)
   where (order_published_at,order_id)<(window_time,window_id) and not(group_key=any(featured_keys))
   order by order_published_at desc,order_id desc limit p_window_pages*10+1
  ), numbered as materialized (
   select *,row_number() over w as n,lag(order_published_at) over w as prev_time,lag(order_id) over w as prev_id
   from scan window w as(order by order_published_at desc,order_id desc)
  )
  select jsonb_build_object(
   'pages',coalesce((select jsonb_agg(jsonb_build_object('page',p_window_start+(n-1)/10,'position',
    case when n=1 then p_window_after else jsonb_build_object('publishedAt',prev_time,'id',prev_id::text) end) order by n)
    from numbered where n<=p_window_pages*10 and (n-1)%10=0),'[]'::jsonb),
   'hasMore',exists(select 1 from numbered where n>p_window_pages*10),
   'afterPosition',(select jsonb_build_object('publishedAt',order_published_at,'id',order_id::text) from numbered where n=p_window_pages*10)
  ) into window_result;
 end if;
 result=result||jsonb_build_object('sourceRevision',state.source_revision::text,'indexRevision',state.index_revision::text,
  'hasNext',has_next,'pageKeys',to_jsonb(page_keys),'contextFeaturedKeys',to_jsonb(featured_keys),
  'featuredKeys',case when p_include_featured then to_jsonb(featured_keys) else '[]'::jsonb end,
  'groups',coalesce((select jsonb_agg(jsonb_build_object('key',g.group_key,'projection',to_jsonb(g)||jsonb_build_object('order_id',g.order_id::text),
   'rows',(select jsonb_agg(to_jsonb(a)||jsonb_build_object('id',a.id::text) order by a.published_at desc,a.id desc)
    from(select a.* from public.news_archive a join public.news_archive_query_rows r using(fingerprint) where r.group_key=g.group_key order by a.published_at desc,a.id desc limit 2001) a)))
   from public.news_archive_query_groups g where g.group_key=any(page_keys||case when p_include_featured then featured_keys else '{}'::text[] end)),'[]'::jsonb));
 if (select coalesce(sum(jsonb_array_length(x->'rows')),0) from jsonb_array_elements(result->'groups') x)>2000 then raise exception 'NEWS_QUERY_RESPONSE_LIMIT';end if;
 if p_window_pages>0 then result=result||jsonb_build_object('window',window_result);end if;
 return result;
end $$;

revoke all on function public.news_archive_cursor_candidates(text[],text,text,text[],timestamptz,jsonb),
 public.list_news_archive_cursor(text,text[],text,text,text[],integer,timestamptz,jsonb,text,text,jsonb,jsonb,integer,integer,text[],boolean) from public,anon,authenticated;
grant execute on function public.news_archive_cursor_candidates(text[],text,text,text[],timestamptz,jsonb),
 public.list_news_archive_cursor(text,text[],text,text,text[],integer,timestamptz,jsonb,text,text,jsonb,jsonb,integer,integer,text[],boolean) to service_role;
notify pgrst,'reload schema';
commit;
