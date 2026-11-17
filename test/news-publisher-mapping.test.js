'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceFromOutlet, createNewsService } = require('../server/news-service');
const { newsPublisherKey, newsMatchesSources, newsAssociationSymbols, newsSecuritySymbols } = require('../lib/news-content');
const { classifyNewsItem, reviewNewsForDisplay } = require('../lib/news-quality');
const { createNewsArchiveService } = require('../server/news-archive-service');

const publisherCases = ['SET', 'SETTRADE', 'SETTRADE.COM', '  set  ', ' settrade ', '  settrade.com  '];
const article = (sourceName, url, overrides = {}) => ({
  title: 'PTT รายงานความคืบหน้าโครงการลงทุนใหม่', source: 'other', sourceName,
  url, pubDate: new Date(Date.now()-60_000).toISOString(),
  snippet: 'บริษัทเปิดเผยรายละเอียดโครงการลงทุนและผลประกอบการที่เกี่ยวข้อง', ...overrides
});

test('FIX-01: map confirmed SET publisher names through existing outlet mapping', () => {
  for (const sourceName of publisherCases) assert.equal(sourceFromOutlet(sourceName), 'settrade', sourceName);
  for (const sourceName of ['SETTRADE.COMM','the SETTRADE.COM desk','Another Publisher'])
    assert.equal(sourceFromOutlet(sourceName), 'other', sourceName);
});

test('FIX-02: existing publisher filter recognizes current and legacy publisher names', () => {
  for (const sourceName of publisherCases) {
    const item = article(sourceName,'https://www.settrade.com/th/news-and-articles/news/106526600');
    assert.equal(newsPublisherKey(item), 'settrade', sourceName);
    assert.equal(newsMatchesSources(item,'settrade'), true, sourceName);
    assert.equal(newsMatchesSources(item,'settrade,kaohoon'), true, sourceName);
    assert.equal(newsMatchesSources(item,'all'), true, sourceName);
    assert.equal(item.source,'other','presentation classification must not mutate stored source');
  }
  const unrelated = article('Independent News','https://www.kaohoon.com/news/999998', {title:'SETTRADE.COM แจ้งข่าวการลงทุน'});
  assert.equal(newsPublisherKey(unrelated),'other');
  assert.equal(newsMatchesSources(unrelated,'settrade'),false,'headline must not establish publisher');
});

test('FIX-02: existing ticker association behavior is reused without inventing symbols', () => {
  const tagged=article('SETTRADE.COM','https://www.settrade.com/th/news-and-articles/news/106526600',{matchedSymbols:['PTT']});
  const untagged={...tagged,matchedSymbols:[]};
  assert.deepEqual(newsAssociationSymbols(tagged),['PTT']);
  assert.deepEqual(newsAssociationSymbols(untagged),[]);
  assert.equal(newsSecuritySymbols(tagged),null,'legacy source=other retains existing association semantics');
  assert.equal(newsMatchesSources(untagged,'settrade'),true,'publisher filter does not depend on ticker');
});

test('FIX-04: existing quality/verification still rejects non-news and unresolved wrappers', () => {
  const dataPage=article('SETTRADE.COM','https://www.settrade.com/th/equities/quote/PTT/overview');
  assert.equal(classifyNewsItem(dataPage).accepted,false);
  const unresolved=article('SETTRADE.COM','https://news.google.com/rss/articles/opaque');
  assert.notEqual(reviewNewsForDisplay(unresolved).status,'VERIFIED','name alone must not bypass article evidence');
  const rejected={...unresolved,verification:{status:'REJECTED',reason:'ARTICLE_NOT_FOUND'}};
  assert.equal(newsMatchesSources(rejected,'settrade'),true,'filter is only metadata, not a quality bypass');
  assert.equal(rejected.verification.status,'REJECTED');
});

test('FIX-01/02: synthetic RSS source is visible to existing SETTRADE filter', async () => {
  const row=article('SETTRADE.COM','https://news.google.com/rss/articles/v170-mapping');
  const rss=`<rss><channel><item><title>${row.title}</title><link>${row.url}</link><pubDate>${new Date(row.pubDate).toUTCString()}</pubDate><source>${row.sourceName}</source><description>${row.snippet}</description></item></channel></rss>`;
  const service=createNewsService({env:{SETSCOPE_P1_DISPLAY_GATE:'off'},fetchImpl:async()=>new Response(rss)});
  const news=(await service.getNews()).items.find(x=>x.sourceName==='SETTRADE.COM');
  assert.ok(news,'the fixture item should remain in the accepted news feed');
  assert.equal(news.source,'settrade');
  assert.equal(newsMatchesSources(news,'settrade'),true);
});

