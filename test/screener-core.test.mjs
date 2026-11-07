import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTechnicalSeries, TECHNICAL_DEFAULTS } from '../client/domain.mjs';
import { SCREENER_SCHEMA_VERSION, buildDailyScreenerRow, buildScreenerSnapshot, queryScreenerSnapshot } from '../client/screener-core.mjs';

function tradingBars(count, { start = Date.UTC(2026, 6, 1, 3), base = 100, step = 0.5, acceleration = 0 } = {}) {
  const rows = [];
  for (let time = start; rows.length < count; time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day === 0 || day === 6) continue;
    const close = base + rows.length * step + acceleration * rows.length * rows.length;
    rows.push({ time, open: close, high: close + 1, low: close - 1, close,
      volume: 1000000, complete: true, availableAt: time + 8 * 3600000, guardStatus: 'accepted' });
  }
  return rows;
}
const day = date => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
function validCoverage(symbol='AAA') {
  return { symbol, active:true, provider:'Yahoo Finance', provider_symbol:`${symbol}.BK`,
    symbol_verified:true,chart_ready:true,technical_ready:true,status:'verified',guard_status:'accepted' };
}
function evidence(bars, symbol='AAA', overrides={}) {
  const completed = bars.filter(b=>b.complete);
  const last=completed.at(-1);
  return {provider:'Yahoo Finance',providerSymbol:`${symbol}.BK`,identityStatus:'accepted',guardStatus:'accepted',
    historyStatus:'usable',interval:'1d',dataState:'delayed',guardReasons:[],
    sourceFetchedAt: new Date(last.availableAt+60_000).toISOString(),bars,...overrides};
}
function context(bars) {
  const last=bars.filter(b=>b.complete).at(-1);
  return {sessionDate:day(last.time),observedAt:new Date(last.availableAt+120_000).toISOString()};
}
function build(bars, symbol='AAA', customEvidence={}, coverage=validCoverage(symbol)) {
  return buildDailyScreenerRow(coverage,evidence(bars,symbol,customEvidence),context(bars));
}
function snapshot(entries) {
  const registry=[],evidenceBySymbol={};
  for(const [symbol,bars,override] of entries){registry.push(validCoverage(symbol));evidenceBySymbol[symbol]=evidence(bars,symbol,override);}
  return buildScreenerSnapshot({registry,evidenceBySymbol,...context(entries[0][1])});
}

test('WS2: Daily indicators reuse Chart domain calculations with confirmed candles', () => {
  const bars=tradingBars(65);
  const row=build(bars);
  const technical=computeTechnicalSeries(bars,TECHNICAL_DEFAULTS);
  assert.equal(row.state,'READY');
  assert.equal(row.confirmedBars,65);
  assert.equal(row.technical.ema20,technical.ema20.at(-1));
  assert.equal(row.technical.ema50,technical.ema50.at(-1));
  assert.equal(row.technical.rsi14,technical.rsi.at(-1));
  assert.equal(row.technical.macd,technical.macd.at(-1));
  assert.equal(row.technical.macdSignal,technical.signal.at(-1));
  assert.equal(row.available.macd,true);
});

test('WS2: 30 candles do not claim EMA50 or MACD 12/26/9 readiness', () => {
  const row=build(tradingBars(30));
  assert.equal(row.available.ema20,true);
  assert.equal(row.available.ema50,false);
  assert.equal(row.available.macd,false);
  assert.equal(row.technical.ema50,null);
  assert.equal(row.technical.macdSignal,null);
});

test('WS2: provisional latest candle never enters a technical signal', () => {
  const bars=tradingBars(65),last=bars.at(-1);
  const newer={...last,time:last.time+86_400_000,close:900,open:900,high:901,low:899,complete:false,availableAt:last.availableAt+86_400_000};
  const plain=build(bars);
  const cutoff=new Date(newer.time+3600000).toISOString();
  const withProvisional=buildDailyScreenerRow(validCoverage(), evidence([...bars,newer]),
    {...context(bars),observedAt:cutoff});
  assert.equal(withProvisional.state,'READY');
  assert.equal(withProvisional.price.close,plain.price.close);
  assert.equal(withProvisional.technical.macd,plain.technical.macd);
  assert.equal(withProvisional.confirmedBars,65);
});

test('WS2: guard, mapping, stale session and coverage eligibility fail closed', () => {
  const bars=tradingBars(60),ctx=context(bars);
  assert.equal(build(bars,'AAA',{guardStatus:'suspect'}).state,'GUARD_BLOCKED');
  assert.equal(build(bars,'AAA',{providerSymbol:'WRONG.BK'}).state,'GUARD_BLOCKED');
  assert.equal(build(bars,'AAA',{dataState:'stale'}).state,'GUARD_BLOCKED');
  assert.equal(buildDailyScreenerRow(validCoverage(),null,ctx).state,'UNAVAILABLE');
  assert.equal(buildDailyScreenerRow({...validCoverage(),status:'partial'},evidence(bars),ctx).state,'COVERAGE_INELIGIBLE');
  const wrongSession='2026-01-01';
  assert.equal(buildDailyScreenerRow(validCoverage(),evidence(bars),{...ctx,sessionDate:wrongSession}).state,'STALE_SESSION');
  assert.equal(buildDailyScreenerRow(validCoverage(),evidence(bars,'AAA',{sourceFetchedAt:'2026-01-01T00:00:00Z'}),ctx).state,'STALE_SESSION');
});

