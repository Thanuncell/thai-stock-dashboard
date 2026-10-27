'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsService}=require('../server/news-service');
const {matchesWatchlistStock}=require('../lib/watchlist-news-identity');
const {normalizeWatchlistNewsStocks}=require('../lib/validation');
const NOW=Date.parse('2026-10-27T12:00:00Z');
const snippet='บริษัทเปิดเผยข้อมูลผลประกอบการและรายละเอียดการดำเนินงานล่าสุด';
const story=(symbol,i=0)=>({title:symbol+' รายงานผลประกอบการ '+i,url:'https://www.kaohoon.com/news/'+symbol+'-'+i,pubDate:new Date(NOW-i*1000).toUTCString(),snippet});
const xml=items=>'<rss><channel>'+items.map(item=>`<item><title>${item.title}</title><link>${item.url}</link><pubDate>${item.pubDate}</pubDate><description>${item.snippet||''}</description><source>ข่าวหุ้น</source></item>`).join('')+'</channel></rss>';
function fixture(){let time=NOW;const calls=[],fail=new Map(),rows=new Map();
 const service=createNewsService({now:()=>time,fetchImpl:async(value,init)=>{const url=new URL(value);assert.equal(url.hostname,'news.google.com');assert.ok(init.signal);const symbol=url.searchParams.get('q').match(/^\("([^"]+)"/)[1];calls.push(symbol);if(fail.has(symbol))return new Response('',{status:fail.get(symbol)});return new Response(xml(rows.get(symbol)||[story(symbol)]));}});
 return {service,calls,fail,rows,setTime:value=>{time=value;}};
}
test('adding PTT → OR → KBANK → BBL retains each stock and only fetches new stock',async()=>{
 const f=fixture(),symbols=['PTT','OR','KBANK','BBL'];
 for(let i=1;i<=4;i++){
  const stocks=symbols.slice(0,i).map(symbol=>({symbol}));const result=await f.service.getWatchlistNews(stocks,{ownerId:'A'});
  assert.equal(result.items.length,i);assert.deepEqual(new Set(result.items.flatMap(item=>item.matchedSymbols)),new Set(symbols.slice(0,i)));
  assert.equal(result.dataState,'fresh');assert.equal(f.calls.length,i);
 }
 const removed=await f.service.getWatchlistNews([{symbol:'PTT'},{symbol:'BBL'}],{ownerId:'A'});
 assert.deepEqual(new Set(removed.items.flatMap(item=>item.matchedSymbols)),new Set(['PTT','BBL']));assert.equal(f.calls.length,4);
});
test('bank group progresses within per-request and rolling owner request bounds without silent omission',async()=>{
 const f=fixture(),banks=['KBANK','BBL','SCB','KTB','BAY','TTB','KKP','TISCO'].map(symbol=>({symbol}));
 const first=await f.service.getWatchlistNews(banks,{ownerId:'A'});assert.equal(f.calls.length,4);assert.equal(first.dataState,'partial');assert.equal(first.stockStatus.filter(s=>s.reason==='REQUEST_BUDGET').length,4);
 const second=await f.service.getWatchlistNews(banks,{ownerId:'A'});assert.equal(f.calls.length,8);assert.equal(second.items.length,8);assert.equal(second.dataState,'fresh');
 await f.service.getWatchlistNews(banks,{ownerId:'A',refresh:true});assert.equal(f.calls.length,8);
});

test('concurrent requests share owner reservations and per-stock pending work',async()=>{
 const f=fixture();
 const results=await Promise.all(Array.from({length:12},(_,i)=>f.service.getWatchlistNews([{symbol:'FIX'+i}],{ownerId:'A'})));
 assert.equal(f.calls.length,8);assert.equal(results.filter(r=>r.dataState==='unavailable').length,4);
 const g=fixture();const same=await Promise.all([g.service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'A'}),g.service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'A'})]);
 assert.equal(g.calls.length,1);assert.deepEqual(same[0].items,same[1].items);
});
test('shared stories retain all matched symbols, sorting and more than 30 total stories',async()=>{
 const f=fixture(),shared={...story('PTT'),title:'PTT และ KBANK รายงานผลประกอบการ',url:'https://www.kaohoon.com/news/shared'};
 f.rows.set('PTT',[shared,...Array.from({length:20},(_,i)=>story('PTT',i+1))]);f.rows.set('KBANK',[shared,...Array.from({length:20},(_,i)=>story('KBANK',i+1))]);
 const result=await f.service.getWatchlistNews([{symbol:'PTT'},{symbol:'KBANK'}],{ownerId:'A'});
 assert.equal(result.items.length,41);assert.equal(result.total,41);assert.equal(new Set(result.items.map(i=>i.url)).size,41);
 assert.deepEqual(new Set(result.items.find(i=>i.url===shared.url).matchedSymbols),new Set(['PTT','KBANK']));
 assert.ok(result.items.every((item,i,items)=>!i||Date.parse(items[i-1].pubDate)>=Date.parse(item.pubDate)));
});
test('per-stock retention limit is explicit and cannot crowd another stock out',async()=>{
 const f=fixture();f.rows.set('PTT',Array.from({length:40},(_,i)=>story('PTT',i)));
 const result=await f.service.getWatchlistNews([{symbol:'PTT'},{symbol:'OR'}],{ownerId:'A'});
 assert.equal(result.items.length,31);assert.equal(result.limited,true);assert.equal(result.dataState,'partial');assert.ok(result.items.some(i=>i.matchedSymbols.includes('OR')));
});
for(const code of [403,429,503])test('partial provider '+code+' retains existing owner stocks and never leaks fallback',async()=>{
 const f=fixture();await f.service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'A'});f.fail.set('OR',code);
 const result=await f.service.getWatchlistNews([{symbol:'PTT'},{symbol:'OR'}],{ownerId:'A'});assert.equal(result.items.length,1);assert.equal(result.dataState,'partial');
 const other=await f.service.getWatchlistNews([{symbol:'OR'}],{ownerId:'B'});assert.equal(other.items.length,0);assert.equal(other.dataState,'unavailable');
 assert.equal(f.calls.filter(s=>s==='OR').length,1,'denial/cooldown prevents another RSS call');
});
test('failed refresh retains LKG until deadline, not forever, and expired/rejected stories never accumulate',async()=>{
 const f=fixture();f.rows.set('PTT',[story('PTT'),{...story('PTT',1),pubDate:new Date(NOW-31*86400000).toUTCString()},{...story('PTT',2),title:'Login',url:'https://www.kaohoon.com/login'}]);
 assert.equal((await f.service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'A'})).items.length,1);
 f.fail.set('PTT',503);f.setTime(NOW+1000);
 const stale=await f.service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'A',refresh:true});assert.equal(stale.dataState,'stale');assert.equal(stale.items.length,1);
 f.setTime(NOW+31*60000);const expired=await f.service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'A'});assert.equal(expired.items.length,0);assert.equal(expired.dataState,'unavailable');
});
test('absolute deadline aborts an ignored provider request and does not commit its late result',async()=>{
 let signal,release,calls=0;
 const service=createNewsService({now:()=>NOW,watchlistDeadlineMs:15,fetchImpl:async(value,init)=>{calls++;signal=init.signal;await new Promise(resolve=>{release=resolve;});return new Response(xml([story('PTT')]));}});
 const result=await service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'A'});assert.equal(result.dataState,'unavailable');assert.equal(result.items.length,0);assert.equal(signal.aborted,true);assert.equal(calls,1);
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'B'})).items.length,0);
});
test('OR context, PTT/PTTEP boundaries, bank aliases and normalized symbols are conservative',()=>{
 assert.equal(matchesWatchlistStock({symbol:'OR'},'buy or sell stocks'),false);assert.equal(matchesWatchlistStock({symbol:'OR'},'BUY OR SELL'),false);
 for(const text of ['หุ้น OR รายงานผลประกอบการ','OR announces dividend','บริษัท ปตท. น้ำมันและการค้าปลีก เปิดเผยข้อมูล','โออาร์ รายงานข้อมูล'])assert.equal(matchesWatchlistStock({symbol:'OR'},text),true);
 assert.equal(matchesWatchlistStock({symbol:'PTTEP'},'ปตท. สผ. รายงานผลประกอบการ'),true);
 assert.equal(matchesWatchlistStock({symbol:'PTT'},'PTTEP รายงานข้อมูล'),false);assert.equal(matchesWatchlistStock({symbol:'PTT'},'ปตท.สผ. รายงานข้อมูล'),false);
 for(const [symbol,text]of [['KBANK','ธนาคารกสิกรไทย'],['BBL','ธนาคารกรุงเทพ'],['SCB','เอสซีบี เอกซ์'],['KTB','ธนาคารกรุงไทย'],['BAY','ธนาคารกรุงศรีอยุธยา'],['TTB','ทหารไทยธนชาต'],['KKP','เกียรตินาคินภัทร'],['TISCO','ทิสโก้ไฟแนนเชียลกรุ๊ป']])assert.equal(matchesWatchlistStock({symbol},text),true,symbol);
 assert.deepEqual(normalizeWatchlistNewsStocks([null,'ptt.bk',{symbol:' OR.bk '}]).map(s=>s.symbol),['OR','PTT']);
});
test('unknown-stock company names require reviewed registry provenance rather than an arbitrary client alias',async()=>{
 const stock={symbol:'XYZ',name:'Untrusted Company'},row={symbol:'XYZ',active:true,provider:'Yahoo Finance',provider_symbol:'XYZ.BK',company_name_en:'Example Manufacturing Public Company Limited',name_source:'https://www.sec.or.th/example',name_checked_at:'2026-10-01T00:00:00Z'};
 const service=createNewsService({now:()=>NOW,registrySearch:async()=>[row],fetchImpl:async()=>new Response(xml([{...story('XYZ'),title:row.company_name_en+' announces operating results'}]))});
 assert.equal((await service.getWatchlistNews([stock],{ownerId:'A'})).items.length,1);
 assert.equal(matchesWatchlistStock(stock,'Untrusted Company announces results'),false);
});

