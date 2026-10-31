// Test the Tizen add-on host with a synthetic XHR and clock. No TV or network access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/tizen-addons.js', import.meta.url), 'utf8');
const CATALOG = 'https://raw.githubusercontent.com/AntoinS/cleanframe-addons/main/catalog-v2.json';
const SHA = 'a'.repeat(64);
const plain = value => JSON.parse(JSON.stringify(value));
const bytes = text => { const b = Buffer.from(text, 'utf8'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

function harness({ tizen = true, platform, intl = Intl, decoder = TextDecoder } = {}) {
  const xhrs = [], events = [], timers = [];
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
    FrameDevice: platform ? { platform } : {}, XMLHttpRequest: FakeXHR, CustomEvent: FakeEvent, Uint8Array, TextDecoder: decoder, Intl: intl,
    dispatchEvent: event => events.push(event), setTimeout: callback => timers.push(callback)
  };
  if (tizen) window.tizen = { application: {} };
  vm.runInNewContext(source, { window });
  const flush = () => { while (timers.length) timers.shift()(); };
  return { addons: window.FrameDevice.addons, xhrs, events, flush };
}
const widget = (id, extra) => Object.assign({ api: 1, id, name: 'Widget ' + id, version: '1.0.0', kind: 'text', description: 'A short note', author: 'Someone', license: 'MIT', text: 'Hello', path: 'packages/' + id + '/1.0.0.json', sha256: SHA }, extra);
const spotify = { api: 1, id: 'spotify', name: 'Spotify', version: '1.0.0', kind: 'spotify', description: 'Player', author: 'CleanFrame', license: 'MIT', path: 'packages/spotify/1.0.0.json', sha256: SHA };
const native = { api: 2, id: 'apple-remote', name: 'iPhone Remote', version: '0.1.2', kind: 'native', description: 'Remote', author: 'CleanFrame', license: 'MIT', apkUrl: 'https://github.com/x.apk', sha256: SHA };
const catalog = addons => JSON.stringify({ api: 2, addons });
function refreshWith(h, response) {
  assert.deepEqual(plain(h.addons({ action: 'refresh' })), { ok: true });
  h.xhrs[h.xhrs.length - 1].respond(response);
  h.flush();
  return plain(h.addons({ action: 'state' }));
}

test('the host stays inactive outside a Tizen TV and on Android', () => {
  assert.equal(harness({ tizen: false }).addons, undefined);
  assert.equal(harness({ platform: 'android' }).addons, undefined);
});

test('state never touches the network, seeds nothing and returns a copy', () => {
  const h = harness(), first = h.addons({ action: 'state' });
  assert.equal(h.xhrs.length, 0);
  assert.deepEqual(plain(first), { installed: {}, catalog: [], busy: false, error: '', api: 2, runtime: {}, pending: {}, batch: { status: 'idle', completed: 0, total: 0 }, readOnly: true, catalogInfo: { checked: false, total: 0, compatible: 0 } });
  first.catalog.push('changed'); first.catalogInfo.checked = true;
  assert.deepEqual(plain(h.addons({ action: 'state' })).catalog, []);
  assert.equal(h.addons({ action: 'state' }).catalogInfo.checked, false);
});

test('refresh sends one plain GET to the reviewed catalog and blocks a second request', () => {
  const h = harness();
  h.addons({ action: 'refresh' });
  const [xhr] = h.xhrs;
  assert.equal(h.xhrs.length, 1);
  assert.deepEqual({ method: xhr.method, url: xhr.url, async: xhr.async, headers: xhr.headers, credentials: xhr.withCredentials, timeout: xhr.timeout, type: xhr.responseType, sent: xhr.sent },
    { method: 'GET', url: CATALOG, async: true, headers: {}, credentials: false, timeout: 15000, type: 'arraybuffer', sent: true });
  assert.equal(h.addons({ action: 'state' }).busy, true);
  assert.throws(() => h.addons({ action: 'refresh' }), /Another add-on operation is running\./);
  assert.equal(h.xhrs.length, 1);
});

test('a valid catalog offers only text and clock widgets and reports the count', () => {
  const h = harness();
  const s = refreshWith(h, { body: bytes(catalog([spotify, native, widget('note', { icon: 'https://example.com/i.png', script: 'x' }), widget('world', { kind: 'clock', text: undefined, timeZone: 'Europe/Berlin' })])) });
  assert.deepEqual(s.catalog.map(e => e.id), ['note', 'world']);
  assert.equal(s.catalog[0].icon, undefined, 'unknown fields are dropped');
  assert.equal(s.catalog[0].script, undefined);
  assert.deepEqual(s.catalogInfo, { checked: true, total: 4, compatible: 2 });
  assert.equal(s.busy, false); assert.equal(s.error, '');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, 'cleanframe:addons');
  assert.deepEqual(plain(h.events[0].detail), s);
});

test('the current upstream catalog (Spotify and native only) yields zero widgets', () => {
  const s = refreshWith(harness(), { body: bytes(catalog([spotify, native])) });
  assert.deepEqual(s.catalog, []);
  assert.deepEqual(s.catalogInfo, { checked: true, total: 2, compatible: 0 });
});

test('every failure keeps the previous catalog and names the cause', () => {
  const cases = [
    [{ status: 404, body: bytes('missing') }, 'Catalog download failed (HTTP 404).'],
    [{ body: bytes(catalog([])), url: 'https://raw.githubusercontent.com/other/repo/main/catalog-v2.json' }, 'Catalog download failed (unexpected address).'],
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
    [{ body: bytes(catalog([])), url: 'https://raw.githubusercontent.com/AntoinS/cleanframe-addons/main/catalog-v3.json' }, 'Catalog download failed (unexpected address).'],
    [{ body: bytes(catalog([widget('meta', { author: '' })])) }, 'Invalid package metadata.'],
    [{ body: bytes(catalog([widget('kind', { kind: 'html' })])) }, 'Unsupported widget kind.'],
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
  assert.equal(h.addons({ action: 'state' }).error, 'Catalog could not be read.');
});

test('connection, timeout and size failures end the request', () => {
  let h = harness();
  h.addons({ action: 'refresh' }); h.xhrs[0].onerror(); h.flush();
  assert.equal(h.addons({ action: 'state' }).error, 'Catalog download failed (no connection, certificate or access policy).');
  h = harness();
  h.addons({ action: 'refresh' }); h.xhrs[0].ontimeout(); h.flush();
  assert.equal(h.addons({ action: 'state' }).error, 'Catalog download timed out.');
  h = harness();
  h.addons({ action: 'refresh' }); h.xhrs[0].onprogress({ loaded: 131073 }); h.flush();
  assert.equal(h.xhrs[0].aborted, true);
  assert.equal(h.addons({ action: 'state' }).error, 'Package exceeds size limit.');
  assert.equal(h.addons({ action: 'state' }).busy, false);
  assert.equal(h.events.length, 1, 'one completion event per request');
});

test('install, remove, toggle and update stay unavailable in this stage', () => {
  const h = harness();
  for (const action of ['install', 'remove', 'toggle', 'updateAll']) assert.throws(() => h.addons({ action, id: 'note' }), /Downloads follow in a later update\./);
  for (const request of [{ action: 'remote' }, { action: 'remoteState' }, {}, null]) assert.throws(() => h.addons(request), /Unknown add-on action\./);
  assert.equal(h.xhrs.length, 0);
});
