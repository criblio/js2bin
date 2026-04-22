const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { assertSupportedKey } = require('../src/util');

function genP256() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function genP384() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp384r1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function genRSA() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function genEd25519() {
  return crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

function expectThrowsWithCode(fn, expectedCode) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, expectedCode, `expected code=${expectedCode}, got=${err.code} (${err.message})`);
    return;
  }
  assert.fail(`expected throw with code=${expectedCode}, got no throw`);
}

describe('assertSupportedKey', () => {
  // --- Happy paths ---

  it('accepts a P-256 public key', () => {
    const { publicKey } = genP256();
    assert.doesNotThrow(() => assertSupportedKey(publicKey, { type: 'public', source: 'test.pub' }));
  });

  it('accepts a P-256 private key', () => {
    const { privateKey } = genP256();
    assert.doesNotThrow(() => assertSupportedKey(privateKey, { type: 'private', source: 'test.key' }));
  });

  it('accepts a P-256 public key passed as a Buffer', () => {
    const { publicKey } = genP256();
    assert.doesNotThrow(() =>
      assertSupportedKey(Buffer.from(publicKey), { type: 'public', source: 'buf.pub' })
    );
  });

  // Documents Node behavior: createPublicKey() will extract the public half
  // from a private-key PEM. A regression here would mean Node's API changed.
  it('accepts a private-key PEM when validating as public (Node derives it)', () => {
    const { privateKey } = genP256();
    assert.doesNotThrow(() =>
      assertSupportedKey(privateKey, { type: 'public', source: 'derived.pem' })
    );
  });

  // --- Unsupported algorithms ---

  it('rejects a P-384 public key with ERR_UNSUPPORTED_KEY', () => {
    const { publicKey } = genP384();
    expectThrowsWithCode(
      () => assertSupportedKey(publicKey, { type: 'public', source: 'p384.pub' }),
      'ERR_UNSUPPORTED_KEY'
    );
  });

  it('rejects a P-384 private key with ERR_UNSUPPORTED_KEY', () => {
    const { privateKey } = genP384();
    expectThrowsWithCode(
      () => assertSupportedKey(privateKey, { type: 'private', source: 'p384.key' }),
      'ERR_UNSUPPORTED_KEY'
    );
  });

  it('rejects an RSA public key with ERR_UNSUPPORTED_KEY', () => {
    const { publicKey } = genRSA();
    expectThrowsWithCode(
      () => assertSupportedKey(publicKey, { type: 'public', source: 'rsa.pub' }),
      'ERR_UNSUPPORTED_KEY'
    );
  });

  it('rejects an RSA private key with ERR_UNSUPPORTED_KEY', () => {
    const { privateKey } = genRSA();
    expectThrowsWithCode(
      () => assertSupportedKey(privateKey, { type: 'private', source: 'rsa.key' }),
      'ERR_UNSUPPORTED_KEY'
    );
  });

  it('rejects an Ed25519 public key with ERR_UNSUPPORTED_KEY', () => {
    const { publicKey } = genEd25519();
    expectThrowsWithCode(
      () => assertSupportedKey(publicKey, { type: 'public', source: 'ed25519.pub' }),
      'ERR_UNSUPPORTED_KEY'
    );
  });

  // --- Parse failures ---

  it('throws ERR_KEY_PARSE for malformed PEM', () => {
    expectThrowsWithCode(
      () => assertSupportedKey('-----BEGIN PUBLIC KEY-----\nnotvalid\n-----END PUBLIC KEY-----\n',
        { type: 'public', source: 'bad.pem' }),
      'ERR_KEY_PARSE'
    );
  });

  it('throws ERR_KEY_PARSE for empty input', () => {
    expectThrowsWithCode(
      () => assertSupportedKey('', { type: 'public', source: 'empty.pem' }),
      'ERR_KEY_PARSE'
    );
  });

  // --- Operator-debuggability smoke test ---
  // One check per error family that the `source` argument survives into the
  // message so ops can tell which key file tripped the error.

  it('includes the source path in both error families', () => {
    try {
      assertSupportedKey('', { type: 'public', source: '/a/parse/path.pem' });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err.message.includes('/a/parse/path.pem'), `parse error missing source: ${err.message}`);
    }
    try {
      assertSupportedKey(genRSA().publicKey, { type: 'public', source: '/an/unsupp/path.pub' });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err.message.includes('/an/unsupp/path.pub'), `unsupported error missing source: ${err.message}`);
    }
  });
});
