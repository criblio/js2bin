const http = require('http');
const https = require('https');
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
        if (code !== 0) return reject(new Error(`falied to patch file=${file} with patch=${patchFile} code=${code}`));
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

module.exports = {
  log,
  download,
  upload,
  fetch,
  runCommand,
  mkdirp,
  rmrf,
  copyFileAsync,
  renameAsync,
  patchFile
};
