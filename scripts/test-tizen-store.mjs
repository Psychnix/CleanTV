// Two-slot CleanTV storage with a synthetic localStorage. No TV, browser or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const sources = ['sha256.js', 'tizen-store.js'].map(name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8'));
const P = 'cleantv.addons.v1', A = P + '.a', B = P + '.b', FAILED = /^Error: Could not save add-ons\.$/;
const hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const record = (seq, data, extra) => JSON.stringify({ v: 1, seq, sum: hex(JSON.stringify(data)), data: JSON.stringify(data), ...extra });
// Earlier Home preferences in their exact stored form; the store must never touch them.
const HOME = { 'cleantv.home.v1': '{"bg":"photo","home":["netflix"]}', 'cleanframe.home.v1': '{"dock":["youtube"]}', 'cleanframe.shore.v1': '{"theme":"shore"}' };

function storage(seed = {}) {
  const map = new Map(Object.entries(seed)), log = [];
  return {
    map, log, quota: false, mangle: null,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      log.push(['set', key]);
      if (this.quota) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      map.set(key, this.mangle ? this.mangle(String(value)) : String(value));
    },
    removeItem(key) { log.push(['remove', key]); map.delete(key); }
  };
}
function store(local) {
  const window = { Uint8Array };
  if (local !== undefined) Object.defineProperty(window, 'localStorage', typeof local === 'function' ? { get: local } : { value: local });
  const context = vm.createContext({ window });
  for (const source of sources) vm.runInContext(source, context);
  return window.CleanTVStore;
}
const slot = (local, key) => JSON.parse(local.map.get(key));

test('writes alternate between the two slots with an increasing sequence', () => {
  const local = storage(), s = store(local);
  assert.equal(s.read(P), null);
  assert.equal(s.write(P, { n: 1 }), true);
  assert.deepEqual(slot(local, A), { v: 1, seq: 1, sum: hex('{"n":1}'), data: '{"n":1}' });
  assert.equal(local.map.has(B), false);
  s.write(P, { n: 2 });
  assert.deepEqual([slot(local, A).seq, slot(local, B).seq], [1, 2]);
  s.write(P, { n: 3, text: 'Grüße 🎵' });
  assert.deepEqual([slot(local, A).seq, slot(local, B).seq], [3, 2]);
  assert.equal(local.map.get(A), record(3, { n: 3, text: 'Grüße 🎵' }), 'exact record format and UTF-8 sum');
  assert.deepEqual(plain(s.read(P)), { n: 3, text: 'Grüße 🎵' });
  s.write(P, { n: 4 });
  assert.deepEqual(plain(s.read(P)), { n: 4 });
  assert.equal(slot(local, B).seq, 4);
});

test('a corrupt newest slot falls back to the older one', () => {
  for (const broken of [
    JSON.stringify({ v: 1, seq: 9, sum: 'f'.repeat(64), data: '{"n":9}' }),
    JSON.stringify({ v: 1, seq: 9, sum: hex('{"n":9'), data: '{"n":9' }),
    JSON.stringify({ v: 0, seq: 9, sum: hex('{"n":9}'), data: '{"n":9}' }),
    JSON.stringify({ seq: 9, sum: hex('{"n":9}'), data: '{"n":9}' }),
    JSON.stringify({ v: 1, seq: 0, sum: hex('{"n":9}'), data: '{"n":9}' }),
    JSON.stringify({ v: 1, seq: 9.5, sum: hex('{"n":9}'), data: '{"n":9}' }),
    JSON.stringify({ v: 1, seq: '9', sum: hex('{"n":9}'), data: '{"n":9}' }),
    JSON.stringify({ v: 1, seq: 9, sum: hex('{"n":9}'), data: { n: 9 } }),
    '{"v":1,"seq":9,', 'null', '"text"', ''
  ]) {
    const local = storage({ [A]: record(4, { n: 4 }), [B]: broken }), s = store(local);
    assert.deepEqual(plain(s.read(P)), { n: 4 }, broken);
    // The next write replaces the broken slot and keeps the valid one.
    s.write(P, { n: 5 });
    assert.equal(local.map.get(A), record(4, { n: 4 }));
    assert.equal(slot(local, B).seq, 5);
  }
});

test('two corrupt slots read as nothing and the next write starts again', () => {
  const local = storage({ [A]: 'garbage', [B]: JSON.stringify({ v: 1, seq: 3, sum: '0'.repeat(64), data: '{}' }) }), s = store(local);
  assert.equal(s.read(P), null);
  s.write(P, { fresh: true });
  assert.deepEqual(slot(local, A).seq, 1);
  assert.deepEqual(plain(s.read(P)), { fresh: true });
});

