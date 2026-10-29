'use strict';
// Synthetic auth + localhost PostgREST only. Used by the WS7 browser integration.
const assert=require('node:assert/strict'),base=new URL(process.env.SETSCOPE_WS7_HTTP_BASE),nativeFetch=globalThis.fetch;assert.equal(base.hostname,'127.0.0.1');
process.env.SETSCOPE_TEST_MODE='1';process.env.SUPABASE_URL='https://isolation-test.supabase.co';process.env.SUPABASE_ANON_KEY='synthetic-public';process.env.SUPABASE_SECRET_KEY=process.env.SETSCOPE_WS7_HTTP_TOKEN;
process.env.SETSCOPE_NEWS_ARCHIVE_QUERY='on';process.env.SETSCOPE_NEWS_EVIDENCE='read';process.env.SETSCOPE_NEWS_WORK_QUEUE='off';process.env.SETSCOPE_P1_DISPLAY_GATE='off';process.env.SETSCOPE_GOOGLE_NEWS_RPC='off';process.env.SETSCOPE_NEWS_BANGKOKBIZNEWS='off';process.env.SETSCOPE_NEWS_THANSETTAKIJ='off';
globalThis.fetch=async(input,init={})=>{const u=new URL(input);assert.equal(u.origin,'https://isolation-test.supabase.co');if(u.pathname==='/auth/v1/user')return Response.json({id:String(init.headers.Authorization).includes('token-b')?'user-b':'user-a'});assert.ok(u.pathname.startsWith('/rest/v1/'));return nativeFetch(base.origin+u.pathname.slice('/rest/v1'.length)+u.search,init);};
require('./news-https.cjs').installNewsHttpsFixture(globalThis.fetch);
require('../../server').server.listen(Number(process.env.PORT),'127.0.0.1');
