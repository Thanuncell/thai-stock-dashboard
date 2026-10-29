'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsService}=require('../server/news-service');
const {newsAnalysisRequest}=require('../lib/news-analysis');
const url='https://thunhoon.com/article-123456',title='PTT รายงานกำไรและแผนลงทุนล่าสุด',date=new Date(Date.now()-60000).toISOString();
const body='บริษัท PTT รายงานผลประกอบการและรายละเอียดแผนลงทุนจากเนื้อหาต้นฉบับ '.repeat(6);
const html=(target=url)=>'<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:target,headline:title,datePublished:date,articleBody:body})+'</script>';
const item=(overrides={})=>({title,url,source:'thunhoon',sourceName:'Thunhoon',pubDate:date,snippet:'PTT รายงานข้อมูลบริษัทและผลประกอบการจากข่าวต้นทาง',...overrides});
const success=items=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({items})}]}]});
const ai=(input,init)=>{const material=JSON.parse(JSON.parse(init.body).input.split('\n').slice(1).join('\n'));return Response.json(success(material.map(x=>({id:x.id,summary:'Synthetic summary'}))));};
test('analysis resolves legacy RSS wrapper through the same bounded article loader',async()=>{
 const bytes=Buffer.from(url),encoded=Buffer.concat([Buffer.from([8,19,34,bytes.length]),bytes]).toString('base64url'),wrapper='https://news.google.com/rss/articles/'+encoded;const calls=[];
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key',SETSCOPE_GOOGLE_NEWS_RPC:'off'},articleFetch:async value=>{calls.push(String(value));return new Response(String(value)===url?html():'<html>Wrapper only</html>',{headers:{'content-type':'text/html'}});},fetchImpl:ai});
 const result=await service.analyse([item({url:wrapper})]);assert.equal(result.items[0].basis,'article');assert.deepEqual(calls,[url]);
});
test('analysis shares a bounded article candidate and HTTP budget across eight summaries',async()=>{
 let calls=0;const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key'},articleFetch:async value=>{calls++;const u=new URL(value),hop=Number(u.searchParams.get('hop')||0);if(hop<3){u.searchParams.set('hop',String(hop+1));return new Response('',{status:302,headers:{location:u.href}});}return new Response(html(u.href),{headers:{'content-type':'text/html'}});},fetchImpl:ai});
 const result=await service.analyse(Array.from({length:8},(_,i)=>item({url:url+i})));assert.equal(result.items.length,8);assert.ok(calls<=12,'shared HTTP ceiling, not a separate budget per item');assert.equal(result.items.filter(x=>x.basis==='article').length,3);
});
test('analysis timeout includes extraction and prevents a late AI request',async()=>{
 let aiCalls=0,signal;const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key'},analysisTimeoutMs:10,logger:{warn(){}},articleFetch:async(_u,init)=>{signal=init.signal;await new Promise(resolve=>setTimeout(resolve,40));return new Response(html(),{headers:{'content-type':'text/html'}});},fetchImpl:async(...args)=>{aiCalls++;return ai(...args);}});
 const result=await service.analyse([item()]);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(aiCalls,0);assert.equal(signal.aborted,true);assert.equal(result.items[0].mode,'rules');
});

