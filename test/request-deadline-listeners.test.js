'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{getEventListeners}=require('node:events');
const {createRequestDeadline}=require('../server/request-deadline');
test('R1: concurrent operations share one cancellation listener and release every subscription',async()=>{
 const d=createRequestDeadline();let release;const held=new Promise(r=>release=r);
 try{const pending=Array.from({length:64},()=>d.run(()=>held));assert.equal(getEventListeners(d.signal,'abort').length,1);release();await Promise.all(pending);assert.equal(getEventListeners(d.signal,'abort').length,0);}finally{d.close();}
});
test('R1: cancellation reaches all pending work and sleep without accumulating listeners',async()=>{
 const d=createRequestDeadline();
 try{const pending=Array.from({length:32},()=>d.sleep(10000));assert.equal(getEventListeners(d.signal,'abort').length,1);d.abort();const done=await Promise.allSettled(pending);assert.ok(done.every(x=>x.status==='rejected'));assert.equal(getEventListeners(d.signal,'abort').length,0);}finally{d.close();}
});
test('R1: already aborted work cannot start a provider or timer',async()=>{
 const d=createRequestDeadline();let ran=false;try{d.abort();await assert.rejects(d.run(()=>{ran=true;}));assert.equal(ran,false);}finally{d.close();}
});
