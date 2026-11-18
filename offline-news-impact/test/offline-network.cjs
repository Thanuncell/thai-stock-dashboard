'use strict';
// Test process boundary only; never imported into SETscope runtime.
const allowed=host=>['127.0.0.1','localhost','::1','[::1]'].includes(host);
const check=url=>{const parsed=new URL(typeof url==='string'||url instanceof URL?url:url.url);if(!allowed(parsed.hostname))throw Error('OFFLINE_TEST_EXTERNAL_REQUEST_BLOCKED');};
const originalFetch=global.fetch;
global.fetch=function(url,...args){check(url);return originalFetch.call(this,url,...args);};
for(const protocol of ['http','https']){
 const mod=require('node:'+protocol),original=mod.request;
 mod.request=function(...args){const first=args[0];const host=typeof first==='string'||first instanceof URL?new URL(first).hostname:first?.hostname||first?.host||'localhost';if(!allowed(host))throw Error('OFFLINE_TEST_EXTERNAL_REQUEST_BLOCKED');return original.apply(this,args);};
 mod.get=function(...args){const req=mod.request(...args);req.end();return req;};
}
