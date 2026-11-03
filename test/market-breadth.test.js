'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSettradeMarket, classifySettradeParse } = require('../lib/settrade-parser');
const { parseHydratedMaiBreadth } = require('../lib/settrade-breadth-hydration');
const { createSettradeService } = require('../server/settrade-service');
const { createMarketOverviewSafety } = require('../server/market-overview-safety');

const table = (market, count = '12', volume = '1,234.50') => `<section><h2>${market}</h2><table><tr><th>สถานะ</th><th>จำนวนหลักทรัพย์</th><th>ปริมาณ ('000 หุ้น)</th></tr><tr><td>Gainers</td><td>${count}</td><td>${volume}</td></tr><tr><td>Unchanges</td><td>0</td><td>0</td></tr><tr><td>Losers</td><td>7</td><td>50</td></tr></table></section>`;
const page = body => '<h1>สรุปภาวะตลาด SET</h1>' + body;
const info = { symbol: 'mai', marketDateTime: '2026-11-03T10:00:00+07:00', gainerAmount: 23, gainerVolume: 456000, unchangedAmount: 0, unchangedVolume: 0, loserAmount: 4, loserVolume: 12000 };
const hydrated = value => page('<script>window.__NUXT__=' + JSON.stringify({ state: { summary: { index: { marketInfo: { mai: value } } } } }) + ';</script>');

test('breadth preserves market identity, semantic columns, units and real zero', () => {
  const parsed = parseSettradeMarket(page(table('SET') + table('mai', '23', '456')));
  assert.deepEqual(parsed.breadth.map(group => [group.market, group.items[0].count, group.items[0].volumeThousand]), [['SET', 12, 1234.5], ['mai', 23, 456]]);
  assert.equal(parsed.breadth[0].items[1].count, 0);
});

for (const invalid of ['-1', '1.5', '12 invalid', 'Infinity']) test('breadth rejects invalid count independently: ' + invalid, () => {
  const parsed = parseSettradeMarket(page(table('SET', invalid)));
  assert.equal(parsed.breadth[0].items[0].count, null);
  assert.equal(parsed.breadth[0].items[0].volumeThousand, 1234.5);
  assert.equal(parsed.__diagnostics.breadthCoverage.SET, 'INVALID_DATA');
});

test('breadth rejects negative volume while retaining independently valid count', () => {
  const parsed = parseSettradeMarket(page(table('mai', '12', '-5')));
  assert.deepEqual(parsed.breadth[0].items[0], { label: 'Gainers', count: 12, volumeThousand: null });
});

test('missing legacy count cannot shift volume into the count column', () => {
  const result = parseSettradeMarket(page('<h2>SET</h2><table><tr><td>Gainers</td><td></td><td>123</td></tr></table>'));
  assert.deepEqual(result.breadth[0].items[0], { label: 'Gainers', count: null, volumeThousand: 123 });
});

test('display projection always has two markets, three exact labels and no untrusted numbers', async () => {
  const { marketBreadthRows } = await import('../client/domain.mjs');
  for (const source of [undefined, null, {}, []]) {
    const groups = marketBreadthRows(source);
    assert.deepEqual(groups.map(group => group.market), ['SET', 'mai']);
    for (const group of groups) assert.deepEqual(group.items, ['Gainers', 'Unchanges', 'Losers'].map(label => ({ label, count: null, volumeThousand: null })));
  }
  const groups = marketBreadthRows([{ market: 'SET50', items: [{ label: 'Gainers', count: 999, volumeThousand: 999 }] },
    { market: 'SET', items: [{ label: 'Gainers', count: 0, volumeThousand: 2.5 }, { label: 'not Losers', count: 88 }, { label: 'Unchanges', count: '12', volumeThousand: -1 }] }]);
  assert.deepEqual(groups[0].items[0], { label: 'Gainers', count: 0, volumeThousand: 2.5 });
  assert.equal(groups[0].items[1].count, null); assert.equal(groups[0].items[2].count, null);
  assert.equal(groups[1].items[0].count, null);
});

