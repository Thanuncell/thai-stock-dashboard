'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {rankingRows,roleRankingRows,scarceRows}=require('./fixtures/technical-ranking.cjs');
let technical;
test.before(async()=>{technical=await import('../client/technical.mjs');});
function completed(rows,step=60000){return rows.map(row=>({...row,complete:true,availableAt:row.time+step}));}
function structure(rows,atr=2){return technical.priceStructure(rows,39.5,{asOf:rows.at(-1).availableAt,candleTime:rows.at(-1).time,atr});}
test('nearest eligible swing price ranks ahead of stronger distant reactions on both sides',()=>{
 const s=structure(completed(rankingRows('1D')));
 assert.deepEqual(s.supports,[36.25,35.25,35]);assert.deepEqual(s.resistances,[41.25,41.75,42]);
 const reactions=z=>z.events.filter(e=>e.kind==='reaction').length;
 assert.ok(reactions(s.supportDetails[2])>reactions(s.supportDetails[0]));
 assert.ok(reactions(s.resistanceDetails[2])>reactions(s.resistanceDetails[1]));
 for(const [type,values]of [['support',[36.25,35.25,35]],['resistance',[41.25,41.75,42]]])s[type+'Details'].forEach((z,i)=>{assert.equal(z.value,values[i]);assert.equal(z.rank,i+1);assert.ok(z.swings.length);});
});
test('eligible previous-completed pivots enter the candidate pool before the three-level cutoff',()=>{
 const rows=completed(rankingRows('1D'));
 for(const row of rows)if(row.low===35.25)row.low=35.05;else if(row.low===36.25)row.low=35.1;
 const s=structure(rows,.01),prior=rows.at(-2),pivot=(prior.high+prior.low+prior.close)/3;
 assert.equal(s.supports[0],2*pivot-prior.high);assert.equal(s.supportDetails[0].source,'Classic Pivot');
 assert.equal(s.supportDetails[0].referenceTime,prior.time);assert.equal(s.supportDetails[0].confirmedAt,prior.availableAt);
 assert.ok(s.supports.every((v,i,a)=>i===0||a[i-1]>v));
});
test('zone dedup retains evidence prices and does not pad missing supports',()=>{
 const s=structure(completed(scarceRows()));
 assert.equal(s.supports.length,1);assert.equal(s.supportDetails[0].source,'Classic Pivot');
 const ordinary=structure(completed(rankingRows('1D')));
 for(const type of ['support','resistance']){const details=ordinary[type+'Details'];assert.equal(new Set(details.map(z=>z.value)).size,details.length);for(const z of details)assert.ok(z.swings.some(swing=>swing.price===z.value));}
});
test('equal-price cross-role zones deduplicate with confirmed strength only as a tie-breaker',()=>{
 const rows=completed(roleRankingRows());const options={asOf:rows.at(-1).availableAt,candleTime:rows.at(-1).time,interval:'1m',atr:2};
 const s=technical.priceStructure(rows,112,options),twins=s.zones.filter(z=>z.value===110);
 assert.equal(twins.length,2);assert.ok(twins[0].events.filter(e=>e.kind==='retest-confirmed').length>twins[1].events.length);
 const selected=s.supportDetails.filter(z=>z.value===110);assert.equal(selected.length,1);
 assert.equal(selected[0].source,'Swing high');assert.equal(selected[0].originalType,'resistance');
 assert.ok(selected[0].roleConfirmation.confirmedAt<=options.asOf);assert.match(selected[0].sourceLabel,/Swing high → แนวรับ.*ยืนยัน/);
 assert.deepEqual(technical.priceStructure(rows,112,options),s,'repeatable price and evidence selection');
});
for(const range of ['1D','1W','1M','3M','1Y'])test(`${range}: ranking, summary and analysis use the confirmed reference close without future prices`,()=>{
 const rows=rankingRows(range),step=range==='1D'?60000:range==='1W'?900000:range==='1M'?1800000:range==='3M'?3600000:86400000,interval=range==='1D'?'1m':range==='1W'?'15m':range==='1M'?'30m':range==='3M'?'60m':'1d';
 const reference=rows.at(-2),receivedAt=rows.at(-1).time+(interval==='1d'?3600000:step/2);
 const meta={interval,receivedAt,regularStart:rows.at(-1).time,regularEnd:rows.at(-1).time+23400000,timeZone:'Asia/Bangkok'};
 const snapshot=history=>technical.createTechnicalSnapshot({symbol:'PTT',timeframe:range,history,fetchedAt:receivedAt,technicalMeta:{history:meta,indicator:meta,levels:meta}});
 const before=snapshot(rows);rows.at(-1).close=100;rows.at(-1).high=101;rows.at(-1).open=100;const after=snapshot(rows);
 assert.equal(after.candleTime,reference.time);assert.equal(after.signalRows.at(-1).close,39.5);
 assert.deepEqual(after.levels,before.levels);assert.deepEqual(after.summary,before.summary);
 assert.deepEqual(after.levels.supports,[36.25,35.25,35]);assert.deepEqual(after.levels.resistances,[41.25,41.75,42]);
 assert.equal(after.analysis.levels,after.levels);
 const reason=after.summary.reasons.find(r=>r.group==='structure');assert.equal(reason.values.support,36.25);assert.equal(reason.values.resistance,41.25);
 assert.ok([...after.levels.supportDetails,...after.levels.resistanceDetails].every(z=>z.confirmedAt<=after.asOf));
});
