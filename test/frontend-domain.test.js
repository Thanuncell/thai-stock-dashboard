'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let domain;
test.before(async () => { domain = await import('../client/domain.mjs'); });

test('display rules never block actual AI and negative verification cannot inherit analysis',()=>{
 const item={title:'PTT',analysisMode:'rules',analysisSummary:'Read-time rules',verification:{status:'VERIFIED'}};
 assert.equal(domain.newsDisplayAnalysis(item).mode,'rules');
 assert.equal(domain.newsDisplayAnalysis(item,{mode:'ai',summary:'Real AI result'}).mode,'ai');
 assert.equal(domain.newsDisplayAnalysis(item,{mode:'unavailable',summary:''}).mode,'rules');
 for(const status of ['UNVERIFIED','REJECTED'])assert.equal(domain.newsDisplayAnalysis({...item,verification:{status}},{mode:'ai',summary:'Other result'}),null);
 assert.equal(domain.newsDisplayAnalysis({...item,analysisMode:'',analysisSummary:''}),null);
 assert.equal(domain.sentimentHeadline('PTT กำไรเพิ่ม'),'บวก');assert.equal(domain.sentimentHeadline('PTT ขาดทุน'),'ลบ');
 assert.equal(domain.sentimentHeadline('PTT รายงานข้อมูล'),'เป็นกลาง');
});

test('analysis requests stay below endpoint budget without timers and cooldown can expire',()=>{
 const calls=[];for(let time=0;time<60000;time+=100){if(domain.canRequestNewsAnalysis(time,calls))calls.push(time);}
 assert.equal(calls.length,6);assert.equal(domain.canRequestNewsAnalysis(59999,calls),false);
 assert.equal(domain.canRequestNewsAnalysis(60000,calls),true);
 assert.equal(domain.canRequestNewsAnalysis(61000,[],62000),false);assert.equal(domain.canRequestNewsAnalysis(62000,[],62000),true);
});

test('Search display formats reviewed SEC names without modifying source records or symbols', () => {
  const { rows } = require('./fixtures/search-company-display.json');
  const before = structuredClone(rows);
  const cached = rows.map(row => Object.freeze({symbol:row.symbol,name:row.company_name_en}));
  for (const row of cached) Object.freeze(row);
  for (const [index, row] of rows.entries()) {
    assert.equal(domain.formatSearchCompanyName(cached[index].name, row.symbol), row.display, row.symbol);
    assert.equal(domain.formatSearchCompanyName(row.display, row.symbol), row.display, 'stable display: ' + row.symbol);
    assert.equal(row.company_name_en.replace(/\p{L}/gu, ''), row.display.replace(/\p{L}/gu, ''), 'punctuation: ' + row.symbol);
  }
  assert.deepEqual(rows, before);
  assert.deepEqual(cached, before.map(row => ({symbol:row.symbol,name:row.company_name_en})));
});

test('Search display preserves initialisms, brand casing and punctuation', () => {
  for (const [source, expected] of [
    ['PTT, SCG & CP PUBLIC COMPANY LIMITED', 'PTT, SCG & CP Public Company Limited'],
    ['B.GRIMM POWER PUBLIC COMPANY LIMITED', 'B.Grimm Power Public Company Limited'],
    ['S&P SYNDICATE PUBLIC COMPANY LIMITED', 'S&P Syndicate Public Company Limited'],
    ['P.C.S. MACHINE GROUP HOLDING PUBLIC COMPANY LIMITED', 'P.C.S. Machine Group Holding Public Company Limited'],
    ["O'REILLY (THAILAND) PUBLIC CO., LTD.", "O'Reilly (Thailand) Public Co., Ltd."],
    ['  AMATA  CORPORATION — PUBLIC COMPANY LIMITED  ', '  Amata  Corporation — Public Company Limited  ']
  ]) assert.equal(domain.formatSearchCompanyName(source), expected);
});