test('FIX-03: archive read-time filter includes legacy rows without writes or identity mutation',async () => {
  const publishedAt=new Date(Date.now()-120_000).toISOString();
  const make=(id,name)=>({fingerprint:`fixture-v170-${id}`,title:`PTT รายงานความคืบหน้าการลงทุน ${id}`,
    url:`https://news.google.com/rss/articles/fixture-v170-${id}`,source:'other',source_name:name,
    snippet:'บริษัทเปิดเผยรายละเอียดความคืบหน้าโครงการและกรอบการดำเนินงานล่าสุด',
    published_at:publishedAt,matched_symbols:['PTT'],broker_firms:[]});
  const rows=[make(1,'SETTRADE.COM'),make(2,'Independent News')];
  const original=JSON.stringify(rows);let reads=0,writes=0;
  const service=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:'off'},
    fetchImpl:async(_url,init)=>{
      if(init?.method&&init.method!=='GET'){writes++;throw Error('unexpected write');}
      reads++;
      return new Response(JSON.stringify(rows),{status:200,headers:{'content-range':'0-1/2','content-type':'application/json'}});
    }});
  const all=await service.list({source:'all',page:1,pageSize:10});
  const filtered=await service.list({source:'settrade',page:1,pageSize:10});
  assert.equal(all.items.length,2);
  assert.deepEqual(filtered.items.map(x=>x.sourceName),['SETTRADE.COM']);
  assert.equal(filtered.total,1);
  assert.equal(filtered.items[0].source,'other');
  assert.deepEqual(newsAssociationSymbols(filtered.items[0]),['PTT']);
  assert.equal(JSON.stringify(rows),original);
  assert.equal(writes,0);assert.equal(reads,1,'existing snapshot cache should be reused');
});

test('FIX-01/04: confirmed names use the existing ingestion gate in both modes', async () => {
  for (const mode of ['off','on']) for (const sourceName of ['SET','SETTRADE','SETTRADE.COM']) {
    const row=article(sourceName,'https://www.settrade.com/th/news-and-articles/news/999991');
    const body='บริษัทเปิดเผยรายละเอียดผลประกอบการและแผนการลงทุนจากบทความต้นฉบับ '.repeat(8);
    const rss=`<rss><channel><item><title>${row.title}</title><link>${row.url}</link><pubDate>${new Date(row.pubDate).toUTCString()}</pubDate><source>${sourceName}</source><description>${body}</description></item></channel></rss>`;
    const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:row.url,headline:row.title,datePublished:row.pubDate,articleBody:body})+'</script>';
    let probes=0;
    const service=createNewsService({env:{SETSCOPE_P1_DISPLAY_GATE:mode},fetchImpl:async()=>new Response(rss),
      articleFetch:async()=>{probes++;return new Response(html,{headers:{'content-type':'text/html'}});}});
    const items=(await service.getNews()).items;
    assert.equal(items.length,1,sourceName+' gate='+mode);
    assert.equal(items[0].source,'settrade');
    assert.equal(newsMatchesSources(items[0],'settrade'),true);
    if(mode==='on') {
      assert.equal(reviewNewsForDisplay(items[0]).status,'VERIFIED');
      assert.equal(items[0].verification.basis,'article');
      assert.equal(probes,1,'existing article cache is reused across feeds');
    } else assert.equal(probes,0);
  }
});

test('FIX-02/04: SETTRADE.COM reuses article-bound stock identification, not headline guesses',async () => {
  const {createNewsLinkReview}=require('../server/news-link-review');
  const row=article('SETTRADE.COM','https://www.settrade.com/th/news-and-articles/news/999992',{source:'settrade',matchedSymbols:['OR']});
  const check=async about=>{
    const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:row.url,headline:row.title,datePublished:row.pubDate,
      articleBody:'รายละเอียดผลประกอบการและการลงทุนของบริษัทจากบทความต้นฉบับ '.repeat(8),about})+'</script>';
    const review=createNewsLinkReview({registrySearch:async()=>[{symbol:'PTT',provider_symbol:'PTT.BK',provider:'Yahoo Finance',active:true,status:'verified'}],
      loadArticle:async()=>({response:new Response(html,{headers:{'content-type':'text/html'}}),target:new URL(row.url)})});
    await review.inspect(row);
    return review.project(row);
  };
  assert.deepEqual(newsSecuritySymbols(await check({'@type':'Corporation',tickerSymbol:'PTT'})),['PTT']);
  assert.deepEqual(newsSecuritySymbols(await check([])),[],'PTT headline and unrelated matchedSymbols cannot invent a SET tag');
});

function archiveRows() {
  const rows=Array.from({length:13},(_,i)=>({id:i+1,fingerprint:`fixture-g2-${i}`,title:`PTT รายงานผลประกอบการโครงการ ${i}`,
    url:`https://news.google.com/rss/articles/fixture-g2-${i}`,source:i===12?'infoquest':'other',source_name:i===12?'InfoQuest':'SETTRADE.COM',
    snippet:'บริษัทเปิดเผยรายละเอียดผลประกอบการและการลงทุนตามข่าวต้นทาง',published_at:new Date(Date.now()-60_000-i*1000).toISOString(),
    matched_symbols:['PTT'],broker_firms:[],analysis_mode:'ai',analysis_summary:'Stored synthetic summary'}));
  rows.push({...rows[0],id:14,fingerprint:'fixture-g2-duplicate',url:rows[0].url+'?utm_source=fixture'});
  return rows;
}

