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
  assert.equal(domain.escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
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
