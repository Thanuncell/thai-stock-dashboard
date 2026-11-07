'use strict';

const { createCoverageRepository } = require('../server/coverage-service');
const { createMarketService } = require('../server/market-service');
const { createScreenerAcquisition } = require('../server/screener-acquisition');
const { createScreenerSnapshotStore } = require('../server/screener-snapshot-store');

async function main(args, env = process.env) {
  if (args.length === 1 && args[0] === '--rollback') {
    const store = createScreenerSnapshotStore(env.SETSCOPE_SCREENER_SNAPSHOT_DIR || '');
    return store.withLease(async () => ({ status: 'ROLLED_BACK', snapshotId: await store.rollback(), requests: 0 }));
  }
  const budget = args[1]?.match(/^--max-requests=([1-9]\d{0,3})$/);
  if (args.length !== 2 || args[0] !== '--acquire' || !budget || env.SETSCOPE_SCREENER_MANUAL_ACQUISITION !== '1')
    throw Error('Explicit operator authorization and budget required');
  const store = createScreenerSnapshotStore(env.SETSCOPE_SCREENER_SNAPSHOT_DIR || '');
  const coverage = createCoverageRepository({ env });
  if (!coverage.configured) throw Error('Coverage registry unavailable');
  const market = createMarketService({ env });
  return createScreenerAcquisition({
    listCoverage: coverage.listCandidates, readDaily: market.readScreenerDaily, store
  }).run({ maxRequests: Number(budget[1]) });
}

if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!['PUBLISHED', 'ROLLED_BACK'].includes(result.status)) process.exitCode = 1;
}).catch(() => {
  console.error('Screener operation stopped. Verify local storage and operator settings.');
  process.exitCode = 1;
});

module.exports = { main };
