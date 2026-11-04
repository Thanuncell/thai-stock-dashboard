'use strict';
(() => {
 const intervalMs=interval=>({'1m':60000,'5m':300000,'15m':900000,'1d':null}[interval]??null);
 function temporalBars(rows=[],{interval='1d',observedAt=null,regularEnd=null,timeZone='Asia/Bangkok'}={}){
  const observed=typeof observedAt==='number'?observedAt:Date.parse(observedAt);
  let day;
  try{day=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'});}
  const end=Number(regularEnd)>0?Number(regularEnd):null;
  return rows.map((row,i)=>{
   const time=Number(row.time),next=Number(rows[i+1]?.time),duration=intervalMs(interval);
   let availableAt=null,basis='unconfirmed';
   if(duration&&time>0){availableAt=time+duration;basis='interval-end';}
   else if(interval==='1d'&&Number.isFinite(next)&&next>time){availableAt=next;basis='next-session-observation';}
   else if(interval==='1d'&&end>time&&day.format(time)===day.format(end-1)){availableAt=end;basis='provider-session-end';}
   return {...row,interval,availableAt,complete:Number.isFinite(observed)&&availableAt!==null&&availableAt<=observed,confirmationBasis:basis};
  });
 }
 const api=Object.freeze({intervalMs,temporalBars});
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 else Object.defineProperty(globalThis,'SETscopeMarketTime',{value:api});
})();
