'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertPublicHttpsUrl,
  classifyObservation,
  validateDocumentIdentity,
  validateRegistry
} = require('../lib/policy-document');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-watch', name), 'utf8');
const registryEntry = {
  sourceId: 'set-terms-fixture',
  publisher: 'SET',
  canonicalUrl: 'https://www.set.or.th/fixture/terms',
  permittedHosts: ['www.set.or.th'],
  docType: 'terms',
  expectedMarkers: ['SET Website Terms of Use', 'Access policy', 'Data use'],
  rightsEvidence: { status: 'UNVERIFIED', checkedAt: null },
  enabled: false
};
const response = (body, overrides = {}) => ({
  status: 200,
  url: registryEntry.canonicalUrl,
  redirects: [],
  contentType: 'text/html; charset=utf-8',
  body,
  ...overrides
});

test('registry keeps rights and live acquisition disabled until separately approved', () => {
  const [entry] = validateRegistry([registryEntry]);
  assert.equal(entry.rightsEvidence.status, 'UNVERIFIED');
  assert.equal(entry.enabled, false);
  assert.equal(entry.publisher, 'SET');
  assert.equal(Object.isFrozen(entry), true);
});

test('first verified fixture creates a baseline rather than a change event', () => {
  const [entry] = validateRegistry([registryEntry]);
  const identity = validateDocumentIdentity(entry, response(fixture('policy-v1.html')));
  assert.equal(identity.matched, true);
  assert.deepEqual(classifyObservation(null, { ...identity, sourceId: entry.sourceId }), {
    status: 'FIRST_VERIFIED_BASELINE', changeType: 'BASELINE'
  });
});

test('content, layout and document move changes remain distinct', () => {
  const [entry] = validateRegistry([registryEntry]);
  const first = { ...validateDocumentIdentity(entry, response(fixture('policy-v1.html'))), sourceId: entry.sourceId };
  const content = { ...validateDocumentIdentity(entry, response(fixture('policy-v2.html'))), sourceId: entry.sourceId };
  const layout = { ...validateDocumentIdentity(entry, response(fixture('policy-v1-layout.html'))), sourceId: entry.sourceId };
  const moved = { ...first, finalUrl: 'https://www.set.or.th/fixture/terms-v2' };

  assert.equal(classifyObservation(first, first).status, 'UNCHANGED');
  assert.equal(classifyObservation(first, content).changeType, 'CONTENT_CHANGE');
  assert.equal(classifyObservation(first, layout).changeType, 'LAYOUT_CHANGE');
  assert.equal(classifyObservation(first, moved).changeType, 'DOCUMENT_MOVED');
});

test('HTTP success cannot promote login or a marker-mismatched page', () => {
  const [entry] = validateRegistry([registryEntry]);
  const login = validateDocumentIdentity(entry, response(fixture('login.html')));
  const unrelated = validateDocumentIdentity(entry, response('<main><h1>Other official page</h1><p>This is not the registered document.</p></main>'));
  assert.deepEqual([login.status, unrelated.status], ['DOCUMENT_MISMATCH', 'DOCUMENT_MISMATCH']);
  assert.equal(login.reason, 'WRONG_PAGE_CLASS');
  assert.equal(unrelated.reason, 'IDENTITY_MARKERS_MISSING');
});

test('unsupported redirects, private hosts and oversized responses fail closed', () => {
  const [entry] = validateRegistry([registryEntry]);
  const privateRedirect = validateDocumentIdentity(entry, response(fixture('policy-v1.html'), {
    redirects: ['https://127.0.0.1/private']
  }));
  const foreignRedirect = validateDocumentIdentity(entry, response(fixture('policy-v1.html'), {
    redirects: ['https://example.com/terms']
  }));
  const oversized = validateDocumentIdentity(entry, response('x'.repeat(513_000)));

  assert.equal(privateRedirect.status, 'DOCUMENT_MISMATCH');
  assert.equal(foreignRedirect.status, 'DOCUMENT_MISMATCH');
  assert.equal(oversized.reason, 'DOCUMENT_TOO_LARGE');
  assert.throws(() => assertPublicHttpsUrl('http://www.set.or.th/terms', entry.permittedHosts), /UNSAFE_DOCUMENT_URL/);
});

test('transport failure is FETCH_FAILURE and never UNCHANGED', () => {
  const [entry] = validateRegistry([registryEntry]);
  const failure = validateDocumentIdentity(entry, response('', { status: 503 }));
  assert.equal(failure.status, 'FETCH_FAILURE');
  assert.notEqual(classifyObservation(null, failure).status, 'UNCHANGED');
});
