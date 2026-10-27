'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_SECRET_KEY='synthetic-fixture';
let calls=0,reads=0;
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));assert.ok(!init.method||init.method==='GET');
 if(url.pathname==='/auth/v1/user')return Response.json({id:'fixture-owner'});
 if(url.pathname==='/rest/v1/security_coverage'){
  reads++;assert.ok(url.searchParams.get('select').includes('company_name_en'));
  return Response.json(['AMATA','AMATAV'].map(symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified',
   ...(symbol==='AMATA'?{company_name_en:'Amata Corporation Public Company Limited',name_source:'https://licensed.example/AMATA',name_checked_at:'2026-10-25T00:00:00Z'}:{})})));
 }
 if(url.pathname==='/v1/finance/search'){calls++;return Response.json({},{status:503});}
 throw Error('Unexpected upstream');
};
const {server}=require('../server');
function request(q){return new Promise((resolve,reject)=>{
 http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/search?q='+encodeURIComponent(q),headers:{authorization:'Bearer fixture-token'}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
 }).on('error',reject);
});}
test.before(()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)));test.after(()=>new Promise(resolve=>server.close(resolve)));
test('API exact/prefix registry name survives outage and keeps shared registry cache',async()=>{
 const exact=await request('AMATA.BK');assert.equal(exact.status,200);assert.equal(exact.body.items[0].name,'Amata Corporation Public Company Limited');
 assert.equal(exact.body.items[1].symbol,'AMATAV');assert.equal(exact.body.items[1].name,'AMATAV');assert.equal(calls,0);
 const namedOnly=await request('AMATAV');assert.equal(namedOnly.status,200);assert.equal(namedOnly.body.items[0].name,'AMATAV');
 assert.equal(reads,1);assert.equal(calls,1);
 const prefix=await request('AM');assert.equal(prefix.status,200);assert.equal(prefix.body.items[0].name,exact.body.items[0].name);assert.equal(calls,2);
});
