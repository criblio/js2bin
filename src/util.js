const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { join, dirname } = require('path');
const { promisify } = require('util');
const fs = require('fs');
const { URL } = require('url');
const { pipeline } = require('stream');

const mkdirAsync = promisify(fs.mkdir);
const copyFileAsync = promisify(fs.copyFile);
const renameAsync = promisify(fs.rename);
const statAsync = promisify(fs.lstat);
const unlinkAsync = promisify(fs.unlink);
const readdirAsync = promisify(fs.readdir);
const rmdirAsync = promisify(fs.rmdir);

function log() {
  console.log(`${new Date().toISOString()} -`, ...arguments);
}

function mkdirp(path) {
  return mkdirAsync(path).catch(err => {
    if (err.code === 'ENOENT') {
      return mkdirp(dirname(path)).then(() => mkdirp(path));
    } else {
      const statRes = fs.statSync(path);
      if (!statRes.isDirectory()) {
        throw err;
      }
    }
  });
}

function rmrf(dir, retries) {
  return statAsync(dir)
    .then(statRes => {
      if (!statRes.isDirectory()) {
        return unlinkAsync(dir).catch(() => rmdirAsync(dir)); // windows, maybe a symlink to a dir?
      }
      console.log(`removing dir=${dir}, retries=${retries}`);
      return readdirAsync(dir)
        .then(entries => {
          let p = Promise.resolve();
          entries.forEach(e => { p = p.then(() => rmrf(join(dir, e), retries)); });
          return p.then(() => rmdirAsync(dir));
        });
    })
    .catch(err => {
      if (err.code !== 'ENOENT') { // do not throw if what we're trying to remove doesn't exist
        if (retries > 0) {
          return new Promise((resolve, reject) => {
            setTimeout(() => rmrf(dir, retries - 1).then(resolve, reject), 1000);
          });
        } else {
          return readdirAsync(dir)
            .then(console.log)
            .then(() => { throw err; });
        }
      }
    });
}

function runCommand(command, args = [], cwd = undefined, env = undefined, verbose = true) {
  return new Promise((resolve, reject) => {
    log(`running: ${command} ${args.join(' ')} ...`);
    spawn(command, args, {
      cwd,
      env: env || { ...process.env },
      stdio: verbose ? 'inherit' : 'ignore'
    })
      .once('error', reject)
      .once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`${command} ${args.join(' ')} exited with code: ${code}`));
        }
        resolve();
      });
  });
}

async function patchFile(baseDir, patchFile) {
  if (!fs.existsSync(patchFile)) return; // noop
  await new Promise((resolve, reject) => {
    const proc = spawn(
      'patch',
      [
        '-uN', // Unified patch format
        '-p1' // Adjust the file path by stripping leading directories (a/ and b/)
      ],
      {
        cwd: baseDir, // Apply the patches in the provided directory
        stdio: [
          null,
          'inherit',
          'inherit'
        ]
      })
      .once('exit', code => {
        if (code !== 0) return reject(new Error(`failed to patch in baseDir=${baseDir} patch=${patchFile} code=${code}`));
        return resolve();
      })
      .once('error', reject);
    pipeline(
      fs.createReadStream(patchFile),
      proc.stdin,
      err => err ? reject(err) : undefined
    );
  });
}

function fetch(url, headers) {
  return new Promise((resolve, reject) => {
    if (!url || url.length === 0) {
      throw new Error(`Invalid Argument - url [${url}] is undefined or empty!`);
    }
    let result = '';
    const _url = new URL(url);
    const options = {
      hostname: _url.hostname,
      port: _url.port,
      path: `${_url.pathname}${_url.search}`,
      method: 'GET',
      headers: {
        ...headers,
        'User-Agent': 'js2bin'
      }
    };
    const proto = url.startsWith('https://') ? https : http;
    const req = proto.request(options, (res) => {
      console.log(res.statusCode);
      if (res.statusCode > 300 && res.statusCode < 400 && res.headers.location) {
        const redirUrl = new URL(res.headers.location);
        if (!redirUrl.hostname) { // partial URL
          const origUrl = new URL(url);
          redirUrl.hostname = origUrl.hostname;
          redirUrl.protocol = origUrl.protocol;
        }
        log('following redirect ...');
        return fetch(redirUrl.toString(), headers).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.on('data', d => { result += d; });
        res.on('end', () => reject(new Error(`Non-OK response, statusCode=${res.statusCode}, url=${url}, response=${result}`)));
        return;
      }
      res.on('error', reject);
      res.on('data', d => { result += d; });
      res.on('end', () => resolve(result));
    });
    req.end();
  });
}

