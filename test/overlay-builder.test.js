const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const { OverlayBuilder } = require('../src/OverlayBuilder');
const { compatHeader, parseSigFile } = require('../src/_js2bin_sig_format');

function generateKeypair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

describe('OverlayBuilder', () => {
  let tmpDir;
  let keypair;
  let appFile;
  let keyFile;

  const appContent = 'console.log("hello from overlay");';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-builder-test-'));
    keypair = generateKeypair();

    appFile = path.join(tmpDir, 'app.js');
    fs.writeFileSync(appFile, appContent);

    keyFile = path.join(tmpDir, 'signing.key');
    fs.writeFileSync(keyFile, keypair.privateKey);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('compressApp', () => {
    it('should produce base64-encoded brotli-compressed content', () => {
      const encoded = OverlayBuilder.compressApp(appFile);
      // Should be valid base64
      const buf = Buffer.from(encoded, 'base64');
      assert.ok(buf.length > 0);
      // Should decompress back to the original content
      const decompressed = zlib.brotliDecompressSync(buf).toString();
      assert.equal(decompressed, appContent);
    });
  });

  describe('sign', () => {
    it('should produce a valid ECDSA signature', () => {
      const data = Buffer.from('test data');
      const sig = OverlayBuilder.sign(data, keypair.privateKey);
      assert.ok(Buffer.isBuffer(sig));
      assert.ok(sig.length > 0);
      const verify = crypto.createVerify('SHA256');
      verify.update(data);
      verify.end();
      assert.ok(verify.verify({ key: keypair.publicKey, dsaEncoding: 'der' }, sig));
    });
  });

  describe('build', () => {
    it('should produce both artifacts', () => {
      const outputDir = path.join(tmpDir, 'out');
      const builder = new OverlayBuilder({
        app: appFile,
        signingKey: keyFile,
        compatString: 'goat-v1',
        output: outputDir,
      });

      const result = builder.build();

      assert.ok(fs.existsSync(result.bundlePath));
      assert.ok(fs.existsSync(result.sigPath));
    });

    it('should produce a bundle that decompresses to the original JS', () => {
      const outputDir = path.join(tmpDir, 'out');
      const builder = new OverlayBuilder({
        app: appFile,
        signingKey: keyFile,
        compatString: 'goat-v1',
        output: outputDir,
      });

      builder.build();

      const bundleContent = fs.readFileSync(path.join(outputDir, 'bundle.js'), 'utf8');
      const decompressed = zlib.brotliDecompressSync(Buffer.from(bundleContent, 'base64')).toString();
      assert.equal(decompressed, appContent);
    });

    it('should produce a valid signature verifiable with the public key', () => {
      const outputDir = path.join(tmpDir, 'out');
      const builder = new OverlayBuilder({
        app: appFile,
        signingKey: keyFile,
        compatString: 'goat-v1',
        output: outputDir,
      });

      builder.build();

      const bundleData = fs.readFileSync(path.join(outputDir, 'bundle.js'));
      const sigData = fs.readFileSync(path.join(outputDir, 'bundle.js.sig'));
      const header = Buffer.concat([Buffer.from('J2BCOMPAT1'), Buffer.from([0x00, 0x07]), Buffer.from('goat-v1')]);
      assert.ok(sigData.subarray(0, header.length).equals(header));
      const verify = crypto.createVerify('SHA256');
      verify.update(Buffer.concat([header, bundleData]));
      verify.end();
      assert.ok(verify.verify({ key: keypair.publicKey, dsaEncoding: 'der' }, sigData.subarray(header.length)));
    });

    it('should produce a bundle that decompresses to the original JS via the full artifact set', () => {
      const outputDir = path.join(tmpDir, 'out');
      const builder = new OverlayBuilder({
        app: appFile,
        signingKey: keyFile,
        compatString: 'goat-v1',
        output: outputDir,
      });

      builder.build();

      // Verify signature
      const bundleData = fs.readFileSync(path.join(outputDir, 'bundle.js'));
      const sigData = fs.readFileSync(path.join(outputDir, 'bundle.js.sig'));
      const header = Buffer.concat([Buffer.from('J2BCOMPAT1'), Buffer.from([0x00, 0x07]), Buffer.from('goat-v1')]);
      assert.ok(sigData.subarray(0, header.length).equals(header));
      const verify = crypto.createVerify('SHA256');
      verify.update(Buffer.concat([header, bundleData]));
      verify.end();
      assert.ok(verify.verify({ key: keypair.publicKey, dsaEncoding: 'der' }, sigData.subarray(header.length)));

      // Verify content round-trips
      const decompressed = zlib.brotliDecompressSync(Buffer.from(bundleData.toString(), 'base64')).toString();
      assert.equal(decompressed, appContent);
    });

    it('should create output directory if it does not exist', () => {
      const outputDir = path.join(tmpDir, 'nested', 'deep', 'out');
      const builder = new OverlayBuilder({
        app: appFile,
        signingKey: keyFile,
        compatString: 'goat-v1',
        output: outputDir,
      });

      builder.build();
      assert.ok(fs.existsSync(path.join(outputDir, 'bundle.js')));
    });
  });

  describe('parseSigFile', () => {
    it('round-trips compatHeader', () => {
      const der = Buffer.from([0x30, 0x01, 0x02]);
      const sig = parseSigFile(Buffer.concat([compatHeader('goat-v1'), der]));
      assert.equal(sig.compatString, 'goat-v1');
      assert.ok(sig.header.equals(compatHeader('goat-v1')));
      assert.ok(sig.signature.equals(der));
    });

    it('rejects legacy raw-DER and short input', () => {
      assert.equal(parseSigFile(Buffer.from([0x30, 0x45, 0x02])), 'unsupported signature format');
      assert.equal(parseSigFile(Buffer.from('J2BCOMPAT1')), 'unsupported signature format');
    });

    it('rejects compat length beyond file or over 64', () => {
      const truncated = compatHeader('goat-v1').subarray(0, 14);
      assert.equal(parseSigFile(truncated), 'invalid signature compat string length');
      const oversized = Buffer.concat([compatHeader('x'.repeat(65)), Buffer.alloc(70)]);
      assert.equal(parseSigFile(oversized), 'invalid signature compat string length');
    });
  });
});
