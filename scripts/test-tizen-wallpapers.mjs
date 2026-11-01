// Test the add-on wallpaper module with a synthetic XHR, IndexedDB, clock, Blob URLs and localStorage,
// together with the real Tizen add-on host and store. No TV or network access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8');
const SOURCES = { sha: read('sha256.js'), store: read('tizen-store.js'), walls: read('tizen-wallpapers.js'), host: read('tizen-addons.js') };
const BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/';
const CATALOG = BASE + 'cleantv-catalog.json', INDEX = BASE + 'cleantv-wallpapers/index.json';
const ID = 'cleantv-wallpapers', PREFIX = 'cleantv.wallpapers.v1', DAY = 86400000;
const ROLES = ['jpg', 'thumb', 'panel', 'study-soft', 'field-blur', 'field-frost', 'field-clear'];
const NAMES = { jpg: 'image.jpg', thumb: 'thumb.jpg', panel: 'panel.jpg', 'study-soft': 'study-soft.jpg', 'field-blur': 'field-blur.jpg', 'field-frost': 'field-frost.jpg', 'field-clear': 'field-clear.jpg' };
const BUILT_IN = [{ id: 'misty', name: 'Misty coast', tone: 'light', ut: { tr: 'mist', br: 'mist' }, frostVeil: 0.2 },
  { id: 'cove', name: 'Quiet cove', tone: 'light', ut: { tr: 'light', br: 'mist' }, frostVeil: 0.12 },
  { id: 'summit', name: 'Sunlit summits', tone: 'dark', ut: { tr: 'light', br: 'light' }, frostVeil: 0.2 }];
const plain = value => JSON.parse(JSON.stringify(value));
const hex = data => createHash('sha256').update(data).digest('hex');
const buffer = data => { const b = Buffer.from(data); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

/* ---------- Fixtures ---------- */
const PKG = { api: 1, id: ID, name: 'Wallpapers', version: '1.0.0', kind: 'wallpapers', description: 'Own photos', author: 'Psychnix', license: 'MIT', index: 'cleantv-wallpapers/index.json' };
const listed = (pkg = PKG) => ({ ...pkg, path: 'cleantv-packages/' + pkg.id + '/' + pkg.version + '.json', sha256: hex(JSON.stringify(pkg)) });
/* One index entry and the bytes of its seven files; `seed` changes the bytes and so the revision. */
function photo(id, { seed = '1', title = 'Photo ' + id, extra = {} } = {}) {
  const bytes = {}, files = {};
  for (const role of ROLES) {
    bytes[role] = Buffer.from(id + '/' + role + '/' + seed + '/' + 'x'.repeat(role === 'jpg' ? 400 : 60));
    files[role] = { path: 'cleantv-wallpapers/generated/' + id + '/' + NAMES[role], size: bytes[role].length, sha256: hex(bytes[role]) };
  }
  return { entry: { id, title, rev: files.jpg.sha256.slice(0, 12), tone: 'dark', ut: { tr: 'light', br: 'mist' }, frostVeil: 0.3, listColumn: 2, files, ...extra }, bytes };
}
const indexOf = photos => JSON.stringify({ api: 1, entries: photos.map(p => p.entry) });

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map, quota: false,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (this.quota && key.startsWith(PREFIX)) { const e = new Error('Quota exceeded'); e.name = 'QuotaExceededError'; throw e; } map.set(key, String(value)); },
    removeItem(key) { map.delete(key); }
  };
}

