#!/usr/bin/env node

const { NodeJsBuilder } = require('./src/NodeBuilder');
const { log } = require('./src/util');
const fs = require('fs');

function usage(msg) {
  if(msg)
    console.log(`ERROR: ${msg}`)
  console.log(`usage: node index.js <ci|build> <node-versions> <other-ags>`);
  console.log(`ci: compile NodeJS with different pre-allocated application sizes`);
  console.log(`e.g node index.js ci 10.16.0,12.4.0 2MB,4MB,6MB`);
  console.log(`build: bundle you application into an executable`);
  console.log(`e.g node index.js build 10.16.0 mac,windows,linux /path/to/app/index.js`);
  process.exit(1);
}


function parseArgs() {
  const args = {};
  for(let i=2; i<process.argv.length; i++) {
    const arg = process.argv[i];
    if(!arg.startsWith('--')) {
      return usage(`invalid argument: ${arg}`);
    }
    if(arg === '--help') 
      return usage();

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

  console.log(args);
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
      const builder = new NodeJsBuilder(version, app);
      p = p.then(() => {
        log(`building for version=${version}, plat=${plat} app=${app}}`);
        return builder.buildFromCached(plat);
      });
    });
  });
} if(args['ci']){
  const versions = asArray(args.node);
  const sizes = asArray(args.size || '2MB').map(v => `__${v.trim().toUpperCase()}__`);
  versions.forEach(version => {
    sizes.forEach(size => {
      const builder = new NodeJsBuilder(version, size);
      p = p.then(() => {
        log(`building for version=${version}, size=${size}}`);
        return builder.buildFromSource();
      });
    });
  });
} else {
  return usage();
}
