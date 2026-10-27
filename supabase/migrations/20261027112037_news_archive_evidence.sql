-- Additive proposal. Production application requires separate Owner approval.
begin;

alter table public.news_archive
  add column verification_status text,
  add column verification_reason text,
  add column verification_basis text,
  add column verification_policy_version text,
  add column verification_checked_at timestamptz,
  add column verification_subject_hash text,
  add column verification_revision bigint not null default 0,
  add column canonical_url text,
  add column canonical_key text,
  add column verification_provenance jsonb;

alter table public.news_archive add constraint news_archive_evidence_bundle check (
  (verification_status is null and verification_reason is null and verification_basis is null
    and verification_policy_version is null and verification_checked_at is null
    and verification_subject_hash is null and canonical_url is null and canonical_key is null
    and verification_provenance is null and verification_revision = 0)
  or
  (verification_status is not null and verification_status in ('VERIFIED','UNVERIFIED','REJECTED')
    and verification_reason ~ '^[A-Z0-9_]{1,80}$'
    and verification_basis in ('metadata','article')
    and verification_policy_version = 'news-quality-1'
    and verification_checked_at is not null and verification_revision > 0
    and verification_subject_hash ~ '^[a-f0-9]{64}$'
    and canonical_url ~ '^https://' and char_length(canonical_url) <= 2000
    and canonical_key ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(verification_provenance) = 'object'
    and octet_length(verification_provenance::text) <= 5000
    and verification_provenance->>'identityVersion' = 'news-url-1'
    and verification_reason is not null and verification_basis is not null
    and verification_policy_version is not null and verification_subject_hash is not null
    and canonical_url is not null and canonical_key is not null and verification_provenance is not null)
);

