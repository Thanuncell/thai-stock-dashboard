'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { runFixtureManual } = require('../scripts/run-policy-watch-fixture');
const { createPolicyWatchStore, stateChecksum } = require('../server/policy-watch-store');
const { createPolicyWatchService } = require('../server/policy-watch-service');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-watch', name), 'utf8');
const registry = [{
  sourceId: 'set-terms-fixture',
  publisher: 'SET',
  canonicalUrl: 'https://www.set.or.th/fixture/terms',
  permittedHosts: ['www.set.or.th'],
  docType: 'terms',
  expectedMarkers: ['SET Website Terms of Use', 'Access policy', 'Data use'],
  rightsEvidence: { status: 'UNVERIFIED', checkedAt: null },
  enabled: false
}];
const response = (body, overrides = {}) => ({
  status: 200,
  url: registry[0].canonicalUrl,
  redirects: [],
  contentType: 'text/html',
  body,
  ...overrides
});

async function workspace(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'setscope-policy-watch-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return { directory, statePath: path.join(directory, 'state.json') };
}

function serviceFor({ statePath, acquire, now = () => Date.UTC(2026, 9, 24, 9), sleep = async () => {}, ...options }) {
  return createPolicyWatchService({
    registry,
    store: createPolicyWatchStore({ filePath: statePath }),
    acquire,
    enabled: true,
    shadow: true,
    fixtureMode: true,
    retainFixtureText: true,
    now,
    sleep,
    baseDelayMs: 10,
    cooldownMs: 100,
    random: () => 0,
    ...options
  });
}

test('default OFF manual mode performs zero policy acquisition', async t => {
  const { statePath } = await workspace(t);
  let requests = 0;
  const service = createPolicyWatchService({
    registry,
    store: createPolicyWatchStore({ filePath: statePath }),
    acquire: async () => { requests += 1; return response(fixture('policy-v1.html')); },
    fixtureMode: true
  });
  const result = await service.runManual();
  assert.equal(result.status, 'DISABLED');
  assert.equal(result.requests, 0);
  assert.equal(requests, 0);
  await assert.rejects(fsp.access(statePath));
});

test('verified baseline, content, layout and unchanged history are durable and idempotent', async t => {
  const { statePath } = await workspace(t);
  let body = fixture('policy-v1.html');
  let now = Date.UTC(2026, 9, 24, 9);
  const service = serviceFor({ statePath, acquire: async () => response(body), now: () => now });

  const first = await service.runManual();
  now += 1_000;
  const unchanged = await service.runManual();
  body = fixture('policy-v2.html');
  now += 1_000;
  const content = await service.runManual();
  body = fixture('policy-v1-layout.html');
  now += 1_000;
  const layout = await service.runManual();
  const stored = await createPolicyWatchStore({ filePath: statePath }).read();

  assert.equal(first.results[0].status, 'FIRST_VERIFIED_BASELINE');
  assert.equal(unchanged.results[0].status, 'UNCHANGED');
  assert.equal(content.results[0].changeType, 'CONTENT_CHANGE');
  assert.equal(layout.results[0].changeType, 'CONTENT_CHANGE');
  assert.equal(stored.payload.observations.length, 4);
  assert.equal(stored.payload.changes.length, 3);
  assert.ok(stored.payload.changes.every(item => item.evidenceRef.startsWith('observation:')));
  assert.equal(stored.payload.baselines[registry[0].sourceId].sourceId, registry[0].sourceId);
});

test('layout-only change is classified without inventing a content change', async t => {
  const { statePath } = await workspace(t);
  let body = fixture('policy-v1.html');
  const service = serviceFor({ statePath, acquire: async () => response(body) });
  await service.runManual();
  body = fixture('policy-v1-layout.html');
  const result = await service.runManual();
  assert.equal(result.results[0].changeType, 'LAYOUT_CHANGE');
});

test('document mismatch and fetch failure never overwrite a verified baseline', async t => {
  const { statePath } = await workspace(t);
  let current = response(fixture('policy-v1.html'));
  const service = serviceFor({ statePath, acquire: async () => current });
  await service.runManual();
  const before = await createPolicyWatchStore({ filePath: statePath }).read();
  current = response(fixture('login.html'));
  const mismatch = await service.runManual();
  current = response('', { status: 503 });
  const failed = await service.runManual();
  const after = await createPolicyWatchStore({ filePath: statePath }).read();

  assert.equal(mismatch.results[0].status, 'DOCUMENT_MISMATCH');
  assert.equal(failed.results[0].status, 'UNAVAILABLE');
  assert.equal(failed.status, 'PARTIAL');
  assert.equal(after.payload.baselines[registry[0].sourceId].contentHash, before.payload.baselines[registry[0].sourceId].contentHash);
});

