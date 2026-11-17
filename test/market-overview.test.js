'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSettradeActiveValue,
  parseSettradeTfex
} = require('../lib/settrade-parser');
const { parseHydratedMostActive, selectMostActiveResponse, isRenderableActiveRow } = require('../lib/settrade-active-hydration');
const { createMarketOverviewSafety: createSafety, explicitAccessDenial } = require('../server/market-overview-safety');
const { createMarketOverviewService } = require('../server/market-overview-service');
const { createSettradeService: createService } = require('../server/settrade-service');
const { createTfexHomeSource } = require('../server/tfex-home-source');
const { PROVIDER_POLICIES } = require('../server/reliability');

// Both independent source adapters share only this test's mock transport.
const transports = new WeakMap();
function createMarketOverviewSafety(options) {
  const safety = createSafety(options); transports.set(safety, options.fetchImpl); return safety;
}
function createSettradeService(options) {
  return createService({ ...options, fetchImpl: options.fetchImpl || transports.get(options.safety),
    now: options.now || (() => Date.parse('2026-10-20T22:20:00+07:00')) });
}

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const htmlResponse = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' }
});

const contractTime = '2026-11-02T16:51:48.186602634+07:00';
function contractHtml(stocks, extra = {}) {
  return '<h1>Most Active Value</h1><script>window.__NUXT__=' + JSON.stringify({ state: { summary: { topRanking: { info: {
    rankingType: 'mostActiveValue', market: 'SET', marketDateTime: contractTime, rankingPeriod: null, stocks, ...extra
  } } } } }) + ';</script>';
}
const contractRow = (extra = {}) => ({ symbol: 'UNITA', aomValue: 4864493400, aomVolume: 24004200,
  totalValue: 4876588321, totalVolume: 24064271, last: 199.5, change: -3.5, percentChange: -1.724138,
  low: 199.5, high: 208, ...extra });

test('AOM contract: reviewed baht/share conversion retains exact raw fields and never borrows totals', () => {
  const row = parseHydratedMostActive(contractHtml([contractRow()])).items[0];
  assert.equal(row.turnoverMillion, 4864.4934); assert.equal(row.volumeThousand, 24004.2);
  assert.deepEqual(row.sourceQuantities, { origin: 'SETTRADE_AOM', basis: 'SET_AOM_BAHT_SHARES', verification: 'EVIDENCE_SUPPORTED',
    value: { sourceField: 'aomValue', raw: 4864493400, unit: 'baht' }, volume: { sourceField: 'aomVolume', raw: 24004200, unit: 'shares' } });
  assert.equal(isRenderableActiveRow(row), true);
});

for (const value of [0, 4864.4934, 4864493400]) test('AOM contract: raw is retained and exactly one conversion applies regardless of magnitude: ' + value, () => {
  const row = parseHydratedMostActive(contractHtml([contractRow({ aomValue: value, aomVolume: value })])).items[0];
  assert.equal(row.sourceQuantities.value.raw, value); assert.equal(row.sourceQuantities.volume.raw, value);
  assert.equal(row.turnoverMillion, value / 1000000); assert.equal(row.volumeThousand, value / 1000);
});

test('AOM contract: invalid raw fields cannot borrow valid totals or become renderable', () => {
  for (const extra of [{ aomValue: -1 }, { aomVolume: null }, { aomValue: '4864493400' }, { last: null }]) {
    const chosen = selectMostActiveResponse(contractHtml([contractRow(extra)]), parseSettradeActiveValue(contractHtml([contractRow(extra)])), true);
    assert.deepEqual(chosen.items, []);
  }
});

test('AOM contract: conflicting raw amounts are rejected before PASS/LKG', () => {
  const result = parseHydratedMostActive(contractHtml([contractRow(), contractRow({ aomValue: 1 })]));
  assert.equal(result.items.length, 0); assert.equal(result.conflictingRows, 2); assert.equal(result.outcome, 'INVALID_DATA');
});

test('AOM contract: repeated conversion, unsupported basis or wrong raw units fail validation', () => {
  const row = parseHydratedMostActive(contractHtml([contractRow()])).items[0];
  assert.equal(isRenderableActiveRow({ ...row, turnoverMillion: 0.0048644934 }), false);
  assert.equal(isRenderableActiveRow({ ...row, sourceQuantities: { ...row.sourceQuantities, basis: 'UNSUPPORTED' } }), false);
  assert.equal(isRenderableActiveRow({ ...row, sourceQuantities: { ...row.sourceQuantities,
    value: { ...row.sourceQuantities.value, unit: 'million_baht' } } }), false);
});

test('AOM contract: explicit HTML units are already normalized and are never divided again', () => {
  const row = selectMostActiveResponse(fixture('settrade-active-value.html'), parseSettradeActiveValue(fixture('settrade-active-value.html')), true).items[0];
  assert.equal(row.turnoverMillion, 4521.3); assert.equal(row.volumeThousand, 25100.5);
  assert.equal(row.sourceQuantities, undefined);
});

