'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto'),{Pool}=require('pg');
const {createNewsArchiveService,reviewArchivedNewsRow}=require('../server/news-archive-service');
const repo=path.join(__dirname,'..'),policy='news-query-2:read:metadata';
const cursorSqlFile='supabase/migrations/20261123155803_news_archive_cursor.sql';
const cursorRollbackFile='supabase/news_archive_cursor_rollback.sql';
const rank=value=>BigInt(Date.parse(value))*1000n+BigInt((String(value).match(/\.(\d+)/)?.[1]||'').padEnd(6,'0').slice(3,6)||0);
const order=(a,b)=>rank(a.order_published_at)===rank(b.order_published_at)?(BigInt(a.order_id)>BigInt(b.order_id)?-1:1):(rank(a.order_published_at)>rank(b.order_published_at)?-1:1);

test('G2-B native PostgreSQL/PostgREST keyset, window, E02 and parity',{skip:!process.env.SETSCOPE_G2B_NATIVE},async t=>{
 const config=JSON.parse(process.env.SETSCOPE_G2B_NATIVE);assert.equal(config.host,'127.0.0.1');
 const admin=new Pool({...config,max:2}),evidence=[],now=Date.now();
 const version=(await admin.query('show server_version')).rows[0].server_version;assert.match(version,/^17\./);
 try{
  for(const role of ['anon','authenticated','service_role'])if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+role+' nologin'+(role==='service_role'?' bypassrls':''));
  await t.test('additive SQL transaction can roll back on a populated fixture without data/RLS loss',async()=>{
   const database='g2b_rehearsal_'+randomUUID().replaceAll('-','');await admin.query('create database '+database);const pool=new Pool({...config,database,max:1});
   try{
    for(const file of ['supabase/news_archive.sql','supabase/news_archive_least_privilege.sql','supabase/migrations/20261027112037_news_archive_evidence.sql','supabase/migrations/20261029131808_news_archive_query.sql'])await pool.query(await fs.readFile(path.join(repo,file),'utf8'));
    await pool.query("insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at) values('rehearsal','PTT retained fixture story','https://news.google.com/rss/articles/g2b-rehearsal','infoquest','InfoQuest','บริษัทเผยข้อมูลผลประกอบการตามต้นทาง',now(),now())");
    const before=(await pool.query("select to_jsonb(a) row from news_archive a")).rows,acl=(await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='news_archive'::regclass")).rows;
    await pool.query('begin');await pool.query((await fs.readFile(path.join(repo,cursorSqlFile),'utf8')).replace(/^begin;$/m,'').replace(/^commit;$/m,''));
    assert.deepEqual((await pool.query('select to_jsonb(a) row from news_archive a')).rows,before);await pool.query('rollback');
    assert.equal((await pool.query("select to_regprocedure('public.news_archive_cursor_candidates(text[],text,text,text[],timestamptz,jsonb)') fn")).rows[0].fn,null);
    assert.deepEqual((await pool.query('select to_jsonb(a) row from news_archive a')).rows,before);
    assert.deepEqual((await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='news_archive'::regclass")).rows,acl);
    evidence.push({rollbackRehearsal:'PASS',sourceRowsUnchanged:true,rlsGrantsUnchanged:true});
   }finally{await pool.end();}
  });
  for(const size of process.env.SETSCOPE_G2B_SMOKE==='1'?[125]:[4000,40000,50000])await t.test('native archive '+size,async t=>{
   const database='g2b_'+randomUUID().replaceAll('-','');await admin.query('create database '+database);
   const pool=new Pool({...config,database,max:4}),calls=[];let http;
   try{
    for(const file of ['supabase/news_archive.sql','supabase/news_archive_least_privilege.sql','supabase/migrations/20261027112037_news_archive_evidence.sql',
     'supabase/migrations/20261029131808_news_archive_query.sql','supabase/migrations/20261029154157_news_archive_query_safeupdate.sql','supabase/migrations/20261103035737_news_archive_query_quality_policy.sql'])await pool.query(await fs.readFile(path.join(repo,file),'utf8'));
    const protectedBefore=(await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='news_archive'::regclass")).rows;
    await pool.query(await fs.readFile(path.join(repo,cursorSqlFile),'utf8'));
    assert.deepEqual((await pool.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='news_archive'::regclass")).rows,protectedBefore);
    const removed=Math.min(420,Math.floor(size/5)),raw=[];
    for(let i=0;i<size;i++)raw.push({fingerprint:createHash('sha256').update('native-'+i).digest('hex'),title:'PTT ข่าวการลงทุนและผลประกอบการ '+(i===size-500?'DEEP_NATIVE ':'')+i+(i>=size-removed?' - Investing.com':''),
     url:'https://news.google.com/rss/articles/g2b-native-'+i,source:i%3===0?'infoquest':'other',source_name:i>=size-removed?'Investing.com':['InfoQuest','กรุงเทพธุรกิจ','ฐานเศรษฐกิจ'][i%3],
     snippet:'บริษัทเปิดเผยข้อมูลการลงทุนและผลประกอบการตามข่าวต้นทางอย่างเป็นทางการ',published_at:new Date(now-(i<20?60000:8*86400000)-i*1000).toISOString(),fetched_at:new Date(now).toISOString(),
     matched_symbols:i%5===0?['ADVANC']:['PTT'],broker_firms:i%7===0?['KS']:[],analysis_summary:i%11===0?'StoredNative '+i:null,analysis_mode:i%11===0?'rules':null});
    // One canonical duplicate, one rejected document and a microsecond/bigint tie.
    raw[21]={...raw[20],fingerprint:raw[21].fingerprint,url:raw[20].url+'?utm_source=duplicate'};
    raw[22]={...raw[22],url:'https://www.set.or.th/fixture-document.pdf',title:'fixture-document.pdf'};
    for(let i=size-removed;i<size;i++){
     if(i%4===1)raw[i].source_name='Other Publisher';
     if(i%4===2){raw[i].source_name='Other Publisher';raw[i].title=raw[i].title.replace(' - Investing.com','');raw[i].url='https://th.investing.com/news/stock-market-news/native-'+i;}
     if(i%4===3){raw[i].source_name='อินเวสติ้ง';raw[i].title=raw[i].title.replace(' - Investing.com','');}
    }
    const tieStamp=new Date(now-2*86400000).toISOString().replace(/\.\d{3}Z$/,'');
    raw.forEach((value,i)=>{const tie=i>=24&&i<=27;value.id=String(BigInt(i+1)+(tie?9007199254740992n:0n));if(tie)value.published_at=tieStamp+(i<26?'.123001Z':'.123002Z');});
    const columns=['id','fingerprint','title','url','source','source_name','snippet','published_at','fetched_at','matched_symbols','broker_firms','analysis_summary','analysis_mode'];
    for(let start=0;start<raw.length;start+=1000)await pool.query(`insert into news_archive(${columns.join(',')}) overriding system value select ${columns.join(',')} from jsonb_populate_recordset(null::news_archive,$1)`,[JSON.stringify(raw.slice(start,start+1000))]);
    const stored=(await pool.query("select to_jsonb(a)||jsonb_build_object('id',id::text) row from news_archive a order by published_at desc,id desc")).rows.map(x=>x.row);
    const seedService=createNewsArchiveService({env:{SUPABASE_URL:'https://g2b.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_EVIDENCE:'read'},now:()=>now,fetchImpl:async()=>{throw Error('No network during fixture projection');}});
    const prepared=seedService.projectQueryRows(stored),projections=prepared.projections,membership=new Map();
    prepared.groups.forEach((group,i)=>group.contributors.forEach(item=>membership.set(item.fingerprint,projections[i].group_key)));
    const removedRows=stored.filter(x=>require('../lib/news-content').isRemovedNewsPublisher({title:x.title,url:x.url,sourceName:x.source_name}));
    assert.equal(removedRows.length,removed);const removedKeys=new Set(removedRows.map(x=>x.fingerprint));
    const legacy=require('./fixtures/news-query-quality.cjs').legacyGroups(removedRows,policy);
    for(const group of legacy){
     // Historical positive fixture predates current URL removal policy.
     group.projection.url_identity ||= removedRows.find(x=>group.fingerprints.includes(x.fingerprint)).url;
     projections.push(group.projection);for(const fp of group.fingerprints)membership.set(fp,group.projection.group_key);
    }
    for(let start=0;start<projections.length;start+=1000)await pool.query('insert into news_archive_query_groups select * from jsonb_populate_recordset(null::news_archive_query_groups,$1)',[JSON.stringify(projections.slice(start,start+1000))]);
    const members=stored.map(row=>({fingerprint:row.fingerprint,group_key:membership.get(row.fingerprint)||null,row_digest:'fixture-only',quality_status:removedKeys.has(row.fingerprint)?'VERIFIED':reviewArchivedNewsRow(row).status}));
    for(let start=0;start<members.length;start+=1000)await pool.query('insert into news_archive_query_rows select * from jsonb_populate_recordset(null::news_archive_query_rows,$1)',[JSON.stringify(members.slice(start,start+1000))]);
    await pool.query('delete from news_archive_query_dirty where fingerprint in(select fingerprint from news_archive)');
    await pool.query('update news_archive_query_state set policy=$1,index_revision=1 where singleton=true',[policy]);
    await pool.query('analyze news_archive_query_groups;analyze news_archive_query_rows;analyze news_archive');
    console.log('G2B_FIXTURE_READY '+JSON.stringify({size,removed,groups:projections.length,resetOrRebuildCalls:0}));
    http=await require('./fixtures/news-archive-query-http.cjs')(pool,{...config,database});
    const transport=async(input,init={})=>{
     const u=new URL(input);assert.equal(u.origin,'https://g2b.invalid');
     // The slow 50k snapshot oracle blocks this test process between requests.
     // Close fixture connections explicitly rather than reusing an idle socket
     // whose peer timeout cannot be consumed while that CPU work runs.
     const response=await fetch(http.base+u.pathname.slice('/rest/v1'.length)+u.search,{...init,headers:{...init.headers,connection:'close'}}),body=await response.text();let parsed;try{parsed=JSON.parse(body);}catch{}
     calls.push({path:u.pathname,status:response.status,bytes:Buffer.byteLength(body),hydratedRows:parsed?.groups?.reduce((n,g)=>n+g.rows.length,0)||0,groups:parsed?.groups?.length||0,positions:parsed?.window?.pages?.length||0,
      groupJsonBytes:Buffer.byteLength(JSON.stringify(parsed?.groups||[])),windowJsonBytes:Buffer.byteLength(JSON.stringify(parsed?.window||null))});
     return new Response(body,{status:response.status,headers:response.headers});
    };
    const env={SUPABASE_URL:'https://g2b.invalid',SUPABASE_SECRET_KEY:http.token,SETSCOPE_NEWS_EVIDENCE:'read',SETSCOPE_NEWS_ARCHIVE_QUERY:'on'};
    const service=createNewsArchiveService({env,fetchImpl:transport,now:()=>now});
    const oracle=createNewsArchiveService({env:{...env,SETSCOPE_NEWS_ARCHIVE_QUERY:'off'},fetchImpl:transport,now:()=>now,maxScanRows:60000,scanChunkSize:1000});
    await t.test('native prepared 1 -> 5 -> 2 -> 4 -> 7 parity, cache, no article prefetch',async()=>{
     // Build the slow snapshot oracle before timing the warm cursor workflow;
     // reference work must not artificially expire the real 30-second client cache.
     const expectedPages=new Map();for(const page of [1,5,2,4,7])expectedPages.set(page,await oracle.list({page,featuredCount:5}));
     const {createArchiveCursorSession,cursorScope}=await import('../client/news-archive-cursor.mjs');const s=createArchiveCursorSession({scope:cursorScope({featuredCount:5})});
     const metrics=[],loaded=new Set();let cacheHits=0;
     for(const page of [1,5,2,4,7,1,5,2,4,7]){
      assert.equal(s.open(page),true);const req=s.begin(),at=calls.length;
      if(req.cached){cacheHits++;continue;}
      const data=await service.list({pagination:'cursor',featuredCount:5,cursor:req.cursor,context:req.context,revision:req.revision,
       windowStart:req.lookahead?.startPage,windowPages:req.lookahead?.pageCount||0,windowAfter:req.lookahead?.cursor});
      const nativeCalls=calls.slice(at);assert.equal(nativeCalls.length,1);assert.equal(nativeCalls[0].path,'/rest/v1/rpc/list_news_archive_cursor');assert.ok(nativeCalls[0].groups<=15);
      assert.equal(data.items.length,10);assert.equal('total' in data,false);assert.equal(s.accept(req,data),true);
      if(data.window){assert.doesNotMatch(JSON.stringify(data.window),/title|snippet|articleBody/);assert.ok(data.window.pages.length<=5);}
      const expected=expectedPages.get(page);assert.deepEqual(data.items.map(x=>x.url),expected.items.map(x=>x.url));
      for(const item of data.items){assert.equal(loaded.has(item.url),false);loaded.add(item.url);}
      assert.ok(data.items.every(x=>x.sourceName!=='Investing.com'));metrics.push({page,...nativeCalls[0]});
     }
     s.open(1);assert.equal(s.begin().cached,true);s.open(5);assert.equal(s.begin().cached,true);
     assert.equal(cacheHits,5);assert.equal(metrics.length,5);
     const sequential=[],cache=new Map(),positions=new Map([[1,null]]);let seqContext=null,seqRevision=null,seqHits=0;
     const fetchPage=async page=>{
      const at=calls.length,data=await service.list({pagination:'cursor',featuredCount:5,cursor:positions.get(page),context:seqContext,revision:seqRevision});
      seqContext=data.context;seqRevision=data.revision;cache.set(page,data);if(data.hasNext)positions.set(page+1,data.nextCursor);
      assert.equal(calls.length-at,1);sequential.push({page,...calls.at(-1)});
     };
     for(const target of [1,5,2,4,7,1,5,2,4,7]){
      if(cache.has(target)){seqHits++;continue;}
      while(!positions.has(target)){let page=1;while(cache.has(page))page++;await fetchPage(page);}
      await fetchPage(target);
     }
     const summary=list=>({requests:list.length,postgrestBytes:list.reduce((n,x)=>n+x.bytes,0),hydratedRows:list.reduce((n,x)=>n+x.hydratedRows,0),groupJsonBytes:list.reduce((n,x)=>n+x.groupJsonBytes,0),windowJsonBytes:list.reduce((n,x)=>n+x.windowJsonBytes,0),preparedPositions:list.reduce((n,x)=>n+x.positions,0)});
     assert.equal(sequential.length,7);evidence.push({size,removed,nativeWorkflow:metrics,sequentialWorkflow:sequential,cost:{window:{...summary(metrics),cacheHits},sequential:{...summary(sequential),cacheHits:seqHits}}});
     console.log('G2B_NATIVE_COST '+JSON.stringify({size,...evidence.at(-1).cost}));
    });
    await t.test('search/source/OR/symbol/broker/Featured parity before boundaries',async()=>{
     for(const args of [{source:'bangkokbiznews'},{source:'bangkokbiznews,thansettakij'},{symbol:'ADVANC'},{source:'broker'},{query:'StoredNative'},
      {query:'DEEP_NATIVE'},{query:'missing-literal-%_'},{featuredCount:5},{query:'การลงทุน',source:'infoquest',featuredCount:5}]){
      const data=await service.list({...args,pagination:'cursor',windowStart:1,windowPages:5}),expected=await oracle.list(args);
      assert.deepEqual(data.items.map(x=>x.url),expected.items.map(x=>x.url),JSON.stringify(args));assert.deepEqual(data.featured.map(x=>x.url),expected.featured.map(x=>x.url));
      assert.equal(data.window.pages.length,Math.min(5,Math.ceil(expected.total/10)));assert.equal(data.hasNext,expected.total>10);
     }
    });
    if(size===125)await t.test('legacy RPC precision remains compatible at bigint/microsecond ties',async()=>{
     const data=await service.list({page:2,featuredCount:5}),expected=await oracle.list({page:2,featuredCount:5});assert.deepEqual(data.items.map(x=>x.url),expected.items.map(x=>x.url));
    });
    await t.test('native symbol/search overlays preserve exact subject binding and invalidate context',async()=>{
     const target=stored.find(x=>x.fingerprint===raw[30].fingerprint);
     let overlays=[{url:target.url,title:target.title,published_at:new Date(target.published_at).toISOString(),source:target.source,source_name:target.source_name,symbols:['AOT']}];
     const indexed=createNewsArchiveService({env,fetchImpl:transport,now:()=>now,displayOverlays:()=>overlays});
     const found=await indexed.list({pagination:'cursor',symbol:'AOT',windowStart:1,windowPages:5});
     assert.deepEqual(found.items.map(x=>x.fingerprint),[target.fingerprint]);
     assert.deepEqual((await indexed.list({pagination:'cursor',query:'AOT'})).items.map(x=>x.fingerprint),[target.fingerprint]);
     const old=(await pool.query('select list_news_archive_query(p_policy=>$1,p_symbol=>$2,p_now=>$3,p_overlays=>$4) result',[policy,'AOT',new Date(now).toISOString(),JSON.stringify(overlays)])).rows[0].result;
     assert.equal(old.total,1);assert.equal(found.window.pages.length,1);assert.equal(found.hasNext,false);
     overlays=[{...overlays[0],title:'wrong subject'}];
     await assert.rejects(indexed.list({pagination:'cursor',symbol:'AOT',context:found.context}),/SCOPE_CHANGED/);
     assert.equal((await indexed.list({pagination:'cursor',symbol:'AOT'})).items.length,0);
     overlays=[];assert.equal((await indexed.list({pagination:'cursor',query:'AOT'})).items.length,0);
    });
    await t.test('initial content/window retain ordered index limits without full archive scans',async()=>{
     const plans=[];
     for(const limit of [11,51]){
      const plan=(await pool.query(`explain(analyze,buffers,format json) select group_key,order_published_at,order_id from public.news_archive_cursor_candidates(array['all'],'','','{}',$1,'[]') order by order_published_at desc,order_id desc limit ${limit}`,[new Date(now).toISOString()])).rows[0]['QUERY PLAN'];
      const nodes=[];const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(plan[0].Plan);
      assert.ok(nodes.some(n=>n['Index Name']==='news_archive_query_order_idx'));
      assert.equal(nodes.some(n=>n['Node Type']==='Seq Scan'&&n['Relation Name']==='news_archive'&&n['Actual Rows']>1),false);
      assert.equal(plan[0].Plan['Actual Rows'],limit);plans.push({limit,plan});
     }
     evidence.push({size,initialPlans:plans});
    });
    await t.test('deep native SQL keyset/end and existing order-index query plan',async()=>{
     const expected=prepared.projections.slice(0,prepared.groups.length).filter(x=>!x.blocked).sort(order);
     const anchor=expected.at(-21),boundary={publishedAt:anchor.order_published_at,id:String(anchor.order_id)};
     const args={p_policy:policy,p_now:new Date(now).toISOString(),p_after:boundary,p_window_after:boundary,p_window_start:100,p_window_pages:5};
     const response=await fetch(http.base+'/rpc/list_news_archive_cursor',{method:'POST',headers:{Authorization:'Bearer '+http.token,'content-type':'application/json'},body:JSON.stringify(args)});
     const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.pageKeys.length,10);assert.equal(data.hasNext,true);assert.equal(data.window.pages.length,2);assert.equal(data.window.hasMore,false);
     assert.deepEqual(data.pageKeys,expected.slice(-20,-10).map(x=>x.group_key));
     const plan=(await pool.query("explain(analyze,buffers,format json) select group_key,order_published_at,order_id from public.news_archive_cursor_candidates(array['all'],'','','{}',$1,'[]') where (order_published_at,order_id)<($2::timestamptz,$3::bigint) order by order_published_at desc,order_id desc limit 51",[new Date(now).toISOString(),boundary.publishedAt,boundary.id])).rows[0]['QUERY PLAN'];
     if(size>=4000)assert.match(JSON.stringify(plan),/news_archive_query_(order|publisher)_idx/);
     evidence.push({size,deepRows:data.pageKeys.length,deepPositions:data.window.pages.length,plan});
    });
    await t.test('signed boundary/ordinal/context validation and atomic revision consistency',async()=>{
     const first=await service.list({pagination:'cursor',windowStart:1,windowPages:5}),position=first.window.pages[4].cursor;
     // Change actual MAC bits. The last base64url character has unused padding
     // bits, so changing only that character can decode to the identical MAC.
     const tampered=position.split('.');tampered[2]=(tampered[2][0]==='A'?'B':'A')+tampered[2].slice(1);
     await assert.rejects(service.list({pagination:'cursor',context:first.context,cursor:tampered.join('.')}),/CURSOR_INVALID/);
     await assert.rejects(service.list({pagination:'cursor',context:first.context,cursor:position,query:'different'}),/SCOPE_CHANGED/);
     await assert.rejects(service.list({pagination:'cursor',context:first.context,windowAfter:position,windowStart:55,windowPages:1}),/CURSOR_INVALID/);
     const oldAt=(await pool.query('select source_revision::text from news_archive_query_state')).rows[0].source_revision;
     // A committed source change dirties the generation. No implicit index work.
     await pool.query("update news_archive set snippet=snippet||' ' where fingerprint=$1",[stored[30].fingerprint]);
     await assert.rejects(service.list({pagination:'cursor',context:first.context,cursor:position}),/INDEX_NOT_READY|INDEX_CHANGED/);
     await pool.query("update news_archive set snippet=left(snippet,char_length(snippet)-1) where fingerprint=$1",[stored[30].fingerprint]);
     await pool.query('delete from news_archive_query_dirty where fingerprint=$1',[stored[30].fingerprint]);
     assert.notEqual((await pool.query('select source_revision::text from news_archive_query_state')).rows[0].source_revision,oldAt);
     await assert.rejects(service.list({pagination:'cursor',context:first.context,cursor:position}),/INDEX_CHANGED/);
     const transaction=await pool.connect();await transaction.query('begin isolation level repeatable read');
     const before=(await transaction.query('select source_revision::text,index_revision::text from news_archive_query_state')).rows[0];
     await pool.query('update news_archive_query_state set index_revision=index_revision+1 where singleton=true');
     const stable=(await transaction.query('select list_news_archive_cursor(p_policy=>$1,p_source_revision=>$2,p_index_revision=>$3)',[policy,before.source_revision,before.index_revision])).rows[0];assert.ok(stable.list_news_archive_cursor);
     await transaction.query('commit');transaction.release();
     await assert.rejects(service.list({pagination:'cursor',context:first.context,cursor:position}),/INDEX_CHANGED/);
     await pool.query("insert into news_archive_query_dirty(fingerprint) values('synthetic-not-ready')");
     await assert.rejects(service.list({pagination:'cursor'}),/INDEX_NOT_READY/);
     await pool.query("delete from news_archive_query_dirty where fingerprint='synthetic-not-ready'");
    });
    await t.test('E02 cursor availability, read-only archive and RPC role isolation',async()=>{
     const before=(await pool.query("select md5(string_agg(to_jsonb(a)::text,'' order by id)) digest from news_archive a")).rows[0].digest,at=calls.length;
     const result=await service.list({pagination:'cursor',windowStart:1,windowPages:5});assert.equal(result.items.length,10);assert.equal(calls.length-at,1);
     assert.equal(calls.at(-1).path,'/rest/v1/rpc/list_news_archive_cursor');
     assert.equal((await pool.query("select md5(string_agg(to_jsonb(a)::text,'' order by id)) digest from news_archive a")).rows[0].digest,before);
     for(const role of ['anon','authenticated'])assert.ok([401,403,404].includes((await fetch(http.base+'/rpc/list_news_archive_cursor',{method:'POST',headers:{Authorization:'Bearer '+http.jwt(role),'content-type':'application/json'},body:JSON.stringify({p_policy:policy})})).status));
     console.log('G2B_E02 '+JSON.stringify({size,removed,cursorAvailability:'PASS',snapshotFallbackRequests:0,productionRequests:0}));
    });
    await t.test('migration reinstall and rollback preserve populated Archive, derived generation and legacy security',async()=>{
     const functions=(await pool.query("select proname,prosecdef,provolatile,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service_role from pg_proc where pronamespace='public'::regnamespace and proname in('list_news_archive_cursor','news_archive_cursor_candidates') order by proname")).rows;
     assert.equal(functions.length,2);
     for(const fn of functions){assert.equal(fn.prosecdef,false);assert.equal(fn.provolatile,'s');assert.equal(fn.anon,false);assert.equal(fn.authenticated,false);assert.equal(fn.service_role,true);}
     assert.match(functions[0].proconfig.join(','),/search_path=public, ?pg_temp/);
     assert.equal(functions[1].proconfig,null,'Fully qualified SQL helper must remain inlineable');
     const snapshot=async()=>{
      const result={};
      for(const [table,key] of [['news_archive','id'],['news_archive_query_groups','group_key'],['news_archive_query_rows','fingerprint'],['news_archive_query_dirty','fingerprint'],['news_archive_query_state','singleton']])result[table]=(await pool.query(`select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by ${key}),'')) digest from public.${table} t`)).rows[0].digest;
      result.security=(await pool.query("select relname,relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid=any(array['news_archive'::regclass,'news_archive_query_groups'::regclass,'news_archive_query_rows'::regclass,'news_archive_query_dirty'::regclass,'news_archive_query_state'::regclass]) order by relname")).rows;
      result.legacy=(await pool.query("select pg_get_functiondef('public.list_news_archive_query(text,integer,integer,text[],text,text,text[],integer,timestamptz,jsonb)'::regprocedure) definition")).rows[0].definition;
      return result;
     };
     const before=await snapshot(),install=await fs.readFile(path.join(repo,cursorSqlFile),'utf8'),rollback=await fs.readFile(path.join(repo,cursorRollbackFile),'utf8');
     const rpcSignature='public.list_news_archive_cursor(text,text[],text,text,text[],integer,timestamptz,jsonb,text,text,jsonb,jsonb,integer,integer,text[],boolean)';
     const waitForCursorRpc=async()=>{
      const start=performance.now(),deadline=start+5000;let attempts=0,metadataRetries=0;
      const remaining=()=>{const ms=Math.ceil(deadline-performance.now());assert.ok(ms>0,'G5C_CURSOR_RPC_READINESS_TIMEOUT');return ms;};
      while(true){
       const catalog=await pool.query({text:'select to_regprocedure($1) fn',values:[rpcSignature],query_timeout:remaining()});
       assert.ok(catalog.rows[0].fn,'G5C_CURSOR_RPC_MISSING');
       const response=await fetch(http.base+'/rpc/list_news_archive_cursor',{method:'POST',headers:{Authorization:'Bearer '+http.token,'content-type':'application/json'},
        body:JSON.stringify({p_policy:policy,p_window_start:1,p_window_pages:5}),signal:AbortSignal.timeout(remaining())});
       const body=await response.json();attempts++;
       if(response.status===200){assert.ok(Array.isArray(body.pageKeys));return{attempts,metadataRetries,elapsedMs:Math.round(performance.now()-start),deadlineMs:5000};}
       // Only an installed RPC missing from PostgREST metadata can be retried.
       // Other HTTP/SQL/network errors fail immediately; no response body is logged.
       assert.ok(response.status===404&&body.code==='PGRST202','G5C_CURSOR_RPC_UNEXPECTED_RESPONSE');
       metadataRetries++;await new Promise(resolve=>setTimeout(resolve,Math.min(25,remaining())));
      }
     };
     for(let cycle=1;cycle<=(size===4000?3:1);cycle++){
      await pool.query(install);assert.deepEqual(await snapshot(),before);
      await pool.query(rollback);assert.deepEqual(await snapshot(),before);
      for(const signature of [rpcSignature,'public.news_archive_cursor_candidates(text[],text,text,text[],timestamptz,jsonb)'])assert.equal((await pool.query('select to_regprocedure($1) fn',[signature])).rows[0].fn,null);
      await pool.query(rollback);assert.deepEqual(await snapshot(),before);
      await assert.rejects(waitForCursorRpc(),/G5C_CURSOR_RPC_MISSING/);
      await assert.rejects(service.list({pagination:'cursor',windowStart:1,windowPages:5}),/NEWS_ARCHIVE_CURSOR_RPC_REQUIRED/);
      await pool.query(install);assert.deepEqual(await snapshot(),before);
      const readiness=await waitForCursorRpc();
      assert.equal((await service.list({pagination:'cursor',windowStart:1,windowPages:5})).items.length,10);
      console.log('G5C_RPC_READINESS '+JSON.stringify({size,cycle,...readiness,missingRpcRejected:true}));
      evidence.push({size,cycle,readiness,missingRpcRejected:true});
     }
     evidence.push({size,migrationCandidate:cursorSqlFile,rollback:cursorRollbackFile,functions,installReinstallRollback:'PASS',archiveDerivedLegacySecurityUnchanged:true});
    });
    if(size===4000)await t.test('actual Node API and native database browser flow',async()=>{await require('./news-archive-cursor-native.browser.cjs')({http,pool,oracle,evidence});});
   }finally{await http?.stop();await pool.end();}
  });
 }finally{await admin.end();if(process.env.SETSCOPE_G2B_EVIDENCE)await fs.writeFile(path.join(process.env.SETSCOPE_G2B_EVIDENCE,'G2B_NATIVE_EVIDENCE.json'),JSON.stringify({postgres:version,evidence},null,2));}
});