test('Search display keeps existing mixed casing and symbol-only fallbacks unchanged', () => {
  for (const name of ['B.Grimm Power Public Company Limited', 'i-Tail Corporation Public Company Limited',
    'BlueVenture Group Public Company Limited', 'S&P Syndicate Public Company Limited', 'all lowercase', 'บริษัททดสอบ']) {
    assert.equal(domain.formatSearchCompanyName(name), name);
  }
  for (const symbol of ['AMATA', 'PTT', 'S&P', 'L&E', 'THCOM']) assert.equal(domain.formatSearchCompanyName(symbol, symbol), symbol);
  assert.equal(domain.formatSearchCompanyName(''), '');
  assert.equal(domain.formatSearchCompanyName(null), '');
});

test('dense intraday chart geometry stays within the viewport and preserves ordering', () => {
  const geometry = domain.chartGeometry({ rowCount: 292, hostWidth: 640, range: '1D' });
  assert.equal(geometry.width, 640);
  assert.ok(geometry.step > 1);
  assert.ok(geometry.candleWidth >= 1);
  assert.ok(geometry.x(0) < geometry.x(291));
  assert.ok(geometry.x(291) <= geometry.width - geometry.right);
});

test('Footer Coverage accepts only fresh, valid persisted counts', () => {
  const valid = {
    configured: true, universe: 400, currentVerified: 321,
    lastChecked: '2026-10-24T01:00:00.000Z', provider: 'Yahoo Finance', dataState: 'fresh'
  };
  assert.deepEqual(domain.coverageDisplayState(valid), {
    ready: true, reason: null, universe: 400, currentVerified: 321
  });
  assert.equal(domain.coverageDisplayState({ ...valid, universe: null }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, dataState: 'stale' }).reason, 'stale');
  assert.equal(domain.coverageDisplayState({ ...valid, currentVerified: 401 }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, currentVerified: '321' }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, provider: 'fixture' }).reason, 'invalid');
  assert.equal(domain.coverageDisplayState({ ...valid, currentUsable: 0 }).currentVerified, 0);
  assert.equal(domain.coverageDisplayState({ ...valid, currentUsable: null }).reason, 'invalid');
});

test('chart viewport defaults to a useful latest window without changing the dataset', () => {
  assert.deepEqual(domain.defaultChartViewport({ rowCount: 200, hostWidth: 390, range: '1D' }), {
    start: 158, end: 200, followLatest: true
  });
  assert.deepEqual(domain.defaultChartViewport({ rowCount: 8, hostWidth: 390, range: '1D' }), {
    start: 0, end: 8, followLatest: true
  });
});

test('chart zoom preserves its anchor and pan remains bounded in cached rows', () => {
  const initial = { start: 100, end: 150, followLatest: false };
  const zoomed = domain.zoomChartViewport(initial, 200, .5, .5);
  assert.deepEqual(zoomed, { start: 113, end: 138, followLatest: false });
  assert.deepEqual(domain.panChartViewport(zoomed, 200, -999), { start: 0, end: 25, followLatest: false });
  assert.deepEqual(domain.panChartViewport(zoomed, 200, 999), { start: 175, end: 200, followLatest: true });
});

test('adaptive price axis uses only visible valid values and does not invent missing prices', () => {
  const axis = domain.chartPriceAxis([
    { low: 98, high: 103 },
    { low: 99, high: 104 },
    { low: null, high: undefined }
  ], [100, null]);
  assert.equal(axis.min, 97.52);
  assert.equal(axis.max, 104.48);
  assert.equal(domain.chartPriceAxis([{ low: null, high: null }]), null);
});

test('workspace routing preserves canonical and legacy hashes', () => {
  assert.equal(domain.pageFromHash('#overview'), 'overview');
  assert.equal(domain.pageFromHash('#chart-section'), 'chart');
  assert.equal(domain.pageFromHash('#news-section'), 'news');
  assert.equal(domain.pageFromHash('#top'), 'overview');
  assert.equal(domain.pageFromHash('#unknown'), 'overview');
});

