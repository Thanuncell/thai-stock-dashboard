'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createPolicyWatchStore } = require('../server/policy-watch-store');
const { createPolicyWatchService } = require('../server/policy-watch-service');

async function runFixtureManual({ registryPath, responsePath, statePath, sourceId, env = process.env } = {}) {
  if (env.POLICY_WATCH_ENABLED !== 'true' || env.POLICY_WATCH_SHADOW !== 'true') {
    return { status: 'DISABLED', fixtureMode: true, requests: 0, results: [] };
  }
  for (const value of [registryPath, responsePath, statePath]) {
    if (!value || !path.isAbsolute(value)) throw Error('ABSOLUTE_FIXTURE_PATH_REQUIRED');
  }
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const responseFixture = JSON.parse(await fs.readFile(responsePath, 'utf8'));
  const fixtureRoot = path.dirname(responsePath);
  const service = createPolicyWatchService({
    registry,
    store: createPolicyWatchStore({ filePath: statePath }),
    enabled: true,
    shadow: true,
    fixtureMode: true,
    retainFixtureText: true,
    requireExistingState: env.POLICY_WATCH_REQUIRE_STATE === 'true',
    acquire: async source => {
      const configured = responseFixture[source.sourceId];
      if (!configured) throw Error('FIXTURE_RESPONSE_MISSING');
      const bodyPath = path.resolve(fixtureRoot, configured.bodyFile);
      if (!bodyPath.startsWith(`${fixtureRoot}${path.sep}`)) throw Error('FIXTURE_PATH_OUTSIDE_ROOT');
      return { ...configured, body: await fs.readFile(bodyPath, 'utf8') };
    }
  });
  return service.runManual({ sourceIds: sourceId ? [sourceId] : undefined });
}

if (require.main === module) {
  runFixtureManual({
    registryPath: process.argv[2],
    responsePath: process.argv[3],
    statePath: process.argv[4],
    sourceId: process.argv[5]
  }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { runFixtureManual };
