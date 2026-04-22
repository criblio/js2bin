
const { log, download, upload, deleteArtifact, getAssetIdByName, fetch, mkdirp, rmrf, copyFileAsync, runCommand, renameAsync, patchFile, assertSupportedKey } = require('./util');
const { brotliCompressSync, createGunzip } = require('zlib');
const zlib = require('zlib');
const { join, dirname, basename, parse, resolve } = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const tar = require('tar-fs');
const execFileAsync = promisify(execFile);
const pkg = require('../package.json');

const isWindows = process.platform === 'win32';
const isDarwin = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

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
};

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
};

// keys are expected to come from values of `prettyArch`
const darwinArch = {
  arm64: 'arm64',
  x64: 'x86_64',
};

function buildName(platform, arch, placeHolderSizeMB, version, buildVersion, enableOverlay) {
  let name = `${platform}-${arch}-${version}-${buildVersion}-${placeHolderSizeMB}MB`;
  if (enableOverlay) name += '-overlay';
  return name;
}

function commitDirSuffix(commitHash) {
  const s = String(commitHash).trim().replace(/^[\^#]+/, '');
  const lower = s.toLowerCase();
  if (/^[0-9a-f]+$/.test(lower)) {
    return lower;
  }
  return lower.replace(/[^a-z0-9-]/g, '_').slice(0, 64) || 'unknown';
}

function parseSemverFromDescribe(desc) {
  const m = String(desc).match(/v?(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

class NodeJsBuilder {
  constructor(cwd, version, mainAppFile, appName, patchDir, buildVersion, commitHash, signingPublicKey, enableOverlay) {
    this.version = version;
    this.appFile = resolve(mainAppFile);
    this.appName = appName;
    this.buildVersion = buildVersion || 'v1';
    if (!this.appName) {
      if (basename(this.appFile) !== 'index.js') { // use filename if ! index.js
        this.appName = basename(this.appFile).split('.')[0];
      } else if (basename(dirname(this.appFile))) { // parent dir
        this.appName = basename(dirname(this.appFile));
      } else {
        this.appName = 'app_main';
      }
    }
    const isBsd = process.platform.indexOf('bsd') > -1;
    this.make = isWindows ? 'vcbuild.bat' : isBsd ? 'gmake' : 'make';
    this.configure = isWindows ? 'configure' : './configure';
    this.srcDir = join(__dirname);
    this.patchDir = patchDir || join(this.srcDir, 'patch', version);
    this.buildDir = join(cwd || process.cwd(), 'build');
    this.nodeSrcFile = join(this.buildDir, `node-v${version}.tar.gz`);
    this.nodeSrcDir = commitHash
      ? join(this.buildDir, `node-git-${commitDirSuffix(commitHash)}`)
      : join(this.buildDir, `node-v${version}`);
    this.cacheDir = join(cwd || process.cwd(), 'cache');
    this.resultFile = isWindows ? join(this.nodeSrcDir, 'Release', 'node.exe') : join(this.nodeSrcDir, 'out', 'Release', 'node');
    this.placeHolderSizeMB = -1;
    this.builderImageVersion = 3;
    this.commitHash = commitHash;
    this.signingPublicKey = signingPublicKey || '';
    this.enableOverlay = !!enableOverlay;
  }

  static platform() {
    return prettyPlatform[process.platform];
  }

  static getArch(arch) {
    if (arch.indexOf('linux') > -1) {
      arch = arch.split('/')[1];
    }
    return arch in prettyArch ? prettyArch[arch] : arch;
  }

  inferVersionAndPatchDirFromGit() {
    return execFileAsync('git', ['describe', '--tags', '--always'], { cwd: this.nodeSrcDir })
      .then(({ stdout }) => {
        const describe = stdout.trim();
        const semver = parseSemverFromDescribe(describe);
        if (!semver) {
          throw new Error(`Could not parse semver from git describe output: ${describe}`);
        }
        this.version = semver;
        this.patchDir = join(this.srcDir, 'patch', this.version);
        log(`inferred version=${this.version} from git describe (${describe})`);
      });
  }

  downloadExpandNodeSourceWithCommit() {
    const afterSourceReady = () =>
      this.inferVersionAndPatchDirFromGit().then(() =>
        this.version.split('.')[0] >= 15 ? this.applyPatches() : Promise.resolve()
      );

    if (fs.existsSync(this.nodePath('configure'))) {
      log(`node commit=${this.commitHash} already downloaded and expanded, using it`);
      return afterSourceReady();
    }
    log(`cloning node source for commit=${this.commitHash} ...`);

    return mkdirp(this.buildDir)
      .then(() => {
        return runCommand('git', ['clone', 'https://github.com/nodejs/node.git', this.nodeSrcDir], this.buildDir);
      })
      .then(() => {
        log(`checking out commit hash: ${this.commitHash}`);
        return runCommand('git', ['checkout', this.commitHash], this.nodeSrcDir);
      })
      .then(() => afterSourceReady());
  }

  downloadExpandNodeSource() {
    const url = `https://nodejs.org/dist/v${this.version}/node-v${this.version}.tar.gz`;
    if (fs.existsSync(this.nodePath('configure'))) {
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
          .on('finish', resolve);
      })
      )
      .then(() => this.version.split('.')[0] >= 15 ? this.applyPatches() : Promise.resolve())
  }

  downloadCachedBuild(platform, arch, customDownloadUrl, placeHolderSizeMB) {
    placeHolderSizeMB = placeHolderSizeMB || this.placeHolderSizeMB;
    const name = buildName(platform, arch, placeHolderSizeMB, this.version, this.buildVersion, this.enableOverlay);
    const filename = join(this.cacheDir, name);
    if (fs.existsSync(filename)) {
      log(`build name=${name} already downloaded, using it`);
      return Promise.resolve(filename);
    }
    const baseUrl = customDownloadUrl || `https://github.com/criblio/js2bin/releases/download/v${pkg.version}/`;
    const url = `${baseUrl}${name}`;
    return download(url, filename);
  }

  uploadNodeBinary(name, uploadBuild, cache, arch, ptrCompression) {
    if (!uploadBuild && !cache) return Promise.resolve();
    if (!name) {
      arch = NodeJsBuilder.getArch(arch);
      const platform = prettyPlatform[process.platform] + (ptrCompression ? '-ptrc' : '');
      name = buildName(platform, arch, this.placeHolderSizeMB, this.version, this.buildVersion, this.enableOverlay);
    }

    let p = Promise.resolve();
    if (cache) {
      p = mkdirp(this.cacheDir)
        .then(() => copyFileAsync(this.resultFile, join(this.cacheDir, name)));
    }

    if (!uploadBuild) return p;

    // now upload to release
    const headers = {
      Authorization: 'token ' + process.env.GITHUB_TOKEN
    };
    return p
      .then(() => fetch(`https://api.github.com/repos/criblio/js2bin/releases/tags/v${pkg.version}`, headers))
      .then(JSON.parse)
      .then(release => {
        // First, check if an asset with the same name already exists and delete it
        const releaseUrl = `https://api.github.com/repos/criblio/js2bin/releases/tags/v${pkg.version}`;
        return getAssetIdByName(releaseUrl, name, headers)
          .then(assetId => {
            if (assetId) {
              log(`Found existing asset with name '${name}' and id ${assetId}, deleting it first and then proceeding with uploading the new one`);
              const deleteUrl = `https://api.github.com/repos/criblio/js2bin/releases/assets/${assetId}`;
              return deleteArtifact(deleteUrl, headers)
                .then(() => {
                  log(`Successfully deleted existing asset with ID ${assetId}`);
                  return release;
                });
            } else {
              log(`No existing asset with name '${name}' found for deletion, proceeding with upload`);
              return release;
            }
          });
      })
      .then(release => release.upload_url.split('{')[0])
      .then(baseUrl => {
        const url = `${baseUrl}?name=${encodeURIComponent(name)}`;
        return upload(url, this.resultFile, headers);
      });
  }

  nodePath(...pathSegments) {
    return join(this.nodeSrcDir, ...pathSegments);
  }

  revertBackup(origFile) {
    if (!fs.existsSync(origFile + '.bak')) { return Promise.resolve(); }
    return renameAsync(origFile + '.bak', origFile);
  }

  createBackup(origFile) {
    if (fs.existsSync(origFile + '.bak')) { return Promise.resolve(); } // do not overwrite backup
    return copyFileAsync(origFile, origFile + '.bak');
  }

  cleanupBuild() {
    log(`cleaning up build dir=${this.nodeSrcDir}`);
    return rmrf(dirname(this.nodeSrcDir), 5);
  }

  getPlaceholderContent(sizeMB) {
    const appMainCont = '~N~o~D~e~o~N~e~\n'.repeat(sizeMB * 1024 * 1024 / 16);
    return Buffer.from('`' + appMainCont + '`');
  }

  // 512 B region reserved for the overlay signing public key. Sized to fit a
  // PEM-encoded ECDSA P-256 public key (~200 B) with generous slack. Written
  // at --ci time and overwritten at --build time when the user passes
  // --signing-public-key. Uses the same sentinel+indexOf scheme as the app
  // bundle placeholder so the runtime can detect an unmodified slot.
  getKeyPlaceholderContent() {
    const KEY_PLACEHOLDER_SIZE = 512;
    const line = '~K~e~y~P~l~H~d~\n';
    return Buffer.from('`' + line.repeat(KEY_PLACEHOLDER_SIZE / line.length) + '`');
  }

  getAppContentToBundle() {
    const mainAppFileCont = brotliCompressSync(
      fs.readFileSync(this.appFile),
      {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: fs.statSync(this.appFile).size
        }
      }
    ).toString('base64');
    return Buffer.from(this.appName).toString('base64') + '\n' + mainAppFileCont;
  }

  prepareNodeJsBuild() {
    // install _third_party_main.js — pick overlay or non-overlay version
    // install app_main.js
    // install _js2bin_signing_key.js placeholder (when overlay is enabled)
    const appMainPath = this.nodePath('lib', '_js2bin_app_main.js');
    const keyPath = this.nodePath('lib', '_js2bin_signing_key.js');
    return Promise.resolve()
      .then(() => {
        const srcFile = this.enableOverlay ? '_third_party_main_overlay.js' : '_third_party_main.js';
        const tpmContent = fs.readFileSync(join(this.srcDir, srcFile), 'utf8');
        const destPath = this.nodePath('lib', '_third_party_main.js');
        fs.writeFileSync(destPath, tpmContent);
      })
      .then(() => {
        const m = /^__(\d+)MB__$/i.exec(basename(this.appFile)); // placeholder file
        if (m) {
          this.placeHolderSizeMB = Number(m[1]);
          fs.writeFileSync(appMainPath, this.getPlaceholderContent(this.placeHolderSizeMB));
        } else {
          fs.writeFileSync(appMainPath, this.getAppContentToBundle());
        }
      })
      .then(() => {
        if (this.enableOverlay) {
          fs.writeFileSync(keyPath, this.getKeyPlaceholderContent());
        }
      });
  }

  async patchThirdPartyMain() {
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'run_third_party_main.js.patch'));
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'node.cc.patch'));
  }

  async patchNodeCompileIssues() {
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'node.gyp.patch'));

    if (isWindows) {
      await patchFile(this.nodeSrcDir, join(this.patchDir, 'vcbuild.bat.patch'));
      await patchFile(this.nodeSrcDir, join(this.patchDir, 'v8config.patch'));
      // The following patches fix the memory leak when using pointer compression
      // They are fixing both Linux and Windows, however, we only apply them to Windows to keep the blast radius small
      await patchFile(this.nodeSrcDir, join(this.patchDir, 'configure.py.patch'));
      await patchFile(this.nodeSrcDir, join(this.patchDir, 'node_buffer.cc.patch'));
      await patchFile(this.nodeSrcDir, join(this.patchDir, 'v8_backing_store_callers.patch'));
    }

    if (isLinux) {
      await patchFile(this.nodeSrcDir, join(this.patchDir, 'no_rand_on_glibc.patch'));
    }
  }

  async patchNodePerformance() {
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'json-stringifier.cc.patch'));
    await patchFile(this.nodeSrcDir, join(this.patchDir, 'end-of-stream.js.patch'));
    await patchFile(this.nodeSrcDir, join(this.patchDir, 't1_lib.c.patch'));
  }

  async applyPatches() {
    await this.patchThirdPartyMain();
    await this.patchNodeCompileIssues();
    await this.patchNodePerformance();
  }

  printDiskUsage() {
    if (isWindows) {
      const parsedPath = parse(this.resultFile);
      return runCommand('fsutil', ['volume', 'diskfree', parsedPath.root]);
    }
    return runCommand('df', ['-h']);
  }

  buildInContainer(ptrCompression) {
    const containerTag = `cribl/js2bin-builder:${this.builderImageVersion}`;
    return runCommand(
      'docker', ['run',
        '-v', `${process.cwd()}:/js2bin/`,
        '-t', containerTag,
        '/bin/bash', '-c',
        `source /opt/rh/devtoolset-10/enable && cd /js2bin && npm install && ./js2bin.js --ci --node=${this.version} --size=${this.placeHolderSizeMB}MB ${this.commitHash ? `--commitHash=${this.commitHash}` : ''} ${ptrCompression ? '--pointer-compress=true' : ''}`
      ]
    );
  }

  buildInContainerNonX64(arch, ptrCompression) {
    const containerTag = `cribl/js2bin-builder:${this.builderImageVersion}-nonx64`;
    return runCommand(
      'docker', ['run',
        '--platform', arch,
        '-v', `${process.cwd()}:/js2bin/`,
        '-t', containerTag,
        '/bin/bash', '-c',
          `source /opt/rh/devtoolset-10/enable && cd /js2bin && npm install && ./js2bin.js --ci --node=${this.version} --size=${this.placeHolderSizeMB}MB ${this.commitHash ? `--commitHash=${this.commitHash}` : ''} ${ptrCompression ? '--pointer-compress=true' : ''}`
      ]
    );
  }

  // 1. download node source
  // 2. expand node version
  // 3. install _third_party_main.js
  // 4. process mainAppFile (gzip, base64 encode it) - could be a placeholder file
  // 5. kick off ./configure & build
  buildFromSource(uploadBuild, cache, container, arch, ptrCompression) {
    const makeArgs = isWindows ? ['x64', 'no-cctest'] : [`-j${os.cpus().length}`];
    const configArgs = [];
    if(ptrCompression) {
      if(isWindows) makeArgs.push('v8_ptr_compress');
      else          configArgs.push('--experimental-enable-pointer-compression');
    }
    return this.printDiskUsage()
      .then(() => this.commitHash ? this.downloadExpandNodeSourceWithCommit() : this.downloadExpandNodeSource())
      .then(() => this.prepareNodeJsBuild())
      .then(() => {
        if (isWindows) { return runCommand(this.make, makeArgs, this.nodeSrcDir); }
        if (isDarwin) {
          let buildArch = darwinArch[NodeJsBuilder.getArch(arch)];
          if (!buildArch) {
            log(`Unrecogized arch '${arch}' for darwin, but we'll try it anyway`);
            buildArch = arch;
          }
          configArgs.push(`--dest-cpu=${buildArch}`);
          // For some reason, configure.py does not set these when given the
          // --dest-cpu argument. Maybe we can patch it to do so?
          makeArgs.push(`CPPFLAGS=-arch ${buildArch}`, `LDFLAGS=-arch ${buildArch}`);
          return runCommand(this.configure, configArgs, this.nodeSrcDir)
            .then(() => runCommand(this.make, makeArgs, this.nodeSrcDir));
        }

        if (!container) {
          const cfgMakeEnv = { ...process.env };
          cfgMakeEnv.LDFLAGS = '-lrt'; // needed for node 12 to be compiled with this old compiler https://github.com/nodejs/node/issues/30077#issuecomment-574535342
          return runCommand(this.configure, configArgs, this.nodeSrcDir, cfgMakeEnv)
            .then(() => runCommand(this.make, makeArgs, this.nodeSrcDir, cfgMakeEnv));
        }
        if (arch !== 'linux/amd64') {
          return this.buildInContainerNonX64(arch, ptrCompression);
        }
        return this.buildInContainer(ptrCompression);
      })
      .then(() => this.uploadNodeBinary(undefined, uploadBuild, cache, arch, ptrCompression))
      .then(() => this.printDiskUsage())
      // .then(() => this.cleanupBuild().catch(err => log(err)))
      .then(() => {
        log(`RESULTS: ${this.resultFile}`);
        return this.resultFile;
      })
      .catch(err => this.printDiskUsage().then(() => { throw err; }));
  }

  buildFromCached(platform = 'linux', arch = 'x64', outFile = undefined, cache = false, size, customDownloadUrl) {
    // Validate the signing key before any I/O so bad inputs fail fast without
    // a cache download.
    let keyPem = null;
    if (this.enableOverlay && this.signingPublicKey) {
      keyPem = fs.readFileSync(this.signingPublicKey);
      assertSupportedKey(keyPem, { type: 'public', source: this.signingPublicKey });
    }

    const mainAppFileCont = this.getAppContentToBundle();
    this.placeHolderSizeMB = Math.ceil(mainAppFileCont.length / 1024 / 1024); // 2, 4, 6, 8...
    if (this.placeHolderSizeMB % 2 !== 0) {
      this.placeHolderSizeMB += 1;
    }
    log(`main app file content size = ${mainAppFileCont.length}, place holder size MB = ${this.placeHolderSizeMB}`);

    if (size) this.placeHolderSizeMB = parseInt( size.toUpperCase().replaceAll('MB', '') )

    return this.downloadCachedBuild(platform, arch, customDownloadUrl)
      .then(cachedFile => {
        const placeholder = this.getPlaceholderContent(this.placeHolderSizeMB);

        outFile = resolve(outFile || `app-${platform}-${arch}-${this.version}`);
        const execFileCont = fs.readFileSync(cachedFile);
        if (!cache) {
          fs.unlinkSync(cachedFile);
        }

        const placeholderIdx = execFileCont.indexOf(placeholder);
        if (placeholderIdx < 0) {
          throw new Error(`Could not find placeholder in file=${cachedFile}`);
        }

        execFileCont.fill(0, placeholderIdx, placeholderIdx + placeholder.length);
        execFileCont.write(mainAppFileCont, placeholderIdx);

        if (keyPem) {
          const keyPlaceholder = this.getKeyPlaceholderContent();
          const keyIdx = execFileCont.indexOf(keyPlaceholder);
          if (keyIdx < 0) {
            throw new Error(
              `Could not find signing-key placeholder in file=${cachedFile}. ` +
              `The cached binary must be built with --ci --enable-overlay.`
            );
          }
          if (keyPem.length > keyPlaceholder.length) {
            throw new Error(
              `Signing public key (${keyPem.length} bytes) does not fit in the ` +
              `reserved ${keyPlaceholder.length}-byte placeholder.`
            );
          }
          execFileCont.fill(0, keyIdx, keyIdx + keyPlaceholder.length);
          keyPem.copy(execFileCont, keyIdx);
          log(`embedded signing public key (${keyPem.length} bytes) at offset ${keyIdx}`);
        }

        log(`writing native binary ${outFile}`);
        return mkdirp(dirname(outFile))
          .then(() => fs.writeFileSync(outFile, execFileCont));
      });
  }
}

module.exports = {
  NodeJsBuilder
};
