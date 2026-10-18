'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let domain;
test.before(async () => { domain = await import('../client/domain.mjs'); });

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