test('symbol-only stock outside the alias list uses a unique reviewed registry identity without extra RSS requests',async()=>{
 const row={symbol:'XYZ',active:true,provider:'Yahoo Finance',provider_symbol:'XYZ.BK',company_name_en:'Example Manufacturing Public Company Limited',name_source:'https://www.sec.or.th/example',name_checked_at:'2026-10-01T00:00:00Z'};
 let registryCalls=0,rssCalls=0;
 const service=createNewsService({now:()=>NOW,registrySearch:async()=>{registryCalls++;return [row];},fetchImpl:async value=>{rssCalls++;assert.ok(new URL(value).searchParams.get('q').includes(row.company_name_en));return new Response(xml([{...story('XYZ'),title:row.company_name_en+' announces operating results'}]));}});
 const result=await service.getWatchlistNews([{symbol:'XYZ'}],{ownerId:'A'});
 assert.equal(result.items.length,1);assert.deepEqual(result.items[0].matchedSymbols,['XYZ']);assert.equal(registryCalls,1);assert.equal(rssCalls,1);
});

for(const failure of ['unavailable','duplicate','timeout','incorrect-mapping','unreviewed'])test('symbol-only registry '+failure+' fails safely without trusting client aliases or retrying RSS',async()=>{
 const row={symbol:'XYZ',active:true,provider:'Yahoo Finance',provider_symbol:'XYZ.BK',company_name_en:'Example Manufacturing Public Company Limited',name_source:'https://www.sec.or.th/example',name_checked_at:'2026-10-01T00:00:00Z'};
 let registryCalls=0,rssCalls=0;
 const service=createNewsService({now:()=>NOW,registrySearch:async()=>{
  registryCalls++;
  if(failure==='unavailable')throw Error('Registry unavailable');
  if(failure==='timeout')return new Promise(()=>{});
  if(failure==='duplicate')return [row,{...row}];
  return [{...row,...(failure==='incorrect-mapping'?{provider_symbol:'OTHER.BK'}:{name_source:''})}];
 },fetchImpl:async()=>{rssCalls++;return new Response(xml([{...story('XYZ'),title:row.company_name_en+' announces operating results'}]));}});
 const result=await service.getWatchlistNews([{symbol:'XYZ'}],{ownerId:'A'});
 assert.equal(result.items.length,0);assert.equal(registryCalls,1);assert.equal(rssCalls,1);
 assert.equal(matchesWatchlistStock({symbol:'XYZ',name:row.company_name_en},row.company_name_en),false);
});