/* IndexedDB with object stores, request and transaction events, atomic commits and a byte quota. */
function indexedDB(schedule) {
  const dbs = new Map(), log = [];
  const factory = { dbs, log, quota: Infinity, unavailable: false };
  const bytes = db => { let n = 0; for (const store of db.stores.values()) for (const v of store.values()) n += v && v.data ? v.data.byteLength : 0; return n; };
  function connection(db) {
    return {
      objectStoreNames: { contains: name => db.stores.has(name) },
      createObjectStore(name) { db.stores.set(name, new Map()); },
      close() { log.push('close'); },
      transaction(names, mode) {
        for (const name of names) if (!db.stores.has(name)) { const e = new Error('No store'); e.name = 'NotFoundError'; throw e; }
        const staged = [];
        const tx = {
          error: null, abort() { tx.aborted = true; },
          objectStore(name) {
            const store = db.stores.get(name);
            return {
              put(value, key) { if (mode !== 'readwrite') throw Error('readonly'); staged.push(() => store.set(key, value)); return {}; },
              delete(key) { if (mode !== 'readwrite') throw Error('readonly'); staged.push(() => store.delete(key)); return {}; },
              get(key) { const request = {}; schedule(() => { request.result = store.get(key); if (request.onsuccess) request.onsuccess(); }); return request; }
            };
          }
        };
        schedule(() => schedule(() => {
          if (tx.aborted) { tx.error = { name: 'AbortError' }; if (tx.onabort) tx.onabort(); return; }
          const backup = new Map([...db.stores].map(([name, store]) => [name, new Map(store)]));
          staged.forEach(apply => apply());
          if (bytes(db) > factory.quota) {
            db.stores = backup; tx.error = { name: 'QuotaExceededError' };
            if (tx.onerror) tx.onerror(); if (tx.onabort) tx.onabort(); return;
          }
          log.push(mode + ' ' + names.join());
          if (tx.oncomplete) tx.oncomplete();
        }));
        return tx;
      }
    };
  }
  factory.open = (name, version) => {
    const request = {};
    schedule(() => {
      if (factory.unavailable) { request.error = { name: 'UnknownError' }; if (request.onerror) request.onerror(); return; }
      let db = dbs.get(name);
      if (!db) { db = { stores: new Map(), version: 0 }; dbs.set(name, db); }
      request.result = connection(db);
      if (db.version < version) { db.version = version; if (request.onupgradeneeded) request.onupgradeneeded(); }
      if (request.onsuccess) request.onsuccess();
    });
    return request;
  };
  factory.deleteDatabase = name => { log.push('delete ' + name); dbs.delete(name); return {}; };
  factory.files = () => { const db = dbs.get('cleantv-wallpapers'); return db && db.stores.get('files') ? [...db.stores.get('files').keys()].sort() : []; };
  return factory;
}