test('a quota error keeps the previous record intact', () => {
  const local = storage(), s = store(local);
  s.write(P, { n: 1 }); s.write(P, { n: 2 });
  const before = new Map(local.map);
  local.quota = true;
  assert.throws(() => s.write(P, { n: 3 }), FAILED);
  assert.deepEqual(local.map, before);
  local.quota = false;
  assert.deepEqual(plain(s.read(P)), { n: 2 });
});

test('a read-back mismatch is removed and the previous record stays', () => {
  const local = storage(), s = store(local);
  s.write(P, { n: 1 });
  const previous = local.map.get(A);
  for (const mangle of [value => value.slice(0, -3), value => value.replace(/2/g, '7'), value => value + ' ']) {
    local.mangle = mangle;
    assert.throws(() => s.write(P, { n: 2 }), FAILED);
    assert.equal(local.map.get(A), previous);
    assert.equal(local.map.has(B), false, 'the mangled copy cannot win a later read');
    local.mangle = null;
    assert.deepEqual(plain(s.read(P)), { n: 1 });
  }
});

test('the data budget is 131072 characters per slot', () => {
  const local = storage(), s = store(local), fits = 'x'.repeat(131072 - 2);
  assert.equal(s.write(P, fits), true);
  assert.equal(JSON.parse(slot(local, A).data).length, 131070);
  const writes = local.log.length;
  assert.throws(() => s.write(P, fits + 'y'), FAILED);
  assert.equal(local.log.length, writes, 'an oversized record is never written');
  assert.equal(plain(s.read(P)), fits);
});

test('values that cannot be stored are refused', () => {
  const s = store(storage()), circular = {};
  circular.self = circular;
  assert.throws(() => s.write(P, circular), FAILED);
  assert.throws(() => s.write(P, undefined), FAILED);
  assert.throws(() => s.write(P, () => 1), FAILED);
});

test('a slot in a newer format is read-only', () => {
  const newer = JSON.stringify({ v: 2, seq: 50, sum: 'x', data: 'later format' });
  for (const seed of [{ [A]: record(3, { n: 3 }), [B]: newer }, { [A]: newer, [B]: record(3, { n: 3 }) }]) {
    const local = storage(seed), s = store(local), before = new Map(local.map);
    assert.deepEqual(plain(s.read(P)), { n: 3 }, 'the v1 record is still read');
    assert.throws(() => s.write(P, { n: 4 }), FAILED);
    assert.deepEqual(local.map, before);
    assert.deepEqual(local.log, []);
  }
  assert.equal(store(storage({ [A]: newer })).read(P), null);
});

test('clear removes only its two slots', () => {
  const local = storage({ ...HOME, 'cleantv.weather.v1.a': record(1, { city: 'Berlin' }) }), s = store(local);
  s.write(P, { n: 1 }); s.write(P, { n: 2 });
  s.clear(P);
  assert.equal(s.read(P), null);
  assert.deepEqual([...local.map.keys()].sort(), [...Object.keys(HOME), 'cleantv.weather.v1.a'].sort());
});

test('Home preference keys are never read, written or removed', () => {
  const local = storage(HOME), s = store(local);
  const reads = [];
  const getItem = local.getItem.bind(local);
  local.getItem = key => { reads.push(key); return getItem(key); };
  for (const prefix of ['cleantv.addons.v1', 'cleantv.wallpapers.v1', 'cleantv.weather.v1', 'cleantv.spotify.v1']) {
    s.write(prefix, { prefix }); s.write(prefix, { prefix, again: true });
    assert.deepEqual(plain(s.read(prefix)), { prefix, again: true });
  }
  s.clear('cleantv.spotify.v1');
  for (const bad of ['cleantv.home.v1', 'cleantv.home', 'cleanframe.home.v1', 'cleanframe.shore.v1', 'cleantv.home.v1.a', '', 'cleantv..v1', 'other.addons.v1', null, 7]) {
    assert.equal(s.read(bad), null);
    assert.throws(() => s.write(bad, { x: 1 }), FAILED);
    s.clear(bad);
  }
  for (const [key, value] of Object.entries(HOME)) assert.equal(local.map.get(key), value, key + ' is byte-identical');
  const touched = new Set(local.log.map(([, key]) => key).concat(reads));
  for (const key of Object.keys(HOME)) assert.equal(touched.has(key), false, key + ' was accessed');
  for (const key of touched) assert.match(key, /^cleantv\.(addons|wallpapers|weather|spotify)\.v1\.[ab]$/);
});

test('missing or blocked storage reads nothing and refuses writes', () => {
  for (const local of [null, () => { throw new Error('SecurityError'); }]) {
    const s = store(local);
    assert.equal(s.read(P), null);
    assert.throws(() => s.write(P, { n: 1 }), FAILED);
    s.clear(P);
  }
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const s = store(throwing);
  assert.equal(s.read(P), null);
  assert.throws(() => s.write(P, { n: 1 }), FAILED);
  s.clear(P);
});