test('AOM contract: a generic HTML Value/Volume header does not prove millions or thousands', () => {
  const html = fixture('settrade-active-value.html').replace(/มูลค่า AOM \(ล้านบาท\)/g, 'Value').replace(/ปริมาณ AOM \('000 หุ้น\)/g, 'Volume');
  const row = selectMostActiveResponse(html, parseSettradeActiveValue(html), true).items[0];
  assert.equal(row.turnoverMillion, null); assert.equal(row.volumeThousand, null);
  assert.equal(row.sourceQuantities.origin, 'HTML_TABLE'); assert.equal(row.sourceQuantities.value.raw, 4521.3);
});

test('AOM contract: unsupported USD or million-share HTML labels stay raw rather than being treated as baht/thousands', () => {
  const html = fixture('settrade-active-value.html').replace(/มูลค่า AOM \(ล้านบาท\)/g, 'Value (million USD)').replace(/ปริมาณ AOM \('000 หุ้น\)/g, 'Volume (1,000,000 shares)');
  const row = selectMostActiveResponse(html, parseSettradeActiveValue(html), true).items[0];
  assert.equal(row.turnoverMillion, null); assert.equal(row.volumeThousand, null);
  assert.equal(row.sourceQuantities.value.unit, null); assert.equal(row.sourceQuantities.volume.unit, null);
});

test('AOM contract: twenty valid rows retain raw quantities and unknown session through snapshot, LKG and expiry', async () => {
  const h = freshnessHarness({ start: '2026-11-02T16:52:07+07:00' });
  h.bodies.set('https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value', contractHtml(Array.from({ length: 20 }, (_, i) => contractRow({ symbol: 'UNIT' + (i + 1) }))));
  const a = (await h.service.getOverview()).value, s = a.fieldStatus.activeValue;
  assert.equal(a.activeValue.length, 20); assert.equal(s.quantityStatus, 'EVIDENCE_SUPPORTED'); assert.equal(s.quantityBasis, 'SET_AOM_BAHT_SHARES');
  assert.equal(s.coverageReason, undefined); assert.equal(s.partial, undefined);
  assert.equal(s.tradingSession, null); assert.equal(s.tradingSessionDate, null); assert.equal(s.marketEffectiveTime, null); assert.equal(s.sourceRankingPeriod, null);
  assert.equal(s.sourceUpdatedAt, contractTime); assert.equal(s.fetchedAt, '2026-11-02T09:52:07.000Z'); assert.equal(s.asOf, null);
  h.bodies.set('https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value', '<h1>Most Active Value</h1><p>Symbol no data</p>');
  h.time('2026-11-02T16:58:00+07:00'); const saved = (await h.service.getOverview()).value;
  assert.equal(saved.fieldStatus.activeValue.state, 'LKG'); assert.deepEqual(saved.activeValue, a.activeValue);
  assert.equal(saved.fieldStatus.activeValue.fetchedAt, s.fetchedAt); assert.equal(saved.fieldStatus.activeValue.sourceUpdatedAt, contractTime);
  assert.equal(saved.fieldStatus.activeValue.quantityStatus, 'EVIDENCE_SUPPORTED'); assert.equal(saved.fieldStatus.activeValue.quantityBasis, s.quantityBasis);
  assert.equal(saved.fieldStatus.activeValue.tradingSessionDate, null); assert.match(saved.activeValueStatus, /Trading Session ยังไม่ยืนยัน/);
  h.time('2026-11-02T17:23:00+07:00'); const expired = (await h.service.getOverview()).value;
  assert.deepEqual(expired.activeValue, []); assert.equal(expired.fieldStatus.activeValue.state, 'UNAVAILABLE');
});

test('AOM contract: normalized API rows cannot be parsed again as raw provider fields', () => {
  const row = parseHydratedMostActive(contractHtml([contractRow()])).items[0];
  const parsedAgain = parseHydratedMostActive(contractHtml([row]));
  assert.equal(parsedAgain.items.length, 0); assert.equal(parsedAgain.outcome, 'INVALID_DATA');
});

test('AOM contract: rankingPeriod is preserved as source metadata, never promoted to a trading date', async () => {
  const h = freshnessHarness({ start: '2026-11-02T16:52:07+07:00' });
  h.bodies.set('https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value', contractHtml([contractRow()], { rankingPeriod: '2026/11/02' }));
  const s = (await h.service.getOverview()).value.fieldStatus.activeValue;
  assert.equal(s.sourceRankingPeriod, '2026/11/02'); assert.equal(s.tradingSessionDate, null); assert.equal(s.marketEffectiveTime, null);
});

test('AOM contract: legacy cached quantities without provenance cannot become a new PASS or LKG', async () => {
  const h = freshnessHarness(); const legacy = (await h.service.getOverview()).value;
  delete legacy.fieldStatus.activeValue.quantityStatus;
  let calls = 0;
  const service = createService({ now: () => Date.parse('2026-10-20T22:20:00+07:00'),
    fetchImpl: async () => { calls++; throw Error('No cache-hit acquisition'); },
    cache: { get: async () => ({ value: legacy, meta: { status: 'hit' } }) } });
  const value = (await service.getOverview()).value;
  assert.deepEqual(value.activeValue, []); assert.equal(value.fieldStatus.activeValue.state, 'UNAVAILABLE');
  assert.equal(value.fieldStatus.activeValue.reason, 'QUANTITY_PROVENANCE_UNVERIFIED'); assert.equal(calls, 0);
});

function freshnessHarness({ start = '2026-10-20T22:20:00+07:00', longCache = false } = {}) {
  let clock = Date.parse(start), calls = 0;
  const bodies = new Map();
  const fetchImpl = async url => { calls++; return htmlResponse(bodies.get(String(url)) ?? responseFor(url)); };
  const safety = createSafety({ fetchImpl, now: () => clock, minSpacingMs: 0, maxAttempts: 1, maxRequestsPerWindow: 100 });
  let cached;
  const cache = longCache ? { async get(key, policy, load) {
    if (!cached) cached = await load();
    return { value: cached, meta: { status: 'hit' } };
  } } : undefined;
  const service = createService({ fetchImpl, safety, now: () => clock, ...(cache ? { cache } : {}) });
  return { service, bodies, calls: () => calls, time: value => { clock = typeof value === 'string' ? Date.parse(value) : value; } };
}

test('P1 synthetic October fixture at November runtime is rejected, never seeded as current TFEX or ranking', async () => {
  const h = freshnessHarness({ start: '2026-11-02T15:20:00+07:00' });
  const v = (await h.service.getOverview()).value;
  assert.equal(v.tfex.available, false); assert.equal(v.tfex.totalVolume, null); assert.equal(v.tfex.openInterest, null);
  assert.equal(v.fieldStatus.tfex.state, 'UNAVAILABLE'); assert.equal(v.fieldStatus.tfex.reason, 'SOURCE_TIME_UNVERIFIED');
  assert.deepEqual(v.activeValue, []); assert.equal(v.fieldStatus.activeValue.state, 'UNAVAILABLE');
  assert.doesNotMatch(v.activeValueStatus, /ข้อมูลล่าสุด/); assert.equal(v.fieldStatus.indices.state, 'PASS');
  h.bodies.set('https://www.tfex.co.th/th/home', '<title>TFEX</title>');
  h.time('2026-11-02T15:26:00+07:00');
  assert.equal((await h.service.getOverview()).value.fieldStatus.tfex.state, 'UNAVAILABLE');
});

test('P1 clock rollback cannot expose future receipt TFEX or Most Active as PASS or LKG', async () => {
  const h = freshnessHarness({ longCache: true }); await h.service.getOverview();
  h.time('2026-10-20T22:19:40+07:00');
  const v = (await h.service.getOverview()).value;
  assert.equal(v.fieldStatus.tfex.state, 'UNAVAILABLE'); assert.equal(v.tfex.available, false);
  assert.equal(v.fieldStatus.activeValue.state, 'UNAVAILABLE'); assert.deepEqual(v.activeValue, []);
  assert.equal(h.calls(), 5);
});

test('P1 completed-session snapshot is explicitly classified, dated and never relabelled Fresh', async () => {
  const h = freshnessHarness({ start: '2026-11-01T12:00:00+07:00' });
  h.bodies.set('https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value',
    fixture('settrade-active-value.html').replace('20 ต.ค. 2569 22:19:18', '30 ต.ค. 2569 16:40:00'));
  const v = (await h.service.getOverview()).value, s = v.fieldStatus.activeValue;
  assert.equal(s.state, 'PASS'); assert.equal(s.sessionContext, 'SESSION_SNAPSHOT');
  assert.equal(s.freshness, 'SESSION_SNAPSHOT'); assert.equal(s.freshnessVerified, false);
  assert.equal(s.asOf, null); assert.equal(s.reportedAsOf, '30 ต.ค. 2569 16:40:00');
  assert.equal(s.sourceUpdatedAt, '2026-10-30T16:40:00+07:00');
  assert.match(v.activeValueStatus, /Snapshot/); assert.match(v.activeValueStatus, /30 ต.ค. 2569/);
  assert.doesNotMatch(v.activeValueStatus, /ข้อมูลล่าสุด/);
});

test('P1 cache hit crossing a completed-session boundary downgrades ranking to original dated LKG', async () => {
  const h = freshnessHarness({ start: '2026-10-20T17:14:00+07:00', longCache: true });
  h.bodies.set('https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value',
    fixture('settrade-active-value.html').replace('20 ต.ค. 2569 22:19:18', '19 ต.ค. 2569 16:40:00'));
  const original = (await h.service.getOverview()).value.fieldStatus.activeValue;
  h.time('2026-10-20T17:16:00+07:00');
  const v = (await h.service.getOverview()).value, s = v.fieldStatus.activeValue;
  assert.equal(s.state, 'LKG'); assert.equal(s.freshness, 'LKG'); assert.equal(s.freshnessVerified, false);
  assert.equal(s.reportedAsOf, original.reportedAsOf); assert.equal(s.fetchedAt, original.fetchedAt);
  assert.match(v.activeValueStatus, /ข้อมูลเก่า.*LKG/); assert.doesNotMatch(v.activeValueStatus, /ข้อมูลล่าสุด/);
  h.time('2026-10-20T17:44:01+07:00');
  const expired = (await h.service.getOverview()).value;
  assert.deepEqual(expired.activeValue, []); assert.equal(expired.fieldStatus.activeValue.state, 'UNAVAILABLE');
  assert.equal(h.calls(), 5);
});

for (const source of ['30 ก.พ. 2569 22:19:18', '21 ต.ค. 2569 22:19:18']) {
  test('P1 invalid/future TFEX source timestamp never seeds PASS or LKG: ' + source, async () => {
    const h = freshnessHarness(); h.bodies.set('https://www.tfex.co.th/th/home', fixture('tfex-home.html').replace('20 ต.ค. 2569 22:19:18', source));
    const v = (await h.service.getOverview()).value;
    assert.equal(v.fieldStatus.tfex.state, 'UNAVAILABLE'); assert.equal(v.tfex.totalVolume, null);
    assert.equal(v.fieldStatus.activeValue.state, 'PASS');
  });
}

test('P1 expired TFEX snapshot keeps original clock only as labelled LKG, then removes values without an extra GET', async () => {
  const h = freshnessHarness({ longCache: true }); const first = (await h.service.getOverview()).value.fieldStatus.tfex;
  h.time('2026-10-20T22:26:00+07:00'); const lkg = (await h.service.getOverview()).value;
  assert.equal(lkg.fieldStatus.tfex.state, 'LKG'); assert.equal(lkg.fieldStatus.tfex.freshness, 'LKG');
  assert.equal(lkg.fieldStatus.tfex.sourceUpdatedAt, first.sourceUpdatedAt); assert.equal(lkg.fieldStatus.tfex.fetchedAt, first.fetchedAt);
  assert.equal(lkg.fieldStatus.tfex.asOf, null); assert.equal(lkg.fieldStatus.tfex.freshnessVerified, false);
  h.time('2026-10-20T22:50:01+07:00'); const expired = (await h.service.getOverview()).value;
  assert.equal(expired.fieldStatus.tfex.state, 'UNAVAILABLE'); assert.equal(expired.tfex.totalVolume, null); assert.equal(h.calls(), 5);
});

function tfexHtmlAt(timestamp) {
  const local = new Date(Date.parse(timestamp) + 7 * 3600000);
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const label = `${local.getUTCDate()} ${months[local.getUTCMonth()]} ${local.getUTCFullYear() + 543} ${local.toISOString().slice(11, 19)}`;
  return fixture('tfex-home.html').replace('20 ต.ค. 2569 22:19:18', label);
}

function tfexRetentionHarness({ start = '2026-11-13T22:20:00+07:00', reportedAsOf = start, policy, enabled = true } = {}) {
  let clock = Date.parse(start), calls = 0;
  let respond = () => htmlResponse(tfexHtmlAt(reportedAsOf));
  const options = { enabled, now: () => clock, ...(policy ? { policy } : {}),
    fetchImpl: async () => { calls++; return respond(); } };
  let source = createTfexHomeSource(options);
  return { get source() { return source; }, calls: () => calls,
    time(value) { clock = typeof value === 'string' ? Date.parse(value) : value; },
    respond(value) { respond = value; }, restart() { source = createTfexHomeSource(options); } };
}

function assertTfexLkg(actual, original, reason) {
  assert.deepEqual(actual.value, original.value);
  assert.equal(actual.status.state, 'LKG'); assert.equal(actual.status.freshness, 'LKG');
  assert.equal(actual.status.stale, true); assert.equal(actual.status.freshnessVerified, false);
  for (const key of ['reportedAsOf', 'sourceUpdatedAt', 'fetchedAt', 'openInterestReference']) {
    assert.deepEqual(actual.status[key], original.status[key]);
  }
  for (const key of ['asOf', 'tradingSessionDate', 'volumeEffectiveTime', 'openInterestEffectiveTime']) {
    assert.equal(actual.status[key], null);
  }
  if (reason) assert.equal(actual.status.reason, reason);
}

for (const [age, state] of [[1_799_999, 'PASS'], [1_800_000, 'PASS'], [1_800_001, 'UNAVAILABLE']]) {
  test(`TFEX retention: PASS source-age boundary remains unchanged at ${age} ms`, async () => {
    const h = tfexRetentionHarness({ start: '2026-11-17T10:00:00+07:00',
      policy: { ...PROVIDER_POLICIES.settrade, ttlMs: 31 * 60000 } });
    const original = await h.source.getSnapshot();
    h.time(Date.parse('2026-11-17T10:00:00+07:00') + age);
    const actual = h.source.peekSnapshot();
    assert.equal(actual.status.state, state);
    if (state === 'PASS') assert.equal(actual.status.fetchedAt, original.status.fetchedAt);
    else assert.equal(actual.status.reason, 'SOURCE_TIME_UNVERIFIED');
    assert.equal(h.calls(), 1);
  });
}

for (const [when, state] of [
  ['2026-11-13T23:00:00+07:00', 'UNAVAILABLE'],
  ['2026-11-14T02:59:59+07:00', 'UNAVAILABLE'],
  ['2026-11-14T03:00:00+07:00', 'LKG'],
  ['2026-11-15T01:00:00+07:00', 'LKG'],
  ['2026-11-15T12:00:00+07:00', 'LKG'],
  ['2026-11-16T01:00:00+07:00', 'LKG'],
  ['2026-11-16T07:49:59+07:00', 'LKG'],
  ['2026-11-16T07:50:00+07:00', 'UNAVAILABLE']
]) {
  test('TFEX retention: Friday Night through weekend and Monday pre-open: ' + when, async () => {
    const h = tfexRetentionHarness(), original = await h.source.getSnapshot();
    h.time(when); const actual = h.source.peekSnapshot();
    assert.equal(actual.status.state, state);
    if (state === 'LKG') assertTfexLkg(actual, original, 'SOURCE_TIME_UNVERIFIED');
    else assert.equal(actual.value.totalVolume, null);
    assert.equal(h.calls(), 1);
  });
}

for (const [when, state] of [
  ['2026-11-17T01:00:00+07:00', 'UNAVAILABLE'],
  ['2026-11-17T03:00:00+07:00', 'LKG'],
  ['2026-11-17T07:49:59+07:00', 'LKG'],
  ['2026-11-17T07:50:00+07:00', 'UNAVAILABLE'],
  ['2026-11-17T12:00:00+07:00', 'UNAVAILABLE'],
  ['2026-11-17T17:20:00+07:00', 'UNAVAILABLE'],
  ['2026-11-17T18:45:00+07:00', 'UNAVAILABLE']
]) {
  test('TFEX retention: weekday closure never extends across Day or Night preparation: ' + when, async () => {
    const h = tfexRetentionHarness({ start: '2026-11-16T22:20:00+07:00' });
    const original = await h.source.getSnapshot(); h.time(when);
    const actual = h.source.peekSnapshot(); assert.equal(actual.status.state, state);
    if (state === 'LKG') assertTfexLkg(actual, original);
    assert.equal(h.calls(), 1);
  });
}

test('TFEX retention: consecutive calendar holidays retain old values only until the next pre-open', async () => {
  const h = tfexRetentionHarness({ start: '2026-04-10T22:20:00+07:00' });
  const original = await h.source.getSnapshot();
  for (const when of ['2026-04-13T12:00:00+07:00', '2026-04-14T12:00:00+07:00',
    '2026-04-15T12:00:00+07:00', '2026-04-16T07:49:59+07:00']) {
    h.time(when); assertTfexLkg(h.source.peekSnapshot(), original);
  }
  h.time('2026-04-16T07:50:00+07:00');
  assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE'); assert.equal(h.calls(), 1);
});

test('TFEX retention: the night preceding a calendar holiday keeps the ordinary LKG boundary', async () => {
  const h = tfexRetentionHarness({ start: '2026-10-22T22:20:00+07:00' });
  const original = await h.source.getSnapshot(); h.time('2026-10-23T02:59:59+07:00');
  assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE');
  h.time('2026-10-23T03:00:00+07:00'); assertTfexLkg(h.source.peekSnapshot(), original);
});

for (const start of ['2028-01-01T04:00:00+07:00', '2025-12-31T23:40:00+07:00']) {
  test('TFEX retention: uncovered current or previous calendar keeps ordinary expiry: ' + start, async () => {
    const h = tfexRetentionHarness({ start }); await h.source.getSnapshot();
    h.time(Date.parse(start) + 1_800_001);
    assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE'); assert.equal(h.calls(), 1);
  });
}

test('TFEX retention: repeated failures and peeks cannot move the 168-hour deadline', async () => {
  const start = '2026-11-15T04:00:00+07:00', h = tfexRetentionHarness({ start });
  const original = await h.source.getSnapshot();
  h.respond(() => htmlResponse('', 500)); h.time('2026-11-15T12:00:00+07:00');
  assertTfexLkg(await h.source.getSnapshot(), original, 'SOURCE_HTTP_ERROR');
  assertTfexLkg(await h.source.getSnapshot(), original); assert.equal(h.calls(), 2);
  h.time('2026-11-15T12:01:00+07:00');
  assertTfexLkg(await h.source.getSnapshot(), original); assert.equal(h.calls(), 3);
  const deadline = Date.parse(start) + 168 * 3600000;
  for (const time of [deadline - 1, deadline]) {
    h.time(time); assertTfexLkg(h.source.peekSnapshot(), original);
  }
  h.time(deadline + 1);
  const expired = h.source.peekSnapshot(); assert.equal(expired.status.state, 'UNAVAILABLE');
  assert.equal(expired.value.totalVolume, null); assert.equal(expired.status.fetchedAt, null);
  assert.equal((await h.source.getSnapshot()).status.state, 'UNAVAILABLE');
});

for (const status of [401, 403, 429]) {
  test('TFEX retention: access denial preserves the stop and bounded LKG: ' + status, async () => {
    const h = tfexRetentionHarness(), original = await h.source.getSnapshot();
    h.respond(() => htmlResponse('', status)); h.time('2026-11-14T12:00:00+07:00');
    const reason = status === 429 ? 'SOURCE_RATE_LIMIT_STOP' : 'MANUAL_REVIEW_REQUIRED';
    assertTfexLkg(await h.source.getSnapshot(), original, reason);
    assert.equal(h.source.snapshot().stopped, true);
    h.time('2026-11-15T12:00:00+07:00'); assertTfexLkg(await h.source.getSnapshot(), original, reason);
    h.time('2026-11-16T07:50:00+07:00');
    assert.equal((await h.source.getSnapshot()).status.state, 'UNAVAILABLE'); assert.equal(h.calls(), 2);
  });
}

for (const [label, respond, reason] of [
  ['parser mismatch', () => htmlResponse('<title>TFEX</title>'), 'PARSER_MISMATCH'],
  ['invalid timestamp', () => htmlResponse(fixture('tfex-home.html').replace('20 ต.ค. 2569', '30 ก.พ. 2569')), 'INVALID_DATA'],
  ['future timestamp', () => htmlResponse(tfexHtmlAt('2026-11-16T12:00:00+07:00')), 'SOURCE_TIME_UNVERIFIED'],
  ['old unaccepted snapshot', () => htmlResponse(tfexHtmlAt('2026-11-13T22:20:00+07:00')), 'SOURCE_TIME_UNVERIFIED'],
  ['timeout', () => { throw Object.assign(Error('mock timeout'), { name: 'TimeoutError' }); }, 'ACQUISITION_TIMEOUT']
]) {
  test('TFEX retention: an unvalidated record cannot seed LKG: ' + label, async () => {
    const h = tfexRetentionHarness({ start: '2026-11-15T12:00:00+07:00' }); h.respond(respond);
    const actual = await h.source.getSnapshot(); assert.equal(actual.status.state, 'UNAVAILABLE');
    assert.equal(actual.status.reason, reason); assert.equal(actual.value.totalVolume, null);
    assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE'); assert.equal(h.calls(), 1);
  });
}

test('TFEX retention: parser failure preserves only the previously validated record; clock rollback cannot expose it', async () => {
  const start = '2026-11-15T04:00:00+07:00', h = tfexRetentionHarness({ start });
  const original = await h.source.getSnapshot(); h.respond(() => htmlResponse('<title>TFEX</title>'));
  h.time('2026-11-15T12:00:00+07:00');
  assertTfexLkg(await h.source.getSnapshot(), original, 'PARSER_MISMATCH');
  h.time(Date.parse(start) - 1); assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE');
  assert.equal(h.calls(), 2);
});

test('TFEX retention: restart loses in-memory LKG and cannot reseed it from an aged successful response', async () => {
  const h = tfexRetentionHarness(), original = await h.source.getSnapshot();
  h.time('2026-11-15T12:00:00+07:00'); assertTfexLkg(h.source.peekSnapshot(), original);
  h.restart(); assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE');
  const actual = await h.source.getSnapshot(); assert.equal(actual.status.state, 'UNAVAILABLE');
  assert.equal(actual.status.reason, 'SOURCE_TIME_UNVERIFIED'); assert.equal(h.calls(), 2);
});

for (const [age, state] of [[1_799_999, 'LKG'], [1_800_000, 'LKG'], [1_800_001, 'UNAVAILABLE']]) {
  test(`TFEX retention: ordinary source-failure LKG boundary remains ${age} ms`, async () => {
    const start = '2026-11-17T10:00:00+07:00', h = tfexRetentionHarness({ start });
    const original = await h.source.getSnapshot(); h.respond(() => htmlResponse('', 500));
    h.time(Date.parse(start) + 6 * 60000); assertTfexLkg(await h.source.getSnapshot(), original);
    h.time(Date.parse(start) + age); const actual = h.source.peekSnapshot();
    assert.equal(actual.status.state, state);
    if (state === 'LKG') assertTfexLkg(actual, original, 'SOURCE_HTTP_ERROR');
    assert.equal(h.calls(), 2);
  });
}

test('TFEX retention: entering pre-open preserves only the remaining ordinary LKG allowance', async () => {
  const h = tfexRetentionHarness({ start: '2026-11-16T07:40:00+07:00' });
  const original = await h.source.getSnapshot(); h.time('2026-11-16T07:50:00+07:00');
  assertTfexLkg(h.source.peekSnapshot(), original);
  h.time('2026-11-16T08:10:00.001+07:00');
  assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE'); assert.equal(h.calls(), 1);
});

test('TFEX retention: only a newly validated fetch replaces LKG with a new PASS receipt', async () => {
  const h = tfexRetentionHarness(), original = await h.source.getSnapshot();
  h.time('2026-11-15T12:00:00+07:00'); assertTfexLkg(h.source.peekSnapshot(), original);
  h.respond(() => htmlResponse(tfexHtmlAt('2026-11-15T12:00:00+07:00')));
  const recovered = await h.source.getSnapshot(); assert.equal(recovered.status.state, 'PASS');
  assert.equal(recovered.status.fetchedAt, '2026-11-15T05:00:00.000Z');
  assert.equal(recovered.status.sourceUpdatedAt, '2026-11-15T12:00:00+07:00');
  assert.equal(recovered.status.freshnessVerified, false); assert.equal(recovered.status.stale, undefined);
  assert.equal(h.calls(), 2);
});

test('TFEX retention: an unassessable clock cannot grant extended LKG or throw from peek', async () => {
  const h = tfexRetentionHarness(), original = await h.source.getSnapshot();
  assert.equal(original.status.state, 'PASS');
  for (const time of [NaN, Infinity, 8.64e15 + 1]) {
    h.time(time); assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE');
  }
  assert.equal(h.calls(), 1);
});

test('TFEX retention: disabled source remains unavailable with zero fetches', async () => {
  const h = tfexRetentionHarness({ enabled: false });
  assert.equal((await h.source.getSnapshot()).status.reason, 'SOURCE_DISABLED');
  assert.equal(h.source.peekSnapshot().status.state, 'UNAVAILABLE'); assert.equal(h.calls(), 0);
});

test('Most Active regression: a holiday snapshot stays PASS independently of extended TFEX LKG', async () => {
  const h = freshnessHarness({ start: '2026-11-13T16:40:00+07:00' });
  h.bodies.set('https://www.tfex.co.th/th/home', tfexHtmlAt('2026-11-13T16:39:00+07:00'));
  h.bodies.set('https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value',
    fixture('settrade-active-value.html').replace('20 ต.ค. 2569 22:19:18', '13 พ.ย. 2569 16:40:00'));
  const first = (await h.service.getOverview()).value;
  h.time('2026-11-15T12:00:00+07:00'); const current = (await h.service.getOverview()).value;
  assert.equal(current.fieldStatus.tfex.state, 'LKG'); assert.equal(current.stale, true);
  assert.equal(current.fieldStatus.tfex.fetchedAt, first.fieldStatus.tfex.fetchedAt);
  assert.equal(current.fieldStatus.activeValue.state, 'PASS');
  assert.equal(current.fieldStatus.activeValue.sessionContext, 'SESSION_SNAPSHOT');
  assert.equal(current.fieldStatus.activeValue.sourceUpdatedAt, first.fieldStatus.activeValue.sourceUpdatedAt);
  assert.equal(current.fieldStatus.activeValue.fetchedAt, '2026-11-15T05:00:00.000Z');
  assert.deepEqual(current.activeValue, first.activeValue);
  const calls = h.calls(); h.time('2026-11-15T12:01:00+07:00');
  const cached = (await h.service.getOverview()).value;
  assert.equal(cached.fieldStatus.activeValue.state, 'PASS');
  assert.equal(cached.fieldStatus.tfex.freshness, 'LKG'); assert.equal(h.calls(), calls);
});

test('Most Active regression: holiday failure and cache hits keep the original 30-minute LKG deadline', async () => {
  const h = freshnessHarness({ start: '2026-11-15T12:00:00+07:00' });
  const activeUrl = 'https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value';
  h.bodies.set(activeUrl, fixture('settrade-active-value.html').replace('20 ต.ค. 2569 22:19:18', '13 พ.ย. 2569 16:40:00'));
  h.bodies.set('https://www.tfex.co.th/th/home', tfexHtmlAt('2026-11-15T12:00:00+07:00'));
  const first = (await h.service.getOverview()).value.fieldStatus.activeValue;
  h.bodies.set(activeUrl, '<h1>Most Active Value</h1><p>Symbol no data</p>');
  h.time('2026-11-15T12:06:00+07:00');
  assert.equal((await h.service.getOverview()).value.fieldStatus.activeValue.state, 'LKG');
  const calls = h.calls(); h.time('2026-11-15T12:07:00+07:00');
  assert.equal((await h.service.getOverview()).value.fieldStatus.activeValue.fetchedAt, first.fetchedAt);
  assert.equal(h.calls(), calls);
  h.time('2026-11-15T12:29:59+07:00');
  assert.equal((await h.service.getOverview()).value.fieldStatus.activeValue.state, 'LKG');
  const beforeExpiryCalls = h.calls(); h.time('2026-11-15T12:30:00+07:00');
  assert.equal((await h.service.getOverview()).value.fieldStatus.activeValue.state, 'LKG');
  h.time('2026-11-15T12:30:00.001+07:00'); const expired = (await h.service.getOverview()).value;
  assert.equal(expired.fieldStatus.activeValue.state, 'UNAVAILABLE'); assert.deepEqual(expired.activeValue, []);
  assert.equal(h.calls(), beforeExpiryCalls);
});

test('Most Active regression: a restarted service can reacquire a holiday snapshot, but has no LKG during source failure', async () => {
  const activeUrl = 'https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value';
  const healthy = freshnessHarness({ start: '2026-11-15T12:00:00+07:00' });
  healthy.bodies.set(activeUrl, fixture('settrade-active-value.html').replace('20 ต.ค. 2569 22:19:18', '13 พ.ย. 2569 16:40:00'));
  assert.equal((await healthy.service.getOverview()).value.fieldStatus.activeValue.state, 'PASS');
  const restarted = freshnessHarness({ start: '2026-11-15T12:01:00+07:00' });
  restarted.bodies.set(activeUrl, '<h1>Most Active Value</h1><p>Symbol no data</p>');
  const actual = (await restarted.service.getOverview()).value;
  assert.equal(actual.fieldStatus.activeValue.state, 'UNAVAILABLE'); assert.deepEqual(actual.activeValue, []);
});

function responseFor(url) {
  const value = String(url);
  if (value.includes('/market-summary/overview')) return fixture('settrade-overview.html');
  if (value.includes('/nvdr/value')) return fixture('settrade-nvdr.html');
  if (value.includes('/historical-report/investor-type')) return fixture('settrade-foreign.html');
  if (value.includes('/derivatives/overview')) return fixture('settrade-tfex.html');
  if (value === 'https://www.tfex.co.th/th/home') return fixture('tfex-home.html');
  if (value.includes('/most-active-value')) return fixture('settrade-active-value.html');
  throw Error(`Unexpected URL: ${value}`);
}

test('Most Active and TFEX fixtures become normalized structured data without invention', () => {
  const active = parseSettradeActiveValue(fixture('settrade-active-value.html'));
  assert.equal(active.items.length, 3);
  assert.deepEqual(active.items[0], {
    rank: 1, symbol: 'DELTA', turnoverMillion: 4521.3, volumeThousand: 25100.5,
    last: 180, change: -2, changePercent: -1.1, low: 178.5, high: 184
  });
  assert.equal(active.asOf, '20 ต.ค. 2569 22:19:18');

  const tfex = parseSettradeTfex(fixture('settrade-tfex.html'));
  assert.equal(tfex.available, true);
  assert.equal(tfex.totalVolume, 482150);
  assert.equal(tfex.openInterest, 3104220);
  assert.equal(tfex.delayMinutes, 15);
  assert.equal(tfex.marketDate, '20 ต.ค. 2569');
  assert.deepEqual(tfex.topVolume[0], {
    symbol: 'S50Z26', volume: 105250, last: 998.4, change: -4.1, changePercent: -0.41
  });
  assert.deepEqual(tfex.investorType[0], {
    name: 'นักลงทุนต่างชาติ', buy: 120000, sell: 110000, net: 10000
  });
});

test('disabled scraper performs zero upstream requests and returns a safe degraded result', async () => {
  let calls = 0;
  const safety = createMarketOverviewSafety({
    enabled: false,
    fetchImpl: async () => { calls += 1; return htmlResponse(''); }
  });
  const service = createSettradeService({ safety });
  const result = await service.getOverview();

  assert.equal(calls, 0);
  assert.equal(result.value.dataState, 'unavailable');
  assert.equal(result.value.sourceStatus.settrade.state, 'DISABLED');
  assert.deepEqual(result.value.indices, []);
});

test('provider requests are sequential, coalesced and manual refresh cannot bypass the shared cache', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    maxRequestsPerWindow: 10,
    fetchImpl: async url => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return htmlResponse(responseFor(url));
    }
  });
  const service = createSettradeService({ safety, now: () => Date.parse('2026-10-20T22:20:00+07:00') });

  const [first, second] = await Promise.all([service.getOverview(), service.getOverview()]);
  assert.equal(calls, 5);
  assert.equal(maxActive, 1);
  assert.equal(first.value.activeValue.length, 3);
  assert.equal(second.meta.coalesced, true);

  await service.getOverview(true);
  await service.getOverview(true);
  assert.equal(calls, 5);
});

