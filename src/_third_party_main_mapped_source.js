
// Mapped-source bootstrap. Selected at build time by JS2BIN_MAPPED_SOURCE=1.
//
// The default bootstrap (_third_party_main.js) stores the app as base64(brotli(source)) and, at every
// process start, base64-decodes it, brotli-decompresses it into a large Buffer, .toString()s that into a
// JS string, and then concatenates THAT into a template literal in order to prepend the cluster preamble.
// The resulting string is what V8 keeps alive for the whole process lifetime, because it needs the source
// to lazily compile functions that have not run yet. For a ~26 MB bundle that is ~26 MB of private heap in
// every process, plus a boot peak of roughly three times that while the copies coexist.
//
// This bootstrap keeps the payload compressed in the binary -- so the placeholder and the executable do
// not grow -- but materialises the decompressed source to a file ONCE and maps it read-only. V8 then
// compiles from an external one-byte string whose bytes are file-backed and shared between the parent and
// every worker, rather than private per process.
//
// Requires internalBinding('js2bin').mapFileAsExternalString from node_mapped_source.cc.patch. If that is
// missing, or anything else fails, this falls back to the historical in-heap path rather than refusing to
// boot.
//
// Measured on a two-process Cribl Edge node (Windows, pointer compression, 17-minute settle):
// total private working set 295.2 MB -> 185.2 MB, and mean boot 2623 ms -> 2533 ms.
//
// Two rules here are load-bearing and must not be "tidied up":
//   1. Never slice the mapped string. A sliced string over an external parent can be flattened by V8 when
//      compiled, which silently reinstates the private copy this exists to remove.
//   2. Never concatenate it. The cluster preamble runs below as real code instead of being textually
//      prepended to the source, for the same reason.
//
// Not yet suitable for production; see the notes at the end of this file.

const Module = require('module');
const { brotliDecompressSync } = require('zlib');
const { join, dirname, basename } = require('path');
const fs = require('fs');
const os = require('os');

let source = process.binding('natives')._js2bin_app_main;
if (source.startsWith('`~')) {
  console.log(`js2bin binary with ${Math.floor(source.length / 1024 / 1024)}MB of placeholder content.
For more info see: js2bin --help`);
  process.exit(-1);
}

const nullIdx = source.indexOf('\0');
if (nullIdx > -1) {
  source = source.substr(0, nullIdx);
}

const parts = source.split('\n');
const appName = Buffer.from(parts[0], 'base64').toString();
const filename = join(dirname(process.execPath), `${appName.trim()}.js`);

// Cache key: distinct per payload, so a new binary never maps a stale file. The compressed payload's
// length is cheap and sufficient for a spike; production should use the embedded source hash.
const cacheDir = process.env.JS2BIN_SRC_CACHE_DIR || os.tmpdir();
const cachePath = join(cacheDir, `js2bin-src-${appName.trim()}-${parts[1].length}.js`);

let external = null;
try {
  // Materialise once. Workers spawn after the parent has booted, so in practice the parent writes and
  // the workers map. Write-to-temp-then-rename keeps a concurrent mapper from ever seeing a partial file.
  if (!fs.existsSync(cachePath)) {
    const decoded = brotliDecompressSync(Buffer.from(parts[1], 'base64'),
      { chunkSize: 128 * 1024 * 1024 });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, decoded);
    try {
      fs.renameSync(tmp, cachePath);
    } catch (err) {
      // Another process won the race; its file is equivalent.
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  external = internalBinding('js2bin').mapFileAsExternalString(cachePath);
} catch (err) {
  // Any failure falls back to the historical path rather than refusing to boot.
  process._rawDebug(`js2bin: falling back to in-heap source (${err && err.message})`);
  external = null;
}

const mod = new Module(process.execPath, null);
mod.id = '.';
mod.filename = filename;
process.mainModule = mod;

if (external !== null) {
  // Cluster setup, previously textually prepended to the source. Runs before the app's module scope,
  // which is the same ordering as the original bootstrap.
  const cluster = require('cluster');
  if (cluster.worker) {
    // NOOP - cluster worker already initialized, likely Node 12.x+
  } else if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
    cluster._setupWorker();
    delete process.env.NODE_UNIQUE_ID;
  } else {
    process.argv.splice(1, 0, filename);
  }
  mod._compile(external, filename);
} else {
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

${brotliDecompressSync(Buffer.from(parts[1], 'base64'), { chunkSize: 128 * 1024 * 1024 }).toString()}

`, filename);
}

// Remaining work before this ships:
//   - Verify the mapped bytes against a digest embedded in the signed binary before compiling. The cache
//     file is writable by anything running as the same account, so integrity must come from the signature
//     chain, not from filesystem permissions.
//   - Use a fixed, known cache directory rather than os.tmpdir(), which is per-account: an interactive run
//     and the service account produce two separate copies.
//   - Remove the visible path once mapped (FILE_FLAG_DELETE_ON_CLOSE on Windows, unlink-after-mmap on
//     POSIX) so no readable copy of the application source is left on disk.
//   - Key the cache filename on that source digest instead of the compressed payload's length.
