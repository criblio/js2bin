const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const CLI_PATH = path.join(__dirname, '..', 'js2bin.js');

function generateKeypair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function createApp(dir, name, code) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, code);
  return filePath;
}

async function runCli(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [CLI_PATH, ...args],
      { timeout: opts.timeout || 30000, env: { ...process.env, ...opts.env } }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

async function runBinary(binPath, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      binPath, opts.args || [],
      { timeout: opts.timeout || 10000, env: { ...process.env, ...opts.env } }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// ---------------------------------------------------------------------------
// Tier 1: Overlay Bundle CLI (--overlay) — always runs, fast
// ---------------------------------------------------------------------------

describe('Overlay Integration: Bundle CLI (--overlay)', () => {
  let tmpDir;
  let keypair;
  let appFile;
  let keyFile;

  const appContent = 'console.log("overlay-bundle-test");';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-integ-'));
    keypair = generateKeypair();
    appFile = createApp(tmpDir, 'app.js', appContent);
    keyFile = path.join(tmpDir, 'signing.key');
    fs.writeFileSync(keyFile, keypair.privateKey);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should produce all three bundle artifacts', async () => {
    const outputDir = path.join(tmpDir, 'out');
    const result = await runCli([
      '--overlay',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    assert.equal(result.code, 0, `CLI failed: ${result.stderr}`);
    assert.ok(fs.existsSync(path.join(outputDir, 'bundle.js')));
    assert.ok(fs.existsSync(path.join(outputDir, 'bundle.js.sig')));
    assert.ok(fs.existsSync(path.join(outputDir, 'bundle.js.sha256')));
  });

  it('should produce a bundle that decompresses to the original JS', async () => {
    const outputDir = path.join(tmpDir, 'out');
    await runCli([
      '--overlay',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    const bundleContent = fs.readFileSync(path.join(outputDir, 'bundle.js'), 'utf8');
    const decompressed = zlib.brotliDecompressSync(Buffer.from(bundleContent, 'base64')).toString();
    assert.equal(decompressed, appContent);
  });

  it('should produce a valid signature verifiable with the public key', async () => {
    const outputDir = path.join(tmpDir, 'out');
    await runCli([
      '--overlay',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    const bundleData = fs.readFileSync(path.join(outputDir, 'bundle.js'));
    const sigData = fs.readFileSync(path.join(outputDir, 'bundle.js.sig'));
    const verify = crypto.createVerify('SHA256');
    verify.update(bundleData);
    verify.end();
    assert.ok(verify.verify({ key: keypair.publicKey, dsaEncoding: 'der' }, sigData));
  });

  it('should write a correct sha256 checksum', async () => {
    const outputDir = path.join(tmpDir, 'out');
    await runCli([
      '--overlay',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);

    const bundleData = fs.readFileSync(path.join(outputDir, 'bundle.js'));
    const expectedChecksum = crypto.createHash('sha256').update(bundleData).digest('hex');
    const writtenChecksum = fs.readFileSync(path.join(outputDir, 'bundle.js.sha256'), 'utf8');
    assert.equal(writtenChecksum, expectedChecksum);
  });

  it('should fail without --signing-key', async () => {
    const result = await runCli([
      '--overlay',
      `--app=${appFile}`,
    ]);
    assert.notEqual(result.code, 0);
  });

  it('should fail without --app', async () => {
    const result = await runCli([
      '--overlay',
      `--signing-key=${keyFile}`,
    ]);
    assert.notEqual(result.code, 0);
  });

  it('should fail with nonexistent app file', async () => {
    const result = await runCli([
      '--overlay',
      '--app=/tmp/does-not-exist-overlay-test.js',
      `--signing-key=${keyFile}`,
    ]);
    assert.notEqual(result.code, 0);
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Full Binary Overlay Flow
//
// Tries to build an overlay-enabled binary via --build --enable-overlay --cache.
// If the overlay cached binary isn't available, falls back to JS2BIN_OVERLAY_BINARY
// env var. Skips if neither works.
// ---------------------------------------------------------------------------

const DEFAULT_NODE_VERSION = '22.22.0';
const DEFAULT_BUILD_VERSION = 'v2';
const DEFAULT_SIZE = '6MB';
const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform;
const ARCH = process.arch;

let resolvedBinary = null;
let setupDir = null;

describe('Overlay Integration: Full Binary Flow', async () => {
  let tmpDir;
  let keypair;
  let binPath;
  let skipBinaryTests = false;

  before(async () => {
    setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-setup-'));
    const embeddedApp = createApp(setupDir, 'embedded.js', 'console.log("embedded-ok");');
    const binName = path.join(setupDir, 'overlay-integ-test');

    // Single keypair: the public half is embedded at --build time (the only
    // accepted verifier) and the private half signs every bundle in tests.
    keypair = generateKeypair();
    const buildKeyFile = path.join(setupDir, 'signing.pub');
    fs.writeFileSync(buildKeyFile, keypair.publicKey);

    const buildResult = await runCli([
      '--build',
      `--app=${embeddedApp}`,
      `--node=${DEFAULT_NODE_VERSION}`,
      `--build-version=${DEFAULT_BUILD_VERSION}`,
      `--size=${DEFAULT_SIZE}`,
      '--enable-overlay',
      `--signing-public-key=${buildKeyFile}`,
      '--cache',
      `--name=${binName}`,
      `--platform=${PLATFORM}`,
      `--arch=${ARCH}`,
    ], { timeout: 60000 });

    const builtPath = `${binName}-${PLATFORM}-${ARCH}`;
    console.log(`Build result: code=${buildResult.code} stdout=${buildResult.stdout} stderr=${buildResult.stderr}`);
    if (buildResult.code === 0 && fs.existsSync(builtPath)) {
      if (process.platform === 'darwin') {
        try { await execFileAsync('codesign', ['--force', '--sign', '-', builtPath]); } catch {}
      }
      resolvedBinary = builtPath;
    } else if (process.env.JS2BIN_OVERLAY_BINARY && fs.existsSync(process.env.JS2BIN_OVERLAY_BINARY)) {
      resolvedBinary = process.env.JS2BIN_OVERLAY_BINARY;
    } else {
      // No overlay-enabled cached binary available — skip binary tests gracefully.
      // Tier 2 tests require a binary built with --ci --enable-overlay.
      skipBinaryTests = true;
    }
  });

  after(() => {
    if (setupDir) fs.rmSync(setupDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (skipBinaryTests) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-binary-test-'));

    // Copy binary into tmpDir so overlay/ dirs are relative to it
    const binName = path.basename(resolvedBinary);
    binPath = path.join(tmpDir, binName);
    fs.copyFileSync(resolvedBinary, binPath);
    fs.chmodSync(binPath, 0o755);
    // Re-sign after copy on macOS
    if (process.platform === 'darwin') {
      const { execFileSync } = require('child_process');
      try { execFileSync('codesign', ['--force', '--sign', '-', binPath]); } catch {}
    }
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: build an overlay bundle from source code and place it in a directory
  async function buildOverlayBundle(appCode, outputDir) {
    const appFile = createApp(tmpDir, `overlay-app-${Date.now()}.js`, appCode);
    const keyFile = path.join(tmpDir, 'signing.key');
    fs.writeFileSync(keyFile, keypair.privateKey);

    const result = await runCli([
      '--overlay',
      `--app=${appFile}`,
      `--signing-key=${keyFile}`,
      `--output=${outputDir}`,
    ]);
    assert.equal(result.code, 0, `Overlay bundle build failed: ${result.stderr}`);
    return outputDir;
  }

  it('should run embedded app when no overlay bundle is present', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const result = await runBinary(binPath);
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('embedded-ok'), `Expected "embedded-ok", got: ${result.stdout}`);
  });

  it('should load overlay bundle that overrides embedded app', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const overlayCurrentDir = path.join(tmpDir, 'overlay', 'current');
    await buildOverlayBundle('console.log("v2-ok");', overlayCurrentDir);

    const result = await runBinary(binPath);
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('v2-ok'), `Expected overlay output "v2-ok", got: ${result.stdout}`);
  });

  it('should load overlay bundle via JS2BIN_OVERLAY_DIR env var', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const customOverlayDir = path.join(tmpDir, 'custom-overlay-location');
    await buildOverlayBundle('console.log("env-var-ok");', customOverlayDir);

    const result = await runBinary(binPath, { env: { JS2BIN_OVERLAY_DIR: customOverlayDir } });
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('env-var-ok'), `Expected overlay output "env-var-ok", got: ${result.stdout}`);
  });

  it('should fall back to embedded app when overlay signature is tampered', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const overlayCurrentDir = path.join(tmpDir, 'overlay', 'current');
    await buildOverlayBundle('console.log("tampered");', overlayCurrentDir);

    // Corrupt the signature
    const sigPath = path.join(overlayCurrentDir, 'bundle.js.sig');
    const sig = fs.readFileSync(sigPath);
    sig[0] ^= 0xff;
    fs.writeFileSync(sigPath, sig);

    const result = await runBinary(binPath);
    // Should NOT contain the tampered overlay output
    assert.ok(!result.stdout.includes('tampered'), 'Binary should not have loaded tampered overlay bundle');
    // Stderr should mention signature verification failure
    assert.ok(result.stderr.includes('signature verification failed'), `Expected signature error in stderr, got: ${result.stderr}`);
  });

  it('should reject overlay bundle signed by a different key', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const overlayCurrentDir = path.join(tmpDir, 'overlay', 'current');
    const rogue = generateKeypair();
    const rogueKeyFile = path.join(tmpDir, 'rogue.key');
    fs.writeFileSync(rogueKeyFile, rogue.privateKey);
    const appFile = createApp(tmpDir, 'rogue-app.js', 'console.log("rogue-ok");');
    await runCli([
      '--overlay',
      `--app=${appFile}`,
      `--signing-key=${rogueKeyFile}`,
      `--output=${overlayCurrentDir}`,
    ]);

    const result = await runBinary(binPath);
    assert.ok(!result.stdout.includes('rogue-ok'), 'Binary should not have loaded rogue-signed bundle');
    assert.ok(result.stderr.includes('signature verification failed'), `Expected signature error in stderr, got: ${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// CLI validation: --signing-public-key lives on --build, not --ci
// ---------------------------------------------------------------------------

describe('Overlay Integration: CLI validation', () => {
  let tmpDir;
  let keyFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-cli-'));
    const kp = generateKeypair();
    keyFile = path.join(tmpDir, 'signing.pub');
    fs.writeFileSync(keyFile, kp.publicKey);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should reject --signing-public-key on --ci', async () => {
    const result = await runCli([
      '--ci',
      `--node=${DEFAULT_NODE_VERSION}`,
      '--size=2MB',
      '--enable-overlay',
      `--signing-public-key=${keyFile}`,
    ]);
    assert.notEqual(result.code, 0);
    assert.ok(
      /only supported with --build/.test(result.stdout + result.stderr),
      `Expected CLI error mentioning --build, got: ${result.stdout}${result.stderr}`
    );
  });

  it('should reject --build --enable-overlay without --signing-public-key', async () => {
    const appFile = createApp(tmpDir, 'app.js', 'console.log("x");');
    const result = await runCli([
      '--build',
      `--node=${DEFAULT_NODE_VERSION}`,
      `--app=${appFile}`,
      '--enable-overlay',
    ]);
    assert.notEqual(result.code, 0);
    assert.ok(
      /requires --signing-public-key/.test(result.stdout + result.stderr),
      `Expected CLI error about missing key, got: ${result.stdout}${result.stderr}`
    );
  });

  it('should reject an RSA private key at --overlay time', async () => {
    const rsa = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const badKeyFile = path.join(tmpDir, 'rsa.key');
    fs.writeFileSync(badKeyFile, rsa.privateKey);
    const appFile = createApp(tmpDir, 'app.js', 'console.log("x");');
    const result = await runCli([
      '--overlay',
      `--app=${appFile}`,
      `--signing-key=${badKeyFile}`,
      `--output=${path.join(tmpDir, 'out')}`,
    ]);
    assert.notEqual(result.code, 0);
    assert.ok(
      /ECDSA P-256/.test(result.stdout + result.stderr),
      `Expected P-256 error, got: ${result.stdout}${result.stderr}`
    );
  });

  it('should reject a P-384 public key at --build time', async () => {
    const p384 = crypto.generateKeyPairSync('ec', {
      namedCurve: 'secp384r1',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const badKeyFile = path.join(tmpDir, 'p384.pub');
    fs.writeFileSync(badKeyFile, p384.publicKey);
    const appFile = createApp(tmpDir, 'app.js', 'console.log("x");');
    const result = await runCli([
      '--build',
      `--node=${DEFAULT_NODE_VERSION}`,
      `--app=${appFile}`,
      '--enable-overlay',
      `--signing-public-key=${badKeyFile}`,
      `--name=${path.join(tmpDir, 'bad-build')}`,
    ]);
    assert.notEqual(result.code, 0);
    assert.ok(
      /ECDSA P-256/.test(result.stdout + result.stderr),
      `Expected P-256 error, got: ${result.stdout}${result.stderr}`
    );
  });
});
