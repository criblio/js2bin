
const {log, download, upload, fetch, mkdirp, rmrf, copyFileAsync, runCommand, renameAsync} = require('./util');
const {gzipSync, createGunzip} = require('zlib');
const { join, dirname, basename, resolve } = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tar = require('tar-fs');
const pkg = require('../package.json');

const isWindows = process.platform === 'win32';
const isDarwin = process.platform === 'darwin';


const prettyPlatform = {
  win32: 'windows',
  windows: 'windows',
  win: 'windows',
  darwin: 'darwin',
  macos: 'darwin',
  mac: 'darwin',
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
  return `${platform}-${arch}-${version}-v1-${placeHolderSizeMB}MB`;
}

class NodeJsBuilder {

  constructor(cwd, version, mainAppFile, appName) {
    this.version = version;
    this.appFile = resolve(mainAppFile);
    this.appName = appName;
    if(!this.appName) {
      if(basename(this.appFile) !== 'index.js') { // use filename if ! index.js
        this.appName = basename(this.appFile).split('.')[0];
      }else if(basename(dirname(this.appFile))) { // parent dir
        this.appName = basename(dirname(this.appFile));
      } else {
        this.appName = 'app_main';
      }
    }
    const isBsd = process.platform.indexOf('bsd') > -1;
    this.make = isWindows ? 'vcbuild.bat' : isBsd ? 'gmake' : 'make';
    this.configure = isWindows ? 'configure' : './configure';
    this.srcDir = join(__dirname);
    this.buildDir = join(cwd || process.cwd(), 'build');
    this.nodeSrcFile = join(this.buildDir, `node-v${version}.tar.gz`);
    this.nodeSrcDir = join(this.buildDir, `node-v${version}`);
    this.cacheDir = join(cwd || process.cwd(), 'cache');
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
    const filename = join(this.cacheDir, name);
    if(fs.existsSync(filename)) {
      log(`build name=${name} already downloaded, using it`);
      return Promise.resolve(filename);
    }
    const baseUrl = `https://github.com/criblio/js2bin/releases/download/v${pkg.version}/`;
    const url = `${baseUrl}${name}`;
    return download(url, filename)
  }