test('FIX-02/03: snapshot search, OR filters, totals, pages, featured and dedupe reuse the existing flow',async () => {
  const rows=archiveRows(),original=JSON.stringify(rows);let reads=0;
  const service=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:'off'},
    fetchImpl:async(_url,init)=>{assert.ok(!init?.method||init.method==='GET');reads++;
      return Response.json(rows,{headers:{'content-range':`0-${rows.length-1}/${rows.length}`}});}});
  const pages=[];
  for(let page=1;page<=3;page++) {
    const result=await service.list({source:'settrade',page,pageSize:5});
    assert.equal(result.total,12);assert.equal(result.countExact,true);assert.equal(result.deduplicated,1);
    pages.push(...result.items);
  }
  assert.equal(pages.length,12);assert.equal(new Set(pages.map(x=>x.url)).size,12);
  assert.equal((await service.list({source:'settrade,infoquest'})).matchingTotal,13);
  const searched=await service.list({source:'settrade',query:'โครงการ 11',symbol:'PTT'});
  assert.equal(searched.total,1);assert.equal(searched.items[0].fingerprint,'fixture-g2-11');
  const featured=await service.list({source:'settrade',featuredCount:2,pageSize:20});
  assert.equal(featured.matchingTotal,12);assert.equal(featured.total,10);assert.equal(featured.featured.length,2);
  assert.equal(new Set([...featured.items,...featured.featured].map(x=>x.url)).size,12);
  assert.equal(reads,1);assert.equal(JSON.stringify(rows),original);
});

test('FIX-02/04: client selection retains search, multi-select, featured/latest and rejected controls',async () => {
  const {selectNewsForDisplay}=await import('../client/domain.mjs');
  const good=article('SETTRADE.COM','https://news.google.com/rss/articles/fixture-client',{matchedSymbols:['PTT']});
  const other={...good,source:'infoquest',sourceName:'InfoQuest',url:good.url+'-other'};
  const rejected={...good,url:good.url+'-rejected',verification:{status:'REJECTED'}};
  const unverified={...good,url:good.url+'-unverified',verification:{status:'UNVERIFIED'}};
  const selected=selectNewsForDisplay([good,{...good},other,rejected,unverified],{source:'settrade',query:'โครงการ',featuredCount:1});
  assert.deepEqual(selected.filtered,[good]);assert.deepEqual(selected.featured,[good]);assert.equal(selected.latest.length,0);
  assert.equal(selectNewsForDisplay([good,other],{source:'settrade,infoquest',featuredCount:0}).latest.length,2);
  assert.equal(selectNewsForDisplay([good],{source:'settrade',query:'missing'}).filtered.length,0);
});

test('FIX-03: compatible derived-query fixture agrees with snapshot without maintenance',async () => {
  const {memoryQuery}=require('./fixtures/news-query-quality.cjs');
  const rows=archiveRows(),fixture=memoryQuery(rows,'news-query-2:legacy:metadata'),original=JSON.stringify([...fixture.raw.values()]);
  const service=createNewsArchiveService({env:{SUPABASE_URL:'https://query-quality.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:'on'},fetchImpl:fixture.fetchImpl});
  for(const options of [{source:'settrade'},{source:'settrade',page:2},{source:'settrade,infoquest'},
    {source:'settrade',query:'โครงการ 11'},{source:'settrade',featuredCount:2}]) {
    const result=await service.list({pageSize:5,...options});
    assert.equal(result.matchingTotal,options.query?1:options.source.includes('infoquest')?13:12);
    assert.equal(result.total,result.matchingTotal-result.featured.length);
    assert.equal(result.queryMode,'database');
  }
  assert.ok(fixture.calls.every(x=>['read_news_archive','list_news_archive_query'].includes(x.name)));
  assert.equal(JSON.stringify([...fixture.raw.values()]),original);
});

test('FIX-03: stale derived publisher remains a separate limitation; never rebuild or mask it',async () => {
  const {memoryQuery}=require('./fixtures/news-query-quality.cjs');
  const fixture=memoryQuery(archiveRows(),'news-query-2:legacy:metadata');
  for(const group of fixture.groups.values())if(group.publisher==='settrade')group.publisher='other';
  const before=JSON.stringify([...fixture.groups]);
  const service=createNewsArchiveService({env:{SUPABASE_URL:'https://query-quality.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:'on'},fetchImpl:fixture.fetchImpl});
  assert.equal((await service.list({source:'settrade'})).total,0,'stored publisher can omit eligible rows before read-time mapping');
  await assert.rejects(service.list({source:'all'}),/NEWS_QUERY_PROJECTION_CHANGED/);
  assert.equal(JSON.stringify([...fixture.groups]),before);
  assert.ok(fixture.calls.every(x=>['read_news_archive','list_news_archive_query'].includes(x.name)),'no reset, refresh or commit');
});
