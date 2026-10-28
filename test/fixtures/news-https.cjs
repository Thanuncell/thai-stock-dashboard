'use strict';
const {EventEmitter}=require('node:events');
function fixtureRequest(fetchImpl) {
 return (url,options,callback)=>{
  const req=new EventEmitter(),chunks=[];
  req.setTimeout=()=>req;req.write=chunk=>chunks.push(Buffer.from(chunk));
  req.destroy=error=>{if(error)req.emit('error',error);};
  req.end=()=>{(async()=>{
   await new Promise((resolve,reject)=>options.lookup(url.hostname,{all:true},(error,addresses)=>error?reject(error):resolve(addresses)));
   const result=await fetchImpl(url,{method:options.method,headers:options.headers,body:chunks.length?Buffer.concat(chunks).toString():undefined,signal:options.signal,redirect:'manual'});
   const response=new EventEmitter();response.statusCode=result.status;response.headers=Object.fromEntries(result.headers);response.destroy=()=>{};
   callback(response);response.emit('data',Buffer.from(await result.arrayBuffer()));response.emit('end');
  })().catch(error=>req.emit('error',error));};return req;
 };
}
function installNewsHttpsFixture(fetchImpl) {
 const https=require('node:https'),dns=require('node:dns').promises,oldRequest=https.request,oldLookup=dns.lookup,stats={lookups:0,sockets:0};
 const mock=fixtureRequest(fetchImpl);
 https.request=(...args)=>{stats.sockets++;return mock(...args);};
 dns.lookup=async()=>{stats.lookups++;return [{address:'8.8.8.8',family:4}];};
 const restore=()=>{https.request=oldRequest;dns.lookup=oldLookup;};restore.stats=stats;return restore;
}
module.exports={fixtureRequest,installNewsHttpsFixture};
