'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {temporalBars}=require('../lib/market-time');
let d,t;
test.before(async()=>{d=await import('../client/domain.mjs');t=await import('../client/technical.mjs');});
const at=Date.UTC(2026,9,20,3),bars=(n=260,step=60000)=>Array.from({length:n},(_,i)=>({time:at+i*step,open:100+i*.1,high:102+i*.1,low:99+i*.1,close:101+i*.1,volume:1000+i}));
const snapshot=(rows,extra={})=>t.createTechnicalSnapshot({symbol:'PTT',timeframe:'1D',history:rows,indicatorHistory:rows,levelsHistory:rows,fetchedAt:new Date(rows.at(-1).time+60000).toISOString(),...extra});

test('SMA/EMA never convert missing values to zero or shift the remaining timestamps',()=>{
 const input=[1,2,3,null,4,5,6];
 assert.deepEqual(d.computeEma(input,3),[null,null,2,null,null,null,5]);
 assert.deepEqual(d.computeSmaSeries(input,3),[null,null,2,null,null,null,5]);
 for(const absent of [undefined,'',NaN,Infinity])assert.deepEqual(d.computeEma([1,2,absent,3,4],2),[null,1.5,null,null,3.5]);
 assert.deepEqual(d.alignIndicatorSeries([{time:at},{time:at}],[1,2],[{time:at}]),[null]);
 assert.deepEqual(d.alignIndicatorSeries([{time:at}],[NaN],[{time:at}]),[null]);
});
test('indicator warm-up is independently available, preserving neutral flat RSI and full precision',()=>{
 const rows=bars(),s=d.computeTechnicalSeries(rows);
 for(const [name,index]of [['rsi',14],['atr',14],['ema200',199],['signal',33]]){
  assert.ok(s[name].slice(0,index).every(v=>v===null));assert.ok(Number.isFinite(s[name][index]));
 }
 assert.equal(d.computeRsiSeries(Array(40).fill(10)).at(-1),50);
 assert.equal(d.computeRsiSeries(Array.from({length:40},(_,i)=>40-i)).at(-1),0);
 assert.equal(d.computeRsiSeries(Array.from({length:40},(_,i)=>i+1)).at(-1),100);
 const bb=d.computeBollingerSeries([1,2,3],3,2);assert.equal(bb.standardDeviation,'population');assert.equal(bb.middle[2],2);assert.equal(bb.upper[2],2+2*Math.sqrt(2/3));
 const short=snapshot(rows.slice(0,30));assert.equal(short.availability.macd.state,'insufficient');assert.equal(short.availability.ema200.state,'insufficient');
 assert.equal(short.analysis.macdSignal,null);assert.equal(short.analysis.signals.macd,undefined);
});
test('ATR includes gap from previous close and restarts honestly after invalid OHLC',()=>{
 const input=[{high:11,low:9,close:10},{high:16,low:14,close:15},{high:17,low:15,close:16}];
 assert.deepEqual(d.computeAtrSeries(input,2),[null,null,4]);
 assert.deepEqual(d.computeAtrSeries([...input,{high:null,low:1,close:2},...input],2),[null,null,4,null,null,null,4]);
});
test('bar availability follows provider session evidence, never UTC date matching',()=>{
 const row={time:at,open:100,high:102,low:99,close:101,volume:1};
 assert.equal(temporalBars([row],{interval:'1m',observedAt:at+30000})[0].complete,false);
 assert.equal(temporalBars([row],{interval:'1m',observedAt:at+60000})[0].complete,true);
 const end=Date.UTC(2026,9,20,9,40);
 assert.equal(temporalBars([row],{interval:'1d',regularEnd:end,observedAt:end-1})[0].complete,false);
 assert.equal(temporalBars([row],{interval:'1d',regularEnd:end,observedAt:end})[0].complete,true);
 assert.equal(temporalBars([row],{interval:'1d',observedAt:end+86400000})[0].complete,false,'without closure evidence the final daily bar is provisional');
});
test('same-day daily fallback cannot leak a future close or Pivot into an intraday snapshot',()=>{
 const rows=bars(80),daily=bars(30,86400000).map((bar,i)=>({...bar,time:at-(30-i)*86400000}));
 const options={levelsHistory:daily,technicalMeta:{indicator:{interval:'1m'},levels:{interval:'1d',regularEnd:at+24000000}}};
 const a=snapshot(rows,{...options,technicalMeta:{...options.technicalMeta,levels:{interval:'1d',regularEnd:at-86400000+24000000}}});
 const b=snapshot(rows,{...options,levelsHistory:[...daily,{time:at,open:999,high:1000,low:998,close:999,volume:1000}]});
 assert.deepEqual(b.levels.supports,a.levels.supports);assert.deepEqual(b.levels.resistances,a.levels.resistances);
 assert.ok([...b.levels.supportDetails,...b.levels.resistanceDetails].every(level=>level.referenceTime<at));
});
test('walk-forward indicators and confirmed swings never change their past values after future bars arrive',()=>{
 const rows=bars(90).map((row,i)=>({...row,high:row.high+3+Math.sin(i)*2,low:row.low-Math.sin(i)**2}));
 const full=snapshot(rows);
 for(const end of [20,34,50,70]){
  const prefix=snapshot(rows.slice(0,end));
  for(const key of ['ema20','rsi','macd','signal','atr'])assert.deepEqual(prefix.series[key],full.series[key].slice(0,end));
  const future=snapshot(rows.slice(0,end),{indicatorHistory:rows});assert.deepEqual(future.series,prefix.series);
  for(const swing of prefix.levels.swings.confirmed)assert.ok(swing.confirmedAt<=prefix.asOf);
 }
});
test('snapshot is immutable and identity-bound; mismatched cadence, anomalies and actions never become confirmed signals',()=>{
 const rows=bars(),before=JSON.stringify(rows),s=snapshot(rows);
 assert.equal(JSON.stringify(rows),before);assert.ok(Object.isFrozen(s));assert.ok(Object.isFrozen(s.series.ema20));
 assert.equal(s.summary.reasons.length,3);assert.ok(Math.abs(s.summary.score)<=3,'MA votes count as one evidence group');
 assert.ok(s.summary.reasons.every(r=>r.symbol===s.symbol&&r.candleTime===s.candleTime&&r.version===s.version));
 for(const extra of [{guardReasons:['HISTORICAL_ANOMALY']},{technicalMeta:{indicator:{interval:'1m',corporateActionCount:1}}},{dataState:'stale'},{technicalMeta:{indicator:{interval:'1d'}}}]){
  const value=snapshot(rows,extra);assert.equal(value.summary.actionable,false);assert.equal(value.summary.overall,'ข้อมูลต้องตรวจสอบ');
 }
 assert.equal(snapshot(rows,{technicalMeta:{indicator:{interval:'1d'}}}).rows.length,0);
});
test('swings wait for right-hand completed bars and pivots use the previous completed reference period',()=>{
 const rows=bars(40).map((r,i)=>({...r,high:i===20?120:110,low:i===20?80:90,open:100,close:101}));
 const pending=snapshot(rows.slice(0,22));assert.ok(pending.levels.swings.pending.some(s=>s.time===rows[20].time));
 assert.ok(!pending.levels.swings.confirmed.some(s=>s.time===rows[20].time));
 const confirmed=snapshot(rows.slice(0,23));assert.ok(confirmed.levels.swings.confirmed.some(s=>s.time===rows[20].time&&s.confirmedAt===rows[22].time+60000));
 assert.ok([...confirmed.levels.supportDetails,...confirmed.levels.resistanceDetails].every(d=>d.confirmedAt<=confirmed.asOf));
 const simple=snapshot(bars(40));const details=[...simple.levels.supportDetails,...simple.levels.resistanceDetails].filter(d=>d.source==='Classic Pivot');
 assert.ok(details.length);assert.ok(details.every(d=>d.referenceTime===simple.rows.at(-2).time));
});
test('zero or missing reference volume never confirms a breakout; ATR cannot invent a zone centre',()=>{
 const source=bars(65).map((r,i)=>({...r,open:i>50?115:100,close:i>50?116:101,high:i===25?110:i>50?118:105,low:99,volume:i>50?1000:0}));
 const s=snapshot(source);const events=s.levels.zones.flatMap(z=>z.events);
 assert.ok(events.some(e=>e.kind==='breakout-pending-volume'));
 assert.ok(events.filter(e=>e.kind==='breakout-confirmed').every(e=>e.volumeBaseline>0));
 assert.ok(s.levels.zones.every(z=>s.levels.swings.confirmed.some(sw=>sw.price===z.value)));
 const missing=snapshot(source.map(r=>({...r,volume:null})));assert.equal(missing.volume.ratio,null);assert.ok(!missing.levels.zones.flatMap(z=>z.events).some(e=>e.kind==='breakout-confirmed'));
});
test('drawing projection preserves time/price across viewport shifts and rejects unsafe local payloads',async()=>{
 const {validDrawings,projectAnchor,measurement}=await import('../client/drawings.mjs');
 const drawing={id:'test-1',type:'measure',a:{time:at+10*60000,price:100},b:{time:at+20*60000,price:110}};
 assert.equal(validDrawings([drawing,drawing,{...drawing,id:'<script>'},{...drawing,id:'test-2',a:{time:at,price:NaN}}]).length,1);
 const rows=bars(30),full=projectAnchor(drawing.a,rows,i=>i*10,p=>p*2),shifted=projectAnchor(drawing.a,rows.slice(15),i=>i*10,p=>p*2);
 assert.equal(full.x,100);assert.equal(shifted.x,-50);assert.equal(full.y,shifted.y);
 const m=measurement(drawing);assert.equal(m.change,10);assert.ok(Math.abs(m.percent-10)<1e-10);assert.equal(m.elapsed,600000);
});
