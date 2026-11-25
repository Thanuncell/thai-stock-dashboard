'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historyBars, observedAt } = require('./fixtures/daily-ohlcv.cjs');
const { providerChart } = require('./fixtures/screener.cjs');
const { barsBetween, payload, received, responder } = require('./fixtures/chart-candle-density.cjs');
const { createMarketService, PERIODS } = require('../server/market-service');
let chart, technical, domain;
test.before(async () => {
  chart = await import('../client/chart-timeframe.mjs');
  technical = await import('../client/technical.mjs');
  domain = await import('../client/domain.mjs');
});
const fields = ({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume });
const fixture = (count = 260) => {
  const raw = providerChart('PTT.BK', '1d', historyBars(count)).chart.result[0];
  const source = createMarketService({ now: () => observedAt, env: {} }).shapeChart(raw, 'PTT', 'chart:1y:1d');
  return { history: source.history, indicatorHistory: source.history, levelsHistory: source.history,
    technicalMeta: Object.fromEntries(['history', 'indicator', 'levels'].map(key => [key, source.provenance])),
    fetchedAt: new Date(observedAt).toISOString(), dataState: 'delayed' };
};

for (const timeframe of ['D', 'W', 'M']) {
  test(timeframe + ' agrees with independent calendar/OHLCV fixture reference without filling holidays', () => {
    const rows = historyBars(310), original = structuredClone(rows);
    const groups = new Map();
    for (const row of rows) {
      const local = new Date(row.time + 25200000);
      let key = local.toISOString().slice(0, timeframe === 'M' ? 7 : 10);
      if (timeframe === 'W') {
        local.setUTCDate(local.getUTCDate() - (local.getUTCDay() || 7) + 1);
        key = local.toISOString().slice(0, 10);
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const expected = [...groups.values()].map(group => ({ time: group[0].time, open: group[0].open,
      high: Math.max(...group.map(row => row.high)), low: Math.min(...group.map(row => row.low)),
      close: group.at(-1).close, volume: group.reduce((sum, row) => sum + row.volume, 0) }));
    assert.deepEqual(chart.aggregateDailyBars(rows, timeframe).map(fields), expected);
    assert.deepEqual(rows, original);
    assert.deepEqual(chart.aggregateDailyBars([], timeframe), []);
  });
}

test('Bangkok calendar boundaries, year crossover, missing periods and zero/unknown volume remain truthful', () => {
  const rows = historyBars(4).map((row, i) => ({ ...row,
    time: Date.parse(['2025-12-28T18:00:00Z', '2025-12-31T18:00:00Z', '2026-01-04T18:00:00Z', '2026-03-01T18:00:00Z'][i]), volume: i === 0 ? 0 : i === 1 ? null : 10 }));
  const weekly = chart.aggregateDailyBars(rows, 'W');
  assert.equal(weekly.length, 3); assert.equal(weekly[0].volume, null);
  const monthly = chart.aggregateDailyBars(rows, 'M');
  assert.equal(monthly.length, 3); assert.equal(monthly[0].volume, 0); assert.equal(monthly[1].volume, null);
  assert.deepEqual(monthly.map(row => row.time), [rows[0].time, rows[1].time, rows[3].time]);
});

test('Historical Range is independent of D/W/M and warm-up uses the same selected interval', () => {
  const market = fixture();
  for (const timeframe of ['D', 'W', 'M']) {
    const full = chart.marketTimeframe(market, timeframe, '5Y');
    let previous = 0;
    for (const range of chart.HISTORICAL_RANGES) {
      const selected = chart.marketTimeframe(market, timeframe, range);
      assert.ok(selected.history.length >= previous); previous = selected.history.length;
      assert.deepEqual(selected.indicatorHistory, full.indicatorHistory);
      assert.deepEqual(selected.levelsHistory, full.levelsHistory);
      assert.equal(selected.technicalMeta.indicator.interval, technical.RANGE_INTERVAL[timeframe]);
    }
  }
  assert.equal(chart.marketTimeframe(market, 'Auto', '1M'), market);
});

for (const timeframe of ['W', 'M']) {
  test(timeframe + ' shows the partial last period but excludes it from confirmed signals', () => {
    const market = fixture(480);
    const projected = chart.marketTimeframe(market, timeframe, '5Y');
    const snapshot = technical.createTechnicalSnapshot({ ...projected, symbol: 'PTT', timeframe });
    assert.equal(snapshot.latestCandle.complete, false);
    assert.ok(snapshot.signalRows.length > 0);
    assert.ok(snapshot.signalRows.every(row => row.availableAt <= observedAt));
    const changed = structuredClone(market);
    Object.assign(changed.indicatorHistory.at(-1), { high: 99999, close: 99999 });
    const replay = technical.createTechnicalSnapshot({ ...chart.marketTimeframe(changed, timeframe, '5Y'), symbol: 'PTT', timeframe });
    assert.deepEqual(replay.signalSeries, snapshot.signalSeries);
    assert.equal(replay.series.sma20.at(-1) === snapshot.series.sma20.at(-1), false);
  });
}

test('Selected weekly SMA uses weekly closes and monthly insufficient warm-up keeps bars visible', () => {
  const market = fixture(480);
  const weekly = technical.createTechnicalSnapshot({ ...chart.marketTimeframe(market, 'W', '3M'), symbol: 'PTT', timeframe: 'W' });
  const expected = weekly.signalRows.slice(-20).reduce((sum, row) => sum + row.close, 0) / 20;
  assert.ok(Math.abs(weekly.signalSeries.sma20.at(-1) - expected) < 1e-9);
  const monthly = technical.createTechnicalSnapshot({ ...chart.marketTimeframe(fixture(25), 'M', '5Y'), symbol: 'PTT', timeframe: 'M' });
  assert.ok(monthly.rows.length > 0); assert.equal(monthly.summary.status, 'insufficient');
  assert.equal(monthly.summary.actionable, false); assert.equal(monthly.availability.ema200.state, 'insufficient');
});

test('Existing Data Guard excludes invalid and duplicate daily bars before aggregation', () => {
  const rows = barsBetween(received - 60 * 86400000, received, '1d');
  const raw = payload('PTT.BK', '1d', rows.rows, rows.periods);
  raw.indicators.quote[0].high[2] = raw.indicators.quote[0].low[2] - 0.1;
  raw.timestamp[4] = raw.timestamp[3];
  const service = createMarketService({ now: () => received, env: {} });
  const guarded = service.shapeChart(raw, 'PTT', 'chart:1y:1d');
  assert.ok(guarded.historyReasons.includes('INVALID_OHLC'));
  assert.ok(guarded.historyReasons.includes('DUPLICATE_TIMESTAMP'));
  const weekly = chart.aggregateDailyBars(guarded.history, 'W');
  assert.equal(weekly.reduce((sum, row) => sum + row.volume, 0), guarded.history.reduce((sum, row) => sum + row.volume, 0));
});

test('Legacy Auto mappings and navigation URLs remain compatible; new selection round-trips independently', () => {
  assert.deepEqual(PERIODS, { '1D': ['1d','1m'], '1W': ['5d','15m'], '1M': ['1mo','30m'], '3M': ['3mo','60m'], '1Y': ['1y','1d'] });
  for (const range of Object.keys(PERIODS)) {
    const state = { route: 'chart', symbol: 'PTT', range };
    assert.deepEqual(domain.parseNavigationState(domain.navigationUrl(state)), state);
    assert.ok(!domain.navigationUrl(state).includes('timeframe'));
    for (const timeframe of ['D','W','M']) for (const historicalRange of chart.HISTORICAL_RANGES) {
      const expanded = { ...state, timeframe, historicalRange };
      assert.deepEqual(domain.parseNavigationState(domain.navigationUrl(expanded)), expanded);
    }
  }
  assert.deepEqual(domain.parseNavigationState('/?symbol=PTT&range=1M#chart', { timeframe:'W', historicalRange:'5Y' }), {route:'chart',symbol:'PTT',range:'1M'});
  for (const timeframe of ['D','W','M']) {
    const old = domain.parseNavigationState(`/?symbol=PTT&range=1Y&timeframe=${timeframe}&historicalRange=ALL#chart`);
    assert.equal(old.historicalRange, '5Y');
    assert.ok(domain.navigationUrl(old).includes('historicalRange=5Y'));
    assert.equal(domain.navigationUrl({...old,historicalRange:'ALL'}), domain.navigationUrl(old));
  }
  assert.ok(!chart.HISTORICAL_RANGES.includes('ALL'), 'ALL remains deferred, not a visible range');
});

test('5Y uses the existing guarded Yahoo daily path and preserves quotes', async () => {
  const calls = [], standard = responder(calls);
  const service = createMarketService({ env: {}, now: () => received, fetchImpl: async input => {
    const url = new URL(input);
    if (url.searchParams.get('range') !== '5y') return standard(input);
    calls.push({ range:'5y', interval:url.searchParams.get('interval') });
    const rows = barsBetween(received - 800 * 86400000, received, '1d');
    return {ok:true,json:async()=>({chart:{result:[payload('PTT.BK','1d',rows.rows,rows.periods)]}})};
  }});
  const market = await service.getMarket(['PTT'], 'PTT', '1Y', {fiveYearDailyHistory:true});
  assert.ok(market.history.length > 365); assert.equal(market.stocks[0].symbol, 'PTT');
  assert.equal(calls.filter(call => call.range === '5y').length, 1);
  assert.equal(calls.find(call => call.range === '5y').interval, '1d');
  assert.ok(calls.every(call => call.range !== 'max'), 'never fetch max and truncate afterward');
  const visible = chart.marketTimeframe(market, 'D', '5Y');
  assert.deepEqual(visible.history.map(fields), market.history.map(fields), 'shorter available history is shown without filling missing years');
});

for (const timeframe of ['D','W','M']) test(`5Y ${timeframe} retains actual calendar intervals, OHLCV and bounded warm-up`, () => {
  const start = new Date(received); start.setUTCFullYear(start.getUTCFullYear() - 5);
  const data = barsBetween(+start, received, '1d');
  const service = createMarketService({now:()=>received,env:{}});
  const source = service.shapeChart(payload('PTT.BK','1d',data.rows,data.periods),'PTT','chart:5y:1d');
  const market = {history:source.history,indicatorHistory:source.history,levelsHistory:source.history,
    fetchedAt:new Date(received).toISOString(),technicalMeta:{history:source.provenance,indicator:source.provenance,levels:source.provenance}};
  const selected = chart.marketTimeframe(market,timeframe,'5Y');
  const groups = new Map();
  for (const row of source.history) {
    const date = new Date(row.time + 25200000);
    if (timeframe === 'W') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() || 7) + 1);
    const key = date.toISOString().slice(0,timeframe === 'M' ? 7 : 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const expected = [...groups.values()].map(rows=>({time:rows[0].time,open:rows[0].open,
    high:Math.max(...rows.map(row=>row.high)),low:Math.min(...rows.map(row=>row.low)),
    close:rows.at(-1).close,volume:rows.reduce((sum,row)=>sum+row.volume,0)}));
  assert.deepEqual(selected.history.map(fields),expected);
  assert.ok(selected.history.every(row=>row.time >= +start && row.time <= received));
  assert.equal(selected.technicalMeta.history.interval,{D:'1d',W:'1wk',M:'1mo'}[timeframe]);
  const snapshot = technical.createTechnicalSnapshot({...selected,symbol:'PTT',timeframe});
  assert.ok(snapshot.signalRows.every(row=>row.complete && row.availableAt<=received));
  if (timeframe === 'M') {
    assert.ok(snapshot.signalRows.length >= 59 && snapshot.signalRows.length <= 61);
    assert.equal(snapshot.availability.ema100.state,'insufficient');
    assert.equal(snapshot.availability.ema200.state,'insufficient');
    const custom = technical.createTechnicalSnapshot({...selected,symbol:'PTT',timeframe,parameters:{ema20:100}});
    assert.equal(custom.availability.ema20.required,100);
    assert.equal(custom.availability.ema20.state,'insufficient');
  } else {
    assert.equal(snapshot.availability.ema200.state,'available');
  }
  const unknown = structuredClone(market); unknown.fetchedAt=null;
  for (const meta of Object.values(unknown.technicalMeta)) meta.receivedAt=null;
  const provisional = technical.createTechnicalSnapshot({...chart.marketTimeframe(unknown,timeframe,'5Y'),symbol:'PTT',timeframe});
  assert.equal(provisional.confirmation,'provisional');
  assert.equal(provisional.summary.status,'waiting-close');
  assert.ok(provisional.rows.length>0,'missing receipt time does not erase available real bars');
});

test('5Y preserves the selected guard reason without conflating quote metadata with historical bars', async () => {
 const calls=[],standard=responder(calls);
 const service=createMarketService({env:{},now:()=>received,fetchImpl:async input=>{
  const url=new URL(input);
  if(url.searchParams.get('range')!=='5y')return standard(input);
  const {rows,periods}=barsBetween(received-800*86400000,received,'1d');
  const raw=payload('TISCO.BK','1d',rows,periods);
  raw.meta.regularMarketChange=999; // synthetic quote-only mismatch; OHLC untouched
  return {ok:true,status:200,json:async()=>({chart:{result:[raw]}})};
 }});
 const market=await service.getMarket(['TISCO'],'TISCO','1Y',{fiveYearDailyHistory:true});
 assert.equal(market.dataState,'suspect');
 assert.deepEqual(market.guardReasons,['PRICE_CHANGE_MISMATCH']);
 const projected=chart.marketTimeframe(market,'D','5Y');
 assert.deepEqual(projected.guardReasons,['PRICE_CHANGE_MISMATCH']);
 const snapshot=technical.createTechnicalSnapshot({...projected,symbol:'TISCO',timeframe:'D',historicalRange:'5Y'});
 assert.equal(snapshot.summary.status,'ready');
 assert.ok(snapshot.quality.warnings.includes('PRICE_CHANGE_MISMATCH'));
 assert.equal(technical.createTechnicalSnapshot({...projected,symbol:'TISCO',timeframe:'D',historicalRange:'1Y'}).summary.status,'data-review');
});

test('unavailable 5Y history preserves the existing unavailable state and never invents bars', async () => {
  const calls=[], standard=responder(calls);
  const service=createMarketService({env:{},now:()=>received,fetchImpl:async input=>{
    if(new URL(input).searchParams.get('range')==='5y') return {ok:false,status:503};
    return standard(input);
  }});
  const market=await service.getMarket(['PTT'],'PTT','1Y',{fiveYearDailyHistory:true});
  assert.deepEqual(market.history,[]);assert.equal(market.dataState,'unavailable');
  for(const timeframe of ['D','W','M']) assert.deepEqual(chart.marketTimeframe(market,timeframe,'5Y').history,[]);
});
