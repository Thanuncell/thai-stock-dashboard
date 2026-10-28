'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createNewsArchiveService,archiveFingerprint,reviewArchivedNewsRow}=require('../server/news-archive-service');
const {createNewsService}=require('./fixtures/news-service.cjs');
const {reviewNewsItem,reviewNewsForDisplay}=require('../lib/news-quality');
const {evidenceColumns}=require('../lib/news-evidence');
const NOW=Date.parse('2026-10-28T06:00:00Z');
function cohort(){
 return Array.from({length:1229},(_,i)=>{
  const item={title:'PTT ผลประกอบการและแผนลงทุน ตัวอย่าง '+i,url:'https://thunhoon.com/article-impact-'+i,
   source:'thunhoon',sourceName:'Thunhoon',snippet:'ข้อมูลข่าวจำลองสำหรับตรวจผลกระทบเท่านั้น ไม่ใช่ข่าว Production',pubDate:new Date(NOW-60000-i).toISOString(),matchedSymbols:['PTT'],matchedBrokerFirms:[]};
  const row={fingerprint:archiveFingerprint(item),title:item.title,url:item.url,source:item.source,source_name:item.sourceName,snippet:item.snippet,
   published_at:item.pubDate,first_seen_at:item.pubDate,fetched_at:item.pubDate,matched_symbols:['PTT'],broker_firms:[],
   analysis_summary:'Synthetic stored AI',analysis_mode:'ai'};
  if(i>=1163)Object.assign(row,evidenceColumns(item,row,reviewNewsItem(item)),{verification_revision:1});
  return row;
 });
}
test('P1 impact: production-shaped 1163 legacy + 66 metadata rows are held across all delivery paths without writes',async()=>{
 const rows=cohort(),digest=()=>createHash('sha256').update(JSON.stringify(rows)).digest('hex'),before=digest();
 let reads=0;
 const fetchImpl=async(input,init={})=>{
  assert.equal(init.method||'GET','GET');assert.ok(new URL(input).pathname.endsWith('/news_archive'));reads++;
  const [start,end]=init.headers.Range.split('-').map(Number);
  return Response.json(rows.slice(start,end+1),{headers:{'content-range':start+'-'+Math.min(end,rows.length-1)+'/'+rows.length}});
 };
 const env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on',SETSCOPE_GOOGLE_NEWS_RPC:'on'};
 const archive=createNewsArchiveService({env,fetchImpl,now:()=>NOW});
 const response=await archive.list({featuredCount:5});
 assert.equal(response.total,0);assert.equal(response.featured.length,0);assert.equal(response.items.length,0);assert.equal(response.qualityFiltered,1229);
 assert.equal((await archive.list({symbol:'PTT'})).total,0);
 const items=rows.map(row=>({title:row.title,url:row.url,source:row.source,sourceName:row.source_name,snippet:row.snippet,
  pubDate:row.published_at,matchedSymbols:row.matched_symbols,matchedBrokerFirms:row.broker_firms,verification:reviewArchivedNewsRow(row)}));
 assert.equal(items.filter(x=>reviewNewsForDisplay(x,{now:NOW,hardGate:true}).status==='VERIFIED').length,0);
 const service=createNewsService({env,now:()=>NOW,fetchImpl:()=>{throw Error('Unexpected network');}});
 assert.equal(service.filterForDisplay({items}).items.length,0);
 const domain=await import('../client/domain.mjs');
 const scope=items.slice(0,15).concat(items.slice(1163,1178));
 assert.equal(domain.selectNewsForDisplay(scope,{now:NOW,hardGate:true}).latest.length,0);
 assert.equal(domain.selectNewsForDisplay(scope.slice(0,5),{now:NOW,hardGate:true}).featured.length,0);
 assert.equal(domain.retainWatchlistNews(scope,[{symbol:'PTT'}],NOW,{hardGate:true}).length,0);
 assert.equal(domain.selectNewsForDisplay(items,{now:NOW,hardGate:true}).filtered.length,0);
 assert.equal(digest(),before);assert.equal(reads,3);
 console.log(JSON.stringify({type:'OFFLINE_SYNTHETIC_COHORT',productionTotalsProvidedByOwner:true,legacy:1163,metadataVerified:66,articleVerified:0,
  archive:{input:1229,shown:0,held:1229,needsArticleProof:1229},
  featured:{candidateSample:5,shown:0,held:5},latest:{candidateSample:30,shown:0,held:30},watchlist:{candidateSample:30,shown:0,held:30},
  entireCohortEveryGate:{input:1229,shown:0},writes:0,unchangedDigest:true,actualProductionPerViewCounts:'NOT MEASURED'}));
});
module.exports={cohort};