test('SR-01 restart preserves baseline and history across pre/post commit faults', async t => {
  const { statePath } = await workspace(t);
  let body = fixture('policy-v1.html');
  let now = Date.UTC(2026, 9, 24, 9);
  let service = serviceFor({ statePath, acquire: async () => response(body), now: () => now });
  await service.runManual();
  const initial = await createPolicyWatchStore({ filePath: statePath }).read();

  body = fixture('policy-v2.html');
  now += 1_000;
  const beforeCommit = await service.runManual({ faultBySource: { 'set-terms-fixture': 'before-rename' } });
  const afterRejectedCommit = await createPolicyWatchStore({ filePath: statePath }).read();
  assert.equal(beforeCommit.results[0].status, 'RECOVERY_REQUIRED');
  assert.equal(afterRejectedCommit.revision, initial.revision);
  assert.equal(afterRejectedCommit.payload.changes.length, initial.payload.changes.length);

  now += 1_000;
  const afterCommit = await service.runManual({ faultBySource: { 'set-terms-fixture': 'after-commit' } });
  assert.equal(afterCommit.results[0].status, 'RECOVERY_REQUIRED');
  const committed = await createPolicyWatchStore({ filePath: statePath }).read();
  assert.equal(committed.payload.changes.length, initial.payload.changes.length + 1);

  service = serviceFor({ statePath, acquire: async () => response(body), now: () => now, requireExistingState: true });
  const restarted = await service.runManual();
  const final = await createPolicyWatchStore({ filePath: statePath }).read();
  assert.equal(restarted.results[0].status, 'UNCHANGED');
  assert.equal(final.payload.changes.length, committed.payload.changes.length);
  assert.equal(final.payload.baselines[registry[0].sourceId].contentHash, committed.payload.baselines[registry[0].sourceId].contentHash);
});

test('SR-01 corrupt, missing and schema-mismatched state fails safely after restart', async t => {
  const { directory, statePath } = await workspace(t);
  const missing = serviceFor({ statePath, acquire: async () => response(fixture('policy-v1.html')), requireExistingState: true });
  assert.equal((await missing.runManual()).results[0].status, 'RECOVERY_BLOCKED');

  await fsp.writeFile(statePath, '{"partial":', 'utf8');
  const corrupt = serviceFor({ statePath, acquire: async () => response(fixture('policy-v1.html')), requireExistingState: true });
  assert.equal((await corrupt.runManual()).results[0].reason, 'POLICY_STATE_CORRUPT');

  const payload = { baselines: {}, observations: [], changes: [], recovery: {} };
  await fsp.writeFile(statePath, JSON.stringify({ schemaVersion: 2, revision: 1, payload, checksum: stateChecksum(payload) }), 'utf8');
  const mismatch = serviceFor({ statePath, acquire: async () => response(fixture('policy-v1.html')), requireExistingState: true });
  assert.equal((await mismatch.runManual()).results[0].reason, 'POLICY_STATE_SCHEMA_MISMATCH');

  const missingEvidence = {
    baselines: { 'set-terms-fixture': { sourceId: 'set-terms-fixture', observationId: 'missing' } },
    observations: [],
    changes: [],
    recovery: {}
  };
  await fsp.writeFile(statePath, JSON.stringify({ schemaVersion: 1, revision: 1, payload: missingEvidence, checksum: stateChecksum(missingEvidence) }), 'utf8');
  const untrusted = serviceFor({ statePath, acquire: async () => response(fixture('policy-v1.html')), requireExistingState: true });
  assert.equal((await untrusted.runManual()).results[0].reason, 'POLICY_STATE_BASELINE_LINK_MISSING');
  assert.ok(directory);
});

test('SR-01 partial atomic write keeps the last verified history intact', async t => {
  const { statePath } = await workspace(t);
  let body = fixture('policy-v1.html');
  const service = serviceFor({ statePath, acquire: async () => response(body) });
  await service.runManual();
  const before = await createPolicyWatchStore({ filePath: statePath }).read();
  body = fixture('policy-v2.html');
  const failed = await service.runManual({ faultBySource: { 'set-terms-fixture': 'partial-write' } });
  const after = await createPolicyWatchStore({ filePath: statePath }).read();
  assert.equal(failed.results[0].status, 'RECOVERY_REQUIRED');
  assert.deepEqual(after, before);
});

test('SR-02 denial and CAPTCHA stop the source without retries or access evasion', async t => {
  const { statePath } = await workspace(t);
  let requests = 0;
  let current = response('', { status: 403 });
  let service = serviceFor({ statePath, acquire: async () => { requests += 1; return current; } });
  const denied = await service.runManual();
  assert.equal(denied.results[0].status, 'RECOVERY_BLOCKED');
  assert.equal(requests, 1);

  service = serviceFor({ statePath, acquire: async () => { requests += 1; return response(fixture('policy-v1.html')); }, requireExistingState: true });
  const restart = await service.runManual();
  assert.equal(restart.results[0].status, 'RECOVERY_BLOCKED');
  assert.equal(restart.results[0].requests, 0);
  assert.equal(requests, 1);

  const captchaPath = path.join(path.dirname(statePath), 'captcha-state.json');
  current = response('<main><h1>SET Website Terms of Use</h1><p>Access policy Data use</p><div>reCAPTCHA challenge</div></main>');
  const captcha = serviceFor({ statePath: captchaPath, acquire: async () => { requests += 1; return current; } });
  assert.equal((await captcha.runManual()).results[0].status, 'RECOVERY_BLOCKED');
  assert.equal(requests, 2);
});

