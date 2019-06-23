const { spawn } = require('child_process');
const { join, dirname, basename } = require('path');
const fs = require('fs');
const {gzipSync} = require('zlib');
const {promisify} = require('util');
const http = require('http')
const https = require('https');

const isWindows = process.platform === 'win32';

const mkdirAsync = promisify(fs.mkdir);
const copyFileAsync = promisify(fs.copyFile);
const renameAsync = promisify(fs.rename);

const prettyPlatform = {
  win32: 'windows',
  windows: 'windows',
  win: 'windows',
  darwin: 'mac',
  macos: 'mac',
  mac: 'mac',
  linux: 'linux',
  static: 'alpine',
  alpine: 'alpine'
}

const prettyArch = {
  x86: 'x86',
  arm6: 'arm6l',
  arm64: 'arm64',
  arm6l: 'arm6l',
  arm: 'arm7l',
  arm7: 'arm7l',
  arm7l: 'arm7l',
  amd64: 'x64',
  ia32: 'x86',
  x32: 'x86',
  x64: 'x64'
}

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
    const request = proto.get(url, function(response) {
      if(response.statusCode !== 200) {
        return reject(new Error(`Non-OK response, statusCode=${response.statusCode}, url=${url}`));
      }
      response.on('error', reject);
      mkdirp(dirname(toFile)).then(() => {
        const outFile = fs.createWriteStream(toFile);
        outFile.on('finish', () => resolve());
        response.pipe(outFile);
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

function buildName(platform, arch, placeHolderSizeMB, version) {
  return `${platform}-${placeHolderSizeMB}MB-${arch}-${version}`;
}

class NodeJsBuilder {

  constructor(version, mainAppFile) {
    this.version = version;
    this.appFile = mainAppFile;
    const isBsd = process.platform.indexOf('bsd') > -1;
    this.make = isWindows ? 'vcbuild.bat' : isBsd ? 'gmake' : 'make';
    this.configure = isWindows ? 'configure' : './configure';
    this.srcDir = join(__dirname, 'src');
    this.nodeSrcFile = join('build', `node-v${version}.tar.gz`);
    this.nodeSrcDir = join('build', `node-v${version}`);
    this.cacheDir = 'cache';
    this.resultFile = isWindows ? join(this.nodeSrcDir, 'Release', 'node.exe') : join(this.nodeSrcDir, 'out', 'Release', 'node');
    this.placeHolderSizeMB = -1;
  }

  downloadExpandNodeSource() {
    const url = `https://nodejs.org/dist/v${this.version}/node-v${this.version}.tar.gz`;
    if(fs.existsSync(this.nodePath('configure'))) {
      log(`node version=${this.version} already downloaded and expanded`)
      return Promise.resolve();
    }
    return download(url, this.nodeSrcFile)
      //TODO: windows
      .then(() => runCommand('tar', ['-xf', basename(this.nodeSrcFile)], dirname(this.nodeSrcFile)))
  }

  downloadCachedBuild(platform, arch, placeHolderSizeMB) {
    placeHolderSizeMB = placeHolderSizeMB || this.placeHolderSizeMB;
    const name = buildName(platform, arch, placeHolderSizeMB, this.version);
    //TODO:
    const baseUrl = 'https://github.com/criblio/node-one/releases/download/v0.01/';
    const url = `${baseUrl}${name}`;
    const filename = join(this.cacheDir, name);
    if(fs.existsSync(filename)) {
      return Promise.resolve(filename);
    }
    return download(url, filename);
  }

  uploadNodeBinary(name) {
    if(!name) {
      const arch = process.arch in prettyArch ? prettyArch[process.arch] : process.arch;
      const platform = prettyPlatform[process.platform];
      name = buildName(platform, arch, this.placeHolderSizeMB, this.version);
    }
    //TODO:
    const baseUrl = 'https://uploads.github.com/repos/criblio/node-one/releases/18154804/assets';
    const url = `${baseUrl}?name=${encodeURIComponent(name)}`;
    return upload(url, this.resultFile);
  }

  nodePath(...pathSegments) {
    return join(this.nodeSrcDir, ...pathSegments);
  }

  revertBackup(origFile) {
    if(!fs.existsSync(origFile + '.bak'))
      return Promise.resolve();
    return renameAsync(origFile+'.bak', origFile);
  }

  createBackup(origFile) {
    if(fs.existsSync(origFile + '.bak'))
      return Promise.resolve();  // do not overwrite backup
    return copyFileAsync(origFile, origFile+'.bak');
  }

  getPlaceholderContent(sizeMB) {
    const appMainCont = '~N~o~D~e~o~N~e~\n'.repeat(sizeMB*1024*1024/16);
    return Buffer.from(appMainCont);
  }

  prepareNodeJsBuild() {
    // install _third_party_main.js
    // install app_main.js
    // update node.gyp
    const nodeGypPath = this.nodePath('node.gyp');
    const appMainPath = this.nodePath('lib', 'app_main.js');
    return Promise.resolve()
      .then(() => copyFileAsync(
        join(this.srcDir, '_third_party_main.js'),
        this.nodePath('lib', '_third_party_main.js'),
      ))
      //TODO: install app_main.js
      .then(() => {
        const m = /^__(\d+)MB__$/.exec(this.appFile);
        if(m) {
          this.placeHolderSizeMB = Number(m[1]);
          fs.writeFileSync(appMainPath, this.getPlaceholderContent(this.placeHolderSizeMB));
        } else {
          const fileCont = fs.readFileSync(this.appFile);
          fs.writeFileSync(appMainPath, gzipSync(fileCont).toString('base64'));
        }
      })
      .then(() => this.revertBackup(nodeGypPath))
      .then(() => this.createBackup(nodeGypPath))
      .then(() => {
        const nodeGypCont = fs.readFileSync(nodeGypPath)
          .toString().replace(/('lib\/sys.js',)/, "$1"+
          "\n      'lib/_third_party_main.js'," + 
          "\n      'lib/app_main.js',"
        );
        fs.writeFileSync(nodeGypPath, nodeGypCont);
      });
  }

  //1. download node source
  //2. expand node version 
  //3. install _third_party_main.js 
  //4. process mainAppFile (gzip, base64 encode it)
  //5. kick off ./configure & build
  buildFromSource(){
    return this.downloadExpandNodeSource()
      .then(() => this.prepareNodeJsBuild())
      .then(() => runCommand(this.configure, [], this.nodeSrcDir))
      .then(() => runCommand(this.make, ['-j2'], this.nodeSrcDir))
      .then(() => this.uploadNodeBinary())
      .then(() => {
        log(`RESULTS: ${this.resultFile}`);
        return this.resultFile;
      })
  }

  buildFromCached(platform='linux', arch='x64', outFile=undefined) {
    const mainAppFileCont = gzipSync(fs.readFileSync(this.appFile)).toString('base64');
    this.placeHolderSizeMB = 2; // TODO: 

    return this.downloadCachedBuild(platform, arch)
      .then(cachedFile => {
        const placeholder = this.getPlaceholderContent(this.placeHolderSizeMB);

        outFile = outFile || `app-${platform}-${arch}-${this.version}`;
        const execFileCont = fs.readFileSync(cachedFile);
        const placeholderIdx = execFileCont.indexOf(placeholder);
    
        if(placeholderIdx < 0) {
          throw new Error(`Could not find placeholder in file=${cachedFile}`);
        }
    
        execFileCont.fill(0, placeholderIdx, placeholderIdx + placeholder.length);
        const bytesWritten = execFileCont.write(mainAppFileCont, placeholderIdx);
    
        return mkdirp(dirname(outFile))
          .then(() => fs.writeFileSync(outFile, execFileCont));
      });
  }
}

const builder = new NodeJsBuilder('10.16.0', process.argv[2] || '__2MB__');
builder.buildFromSource();
// builder.buildFromCached();
