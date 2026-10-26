'use strict';

const { createControlledCoverage } = require('../server/controlled-coverage');

async function main({ env = process.env, controller } = {}) {
  if (env.SETSCOPE_V156_MANUAL_VERIFY !== '1' || env.SETSCOPE_V156_KILL === '1') throw Error('Manual verification is OFF');
  // No deployment, schema installation, scheduler or automatic startup.
  const control = controller || createControlledCoverage({ env });
  return control.execute({ tag: env.SETSCOPE_V156_RUN_TAG || 'manual-1',
    resume: env.SETSCOPE_V156_RESUME === '1', operation: env.SETSCOPE_V156_OPERATION || 'run', runKey: env.SETSCOPE_V156_RUN_KEY,
    mode: env.SETSCOPE_V156_MODE || 'coverage', reviewed: env.SETSCOPE_V156_RECONCILIATION_REVIEWED === '1' });
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
  console.error('Controlled verification stopped. Inspect durable status before retry.');
  process.exitCode = 1;
});
module.exports = { main };