test('mai hydration retains either verified cell when its companion is missing or invalid', () => {
  for (const [patch, expected] of [
    [{ gainerVolume: null }, { count: 23, volumeThousand: null }],
    [{ gainerAmount: null }, { count: null, volumeThousand: 456 }],
    [{ gainerAmount: -1 }, { count: null, volumeThousand: 456 }]
  ]) {
    const result = parseHydratedMaiBreadth(hydrated({ ...info, ...patch }), { pageIdentity: true });
    assert.deepEqual(result.group.items[0], { label: 'Gainers', ...expected });
  }
});

test('breadth distinguishes empty source, unlabeled mai rows and invalid hydration', () => {
  const empty = parseSettradeMarket(page('<p>no data</p>'));
  assert.equal(classifySettradeParse('breadth', empty), 'SOURCE_NO_DATA');
  const missing = parseSettradeMarket(page('<h2>SET</h2><table><tr><td>Gainers</td><td>—</td><td>—</td></tr></table>'));
  assert.equal(classifySettradeParse('breadth', missing), 'SOURCE_NO_DATA');
  assert.equal(missing.__diagnostics.breadthCoverage.SET, 'SOURCE_NO_DATA');
  const unlabeled = parseSettradeMarket(page('<h2>mai</h2><table><tr><th>จำนวนหลักทรัพย์</th><th>ปริมาณ</th></tr><tr><td>99</td><td>777</td></tr></table>'));
  assert.deepEqual(unlabeled.breadth, []);
  assert.equal(unlabeled.__diagnostics.breadthCoverage.mai, 'PARSER_MISMATCH');
  const invalid = parseHydratedMaiBreadth(hydrated({ ...info, marketDateTime: 'invalid' }), { pageIdentity: true });
  assert.equal(invalid.outcome, 'INVALID_DATA'); assert.equal(invalid.group, null);
});

test('mai hydration never overwrites labeled HTML or accepts a different market', () => {
  const parsed = parseSettradeMarket(page(table('SET') + table('mai', '8')) + hydrated(info));
  assert.equal(parsed.breadth.find(group => group.market === 'mai').items[0].count, 8);
  const wrong = parseHydratedMaiBreadth(hydrated({ ...info, symbol: 'SET' }), { pageIdentity: true });
  assert.equal(wrong.group, null); assert.equal(wrong.outcome, 'PARSER_MISMATCH');
});

test('overview integration keeps partial diagnostics and does not add acquisition calls', async () => {
  const requests = [];
  const fetchImpl = async url => { requests.push(String(url)); return new Response(String(url).includes('/overview') ? page(table('SET')) + hydrated({ ...info, gainerVolume: null }) : '<p>no data</p>'); };
  const safety = createMarketOverviewSafety({ fetchImpl, minSpacingMs: 0, maxAttempts: 1 });
  const service = createSettradeService({ fetchImpl, safety, now: () => Date.parse(info.marketDateTime), tfexSource: { getSnapshot: async () => ({ value: {}, status: {} }), snapshot: () => ({}) } });
  const { value } = await service.getOverview();
  assert.equal(value.breadth.find(group => group.market === 'mai').items[0].count, 23);
  assert.equal(value.fieldStatus.breadth.partial, true);
  assert.deepEqual(value.fieldStatus.breadth.marketCoverage, { SET: 'ACCEPT', mai: 'PARSER_MISMATCH' });
  assert.equal(requests.length, 4);
  assert.equal(requests.filter(url => url.includes('/overview')).length, 1);
});

test('overview keeps invalid SET diagnostics even when mai remains usable', async () => {
  const fetchImpl = async url => new Response(String(url).includes('/overview') ? page(table('SET', '-1') + table('mai', '23', '456')) : '<p>no data</p>');
  const safety = createMarketOverviewSafety({ fetchImpl, minSpacingMs: 0, maxAttempts: 1 });
  const service = createSettradeService({ fetchImpl, safety, tfexSource: { getSnapshot: async () => ({ value: {}, status: {} }), snapshot: () => ({}) } });
  const { value } = await service.getOverview();
  assert.equal(value.breadth.find(group => group.market === 'SET').items[0].count, null);
  assert.equal(value.breadth.find(group => group.market === 'mai').items[0].count, 23);
  assert.equal(value.fieldStatus.breadth.partial, true);
  assert.deepEqual(value.fieldStatus.breadth.marketCoverage, { SET: 'INVALID_DATA', mai: 'ACCEPT' });
  assert.equal(value.fieldStatus.breadth.coverageReason, 'BREADTH_INVALID_DATA');
});
