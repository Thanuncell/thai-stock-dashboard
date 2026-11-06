'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {temporalBars}=require('../lib/market-time');
const {createMarketService}=require('../server/market-service');
let technical,domain;test.before(async()=>{technical=await import('../client/technical.mjs');domain=await import('../client/domain.mjs');});
const day=86400000,lastOpen=Date.UTC(2026,10,3,3),end=lastOpen+23400000;
function daily(n=260){const times=[];for(let t=lastOpen;times.length<n;t-=day)if(![0,6].includes(new Date(t).getUTCDay()))times.unshift(t);return times.map((time,i)=>({time,open:100+i*.1,high:102+i*.1,low:99+i*.1,close:101+i*.1,volume:1000+i}));}
function options(rows,extra={}){return {symbol:'PTT',timeframe:'1Y',history:rows,indicatorHistory:rows,levelsHistory:rows,fetchedAt:new Date(end+60000).toISOString(),technicalMeta:{indicator:{interval:'1d',timeZone:'Asia/Bangkok',regularStart:lastOpen,regularEnd:end,receivedAt:new Date(end+60000).toISOString()}},...extra};}
const make=(rows,extra={})=>technical.createTechnicalSnapshot(options(rows,extra));
const metadata=(extra={})=>({indicator:{interval:'1d',timeZone:'Asia/Bangkok',regularStart:lastOpen,regularEnd:end,receivedAt:new Date(end+60000).toISOString(),...extra}});

