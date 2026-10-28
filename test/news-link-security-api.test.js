'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_SECRET_KEY='synthetic-fixture';process.env.SETSCOPE_NEWS_EVIDENCE='write';process.env.SETSCOPE_P1_DISPLAY_GATE='off';process.env.SETSCOPE_GOOGLE_NEWS_RPC='off';delete process.env.OPENAI_API_KEY;
const date=new Date(Date.now()-60000).toISOString(),publisher='https://www.set.or.th/th/market/news-and-alert/newsdetails?id=api-fixture',title='แจ้งการเลิกกิจการของบริษัทย่อย',calls=[];
globalThis.fetch=async(input,init={})=>{
 const url=new URL(input);calls.push(url.hostname+url.pathname);assert.equal(init.method||'GET','GET');
 if(url.pathname==='/auth/v1/user')return Response.json({id:String(init.headers.Authorization).includes('token-b')?'owner-b':'owner-a'});
 if(url.pathname==='/rest/v1/security_coverage')return Response.json(['PTT','OR'].map(symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified'})));
 if(url.hostname==='news.google.com'&&url.pathname==='/rss/search')return new Response('<rss><channel><item><title>'+title+'</title><link>'+publisher+'</link><pubDate>'+date+'</pubDate><source>SET</source><description>หุ้น OR และบริษัท PTT Public Company ปรากฏในข้อความ RSS แต่ Issuer จริงคือ PTT</description></item></channel></rss>');
 if(url.href===publisher)return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:publisher,headline:title,datePublished:date,articleBody:'รายละเอียดการดำเนินงานและบริษัทย่อยที่ออกประกาศจากต้นทาง '.repeat(5),about:{'@type':'Corporation',tickerSymbol:'PTT'}})+'</script>',{headers:{'content-type':'text/html'}});
 throw Error('Unexpected fixture upstream');
};
const restore=require('./fixtures/news-https.cjs').installNewsHttpsFixture(globalThis.fetch),{server}=require('../server');
test.before(()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)));test.after(async()=>{await new Promise(resolve=>server.close(resolve));restore();});
function request(symbol,token){return new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:'/api/watchlist-news?stocks='+encodeURIComponent(JSON.stringify([{symbol}])) ,headers:{authorization:'Bearer '+token}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);});}
test('authenticated HTTP Watchlist applies SET issuer scope and counts before delivery, including cached owner responses',async()=>{
 const a=await request('OR','token-a');assert.equal(a.status,200);assert.equal(a.body.total,0);assert.equal(a.body.stockStatus[0].retained,0);
 const b=await request('PTT','token-b');assert.equal(b.status,200);assert.equal(b.body.total,1);assert.equal(b.body.stockStatus[0].retained,1);assert.deepEqual(b.body.items[0].securityIdentification.symbols,['PTT']);assert.equal(b.body.items[0].verification.basis,'metadata');
 const again=await request('OR','token-a');assert.equal(again.body.total,0);assert.equal(again.body.stockStatus[0].symbol,'OR');
 assert.equal(calls.filter(x=>x==='www.set.or.th/th/market/news-and-alert/newsdetails').length,1);assert.ok(restore.stats.lookups>=1);
});
