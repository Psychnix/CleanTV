/* Tizen add-on host, stage 2: reads the reviewed catalog, downloads declarative JSON packages on
   request, verifies them and keeps them in two-slot local storage. Downloaded code never runs. */
(function () {
  'use strict';
  /* ---------- Kind registry (also outside Tizen, so modules can always register) ---------- */
  // Modules loaded before this file may leave {queue: [[kind, definition], ...]}; it is replayed in order.
  var kinds = {}, early = window.CleanTVAddonKinds, BUILT_IN = { text: 1, clock: 1, native: 1 };
  window.CleanTVAddonKinds = {
    register: function (kind, definition) {
      if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(kind) || BUILT_IN[kind] || Object.prototype.hasOwnProperty.call(kinds, kind)) throw new Error('Add-on kind cannot be registered: ' + kind);
      if (!definition || typeof definition.validate !== 'function' || definition.widget !== false) throw new Error('Add-on kind needs validate() and widget: false: ' + kind);
      kinds[kind] = { validate: definition.validate };
    },
    registered: function (kind) { return Object.prototype.hasOwnProperty.call(kinds, kind); }
  };
  // A faulty registration is reported asynchronously and cannot stop the host.
  if (early && Array.isArray(early.queue)) early.queue.forEach(function (args) {
    try { window.CleanTVAddonKinds.register(args[0], args[1]); } catch (e) { window.setTimeout(function () { throw e; }, 0); }
  });

  var listeners = [], installed = {};
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  window.CleanTVAddons = {
    installed: function (id) { return Object.prototype.hasOwnProperty.call(installed, id) ? copy(installed[id]) : null; },
    enabled: function (id) { return Object.prototype.hasOwnProperty.call(installed, id) && installed[id].enabled !== false; },
    on: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (other) { return other !== fn; }); };
    }
  };

  var device = window.FrameDevice;
  if (!window.tizen || !device || device.platform === 'android') return;
  var STORE = window.CleanTVStore, SHA = window.CleanTVSha256;
  // config.xml allows this origin; fixed paths keep requests on the reviewed repository.
  var BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/', CATALOG = BASE + 'cleantv-catalog.json';
  var PREFIX = 'cleantv.addons.v1', LIMIT = 131072, PACKAGE_LIMIT = 65536, TIMEOUT = 15000, MAX_ENTRIES = 32, MAX_WIDGETS = 3;
  var ID = /^[a-z][a-z0-9-]{0,47}$/, VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/, CHECKSUM = /^[a-f0-9]{64}$/;
  var PATH = /^packages\/[a-z0-9-]+\/[0-9]+\.[0-9]+\.[0-9]+\.json$/;
  var IDENTITY = ['api', 'id', 'name', 'version', 'kind', 'description', 'author', 'license', 'permissions'];
  var catalog = [], busy = false, error = '', info = { checked: false, total: 0, compatible: 0 };
  var batch = { status: 'idle', completed: 0, total: 0 }, dormant = {};

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function state() {
    return copy({ installed: installed, catalog: catalog, busy: busy, error: error, api: 2, runtime: {}, pending: {}, batch: batch, catalogInfo: info });
  }
  function fail(message) { var e = new Error(message); e.own = true; throw e; }
  function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
  function described(value) {
    if (text(value, 240)) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var keys = Object.keys(value);
    return keys.length > 0 && keys.every(function (key) { return /^[a-z]{2}$/.test(key) && text(value[key], 240); });
  }
  function zone(name) {
    try { new window.Intl.DateTimeFormat('en', { timeZone: name }).format(new Date()); return true; } catch (e) { return false; }
  }
  /* Identity and metadata shared by every kind. `listed` entries also carry path and sha256. */
  function common(entry, listed) {
    var result = {};
    if (entry.api !== 1 || !ID.test(entry.id) || typeof entry.version !== 'string' || !VERSION.test(entry.version)) fail('Unsupported package identity or API.');
    if (!text(entry.name, 240) || !described(entry.description) || !text(entry.author, 240) || !text(entry.license, 240)) fail('Invalid package metadata.');
    if (listed && (typeof entry.path !== 'string' || !PATH.test(entry.path))) fail('Invalid package path.');
    if (listed && (typeof entry.sha256 !== 'string' || !CHECKSUM.test(entry.sha256))) fail('Invalid package checksum.');
    IDENTITY.forEach(function (key) { if (key !== 'permissions' && entry[key] !== undefined) result[key] = entry[key]; });
    if (Array.isArray(entry.permissions) && entry.permissions.length <= 8 && entry.permissions.every(function (p) { return text(p, 64); })) result.permissions = entry.permissions.slice();
    if (listed) { result.path = entry.path; result.sha256 = entry.sha256; }
    return result;
  }
  // Same rules as the Android host for the widget kinds this TV can show; unknown fields are dropped.
  function widget(entry, listed) {
    if (entry.kind !== 'text' && entry.kind !== 'clock') fail('Unsupported widget kind.');
    var result = common(entry, listed);
    if (entry.text !== undefined && (typeof entry.text !== 'string' || entry.text.length > 500)) fail('Widget text is too long.');
    if (entry.kind === 'clock' && entry.timeZone !== undefined && (typeof entry.timeZone !== 'string' || entry.timeZone.length > 64)) fail('Unsupported time zone.');
    // Chromium 47 knows fewer zone names than Android; such a clock is not offered on this TV.
    if (entry.kind === 'clock' && entry.timeZone !== undefined && !zone(entry.timeZone)) return null;
    if (entry.text !== undefined) result.text = entry.text;
    if (entry.kind === 'clock' && entry.timeZone !== undefined) result.timeZone = entry.timeZone;
    return result;
  }
  /* A registered kind validates its own fields; the host keeps identity, path and checksum. */
  function registered(entry, listed) {
    var base = common(entry, listed), input = copy(entry), result;
    delete input.path; delete input.sha256;
    try { result = kinds[entry.kind].validate(input); }
    catch (e) { fail(e && e.name === 'Error' && typeof e.message === 'string' && /^[^\n]{1,200}\.$/.test(e.message) ? e.message : 'Invalid package metadata.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('Invalid package metadata.');
    result = copy(result);
    delete result.path; delete result.sha256; delete result.enabled;
    IDENTITY.forEach(function (key) { if (has(base, key)) result[key] = base[key]; else delete result[key]; });
    if (listed) { result.path = base.path; result.sha256 = base.sha256; }
    return result;
  }
  function widgetKind(kind) { return kind === 'text' || kind === 'clock'; }
  /* Sanitised entry, null when this TV does not offer it, or an own error for the whole catalog. */
  function offer(entry, listed) {
    if (widgetKind(entry.kind)) return widget(entry, listed);
    if (typeof entry.kind === 'string' && has(kinds, entry.kind)) return registered(entry, listed);
    // Native packages, Spotify without its host module and kinds from newer catalogs are skipped.
    return null;
  }
  function parse(body) {
    var root, seen = {}, offered = [];
    try { root = JSON.parse(body); } catch (e) { fail('Catalog could not be read.'); }
    if (!root || typeof root !== 'object' || root.api !== 2) fail('Unsupported catalog API.');
    if (!Array.isArray(root.addons) || root.addons.length > MAX_ENTRIES) fail('Catalog is too large.');
    root.addons.forEach(function (entry) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !ID.test(entry.id)) fail('Unsupported package identity or API.');
      if (has(seen, entry.id)) fail('Duplicate add-on ID.');
      seen[entry.id] = true;
      var item = offer(entry, true);
      if (item) offered.push(item);
    });
    return { entries: offered, total: root.addons.length };
  }
  function decode(buffer) {
    var bytes = new window.Uint8Array(buffer), binary = '', i;
    if (window.TextDecoder) return new window.TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
  }
  /* Canonical JSON with sorted keys, for comparing a package with its catalog entry. */
  function canon(value) {
    if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + canon(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  function newer(candidate, current) {
    var a = candidate.split('.'), b = current.split('.'), i;
    for (i = 0; i < 3; i++) if (+a[i] !== +b[i]) return +a[i] > +b[i];
    return false;
  }
  function active(except) {
    return Object.keys(installed).filter(function (id) { return id !== except && widgetKind(installed[id].kind) && installed[id].enabled !== false; }).length;
  }
  function entryFor(id) { for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return catalog[i]; return null; }

  /* ---------- Storage ---------- */
  function save(nextInstalled, nextCatalog, nextInfo) {
    var all = {};
    Object.keys(dormant).forEach(function (id) { all[id] = dormant[id]; });
    Object.keys(nextInstalled).forEach(function (id) { all[id] = nextInstalled[id]; });
    try { STORE.write(PREFIX, { installed: all, catalog: nextCatalog, catalogInfo: nextInfo }); }
    catch (e) { fail('Could not save add-ons.'); }
    installed = nextInstalled; catalog = nextCatalog; info = nextInfo;
  }
  function stored(item) {
    var pkg = copy(item), enabled = pkg.enabled !== false, result;
    delete pkg.enabled;
    result = offer(pkg, false);
    if (result) result.enabled = enabled;
    return result;
  }
  function load() {
    var data = STORE.read(PREFIX);
    if (!data || typeof data !== 'object') return;
    if (data.installed && typeof data.installed === 'object' && !Array.isArray(data.installed)) Object.keys(data.installed).forEach(function (id) {
      var item = data.installed[id], result = null;
      if (!ID.test(id) || !item || typeof item !== 'object' || item.id !== id) return;
      try { result = stored(item); } catch (e) { result = null; }
      // A package this build cannot read (for example a kind whose module is absent) is kept as stored.
      if (result) installed[id] = result; else dormant[id] = item;
    });
    if (Array.isArray(data.catalog)) data.catalog.forEach(function (entry) {
      var result = null;
      try { result = entry && typeof entry === 'object' && ID.test(entry.id) ? offer(entry, true) : null; } catch (e) { result = null; }
      if (result && !entryFor(result.id)) catalog.push(result);
    });
    var c = data.catalogInfo;
    if (c && c.checked === true && typeof c.total === 'number') info = { checked: true, total: c.total, compatible: catalog.length };
  }

  /* ---------- Operations ---------- */
  function emit() {
    window.setTimeout(function () {
      var detail = state();
      window.dispatchEvent(new window.CustomEvent('cleanframe:addons', { detail: detail }));
      listeners.slice().forEach(function (fn) { try { fn(copy(detail)); } catch (e) { /* one listener cannot stop the others */ } });
    }, 0);
  }
  function finish(message) { error = message || ''; busy = false; emit(); }
  /* A refused request is reported like an operation result, then thrown for the caller. */
  function refuse(message) { error = message; batch = { status: 'idle', completed: 0, total: 0 }; emit(); fail(message); }
  function own(e, fallback) { return e && e.own ? e.message : fallback; }
  /* GET without headers or credentials; done(message, buffer). */
  function download(url, limit, label, done) {
    var request = new window.XMLHttpRequest(), ended = false, tooLarge = false;
    var offline = label + ' download failed (no connection, certificate or access policy).';
    function end(message, buffer) { if (!ended) { ended = true; done(message, buffer); } }
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';
    request.timeout = TIMEOUT;
    request.withCredentials = false;
    request.onprogress = function (event) { if (event.loaded > limit) { tooLarge = true; request.abort(); end('Package exceeds size limit.'); } };
    request.ontimeout = function () { end(label + ' download timed out.'); };
    request.onerror = function () { end(offline); };
    request.onabort = function () { end(tooLarge ? 'Package exceeds size limit.' : offline); };
    request.onload = function () {
      var buffer = request.response;
      if (request.status !== 200) { end(request.status ? label + ' download failed (HTTP ' + request.status + ').' : offline); return; }
      if (!buffer || buffer.byteLength > limit) { end('Package exceeds size limit.'); return; }
      end('', buffer);
    };
    try { request.send(); } catch (e) { end(offline); }
    return request;
  }
  function refresh() {
    busy = true; error = ''; batch = { status: 'idle', completed: 0, total: 0 };
    var request = download(CATALOG, LIMIT, 'Catalog', function (message, buffer) {
      var result;
      if (message) { finish(message); return; }
      // XHR follows redirects; only the reviewed address is accepted.
      if (request.responseURL && request.responseURL !== CATALOG) { finish('Catalog download failed (unexpected address).'); return; }
      try {
        result = parse(decode(buffer));
        save(installed, result.entries, { checked: true, total: result.total, compatible: result.entries.length });
      } catch (e) { finish(own(e, 'Catalog could not be read.')); return; }
      finish('');
    });
  }
  /* Download, verify and store one catalog entry; done('') or done(message). */
  function fetchPackage(entry, done) {
    var url = BASE + entry.path, request = download(url, PACKAGE_LIMIT, 'Package', function (message, buffer) {
      var body, item, expected, current, next;
      if (message) { done(message); return; }
      if (request.responseURL !== url) { done('Package download failed (unexpected address).'); return; }
      try {
        if (SHA.bytes(new window.Uint8Array(buffer)) !== entry.sha256) fail('Package checksum mismatch.');
        try { body = JSON.parse(decode(buffer)); } catch (e) { fail('Package could not be read.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Package could not be read.');
        expected = copy(entry); delete expected.path; delete expected.sha256;
        // The package is read by the rules of the kind it was offered as.
        body.kind = typeof body.kind === 'string' ? body.kind : '';
        item = body.kind === entry.kind ? offer(body, false) : null;
        if (!item || canon(item) !== canon(expected)) fail('Package does not match catalog.');
        current = installed[entry.id];
        if (current && current.kind !== item.kind) fail('An update cannot change the add-on type.');
        if (current && !newer(item.version, current.version)) fail('This add-on is already up to date.');
        // Updates keep their state; a new widget beyond the limit arrives disabled.
        item.enabled = current ? current.enabled !== false : !widgetKind(item.kind) || active() < MAX_WIDGETS;
        next = copy(installed); next[entry.id] = item;
        save(next, catalog, info);
        delete dormant[entry.id];
      } catch (e) { done(own(e, 'Package could not be read.')); return; }
      done('');
    });
  }
  function install(id) {
    var entry = entryFor(id), current = installed[id];
    if (!entry) refuse('Refresh the catalog before downloading.');
    if (current && current.kind !== entry.kind) refuse('An update cannot change the add-on type.');
    if (current && !newer(entry.version, current.version)) refuse('This add-on is already up to date.');
    busy = true; error = ''; batch = { status: 'idle', completed: 0, total: 0 };
    fetchPackage(entry, finish);
  }
  function updateAll() {
    var targets = catalog.filter(function (entry) { var current = installed[entry.id]; return current && current.kind === entry.kind && newer(entry.version, current.version); });
    busy = true; error = ''; batch = { status: 'running', completed: 0, total: targets.length };
    (function next(i) {
      if (i >= targets.length) { batch = { status: 'complete', completed: i, total: targets.length }; finish(''); return; }
      batch.name = targets[i].name;
      fetchPackage(targets[i], function (message) {
        if (message) { batch = { status: 'stopped', completed: i, total: targets.length }; finish('Update stopped: ' + message); return; }
        batch.completed = i + 1; emit();
        next(i + 1);
      });
    }(0));
  }
  function change(id, update) {
    var next;
    if (!has(installed, id)) refuse('Add-on is not installed.');
    next = copy(installed); update(next);
    batch = { status: 'idle', completed: 0, total: 0 };
    try { save(next, catalog, info); } catch (e) { refuse(e.message); }
    error = ''; emit();
  }
  function remove(id) { change(id, function (next) { delete next[id]; }); }
  function toggle(id) {
    var item = installed[id];
    if (item && item.enabled === false && widgetKind(item.kind) && active(id) >= MAX_WIDGETS) refuse('Disable another widget first (maximum three active widgets).');
    change(id, function (next) { next[id].enabled = next[id].enabled === false; });
  }

  load();
  device.addons = function (req) {
    var action = req && typeof req.action === 'string' ? req.action : '', id = req && typeof req.id === 'string' ? req.id : '';
    if (action === 'state') return state();
    if (!/^(refresh|install|remove|toggle|updateAll)$/.test(action)) return fail('Unknown add-on action.');
    if (busy) fail('Another add-on operation is running.');
    if (action === 'refresh') refresh();
    else if (action === 'install') install(id);
    else if (action === 'remove') remove(id);
    else if (action === 'toggle') toggle(id);
    else updateAll();
    return { ok: true };
  };
}());
