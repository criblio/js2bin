'use strict';

// Single source of truth for the overlay bundle.js.sig format. Used by
// OverlayBuilder at --overlay time, and compiled into overlay-enabled binaries
// as lib/_js2bin_sig_format.js (see NodeBuilder.prepareNodeJsBuild) where the
// loader require()s it. Keep this file dependency-free: it runs inside Node's
// builtin module loader.
//
// bundle.js.sig layout: MAGIC | uint16 BE compatLen | compatStr | DER signature.
// The signature covers MAGIC | uint16 BE compatLen | compatStr | bundle.

const SIG_MAGIC = Buffer.from('J2BCOMPAT1', 'ascii');

// A leading `~ would read as the unmodified-slot sentinel in the binary.
const COMPAT_STRING_RE = /^(?!`~)[\x21-\x7e]{1,64}$/;
const MAX_COMPAT_LEN = 64;

function compatHeader(compatString) {
  const compat = Buffer.from(compatString, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(compat.length);
  return Buffer.concat([SIG_MAGIC, len, compat]);
}

// Returns { header, compatString, signature } or an error string.
function parseSigFile(sigData) {
  const headerMin = SIG_MAGIC.length + 2;
  if (sigData.length < headerMin || !sigData.subarray(0, SIG_MAGIC.length).equals(SIG_MAGIC)) {
    return 'unsupported signature format';
  }
  const compatLen = sigData.readUInt16BE(SIG_MAGIC.length);
  if (compatLen > MAX_COMPAT_LEN || headerMin + compatLen > sigData.length) {
    return 'invalid signature compat string length';
  }
  return {
    header: sigData.subarray(0, headerMin + compatLen),
    compatString: sigData.subarray(headerMin, headerMin + compatLen).toString('utf8'),
    signature: sigData.subarray(headerMin + compatLen)
  };
}

module.exports = { COMPAT_STRING_RE, compatHeader, parseSigFile };
