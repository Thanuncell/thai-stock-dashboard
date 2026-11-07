'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { coverage, dailyBars, guardedDaily, observedAt, session } = require('./fixtures/screener.cjs');
const { createScreenerService, guardedDailyEvidence } = require('../server/screener-service');
const { createScreenerSnapshotStore, completeForEligible } = require('../server/screener-snapshot-store');

const universe = () => Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));

test('WS6-A publication preflight covers complete, missing and mixed-session universes without enabling partial publication', async t => {
  const { buildScreenerSnapshot, queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  for (const scenario of [
    { name: '500/500', ready: 500, unavailable: 0, stale: 0, fresh: 'CURRENT_SESSION' },
    { name: '499/500', ready: 499, unavailable: 1, stale: 0, fresh: 'UNAVAILABLE' },
    { name: 'mixed-session', ready: 499, unavailable: 0, stale: 1, fresh: 'STALE' }
  ]) await t.test(scenario.name, async () => {
    const registry = universe();
    const currentBars = dailyBars();
    const evidenceBySymbol = new Map();
    const service = createScreenerService({ listCoverage: async () => registry, now: () => observedAt });
    for (const [index, row] of registry.entries()) {
      if (scenario.unavailable && index === 499) continue;
      const bars = scenario.stale && index === 499 ? dailyBars('2026-11-05') : currentBars;
      const source = guardedDaily(row.symbol, bars);
      service.rememberDailyHistory(row.symbol, source.meta, source.result);
      evidenceBySymbol.set(row.symbol, guardedDailyEvidence(source.meta, source.result));
    }
    const candidate = buildScreenerSnapshot({ registry, evidenceBySymbol, sessionDate: session,
      latestCompletedSessionDate: session, observedAt });
    assert.deepEqual(candidate.counts, {
      registered: 500, eligible: 500, ready: scenario.ready, unavailable: scenario.unavailable,
      staleSession: scenario.stale, guardBlocked: 0, coverageIneligible: 0
    });
    const query = queryScreenerSnapshot(candidate, { rsi14: { min: 0, max: 100 } }, { sortBy: 'price', page: 1 });
    assert.equal(query.counts.matched, scenario.ready);
    assert.equal(query.counts.excluded, 500 - scenario.ready);
    assert.equal(query.counts.unevaluable, 0);
    assert.equal(completeForEligible(candidate), scenario.ready === 500);
    const envelope = await service.readSnapshot();
    assert.equal(envelope.marketFreshness, scenario.fresh);
    assert.equal(envelope.snapshot.state, scenario.ready === 500 ? 'COMPLETE' : 'PARTIAL');
    if (scenario.ready < 500) {
      const excluded = candidate.rows.at(-1);
      assert.equal(excluded.state, scenario.stale ? 'STALE_SESSION' : 'UNAVAILABLE');
      assert.equal(excluded.price.close, null);
      assert.equal(excluded.technical.rsi14, null);
      assert.deepEqual(excluded.exclusionReasons, [excluded.state]);
    }

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setscope-ws6a-'));
    try {
      const store = createScreenerSnapshotStore(directory);
      if (scenario.ready === 500) {
        await store.withLease(() => store.publish(candidate));
        const persisted = await createScreenerSnapshotStore(directory).readPublished();
        assert.equal(persisted.snapshot.id, candidate.id);
      } else {
        await assert.rejects(store.withLease(() => store.publish(candidate)), /INVALID_SCREENER_SNAPSHOT/);
        assert.equal((await store.readPublished()).snapshot, null);
      }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

test('WS6-A Coverage eligibility is independent of confirmed indicator availability', async t => {
  const { buildDailyScreenerRow, buildScreenerSnapshot, queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  const source = guardedDaily('PTT', dailyBars());
  const evidence = guardedDailyEvidence(source.meta, source.result);
  const context = { sessionDate: session, observedAt };
  const matrix = [
    ['verified daily history', {}, 'READY'],
    ['technical_ready is not computed indicator evidence', { technical_ready: false }, 'READY'],
    ['inactive', { active: false }, 'COVERAGE_INELIGIBLE'],
    ['unverified symbol', { symbol_verified: false }, 'COVERAGE_INELIGIBLE'],
    ['chart unavailable', { chart_ready: false }, 'COVERAGE_INELIGIBLE'],
    ['partial verification', { status: 'partial' }, 'COVERAGE_INELIGIBLE'],
    ['stale coverage guard', { guard_status: 'stale' }, 'COVERAGE_INELIGIBLE'],
    ['wrong provider', { provider: 'fixture-other-provider' }, 'COVERAGE_INELIGIBLE'],
    ['incorrect identity mapping', { provider_symbol: 'CPALL.BK' }, 'COVERAGE_INELIGIBLE']
  ];
  for (const [name, change, expected] of matrix) {
    const result = buildDailyScreenerRow({ ...coverage('PTT'), ...change }, evidence, context);
    assert.equal(result.state, expected, name);
    assert.equal(result.eligible, expected === 'READY', name);
    assert.equal(result.available.ema50, expected === 'READY', name);
  }
  const short = guardedDaily('PTT', dailyBars(session, 2));
  const snapshot = buildScreenerSnapshot({
    registry: [coverage('PTT')], evidenceBySymbol: { PTT: guardedDailyEvidence(short.meta, short.result) },
    ...context, latestCompletedSessionDate: session
  });
  assert.equal(snapshot.state, 'COMPLETE');
  assert.equal(snapshot.rows[0].available.price, true);
  for (const indicator of ['ema20', 'ema50', 'rsi14', 'macd']) {
    assert.equal(snapshot.rows[0].available[indicator], false);
    assert.equal(snapshot.rows[0].technical[indicator], null);
  }
  const filtered = queryScreenerSnapshot(snapshot, { rsi14: { min: 0, max: 100 } });
  assert.equal(filtered.counts.matched, 0);
  assert.equal(filtered.counts.unevaluable, 1);
  assert.equal(filtered.counts.evaluated, 0);
});