/* The real store, wallpaper module and add-on host in one vm context. */
function harness({ local = storage(), db, clock = { now: 1700000000000 }, walls = BUILT_IN.map(w => ({ ...w })) } = {}) {
  const timers = [], xhrs = [], routes = new Map(), listeners = {}, urls = { created: [], revoked: [] };
  const schedule = fn => timers.push(fn);
  const idb = db || indexedDB(schedule);
  if (db) db.reschedule(schedule);
  class FakeXHR {
    constructor() { this.status = 0; this.response = null; this.responseURL = ''; xhrs.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() { throw Error('No custom headers'); }
    send() { this.sent = true; schedule(() => this.answer()); }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    answer() {
      if (this.aborted) return;
      const route = routes.get(this.url);
      if (route === 'offline') { if (this.onerror) this.onerror(); return; }
      const r = route || { status: 404, body: buffer('missing') };
      this.status = r.status || 200; this.response = r.body; this.responseURL = r.url === undefined ? this.url : r.url;
      if (this.onprogress && this.response) this.onprogress({ loaded: this.response.byteLength });
      if (!this.aborted && this.onload) this.onload();
    }
  }
  class FakeDate extends Date { static now() { return clock.now; } }
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.type = options && options.type; } }
  let next = 0;
  const window = {
    FrameDevice: {}, tizen: { application: {} }, XMLHttpRequest: FakeXHR, Uint8Array, TextDecoder, Intl, localStorage: local,
    CleanFrameWallpapers: walls, indexedDB: idb, Blob: FakeBlob,
    URL: { createObjectURL: blob => { const u = 'blob:qa/' + (++next); urls.created.push({ url: u, blob }); return u; }, revokeObjectURL: u => urls.revoked.push(u) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent: event => { (listeners[event.type] || []).forEach(fn => fn(event)); },
    setTimeout: fn => schedule(fn)
  };
  const context = vm.createContext({ window, Date: FakeDate });
  for (const source of [SOURCES.sha, SOURCES.store, SOURCES.walls, SOURCES.host]) vm.runInContext(source, context);
  const flush = () => { let n = 0; while (timers.length) { if (++n > 100000) throw Error('Timers never settle'); timers.shift()(); } };
  const h = {
    window, walls: window.CleanTVWallpapers, list: window.CleanFrameWallpapers, addons: window.FrameDevice.addons, xhrs, routes, local, idb, clock, urls, flush,
    remote: () => h.list.filter(w => w.remote).map(w => w.id),
    requests: () => xhrs.map(x => x.url),
    record: () => plain(window.CleanTVStore.read(PREFIX)),
    serve(photos, index = indexOf(photos)) {
      routes.set(INDEX, { body: buffer(index) });
      for (const p of photos) for (const role of ROLES) routes.set(BASE + p.entry.files[role].path, { body: buffer(p.bytes[role]) });
    },
    /* A stand-in for main.js: the chosen and shown photo, favourites and rotation. */
    bind({ wall = 'misty', favourites = [], rotation = false } = {}) {
      const model = h.model = { wall, shown: wall, favourites, rotation, leaves: 0, changes: 0, updates: 0 };
      h.walls.bind({
        state: () => ({ wall: model.wall, favourites: model.favourites.slice(), rotation: model.rotation, inUse: [model.shown].filter(Boolean) }),
        update: mutate => { model.updates++; mutate(); },
        leave: () => { model.leaves++; if (h.list.some(w => w.id === model.wall && w.remote)) { model.wall = model.shown = 'misty'; h.walls.sync(); } },
        changed: () => { model.changes++; }
      });
      flush();
      return model;
    },
    set(patch) { Object.assign(h.model, patch); h.walls.sync(); flush(); },
    install(photos = []) {
      routes.set(CATALOG, { body: buffer(JSON.stringify({ api: 2, addons: [listed()] })) });
      routes.set(BASE + listed().path, { body: buffer(JSON.stringify(PKG)) });
      h.serve(photos);
      h.addons({ action: 'refresh' }); flush();
      h.addons({ action: 'install', id: ID }); flush();
      assert.equal(window.CleanTVAddons.enabled(ID), true, 'package installed');
    },
    resolved(id) { let done = false; h.walls.resolve(id, () => { done = true; }); flush(); assert.ok(done); return ROLES.map(role => h.walls.url(id, role)); }
  };
  return h;
}
/* A database shared by two harnesses, for a reload. */
function sharedDB() {
  let scheduler = () => {};
  const db = indexedDB(fn => scheduler(fn));
  db.reschedule = fn => { scheduler = fn; };
  return db;
}

/* ---------- Tests ---------- */
test('without the package nothing is requested, stored or added', () => {
  const h = harness();
  h.bind({ wall: 'misty', favourites: ['cove'], rotation: true });
  h.walls.picker(); h.walls.home(); h.flush();
  assert.deepEqual(h.requests(), []);
  assert.deepEqual(h.remote(), []);
  assert.deepEqual([...h.local.map.keys()], []);
  assert.deepEqual(h.idb.log, []);
  assert.equal(h.walls.url('misty', 'jpg').startsWith(BASE), true, 'a URL is only built, never requested');
});

test('install registers the kind, fetches the index once and appends validated entries', () => {
  const h = harness(), a = photo('aw-a'), b = photo('aw-b', { extra: { listColumn: 0, dockQuiet: true, clockMist: true, unknown: 'dropped' } });
  h.bind();
  assert.equal(h.window.CleanTVAddonKinds.registered('wallpapers'), true);
  h.install([a, b]);
  assert.deepEqual(h.requests(), [CATALOG, BASE + listed().path, INDEX]);
  assert.deepEqual(h.remote(), ['aw-a', 'aw-b']);
  const entry = plain(h.list[3]);
  assert.deepEqual(entry, { id: 'aw-a', name: 'Photo aw-a', remote: true, rev: a.entry.rev, tone: 'dark', ut: { tr: 'light', br: 'mist' }, frostVeil: 0.3, listColumn: 2, dockQuiet: false, clockMist: false,
    files: Object.fromEntries(ROLES.map(role => [role, { path: 'cleantv-wallpapers/generated/aw-a/' + NAMES[role] }])) });
  assert.equal(h.list[4].dockQuiet, true); assert.equal(h.list[4].clockMist, true); assert.equal(h.list[4].unknown, undefined);
  assert.equal(h.list[0].id, 'misty', 'built-ins stay first and unchanged');
  assert.equal(h.record().active, true);
  assert.equal(h.walls.url('aw-a', 'thumb'), BASE + 'cleantv-wallpapers/generated/aw-a/thumb.jpg', 'not chosen: streamed');
  assert.deepEqual(h.idb.files(), [], 'nothing is downloaded before it is chosen');
});

