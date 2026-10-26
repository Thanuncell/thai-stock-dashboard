'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { reviewRegistration, createRegistryImporter } = require('../server/coverage-registration');
const { createFileCheckpoint } = require('../server/coverage-checkpoint');

async function runRegistration(plan, { execute = false, env = process.env, poolFactory } = {}) {
  const mode = plan.mode || 'review';
  if (mode === 'review') {
    const report = reviewRegistration(plan.input, { existing: plan.existing || [], protectedSymbols: plan.protectedSymbols || [] });
    return { ...report, actions: report.entries.map(({ symbol, action }) => ({ symbol, action })) };
  }
  if (!['register', 'recover', 'rollback'].includes(mode)) throw Error('Unknown registration operation');
  if ((mode !== 'recover' || plan.finalize === true) && (!execute || plan.approval?.approved !== true)) throw Error('Explicit execution approval required');
  if (!plan.receiptDirectory || !path.isAbsolute(plan.receiptDirectory)) throw Error('Explicit private receipt directory required');
  const root = path.resolve(__dirname, '..'), directory = path.resolve(plan.receiptDirectory);
  async function physical(location) {
    try { return await fs.realpath(location); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(location);
      if (parent === location) throw error;
      return path.join(await physical(parent), path.basename(location));
    }
  }
  const relative = path.relative(await fs.realpath(root), await physical(directory));
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw Error('Receipts must remain outside the repository');
  const connection = env.SETSCOPE_REGISTRATION_DATABASE_URL;
  if (!connection) throw Error('Explicit database connection required');
  const url = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== plan.target?.host
    || decodeURIComponent(url.pathname.slice(1)) !== plan.target?.database || decodeURIComponent(url.username) !== plan.target?.role) throw Error('Connection does not match reviewed target');
  // pg is loaded only for a deliberate operation; review cannot create a connection.
  const pool = poolFactory ? await poolFactory(connection) : new (require('pg').Pool)({
    connectionString: connection, max: 1, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000'
  });
  try {
    const importer = createRegistryImporter({ pool, store: createFileCheckpoint(directory), target: plan.target });
    if (mode === 'register') return await importer.register(plan);
    return await importer[mode]({ ...plan, inputKey: plan.reviewedInputKey });
  } finally { await pool.end(); }
}

async function main() {
  const args = process.argv.slice(2), filename = args.find(arg => !arg.startsWith('--'));
  if (!filename) throw Error('Explicit reviewed input file required');
  const plan = JSON.parse(await fs.readFile(filename, 'utf8'));
  const result = await runRegistration(plan, { execute: args.includes('--execute') });
  const counts = {};
  for (const row of result.actions || []) counts[row.action] = (counts[row.action] || 0) + 1;
  console.log(JSON.stringify({ status: result.status || 'review', writes: result.writes ?? result.inserted ?? result.removed ?? 0,
    inputKey: result.inputKey, counts, replayed: Boolean(result.replayed) }));
}
if (require.main === module) main().catch(() => {
  console.error('Registration stopped. Review the private plan and receipt; do not blindly retry.');
  process.exitCode = 1;
});
module.exports = { runRegistration };
