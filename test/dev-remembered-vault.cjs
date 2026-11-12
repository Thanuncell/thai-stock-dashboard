'use strict';
// Explicit Windows/local vault smoke. Never print decrypted data or errors.
const fs = require('node:fs');
const https = require('node:https');
const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const { readVault } = require('../scripts/run-v165-dev.cjs');
async function verify(file) {
  const first = readVault(file), again = readVault(file);
  assert.equal(first.projectId, 'mlqbmtycvlbfbszyrsqd');
  assert.equal(first.encryptionKey === again.encryptionKey, true);
  assert.equal(Buffer.from(first.encryptionKey, 'base64').length, 32);
  const cert = new X509Certificate(fs.readFileSync(file + '.crt'));
  const server = https.createServer({ pfx: Buffer.from(first.tls.pfx, 'base64'), passphrase: first.tls.passphrase,
    minVersion: 'TLSv1.2' }, (req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function request(ca, servername = 'localhost') {
    return new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', servername, port: server.address().port, ca,
        rejectUnauthorized: true, agent: false }, res => {
        const value = { status: res.statusCode, authorized: res.socket.authorized, protocol: res.socket.getProtocol() };
        res.resume(); res.on('end', () => resolve(value));
      }).on('error', error => reject({ code: error.code }));
    });
  }
  try {
    const localTls = await request(cert.toString());
    assert.equal(localTls.authorized, true);
    await assert.rejects(request(undefined));
    await assert.rejects(request(cert.toString(), 'incorrect.example.test'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    return { vault: 'DPAPI CurrentUser; outside Git', keyStableAcrossReload: true, localTls,
      untrustedCertificateRejected: true, wrongHostnameRejected: true, osTrustChanged: false,
      databaseCredentialPresent: Boolean(first.database) };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
if (require.main === module) verify(process.argv[2]).then(value => {
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(value, null, 2));
  console.log(JSON.stringify(value));
}).catch(() => { console.error('Dev vault/TLS check failed; secret values suppressed'); process.exitCode = 1; });
module.exports = { verify };
