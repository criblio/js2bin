#!/usr/bin/env node

const { NodeJsBuilder } = require('./src/NodeBuilder');
const { log } = require('./src/util');
const fs = require('fs');

function usage(msg) {
  if(msg)
    console.log(`ERROR: ${msg}`)
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
  --name:     Application name (optional)

--ci: build NodeJS with preallocated space for embedding applications
  --node: NodeJS version to build from source, can specify more than one. 
          e.g. --node=10.16.0
  --size: Amount of preallocated space, can specify more than one. 
          e.g. --size=2MB --size==4MB

--help: print this help message
`);
  process.exit(1);
}


function parseArgs() {
  const args = {};
  for(let i=2; i<process.argv.length; i++) {
    const arg = process.argv[i];
    if(!arg.startsWith('--')) {
      return usage(`invalid argument: ${arg}`);
    }

    if(arg === '--help'){
      return usage();
    }

    const parts = arg.substr(2).split('=', 2);
    const name = parts[0];
    const value = parts.length === 1 ? true : parts[1];
    if(args[name] !== undefined) {
      if(Array.isArray(args[name])) 
        args[name].push(value);
      else
        args[name] = [args[name], value]
    } else {
      args[name] = value;
    }
  }

  // console.log(args);
  if(!args['build'] && !args['ci']) {
    return usage(`must use either --build or --ci`);
  }
  args.node = (args.node || '10.16.0');
  args.platform = (args.platform || NodeJsBuilder.platform());
  return args;
}

function asArray(val) {
  return Array.isArray(val) ? val : [val];
}

const args = parseArgs();
let p = Promise.resolve();

if(args['build']) {
  const app = args.app;
  if(!app) return usage('missing required arg: --app');
  if(!fs.existsSync(app)) {
    console.log(`ERROR: file not found: ${app}`);
    process.exit(1);
  }

  const versions = asArray(args.node);
  const plats = asArray(args.platform);
  versions.forEach(version => {
    plats.forEach(plat => {
      const builder = new NodeJsBuilder(version, app, args.name);
      p = p.then(() => {
        log(`building for version=${version}, plat=${plat} app=${app}}`);
        const arch = 'x64';
        const outName = args.name ? `${args.name}-${plat}-${arch}` : undefined;
        return builder.buildFromCached(plat, arch, outName);
      });
    });
  });
} else if(args['ci']){
  const versions = asArray(args.node);
  const sizes = asArray(args.size || '2MB').map(v => `__${v.trim().toUpperCase()}__`);
  versions.forEach(version => {
    sizes.forEach(size => {
      const builder = new NodeJsBuilder(version, size);
      p = p.then(() => {
        log(`building for version=${version}, size=${size}`);
        return builder.buildFromSource();
      });
    });
  });
} else {
  return usage();
}
