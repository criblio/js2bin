
const { NodeJsBuilder } = require('./src/NodeBuilder');
const { log } = require('./src/util');

function usage() {
  console.log(`usage: node index.js <ci|build> <node-versions> <other-ags>`);
  console.log(`ci: compile NodeJS with different pre-allocated application sizes`);
  console.log(`e.g node index.js ci 10.16.0,12.4.0 2MB,4MB,6MB`);
  console.log(`build: bundle you application into an executable`);
  console.log(`e.g node index.js build 10.16.0 mac,windows,linux /path/to/app/index.js`);
}

const cmd = process.argv[2];
const versions = (process.argv[3] || '10.16.0').split(',').map(v => v.trim());
let p = Promise.resolve();

if(cmd === 'ci') {
  const sizes = (process.argv[4] || '2MB').split(',').map(v => `__${v.trim().toUpperCase()}__`);
  versions.forEach(version => {
    sizes.forEach(size => {
      const builder = new NodeJsBuilder(version, size);
      p = p.then(() => {
        log(`building for version=${version}, size=${size}}`);
        return builder.buildFromSource();
      });
    });
  });
} else if(cmd === 'build') {
  const plats = (process.argv[4] || NodeJsBuilder.platform()).split(',').map(v => v.trim());
  const app = process.argv[5];
  versions.forEach(version => {
    plats.forEach(plat => {
      const builder = new NodeJsBuilder(version, app);
      p = p.then(() => {
        log(`building for version=${version}, plat=${plat} app=${app}}`);
        return builder.buildFromCached(plat);
      });
    });
  });
} else {
  return usage();
}
