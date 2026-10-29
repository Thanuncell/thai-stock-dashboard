'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{Pool}=require('pg');
const {createNewsArchiveService}=require('../server/news-archive-service'),{article}=require('./fixtures/news-evidence.cjs');
const repo=path.join(__dirname,'..');
test('WS7 isolated PostgreSQL 17 and actual PostgREST archive query',{skip:!process.env.SETSCOPE_WS7_PG},async t=>{
 const config=JSON.parse(process.env.SETSCOPE_WS7_PG);assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'postgres');
 let admin=new Pool({...config,max:1});const database='setscope_ws7_'+randomUUID().replaceAll('-','');await admin.query('create database '+database);let pool=new Pool({...config,database,max:5,options:'-c statement_timeout=30000'}),http;
 try{
  assert.match((await pool.query('show server_version')).rows[0].server_version,/^17\./);
  for(const role of ['anon','authenticated','service_role'])if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+role+' nologin'+(role==='service_role'?' bypassrls':''));
  for(const file of ['supabase/news_archive.sql','supabase/news_archive_least_privilege.sql','supabase/migrations/20261027112037_news_archive_evidence.sql'])await pool.query(await fs.readFile(path.join(repo,file),'utf8'));
  const protection=(await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='news_archive'::regclass")).rows;
  await pool.query(await fs.readFile(path.join(repo,'supabase/migrations/20261029131808_news_archive_query.sql'),'utf8'));
  http=await require('./fixtures/news-archive-query-http.cjs')(pool,{...config,database});
  const stats={requests:0,bytes:0,paths:[]},transport=async(input,init={})=>{const u=new URL(input);assert.equal(u.origin,'https://ws7.invalid');const r=await fetch(http.base+u.pathname.slice('/rest/v1'.length)+u.search,init),body=await r.text();stats.requests++;stats.bytes+=Buffer.byteLength(body);stats.paths.push(u.pathname);return new Response(body,{status:r.status,headers:r.headers});};
  const env={SUPABASE_URL:'https://ws7.invalid',SUPABASE_SECRET_KEY:http.token,SETSCOPE_NEWS_EVIDENCE:'read',SETSCOPE_NEWS_WORK_QUEUE:'off',SETSCOPE_NEWS_ARCHIVE_QUERY:'on'};
  const service=(extra={},options={})=>createNewsArchiveService({env:{...env,...extra},fetchImpl:transport,...options});
  const seed=async(n,start=0)=>pool.query(`insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at,matched_symbols,broker_firms,analysis_mode,analysis_summary)
   select encode(sha256(convert_to('seed-'||i,'UTF8')),'hex'),'PTT ข่าวการลงทุนและผลประกอบการ '||i,'https://news.google.com/rss/articles/ws7-'||i,
   case when i%4=3 then 'infoquest' else 'other' end,(array['กรุงเทพธุรกิจ','ฐานเศรษฐกิจ','Investing.com','InfoQuest'])[i%4+1],
   'บริษัทเปิดเผยข้อมูลการลงทุนและผลประกอบการจากต้นทาง ข่าวจริงเกี่ยวกับกรรมการ ผู้ถือหุ้น และการสมัครงาน',now()-i*interval '1 second',now(),
   case when i%5=0 then array['ADVANC'] else array['PTT'] end,case when i%7=0 then array['KS'] else '{}'::text[] end,
   case when i%11=0 then 'ai' else null end,case when i%11=0 then 'Stored AI '||i else null end from generate_series($2::integer+1,$1::integer) i`,[n,start]);
  await seed(125);
  assert.equal((await pool.query('select source_revision::int n from news_archive_query_state')).rows[0].n,1);
  await t.test('migration transaction rehearsal preserves populated Archive and can roll back every derived object',async()=>{
   const dbName='ws7_rehearsal_'+randomUUID().replaceAll('-','');await admin.query('create database '+dbName);const db=new Pool({...config,database:dbName,max:1});
   try{
    await db.query(await fs.readFile(path.join(repo,'supabase/news_archive.sql'),'utf8'));
    await db.query("insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at) values('preserved','PTT preserved article','https://news.google.com/rss/articles/preserved','infoquest','InfoQuest','Sufficient synthetic source evidence',now(),now())");
    const before=(await db.query('select to_jsonb(a) row from news_archive a')).rows;
    await db.query('begin');const migration=(await fs.readFile(path.join(repo,'supabase/migrations/20261029131808_news_archive_query.sql'),'utf8')).replace(/^begin;$/m,'').replace(/^commit;$/m,'');await db.query(migration);
    assert.deepEqual((await db.query('select to_jsonb(a) row from news_archive a')).rows,before);assert.equal((await db.query('select count(*)::int n from news_archive_query_dirty')).rows[0].n,1);
    await db.query('rollback');assert.equal((await db.query("select to_regclass('news_archive_query_groups') x")).rows[0].x,null);assert.deepEqual((await db.query('select to_jsonb(a) row from news_archive a')).rows,before);
   }finally{await db.end();await admin.query('drop database '+dbName+' with(force)');}
  });
  await t.test('default OFF performs no query-index RPC; incomplete projection refuses exact counts',async()=>{
   const old=service({SETSCOPE_NEWS_ARCHIVE_QUERY:'off'});const before=stats.paths.length;assert.equal((await old.list()).total,125);assert.ok(stats.paths.slice(before).every(x=>!x.includes('_query')));
   await assert.rejects(service().list(),/HTTP 400/);
  });
  await t.test('bounded bootstrap and actual named RPC payload/response',async()=>{const r=await service().refreshQueryIndex({maxBatches:10,batchSize:50});assert.equal(r.pending,0);assert.equal((await service().list()).total,125);});
  await t.test('query matches legacy order/count/search/OR/broker/symbol/featured and overflow contract',async()=>{
   const old=service({SETSCOPE_NEWS_ARCHIVE_QUERY:'off'}),indexed=service();
   for(const args of [{},{page:2},{page:3},{page:999},{source:'bangkokbiznews,thansettakij'},{source:'investing,broker',query:'การลงทุน'},{symbol:'PTT'},{symbol:'ADVANC'},{query:'Stored AI'},{query:'%_'},{featuredCount:5},{source:'other',featuredCount:5,page:2}]){
    const a=await old.list(args),b=await indexed.list(args);assert.equal(b.total,a.total,JSON.stringify(args));assert.equal(b.matchingTotal,a.matchingTotal);assert.deepEqual(b.items,a.items);assert.deepEqual(b.featured,a.featured);assert.equal(b.page,a.page);
   }
   assert.equal((await indexed.list({page:999})).items.length,0);
  });
  await t.test('read RPCs cannot be called by anonymous or either authenticated account',async()=>{
   for(const role of ['anon','authenticated']){
    for(const endpoint of ['/news_archive_query_groups?select=group_key','/news_archive_query_rows?select=fingerprint'])assert.ok([401,403].includes((await fetch(http.base+endpoint,{headers:{Authorization:'Bearer '+http.jwt(role)}})).status));
    const r=await fetch(http.base+'/rpc/list_news_archive_query',{method:'POST',headers:{Authorization:'Bearer '+http.jwt(role),'content-type':'application/json'},body:JSON.stringify({p_policy:'news-query-1:read:metadata'})});assert.ok([401,403,404].includes(r.status));
   }
   assert.deepEqual((await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='news_archive'::regclass")).rows,protection);
  });
  await t.test('cached SET association overlays use exact subject identity for SQL symbol and search counts',async()=>{
   const url='https://news.google.com/rss/articles/ws7-set-symbol',title='แจ้งการเลิกกิจการของบริษัทย่อย - SET',date=new Date(Date.now()-60000).toISOString();
   await pool.query('insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at,matched_symbols) values($1,$2,$3,$4,$5,$6,$7,now(),$8)',['set-overlay',title,url,'settrade','SET','บริษัทเปิดเผยข้อมูลการดำเนินงานของบริษัทย่อยและผลประกอบการ',date,['OR']]);await service().refreshQueryIndex();
   let overlays=[{url,title,published_at:date,source:'settrade',source_name:'SET',symbols:['PTTEP']}];const indexed=service({}, {displayOverlays:()=>overlays});
   assert.equal((await indexed.list({symbol:'PTTEP'})).total,1);assert.equal((await indexed.list({query:'pttep'})).total,1);assert.equal((await indexed.list({symbol:'OR'})).total,0);
   overlays=[{...overlays[0],title:'wrong subject'}];assert.equal((await indexed.list({symbol:'PTTEP'})).total,0);
   overlays=[];assert.equal((await indexed.list({symbol:'PTTEP'})).total,0);
   await pool.query("delete from news_archive where fingerprint='set-overlay'");await service().refreshQueryIndex();
  });
  await t.test('all derived relations enforce RLS and functions remain invoker with narrow service grants',async()=>{
   const relations=(await pool.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any($1::text[])",[['news_archive_query_state','news_archive_query_dirty','news_archive_query_groups','news_archive_query_rows']])).rows;assert.equal(relations.length,4);assert.ok(relations.every(x=>x.relrowsecurity&&x.relforcerowsecurity));
   const functions=(await pool.query("select proname,prosecdef from pg_proc where proname like 'news_archive_query_%' or proname='list_news_archive_query'")).rows;assert.equal(functions.length,7);assert.ok(functions.every(x=>!x.prosecdef));
   for(const role of ['anon','authenticated'])for(const table of relations)assert.equal((await pool.query("select has_table_privilege($1,$2,'SELECT') allowed",[role,table.relname])).rows[0].allowed,false);
   assert.equal((await pool.query("select has_table_privilege('service_role','news_archive_query_groups','UPDATE') allowed")).rows[0].allowed,false);
  });
  await t.test('updates invalidate the projection, recovery preserves AI, First Seen and raw fingerprints',async()=>{
   const before=(await pool.query('select * from news_archive order by id limit 1')).rows[0];await pool.query('update news_archive set matched_symbols=$1 where id=$2',[['PTT','OR'],before.id]);
   await assert.rejects(service().list(),/HTTP 400/);assert.equal((await service().refreshQueryIndex()).pending,0);
   assert.equal((await service().list({symbol:'OR'})).total,1);const after=(await pool.query('select * from news_archive where id=$1',[before.id])).rows[0];assert.equal(after.fingerprint,before.fingerprint);assert.equal(+after.first_seen_at,+before.first_seen_at);assert.equal(after.analysis_summary,before.analysis_summary);
  });
  await t.test('concurrent maintenance has revision conflicts without partial index commits',async()=>{
   await pool.query("update news_archive set snippet=snippet||' updated' where id in(select id from news_archive order by id limit 3)");
   await Promise.all([service().refreshQueryIndex({maxBatches:6}),service().refreshQueryIndex({maxBatches:6})]);assert.equal((await service().refreshQueryIndex({maxBatches:6})).pending,0);assert.equal((await service().list()).total,125);
  });
  await t.test('legacy quality negatives, positive keyword headlines and true documents match the existing classifier',async()=>{
   const row=(await pool.query('select * from news_archive order by id limit 1')).rows[0],cases=[
    ['careers','SET Recruiting','https://www.set.or.th/th/about/careers','settrade','SET'],
    ['leadership','PTT - กรรมการบริษัท - SETTRADE','https://www.settrade.com/th/equities/quote/ptt/company-profile/board-of-directors','settrade','SETTRADE'],
    ['slug','business-news-in-a-slug','https://thunhoon.com/business-news-in-a-slug','thunhoon','Thunhoon'],
    ['document','notice.pdf - SET','https://www.set.or.th/notice.pdf','settrade','SET'],
    ['realpdf','PTT อธิบายระบบ PDF สำหรับผู้ถือหุ้น','https://www.kaohoon.com/news/pdf-investment','kaohoon','ข่าวหุ้น'],
    ['positive','PTT แต่งตั้งกรรมการและเปิดรับสมัครงาน','https://www.kaohoon.com/news/actual-investment','kaohoon','ข่าวหุ้น']
   ];
   for(const [id,title,url,source,name]of cases)await pool.query('insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at) values($1,$2,$3,$4,$5,$6,now(),now())',['fixture-'+id,title,url,source,name,id==='slug'?'':row.snippet]);
   await service().refreshQueryIndex({maxBatches:5});const a=await service({SETSCOPE_NEWS_ARCHIVE_QUERY:'off'}).list({pageSize:50}),b=await service().list({pageSize:50});
   assert.equal(a.total,b.total);for(const key of ['qualityFiltered','rejected','quarantined','deduplicated'])assert.equal(b[key],a[key],key);assert.deepEqual(a.items,b.items);assert.ok(b.items.some(x=>x.title.includes('ระบบ PDF')));assert.ok(!b.items.some(x=>x.title==='SET Recruiting'));
   await pool.query("delete from news_archive where fingerprint like 'fixture-%'");await service().refreshQueryIndex({maxBatches:5});
  });
  await t.test('stored Article proof, canonical duplicate winner, AI and First Seen survive index/read/restart',async()=>{
   const beforeCount=(await pool.query('select count(*)::int n from news_archive')).rows[0].n,pubDate=new Date(Date.now()-60000).toISOString();
   const writer=service({SETSCOPE_NEWS_EVIDENCE:'write'}),a=article({url:'https://thunhoon.com/article-ws7-proof?fbclid=a',title:'PTT บริษัทเติบโตจากธุรกิจหลัก',pubDate,matchedSymbols:['PTT']}),b=article({url:'https://thunhoon.com/article-ws7-proof?gclid=b',title:a.title,pubDate,matchedSymbols:['OR']});
   assert.equal((await writer.ingest([a,b])).ingested,2);await pool.query("update news_archive set analysis_mode='ai',analysis_summary='Stored AI canonical',first_seen_at=first_seen_at where url like '%fbclid=a'");await writer.refreshQueryIndex({maxBatches:5});
   const rawBefore=(await pool.query("select to_jsonb(a) data from news_archive a where url like '%article-ws7-proof%' order by id")).rows;
   const listed=await service().list({query:'ธุรกิจหลัก'});assert.equal(listed.total,1);assert.equal(listed.items[0].verification.basis,'article');assert.equal(listed.items[0].articleVerified,true);assert.equal(listed.items[0].analysisSummary,'Stored AI canonical');assert.deepEqual(new Set(listed.items[0].matchedSymbols),new Set(['PTT','OR']));
   const restarted=service();assert.deepEqual((await restarted.list({query:'ธุรกิจหลัก'})).items,listed.items);assert.deepEqual((await pool.query("select to_jsonb(a) data from news_archive a where url like '%article-ws7-proof%' order by id")).rows,rawBefore);
   const gated=service({SETSCOPE_P1_DISPLAY_GATE:'on'});await assert.rejects(gated.list(),/HTTP 400/);await gated.refreshQueryIndex({maxBatches:10,batchSize:500,reset:true});assert.equal((await gated.list()).total,1);
   await pool.query("delete from news_archive where url like '%article-ws7-proof%'");await service().refreshQueryIndex({maxBatches:10,batchSize:500,reset:true});assert.equal((await service().list()).total,beforeCount);
  });
  await t.test('failed/lost projection acknowledgement is recoverable without rewriting Archive',async()=>{
   await pool.query('update news_archive set snippet=snippet where id=(select min(id) from news_archive)');let lost=true;
   const flaky=createNewsArchiveService({env,fetchImpl:async(...args)=>{const response=await transport(...args);if(String(args[0]).endsWith('/news_archive_query_commit')&&lost){lost=false;await response.text();throw Error('SYNTHETIC_LOST_ACK');}return response;}});
   await assert.rejects(flaky.refreshQueryIndex(),/SYNTHETIC_LOST_ACK/);assert.equal((await service().refreshQueryIndex()).pending,0);assert.equal((await service().list()).total,125);
   const broken=createNewsArchiveService({env,fetchImpl:async()=>{throw Error('SYNTHETIC_DB_FAILURE');}});await assert.rejects(broken.list(),/SYNTHETIC_DB_FAILURE/);assert.equal((await service().list()).total,125);
  });
  await t.test('sub-millisecond publication ordering matches the original stable database order',async()=>{
   for(const [i,fraction]of ['999','001'].entries())await pool.query("insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at) values($1,$2,$3,'infoquest','InfoQuest','Sufficient synthetic article metadata content',$4,now())",['micro-'+i,'PTT micro precision '+i,'https://news.google.com/rss/articles/micro-'+i,new Date(Date.now()-60000).toISOString().slice(0,-1)+fraction+'Z']);
   await service().refreshQueryIndex();const a=await service({SETSCOPE_NEWS_ARCHIVE_QUERY:'off'}).list({query:'micro precision'}),b=await service().list({query:'micro precision'});assert.deepEqual(b.items,a.items);
   await pool.query("delete from news_archive where fingerprint like 'micro-%'");await service().refreshQueryIndex();
  });
  await t.test('actual database and PostgREST restart preserve Archive and durable projection',async()=>{
   const digest=async()=>(await pool.query("select md5(string_agg(to_jsonb(a)::text,'' order by id)) raw,(select count(*)::int from news_archive_query_groups) groups from news_archive a")).rows[0];const before=await digest();
   await http.stop();http=null;await pool.end();await admin.end();
   const {spawn}=require('node:child_process');await new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SETSCOPE_TEST_PG_BIN,'pg_ctl.exe'),['-D',process.env.SETSCOPE_WS3_PG_DATA,'-m','fast','-w','restart'],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Isolated database restart failed')));});
   admin=new Pool({...config,max:1});pool=new Pool({...config,database,max:5,options:'-c statement_timeout=30000'});http=await require('./fixtures/news-archive-query-http.cjs')(pool,{...config,database});env.SUPABASE_SECRET_KEY=http.token;
   assert.deepEqual(await digest(),before);assert.equal((await service().list()).total,125);
  });
  await t.test(['browser-only','query-40k'].includes(process.env.SETSCOPE_WS7_SCALE)?'optimized scale measurements and browser fixture':'40k/50k scale measurements',{skip:!['on','browser-only','query-40k'].includes(process.env.SETSCOPE_WS7_SCALE)},async()=>{
   if(['browser-only','query-40k'].includes(process.env.SETSCOPE_WS7_SCALE)){const size=process.env.SETSCOPE_WS7_SCALE==='query-40k'?40000:50000;await pool.query('delete from news_archive');await seed(size);assert.equal((await service().refreshQueryIndex({reset:true,maxBatches:150,batchSize:500})).pending,0);assert.equal((await service().list({page:size/10,featuredCount:5})).total,size-5);const {execFile}=require('node:child_process'),{promisify}=require('node:util');const measured=await promisify(execFile)(process.execPath,['--expose-gc',path.join(__dirname,'fixtures/news-archive-benchmark.cjs')],{cwd:repo,env:{...process.env,SETSCOPE_WS7_HTTP_BASE:http.base,SETSCOPE_WS7_HTTP_TOKEN:http.token,SETSCOPE_WS7_BENCH_MODE:'database',SETSCOPE_WS7_BENCH_SIZE:String(size)}});const m=JSON.parse(measured.stdout);assert.ok(m.requestCounts.every(x=>x===1));console.log('WS7_FINAL_METRIC '+JSON.stringify(m));if(process.env.SETSCOPE_WS7_METRICS)await fs.writeFile(process.env.SETSCOPE_WS7_METRICS,JSON.stringify(m,null,2));return;}
   const {execFile}=require('node:child_process'),{promisify}=require('node:util'),run=promisify(execFile),metrics=[];
   await pool.query('delete from news_archive');
   for(const size of [40000,50000]){
    await seed(size,size===50000?40000:0);const start=performance.now();assert.equal((await service().refreshQueryIndex({maxBatches:150,batchSize:500,reset:size===40000})).pending,0);
    const bootstrapMs=Number((performance.now()-start).toFixed(2));await pool.query('analyze news_archive_query_groups;analyze news_archive_query_rows');
    const beforeRows=(await pool.query('select count(*)::int n,count(distinct fingerprint)::int fingerprints from news_archive')).rows[0];assert.equal(beforeRows.n,size);assert.equal(beforeRows.fingerprints,size);
    for(const mode of ['bounded-baseline','fullscan-reference','database']){
     let child;try{child=await run(process.execPath,['--expose-gc',path.join(__dirname,'fixtures/news-archive-benchmark.cjs')],{cwd:repo,env:{...process.env,SETSCOPE_WS7_HTTP_BASE:http.base,SETSCOPE_WS7_HTTP_TOKEN:http.token,SETSCOPE_WS7_BENCH_MODE:mode,SETSCOPE_WS7_BENCH_SIZE:String(size)},maxBuffer:2000000});}catch(error){if(mode!=='fullscan-reference')throw error;const failed={size,mode,status:'MEASUREMENT_FAILED',error:String(error.stderr||error.message).trim().slice(-300)};metrics.push(failed);console.log('WS7_METRIC '+JSON.stringify(failed));continue;}
     const measurement=JSON.parse(child.stdout);metrics.push({...measurement,bootstrapMs});console.log('WS7_METRIC '+JSON.stringify(measurement));
     if(mode==='database'){assert.ok(measurement.requestCounts.every(n=>n===1));assert.ok(measurement.responseBytes.every(n=>n<200000));assert.ok(measurement.outcomes.every(x=>!x.error));}
     if(mode==='bounded-baseline')assert.ok(measurement.outcomes.every(x=>x.error==='BOUNDED_SCAN_LIMIT'));
    }
    const reference=metrics.find(x=>x.size===size&&x.mode==='fullscan-reference'),after=metrics.find(x=>x.size===size&&x.mode==='database');if(reference.outcomes){assert.deepEqual(after.outcomes,reference.outcomes);assert.ok(after.p95Ms<reference.p95Ms);}else assert.equal(after.outcomes[0].total,size-5);
    const plans={};for(const [name,sql]of Object.entries({first:'select group_key from news_archive_query_groups order by order_published_at desc,order_id desc limit 10',deep:'select group_key from news_archive_query_groups order by order_published_at desc,order_id desc limit 10 offset '+(size-10),publisher:"select group_key from news_archive_query_groups where publisher='bangkokbiznews' order by order_published_at desc,order_id desc limit 10",broker:'select group_key from news_archive_query_groups where broker order by order_published_at desc,order_id desc limit 10'})){
     const plan=(await pool.query('explain(analyze,buffers,format json) '+sql)).rows[0]['QUERY PLAN'][0];const nodes=[];const walk=p=>{nodes.push({type:p['Node Type'],index:p['Index Name']||null,rows:p['Actual Rows']});(p.Plans||[]).forEach(walk);};walk(plan.Plan);plans[name]={executionMs:plan['Execution Time'],nodes};
    }const storage=(await pool.query("select pg_total_relation_size('news_archive')::float8 raw_bytes,(select sum(pg_total_relation_size(oid))::float8 from pg_class where relname in('news_archive_query_groups','news_archive_query_rows','news_archive_query_dirty','news_archive_query_state')) index_bytes")).rows[0];metrics.push({size,plans,storage});console.log('WS7_PLANS '+JSON.stringify({size,plans}));
   }
   if(process.env.SETSCOPE_WS7_METRICS)await fs.writeFile(process.env.SETSCOPE_WS7_METRICS,JSON.stringify(metrics,null,2));
  });
  await t.test('frozen frontend uses real Node API, PostgREST and PostgreSQL',{skip:process.env.SETSCOPE_WS7_BROWSER!=='on'},async()=>{await require('./news-archive-query.browser.cjs')({http,pool});});
  await t.test('rollback removes only derived objects and preserves all original archive data',async()=>{
   const before=(await pool.query("select count(*)::int n,md5(string_agg(to_jsonb(a)::text,'' order by id)) digest from news_archive a")).rows[0];await pool.query(await fs.readFile(path.join(repo,'supabase/news_archive_query_rollback.sql'),'utf8'));
   assert.deepEqual((await pool.query("select count(*)::int n,md5(string_agg(to_jsonb(a)::text,'' order by id)) digest from news_archive a")).rows[0],before);if(['on','browser-only','query-40k'].includes(process.env.SETSCOPE_WS7_SCALE))await assert.rejects(service({SETSCOPE_NEWS_ARCHIVE_QUERY:'off'}).list(),/bounded scan limit/);else assert.equal((await service({SETSCOPE_NEWS_ARCHIVE_QUERY:'off'}).list()).total,125);
  });
 }finally{await http?.stop();await pool.end();await admin.query('drop database '+database+' with(force)');await admin.end();}
});
