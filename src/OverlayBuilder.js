const { brotliCompressSync } = require('zlib');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const { join } = require('path');
const { log, assertSupportedKey } = require('./util');

class OverlayBuilder {
  /**
   * @param {object} opts
   * @param {string} opts.app - Path to the JS app file to bundle
   * @param {string} opts.signingKey - Path to ECDSA P-256 private key PEM file
   * @param {string} [opts.output] - Output directory (default: ./overlay-bundle/)
   */
  constructor(opts) {
    this.app = opts.app;
    this.signingKey = opts.signingKey;
    this.output = opts.output || './overlay-bundle';
  }

  /**
   * Compress and base64-encode a JS file, matching the format the overlay loader expects.
   * This is the same encoding used by NodeJsBuilder.getAppContentToBundle() for parts[1].
   * @param {string} appPath
   * @returns {string} base64-encoded brotli-compressed content
   */
  static compressApp(appPath) {
    const raw = fs.readFileSync(appPath);
    const compressed = brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    return compressed.toString('base64');
  }

  /**
   * Sign data with an ECDSA P-256 private key.
   * @param {Buffer} data
   * @param {string} privateKeyPem
   * @returns {Buffer} DER-encoded signature
   */
  static sign(data, privateKeyPem) {
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    sign.end();
    return sign.sign({ key: privateKeyPem, dsaEncoding: 'der' });
  }

  /**
   * Build the Overlay bundle artifacts: bundle.js, bundle.js.sig, bundle.js.sha256.
   * @returns {{ bundlePath: string, sigPath: string, sha256Path: string }}
   */
  build() {
    // Compress and encode the app
    log(`compressing ${this.app} ...`);
    const bundleContent = OverlayBuilder.compressApp(this.app);
    const bundleBuffer = Buffer.from(bundleContent, 'utf8');

    // Read the private key
    const privateKeyPem = fs.readFileSync(this.signingKey, 'utf8');
    assertSupportedKey(privateKeyPem, { type: 'private', source: this.signingKey });

    // Sign the bundle
    log('signing bundle ...');
    const signature = OverlayBuilder.sign(bundleBuffer, privateKeyPem);

    // Compute SHA-256 checksum
    const checksum = crypto.createHash('sha256').update(bundleBuffer).digest('hex');

    // Write artifacts
    fs.mkdirSync(this.output, { recursive: true });

    const bundlePath = join(this.output, 'bundle.js');
    const sigPath = join(this.output, 'bundle.js.sig');
    const sha256Path = join(this.output, 'bundle.js.sha256');

    fs.writeFileSync(bundlePath, bundleBuffer);
    fs.writeFileSync(sigPath, signature);
    fs.writeFileSync(sha256Path, checksum);

    log(`Overlay bundle written to ${this.output}/`);
    log(`  bundle.js         (${bundleBuffer.length} bytes)`);
    log(`  bundle.js.sig     (${signature.length} bytes)`);
    log(`  bundle.js.sha256  ${checksum}`);

    return { bundlePath, sigPath, sha256Path };
  }
}

module.exports = { OverlayBuilder };
