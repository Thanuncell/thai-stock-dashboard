'use strict';
// Copy of existing test fixtureStore contract, plus existing provider/auth service.
// Test-only in-memory sessions; never source/store a real key, cookie or token.
const {randomBytes}=require('node:crypto');
const {Readable}=require('node:stream');
const {fixture,origin,upstream,browserHeaders,owners}=require('../../test/fixtures/remembered-session.cjs');
const {createAuthService}=require('../../server/auth-service.js');
const {handle}=require('../../server.js');
function fixtureStore(state) {
  const active = (row, now) => row?.revokedAt === null && row.expiresAt > now;
  function available() {
    if (state.offline) throw Error('Fixture store unavailable');
  }
  return {
    find(digest) { available(); return structuredClone(state.rows[digest] || null); },
    hasProviderSession(sessionId) {
      available();
      return Object.values(state.rows).some(row => row.providerSessionId === sessionId);
    },
    issue(record, predecessor) {
      available();
      if (this.hasProviderSession(record.providerSessionId)) return false;
      if (predecessor && !active(state.rows[predecessor], record.issuedAt)) return false;
      if (predecessor) this.revoke(predecessor, record.issuedAt);
      state.rows[record.digest] = structuredClone(record);
      return true;
    },
    acquireRefresh(digest, version, lease, now) {
      available();
      const row = state.rows[digest];
      if (!active(row, now) || row.version !== version || row.lease) return false;
      row.lease = lease;
      return true;
    },
    finishRefresh(digest, version, leaseId, update, now) {
      available();
      if (state.failFinish) throw Error('Fixture rotation write unavailable');
      const row = state.rows[digest];
      if (!active(row, now) || row.version !== version || row.lease?.id !== leaseId || row.lease.until <= now) return false;
      Object.assign(row, update, { version: version + 1, lease: null });
      return true;
    },
    revoke(digest, now, leaseId) {
      available();
      const row = state.rows[digest];
      if (!row || row.revokedAt !== null || (leaseId && row.lease?.id !== leaseId)) return false;
      Object.assign(row, { revokedAt: now, lease: null, encrypted: null, version: row.version + 1 });
      return true;
    }
  };
}

function rememberedRuntime(impact){
 const f=fixture(),store=fixtureStore(f.state);
 const auth=createAuthService({env:{SUPABASE_URL:upstream,SUPABASE_ANON_KEY:'fixture-public'},fetchImpl:f.fetchProvider,remembered:{store,key:randomBytes(32),origin,now:f.now,allowIssue:true,dataApiGuardVerified:true},send(res,status,body,headers){res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(body));}});
 async function request(url,{method='GET',headers={},body}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  const result={headers:{}};const res={setHeader(name,value){result.headers[name]=value;},getHeader(name){return result.headers[name];},writeHead(status,values){result.status=status;Object.assign(result.headers,values);},once(){},end(data){try{result.body=JSON.parse(data);}catch{result.body=data;}}};
  await handle(req,res,auth,impact);return result;
 }
 async function login(owner='a'){const response=await request('/api/auth/session/login',{method:'POST',headers:{...browserHeaders,'content-type':'application/json'},body:{email:owner+'@example.test',password:'fixture-password',rememberDevice:true}});return{response,cookie:response.headers['set-cookie']?.split(';')[0],generation:response.body?.generation};}
 const sessionHeaders=session=>({...browserHeaders,cookie:session.cookie,'x-setscope-session':session.generation,'content-type':'application/json'});
 return{f,request,login,sessionHeaders,owners};
}
module.exports={rememberedRuntime};
