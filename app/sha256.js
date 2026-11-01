/* SHA-256 (FIPS 180-4) for package checksums, storage sums and PKCE. Pure computation. */
(function () {
  'use strict';
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var HEX = '0123456789abcdef', B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function input(bytes) {
    if (Object.prototype.toString.call(bytes) !== '[object Uint8Array]') throw new TypeError('SHA-256 input must be a Uint8Array.');
    return bytes;
  }
  /* One 64-byte block at src[p] (FIPS 180-4 section 6.2.2). */
  function block(H, W, src, p) {
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], t, x, y, t1, t2;
    for (t = 0; t < 16; t++, p += 4) W[t] = (src[p] << 24) | (src[p + 1] << 16) | (src[p + 2] << 8) | src[p + 3];
    for (t = 16; t < 64; t++) {
      x = W[t - 15]; y = W[t - 2];
      W[t] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3))
        + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + W[t - 7] + W[t - 16] | 0;
    }
    for (t = 0; t < 64; t++) {
      t1 = h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[t] + W[t] | 0;
      t2 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c)) | 0;
      h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    H[0] = H[0] + a | 0; H[1] = H[1] + b | 0; H[2] = H[2] + c | 0; H[3] = H[3] + d | 0;
    H[4] = H[4] + e | 0; H[5] = H[5] + f | 0; H[6] = H[6] + g | 0; H[7] = H[7] + h | 0;
  }
  function digest(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64), length = input(bytes).length, full = length - length % 64, rest = length - full, tail, i, out;
    for (i = 0; i < full; i += 64) block(H, W, bytes, i);
    // Padding: 0x80, zeros, then the message length in bits as a 64-bit big-endian number.
    tail = new window.Uint8Array(rest < 56 ? 64 : 128);
    for (i = 0; i < rest; i++) tail[i] = bytes[full + i];
    tail[rest] = 0x80;
    i = tail.length;
    tail[i - 1] = (length << 3) & 0xff; tail[i - 2] = (length >>> 5) & 0xff; tail[i - 3] = (length >>> 13) & 0xff; tail[i - 4] = (length >>> 21) & 0xff;
    tail[i - 5] = Math.floor(length / 0x20000000) & 0xff; tail[i - 6] = Math.floor(length / 0x2000000000) & 0xff;
    block(H, W, tail, 0);
    if (tail.length === 128) block(H, W, tail, 64);
    out = new window.Uint8Array(32);
    for (i = 0; i < 8; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 0xff; out[i * 4 + 2] = (H[i] >>> 8) & 0xff; out[i * 4 + 3] = H[i] & 0xff; }
    return out;
  }
  function hex(bytes) {
    var s = '', i;
    for (i = 0; i < bytes.length; i++) s += HEX.charAt(bytes[i] >>> 4) + HEX.charAt(bytes[i] & 15);
    return s;
  }
  /* UTF-8 as TextEncoder produces it; a lone surrogate becomes U+FFFD. */
  function utf8(value) {
    var out = [], i, c, d;
    value = String(value);
    for (i = 0; i < value.length; i++) {
      c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && (d = value.charCodeAt(i + 1)) >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    return new window.Uint8Array(out);
  }
  function base64url(bytes) {
    var s = '', i, n;
    input(bytes);
    for (i = 0; i + 2 < bytes.length; i += 3) {
      n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
      s += B64.charAt(n >>> 18) + B64.charAt(n >>> 12 & 63) + B64.charAt(n >>> 6 & 63) + B64.charAt(n & 63);
    }
    if (bytes.length - i === 1) { n = bytes[i] << 16; s += B64.charAt(n >>> 18) + B64.charAt(n >>> 12 & 63); }
    else if (bytes.length - i === 2) { n = bytes[i] << 16 | bytes[i + 1] << 8; s += B64.charAt(n >>> 18) + B64.charAt(n >>> 12 & 63) + B64.charAt(n >>> 6 & 63); }
    return s;
  }
  window.CleanTVSha256 = {
    bytes: function (bytes) { return hex(digest(bytes)); },
    raw: digest,
    text: function (value) { return hex(digest(utf8(value))); },
    base64url: base64url,
    utf8: utf8
  };
}());