const {recordDiscovery,trustedDiscovery,projectDiscovery}=require('../lib/news-discovery');
const {trustedEvidence,getAssessments,canonicalUrl,issueEvidence}=require('../lib/news-evidence');
const {reviewNewsForDisplay,reviewNewsItem}=require('../lib/news-quality');
const {memoryTransport,env:archiveEnv}=require('./fixtures/news-evidence.cjs');
const {createNewsArchiveService,archiveFingerprint}=require('../server/news-archive-service');
const rss=(value=item())=>'<rss><channel><item><title>'+value.title+'</title><link>'+value.url+'</link><pubDate>'+value.pubDate+'</pubDate><source>'+value.sourceName+'</source><description>'+value.snippet+'</description></item></channel></rss>';
for(const view of ['general','watchlist'])test('discovery contract records RSS metadata independently of extraction: '+view,async()=>{
 let calls=0;const wrapper='https://news.google.com/rss/articles/discovery-contract';const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write'},fetchImpl:async()=>new Response(rss(item({url:wrapper}))),articleFetch:async()=>{calls++;throw Error('no hidden extraction');}});
 const result=view==='general'?await service.getNews():await service.getWatchlistNews('PTT',{ownerId:'a'});assert.equal(result.items.length,1);const news=result.items[0];assert.equal(news.discovery.pathway,'google-news-rss/'+view);assert.equal(news.discovery.originalUrl,wrapper);assert.equal(news.discovery.publisher,'Thunhoon');assert.equal(news.discovery.publishedAt,date);assert.ok(trustedDiscovery(news));assert.equal(news.verification.basis,'metadata');assert.equal(reviewNewsForDisplay(news).status,'UNVERIFIED');assert.equal(calls,0);
 const db=memoryTransport(),settings={env:{...archiveEnv,SETSCOPE_P1_DISPLAY_GATE:'off'},fetchImpl:db.fetchImpl};await createNewsArchiveService(settings).ingest(result.items);const row=[...db.rows.values()][0];assert.deepEqual(row.verification_provenance.discovery,news.discovery);row.analysis_mode='ai';row.analysis_summary='Stored synthetic AI';const baseline=[row.fingerprint,row.first_seen_at,row.analysis_summary];
 const read=await createNewsArchiveService(settings).list();assert.equal(read.items.length,1);assert.deepEqual(read.items[0].discovery,news.discovery);assert.ok(trustedDiscovery(read.items[0]));assert.deepEqual([row.fingerprint,row.first_seen_at,row.analysis_summary],baseline);assert.equal(read.items[0].analysisSummary,'Stored synthetic AI');assert.equal(reviewNewsForDisplay(read.items[0]).status,'UNVERIFIED');
});
test('strict RSS verification preserves original discovery, canonical identity and fingerprint through archive restart',async()=>{
 const wrapper='https://news.google.com/rss/articles/discovery-e2e',raw=item({url:wrapper});
 const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on',SETSCOPE_GOOGLE_NEWS_RPC:'off'},fetchImpl:async()=>new Response(rss(raw)),articleFetch:async value=>String(value)===wrapper?new Response('',{status:302,headers:{location:url}}):new Response(html(),{headers:{'content-type':'text/html'}})});
 const news=(await service.getNews()).items[0];assert.ok(news);assert.equal(news.url,canonicalUrl(url));assert.ok(trustedDiscovery(news));assert.equal(news.discovery.originalUrl,wrapper);assert.equal(news.discovery.publishedAt,date);assert.equal(news.verification.basis,'article');assert.equal(reviewNewsForDisplay(news).status,'VERIFIED');
 const db=memoryTransport();await db.service().ingest([news]);const stored=[...db.rows.values()][0];assert.equal(stored.verification_provenance.originalUrl,wrapper);assert.equal(stored.verification_provenance.discovery.pathway,'google-news-rss/general');assert.equal(stored.verification_provenance.resolvedUrl,canonicalUrl(url));const fingerprint=archiveFingerprint(news);assert.equal(stored.fingerprint,fingerprint);
 const restored=(await db.service().list()).items[0];assert.deepEqual(restored.discovery,news.discovery);assert.ok(trustedDiscovery(restored));assert.equal(archiveFingerprint(restored),fingerprint);assert.equal(reviewNewsForDisplay(restored).status,'VERIFIED');
});
test('caller-supplied discovery and VERIFIED cannot cross the evidence trust boundary',async()=>{
 const original=recordDiscovery(item(),{pathway:'google-news-rss/general'}),copy=JSON.parse(JSON.stringify(original));assert.ok(trustedDiscovery(original));assert.equal(trustedDiscovery(copy),null);assert.equal(trustedDiscovery({...original,title:'Different article'}),null);
 const forged={...copy,verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}};assert.equal(reviewNewsForDisplay(forged).status,'UNVERIFIED');const decision=reviewNewsItem(forged);assert.equal(decision.basis,'metadata');assert.equal(trustedEvidence(forged,decision).discovery,null);
 const db=memoryTransport();await db.service().ingest([forged]);assert.equal([...db.rows.values()][0].verification_provenance.discovery,undefined);
});
test('legacy evidence remains readable without a discovery record; invalid optional provenance grants no new trust',async()=>{
 const {article}=require('./fixtures/news-evidence.cjs'),db=memoryTransport();await db.service().ingest([article()]);let row=[...db.rows.values()][0];assert.equal((await db.service().list()).items.length,1);
 row.verification_provenance.discovery={version:'news-discovery-1',publisher:'Wrong publisher',originalUrl:url,pathway:'google-news-rss/general',observedAt:date,publishedAt:date};const read=(await db.service().list()).items[0];assert.ok(read);assert.equal(read.discovery,undefined);assert.equal(reviewNewsForDisplay(read).status,'VERIFIED');
});
for(const [label,response,reason]of [
 ['PDF',()=>new Response('%PDF-1.7',{headers:{'content-type':'application/pdf'}}),'ARTICLE_CONTENT_TYPE_UNVERIFIED'],
 ['login',()=>new Response('<form>Sign in</form>',{headers:{'content-type':'text/html'}}),'ARTICLE_ACCESS_DENIED'],
 ['canonical mismatch',()=>new Response(html(url+'wrong'),{headers:{'content-type':'text/html'}}),'ARTICLE_IDENTITY_MISMATCH'],
 ['missing date',()=>new Response(html().replace(/,"datePublished":"[^"]+"/,''),{headers:{'content-type':'text/html'}}),'ARTICLE_DATE_UNVERIFIED'],
 ['publisher mismatch',()=>new Response(html(),{headers:{'content-type':'text/html'}}),'PUBLISHER_IDENTITY_UNVERIFIED']
])test('extraction uncertainty stays separate from discovery and never creates REJECTED: '+label,async()=>{
 const service=createNewsService({env:{},articleFetch:async()=>response()});const input=item(label==='publisher mismatch'?{sourceName:'InfoQuest',source:'infoquest'}:{});const result=await service.extractArticle(input);assert.equal(result.state,'UNVERIFIED');assert.equal(result.reason,reason);assert.equal(result.text,'');assert.equal(input.verification,undefined);
});
for(const code of [401,403,429])test('shared resolver stops extraction denial '+code+' without repeating the origin',async()=>{
 let calls=0;const service=createNewsService({env:{},articleFetch:async()=>{calls++;return new Response('denied',{status:code});}});for(let i=0;i<2;i++)assert.equal((await service.extractArticle(item())).reason,'ARTICLE_ACCESS_DENIED');assert.equal(calls,1);
});
test('extraction streams are cancelled on abort; late HTML cannot issue evidence or erase discovery',async()=>{
 let cancelled=0;const controller=new AbortController();const service=createNewsService({env:{},articleFetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('<html>'));},cancel(){cancelled++;}}),{headers:{'content-type':'text/html'}})});
 const original=recordDiscovery(item(),{pathway:'google-news-rss/general'});const pending=service.extractArticle(original,{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();const result=await pending;assert.equal(result.state,'UNVERIFIED');assert.equal(result.reason,'ARTICLE_REQUEST_TIMEOUT');assert.equal(cancelled,1);assert.ok(trustedDiscovery(original));assert.equal(original.verification,undefined);
});
test('strict extraction provides a separate internal result without publishing full text or issuing G1 proof',async()=>{
 const service=createNewsService({env:{},articleFetch:async()=>new Response(html(),{headers:{'content-type':'text/html'}})});const original=recordDiscovery(item(),{pathway:'google-news-rss/general'});const result=await service.extractArticle(original);assert.equal(result.state,'EXTRACTED');assert.equal(result.canonicalUrl,canonicalUrl(url));assert.equal(result.publishedAt,date);assert.ok(result.text.length>80&&result.text.length<=7000);assert.equal(result.verification,undefined);assert.equal(original.verification,undefined);assert.ok(trustedDiscovery(original));
});
test('Investing and optional-source OFF cannot cause direct extraction network IO',async()=>{
 const {createNewsTransport}=require('../lib/news-fetch');let dns=0;const service=createNewsService({env:{},articleFetch:createNewsTransport({allowBangkok:false,allowThansettakij:false,lookup:async()=>{dns++;throw Error('must not resolve');}})});
 for(const target of ['https://th.investing.com/news/stock-market-news/article-123','https://bangkokbiznews.com/finance/stock/1234567','https://thansettakij.com/finance/stock/1234567'])assert.equal((await service.extractArticle(item({url:target}))).state,'UNVERIFIED');assert.equal(dns,0);
});