test('watchlists stay bounded and reject invalid symbols without inventing items', () => {
  const normalized = domain.normalizeLists([{
    id: 'list-1',
    name: ' Main ',
    items: [{ symbol: 'PTT', name: 'ปตท.' }, { symbol: '../BAD' }, null]
  }]);
  assert.equal(normalized[0].name, 'Main');
  assert.deepEqual(normalized[0].items, [{ symbol: 'PTT', name: 'ปตท.' }]);
  assert.equal(domain.mergeWatchlists(normalized, []), normalized);
});

test('a valid Watchlist URL selection wins over cloud and local active selections', () => {
  const lists = [{ id: 'list-1' }, { id: 'list-2' }];
  assert.equal(domain.resolveActiveWatchlistId(lists, {
    requestedId: 'list-2',
    cloudId: 'list-1',
    localId: 'list-1'
  }), 'list-2');
  assert.equal(domain.resolveActiveWatchlistId(lists, {
    requestedId: 'stale-list',
    cloudId: 'list-1',
    localId: 'list-2'
  }), 'list-1');
});

test('news search includes an analysis summary but does not fabricate a match', () => {
  const item = { title: 'PTT update', sourceName: 'SET News', snippet: '' };
  assert.equal(domain.matchesNewsQuery(item, 'กำไร', 'กำไรเติบโต'), true);
  assert.equal(domain.matchesNewsQuery(item, 'ขาดทุน', ''), false);
});

test('pagination and escaping preserve frontend output contracts', () => {
  assert.deepEqual(domain.pageList(5, 10), [1, 2, '…', 4, 5, 6, '…', 9, 10]);
  assert.deepEqual(domain.pageList(1, 1), [1]);
  assert.deepEqual(domain.pageList(1, 2), [1, 2]);
  assert.deepEqual(domain.pageList(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(domain.pageList(22, 43), [1, 2, '…', 21, 22, 23, '…', 42, 43]);
  assert.equal(domain.escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

test('featured news is source-aware and excluded from the latest list', () => {
  const now = Date.parse('2026-10-18T00:00:00.000Z');
  const items = [
    { source: 'infoquest', title: 'IQ recent', pubDate: '2026-10-17T00:00:00.000Z' },
    { source: 'infoquest', title: 'IQ older', pubDate: '2026-10-01T00:00:00.000Z' },
    { source: 'efinance', title: 'EF recent', pubDate: '2026-10-16T00:00:00.000Z' }
  ];
  const selected = domain.selectNewsForDisplay(items, { source: 'infoquest', now });
  assert.deepEqual(selected.featured.map(item => item.title), ['IQ recent']);
  assert.deepEqual(selected.latest.map(item => item.title), ['IQ older']);
});

test('canonical URL state restores all four workspaces and rejects stale input', () => {
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/#overview'), { route: 'overview' });
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?symbol=ptt&range=1M#chart'), {
    route: 'chart', symbol: 'PTT', range: '1M'
  });
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?s=PTT&source=infoquest&newsPage=12#news'), {
    route: 'news', query: 'PTT', source: 'infoquest', newsPage: 12
  });
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?watchlist=list-2&watchPage=4#watchlist'), {
    route: 'watchlist', watchlistId: 'list-2', watchPage: 4
  });
  assert.equal(domain.navigationUrl({ route: 'chart', symbol: 'PTT', range: '1M' }), '/?symbol=PTT&range=1M#chart');
  assert.equal(domain.navigationUrl({ route: 'news', query: '<PTT>', source: 'invalid', newsPage: -2 }), '/?s=%3CPTT%3E#news');
  assert.deepEqual(domain.parseNavigationState('https://setscope.test/?token=secret&source=bad&newsPage=NaN#news'), {
    route: 'news', query: '', source: 'all', newsPage: 1
  });
});

