#!/usr/bin/env node

const { NodeJsBuilder } = require('./src/NodeBuilder');
const { OverlayBuilder } = require('./src/OverlayBuilder');
const { log } = require('./src/util');
const { COMPAT_STRING_RE } = require('./src/_js2bin_sig_format');
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
  --require-signature: (opt) Require a valid GPG signature on the downloaded
                binary before use. Fails hard if the signature, public key, or
                gpg tool is missing or verification fails (no silent skip).
  --gpg-signature-url: (opt) URL of the detached .asc signature (or set
                JS2BIN_GPG_SIGNATURE_URL). Defaults to the binary URL with a
                .asc suffix. Only used with --require-signature.
  --gpg-key-path: (opt) Path to the armored public key to verify against (or set
                JS2BIN_GPG_KEY_PATH). Defaults to the key committed at
                keys/release-signing.asc. Only used with --require-signature.
  --overlay-compat-string: (opt) Enable overlays and embed this opaque string
                (1-64 printable ASCII, no spaces) into the binary. Overlays with a different
                --overlay-compat-string are ignored.
                e.g. --overlay-compat-string=1.2.3
  --signing-public-key: Path to ECDSA P-256 public key PEM file to embed into
                the binary. Required with --overlay-compat-string.
                e.g. --signing-public-key=/path/to/overlay-signing.pub
  --encryption-key: (opt) Path to a file containing a 64-char hex AES-256 key to embed
                into the binary for decrypting encrypted overlay bundles (bundle.js.enc).
                Only valid with --build --overlay-compat-string.
                e.g. --encryption-key=/path/to/overlay-encryption.key

--overlay: build a signed overlay bundle from a JS application
  --app:      Path to your (bundled) application
              e.g. --app=/path/to/app/index.js
  --signing-key: Path to ECDSA P-256 private key PEM file for signing
              e.g. --signing-key=/path/to/overlay-signing.key
  --overlay-compat-string: Must equal the --overlay-compat-string of the target binary. Required.
              e.g. --overlay-compat-string=1.2.3
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
                    has no embedded signing key or compat string — use --build
                    --signing-public-key --overlay-compat-string to stamp them in.

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

    const eqIdx = arg.indexOf('=');
    const name = eqIdx < 0 ? arg.substr(2) : arg.slice(2, eqIdx);
    const value = eqIdx < 0 ? true : arg.slice(eqIdx + 1);
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
  args.requireSignature = (args['require-signature'] === true);
  args.gpgSignatureUrl = (args['gpg-signature-url'] || process.env.JS2BIN_GPG_SIGNATURE_URL || undefined);
  args.gpgKeyPath = (args['gpg-key-path'] || process.env.JS2BIN_GPG_KEY_PATH || undefined);
  args.compatString = (args['overlay-compat-string'] || undefined);
  if (args.compatString !== undefined && (typeof args.compatString !== 'string' || !COMPAT_STRING_RE.test(args.compatString))) {
    return usage('--overlay-compat-string must be 1-64 printable ASCII characters, not starting with `~');
  }
  if (args.compatString && args.ci) {
    return usage('--overlay-compat-string is only supported with --build or --overlay');
  }
  if (args.build && args['enable-overlay']) {
    return usage('--build --enable-overlay was replaced by --overlay-compat-string');
  }
  if (args.overlay && !args.compatString) {
    return usage('--overlay requires --overlay-compat-string');
  }
  args.enableOverlay = args.ci ? (args['enable-overlay'] === true) : !!(args.build && args.compatString);
  args.signingPublicKey = (args['signing-public-key'] || undefined);
  args.encryptionKey = (args['encryption-key'] || undefined);
  if (args.signingPublicKey && !args.build) {
    return usage('--signing-public-key is only supported with --build (key is embedded at build time)');
  }
  if (args.signingPublicKey && !args.enableOverlay) {
    return usage('--signing-public-key requires --overlay-compat-string');
  }
  if (args.enableOverlay && args.build && !args.signingPublicKey) {
    return usage('--overlay-compat-string requires --signing-public-key');
  }
  if (args.encryptionKey && !args.build) {
    return usage('--encryption-key is only supported with --build (key is embedded at build time)');
  }
  if (args.encryptionKey && !args.enableOverlay) {
    return usage('--encryption-key requires --overlay-compat-string');
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
      const builder = new NodeJsBuilder(args.dir, version, app, args.name, undefined, args.buildVersion, undefined, args.signingPublicKey, args.enableOverlay, args.encryptionKey, args.compatString);
      p = p.then(() => {
        const arch = args.arch || 'x64';
        log(`building for version=${version}, plat=${plat} app=${app}} arch=${arch}`);
        const outName = args.name ? `${args.name}-${plat}-${arch}` : undefined;
        const gpgVerify = args.requireSignature
          ? { sigUrl: args.gpgSignatureUrl, keyPath: args.gpgKeyPath }
          : undefined;
        return builder.buildFromCached(plat, arch, outName, args.cache, args.size, args.downloadUrl, gpgVerify);
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
    compatString: args.compatString,
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
        const builder = new NodeJsBuilder(args.dir, version, size, undefined, undefined, args.buildVersion, args.commitHash, undefined, args.enableOverlay, undefined);
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