function download(url, toFile, headers) {
  return new Promise((resolve, reject) => {
    if (!url || url.length === 0) {
      throw new Error(`Invalid Argument - url [${url}] is undefined or empty!`);
    }
    if (!toFile || toFile.length === 0) {
      throw new Error(`Invalid Argument - file: [${toFile}] is undefined or empty!`);
    }
    log(`downloading ${url} to ${toFile} ...`);
    const _url = new URL(url);
    const options = {
      hostname: _url.hostname,
      port: _url.port,
      path: `${_url.pathname}${_url.search}`,
      method: 'GET',
      headers: {
        ...headers,
        'User-Agent': 'js2bin'
      }
    };
    const proto = url.startsWith('https://') ? https : http;
    const req = proto.request(options, (res) => {
      if (res.statusCode > 300 && res.statusCode < 400 && res.headers.location) {
        const redirUrl = new URL(res.headers.location);
        if (!redirUrl.hostname) { // partial URL
          const origUrl = new URL(url);
          redirUrl.hostname = origUrl.hostname;
          redirUrl.protocol = origUrl.protocol;
        }
        log('following redirect ...');
        return download(redirUrl.toString(), toFile, headers).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`Non-OK response, statusCode=${res.statusCode}, url=${url}`));
      }
      res.on('error', reject);
      mkdirp(dirname(toFile)).then(() => {
        const outFile = fs.createWriteStream(toFile);
        outFile.on('finish', () => resolve(toFile));
        res.pipe(outFile);
      });
    });
    req.end();
  })
    .catch(err => {
      try { fs.unlinkSync(toFile); } catch (ignore) {
      // fail through
      }
      throw err;
    });
}

// Committed public key used to verify release binaries. Trust anchor ships in
// the package (git-audited), so verification never depends on a key fetched
// from the same place as the artifact.
const DEFAULT_KEY_PATH = join(__dirname, '..', 'keys', 'release-signing.asc');

// Verify a downloaded binary against a detached GPG signature and a committed
// public key. Explicit and mandatory: the caller opts in (via --require-signature)
// and this fails hard on ANY problem (no gpg, no signature, bad key, bad sig) -
// there is no silent skip.
//
// opts: { binaryUrl, sigUrl?, keyPath?, headers? }
//   sigUrl  - defaults to `${binaryUrl}.asc`
//   keyPath - defaults to the committed DEFAULT_KEY_PATH
function verifyGpgSignature(file, opts = {}) {
  const { binaryUrl, headers } = opts;
  const sigUrl = opts.sigUrl || `${binaryUrl}.asc`;
  const keyPath = opts.keyPath || DEFAULT_KEY_PATH;

  if (!fs.existsSync(keyPath)) {
    return Promise.reject(sigError(`gpg public key not found at ${keyPath}`));
  }

  const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'js2bin-gpg-'));
  const sigFile = join(tmpDir, 'sig.asc');
  const keyringFile = join(tmpDir, 'keyring.gpg');
  const cleanup = () => { try { rmrf(tmpDir, 3); } catch (ignore) { /* best effort */ } };

  // Verify with `gpgv` against a keyring built from the committed public key,
  // rather than `gpg --import` + `gpg --verify`. gpg insists on talking to
  // gpg-agent even for public-key operations and exits nonzero when the agent
  // is broken (e.g. git-bash gpg on Windows CI). gpgv is the standalone verify
  // tool: no agent, no keyring management. `gpg --dearmor` is a pure ASCII->
  // binary transform (also no agent) to turn the committed .asc key into the
  // binary keyring gpgv wants.
  //
  // gpgv treats a --keyring path with NO slash as a name inside ~/.gnupg. On
  // Windows the paths are backslash-separated (C:\...), which the MSYS gpgv
  // sees as slash-less and mis-resolves. Convert to forward slashes (valid on
  // Windows, and gpgv then uses the path literally).
  const fwd = (p) => p.replace(/\\/g, '/');
  return download(sigUrl, sigFile, headers)
    .catch(err => { throw sigError(`could not fetch signature ${sigUrl}: ${err.message}`); })
    .then(() => runCommand('gpg', ['--batch', '--no-tty', '--yes', '--dearmor', '-o', keyringFile, keyPath], undefined, undefined, true)
      .catch(() => { throw sigError(`failed to prepare public key ${keyPath}`); }))
    .then(() => runCommand('gpgv', ['--keyring', fwd(keyringFile), fwd(sigFile), fwd(file)], undefined, undefined, true)
      .catch(() => { throw sigError(`GPG signature verification failed for ${file}`); }))
    .then(() => { log(`verified GPG signature for ${file}`); cleanup(); })
    .catch(err => { cleanup(); throw err; });
}

function sigError(message) {
  const e = new Error(message);
  e.code = 'ERR_GPG_VERIFY';
  return e;
}

