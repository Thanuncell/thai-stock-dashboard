'use strict';
const https=require('node:https'),dns=require('node:dns').promises,net=require('node:net');
const {allowedNewsUrl}=require('./news-policy');
function publicNewsAddress(address) {
 const family=net.isIP(address);
 if(family===4){
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31
   ||a===192&&b===168||a===100&&b>=64&&b<=127||a===192&&b===0||a===192&&b===88&&c===99
   ||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
 }
 if(family===6){
  const lower=address.toLowerCase(),first=parseInt(lower.split(':')[0],16);
  return first>=0x2000&&first<=0x3fff&&!/^2001:(?:0*:|db8:)/.test(lower)&&!/^2002:|^3fff:/.test(lower);
 }
 return false;
}
async function publicNewsLookup(host,lookup=dns.lookup) {
 const addresses=await lookup(host,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(x=>!publicNewsAddress(x.address)))throw Error('NEWS_PRIVATE_ADDRESS');
 return addresses;
}
function createNewsTransport({lookup=dns.lookup,requestImpl=https.request,allowBangkok=process.env.SETSCOPE_NEWS_BANGKOKBIZNEWS==='on',allowPrachachat=process.env.SETSCOPE_NEWS_PRACHACHAT==='on'}={}) {
 return async function request(value,init={}) {
  const url=allowedNewsUrl(value);if(!url)throw Error('NEWS_UNSAFE_URL');
  if(!allowBangkok&&/(?:^|\.)bangkokbiznews\.com$/.test(url.hostname))throw Error('NEWS_OPTIONAL_SOURCE_DISABLED');
  if(!allowPrachachat&&/(?:^|\.)prachachat\.net$/.test(url.hostname))throw Error('NEWS_OPTIONAL_SOURCE_DISABLED');
  const {maxBytes=256000,...options}=init;
  const signal=options.signal||AbortSignal.timeout(7000);options.signal=signal;
  if(signal.aborted)throw Error('NEWS_REQUEST_ABORTED');
  let abort;
  const cancelled=new Promise((_,reject)=>{abort=()=>reject(Error('NEWS_REQUEST_ABORTED'));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
  let addresses;
  try{addresses=await Promise.race([publicNewsLookup(url.hostname,lookup),cancelled]);}
  finally{signal.removeEventListener('abort',abort);}
  if(signal.aborted)throw Error('NEWS_REQUEST_ABORTED');
  return new Promise((resolve,reject)=>{
   const req=requestImpl(url,{method:options.method||'GET',headers:options.headers,signal:options.signal,
    lookup:(_host,opts,done)=>opts.all?done(null,addresses):done(null,addresses[0].address,addresses[0].family)},res=>{
    if(res.headers['content-encoding']&&!/^identity$/i.test(res.headers['content-encoding'])){res.destroy();reject(Error('NEWS_ENCODING_UNSUPPORTED'));return;}
    const chunks=[];let size=0,finished=false;
    const finish=()=>{if(finished)return;finished=true;const headers=Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):String(v)]));
     resolve(new Response([204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers}));};
    res.on('data',chunk=>{const part=chunk.subarray(0,Math.max(0,maxBytes-size));chunks.push(part);size+=part.length;if(size>=maxBytes){finish();res.destroy();}});
    res.on('end',finish);res.on('error',error=>{if(!finished)reject(error);});
   });
   req.on('error',reject);req.setTimeout(7000,()=>req.destroy(Error('NEWS_REQUEST_TIMEOUT')));
   if(options.body)req.write(String(options.body));req.end();
  });
 };
}
module.exports={publicNewsAddress,publicNewsLookup,createNewsTransport};
