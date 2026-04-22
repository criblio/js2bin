#!/usr/bin/env node

const { NodeJsBuilder } = require('./src/NodeBuilder');
const { OverlayBuilder } = require('./src/OverlayBuilder');
const { log } = require('./src/util');
const fs = require('fs');

function usage(msg) {
  if (msg) { console.log(`ERROR: ${msg}`); }
  console.log(`usage: ${process.argv[1]} command <command-args>
command: --build, --ci, --overlay, --help
command-args: take the form of --name=value

--build: embed your application into the precompiled NodeJS binary.
  --node:     NodeJS version(s) to use, can specify more than one.
              e.g. --node=10.16.0 --node=12.4.0
  --platform: Platform(s) to build for, can specify more than one.
              e.g. --platform=linux --platform=darwin
  --app:      Path to your (bundled) application.
              e.g. --app=/path/to/app/index.js
  --name:     (opt) Application name
              e.g --name=MyAppSoCool
  --dir:      (opt) Working directory, if not specified use cwd
              e.g. --dir=/tmp/js2bin
  --cache     (opt) Cache any pre-built binaries used, to avoid redownload
  --arch:     (opt) Architecture to build for
  --build-version: (opt) Build version identifier (default: v1)
              e.g. --build-version=v2
  --download-url: (opt) Custom URL to download pre-built binaries from
                e.g. --download-url=https://example.com/binaries/
  --enable-overlay: (opt) Use an overlay-enabled cached binary (built via --ci --enable-overlay).
                    Disabled by default.
  --signing-public-key: Path to ECDSA P-256 public key PEM file to embed into
                the binary. Required with --enable-overlay.
                e.g. --signing-public-key=/path/to/overlay-signing.pub

--overlay: build a signed overlay bundle from a JS application
  --app:      Path to your (bundled) application
              e.g. --app=/path/to/app/index.js
  --signing-key: Path to ECDSA P-256 private key PEM file for signing
              e.g. --signing-key=/path/to/overlay-signing.key
  --output:   (opt) Output directory (default: ./overlay-bundle/)
              e.g. --output=/path/to/output

--ci: build NodeJS with preallocated space for embedding applications
  --node: NodeJS version to build from source, can specify more than one.
          e.g. --node=10.16.0
  --size: Amount of preallocated space, can specify more than one.
          e.g. --size=2MB --size=4MB
  --commitHash: (opt) Git commit hash to build from. It's useful for building NodeJS from a specific commit hash instead of a versioned release.
  --dir:       (opt) Working directory, if not specified use cwd
  --cache:     (opt) whether to keep build in the cache (to be reused by --build)
  --upload:    (opt) whether to upload node build to github releases
  --clean:     (opt) whether to clean up after the build
  --container: (opt) build using builder container rather than local dev tools
  --arch:      (opt) build on a specific architecture
  --pointer-compress:  (opt) whether to enable pointer compression
  --enable-overlay: (opt) Compile the overlay runtime into the binary. Without this,
                    no overlay code exists in the binary. The resulting binary
                    has no embedded signing key — use --build --signing-public-key
                    to stamp one in.

--help: print this help message
`);
  process.exit(1);
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) {
      return usage(`invalid argument: ${arg}`);
    }

    if (arg === '--help') {
      return usage();
    }

    const parts = arg.substr(2).split('=', 2);
    const name = parts[0];
    const value = parts.length === 1 ? true : parts[1];
    if (args[name] !== undefined) {
      if (Array.isArray(args[name])) { args[name].push(value); } else { args[name] = [args[name], value]; }
    } else {
      args[name] = value;
    }
  }

  // console.log(args);
  if (!args.build && !args.ci && !args.overlay) {
    return usage('must use either --build, --ci, or --overlay');
  }
  args.node = (args.node || '10.16.0');
  args.platform = (args.platform || NodeJsBuilder.platform());
  args.container = (args.container || false);
  args.ptrCompression = (args['pointer-compress'] == 'true');
  args.buildVersion = (args['build-version'] || 'v1');
  args.downloadUrl = (args['download-url'] || undefined);
  args.enableOverlay = (args['enable-overlay'] === true);
  args.signingPublicKey = (args['signing-public-key'] || undefined);
  if (args.signingPublicKey && !args.enableOverlay) {
    return usage('--signing-public-key requires --enable-overlay');
  }
  if (args.signingPublicKey && !args.build) {
    return usage('--signing-public-key is only supported with --build (key is embedded at build time)');
  }
  if (args.build && args.enableOverlay && !args.signingPublicKey) {
    return usage('--build --enable-overlay requires --signing-public-key');
  }
  return args;
}

function asArray(val) {
  return Array.isArray(val) ? val : [val];
}

const args = parseArgs();
let p = Promise.resolve();

if (args.build) {
  const app = args.app;
  if (!app) usage('missing required arg: --app');
  if (!fs.existsSync(app)) {
    console.log(`ERROR: file not found: ${app}`);
    process.exit(1);
  }

  const versions = asArray(args.node);
  const plats = asArray(args.platform);
  versions.forEach(version => {
    plats.forEach(plat => {
      const builder = new NodeJsBuilder(args.dir, version, app, args.name, undefined, args.buildVersion, undefined, args.signingPublicKey, args.enableOverlay);
      p = p.then(() => {
        const arch = args.arch || 'x64';
        log(`building for version=${version}, plat=${plat} app=${app}} arch=${arch}`);
        const outName = args.name ? `${args.name}-${plat}-${arch}` : undefined;
        return builder.buildFromCached(plat, arch, outName, args.cache, args.size, args.downloadUrl);
      });
    });
  });
  p = p.catch(err => { log(err); process.exitCode = 1; });
} else if (args.overlay) {
  const app = args.app;
  if (!app) usage('missing required arg: --app');
  if (!fs.existsSync(app)) {
    console.log(`ERROR: file not found: ${app}`);
    process.exit(1);
  }
  if (!args['signing-key']) usage('missing required arg: --signing-key');

  const builder = new OverlayBuilder({
    app,
    signingKey: args['signing-key'],
    output: args.output || undefined,
  });

  try {
    builder.build();
  } catch (err) {
    log(err);
    process.exitCode = 1;
  }
} else if (args.ci) {
  const versions = asArray(args.node);
  const archs = asArray(args.arch || 'x64');
  const sizes = asArray(args.size || '2MB').map(v => `__${v.trim().toUpperCase()}__`);
  versions.forEach(version => {
    let lastBuilder;
    sizes.forEach(size => {
      archs.forEach(arch => {
        const builder = new NodeJsBuilder(args.dir, version, size, undefined, undefined, args.buildVersion, args.commitHash, undefined, args.enableOverlay);
        lastBuilder = builder;
        p = p.then(() => {
          log(`building for version=${version}, size=${size} arch=${arch}`);
          return builder.buildFromSource(args.upload, args.cache, args.container, arch, args.ptrCompression);
        });
      });
    });
    if (args.clean) { p = p.then(() => lastBuilder.cleanupBuild().catch(err => log(err))); }
  });
  p = p.catch(err => { log(err); process.exitCode = 1; });
} else {
  usage();
}