for(const [interval,step]of [['1m',60000],['15m',900000],['30m',1800000],['60m',3600000]])test(`${interval} has explicit unchanged open/close/availability contract`,()=>{
 const row=daily(1)[0],before=JSON.stringify(row),bar=temporalBars([row],{interval,observedAt:row.time+step})[0];
 assert.equal(bar.time,row.time);assert.equal(bar.barOpenTime,row.time);assert.equal(bar.barCloseTime,row.time+step);assert.equal(bar.availableAt,bar.barCloseTime);assert.equal(bar.confirmed,true);assert.equal(bar.complete,true);assert.equal(bar.confirmationBasis,'interval-end');assert.equal(JSON.stringify(row),before);
});
for(const [label,observed,complete]of [['before-open',lastOpen-1,false],['during-session',lastOpen+3600000,false],['after-close',end+1,true],['overnight',end+8*3600000,true],['holiday-or-weekend',end+3*day,true]])test(`daily ${label} uses matched provider session evidence`,()=>{
 const b=temporalBars(daily(1),{interval:'1d',regularStart:lastOpen,regularEnd:end,timeZone:'Asia/Bangkok',observedAt:observed})[0];assert.equal(b.complete,complete);assert.equal(b.barOpenTime,lastOpen);assert.equal(b.barCloseTime,end);assert.equal(b.confirmationBasis,'provider-session-end');
});
test('daily next-session evidence is availability, never an invented close timestamp',()=>{
 const rows=daily(3),b=temporalBars(rows,{interval:'1d',observedAt:end+day})[1];assert.equal(b.barCloseTime,null);assert.equal(b.availableAt,rows[2].time);assert.equal(b.confirmationBasis,'next-session-observation');assert.equal(b.complete,true);
});
test('a duplicate date is not the next daily session',()=>{
 const rows=[daily(1)[0],{...daily(1)[0],time:lastOpen+60000}];assert.equal(temporalBars(rows,{interval:'1d',observedAt:end+day})[0].complete,false);
});
test('exchange date comparison works across UTC midnight',()=>{
 const open=Date.UTC(2026,10,2,20),close=Date.UTC(2026,10,3,1);assert.equal(temporalBars([{...daily(1)[0],time:open}],{interval:'1d',regularStart:open,regularEnd:close,timeZone:'Asia/Bangkok',observedAt:close})[0].complete,true);
});
test('next-session chronology does not depend on locale display order at a year boundary',()=>{
 const context={module:{exports:{}},Intl:{DateTimeFormat:function(locale,options){const formatter=new Intl.DateTimeFormat(locale,options);return {format:value=>{const p=Object.fromEntries(formatter.formatToParts(value).map(p=>[p.type,p.value]));return `${p.month}/${p.day}/${p.year}`;},formatToParts:value=>formatter.formatToParts(value)};}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/market-time.js'),'utf8'),context);
 const open=Date.UTC(2026,11,31,3),next=Date.UTC(2027,0,4,3),rows=[{...daily(1)[0],time:open},{...daily(1)[0],time:next}];
 assert.equal(context.module.exports.temporalBars(rows,{interval:'1d',observedAt:next})[0].complete,true,'a later exchange date confirms the prior bar independently of rendered date order');
});
for(const regularEnd of [null,end-day,end+day])test(`daily missing or wrong-date session end ${regularEnd} cannot confirm the last candle`,()=>{
 const rows=daily(40),s=make(rows,{technicalMeta:metadata({regularEnd})});assert.equal(s.latestCandle.complete,false);assert.equal(s.signalReference.barOpenTime,rows.at(-2).time);assert.equal(s.signalReference.selection,'previous-confirmed');assert.equal(s.signalReference.confirmationBasis,'next-session-observation');assert.equal(s.confirmation,'confirmed');assert.equal(s.summary.actionable,true);assert.ok(['ซื้อ','ขาย','เป็นกลาง'].includes(s.summary.overall));
});
test('invalid timezone and inconsistent session start fail closed',()=>{
 const row=daily(1)[0];assert.equal(temporalBars([row],{interval:'1d',timeZone:'Invalid/Zone',regularStart:lastOpen,regularEnd:end,observedAt:end+day})[0].complete,false);
 assert.equal(temporalBars([row],{interval:'1d',timeZone:'Asia/Bangkok',regularStart:lastOpen+day,regularEnd:end,observedAt:end+day})[0].complete,false);
});
for(const timeframe of ['1Y'])test(`${timeframe} selects latest confirmed daily candle and preserves complete snapshot evidence`,()=>{
 const rows=daily(),s=make(rows,{timeframe});assert.equal(s.signalReference.barOpenTime,lastOpen);assert.equal(s.signalReference.availableAt,end);assert.equal(s.signalReference.selection,'latest-confirmed');assert.equal(s.signalReference.confirmationBasis,'provider-session-end');assert.equal(s.candleTime,lastOpen);assert.equal(s.receivedAt,end+60000);assert.ok(s.summary.reasons.every(r=>r.candleTime===s.candleTime));assert.ok(Object.isFrozen(s.signalReference));
});
for(const timeframe of ['1D','1W'])test(`${timeframe} uses confirmed previous intraday candle while latest is open`,()=>{
 const step=timeframe==='1D'?60000:900000,rows=Array.from({length:80},(_,i)=>({...daily(1)[0],time:lastOpen+i*step,close:101+i*.01})),observed=rows.at(-1).time+step/2;
 const s=make(rows,{timeframe,fetchedAt:observed,technicalMeta:{indicator:{interval:timeframe==='1D'?'1m':'15m',receivedAt:observed}}});assert.equal(s.signalReference.barOpenTime,rows.at(-2).time);assert.equal(s.latestCandle.complete,false);assert.equal(s.summary.actionable,true);
});
test('unconfirmed OHLC and volume cannot contaminate confirmed indicators, levels, votes or explanations',()=>{
 const rows=daily(),extra={technicalMeta:metadata({regularEnd:null})},a=make(rows,extra),changed=rows.map(r=>({...r}));changed.at(-1).open=999;changed.at(-1).high=1001;changed.at(-1).low=998;changed.at(-1).close=1000;changed.at(-1).volume=999999;
 const b=make(changed,extra);assert.deepEqual(b.analysis,a.analysis);assert.deepEqual(b.signalSeries,a.signalSeries);assert.deepEqual(b.summary,a.summary);assert.deepEqual(b.levels,a.levels);assert.notDeepEqual(b.series,a.series,'chart still shows the actual provisional values');assert.equal(b.rows.at(-1).close,1000);
});
test('previous confirmed fallback does not bypass MACD warm-up',()=>{
 const rows=daily(34),s=make(rows,{technicalMeta:metadata({regularEnd:null})});assert.equal(s.signalRows.length,33);assert.equal(s.availability.macd.state,'insufficient');assert.equal(s.summary.actionable,false);assert.equal(s.summary.overall,'ข้อมูลไม่เพียงพอ');assert.equal(s.summary.requiredBars,34);
 const ready=make(rows);assert.equal(ready.signalRows.length,34);assert.equal(ready.summary.actionable,true);
});
test('no confirmed history is distinguished from insufficient warm-up without inventing a close',()=>{
 const rows=daily(40),s=make(rows,{fetchedAt:null,technicalMeta:{}});assert.equal(s.signalReference,null);assert.equal(s.analysis,null);assert.equal(s.summary.status,'waiting-close');assert.equal(s.summary.overall,'รอแท่งปิด');assert.equal(make(daily(1),{technicalMeta:metadata({regularEnd:null})}).summary.overall,'ข้อมูลไม่เพียงพอ');
});
for(const extra of [{guardReasons:['HISTORICAL_ANOMALY']},{technicalMeta:metadata({corporateActionCount:1})},{dataState:'stale'},{dataState:'suspect'},{guardReasons:['SYMBOL_MISMATCH']},{technicalMeta:metadata({interval:'15m'})}])test(`critical quality blocks signals: ${JSON.stringify(extra)}`,()=>{
 const s=make(daily(),extra);assert.equal(s.summary.actionable,false);assert.equal(s.summary.overall,'ข้อมูลต้องตรวจสอบ');assert.equal(s.summary.status,'data-review');assert.ok(s.quality.warnings.length);
});
test('rejected historical bars remain excluded and INVALID_NUMERIC remains visible without fabricating values',()=>{
 const rows=daily(50),raw={meta:{symbol:'PTT.BK',currency:'THB',exchangeName:'SET',exchangeTimezoneName:'Asia/Bangkok',regularMarketPrice:rows.at(-1).close,regularMarketTime:end/1000,previousClose:rows.at(-2).close,currentTradingPeriod:{regular:{start:lastOpen/1000,end:end/1000}}},timestamp:rows.map(r=>r.time/1000),indicators:{quote:[Object.fromEntries(['open','high','low','close','volume'].map(k=>[k,rows.map(r=>r[k])]))]}};
 raw.indicators.quote[0].close[10]=null;const before=JSON.stringify(raw),service=createMarketService({env:{},now:()=>end+60000,fetchImpl:()=>{throw Error('No live requests');}}),shaped=service.shapeChart(raw,'PTT','chart:3mo:1d');
 assert.equal(shaped.rejectedBars,1);assert.deepEqual(shaped.historyReasons,['INVALID_NUMERIC']);assert.equal(shaped.provenance.timeZone,'Asia/Bangkok');assert.equal(shaped.provenance.regularStart,lastOpen);assert.equal(shaped.provenance.receivedAt,new Date(end+60000).toISOString());
 const s=make(shaped.history,{technicalMeta:{indicator:shaped.provenance}});assert.ok(s.quality.warnings.includes('INVALID_NUMERIC'));assert.ok(!s.signalRows.some(r=>r.time===rows[10].time));assert.equal(JSON.stringify(raw),before);
});
test('daily walk-forward replay cannot borrow future session observations, prices or swing confirmations',()=>{
 const rows=daily(85);
 for(const n of [35,50,70]){
  const observed=rows[n-1].time+3600000,extra={fetchedAt:observed,technicalMeta:{indicator:{interval:'1d',timeZone:'Asia/Bangkok',receivedAt:observed}}};
  const prefix=make(rows.slice(0,n),extra),future=make(rows,extra);assert.deepEqual(future.signalRows,prefix.signalRows);assert.deepEqual(future.summary,prefix.summary);assert.deepEqual(future.analysis,prefix.analysis);assert.equal(prefix.signalReference.barOpenTime,rows[n-2].time);
  assert.ok(prefix.crosses.every(c=>c.confirmedAt<=observed));assert.ok(prefix.levels.swings.confirmed.every(s=>s.confirmedAt<=observed));
 }
});
test('confirmed signal series keep the independent indicator formulas and chart timestamp alignment',()=>{
 const rows=daily(),s=make(rows,{technicalMeta:metadata({regularEnd:null})}),expected=domain.computeTechnicalSeries(rows.slice(0,-1));assert.deepEqual(s.signalSeries,expected);assert.deepEqual(s.rows.map(r=>r.time),rows.map(r=>r.time));assert.deepEqual(s.series,domain.computeTechnicalSeries(rows));
});
for(const timeframe of ['1Y'])test(`${timeframe} service-to-snapshot flow preserves cadence, fallback provenance and the existing request budget`,async()=>{
 const calls=[],received=end+3600000;
 const service=createMarketService({env:{},now:()=>received,fetchImpl:async input=>{
  const url=new URL(input),interval=url.searchParams.get('interval'),range=url.searchParams.get('range'),symbol=decodeURIComponent(url.pathname.split('/').at(-1));calls.push({range,interval});
  const n=interval==='1d'?({'1mo':19,'3mo':63,'1y':242,'6mo':120}[range]||120):50;
  const rows=(interval==='1d'?daily(n):Array.from({length:n},(_,i)=>({...daily(1)[0],time:lastOpen+i*300000}))).map((r,i)=>({...r,close:100+(i-n+1)*.02,open:100+(i-n+1)*.02,high:101+(i-n+1)*.02,low:99+(i-n+1)*.02}));
  const raw={meta:{symbol,currency:'THB',exchangeName:'SET',exchangeTimezoneName:'Asia/Bangkok',regularMarketPrice:100,regularMarketTime:end/1000,previousClose:99.98,range,currentTradingPeriod:{regular:{start:lastOpen/1000}}},timestamp:rows.map(r=>r.time/1000),indicators:{quote:[Object.fromEntries(['open','high','low','close','volume'].map(k=>[k,rows.map(r=>r[k])]))]}};
  return {ok:true,status:200,json:async()=>({chart:{result:[raw],error:null}})};
 }});
 const market=await service.getMarket(['PTT'],'PTT',timeframe),s=technical.createTechnicalSnapshot({...market,symbol:'PTT',timeframe});
 assert.equal(calls.length,timeframe==='1M'?4:3,'no provider requests added to the existing acquisition path');assert.equal(market.technicalMeta.indicator.interval,'1d');assert.equal(market.technicalMeta.indicator.timeZone,'Asia/Bangkok');assert.equal(market.technicalMeta.indicator.regularEnd,null);assert.equal(s.receivedAt,received);assert.equal(s.latestCandle.time,lastOpen);assert.equal(s.latestCandle.complete,false);assert.equal(s.signalReference.barOpenTime,daily(2)[0].time);assert.equal(s.summary.actionable,true);
 assert.equal(s.signalRows.length,({'1M':119,'3M':62,'1Y':241})[timeframe]);if(timeframe==='1M'){assert.equal(market.history.length,19);assert.equal(market.indicatorHistory.length,120);assert.equal(calls.at(-1).range,'6mo');}
});