test('a wallpapers package with another index is refused by the host', () => {
  const h = harness(), wrong = { ...PKG, index: 'other/index.json' };
  h.routes.set(CATALOG, { body: buffer(JSON.stringify({ api: 2, addons: [listed(wrong)] })) });
  h.addons({ action: 'refresh' }); h.flush();
  assert.equal(h.addons({ action: 'state' }).error, 'Unsupported wallpaper index.');
});

test('every index field is validated; a bad index keeps the previous wallpapers', () => {
  const good = photo('aw-a'), base = good.entry;
  const variants = {
    api: { api: 2, entries: [base] }, entries: { api: 1, entries: {} }, tooMany: { api: 1, entries: Array.from({ length: 201 }, (_, i) => ({ ...base, id: 'aw-n' + i })) },
    duplicate: { api: 1, entries: [base, base] }, id: [{ ...base, id: 'Aw-a' }], idDash: [{ ...base, id: 'aw-a-' }], idLong: [{ ...base, id: 'aw-' + 'a'.repeat(38) }], builtIn: [{ ...base, id: 'misty' }],
    title: [{ ...base, title: '' }], titleBlank: [{ ...base, title: '   ' }], titleLong: [{ ...base, title: 'x'.repeat(121) }], titleType: [{ ...base, title: 5 }],
    rev: [{ ...base, rev: '0'.repeat(12) }], revFormat: [{ ...base, rev: 'XYZ' }], tone: [{ ...base, tone: 'grey' }], ut: [{ ...base, ut: { tr: 'mist' } }], utValue: [{ ...base, ut: { tr: 'mist', br: 'bright' } }],
    veil: [{ ...base, frostVeil: 0.25 }], column: [{ ...base, listColumn: true }], columnValue: [{ ...base, listColumn: 1 }], quiet: [{ ...base, dockQuiet: 'yes' }], mist: [{ ...base, clockMist: 1 }],
    noFiles: [{ ...base, files: undefined }], role: [{ ...base, files: { ...base.files, extra: base.files.jpg } }], missingRole: [{ ...base, files: { ...base.files, panel: undefined } }],
    path: [{ ...base, files: { ...base.files, thumb: { ...base.files.thumb, path: 'cleantv-wallpapers/generated/aw-b/thumb.jpg' } } }],
    size: [{ ...base, files: { ...base.files, panel: { ...base.files.panel, size: 65537 } } }], sizeType: [{ ...base, files: { ...base.files, panel: { ...base.files.panel, size: 1.5 } } }],
    sha: [{ ...base, files: { ...base.files, thumb: { ...base.files.thumb, sha256: 'A'.repeat(64) } } }]
  };
  for (const [name, value] of Object.entries(variants)) {
    const h = harness(); h.bind(); h.install([good]);
    const before = h.remote(), requests = h.requests().length;
    h.routes.set(INDEX, { body: buffer(JSON.stringify(Array.isArray(value) ? { api: 1, entries: value } : value)) });
    h.clock.now += 60001; h.walls.picker(); h.flush();
    assert.equal(h.requests().length, requests + 1, name + ' fetched');
    assert.deepEqual(h.remote(), before, name + ' keeps the previous wallpapers');
    assert.equal(h.walls.message(), 'Add-on wallpapers could not be updated.', name);
  }
  const transport = { http: { status: 404, body: buffer('x') }, address: { body: buffer(indexOf([good])), url: BASE + 'other.json' }, large: { body: buffer(' '.repeat(262145)) },
    utf8: { body: new Uint8Array([0x7b, 0xff, 0x7d]).buffer }, json: { body: buffer('{"api":1,') }, offline: 'offline' };
  for (const [name, route] of Object.entries(transport)) {
    const h = harness(); h.bind(); h.install([good]);
    h.routes.set(INDEX, route); h.clock.now += 60001; h.walls.picker(); h.flush();
    assert.deepEqual(h.remote(), ['aw-a'], name);
    assert.equal(h.walls.message(), 'Add-on wallpapers could not be updated.', name);
  }
  // Missing appearance fields get the safe defaults.
  const h = harness(), bare = photo('aw-d');
  ['tone', 'ut', 'frostVeil', 'listColumn'].forEach(key => delete bare.entry[key]);
  h.bind(); h.install([bare]);
  assert.deepEqual(plain(h.list.find(w => w.id === 'aw-d')).ut, { tr: 'mist', br: 'mist' });
  assert.equal(h.list.find(w => w.id === 'aw-d').tone, 'light');
  assert.equal(h.list.find(w => w.id === 'aw-d').frostVeil, 0.2);
});

