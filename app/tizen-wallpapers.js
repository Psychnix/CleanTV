/* CleanTV add-on wallpapers (kind "wallpapers"). The reviewed index from the add-on fork adds photos
   to window.CleanFrameWallpapers. The chosen photo, and up to ten favourites while rotation is on, are
   kept verified in IndexedDB; the others stream from raw.githubusercontent.com. The index is JSON data
   and the files are JPEGs: nothing downloaded is ever executed. See docs/addons.md, "Wallpapers". */
(function () {
  'use strict';
  var ID = 'cleantv-wallpapers', INDEX = 'cleantv-wallpapers/index.json';
  // config.xml allows this origin; fixed paths keep requests on the reviewed repository.
  var BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/', INDEX_URL = BASE + INDEX;
  var PREFIX = 'cleantv.wallpapers.v1', DB_NAME = 'cleantv-wallpapers';
  var INDEX_LIMIT = 262144, MAX_ENTRIES = 200, KEEP = 10, DAY = 86400000, PICKER_GAP = 60000, TIMEOUT = 15000, FILE_TIMEOUT = 60000;
  var ROLES = ['jpg', 'thumb', 'panel', 'study-soft', 'field-blur', 'field-frost', 'field-clear'];
  var NAMES = { jpg: 'image.jpg', thumb: 'thumb.jpg', panel: 'panel.jpg', 'study-soft': 'study-soft.jpg', 'field-blur': 'field-blur.jpg', 'field-frost': 'field-frost.jpg', 'field-clear': 'field-clear.jpg' };
  var LIMITS = { jpg: 4194304, thumb: 262144, panel: 65536, 'study-soft': 2097152, 'field-blur': 2097152, 'field-frost': 2097152, 'field-clear': 2097152 };
  var WALL_ID = /^aw-[a-z0-9]+(?:-[a-z0-9]+)*$/, REV = /^[a-f0-9]{12}$/, CHECKSUM = /^[a-f0-9]{64}$/;
  var VEILS = [0.12, 0.2, 0.3, 0.36, 0.44], INKS = ['light', 'mist', 'dark'], COLUMNS = [0, 2, 3];
  var FULL = 'Storage is full. Add-on wallpapers are streamed.', STALE = 'Add-on wallpapers could not be updated.', MISMATCH = 'A wallpaper download did not match its checksum.';

  /* ---------- Kind ---------- */
  function cleantv(name) {
    var r = window[name];
    if (!r) { r = window[name] = { queue: [] }; r.register = function () { r.queue.push(Array.prototype.slice.call(arguments)); }; }
    return r;
  }
  // The host keeps identity, path and checksum; the package adds only its fixed index path.
  cleantv('CleanTVAddonKinds').register('wallpapers', { widget: false, validate: function (entry) {
    if (entry.index !== INDEX) throw new Error('Unsupported wallpaper index.');
    return { index: INDEX };
  } });

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function now() { return Date.now(); }
  function later(fn) { window.setTimeout(fn, 0); }
  function path(id, role) { return 'cleantv-wallpapers/generated/' + id + '/' + NAMES[role]; }
  function own(e) { var o = new Error(e); o.own = true; return o; }

  /* ---------- Index validation ---------- */
  function integer(value) { return typeof value === 'number' && isFinite(value) && Math.floor(value) === value; }
  /* One entry, strictly: unknown fields are dropped, known ones must be exact. full keeps the files map. */
  function entry(e, full) {
    var out, files = {}, ok;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw own('entry');
    if (typeof e.id !== 'string' || e.id.length > 40 || !WALL_ID.test(e.id)) throw own('id');
    if (typeof e.title !== 'string' || !e.title.replace(/\s+/g, '') || e.title.length > 120) throw own('title');
    if (typeof e.rev !== 'string' || !REV.test(e.rev)) throw own('rev');
    out = { id: e.id, title: e.title, rev: e.rev, tone: 'light', ut: { tr: 'mist', br: 'mist' }, frostVeil: 0.2 };
    // Safe defaults when a field is absent: heavier scrims, the mist halo and a medium Frost veil.
    if (e.tone !== undefined) { if (e.tone !== 'light' && e.tone !== 'dark') throw own('tone'); out.tone = e.tone; }
    if (e.ut !== undefined) {
      if (!e.ut || typeof e.ut !== 'object' || INKS.indexOf(e.ut.tr) < 0 || INKS.indexOf(e.ut.br) < 0) throw own('ut');
      out.ut = { tr: e.ut.tr, br: e.ut.br };
    }
    if (e.frostVeil !== undefined) { if (VEILS.indexOf(e.frostVeil) < 0) throw own('frostVeil'); out.frostVeil = e.frostVeil; }
    if (e.listColumn !== undefined) { if (!integer(e.listColumn) || COLUMNS.indexOf(e.listColumn) < 0) throw own('listColumn'); if (e.listColumn) out.listColumn = e.listColumn; }
    if (e.dockQuiet !== undefined) { if (typeof e.dockQuiet !== 'boolean') throw own('dockQuiet'); if (e.dockQuiet) out.dockQuiet = true; }
    if (e.clockMist !== undefined) { if (typeof e.clockMist !== 'boolean') throw own('clockMist'); if (e.clockMist) out.clockMist = true; }
    if (!full) return out;
    if (!e.files || typeof e.files !== 'object' || Array.isArray(e.files)) throw own('files');
    ok = ROLES.every(function (role) {
      var f = e.files[role];
      if (!f || typeof f !== 'object' || f.path !== path(e.id, role) || !integer(f.size) || f.size < 1 || f.size > LIMITS[role] || typeof f.sha256 !== 'string' || !CHECKSUM.test(f.sha256)) return false;
      files[role] = { path: f.path, size: f.size, sha256: f.sha256 };
      return true;
    });
    if (!ok || Object.keys(e.files).length !== ROLES.length) throw own('files');
    if (files.jpg.sha256.slice(0, 12) !== e.rev) throw own('rev');
    out.files = files;
    return out;
  }
  function parse(body) {
    var root, seen = {};
    root = JSON.parse(body);
    if (!root || typeof root !== 'object' || root.api !== 1 || !Array.isArray(root.entries) || root.entries.length > MAX_ENTRIES) throw own('index');
    return root.entries.map(function (e) {
      var item = entry(e, true);
      if (has(seen, item.id)) throw own('duplicate');
      seen[item.id] = true;
      return item;
    });
  }
  function decode(buffer) {
    var bytes = new window.Uint8Array(buffer), binary = '', i;
    if (window.TextDecoder) return new window.TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
  }

  /* ---------- Startup record (CleanTVStore) ----------
     {active, version, checked, entries: [metadata without files], stored: {id: rev}, gone: [ids]} */
  var STORE = window.CleanTVStore, SHA = window.CleanTVSha256;
  function light(e) { var out = entry(e, false); if (e.gone) out.gone = true; return out; }
  function readRecord() {
    var data = null, out = { active: false, version: '', checked: 0, entries: [], stored: {} }, seen = {};
    try { data = STORE && STORE.read(PREFIX); } catch (e) { data = null; }
    if (!data || typeof data !== 'object') return out;
    out.active = data.active === true;
    out.version = typeof data.version === 'string' ? data.version : '';
    out.checked = typeof data.checked === 'number' && isFinite(data.checked) ? data.checked : 0;
    (Array.isArray(data.entries) ? data.entries : []).slice(0, MAX_ENTRIES + 16).forEach(function (e) {
      var item = null;
      try { item = light(e); } catch (error) { item = null; }
      if (item && !has(seen, item.id)) { seen[item.id] = true; out.entries.push(item); }
    });
    if (data.stored && typeof data.stored === 'object') Object.keys(data.stored).forEach(function (id) {
      // Kept even without an entry, so the next sync deletes those files.
      if (WALL_ID.test(id) && typeof data.stored[id] === 'string' && REV.test(data.stored[id])) out.stored[id] = data.stored[id];
    });
    return out;
  }
  var record = readRecord(), saveFailed = false;
  function save() {
    try { STORE.write(PREFIX, record); saveFailed = false; return true; } catch (e) { saveFailed = true; return false; }
  }

  /* ---------- Wallpaper list ---------- */
  var walls = Array.isArray(window.CleanFrameWallpapers) ? window.CleanFrameWallpapers : null;
  function find(id) { if (walls) for (var i = 0; i < walls.length; i++) if (walls[i].id === id) return walls[i]; return null; }
  function remote(id) { var w = find(id); return !!(w && w.remote === true); }
  function shape(target, e) {
    target.id = e.id; target.name = e.title; target.remote = true; target.rev = e.rev; target.tone = e.tone;
    target.ut = { tr: e.ut.tr, br: e.ut.br }; target.frostVeil = e.frostVeil;
    target.listColumn = e.listColumn || 0; target.dockQuiet = !!e.dockQuiet; target.clockMist = !!e.clockMist;
    target.files = {};
    ROLES.forEach(function (role) { target.files[role] = { path: path(e.id, role) }; });
    if (e.gone) target.gone = true; else delete target.gone;
    return target;
  }
  /* Main.js reads WALLS by reference: entries change in place and remote ones stay after the built-ins. */
  function rebuild(list) {
    var kept = {}, i;
    for (i = walls.length - 1; i >= 0; i--) if (walls[i].remote === true) { kept[walls[i].id] = walls[i]; walls.splice(i, 1); }
    list.forEach(function (e) { if (!find(e.id)) walls.push(shape(has(kept, e.id) ? kept[e.id] : {}, e)); });
  }
  function attach() { if (walls) rebuild(record.entries); }
  // Before main.js validates the saved wallpaper: a saved add-on ID is kept when the package was active.
  if (record.active) attach();

  /* ---------- Host binding (main.js) ---------- */
  var host = null, message = '', full = null, fetching = false, lastAttempt = 0, quota = false, retiring = null;
  var failed = {}, RETRY = 600000; // id -> time of the last failed download
  function state() {
    var s = host ? host.state() : null;
    return s || { wall: '', favourites: [], rotation: false, inUse: [] };
  }
  function update(mutate) { if (host) host.update(mutate); else mutate(); }
  function changed() { if (host) later(function () { host.changed(); }); }
  function addon() {
    var api = window.CleanTVAddons, item = api && api.installed(ID);
    return { installed: !!item, enabled: !!(api && api.enabled(ID)), version: item && typeof item.version === 'string' ? item.version : '' };
  }
  function allowed() { return !retiring && addon().enabled; }

  /* ---------- Network ---------- */
  /* GET without headers or credentials; done(error, buffer). The final address must be the requested one. */
  function get(url, limit, timeout, done) {
    var request = new window.XMLHttpRequest(), ended = false;
    function end(error, buffer) { if (!ended) { ended = true; done(error, buffer); } }
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';
    request.timeout = timeout;
    request.withCredentials = false;
    request.onprogress = function (event) { if (event.loaded > limit) { request.abort(); end('size'); } };
    request.ontimeout = function () { end('timeout'); };
    request.onerror = function () { end('network'); };
    request.onabort = function () { end('network'); };
    request.onload = function () {
      var buffer = request.response;
      if (request.status !== 200) { end('http'); return; }
      if (request.responseURL !== url) { end('address'); return; }
      if (!buffer || buffer.byteLength > limit) { end('size'); return; }
      end('', buffer);
    };
    try { request.send(); } catch (e) { end('network'); }
  }
  function check() {
    if (!allowed() || fetching) return;
    fetching = true; lastAttempt = now();
    get(INDEX_URL, INDEX_LIMIT, TIMEOUT, function (error, buffer) {
      var list = null;
      fetching = false;
      if (!error) { try { list = parse(decode(buffer)); } catch (e) { list = null; } }
      // A failed or invalid index keeps the previous wallpapers.
      if (!list) { message = STALE; changed(); return; }
      if (!allowed()) return;
      apply(list);
    });
  }
  function apply(list) {
    var st = state(), use = {}, gone = [];
    full = list;
    st.inUse.concat([st.wall]).forEach(function (id) { if (id) use[id] = true; });
    // A photo removed from the index stays while it is shown or chosen, marked gone.
    record.entries.forEach(function (e) { if (use[e.id] && !list.some(function (n) { return n.id === e.id; })) gone.push(light(e)); });
    gone.forEach(function (e) { e.gone = true; });
    record.entries = list.map(function (e) { return light(e); }).concat(gone);
    record.checked = now(); record.active = true; record.version = addon().version;
    failed = {};
    update(function () { if (walls) rebuild(record.entries); });
    if (message === STALE) message = '';
    save(); writeMeta(list); changed(); sync();
  }

  /* ---------- IndexedDB: files {id/role: {id, rev, role, data}} and meta {index: entries} ---------- */
  var database = null, opening = null;
  function db(done) {
    var factory = null, request;
    if (database) { done(database); return; }
    if (opening) { opening.push(done); return; }
    opening = [done];
    function finish(value) {
      var list = opening;
      // A late success after onblocked keeps the connection for the next call.
      if (!list) { if (value && !database) database = value; return; }
      database = value; opening = null;
      list.forEach(function (fn) { fn(value); });
    }
    try { factory = window.indexedDB || window.webkitIndexedDB || null; } catch (e) { factory = null; }
    if (!factory) { finish(null); return; }
    try { request = factory.open(DB_NAME, 1); } catch (e) { finish(null); return; }
    request.onupgradeneeded = function () {
      var d = request.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    request.onsuccess = function () { var d = request.result; d.onversionchange = function () { d.close(); database = null; }; finish(d); };
    request.onerror = function () { finish(null); };
    request.onblocked = function () { finish(null); };
  }
  /* One transaction; done(errorName) with '' on success. */
  function transact(stores, mode, work, done) {
    db(function (d) {
      var tx, ended = false;
      function end(error) { if (!ended) { ended = true; done(error); } }
      if (!d) { end('unavailable'); return; }
      try { tx = d.transaction(stores, mode); work(tx); } catch (e) { try { if (tx) tx.abort(); } catch (ignore) { /* already finished */ } end(e && e.name || 'failed'); return; }
      tx.oncomplete = function () { end(''); };
      tx.onabort = tx.onerror = function () { end(tx.error && tx.error.name || 'failed'); };
    });
  }
  function writeMeta(list) { transact(['meta'], 'readwrite', function (tx) { tx.objectStore('meta').put({ entries: list }, 'index'); }, function () {}); }
  function readMeta(done) {
    var value = null;
    transact(['meta'], 'readonly', function (tx) { var r = tx.objectStore('meta').get('index'); r.onsuccess = function () { value = r.result; }; }, function (error) {
      var list = null;
      if (!error && value && Array.isArray(value.entries)) { try { list = value.entries.map(function (e) { return entry(e, true); }); } catch (e) { list = null; } }
      done(list);
    });
  }

  /* ---------- Local copies ---------- */
  var urls = {}; // id -> {rev, map: role -> object URL}
  function objectURL(buffer) {
    var U = window.URL || window.webkitURL;
    return U.createObjectURL(new window.Blob([buffer], { type: 'image/jpeg' }));
  }
  function revoke(id) {
    var U = window.URL || window.webkitURL, item = urls[id];
    delete urls[id];
    if (item && U && U.revokeObjectURL) ROLES.forEach(function (role) { try { U.revokeObjectURL(item.map[role]); } catch (e) { /* already gone */ } });
  }
  function canStore() { var U = window.URL || window.webkitURL; return !!(window.Blob && U && U.createObjectURL); }
  /* Local object URLs when a complete verified copy exists, otherwise the stream addresses. */
  function resolve(id, done) {
    var w = find(id), rev = w && w.rev, found = {}, missing = false;
    if (!w || w.remote !== true || record.stored[id] !== rev || !canStore() || urls[id] && urls[id].rev === rev) { later(done); return; }
    transact(['files'], 'readonly', function (tx) {
      var store = tx.objectStore('files');
      ROLES.forEach(function (role) {
        var r = store.get(id + '/' + role);
        r.onsuccess = function () { var v = r.result; if (v && v.rev === rev && v.data) found[role] = v.data; else missing = true; };
      });
    }, function (error) {
      var map = {};
      if (!error && !missing && find(id) === w && w.rev === rev) {
        try { ROLES.forEach(function (role) { map[role] = objectURL(found[role]); }); urls[id] = { rev: rev, map: map }; } catch (e) { missing = true; }
      } else missing = true;
      // An incomplete copy is forgotten; the next sync downloads it again.
      if (missing && record.stored[id] === rev) { delete record.stored[id]; save(); later(sync); }
      done();
    });
  }
  function url(id, role) {
    var item = urls[id], w = find(id);
    if (item && w && item.rev === w.rev && item.map[role]) return item.map[role];
    return BASE + path(id, role);
  }

  /* ---------- Storage rules ----------
     Keep the chosen add-on photo; with rotation on also the first ten add-on favourites (in starring
     order). Nothing that is shown, previewed or chosen is deleted. */
  function plan() {
    var st = state(), keep = [], use = {}, n = 0;
    function add(id) { if (remote(id) && keep.indexOf(id) < 0) keep.push(id); }
    add(st.wall);
    if (st.rotation) st.favourites.forEach(function (id) { if (remote(id) && n < KEEP) { n++; add(id); } });
    st.inUse.concat([st.wall]).forEach(function (id) { if (id) use[id] = true; });
    return { keep: keep, use: use };
  }
  var running = false, again = false, scheduled = false;
  function sync() {
    if (scheduled) return;
    scheduled = true;
    later(function () { scheduled = false; if (running) { again = true; return; } run(); });
  }
  function idle() { running = false; if (again) { again = false; sync(); } }
  function run() {
    var p, drop, need;
    if (!host) return;
    running = true;
    if (retiring) { retire(); return; }
    p = plan();
    // A gone photo that is no longer in use leaves the list.
    if (record.entries.some(function (e) { return e.gone && !p.use[e.id]; })) {
      record.entries = record.entries.filter(function (e) { return !e.gone || p.use[e.id]; });
      update(function () { if (walls) rebuild(record.entries); });
      save(); changed();
    }
    drop = Object.keys(record.stored).filter(function (id) { return p.keep.indexOf(id) < 0 && !p.use[id]; });
    Object.keys(urls).forEach(function (id) { if (!p.use[id] && (record.stored[id] !== urls[id].rev || drop.indexOf(id) >= 0)) revoke(id); });
    if (drop.length) {
      transact(['files'], 'readwrite', function (tx) {
        var store = tx.objectStore('files');
        drop.forEach(function (id) { ROLES.forEach(function (role) { store['delete'](id + '/' + role); }); });
      }, function (error) {
        if (!error) { drop.forEach(function (id) { delete record.stored[id]; revoke(id); }); quota = false; save(); }
        idle();
        if (!error) sync();
      });
      return;
    }
    need = p.keep.filter(function (id) { var w = find(id); return w && !w.gone && record.stored[id] !== w.rev && !(now() - (failed[id] || -RETRY) < RETRY); })[0];
    if (!need || quota || !allowed() || !canStore()) { idle(); return; }
    // Without IndexedDB nothing is downloaded: every add-on photo streams.
    db(function (d) {
      if (d) fetchCopy(need, stored); else idle();
    });
    function stored(error) {
      if (error === 'QuotaExceededError') { quota = true; message = FULL; }
      else if (error === 'checksum') message = MISMATCH;
      else if (!error && (message === FULL || message === MISMATCH)) message = '';
      // A failed photo waits ten minutes before it is tried again, unless a new index arrives.
      if (error) failed[need] = now();
      changed(); idle();
      if (!error) sync();
    }
  }
  function known(id, done) {
    var w = find(id), pick = function (list) { var i; for (i = 0; w && list && i < list.length; i++) if (list[i].id === id && list[i].rev === w.rev) return list[i]; return null; };
    if (pick(full)) { done(pick(full)); return; }
    readMeta(function (list) { if (list && !full) full = list; done(pick(list)); });
  }
  /* Download, verify and store all seven files of one photo, or nothing. */
  function fetchCopy(id, done) {
    known(id, function (meta) {
      var buffers = {}, i = 0;
      if (!meta) { done('unknown'); return; }
      (function step() {
        var role, file;
        if (i >= ROLES.length) { store(meta, buffers, done); return; }
        role = ROLES[i++]; file = meta.files[role];
        get(BASE + file.path, file.size, FILE_TIMEOUT, function (error, buffer) {
          if (error) { done(error); return; }
          // Hashing is synchronous; one file per task keeps each pause short.
          later(function () {
            if (buffer.byteLength !== file.size || SHA.bytes(new window.Uint8Array(buffer)) !== file.sha256) { done('checksum'); return; }
            buffers[role] = buffer;
            step();
          });
        });
      }());
    });
  }
  function store(meta, buffers, done) {
    var w = find(meta.id);
    if (!w || w.rev !== meta.rev || plan().keep.indexOf(meta.id) < 0) { done(''); return; }
    transact(['files'], 'readwrite', function (tx) {
      var files = tx.objectStore('files');
      ROLES.forEach(function (role) { files.put({ id: meta.id, rev: meta.rev, role: role, data: buffers[role] }, meta.id + '/' + role); });
    }, function (error) {
      if (error) { done(error); return; }
      record.stored[meta.id] = meta.rev;
      if (save()) { done(''); return; }
      // Without the record the copy would be unknown after a restart: remove it again.
      delete record.stored[meta.id];
      transact(['files'], 'readwrite', function (tx) { ROLES.forEach(function (role) { tx.objectStore('files')['delete'](meta.id + '/' + role); }); }, function () { done('QuotaExceededError'); });
    });
  }

  /* ---------- Package state ---------- */
  function reconcile() {
    var a = addon();
    if (a.enabled && !retiring) {
      if (!record.active) { record.active = true; record.version = a.version; save(); update(attach); changed(); check(); }
      else if (a.version !== record.version) { record.version = a.version; save(); check(); }
    } else if (!a.enabled && (record.active || retiring || !a.installed && (record.entries.length || Object.keys(record.stored).length))) {
      // Disabling keeps the data for a later Enable; uninstalling removes it.
      retiring = { purge: !a.installed || !!(retiring && retiring.purge) };
      sync();
    }
  }
  /* Switch to a built-in photo first, then remove the add-on entries (and on uninstall their data). */
  function retire() {
    var st = state(), purge = retiring.purge;
    if (st.inUse.concat([st.wall]).some(remote)) { host.leave(); idle(); return; }
    retiring = null;
    update(function () { var i; if (walls) for (i = walls.length - 1; i >= 0; i--) if (walls[i].remote === true) walls.splice(i, 1); });
    Object.keys(urls).forEach(revoke);
    message = ''; full = null; quota = false;
    if (purge) {
      record = { active: false, version: '', checked: 0, entries: [], stored: {} };
      try { STORE.clear(PREFIX); } catch (e) { /* nothing stored */ }
      if (database) { try { database.close(); } catch (e) { /* closed */ } database = null; }
      try { if (window.indexedDB) window.indexedDB.deleteDatabase(DB_NAME); } catch (e) { /* no database */ }
    } else { record.active = false; save(); }
    changed();
    // Enabled again while switching: start over.
    if (addon().enabled) reconcile();
    idle();
  }
  window.addEventListener('cleanframe:addons', function () { if (host) reconcile(); });

  window.CleanTVWallpapers = {
    /* host: {state() -> {wall, favourites, rotation, inUse}, update(mutate), leave(), changed()} */
    bind: function (value) { host = value; reconcile(); sync(); },
    resolve: resolve,
    url: url,
    stored: function (id) { var w = find(id); return !!(w && w.remote === true && record.stored[id] === w.rev); },
    limit: KEEP,
    /* Main.js calls these; each fetch needs the installed and enabled package. */
    picker: function () { if (now() - lastAttempt >= PICKER_GAP) check(); },
    home: function () { if (record.active && now() - Math.max(record.checked, lastAttempt) >= DAY) check(); sync(); },
    sync: sync,
    message: function () { return saveFailed && !message ? FULL : message; }
  };
}());