create function public.news_archive_subject_hash(r public.news_archive)
returns text language sql immutable strict
set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(string_agg(octet_length(convert_to(v,'UTF8'))::text || ':' || v, '' order by n),'UTF8')),'hex')
  from unnest(array[r.title,r.url,r.source,r.source_name,coalesce(r.snippet,''),
    to_char(r.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    case when cardinality(r.broker_firms)>0 then '1' else '0' end,coalesce(r.canonical_url,'')]) with ordinality as fields(v,n);
$$;

create function public.news_archive_evidence_valid(r public.news_archive)
returns boolean language sql immutable strict
set search_path = public, pg_temp as $$
  select coalesce(r.verification_status in ('VERIFIED','UNVERIFIED','REJECTED')
    and r.verification_policy_version='news-quality-1' and r.verification_revision>0
    and r.verification_subject_hash=public.news_archive_subject_hash(r)
    and r.canonical_key=encode(sha256(convert_to('news-url-1:' || r.canonical_url,'UTF8')),'hex')
    and r.verification_provenance->>'identityVersion'='news-url-1'
    and r.verification_provenance->>'publisher'=r.source_name
    and (r.verification_status<>'VERIFIED' or (r.verification_basis='article'
      and r.verification_reason='ARTICLE_IDENTITY_VERIFIED' and r.verification_provenance->>'resolvedUrl'=r.canonical_url)
      or (r.verification_basis='metadata' and r.verification_reason='NEWS_METADATA_EVIDENCE')),false);
$$;

create function public.guard_news_archive_evidence()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if TG_OP='UPDATE' then
    NEW.id:=OLD.id; NEW.fingerprint:=OLD.fingerprint; NEW.first_seen_at:=OLD.first_seen_at;
  end if;
  if TG_OP='UPDATE' and OLD.verification_status is not null then
    if NEW.verification_revision=OLD.verification_revision then
      if row(NEW.verification_status,NEW.verification_reason,NEW.verification_basis,NEW.verification_policy_version,
        NEW.verification_checked_at,NEW.verification_subject_hash,NEW.canonical_url,NEW.canonical_key,NEW.verification_provenance)
        is distinct from row(OLD.verification_status,OLD.verification_reason,OLD.verification_basis,OLD.verification_policy_version,
        OLD.verification_checked_at,OLD.verification_subject_hash,OLD.canonical_url,OLD.canonical_key,OLD.verification_provenance) then
        raise exception 'NEWS_EVIDENCE_REVISION_REQUIRED';
      end if;
      -- Compatibility writers cannot detach a committed decision from its subject.
      if public.news_archive_subject_hash(NEW) is distinct from public.news_archive_subject_hash(OLD) then
        NEW.title:=OLD.title; NEW.url:=OLD.url; NEW.source:=OLD.source; NEW.source_name:=OLD.source_name;
        NEW.snippet:=OLD.snippet; NEW.published_at:=OLD.published_at; NEW.broker_firms:=OLD.broker_firms;
        NEW.fetched_at:=OLD.fetched_at;
      end if;
    elsif NEW.verification_revision<>OLD.verification_revision+1 then
      raise exception 'NEWS_EVIDENCE_REVISION_INVALID';
    end if;
  end if;
  if NEW.verification_status is not null and not public.news_archive_evidence_valid(NEW) then
    raise exception 'NEWS_EVIDENCE_SUBJECT_INVALID';
  end if;
  return NEW;
end;
$$;

create trigger news_archive_evidence_guard before insert or update on public.news_archive
for each row execute function public.guard_news_archive_evidence();

create function public.upsert_news_archive_evidence(p_rows jsonb)
returns table(fingerprint text,outcome text) language plpgsql security invoker
set search_path = public, pg_temp as $$
declare v jsonb; incoming public.news_archive; current_row public.news_archive; expected bigint; changed integer;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>50 then raise exception 'NEWS_BATCH_INVALID'; end if;
  if (select count(*)<>count(distinct x->>'fingerprint') from jsonb_array_elements(p_rows) x) then
    raise exception 'NEWS_BATCH_DUPLICATE';
  end if;
  -- A consistent lock order also serializes competing inserts for absent keys.
  for v in select x from jsonb_array_elements(p_rows) x order by x->>'fingerprint' loop
    perform pg_advisory_xact_lock(hashtextextended(v->>'fingerprint',0));
  end loop;
  for v in select x from jsonb_array_elements(p_rows) x loop
    incoming:=jsonb_populate_record(null::public.news_archive,v);
    expected:=(v->>'expected_revision')::bigint;
    if incoming.fingerprint is null or incoming.fingerprint !~ '^[a-f0-9]{64}$' or expected is null or expected < -1 then raise exception 'NEWS_IDENTITY_INVALID'; end if;
    incoming.verification_revision:=1;
    if not public.news_archive_evidence_valid(incoming) then raise exception 'NEWS_EVIDENCE_INVALID'; end if;
    fingerprint:=incoming.fingerprint;
    select a.* into current_row from public.news_archive a where a.fingerprint=incoming.fingerprint for update;
    if not found then
      if expected<>-1 then outcome:='conflict'; return next; continue; end if;
      if incoming.verification_status<>'VERIFIED' then outcome:='not_inserted'; return next; continue; end if;
      insert into public.news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at,matched_symbols,broker_firms,
        verification_status,verification_reason,verification_basis,verification_policy_version,verification_checked_at,
        verification_subject_hash,verification_revision,canonical_url,canonical_key,verification_provenance)
      values(incoming.fingerprint,incoming.title,incoming.url,incoming.source,incoming.source_name,incoming.snippet,
        incoming.published_at,incoming.fetched_at,coalesce(incoming.matched_symbols,'{}'),coalesce(incoming.broker_firms,'{}'),
        incoming.verification_status,incoming.verification_reason,incoming.verification_basis,incoming.verification_policy_version,
        incoming.verification_checked_at,incoming.verification_subject_hash,1,incoming.canonical_url,incoming.canonical_key,incoming.verification_provenance)
      on conflict on constraint news_archive_fingerprint_key do nothing;
      get diagnostics changed=row_count;
      outcome:=case when changed=1 then 'persisted' else 'conflict' end; return next; continue;
    end if;
    if expected<>current_row.verification_revision then outcome:='conflict'; return next; continue; end if;
    -- Uncertainty cannot erase previously committed legacy or verified news.
    if incoming.verification_status='UNVERIFIED' then outcome:='retained'; return next; continue; end if;
    if public.news_archive_evidence_valid(current_row) and (
      incoming.verification_checked_at<current_row.verification_checked_at
      or (incoming.verification_status='UNVERIFIED' and current_row.verification_status='VERIFIED')
      or (incoming.verification_status='VERIFIED' and incoming.verification_basis='metadata'
        and (current_row.verification_basis='article' or current_row.verification_status='REJECTED'))
      or (incoming.verification_status=current_row.verification_status and incoming.verification_basis=current_row.verification_basis
        and incoming.verification_reason=current_row.verification_reason and incoming.verification_subject_hash=current_row.verification_subject_hash)
    ) then outcome:='retained'; return next; continue; end if;
    update public.news_archive a set title=incoming.title,url=incoming.url,source=incoming.source,source_name=incoming.source_name,
      snippet=incoming.snippet,published_at=incoming.published_at,fetched_at=incoming.fetched_at,
      matched_symbols=coalesce(incoming.matched_symbols,'{}'),broker_firms=coalesce(incoming.broker_firms,'{}'),
      verification_status=incoming.verification_status,verification_reason=incoming.verification_reason,
      verification_basis=incoming.verification_basis,verification_policy_version=incoming.verification_policy_version,
      verification_checked_at=incoming.verification_checked_at,verification_subject_hash=incoming.verification_subject_hash,
      verification_revision=current_row.verification_revision+1,canonical_url=incoming.canonical_url,
      canonical_key=incoming.canonical_key,verification_provenance=incoming.verification_provenance
    where a.id=current_row.id;
    outcome:='persisted'; return next;
  end loop;
end;
$$;

revoke all on function public.news_archive_subject_hash(public.news_archive) from public,anon,authenticated;
revoke all on function public.news_archive_evidence_valid(public.news_archive) from public,anon,authenticated;
revoke all on function public.guard_news_archive_evidence() from public,anon,authenticated;
revoke all on function public.upsert_news_archive_evidence(jsonb) from public,anon,authenticated;
grant execute on function public.news_archive_subject_hash(public.news_archive) to service_role;
grant execute on function public.news_archive_evidence_valid(public.news_archive) to service_role;
grant execute on function public.guard_news_archive_evidence() to service_role;
grant execute on function public.upsert_news_archive_evidence(jsonb) to service_role;
commit;
