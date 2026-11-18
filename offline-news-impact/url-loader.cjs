'use strict';
// Candidate HTML transport, OFF by default. Tested exclusively with injected
// DNS/HTTP mocks. Extraction remains Jina OSS, not an Own Reader implementation.
const dns=require('node:dns').promises;
const http=require('node:http'),https=require('node:https'),net=require('node:net');
const {safeUrl,fail}=require('./reader.cjs');
const blocked=new net.BlockList();
for(const [address,prefix]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(address,prefix,'ipv4');
function publicIPv4(address){return net.isIPv4(address)&&!blocked.check(address,'ipv4');}
function createUrlLoader({enabled=false,resolve=(host)=>dns.lookup(host,{family:4,all:true,verbatim:true}),request=(url,options,callback)=>(url.protocol==='https:'?https:http).request(url,options,callback),timeoutMs=5000,maxBytes=512_000}={}){
  return async function load(value){
    if(!enabled)throw fail('READER_DISABLED');
    const deadline=Date.now()+timeoutMs;
    const remaining=()=>Math.max(1,deadline-Date.now());
    async function step(value,redirects){
      const url=new URL(safeUrl(value));
      let addresses,timer;
      try{addresses=await Promise.race([resolve(url.hostname),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('READER_TIMEOUT')),remaining());})]);}
      catch(error){throw fail(error.code==='READER_TIMEOUT'?'READER_TIMEOUT':'READER_DNS');}
      finally{clearTimeout(timer);}
      if(!Array.isArray(addresses)||!addresses.length||addresses.some(x=>!publicIPv4(x.address)))throw fail('UNSAFE_DNS');
      // Pin approved address on the actual socket; no second DNS lookup/rebinding.
      const address=addresses[0].address;
      const response=await new Promise((accept,reject)=>{
        let req,timer,settled=false;
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):accept(value);};
        timer=setTimeout(()=>{finish(fail('READER_TIMEOUT'));req?.destroy();},remaining());
        try{
          req=request(url,{method:'GET',headers:{accept:'text/html','accept-encoding':'identity','user-agent':'SETscope-Offline-Review/1.7.1'},agent:false,lookup(_host,options,callback){if(options?.all)callback(null,[{address,family:4}]);else callback(null,address,4);}},res=>{
            const status=res.statusCode;
            if([301,302,303,307,308].includes(status)){
              const location=res.headers.location;res.destroy();return finish(null,{status,location});
            }
            if(status!==200){res.destroy();return finish(null,{status});}
            if(!/^text\/html(?:;|$)/i.test(res.headers['content-type']||'')||!['','identity'].includes(res.headers['content-encoding']||'')){res.destroy();return finish(fail('READER_CONTENT_TYPE'));}
            const chunks=[];let bytes=0;
            res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){finish(fail('ARTICLE_TOO_LARGE'));res.destroy();req?.destroy();}else chunks.push(chunk);});
            res.on('end',()=>finish(null,{status,html:Buffer.concat(chunks).toString('utf8')}));
            res.on('error',()=>finish(fail('READER_UNAVAILABLE')));
            res.on('aborted',()=>finish(fail('READER_UNAVAILABLE')));
          });
          req.on('error',()=>finish(fail('READER_UNAVAILABLE')));req.end();
        }catch{finish(fail('READER_UNAVAILABLE'));}
      });
      if(response.location){
        if(redirects>=2)throw fail('READER_REDIRECT_LIMIT');
        let next;try{next=new URL(response.location,url);}catch{throw fail('INVALID_URL');}
        if(url.protocol==='https:'&&next.protocol!=='https:')throw fail('UNSAFE_URL');
        return step(safeUrl(next.href),redirects+1);
      }
      return response;
    }
    return step(value,0);
  };
}
module.exports={createUrlLoader,publicIPv4};
