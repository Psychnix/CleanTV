/* CleanTV weather (docs/addons.md, "Weather"): the `weather` package kind, the Home widget below the
   clock, its settings and the place search. Data come only from Open-Meteo (forecast and geocoding)
   and OpenPLZ (postal codes), and only while the cleantv-weather package is installed and enabled.
   Loaded before tizen-addons.js; the registries are queued until their owners load. */
(function () {
  'use strict';
  var ID = 'cleantv-weather', KIND = 'weather', PREFIX = 'cleantv.weather.v1', VIEW = 'cleantv.weather.keyboard';
  var FORECAST = 'https://api.open-meteo.com/v1/forecast', GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search', PLZ = 'https://openplzapi.org/';
  var CURRENT = 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover,is_day', DAILY = 'temperature_2m_max,temperature_2m_min';
  var MINUTE = 60000, PERIOD = 15 * MINUTE, RETURN_AGE = 10 * MINUTE, STALE = 45 * MINUTE, EXPIRED = 180 * MINUTE, AWAY_GAP = 75000;
  var BACKOFF = [1, 2, 5, 10, 15], TIMEOUT = 15000, FORECAST_LIMIT = 16384, SEARCH_LIMIT = 262144, PLZ_LIMIT = 65536;
  var SHOW = ['name', 'temp', 'range', 'wind', 'icon'], SHOW_LABELS = { name: 'Place name', temp: 'Current temperature', range: 'High and low', wind: 'Wind', icon: 'Weather symbol' };
  var PACKAGE_FIELDS = { api: 1, id: 1, name: 1, version: 1, kind: 1, description: 1, author: 1, license: 1 };
  var DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
  var CLOUD = 'M12 27H32A7 7 0 1 0 29 13.7A8 8 0 1 0 13.1 15.1A6 6 0 1 0 12 27Z';
  var de = {
    'Weather': 'Wetter', 'Place': 'Ort', 'Choose a place': 'Ort wählen', 'Search by name or postal code': 'Nach Name oder Postleitzahl suchen',
    'Search for a place': 'Ort suchen', 'Show on Home': 'Auf dem Startbildschirm', 'Place name': 'Ortsname', 'Current temperature': 'Aktuelle Temperatur',
    'High and low': 'Höchst- und Tiefstwert', 'Wind': 'Wind', 'Weather symbol': 'Wettersymbol', 'Show': 'Einblenden', 'Hide': 'Ausblenden',
    'Weather: Open-Meteo.com': 'Wetter: Open-Meteo.com', 'As of ': 'Stand ', 'Settings › Add-ons › Weather': 'Einstellungen › Add-ons › Wetter',
    'Updating…': 'Wird aktualisiert …', ' · updates every 15 minutes': ' · Aktualisierung alle 15 Minuten', 'Waiting for the first update.': 'Warten auf die erste Aktualisierung.',
    'No place chosen yet.': 'Noch kein Ort gewählt.', 'Could not save the weather settings.': 'Die Wettereinstellungen konnten nicht gespeichert werden.',
    'Name or postal code': 'Name oder Postleitzahl', 'Type a place name or a postal code.': 'Ortsnamen oder Postleitzahl eingeben.',
    'Postal codes have 4 (AT, CH, LI) or 5 digits (DE).': 'Postleitzahlen haben 4 (AT, CH, LI) oder 5 Ziffern (DE).',
    'No place with this postal code.': 'Kein Ort mit dieser Postleitzahl.', 'No place found.': 'Kein Ort gefunden.',
    'The weather add-on is not active.': 'Das Wetter Add-on ist nicht aktiv.', 'No coordinates were found for this place.': 'Für diesen Ort wurden keine Koordinaten gefunden.',
    'Could not save the place.': 'Der Ort konnte nicht gespeichert werden.',
    'No connection to the weather service.': 'Keine Verbindung zum Wetterdienst.', 'The weather service did not respond.': 'Der Wetterdienst antwortet nicht.',
    'The weather service sent an unexpected response.': 'Unerwartete Antwort vom Wetterdienst.', 'The weather service reported an error (HTTP ': 'Der Wetterdienst meldet einen Fehler (HTTP ',
    'No connection to the place search.': 'Keine Verbindung zur Ortssuche.', 'The place search did not respond.': 'Die Ortssuche antwortet nicht.',
    'The place search sent an unexpected response.': 'Unerwartete Antwort der Ortssuche.', 'The place search reported an error (HTTP ': 'Die Ortssuche meldet einen Fehler (HTTP ',
    'Weather: Open-Meteo.com (CC BY 4.0) · Places: GeoNames (CC BY 4.0), OpenPLZ (ODbL)': 'Wetter: Open-Meteo.com (CC BY 4.0) · Orte: GeoNames (CC BY 4.0), OpenPLZ (ODbL)',
    'Austria': 'Österreich', 'Switzerland': 'Schweiz'
  };
  function tr(lang, text) { return lang === 'de' && de[text] || text; }
  function now() { return Date.now(); }
  function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { return finite(v) ? v : null; }
  function positive(v) { return finite(v) && v >= 0 ? v : null; }
  function whole(v) { return finite(v) && v % 1 === 0; }
  function text(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/^ | $/g, ''); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function active() { var a = window.CleanTVAddons; return !!(a && typeof a.enabled === 'function' && a.enabled(ID)); }
  /* After late data: the open settings render again (with the Home preview), otherwise the widgets. */
  function redraw() {
    var s = window.CleanTVAddonSettings, w = window.CleanTVWidgets;
    if (s && typeof s.refresh === 'function' && s.refresh(ID)) return;
    if (w && typeof w.refresh === 'function') w.refresh();
  }

  /* ---------- Package kind ---------- */
  // The host has checked identity and metadata; the weather package has no fields of its own.
  function validate(entry) {
    if (entry.id !== ID) throw new Error('The weather add-on must use the ID cleantv-weather.');
    Object.keys(entry).forEach(function (key) { if (!PACKAGE_FIELDS[key]) throw new Error('The weather add-on has unsupported fields.'); });
    return copy(entry);
  }

  /* ---------- Stored record (CleanTVStore, cleantv.weather.v1) ---------- */
  var place = null, show = defaults(), forecast = null, saveError = false;
  function defaults() { return { name: true, temp: true, range: true, wind: true, icon: true }; }
  function cleanPlace(p) {
    if (!p || typeof p !== 'object' || !text(p.name, 120) || !finite(p.lat) || !finite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return null;
    return {
      name: p.name, region: text(p.region, 160) ? p.region : '', detail: text(p.detail, 200) ? p.detail : '', country: /^[A-Z]{2}$/.test(p.country) ? p.country : '',
      lat: p.lat, lon: p.lon, timezone: typeof p.timezone === 'string' && p.timezone.length <= 64 && ZONE.test(p.timezone) ? p.timezone : '',
      offset: whole(p.offset) && Math.abs(p.offset) <= 50400 ? p.offset : null
    };
  }
  function cleanShow(s) {
    var result = defaults();
    if (s && typeof s === 'object') SHOW.forEach(function (key) { if (typeof s[key] === 'boolean') result[key] = s[key]; });
    return result;
  }
  function cleanDays(days) {
    return (Array.isArray(days) ? days : []).filter(function (d) { return d && typeof d.date === 'string' && DATE.test(d.date); }).slice(0, 7)
      .map(function (d) { return { date: d.date, max: num(d.max), min: num(d.min) }; });
  }
  // A forecast belongs to the coordinates it was fetched for.
  function cleanForecast(f, p) {
    if (!f || typeof f !== 'object' || !p || f.lat !== p.lat || f.lon !== p.lon || !finite(f.at) || f.at <= 0) return null;
    if (!whole(f.offset) || Math.abs(f.offset) > 50400 || !finite(f.temp) || !whole(f.code) || f.code < 0 || f.code > 99) return null;
    return { lat: f.lat, lon: f.lon, at: f.at, offset: f.offset, temp: f.temp, code: f.code, wind: positive(f.wind), gusts: positive(f.gusts), precip: positive(f.precip) || 0,
      cloud: finite(f.cloud) && f.cloud >= 0 && f.cloud <= 100 ? f.cloud : null, day: f.day === 0 ? 0 : 1, windy: f.windy === true, days: cleanDays(f.days) };
  }
  function load() {
    var data = null;
    try { data = window.CleanTVStore ? window.CleanTVStore.read(PREFIX) : null; } catch (e) { data = null; }
    place = cleanPlace(data && data.place);
    show = cleanShow(data && data.show);
    forecast = cleanForecast(data && data.forecast, place);
  }
  function save(nextPlace, nextShow, nextForecast) {
    try { window.CleanTVStore.write(PREFIX, { place: nextPlace, show: nextShow, forecast: nextForecast }); return true; } catch (e) { return false; }
  }

  /* ---------- Requests: plain GET, no headers or credentials, bounded and cancellable ---------- */
  function get(url, limit, done) {
    var request = new window.XMLHttpRequest(), ended = false;
    function end(error, data) { if (!ended) { ended = true; done(error, data); } }
    request.open('GET', url, true);
    request.timeout = TIMEOUT;
    request.withCredentials = false;
    request.onprogress = function (event) { if (event.loaded > limit) { end('data'); try { request.abort(); } catch (e) { /* ended */ } } };
    request.ontimeout = function () { end('timeout'); };
    request.onerror = function () { end('offline'); };
    request.onabort = function () { end('offline'); };
    request.onload = function () {
      var body = request.responseText, data;
      if (request.status !== 200) { end(request.status ? 'http ' + request.status : 'offline'); return; }
      // XHR follows redirects; only the requested address is accepted.
      if (request.responseURL && request.responseURL !== url) { end('data'); return; }
      if (typeof body !== 'string' || body.length > limit) { end('data'); return; }
      try { data = JSON.parse(body); } catch (e) { end('data'); return; }
      end('', data);
    };
    try { request.send(); } catch (e) { end('offline'); }
    return { abort: function () { if (!ended) { ended = true; try { request.abort(); } catch (e) { /* gone */ } } } };
  }
  function failure(lang, error, search) {
    var http = /^http ([0-9]{3})$/.exec(error || '');
    if (http) return tr(lang, search ? 'The place search reported an error (HTTP ' : 'The weather service reported an error (HTTP ') + http[1] + ').';
    if (error === 'offline') return tr(lang, search ? 'No connection to the place search.' : 'No connection to the weather service.');
    if (error === 'timeout') return tr(lang, search ? 'The place search did not respond.' : 'The weather service did not respond.');
    return tr(lang, search ? 'The place search sent an unexpected response.' : 'The weather service sent an unexpected response.');
  }

  /* ---------- Forecast ---------- */
  function forecastUrl(p) {
    return FORECAST + '?latitude=' + p.lat + '&longitude=' + p.lon + '&current=' + CURRENT + '&daily=' + DAILY
      + '&timezone=' + encodeURIComponent(p.timezone || 'auto') + '&forecast_days=2';
  }
  /* Wind shows at 30 km/h or gusts of 50 km/h and stays until both fall below 25 and 42 km/h. */
  function windy(wind, gusts, before) {
    var ws = wind || 0, wg = gusts || 0;
    return before ? !(ws < 25 && wg < 42) : ws >= 30 || wg >= 50;
  }
  function parseForecast(data, before) {
    var c = data && data.current, d = data && data.daily, offset = data && data.utc_offset_seconds, days = [], i, wind, gusts;
    if (!c || !d || typeof c !== 'object' || typeof d !== 'object' || data.error || !whole(offset) || Math.abs(offset) > 50400) throw new Error('data');
    if (!finite(c.temperature_2m) || !whole(c.weather_code) || c.weather_code < 0 || c.weather_code > 99 || !Array.isArray(d.time)) throw new Error('data');
    for (i = 0; i < d.time.length && days.length < 7; i++) {
      if (typeof d.time[i] === 'string' && DATE.test(d.time[i])) days.push({ date: d.time[i], max: num(d.temperature_2m_max && d.temperature_2m_max[i]), min: num(d.temperature_2m_min && d.temperature_2m_min[i]) });
    }
    wind = positive(c.wind_speed_10m); gusts = positive(c.wind_gusts_10m);
    return { offset: offset, temp: c.temperature_2m, code: c.weather_code, wind: wind, gusts: gusts, precip: positive(c.precipitation) || 0,
      cloud: finite(c.cloud_cover) && c.cloud_cover >= 0 && c.cloud_cover <= 100 ? c.cloud_cover : null, day: c.is_day === 0 ? 0 : 1,
      windy: windy(wind, gusts, !!before), days: days };
  }
  /* The place's local date from the stored UTC offset; no time-zone names are interpreted here. */
  function today(days, at, offset) {
    var date = new Date(at + (offset || 0) * 1000).toISOString().slice(0, 10), i;
    for (i = 0; i < (days || []).length; i++) if (days[i].date === date) return days[i];
    return null;
  }

  /* ---------- Refresh: every 15 minutes plus jitter while Home is visible ---------- */
  // The jitter spreads TVs over the minute after each quarter hour; it changes after every fetch.
  var failures = 0, lastAttempt = 0, lastError = '', jitter = Math.floor(Math.random() * MINUTE), inflight = null, timer = 0, away = true, seen = 0;
  function homeVisible() {
    var stage = document.getElementById('stage');
    return !document.hidden && !(stage && /(^|\s)is-sheet(\s|$)/.test(stage.className));
  }
  function due() {
    if (failures) return lastAttempt + BACKOFF[Math.min(failures, BACKOFF.length) - 1] * MINUTE;
    return forecast ? forecast.at + PERIOD + jitter : 0;
  }
  function clearTimer() { if (timer) { window.clearTimeout(timer); timer = 0; } }
  function stop() { clearTimer(); if (inflight) { inflight.abort(); inflight = null; } }
  function plan() {
    clearTimer();
    if (!active() || !place || inflight) return;
    timer = window.setTimeout(tick, Math.max(0, due() - now()));
  }
  function tick() {
    timer = 0;
    if (!active() || !place || inflight) return;
    // Away from Home nothing is requested; the next visible Home render catches up.
    if (!homeVisible()) { away = true; return; }
    if (now() >= due()) refreshNow(); else plan();
  }
  function refreshNow() {
    var p = place;
    if (!active() || !p || inflight) return false;
    clearTimer();
    lastAttempt = now();
    inflight = get(forecastUrl(p), FORECAST_LIMIT, function (error, data) {
      var next = null;
      inflight = null;
      if (p !== place) { plan(); return; }
      if (!error) { try { next = parseForecast(data, forecast && forecast.windy); } catch (e) { error = 'data'; } }
      if (error) { failures++; lastError = error; plan(); redraw(); return; }
      failures = 0; lastError = ''; jitter = Math.floor(Math.random() * MINUTE);
      next.lat = p.lat; next.lon = p.lon; next.at = now();
      p.offset = next.offset;
      forecast = next;
      saveError = !save(place, show, forecast);
      plan(); redraw();
    });
    return true;
  }
  /* Every Home render and every return to the app: cheap unless a refresh is due. Back on Home after
     a while (hidden, another app or a full-screen panel), data older than 10 minutes refresh at once. */
  function wake() {
    var t = now(), returning, next;
    if (!active() || !place) { stop(); return; }
    if (!homeVisible()) { away = true; return; }
    returning = away || t - seen > AWAY_GAP;
    seen = t; away = false;
    if (inflight) return;
    next = due();
    if (returning && !failures && forecast && t - forecast.at >= RETURN_AGE) next = t;
    if (t >= next) refreshNow(); else if (!timer) plan();
  }

  /* ---------- Pictogram: combinable glass layers on a 48 grid (docs/addons.md) ---------- */
  /* WMO weather code plus the measured rain and the wind hysteresis. */
  function layers(f) {
    var c = f.code, cc = finite(f.cloud) ? f.cloud : null, sky = f.day === 0 ? 'moon' : 'sun';
    var L = { sky: '', cloud: false, precip: '', bolt: false, wind: !!f.windy };
    function clouded(limit, precip) { L.cloud = true; L.precip = precip; if (cc !== null && cc < limit) L.sky = sky; }
    if (c === 0 || c === 1) L.sky = sky;
    else if (c === 2) { L.sky = sky; L.cloud = true; }
    else if (c === 3) L.cloud = true;
    else if (c === 45 || c === 48) { L.cloud = true; L.precip = 'fog'; }
    else if (c >= 51 && c <= 67) clouded(50, 'rain');
    else if (c >= 71 && c <= 77) clouded(50, 'snow');
    else if (c >= 80 && c <= 82) clouded(80, 'rain');
    else if (c === 85 || c === 86) clouded(80, 'snow');
    else if (c >= 95 && c <= 99) { clouded(80, 'rain'); L.bolt = true; }
    else if (cc !== null && cc < 20) L.sky = sky;
    else if (cc !== null && cc < 80) { L.sky = sky; L.cloud = true; }
    else L.cloud = true;
    // Rain right now, even when the code lags: at least 0.1 mm in the last 15 minutes.
    if ((f.precip || 0) >= 0.1 && L.precip !== 'snow') { L.precip = 'rain'; L.cloud = true; }
    return L;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function sunMarkup(cx, cy) {
    var rays = '', k, a;
    for (k = 0; k < 8; k++) { a = k * Math.PI / 4; rays += 'M' + r2(cx + 9.5 * Math.cos(a)) + ' ' + r2(cy + 9.5 * Math.sin(a)) + 'L' + r2(cx + 12.5 * Math.cos(a)) + ' ' + r2(cy + 12.5 * Math.sin(a)); }
    return '<circle class="wx-glass" cx="' + cx + '" cy="' + cy + '" r="6.5"/><path d="' + rays + '"/>';
  }
  /* A crescent lit towards the upper right, so it still shows above the right edge of a cloud. */
  function moonMarkup(cx, cy) {
    var a = r2(cx + 0.78) + ' ' + r2(cy + 7.46);
    return '<path class="wx-glass" d="M' + a + 'A7.5 7.5 0 1 0 ' + r2(cx - 7.11) + ' ' + r2(cy - 2.4) + 'A6.4 6.4 0 0 1 ' + a + 'Z"/>';
  }
  function drops(x, list) { return list.map(function (dx) { return 'M' + r2(x + dx) + ' 31l-1.5 6'; }).join(''); }
  function flakes(x, list) {
    return list.map(function (dx) { var cx = r2(x + dx); return 'M' + cx + ' 31.3v6.4M' + r2(cx - 2.77) + ' 32.9l5.54 3.2M' + r2(cx - 2.77) + ' 36.1l5.54-3.2'; }).join('');
  }
  function bolt(x) { return 'M' + r2(x + 2) + ' 31l-4 7h5.5l-3.5 7'; }
  // Ground-row blocks, left to right: { w, top, bottom, d(x) }.
  var BLOCKS = {
    wind: { w: 15, top: 31, bottom: 41, d: function (x) { return 'M' + r2(x) + ' 35h9a2 2 0 1 0-2-2M' + r2(x) + ' 41h13a2 2 0 1 0-2-2'; } },
    rain: { w: 15.5, top: 31, bottom: 37, d: function (x) { return drops(x, [1.5, 8.5, 15.5]); } },
    'rain-bolt': { w: 19, top: 31, bottom: 45, d: function (x) { return drops(x, [1.5, 19]) + bolt(x + 9.5); } },
    bolt: { w: 5.5, top: 31, bottom: 45, d: function (x) { return bolt(x + 2); } },
    snow: { w: 22.4, top: 31.3, bottom: 37.7, d: function (x) { return flakes(x, [3.2, 11.2, 19.2]); } },
    'snow-bolt': { w: 25.2, top: 31, bottom: 45, d: function (x) { return flakes(x, [3.2, 22]) + bolt(x + 10.5); } },
    fog: { w: 20, top: 32.5, bottom: 37.5, d: function (x) { return 'M' + r2(x) + ' 32.5h20M' + r2(x + 3) + ' 37.5h14'; } }
  };
  /* SVG inner markup for CleanTVIcon: the group is translated so its bounds sit in the 48 grid centre.
     A sun or moon behind a cloud is knocked out by #cleantvWxKnock (the widget defines it once). */
  function pictogram(L) {
    var box = [99, 99, -99, -99], sky = '', ground = [], total = 0, x, paths = '', centre;
    function grow(x0, y0, x1, y1) { box = [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)]; }
    if (L.cloud) grow(6, 5.8, 39.1, 27);
    if (L.sky) {
      centre = L.cloud ? L.sky === 'moon' ? [34, 12] : [33, 15] : L.wind ? [24, 14] : [24, 24];
      var r = L.sky === 'moon' ? 7.5 : 12.5;
      grow(centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r);
      sky = '<g' + (L.cloud ? ' mask="url(#cleantvWxKnock)"' : '') + '>' + (L.sky === 'moon' ? moonMarkup(centre[0], centre[1]) : sunMarkup(centre[0], centre[1])) + '</g>';
    }
    if (L.wind) ground.push(BLOCKS.wind);
    if (L.precip || L.bolt) ground.push(BLOCKS[L.precip ? L.precip + (L.bolt && L.precip !== 'fog' ? '-bolt' : '') : 'bolt']);
    ground.forEach(function (b) { total += b.w; });
    total += 5 * Math.max(0, ground.length - 1);
    x = (L.cloud ? 22.5 : 24) - total / 2;
    ground.forEach(function (b) { paths += b.d(x); grow(x, b.top, x + b.w, b.bottom); x += b.w + 5; });
    if (box[0] > box[2]) return '';
    return '<g transform="translate(' + r2(24 - (box[0] + box[2]) / 2) + ' ' + r2(24 - (box[1] + box[3]) / 2) + ')">' + sky
      + (L.cloud ? '<path class="wx-glass" d="' + CLOUD + '"/>' : '') + (paths ? '<path d="' + paths + '"/>' : '') + '</g>';
  }

  /* ---------- Widget: fixed slots, a switched-off element leaves its slot empty ---------- */
  function degrees(v) { var n = Math.round(v) || 0; return (n < 0 ? '−' + -n : String(n)) + '°'; }
  function clock(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function model(lang) {
    var t = now(), f = forecast, age = f ? t - f.at : Infinity, fresh = !!f && age <= EXPIRED, day = f ? today(f.days, t, f.offset) : null;
    if (!SHOW.some(function (key) { return show[key]; })) return null;
    return {
      name: place ? place.name : tr(lang, 'Choose a place'),
      temp: fresh ? degrees(f.temp) : '–',
      icon: fresh ? pictogram(layers(f)) : '',
      range: '↑ ' + (day && day.max !== null ? degrees(day.max) : '–') + ' · ↓ ' + (day && day.min !== null ? degrees(day.min) : '–'),
      wind: (fresh && f.wind !== null ? Math.round(f.wind) : '–') + ' km/h',
      note: !place ? tr(lang, 'Settings › Add-ons › Weather') : f && age > STALE ? tr(lang, 'As of ') + clock(f.at) + ' · Open-Meteo.com' : tr(lang, 'Weather: Open-Meteo.com')
    };
  }
  function setClass(el, name, on) {
    var has = (' ' + el.className + ' ').indexOf(' ' + name + ' ') >= 0;
    if (on && !has) el.className += ' ' + name;
    else if (!on && has) el.className = (' ' + el.className + ' ').replace(' ' + name + ' ', ' ').replace(/^ | $/g, '');
  }
  function setText(el, value) { if (el._text !== value) { el._text = value; el.textContent = value; } }
  function icon(inner) {
    if (!inner) return '';
    return typeof window.CleanTVIcon === 'function' ? window.CleanTVIcon(inner, 96) : '';
  }
  function buildWidget(el) {
    el.innerHTML = '<div class="cw-wx"><svg class="cw-wx-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>'
      + '<mask id="cleantvWxKnock" maskUnits="userSpaceOnUse" x="-8" y="-8" width="64" height="64"><rect x="-8" y="-8" width="64" height="64" fill="#fff"/>'
      + '<path d="' + CLOUD + '" fill="#000" stroke="#000" stroke-width="5.6" stroke-linejoin="round"/></mask></defs></svg>'
      + '<span class="cw-title cw-wx-place" data-slot="name"></span><div class="cw-wx-body"><span class="cw-wx-icon" data-slot="icon"></span>'
      + '<span class="cw-big cw-wx-temp" data-slot="temp"></span><span class="cw-small cw-wx-range" data-slot="range"></span><span class="cw-small cw-wx-wind" data-slot="wind"></span></div>'
      + '<span class="cw-wx-note" data-slot="note"></span></div>';
    var root = el.firstChild, ui = { root: root, markup: null };
    Array.prototype.forEach.call(root.querySelectorAll('[data-slot]'), function (slot) { ui[slot.getAttribute('data-slot')] = slot; });
    el._wx = ui;
    return ui;
  }
  function renderWidget(el, ctx) {
    var lang = ctx && ctx.language === 'de' ? 'de' : 'en', view, ui;
    if (!active()) { if (el.firstChild) { el.innerHTML = ''; el._wx = null; } return; }
    wake();
    view = model(lang);
    // Every element switched off: nothing to show, so the card and its plate disappear.
    if (!view) { if (el.firstChild) { el.innerHTML = ''; el._wx = null; } return; }
    ui = el._wx && el.firstChild === el._wx.root ? el._wx : buildWidget(el);
    setClass(ui.root, 'is-list', !!ctx && ctx.layout === 'list');
    ['name', 'temp', 'range', 'wind'].forEach(function (key) { setText(ui[key], view[key]); });
    setText(ui.note, view.note);
    if (ui.markup !== view.icon) { ui.markup = view.icon; ui.icon.innerHTML = icon(view.icon); }
    SHOW.forEach(function (key) { setClass(ui[key], 'is-off', !show[key]); });
  }

  /* ---------- Place search ---------- */
  function admin(name) {
    return norm(String(name || '').replace(/^(Kreisfreie Stadt|Landkreis|Stadtkreis|Kreis|Kanton|Bundesland|Politischer Bezirk|Regierungsbezirk|Bezirk|Region|Statutarstadt|Stadt|Land)\s+/i, '')
      .replace(/,\s*(Stadt|Markt|Hansestadt|Landeshauptstadt|Universitätsstadt|Kreisstadt|Gemeinde|Flecken)$/i, ''));
  }
  function display(name) { return String(name || '').replace(/\s+/g, ' ').replace(/^ | $/g, ''); }
  function group(r) {
    var code = typeof r.feature_code === 'string' ? r.feature_code : '';
    return code === 'PPLX' ? 2 : /^PPL/.test(code) && !/^PPL(H|Q|W|CH)$/.test(code) ? 0 : 1;
  }
  /* Geocoding results the app can use; null when the response has the wrong shape. */
  function places(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) return null;
    if (data.results === undefined) return [];
    if (!Array.isArray(data.results)) return null;
    return data.results.filter(function (r) {
      return r && typeof r === 'object' && text(r.name, 120) && finite(r.latitude) && finite(r.longitude) && Math.abs(r.latitude) <= 90 && Math.abs(r.longitude) <= 180;
    }).slice(0, 100);
  }
  /* Populated places before other features and districts (PPLX last), then population, then names
     that start with the query; the API's own order breaks the remaining ties. */
  function rank(list, query) {
    var q = norm(query);
    return list.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
      return group(a.r) - group(b.r) || (finite(b.r.population) ? b.r.population : 0) - (finite(a.r.population) ? a.r.population : 0)
        || (norm(a.r.name).indexOf(q) === 0 ? 0 : 1) - (norm(b.r.name).indexOf(q) === 0 ? 0 : 1) || a.i - b.i;
    }).map(function (x) { return x.r; });
  }
  function shortAdmin(name) { return display(name).replace(/^(Kreisfreie Stadt|Landkreis|Stadtkreis|Kreis|Politischer Bezirk|Bezirk)\s+/i, '').replace(/,\s*(Stadt|Markt)$/i, ''); }
  /* The district or, for a district (PPLX), its town tells equal names apart; then state and country. */
  function geoDetail(r) {
    var parts = [], parent = shortAdmin(r.feature_code === 'PPLX' ? r.admin4 || r.admin3 : r.admin3 || r.admin2), p = norm(parent), name = norm(r.name);
    if (p && p !== name && name.indexOf(p) !== 0 && admin(parent) !== admin(r.admin1)) parts.push(parent);
    if (r.admin1) parts.push(display(r.admin1));
    if (r.country_code !== 'DE' && r.country) parts.push(display(r.country));
    return parts.join(', ');
  }
  function geoItem(r) {
    var detail = geoDetail(r);
    return { name: display(r.name), detail: detail, place: { name: display(r.name), region: display(r.admin1), detail: detail, country: r.country_code, lat: r.latitude, lon: r.longitude, timezone: r.timezone } };
  }
  function field(o, prop) { return o && typeof o === 'object' && typeof o[prop] === 'string' ? display(o[prop]) : ''; }
  /* Swiss cantons by abbreviation, as GeoNames names them in German (without "Kanton"); OpenPLZ uses
     the official names ("Genève", "Vaud", "Bern / Berne"). */
  var CANTONS = { AG: 'Aargau', AI: 'Appenzell Innerrhoden', AR: 'Appenzell Ausserrhoden', BE: 'Bern', BL: 'Basel-Landschaft', BS: 'Basel-Stadt',
    FR: 'Freiburg', GE: 'Genf', GL: 'Glarus', GR: 'Graubünden', JU: 'Jura', LU: 'Luzern', NE: 'Neuenburg', NW: 'Nidwalden', OW: 'Obwalden',
    SG: 'St. Gallen', SH: 'Schaffhausen', SO: 'Solothurn', SZ: 'Schwyz', TG: 'Thurgau', TI: 'Tessin', UR: 'Uri', VD: 'Waadt', VS: 'Wallis', ZG: 'Zug', ZH: 'Zürich' };
  /* OpenPLZ abbreviates official names ("St. Ingbert", "Mühldorf a. Inn", "Weiden i.d.OPf."); GeoNames
     mostly spells them out ("Sankt Ingbert"). */
  function expand(name) {
    return display(String(name || '').replace(/(^|[\s(])St\.\s*/g, '$1Sankt ').replace(/(^|\s)a\.\s*d\.\s*/g, '$1an der ')
      .replace(/(^|\s)i\.\s*d\.\s*/g, '$1in der ').replace(/(^|\s)v\.\s*d\.\s*/g, '$1vor der ')
      .replace(/(^|\s)a\.\s*/g, '$1am ').replace(/(^|\s)i\.\s*/g, '$1im '));
  }
  /* Comparable names: the part before a comma, abbreviations spelled out, administrative words, spaces and
     punctuation dropped, so "Mühldorf a.Inn, St" and "Landkreis Mühldorf am Inn" agree. */
  function comparable(name) {
    return admin(expand(String(name || '').split(',')[0])).replace(/^(verwaltungskreis|wahlkreis|district de la|district de|district du|canton de|canton du)\s+/, '')
      .replace(/[^0-9a-z\u00df-\u00f6\u00f8-\u024f]+/g, '');
  }
  // Every language part of a state ("Bern / Berne"), plus the German name of a Swiss canton.
  function regions(lookup) {
    var list = String(lookup.region || '').split('/').map(comparable).filter(Boolean);
    if (CANTONS[lookup.canton]) list.push(comparable(CANTONS[lookup.canton]));
    return list;
  }
  function plzItem(cc, row, code, lang) {
    if (!row || typeof row !== 'object' || !text(row.name, 120)) return null;
    var name = display(row.name), country = cc.toUpperCase();
    var region = cc === 'de' ? field(row.federalState, 'name') : cc === 'at' ? field(row.federalProvince, 'name') : cc === 'ch' ? field(row.canton, 'name') : '';
    var district = field(row.district, 'name'), municipality = cc === 'ch' || cc === 'li' ? field(row.commune, 'name') : field(row.municipality, 'name');
    var parts = [], brief = comparable(district), detail;
    // Districts tell villages apart in Germany and Switzerland; Austrian postal areas span several.
    if (cc !== 'at' && brief && brief !== comparable(name) && brief !== comparable(region)) parts.push(shortAdmin(district));
    if (region) parts.push(region);
    if (country !== 'DE') parts.push(tr(lang, { AT: 'Austria', CH: 'Switzerland', LI: 'Liechtenstein' }[country]));
    detail = code + ' · ' + parts.join(', ');
    return { name: name, detail: detail, lookup: { country: country, code: code, name: name, region: region, canton: cc === 'ch' ? field(row.canton, 'shortName').toUpperCase() : '',
      district: district, municipality: municipality, detail: detail } };
  }
  function own(item) { return comparable(item.lookup.municipality) === comparable(item.name); }
  function postal(countries, code, lang, done) {
    var pending = countries.length, found = {}, failed = '';
    var handles = countries.map(function (cc) {
      return get(PLZ + cc + '/Localities?postalCode=' + code + '&pageSize=50', PLZ_LIMIT, function (error, data) {
        if (error || !Array.isArray(data)) failed = failed || error || 'data'; else found[cc] = data;
        if (--pending) return;
        var items = [], seen = {};
        countries.forEach(function (cc) {
          (found[cc] || []).forEach(function (row) {
            var item = plzItem(cc, row, code, lang), id = item && item.lookup.country + '|' + norm(item.name) + '|' + norm(item.lookup.region);
            if (!item) return;
            // One entry per place; it keeps the row whose municipality has the place's name (Sion, not Savièse).
            if (!seen[id]) seen[id] = items.push(item);
            else if (own(item) && !own(items[seen[id] - 1])) items[seen[id] - 1] = item;
          });
        });
        if (!items.length && failed) done(failure(lang, failed, true));
        else done('', items.slice(0, 100), items.length ? '' : tr(lang, 'No place with this postal code.'));
      });
    });
    return handles;
  }
  /* Live suggestions for the keyboard: 5 digits are a German postal code, 4 digits Austrian, Swiss or
     Liechtenstein codes, anything else a place name. */
  function search(query, lang, done) {
    var handles;
    if (!active()) { done(tr(lang, 'The weather add-on is not active.')); return null; }
    if (/^[0-9]+$/.test(query)) {
      if (query.length === 5) handles = postal(['de'], query, lang, done);
      else if (query.length === 4) handles = postal(['at', 'ch', 'li'], query, lang, done);
      else { done('', [], tr(lang, 'Postal codes have 4 (AT, CH, LI) or 5 digits (DE).')); return null; }
    } else {
      handles = [get(GEOCODING + '?name=' + encodeURIComponent(query) + '&count=100&language=de&format=json', SEARCH_LIMIT, function (error, data) {
        var list = error ? null : places(data), items;
        if (!list) { done(failure(lang, error || 'data', true)); return; }
        items = rank(list, query).map(geoItem);
        done('', items, items.length ? '' : tr(lang, 'No place found.'));
      })];
    }
    return function () { handles.forEach(function (h) { h.abort(); }); };
  }
  /* A postal-code entry has no coordinates. A GeoNames place in the same country counts when it lists
     the postal code ("Genf" for 1201 Genève), or when it lies in the same state and has the same name
     or, as a town, the same district or municipality ("Mühldorf" in "Mühldorf a. Inn"); names compare
     through comparable(). Weight, in this order: same name, the code, the district, a town, then
     population. A lookup by the postal code itself takes only a place that lists it. */
  function match(list, step, lookup) {
    var want = comparable(step.query), wanted = regions(lookup), areas = [comparable(lookup.district), comparable(lookup.municipality)].filter(Boolean), best = null, score = -1;
    list.forEach(function (r) {
      var town = group(r) === 0, named = !step.code && comparable(r.name) === want, s,
        coded = !!lookup.code && Array.isArray(r.postcodes) && r.postcodes.indexOf(lookup.code) >= 0,
        area = [r.admin2, r.admin3, r.admin4].some(function (a) { return !!a && areas.indexOf(comparable(a)) >= 0; });
      if (r.country_code && r.country_code !== lookup.country || step.code && !coded) return;
      if (!coded && (wanted.length && wanted.indexOf(comparable(r.admin1)) < 0 || !named && !(area && town))) return;
      s = (named ? 8 : 0) + (coded ? 4 : 0) + (area ? 2 : 0) + (town ? 1 : 0);
      if (s > score || s === score && (r.population || 0) > (best.population || 0)) { best = r; score = s; }
    });
    return best;
  }
  /* Lookups in turn until one matches: the name, then the municipality, each as written and spelled
     out (names with a comma, "Wien, Innere Stadt", by their first part), then the postal code. */
  function locate(lookup, lang, done) {
    var steps = [], tried = {}, handle = null, cancelled = false;
    function add(query, code) {
      var id = norm(query).replace(/[\s.]+/g, '');
      if (query && !tried[id]) { tried[id] = true; steps.push({ query: query, code: code }); }
    }
    [lookup.name, lookup.municipality].forEach(function (name) {
      var first = display(String(name || '').split(',')[0]);
      add(first, false); add(expand(first), false);
    });
    if (lookup.code) add(lookup.code, true);
    (function next(i) {
      if (i >= steps.length) { done(tr(lang, 'No coordinates were found for this place.')); return; }
      handle = get(GEOCODING + '?name=' + encodeURIComponent(steps[i].query) + '&count=100&language=de&format=json&countryCode=' + lookup.country, SEARCH_LIMIT, function (error, data) {
        var list = error ? null : places(data), best = list && match(list, steps[i], lookup);
        handle = null;
        if (cancelled) return;
        if (!list) { done(failure(lang, error || 'data', true)); return; }
        if (!best) { next(i + 1); return; }
        done('', { name: lookup.name, region: lookup.region, detail: lookup.detail, country: lookup.country, lat: best.latitude, lon: best.longitude, timezone: best.timezone });
      });
    }(0));
    return function () { cancelled = true; if (handle) handle.abort(); };
  }
  function apply(p, lang) {
    var next = cleanPlace(p);
    if (!next) return tr(lang, 'No coordinates were found for this place.');
    if (!save(next, show, null)) return tr(lang, 'Could not save the place.');
    stop();
    place = next; forecast = null; failures = 0; lastError = ''; saveError = false;
    // An explicit choice loads at once, also from the keyboard.
    refreshNow();
    redraw();
    return '';
  }
  function choose(item, lang, done) {
    if (!active()) { done(tr(lang, 'The weather add-on is not active.')); return null; }
    if (item && item.place) { done(apply(item.place, lang)); return null; }
    if (!item || !item.lookup) { done(tr(lang, 'No coordinates were found for this place.')); return null; }
    return locate(item.lookup, lang, function (error, p) { done(error || apply(p, lang)); });
  }

  /* ---------- Settings ---------- */
  function status(lang) {
    if (!place) return tr(lang, 'No place chosen yet.');
    if (saveError) return tr(lang, 'Could not save the weather settings.');
    if (inflight) return tr(lang, 'Updating…');
    if (failures) return failure(lang, lastError, false) + (forecast ? ' ' + tr(lang, 'As of ') + clock(forecast.at) : '');
    if (forecast) return tr(lang, 'As of ') + clock(forecast.at) + tr(lang, ' · updates every 15 minutes');
    return tr(lang, 'Waiting for the first update.');
  }
  var settings = {
    title: function (lang) { return tr(lang, 'Weather'); },
    sections: function (lang) {
      return [
        { id: 'weather-place', title: tr(lang, 'Place'), reason: status(lang), items: [{ action: 'cleantv.weather.place', label: place ? place.name : tr(lang, 'Choose a place'),
          description: place ? place.detail || place.region : tr(lang, 'Search by name or postal code'), hint: tr(lang, 'Search for a place') }] },
        { id: 'weather-show', title: tr(lang, 'Show on Home'), reason: tr(lang, 'Weather: Open-Meteo.com (CC BY 4.0) · Places: GeoNames (CC BY 4.0), OpenPLZ (ODbL)'),
          items: SHOW.map(function (key) { return { action: 'cleantv.weather.show.' + key, label: tr(lang, SHOW_LABELS[key]), axis: 'cleantv-weather-' + key, value: true, applied: show[key], hint: tr(lang, show[key] ? 'Hide' : 'Show') }; }) }
      ];
    },
    ok: function (item) {
      var key = /^cleantv\.weather\.show\.([a-z]+)$/.exec(item.action), next;
      if (item.action === 'cleantv.weather.place') return !!(window.CleanTVAddonSettings && typeof window.CleanTVAddonSettings.open === 'function' && window.CleanTVAddonSettings.open(VIEW, {}));
      if (!key || SHOW.indexOf(key[1]) < 0) return false;
      next = cleanShow(show); next[key[1]] = !next[key[1]];
      // A failed write keeps the previous choice.
      if (save(place, next, forecast)) { show = next; saveError = false; } else saveError = true;
      return true;
    }
  };

  /* ---------- Registration and lifecycle ---------- */
  function cleantv(name) {
    var r = window[name];
    if (!r) { r = window[name] = { queue: [] }; r.register = function () { r.queue.push(Array.prototype.slice.call(arguments)); }; }
    return r;
  }
  function guarded(fn) { try { fn(); } catch (e) { window.setTimeout(function () { throw e; }, 0); } }
  load();
  guarded(function () { cleantv('CleanTVAddonKinds').register(KIND, { validate: validate, widget: false }); });
  guarded(function () { cleantv('CleanTVAddonSettings').register(ID, settings); });
  guarded(function () {
    if (!window.CleanTVKeyboard) return;
    cleantv('CleanTVViews').register(VIEW, window.CleanTVKeyboard.create({
      name: VIEW, min: 2, max: 40, delay: 400, limit: 100, suggest: search, choose: choose,
      title: function (lang) { return tr(lang, 'Search for a place'); },
      placeholder: function (lang) { return tr(lang, 'Name or postal code'); },
      hint: function (lang) { return tr(lang, 'Type a place name or a postal code.'); }
    }));
  });
  guarded(function () { cleantv('CleanTVWidgets').register(ID, { order: 10, render: renderWidget }); });
  window.addEventListener('cleanframe:addons', function () { if (!active()) stop(); else wake(); });
  window.addEventListener('online', function () { if (failures && active() && place && homeVisible() && !inflight) refreshNow(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) away = true; else wake(); });

  /* Read-only state for checks; reload() reads the stored record again (browser checks seed it). */
  window.CleanTVWeather = {
    state: function () { return copy({ place: place, show: show, forecast: forecast, failures: failures, error: lastError, busy: !!inflight, saveError: saveError, due: place ? due() : 0 }); },
    reload: function () { stop(); load(); failures = 0; lastError = ''; saveError = false; away = true; seen = 0; redraw(); },
    layers: layers, pictogram: pictogram, rank: rank, today: today, windy: windy
  };
}());
