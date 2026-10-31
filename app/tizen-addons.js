/* Tizen add-on host, stage 1: reads the reviewed catalog on request. Nothing is stored or installed yet. */
(function () {
  'use strict';
  var device = window.FrameDevice;
  if (!window.tizen || !device || device.platform === 'android') return;
  // config.xml allows only this origin; the path keeps requests on the reviewed catalog.
  var CATALOG = 'https://raw.githubusercontent.com/AntoinS/cleanframe-addons/main/catalog-v2.json';
  var LIMIT = 131072, TIMEOUT = 15000, MAX_ENTRIES = 32;
  var ID = /^[a-z][a-z0-9-]{0,47}$/, VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/, SHA = /^[a-f0-9]{64}$/;
  var PATH = /^packages\/[a-z0-9-]+\/[0-9]+\.[0-9]+\.[0-9]+\.json$/;
  var catalog = [], busy = false, error = '', info = { checked: false, total: 0, compatible: 0 };

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function state() {
    return copy({ installed: {}, catalog: catalog, busy: busy, error: error, api: 2, runtime: {}, pending: {},
      batch: { status: 'idle', completed: 0, total: 0 }, readOnly: true, catalogInfo: info });
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
  // Same rules as the Android host for the widget kinds this TV can show; unknown fields are dropped.
  function widget(entry) {
    var result = {};
    if (entry.api !== 1 || !ID.test(entry.id) || typeof entry.version !== 'string' || !VERSION.test(entry.version)) fail('Unsupported package identity or API.');
    if (entry.kind !== 'text' && entry.kind !== 'clock') fail('Unsupported widget kind.');
    if (!text(entry.name, 240) || !described(entry.description) || !text(entry.author, 240) || !text(entry.license, 240)) fail('Invalid package metadata.');
    if (entry.text !== undefined && (typeof entry.text !== 'string' || entry.text.length > 500)) fail('Widget text is too long.');
    if (entry.kind === 'clock' && entry.timeZone !== undefined && (typeof entry.timeZone !== 'string' || entry.timeZone.length > 64)) fail('Unsupported time zone.');
    if (typeof entry.path !== 'string' || !PATH.test(entry.path)) fail('Invalid package path.');
    if (typeof entry.sha256 !== 'string' || !SHA.test(entry.sha256)) fail('Invalid package checksum.');
    // Chromium 47 knows fewer zone names than Android; such a clock is not offered on this TV.
    if (entry.kind === 'clock' && entry.timeZone !== undefined && !zone(entry.timeZone)) return null;
    ['api', 'id', 'name', 'version', 'kind', 'description', 'author', 'license', 'text', 'timeZone', 'path', 'sha256'].forEach(function (key) {
      if (entry[key] !== undefined && (key !== 'timeZone' || entry.kind === 'clock')) result[key] = entry[key];
    });
    if (Array.isArray(entry.permissions) && entry.permissions.length <= 8 && entry.permissions.every(function (p) { return text(p, 64); })) result.permissions = entry.permissions.slice();
    return result;
  }
  function parse(body) {
    var root, seen = {}, widgets = [];
    try { root = JSON.parse(body); } catch (e) { fail('Catalog could not be read.'); }
    if (!root || typeof root !== 'object' || root.api !== 2) fail('Unsupported catalog API.');
    if (!Array.isArray(root.addons) || root.addons.length > MAX_ENTRIES) fail('Catalog is too large.');
    root.addons.forEach(function (entry) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !ID.test(entry.id)) fail('Unsupported package identity or API.');
      if (Object.prototype.hasOwnProperty.call(seen, entry.id)) fail('Duplicate add-on ID.');
      seen[entry.id] = true;
      // Spotify and native packages need Android; they count toward the limits but are not offered here.
      if (entry.kind === 'spotify' || entry.kind === 'native') return;
      var item = widget(entry);
      if (item) widgets.push(item);
    });
    return { widgets: widgets, total: root.addons.length };
  }
  function decode(buffer) {
    var bytes = new window.Uint8Array(buffer), binary = '', i;
    if (window.TextDecoder) return new window.TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
  }
  function finish(message, result) {
    if (result) { catalog = result.widgets; info = { checked: true, total: result.total, compatible: result.widgets.length }; }
    error = message || ''; busy = false;
    window.setTimeout(function () { window.dispatchEvent(new window.CustomEvent('cleanframe:addons', { detail: state() })); }, 0);
  }
  function refresh() {
    var request = new window.XMLHttpRequest(), done = false, tooLarge = false;
    function end(message, result) { if (!done) { done = true; finish(message, result); } }
    busy = true; error = '';
    request.open('GET', CATALOG, true);
    request.responseType = 'arraybuffer';
    request.timeout = TIMEOUT;
    request.withCredentials = false;
    request.onprogress = function (event) { if (event.loaded > LIMIT) { tooLarge = true; request.abort(); end('Package exceeds size limit.'); } };
    request.ontimeout = function () { end('Catalog download timed out.'); };
    request.onerror = function () { end('Catalog download failed (no connection, certificate or access policy).'); };
    request.onabort = function () { end(tooLarge ? 'Package exceeds size limit.' : 'Catalog download failed (no connection, certificate or access policy).'); };
    request.onload = function () {
      var buffer = request.response, result;
      if (request.status !== 200) { end(request.status ? 'Catalog download failed (HTTP ' + request.status + ').' : 'Catalog download failed (no connection, certificate or access policy).'); return; }
      // XHR follows redirects; only the reviewed address is accepted.
      if (request.responseURL && request.responseURL !== CATALOG) { end('Catalog download failed (unexpected address).'); return; }
      if (!buffer || buffer.byteLength > LIMIT) { end('Package exceeds size limit.'); return; }
      try { result = parse(decode(buffer)); } catch (e) { end(e && e.own ? e.message : 'Catalog could not be read.'); return; }
      end('', result);
    };
    try { request.send(); } catch (e) { end('Catalog download failed (no connection, certificate or access policy).'); }
  }
  device.addons = function (req) {
    var action = req && typeof req.action === 'string' ? req.action : '';
    if (action === 'state') return state();
    if (action === 'refresh') {
      if (busy) fail('Another add-on operation is running.');
      refresh();
      return { ok: true };
    }
    if (/^(install|remove|toggle|updateAll)$/.test(action)) fail('Downloads follow in a later update.');
    return fail('Unknown add-on action.');
  };
}());