test('403 or access-denial page opens MANUAL_REVIEW_REQUIRED and prevents further fetches', async () => {
  let calls = 0;
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return htmlResponse(calls === 1 ? 'Forbidden' : '<html>should not load</html>', 403);
    }
  });

  await assert.rejects(safety.request('https://www.settrade.com/a'), /MANUAL_REVIEW_REQUIRED/);
  await assert.rejects(safety.request('https://www.settrade.com/b'), /MANUAL_REVIEW_REQUIRED/);
  assert.equal(calls, 1);
  assert.equal(safety.snapshot().state, 'MANUAL_REVIEW_REQUIRED');

  let captchaCalls = 0;
  const captchaSafety = createMarketOverviewSafety({
    minSpacingMs: 0,
    fetchImpl: async () => { captchaCalls += 1; return htmlResponse('<html><title>Checking CAPTCHA</title><body>captcha</body></html>'); }
  });
  await assert.rejects(captchaSafety.request('https://www.settrade.com/a'), /MANUAL_REVIEW_REQUIRED/);
  await assert.rejects(captchaSafety.request('https://www.settrade.com/b'), /MANUAL_REVIEW_REQUIRED/);
  assert.equal(captchaCalls, 1);
});

test('a passive reCAPTCHA site-key config is not mistaken for an active CAPTCHA challenge', () => {
  assert.equal(explicitAccessDenial('<script>settings={gReCaptchaSiteKey:"public-site-key"}</script><h1>สรุปภาวะตลาด</h1>'), false);
  assert.equal(explicitAccessDenial('<html><title>Checking CAPTCHA</title><body>captcha challenge</body></html>'), true);
  assert.equal(explicitAccessDenial('<html><title>Login - SETTRADE</title><input type="password"></html>'), true);
});

