const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { download, getExpectedSha256, __setGithubHostsForTest } = require('../src/util');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function tmpFile(name = 'js2bin-dl-test') {
  return path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('getExpectedSha256', () => {
  let apiServer;
  let apiBase;
  let lastApiPath;
  let apiResponse;

  before(async () => {
    apiServer = await startServer((req, res) => {
      lastApiPath = req.url;
      if (apiResponse instanceof Error) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(typeof apiResponse === 'string' ? apiResponse : JSON.stringify(apiResponse));
    });
    apiBase = `http://127.0.0.1:${apiServer.address().port}`;
    __setGithubHostsForTest({ releaseHost: 'github.com', apiBase });
  });

  after(async () => {
    __setGithubHostsForTest({ releaseHost: 'github.com', apiBase: 'https://api.github.com' });
    await stopServer(apiServer);
  });

  afterEach(() => {
    apiResponse = undefined;
    lastApiPath = undefined;
  });

  it('returns null and skips the API call for non-GitHub URLs', async () => {
    apiResponse = new Error('should not be called');
    const result = await getExpectedSha256('https://nodejs.org/dist/v20.18.0/node-v20.18.0.tar.gz');
    assert.equal(result, null);
    assert.equal(lastApiPath, undefined);
  });

  it('returns lowercased hex when the matching asset publishes a sha256 digest', async () => {
    apiResponse = { assets: [
      { name: 'darwin-x64-22.22.0-v1-4MB', digest: 'sha256:6AB6DB56627A265924468491817B0D0220DE27181F3F16EAEB2D76A6101102F9' },
      { name: 'darwin-arm64-22.22.0-v1-4MB', digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }
    ] };
    const result = await getExpectedSha256(
      'https://github.com/criblio/js2bin/releases/download/v1.0.9/darwin-x64-22.22.0-v1-4MB'
    );
    assert.equal(result, '6ab6db56627a265924468491817b0d0220de27181f3f16eaeb2d76a6101102f9');
    assert.equal(lastApiPath, '/repos/criblio/js2bin/releases/tags/v1.0.9');
  });

  it('returns null when the matching asset has no digest field (older asset)', async () => {
    apiResponse = { assets: [{ name: 'old-asset', /* no digest */ }] };
    const result = await getExpectedSha256(
      'https://github.com/criblio/js2bin/releases/download/v1.0.9/old-asset'
    );
    assert.equal(result, null);
  });

  it('returns null when the digest is not sha256 (e.g. sha512)', async () => {
    apiResponse = { assets: [{ name: 'asset', digest: 'sha512:' + 'a'.repeat(128) }] };
    const result = await getExpectedSha256(
      'https://github.com/criblio/js2bin/releases/download/v1.0.9/asset'
    );
    assert.equal(result, null);
  });

  it('returns null when the asset is not in the release', async () => {
    apiResponse = { assets: [{ name: 'something-else', digest: 'sha256:' + 'a'.repeat(64) }] };
    const result = await getExpectedSha256(
      'https://github.com/criblio/js2bin/releases/download/v1.0.9/missing-asset'
    );
    assert.equal(result, null);
  });

  it('URL-decodes the asset name before matching', async () => {
    const digest = 'b'.repeat(64);
    apiResponse = { assets: [{ name: 'name with spaces+plus', digest: `sha256:${digest}` }] };
    const result = await getExpectedSha256(
      'https://github.com/criblio/js2bin/releases/download/v1.0.9/name%20with%20spaces%2Bplus'
    );
    assert.equal(result, digest);
  });

  it('rejects when the API returns malformed JSON', async () => {
    apiResponse = 'not json {';
    await assert.rejects(
      getExpectedSha256('https://github.com/criblio/js2bin/releases/download/v1.0.9/asset'),
      /JSON/i
    );
  });
});

describe('download', () => {
  // Two servers: one serves the binary, the other serves the GitHub Releases
  // API response. Both bind on 127.0.0.1:0; tests rewrite `download`'s notion
  // of GitHub hosts via __setGithubHostsForTest so URL pattern detection
  // matches the binary server's host.
  let dlServer, apiServer;
  let dlHost, apiBase;
  let dlHandler, apiHandler;

  before(async () => {
    dlServer = await startServer((req, res) => dlHandler(req, res));
    apiServer = await startServer((req, res) => apiHandler(req, res));
    dlHost = `127.0.0.1:${dlServer.address().port}`;
    apiBase = `http://127.0.0.1:${apiServer.address().port}`;
    __setGithubHostsForTest({ releaseHost: dlHost, apiBase });
  });

  after(async () => {
    __setGithubHostsForTest({ releaseHost: 'github.com', apiBase: 'https://api.github.com' });
    await stopServer(dlServer);
    await stopServer(apiServer);
  });

  function downloadUrl(asset) {
    return `http://${dlHost}/criblio/js2bin/releases/download/v1.0.9/${asset}`;
  }

  function serveBytes(bytes) {
    dlHandler = (req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(bytes);
    };
  }

  function serveApi(payload) {
    apiHandler = (req, res) => {
      if (payload === 'boom') { res.statusCode = 500; res.end('boom'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
  }

  it('resolves and writes the file when the sha256 matches the published digest', async () => {
    const bytes = Buffer.from('hello world');
    serveBytes(bytes);
    serveApi({ assets: [{ name: 'asset-ok', digest: `sha256:${sha256Hex(bytes)}` }] });

    const dest = tmpFile();
    try {
      const result = await download(downloadUrl('asset-ok'), dest);
      assert.equal(result, dest);
      assert.deepEqual(fs.readFileSync(dest), bytes);
    } finally {
      try { fs.unlinkSync(dest); } catch {}
    }
  });

  it('rejects with ERR_CHECKSUM_MISMATCH and removes the partial file on mismatch', async () => {
    const bytes = Buffer.from('actual bytes that hash to something');
    serveBytes(bytes);
    serveApi({ assets: [{ name: 'asset-bad', digest: 'sha256:' + 'a'.repeat(64) }] });

    const dest = tmpFile();
    await assert.rejects(
      download(downloadUrl('asset-bad'), dest),
      err => err.code === 'ERR_CHECKSUM_MISMATCH'
    );
    assert.equal(fs.existsSync(dest), false, 'partial file should be removed');
  });

  it('resolves with a warning when the published asset has no digest', async () => {
    const bytes = Buffer.from('payload without digest');
    serveBytes(bytes);
    serveApi({ assets: [{ name: 'asset-no-digest' }] });

    const dest = tmpFile();
    try {
      const result = await download(downloadUrl('asset-no-digest'), dest);
      assert.equal(result, dest);
      assert.deepEqual(fs.readFileSync(dest), bytes);
    } finally {
      try { fs.unlinkSync(dest); } catch {}
    }
  });

  it('resolves with a warning when the API endpoint returns 500', async () => {
    const bytes = Buffer.from('payload despite api down');
    serveBytes(bytes);
    serveApi('boom');

    const dest = tmpFile();
    try {
      const result = await download(downloadUrl('asset-api-500'), dest);
      assert.equal(result, dest);
      assert.deepEqual(fs.readFileSync(dest), bytes);
    } finally {
      try { fs.unlinkSync(dest); } catch {}
    }
  });

  it('follows redirects and verifies the final bytes against the published digest', async () => {
    const finalBytes = Buffer.from('bytes served after redirect');
    let hitCount = 0;
    dlHandler = (req, res) => {
      hitCount += 1;
      if (req.url.includes('/redirect-target')) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(finalBytes);
        return;
      }
      res.statusCode = 302;
      res.setHeader('location', `http://${dlHost}/redirect-target`);
      res.end();
    };
    serveApi({ assets: [{ name: 'asset-redirect', digest: `sha256:${sha256Hex(finalBytes)}` }] });

    const dest = tmpFile();
    try {
      const result = await download(downloadUrl('asset-redirect'), dest);
      assert.equal(result, dest);
      assert.deepEqual(fs.readFileSync(dest), finalBytes);
      assert.ok(hitCount >= 2, 'redirect should have been followed');
    } finally {
      try { fs.unlinkSync(dest); } catch {}
    }
  });

  it('hashes correctly across multiple stream chunks (large body)', async () => {
    // Larger than the default highWaterMark (16 KB) to ensure the data event
    // fires repeatedly and the hash is updated per chunk rather than once.
    const bytes = crypto.randomBytes(5 * 1024 * 1024);
    serveBytes(bytes);
    serveApi({ assets: [{ name: 'asset-large', digest: `sha256:${sha256Hex(bytes)}` }] });

    const dest = tmpFile();
    try {
      const result = await download(downloadUrl('asset-large'), dest);
      assert.equal(result, dest);
      assert.equal(fs.statSync(dest).size, bytes.length);
      assert.equal(sha256Hex(fs.readFileSync(dest)), sha256Hex(bytes));
    } finally {
      try { fs.unlinkSync(dest); } catch {}
    }
  });
});
