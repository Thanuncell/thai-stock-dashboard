'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNewsArchiveService } = require('../server/news-archive-service');

const NOW = Date.parse('2026-10-18T00:00:00.000Z');
const item = {
  source: 'infoquest', sourceName: 'InfoQuest',
  title: 'PTT รายงานการดำเนินงานและแผนธุรกิจล่าสุด',
  url: 'https://news.google.com/articles/setscope-egress-fixture',
  pubDate: '2026-10-17T12:00:00.000Z',
  snippet: 'บริษัทชี้แจงข้อมูลผลการดำเนินงานอย่างเป็นทางการ'
};

function makeHarness(outcome, { evidenceMode = 'write' } = {}) {
  let scans = 0, revisionReads = 0, writes = 0, cleanup = 0;
  let time = NOW;
  const rows = [];
  const service = createNewsArchiveService({
    now: () => time,
    env: {
      SUPABASE_URL: 'https://fixture.invalid',
      SUPABASE_SECRET_KEY: 'sb_secret_test_only',
      SETSCOPE_NEWS_EVIDENCE: evidenceMode,
      SETSCOPE_NEWS_ARCHIVE_QUERY: 'off'
    },
    fetchImpl: async (value, init = {}) => {
      const url = new URL(value);
      if (url.pathname.endsWith('/rpc/upsert_news_archive_evidence')) {
        writes++;
        const payload = JSON.parse(init.body).p_rows;
        const ack = typeof outcome === 'function' ? await outcome(payload, writes) : payload.map(row => ({ fingerprint: row.fingerprint, outcome }));
        return ack instanceof Response ? ack : Response.json(ack);
      }
      if (url.pathname.endsWith('/rpc/cleanup_news_archive')) {
        cleanup++;
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get('select') === 'fingerprint,verification_revision') {
        revisionReads++;
        return Response.json(rows.map(({ fingerprint, verification_revision }) => ({ fingerprint, verification_revision })));
      }
      if (url.pathname.endsWith('/news_archive')) {
        if (init.method === 'POST') { writes++; return new Response(null, { status: 204 }); }
        scans++;
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}`, 'content-type': 'application/json' }
        });
      }
      throw Error('unexpected isolated request');
    }
  });
  rows.push(...service.prepare([item]).map(row => ({ ...row, verification_revision: 1, first_seen_at: item.pubDate })));
  return {service, rows, setTime: value => { time = value; }, metrics: () => ({scans, revisionReads, writes, cleanup})};
}

test('retained evidence upsert does not invalidate an unchanged archive snapshot', async () => {
  const h = makeHarness('retained');
  const first = await h.service.list({page:1});
  assert.equal(first.total, 1);
  const before = h.metrics().scans;
  const ack = await h.service.ingest([item]);
  assert.equal(ack.retained, 1);
  assert.equal(ack.ingested, 0);
  await h.service.list({page:2});
  assert.equal(h.metrics().scans, before);
  assert.equal(h.metrics().cleanup, 0);
  assert.deepEqual((await h.service.list()).items, first.items);
});

test('persisted evidence upsert invalidates archive snapshot', async () => {
  const h = makeHarness('persisted');
  await h.service.list({page:1});
  const before = h.metrics().scans;
  const ack = await h.service.ingest([item]);
  assert.equal(ack.ingested, 1);
  await h.service.list({page:2});
  assert.equal(h.metrics().scans, before + 1);
});

test('conflict or not-inserted outcomes retain conservative cache invalidation', async () => {
  for (const status of ['conflict','not_inserted']) {
    const h = makeHarness(status);
    await h.service.list();
    const before = h.metrics().scans;
    const ack = await h.service.ingest([item]);
    assert.equal(ack.ingested, 0);
    await h.service.list({page:3});
    assert.equal(h.metrics().scans, before + 1, status);
  }
});

test('lost or malformed acknowledgements invalidate a possibly changed snapshot', async () => {
  for (const reply of [
    () => { throw Error('lost acknowledgement'); },
    () => new Response('invalid json'),
    () => [],
    payload => payload.map(row => ({ fingerprint: row.fingerprint, outcome: 'unknown' })),
    () => [{ fingerprint: 'wrong', outcome: 'retained' }]
  ]) {
    const h = makeHarness(reply);
    await h.service.list();
    await assert.rejects(h.service.ingest([item]));
    h.rows[0].title = 'PTT รายงานผลประกอบการที่แก้ไขแล้ว';
    // This harness tests invalidation; remove evidence bound to the previous title.
    for (const key of Object.keys(h.rows[0])) if (key.startsWith('verification_')) delete h.rows[0][key];
    delete h.rows[0].canonical_url; delete h.rows[0].canonical_key;
    const result = await h.service.list();
    assert.equal(h.metrics().scans, 2);
    assert.equal(result.items[0].title, h.rows[0].title);
  }
});

test('a later failed batch invalidates a partially persisted write', async () => {
  const h = makeHarness((payload, batch) => {
    if (batch === 2) throw Error('second batch unavailable');
    return payload.map(row => ({ fingerprint: row.fingerprint, outcome: 'persisted' }));
  });
  await h.service.list();
  const items = Array.from({ length: 51 }, (_, i) => ({ ...item, url: item.url + '-' + i }));
  await assert.rejects(h.service.ingest(items), /second batch unavailable/);
  await h.service.list();
  assert.equal(h.metrics().writes, 2);
  assert.equal(h.metrics().scans, 2);
});

test('retained acknowledgements across every batch preserve the snapshot; one persisted row invalidates it', async () => {
  for (const changed of [false, true]) {
    const h = makeHarness((payload, batch) => payload.map((row, i) => ({
      fingerprint: row.fingerprint, outcome: changed && batch === 2 && i === 0 ? 'persisted' : 'retained'
    })));
    await h.service.list();
    const ack = await h.service.ingest(Array.from({ length: 51 }, (_, i) => ({ ...item, url: item.url + '-' + i })));
    assert.equal(ack.retained, changed ? 50 : 51);
    assert.equal(ack.ingested, changed ? 1 : 0);
    await h.service.list();
    assert.equal(h.metrics().scans, changed ? 2 : 1);
  }
});

test('legacy writes still invalidate and read-only evidence mode does not write', async () => {
  for (const evidenceMode of ['', 'read']) {
    const h = makeHarness('retained', { evidenceMode });
    await h.service.list();
    await h.service.ingest([item]);
    await h.service.list();
    assert.equal(h.metrics().writes, evidenceMode === 'read' ? 0 : 1);
    assert.equal(h.metrics().scans, evidenceMode === 'read' ? 1 : 2);
  }
});

test('retained retries do not extend the existing snapshot expiry', async () => {
  const h = makeHarness('retained');
  await h.service.list();
  h.setTime(NOW + 299999);
  await h.service.ingest([item]);
  await h.service.list();
  assert.equal(h.metrics().scans, 1);
  h.setTime(NOW + 300001);
  await h.service.list();
  assert.equal(h.metrics().scans, 2);
});
