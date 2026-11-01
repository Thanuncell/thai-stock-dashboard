'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_SECRET_KEY='synthetic-fixture';delete process.env.OPENAI_API_KEY;
process.env.SETSCOPE_NEWS_EVIDENCE='write';process.env.SETSCOPE_P1_DISPLAY_GATE='on';
let feeds=0,registryReads=0,searchCalls=0,broken=false;
const publicProviderRequests=[];
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));
 if(['news.google.com','query1.finance.yahoo.com'].includes(url.hostname))publicProviderRequests.push({url:url.href,headers:init.headers,body:init.body});
 assert.ok(!init.method||init.method==='GET','this integration test must never write upstream');
 if(url.pathname==='/auth/v1/user')return init.headers.Authorization?.includes('invalid-token')?Response.json({error:'fixture-private-auth'},{status:401}):Response.json({id:init.headers.Authorization?.includes('token-b')?'b':'a'});
 if(url.pathname==='/rest/v1/security_coverage'){registryReads++;return Response.json(['THAI','THANI'].map(symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified'})));}
 if(url.pathname==='/v1/finance/search'){searchCalls++;return Response.json({quotes:[{symbol:'THAI.BK',quoteType:'EQUITY',longname:'Thai Airways'}]});}
 if(url.hostname==='news.google.com'&&url.pathname==='/rss/search'){
  feeds++;return new Response(broken?'<html>temporary failure</html>':`<rss><channel><item><title>THAI รายงานผลประกอบการรอบที่ ${feeds}</title><link>https://thunhoon.com/article/story-${feeds}</link><pubDate>${new Date().toUTCString()}</pubDate><source>ทันหุ้น</source></item></channel></rss>`);
 }
 if(url.hostname==='thunhoon.com'){
  const id=url.pathname.split('-').at(-1),title='THAI รายงานผลประกอบการรอบที่ '+id;
  return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:url.href,headline:title,datePublished:new Date().toISOString(),articleBody:('THAI disclosed operating results and investment plans. ').repeat(5)})+'</script>',{headers:{'content-type':'text/html'}});
 }
 throw Error('Unexpected fixture upstream');
};
const restoreNewsHttps=require('./fixtures/news-https.cjs').installNewsHttpsFixture(globalThis.fetch);
test.after(restoreNewsHttps);
const {server}=require('../server');
function request(path,token='token-a',{method='GET',body,headers={}}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{authorization:'Bearer '+token,...headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks))}));
  });req.on('error',reject);if(body)req.write(body);req.end();
 });
}
test.before(()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)));
test.after(()=>new Promise(resolve=>server.close(resolve)));
test('Search API returns both prefix identities and caches the shared registry snapshot',async()=>{
 const result=await request('/api/search?q=tha');assert.equal(result.status,200);assert.deepEqual(result.body.items.map(r=>r.symbol),['THAI','THANI']);
 await request('/api/search?q=THA');assert.equal(registryReads,1);assert.equal(searchCalls,1);
});
test('Watchlist News API isolates account caches, refreshes explicitly and retains malformed-feed fallback for the same owner only',async()=>{
 const path='/api/watchlist-news?stocks='+encodeURIComponent(JSON.stringify([{symbol:'THAI',name:'THAI'}]));
 const a=await request(path);assert.equal(a.status,200);assert.ok(restoreNewsHttps.stats.lookups>0);assert.ok(restoreNewsHttps.stats.sockets>0);const initialFeeds=feeds;
 assert.equal((await request(path)).body.items[0].title,a.body.items[0].title);assert.equal(feeds,initialFeeds);
 const b=await request(path,'token-b');assert.equal(b.status,200);assert.notEqual(b.body.items[0].title,a.body.items[0].title);
 const refreshed=await request('/api/watchlist-news','token-a',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stocks:[{symbol:'THAI'}],refresh:true})});assert.equal(refreshed.status,200);assert.equal(refreshed.body.items.length,2);assert.ok(refreshed.body.items.some(item=>item.title!==a.body.items[0].title));
 assert.equal((await request(path,'token-b')).body.items[0].title,b.body.items[0].title);
 broken=true;const stale=await request(path+'&refresh=1');assert.equal(stale.status,200);assert.equal(stale.body.stale,true);assert.equal(stale.body.items[0].title,refreshed.body.items[0].title);
});

test('Watchlist News POST shares the compatible owner cache and drops private aliases from requests and logs',async()=>{
 const path='/api/watchlist-news',legacy=path+'?symbols=THAI';
 const a=await request(legacy),b=await request(legacy,'token-b'),before=feeds;
 const logs=[],original=console.info;console.info=line=>logs.push(String(line));
 try {
  for(const [token,expected]of [['token-a',a],['token-b',b]]){
   const result=await request(path,token,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    stocks:[{symbol:'THAI',name:'fixture-private-alias'}],user_id:'forged-owner',watchlistId:'fixture-private-list'
   })});
   assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');assert.deepEqual(result.body,expected.body);
  }
  assert.equal(feeds,before,'GET/POST must reuse the same owner cache without more provider calls');
  assert.notDeepEqual(a.body.items,b.body.items,'owner cache contents must remain separate');
  assert.doesNotMatch(logs.join('\n'),/fixture-private|forged-owner|token-a|token-b/);
 }finally{console.info=original;}
 for(const call of publicProviderRequests){
  assert.doesNotMatch(call.url,/fixture-private|forged-owner|token-a|token-b/);
  const headers=new Headers(call.headers);assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
  assert.equal(call.body,undefined);
 }
});

test('Watchlist News POST validates method/body and fails closed for invalid tokens',async()=>{
 const path='/api/watchlist-news',headers={'content-type':'application/json'};
 for(const [options,status]of [
  [{method:'DELETE'},405],[{method:'POST',body:'{}'},415],
  [{method:'POST',headers,body:'{'},400],[{method:'POST',headers,body:'{"stocks":{},"refresh":true}'},400],
  [{method:'POST',headers,body:'{"stocks":[],"refresh":"true"}'},400]
 ])assert.equal((await request(path,'token-a',options)).status,status);
 const before=feeds;
 const invalid=await request(path,'invalid-token',{method:'POST',headers,body:'{"stocks":[{"symbol":"THAI"}]}'});
 assert.equal(invalid.status,401);assert.equal(invalid.headers['cache-control'],'no-store');assert.equal(feeds,before);
 assert.doesNotMatch(JSON.stringify(invalid.body),/fixture-private|invalid-token/);
});
