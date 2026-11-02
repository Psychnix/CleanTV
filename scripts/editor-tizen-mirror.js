/* CleanTV Live-Spiegel: the one fixed expression the editor evaluates in CleanTV on a Samsung TV.
   ES5 for Chrome 47 (Tizen 3.0). Read-only: it calls getters of ShoreQA, CleanFrameDesign and the
   add-on modules and copies chosen fields. It never navigates, focuses, renders or saves, never reads
   web storage, Spotify credentials, sign-in sessions (QR, codes) or device identifiers, and returns
   one JSON string. scripts/editor-tizen-cdp.mjs sends this file unchanged; see docs/editor.md. */
(function () {
  'use strict';
  var out = { v: 1, errors: {} }, Q = window.ShoreQA, D = window.CleanFrameDesign;
  var PREFS = ['bg', 'wall', 'layout', 'apps', 'font', 'controls', 'focus', 'material', 'home', 'recent', 'lastApp', 'mode',
    'clockFormat', 'dateVisible', 'spotifyEnabled', 'spotifySurface', 'spotifyTransparency', 'controlsPosition', 'language', 'favourites'];
  var MEDIA = ['status', 'title', 'artist', 'duration', 'position', 'speed', 'art', 'artColor', 'artLight', 'actions', 'deviceName',
    'connection', 'permission', 'webLinked', 'webApi', 'errorMessage'];
  var ADDON = ['id', 'name', 'kind', 'version', 'enabled', 'text', 'timeZone', 'description', 'author', 'license'];
  var WALL = ['id', 'name', 'rev', 'tone', 'ut', 'frostVeil', 'listColumn', 'dockQuiet', 'clockMist', 'gone'];
  function take(name, read) {
    try { out[name] = read(); } catch (e) { out[name] = null; out.errors[name] = String(e && e.message || e).slice(0, 160); }
  }
  function pick(source, keys) {
    var result = {}, i;
    if (!source || typeof source !== 'object') return null;
    for (i = 0; i < keys.length; i++) if (source[keys[i]] !== undefined) result[keys[i]] = source[keys[i]];
    return result;
  }
  function list(items, keys, max) {
    var result = [], i;
    for (i = 0; items && i < items.length && result.length < max; i++) result.push(pick(items[i], keys));
    return result;
  }
  function each(items, keys) {
    var result = {}, id;
    for (id in items) if (Object.prototype.hasOwnProperty.call(items, id)) result[id] = pick(items[id], keys);
    return result;
  }
  out.hidden = !!document.hidden;
  take('app', function () {
    var info = window.tizen.application.getCurrentApplication().appInfo;
    return { id: info.id, packageId: info.packageId, version: info.version };
  });
  take('ready', function () { return !!(Q.ready() && D.ready()); });
  take('legacy', function () { return !!(window.CleanTVLegacy && window.CleanTVLegacy.active); });
  take('caps', function () {
    var c = window.FrameDevice.capabilities || {};
    return { art: c.art, home: c.home, settings: c.settings, spotify: !!c.spotify };
  });
  take('context', function () { return pick(D.context(), ['view', 'layout', 'state']); });
  take('where', function () { return pick(Q.where(), ['view', 'settingsGroup', 'focusAction', 'zone', 'wallpaper']); });
  take('state', function () {
    var s = Q.state();
    return {
      committed: pick(s.committed, PREFS), shown: pick(s.shown, ['bg', 'wall', 'material', 'font']),
      appRecords: list(s.appRecords, ['id', 'appId', 'name', 'brand'], 64),
      view: s.view, settingsGroup: s.settingsGroup, selected: s.selected, focusAction: s.focusAction, pending: !!s.pending,
      draft: s.draft, wallpaperPicker: pick(s.wallpaperPicker, ['candidate', 'applied', 'zone', 'top']), spotify: pick(s.spotify, MEDIA)
    };
  });
  // The open add-on and tab are not part of ShoreQA.state(); the rendered actions name them.
  take('detail', function () {
    var actions = Q.actions(), addon = '', i, m, tab = document.querySelector('#appearance [role="tab"][aria-selected="true"]');
    for (i = 0; i < actions.length && !addon; i++) {
      m = /^addon\.(?:install|settings|setup|toggle|remove)\.([a-z][a-z0-9-]{0,47})$/.exec(actions[i]);
      if (m) addon = m[1];
      m = /^cleantv\.([a-z][a-z0-9]{0,31})\./.exec(actions[i]);
      if (m && !addon) addon = 'cleantv-' + m[1];
    }
    return { addonId: addon, addonTab: tab ? tab.getAttribute('data-action') : '' };
  });
  // Message/dialog views are drawn in the sheet; the add-on behind an uninstall dialog names it.
  take('message', function () {
    var sheet = document.getElementById('sheet');
    if (!sheet || sheet.hidden) return null;
    var title = sheet.querySelector('.msg-title');
    if (!title) return null;
    var remove = document.querySelector('#appearance [data-action^="addon.remove."]');
    function clip(el) { return el ? String(el.textContent || '').slice(0, 200) : ''; }
    return { title: clip(title), line: clip(sheet.querySelector('.msg-line')), note: clip(sheet.querySelector('.msg-note')),
      addonId: remove ? String(remove.getAttribute('data-action')).slice(13) : '' };
  });
  take('link', function () {
    var l = window.CleanFrameAddonSetup.link() || {};
    return { phase: String(l.phase || ''), expiresAt: Number(l.expiresAt) || 0, message: String(l.message || '').slice(0, 200) };
  });
  take('design', function () { return D.get(); });
  take('addons', function () {
    var a = window.CleanFrameAddons.state();
    return { installed: each(a.installed, ADDON), catalog: list(a.catalog, ADDON, 64), busy: !!a.busy, error: String(a.error || '').slice(0, 200),
      batch: pick(a.batch, ['status', 'completed', 'total']), catalogInfo: pick(a.catalogInfo, ['checked', 'total', 'compatible']) };
  });
  take('weather', function () {
    var w = window.CleanTVWeather.state();
    return { place: w.place, show: w.show, forecast: w.forecast, failures: w.failures, error: w.error, busy: w.busy };
  });
  take('walls', function () {
    var api = window.CleanTVWallpapers, all = window.CleanFrameWallpapers || [], entries = [], i, e;
    for (i = 0; i < all.length && entries.length < 200; i++) {
      if (!all[i] || all[i].remote !== true) continue;
      e = pick(all[i], WALL); e.stored = !!api.stored(all[i].id); entries.push(e);
    }
    return { message: String(api.message() || ''), limit: api.limit, entries: entries };
  });
  return JSON.stringify(out);
}())
