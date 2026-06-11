
const Module = require('module');
const { brotliDecompressSync } = require('zlib');
const { join, dirname } = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- Overlay Loader ---

// The signing public key lives in a dedicated native module whose backing file
// (lib/_js2bin_signing_key.js) starts out as a sentinel placeholder and is
// overwritten at --build time when the user passes --signing-public-key. The
// sentinel shape mirrors _js2bin_app_main so the same detection works: if the
// raw module content still starts with backtick+tilde, no key was embedded.
// Only ECDSA P-256 keys are accepted — matches OverlayBuilder's sign path.
function extractEmbeddedKey() {
  let raw;
  try {
    raw = process.binding('natives')._js2bin_signing_key;
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.startsWith('`~')) return null;
  const nullIdx = raw.indexOf('\0');
  const trimmed = (nullIdx > -1 ? raw.substr(0, nullIdx) : raw).trim();
  if (trimmed.length === 0) return null;
  try {
    const key = crypto.createPublicKey(trimmed);
    const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
    if (key.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
      process.stderr.write(`[js2bin] overlay: embedded signing key is not ECDSA P-256 (type='${key.asymmetricKeyType}', curve='${curve}'). Ignoring.\n`);
      return null;
    }
  } catch (err) {
    process.stderr.write(`[js2bin] overlay: embedded signing key failed to parse: ${err.message}. Ignoring.\n`);
    return null;
  }
  return trimmed;
}

const EMBEDDED_SIGNING_PUBLIC_KEY = extractEmbeddedKey();

function extractEmbeddedEncryptionKey() {
  let raw;
  try {
    raw = process.binding('natives')._js2bin_encryption_key;
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.startsWith('`~')) return null;
  const nullIdx = raw.indexOf('\0');
  const trimmed = (nullIdx > -1 ? raw.substr(0, nullIdx) : raw).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    process.stderr.write('[js2bin] overlay: embedded encryption key is not a valid 64-char hex string. Ignoring.\n');
    return null;
  }
  return trimmed;
}

const EMBEDDED_ENCRYPTION_KEY = extractEmbeddedEncryptionKey();

function decryptBundle(encData, hexKey) {
  const iv = encData.slice(0, 12);
  const authTag = encData.slice(encData.length - 16);
  const ciphertext = encData.slice(12, encData.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function verifySignature(data, signature, publicKeyPem) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();
    return verify.verify({ key: publicKeyPem, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}

function tryLoadOverlayBundle(execDir) {
  const overlayDir = process.env.JS2BIN_OVERLAY_DIR || join(execDir, 'overlay', 'current');

  const encBundlePath = join(overlayDir, 'bundle.js.enc');
  const plainBundlePath = join(overlayDir, 'bundle.js');
  const sigPath = join(overlayDir, 'bundle.js.sig');

  // Prefer encrypted bundle over plain bundle. Determine which path to use.
  const isEncrypted = fs.existsSync(encBundlePath);
  const bundlePath = isEncrypted ? encBundlePath : plainBundlePath;

  // Read the signature first — it's tiny (~70 bytes) — so a missing or empty
  // sig short-circuits before we touch the (potentially much larger) bundle.
  // Treats missing/empty files as non-existent, letting operators "disable"
  // an overlay by truncating either file without log noise.
  let sigData;
  try {
    sigData = fs.readFileSync(sigPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    process.stderr.write(`[js2bin] overlay: failed to read signature file: ${err.message}\n`);
    return null;
  }
  if (sigData.length === 0) return null;

  let bundleData;
  try {
    bundleData = fs.readFileSync(bundlePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    process.stderr.write(`[js2bin] overlay: failed to read bundle file: ${err.message}\n`);
    return null;
  }
  if (bundleData.length === 0) return null;

  // Decrypt if the bundle is encrypted.
  if (isEncrypted) {
    if (!EMBEDDED_ENCRYPTION_KEY) {
      process.stderr.write('[js2bin] overlay: bundle.js.enc found but no encryption key embedded — binary was not built with --encryption-key. Falling back to embedded JS.\n');
      return null;
    }
    try {
      bundleData = decryptBundle(bundleData, EMBEDDED_ENCRYPTION_KEY);
    } catch (err) {
      process.stderr.write(`[js2bin] overlay: failed to decrypt bundle.js.enc: ${err.message}. Falling back to embedded JS.\n`);
      return null;
    }
  }

  if (!EMBEDDED_SIGNING_PUBLIC_KEY) {
    process.stderr.write('[js2bin] overlay: no embedded signing key — binary was not built with --signing-public-key. Ignoring overlay bundle.\n');
    return null;
  }

  if (!verifySignature(bundleData, sigData, EMBEDDED_SIGNING_PUBLIC_KEY)) {
    process.stderr.write('[js2bin] overlay: signature verification failed — bundle is unsigned or tampered. Falling back to embedded JS.\n');
    return null;
  }

  process.stderr.write(`[js2bin] overlay: loaded valid bundle from ${overlayDir}\n`);
  return bundleData.toString('utf8');
}

// --- Main bootstrap ---

let source = process.binding('natives')._js2bin_app_main;
if (source.startsWith('`~')) {
  console.log(`js2bin binary with ${Math.floor(source.length / 1024 / 1024)}MB of placeholder content.
For more info see: js2bin --help`);
  process.exit(-1);
}

const nullIdx = source.indexOf('\0');
if (nullIdx > -1) {
  source = source.substr(0, nullIdx);
}

const parts = source.split('\n');
const appName = Buffer.from(parts[0], 'base64').toString();
const filename = join(dirname(process.execPath), `${appName.trim()}.js`);

const embeddedSource = parts[1];

// Try overlay bundle
let activeSource = embeddedSource;
try {
  const overlayBundle = tryLoadOverlayBundle(dirname(process.execPath));
  if (overlayBundle) {
    activeSource = overlayBundle;
  }
} catch (err) {
  process.stderr.write(`[js2bin] overlay: unexpected error during overlay load: ${err.message}. Falling back to embedded JS.\n`);
}

// here we turn what looks like an internal module to an non-internal one
// that way the module is loaded exactly as it would by: node app_main.js
const mod = new Module(process.execPath, null);
mod.id = '.'; // main module
mod.filename = filename; // dirname of this is used by require
process.mainModule = mod; // main module

function decompressActiveSource() {
  try {
    return brotliDecompressSync(Buffer.from(activeSource, 'base64'), { chunkSize: 128 * 1024 * 1024 }).toString();
  } catch (err) {
    if (activeSource !== embeddedSource) {
      process.stderr.write(`[js2bin] overlay: failed to decompress overlay bundle: ${err.message}. Falling back to embedded JS.\n`);
      return brotliDecompressSync(Buffer.from(embeddedSource, 'base64'), { chunkSize: 128 * 1024 * 1024 }).toString();
    }
    throw err;
  }
}

mod._compile(`

// initialize clustering
const cluster = require('cluster');
if (cluster.worker) {
   // NOOP - cluster worker already initialized, likely Node 12.x+
}else if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
   cluster._setupWorker()
   delete process.env.NODE_UNIQUE_ID
} else {
  process.argv.splice(1, 0, __filename); // don't mess with argv in clustering
}

${decompressActiveSource()}

`, filename);
