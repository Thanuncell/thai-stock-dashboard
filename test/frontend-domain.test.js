'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let domain;
test.before(async () => { domain = await import('../client/domain.mjs'); });

test('dense intraday chart geometry stays within the viewport and preserves ordering', () => {
  const geometry = domain.chartGeometry({ rowCount: 292, hostWidth: 640, range: '1D' });
  assert.equal(geometry.width, 640);
  assert.ok(geometry.step > 1);
  assert.ok(geometry.candleWidth >= 1);
  assert.ok(geometry.x(0) < geometry.x(291));
  assert.ok(geometry.x(291) <= geometry.width - geometry.right);
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

test('Market Overview banner keeps validated Overview fields ahead of a later market response', () => {
  const resolved = domain.resolveMarketBannerFields({
    symbol: 'SET', last: 1546.05, change: -8.89, changePercent: -0.57,
    volumeThousand: 9921584, high: 1563.04, low: 1532.71, turnoverMillion: 43861.21
  }, {
    symbol: 'SET', guardStatus: 'accepted', last: 1546.1, prior: 1554.9,
    volume: null, high: null, low: null, turnoverMillionBaht: null
  });

  assert.equal(resolved.index.last, 1546.1);
  assert.equal(resolved.volumeThousand, 9921584);
  assert.deepEqual([resolved.high, resolved.low], [1563.04, 1532.71]);
  assert.equal(resolved.turnoverMillion, 43861.21);
  assert.deepEqual(resolved.sources, {
    index: 'market', volume: 'overview', range: 'overview', turnover: 'overview'
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
    index: 'market', volume: 'market', range: 'market', turnover: 'market'
  });

  const unavailable = domain.resolveMarketBannerFields({}, {
    symbol: 'SET', guardStatus: 'accepted', last: 1500, prior: 1490,
    volume: null, high: null, low: null, turnoverMillionBaht: null
  });
  assert.equal(unavailable.volumeThousand, null);
  assert.equal(unavailable.high, null);
  assert.equal(unavailable.low, null);
  assert.equal(unavailable.turnoverMillion, null);
});

test('Market Overview freshness label distinguishes current, partial and LKG data', () => {
  const fetchedAt = '2026-10-21T07:16:21.000Z';
  const fresh = domain.marketOverviewStatus({ fetchedAt, dataState: 'fresh', fieldStatus: {} });
  assert.match(fresh, /^แหล่งข้อมูล SETTRADE · อัปเดตล่าสุด: /);
  assert.doesNotMatch(fresh, /LKG|บางส่วนไม่พร้อม/);

  const partial = domain.marketOverviewStatus({ fetchedAt, dataState: 'partial', fieldStatus: {} });
  assert.match(partial, /บางส่วนไม่พร้อม$/);

  const lkg = domain.marketOverviewStatus({ fetchedAt, dataState: 'partial', fieldStatus: { nvdr: { state: 'LKG' } } });
  assert.match(lkg, /ข้อมูลที่บันทึกล่าสุด \(LKG\)$/);
});