test('parser mismatch is explicit, consumes no retry requests and does not hide healthy fields', async () => {
  let calls = 0;
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    maxRequestsPerWindow: 10,
    fetchImpl: async url => {
      calls += 1;
      if (String(url).includes('/nvdr/value')) {
        return htmlResponse('<h1>ภาพรวมมูลค่าการซื้อขาย NVDR</h1><div>มูลค่า SET และ mai 60,980.99</div><div data-new-schema="nvdr">34,209.86</div>');
      }
      return htmlResponse(responseFor(url));
    }
  });
  const service = createSettradeService({ safety });
  const result = (await service.getOverview()).value;

  assert.equal(calls, 5);
  assert.equal(result.fieldStatus.nvdr.state, 'UNAVAILABLE');
  assert.equal(result.fieldStatus.nvdr.reason, 'PARSER_MISMATCH');
  assert.equal(result.fieldStatus.indices.state, 'PASS');
  assert.equal(result.fieldStatus.foreign.state, 'PASS');
  assert.equal(result.partial, true);
});

test('wrong page remains rejected even when another field can still render', async () => {
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    maxRequestsPerWindow: 10,
    fetchImpl: async url => htmlResponse(String(url).includes('/nvdr/value')
      ? fixture('settrade-wrong-page.html')
      : responseFor(url))
  });
  const result = (await createSettradeService({ safety }).getOverview()).value;
  assert.equal(result.fieldStatus.nvdr.state, 'UNAVAILABLE');
  assert.equal(result.fieldStatus.nvdr.reason, 'PAGE_IDENTITY_MISMATCH');
  assert.equal(result.fieldStatus.indices.state, 'PASS');
});