test('429 opens a persisted cooldown and creates no retry burst', async t => {
  const { statePath } = await workspace(t);
  let requests = 0;
  let now = 1_000;
  const service = serviceFor({
    statePath,
    acquire: async () => { requests += 1; return response('', { status: 429 }); },
    now: () => now
  });
  const first = await service.runManual();
  const second = await service.runManual();
  assert.equal(first.results[0].status, 'UNAVAILABLE');
  assert.equal(second.results[0].status, 'COOLDOWN');
  assert.equal(requests, 1);
});

test('SR-04 bounded retries persist across restart and end in RECOVERY_BLOCKED', async t => {
  const { statePath } = await workspace(t);
  let requests = 0;
  let now = 1_000;
  const delays = [];
  const makeService = requireExistingState => serviceFor({
    statePath,
    acquire: async () => { requests += 1; throw Error('timeout'); },
    now: () => now,
    sleep: async delay => { delays.push(delay); },
    requireExistingState
  });

  let service = makeService(false);
  assert.equal((await service.runManual()).results[0].status, 'UNAVAILABLE');
  now += 101;
  service = makeService(true);
  assert.equal((await service.runManual()).results[0].status, 'UNAVAILABLE');
  const open = await createPolicyWatchStore({ filePath: statePath }).read();
  assert.equal(open.payload.recovery['set-terms-fixture'].state, 'OPEN');
  now += 101;
  service = makeService(true);
  assert.equal((await service.runManual()).results[0].status, 'RECOVERY_BLOCKED');
  const blocked = await makeService(true).runManual();

  assert.equal(blocked.results[0].requests, 0);
  assert.equal(requests, 6);
  assert.deepEqual(delays, [10, 10, 10]);
});

test('coverage report exposes fixture counts and truthful failure gaps', async t => {
  const { statePath } = await workspace(t);
  let current = response(fixture('policy-v1.html'));
  const service = serviceFor({ statePath, acquire: async () => current });
  await service.runManual();
  const healthy = await service.report();
  assert.equal(healthy.status, 'FIXTURE_PASS');
  assert.equal(healthy.verified, 1);
  assert.equal(healthy.changes, 1);
  assert.ok(healthy.lastCheck);

  current = response(fixture('login.html'));
  await service.runManual();
  const partial = await service.report();
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.verified, 1);
});

test('one in-flight fixture check per source is coalesced', async t => {
  const { statePath } = await workspace(t);
  let release;
  let requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const service = serviceFor({
    statePath,
    acquire: async () => { requests += 1; await pending; return response(fixture('policy-v1.html')); }
  });
  const first = service.runManual();
  const second = service.runManual();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(a.results[0].observationId, b.results[0].observationId);
});

test('SR-03 persistent watcher failure remains isolated from the main server', async t => {
  const { statePath } = await workspace(t);
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /policy-watch/);
  const service = serviceFor({ statePath, acquire: async () => { throw Error('timeout'); } });
  const result = await service.runManual();
  assert.equal(result.results[0].status, 'UNAVAILABLE');

  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  const authConfig = await fetch(`http://127.0.0.1:${address.port}/api/auth-config`);
  assert.equal(health.status, 200);
  assert.equal(authConfig.status, 200);
});

test('fixture runner is manual, local-only and restart-capable', async t => {
  const { directory, statePath } = await workspace(t);
  const registryPath = path.join(directory, 'registry.json');
  const responsePath = path.join(directory, 'responses.json');
  const bodyPath = path.join(directory, 'policy.html');
  await fsp.writeFile(registryPath, JSON.stringify(registry), 'utf8');
  await fsp.writeFile(responsePath, JSON.stringify({
    'set-terms-fixture': { status: 200, url: registry[0].canonicalUrl, contentType: 'text/html', bodyFile: 'policy.html' }
  }), 'utf8');
  await fsp.writeFile(bodyPath, fixture('policy-v1.html'), 'utf8');

  const disabled = await runFixtureManual({ registryPath: 'not-read', responsePath: 'not-read', statePath: 'not-read', env: {} });
  assert.equal(disabled.requests, 0);
  const enabled = await runFixtureManual({
    registryPath, responsePath, statePath,
    env: { POLICY_WATCH_ENABLED: 'true', POLICY_WATCH_SHADOW: 'true' }
  });
  const restarted = await runFixtureManual({
    registryPath, responsePath, statePath,
    env: { POLICY_WATCH_ENABLED: 'true', POLICY_WATCH_SHADOW: 'true', POLICY_WATCH_REQUIRE_STATE: 'true' }
  });
  assert.equal(enabled.status, 'FIXTURE_PASS');
  assert.equal(enabled.results[0].status, 'FIRST_VERIFIED_BASELINE');
  assert.equal(restarted.results[0].status, 'UNCHANGED');
});
