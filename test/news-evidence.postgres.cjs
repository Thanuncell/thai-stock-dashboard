'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {Pool}=require('pg');
const {article,env}=require('./fixtures/news-evidence.cjs');
const {createNewsArchiveService,reviewArchivedNewsRow}=require('../server/news-archive-service');
const {rowSubjectHash,issueEvidence,validStoredEvidence}=require('../lib/news-evidence');
const {reviewNewsItem}=require('../lib/news-quality');

test('AC-G1-09/10: native PostgreSQL evidence, concurrency and compatible rollback',{
  skip:!process.env.SETSCOPE_G1_TEST_PG
},async t=>{
  const config=JSON.parse(process.env.SETSCOPE_G1_TEST_PG);
  assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'postgres');
  const admin=new Pool({...config,max:1}),database='setscope_g1_'+randomUUID().replaceAll('-','');
  assert.match((await admin.query('show server_version')).rows[0].server_version,/^17\./);
  await admin.query('create database '+database);
  const pool=new Pool({...config,database,max:6});
  let writer;
  try{
    for(const role of ['anon','authenticated','service_role']){
      if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)
        await admin.query('create role '+role+' nologin'+(role==='service_role'?' bypassrls':''));
    }
    await pool.query(await fs.readFile(path.join(__dirname,'../supabase/news_archive.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(__dirname,'../supabase/news_archive_least_privilege.sql'),'utf8'));
    await pool.query("insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at) values('legacy','Legacy news','https://news.google.com/articles/legacy','other','Unknown publisher','Sufficient synthetic source snippet for legacy verification',now(),now())");
    const legacyBefore=(await pool.query("select to_jsonb(a) data from news_archive a where fingerprint='legacy'")).rows[0].data;
    const protections=async()=>(await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='public.news_archive'::regclass")).rows;
    const controls=await protections();
    const migrationFiles=(await fs.readdir(path.join(__dirname,'../supabase/migrations'))).filter(name=>name.endsWith('_news_archive_evidence.sql'));
    assert.equal(migrationFiles.length,1);
    await pool.query(await fs.readFile(path.join(__dirname,'../supabase/migrations',migrationFiles[0]),'utf8'));
    writer=new Pool({...config,database,max:6,options:'-c role=service_role'});
    let beforeRevisionRead=null;
    // This transport calls the actual RPC SQL and preserves the application's REST payload.
    // It verifies native PostgreSQL semantics, not live Supabase/PostgREST.
    const fetchImpl=async(input,init={})=>{
      const url=new URL(input);
      if(url.pathname.endsWith('/cleanup_news_archive'))return Response.json((await writer.query('select cleanup_news_archive(500) n')).rows[0].n);
      if(url.pathname.endsWith('/upsert_news_archive_evidence')){
        const result=await writer.query('select * from upsert_news_archive_evidence($1::jsonb)',[JSON.stringify(JSON.parse(init.body).p_rows)]);
        return Response.json(result.rows);
      }
      assert.ok(url.pathname.endsWith('/news_archive'));
      const fp=url.searchParams.get('fingerprint');
      const rows=fp?(await writer.query('select * from news_archive where fingerprint=any($1::text[])',[fp.slice(4,-1).split(',')])).rows
        :(await writer.query('select * from news_archive order by published_at desc,id desc')).rows;
      if(fp&&beforeRevisionRead)await beforeRevisionRead();
      const [start,end]=String(init.headers?.Range||'0-999').split('-').map(Number);
      return Response.json(rows.slice(start,end+1),{headers:{'content-range':`${start}-${Math.max(start,start+rows.length-1)}/${rows.length}`}});
    };
    const service=(mode='write')=>createNewsArchiveService({env:{...env,SETSCOPE_NEWS_EVIDENCE:mode},fetchImpl});
    const current=async()=> (await pool.query("select * from news_archive where fingerprint<>'legacy' order by id limit 1")).rows[0];
    await t.test('additive migration preserves legacy data and table protections',async()=>{
      const after=(await pool.query("select * from news_archive where fingerprint='legacy'")).rows[0];
      const afterJson=(await pool.query("select to_jsonb(a) data from news_archive a where fingerprint='legacy'")).rows[0].data;
      assert.deepEqual(Object.fromEntries(Object.keys(legacyBefore).map(key=>[key,afterJson[key]])),legacyBefore);
      assert.equal(after.verification_status,null);assert.equal(reviewArchivedNewsRow(after).status,'VERIFIED');
      assert.deepEqual(await protections(),controls);
      for(const role of ['anon','authenticated']){
        const access=(await pool.query("select has_table_privilege($1,'public.news_archive','select') t,has_function_privilege($1,'public.upsert_news_archive_evidence(jsonb)','execute') f",[role])).rows[0];
        assert.deepEqual(access,{t:false,f:false});
      }
    });
    const item=article();
    await t.test('article roundtrip, native hash parity and fresh process read',async()=>{
      const result=await service().ingest([item]);assert.equal(result.ingested,1);
      const row=await current();assert.equal(row.verification_subject_hash,rowSubjectHash(row));assert.ok(validStoredEvidence(row));
      assert.equal((await pool.query('select news_archive_subject_hash(a) h,news_archive_evidence_valid(a) v from news_archive a where id=$1',[row.id])).rows[0].h,row.verification_subject_hash);
      const listed=await service('read').list();assert.equal(listed.items.find(x=>x.fingerprint===row.fingerprint).verification.basis,'article');
      const code="const {Pool}=require('pg');const {reviewArchivedNewsRow}=require('./server/news-archive-service');(async()=>{const p=new Pool(JSON.parse(process.env.SETSCOPE_G1_CHILD_PG));try{const r=await p.query(\"select * from news_archive where fingerprint<>'legacy'\");console.log(JSON.stringify(r.rows.map(reviewArchivedNewsRow)));}finally{await p.end();}})().catch(e=>{console.error(e);process.exitCode=1});";
      const child=await promisify(execFile)(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:{...process.env,SETSCOPE_G1_CHILD_PG:JSON.stringify({...config,database})}});
      assert.equal(JSON.parse(child.stdout)[0].basis,'article');
    });
    await t.test('old writer cannot detach evidence, reset first_seen or alter stored AI',async()=>{
      const row=await current();
      await writer.query("update news_archive set analysis_mode='ai',analysis_summary='Stored synthetic AI' where id=$1",[row.id]);
      await writer.query("update news_archive set title='Old writer changed title',snippet='Old writer changed snippet',fetched_at=now(),first_seen_at=now()+interval '1 day' where id=$1",[row.id]);
      const after=await current();assert.equal(after.title,row.title);assert.equal(after.snippet,row.snippet);
      assert.equal(+after.first_seen_at,+row.first_seen_at);assert.equal(after.analysis_summary,'Stored synthetic AI');
      assert.ok(validStoredEvidence(after));assert.equal(after.verification_revision,row.verification_revision);
      const metadata={...JSON.parse(JSON.stringify(item)),snippet:'Sufficient metadata-only refresh source evidence'};
      const result=await service().ingest([metadata]);assert.equal(result.retained,1);assert.equal((await current()).verification_basis,'article');
    });
    await t.test('native simultaneous updates produce one winner and one revision conflict',async()=>{
      let readers=0,release;const barrier=new Promise(resolve=>{release=resolve;});
      beforeRevisionRead=async()=>{readers++;if(readers===2)release();await barrier;};
      const a=article({title:'Q3 A',checkedAt:Date.now()+100}),b=article({title:'Q3 B',checkedAt:Date.now()+100});
      const results=await Promise.all([service().ingest([a]),service().ingest([b])]);beforeRevisionRead=null;
      assert.equal(results.reduce((n,r)=>n+r.ingested,0),1);assert.equal(results.reduce((n,r)=>n+r.conflicts,0),1);
      const row=await current();assert.ok(validStoredEvidence(row));assert.equal(row.analysis_summary,'Stored synthetic AI');
      assert.equal((await pool.query("select count(*)::int n from news_archive where fingerprint<>'legacy'")).rows[0].n,1);
      const stale=article({title:'Delayed older verification',checkedAt:Date.now()-10000});
      assert.equal((await service().ingest([stale])).retained,1);assert.equal((await current()).title,row.title);
    });
    await t.test('concurrent AI writer and trusted metadata/evidence upsert preserve independent columns',async()=>{
      const row=await current(),next=article({title:'Q3 C',checkedAt:Date.now()+200});
      await Promise.all([service().ingest([next]),writer.query("update news_archive set analysis_summary='Concurrent synthetic AI' where id=$1",[row.id])]);
      const after=await current();assert.equal(after.analysis_summary,'Concurrent synthetic AI');assert.ok(validStoredEvidence(after));
      assert.equal(+after.first_seen_at,+row.first_seen_at);
    });
    await t.test('transient negative retains accepted data; trusted rejection hides without deletion',async()=>{
      const row=await current(),same={...item,title:row.title,pubDate:row.published_at.toISOString(),snippet:row.snippet};
      const uncertain=issueEvidence(same,{status:'UNVERIFIED',reason:'ARTICLE_NOT_VERIFIED',basis:'article'},{checkedAt:Date.now()+300});
      const result=await service().ingest([],{assessments:[{item:same,verification:uncertain}]});assert.equal(result.retained,1);
      const bad={...same,title:'Login'},rejected=reviewNewsItem(bad);
      // Rejection observation is later than the earlier fixture observations.
      const trusted=issueEvidence(bad,rejected,{checkedAt:Date.now()+400});
      assert.equal((await service().ingest([],{assessments:[{item:bad,verification:trusted}]})).ingested,1);
      const after=await current();assert.equal(after.verification_status,'REJECTED');assert.equal(reviewArchivedNewsRow(after).status,'REJECTED');
      assert.equal((await service('read').list()).items.some(x=>x.fingerprint===row.fingerprint),false);
      assert.equal((await pool.query('select count(*)::int n from news_archive')).rows[0].n,2);
      const unrelated={...bad,url:'https://thunhoon.com/article-unknown'};
      const unrelatedEvidence=reviewNewsItem(unrelated);
      const skipped=await service().ingest([],{assessments:[{item:unrelated,verification:unrelatedEvidence}]});
      assert.equal(skipped.ingested,0);assert.equal((await pool.query('select count(*)::int n from news_archive')).rows[0].n,2);
    });
    await t.test('failed transaction and lost acknowledgement preserve existing committed rows',async()=>{
      const row=await current(),before=JSON.stringify(row);
      await assert.rejects(writer.query('select * from upsert_news_archive_evidence($1::jsonb)',[JSON.stringify([{...row,verification_subject_hash:'0'.repeat(64),expected_revision:Number(row.verification_revision)}])]),/NEWS_EVIDENCE_INVALID/);
      assert.equal(JSON.stringify(await current()),before);
      const fresh=article({url:'https://thunhoon.com/article-789012',checkedAt:Date.now()+500});
      let lost=true;
      const unreliable=createNewsArchiveService({env,fetchImpl:async(url,init)=>{
        const result=await fetchImpl(url,init);
        if(String(url).endsWith('/upsert_news_archive_evidence')&&lost){lost=false;throw Error('fixture acknowledgement lost');}
        return result;
      }});
      await assert.rejects(unreliable.ingest([fresh]));
      const replay=await service().ingest([fresh]);assert.equal(replay.retained,1);
      assert.equal((await pool.query("select count(*)::int n from news_archive where url=$1",[fresh.url])).rows[0].n,1);
    });
    await t.test('read-only compatibility rollback preserves evidence columns and accepted data',async()=>{
      const read=await service('read').list();assert.ok(read.items.some(x=>x.url.endsWith('789012')));
      const columns=(await pool.query("select column_name from information_schema.columns where table_schema='public' and table_name='news_archive'")).rows.map(r=>r.column_name);
      assert.ok(columns.includes('verification_status'));assert.ok(columns.includes('analysis_summary'));
      assert.deepEqual(await protections(),controls);
    });
    await t.test('transient checks preserve accepted legacy rows before evidence backfill',async()=>{
      const url='https://news.google.com/articles/legacy-lkg',fingerprint=createHash('sha256').update('url:'+url).digest('hex');
      const published=new Date(Date.now()-1000).toISOString();
      await writer.query("insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at) values($1,'Q3',$2,'other','Unknown publisher','Sufficient legacy source snippet remains accepted',$3,now())",[fingerprint,url,published]);
      const subject={title:'Q3',url,source:'other',sourceName:'Unknown publisher',snippet:'',pubDate:published};
      const uncertain=issueEvidence(subject,{status:'UNVERIFIED',reason:'ARTICLE_NOT_VERIFIED',basis:'article'});
      assert.equal((await service().ingest([],{assessments:[{item:subject,verification:uncertain}]})).retained,1);
      const row=(await pool.query('select * from news_archive where fingerprint=$1',[fingerprint])).rows[0];
      assert.equal(row.verification_status,null);assert.equal(reviewArchivedNewsRow(row).status,'VERIFIED');
    });
    await t.test('Thai UTF-8 projection has identical JavaScript and PostgreSQL subject hashes',async()=>{
      const item=article({url:'https://thunhoon.com/article-654321',title:'ผลประกอบการไตรมาส 3',sourceName:'ทันหุ้น',snippet:'ข้อความย่อภาษาไทยสำหรับทดสอบความตรงกันของข้อมูล'});
      assert.equal((await service().ingest([item])).ingested,1);
      const row=(await pool.query('select a.*,news_archive_subject_hash(a) native_hash from news_archive a where url=$1',[item.url])).rows[0];
      assert.equal(row.native_hash,rowSubjectHash(row));assert.equal(reviewArchivedNewsRow(row).basis,'article');
    });
    await t.test('P1: equivalent T3 verification fences delayed T2 rejection and retries',async()=>{
      const time=Date.now(),pubDate=new Date(time-10000).toISOString(),url='https://thunhoon.com/article-951001';
      const first=article({url,pubDate,checkedAt:time-3000}),latest=article({url,pubDate,checkedAt:time-1000});
      assert.equal((await service().ingest([first])).ingested,1);
      const before=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.equal((await service().ingest([latest])).ingested,1);
      const fresh=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.equal(+fresh.verification_checked_at,time-1000);assert.equal(Number(fresh.verification_revision),Number(before.verification_revision)+1);
      const rejected=issueEvidence(first,{status:'REJECTED',reason:'ARTICLE_NOT_FOUND',basis:'article'},{checkedAt:time-2000});
      assert.equal((await service().ingest([],{assessments:[{item:first,verification:rejected}]})).retained,1);
      assert.equal((await service().ingest([latest])).retained,1);
      const final=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.equal(final.verification_status,'VERIFIED');assert.equal(final.verification_revision,fresh.verification_revision);
      assert.equal(+final.first_seen_at,+before.first_seen_at);assert.ok(validStoredEvidence(final));
      const bad={...first,title:'Login'},lateNegative=issueEvidence(bad,{status:'REJECTED',reason:'ARTICLE_NOT_FOUND',basis:'article'},{checkedAt:time-2000});
      assert.equal((await service().ingest([],{assessments:[{item:bad,verification:lateNegative}]})).retained,1,
        'reclassifying a trusted observation must not mint a later ordering timestamp');
    });
    await t.test('P2: trusted association refresh is additive, bounded and visible to stock filters',async()=>{
      const time=Date.now(),pubDate=new Date(time-10000).toISOString(),url='https://thunhoon.com/article-951002';
      const first=article({url,pubDate,checkedAt:time-3000,matchedSymbols:['PTT'],matchedBrokerFirms:['FSS']});
      await service().ingest([first]);
      await writer.query("update news_archive set analysis_summary='Association AI',analysis_mode='ai' where url=$1",[url]);
      const before=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      const refresh=article({url,pubDate,checkedAt:time-1000,matchedSymbols:[' ptt ','or','OR'],matchedBrokerFirms:[' fss ','KGI']});
      assert.equal((await service().ingest([refresh])).ingested,1);
      const after=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.deepEqual(after.matched_symbols,['PTT','OR']);assert.deepEqual(after.broker_firms,['FSS','KGI']);
      assert.ok(validStoredEvidence(after));assert.equal(after.analysis_summary,'Association AI');
      assert.equal(+after.first_seen_at,+before.first_seen_at);assert.equal(after.fingerprint,before.fingerprint);
      assert.ok((await service('read').list({symbol:'OR'})).items.some(x=>x.url===url));
      const {mergeStockNews}=require('../server/watchlist-news');
      assert.equal(mergeStockNews((await service('read').list({symbol:'OR'})).items,[{symbol:'OR'}],Date.now()).some(x=>x.url===url),true);
      const newer=article({url,pubDate,checkedAt:time,matchedSymbols:['OR'],matchedBrokerFirms:[]});
      await service().ingest([newer]);
      const preserved=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.deepEqual(preserved.matched_symbols,['PTT','OR']);assert.deepEqual(preserved.broker_firms,['FSS','KGI']);
      assert.ok(validStoredEvidence(preserved));
      await writer.query("update news_archive set matched_symbols='{BAD}',broker_firms='{}',first_seen_at=now() where url=$1",[url]);
      const oldWriter=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.deepEqual(oldWriter.matched_symbols,preserved.matched_symbols);assert.deepEqual(oldWriter.broker_firms,preserved.broker_firms);
      assert.equal(oldWriter.analysis_summary,'Association AI');assert.equal(+oldWriter.first_seen_at,+before.first_seen_at);assert.ok(validStoredEvidence(oldWriter));
    });
    await t.test('P1: competing T2 negative and T3 equivalent writers converge through revision conflicts',async()=>{
      for(const negativeFirst of [true,false]){
        const time=Date.now(),url='https://thunhoon.com/article-95100'+(negativeFirst?'3':'4'),pubDate=new Date(time-10000).toISOString();
        const first=article({url,pubDate,checkedAt:time-3000}),latest=article({url,pubDate,checkedAt:time-1000});
        await service().ingest([first]);
        const rejection=issueEvidence(first,{status:'REJECTED',reason:'ARTICLE_NOT_FOUND',basis:'article'},{checkedAt:time-2000});
        let readers=0,release;const barrier=new Promise(resolve=>{release=resolve;});
        beforeRevisionRead=async()=>{if(++readers===2)release();await barrier;};
        const reject=()=>service().ingest([],{assessments:[{item:first,verification:rejection}]}),verify=()=>service().ingest([latest]);
        let results;try{results=await Promise.all(negativeFirst?[reject(),verify()]:[verify(),reject()]);}finally{beforeRevisionRead=null;}
        assert.equal(results.reduce((n,r)=>n+r.ingested,0),1);assert.equal(results.reduce((n,r)=>n+r.conflicts,0),1);
        await verify();assert.equal((await reject()).retained,1);
        const row=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
        assert.equal(row.verification_status,'VERIFIED');assert.equal(+row.verification_checked_at,time-1000);assert.ok(validStoredEvidence(row));
        const tie=issueEvidence(latest,{status:'REJECTED',reason:'ARTICLE_NOT_FOUND',basis:'article'},{checkedAt:time-1000});
        assert.equal((await service().ingest([],{assessments:[{item:latest,verification:tie}]})).retained,1);
      }
    });
    await t.test('P2: association union is bounded, broker binding stays valid and retries are idempotent',async()=>{
      const time=Date.now(),url='https://thunhoon.com/article-951005',pubDate=new Date(time-10000).toISOString();
      const first=article({url,pubDate,checkedAt:time-3000,matchedSymbols:['PTT']});await service().ingest([first]);
      const refreshed=article({url,pubDate,checkedAt:time-1000,
        matchedSymbols:['PTT',...Array.from({length:40},(_,i)=>'S'+i)],matchedBrokerFirms:Array.from({length:15},(_,i)=>'B'+i)});
      assert.equal((await service().ingest([refreshed])).ingested,1);
      const row=(await pool.query('select a.*,news_archive_subject_hash(a) native_hash from news_archive a where url=$1',[url])).rows[0];
      assert.equal(row.matched_symbols.length,30);assert.equal(row.broker_firms.length,10);assert.ok(row.matched_symbols.includes('PTT'));
      assert.ok(validStoredEvidence(row));assert.equal(row.native_hash,row.verification_subject_hash);
      assert.equal((await service().ingest([refreshed])).retained,1);
      const before=(await pool.query('select to_jsonb(a) data from news_archive a where url=$1',[url])).rows[0].data;
      const spoof={...JSON.parse(JSON.stringify(first)),snippet:'Sufficient synthetic metadata source evidence',matchedSymbols:['BAD'],matchedBrokerFirms:['BAD'],
        verification:{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article',checkedAt:'2099-01-01T00:00:00Z'}};
      await service().ingest([spoof]);
      assert.deepEqual((await pool.query('select to_jsonb(a) data from news_archive a where url=$1',[url])).rows[0].data,before);
      const negative=issueEvidence(first,{status:'REJECTED',reason:'ARTICLE_NOT_FOUND',basis:'article'},{checkedAt:time});
      await service().ingest([],{assessments:[{item:first,verification:negative}]});
      const rejected=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.deepEqual(rejected.matched_symbols,row.matched_symbols);assert.deepEqual(rejected.broker_firms,row.broker_firms);assert.ok(validStoredEvidence(rejected));
    });
    await t.test('P1/P2: invalid association rolls back the entire RPC batch',async()=>{
      let payload;
      const capture=createNewsArchiveService({env,fetchImpl:async(input,init={})=>{
        if(String(input).endsWith('/upsert_news_archive_evidence')){payload=JSON.parse(init.body).p_rows;return Response.json(payload.map(r=>({fingerprint:r.fingerprint,outcome:'persisted'})));}
        return Response.json([]);
      }});
      await capture.ingest([article({url:'https://thunhoon.com/article-951006'}),article({url:'https://thunhoon.com/article-951007'})]);
      payload[1].matched_symbols=['bad association'];
      await assert.rejects(writer.query('select * from upsert_news_archive_evidence($1::jsonb)',[JSON.stringify(payload)]),/NEWS_ASSOCIATION_INVALID/);
      assert.equal((await pool.query('select count(*)::int n from news_archive where fingerprint=any($1::text[])',[payload.map(r=>r.fingerprint)])).rows[0].n,0);
    });
    await t.test('P2: weaker trusted metadata can add associations without advancing article evidence',async()=>{
      const time=Date.now(),pubDate=new Date(time-10000).toISOString(),url='https://thunhoon.com/article-951008';
      const first=article({url,pubDate,checkedAt:time-3000,matchedSymbols:['PTT'],matchedBrokerFirms:['FSS']});
      await service().ingest([first]);
      const metadata={...JSON.parse(JSON.stringify(first)),verification:undefined,brokerCategory:true,matchedSymbols:['OR']};
      metadata.verification=reviewNewsItem(metadata);assert.equal(metadata.verification.basis,'metadata');
      assert.equal((await service().ingest([metadata])).ingested,1);
      const after=(await pool.query('select * from news_archive where url=$1',[url])).rows[0];
      assert.deepEqual(after.matched_symbols,['PTT','OR']);assert.equal(after.verification_basis,'article');
      assert.equal(+after.verification_checked_at,time-3000);assert.ok(validStoredEvidence(after));
      const rejection=issueEvidence(first,{status:'REJECTED',reason:'ARTICLE_NOT_FOUND',basis:'article'},{checkedAt:time-2000});
      await service().ingest([],{assessments:[{item:first,verification:rejection}]});
      assert.equal((await service().ingest([metadata])).retained,1);
      assert.equal((await pool.query('select verification_status from news_archive where url=$1',[url])).rows[0].verification_status,'REJECTED');
    });
  }finally{
    if(writer)await writer.end();await pool.end();
    await admin.query('drop database '+database);await admin.end();
  }
});
