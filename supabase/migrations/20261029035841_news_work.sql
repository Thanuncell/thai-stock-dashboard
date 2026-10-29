-- Review proposal only. Apply transactionally to an isolated database first.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create table public.news_work (
 id bigint generated always as identity primary key,
 work_key text not null unique check(length(work_key)=64),
 scope text not null check(length(scope) between 1 and 100),
 initial_stage text not null check(initial_stage in ('discovery','extraction','persistence')),
 stage text not null check(stage in ('discovery','extraction','persistence')),
 state text not null default 'pending' check(state in ('pending','processing','retry','completed','terminal')),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=64000),
 checkpoint jsonb,
 attempts integer not null default 0 check(attempts between 0 and 5),
 available_at timestamptz not null default clock_timestamp(),
 lease_token uuid, lease_until timestamptz,
 last_error text check(length(last_error)<=80),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check ((state='processing' and lease_token is not null and lease_until is not null) or (state<>'processing' and lease_token is null and lease_until is null))
);
create index news_work_due on public.news_work(available_at,id) where state in ('pending','retry');
create index news_work_expired on public.news_work(lease_until,id) where state='processing';
alter table public.news_work enable row level security;
alter table public.news_work force row level security;
revoke all on public.news_work from public,anon,authenticated;
grant select,insert,update on public.news_work to service_role;
grant usage,select on sequence public.news_work_id_seq to service_role;

create function public.enqueue_news_work(p_key text,p_scope text,p_stage text,p_payload jsonb)
returns setof public.news_work language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.news_work;
begin
 insert into public.news_work(work_key,scope,initial_stage,stage,payload) values(p_key,p_scope,p_stage,p_stage,p_payload)
 on conflict(work_key) do nothing;
 select * into r from public.news_work where work_key=p_key;
 if r.scope<>p_scope or r.initial_stage<>p_stage or r.payload<>p_payload then raise exception 'NEWS_WORK_KEY_COLLISION'; end if;
 return next r;
end; $$;

create function public.claim_news_work(p_scope text,p_limit integer default 1,p_lease_seconds integer default 60)
returns setof public.news_work language plpgsql security invoker set search_path=pg_catalog,public as $$
declare active_count integer;
begin
 if p_limit not between 1 and 4 or p_lease_seconds not between 10 and 300 then raise exception 'NEWS_WORK_BUDGET'; end if;
 perform pg_advisory_xact_lock(hashtextextended('news-work:'||p_scope,0));
 select count(*) into active_count from public.news_work where scope=p_scope and state='processing' and lease_until>clock_timestamp();
 p_limit:=least(p_limit,greatest(0,4-active_count));
 if p_limit=0 then return; end if;
 -- Exhausted jobs, including crashed final attempts, remain inspectable.
 update public.news_work set state='terminal',lease_token=null,lease_until=null,last_error='ATTEMPTS_EXHAUSTED',updated_at=clock_timestamp()
 where scope=p_scope and attempts>=5 and ((state='processing' and lease_until<clock_timestamp()) or state in ('pending','retry'));
 return query
 with due as (
  select id from public.news_work
  where scope=p_scope and attempts<5 and
   ((state in ('pending','retry') and available_at<=clock_timestamp()) or (state='processing' and lease_until<clock_timestamp()))
  order by available_at,id for update skip locked limit p_limit
 )
 update public.news_work w set state='processing',attempts=w.attempts+1,lease_token=gen_random_uuid(),
 lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
 from due where w.id=due.id returning w.*;
end; $$;

create function public.finish_news_work(p_id bigint,p_token uuid,p_scope text,p_action text,p_stage text default null,
 p_checkpoint jsonb default null,p_error text default null,p_delay integer default 1)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare changed integer;
begin
 if p_action not in ('advance','retry','completed','terminal') or p_delay not between 0 and 3600
 or (p_checkpoint is not null and octet_length(p_checkpoint::text)>64000) then raise exception 'NEWS_WORK_TRANSITION'; end if;
 update public.news_work set
 stage=case when p_action='advance' then p_stage else stage end,
 checkpoint=case when p_action='advance' then p_checkpoint else checkpoint end,
 state=case when p_action='advance' then 'pending' when p_action='retry' and attempts>=5 then 'terminal' else p_action end,
 attempts=case when p_action='advance' then 0 else attempts end,
 available_at=clock_timestamp()+make_interval(secs=>case when p_action='retry' then p_delay else 0 end),
 lease_token=null,lease_until=null,last_error=left(p_error,80),updated_at=clock_timestamp()
 where id=p_id and scope=p_scope and state='processing' and lease_token=p_token and lease_until>clock_timestamp()
 and (p_action<>'advance' or (stage='discovery' and p_stage='extraction') or (stage='extraction' and p_stage='persistence'));
 get diagnostics changed=row_count;return changed=1;
end; $$;
revoke all on function public.enqueue_news_work(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.claim_news_work(text,integer,integer) from public,anon,authenticated;
revoke all on function public.finish_news_work(bigint,uuid,text,text,text,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.enqueue_news_work(text,text,text,jsonb),public.claim_news_work(text,integer,integer),
 public.finish_news_work(bigint,uuid,text,text,text,jsonb,text,integer) to service_role;
notify pgrst,'reload schema';
commit;
