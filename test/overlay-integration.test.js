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

    // --build --enable-overlay requires --signing-public-key. The embedded key
    // is independent of the per-test bundle-signing key; tests rely on the
    // trusted-keys directory for bundle verification.
    const buildKeypair = generateKeypair();
    const buildKeyFile = path.join(setupDir, 'build.pub');
    fs.writeFileSync(buildKeyFile, buildKeypair.publicKey);

    const buildResult = await runCli([
      '--build',
      `--app=${embeddedApp}`,
      `--node=${DEFAULT_NODE_VERSION}`,
      '--enable-overlay',
      `--signing-public-key=${buildKeyFile}`,
      '--cache',
      `--name=${binName}`,
      `--platform=${PLATFORM}`,
      `--arch=${ARCH}`,
    ], { timeout: 60000 });

    const builtPath = `${binName}-${PLATFORM}-${ARCH}`;
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
    keypair = generateKeypair();

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

  // Helper: set up trusted-keys directory with the test public key
  function installTrustedKey() {
    const trustedKeysDir = path.join(tmpDir, 'overlay', 'trusted-keys');
    fs.mkdirSync(trustedKeysDir, { recursive: true });
    fs.writeFileSync(path.join(trustedKeysDir, 'test.pub'), keypair.publicKey);
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
    installTrustedKey();
    await buildOverlayBundle('console.log("v2-ok");', overlayCurrentDir);

    const result = await runBinary(binPath);
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('v2-ok'), `Expected overlay output "v2-ok", got: ${result.stdout}`);
  });

  it('should load overlay bundle via JS2BIN_OVERLAY_DIR env var', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const customOverlayDir = path.join(tmpDir, 'custom-overlay-location');
    installTrustedKey();
    await buildOverlayBundle('console.log("env-var-ok");', customOverlayDir);

    const result = await runBinary(binPath, { env: { JS2BIN_OVERLAY_DIR: customOverlayDir } });
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('env-var-ok'), `Expected overlay output "env-var-ok", got: ${result.stdout}`);
  });

  it('should fall back to embedded app when overlay signature is tampered', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const overlayCurrentDir = path.join(tmpDir, 'overlay', 'current');
    installTrustedKey();
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

  it('should verify overlay bundle using trusted-keys directory', async (ctx) => {
    if (skipBinaryTests) return ctx.skip('No overlay-enabled cached binary available');
    const overlayCurrentDir = path.join(tmpDir, 'overlay', 'current');
    installTrustedKey();
    await buildOverlayBundle('console.log("trusted-key-ok");', overlayCurrentDir);

    const result = await runBinary(binPath);
    assert.equal(result.code, 0, `Binary failed: ${result.stderr}`);
    assert.ok(result.stdout.includes('trusted-key-ok'), `Expected overlay output "trusted-key-ok", got: ${result.stdout}`);
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
});