test('429 backs off without retrying and repeated transient failures use one HALF_OPEN probe', async () => {
  let now = 1_000;
  let calls = 0;
  const rateSafety = createMarketOverviewSafety({
    now: () => now,
    minSpacingMs: 0,
    cooldownMs: 100,
    fetchImpl: async () => { calls += 1; return htmlResponse('rate limited', 429); }
  });
  await assert.rejects(rateSafety.request('https://www.settrade.com/a'), /BACKOFF/);
  await assert.rejects(rateSafety.request('https://www.settrade.com/a'), /BACKOFF/);
  assert.equal(calls, 1);

  let transientCalls = 0;
  const transientSafety = createMarketOverviewSafety({
    now: () => now,
    minSpacingMs: 0,
    cooldownMs: 100,
    maxAttempts: 1,
    openAfterFailures: 1,
    fetchImpl: async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw Error('timeout');
      return htmlResponse('<html>ok</html>');
    }
  });
  await assert.rejects(transientSafety.request('https://www.settrade.com/a'), /OPEN/);
  assert.equal(transientSafety.snapshot().state, 'OPEN');
  now += 101;
  await transientSafety.request('https://www.settrade.com/a');
  assert.equal(transientCalls, 2);
  assert.equal(transientSafety.snapshot().state, 'ACTIVE');
});

