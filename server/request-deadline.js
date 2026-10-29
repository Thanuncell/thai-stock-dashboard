'use strict';
const { stopped } = require('./controlled-coverage-store');
function createRequestDeadline({durationMs=120000}={}) {
  if (!Number.isInteger(durationMs)||durationMs<1||durationMs>120000) throw Error('INVALID_DEADLINE');
  const controller=new AbortController();
  const abort=()=>controller.abort(stopped('ABSOLUTE_DEADLINE_OR_CANCELLED'));
  const timer=setTimeout(abort,durationMs);
  function check(){if(controller.signal.aborted)throw controller.signal.reason;}
  const cancellations=new Set();
  const cancelAll=()=>{for(const reject of [...cancellations])reject(controller.signal.reason);};
  async function race(work) {
    check();
    let cancel;
    const cancelled=new Promise((_,reject)=>{cancel=reject;cancellations.add(cancel);});
    if(cancellations.size===1)controller.signal.addEventListener('abort',cancelAll,{once:true});
    try{return await Promise.race([Promise.resolve().then(()=>{check();return work();}),cancelled]);}
    finally{cancellations.delete(cancel);if(!cancellations.size)controller.signal.removeEventListener('abort',cancelAll);}
  }
  function wrap(fetchImpl) {
    return (input,init={})=>race(async()=>{
      check();
      const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
      const response=await fetchImpl(input,{...init,signal});
      check();
      // Include response-body reads in the same absolute deadline, not just headers.
      return new Proxy(response,{get(target,property){
        const value=Reflect.get(target,property,target);
        if(['json','text','arrayBuffer','blob','formData'].includes(property))return (...args)=>race(()=>value.apply(target,args));
        return typeof value==='function'?value.bind(target):value;
      }});
    });
  }
  async function sleep(ms){let handle;try{return await race(()=>new Promise(resolve=>{handle=setTimeout(resolve,ms);}));}finally{clearTimeout(handle);}}
  return {wrap,run:race,sleep,abort,check,signal:controller.signal,close(){clearTimeout(timer);}};
}
module.exports={createRequestDeadline};
