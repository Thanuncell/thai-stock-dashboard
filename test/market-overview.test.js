'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSettradeActiveValue,
  parseSettradeTfex
} = require('../lib/settrade-parser');
const { createMarketOverviewSafety, explicitAccessDenial } = require('../server/market-overview-safety');
const { createMarketOverviewService } = require('../server/market-overview-service');
const { createSettradeService } = require('../server/settrade-service');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const htmlResponse = (body, status = 200) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' }
});

function responseFor(url) {
  const value = String(url);
  if (value.includes('/market-summary/overview')) return fixture('settrade-overview.html');
  if (value.includes('/nvdr/value')) return fixture('settrade-nvdr.html');
  if (value.includes('/historical-report/investor-type')) return fixture('settrade-foreign.html');
  if (value.includes('/derivatives/overview')) return fixture('settrade-tfex.html');
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
  const service = createSettradeService({ safety });

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
  let now = 1_000;
  let calls = 0;
  const safety = createMarketOverviewSafety({
    now: () => now,
    minSpacingMs: 0,
    maxRequestsPerWindow: 20,
    fetchImpl: async url => {
      calls += 1;
      const activePage = String(url).includes('/most-active-value');
      return htmlResponse(activePage && now > 1_000
        ? fixture('settrade-wrong-page.html')
        : responseFor(url));
    }
  });
  const service = createSettradeService({ now: () => now, safety });

  const fresh = (await service.getOverview()).value;
  assert.equal(fresh.fieldStatus.activeValue.state, 'PASS');
  assert.match(fresh.activeValueStatus, /ข้อมูลล่าสุด 3 รายการ/);
  assert.equal(calls, 5);

  now += 300_001;
  const stale = (await service.getOverview()).value;
  assert.equal(calls, 10);
  assert.equal(stale.fieldStatus.activeValue.state, 'LKG');
  assert.equal(stale.activeValue.length, 3);
  assert.equal(stale.fieldStatus.indices.state, 'PASS');
  assert.match(stale.activeValueStatus, /บันทึกล่าสุด/);
  assert.doesNotMatch(stale.activeValueStatus, /ข้อมูลล่าสุด/);

  now = 1_000 + 1_800_001;
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

  assert.equal(calls, 1);
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
