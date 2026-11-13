'use strict';

// Offline only: initialize fresh loopback clusters using explicitly supplied PG17
// tools. No connection strings, credentials, existing data directories or cloud.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const bin = process.env.SETSCOPE_PG_BIN;
const postgrest = process.env.SETSCOPE_POSTGREST_BIN;
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(SUPABASE_|PG|DATABASE_URL$|SETSCOPE_)|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(name)) delete env[name];
}
const executable = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function main() {
  assert.equal(process.argv[2], '--local-only', 'Explicit --local-only is required');
  assert.ok(bin && path.isAbsolute(bin), 'SETSCOPE_PG_BIN must name existing PostgreSQL 17 tools');
  assert.match((await run(executable('postgres'), ['--version'], { env })).stdout, /PostgreSQL\) 17\./);
  if (postgrest) assert.ok(path.isAbsolute(postgrest));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'setscope-v165-pg-'));
  let safeToRemove = true;
  try {
    const files = process.argv.includes('--production-only') ? ['test/production-remembered.postgres.cjs']
      : ['test/remembered-session.postgres.cjs', 'test/dev-remembered-role.postgres.cjs', 'test/production-remembered.postgres.cjs'];
    for (const [index, file] of files.entries()) {
      const directory = path.join(temporary, String(index), 'v165-pg-verification');
      const dataDir = path.join(directory, 'data');
      await fs.mkdir(directory, { recursive: true });
      const localPort = await port();
      const pgCtl = executable('pg_ctl');
      const options = { env, windowsHide: true, timeout: 60000 };
      await run(executable('initdb'), ['-D', dataDir, '-U', 'setscope_test_admin', '--auth=trust', '--encoding=UTF8', '--no-locale'], options);
      const socket = directory.replaceAll('\\', '/').replaceAll("'", "''");
      await fs.appendFile(path.join(dataDir, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${localPort}\nmax_connections=25\nlog_statement='none'\n${process.platform === 'win32' ? '' : `unix_socket_directories='${socket}'\n`}`);
      let started = false;
      try {
        await run(pgCtl, ['-D', dataDir, '-l', path.join(directory, 'postgres.log'), '-w', 'start'], options);
        started = true;
        const testEnv = { ...env, SETSCOPE_V165_LOCAL_PG: JSON.stringify({ port: localPort, dataDir, pgCtl }) };
        if (postgrest) testEnv.SETSCOPE_V165_LOCAL_HTTP = JSON.stringify({ executable: postgrest });
        const code = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--test', file], { cwd: root, env: testEnv, stdio: 'inherit', windowsHide: true });
          child.once('error', reject);
          child.once('exit', resolve);
        });
        assert.equal(code, 0, 'Offline PostgreSQL suite failed');
      } finally {
        // A suite can restart the cluster itself. Check actual state before cleanup.
        let running = false;
        try { await run(pgCtl, ['-D', dataDir, 'status'], options); running = true; } catch (error) {
          if (error.code !== 3) { safeToRemove = false; throw new Error('Unable to verify disposable database state'); }
        }
        if (started || running) {
          if (running) try { await run(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], options); }
          catch { safeToRemove = false; throw new Error('Disposable database shutdown failed; directory retained'); }
        }
      }
    }
  } finally {
    const stat = await fs.lstat(temporary);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('setscope-v165-pg-'));
    if (safeToRemove) await fs.rm(temporary, { recursive: true });
  }
}
main().catch(() => { console.error('Offline PostgreSQL verification failed (diagnostics redacted).'); process.exitCode = 1; });