test('failed extraction does not remove eligible legacy RSS news or alter its metadata proof',async()=>{
 const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_GOOGLE_NEWS_RPC:'off'},fetchImpl:async()=>new Response(rss()),articleFetch:async()=>new Response('denied',{status:403})});const first=(await service.getNews()).items[0];assert.equal(first.verification.basis,'metadata');assert.equal((await service.extractArticle(first)).state,'UNVERIFIED');const next=await service.getNews();assert.equal(next.items.length,1);assert.equal(next.items[0].verification.basis,'metadata');assert.equal(service.quarantineReport().length,0);
});
test('extraction redirects retain DNS pinning and block a public-to-private rebind',async()=>{
 const {createNewsTransport}=require('../lib/news-fetch'),{fixtureRequest}=require('./fixtures/news-https.cjs');let dns=0,sockets=0;const request=fixtureRequest(async()=>new Response('',{status:302,headers:{location:'/article-next'}}));
 const transport=createNewsTransport({lookup:async()=>[{address:++dns===1?'8.8.8.8':'127.0.0.1',family:4}],requestImpl:(...args)=>{sockets++;return request(...args);}});const service=createNewsService({env:{},articleFetch:transport});const result=await service.extractArticle(item());assert.equal(result.reason,'ARTICLE_UNSAFE_ADDRESS');assert.equal(dns,2);assert.equal(sockets,1);
});
test('extraction retains the existing response bound and never returns a full article in a news payload',async()=>{
 let cancelled=0,maxBytes;const service=createNewsService({env:{},fetchImpl:async()=>new Response(rss()),articleFetch:async(_u,init)=>{maxBytes=init.maxBytes;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(html()+' '.repeat(1600000)));},cancel(){cancelled++;}}),{headers:{'content-type':'text/html'}});}});const result=await service.extractArticle(item());assert.equal(maxBytes,1500000);assert.equal(cancelled,1);assert.ok(result.text.length<=7000);const news=await service.getNews();assert.ok(!JSON.stringify(news).includes(body));assert.ok(!('text' in news.items[0]));
});

