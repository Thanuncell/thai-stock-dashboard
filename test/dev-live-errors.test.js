'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const modulePath=require.resolve('./fixtures/dev-live-errors.cjs');
const sentinel='__Host-setscope-remember=SYNTHETIC_COOKIE_SHOULD_NOT_APPEAR';
for(const kind of ['rejection','exception'])test(`Dev driver ${kind} cannot dump HTTP credentials`,()=>{
 const source=`const guard=require(${JSON.stringify(modulePath)}).installSafeDriverErrors();
   const error=Error(${JSON.stringify(sentinel)});
   ${kind==='rejection'?"Promise.reject(error);setTimeout(()=>{process.stdout.write(guard.failed()?'Failure detected safely':'Missed failure');process.exit(guard.failed()?1:0);},20);":"setImmediate(()=>{throw error;});"}`;
 const result=spawnSync(process.execPath,['-e',source],{encoding:'utf8',windowsHide:true,timeout:5000});
 assert.equal(result.status,1);
 assert.ok(!(result.stdout+result.stderr).includes(sentinel));
 assert.ok(!(result.stdout+result.stderr).includes('at '));
 assert.match(result.stdout+result.stderr,kind==='rejection'?/Failure detected safely/:/details suppressed/);
});