test('the chosen add-on photo is downloaded, verified and stored; another choice deletes it', () => {
  const h = harness(), a = photo('aw-a'), b = photo('aw-b');
  h.bind(); h.install([a, b]);
  const before = h.requests().length;
  h.set({ wall: 'aw-a', shown: 'aw-a' });
  assert.deepEqual(h.requests().slice(before), ROLES.map(role => BASE + a.entry.files[role].path), 'seven files, in role order');
  assert.deepEqual(h.idb.files(), ROLES.map(role => 'aw-a/' + role).sort());
  assert.equal(h.walls.stored('aw-a'), true);
  assert.deepEqual(h.record().stored, { 'aw-a': a.entry.rev });
  const local = h.resolved('aw-a');
  assert.ok(local.every(u => u.startsWith('blob:qa/')), 'resolve gives object URLs');
  assert.equal(h.urls.created[0].blob.type, 'image/jpeg');
  // Choosing another photo deletes the copy, but only once it is no longer shown.
  h.set({ wall: 'aw-b' });
  assert.deepEqual(h.idb.files().filter(k => k.startsWith('aw-a/')).length, 7, 'still shown: kept');
  h.set({ shown: 'aw-b' });
  assert.deepEqual(h.idb.files(), ROLES.map(role => 'aw-b/' + role).sort());
  assert.equal(h.walls.stored('aw-a'), false);
  assert.ok(local.every(u => h.urls.revoked.includes(u)), 'its object URLs are revoked');
  assert.equal(h.walls.url('aw-a', 'jpg'), BASE + 'cleantv-wallpapers/generated/aw-a/image.jpg');
  // A built-in choice deletes the last add-on copy.
  h.set({ wall: 'cove', shown: 'cove' });
  assert.deepEqual(h.idb.files(), []);
  assert.deepEqual(h.record().stored, {});
});

test('a file that fails its checksum or size is not stored and the photo keeps streaming', () => {
  for (const broken of ['bytes', 'size', 'address']) {
    const h = harness(), a = photo('aw-a');
    h.bind(); h.install([a]);
    const path = BASE + a.entry.files.panel.path;
    if (broken === 'bytes') h.routes.set(path, { body: buffer(Buffer.from(a.bytes.panel).fill(65, 0, 1)) });
    if (broken === 'size') h.routes.set(path, { body: buffer(Buffer.concat([a.bytes.panel, Buffer.from('!')])) });
    if (broken === 'address') h.routes.set(path, { body: buffer(a.bytes.panel), url: path + '?moved' });
    h.set({ wall: 'aw-a', shown: 'aw-a' });
    assert.deepEqual(h.idb.files(), [], broken);
    assert.equal(h.walls.stored('aw-a'), false, broken);
    assert.ok(h.resolved('aw-a').every(u => u.startsWith(BASE)), broken + ' streams');
    if (broken === 'bytes') assert.equal(h.walls.message(), 'A wallpaper download did not match its checksum.');
    // The failure waits ten minutes; a later Home visit tries again.
    const count = h.requests().length;
    h.walls.home(); h.flush();
    assert.equal(h.requests().length, count, broken + ' waits');
    h.routes.set(path, { body: buffer(a.bytes.panel) });
    h.clock.now += 600001; h.walls.home(); h.flush();
    assert.equal(h.walls.stored('aw-a'), true, broken + ' recovers');
  }
});

