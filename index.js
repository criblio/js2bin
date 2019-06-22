const { spawn } = require('child_process');
const { join, dirname } = require('path');
const { mkdir, createWriteStream, statSync } = require('fs');
const http = require('http')
const https = require('https');

const isWindows = process.platform === 'win32';


function mkdirp(path) {
  return new Promise((resolve, reject) => {
    mkdir(path, err => {
      if(err) reject(err)
      else    resolve()
    })
  }).catch(err => {
    if(err.code === 'ENOENT') {
      return mkdirp(dirname(path)).then(() => mkdirp(path));
    } else {
      const statRes = statSync(path);
      if(!statRes.isDirectory()) {
        throw err;
      }
    }
  })
}

function runCommand(command, args, cwd, env=undefined, verbose=true) {
  return new Promise((resolve, reject) => {
    console.log(`${new Date()} - running: ${command} ${args.join(' ')} ...`);
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
    console.log(`downloading ${url} to ${toFile} ...`);
    const proto = url.startsWith('https://') ? https : http ;
    const dir = dirname(toFile);
    mkdirp(dir).then(() => {
      const outFile = createWriteStream(toFile);
      const request = proto.get(url, function(response) {
        response.on('error', reject);
        outFile.on('finish', () => resolve());
        response.pipe(outFile);
      });
    });
  });
}



//1. download node source
//2. expand node version 
//3. install _third_party_main.js 
//4. process mainAppFile (gzip, base64 encode it)
//5. kick off ./configure & build
function buildFromSource(version, mainAppFile){
  const isBsd = process.platform.indexOf('bsd') > -1;
  const make = isWindows ? 'vcbuild.bat' : isBsd ? 'gmake' : 'make';
  const configure = isWindows ? 'configure' : './configure';
  const url = `https://nodejs.org/dist/v${version}/node-v${version}.tar.gz`;
  const srcFile = join('build', `node-v${version}.tar.gz`);
  const srcDir = join('build', `node-v${version}`);
  const resultFile = isWindows ? join(srcDir, 'Release', 'node.exe') : join(srcDir, 'out', 'Release', 'node');

  return Promise.resolve()
    .then(() => download(url, srcFile))
    .then(() => runCommand('tar', ['-xf', `node-v${version}.tar.gz`], dirname(srcFile)))
    .then(() => runCommand(configure, [], srcDir))
    .then(() => runCommand(make, ['-j2'], srcDir))
    .then(() => console.log(`RESULTS: ${resultFile}`))
}


function buildFromCached(nodeVersion, mainAppFile, platform) {

}


buildFromSource('10.16.0');