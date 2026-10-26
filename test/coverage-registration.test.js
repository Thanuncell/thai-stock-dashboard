'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reviewRegistration } = require('../server/coverage-registration');
const { runRegistration } = require('../scripts/register-coverage');
const { prepareImportAdds } = require('../server/security-import');
const row = (symbol, extra = {}) => ({ symbol, instrumentType: 'COMMON_STOCK', market: 'SET',
  source: 'fixture://permitted-list', effectiveDate: '2026-10-25', providerSymbol: symbol + '.BK',
  rightsConfirmed: true, classificationConfirmed: true, rightsEvidence: 'fixture://licence',
  classificationEvidence: 'fixture://common-share', ...extra });

test('PENDING registration accepts confirmed common shares without issuer metadata, prices or chart', () => {
  const input = [row('NEW')], r = reviewRegistration(input);
  assert.equal(r.entries[0].action, 'ADD');
  const [add] = prepareImportAdds(input, { existing: [], protectedSymbols: [], approvedSymbols: ['NEW'], reviewedInputKey: r.inputKey });
  assert.equal(add.symbol, 'NEW'); assert.equal(add.provider_symbol, 'NEW.BK');
  assert.equal(add.issuer_name, ''); assert.equal(add.instrument_id, '');
  assert.equal(r.writes, 0);
});

test('confirmed SET/mai membership permits an unspecified sub-board without fabricating one', () => {
  const input = [row('NEW', { market: 'SET_OR_MAI' })];
  const report = reviewRegistration(input);
  assert.equal(report.entries[0].action, 'ADD');
  const [addition] = prepareImportAdds(input, { existing: [], protectedSymbols: [], approvedSymbols: ['NEW'], reviewedInputKey: report.inputKey });
  assert.equal(addition.listing_market, 'SET_OR_MAI');
  for (const extra of [{ classificationConfirmed: false }, { sourceDenied: true }, { instrumentType: 'FUND' }, { instrumentType: 'REIT' }, { instrumentType: 'DR' }, { market: 'UNKNOWN' }]) {
    assert.equal(reviewRegistration([row('NEW', { market: 'SET_OR_MAI', ...extra })]).entries[0].action, 'UNVERIFIED');
  }
});

test('provenance and common-share classification remain required; price verification never substitutes', () => {
  for (const overrides of [{ sourceDenied: true }, { acquisitionProhibited: true }, { classificationConfirmed: false }, { instrumentType: 'DR' },
    { instrumentType: 'REIT' }, { instrumentType: 'FUND' }, { market: 'NYSE' }, { source: '' }, { classificationEvidence: '' }]) {
    assert.equal(reviewRegistration([row('NEW', overrides)]).entries[0].action, 'UNVERIFIED');
  }
});

test('retired rights checklist is optional while an actual source denial still blocks import', () => {
  const input = [row('NEW', { rightsConfirmed: false, rightsEvidence: '' })];
  assert.equal(reviewRegistration(input).entries[0].action, 'ADD');
  assert.equal(reviewRegistration([row('NEW', { sourceDenied: true })]).entries[0].action, 'UNVERIFIED');
  assert.equal(reviewRegistration([row('NEW', { acquisitionProhibited: true })]).entries[0].action, 'UNVERIFIED');
});

test('legacy 191 rows and protected Watchlist/DR symbols are preserved without reclassification or activation', () => {
  const existing = Array.from({ length: 191 }, (_, i) => ({ symbol: 'L' + i, provider_symbol: 'ALIAS' + i + '.BK', active: false }));
  const before = structuredClone(existing);
  const r = reviewRegistration([row('L0'), row('DR80'), row('NEW')], { existing, protectedSymbols: ['DR80'] });
  assert.equal(r.entries.find(e => e.symbol === 'L0').action, 'PROTECTED_LEGACY');
  assert.equal(r.entries.find(e => e.symbol === 'DR80').action, 'PROTECTED_LEGACY');
  assert.equal(r.entries.find(e => e.symbol === 'NEW').action, 'ADD');
  assert.deepEqual(existing, before);
});

test('duplicate symbols, stable identities and provider mapping collisions do not produce additions', () => {
  for (const input of [[row('NEW'), row('NEW')], [row('ONE', { instrumentId: 'same' }), row('TWO', { instrumentId: 'same' })],
    [row('ONE', { providerSymbol: 'SAME.BK' }), row('TWO', { providerSymbol: 'SAME.BK' })]]) {
    assert.ok(reviewRegistration(input).entries.every(e => e.action === 'CONFLICT'));
  }
  assert.equal(reviewRegistration([row('NEW')], { existing: [{ symbol: 'DR80', provider_symbol: 'NEW.BK' }] }).entries[0].action, 'CONFLICT');
});

test('manual review never constructs a database pool or calls a provider, including mixed blocked input', async () => {
  const result = await runRegistration({ input: [row('NEW'), row('REVIEW', { classificationConfirmed: false })] }, {
    env: {}, poolFactory: () => { throw Error('Unexpected database'); }
  });
  assert.equal(result.actions[0].action, 'ADD'); assert.equal(result.actions[1].action, 'UNVERIFIED');
  assert.equal(result.writes, 0);
});

test('execution fails closed for missing approval and wrong database host before connecting', async () => {
  await assert.rejects(runRegistration({ mode: 'register' }), /approval/);
  await assert.rejects(runRegistration({ mode: 'recover', finalize: true, approval: { approved: true } }), /approval/);
  await assert.rejects(runRegistration({ mode: 'register', approval: { approved: true }, receiptDirectory: require('node:path').join(__dirname, '..', 'PRIVATE-RECEIPTS') }, { execute: true }), /outside the repository/);
  await assert.rejects(runRegistration({ mode: 'register', approval: { approved: true }, receiptDirectory: require('node:os').tmpdir(),
    target: { host: 'expected.invalid', database: 'fixture', role: 'fixture' } }, { execute: true,
    env: { SETSCOPE_REGISTRATION_DATABASE_URL: 'postgresql://fixture:fake@wrong.invalid/fixture' }, poolFactory: () => { throw Error('Must not connect'); } }), /reviewed target/);
});

test('review remains bounded and repeatable through 300/400/500 and 900 new synthetic shares', () => {
  for (const n of [300, 400, 500, 900]) {
    const input = Array.from({ length: n }, (_, i) => row('S' + i));
    const first = reviewRegistration(input), second = reviewRegistration(input);
    assert.equal(first.inputKey, second.inputKey); assert.equal(first.entries.filter(e => e.action === 'ADD').length, n);
  }
  assert.throws(() => reviewRegistration(Array.from({ length: 1001 }, (_, i) => row('S' + i))), /1..1000/);
});

test('changing approved input cannot silently reuse an earlier dry-run', () => {
  const input = [row('NEW')], old = reviewRegistration(input);
  assert.throws(() => prepareImportAdds([row('OTHER')], { existing: [], protectedSymbols: [], approvedSymbols: ['OTHER'], reviewedInputKey: old.inputKey }), /Exact import review/);
});