test('rotation keeps at most ten add-on favourites; turning it off deletes them but keeps the stars', () => {
  const h = harness(), photos = Array.from({ length: 12 }, (_, i) => photo('aw-p' + i));
  const ids = photos.map(p => p.entry.id);
  h.bind({ wall: 'misty' }); h.install(photos);
  h.set({ favourites: ['cove'].concat(ids) });
  assert.deepEqual(h.idb.files(), [], 'rotation off: favourites are not stored');
  h.set({ rotation: true });
  const stored = ids.filter(id => h.walls.stored(id));
  assert.deepEqual(stored, ids.slice(0, 10), 'the first ten add-on favourites in starring order');
  assert.equal(h.walls.limit, 10);
  assert.equal(h.idb.files().length, 70);
  // The chosen photo is kept on top of the ten.
  h.set({ wall: 'aw-p11', shown: 'aw-p11' });
  assert.equal(h.walls.stored('aw-p11'), true);
  assert.equal(h.idb.files().length, 77);
  // Rotation off: only the chosen photo stays; the favourites list itself is untouched.
  h.set({ rotation: false });
  assert.deepEqual(ids.filter(id => h.walls.stored(id)), ['aw-p11']);
  assert.equal(h.model.favourites.length, 13);
});

test('object URLs are released once a photo is no longer shown, also for kept favourites', () => {
  const h = harness(), photos = Array.from({ length: 4 }, (_, i) => photo('aw-u' + i));
  const ids = photos.map(p => p.entry.id);
  h.bind({ wall: 'misty' }); h.install(photos);
  h.set({ favourites: ids, rotation: true });
  assert.deepEqual(ids.filter(id => h.walls.stored(id)), ids, 'rotation keeps the four favourites');
  // Rotation visits every favourite; each is shown from its local copy.
  const seen = {};
  for (const id of ids) {
    h.set({ wall: id, shown: id });
    seen[id] = h.resolved(id);
    assert.ok(seen[id].every(u => u.startsWith('blob:qa/')), id + ' is shown from its local copy');
    assert.ok(seen[id].every(u => !h.urls.revoked.includes(u)), id + ' keeps its URLs while shown');
  }
  for (const id of ids.slice(0, -1)) assert.ok(seen[id].every(u => h.urls.revoked.includes(u)), id + ' left the screen: its URLs are revoked');
  h.set({ wall: 'misty', shown: 'misty' });
  const live = h.urls.created.map(c => c.url).filter(u => !h.urls.revoked.includes(u));
  assert.deepEqual(live, [], 'no object URL stays live for photos that are not shown');
  assert.deepEqual(ids.filter(id => h.walls.stored(id)), ids, 'the favourites stay stored');
  assert.equal(h.walls.url('aw-u0', 'jpg'), BASE + 'cleantv-wallpapers/generated/aw-u0/image.jpg', 'not shown: the stream address');
  // Shown again: new object URLs from IndexedDB, without a download.
  const count = h.requests().length;
  h.set({ wall: 'aw-u0', shown: 'aw-u0' });
  const again = h.resolved('aw-u0');
  assert.ok(again.every(u => u.startsWith('blob:qa/') && !seen['aw-u0'].includes(u)));
  assert.equal(h.requests().length, count);
});

