'use strict';

const { createCoverageRepository, createCoverageRunner, coverageRunKey } = require('../server/coverage-service');
const { createMarketService } = require('../server/market-service');

async function main() {
  const repository = createCoverageRepository();
  if (!repository.configured) throw Error('Coverage requires server-side SUPABASE_URL and SUPABASE_SECRET_KEY');

  const configuredSymbols = String(process.env.COVERAGE_SYMBOLS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (configuredSymbols.length) await repository.seedSymbols(configuredSymbols);

  const marketService = createMarketService();
  const runner = createCoverageRunner({
    repository,
    verifySymbol: symbol => marketService.verifySymbol(symbol),
    batchSize: process.env.COVERAGE_BATCH_SIZE,
    concurrency: process.env.COVERAGE_CONCURRENCY
  });
  const result = await runner.run({ runKey: coverageRunKey(new Date()) });
  process.stdout.write(`${JSON.stringify({
    runKey: result.runKey,
    alreadyCompleted: Boolean(result.alreadyCompleted),
    alreadyRunning: Boolean(result.alreadyRunning),
    attempted: result.attempted || 0,
    verified: result.verified || 0,
    temporaryFailed: result.temporaryFailed || 0,
    partial: result.partial || 0,
    configuredSymbols: result.configuredSymbols ?? null,
    universe: result.universe ?? null,
    success: result.success ?? null,
    stale: result.stale ?? null,
    error: result.error ?? null,
    inactive: result.inactive ?? null,
    unsupported: result.unsupported ?? null,
    currentVerified: result.currentVerified ?? null,
    technicalReady: result.technicalReady ?? null,
    finishedAt: result.finishedAt || null
  })}\n`);
}

main().catch(error => {
  console.error(`Coverage verification failed: ${error.message}`);
  process.exitCode = 1;
});