function upload(url, file, headers) {
  const fileStream = fs.createReadStream(file);
  return new Promise((resolve, reject) => {
    log(`uploading file=${file}, url=${url} ...`);
    if (!url || url.length === 0) {
      throw new Error(`Invalid Argument - url [${url}] is undefined or empty!`);
    }
    const fstat = fs.statSync(file);
    if (!fstat.isFile()) {
      throw new Error(`Invalid Argument - file [${file}] must be a file`);
    }
    const _url = new URL(url);
    const options = {
      hostname: _url.hostname,
      port: _url.port,
      path: `${_url.pathname}${_url.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'User-Agent': 'js2bin',
        'Content-Type': 'application/octet-stream',
        'Content-Length': fstat.size
      }
    };
    const proto = url.startsWith('https://') ? https : http;
    const req = proto.request(options, (res) => {
      res.on('data', data => log(data.toString()));
      res.on('end', () => resolve());
    });

    req.on('error', reject);
    // Write data to request body
    fileStream.pipe(req);
  })
    .then(
      () => fileStream.close(),
      err => {
        fileStream.close();
        throw err;
      }
    );
}

function getAssetIdByName(url, assetName, headers) {
  return new Promise((resolve, reject) => {
    log(`getting asset ID for name=${assetName} from url=${url} ...`);
    if (!url || url.length === 0) {
      throw new Error(`Invalid Argument - url [${url}] is undefined or empty!`);
    }
    if (!assetName || assetName.length === 0) {
      throw new Error(`Invalid Argument - assetName [${assetName}] is undefined or empty!`);
    }
    const _url = new URL(url);
    const options = {
      hostname: _url.hostname,
      port: _url.port,
      path: `${_url.pathname}${_url.search}`,
      method: 'GET',
      headers: {
        ...headers,
        'User-Agent': 'js2bin'
      }
    };
    const proto = url.startsWith('https://') ? https : http;
    const req = proto.request(options, (res) => {
      if (res.statusCode >= 400) {
        return reject(new Error(`Non-OK response, statusCode=${res.statusCode}, url=${url}`));
        // return resolve(null);
      }
      res.on('error', reject);
      let result = '';
      res.on('data', data => { result += data; });
      res.on('end', () => {
        const response = JSON.parse(result);
        const asset = response.assets.find(a => a.name === assetName);
        if (!asset) {
          return resolve(null);
        }
        resolve(asset.id);
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function deleteArtifact(url, headers) {
  return new Promise((resolve, reject) => {
    log(`deleting artifact from url=${url} ...`);
    if (!url || url.length === 0) {
      throw new Error(`Invalid Argument - url [${url}] is undefined or empty!`);
    }
    const _url = new URL(url);
    const options = {
      hostname: _url.hostname,
      port: _url.port,
      path: `${_url.pathname}${_url.search}`,
      method: 'DELETE',
      headers: {
        ...headers,
        'User-Agent': 'js2bin'
      }
    };
    const proto = url.startsWith('https://') ? https : http;
    const req = proto.request(options, (res) => {
      if (res.statusCode >= 400) {
        return reject(new Error(`Non-OK response, statusCode=${res.statusCode}, url=${url}`));
      }
      res.on('data', data => log(data.toString()));
      res.on('end', () => resolve());
      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

// Allowlist of key algorithms accepted for overlay signing. To add a new
// supported type, append a spec here — each field is matched against the
// parsed key; `undefined` fields are wildcards (e.g. an RSA entry would
// omit `namedCurve`). Unmatched keys are rejected at --overlay / --build
// time so operators never get a silently-weak key into a signed binary.
const SUPPORTED_SIGNING_KEYS = [
  { asymmetricKeyType: 'ec', namedCurve: 'prime256v1', label: 'ECDSA P-256' }
];

function describeKey(key) {
  const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
  return curve ? `${key.asymmetricKeyType}/${curve}` : String(key.asymmetricKeyType);
}

function matchesKeySpec(key, spec) {
  if (spec.asymmetricKeyType !== undefined && spec.asymmetricKeyType !== key.asymmetricKeyType) return false;
  const keyCurve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
  if (spec.namedCurve !== undefined && spec.namedCurve !== keyCurve) return false;
  return true;
}

function assertSupportedKey(pem, { type, source }) {
  const create = type === 'private' ? crypto.createPrivateKey : crypto.createPublicKey;
  let key;
  try {
    key = create(pem);
  } catch (err) {
    const parseErr = new Error(`Failed to parse ${type} signing key from ${source}: ${err.message}`);
    parseErr.code = 'ERR_KEY_PARSE';
    throw parseErr;
  }
  if (!SUPPORTED_SIGNING_KEYS.some(spec => matchesKeySpec(key, spec))) {
    const allowed = SUPPORTED_SIGNING_KEYS.map(s => s.label).join(', ');
    const unsupportedErr = new Error(
      `Signing ${type} key from ${source} is not a supported algorithm ` +
      `(got ${describeKey(key)}). Supported: ${allowed}.`
    );
    unsupportedErr.code = 'ERR_UNSUPPORTED_KEY';
    throw unsupportedErr;
  }
}

module.exports = {
  log,
  download,
  upload,
  deleteArtifact,
  getAssetIdByName,
  fetch,
  runCommand,
  mkdirp,
  rmrf,
  copyFileAsync,
  renameAsync,
  patchFile,
  assertSupportedKey,
  verifyGpgSignature
};
