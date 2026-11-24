'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {encodeNewsArchiveCursor,decodeNewsArchiveCursor}=require('../server/news-archive-cursor');
const scope=JSON.stringify({query:'PTT',source:'settrade',excluded:['abc']});

test('cursor is opaque and roundtrips the exact microsecond timestamp and order ID',()=>{
 const value={publishedAt:'2026-11-23T12:30:42.123456+00:00',id:'123456789',scope,indexRevision:'7'};
 const token=encodeNewsArchiveCursor(value);
 assert.match(token,/^[A-Za-z0-9_-]+$/);
 assert.deepEqual(decodeNewsArchiveCursor(token,{scope,indexRevision:'7'}),{publishedAt:value.publishedAt,id:value.id});
});

test('changing query/filter/exclusions invalidates a cross-scope cursor',()=>{
 const token=encodeNewsArchiveCursor({publishedAt:'2026-11-23T12:00:00Z',id:'42',scope,indexRevision:1});
 assert.throws(()=>decodeNewsArchiveCursor(token,{scope:scope+'changed',indexRevision:1}),/SCOPE_CHANGED/);
});

test('changed derived index revision invalidates old pagination position',()=>{
 const token=encodeNewsArchiveCursor({publishedAt:'2026-11-23T12:00:00Z',id:'42',scope,indexRevision:1});
 assert.throws(()=>decodeNewsArchiveCursor(token,{scope,indexRevision:2}),/INDEX_CHANGED/);
});

test('reject empty, excessive and malformed inputs without turning failure into empty results',()=>{
 for(const token of ['', 'evil!', 'a'.repeat(513),Buffer.from('{bad').toString('base64url')]){
  assert.throws(()=>decodeNewsArchiveCursor(token,{scope,indexRevision:1}),/CURSOR_INVALID/);
 }
 assert.throws(()=>encodeNewsArchiveCursor({publishedAt:'bogus',id:'1',scope,indexRevision:1}),/INVALID/);
});

test('reject lossy precision, rolled calendar dates and out-of-range PostgreSQL keys',()=>{
 const value={publishedAt:'2026-11-23T12:30:42.123456Z',id:'9223372036854775807',scope,indexRevision:'7'};
 for(const publishedAt of ['2026-02-30T12:00:00Z','2026-11-23','2026-11-23T24:00:00Z','2026-11-23T12:00:00.1234567Z','2026-11-23T12:00:00+15:00'])
   assert.throws(()=>encodeNewsArchiveCursor({...value,publishedAt}),/INVALID/);
 for(const id of ['0','01','-1','9223372036854775808','1e3'])assert.throws(()=>encodeNewsArchiveCursor({...value,id}),/INVALID/);
 for(const indexRevision of ['','-1','bogus','9223372036854775808'])assert.throws(()=>encodeNewsArchiveCursor({...value,indexRevision}),/INVALID/);
 const token=encodeNewsArchiveCursor(value);const parsed=JSON.parse(Buffer.from(token,'base64url'));
 for(const changed of [{...parsed,t:'2026-02-30T12:00:00Z'},{...parsed,i:'9223372036854775808'},{...parsed,r:'NaN'},{...parsed,extra:true}])
   assert.throws(()=>decodeNewsArchiveCursor(Buffer.from(JSON.stringify(changed)).toString('base64url'),{scope,indexRevision:'7'}),/INVALID/);
 assert.deepEqual(decodeNewsArchiveCursor(token,{scope,indexRevision:'7'}),{publishedAt:value.publishedAt,id:value.id});
});

test('sub-millisecond boundaries survive tokens without collapsing to the same position',()=>{
 for(const fraction of ['123001','123002','123999']){
   const publishedAt='2026-11-23T12:00:00.'+fraction+'+07:00';
   const token=encodeNewsArchiveCursor({publishedAt,id:'1',scope,indexRevision:'0'});
   assert.equal(decodeNewsArchiveCursor(token,{scope,indexRevision:'0'}).publishedAt,publishedAt);
 }
});

test('explicit cursor requests cannot silently execute the OFFSET RPC or snapshot',async()=>{
 const {createNewsArchiveService}=require('../server/news-archive-service');
 for(const enabled of ['on','off']){
   let calls=0;const service=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:enabled},fetchImpl:async(url)=>{calls++;assert.match(String(url),/rpc\/list_news_archive_cursor$/);return Response.json({code:'PGRST202'},{status:404});}});
   await assert.rejects(service.list({pagination:'cursor'}),/NEWS_ARCHIVE_CURSOR_RPC_REQUIRED/);
   assert.equal(calls,enabled==='on'?1:0);
 }
});

test('native context and ordinal/position tokens resist edits and retire on process codec restart',()=>{
 const {createNewsArchiveCursorCodec}=require('../server/news-archive-cursor'),codec=createNewsArchiveCursorCodec();
 const value={s:'scope-digest',r:'12',i:'9',t:'2026-11-23T12:00:00Z',f:Array.from({length:5},(_,i)=>String(i).repeat(64))};
 const context=codec.context(value);assert.deepEqual(codec.readContext(context),value);assert.ok(context.length<2048);
 const token=codec.position({publishedAt:'2026-11-23T12:30:42.123456+00:00',id:'9223372036854775807',page:5},'bound-context');
 assert.ok(token.length<512);assert.deepEqual(codec.readPosition(token,'bound-context'),{publishedAt:'2026-11-23T12:30:42.123456+00:00',id:'9223372036854775807',page:5});
 const parts=token.split('.'),payload=JSON.parse(Buffer.from(parts[1],'base64url'));payload.p=500;
 parts[1]=Buffer.from(JSON.stringify(payload)).toString('base64url');assert.throws(()=>codec.readPosition(parts.join('.'),'bound-context'),/INVALID/);
 assert.throws(()=>codec.readPosition(token,'other-context'),/SCOPE_CHANGED/);
 assert.throws(()=>createNewsArchiveCursorCodec().readContext(context),/INVALID/);
});
