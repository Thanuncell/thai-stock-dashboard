'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_SECRET_KEY='synthetic-fixture';delete process.env.OPENAI_API_KEY;
let feeds=0,registryReads=0,searchCalls=0,broken=false;
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));
 assert.ok(!init.method||init.method==='GET','this integration test must never write upstream');
 if(url.pathname==='/auth/v1/user')return Response.json({id:init.headers.Authorization?.includes('token-b')?'b':'a'});
 if(url.pathname==='/rest/v1/security_coverage'){registryReads++;return Response.json(['THAI','THANI'].map(symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified'})));}
 if(url.pathname==='/v1/finance/search'){searchCalls++;return Response.json({quotes:[{symbol:'THAI.BK',quoteType:'EQUITY',longname:'Thai Airways'}]});}
 if(url.hostname==='news.google.com'&&url.pathname==='/rss/search'){
  feeds++;return new Response(broken?'<html>temporary failure</html>':`<rss><channel><item><title>THAI รายงานผลประกอบการรอบที่ ${feeds}</title><link>https://thunhoon.com/article/story-${feeds}</link><pubDate>${new Date().toUTCString()}</pubDate><source>ทันหุ้น</source></item></channel></rss>`);
 }
 throw Error('Unexpected fixture upstream');
};
const {server}=require('../server');
function request(path,token='token-a'){
 return new Promise((resolve,reject)=>{
  const req=http.get({hostname:'127.0.0.1',port:server.address().port,path,headers:{authorization:'Bearer '+token}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
  });req.on('error',reject);
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
 const a=await request(path);assert.equal(a.status,200);const initialFeeds=feeds;
 assert.equal((await request(path)).body.items[0].title,a.body.items[0].title);assert.equal(feeds,initialFeeds);
 const b=await request(path,'token-b');assert.equal(b.status,200);assert.notEqual(b.body.items[0].title,a.body.items[0].title);
 const refreshed=await request(path+'&refresh=1');assert.equal(refreshed.status,200);assert.notEqual(refreshed.body.items[0].title,a.body.items[0].title);
 assert.equal((await request(path,'token-b')).body.items[0].title,b.body.items[0].title);
 broken=true;const stale=await request(path+'&refresh=1');assert.equal(stale.status,200);assert.equal(stale.body.stale,true);assert.equal(stale.body.items[0].title,refreshed.body.items[0].title);
});
