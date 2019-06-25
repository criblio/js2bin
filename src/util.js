const http = require('http')
const https = require('https');
const { spawn } = require('child_process');
const { join, dirname, basename, resolve } = require('path');
const {promisify} = require('util');
const fs = require('fs');


const mkdirAsync = promisify(fs.mkdir);
const copyFileAsync = promisify(fs.copyFile);
const renameAsync = promisify(fs.rename);

function log() {
  console.log(`${new Date().toISOString()} -`, ...arguments);
}

function mkdirp(path) {
  return mkdirAsync(path).catch(err => {
    if(err.code === 'ENOENT') {
      return mkdirp(dirname(path)).then(() => mkdirp(path));
    } else {
      const statRes = fs.statSync(path);
      if(!statRes.isDirectory()) {
        throw err;
      }
    }
  })
}

function runCommand(command, args, cwd, env=undefined, verbose=true) {
  return new Promise((resolve, reject) => {
    log(`running: ${command} ${args.join(' ')} ...`);
    spawn(command, args, {
      cwd,
      env: env || {...process.env},
      stdio: verbose ? 'inherit' : 'ignore'
    })
    .once('error', reject)
    .once('close', (code) => {
      if (code != 0) {
        reject (new Error(`${command} ${args.join(' ')} exited with code: ${code}`));
      }
      resolve();
    })
  });
}

function download(url, toFile){
  return new Promise((resolve,reject) => {
    if (!url || url.length===0) {
      throw new Error(`Invalid Argument - url [${url}] is undefined or empty!`);
    }
    if (!toFile || toFile.length===0) {
      throw new Error(`Invalid Argument - file: [${toFile}] is undefined or empty!`);
    }
    log(`downloading ${url} to ${toFile} ...`);
    const proto = url.startsWith('https://') ? https : http ;
    const request = proto.get(url, function(res) {
      if (res.statusCode > 300 && res.statusCode < 400 && res.headers.location) {
        const redirUrl = new URL(res.headers.location);
        if(!redirUrl.hostname) {// partial URL
          const origUrl = new URL(url);
          redirUrl.hostname = origUrl.hostname;
          redirUrl.protocol = origUrl.protocol;
        }
        log(`following redirect ...`);
        return download(redirUrl.toString(), toFile).then(resolve, reject);
      }
      if(res.statusCode >= 400) {
        return reject(new Error(`Non-OK response, statusCode=${res.statusCode}, url=${url}`));
      }
      res.on('error', reject);
      mkdirp(dirname(toFile)).then(() => {
        const outFile = fs.createWriteStream(toFile);
        outFile.on('finish', () => resolve(toFile));
        res.pipe(outFile);
      });
    });
  })
  .catch(err => {
    try{ fs.unlinkSync(toFile); } catch(ignore){} 
    throw err; 
  })
}

function upload(url, file){
  return new Promise((resolve,reject) => {
    log(`uploading file=${file}, url=${url} ...`);
    if (!url || url.length===0) {
      throw new Error(`Invalid Argument - url [${url}] is undefined or empty!`);
    }
    const fstat = fs.statSync(file);
    if(!fstat.isFile()) {
      throw new Error(`Invalid Argument - file [${file}] must be a file`);
    }
    const _url = new URL(url);
    const options = {
      hostname: _url.hostname,
      port: _url.port,
      path: `${_url.pathname}${_url.search}`,
      method: 'POST',
      headers: {
        Authorization: 'token ' + process.env.GITHUB_TOKEN,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fstat.size
      }
    };
    const proto = url.startsWith('https://') ? https : http ;
    const req = proto.request(options, (res) => {
      res.on('data', data => log(data.toString()));
      res.on('end', () => resolve());
    });
    
    req.on('error', reject);
    // Write data to request body
    fs.createReadStream(file)
      .pipe(req);
  });
}


module.exports = {
  log,
  download, upload,
  runCommand,
  mkdirp,
  copyFileAsync, renameAsync
}