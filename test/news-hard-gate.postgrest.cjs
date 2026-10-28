'use strict';
// Opt-in, localhost-only HTTP integration. All database credentials are synthetic.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{randomBytes,createHmac}=require('node:crypto');
const {Pool}=require('pg'),{createNewsArchiveService,archiveFingerprint}=require('../server/news-archive-service');
const {createNewsService}=require('./fixtures/news-service.cjs'),{reviewNewsForDisplay}=require('../lib/news-quality'),{inspectNewsArticle}=require('../lib/news-article');
const {decodeXml}=require('../lib/settrade-parser'),{mergeStockNews}=require('../server/watchlist-news');
const {issueEvidence}=require('../lib/news-evidence');
const run=promisify(execFile),repo=path.join(__dirname,'..');
test('P1: discovery to actual PostgREST HTTP to PostgreSQL 17 to restarted reader',{
 skip:!process.env.SETSCOPE_P1_POSTGREST,timeout:120000
},async t=>{
 const pgBin=process.env.SETSCOPE_TEST_PG_BIN,pgrstExe=process.env.SETSCOPE_TEST_POSTGREST;
 assert.ok(pgBin&&pgrstExe,'Explicit isolated test runtimes required');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'setscope-p1-http-')),data=path.join(root,'data');
 let pgStarted=false,pgrst=null,pool;
 const password=randomBytes(24).toString('hex'),authPassword=randomBytes(24).toString('hex'),secret=randomBytes(32).toString('hex');
 async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
 const pgPort=await port(),httpPort=await port(),base='http://127.0.0.1:'+httpPort;
 const config={host:'127.0.0.1',port:pgPort,user:'p1_admin',password,database:'postgres'};
 function jwt(role){const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const value=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,exp:Math.floor(Date.now()/1000)+900});return value+'.'+createHmac('sha256',secret).update(value).digest('base64url');}
 const env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:jwt('service_role'),SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on',SETSCOPE_GOOGLE_NEWS_RPC:'on'};
 const httpTrace=[];
 const transport=async(input,init={})=>{
  const u=new URL(input);assert.equal(u.origin,'https://fixture.invalid');assert.ok(u.pathname.startsWith('/rest/v1/'));
  const endpoint=u.pathname.slice('/rest/v1'.length)+u.search;
  const response=await fetch(base+endpoint,{...init,signal:init.signal||AbortSignal.timeout(10000)});
  httpTrace.push({path:u.pathname,status:response.status,...(u.pathname.endsWith('/upsert_news_archive_evidence')?{payloadKeys:Object.keys(JSON.parse(init.body))}:{})});
  return response;
 };
 const archive=(mode='write')=>createNewsArchiveService({env:{...env,SETSCOPE_NEWS_EVIDENCE:mode},fetchImpl:transport});
 async function control(action){
  await run(path.join(pgBin,'pg_ctl.exe'),['-D',data,'-l',path.join(root,'postgres.log'),...(action==='start'?['-o','-h 127.0.0.1 -p '+pgPort]:['-m','fast']),'-w',action],{windowsHide:true,timeout:30000});
  pgStarted=action==='start';
 }
 async function stopHttp(){if(pgrst&&pgrst.exitCode===null){const child=pgrst;await new Promise(resolve=>{child.once('close',resolve);child.kill();});}pgrst=null;}
 async function startHttp(){
  const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PGRST_|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)/i.test(key)));
  childEnv.PATH=pgBin+';'+(childEnv.PATH||childEnv.Path||'');
  pgrst=spawn(pgrstExe,[path.join(root,'postgrest.conf')],{windowsHide:true,env:childEnv,stdio:'ignore'});
  for(let i=0;i<100;i++){try{const r=await fetch(base+'/rpc/upsert_news_archive_evidence',{method:'POST',headers:{Authorization:'Bearer '+env.SUPABASE_SECRET_KEY,'content-type':'application/json'},body:'{"p_rows":[]}'});if(r.status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}
  throw Error('Isolated PostgREST startup failed');
 }
 const title='PTT รายงานผลประกอบการและแผนลงทุนล่าสุด',url='https://thunhoon.com/article-http-p1',date=new Date(Date.now()-10000).toISOString();
 const body='บริษัท PTT เปิดเผยรายละเอียดผลประกอบการ แผนลงทุน และข้อมูลการดำเนินงานตามบทความต้นฉบับ '.repeat(5);
 const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:title,datePublished:date,articleBody:body})+'</script>';
 const esc=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 function discovery(articleUrl,headline,published,sourceName,articleHtml){
  return createNewsService({env,fetchImpl:async input=>{
   if(String(input).includes('/rss/search?'))return new Response('<rss><channel><item><title>'+esc(headline)+'</title><link>'+esc(articleUrl)+'</link><pubDate>'+published+'</pubDate><description>'+esc(headline)+'</description><source>'+sourceName+'</source></item></channel></rss>');
   assert.equal(String(input),articleUrl);return new Response(articleHtml,{headers:{'content-type':'text/html'}});
  }});
 }
 let item,fingerprint;
 try{
  const pwFile=path.join(root,'password');await fs.writeFile(pwFile,password);
  await run(path.join(pgBin,'initdb.exe'),['-D',data,'-U','p1_admin','--pwfile',pwFile,'-A','scram-sha-256','-E','UTF8','--locale=C'],{windowsHide:true,timeout:30000});await fs.unlink(pwFile);await control('start');
  pool=new Pool(config);pool.on('error',()=>{});
  assert.match((await pool.query('show server_version')).rows[0].server_version,/^17\./);
  await pool.query("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role p1_auth login noinherit nosuperuser nocreatedb nocreaterole password '"+authPassword+"'; grant anon,authenticated,service_role to p1_auth;");
  for(const file of ['supabase/news_archive.sql','supabase/news_archive_least_privilege.sql','supabase/migrations/20261027112037_news_archive_evidence.sql'])await pool.query(await fs.readFile(path.join(repo,file),'utf8'));
  await fs.writeFile(path.join(root,'postgrest.conf'),[
   'db-uri = "postgresql://p1_auth:'+authPassword+'@127.0.0.1:'+pgPort+'/postgres"','db-schemas = "public"','db-anon-role = "anon"','db-config = false',
   'jwt-secret = "'+secret+'"','server-host = "127.0.0.1"','server-port = '+httpPort,'log-level = "crit"'
  ].join('\n'));
  await startHttp();
  await t.test('discovery strict article evidence persists through named HTTP RPC',async()=>{
   const result=await discovery(url,title,date,'Thunhoon',html).getNews();
   assert.equal(result.items.length,1);item=result.items[0];fingerprint=archiveFingerprint(item);
   assert.equal(reviewNewsForDisplay(item).status,'VERIFIED');assert.equal((await archive().ingest([item])).ingested,1);
   const row=(await pool.query('select * from news_archive where fingerprint=$1',[fingerprint])).rows[0];
   assert.equal(row.verification_basis,'article');assert.equal(row.verification_provenance.displayPolicy,'news-display-1');
   assert.equal(Date.parse(row.verification_provenance.articlePublishedAt),+row.published_at);
   assert.ok(httpTrace.some(x=>x.path.endsWith('/upsert_news_archive_evidence')&&x.status===200&&x.payloadKeys.join()==='p_rows'));
  });
  await t.test('restart database and HTTP service; a fresh process restores displayable evidence',async()=>{
   await pool.end();pool=null;await stopHttp();await control('stop');await control('start');
   pool=new Pool(config);pool.on('error',()=>{});await startHttp();
   const code="const {createNewsArchiveService}=require('./server/news-archive-service');const env=JSON.parse(process.env.SETSCOPE_P1_CHILD_ENV);const base=process.env.SETSCOPE_P1_CHILD_BASE;const fetchImpl=(input,init)=>{const u=new URL(input);if(u.origin!=='https://fixture.invalid')throw Error('Unexpected host');return fetch(base+u.pathname.slice('/rest/v1'.length)+u.search,init);};createNewsArchiveService({env,fetchImpl}).list().then(r=>console.log(JSON.stringify({shown:r.items.length,article:r.items[0]?.verification.basis,datePolicy:r.items[0]?.verification.displayPolicy}))).catch(()=>{process.exitCode=1;});";
   const child=await run(process.execPath,['-e',code],{cwd:repo,windowsHide:true,env:{...process.env,SETSCOPE_P1_CHILD_ENV:JSON.stringify({...env,SETSCOPE_NEWS_EVIDENCE:'read'}),SETSCOPE_P1_CHILD_BASE:base}});
   assert.deepEqual(JSON.parse(child.stdout),{shown:1,article:'article',datePolicy:'news-display-1'});
  });
  await t.test('persisted proof reaches Featured, Latest, Archive and owner stock selectors',async()=>{
   const list=await archive('read').list({featuredCount:1});assert.equal(list.featured.length,1);assert.equal(list.total,0);
   const normal=await archive('read').list();assert.equal(normal.total,1);
   const domain=await import('../client/domain.mjs');
   assert.equal(domain.selectNewsForDisplay(normal.items,{featuredCount:0}).latest.length,1);
   assert.equal(domain.selectNewsForDisplay(normal.items).featured.length,1);
   // Re-observe the stock through the actual pipeline; an unbound object edit is never evidence.
   const watch=await discovery(url,title,date,'Thunhoon',html).getWatchlistNews([{symbol:'PTT'}],{ownerId:'synthetic-owner'});
   assert.equal(watch.items.length,1);assert.equal((await archive().ingest(watch.items)).ingested,1);
   const stocks=(await archive('read').list({symbol:'PTT'})).items;
   assert.equal(mergeStockNews(stocks,[{symbol:'PTT'}],Date.now()).length,1);
   assert.equal(domain.retainWatchlistNews(stocks,[{symbol:'PTT'}]).length,1);
   assert.equal(domain.retainWatchlistNews(stocks,[{symbol:'OR'}]).length,0);
  });
  await t.test('duplicate HTTP retry preserves fingerprint, evidence, first_seen and stored AI',async()=>{
   await pool.query("update news_archive set analysis_summary='Synthetic preserved AI',analysis_mode='ai' where fingerprint=$1",[fingerprint]);
   const before=(await pool.query('select * from news_archive where fingerprint=$1',[fingerprint])).rows[0];
   const listed=(await archive('read').list()).items[0];
   assert.equal((await archive().ingest([listed])).retained,1);
   const after=(await pool.query('select * from news_archive where fingerprint=$1',[fingerprint])).rows[0];
   assert.equal(after.fingerprint,before.fingerprint);assert.equal(after.verification_revision,before.verification_revision);
   assert.equal(+after.first_seen_at,+before.first_seen_at);assert.equal(after.analysis_summary,before.analysis_summary);
  });
  await t.test('spoofed article claim never acquires display policy or trusted article basis in storage',async()=>{
   const fake={...JSON.parse(JSON.stringify(item)),url:'https://thunhoon.com/article-http-spoof'};
   assert.notEqual(reviewNewsForDisplay(fake).status,'VERIFIED');
   await archive().ingest([fake]);
   const row=(await pool.query('select * from news_archive where url=$1',[fake.url])).rows[0];
   assert.equal(row.verification_basis,'metadata');assert.notEqual(row.verification_provenance.displayPolicy,'news-display-1');
   assert.equal((await archive('read').list()).items.some(x=>x.url===fake.url),false);
  });
  await t.test('independent display OFF preserves G1 write and metadata visibility through HTTP',async()=>{
   const off=createNewsArchiveService({env:{...env,SETSCOPE_P1_DISPLAY_GATE:'off'},fetchImpl:transport});
   const list=await off.list();assert.ok(list.items.some(x=>x.url==='https://thunhoon.com/article-http-spoof'));
   const baseline=(await pool.query("select count(*)::int n from news_archive")).rows[0].n;
   const fresh={title:'PTT metadata compatibility',url:'https://thunhoon.com/article-g1-off',source:'thunhoon',sourceName:'Thunhoon',pubDate:date,snippet:'Synthetic metadata for default-off G1 compatibility'};
   assert.equal((await off.ingest([fresh])).ingested,1);assert.equal((await pool.query("select count(*)::int n from news_archive")).rows[0].n,baseline+1);
   assert.ok((await off.list()).items.some(x=>x.url===fresh.url));
   assert.equal((await archive('read').list()).items.some(x=>x.url===fresh.url),false);
  });
  await t.test('official document stays durable G1 metadata and is hidden under both display modes',async()=>{
   const off=createNewsArchiveService({env:{...env,SETSCOPE_P1_DISPLAY_GATE:'off'},fetchImpl:transport});
   const document={title:'0528NWS271020261715395120T.pdf - SET - SET',url:'https://news.google.com/rss/articles/synthetic-official-document',source:'settrade',sourceName:'SET',pubDate:date,snippet:'Synthetic document metadata; contents have not been verified'};
   assert.equal((await off.ingest([document])).ingested,1);
   await pool.query("update news_archive set analysis_summary='Synthetic stored document AI',analysis_mode='ai' where url=$1",[document.url]);
   const before=(await pool.query('select * from news_archive where url=$1',[document.url])).rows[0];
   assert.equal((await off.list()).items.some(x=>x.url===document.url),false);
   assert.equal(before.verification_status,'VERIFIED');assert.equal(before.verification_basis,'metadata');
   assert.equal(before.analysis_summary,'Synthetic stored document AI');
   assert.equal((await archive('read').list()).items.some(x=>x.url===document.url),false);
   const after=(await pool.query('select * from news_archive where url=$1',[document.url])).rows[0];
   assert.deepEqual(after,before);
  });
  await t.test('anon/authenticated HTTP roles cannot read or invoke evidence RPC; RLS remains forced',async()=>{
   for(const role of ['anon','authenticated']){
    const headers={Authorization:'Bearer '+jwt(role),'content-type':'application/json'};
    for(const [endpoint,init] of [['/news_archive?select=id',{headers}],['/rpc/upsert_news_archive_evidence',{method:'POST',headers,body:'{"p_rows":[]}'}]]){
     const r=await fetch(base+endpoint,init);assert.ok([401,403].includes(r.status));
    }
   }
   const controls=(await pool.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.news_archive'::regclass")).rows[0];
   assert.deepEqual(controls,{relrowsecurity:true,relforcerowsecurity:true});
  });
  await t.test('real public legacy article respects Latest age limits and survives isolated HTTP persistence',{
   skip:process.env.SETSCOPE_P1_LIVE_ARTICLE!=='1'
  },async()=>{
   const articleUrl='https://www.kaohoon.com/news/854008';
   const response=await fetch(articleUrl,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
   const actualHtml=await response.text();
   const meta=[...actualHtml.matchAll(/<meta\b[^>]*>/gi)].map(x=>x[0]).find(x=>/\bproperty=["']og:title["']/i.test(x));
   const headline=decodeXml(meta?.match(/\bcontent=["']([^"']*)["']/i)?.[1]||'');
   const inspected=inspectNewsArticle(actualHtml,{url:articleUrl,title:headline,strict:true});assert.equal(inspected.status,'VERIFIED');
   const age=Date.now()-Date.parse(inspected.publishedAt);assert.ok(age>30*86400000&&age<365*86400000);
   const discovered=await discovery(articleUrl,headline,inspected.publishedAt,'ข่าวหุ้น',actualHtml).getNews();
   assert.equal(discovered.items.length,0,'Latest must retain its existing 30-day limit');
   const historical={title:headline,url:articleUrl,pubDate:inspected.publishedAt,source:'kaohoon',sourceName:'ข่าวหุ้น',snippet:'',matchedSymbols:[],matchedBrokerFirms:[]};
   historical.verification=issueEvidence(historical,{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article'},{inspection:inspected,pathway:'manual-isolated-review'});
   assert.equal(reviewNewsForDisplay(historical).status,'VERIFIED');
   assert.equal((await archive().ingest([historical])).ingested,1);
   const stored=(await archive('read').list()).items.find(x=>x.url===articleUrl);assert.ok(stored);assert.equal(reviewNewsForDisplay(stored).status,'VERIFIED');
   console.log('REAL_PUBLIC_ARTICLE HTTP 200; article VERIFIED; isolated HTTP persist/read PASS; Production writes 0');
  });
  await t.test('bounded real publisher article uses pinned transport and survives actual HTTP persist/read',{
   skip:process.env.SETSCOPE_DOCUMENT_LIVE!=='1'
  },async()=>{
   const {createNewsTransport}=require('../lib/news-fetch');
   const articleUrl='https://www.kaohoon.com/pr/875388';
   const response=await createNewsTransport()(articleUrl,{signal:AbortSignal.timeout(15000),maxBytes:1000000});
   assert.equal(response.status,200);
   const actualHtml=await response.text();
   const meta=[...actualHtml.matchAll(/<meta\b[^>]*>/gi)].map(x=>x[0]).find(x=>/\bproperty=["']og:title["']/i.test(x));
   const headline=decodeXml(meta?.match(/\bcontent=["']([^"']*)["']/i)?.[1]||'');
   const inspected=inspectNewsArticle(actualHtml,{url:articleUrl,title:headline,strict:true});assert.equal(inspected.status,'VERIFIED');
   const verified={title:headline,url:articleUrl,pubDate:inspected.publishedAt,source:'kaohoon',sourceName:'ข่าวหุ้น',snippet:'',matchedSymbols:[],matchedBrokerFirms:[]};
   verified.verification=issueEvidence(verified,{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article'},{inspection:inspected,pathway:'manual-isolated-review'});
   assert.equal((await archive().ingest([verified])).ingested,1);
   const stored=(await archive('read').list()).items.find(x=>x.url===articleUrl);
   assert.ok(stored);assert.equal(stored.articleVerified,true);assert.equal(stored.contentType,'ARTICLE_NEWS');
   assert.equal(reviewNewsForDisplay(stored).status,'VERIFIED');
   console.log('REAL_ARTICLE pinned HTTP 200; actual isolated PostgREST persist/read PASS; Production writes 0');
  });
  await t.test('database transport failure fails closed and preserves all persisted rows',async()=>{
   const before=(await pool.query("select md5(jsonb_agg(to_jsonb(a) order by id)::text) digest from news_archive a")).rows[0].digest;
   const failed=createNewsArchiveService({env,fetchImpl:async()=>{throw Error('Synthetic transport failure');}});
   await assert.rejects(failed.list(),/Synthetic transport failure/);
   const after=(await pool.query("select md5(jsonb_agg(to_jsonb(a) order by id)::text) digest from news_archive a")).rows[0].digest;
   assert.equal(after,before);
  });
 }finally{
  if(pool)await pool.end();await stopHttp();if(pgStarted)await control('stop');
  const absolute=path.resolve(root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('setscope-p1-http-'));
  if(!pgStarted)await fs.rm(absolute,{recursive:true,force:true});
 }
});