  uploadNodeBinary(name, uploadBuild, cache) {
    if(!uploadBuild && !cache) return Promise.resolve();
    if(!name) {
      const arch = process.arch in prettyArch ? prettyArch[process.arch] : process.arch;
      const platform = prettyPlatform[process.platform];
      name = buildName(platform, arch, this.placeHolderSizeMB, this.version);
    }

    let p = Promise.resolve()
    if(cache) {
      p = mkdirp(this.cacheDir)
        .then(() => copyFileAsync(this.resultFile, join(this.cacheDir, name)));
    }

    if(!uploadBuild) return p;

    // now upload to release
    const headers = {
      Authorization: 'token ' + process.env.GITHUB_TOKEN,
    };
    return p
      .then(() => fetch(`https://api.github.com/repos/criblio/js2bin/releases/tags/v${pkg.version}`, headers))
      .then(JSON.parse)
      .then(p => p.upload_url.split('{')[0])
      .then(baseUrl => {
        const url = `${baseUrl}?name=${encodeURIComponent(name)}`;
        return upload(url, this.resultFile, headers);
      });
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

  cleanupBuild() {
    log(`cleaning up build dir=${this.nodeSrcDir}`);
    return rmrf(dirname(this.nodeSrcDir), 5);
  }

  getPlaceholderContent(sizeMB) {
    const appMainCont = '~N~o~D~e~o~N~e~\n'.repeat(sizeMB*1024*1024/16);
    return Buffer.from('`' + appMainCont + '`');
  }

  getAppContentToBundle() {
    const mainAppFileCont = gzipSync(fs.readFileSync(this.appFile)).toString('base64');
    return Buffer.from(this.appName).toString('base64') + '\n' + mainAppFileCont;
  }

  prepareNodeJsBuild() {
    // install _third_party_main.js
    // install app_main.js
    const appMainPath = this.nodePath('lib', '_js2bin_app_main.js');
    return Promise.resolve()
      .then(() => copyFileAsync(
        join(this.srcDir, '_third_party_main.js'),   // this is the entrypoint to the light wrapper that js2bin inserts
        this.nodePath('lib', '_third_party_main.js'),
      ))
      .then(() => {
        const m = /^__(\d+)MB__$/i.exec(basename(this.appFile)); // placeholder file
        if(m) {
          this.placeHolderSizeMB = Number(m[1]);
          fs.writeFileSync(appMainPath, this.getPlaceholderContent(this.placeHolderSizeMB));
        } else {
          fs.writeFileSync(appMainPath, this.getAppContentToBundle());
        }
      });
  }

  printDiskUsage() {
    if(isWindows)
      return runCommand('fsutil', ['volume', 'diskfree', 'd:']);
    return runCommand('df', ['-h']);
  }

  buildInContainer() {
    const containerTag = 'centos-6-build'
    return runCommand('docker', ['build', '-t', containerTag, '-f', 'Dockerfile.centos6', '.'])
     //docker run -v /home/ec2-user/js2bin-master/:/js2bin/ -it centosbuild /bin/bash -c 'source /opt/rh/devtoolset-7/enable && source /opt/rh/python27/enable && cd js2bin && npm install && ./js2bin.js --ci --cache --node=12.8.0'
      .then(() => runCommand(
        'docker', ['run', 
        '-v', `${process.cwd()}:/js2bin/`,
        '-t', containerTag,
        '/bin/bash', '-c',
        `source /opt/rh/devtoolset-7/enable && source /opt/rh/python27/enable && cd /js2bin && npm install && ./js2bin.js --ci --node=${this.version} --size=${this.placeHolderSizeMB}MB`
        ]
      ))
  }

  //1. download node source
  //2. expand node version 
  //3. install _third_party_main.js 
  //4. process mainAppFile (gzip, base64 encode it) - could be a placeholder file
  //5. kick off ./configure & build
  buildFromSource(uploadBuild, cache){
    const mod1 = path.join('lib', '_third_party_main.js');
    const mod2 = path.join('lib', '_js2bin_app_main.js');
    const makeArgs = isWindows ? ['x64', 'noetw', 'no-cctest', 'link-module', mod1, 'link-module', mod2] : [`-j${os.cpus().length}`];
    const configArgs = ['--link-module', mod1, '--link-module', mod2]
     isDarwin ? [] : [];
    return this.printDiskUsage()
      .then(() => this.downloadExpandNodeSource())
      .then(() => this.prepareNodeJsBuild())
      .then(() => {
        if(isWindows)
          return runCommand(this.make, makeArgs, this.nodeSrcDir);
        if(isDarwin) {
          return runCommand(this.configure, configArgs, this.nodeSrcDir) 
            .then(() => runCommand(this.make, makeArgs, this.nodeSrcDir))
        }

        // check to see if the system we're running on is old enough - if not use a container build
        const lddVersion = execSync('ldd --version').toString();
        if(lddVersion.indexOf('ldd (GNU libc) 2.12') > -1) {
          const cfgMakeEnv = {...process.env};
          cfgMakeEnv.LDFLAGS = '-lrt'; // needed for node 12 to be compiled with this old compiler https://github.com/nodejs/node/issues/30077#issuecomment-574535342
          return runCommand(this.configure, configArgs, this.nodeSrcDir, cfgMakeEnv) 
            .then(() => runCommand(this.make, makeArgs, this.nodeSrcDir, cfgMakeEnv))
        }
        return this.buildInContainer()
      })
      .then(() => this.uploadNodeBinary(undefined, uploadBuild, cache))
      .then(() => this.printDiskUsage())
      // .then(() => this.cleanupBuild().catch(err => log(err)))
      .then(() => {
        log(`RESULTS: ${this.resultFile}`);
        return this.resultFile;
      })
      .catch(err => this.printDiskUsage().then(() => {throw err;}))
      ;
  }

  buildFromCached(platform='linux', arch='x64', outFile=undefined, cache=false) {
    const mainAppFileCont = this.getAppContentToBundle();
    this.placeHolderSizeMB = Math.ceil(mainAppFileCont.length/1024/1024); // 2, 4, 6, 8...
    if(this.placeHolderSizeMB % 2 !== 0) {
      this.placeHolderSizeMB += 1;
    }

    return this.downloadCachedBuild(platform, arch)
      .then(cachedFile => {
        const placeholder = this.getPlaceholderContent(this.placeHolderSizeMB);

        outFile = resolve(outFile || `app-${platform}-${arch}-${this.version}`);
        const execFileCont = fs.readFileSync(cachedFile);
        if(!cache){
          fs.unlinkSync(cachedFile);
        } 

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