test('a wrong-page parser failure degrades one field while unrelated Overview fields stay available', async () => {
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    maxRequestsPerWindow: 10,
    fetchImpl: async url => htmlResponse(String(url).includes('/most-active-value')
      ? fixture('settrade-wrong-page.html')
      : responseFor(url))
  });
  const service = createSettradeService({ safety });
  const result = (await service.getOverview()).value;

  assert.equal(result.indices[0].symbol, 'SET');
  assert.equal(result.nvdr.marketMillion, 75000.5);
  assert.equal(result.tfex.available, true);
  assert.deepEqual(result.activeValue, []);
  assert.equal(result.fieldStatus.activeValue.state, 'UNAVAILABLE');
  assert.equal(result.partial, true);
});

test('Most Active LKG rows are labelled as saved data without consuming extra requests', async () => {
  const initialTime = Date.parse('2026-10-20T22:20:00+07:00');
  let now = initialTime;
  let calls = 0;
  const safety = createMarketOverviewSafety({
    now: () => now,
    minSpacingMs: 0,
    maxRequestsPerWindow: 20,
    fetchImpl: async url => {
      calls += 1;
      const activePage = String(url).includes('/most-active-value');
      return htmlResponse(activePage && now > initialTime
        ? fixture('settrade-wrong-page.html')
        : responseFor(url));
    }
  });
  const service = createSettradeService({ now: () => now, safety });

  const fresh = (await service.getOverview()).value;
  assert.equal(fresh.fieldStatus.activeValue.state, 'PASS');
  assert.match(fresh.activeValueStatus, /ข้อมูล 3 รายการ.*20 ต.ค. 2569 22:19:18/);
  assert.doesNotMatch(fresh.activeValueStatus, /ข้อมูลล่าสุด/);
  assert.equal(calls, 5);

  now += 300_001;
  const stale = (await service.getOverview()).value;
  assert.equal(calls, 10);
  assert.equal(stale.fieldStatus.activeValue.state, 'LKG');
  assert.equal(stale.activeValue.length, 3);
  assert.equal(stale.fieldStatus.indices.state, 'PASS');
  assert.match(stale.activeValueStatus, /บันทึกล่าสุด/);
  assert.doesNotMatch(stale.activeValueStatus, /ข้อมูลล่าสุด/);

  now = initialTime + 1_800_001;
  const expired = (await service.getOverview()).value;
  assert.equal(calls, 15);
  assert.equal(expired.fieldStatus.activeValue.state, 'UNAVAILABLE');
  assert.deepEqual(expired.activeValue, []);
  assert.equal(expired.fieldStatus.indices.state, 'PASS');
  assert.doesNotMatch(expired.activeValueStatus, /ข้อมูลล่าสุด|บันทึกล่าสุด/);
});