test('a quota failure keeps streaming, stops further downloads and names the cause', () => {
  const h = harness(), photos = Array.from({ length: 3 }, (_, i) => photo('aw-q' + i));
  h.bind(); h.install(photos);
  h.idb.quota = 1200; // room for one photo (about 880 bytes)
  h.set({ favourites: photos.map(p => p.entry.id), rotation: true });
  assert.deepEqual(photos.map(p => h.walls.stored(p.entry.id)), [true, false, false]);
  assert.equal(h.walls.message(), 'Storage is full. Add-on wallpapers are streamed.');
  const count = h.requests().length;
  h.clock.now += 600001; h.walls.home(); h.flush();
  assert.equal(h.requests().length, count, 'no download retry while storage is full');
  assert.ok(h.resolved('aw-q1').every(u => u.startsWith(BASE)), 'the photo that did not fit streams');
  assert.ok(h.resolved('aw-q0').every(u => u.startsWith('blob:')));
  // A full startup record behaves the same.
  const k = harness(); k.bind(); k.install([photos[0]]);
  k.local.quota = true;
  k.set({ wall: 'aw-q0', shown: 'aw-q0' });
  assert.equal(k.walls.stored('aw-q0'), false);
  assert.deepEqual(k.idb.files(), [], 'files are removed again when the record cannot be saved');
  assert.equal(k.walls.message(), 'Storage is full. Add-on wallpapers are streamed.');
});

test('without IndexedDB the add-on photos stream', () => {
  const h = harness(), a = photo('aw-a');
  h.idb.unavailable = true;
  h.bind(); h.install([a]);
  h.set({ wall: 'aw-a', shown: 'aw-a' });
  assert.equal(h.walls.stored('aw-a'), false);
  assert.ok(h.resolved('aw-a').every(u => u.startsWith(BASE)));
});

test('a photo removed from the index stays while it is chosen and leaves afterwards', () => {
  const h = harness(), a = photo('aw-a'), b = photo('aw-b');
  h.bind(); h.install([a, b]);
  h.set({ wall: 'aw-a', shown: 'aw-a' });
  h.serve([b]); h.clock.now += 60001; h.walls.picker(); h.flush();
  assert.deepEqual(h.remote(), ['aw-b', 'aw-a']);
  assert.equal(h.list.find(w => w.id === 'aw-a').gone, true);
  assert.ok(h.resolved('aw-a').every(u => u.startsWith('blob:')), 'its local copy still works');
  h.set({ wall: 'aw-b', shown: 'aw-b' });
  assert.deepEqual(h.remote(), ['aw-b']);
  assert.deepEqual(h.idb.files(), ROLES.map(role => 'aw-b/' + role).sort());
  // A replaced image (new revision) is downloaded again; the old copy is overwritten.
  const b2 = photo('aw-b', { seed: '2' });
  h.serve([b2]); h.clock.now += 60001; h.walls.picker(); h.flush();
  assert.equal(h.list.find(w => w.id === 'aw-b').rev, b2.entry.rev);
  assert.equal(h.record().stored['aw-b'], b2.entry.rev);
});

test('uninstall switches to a built-in photo first, then removes entries and data', () => {
  const h = harness(), a = photo('aw-a');
  h.bind(); h.install([a]);
  h.set({ wall: 'aw-a', shown: 'aw-a', favourites: ['aw-a', 'cove'], rotation: true });
  const local = h.resolved('aw-a');
  h.addons({ action: 'remove', id: ID }); h.flush();
  assert.equal(h.model.leaves, 1, 'Home was asked to leave the add-on photo');
  assert.equal(h.model.wall, 'misty');
  assert.deepEqual(h.remote(), []);
  assert.equal(h.record(), null);
  assert.deepEqual([...h.local.map.keys()].filter(k => k.startsWith(PREFIX)), []);
  assert.ok(h.idb.log.includes('delete cleantv-wallpapers'));
  assert.ok(local.every(u => h.urls.revoked.includes(u)));
  const count = h.requests().length;
  h.clock.now += DAY; h.walls.home(); h.walls.picker(); h.flush();
  assert.equal(h.requests().length, count, 'no request after removal');
});

