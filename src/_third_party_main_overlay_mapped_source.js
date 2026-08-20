
// Overlay + mapped-source bootstrap. Selected at build time when BOTH --enable-overlay and
// JS2BIN_MAPPED_SOURCE=1 are given.
//
// The two features are orthogonal and this file is their composition:
//   * overlay decides WHICH source runs -- the payload embedded in the binary, or a signed (and
//     optionally encrypted) bundle staged on disk next to the executable.
//   * mapped-source decides HOW that source reaches V8 -- decompressed to a cache file once, mapped
//     read-only, and compiled from an external one-byte string so the bytes are file-backed and shared
//     between processes instead of costing ~26 MB of private heap in each.
//
// Without this file the two are mutually exclusive: the bootstrap selection installs exactly one
// _third_party_main.js, so JS2BIN_MAPPED_SOURCE=1 silently displaced the overlay bootstrap and produced
// a binary that was not overlay-capable at all, even though --enable-overlay was passed and the signing
// and encryption keys were embedded.
//
// The overlay logic below is deliberately identical to _third_party_main_overlay.js, including its
// stderr messages, so that overlay behaviour is unchanged by adding mapping. If you fix a bug in one,
// fix it in the other. (Bootstraps cannot share code: exactly one file is installed as the
// _third_party_main builtin, and there is no module for them to require.)
//
// Two rules here are load-bearing and must not be "tidied up":
//   1. Never slice the mapped string. A sliced string over an external parent can be flattened by V8
//      when compiled, which silently reinstates the private copy this exists to remove.
//   2. Never concatenate it. The cluster preamble runs below as real code instead of being textually
//      prepended to the source, for the same reason.
//
// Not yet suitable for production: the mapped bytes are still not verified against a digest embedded in
// the signed binary. See the notes at the end of _third_party_main_mapped_source.js.

const Module = require('module');
const { brotliDecompressSync } = require('zlib');
const { join, dirname } = require('path');
const fs = require('fs');
const os = require('os');
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

// --- Mapped source ---

const cacheDir = process.env.JS2BIN_SRC_CACHE_DIR || os.tmpdir();

// Cache identity MUST come from the payload itself, not from its length. Under overlay the compiled
// source can be either the embedded payload or an overlay bundle, and two different payloads of equal
// length would collide on a length-keyed name -- a node would then map and execute the wrong source.
// Hashing the *compressed* payload keeps this cheap and, crucially, computable without decompressing,
// so an existing cache file still short-circuits the decompress entirely.
// (This is not the integrity check. That has to be a digest embedded in the signed binary and verified
// against the mapped bytes; see the remaining-work notes in _third_party_main_mapped_source.js.)
function cachePathFor(payload) {
  const digest = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return join(cacheDir, `js2bin-src-${appName.trim()}-${digest}.js`);
}

// Decompress to the cache file if it is not already there, and return the path. Throws only on a
// payload problem (bad base64, bad brotli) or a filesystem problem -- deliberately NOT merged with the
// mapping step below, because the two failures need different recovery.
function materialise(payload) {
  const cachePath = cachePathFor(payload);
  if (!fs.existsSync(cachePath)) {
    const decoded = brotliDecompressSync(Buffer.from(payload, 'base64'),
      { chunkSize: 128 * 1024 * 1024 });
    // Write-to-temp-then-rename keeps a concurrent mapper from ever seeing a partial file.
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, decoded);
    try {
      fs.renameSync(tmp, cachePath);
    } catch (err) {
      // Another process won the race; its file is equivalent.
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  return cachePath;
}

// Which payload we actually compile. Only a *decompression* failure of an overlay bundle demotes us to
// the embedded payload -- a mapping failure must not, or a perfectly good overlay would be discarded
// because of an unrelated filesystem or binding problem.
let compiledSource = activeSource;
let cachePath = null;
try {
  cachePath = materialise(activeSource);
} catch (err) {
  if (activeSource !== embeddedSource) {
    process.stderr.write(`[js2bin] overlay: failed to decompress overlay bundle: ${err.message}. Falling back to embedded JS.\n`);
    compiledSource = embeddedSource;
    try {
      cachePath = materialise(embeddedSource);
    } catch (err2) {
      process._rawDebug(`js2bin: falling back to in-heap source (${err2 && err2.message})`);
      cachePath = null;
    }
  } else {
    process._rawDebug(`js2bin: falling back to in-heap source (${err && err.message})`);
    cachePath = null;
  }
}

let external = null;
if (cachePath !== null) {
  try {
    external = internalBinding('js2bin').mapFileAsExternalString(cachePath);
  } catch (err) {
    // Binding missing or mapping refused. Keep whatever source we resolved above and take the
    // historical in-heap path rather than refusing to boot.
    process._rawDebug(`js2bin: falling back to in-heap source (${err && err.message})`);
    external = null;
  }
}

// here we turn what looks like an internal module to an non-internal one
// that way the module is loaded exactly as it would by: node app_main.js
const mod = new Module(process.execPath, null);
mod.id = '.'; // main module
mod.filename = filename; // dirname of this is used by require
process.mainModule = mod; // main module

if (external !== null) {
  // Cluster setup, previously textually prepended to the source. Runs before the app's module scope,
  // which is the same ordering as the original bootstrap.
  const cluster = require('cluster');
  if (cluster.worker) {
    // NOOP - cluster worker already initialized, likely Node 12.x+
  } else if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
    cluster._setupWorker();
    delete process.env.NODE_UNIQUE_ID;
  } else {
    process.argv.splice(1, 0, filename);
  }
  mod._compile(external, filename);
} else {
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

${brotliDecompressSync(Buffer.from(compiledSource, 'base64'), { chunkSize: 128 * 1024 * 1024 }).toString()}

`, filename);
}
