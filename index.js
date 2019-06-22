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
    const dir = dirname(toFile);
    mkdirp(dir).then(() => {
      const outFile = fs.createWriteStream(toFile);
      const request = proto.get(url, function(response) {
        response.on('error', reject);
        outFile.on('finish', () => resolve());
        response.pipe(outFile);
      });
    });
  });
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
    this.resultFile = isWindows ? join(this.nodeSrcDir, 'Release', 'node.exe') : join(this.nodeSrcDir, 'out', 'Release', 'node');
  }

  downloadExpandNodeSource() {
    const url = `https://nodejs.org/dist/v${this.version}/node-v${this.version}.tar.gz`;
    if(fs.existsSync(this.nodePath('configure'))) {
      log(`node version=${this.version} already downloaded and expanded`)
      return Promise.resolve();
    }
    return download(url, this.nodeSrcFile)
      .then(() => runCommand('tar', ['-xf', basename(this.nodeSrcFile)], dirname(this.nodeSrcFile)))
  }

  uploadNodeBinary(name) {
    if(!name) {
      const arch = process.arch in prettyArch ? prettyArch[process.arch] : process.arch;
      const platform = prettyPlatform[process.platform];
      name = `${platform}-${arch}-${this.version}`;
    }
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
          fs.writeFileSync(appMainPath, this.getPlaceholderContent(Number(m[1])));
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

  buildFromCached(platform) {

    const placeholder = this.getPlaceholderContent(3);

    const mainAppFileCont = gzipSync(fs.readFileSync(this.appFile)).toString('base64');

    const execFile = '/home/ledion/workspace/node-one/mac-x64-10.16.0';
    const outFile = '/home/ledion/workspace/node-one/cribl-mac-x64-10.16.0';

    const execFileCont = fs.readFileSync(execFile);
    const placeholderIdx = execFileCont.indexOf(placeholder);

    if(placeholderIdx < 0) {
      throw new Error(`Could not find placeholder in file=${execFile}`);
    }

    execFileCont.fill(0, placeholderIdx, placeholderIdx + placeholder.length);
    const bytesWritten = execFileCont.write(mainAppFileCont, placeholderIdx);

    fs.writeFileSync(outFile, execFileCont);

  }
}

const builder = new NodeJsBuilder('10.16.0', process.argv[2] || '__3MB__');
builder.buildFromSource();
//builder.buildFromCached();