// Real InfoQuest structure: a bound WebPage date/name plus a separate publisher
// content widget. The fixture body is synthetic; metadata alone is never enough.
const infoUrl='https://www.infoquest.co.th/2026/631250';
function infoHtml({schemaUrl=infoUrl,name=title,published=date,content=true,headings=1,metadataBody}={}){
 return '<link rel="canonical" href="'+infoUrl+'"><script type="application/ld+json">'+JSON.stringify({'@graph':[{'@type':'WebPage',url:schemaUrl,'@id':schemaUrl,name,datePublished:published,articleBody:metadataBody},{'@type':'WebSite',url:'https://www.infoquest.co.th/',name:'Unrelated site identity'}]})+'</script>'+Array.from({length:headings},()=>'<h1>'+title+'</h1>').join('')+(content?'<div class="elementor-widget-theme-post-content"><p>'+body+'</p></div>':'')+'<article><h2>Related story only</h2></article>';
}
test('InfoQuest HTML content plus bound WebPage identity/date is verified without requiring NewsArticle JSON-LD',()=>{
 const {inspectNewsArticle}=require('../lib/news-article');const result=inspectNewsArticle(infoHtml(),{url:infoUrl,title,strict:true});assert.equal(result.status,'VERIFIED');assert.equal(result.publishedAt,date);assert.ok(result.text.includes('PTT'));assert.ok(!result.text.includes('Related story'));
});
for(const [label,changes]of [['no article body',{content:false}],['metadata articleBody without HTML content',{content:false,metadataBody:body}],['date without timezone',{published:'2026-10-29T10:00:00'}],['different page identity',{schemaUrl:infoUrl+'9'}],['missing publication date',{published:null}],['multiple headings',{headings:2}],['wrong headline',{name:'Other company news'}]])test('InfoQuest WebPage metadata cannot replace missing or mismatched article evidence: '+label,()=>{
 const {inspectNewsArticle}=require('../lib/news-article');const result=inspectNewsArticle(infoHtml(changes),{url:infoUrl,title,strict:true});assert.notEqual(result.status,'VERIFIED');if(label==='different page identity')assert.equal(result.status,'UNVERIFIED','WebPage metadata alone is not trusted negative article evidence');
});

