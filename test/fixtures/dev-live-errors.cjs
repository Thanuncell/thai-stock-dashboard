'use strict';
// Driver exceptions can contain request headers. Keep them out of all output.
function installSafeDriverErrors(){
 let rejected=false;
 const onRejected=()=>{rejected=true;};
 const onUncaught=()=>{process.stderr.write('Dev live suite aborted; details suppressed\n');process.exit(1);};
 process.on('unhandledRejection',onRejected);process.on('uncaughtException',onUncaught);
 return {failed:()=>rejected,dispose:()=>{process.off('unhandledRejection',onRejected);process.off('uncaughtException',onUncaught);}};
}
module.exports={installSafeDriverErrors};
