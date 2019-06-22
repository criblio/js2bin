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
      const outFile = fs.createWriteStream(toFile);
      const request = proto.get(url, function(response) {
        response.on('error', reject);
        outFile.on('finish', () => resolve());
        response.pipe(outFile);
      });
    });
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
      console.log(`node version=${this.version} already downloaded and expanded`)
      return Promise.resolve();
    }
    return download(url, this.nodeSrcFile)
      .then(() => runCommand('tar', ['-xf', basename(this.nodeSrcFile)], dirname(this.nodeSrcFile)))
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
        if(this.appFile === '__1MB__') {
          const appMainCont = '~N~o~D~e~o~N~e~\n'.repeat(1024*1024/16);
          fs.writeFileSync(appMainPath, appMainCont);
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
      .then(() => {
        console.log(`RESULTS: ${this.resultFile}`);
        return this.resultFile;
      });
  }

  buildFromCached(platform) {

  }
  
}

const builder = new NodeJsBuilder('10.16.0', process.argv[2] || '__1MB__');
builder.buildFromSource();
