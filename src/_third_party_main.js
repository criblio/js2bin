
const Module = require('module');
const { gunzipSync } = require('zlib');
const { join, dirname } = require('path');


let source = process.binding('natives')['_js2bin_app_main'];
if(source.startsWith("`~")) {
  console.log(`js2bin binary with ${Math.floor(source.length/1024/1024)}MB of placeholder content.
For more info see: js2bin --help`);
  process.exit(-1);
}

const nullIdx = source.indexOf('\0');
if(nullIdx > -1) {
  source = source.substr(0, nullIdx);
}

const parts = source.split('\n');
const appName = Buffer.from(parts[0], 'base64').toString();
const filename = join(dirname(process.execPath), `${appName.trim()}.js`);

source = parts[1];

// here we turn what looks like an internal module to an non-internal one
// that way the module is loaded exactly as it would by: node app_main.js
const mod = new Module(process.execPath, null);
mod.id = '.';              // main module 
mod.filename = filename;   // dirname of this is used by require
process.mainModule = mod;  // main module
mod._compile(`

// initialize clustering
const cluster = require('cluster');
if (cluster.worker) {
   // NOOP - cluster worker already initialized, likely Node 12.x+ 
}else if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
   cluster._setupWorker()
   delete process.env.NODE_UNIQUE_ID
} else {
  process.argv.splice(1, 0, __filename); // don't mess with argv in clustering
}

${gunzipSync(Buffer.from(source, 'base64')).toString()}

`, filename);