test('missing market values remain unavailable instead of becoming zero', () => {
  assert.equal(domain.toFiniteNumber(null), null);
  assert.equal(domain.toFiniteNumber(''), null);
  assert.equal(domain.toFiniteNumber('0'), 0);
  assert.deepEqual(domain.quoteChange(35.25, null), { change: null, percent: null });
  assert.deepEqual(domain.quoteChange(35.25, 35), { change: 0.25, percent: 0.25 / 35 * 100 });

  const unavailable = domain.summarizeBreadth([{ items: [
    { label: 'Gainers', count: null },
    { label: 'Losers', count: undefined }
  ] }]);
  assert.deepEqual(unavailable, { up: null, down: null, comparable: false });

  const validZero = domain.summarizeBreadth([{ items: [
    { label: 'Gainers', count: 0 },
    { label: 'Losers', count: 0 }
  ] }]);
  assert.deepEqual(validZero, { up: 0, down: 0, comparable: true });
});

test('Market Overview banner keeps one validated SETTRADE index snapshot after a later market response', () => {
  const resolved = domain.resolveMarketBannerFields({
    symbol: 'SET', last: 1546.05, change: -8.89, changePercent: -0.57,
    volumeThousand: 9921584, high: 1563.04, low: 1532.71, turnoverMillion: 43861.21
  }, {
    symbol: 'SET', guardStatus: 'accepted', last: 1546.1, prior: 1554.9,
    volume: null, high: null, low: null, turnoverMillionBaht: null
  });

  assert.equal(resolved.index.last, 1546.05);
  assert.equal(resolved.volumeThousand, 9921584);
  assert.deepEqual([resolved.high, resolved.low], [1563.04, 1532.71]);
  assert.equal(resolved.turnoverMillion, 43861.21);
  assert.deepEqual(resolved.sources, {
    index: 'overview', volume: 'overview', range: 'overview', turnover: 'overview'
  });
});

test('Market Overview banner converts valid raw-share fallback volume to thousands without inventing missing values', () => {
  const fallback = domain.resolveMarketBannerFields(null, {
    symbol: 'SET', guardStatus: 'accepted', last: 1500, prior: 1490,
    volume: 1234567000, high: 1510, low: 1480, turnoverMillionBaht: 45678.9
  });
  assert.equal(fallback.volumeThousand, 1234567);
  assert.equal(fallback.turnoverMillion, 45678.9);
  assert.deepEqual(fallback.sources, {
    index: null, volume: 'market', range: 'market', turnover: 'market'
  });
  assert.equal(fallback.index, null);

  const unavailable = domain.resolveMarketBannerFields({}, {
    symbol: 'SET', guardStatus: 'accepted', last: 1500, prior: 1490,
    volume: null, high: null, low: null, turnoverMillionBaht: null
  });
  assert.equal(unavailable.volumeThousand, null);
  assert.equal(unavailable.high, null);
  assert.equal(unavailable.low, null);
  assert.equal(unavailable.turnoverMillion, null);
  assert.equal(unavailable.index, null);
});

test('Market Overview banner keeps truthful LKG or unavailable SETTRADE index state without Yahoo substitution', () => {
  const yahoo = {
    symbol: 'SET', guardStatus: 'accepted', last: 1498.25, prior: 1490,
    volume: 1000000, high: 1510, low: 1480, turnoverMillionBaht: 45000
  };
  const savedSettrade = { symbol: 'SET', last: 1502.75, change: -1.25, changePercent: -0.08 };
  const lkg = domain.resolveMarketBannerFields(savedSettrade, yahoo);

  assert.equal(lkg.index.last, 1502.75);
  assert.equal(lkg.sources.index, 'overview');
  const savedAt = '2026-10-23T07:30:00.000Z';
  const refreshedAt = '2026-10-23T08:00:00.000Z';
  const lkgStatus = domain.marketOverviewStatus({
    fetchedAt: refreshedAt,
    dataState: 'stale',
    fieldStatus: { indices: { state: 'LKG', stale: true, asOf: savedAt } }
  });
  assert.match(lkgStatus, /ข้อมูลที่บันทึกล่าสุด \(LKG\)$/);
  assert.ok(lkgStatus.includes(domain.stamp(savedAt)));
  assert.ok(!lkgStatus.includes(domain.stamp(refreshedAt)));

  const passAt = '2026-10-23T07:59:00.000Z';
  const passStatus = domain.marketOverviewStatus({
    fetchedAt: refreshedAt,
    dataState: 'delayed',
    fieldStatus: { indices: { state: 'PASS', asOf: passAt } }
  });
  assert.ok(passStatus.includes(domain.stamp(passAt)));

  const expired = domain.resolveMarketBannerFields(null, yahoo);
  assert.equal(expired.index, null);
  assert.equal(expired.sources.index, null);
});