test('complete scraper failure returns an Overview-safe degraded contract instead of throwing', async () => {
  let calls = 0;
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    maxAttempts: 1,
    openAfterFailures: 1,
    fetchImpl: async () => { calls += 1; throw Error('timeout'); }
  });
  const service = createSettradeService({ safety });
  const result = await service.getOverview();

  assert.equal(calls, 2, 'one failed SETTRADE call and one independent TFEX attempt');
  assert.equal(result.value.fieldStatus.tfex.state, 'UNAVAILABLE');
  assert.equal(result.value.dataState, 'unavailable');
  assert.equal(result.value.sourceStatus.settrade.state, 'OPEN');
  assert.deepEqual(result.value.indices, []);
  assert.deepEqual(result.value.activeValue, []);
  assert.equal(result.value.partial, true);
});

test('shadow comparison is evidence-only and cannot replace or quarantine production output', async () => {
  const production = {
    indices: [{ symbol: 'SET', last: 1234.56 }],
    dataState: 'delayed', partial: false, errors: [], sourceStatus: { settrade: { state: 'ACTIVE' } }
  };
  const service = createMarketOverviewService({
    provider: { getOverview: async () => ({ value: production, meta: { status: 'miss' } }) },
    shadowEnabled: true,
    shadowProvider: { compare: async () => ({ indices: [{ symbol: 'SET', last: 1300 }], status: 'MISMATCH' }) }
  });
  const result = await service.getOverview();

  assert.equal(result.value.indices[0].last, 1234.56);
  assert.equal(result.value.dataState, 'delayed');
  assert.equal(result.value.sourceStatus.shadow.state, 'MISMATCH');
});

test('shared provider budget blocks excess requests without calling upstream', async () => {
  let calls = 0;
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    maxRequestsPerWindow: 1,
    fetchImpl: async () => { calls += 1; return htmlResponse('<html>ok</html>'); }
  });
  await safety.request('https://www.settrade.com/a');
  await assert.rejects(safety.request('https://www.settrade.com/b'), /REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(calls, 1);
});

test('source guard rejects unexpected domains and cross-domain redirects before parsing', async () => {
  let calls = 0;
  const safety = createMarketOverviewSafety({
    minSpacingMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return { status: 200, ok: true, url: 'https://example.com/login', text: async () => '<html>wrong source</html>' };
    }
  });
  await assert.rejects(safety.request('https://example.com/a'), /SOURCE_GUARD_REJECTED/);
  assert.equal(calls, 0);
  await assert.rejects(safety.request('https://www.settrade.com/a'), /SOURCE_GUARD_REJECTED/);
  assert.equal(calls, 1);
});

test('Market Overview orchestration stays independent from frozen product services', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'market-overview-service.js'), 'utf8');
  assert.doesNotMatch(source, /market-service|news-service|watchlist-service|auth-service|data-guard/);
});
