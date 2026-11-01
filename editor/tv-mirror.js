/* Development-only Samsung (Tizen) boundary for the editor; never packaged for a TV.
   The real Samsung page redraws CleanTV from data. "mirror": the state the editor reads on the TV
   (Live-Spiegel, fed by the parent editor page). "draft": an imported Samsung draft with sample media.
   Nothing here reaches the TV: storage stays in memory, other origins are not contacted (images
   excepted) and device actions only show a preview notice. */
(() => {
  'use strict';
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const PREFS = ['bg', 'wall', 'layout', 'apps', 'font', 'controls', 'focus', 'material', 'home', 'mode', 'clockFormat', 'dateVisible',
    'spotifyEnabled', 'spotifySurface', 'spotifyTransparency', 'controlsPosition', 'language', 'favourites'];
  const PARENT = {rotation: 'background', 'addon-detail': 'addons', 'addon-settings': 'addon-detail', spotify: 'addon-detail', 'spotify-link': 'spotify'};
  const MESSAGES = ['leave', 'signout', 'addonRemove', 'error'];
  const WALL_ID = /^aw-[a-z0-9]+(?:-[a-z0-9]+)*$/, REV = /^[a-f0-9]{12}$/;
  const WALL_FILES = {jpg: 'image.jpg', thumb: 'thumb.jpg', panel: 'panel.jpg', 'study-soft': 'study-soft.jpg', 'field-blur': 'field-blur.jpg', 'field-frost': 'field-frost.jpg', 'field-clear': 'field-clear.jpg'};
  const WALL_BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/cleantv-wallpapers/generated/';
  const CAPS = {art: false, home: true, settings: true, spotify: true};

  /* TV state (scripts/editor-tizen-mirror.js) to boot data; the draft boot comes from editor_server.py. */
  function fromState(s) {
    const view = s.state || {}, addons = s.addons || {};
    return {
      mode: 'mirror', legacy: !!s.legacy, caps: {...CAPS, ...(s.caps || {})},
      record: {...copy(view.committed || {}), mode: 'fixed', appRecords: copy(view.appRecords || [])},
      addons: {installed: copy(addons.installed || {}), catalog: copy(addons.catalog || []), busy: !!addons.busy, error: addons.error || '',
        batch: copy(addons.batch || {status: 'idle', completed: 0, total: 0}), catalogInfo: copy(addons.catalogInfo || {checked: false, total: 0, compatible: 0}), runtime: {}, pending: {}, api: 2},
      spotify: copy(view.spotify || {status: 'idle'}), link: copy(s.link || {phase: 'idle'}),
      weather: s.weather && s.weather.place ? {place: copy(s.weather.place), show: copy(s.weather.show), forecast: copy(s.weather.forecast)} : null,
      walls: {message: (s.walls || {}).message || '', limit: (s.walls || {}).limit || 10, entries: copy((s.walls || {}).entries || [])},
      apps: (view.appRecords || []).map(a => ({appId: a.appId, name: a.name, brand: a.brand || ''}))
    };
  }
  // Values the page reads once while loading; a change needs a fresh page. App records are keyed by id
  // (a reorder is a preference change, applied live, not a reload) and the recent-apps list is included
  // (a change there needs a fresh page); lastApp stays out, so it alone never reloads the frame.
  const structure = b => JSON.stringify([b.legacy, b.caps,
    (b.record.appRecords || []).slice().sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0).map(a => [a.id, a.name, a.brand || '']),
    b.record.recent || [], (b.walls.entries || []).map(e => [e.id, e.rev, !!e.gone, e.name, e.tone])]);

  let feed = null;
  try { feed = window.parent !== window ? window.parent.CleanTVMirrorFeed : null; } catch { feed = null; }
  const boot = window.CleanTVMirrorBoot || (feed && feed.boot() ? fromState(feed.boot()) : null);
  if (!boot) throw new Error('CleanTV Vorschau ohne Daten.');
  const draft = boot.mode === 'draft';
  let addons = {catalog: [], busy: false, error: '', runtime: {}, pending: {}, api: 2, batch: {status: 'idle', completed: 0, total: 0}, ...copy(boot.addons || {installed: {}})}, link = copy(boot.link || {phase: 'idle'}), walls = copy(boot.walls || {message: '', limit: 10, entries: []});
  let weather = copy(boot.weather || null), spotify = copy(boot.spotify || {status: 'idle'}), design = null, scene = '', revision = 0;
  const notice = text => window.dispatchEvent(new CustomEvent('cleanframe:preview-notice', {detail: text}));

  /* ---------- Early: before android-device.js, device.js and the Tizen modules ---------- */
  const memory = {};
  const storage = {
    getItem: key => own(memory, key) ? memory[key] : null, setItem: (key, value) => { memory[key] = String(value); },
    removeItem: key => { delete memory[key]; }, clear: () => { Object.keys(memory).forEach(key => delete memory[key]); },
    key: index => Object.keys(memory)[index] ?? null, get length() { return Object.keys(memory).length; }
  };
  Object.defineProperty(window, 'localStorage', {configurable: true, get: () => storage});
  storage.setItem('cleantv.home.v1', JSON.stringify(boot.record));
  window.CleanFramePreview = true;
  window.ShoreQA = {minuteMs: 1e12};  // No wallpaper rotation in a redrawn picture.
  if (!draft) {
    // The Live-Spiegel takes no keyboard input: the TV drives it. Keys never reach CleanTV's handlers,
    // and nothing in the frame grabs real DOM focus (which would scroll or steal focus from the editor).
    HTMLElement.prototype.focus = function () {};
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      window.addEventListener(type, event => { event.stopImmediatePropagation(); if (event.key !== 'Tab') event.preventDefault(); }, true);
    });
  }
  if (boot.legacy && window.CSS && CSS.supports) {
    // The TV's Chrome 47 has no custom properties; legacy.js runs because of ?legacy=1.
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args) => args.length === 2 && String(args[0]).startsWith('--') ? false : supports(...args);
  }
  const local = url => { try { return new URL(url, location.href).origin === location.origin; } catch { return false; } };
  const xhr = XMLHttpRequest.prototype, open = xhr.open, send = xhr.send, abort = xhr.abort;
  // Weather, catalogs and Spotify stay on the TV: cross-origin requests are never sent or answered.
  xhr.open = function (method, url) { this.cleantvBlocked = !local(url); if (!this.cleantvBlocked) return open.apply(this, arguments); };
  xhr.send = function () { if (!this.cleantvBlocked) return send.apply(this, arguments); };
  xhr.abort = function () { if (!this.cleantvBlocked) return abort.apply(this, arguments); };
  const fetchLocal = window.fetch;
  window.fetch = (input, init) => local(typeof input === 'string' ? input : input && input.url) ? fetchLocal(input, init) : new Promise(() => {});

  /* ---------- Draft sample media (as editor/mock.js for Android) ---------- */
  let scenario = boot.scenario || 'playing';
  const calls = [];
  function sample(next) {
    const media = {permission: true, status: 'playing', connection: 'connected', webApi: 'connected', webLinked: true, title: 'A Walk', artist: 'Tycho', duration: 316000, position: 74000, speed: 1, deviceName: 'MacBook', artColor: '#758e93', artLight: false, art: '/media/spotify-1.png', actions: {previous: true, toggle: true, next: true}};
    if (next === 'paused') Object.assign(media, {status: 'paused', speed: 0});
    if (next === 'long') Object.assign(media, {title: 'Eine sehr lange Aufnahme mit vielen Worten und einem ausführlichen Titel', artist: 'Ein langer Name · Ein weiterer Interpret · Live Session'});
    if (next === 'missing') media.art = '';
    if (next === 'none') Object.assign(media, {status: 'idle', title: '', speed: 0});
    if (next === 'unlinked') Object.assign(media, {webApi: 'unlinked', webLinked: false, actions: {previous: false, toggle: false, next: false}});
    if (next === 'denied') Object.assign(media, {permission: false, status: 'unavailable', title: ''});
    if (next === 'offline') Object.assign(media, {connection: 'unavailable', status: 'unavailable', title: '', errorMessage: 'Spotify ist in dieser Vorschau nicht erreichbar.'});
    return media;
  }
  const publish = () => window.dispatchEvent(new CustomEvent('cleanframe:spotify', {detail: copy(spotify)}));
  if (draft) {
    spotify = sample(scenario);
    window.CleanFrameMock = {setScenario(next) { scenario = next; spotify = sample(next); publish(); }, state: () => copy(spotify), calls, scenario: () => scenario};
    if (own(addons.installed, 'cleantv-weather') && !weather) {
      const now = Date.now(), place = {name: 'Beispielort', region: 'Vorschau', detail: '', country: 'DE', lat: 52.52, lon: 13.41, timezone: 'Europe/Berlin', offset: 3600};
      weather = {place, show: {name: true, temp: true, range: true, wind: true, icon: true},
        forecast: {lat: place.lat, lon: place.lon, at: now - 60000, offset: 3600, temp: 7.3, code: 3, wind: 12, gusts: 20, precip: 0, cloud: 90, day: 1, windy: false, days: [{date: new Date(now).toISOString().slice(0, 10), max: 9.4, min: 2.1}]}};
    }
  }

  function wallpaperEntry(e) {
    if (!e || !WALL_ID.test(e.id) || !REV.test(e.rev)) return null;
    const ut = e.ut || {}, ink = value => ['light', 'mist', 'dark'].includes(value) ? value : 'light';
    const files = {};
    Object.keys(WALL_FILES).forEach(role => { files[role] = {path: 'cleantv-wallpapers/generated/' + e.id + '/' + WALL_FILES[role]}; });
    const entry = {id: e.id, name: String(e.name || e.id).slice(0, 120), remote: true, rev: e.rev, tone: e.tone === 'dark' ? 'dark' : 'light', ut: {tr: ink(ut.tr), br: ink(ut.br)},
      frostVeil: [0.12, 0.2, 0.3, 0.36, 0.44].includes(e.frostVeil) ? e.frostVeil : 0.12, listColumn: [0, 2, 3].includes(e.listColumn) ? e.listColumn : 0,
      dockQuiet: !!e.dockQuiet, clockMist: !!e.clockMist, files};
    if (e.gone) entry.gone = true;
    return entry;
  }
  function writeWeather() {
    try {
      if (weather) window.CleanTVStore.write('cleantv.weather.v1', {place: weather.place, show: weather.show, forecast: weather.forecast});
      else window.CleanTVStore.clear('cleantv.weather.v1');
    } catch { /* The widget shows its empty state. */ }
    if (window.CleanTVWeather) window.CleanTVWeather.reload();
  }

  /* ---------- Late: right before main.js ---------- */
  function beforeMain() {
    const device = window.FrameDevice || (window.FrameDevice = {});
    const done = callback => { if (typeof callback === 'function') setTimeout(() => callback(null), 0); };
    const say = text => { if (draft) notice(text); };
    device.capabilities = copy(boot.caps || CAPS);
    device.addons = request => {
      if (request && request.action === 'state') return copy(addons);
      throw new Error(draft ? 'In der Samsung-Vorschau werden keine Add-ons geändert.' : 'Der Live-Spiegel ändert nichts am Fernseher.');
    };
    window.CleanTVAddons = {
      installed: id => own(addons.installed, id) ? copy(addons.installed[id]) : null,
      enabled: id => own(addons.installed, id) && addons.installed[id].enabled !== false, on: () => () => {}
    };
    device.spotify = {
      state: () => copy(spotify), observe: (on, callback) => done(callback), access: callback => done(callback),
      control(command, callback) {
        if (draft) {
          calls.push(['control', command]);
          if (command === 'toggle') Object.assign(spotify, {status: spotify.status === 'playing' ? 'paused' : 'playing', speed: spotify.status === 'playing' ? 0 : 1});
          else Object.assign(spotify, {title: command === 'next' ? 'Awake' : 'A Walk', position: 0});
          publish();
        }
        done(callback);
      },
      link(operation) {
        if (operation === 'state') return copy(link);
        if (draft && operation === 'begin') link = {phase: 'pending', code: 'PREVIEW', expiresAt: Date.now() + 600000};
        if (draft && operation === 'cancel') link = {phase: 'idle'};
        return {ok: true};
      },
      signOut(callback) { if (draft) { calls.push(['signout']); scenario = 'unlinked'; spotify = sample('unlinked'); publish(); } done(callback); }
    };
    const apps = (boot.apps || []).map(a => ({appId: a.appId, name: a.name, brand: a.brand || '', icon: ''}));
    device.apps = callback => setTimeout(() => callback(null, copy(apps)), 0);
    device.launchApp = (id, callback) => { calls.push(['launch', id]); say('Vorschau: ' + ((apps.find(a => a.appId === id) || {}).name || id) + ' öffnen'); done(callback); };
    device.launch = device.launchApp;
    device.art = callback => done(callback);
    device.home = callback => { say('Vorschau: Samsung Home öffnen'); done(callback); };
    device.settings = callback => { say('Vorschau: TV-Einstellungen öffnen'); done(callback); };
    const list = Array.isArray(window.CleanFrameWallpapers) ? window.CleanFrameWallpapers : null;
    if (list) (walls.entries || []).map(wallpaperEntry).filter(Boolean).forEach(entry => { if (!list.some(w => w.id === entry.id)) list.push(entry); });
    const stored = {};
    (walls.entries || []).forEach(e => { if (e && e.stored) stored[e.id] = true; });
    window.CleanTVWallpapers = {
      bind() {}, picker() {}, home() {}, sync() {}, limit: walls.limit || 10,
      resolve: (id, callback) => { setTimeout(callback, 0); },
      url: (id, role) => WALL_ID.test(id) && own(WALL_FILES, role) ? WALL_BASE + id + '/' + WALL_FILES[role] : '',
      stored: id => !!stored[id], message: () => walls.message || ''
    };
    if (window.CleanFrameAddons) window.CleanFrameAddons.state();
    if (weather) writeWeather();
  }

  /* ---------- Mirror: apply one TV state to the running page ---------- */
  function target(s) {
    const where = s.where || {}, context = s.context || {}, detail = s.detail || {};
    const view = where.view || 'home', group = where.settingsGroup || '';
    if (view === 'message') {
      const msg = String(context.view || '').replace(/^message\./, '');
      const m = s.message || {}, addonId = m.addonId || '';
      const content = m.title || m.line || m.note ? {title: m.title || '', line: m.line || '', note: m.note || ''} : null;
      return {view, msg, addonId, content, key: ['message', msg, addonId, JSON.stringify(content)].join('|')};
    }
    if (view === 'appearance') {
      const addonId = group === 'spotify' || group === 'spotify-link' ? 'spotify' : ['addon-detail', 'addon-settings'].includes(group) ? detail.addonId || '' : '';
      const tab = group === 'addons' ? detail.addonTab || '' : '';
      return {view, group, addonId, tab, key: [view, group, addonId, tab].join('|')};
    }
    if (['home', 'apps', 'editor', 'settings', 'wallpaper'].includes(view)) return {view, key: view};
    // An add-on's own view (for example the weather place keyboard) is drawn as that add-on's settings.
    const match = /^cleantv\.([a-z][a-z0-9]{0,31})\./.exec(view);
    return {view: 'appearance', group: 'addon-settings', addonId: match ? 'cleantv-' + match[1] : detail.addonId || '', tab: '', key: 'addon-view|' + view};
  }
  function replay(path) {
    const QA = window.ShoreQA, act = action => QA.activate(action) !== null;
    if (path.view === 'appearance') {
      const chain = [];
      for (let group = path.group; group; group = PARENT[group]) chain.unshift(group);
      QA.editorScene('settings');
      let ok = !!chain.length;
      chain.forEach((group, index) => {
        if (!ok) return;
        if (index === 0) ok = act('settings.group.' + group);
        else if (group === 'rotation') ok = act('background.rotation');
        else if (group === 'addon-detail') { if (!own(addons.installed, path.addonId)) act('addon.tab.discover'); ok = act('addon.details.' + path.addonId); }
        else if (group === 'addon-settings') ok = act('addon.settings.' + path.addonId);
        else if (group === 'spotify') ok = act('group.spotify');
        else if (group === 'spotify-link') ok = act('spotify.signin');
        else ok = false;
      });
      if (ok && path.group === 'addons' && path.tab === 'addon.tab.discover') act('addon.tab.discover');
      // Without the exact path the group is drawn directly (its Back label may then differ).
      if (!ok) QA.editorScene('appearance.' + path.group, path.addonId || undefined);
    } else if (path.view === 'wallpaper') {
      QA.editorScene('settings');
      if (!(act('settings.group.background') && act('background.wallpaper'))) QA.editorScene('wallpaper');
    } else if (path.view === 'message') {
      if (path.msg === 'addonRemove') {
        // Only an installed add-on has a removal dialog; otherwise just show the add-on list.
        if (own(addons.installed, path.addonId)) QA.editorScene('message.addonRemove', path.addonId);
        else QA.editorScene('appearance.addons');
      } else if (path.msg === 'error') QA.editorScene('message.error', undefined, path.content);
      else QA.editorScene('message.' + (MESSAGES.includes(path.msg) ? path.msg : 'error'));
    } else QA.editorScene(path.view);
  }
  // Where the mirror page actually sits right now (view and settings group), for drift detection.
  function place() {
    const w = window.ShoreQA.where();
    return (w.view || '') + '|' + (w.settingsGroup || '');
  }
  // Walk the local wallpaper picker to the TV's candidate and zone, scrolling past the visible rows.
  function follow(p) {
    const QA = window.ShoreQA, picker = () => QA.state().wallpaperPicker;
    if (!picker()) return;
    if (picker().zone === 'star') QA.nav(['left']);
    if (picker().zone === 'back') QA.nav(['down']);
    for (let step = 0; step < 128 && picker() && picker().candidate !== p.candidate && picker().zone !== 'back'; step++) {
      const before = picker().candidate; QA.nav(['down']);
      if (!picker() || picker().candidate === before) break;
    }
    for (let step = 0; step < 128 && picker() && picker().candidate !== p.candidate && picker().zone !== 'back'; step++) {
      const before = picker().candidate; QA.nav(['up']);
      if (!picker() || picker().candidate === before) break;
    }
    const now = picker();
    if (!now) return;
    if (p.zone === 'star' && now.zone !== 'star') QA.nav(['right']);
    else if (p.zone === 'back' && now.zone !== 'back') QA.nav(['left']);
    else if (p.zone !== 'star' && p.zone !== 'back' && now.zone === 'star') QA.nav(['left']);
  }
  let landed = '';
  function apply(s) {
    const QA = window.ShoreQA, D = window.CleanFrameDesign;
    if (draft || !s || !QA || !QA.state) return;
    const next = fromState(s);
    if (!same(next.addons, addons)) { addons = next.addons; window.CleanFrameAddons.state(); window.dispatchEvent(new CustomEvent('cleanframe:addons', {detail: copy(addons)})); }
    if (!same(next.weather, weather)) { weather = next.weather; writeWeather(); }
    if (s.design && !same(s.design, design)) { design = copy(s.design); D.set(copy(design)); }
    const committed = (s.state || {}).committed || {}, current = QA.state().committed, patch = {};
    PREFS.forEach(key => { if (committed[key] !== undefined && !same(committed[key], current[key])) patch[key] = copy(committed[key]); });
    if (Object.keys(patch).length) QA.preferences(patch);
    if (!same(next.spotify, spotify)) { spotify = next.spotify; publish(); }
    if (!same(next.link, link)) { link = next.link; window.dispatchEvent(new CustomEvent('cleanframe:spotify-link', {detail: {phase: link.phase}})); }
    const path = target(s);
    // Re-replay when the TV moved (new key) or the mirror page drifted from where we last left it (#7).
    if (path.key !== scene || place() !== landed) {
      try { replay(path); } catch (e) { QA.editorScene('home'); }  // one bad replay must not loop every 2 s (#11)
      scene = path.key;
    }
    const picker = (s.state || {}).wallpaperPicker;
    if (path.view === 'wallpaper' && picker) follow(picker);  // the picker candidate follows the TV, even scrolled past the rows (#6)
    else { const focus = (s.where || {}).focusAction; if (focus && QA.state().focusAction !== focus) QA.focus(focus); }
    landed = place();
    revision++;
  }

  window.CleanTVMirror = {
    mode: boot.mode, beforeMain, apply, get revision() { return revision; },
    needsReload: s => !s || structure(fromState(s)) !== structure(boot)
  };
})();