test('Market Overview freshness label distinguishes current, partial and LKG data', () => {
  const fetchedAt = '2026-10-21T07:16:21.000Z';
  const fresh = domain.marketOverviewStatus({ fetchedAt, dataState: 'fresh', fieldStatus: {} });
  assert.match(fresh, /^แหล่งข้อมูล SETTRADE · อัปเดตล่าสุด: /);
  assert.doesNotMatch(fresh, /LKG|บางส่วนไม่พร้อม/);

  const partial = domain.marketOverviewStatus({ fetchedAt, dataState: 'partial', fieldStatus: {} });
  assert.doesNotMatch(partial, /บางส่วนไม่พร้อม/);

  const lkg = domain.marketOverviewStatus({ fetchedAt, dataState: 'partial', fieldStatus: { nvdr: { state: 'LKG' } } });
  assert.match(lkg, /ข้อมูลที่บันทึกล่าสุด \(LKG\)$/);
});
test('one news URL keeps the same identity across Live Featured and Archive Latest', () => {
  const date = '2026-10-27T04:00:00.000Z';
  const article = { source: 'kaohoon', title: 'PTT รายงานผลประกอบการ', url: 'https://www.kaohoon.com/news/abc?utm_source=rss', pubDate: date };
  const archived = { ...article, url: 'https://www.kaohoon.com/news/abc', fingerprint: 'sha256-archive-fingerprint' };
  const official = { source: 'official', title: 'BOT ประกาศแนวทางใหม่', url: 'https://www.bot.or.th/news/official', pubDate: date };
  const options = { now: Date.parse(date) + 1000, featuredCount: 1, sourceTier: { official: 4, kaohoon: 2 } };
  const category = domain.selectNewsForDisplay([article, official], { ...options, source: 'kaohoon' });
  const all = domain.selectNewsForDisplay([article, official], { ...options, source: 'all' });
  assert.equal(category.featured[0].url, article.url);
  assert.equal(all.featured[0].url, official.url);
  assert.equal(all.latest[0].url, article.url);
  assert.equal(domain.newsKey(category.featured[0]), domain.newsKey(archived));
  assert.equal(domain.newsKey(all.latest[0]), domain.newsKey(archived));
  assert.notEqual(domain.newsKey(article), domain.newsKey(official));
});

test('Watchlist News empty, partial and unavailable are not conflated', () => {
  assert.equal(domain.watchlistNewsViewState({items:[],dataState:'fresh'}), 'empty');
  assert.equal(domain.watchlistNewsViewState({items:[],dataState:'unavailable'}), 'unavailable');
  assert.equal(domain.watchlistNewsViewState({items:[{title:'news'}],dataState:'partial'}), 'partial');
  assert.equal(domain.watchlistNewsViewState({items:[{title:'news'}],dataState:'stale',stale:true}), 'stale');
  assert.equal(domain.watchlistNewsViewState({items:[{title:'news'}],dataState:'fresh'}), 'fresh');
  assert.equal(domain.watchlistNewsViewState({error:'broken'}), 'error');
});
