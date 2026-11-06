'use strict';
(() => {
 const intervalMs=interval=>({'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'60m':3600000,'1d':null}[interval]??null);
 function temporalBars(rows=[],{interval='1d',observedAt=null,regularStart=null,regularEnd=null,timeZone='Asia/Bangkok'}={}){
  const observed=typeof observedAt==='number'?observedAt:Date.parse(observedAt);
  let day;
  try{day=new Intl.DateTimeFormat('en-CA',{timeZone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit'});}catch{day=null;}
  const dates=new Map(),sessionDate=value=>{
   if(!dates.has(value)){const p=Object.fromEntries(day.formatToParts(value).map(part=>[part.type,part.value]));dates.set(value,Number(p.year)*10000+Number(p.month)*100+Number(p.day));}
   return dates.get(value);
  };
  const start=Number(regularStart)>0?Number(regularStart):null;
  const end=Number(regularEnd)>0?Number(regularEnd):null;
  return rows.map((row,i)=>{
   const time=Number(row.time),next=Number(rows[i+1]?.time),duration=intervalMs(interval);
   let availableAt=null,barCloseTime=null,basis='unconfirmed';
   if(duration&&time>0){
    const sessionEnd=row.sessionEnd;
    const closesAtSessionEnd=(interval==='30m'||interval==='60m')&&row.sessionStatus==='SESSION_VERIFIED'
     &&day&&Number.isFinite(sessionEnd)
     &&sessionEnd>time&&sessionEnd<time+duration&&sessionDate(time)===sessionDate(sessionEnd-1);
    availableAt=barCloseTime=closesAtSessionEnd?sessionEnd:time+duration;
    basis=closesAtSessionEnd?'provider-session-end':'interval-end';
   }
   else if(interval==='1d'&&day&&end>time&&sessionDate(time)===sessionDate(end-1)
    &&(start===null||start<=time&&start<end&&sessionDate(start)===sessionDate(time))){availableAt=barCloseTime=end;basis='provider-session-end';}
   else if(interval==='1d'&&day&&Number.isFinite(next)&&next>time&&sessionDate(next)>sessionDate(time)){availableAt=next;basis='next-session-observation';}
   const complete=Number.isFinite(observed)&&observed>0&&availableAt!==null&&availableAt<=observed;
   const unconfirmedReason=complete?null:!Number.isFinite(observed)||observed<=0?'received-time-unavailable':availableAt!==null?'awaiting-availability':!day?'invalid-exchange-timezone':end===null?'session-end-unavailable':start!==null&&(start>time||start>=end)?'session-bounds-invalid':'session-date-mismatch';
   return {...row,interval,barOpenTime:time,barCloseTime,availableAt,complete,confirmed:complete,confirmationBasis:basis,unconfirmedReason};
  });
 }
 const api=Object.freeze({intervalMs,temporalBars});
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 else Object.defineProperty(globalThis,'SETscopeMarketTime',{value:api});
})();