test('disable keeps the data and Enable restores the entries', () => {
  const h = harness(), a = photo('aw-a');
  h.bind(); h.install([a]);
  h.set({ wall: 'aw-a', shown: 'aw-a' });
  h.addons({ action: 'toggle', id: ID }); h.flush();
  assert.equal(h.model.wall, 'misty');
  assert.deepEqual(h.remote(), []);
  assert.equal(h.record().active, false);
  assert.equal(h.record().entries.length, 1);
  const count = h.requests().length;
  h.walls.picker(); h.clock.now += DAY; h.walls.home(); h.flush();
  assert.equal(h.requests().length, count, 'a disabled package sends nothing');
  h.addons({ action: 'toggle', id: ID }); h.flush();
  assert.deepEqual(h.remote(), ['aw-a']);
  assert.equal(h.requests().at(-1), INDEX, 'Enable checks the index');
});

test('a reload keeps the add-on entries before Home starts and needs no network for a stored photo', () => {
  const local = storage(), db = sharedDB(), clock = { now: 1700000000000 };
  const first = harness({ local, db, clock }), a = photo('aw-a');
  first.bind(); first.install([a]);
  first.set({ wall: 'aw-a', shown: 'aw-a' });
  assert.equal(first.walls.stored('aw-a'), true);
  // Restart: the entries are appended while the module loads, before main.js would validate the saved ID.
  const second = harness({ local, db, clock });
  assert.deepEqual(second.remote(), ['aw-a']);
  assert.deepEqual(second.requests(), []);
  second.bind({ wall: 'aw-a' });
  assert.ok(second.resolved('aw-a').every(u => u.startsWith('blob:')));
  assert.deepEqual(second.requests(), [], 'startup with a stored photo sends nothing');
  // At most once a day while Home is visible the index is checked again.
  second.serve([a]);
  second.walls.home(); second.flush();
  assert.deepEqual(second.requests(), []);
  clock.now += DAY; second.walls.home(); second.flush();
  assert.deepEqual(second.requests(), [INDEX]);
  second.walls.home(); second.flush();
  assert.deepEqual(second.requests(), [INDEX], 'not twice a day');
  // The picker checks again after a minute.
  second.walls.picker(); second.flush();
  assert.deepEqual(second.requests(), [INDEX]);
  clock.now += 60001; second.walls.picker(); second.flush();
  assert.deepEqual(second.requests(), [INDEX, INDEX]);
});

test('a startup record without the package changes nothing and is never trusted for network', () => {
  const local = storage(), db = sharedDB(), clock = { now: 1700000000000 };
  const first = harness({ local, db, clock }), a = photo('aw-a');
  first.bind(); first.install([a]);
  // Another profile with only the wallpaper record and no add-on host record.
  const copy = storage(Object.fromEntries([...local.map].filter(([k]) => k.startsWith(PREFIX))));
  const second = harness({ local: copy, clock });
  assert.deepEqual(second.remote(), ['aw-a'], 'appended for the saved ID');
  second.bind();
  assert.deepEqual(second.remote(), [], 'the host has no package: the entries leave');
  assert.equal(second.record(), null);
  assert.deepEqual(second.requests(), []);
});

test('a stale or incomplete local copy is never shown; it streams and is downloaded again', () => {
  const h = harness(), a = photo('aw-a');
  h.bind(); h.install([a]);
  h.set({ wall: 'aw-a', shown: 'aw-a' });
  const files = h.idb.dbs.get('cleantv-wallpapers').stores.get('files');
  files.set('aw-a/panel', { ...files.get('aw-a/panel'), rev: '000000000000' });
  let count = h.requests().length;
  assert.ok(h.resolved('aw-a').every(u => u.startsWith(BASE)), 'a file of another revision streams');
  assert.equal(h.requests().length, count + 7, 'the copy is downloaded again');
  assert.equal(h.walls.stored('aw-a'), true);
  assert.equal(files.get('aw-a/panel').rev, a.entry.rev);
  // A missing file behaves the same after a restart (no cached object URLs).
  const k = harness(), b = photo('aw-b');
  k.bind(); k.install([b]); k.set({ wall: 'aw-b', shown: 'aw-b' });
  k.idb.dbs.get('cleantv-wallpapers').stores.get('files').delete('aw-b/thumb');
  count = k.requests().length;
  assert.ok(k.resolved('aw-b').every(u => u.startsWith(BASE)));
  assert.equal(k.requests().length, count + 7);
  assert.ok(k.resolved('aw-b').every(u => u.startsWith('blob:')));
});
