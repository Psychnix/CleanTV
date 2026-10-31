// Test the Tizen add-on host with a synthetic XHR, clock and localStorage. No TV or network access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8');
const SOURCES = { sha: read('sha256.js'), store: read('tizen-store.js'), host: read('tizen-addons.js') };
const BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/';
const CATALOG = BASE + 'cleantv-catalog.json';
const SHA = 'a'.repeat(64);
const STORE = 'cleantv.addons.v1';
const HOME = { 'cleantv.home.v1': '{"bg":"photo","home":["netflix","youtube"],"language":"de"}', 'cleanframe.home.v1': '{"dock":["youtube"],"wallpaper":"misty"}', 'cleanframe.shore.v1': '{"theme":"shore"}' };
const plain = value => JSON.parse(JSON.stringify(value));
const bytes = text => { const b = Buffer.from(text, 'utf8'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const hex = text => createHash('sha256').update(text, 'utf8').digest('hex');

function storage(seed = {}) {
  const map = new Map(Object.entries(seed)), log = [];
  return {
    map, log, quota: false,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { log.push(key); if (this.quota) { const e = new Error('Quota exceeded'); e.name = 'QuotaExceededError'; throw e; } map.set(key, String(value)); },
    removeItem(key) { log.push(key); map.delete(key); }
  };
}
/* kinds: [[kind, definition]] queued by a module loaded before tizen-addons.js. */
function harness({ tizen = true, platform, intl = Intl, decoder = TextDecoder, local = storage(), kinds } = {}) {
  const xhrs = [], events = [], timers = [], heard = [];
  class FakeXHR {
    constructor() { this.headers = {}; this.status = 0; this.response = null; this.responseURL = ''; xhrs.push(this); }
    open(method, url, async) { Object.assign(this, { method, url, async }); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send() { this.sent = true; }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    respond({ status = 200, body, url }) {
      this.status = status; this.response = body; this.responseURL = url === undefined ? this.url : url;
      if (this.onload) this.onload();
    }
  }
  class FakeEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const window = {
    FrameDevice: platform ? { platform } : {}, XMLHttpRequest: FakeXHR, CustomEvent: FakeEvent, Uint8Array, TextDecoder: decoder, Intl: intl, localStorage: local,
    dispatchEvent: event => events.push(event), setTimeout: callback => timers.push(callback)
  };
  if (tizen) window.tizen = { application: {} };
  if (kinds) window.CleanTVAddonKinds = { queue: kinds.slice() };
  const context = vm.createContext({ window });
  for (const source of [SOURCES.sha, SOURCES.store, SOURCES.host]) vm.runInContext(source, context);
  const flush = () => { while (timers.length) timers.shift()(); };
  const api = window.CleanTVAddons;
  api.on(detail => heard.push(detail));
  return { addons: window.FrameDevice.addons, api, kinds: window.CleanTVAddonKinds, window, xhrs, events, heard, flush, local, state: () => plain(window.FrameDevice.addons({ action: 'state' })) };
}
const pkg = (id, extra) => Object.assign({ api: 1, id, name: 'Widget ' + id, version: '1.0.0', kind: 'text', description: 'A short note', author: 'Someone', license: 'MIT', text: 'Hello' }, extra);
/* A catalog entry for a package body: the package plus its path and the checksum of its exact bytes. */
function listed(item, body = JSON.stringify(item)) { return Object.assign({}, item, { path: 'packages/' + item.id + '/' + item.version + '.json', sha256: hex(body) }); }
const widget = (id, extra) => Object.assign(pkg(id), { path: 'packages/' + id + '/1.0.0.json', sha256: SHA }, extra);
const spotify = { api: 1, id: 'spotify', name: 'Spotify', version: '1.0.0', kind: 'spotify', description: 'Player', author: 'CleanFrame', license: 'MIT', path: 'packages/spotify/1.0.0.json', sha256: SHA };
const native = { api: 2, id: 'apple-remote', name: 'iPhone Remote', version: '0.1.2', kind: 'native', description: 'Remote', author: 'CleanFrame', license: 'MIT', apkUrl: 'https://github.com/x.apk', sha256: SHA };
const catalog = addons => JSON.stringify({ api: 2, addons });
function refreshWith(h, response) {
  assert.deepEqual(plain(h.addons({ action: 'refresh' })), { ok: true });
  h.xhrs[h.xhrs.length - 1].respond(response);
  h.flush();
  return h.state();
}
/* Refresh with these packages listed, then install each one from its exact body. */
function installAll(h, items, bodies = {}) {
  refreshWith(h, { body: bytes(catalog(items.map(item => listed(item, bodies[item.id])))) });
  for (const item of items) {
    h.addons({ action: 'install', id: item.id });
    h.xhrs[h.xhrs.length - 1].respond({ body: bytes(bodies[item.id] || JSON.stringify(item)) });
    h.flush();
  }
  return h.state();
}
function installWith(h, id, response) {
  assert.deepEqual(plain(h.addons({ action: 'install', id })), { ok: true });
  const xhr = h.xhrs[h.xhrs.length - 1];
  xhr.respond(response);
  h.flush();
  return Object.assign(h.state(), { xhr });
}

test('the host stays inactive outside a Tizen TV and on Android', () => {
  for (const h of [harness({ tizen: false }), harness({ platform: 'android' })]) {
    assert.equal(h.addons, undefined);
    // Modules can still register kinds and ask for installed packages.
    assert.equal(typeof h.kinds.register, 'function');
    assert.equal(h.api.installed('note'), null);
    assert.equal(h.api.enabled('note'), false);
  }
});

test('state never touches the network, seeds nothing and returns a copy', () => {
  const h = harness(), first = h.addons({ action: 'state' });
  assert.equal(h.xhrs.length, 0);
  assert.deepEqual(plain(first), { installed: {}, catalog: [], busy: false, error: '', api: 2, runtime: {}, pending: {}, batch: { status: 'idle', completed: 0, total: 0 }, catalogInfo: { checked: false, total: 0, compatible: 0 } });
  assert.equal('readOnly' in first, false);
  first.catalog.push('changed'); first.catalogInfo.checked = true;
  assert.deepEqual(h.state().catalog, []);
  assert.equal(h.state().catalogInfo.checked, false);
  assert.deepEqual(h.local.log, [], 'nothing is written at load');
});

test('refresh sends one plain GET to the reviewed catalog and blocks a second request', () => {
  const h = harness();
  h.addons({ action: 'refresh' });
  const [xhr] = h.xhrs;
  assert.equal(h.xhrs.length, 1);
  assert.deepEqual({ method: xhr.method, url: xhr.url, async: xhr.async, headers: xhr.headers, credentials: xhr.withCredentials, timeout: xhr.timeout, type: xhr.responseType, sent: xhr.sent },
    { method: 'GET', url: CATALOG, async: true, headers: {}, credentials: false, timeout: 15000, type: 'arraybuffer', sent: true });
  assert.equal(h.state().busy, true);
  for (const action of ['refresh', 'install', 'remove', 'toggle', 'updateAll']) assert.throws(() => h.addons({ action, id: 'note' }), /Another add-on operation is running\./);
  assert.equal(h.xhrs.length, 1);
});

test('a valid catalog offers text and clock widgets, skips other kinds and reports the count', () => {
  const h = harness();
  const s = refreshWith(h, { body: bytes(catalog([spotify, native, widget('note', { icon: 'https://example.com/i.png', script: 'x' }), widget('world', { kind: 'clock', text: undefined, timeZone: 'Europe/Berlin' }), widget('html', { kind: 'html' }), widget('later', { kind: 'weather', api: 9 })])) });
  assert.deepEqual(s.catalog.map(e => e.id), ['note', 'world']);
  assert.equal(s.catalog[0].icon, undefined, 'unknown fields are dropped');
  assert.equal(s.catalog[0].script, undefined);
  assert.deepEqual(s.catalogInfo, { checked: true, total: 6, compatible: 2 });
  assert.equal(s.busy, false); assert.equal(s.error, '');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, 'cleanframe:addons');
  assert.deepEqual(plain(h.events[0].detail), s);
  assert.deepEqual(plain(h.heard), [s], 'CleanTVAddons.on listeners hear the same state');
});

test('the current upstream catalog (Spotify and native only) yields zero widgets', () => {
  const s = refreshWith(harness(), { body: bytes(catalog([spotify, native])) });
  assert.deepEqual(s.catalog, []);
  assert.deepEqual(s.catalogInfo, { checked: true, total: 2, compatible: 0 });
});

test('every failure keeps the previous catalog and names the cause', () => {
  const cases = [
    [{ status: 404, body: bytes('missing') }, 'Catalog download failed (HTTP 404).'],
    [{ body: bytes(catalog([])), url: 'https://raw.githubusercontent.com/other/repo/main/cleantv-catalog.json' }, 'Catalog download failed (unexpected address).'],
    [{ body: new Uint8Array([0xff, 0xfe, 0x7b]).buffer }, 'Catalog could not be read.'],
    [{ body: bytes('{"api":2,') }, 'Catalog could not be read.'],
    [{ body: bytes(JSON.stringify({ api: 1, addons: [] })) }, 'Unsupported catalog API.'],
    [{ body: bytes(catalog(Array.from({ length: 33 }, (_, i) => widget('w' + i)))) }, 'Catalog is too large.'],
    [{ body: bytes(catalog([native, Object.assign({}, native)])) }, 'Duplicate add-on ID.'],
    [{ body: bytes(catalog([widget('long', { text: 'x'.repeat(501) })])) }, 'Widget text is too long.'],
    [{ body: bytes(catalog([widget('sum', { sha256: 'A'.repeat(64) })])) }, 'Invalid package checksum.'],
    [{ body: bytes(catalog([widget('path', { path: 'packages/path/../x.json' })])) }, 'Invalid package path.'],
    [{ body: bytes(catalog([widget('zone', { kind: 'clock', timeZone: { name: 'Europe/Berlin' } })])) }, 'Unsupported time zone.'],
    [{ body: bytes(catalog([widget('apiv', { api: 2 })])) }, 'Unsupported package identity or API.'],
    [{ body: bytes(catalog([widget('ver', { version: '1.0' })])) }, 'Unsupported package identity or API.'],
    [{ body: bytes(catalog([widget('nm', { name: '' })])) }, 'Invalid package metadata.'],
    [{ body: bytes(catalog([widget('nm2', { name: 'x'.repeat(241) })])) }, 'Invalid package metadata.'],
    [{ body: bytes(catalog([widget('lic', { license: undefined })])) }, 'Invalid package metadata.'],
    [{ body: bytes(catalog([widget('d1', { description: {} })])) }, 'Invalid package metadata.'],
    [{ body: bytes(catalog([widget('d2', { description: { english: 'x' } })])) }, 'Invalid package metadata.'],
    [{ body: (() => { const b = Buffer.from(catalog([widget('utf', { name: 'Widget X' })]), 'utf8'); b[b.indexOf('X')] = 0xff; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })() }, 'Catalog could not be read.'],
    [{ body: bytes(catalog([])), url: 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/catalog-v2.json' }, 'Catalog download failed (unexpected address).'],
    [{ body: bytes(catalog([widget('meta', { author: '' })])) }, 'Invalid package metadata.'],
    [{ body: bytes(catalog([widget('Bad-ID', { kind: 'html' })])) }, 'Unsupported package identity or API.'],
    [{ body: bytes(catalog([widget('Bad-ID')])) }, 'Unsupported package identity or API.'],
    [{ body: new ArrayBuffer(131073) }, 'Package exceeds size limit.']
  ];
  for (const [response, message] of cases) {
    const h = harness();
    refreshWith(h, { body: bytes(catalog([widget('keep')])) });
    const s = refreshWith(h, response);
    assert.equal(s.error, message, JSON.stringify(response.status || message));
    assert.deepEqual(s.catalog.map(e => e.id), ['keep'], message);
    assert.equal(s.busy, false);
  }
});

test('a catalog of exactly the size limit is accepted', () => {
  const body = catalog([widget('edge')]);
  const s = refreshWith(harness(), { body: bytes(body + ' '.repeat(131072 - Buffer.byteLength(body))) });
  assert.equal(s.error, ''); assert.deepEqual(s.catalog.map(e => e.id), ['edge']);
});

test('a text widget never carries a time zone, however it is shaped', () => {
  // A deeply nested value would overflow JSON.stringify in every later state copy.
  const nested = '['.repeat(5000) + ']'.repeat(5000);
  for (const zone of ['{"a":1}', nested, '"Europe/Berlin"']) {
    const h = harness(), s = refreshWith(h, { body: bytes(catalog([widget('note', { timeZone: '__ZONE__' })]).replace('"__ZONE__"', zone)) });
    assert.equal(h.events.length, 1);
    assert.equal(s.busy, false); assert.equal(s.error, '');
    assert.equal(s.catalog[0].timeZone, undefined);
  }
});

test('a clock zone this engine cannot format is skipped, not fatal', () => {
  // Chromium 47 (V8 4.7) rejects valid names such as Asia/Kolkata that Android accepts.
  const old = { DateTimeFormat: function (locale, options) { if (options && options.timeZone === 'Asia/Kolkata') throw new RangeError('Unsupported time zone specified Asia/Kolkata'); return new Intl.DateTimeFormat(locale, options); } };
  const clock = (id, timeZone) => widget(id, { kind: 'clock', text: undefined, timeZone });
  const body = bytes(catalog([clock('india', 'Asia/Kolkata'), clock('mars', 'Mars/Olympus'), widget('note')]));
  const tv = refreshWith(harness({ intl: old }), { body });
  assert.equal(tv.error, '');
  assert.deepEqual(tv.catalog.map(e => e.id), ['note']);
  assert.deepEqual(tv.catalogInfo, { checked: true, total: 3, compatible: 1 });
  assert.deepEqual(refreshWith(harness(), { body }).catalog.map(e => e.id), ['india', 'note']);
});

test('IDs that match Object.prototype keys are ordinary IDs', () => {
  const s = refreshWith(harness(), { body: bytes(catalog([widget('constructor'), widget('note')])) });
  assert.equal(s.error, ''); assert.deepEqual(s.catalog.map(e => e.id), ['constructor', 'note']);
});

test('engine exception text never reaches the UI', () => {
  // Chromium 47's TextDecoder message is a full sentence ending in a period.
  class Blink { decode() { throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid."); } }
  const h = harness({ decoder: Blink });
  refreshWith(h, { body: bytes(catalog([widget('keep')])) });
  assert.equal(h.state().error, 'Catalog could not be read.');
});

test('connection, timeout and size failures end the request', () => {
  let h = harness();
  h.addons({ action: 'refresh' }); h.xhrs[0].onerror(); h.flush();
  assert.equal(h.state().error, 'Catalog download failed (no connection, certificate or access policy).');
  h = harness();
  h.addons({ action: 'refresh' }); h.xhrs[0].ontimeout(); h.flush();
  assert.equal(h.state().error, 'Catalog download timed out.');
  h = harness();
  h.addons({ action: 'refresh' }); h.xhrs[0].onprogress({ loaded: 131073 }); h.flush();
  assert.equal(h.xhrs[0].aborted, true);
  assert.equal(h.state().error, 'Package exceeds size limit.');
  assert.equal(h.state().busy, false);
  assert.equal(h.events.length, 1, 'one completion event per request');
});

test('install downloads the listed package once, verifies it and stores it', () => {
  const h = harness(), note = pkg('note', { permissions: ['Network'] }), body = JSON.stringify(note, null, 2);
  refreshWith(h, { body: bytes(catalog([listed(note, body)])) });
  const events = h.events.length;
  const s = installWith(h, 'note', { body: bytes(body) });
  assert.deepEqual({ method: s.xhr.method, url: s.xhr.url, async: s.xhr.async, headers: s.xhr.headers, credentials: s.xhr.withCredentials, timeout: s.xhr.timeout, type: s.xhr.responseType },
    { method: 'GET', url: BASE + 'packages/note/1.0.0.json', async: true, headers: {}, credentials: false, timeout: 15000, type: 'arraybuffer' });
  assert.equal(s.error, ''); assert.equal(s.busy, false);
  assert.deepEqual(s.installed, { note: { ...note, enabled: true } }, 'stored without path or checksum');
  assert.equal(h.events.length, events + 1);
  assert.deepEqual(plain(h.api.installed('note')), { ...note, enabled: true });
  assert.equal(h.api.enabled('note'), true);
  // Only the add-on slots are written.
  assert.deepEqual([...new Set(h.local.log)].sort(), [STORE + '.a', STORE + '.b']);
  const record = JSON.parse(h.local.map.get(STORE + '.b'));
  assert.equal(record.v, 1); assert.equal(record.seq, 2); assert.equal(record.sum, hex(record.data));
  assert.deepEqual(JSON.parse(record.data), { installed: s.installed, catalog: s.catalog, catalogInfo: s.catalogInfo });
});

test('install needs the entry in the last checked catalog', () => {
  const h = harness();
  assert.throws(() => h.addons({ action: 'install', id: 'note' }), /^Error: Refresh the catalog before downloading\.$/);
  h.flush();
  assert.equal(h.state().error, 'Refresh the catalog before downloading.');
  assert.equal(h.xhrs.length, 0);
  assert.equal(h.events.length, 1);
  refreshWith(h, { body: bytes(catalog([listed(pkg('other'))])) });
  assert.throws(() => h.addons({ action: 'install', id: 'note' }), /Refresh the catalog before downloading\./);
  assert.equal(h.xhrs.length, 1);
});

test('package verification failures keep the previous state', () => {
  const note = pkg('note'), body = JSON.stringify(note);
  const cases = [
    [{ body: bytes(body + ' ') }, 'Package checksum mismatch.'],
    [{ body: bytes(body), url: BASE + 'packages/note/1.0.1.json' }, 'Package download failed (unexpected address).'],
    [{ body: bytes(body), url: 'https://raw.githubusercontent.com/evil/repo/main/packages/note/1.0.0.json' }, 'Package download failed (unexpected address).'],
    [{ body: bytes(body), url: '' }, 'Package download failed (unexpected address).'],
    [{ status: 500, body: bytes(body) }, 'Package download failed (HTTP 500).'],
    [{ status: 0, body: bytes(body) }, 'Package download failed (no connection, certificate or access policy).'],
    [{ body: new ArrayBuffer(65537) }, 'Package exceeds size limit.']
  ];
  for (const [response, message] of cases) {
    const h = harness();
    refreshWith(h, { body: bytes(catalog([listed(note, body)])) });
    const before = new Map(h.local.map), s = installWith(h, 'note', response);
    assert.equal(s.error, message, message);
    assert.deepEqual(s.installed, {});
    assert.equal(s.busy, false);
    assert.deepEqual(h.local.map, before, 'nothing stored: ' + message);
  }
  let h = harness();
  refreshWith(h, { body: bytes(catalog([listed(note, body)])) });
  h.addons({ action: 'install', id: 'note' }); h.xhrs[1].onprogress({ loaded: 65537 }); h.flush();
  assert.equal(h.xhrs[1].aborted, true);
  assert.equal(h.state().error, 'Package exceeds size limit.');
  h = harness();
  refreshWith(h, { body: bytes(catalog([listed(note, body)])) });
  h.addons({ action: 'install', id: 'note' }); h.xhrs[1].ontimeout(); h.flush();
  assert.equal(h.state().error, 'Package download timed out.');
});

test('a package of exactly 65536 bytes is accepted', () => {
  const note = pkg('note'), raw = JSON.stringify(note), body = raw + ' '.repeat(65536 - Buffer.byteLength(raw));
  const h = harness();
  refreshWith(h, { body: bytes(catalog([listed(note, body)])) });
  const s = installWith(h, 'note', { body: bytes(body) });
  assert.equal(s.error, ''); assert.equal(s.installed.note.version, '1.0.0');
});

test('the package must equal its catalog entry without path and checksum', () => {
  const note = pkg('note');
  for (const [body, message] of [
    [JSON.stringify({ ...note, text: 'Changed' }), 'Package does not match catalog.'],
    [JSON.stringify({ ...note, version: '1.0.1' }), 'Package does not match catalog.'],
    [JSON.stringify({ ...note, kind: 'clock' }), 'Package does not match catalog.'],
    [JSON.stringify({ ...note, kind: undefined }), 'Package does not match catalog.'],
    [JSON.stringify({ ...note, text: undefined }), 'Package does not match catalog.'],
    [JSON.stringify({ ...note, text: 'x'.repeat(501) }), 'Widget text is too long.'],
    [JSON.stringify([note]), 'Package could not be read.'],
    ['{"api":1,', 'Package could not be read.'],
    ['null', 'Package could not be read.']
  ]) {
    const h = harness();
    // The catalog lists the exact bytes, so only the content comparison can fail.
    refreshWith(h, { body: bytes(catalog([{ ...note, path: 'packages/note/1.0.0.json', sha256: hex(body) }])) });
    const s = installWith(h, 'note', { body: bytes(body) });
    assert.equal(s.error, message, body.slice(0, 60));
    assert.deepEqual(s.installed, {});
  }
  // Fields the host drops on both sides, and path or checksum inside the package, are not differences.
  const h = harness(), body = JSON.stringify({ ...note, icon: 'x.png', path: 'elsewhere', sha256: SHA });
  refreshWith(h, { body: bytes(catalog([{ ...note, path: 'packages/note/1.0.0.json', sha256: hex(body), extra: true }])) });
  assert.equal(installWith(h, 'note', { body: bytes(body) }).error, '');
});

test('updates must keep the kind and be strictly newer, and keep activation', () => {
  const h = harness(), v1 = pkg('note');
  installAll(h, [v1]);
  h.addons({ action: 'toggle', id: 'note' }); h.flush();
  assert.equal(h.state().installed.note.enabled, false);
  // Same version: nothing to download.
  assert.throws(() => h.addons({ action: 'install', id: 'note' }), /^Error: This add-on is already up to date\.$/);
  h.flush(); assert.equal(h.state().error, 'This add-on is already up to date.');
  // Older version listed.
  refreshWith(h, { body: bytes(catalog([listed(pkg('note', { version: '0.9.9' }))])) });
  assert.throws(() => h.addons({ action: 'install', id: 'note' }), /This add-on is already up to date\./);
  // A different kind under the same ID.
  refreshWith(h, { body: bytes(catalog([listed(pkg('note', { version: '2.0.0', kind: 'clock', text: undefined }))])) });
  assert.throws(() => h.addons({ action: 'install', id: 'note' }), /^Error: An update cannot change the add-on type\.$/);
  h.flush(); assert.equal(h.state().error, 'An update cannot change the add-on type.');
  const requests = h.xhrs.length;
  assert.equal(requests, 4, 'refused updates never download (two installs and refreshes)');
  // A real update.
  const v2 = pkg('note', { version: '1.10.0', text: 'New' });
  refreshWith(h, { body: bytes(catalog([listed(v2)])) });
  const s = installWith(h, 'note', { body: bytes(JSON.stringify(v2)) });
  assert.equal(s.error, '');
  assert.deepEqual(s.installed.note, { ...v2, enabled: false }, 'a disabled widget stays disabled');
});

test('at most three text and clock widgets are active', () => {
  const h = harness(), items = ['a1', 'a2', 'a3', 'a4'].map(id => pkg(id));
  let s = installAll(h, items);
  assert.deepEqual(Object.keys(s.installed).map(id => [id, s.installed[id].enabled]), [['a1', true], ['a2', true], ['a3', true], ['a4', false]]);
  assert.throws(() => h.addons({ action: 'toggle', id: 'a4' }), /^Error: Disable another widget first \(maximum three active widgets\)\.$/);
  h.flush();
  s = h.state();
  assert.equal(s.error, 'Disable another widget first (maximum three active widgets).');
  assert.equal(s.installed.a4.enabled, false);
  h.addons({ action: 'toggle', id: 'a2' }); h.flush();
  h.addons({ action: 'toggle', id: 'a4' }); h.flush();
  s = h.state();
  assert.equal(s.error, '');
  assert.deepEqual(Object.keys(s.installed).filter(id => s.installed[id].enabled), ['a1', 'a3', 'a4']);
  // Disabling is always allowed.
  h.addons({ action: 'toggle', id: 'a1' }); h.flush();
  assert.equal(h.state().installed.a1.enabled, false);
});

test('remove and toggle need an installed add-on and are stored', () => {
  const local = storage(), h = harness({ local });
  installAll(h, [pkg('note'), pkg('time', { kind: 'clock', text: undefined, timeZone: 'Europe/Berlin' })]);
  for (const action of ['remove', 'toggle']) {
    assert.throws(() => h.addons({ action, id: 'missing' }), /^Error: Add-on is not installed\.$/);
    h.flush(); assert.equal(h.state().error, 'Add-on is not installed.');
  }
  const events = h.events.length;
  assert.deepEqual(plain(h.addons({ action: 'toggle', id: 'time' })), { ok: true });
  h.flush();
  assert.equal(h.state().error, '');
  assert.equal(h.events.length, events + 1);
  assert.equal(h.api.enabled('time'), false);
  h.addons({ action: 'remove', id: 'note' }); h.flush();
  assert.deepEqual(Object.keys(h.state().installed), ['time']);
  assert.equal(h.api.installed('note'), null);
  const again = harness({ local });
  assert.deepEqual(again.state().installed, { time: plain({ ...pkg('time', { kind: 'clock', text: undefined, timeZone: 'Europe/Berlin' }), enabled: false }) });
});

test('a failed storage write keeps the previous state', () => {
  const local = storage(), h = harness({ local });
  installAll(h, [pkg('note'), pkg('later')].slice(0, 1));
  refreshWith(h, { body: bytes(catalog([listed(pkg('note')), listed(pkg('later'))])) });
  local.quota = true;
  let s = installWith(h, 'later', { body: bytes(JSON.stringify(pkg('later'))) });
  assert.equal(s.error, 'Could not save add-ons.');
  assert.deepEqual(Object.keys(s.installed), ['note']);
  assert.throws(() => h.addons({ action: 'toggle', id: 'note' }), /Could not save add-ons\./);
  assert.throws(() => h.addons({ action: 'remove', id: 'note' }), /Could not save add-ons\./);
  s = refreshWith(h, { body: bytes(catalog([listed(pkg('third'))])) });
  assert.equal(s.error, 'Could not save add-ons.');
  assert.deepEqual(s.catalog.map(e => e.id), ['note', 'later'], 'an unsaved refresh keeps the previous catalog');
  s = h.state();
  assert.equal(s.installed.note.enabled, true);
  local.quota = false;
  assert.deepEqual(harness({ local }).state().installed, s.installed);
});

test('updateAll updates one at a time and stops at the first failure', () => {
  const h = harness(), items = ['u1', 'u2', 'u3'].map(id => pkg(id));
  installAll(h, items);
  const next = items.map(item => ({ ...item, version: '1.1.0', text: 'v2 ' + item.id }));
  refreshWith(h, { body: bytes(catalog(next.map(item => listed(item)))) });
  const start = h.xhrs.length;
  h.addons({ action: 'updateAll' });
  let s = h.state();
  assert.equal(s.busy, true);
  assert.deepEqual(s.batch, { status: 'running', completed: 0, total: 3, name: 'Widget u1' });
  assert.equal(h.xhrs.length, start + 1, 'one request at a time');
  h.xhrs[start].respond({ body: bytes(JSON.stringify(next[0])) }); h.flush();
  s = h.state();
  assert.equal(s.installed.u1.version, '1.1.0');
  assert.deepEqual(s.batch, { status: 'running', completed: 1, total: 3, name: 'Widget u2' });
  assert.equal(h.xhrs.length, start + 2);
  h.xhrs[start + 1].respond({ body: bytes(JSON.stringify(next[1]) + ' ') }); h.flush();
  s = h.state();
  assert.equal(s.error, 'Update stopped: Package checksum mismatch.');
  assert.deepEqual(s.batch, { status: 'stopped', completed: 1, total: 3 });
  assert.equal(s.busy, false);
  assert.equal(h.xhrs.length, start + 2, 'the batch stops after the failure');
  assert.deepEqual([s.installed.u1.version, s.installed.u2.version, s.installed.u3.version], ['1.1.0', '1.0.0', '1.0.0']);
  // A later run finishes the rest.
  h.addons({ action: 'updateAll' });
  h.xhrs[start + 2].respond({ body: bytes(JSON.stringify(next[1])) }); h.flush();
  h.xhrs[start + 3].respond({ body: bytes(JSON.stringify(next[2])) }); h.flush();
  s = h.state();
  assert.equal(s.error, '');
  assert.deepEqual(s.batch, { status: 'complete', completed: 2, total: 2 });
  assert.deepEqual(Object.values(s.installed).map(item => item.text), ['v2 u1', 'v2 u2', 'v2 u3']);
  // Nothing left to update completes without a request.
  h.addons({ action: 'updateAll' }); h.flush();
  assert.deepEqual(h.state().batch, { status: 'complete', completed: 0, total: 0 });
  assert.equal(h.xhrs.length, start + 4);
});

test('installations and the last good catalog survive a restart without network', () => {
  const local = storage(HOME), h = harness({ local }), items = [pkg('note'), pkg('time', { kind: 'clock', text: undefined })];
  const s = installAll(h, items.concat([pkg('extra')]));
  h.addons({ action: 'remove', id: 'extra' }); h.flush();
  const before = h.state();
  const again = harness({ local });
  assert.equal(again.xhrs.length, 0, 'no request at load');
  const after = again.state();
  assert.equal(again.xhrs.length, 0, 'no request for state');
  assert.deepEqual(after.installed, before.installed);
  assert.deepEqual(after.catalog, s.catalog, 'Discover works offline');
  assert.deepEqual(after.catalogInfo, { checked: true, total: 3, compatible: 3 });
  assert.equal(after.busy, false); assert.equal(after.error, '');
  assert.deepEqual(after.batch, { status: 'idle', completed: 0, total: 0 });
  // The stored catalog still allows an install after the restart.
  const reinstall = installWith(again, 'extra', { body: bytes(JSON.stringify(pkg('extra'))) });
  assert.equal(reinstall.error, '');
  assert.equal(reinstall.xhr.url, BASE + 'packages/extra/1.0.0.json');
});

test('Home preference keys stay byte-identical', () => {
  const local = storage(HOME), h = harness({ local });
  installAll(h, [pkg('note'), pkg('two')]);
  h.addons({ action: 'toggle', id: 'note' }); h.flush();
  h.addons({ action: 'remove', id: 'two' }); h.flush();
  harness({ local }).state();
  for (const [key, value] of Object.entries(HOME)) assert.equal(local.map.get(key), value, key);
  assert.deepEqual([...local.map.keys()].sort(), [...Object.keys(HOME), STORE + '.a', STORE + '.b'].sort());
  assert.deepEqual([...new Set(local.log)].sort(), [STORE + '.a', STORE + '.b']);
});

test('a damaged newest record falls back to the previous installation', () => {
  const local = storage(), h = harness({ local });
  installAll(h, [pkg('note')]);
  h.addons({ action: 'toggle', id: 'note' }); h.flush();
  const newest = JSON.parse(local.map.get(STORE + '.a')).seq > JSON.parse(local.map.get(STORE + '.b')).seq ? '.a' : '.b';
  local.map.set(STORE + newest, local.map.get(STORE + newest).replace('"enabled\\":false', '"enabled\\":true '));
  assert.equal(harness({ local }).state().installed.note.enabled, true, 'the older, intact record wins');
  // Stored data that does not validate is not offered.
  const data = { installed: { note: { ...pkg('note'), text: 'x'.repeat(501), enabled: true } }, catalog: [{ bogus: true }, listed(pkg('ok'))], catalogInfo: { checked: true, total: 9, compatible: 9 } };
  const json = JSON.stringify(data);
  const damaged = storage({ [STORE + '.a']: JSON.stringify({ v: 1, seq: 1, sum: hex(json), data: json }) });
  const s = harness({ local: damaged }).state();
  assert.deepEqual(s.installed, {});
  assert.deepEqual(s.catalog.map(e => e.id), ['ok']);
  assert.deepEqual(s.catalogInfo, { checked: true, total: 9, compatible: 1 });
});

test('registered kinds are offered, validated and kept outside the widget limit', () => {
  const calls = [];
  const weather = { widget: false, validate(entry) {
    calls.push(plain(entry));
    if (typeof entry.city !== 'string' || !entry.city) throw new Error('Weather needs a city.');
    if (entry.city === 'bug') return undefined.city;
    return { city: entry.city.slice(0, 40), id: 'spoofed', kind: 'text', enabled: false, path: 'x', secret: undefined };
  } };
  const local = storage(), kinds = [['weather', weather]];
  const h = harness({ local, kinds });
  const forecast = pkg('forecast', { kind: 'weather', text: undefined, city: 'Berlin', extra: 'dropped' });
  const items = ['w1', 'w2', 'w3'].map(id => pkg(id));
  let s = installAll(h, items.concat([forecast]));
  assert.deepEqual(calls[0], plain(forecast), 'the validator sees the entry without path and checksum');
  const expected = { api: 1, id: 'forecast', name: 'Widget forecast', version: '1.0.0', kind: 'weather', description: 'A short note', author: 'Someone', license: 'MIT', city: 'Berlin' };
  assert.deepEqual(s.catalog.find(e => e.id === 'forecast'), { ...expected, path: 'packages/forecast/1.0.0.json', sha256: hex(JSON.stringify(forecast)) }, 'identity comes from the host');
  assert.deepEqual(s.installed.forecast, { ...expected, enabled: true }, 'three active widgets do not block another kind');
  assert.equal(h.api.enabled('forecast'), true);
  h.addons({ action: 'toggle', id: 'forecast' }); h.flush();
  h.addons({ action: 'toggle', id: 'forecast' }); h.flush();
  assert.equal(h.state().error, '');
  assert.equal(h.api.enabled('forecast'), true);
  // After a restart the kind validates its stored package again.
  calls.length = 0;
  s = harness({ local, kinds }).state();
  assert.deepEqual(s.installed.forecast, { ...expected, enabled: true });
  assert.ok(calls.length >= 2, 'stored package and catalog entry are validated');
  // Without its module the package is kept as stored but not offered, and later writes keep it.
  const without = harness({ local });
  s = without.state();
  assert.equal(s.installed.forecast, undefined);
  assert.equal(s.catalog.some(e => e.id === 'forecast'), false);
  without.addons({ action: 'remove', id: 'w1' }); without.flush();
  assert.deepEqual(harness({ local, kinds }).state().installed.forecast, { ...expected, enabled: true });
  // An own validator error fails the refresh and keeps the previous catalog; engine errors stay generic.
  for (const [city, message] of [['', 'Weather needs a city.'], ['bug', 'Invalid package metadata.']]) {
    s = refreshWith(h, { body: bytes(catalog([listed(pkg('forecast', { kind: 'weather', text: undefined, city }))])) });
    assert.equal(s.error, message);
    assert.equal(s.catalog.length, 4);
  }
});

test('Spotify needs a registered kind; registration rules', () => {
  const plainHost = refreshWith(harness(), { body: bytes(catalog([spotify])) });
  assert.deepEqual(plainHost.catalog, []);
  const spot = { widget: false, validate: entry => ({ scopes: Array.isArray(entry.scopes) ? entry.scopes.slice(0, 4) : [] }) };
  const withKind = refreshWith(harness({ kinds: [['spotify', spot]] }), { body: bytes(catalog([{ ...spotify, scopes: ['user-read-playback-state'] }])) });
  assert.deepEqual(withKind.catalog.map(e => [e.id, e.kind, e.scopes]), [['spotify', 'spotify', ['user-read-playback-state']]]);
  const h = harness();
  for (const [kind, definition] of [['text', spot], ['clock', spot], ['native', spot], ['Bad', spot], ['', spot], ['x'.repeat(33), spot], ['ok', {}], ['ok', { validate() {} }], ['ok', { validate() {}, widget: true }]]) {
    assert.throws(() => h.kinds.register(kind, definition), /Add-on kind/);
  }
  h.kinds.register('later', spot);
  assert.equal(h.kinds.registered('later'), true);
  assert.throws(() => h.kinds.register('later', spot), /cannot be registered/);
  // A faulty early registration is reported asynchronously and the host still starts.
  const faulty = harness({ kinds: [['text', spot], ['fine', spot]] });
  assert.equal(typeof faulty.addons, 'function');
  assert.equal(faulty.kinds.registered('fine'), true);
  assert.throws(() => faulty.flush(), /Add-on kind cannot be registered: text/);
});

test('CleanTVAddons reports copies and calls listeners after every change', () => {
  const h = harness();
  installAll(h, [pkg('note')]);
  const copy = h.api.installed('note');
  copy.text = 'changed';
  assert.equal(h.api.installed('note').text, 'Hello');
  assert.equal(h.api.installed('constructor'), null);
  assert.equal(h.api.enabled('toString'), false);
  const seen = [], stop = h.api.on(detail => seen.push(detail.installed.note && detail.installed.note.enabled));
  h.addons({ action: 'toggle', id: 'note' }); h.flush();
  assert.deepEqual(seen, [false]);
  stop();
  h.addons({ action: 'toggle', id: 'note' }); h.flush();
  assert.deepEqual(seen, [false]);
  h.api.on(() => { throw new Error('listener failure'); });
  h.addons({ action: 'toggle', id: 'note' }); h.flush();
  assert.equal(h.api.enabled('note'), false);
  assert.equal(typeof h.api.on(null), 'function');
});

test('unknown actions are refused without network', () => {
  const h = harness();
  for (const request of [{ action: 'remote' }, { action: 'remoteState' }, {}, null, { action: 'install ' }]) assert.throws(() => h.addons(request), /Unknown add-on action\./);
  assert.equal(h.xhrs.length, 0);
  assert.equal(h.events.length, 0);
});
