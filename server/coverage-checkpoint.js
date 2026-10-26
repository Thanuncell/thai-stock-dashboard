'use strict';
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeSymbol } = require('../lib/validation');
function batchKey(rows) {
  const manifest = rows.map(row => [row.symbol, row.provider_symbol, row.instrument_id ?? row.instrumentId ?? null, row.active !== false]);
  manifest.sort((left, right) => left[0].localeCompare(right[0]));
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}



function createFileCheckpoint(directory) {
  const name = key => createHash('sha256').update(String(key)).digest('hex');
  return {
    async withLease(key, action) {
      await fs.mkdir(directory, { recursive: true });
      const lock = path.join(directory, `${name(key)}.lock`);
      // Serialize lock creation and dead-owner recovery; never guess from elapsed time.
      const gatePath = `${lock}.reclaim`;
      const gate = await fs.open(gatePath, 'wx');
      const token = randomUUID();
      try {
        let handle;
        try { handle = await fs.open(lock, 'wx'); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.token) throw Error('Invalid checkpoint lease');
          let dead = false;
          try { process.kill(owner.pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') dead = true; else throw probe; }
          if (!dead) throw error;
          await fs.unlink(lock);
          handle = await fs.open(lock, 'wx');
        }
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
        finally { await handle.close(); }
      } finally { await gate.close(); await fs.unlink(gatePath); }
      try { return await action(); }
      finally {
        const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
        if (owner.token !== token) throw Error('Checkpoint lease changed');
        await fs.unlink(lock);
      }
    },
    async load(key) {
      try { return JSON.parse(await fs.readFile(path.join(directory, `${name(key)}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async save(key, value) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, `${name(key)}.json`);
      const temporary = `${target}.tmp`;
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, target);
    }
  };
}


function createCheckpointBatch({ store, verify, apply }) {
  if (!store?.withLease || !store.load || !store.save || !verify || !apply) throw Error('Explicit batch dependencies required');
  async function run({ runKey, rows }) {
    if (!runKey || !Array.isArray(rows) || !rows.length || rows.length > 200) throw Error('Invalid bounded batch');
    if (rows.some(row => !row || row.active === false || normalizeSymbol(row.symbol) !== row.symbol
        || !/^[A-Z0-9&.-]{1,32}\.BK$/.test(row.provider_symbol))
      || new Set(rows.map(row => row.symbol)).size !== rows.length) throw Error('Ambiguous batch identity');
    rows = structuredClone(rows);
    return store.withLease(runKey, async () => {
      const fingerprint = batchKey(rows);
      let checkpoint = await store.load(runKey);
      if (checkpoint && (checkpoint.version !== 1 || !checkpoint.entries || Array.isArray(checkpoint.entries)
        || !['running', 'completed'].includes(checkpoint.status)
        || Object.keys(checkpoint.entries).some(symbol => !rows.some(row => row.symbol === symbol)))) throw Error('Invalid checkpoint');
      if (checkpoint && checkpoint.fingerprint !== fingerprint) throw Error('Checkpoint input conflict');
      if (!checkpoint) {
        checkpoint = { version: 1, fingerprint, status: 'running', entries: {} };
        await store.save(runKey, checkpoint);
      }
      for (const row of rows) {
        let entry = checkpoint.entries[row.symbol];
        if (entry && !['applied', 'inflight', 'checked'].includes(entry.status)) throw Error('Invalid checkpoint entry');
        if (entry?.status === 'checked' && (!entry.result || typeof entry.result !== 'object' || Array.isArray(entry.result))) throw Error('Invalid checkpoint evidence');
        if (entry?.status === 'applied') continue;
        if (entry?.status === 'inflight') throw Error('Uncertain provider result: manual reconciliation required');
        if (!entry) {
          checkpoint.entries[row.symbol] = { status: 'inflight' };
          await store.save(runKey, checkpoint);
          // No automatic replay after an interrupted or denied provider operation.
          const result = await verify(row.symbol, row.provider_symbol);
          if (!result || typeof result !== 'object') throw Error('Missing verification evidence');
          entry = { status: 'checked', result };
          checkpoint.entries[row.symbol] = entry;
          await store.save(runKey, checkpoint);
        }
        // Apply must be idempotent using this stable key, including crash after write.
        await apply(row, entry.result, `${runKey}:${row.symbol}`);
        entry.status = 'applied';
        await store.save(runKey, checkpoint);
      }
      checkpoint.status = 'completed';
      await store.save(runKey, checkpoint);
      return checkpoint;
    });
  }
  return { run };
}

module.exports = { batchKey, createFileCheckpoint, createCheckpointBatch };