test('WS2: missing, duplicate or invalid daily bars never become technical evidence', () => {
  const bars=tradingBars(65);
  assert.equal(build([...bars,bars.at(-1)]).state,'GUARD_BLOCKED');
  assert.equal(build([...bars.slice(0,5), {...bars[5], close: -1}, ...bars.slice(6)]).state,'GUARD_BLOCKED');
  assert.equal(build(bars.slice(0,1)).available.changePercent,false);
});

test('WS2: zero percent change is valid evidence, not missing-data placeholder', () => {
  const row=build(tradingBars(55,{step:0}));
  assert.equal(row.price.changePercent,0);
  assert.equal(row.available.changePercent,true);
  assert.equal(row.technical.rsi14,50);
});

test('WS2: AND/range filtering evaluates selected fields only; no provider calls', () => {
  const bars=tradingBars(65,{acceleration:0.02}),s=snapshot([['AAA',bars],['BBB',tradingBars(65,{base:100,step:-0.2,acceleration:-0.005})]]);
  assert.equal(s.schemaVersion,SCREENER_SCHEMA_VERSION);
  const r=queryScreenerSnapshot(s,{ema20:'above',rsi14:{min:70,max:100},macd:'above'});
  assert.equal(r.counts.registered,2);
  assert.equal(r.counts.evaluated,2);
  assert.equal(r.counts.matched,1);
  assert.equal(r.rows[0].symbol,'AAA');
  assert.equal(r.counts.notMatched,1);
});

test('WS2: missing indicator is unevaluable, not a zero or false technical signal', () => {
  const bars=tradingBars(30),s=snapshot([['AAA',bars]]);
  const result=queryScreenerSnapshot(s,{ema50:'above'});
  assert.equal(result.counts.evaluated,0);
  assert.equal(result.counts.unevaluable,1);
  assert.equal(result.counts.notMatched,0);
  assert.equal(result.counts.matched,0);
  assert.equal(queryScreenerSnapshot(s,{price:{min:0,max:1000}}).counts.matched,1);
});

test('WS2: page/sort is stable for equal prices and does not mutate frozen snapshots', () => {
  const bars=tradingBars(55,{step:0});
  const s=snapshot([['BBB',bars],['AAA',bars],['CCC',bars]]);
  assert.equal(s.state,'COMPLETE');
  assert(Object.isFrozen(s.rows[0]));
  const before=JSON.stringify(s);
  assert.deepEqual(queryScreenerSnapshot(s,{}, {sortBy:'price',sortDirection:'desc',page:1,pageSize:2}).rows.map(r=>r.symbol),['AAA','BBB']);
  assert.deepEqual(queryScreenerSnapshot(s,{}, {sortBy:'price',sortDirection:'desc',page:2,pageSize:2}).rows.map(r=>r.symbol),['CCC']);
  assert.equal(JSON.stringify(s),before);
});

test('WS2: invalid registry, filter and numeric boundaries reject instead of silently ignoring', () => {
  const bars=tradingBars(55),s=snapshot([['AAA',bars]]),ctx=context(bars);
  assert.throws(()=>buildScreenerSnapshot({registry:[validCoverage('AAA'),validCoverage('AAA')],evidenceBySymbol:{},...ctx}),/duplicate/);
  assert.throws(()=>buildScreenerSnapshot({registry:[validCoverage('AAA'),{...validCoverage('BBB'),provider_symbol:'AAA.BK'}],evidenceBySymbol:{},...ctx}),/duplicate provider/);
  assert.throws(()=>queryScreenerSnapshot(s,{price:{min:Infinity}}),/minimum/);
  assert.throws(()=>queryScreenerSnapshot(s,{price:{min:100,max:20}}),/inverted/);
  assert.throws(()=>queryScreenerSnapshot(s,{rsi14:{min:-1}}),/minimum/);
  assert.throws(()=>queryScreenerSnapshot(s,{unknown:3}),/unknown/);
  assert.throws(()=>queryScreenerSnapshot(s,{}, {pageSize:101}),/pagination/);
});

test('WS2: partial snapshots report ready and excluded counts without claiming whole-market coverage', () => {
  const bars=tradingBars(55),ctx=context(bars);
  const s=buildScreenerSnapshot({registry:[validCoverage('AAA'),validCoverage('BBB')],evidenceBySymbol:{AAA:evidence(bars)},...ctx});
  assert.equal(s.state,'PARTIAL');
  assert.deepEqual(s.counts,{registered:2,eligible:2,ready:1,unavailable:1,staleSession:0,guardBlocked:0,coverageIneligible:0});
  const q=queryScreenerSnapshot(s);
  assert.equal(q.counts.matched,1);
  assert.equal(q.counts.excluded,1);
});


test('WS2: 500-symbol offline fixture filters without fetching or claiming production readiness', () => {
  const bars=tradingBars(60),ctx=context(bars),registry=[],index={};
  for(let i=0;i<500;i++){const symbol=`S${String(i).padStart(3,'0')}`;registry.push(validCoverage(symbol));index[symbol]=evidence(bars,symbol);}
  const s=buildScreenerSnapshot({registry,evidenceBySymbol:index,...ctx});
  assert.equal(s.counts.registered,500);
  assert.equal(s.counts.ready,500);
  const q=queryScreenerSnapshot(s,{price:{min:1,max:1000}},{pageSize:25,page:2});
  assert.equal(q.counts.matched,500);
  assert.equal(q.rows.length,25);
  assert.equal(q.rows[0].symbol,'S025');
});
