// SHA-256 in app/sha256.js against FIPS 180-4 vectors, node:crypto and RFC 7636. No network.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/sha256.js', import.meta.url), 'utf8');
const window = { Uint8Array };
vm.runInNewContext(source, { window });
const sha = window.CleanTVSha256;
const node = bytes => createHash('sha256').update(bytes).digest('hex');
const u8 = text => new Uint8Array(Buffer.from(text, 'utf8'));

test('FIPS 180-4 and NIST example vectors', () => {
  assert.equal(sha.bytes(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha.text(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha.text('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha.text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha.text('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'), 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
});

test('one million a and larger random data', () => {
  assert.equal(sha.bytes(new Uint8Array(1000000).fill(0x61)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  const large = new Uint8Array(randomBytes(3 * 65536 + 17));
  assert.equal(sha.bytes(large), node(large));
});

test('every padding boundary and random inputs match node:crypto', () => {
  for (let length = 0; length <= 200; length++) {
    const bytes = new Uint8Array(randomBytes(length));
    assert.equal(sha.bytes(bytes), node(bytes), 'length ' + length);
  }
  for (let i = 0; i < 200; i++) {
    const bytes = new Uint8Array(randomBytes(Math.floor(Math.random() * 5000)));
    assert.equal(sha.bytes(bytes), node(bytes));
  }
  // Values with the high bit set exercise the signed shifts.
  assert.equal(sha.bytes(new Uint8Array(129).fill(0xff)), node(Buffer.alloc(129, 0xff)));
});

test('raw returns 32 bytes; a typed-array view hashes only its range', () => {
  const raw = sha.raw(u8('abc'));
  assert.equal(Object.prototype.toString.call(raw), '[object Uint8Array]');
  assert.equal(raw.length, 32);
  assert.equal(Buffer.from(raw).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const backing = new Uint8Array([1, 2, 0x61, 0x62, 0x63, 9]);
  assert.equal(sha.bytes(backing.subarray(2, 5)), node(Buffer.from('abc')));
});

test('text hashes UTF-8 as TextEncoder encodes it', () => {
  for (const value of ['Grüße aus Köln', '日本語', 'emoji 🎵🎶', 'lone \ud800 surrogate', 'end \udc00', '\u0000\u007f\u0080߿ࠀ￿']) {
    assert.equal(sha.text(value), node(Buffer.from(new TextEncoder().encode(value))), JSON.stringify(value));
    assert.deepEqual(Array.from(sha.utf8(value)), Array.from(new TextEncoder().encode(value)));
  }
});

test('base64url has the URL alphabet and no padding', () => {
  for (let length = 0; length <= 70; length++) {
    const bytes = new Uint8Array(randomBytes(length));
    assert.equal(sha.base64url(bytes), Buffer.from(bytes).toString('base64url'), 'length ' + length);
  }
  assert.equal(sha.base64url(new Uint8Array([0xfb, 0xff, 0xfe])), '-__-');
});

test('RFC 7636 Appendix B: S256 code challenge', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(sha.base64url(sha.raw(sha.utf8(verifier))), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(sha.base64url(sha.raw(u8(verifier))), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('inputs other than Uint8Array are rejected', () => {
  for (const value of [undefined, null, 'abc', [1, 2, 3], new Uint16Array(2), new ArrayBuffer(4)]) {
    assert.throws(() => sha.bytes(value), /SHA-256 input must be a Uint8Array\./);
    assert.throws(() => sha.base64url(value), /SHA-256 input must be a Uint8Array\./);
  }
});
