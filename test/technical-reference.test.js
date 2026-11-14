'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./fixtures/technical-reference.json');
for(const entry of fixture.cases)test(`locked independent TA-Lib reference: ${entry.name}`,async()=>{
 const {computeTechnicalSeries}=await import('../client/domain.mjs');
 const actual=computeTechnicalSeries(entry.rows);let compared=0;
 const compare=(got,want,path)=>{
  if(Array.isArray(want)){assert.equal(got.length,want.length,path);want.forEach((v,i)=>{if(v===null)assert.equal(got[i],null,`${path}[${i}] warm-up`);else {assert.ok(Number.isFinite(got[i]),path);assert.ok(Math.abs(got[i]-v)<=1e-8*Math.max(1,Math.abs(v)),`${path}[${i}] ${got[i]} != ${v}`);compared++;}});}
  else for(const [key,value]of Object.entries(want))compare(got[key],value,path+'.'+key);
 };
 compare(actual,entry.expected,entry.name);assert.ok(compared>2000);
});

// Keep the locked independent OHLCV/expected values; retime only the daily samples.
// Sparse W/M samples produce one real sample per bucket, never invented prices.
const {historyBars,observedAt}=require('./fixtures/daily-ohlcv.cjs');
async function g3Snapshot(entry,timeframe,count=entry.rows.length,parameters={}){
 const {marketTimeframe}=await import('../client/chart-timeframe.mjs');
 const {createTechnicalSnapshot}=await import('../client/technical.mjs');
 const dailyDates=historyBars(entry.rows.length,'2026-10-30');
 const rows=entry.rows.slice(0,count).map((row,index)=>{
  const date=timeframe==='D'?dailyDates[index].time:timeframe==='W'
   ?historyBars(1,new Date(Date.UTC(2026,9,30)-(entry.rows.length-1-index)*7*86400000).toISOString().slice(0,10))[0].time
   :historyBars(1,new Date(Date.UTC(2005,index,15)).toISOString().slice(0,10))[0].time;
  return {...row,time:date};
 });
 const last=rows.at(-1)?.time;
 const meta={provider:'Yahoo Finance',interval:'1d',timeZone:'Asia/Bangkok',receivedAt:new Date(observedAt).toISOString(),
  regularStart:last??null,regularEnd:last?last+6.5*3600000:null};
 const market={history:rows,indicatorHistory:rows,levelsHistory:rows,fetchedAt:meta.receivedAt,dataState:'delayed',
  technicalMeta:{history:meta,indicator:meta,levels:meta}};
 const projected=marketTimeframe(market,timeframe,'ALL');
 return {snapshot:createTechnicalSnapshot({...projected,symbol:'PTT',timeframe,parameters}),projected};
}
function compareG3Reference(got,want,label){
 if(Array.isArray(want)){
  assert.equal(got.length,want.length,label);
  want.forEach((value,index)=>value===null?assert.equal(got[index],null,`${label}[${index}] warm-up`)
   :assert.ok(Number.isFinite(got[index])&&Math.abs(got[index]-value)<=1e-8*Math.max(1,Math.abs(value)),`${label}[${index}]`));
 }else for(const[key,value]of Object.entries(want))compareG3Reference(got[key],value,label+'.'+key);
}
for(const timeframe of ['D','W','M']){
 for(const entry of fixture.cases)test(`G3 ${timeframe} selected OHLCV matches independent six-indicator reference: ${entry.name}`,async()=>{
  const {snapshot,projected}=await g3Snapshot(entry,timeframe);
  const ohlcv=({open,high,low,close,volume})=>({open,high,low,close,volume});
  assert.deepEqual(projected.history.map(ohlcv),entry.rows.map(ohlcv));
  assert.equal(snapshot.timeframe,timeframe);assert.equal(snapshot.signalRows.length,entry.rows.length);
  assert.ok(snapshot.signalRows.every(row=>row.interval===({D:'1d',W:'1wk',M:'1mo'}[timeframe])));
  compareG3Reference(snapshot.signalSeries,entry.expected,timeframe+'.'+entry.name);
 });
 test(`G3 ${timeframe} warm-up boundaries and insufficient states match independent reference`,async()=>{
  const entry=fixture.cases.find(item=>item.name==='volatile');
  const required={sma20:20,ema20:20,ema50:50,ema100:100,ema200:200,rsi:15,macd:34,bb:20,atr:15};
  for(const count of [0,1,14,15,19,20,33,34,49,50,99,100,199,200]){
   const {snapshot}=await g3Snapshot(entry,timeframe,count);
   const expected=Object.fromEntries(Object.entries(entry.expected).map(([key,value])=>[key,Array.isArray(value)?value.slice(0,count)
    :Object.fromEntries(Object.entries(value).map(([part,values])=>[part,values.slice(0,count)]))]));
   compareG3Reference(snapshot.signalSeries,expected,timeframe+'.'+count);
   for(const[key,bars]of Object.entries(required))assert.equal(snapshot.availability[key].state,count>=bars?'available':'insufficient',`${timeframe} ${key} ${count}`);
   if(count<34){assert.equal(snapshot.summary.status,'insufficient');assert.equal(snapshot.summary.actionable,false);}
  }
 });
 test(`G3 ${timeframe} parameter change and reset reuse the locked EMA reference`,async()=>{
  const entry=fixture.cases.find(item=>item.name==='volatile');
  const initial=(await g3Snapshot(entry,timeframe)).snapshot;
  const changed=(await g3Snapshot(entry,timeframe,entry.rows.length,{ema20:100})).snapshot;
  assert.notEqual(changed.id,initial.id);assert.equal(changed.parameters.ema20,100);
  compareG3Reference(changed.signalSeries,{...entry.expected,ema20:entry.expected.ema100},timeframe+'.EMA100');
  const reset=(await g3Snapshot(entry,timeframe)).snapshot;
  assert.equal(reset.id,initial.id);compareG3Reference(reset.signalSeries,entry.expected,timeframe+'.reset');
 });
}
