'use strict';

const { createHash } = require('node:crypto');
const { dryRunImport, prepareImportAdds } = require('./security-import');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshots = async (client, symbols) => (await client.query(
  'select row_to_json(c)::text as snapshot from public.security_coverage c where symbol=any($1::text[]) order by symbol', [symbols]
)).rows.map(row => row.snapshot);

function reviewRegistration(input, options = {}) {
  if (!Array.isArray(input) || !input.length || input.length > 1000) throw Error('Explicit batch of 1..1000 records required');
  return dryRunImport(input, options);
}

// Uses only the existing registry. Receipt storage is an explicit private file store.
function createRegistryImporter({ pool, store, target }) {
  if (!pool?.connect || !store?.load || !store?.save || !target?.database || !target?.role || !target?.host) throw Error('Explicit target, pool and private receipts required');
  const targetKey = digest(target);
  const receiptKey = runKey => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runKey || '')) throw Error('Invalid import key');
    return `registry:${targetKey}:${runKey}`;
  };
  function approve(approval, operation, inputKey) {
    if (approval?.approved !== true || approval.operation !== operation || approval.inputKey !== inputKey
      || digest(approval.target) !== targetKey || !String(approval.evidence || '').trim()) throw Error('Exact target and operation approval required');
  }
  async function session(action) {
    const client = await pool.connect();
    let locked = false, broken;
    const onError = error => { broken = error; };
    client.on?.('error', onError);
    try {
      const { rows: [identity] } = await client.query('select current_database() as database, current_user as role');
      if (identity.database !== target.database || identity.role !== target.role) throw Error('Database identity mismatch');
      locked = (await client.query('select pg_try_advisory_lock(hashtext($1)) as locked', [`setscope-registry:${targetKey}`])).rows[0].locked;
      if (!locked) throw Error('Manual import already running');
      return await action(client);
    } finally {
      if (locked) try { await client.query('select pg_advisory_unlock(hashtext($1))', [`setscope-registry:${targetKey}`]); }
      catch (error) { broken = error; }
      client.release(broken);
      client.off?.('error', onError);
    }
  }
  async function transaction(client, action) {
    await client.query('begin');
    try {
      await client.query("select set_config('lock_timeout','3000',true),set_config('statement_timeout','10000',true)");
      await client.query('lock table public.security_coverage in share row exclusive mode');
      await client.query('lock table public.user_watchlists in share mode');
      const value = await action();
      await client.query('commit');
      return value;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* Receipt remains unresolved; never retry an uncertain COMMIT. */ }
      throw error;
    }
  }
  async function protectedReferences(client) {
    const rows = (await client.query(`select distinct v #>> '{}' as symbol from public.user_watchlists w
      cross join lateral jsonb_path_query(w.watchlists,'$.**.symbol') v where jsonb_typeof(v)='string' limit 10001`)).rows;
    if (rows.length > 10000) throw Error('Protected reference limit exceeded');
    return rows.map(row => row.symbol);
  }
  function checkReceipt(receipt, inputKey) {
    if (!receipt || receipt.version !== 1 || receipt.targetKey !== targetKey || receipt.inputKey !== inputKey
      || !Array.isArray(receipt.approvedSymbols) || receipt.approvedSymbols.some(symbol => typeof symbol !== 'string')
      || !Array.isArray(receipt.insertedSnapshots) || receipt.insertedSnapshots.length > 1000
      || digest(receipt.insertedSnapshots) !== receipt.rowsDigest) throw Error('Invalid import receipt');
    const rows = receipt.insertedSnapshots.map(text => JSON.parse(text));
    if (new Set(rows.map(row => row.symbol)).size !== rows.length
      || rows.some(row => !receipt.approvedSymbols.includes(row.symbol))) throw Error('Invalid receipt ownership');
    return rows;
  }
  async function register({ runKey, input, reviewedInputKey, approvedSymbols, approval }) {
    approve(approval, 'register', reviewedInputKey);
    const initial = reviewRegistration(input);
    if (initial.inputKey !== reviewedInputKey) throw Error('Import input changed');
    const allowed = prepareImportAdds(input, { existing: [], protectedSymbols: [], approvedSymbols, reviewedInputKey });
    const key = receiptKey(runKey), fingerprint = digest([initial.inputKey, [...approvedSymbols].sort()]);
    return session(async client => {
      const prior = await store.load(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Error('Import receipt conflict');
        const owned = checkReceipt(prior, reviewedInputKey);
        if (prior.status !== 'completed') throw Error('Receipt requires read-only recovery review');
        if (digest(await snapshots(client, owned.map(row => row.symbol))) !== prior.rowsDigest) throw Error('Registered rows changed; do not replay');
        return { ...prior, replayed: true };
      }
      const intent = { version: 1, targetKey, fingerprint, inputKey: reviewedInputKey, approvedSymbols,
        status: 'inflight', insertedSnapshots: [], rowsDigest: digest([]) };
      await store.save(key, intent);
      const receipt = await transaction(client, async () => {
        const existing = (await client.query('select * from public.security_coverage order by symbol limit 10001')).rows;
        if (existing.length > 10000) throw Error('Registry review limit exceeded');
        const refs = await protectedReferences(client);
        const oldSymbols = existing.map(row => row.symbol), before = await snapshots(client, oldSymbols);
        const old = new Map(existing.map(row => [row.symbol, row]));
        // Existing symbols are preserved, including unknown legacy instruments.
        const fresh = allowed.filter(row => !old.has(row.symbol));
        if (fresh.some(row => refs.includes(row.symbol) || existing.some(e => e.provider_symbol === row.provider_symbol))) throw Error('Protected symbol or provider mapping conflict');
        const additions = fresh.map(row => ({ symbol: row.symbol, provider_symbol: row.provider_symbol }));
        const inserted = additions.length ? (await client.query(`insert into public.security_coverage
          (symbol,provider_symbol,provider,active,status,symbol_verified,chart_ready,technical_ready)
          select r.symbol,r.provider_symbol,'Yahoo Finance',true,'pending',false,false,false
          from jsonb_to_recordset($1::jsonb) as r(symbol text,provider_symbol text)
          on conflict(symbol) do nothing returning symbol`, [JSON.stringify(additions)])).rows : [];
        if (inserted.length !== additions.length) throw Error('Incomplete atomic insert');
        const insertedSnapshots = await snapshots(client, inserted.map(row => row.symbol));
        const saved = insertedSnapshots.map(text => JSON.parse(text));
        if (saved.some(row => row.status !== 'pending' || row.symbol_verified || row.chart_ready || row.technical_ready
          || row.last_checked_at || row.last_success_at || row.last_verified_at)) throw Error('New rows must be unverified PENDING');
        if (digest(await snapshots(client, oldSymbols)) !== digest(before)) throw Error('Legacy registry changed');
        const prepared = { ...intent, status: 'prepared', inserted: inserted.length, noChange: allowed.length - inserted.length,
          insertedSnapshots, rowsDigest: digest(insertedSnapshots), sourceRecords: initial.entries.filter(e => approvedSymbols.includes(e.symbol)).map(e => e.staged),
          previousRegistryDigest: digest(before), registeredAt: new Date().toISOString() };
        await store.save(key, prepared); // Durable before COMMIT; uncertain outcomes cannot auto-replay.
        return prepared;
      });
      const completed = { ...receipt, status: 'completed' };
      await store.save(key, completed);
      return completed;
    });
  }
  async function recover({ runKey, inputKey, finalize = false, approval }) {
    return session(async client => {
      const receipt = await store.load(receiptKey(runKey)), rows = checkReceipt(receipt, inputKey);
      if (['rollback_prepared', 'rolled_back'].includes(receipt.status)) {
        const current = await snapshots(client, rows.map(row => row.symbol));
        const status = !current.length ? 'rolled_back' : digest(current) === receipt.rowsDigest ? 'rollback_not_applied' : 'manual_review';
        if (finalize) {
          approve(approval, 'recover', inputKey);
          if (status === 'manual_review') throw Error('Recovery requires manual review');
          await store.save(receiptKey(runKey), { ...receipt, status: status === 'rolled_back' ? 'rolled_back' : 'completed' });
        }
        return { status, writes: 0 };
      }
      if (!['prepared', 'completed'].includes(receipt.status)) return { status: 'manual_review', writes: 0 };
      const current = await snapshots(client, rows.map(row => row.symbol));
      const status = !rows.length || digest(current) === receipt.rowsDigest ? 'committed'
        : current.length === 0 && receipt.status === 'prepared' ? 'not_present' : 'manual_review';
      if (finalize) {
        approve(approval, 'recover', inputKey);
        if (status !== 'committed') throw Error('Recovery requires manual review');
        await store.save(receiptKey(runKey), { ...receipt, status: 'completed' });
      }
      return { status, writes: 0 };
    });
  }
  async function rollback({ runKey, inputKey, approval }) {
    approve(approval, 'rollback', inputKey);
    return session(async client => {
      const key = receiptKey(runKey), receipt = await store.load(key), rows = checkReceipt(receipt, inputKey);
      if (receipt.status === 'rolled_back') {
        if ((await snapshots(client, rows.map(row => row.symbol))).length) throw Error('Rollback ownership changed');
        return { status: 'rolled_back', removed: 0, replayed: true };
      }
      if (receipt.status !== 'completed') throw Error('Completed receipt required for rollback');
      return transaction(client, async () => {
        const symbols = rows.map(row => row.symbol), refs = await protectedReferences(client);
        if (symbols.some(symbol => refs.includes(symbol))) throw Error('Rollback blocked by Watchlist reference');
        if (digest(await snapshots(client, symbols)) !== receipt.rowsDigest) throw Error('Rollback blocked by changed or missing rows');
        await store.save(key, { ...receipt, status: 'rollback_prepared' });
        const removed = (await client.query('delete from public.security_coverage where symbol=any($1::text[]) returning symbol', [symbols])).rows;
        if (removed.length !== symbols.length) throw Error('Incomplete rollback');
        return { status: 'rolled_back', removed: removed.length };
      }).then(async result => { await store.save(key, { ...receipt, ...result }); return result; });
    });
  }
  return { register, recover, rollback };
}

module.exports = { createRegistryImporter, reviewRegistration };
