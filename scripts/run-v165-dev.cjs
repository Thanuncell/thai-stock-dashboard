'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { createDevRememberedRuntime, DEV_PROJECT, DEV_URL } = require('../server/dev-remembered-runtime');

function vaultFile(file) {
  const full = fs.realpathSync(file);
  const repo = path.resolve(__dirname, '..');
  if (!path.isAbsolute(file) || !full.endsWith('.dpapi') || !path.relative(repo, full).startsWith('..' + path.sep)) {
    throw Error('DEV_EXTERNAL_VAULT_REQUIRED');
  }
  for (let parent = path.dirname(full); ; parent = path.dirname(parent)) {
    if (fs.existsSync(path.join(parent, '.git'))) throw Error('DEV_EXTERNAL_VAULT_REQUIRED');
    if (parent === path.dirname(parent)) break;
  }
  return full;
}
function readVault(file) {
  const full = vaultFile(file);
  // Use the installed PowerShell 7 host used to initialize this vault. Do not
  // lower execution policy or fall back to an inline script to bypass it.
  const powershell = 'pwsh.exe';
  const text = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'v165-dev-vault.ps1'), '-Action', 'Read', '-VaultPath', full],
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
  const result = JSON.parse(text);
  if (result.projectId !== DEV_PROJECT) throw Error('DEV_VAULT_TARGET_REJECTED');
  return result;
}
function writeVault(file, value) {
  const full = vaultFile(file);
  if (value?.projectId !== DEV_PROJECT) throw Error('DEV_VAULT_TARGET_REJECTED');
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'v165-dev-vault.ps1'), '-Action', 'Write', '-VaultPath', full],
      { input: JSON.stringify(value), windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
  } catch (_) { throw Error('DEV_VAULT_WRITE_FAILED'); }
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (!args.includes('--dev-tests-only') || process.env.NODE_ENV === 'production') throw Error('DEV_TEST_MODE_REQUIRED');
  const publicConfig = JSON.parse(fs.readFileSync(value('--public-config'), 'utf8'));
  if (publicConfig.projectId !== DEV_PROJECT || publicConfig.supabaseUrl !== DEV_URL) throw Error('DEV_TARGET_REQUIRED');
  const secrets = readVault(value('--vault'));
  const port = Number(value('--port')) || 4175;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('DEV_PORT_REQUIRED');
  // Isolate all existing handlers from inherited production configuration.
  for (const key of Object.keys(process.env)) if (/^SUPABASE_|^SETSCOPE_|^PG|^DATABASE_URL$|^TRUST_PROXY$/.test(key)) delete process.env[key];
  process.env.SUPABASE_URL = DEV_URL;
  process.env.SUPABASE_ANON_KEY = publicConfig.publishableKey;
  process.env.HOST = '127.0.0.1';
  process.env.NODE_ENV = 'development';
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const runtime = await createDevRememberedRuntime({
    config: { devTestsOnly: true, nodeEnv: 'development', projectId: DEV_PROJECT, supabaseUrl: DEV_URL,
      publishableKey: publicConfig.publishableKey, origin: `https://localhost:${port}`,
      testEmails: (value('--test-emails') || '').split(',').filter(Boolean),
      enableRemember: args.includes('--enable-remember'), guardVerifiedForDevTests: args.includes('--guard-verified-for-dev-tests') },
    secrets, Pool, send
  });
  let server;
  try {
    const { handle } = require('../server');
    server = https.createServer({ pfx: Buffer.from(secrets.tls.pfx, 'base64'), passphrase: secrets.tls.passphrase, minVersion: 'TLSv1.2' }, (req, res) => {
      const route = new URL(req.url, `https://localhost:${port}`).pathname;
      if (route.startsWith('/api/') && !['/api/auth-config', '/api/watchlists', '/api/screener'].includes(route)
        && !route.startsWith('/api/auth/session/')) return send(res, 503, { error: 'DEV_AUTH_TEST_SCOPE_ONLY' });
      handle(req, res, runtime.auth).catch(() => { if (!res.headersSent) send(res, 503, { error: 'DEV_REQUEST_UNAVAILABLE' }); else res.end(); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.close(); };
    process.once('SIGINT', () => close().finally(() => process.exit()));
    process.once('SIGTERM', () => close().finally(() => process.exit()));
    console.log('Dev BFF ready on loopback HTTPS; synthetic accounts only');
  } catch (_) { server?.close(); await runtime.close(); throw Error('DEV_RUNTIME_START_FAILED'); }
}

if (require.main === module) main().catch(() => { console.error('Dev BFF not started: prerequisites unavailable or rejected; no credentials logged'); process.exitCode = 1; });
module.exports = { readVault, writeVault };
