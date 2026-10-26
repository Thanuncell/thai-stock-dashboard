'use strict';
const { stopped } = require('./controlled-coverage-store');
function createRequestDeadline({durationMs=120000}={}) {
  if (!Number.isInteger(durationMs)||durationMs<1||durationMs>120000) throw Error('INVALID_DEADLINE');
  const controller=new AbortController();
  const abort=()=>controller.abort(stopped('ABSOLUTE_DEADLINE_OR_CANCELLED'));
  const timer=setTimeout(abort,durationMs);
  function check(){if(controller.signal.aborted)throw controller.signal.reason;}
  async function race(work) {
    check();
    let listener;
    const cancelled=new Promise((_,reject)=>{listener=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',listener,{once:true});});
    try{return await Promise.race([Promise.resolve().then(work),cancelled]);}
    finally{controller.signal.removeEventListener('abort',listener);}
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
  function sleep(ms){return race(()=>new Promise(resolve=>{
    const handle=setTimeout(done,ms);
    function done(){clearTimeout(handle);controller.signal.removeEventListener('abort',done);resolve();}
    controller.signal.addEventListener('abort',done,{once:true});
  }));}
  return {wrap,run:race,sleep,abort,check,signal:controller.signal,close(){clearTimeout(timer);}};
}
module.exports={createRequestDeadline};
