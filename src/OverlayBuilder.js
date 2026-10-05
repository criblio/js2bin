const { brotliCompressSync } = require('zlib');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const { join } = require('path');
const { log, assertSupportedKey } = require('./util');
const { compatHeader } = require('./_js2bin_sig_format');

class OverlayBuilder {
  /**
   * @param {object} opts
   * @param {string} opts.app - Path to the JS app file to bundle
   * @param {string} opts.signingKey - Path to ECDSA P-256 private key PEM file
   * @param {string} opts.compatString - Must equal the binary's --compat-string for the overlay to load
   * @param {string} [opts.output] - Output directory (default: ./overlay-bundle/)
   */
  constructor(opts) {
    this.app = opts.app;
    this.signingKey = opts.signingKey;
    this.compatString = opts.compatString;
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
   * Build the Overlay bundle artifacts: bundle.js, bundle.js.sig.
   * @returns {{ bundlePath: string, sigPath: string }}
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
    const header = compatHeader(this.compatString);
    const signature = Buffer.concat([header, OverlayBuilder.sign(Buffer.concat([header, bundleBuffer]), privateKeyPem)]);

    // Write artifacts
    fs.mkdirSync(this.output, { recursive: true });

    const bundlePath = join(this.output, 'bundle.js');
    const sigPath = join(this.output, 'bundle.js.sig');

    fs.writeFileSync(bundlePath, bundleBuffer);
    fs.writeFileSync(sigPath, signature);

    log(`Overlay bundle written to ${this.output}/`);
    log(`  bundle.js      (${bundleBuffer.length} bytes)`);
    log(`  bundle.js.sig  (${signature.length} bytes)`);

    return { bundlePath, sigPath };
  }
}

module.exports = { OverlayBuilder };
