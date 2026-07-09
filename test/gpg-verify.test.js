const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { verifyGpgSignature } = require('../src/util');

// These tests exercise the real `gpg` binary. If gpg is not installed we skip
// the e2e suite rather than fail.
function gpgInstalled() {
  try {
    const r = cp.spawnSync('gpg', ['--version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
function tmpDir(name = 'js2bin-gpgtest') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

describe('verifyGpgSignature (fail-hard, no gpg-independent paths)', () => {
  it('rejects when the public key file does not exist', async () => {
    await assert.rejects(
      () => verifyGpgSignature('/some/binary', {
        binaryUrl: 'https://example.com/bin',
        keyPath: '/definitely/not/a/key.asc'
      }),
      (err) => err.code === 'ERR_GPG_VERIFY' && /public key not found/.test(err.message)
    );
  });
});

// End-to-end against the real gpg binary and a generated key. A server serves
// the detached signature; the public key is read from a local file (as in
// production, where it is committed to the repo).
describe('verifyGpgSignature (e2e with real gpg)', { skip: !gpgInstalled() }, () => {
  let sigServer;
  let sigHost;
  let work;
  let keyHome;
  let fpr;
  let keyPath;

  before(async () => {
    work = tmpDir();
    keyHome = path.join(work, 'keyhome');
    fs.mkdirSync(keyHome, { recursive: true });
    fs.chmodSync(keyHome, 0o700);

    // Generate a throwaway signing key.
    const params = path.join(work, 'keyparams');
    fs.writeFileSync(params, [
      '%no-protection',
      'Key-Type: RSA',
      'Key-Length: 2048',
      'Key-Usage: sign',
      'Name-Real: js2bin test key',
      'Name-Email: test@example.com',
      'Expire-Date: 0',
      '%commit'
    ].join('\n'));
    cp.execSync(`gpg --homedir "${keyHome}" --batch --gen-key "${params}"`, { stdio: 'ignore' });
    const listing = cp.execSync(`gpg --homedir "${keyHome}" --batch --with-colons --fingerprint`, { encoding: 'utf8' });
    fpr = listing.split('\n').find(l => l.startsWith('fpr:')).split(':').filter(Boolean).pop();

    // Export the public half to a local file (the committed-key stand-in).
    keyPath = path.join(work, 'release-signing.asc');
    cp.execSync(`gpg --homedir "${keyHome}" --batch --armor --export ${fpr} > "${keyPath}"`);

    // Server serves served.asc for any *.asc request.
    sigServer = await startServer((req, res) => {
      const sigPath = path.join(work, 'served.asc');
      if (req.url.endsWith('.asc') && fs.existsSync(sigPath)) {
        res.statusCode = 200;
        res.end(fs.readFileSync(sigPath));
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    const addr = sigServer.address();
    sigHost = `127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (sigServer) await stopServer(sigServer);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function sign(file) {
    const sig = path.join(work, 'served.asc');
    cp.execSync(`gpg --homedir "${keyHome}" --batch --yes --armor --detach-sign --local-user ${fpr} -o "${sig}" "${file}"`);
  }

  it('resolves for a valid signature against the committed key', async () => {
    const bin = path.join(work, 'node-bin');
    fs.writeFileSync(bin, 'node binary bytes');
    sign(bin);
    const binaryUrl = `http://${sigHost}/criblio/js2bin/releases/download/v1.0.9/node-bin`;
    await verifyGpgSignature(bin, { binaryUrl, keyPath });
  });

  it('uses an explicit sigUrl when provided', async () => {
    const bin = path.join(work, 'node-bin-explicit');
    fs.writeFileSync(bin, 'explicit sig url bytes');
    sign(bin);
    await verifyGpgSignature(bin, {
      binaryUrl: 'http://unused.example/ignored',
      sigUrl: `http://${sigHost}/anything.asc`,
      keyPath
    });
  });

  it('rejects (fails hard) when the binary is tampered after signing', async () => {
    const bin = path.join(work, 'node-bin2');
    fs.writeFileSync(bin, 'original bytes');
    sign(bin);
    fs.writeFileSync(bin, 'TAMPERED bytes');
    const binaryUrl = `http://${sigHost}/criblio/js2bin/releases/download/v1.0.9/node-bin2`;
    await assert.rejects(
      () => verifyGpgSignature(bin, { binaryUrl, keyPath }),
      (err) => err.code === 'ERR_GPG_VERIFY' && /verification failed/.test(err.message)
    );
  });

  it('rejects (fails hard) when no signature is published (404)', async () => {
    const sigPath = path.join(work, 'served.asc');
    if (fs.existsSync(sigPath)) fs.unlinkSync(sigPath);
    const bin = path.join(work, 'node-bin3');
    fs.writeFileSync(bin, 'unsigned asset bytes');
    const binaryUrl = `http://${sigHost}/criblio/js2bin/releases/download/v1.0.9/node-bin3`;
    await assert.rejects(
      () => verifyGpgSignature(bin, { binaryUrl, keyPath }),
      (err) => err.code === 'ERR_GPG_VERIFY' && /could not fetch signature/.test(err.message)
    );
  });

  it('rejects (fails hard) when the signature is from a different key', async () => {
    // Generate a second key, sign with it, but verify against the first key.
    const otherHome = path.join(work, 'otherhome');
    fs.mkdirSync(otherHome, { recursive: true });
    fs.chmodSync(otherHome, 0o700);
    const params = path.join(work, 'otherparams');
    fs.writeFileSync(params, [
      '%no-protection', 'Key-Type: RSA', 'Key-Length: 2048', 'Key-Usage: sign',
      'Name-Real: other key', 'Name-Email: other@example.com', 'Expire-Date: 0', '%commit'
    ].join('\n'));
    cp.execSync(`gpg --homedir "${otherHome}" --batch --gen-key "${params}"`, { stdio: 'ignore' });
    const otherFpr = cp.execSync(`gpg --homedir "${otherHome}" --batch --with-colons --fingerprint`, { encoding: 'utf8' })
      .split('\n').find(l => l.startsWith('fpr:')).split(':').filter(Boolean).pop();

    const bin = path.join(work, 'node-bin4');
    fs.writeFileSync(bin, 'signed by wrong key');
    cp.execSync(`gpg --homedir "${otherHome}" --batch --yes --armor --detach-sign --local-user ${otherFpr} -o "${path.join(work, 'served.asc')}" "${bin}"`);

    const binaryUrl = `http://${sigHost}/criblio/js2bin/releases/download/v1.0.9/node-bin4`;
    await assert.rejects(
      () => verifyGpgSignature(bin, { binaryUrl, keyPath }),
      (err) => err.code === 'ERR_GPG_VERIFY' && /verification failed/.test(err.message)
    );
  });
});
