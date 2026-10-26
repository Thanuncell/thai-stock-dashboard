'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_SECRET_KEY='synthetic-fixture';
const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
let registryAvailable=false,mode='403',searchCalls=0,registryReads=0,lastSignal,release;
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));assert.ok(!init.method||init.method==='GET');
 if(url.pathname==='/auth/v1/user')return Response.json({id:'fixture-owner'});
 if(url.pathname==='/rest/v1/security_coverage'){
  registryReads++;return registryAvailable?Response.json(['THAI','THANI'].map(symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified'}))):Response.json({},{status:503});
 }
 if(url.pathname==='/v1/finance/search'){
  searchCalls++;lastSignal=init.signal;
  if(mode==='timeout')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
  if(mode==='ignored-abort')return new Promise(resolve=>{release=()=>resolve(Response.json({quotes:[]}));});
  if(mode==='body-stall'){const r=Response.json({});r.json=()=>new Promise(resolve=>{release=()=>resolve({quotes:[]});});return r;}
  if(['403','429','503'].includes(mode))return Response.json({},{status:Number(mode)});
  return Response.json({quotes:[{symbol:'THAI.BK',quoteType:'EQUITY',longname:'Thai Airways'}]});
 }
 throw Error('Unexpected fixture upstream');
};
const {server}=require('../server');
function request(q){return new Promise((resolve,reject)=>{
 const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/search?q='+encodeURIComponent(q),headers:{authorization:'Bearer fixture-token'}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
 });req.on('error',reject);
});}
test.before(()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)));
test.after(async()=>{await new Promise(resolve=>server.close(resolve));Date.now=realNow;});
test('API registry unavailability does not invent matches or bypass a source denial',async()=>{
 const denied=await request('tha');assert.equal(denied.status,502);assert.deepEqual(denied.body.items,[]);assert.equal(searchCalls,1);
 mode='ok';const available=await request('thai');assert.equal(available.status,200);assert.equal(available.body.items[0].symbol,'THAI');assert.equal(registryReads,1);
 registryAvailable=true;clock+=6000;
});
test('API prefix search merges registry matches after independent registry recovery',async()=>{
 const result=await request('tha');assert.equal(result.status,200);assert.deepEqual(result.body.items.map(r=>r.symbol),['THAI','THANI']);assert.equal(registryReads,2);
});
for(const [kind,query]of [['timeout','th'],['ignored-abort','tha.bk'],['body-stall','thai.bk']])test(`API ${kind} returns registry results at the bounded enrichment deadline`,{timeout:6000},async()=>{
 mode=kind;const before=searchCalls,started=performance.now();
 const result=await request(query);const elapsed=performance.now()-started;
 assert.equal(result.status,200);assert.equal(result.body.items[0].symbol,'THAI');assert.ok(elapsed>=650&&elapsed<5000);assert.equal(lastSignal.aborted,true);assert.equal(searchCalls,before+1);
 if(release){const late=release;release=null;late();await new Promise(resolve=>setImmediate(resolve));assert.equal(searchCalls,before+1);}
});
for(const [status,query]of [['403','than'],['429','thani.bk'],['503','th.bk']])test(`API ${status} enrichment retains registry prefix/exact results without another request`,async()=>{
 mode=status;const before=searchCalls,result=await request(query);assert.equal(result.status,200);assert.ok(result.body.items.length);assert.equal(searchCalls,before+1);
});
