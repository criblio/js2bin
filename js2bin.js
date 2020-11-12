#!/usr/bin/env node

'use strict';

const { NodeJsBuilder } = require('./src/NodeBuilder');
const { VersionInfo } = require('js2bin-version-info');
const { log } = require('./src/util');
const fs = require('fs');

function usage(msg) {
  if (msg) {
    console.log(`ERROR: ${msg}`);
  }
  console.log(`usage: ${process.argv[1]} command <command-args>
command: --build, --ci, --help
command-args: take the form of --name=value

--build: embed your application into the precompiled NodeJS binary.
  --node:     NodeJS version(s) to use, can specify more than one. 
              e.g. --node=10.16.0 --node=12.4.0
  --platform: Platform(s) to build for, can specifiy more than one. 
              e.g. --platform=linux --plaform=darwin
  --app:      Path to your (bundled) application. 
              e.g. --app=/path/to/app/index.js
  --name:     (opt) Application name
              e.g --name=MyAppSoCool
  --dir:      (opt) Working directory, if not specified use cwd
              e.g. --dir=/tmp/js2bin
  --cache     (opt) Cache any pre-built binaries used, to avoid redownload


--ci: build NodeJS with preallocated space for embedding applications
  --node: NodeJS version to build from source, can specify more than one. 
          e.g. --node=10.16.0
  --size: Amount of preallocated space, can specify more than one. 
          e.g. --size=2MB --size==4MB
  --dir:    (opt) Working directory, if not specified use cwd
  --cache:  (opt) whether to keep build in the cache (to be reused by --build)
  --upload: (opt) whether to upload node build to github releases
  --clean:  (opt) whether to clean up after the build

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
      if (Array.isArray(args[name])) {
        args[name].push(value);
      } else {
        args[name] = [args[name], value];
      }
    } else {
      args[name] = value;
    }
  }

  // console.log(args);
  if (!args.build && !args.ci) {
    return usage('must use either --build or --ci');
  }
  args.platform = (args.platform || NodeJsBuilder.platform());
  return args;
}

function asArray(val) {
  return Array.isArray(val) ? val : [val];
}

(async () => {
  const args = parseArgs();
  let p = Promise.resolve();

  if (args.build) {
    const app = args.app;
    if (!app) {
      return usage('missing required arg: --app');
    }
    if (!fs.existsSync(app)) {
      console.log(`ERROR: file not found: ${app}`);
      process.exit(1);
    }
    const versions = asArray(args.node || await new VersionInfo().get('build'));
    const plats = asArray(args.platform);
    versions.forEach(version => {
      plats.forEach(plat => {
        const builder = new NodeJsBuilder(args.dir, version, app, args.name);
        p = p.then(() => {
          log(`building for version=${version}, plat=${plat} app=${app}}`);
          const arch = 'x64';
          const outName = args.name
            ? `${args.name}-${plat}-${arch}`
            : undefined;
          return builder.buildFromCached(plat, arch, outName, args.cache);
        });
      });
    });
  } else if (args.ci) {
    const versions = asArray(args.node || await new VersionInfo().get('ci'));
    const sizes =
      asArray(args.size || '2MB').map(v => `__${v.trim().toUpperCase()}__`);
    versions.forEach(version => {
      let lastBuilder;
      sizes.forEach(size => {
        const builder = new NodeJsBuilder(args.dir, version, size);
        lastBuilder = builder;
        p = p.then(() => {
          log(`building for version=${version}, size=${size}`);
          return builder.buildFromSource(args.upload, args.cache);
        });
      });
      if (args.clean) {
        p = p.then(() => lastBuilder.cleanupBuild().catch(err => log(err)));
      }
    });
  } else {
    return usage();
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