test('WebPage HTML fallback is limited to the existing InfoQuest publisher structure',()=>{
 const {inspectNewsArticle}=require('../lib/news-article');const other=infoHtml().replaceAll(infoUrl,url);assert.notEqual(inspectNewsArticle(other,{url,title,strict:true}).status,'VERIFIED');
});

test('optional discovery details respect the existing JSONB bound without losing core evidence or fingerprint',async()=>{
 const wrapper='https://news.google.com/rss/articles/'+'a'.repeat(1650),target=url+'?context='+'b'.repeat(1650);const raw=recordDiscovery(item({url:wrapper}),{pathway:'google-news-rss/general'}),news=projectDiscovery(raw,{...raw,url:target});const {inspectNewsArticle}=require('../lib/news-article');const inspection=inspectNewsArticle(html(target),{url:target,title,strict:true});
 news.verification=issueEvidence(news,{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article'},{inspection,originalUrl:wrapper,pathway:'google-rss/article'});assert.ok(trustedEvidence(news).discovery);
 const db=memoryTransport();await db.service().ingest([news]);const row=[...db.rows.values()][0];assert.equal(row.verification_provenance.discovery,undefined);assert.ok(Buffer.byteLength(JSON.stringify(row.verification_provenance))<=5000);assert.equal(row.verification_provenance.originalUrl,wrapper);assert.equal(row.canonical_url,canonicalUrl(target));assert.equal(row.fingerprint,archiveFingerprint(news));assert.equal(reviewNewsForDisplay((await db.service().list()).items[0]).status,'VERIFIED');
});
test('InfoQuest HTML evidence survives strict news verification and archive read without promoting metadata alone',async()=>{
 const source=item({url:infoUrl,source:'infoquest',sourceName:'InfoQuest'});const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on'},fetchImpl:async()=>new Response(rss(source)),articleFetch:async()=>new Response(infoHtml(),{headers:{'content-type':'text/html'}})});const news=(await service.getNews()).items[0];assert.ok(news);assert.equal(news.verification.basis,'article');assert.equal(reviewNewsForDisplay(news).status,'VERIFIED');assert.ok(trustedDiscovery(news));
 const db=memoryTransport();await db.service().ingest([news]);const read=(await db.service().list()).items[0];assert.equal(reviewNewsForDisplay(read).status,'VERIFIED');assert.equal(read.discovery.publisher,'InfoQuest');assert.equal(read.discovery.originalUrl,infoUrl);assert.equal(read.pubDate,date);
});
