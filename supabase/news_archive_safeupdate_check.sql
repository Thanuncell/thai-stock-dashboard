-- Review-only preflight / post-patch verification. No Production execution authorized here.
-- Compare source count/digest in a quiescent rehearsal; concurrent legitimate ingests need per-fingerprint comparison.
-- Rollback: abort a failed patch transaction; after commit keep this compatibility patch when rolling back the app.
-- Never restore the unqualified functions or drop Evidence/Archive data as an application rollback.
begin transaction read only;
set local statement_timeout='5s';
with approved(name,original_md5,patched_md5) as (values
 ('news_archive_query_revision','04e35682d988379412ad605fa995f062','b144ea3aefda5881d28f9f690bcaf256'),
 ('news_archive_query_commit','136694df360670eb02c2067d338c645d','4d11ff632d8d19ac79a45149266453c6'),
 ('news_archive_query_reset','6b30ff87b49321d23494553d87a1f7fb','978b981e2db31c6f796a96e7bc3fb86e')
), functions as (
 select a.name,p.oid,p.proacl,p.prosecdef,md5(replace(p.prosrc,E'\r','')) body_md5,
 md5(replace(p.prosrc,E'\r',''))=a.original_md5 original,
 md5(replace(p.prosrc,E'\r',''))=a.patched_md5 patched
 from approved a left join pg_proc p on p.pronamespace='public'::regnamespace and p.proname=a.name
)
select jsonb_build_object(
 'patch_state',case when count(oid)=3 and bool_and(patched) then 'PATCHED' when count(oid)=3 and bool_and(original) then 'ORIGINAL' else 'UNEXPECTED_STOP' end,
 'functions',jsonb_agg(jsonb_build_object('name',name,'oid',oid,'body_md5',body_md5,'security_definer',prosecdef,'acl',proacl)),
 'functions_invoker',bool_and(not prosecdef),
 'safeupdate_in_this_session',current_setting('safeupdate.enabled',true),
 'archive_rows',(select count(*) from public.news_archive),
 'fingerprints',(select count(distinct fingerprint) from public.news_archive),
 'archive_digest',(select md5(string_agg(to_jsonb(a)::text,'' order by id)) from public.news_archive a),
 'rls_active',(select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in('public.news_archive'::regclass,'public.news_archive_query_state'::regclass,'public.news_archive_query_dirty'::regclass,'public.news_archive_query_rows'::regclass,'public.news_archive_query_groups'::regclass)),
 'index_state',(select to_jsonb(s) from public.news_archive_query_state s),
 'indexed_rows',(select count(*) from public.news_archive_query_rows)
) as compatibility_check from functions;
rollback;
