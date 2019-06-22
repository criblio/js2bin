
const Module = require('module');
const { gunzipSync } = require('zlib');
const { NativeModule } = require('internal/bootstrap/loaders');
const { join, dirname } = require('path');


const filename = join(dirname(process.execPath), 'app_main.js');
let source = NativeModule.getSource('app_main');
const nullIdx = source.indexOf('\0');
if(nullIdx > -1) {
  source = source.substr(0, nullIdx);
}

// here we turn what looks like an internal module to an non-internal one
// that way the module is loaded exactly as it would by: node app_main.js
new Module(process.execPath, null)._compile(`

// initialize clustering
if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
   const cluster = require('cluster')
   cluster._setupWorker()
   delete process.env.NODE_UNIQUE_ID
}

process.argv.splice(1, 0, __filename);

${gunzipSync(Buffer.from(source, 'base64')).toString()}

`, filename);

