'use strict';
// TEST PROFILE ONLY: transport mocks; reuse the real existing auth verifier.
const {createAuthService}=require('../../server/auth-service.js');
function createFixtureAuth(){
  const fixture={calls:0,denyNext:false};
  const auth=createAuthService({env:{SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture'},fetchImpl:async(_url,options)=>{
    fixture.calls++;if(fixture.denyNext){fixture.denyNext=false;return Response.json({error:'expired fixture session'},{status:401});}
    const token=String(options.headers.Authorization||'').replace(/^Bearer /,'');
    const id=['token-a','token-a-refreshed'].includes(token)?'user-a':token==='token-b'?'user-b':null;
    return Response.json(id?{id,email:`${id}@example.test`}:{error:'Invalid fixture session'},{status:id?200:401});
  },send(res,status,value){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({...value,code:status===401?'UNAUTHORIZED':'AUTH_UNAVAILABLE'}));}});
  return Object.assign(auth,{fixture});
}
module.exports={createFixtureAuth};
