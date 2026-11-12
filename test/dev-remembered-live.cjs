'use strict';
const {fixture,must}=require('./fixtures/dev-remembered-live.cjs');
const lifetime=604800000;
// Native unhandled rejection formatting can include HTTP credentials. Never
// serialize driver exceptions; bounded tests fail and normal cleanup still runs.
const driverErrors=require('./fixtures/dev-live-errors.cjs').installSafeDriverErrors();
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function bounded(promise){return Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('LIVE_RACE_TIMED_OUT')),12000);timer.unref();})]);}
(async()=>{
 const f=await fixture();let a,b,legacyA,legacyB,accessA;
 try{
  await f.run('Dev credential, TLS and explicit activation',async()=>{
    const client=await f.pool().connect();try{must(client.connection.stream.authorized===true,'DATABASE_TLS_REJECTED');
      const {rows:[r]}=await client.query('select ssl from pg_stat_ssl where pid=pg_backend_pid()');must(r.ssl,'DATABASE_SSL_REQUIRED');}finally{client.release();}
    must((await f.bff('/api/auth-config',{method:'GET'})).body.rememberDevice===true,'DEV_TEST_ACTIVATION_MISSING');
  });
  await f.run('Remember OFF real login and legacy Node compatibility',async()=>{
    legacyA=await f.rawLogin(0);legacyB=await f.rawLogin(1);
    must((await f.bff('/api/watchlists',{method:'GET',bearer:legacyA.access_token})).status===200,'LEGACY_NODE_DENIED');
    must((await f.data('/rest/v1/user_watchlists?select=user_id',legacyA.access_token)).status===200,'LEGACY_DATA_DENIED');
  });
  await f.run('Real Remember ON, opaque Secure HttpOnly cookie and tokenless payload',async()=>{
    a=await f.login(0);b=await f.login(1);const r=await f.row(a);accessA=f.tokens(r).access;
    must(Number(r.expires_at_ms)-Number(r.issued_at_ms)===lifetime,'ABSOLUTE_LIFETIME_INVALID');
    must(/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800$/.test(a.cookieHeader)&&a.cookieHeader.includes('Path=/'),'COOKIE_FLAGS_INVALID');
    const restored=await f.bff('/api/auth/session/restore',a);must(restored.status===200&&restored.body.user.id===a.user.id,'RESTORE_FAILED');
    must(!/access_token|refresh_token/.test(JSON.stringify(restored.body)),'TOKEN_EXPOSED');
  });
  await f.run('Node Watchlist save/load using remembered cookie',async()=>{
    const body={watchlists:[{id:'list-1',name:'Synthetic A',items:[{symbol:'PTT',name:'Synthetic'}]}],activeWatchlistId:'list-1'};
    must((await f.bff('/api/watchlists',{method:'PUT',...a,body})).status===200,'NODE_WATCHLIST_SAVE_FAILED');
    must((await f.bff('/api/watchlists',{method:'GET',...a})).body.record?.watchlists?.[0]?.name==='Synthetic A','NODE_WATCHLIST_LOAD_FAILED');
  });
  await f.run('REST SELECT INSERT PATCH UPSERT and DELETE grant enforcement',async()=>{
    const tokenB=f.tokens(await f.row(b)).access;
    const inserted=await f.data('/rest/v1/user_watchlists',tokenB,{method:'POST',body:{user_id:b.user.id,watchlists:[{id:'list-1',name:'Synthetic B',items:[]}],active_watchlist_id:'list-1'},headers:{Prefer:'return=representation'}});
    // A prior bounded run may already own this synthetic row; UPSERT is tested below.
    must([201,409].includes(inserted.status),'REST_INSERT_FAILED');
    const patched=await f.data('/rest/v1/user_watchlists?user_id=eq.'+b.user.id,tokenB,{method:'PATCH',body:{active_watchlist_id:'list-live-b'},headers:{Prefer:'return=representation'}});
    must(patched.status===200&&patched.body?.length===1,'REST_PATCH_FAILED');
    const upsert=await f.data('/rest/v1/user_watchlists?on_conflict=user_id',tokenB,{method:'POST',body:{user_id:b.user.id,watchlists:[{id:'list-1',name:'Synthetic B',items:[]}],active_watchlist_id:'list-1'},headers:{Prefer:'resolution=merge-duplicates,return=representation'}});
    must([200,201].includes(upsert.status)&&upsert.body?.length===1,'REST_UPSERT_FAILED');
    must((await f.data('/rest/v1/user_watchlists?user_id=eq.'+b.user.id,tokenB,{method:'DELETE'})).status===403,'REST_DELETE_GRANT_BYPASS');
  });
  await f.run('REST verified JWT signature, claim tamper and anonymous denial',async()=>{
    const parts=accessA.split('.');const altered=parts.slice();altered[2]=(parts[2][0]==='a'?'b':'a')+parts[2].slice(1);
    must((await f.data('/rest/v1/user_watchlists?select=user_id',altered.join('.'))).status===401,'JWT_SIGNATURE_ACCEPTED');
    const claims=JSON.parse(Buffer.from(parts[1],'base64url'));claims.sub=b.user.id;parts[1]=Buffer.from(JSON.stringify(claims)).toString('base64url');
    must((await f.data('/rest/v1/user_watchlists?select=user_id',parts.join('.'))).status===401,'JWT_CLAIM_TAMPER_ACCEPTED');
    must((await f.data('/rest/v1/user_watchlists?select=user_id')).status===401,'ANONYMOUS_ACCESS_ACCEPTED');
  });
  await f.run('RLS account A cannot read, insert or reassign account B data',async()=>{
    const r=await f.data('/rest/v1/user_watchlists?user_id=eq.'+b.user.id,accessA);must(r.status===200&&r.body?.length===0,'CROSS_ACCOUNT_READ');
    must((await f.data('/rest/v1/user_watchlists',accessA,{method:'POST',body:{user_id:b.user.id,watchlists:[]}})).status===403,'CROSS_ACCOUNT_INSERT');
    must((await f.data('/rest/v1/user_watchlists?user_id=eq.'+a.user.id,accessA,{method:'PATCH',body:{user_id:b.user.id}})).status===403,'CROSS_ACCOUNT_REASSIGN');
  });
  await f.run('Node blocks mapped Bearer even before revocation; REST allows own live session',async()=>{
    must((await f.bff('/api/watchlists',{method:'GET',bearer:accessA})).status===401,'MAPPED_NODE_BEARER_ACCEPTED');
    const r=await f.data('/rest/v1/user_watchlists?user_id=eq.'+a.user.id,accessA);must(r.status===200&&r.body?.length===1,'ACTIVE_DATA_DENIED');
  });
  await f.run('CSRF Origin, request header and session fixation protection',async()=>{
    must((await f.bff('/api/auth/session/restore',{...a,headers:{origin:'https://attacker.example.test'}})).status===403,'CROSS_ORIGIN_ACCEPTED');
    must((await f.bff('/api/auth/session/restore',{...a,headers:{'x-setscope-request':'0'}})).status===403,'CSRF_HEADER_ACCEPTED');
    must((await f.bff('/api/auth/session/refresh',{...a,generation:'invalid'})).status===401,'STALE_GENERATION_ACCEPTED');
    const replacement=await f.login(1,a);must(replacement.cookie!==a.cookie,'FIXED_COOKIE_REUSED');
    must((await f.bff('/api/auth/session/restore',a)).status===401,'PREDECESSOR_STILL_ACTIVE');a=replacement;
  });
  await f.run('Atomic concurrent real refresh, token rotation and fixed deadline',async()=>{
    const s=await f.login(0),before=await f.row(s),old=f.tokens(before);await f.expireAccess(s);
    const arrived=deferred(),release=deferred();f.state.holdRefresh=()=>{arrived.resolve();return release.promise;};
    const pending=f.bff('/api/auth/session/refresh',s);await bounded(arrived.promise);
    try{must((await f.bff('/api/auth/session/refresh',s)).status===503,'CONCURRENT_REFRESH_NOT_SERIALIZED');}finally{f.state.holdRefresh=null;release.resolve();}
    must((await pending).status===200,'REFRESH_FAILED');const after=await f.row(s);
    must(after.version===before.version+1&&f.tokens(after).refresh!==old.refresh,'ROTATION_NOT_ATOMIC');
    must(after.expires_at_ms===before.expires_at_ms,'SLIDING_EXPIRY');
  });
  await f.run('Logout wins over in-flight real refresh and same JWT replay is denied',async()=>{
    const s=await f.login(0),token=f.tokens(await f.row(s)).access;await f.expireAccess(s);
    const arrived=deferred(),release=deferred();f.state.holdRefresh=()=>{arrived.resolve();return release.promise;};
    const pending=f.bff('/api/auth/session/refresh',s);await bounded(arrived.promise);
    try{must((await f.bff('/api/auth/session/logout',s)).status===200,'LOGOUT_FAILED');}finally{f.state.holdRefresh=null;release.resolve();}
    must([401,503].includes((await pending).status),'REFRESH_REVIVED_LOGOUT');
    const row=await f.row(s);must(row.revoked_at_ms!==null&&row.encrypted===null,'REVOCATION_NOT_DURABLE');
    must((await f.bff('/api/watchlists',{method:'GET',bearer:token})).status===401,'REVOKED_NODE_BEARER_ACCEPTED');
    const rest=await f.data('/rest/v1/user_watchlists',token);must(rest.status===200&&rest.body?.length===0,'REVOKED_DATA_REPLAY_ACCEPTED');
    must((await f.data('/rest/v1/user_watchlists?on_conflict=user_id',token,{method:'POST',body:{user_id:s.user.id,watchlists:[]},headers:{Prefer:'resolution=merge-duplicates'}})).status===403,'REVOKED_DATA_WRITE_ACCEPTED');
  });
  await f.run('Absolute 168h boundary and real PostgreSQL expiry denies same JWT',async()=>{
    f.state.clock=Date.now()-lifetime+10000;let s;
    try{s=await f.login(0);}finally{f.state.clock=null;}
    const row=await f.row(s),deadline=Number(row.expires_at_ms),token=f.tokens(row).access;
    must(deadline-Number(row.issued_at_ms)===lifetime,'LIFETIME_CHANGED');
    f.state.clock=deadline-1000;must((await f.bff('/api/auth/session/restore',s)).status===200,'PRE_EXPIRY_DENIED');
    f.state.clock=deadline;must((await f.bff('/api/auth/session/restore',s)).status===401,'EXACT_EXPIRY_ACCEPTED');
    f.state.clock=deadline+1000;must((await f.bff('/api/auth/session/restore',s)).status===401,'POST_EXPIRY_ACCEPTED');f.state.clock=null;
    const wait=deadline-Date.now()+100;if(wait>0)await new Promise(r=>setTimeout(r,wait));
    const rest=await f.data('/rest/v1/user_watchlists',token);must(rest.status===200&&rest.body?.length===0,'EXPIRED_DATA_REPLAY_ACCEPTED');
  });
  await f.run('Store transport outage fails closed without Mock fallback and recovers',async()=>{
    f.state.outage=true;
    try{must((await f.bff('/api/auth/session/restore',b)).status===503,'COOKIE_OUTAGE_FAIL_OPEN');
      must((await f.bff('/api/watchlists',{method:'GET',bearer:legacyA.access_token})).status===503,'BEARER_OUTAGE_FAIL_OPEN');}
    finally{f.state.outage=false;}
    must((await f.bff('/api/auth/session/restore',b)).status===200,'STORE_RECOVERY_FAILED');
  });
  await f.run('BFF restart preserves encryption, sessions and revocation tombstones',async()=>{
    const active=await f.login(0),revoked=await f.login(1),token=f.tokens(await f.row(revoked)).access;
    must((await f.bff('/api/auth/session/logout',revoked)).status===200,'RESTART_SETUP_FAILED');await f.restart();
    must((await f.bff('/api/auth/session/restore',active)).status===200,'RESTART_RESTORE_FAILED');
    must((await f.bff('/api/auth/session/restore',revoked)).status===401,'RESTART_REVIVED_SESSION');
    must((await f.data('/rest/v1/user_watchlists',token)).body?.length===0,'RESTART_LOST_TOMBSTONE');
  });
  await f.run('Private store, RPC and effective API surface remain restricted',async()=>{
    must((await f.data('/rest/v1/remembered_sessions',legacyA.access_token,{headers:{'Accept-Profile':'setscope_private'}})).status===406,'PRIVATE_SCHEMA_EXPOSED');
    must((await f.data('/rest/v1/rpc/watchlist_session_allowed',legacyA.access_token,{method:'POST',body:{sid:'invalid',subject:legacyA.user.id}})).status===404,'PRIVATE_RPC_EXPOSED');
    const {rows:[r]}=await f.pool().query("select count(*)::int as views from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m') and has_table_privilege('authenticated',c.oid,'SELECT')");must(r.views===0,'UNREVIEWED_API_VIEW');
  });
  if(!process.argv.includes('--skip-browser'))await require('./dev-remembered-live-browser.cjs')(f);
  await f.run('Disable issuance keeps revocation guard and legacy login compatible',async()=>{
    const s=await f.login(0),token=f.tokens(await f.row(s)).access;await f.bff('/api/auth/session/logout',s);await f.restart(false);
    must((await f.bff('/api/auth-config',{method:'GET'})).body.rememberDevice!==true,'ROLLBACK_FLAG_ENABLED');
    must((await f.bff('/api/watchlists',{method:'GET',bearer:token})).status===401,'ROLLBACK_BEARER_BYPASS');
    must((await f.data('/rest/v1/user_watchlists',token)).body?.length===0,'ROLLBACK_DATA_BYPASS');
    must((await f.bff('/api/watchlists',{method:'GET',bearer:legacyA.access_token})).status===200,'ROLLBACK_LEGACY_REGRESSION');
  });
  f.notRun('Cloud PostgreSQL restart and actual cloud outage','No cloud restart/infrastructure change authorized; BFF transport failure and restart tested separately');
  f.notRun('GraphQL','Dev preflight reported pg_graphql absent; no extension changes authorized');
  f.notRun('Recovery email delivery and confirmed self-registration','No synthetic mailbox or Dev admin key; existing confirmed users supplied by Owner');
  await f.run('No credentials, tokens or session handles exposed in runtime/browser logs',async()=>must(f.logsSafe(),'SECRET_LOGGING_DETECTED'));
  await f.run('No unexpected asynchronous driver failure',async()=>must(!driverErrors.failed(),'ASYNC_DRIVER_FAILURE'));
 }finally{f.state.clock=null;await f.close();f.persist();}
 const failures=f.results.filter(r=>r.status==='FAIL').length;console.log(JSON.stringify({pass:f.results.filter(r=>r.status==='PASS').length,fail:failures,notRun:f.results.filter(r=>r.status==='NOT RUN').length}));if(failures)process.exitCode=1;driverErrors.dispose();
})().catch(()=>{console.error('Dev live suite could not complete; secret details suppressed');process.exitCode=1;});
