
// Uncompressed-source bootstrap. Selected at build time by JS2BIN_UNCOMPRESSED_SOURCE=1.
//
// The default bootstrap (_third_party_main.js) stores the app as base64(brotli(source)) and, at every
// process start, base64-decodes it, brotli-decompresses it into a large Buffer, .toString()s that into a
// JS string, and concatenates THAT into a template literal to prepend the cluster preamble. The result is
// what V8 keeps alive for the whole process lifetime, since it needs the source to lazily compile
// functions that have not run yet -- so a ~26 MB bundle costs ~26 MB of private heap per process.
//
// Here the payload is stored as raw source instead. Node's own builtin loader already hands V8 an external
// one-byte string backed by the executable's read-only data, so the bytes are file-backed and shared
// rather than private, and compiling from them copies nothing. The cost is binary size: the placeholder
// has to hold the source uncompressed.
//
// Measured on a two-process Cribl Edge node (Windows, 17-minute settle): total private working set
// 308.1 MB -> 259.1 MB, and mean boot 2564 ms -> 2380 ms. Boot improves because decompression and both
// large string materialisations disappear.
//
// Two rules here are load-bearing and must not be "tidied up":
//   1. Never slice the string. The injected region is padded with a trailing line comment rather than NULs
//      precisely so no substring is needed -- a sliced string over an external parent can be flattened by
//      V8 when compiled, reinstating the private copy.
//   2. Never concatenate it. The cluster preamble runs below as real code instead of being textually
//      prepended to the source, for the same reason.

const Module = require('module');
const { join, dirname, basename } = require('path');

const source = process.binding('natives')._js2bin_app_main;

// Unmodified placeholder: the --ci binary still carries the backtick+tilde sentinel.
if (source.startsWith('`~')) {
  console.log(`js2bin binary with ${Math.floor(source.length / 1024 / 1024)}MB of placeholder content.
For more info see: js2bin --help`);
  process.exit(-1);
}

// The default bootstrap carries the app name as base64 on line 1 of the payload. Raw source has no room
// for a header without offsetting the bytes we want to hand V8 verbatim, so derive it from the binary.
const appName = basename(process.execPath).replace(/\.exe$/i, '') || 'app_main';
const filename = join(dirname(process.execPath), `${appName}.js`);

// Turn what looks like an internal module into a non-internal one, so the app loads exactly as it would
// via `node app_main.js`.
const mod = new Module(process.execPath, null);
mod.id = '.'; // main module
mod.filename = filename; // dirname of this is used by require
process.mainModule = mod;

// Cluster setup, previously textually prepended to the source. Runs before the app's module scope, which
// is the same ordering as before.
const cluster = require('cluster');
if (cluster.worker) {
  // NOOP - cluster worker already initialized, likely Node 12.x+
} else if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
  cluster._setupWorker();
  delete process.env.NODE_UNIQUE_ID;
} else {
  process.argv.splice(1, 0, filename); // don't mess with argv in clustering
}

// Compile the external string directly: no split, no base64, no brotli, no toString, no concatenation.
mod._compile(source, filename);
