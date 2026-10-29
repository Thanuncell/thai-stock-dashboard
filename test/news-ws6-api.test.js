'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
process.env.SETSCOPE_TEST_MODE='1';process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SECRET_KEY='synthetic';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SETSCOPE_NEWS_EVIDENCE='off';
process.env.SETSCOPE_NEWS_WORK_QUEUE='off';process.env.SETSCOPE_P1_DISPLAY_GATE='off';process.env.SETSCOPE_GOOGLE_NEWS_RPC='off';
process.env.SETSCOPE_NEWS_BANGKOKBIZNEWS='off';process.env.SETSCOPE_NEWS_THANSETTAKIJ='off';
const calls={db:0,rss:0,writes:0},date=new Date(Date.now()-60000).toISOString(),names=['กรุงเทพธุรกิจ','ฐานเศรษฐกิจ','InfoQuest'];
const rows=Array.from({length:24},(_,i)=>({fingerprint:'ws6-http-'+i,title:'PTT รายงานผลประกอบการธุรกิจ '+i,url:'https://news.google.com/rss/articles/ws6-http-'+i,source:i%3===2?'infoquest':'other',source_name:names[i%3],snippet:'บริษัทเปิดเผยข้อมูลการลงทุนและผลประกอบการตามข่าวต้นทาง',published_at:date,matched_symbols:['PTT'],broker_firms:i%3===2?['KS']:[]}));
rows.push({...rows[0],fingerprint:'duplicate',url:rows[0].url+'?utm_source=rss'});
rows.push({...rows[0],fingerprint:'pdf',url:'https://www.set.or.th/file.pdf',title:'official.pdf'});
globalThis.fetch=async(input,init={})=>{
 const u=new URL(input);if((init.method||'GET')!=='GET'){calls.writes++;throw Error('Unexpected write');}
 if(u.pathname==='/auth/v1/user')return Response.json({id:String(init.headers.Authorization).includes('token-b')?'owner-b':'owner-a'});
 if(u.pathname==='/rest/v1/news_archive'){calls.db++;return Response.json(rows,{headers:{'content-range':'0-'+(rows.length-1)+'/'+rows.length}});}
 if(u.hostname==='news.google.com'){if(u.pathname==='/rss/search')calls.rss++;return new Response('<html>Unresolved wrapper</html>',{headers:{'content-type':'text/html'}});}
 throw Error('Unexpected isolated request');
};
const restore=require('./fixtures/news-https.cjs').installNewsHttpsFixture(globalThis.fetch),{server}=require('../server');
test.before(()=>new Promise(r=>server.listen(0,'127.0.0.1',r)));test.after(async()=>{await new Promise(r=>server.close(r));restore();});
function request(query,token='token-a'){return new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:'/api/news-archive?'+query,headers:token?{authorization:'Bearer '+token}:{}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);});}
test('WS6 HTTP: union/count/page coverage is consistent and canonical equivalent selections share cached archive reads',async()=>{
 const a=await request('source=bangkokbiznews&source=thansettakij&featuredCount=5&page=2');
 assert.equal(a.status,200);assert.equal(a.body.total,11);assert.equal(a.body.matchingTotal,16);assert.equal(a.body.featured.length,5);assert.equal(a.body.page,2);assert.equal(a.body.items.length,1);assert.equal(a.body.countExact,true);assert.equal(a.body.snapshotLimit,20000);
 const b=await request('source=thansettakij,bangkokbiznews&featuredCount=5&page=2','token-b');
 assert.equal(b.body.total,a.body.total);assert.equal(calls.db,1);
 const cached=await request('source=bangkokbiznews,thansettakij&featuredCount=5&page=2');assert.equal(cached.body.cached,true);assert.equal(calls.db,1);
 const overflow=await request('source=bangkokbiznews,thansettakij&featuredCount=5&page=999');assert.equal(overflow.body.page,999);assert.equal(overflow.body.items.length,0);
 const legacy=await request('source=infoquest&page=2&pageSize=10');assert.equal(legacy.body.total,8);assert.equal(legacy.body.items.length,0);
 const empty=await request('source=infoquest&query=missing');assert.equal(empty.body.total,0);assert.equal(empty.body.page,1);assert.equal(empty.body.countExact,true);
 const denied=await request('source=infoquest','');assert.equal(denied.status,401);
 assert.equal(calls.rss,0);assert.equal(calls.writes,0);
});
