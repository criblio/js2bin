
const {log, download, upload, mkdirp, copyFileAsync, runCommand, renameAsync} = require('./util');
const {gzipSync, createGunzip} = require('zlib');
const { join, dirname, basename, resolve } = require('path');
const fs = require('fs');
const os = require('os');
const tar = require('tar-fs')

const isWindows = process.platform === 'win32';


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
    this.srcDir = join(__dirname);
    this.nodeSrcFile = join('build', `node-v${version}.tar.gz`);
    this.nodeSrcDir = join('build', `node-v${version}`);
    this.cacheDir = 'cache';
    this.resultFile = isWindows ? join(this.nodeSrcDir, 'Release', 'node.exe') : join(this.nodeSrcDir, 'out', 'Release', 'node');
    this.placeHolderSizeMB = -1;
  }

  static platform() {
    return prettyPlatform[process.platform];
  }

  downloadExpandNodeSource() {
    const url = `https://nodejs.org/dist/v${this.version}/node-v${this.version}.tar.gz`;
    if(fs.existsSync(this.nodePath('configure'))) {
      log(`node version=${this.version} already downloaded and expanded, using it`);
      return Promise.resolve();
    }
    return download(url, this.nodeSrcFile)
      .then(() => new Promise((resolve, reject) => {
        log(`expanding node source, file=${this.nodeSrcFile} ...`);
        fs.createReadStream(this.nodeSrcFile)
          .pipe(createGunzip())
          .pipe(tar.extract(dirname(this.nodeSrcFile)))
          .on('error', reject)
          .on('finish', resolve)
        })
      );
  }

  downloadCachedBuild(platform, arch, placeHolderSizeMB) {
    placeHolderSizeMB = placeHolderSizeMB || this.placeHolderSizeMB;
    const name = buildName(platform, arch, placeHolderSizeMB, this.version);
    //TODO:
    const baseUrl = 'https://github.com/criblio/node-one/releases/download/v0.01/';
    const url = `${baseUrl}${name}`;
    const filename = join(this.cacheDir, name);
    if(fs.existsSync(filename)) {
      log(`build name=${name} already downloaded, using it`);
      return Promise.resolve(filename);
    }
    return download(url, filename)
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
      .then(() => {
        const m = /^__(\d+)MB__$/i.exec(this.appFile); // placeholder file
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
  //4. process mainAppFile (gzip, base64 encode it) - could be a placeholder file
  //5. kick off ./configure & build
  buildFromSource(){
    return this.downloadExpandNodeSource()
      .then(() => this.prepareNodeJsBuild())
      .then(() => runCommand(this.configure, [], this.nodeSrcDir))
      .then(() => runCommand(this.make, [`-j${os.cpus().length}`], this.nodeSrcDir))
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

        outFile = resolve(outFile || `app-${platform}-${arch}-${this.version}`);
        const execFileCont = fs.readFileSync(cachedFile);
        const placeholderIdx = execFileCont.indexOf(placeholder);
    
        if(placeholderIdx < 0) {
          throw new Error(`Could not find placeholder in file=${cachedFile}`);
        }
    
        execFileCont.fill(0, placeholderIdx, placeholderIdx + placeholder.length);
        const bytesWritten = execFileCont.write(mainAppFileCont, placeholderIdx);
        log(`writing native binary ${outFile}`);
        return mkdirp(dirname(outFile))
          .then(() => fs.writeFileSync(outFile, execFileCont));
      });
  }
}

module.exports = {
  NodeJsBuilder
};
