// Test the weather add-on (app/tizen-weather.js) with the real keyboard, store and Tizen host, a
// synthetic XHR, clock, document and localStorage, and recorded-style API fixtures. No TV or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8');
const SOURCES = ['sha256.js', 'tizen-store.js', 'cleantv-keyboard.js', 'tizen-weather.js', 'tizen-addons.js'].map(read);
const FX = JSON.parse(readFileSync(new URL('./fixtures/weather-api.json', import.meta.url), 'utf8'));
const GEO = 'https://geocoding-api.open-meteo.com/v1/search', FORECAST = 'https://api.open-meteo.com/v1/forecast', PLZ = 'https://openplzapi.org/';
const BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/';
const MIN = 60000, T0 = Date.UTC(2026, 10, 1, 9, 0, 0); // 10:00 in Bonn (UTC+1)
const plain = value => JSON.parse(JSON.stringify(value));
const hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = text => { const b = Buffer.from(text, 'utf8'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
function record(data, seq = 1) { const json = JSON.stringify(data); return JSON.stringify({ v: 1, seq, sum: hex(json), data: json }); }
const PKG = { api: 1, id: 'cleantv-weather', name: 'Wetter', version: '1.0.0', kind: 'weather', description: 'Wetter unter der Uhr', author: 'Psychnix', license: 'MIT' };
const BONN = { name: 'Bonn', region: 'Nordrhein-Westfalen', detail: '53111 · Nordrhein-Westfalen', country: 'DE', lat: 50.73438, lon: 7.09549, timezone: 'Europe/Berlin', offset: 3600 };
const SHOW = { name: true, temp: true, range: true, wind: true, icon: true };
/* A stored forecast as the module writes it. */
const cached = (at, extra) => Object.assign({ lat: BONN.lat, lon: BONN.lon, at, offset: 3600, temp: 8.1, code: 3, wind: 5, gusts: 9.4, precip: 0, cloud: 100, day: 1, windy: false,
  days: [{ date: '2026-11-01', max: 10.2, min: 8 }, { date: '2026-11-02', max: 8.7, min: 7.5 }] }, extra);
const forecastBody = current => { const f = plain(FX.forecast); Object.assign(f.current, current); return f; };

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { map, quota: false, getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (this.quota) { const e = new Error('Quota exceeded'); e.name = 'QuotaExceededError'; throw e; } map.set(key, String(value)); },
    removeItem(key) { map.delete(key); } };
}
/* Just enough DOM for the widget: innerHTML creates the root and its data-slot children. */
class El {
  constructor(className = '', slot = '') { Object.assign(this, { className, slot, kids: [], textContent: '', _html: '' }); }
  set innerHTML(html) {
    this._html = html; this.kids = [];
    if (!html || this.slot) return;
    const root = new El((/^<div class="([^"]*)"/.exec(html) || [])[1] || '');
    root.slots = [...html.matchAll(/<(?:span|div) class="([^"]*)" data-slot="([a-z]+)"/g)].map(m => new El(m[1], m[2]));
    root.querySelectorAll = () => root.slots;
    this.kids = [root];
  }
  get innerHTML() { return this._html; }
  get firstChild() { return this.kids[0] || null; }
  getAttribute(name) { return name === 'data-slot' ? this.slot : null; }
}

function harness({ installed = true, enabled = true, tizen = true, weather, now = T0, local } = {}) {
  const clock = { now }, timers = [], xhrs = [], listeners = {}, docListeners = {}, opened = [], closed = [];
  let nextId = 1;
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const math = Object.create(Math); math.random = () => 0.5;
  class FakeXHR {
    constructor() { Object.assign(this, { headers: {}, status: 0, response: null, responseText: '', responseURL: '' }); xhrs.push(this); }
    open(method, url, async) { Object.assign(this, { method, url, async }); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send() { this.sent = true; this.at = clock.now; }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    respond({ status = 200, json, text, url } = {}) {
      const body = text !== undefined ? text : JSON.stringify(json);
      Object.assign(this, { status, responseText: body, response: bytes(body), responseURL: url === undefined ? this.url : url, done: true });
      if (this.onload) this.onload();
    }
    fail(kind = 'error') { this.done = true; if (kind === 'timeout') this.ontimeout(); else this.onerror(); }
  }
  class FakeEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const seed = {};
  if (installed) seed['cleantv.addons.v1.a'] = record({ installed: { 'cleantv-weather': Object.assign({}, PKG, { enabled }) }, catalog: [], catalogInfo: { checked: false, total: 0, compatible: 0 } });
  if (weather) seed['cleantv.weather.v1.a'] = record(weather);
  const store = local || storage(seed);
  const stage = { className: 'stage bg-photo l-dock' };
  const document = {
    hidden: false, documentElement: { contains: () => false },
    getElementById: id => id === 'stage' ? stage : null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); }
  };
  const window = {
    FrameDevice: {}, XMLHttpRequest: FakeXHR, CustomEvent: FakeEvent, Uint8Array, TextDecoder, Intl, localStorage: store,
    setTimeout(fn, ms) { const id = nextId++; timers.push({ id, at: clock.now + (ms || 0), fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(event) { (listeners[event.type] || []).forEach(fn => fn(event)); },
    CleanTVIcon: (inner, size) => '<svg size="' + size + '">' + inner + '</svg>'
  };
  if (tizen) window.tizen = { application: {} };
  const context = vm.createContext({ window, document, Date: FakeDate, Math: math });
  for (const source of SOURCES) vm.runInContext(source, context);
  const queued = (name, id) => (window[name].queue.find(q => q[0] === id) || [])[1];
  const widget = queued('CleanTVWidgets', 'cleantv-weather'), settings = queued('CleanTVAddonSettings', 'cleantv-weather'), view = queued('CleanTVViews', 'cleantv.weather.keyboard');
  window.CleanTVAddonSettings.open = (name, data) => { opened.push(name); return true; };
  window.CleanTVViews.close = name => { closed.push(name); return true; };
  const el = new El();
  const h = {
    window, document, stage, store, xhrs, widget, settings, view, el, opened, closed, clock,
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift(); clock.now = t.at; t.fn();
      }
      clock.now = end;
    },
    render(ctx = {}) {
      widget.render(el, Object.assign({ language: 'de', layout: 'dock', bg: 'photo', visible: true }, ctx));
      if (!el.firstChild) return null;
      const ui = el._wx, off = ['name', 'temp', 'range', 'wind', 'icon'].filter(k => / is-off( |$)/.test(ui[k].className));
      return { name: ui.name.textContent, temp: ui.temp.textContent, range: ui.range.textContent, wind: ui.wind.textContent, note: ui.note.textContent, icon: ui.icon.innerHTML, off, list: / is-list/.test(ui.root.className) };
    },
    hide(value) { document.hidden = value; (docListeners.visibilitychange || []).forEach(fn => fn()); },
    fire(type) { (listeners[type] || []).forEach(fn => fn({ type })); },
    state: () => plain(window.CleanTVWeather.state()),
    pending: () => xhrs.filter(x => !x.done && !x.aborted),
    last: () => xhrs[xhrs.length - 1],
    host: request => window.FrameDevice.addons(request)
  };
  /* The keyboard as the remote drives it: focus a key, press OK. */
  const layout = window.CleanTVKeyboard.layout();
  h.keyboard = (lang = 'de') => {
    const t = { id: 'cleantv.weather.keyboard', data: {}, f: {} };
    view.norm(t); t.kb.lang = lang;
    const press = id => { for (let r = 0; r < layout.length; r++) for (const key of layout[r]) if (key.id === id) { t.f.zone = 'keys'; t.f.r = r; t.f.x = key.col; view.key(t, 'ok'); return; } throw Error('No key ' + id); };
    return {
      t,
      type(text) { for (const ch of text) press(ch === ' ' ? 'space' : ch === '-' ? 'hyphen' : { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[ch.toLowerCase()] || ch.toLowerCase()); h.advance(400); },
      clear() { while (t.kb.value) press('delete'); },
      names: () => plain(t.kb.items.map(i => i.name)),
      list: () => plain(t.kb.items),
      lines: () => plain(t.kb.items.map(i => i.name + ' | ' + i.detail)),
      pick(index) { press('ok'); t.f.i = index; view.key(t, 'ok'); }
    };
  };
  /* Answers a request from the fixtures, as the real services would. */
  h.serve = (xhr = h.last(), forecast) => {
    const u = new URL(xhr.url);
    if (xhr.url.startsWith(GEO)) return xhr.respond({ json: FX.geocoding[u.searchParams.get('name') + (u.searchParams.get('countryCode') ? '|' + u.searchParams.get('countryCode') : '')] || { generationtime_ms: 0.1 } });
    if (xhr.url.startsWith(PLZ)) return xhr.respond({ json: FX.openplz[u.pathname.split('/')[1] + '/' + u.searchParams.get('postalCode')] || [] });
    if (xhr.url.startsWith(FORECAST)) return xhr.respond({ json: forecastBody(forecast) });
    throw Error('Unexpected request ' + xhr.url);
  };
  h.advance(0);
  return h;
}
const withPlace = (forecast, show = SHOW) => ({ place: BONN, show, forecast: forecast || null });
const FORECAST_URL = FORECAST + '?latitude=50.73438&longitude=7.09549&current=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FBerlin&forecast_days=2';

test('the module registers its kind, settings, keyboard view and widget before the host loads', () => {
  const h = harness({ installed: false });
  assert.equal(h.window.CleanTVAddonKinds.registered('weather'), true);
  assert.equal(typeof h.widget.render, 'function');
  assert.equal(h.window.CleanTVWidgets.queue.find(q => q[0] === 'cleantv-weather')[1].order, 10);
  assert.equal(typeof h.settings.sections, 'function');
  assert.equal(typeof h.view.key, 'function');
  assert.equal(h.xhrs.length, 0);
});

test('the weather kind accepts only the ID cleantv-weather and no fields of its own', () => {
  const h = harness({ installed: false });
  const listed = item => Object.assign({}, item, { path: 'cleantv-packages/' + item.id + '/' + item.version + '.json', sha256: hex(JSON.stringify(item)) });
  const refresh = addons => { h.host({ action: 'refresh' }); h.last().respond({ text: JSON.stringify({ api: 2, addons }) }); h.advance(0); return plain(h.host({ action: 'state' })); };
  let s = refresh([listed(PKG)]);
  assert.equal(s.error, '');
  assert.deepEqual(s.catalog.map(e => e.id + ' ' + e.path), ['cleantv-weather cleantv-packages/cleantv-weather/1.0.0.json']);
  s = refresh([listed(Object.assign({}, PKG, { id: 'weather-two' }))]);
  assert.equal(s.error, 'The weather add-on must use the ID cleantv-weather.');
  assert.equal(s.catalog.length, 1, 'a refused catalog keeps the previous one');
  s = refresh([listed(Object.assign({}, PKG, { url: 'https://example.org' }))]);
  assert.equal(s.error, 'The weather add-on has unsupported fields.');
  s = refresh([listed(Object.assign({}, PKG, { permissions: ['network'] }))]);
  assert.equal(s.error, 'The weather add-on has unsupported fields.');
  refresh([listed(PKG)]);
  h.host({ action: 'install', id: 'cleantv-weather' });
  assert.equal(h.last().url, BASE + 'cleantv-packages/cleantv-weather/1.0.0.json');
  h.last().respond({ text: JSON.stringify(PKG) }); h.advance(0);
  s = plain(h.host({ action: 'state' }));
  assert.equal(s.error, '');
  assert.equal(s.installed['cleantv-weather'].enabled, true);
  assert.equal(h.window.CleanTVAddons.enabled('cleantv-weather'), true);
});

test('nothing is requested without the installed and enabled package', () => {
  for (const options of [{ installed: false }, { enabled: false }, { tizen: false }]) {
    const h = harness(Object.assign({ weather: withPlace(cached(T0 - 60 * MIN)) }, options));
    assert.equal(h.render(), null, 'no widget card');
    const kb = h.keyboard();
    kb.type('bonn');
    assert.equal(kb.t.kb.message, 'Das Wetter Add-on ist nicht aktiv.');
    kb.clear(); kb.type('53111');
    h.fire('online'); h.hide(true); h.hide(false);
    h.advance(6 * 60 * MIN); h.render();
    assert.equal(h.xhrs.length, 0, JSON.stringify(options));
  }
  const h = harness();
  const empty = h.render();
  assert.deepEqual([empty.name, empty.temp, empty.range, empty.wind, empty.note], ['Ort wählen', '–', '↑ – · ↓ –', '– km/h', 'Einstellungen › Add-ons › Wetter']);
  h.advance(60 * MIN);
  assert.equal(h.xhrs.length, 0, 'no place, no request');
});

test('place names: towns before districts (PPLX last), then population; every match is offered', () => {
  const h = harness();
  const kb = h.keyboard();
  kb.type('frankfurt');
  assert.equal(h.last().url, GEO + '?name=Frankfurt&count=100&language=de&format=json');
  assert.deepEqual({ method: h.last().method, headers: h.last().headers, credentials: h.last().withCredentials, timeout: h.last().timeout }, { method: 'GET', headers: {}, credentials: false, timeout: 15000 });
  h.serve();
  const items = kb.list(), names = kb.names();
  assert.equal(items.length, FX.geocoding.Frankfurt.results.length, 'all results are listed');
  assert.deepEqual(names.slice(0, 2), ['Frankfurt am Main', 'Frankfurt (Oder)']);
  assert.equal(items[0].detail, 'Hessen');
  assert.equal(items.find(i => i.name === 'Frankfurt').detail, 'Neustadt an der Aisch-Bad Windsheim, Bayern');
  const kinds = FX.geocoding.Frankfurt.results.reduce((m, r) => Object.assign(m, { [r.name]: r.feature_code }), {});
  const firstDistrict = names.findIndex(n => kinds[n] === 'PPLX');
  assert.ok(firstDistrict > 0 && names.slice(firstDistrict).every(n => kinds[n] === 'PPLX'), 'districts come last');
  assert.equal(items.find(i => i.name === 'Frankfurt-Nied').detail, 'Frankfurt am Main, Hessen', 'a district names its town');
  kb.clear(); kb.type('neustadt');
  assert.equal(FX.geocoding.Neustadt.results.findIndex(r => r.name === 'Neustadt an der Weinstraße'), 76, 'the API lists it at rank 77');
  h.serve();
  assert.equal(kb.list().length, 100);
  assert.ok(kb.names().indexOf('Neustadt an der Weinstraße') < 3, kb.names().slice(0, 5).join(', '));
  assert.equal(kb.names()[0], 'Neustadt an der Weinstraße');
  assert.equal(h.window.CleanTVWeather.rank([{ name: 'Bonn-Beuel', feature_code: 'PPL' }, { name: 'Alt Bonn', feature_code: 'PPL' }], 'bonn').map(r => r.name).join(), 'Bonn-Beuel,Alt Bonn', 'with equal population, names starting with the query first');
});

test('a chosen name is stored with its coordinates and loads the forecast at once', () => {
  const h = harness();
  const kb = h.keyboard();
  kb.type('bonn'); h.serve();
  assert.equal(h.last().url, GEO + '?name=Bonn&count=100&language=de&format=json');
  kb.pick(0);
  assert.deepEqual(h.closed, ['cleantv.weather.keyboard'], 'the keyboard closes after the choice');
  assert.deepEqual(h.state().place, { name: 'Bonn', region: 'Nordrhein-Westfalen', detail: 'Nordrhein-Westfalen', country: 'DE', lat: 50.73438, lon: 7.09549, timezone: 'Europe/Berlin', offset: null });
  assert.equal(h.last().url, FORECAST_URL, 'a new place loads at once, also with the keyboard open');
  h.serve();
  assert.equal(h.state().place.offset, 3600);
  const again = harness({ local: h.store });
  assert.deepEqual(again.state().place, h.state().place, 'the place and its forecast are stored');
  assert.equal(again.state().forecast.temp, 8.1);
});

test('postal codes: every place for a German code, Austrian, Swiss and Liechtenstein codes, then coordinates by state and district', () => {
  const h = harness();
  const kb = h.keyboard();
  kb.type('53111');
  assert.equal(h.last().url, PLZ + 'de/Localities?postalCode=53111&pageSize=50');
  h.serve();
  assert.deepEqual(kb.lines(), ['Bonn | 53111 · Nordrhein-Westfalen']);
  kb.pick(0);
  assert.equal(h.last().url, GEO + '?name=Bonn&count=100&language=de&format=json&countryCode=DE');
  h.serve();
  assert.deepEqual(h.state().place, Object.assign({}, BONN, { offset: null }));
  assert.equal(h.last().url, FORECAST_URL);
  h.serve();

  const k2 = h.keyboard();
  k2.type('54636'); h.serve();
  assert.equal(k2.list().length, 39, 'every place with this code');
  const altscheid = k2.names().indexOf('Altscheid');
  assert.equal(k2.list()[altscheid].detail, '54636 · Eifelkreis Bitburg-Prüm, Rheinland-Pfalz');
  k2.pick(altscheid);
  assert.equal(h.last().url, GEO + '?name=Altscheid&count=100&language=de&format=json&countryCode=DE');
  h.serve();
  assert.deepEqual([h.state().place.name, h.state().place.lat, h.state().place.lon], ['Altscheid', 50.01667, 6.4]);
  h.serve();
  const kh = h.keyboard();
  kh.type('54636'); h.serve();
  kh.pick(kh.names().indexOf('Hamm'));
  assert.equal(h.last().url, GEO + '?name=Hamm&count=100&language=de&format=json&countryCode=DE');
  h.serve();
  assert.deepEqual([h.state().place.lat, h.state().place.lon], [50.01667, 6.41667], 'Hamm in the Eifelkreis, not the larger Hamm in Westphalia or another one in the same state');
  h.serve();
  // Without a district only the state decides: the Hamm in Lower Saxony, not the larger one in Westphalia.
  const kn = h.keyboard();
  kn.type('49740');
  h.last().respond({ json: [{ postalCode: '49740', name: 'Hamm', federalState: { key: '03', name: 'Niedersachsen' } }] });
  kn.pick(0);
  h.serve();
  assert.deepEqual([h.state().place.lat, h.state().place.region], [52.65695, 'Niedersachsen']);
  h.serve();

  const k3 = h.keyboard();
  k3.type('8001');
  const four = h.pending().map(x => x.url);
  assert.deepEqual(four, ['at', 'ch', 'li'].map(cc => PLZ + cc + '/Localities?postalCode=8001&pageSize=50'), 'a 4-digit code asks Austria, Switzerland and Liechtenstein');
  h.pending().forEach(x => h.serve(x));
  assert.deepEqual(k3.lines(), ['Zürich | 8001 · Zürich, Schweiz']);
  k3.pick(0);
  assert.equal(h.last().url, GEO + '?name=Z%C3%BCrich&count=100&language=de&format=json&countryCode=CH');
  h.serve();
  assert.deepEqual([h.state().place.name, h.state().place.lat, h.state().place.timezone], ['Zürich', 47.36667, 'Europe/Zurich']);
  h.serve();

  const k4 = h.keyboard();
  k4.type('1010'); h.pending().forEach(x => h.serve(x));
  assert.deepEqual(k4.lines(), ['Wien, Innere Stadt | 1010 · Wien, Österreich'], 'one entry per place');
  k4.pick(0);
  assert.equal(h.last().url, GEO + '?name=Wien&count=100&language=de&format=json&countryCode=AT', 'a name with a comma is looked up by its first part');
  h.serve();
  assert.deepEqual([h.state().place.name, h.state().place.lat], ['Wien, Innere Stadt', 48.20849]);
  h.serve();
  const k5 = h.keyboard();
  k5.type('9490'); h.pending().forEach(x => h.serve(x));
  assert.deepEqual(k5.lines(), ['Vaduz | 9490 · Liechtenstein']);
});

test('postal codes whose places OpenPLZ and GeoNames name differently resolve as well (recorded answers)', () => {
  const h = harness();
  /* Type the code, pick the only entry, answer every coordinate lookup; returns the names asked for. */
  const choose = (code, line, answer = x => h.serve(x)) => {
    const kb = h.keyboard();
    kb.type(code); h.pending().forEach(x => h.serve(x));
    assert.deepEqual(kb.lines(), [line]);
    kb.pick(0);
    const asked = [];
    for (let x = h.pending()[0]; x && x.url.startsWith(GEO); x = h.pending()[0]) {
      assert.match(x.url, new RegExp('&countryCode=' + (code.length === 5 ? 'DE' : 'CH') + '$'));
      asked.push(new URL(x.url).searchParams.get('name')); answer(x);
    }
    assert.equal(kb.t.kb.message, '', code);
    assert.equal(h.last().url.startsWith(FORECAST), true, 'the chosen place loads at once');
    h.serve();
    return asked;
  };
  const at = () => { const p = h.state().place; return [p.name, p.region, p.lat, p.lon, p.timezone]; };
  // Canton "Bern / Berne" against GeoNames "Kanton Bern".
  assert.deepEqual(choose('3011', 'Bern | 3011 · Verwaltungskreis Bern-Mittelland, Bern / Berne, Schweiz'), ['Bern']);
  assert.deepEqual(at(), ['Bern', 'Bern / Berne', 46.94809, 7.44744, 'Europe/Zurich']);
  // GeoNames answers "Genf" in "Kanton Genf"; the place lists the postal code, and canton GE is Genf.
  assert.deepEqual(choose('1201', 'Genève | 1201 · Genève, Schweiz'), ['Genève']);
  assert.deepEqual(at(), ['Genève', 'Genève', 46.20222, 6.14569, 'Europe/Zurich']);
  // "Sion" finds only the airport (not a town): the row whose commune is Sion, then the postal code.
  assert.deepEqual(choose('1950', 'Sion | 1950 · Valais / Wallis, Schweiz'), ['Sion', '1950']);
  assert.deepEqual(at(), ['Sion', 'Valais / Wallis', 46.22739, 7.35559, 'Europe/Zurich']);
  // OpenPLZ abbreviates, GeoNames spells out.
  assert.deepEqual(choose('66386', 'St. Ingbert | 66386 · Saarpfalz-Kreis, Saarland'), ['St. Ingbert', 'Sankt Ingbert']);
  assert.deepEqual(at(), ['St. Ingbert', 'Saarland', 49.27697, 7.11672, 'Europe/Berlin']);
  // "Mühldorf am Inn" answers "Mühldorf", a town whose municipality is "Mühldorf a. Inn".
  assert.deepEqual(choose('84453', 'Mühldorf a. Inn | 84453 · Bayern'), ['Mühldorf a. Inn', 'Mühldorf am Inn']);
  assert.deepEqual(at(), ['Mühldorf a. Inn', 'Bayern', 48.2467, 12.52155, 'Europe/Berlin']);
  // Among the recorded answers for "Mühldorf": the town in that district, not the airfield there, the
  // villages elsewhere in Bavaria or the one in Hesse.
  assert.deepEqual(choose('84453', 'Mühldorf a. Inn | 84453 · Bayern', x => x.respond({ json: new URL(x.url).searchParams.get('name') === 'Mühldorf am Inn' ? FX.geocoding['Mühldorf|DE'] : { generationtime_ms: 0.1 } })),
    ['Mühldorf a. Inn', 'Mühldorf am Inn']);
  assert.deepEqual(at().slice(2, 4), [48.2467, 12.52155]);
  // Without that town nothing fits: the same name in another state, the airfield in the district (not a
  // town), villages in other districts.
  const others = FX.geocoding['Mühldorf|DE'].results.filter(r => r.feature_code !== 'PPLA3').map(r => r.admin1 === 'Hessen' ? Object.assign({}, r, { name: 'Mühldorf am Inn' }) : r);
  const kb = h.keyboard();
  kb.type('84453'); h.serve();
  kb.pick(0);
  const asked = [];
  for (let x = h.pending()[0]; x; x = h.pending()[0]) { asked.push(new URL(x.url).searchParams.get('name')); x.respond({ json: { results: others } }); }
  assert.deepEqual(asked, ['Mühldorf a. Inn', 'Mühldorf am Inn', '84453']);
  assert.equal(kb.t.kb.message, 'Für diesen Ort wurden keine Koordinaten gefunden.');
  // The postal-code lookup takes only a place that lists the code, not just any town in the district.
  const town = FX.geocoding['Mühldorf|DE'].results.filter(r => r.feature_code === 'PPLA3');
  kb.clear(); kb.type('84453'); h.serve();
  kb.pick(0);
  for (let x = h.pending()[0]; x; x = h.pending()[0]) x.respond({ json: new URL(x.url).searchParams.get('name') === '84453' ? { results: town } : { generationtime_ms: 0.1 } });
  assert.equal(kb.t.kb.message, 'Für diesen Ort wurden keine Koordinaten gefunden.');
});

test('the same name outweighs a listed postal code, and other countries never count (synthetic answers)', () => {
  const h = harness();
  // 54636 Hamm: a neighbouring village in the same district that lists the code does not replace Hamm.
  const k1 = h.keyboard();
  k1.type('54636'); h.serve();
  k1.pick(k1.names().indexOf('Hamm'));
  const near = { id: 1, name: 'Hammerhof', latitude: 50.1, longitude: 6.5, feature_code: 'PPL', country_code: 'DE', timezone: 'Europe/Berlin', population: 900, postcodes: ['54636'],
    country: 'Deutschland', admin1: 'Rheinland-Pfalz', admin3: 'Eifelkreis Bitburg-Prüm', admin4: 'Hammerhof' };
  h.last().respond({ json: { results: [near].concat(FX.geocoding['Hamm|DE'].results.slice(0, 99)) } });
  assert.deepEqual([h.state().place.lat, h.state().place.lon], [50.01667, 6.41667]);
  h.serve();
  // 9490 Vaduz has no state to compare: a larger Vaduz outside Liechtenstein is still refused.
  const k2 = h.keyboard();
  k2.type('9490'); h.pending().forEach(x => h.serve(x));
  k2.pick(0);
  const vaduz = (country, lat, population) => ({ id: lat, name: 'Vaduz', latitude: lat, longitude: 9.52, feature_code: 'PPLC', country_code: country, timezone: 'Europe/Vaduz', population, admin1: 'Vaduz' });
  assert.equal(h.last().url, GEO + '?name=Vaduz&count=100&language=de&format=json&countryCode=LI');
  h.last().respond({ json: { results: [vaduz('AT', 47.5, 90000), vaduz('LI', 47.14151, 5197)] } });
  assert.deepEqual([h.state().place.name, h.state().place.lat], ['Vaduz', 47.14151]);
});

test('a Swiss canton matches any of its language parts or its abbreviation, also for places without postal codes', () => {
  // The recorded 3011 answers, with the postal codes removed from GeoNames and the canton varied.
  const bern = { results: FX.geocoding['Bern|CH'].results.map(r => { const c = Object.assign({}, r); delete c.postcodes; return c; }) };
  const row = FX.openplz['ch/3011'][0];
  const pick = canton => {
    const h = harness(), kb = h.keyboard();
    kb.type('3011');
    h.pending().forEach(x => x.respond({ json: x.url.startsWith(PLZ + 'ch/') ? [Object.assign({}, row, { canton })] : [] }));
    kb.pick(0);
    for (let x = h.pending()[0]; x && x.url.startsWith(GEO); x = h.pending()[0]) x.respond({ json: bern });
    const p = h.state().place;
    return p ? [p.lat, p.lon] : kb.t.kb.message;
  };
  for (const canton of [row.canton, { name: 'Bern / Berne' }, { name: 'Berne', shortName: 'BE' }]) assert.deepEqual(pick(canton), [46.94809, 7.44744], JSON.stringify(canton));
  assert.equal(pick({ name: 'Vaud', shortName: 'VD' }), 'Für diesen Ort wurden keine Koordinaten gefunden.', 'another canton: no Bern');
});

test('postal-code edge cases: too short, unknown, no coordinates, failed save', () => {
  const h = harness({ weather: withPlace(cached(T0)) });
  const kb = h.keyboard();
  const before = h.xhrs.length;
  kb.type('123');
  assert.equal(h.xhrs.length, before, 'three digits ask nobody');
  assert.equal(kb.t.kb.message, 'Postleitzahlen haben 4 (AT, CH, LI) oder 5 Ziffern (DE).');
  kb.clear(); kb.type('99999'); h.serve();
  assert.equal(kb.t.kb.status, 'none');
  assert.equal(kb.t.kb.message, 'Kein Ort mit dieser Postleitzahl.');
  kb.clear(); kb.type('53111'); h.serve();
  kb.pick(0);
  const asked = [];
  for (let x = h.pending()[0]; x; x = h.pending()[0]) { asked.push(new URL(x.url).searchParams.get('name')); x.respond({ json: { generationtime_ms: 0.1 } }); }
  assert.deepEqual(asked, ['Bonn', '53111'], 'the name (municipality "Bonn, Stadt" is the same), then the postal code');
  assert.equal(kb.t.kb.message, 'Für diesen Ort wurden keine Koordinaten gefunden.');
  assert.equal(h.state().place.lat, BONN.lat, 'the previous place stays');
  h.store.quota = true;
  kb.clear(); kb.type('frankfurt'); h.serve();
  kb.pick(0);
  assert.equal(kb.t.kb.message, 'Der Ort konnte nicht gespeichert werden.');
  assert.deepEqual(h.closed, []);
  kb.clear(); kb.type('bonn');
  h.last().fail();
  assert.equal(kb.t.kb.message, 'Keine Verbindung zur Ortssuche.');
});

test('the forecast request is one plain GET with the stored time zone', () => {
  const h = harness({ weather: withPlace(null) });
  h.render();
  const x = h.last();
  assert.equal(x.url, FORECAST_URL);
  assert.deepEqual({ method: x.method, async: x.async, headers: x.headers, credentials: x.withCredentials, timeout: x.timeout }, { method: 'GET', async: true, headers: {}, credentials: false, timeout: 15000 });
  h.render(); h.render();
  assert.equal(h.xhrs.length, 1, 'one request at a time');
  const g = harness({ weather: { place: Object.assign({}, BONN, { timezone: '' }), show: SHOW, forecast: null } });
  g.render();
  assert.match(g.last().url, /&timezone=auto&forecast_days=2$/);
});

test('today is the date at the place\'s UTC offset: across midnight, DST and negative offsets', () => {
  const W = harness({ installed: false }).window.CleanTVWeather;
  const days = [{ date: '2026-11-01', max: 10, min: 8 }, { date: '2026-11-02', max: 9, min: 5 }];
  const day = (at, offset) => (W.today(days, at, offset) || {}).date || null;
  assert.equal(day(Date.UTC(2026, 10, 1, 22, 59), 3600), '2026-11-01');
  assert.equal(day(Date.UTC(2026, 10, 1, 23, 0), 3600), '2026-11-02', 'midnight in Bonn, not index 0');
  assert.equal(day(Date.UTC(2026, 10, 1, 23, 0), 0), '2026-11-01');
  assert.equal(day(Date.UTC(2026, 10, 2, 3, 0), -18000), '2026-11-01', 'New York is still on Sunday');
  assert.equal(day(Date.UTC(2026, 10, 2, 23, 0), 3600), null, 'a date outside the forecast gives no high and low');
  const spring = [{ date: '2026-03-28', max: 1, min: 0 }, { date: '2026-03-29', max: 2, min: 0 }];
  assert.equal(W.today(spring, Date.UTC(2026, 2, 28, 22, 30), 7200).date, '2026-03-29', 'summer time (UTC+2): 00:30');
  assert.equal(W.today(spring, Date.UTC(2026, 2, 28, 22, 30), 3600).date, '2026-03-28', 'winter time (UTC+1): 23:30');
  // Offline across midnight: the cached second day takes over.
  const evening = Date.UTC(2026, 10, 1, 22, 50);
  const h = harness({ now: evening + MIN, weather: withPlace(cached(evening, { days })) });
  assert.equal(h.render().range, '↑ 10° · ↓ 8°');
  h.advance(10 * MIN);
  h.pending().forEach(x => x.fail());
  assert.equal(h.render().range, '↑ 9° · ↓ 5°');
  h.advance(25 * 60 * MIN);
  h.pending().forEach(x => x.fail());
  assert.equal(h.render().range, '↑ – · ↓ –');
});

test('WMO codes, measured rain and night map to combinable layers', () => {
  const W = harness({ installed: false }).window.CleanTVWeather;
  const L = f => { const l = W.layers(Object.assign({ cloud: 50, precip: 0, day: 1, windy: false }, f)); return [l.sky, l.cloud && 'cloud', l.precip, l.bolt && 'bolt', l.wind && 'wind'].filter(Boolean).join('+'); };
  assert.equal(L({ code: 0 }), 'sun');
  assert.equal(L({ code: 1, day: 0 }), 'moon');
  assert.equal(L({ code: 2 }), 'sun+cloud');
  assert.equal(L({ code: 2, day: 0 }), 'moon+cloud');
  assert.equal(L({ code: 3 }), 'cloud');
  assert.equal(L({ code: 45 }), 'cloud+fog');
  assert.equal(L({ code: 48 }), 'cloud+fog');
  assert.equal(L({ code: 61, cloud: 40 }), 'sun+cloud+rain');
  assert.equal(L({ code: 61, cloud: 90 }), 'cloud+rain');
  assert.equal(L({ code: 61, cloud: null }), 'cloud+rain', 'without cloud cover no sun');
  assert.equal(L({ code: 56, cloud: 95 }), 'cloud+rain', 'freezing drizzle is rain');
  assert.equal(L({ code: 67, cloud: 95 }), 'cloud+rain', 'freezing rain is rain');
  assert.equal(L({ code: 71, cloud: 95 }), 'cloud+snow');
  assert.equal(L({ code: 77, cloud: 30 }), 'sun+cloud+snow');
  assert.equal(L({ code: 85, cloud: 60 }), 'sun+cloud+snow');
  assert.equal(L({ code: 86, cloud: 85 }), 'cloud+snow');
  assert.equal(L({ code: 80, cloud: 70 }), 'sun+cloud+rain');
  assert.equal(L({ code: 82, cloud: 85 }), 'cloud+rain');
  assert.equal(L({ code: 95, cloud: 85 }), 'cloud+rain+bolt');
  assert.equal(L({ code: 99, cloud: 50, day: 0 }), 'moon+cloud+rain+bolt');
  assert.equal(L({ code: 1, precip: 0.1 }), 'sun+cloud+rain', 'rain from 0.1 mm even when the code lags');
  assert.equal(L({ code: 1, precip: 0.09 }), 'sun');
  assert.equal(L({ code: 3, precip: 0.5 }), 'cloud+rain');
  assert.equal(L({ code: 45, precip: 0.2 }), 'cloud+rain', 'rain replaces fog');
  assert.equal(L({ code: 73, cloud: 95, precip: 1.2 }), 'cloud+snow', 'snow stays snow');
  assert.equal(L({ code: 3, windy: true }), 'cloud+wind');
  assert.equal(L({ code: 0, windy: true }), 'sun+wind');
  assert.equal(L({ code: 42, cloud: 10 }), 'sun', 'an unknown code falls back to cloud cover');
  assert.equal(L({ code: 42, cloud: 60 }), 'sun+cloud');
  // The markup: a moon at night, the knock-out mask behind a cloud, snow and fog in their own blocks.
  const P = f => W.pictogram(W.layers(Object.assign({ cloud: 50, precip: 0, day: 1, windy: false }, f)));
  assert.match(P({ code: 0, day: 0 }), /^<g transform="translate\(0 0\)"><g><path class="wx-glass" d="M24\.78 31\.46A7\.5/);
  assert.doesNotMatch(P({ code: 0, day: 0 }), /circle/);
  assert.match(P({ code: 0 }), /<circle class="wx-glass" cx="24" cy="24" r="6.5"\/>/);
  assert.match(P({ code: 2 }), /<g mask="url\(#cleantvWxKnock\)"><circle class="wx-glass" cx="33" cy="15"/);
  assert.doesNotMatch(P({ code: 0 }), /mask=/);
  assert.match(P({ code: 71, cloud: 95 }), /v6\.4M/);
  assert.match(P({ code: 45 }), /h20M/);
  assert.match(P({ code: 95, cloud: 95 }), /l-4 7h5\.5l-3\.5 7/);
  assert.match(P({ code: 3, windy: true }), /h9a2 2 0 1 0-2-2/);
  assert.match(P({ code: 2 }), /^<g transform="translate\(-1\.75 9\)">/, 'sun and cloud are centred in the 48 grid');
  assert.match(P({ code: 61, cloud: 90 }), /^<g transform="translate\(1\.45 2\.6\)">/);
});

test('wind shows from 30 km/h or gusts of 50 km/h and hides below 25 and 42 km/h', () => {
  const W = harness({ installed: false }).window.CleanTVWeather;
  assert.equal(W.windy(29.9, 49.9, false), false);
  assert.equal(W.windy(30, 0, false), true);
  assert.equal(W.windy(0, 50, false), true);
  assert.equal(W.windy(26, 0, true), true, 'stays on between 25 and 30');
  assert.equal(W.windy(10, 45, true), true, 'stays on with gusts between 42 and 50');
  assert.equal(W.windy(24.9, 41.9, true), false);
  const h = harness({ weather: withPlace(null) });
  const steps = [[31, 40, true], [27, 30, true], [24, 44, true], [24, 41, false], [28, 45, false], [12, 50, true]];
  for (const [wind, gusts, expected] of steps) {
    h.render();
    h.serve(h.last(), { wind_speed_10m: wind, wind_gusts_10m: gusts });
    assert.equal(h.state().forecast.windy, expected, wind + '/' + gusts);
    assert.equal(/h9a2 2 0 1 0-2-2/.test(h.render().icon), expected);
    h.advance(16 * MIN);
  }
  assert.equal(h.render().wind, '12 km/h');
});

test('refresh: every 15 minutes plus jitter while Home is visible, at once on return when older than 10 minutes', () => {
  // Fresh data at startup: no request; the next one 15 minutes and 30 s (jitter at random 0.5 of a minute) after the last.
  let h = harness({ weather: withPlace(cached(T0 - 2 * MIN)) });
  h.render();
  assert.equal(h.xhrs.length, 0);
  h.advance(13 * MIN + 29999);
  assert.equal(h.xhrs.length, 0);
  h.advance(1);
  assert.equal(h.xhrs.length, 1, 'due at 15 min 30 s after the last fetch');
  h.serve();
  for (let i = 0; i < 15; i++) { h.advance(MIN); h.render(); }
  assert.equal(h.xhrs.length, 1, 'visible Home renders do not refresh early');
  h.advance(30 * 1000);
  assert.equal(h.xhrs.length, 2);
  h.serve();
  // Startup with data older than 10 minutes: at once.
  h = harness({ weather: withPlace(cached(T0 - 11 * MIN)) });
  h.render();
  assert.equal(h.xhrs.length, 1);
  // Hidden: nothing; back after more than 10 minutes: at once.
  h = harness({ weather: withPlace(cached(T0)) });
  h.render();
  h.hide(true);
  h.advance(40 * MIN);
  assert.equal(h.xhrs.length, 0, 'nothing while the app is hidden');
  h.hide(false);
  assert.equal(h.xhrs.length, 1, 'refreshed on return');
  h.serve();
  // A full-screen panel (All apps, the keyboard) hides Home as well.
  h.stage.className += ' is-sheet';
  h.advance(20 * MIN);
  assert.equal(h.xhrs.length, 1, 'nothing behind a full-screen panel');
  h.stage.className = 'stage bg-photo l-dock';
  h.render();
  assert.equal(h.xhrs.length, 2, 'the first Home render after it refreshes');
  h.serve();
  // Back within 10 minutes: the regular schedule.
  h.hide(true); h.advance(8 * MIN); h.hide(false); h.render();
  assert.equal(h.xhrs.length, 2);
  h.advance(7 * MIN + 29999);
  assert.equal(h.xhrs.length, 2);
  h.advance(1);
  assert.equal(h.xhrs.length, 3);
});

test('failures retry after 1, 2, 5, 10 and 15 minutes, then every 15; success and online reset it', () => {
  const h = harness({ weather: withPlace(null) });
  h.render();
  const times = [];
  const fail = ['http', 'offline', 'timeout', 'http', 'offline', 'offline', 'http'];
  for (const kind of fail) {
    const x = h.pending()[0];
    assert.ok(x, 'a retry is pending after ' + times.length + ' failures');
    times.push((x.at - T0) / MIN);
    if (kind === 'http') x.respond({ status: 503, text: '{"error":true,"reason":"busy"}' }); else x.fail(kind === 'timeout' ? 'timeout' : 'error');
    for (let i = 0; i < 1800 && !h.pending().length; i++) h.advance(1000);
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.deepEqual(gaps, [1, 2, 5, 10, 15, 15]);
  h.pending()[0].respond({ status: 503, text: '' });
  assert.equal(h.settings.sections('de')[0].reason, 'Der Wetterdienst meldet einen Fehler (HTTP 503).');
  assert.equal(h.render().temp, '–', 'no data yet, no error in the widget');
  h.fire('online');
  assert.equal(h.pending().length, 1, 'the online event retries at once');
  h.serve();
  assert.equal(h.state().failures, 0);
  assert.match(h.settings.sections('de')[0].reason, /^Stand \d\d:\d\d · Aktualisierung alle 15 Minuten$/);
  assert.equal(h.state().due - h.state().forecast.at, 15 * MIN + 30000);
});

test('responses are checked: error flag, shape, size and address', () => {
  const bad = [
    { json: { error: true, reason: 'Invalid' } },
    { json: { utc_offset_seconds: 3600, current: { temperature_2m: 'warm', weather_code: 3 }, daily: { time: [] } } },
    { json: { utc_offset_seconds: 3600.5, current: { temperature_2m: 1, weather_code: 3 }, daily: { time: [] } } },
    { json: { utc_offset_seconds: 3600, current: { temperature_2m: 1, weather_code: 300 }, daily: { time: [] } } },
    { text: '{"current":' },
    { text: JSON.stringify(forecastBody({})) + ' '.repeat(17000) },
    { json: forecastBody({}), url: 'https://api.open-meteo.com/v1/elsewhere' }
  ];
  for (const response of bad) {
    const h = harness({ weather: withPlace(cached(T0 - 20 * MIN)) });
    h.render();
    h.last().respond(response);
    assert.equal(h.state().failures, 1, JSON.stringify(response).slice(0, 80));
    assert.equal(h.state().forecast.at, T0 - 20 * MIN, 'the cached forecast stays');
  }
});

test('offline: older than 45 minutes shows the time of the data, older than 3 hours dashes in the same slots', () => {
  const h = harness({ weather: withPlace(cached(T0)) });
  const offline = () => h.pending().forEach(x => x.fail());
  let w = h.render();
  assert.deepEqual([w.name, w.temp, w.range, w.wind, w.note], ['Bonn', '8°', '↑ 10° · ↓ 8°', '5 km/h', 'Wetter: Open-Meteo.com']);
  assert.match(w.icon, /^<svg size="96"><g transform/);
  h.advance(44 * MIN); offline();
  assert.equal(h.render().note, 'Wetter: Open-Meteo.com');
  h.advance(2 * MIN); offline();
  const time = new Date(T0), hhmm = String(time.getHours()).padStart(2, '0') + ':' + String(time.getMinutes()).padStart(2, '0');
  assert.equal(h.render().note, 'Stand ' + hhmm + ' · Open-Meteo.com');
  assert.equal(h.render({ language: 'en' }).note, 'As of ' + hhmm + ' · Open-Meteo.com');
  h.advance(135 * MIN); offline();
  w = h.render();
  assert.deepEqual([w.name, w.temp, w.range, w.wind, w.icon, w.off.length], ['Bonn', '–', '↑ 10° · ↓ 8°', '– km/h', '', 0]);
  assert.equal(w.note, 'Stand ' + hhmm + ' · Open-Meteo.com');
});

test('display toggles keep their slots, all off hides the card, and choices are stored', () => {
  const h = harness({ weather: withPlace(cached(T0)) });
  const sections = plain(h.settings.sections('de'));
  assert.equal(h.settings.title('de'), 'Wetter');
  assert.deepEqual(sections.map(s => s.id), ['weather-place', 'weather-show']);
  assert.deepEqual(plain(sections[0].items[0]), { action: 'cleantv.weather.place', label: 'Bonn', description: '53111 · Nordrhein-Westfalen', hint: 'Ort suchen' });
  assert.deepEqual(sections[1].items.map(i => i.label + ':' + i.applied), ['Ortsname:true', 'Aktuelle Temperatur:true', 'Höchst- und Tiefstwert:true', 'Wind:true', 'Wettersymbol:true']);
  assert.equal(sections[1].reason, 'Wetter: Open-Meteo.com (CC BY 4.0) · Orte: GeoNames (CC BY 4.0), OpenPLZ (ODbL)');
  assert.equal(h.settings.ok({ action: 'cleantv.weather.place' }), true);
  assert.deepEqual(h.opened, ['cleantv.weather.keyboard']);
  const keys = ['name', 'temp', 'range', 'wind', 'icon'];
  const full = h.render();
  for (let mask = 1; mask < 32; mask++) {
    const off = keys.filter((k, i) => mask & (1 << i)), current = h.state().show;
    keys.forEach(k => { if (current[k] === off.includes(k)) h.settings.ok({ action: 'cleantv.weather.show.' + k }); });
    const w = h.render();
    if (off.length === 5) { assert.equal(w, null, 'nothing to show'); continue; }
    assert.deepEqual(w.off, off, 'mask ' + mask);
    assert.deepEqual([w.name, w.temp, w.range, w.wind, w.icon], [full.name, full.temp, full.range, full.wind, full.icon], 'switched-off slots keep their content and place');
  }
  assert.deepEqual(h.state().show, { name: false, temp: false, range: false, wind: false, icon: false });
  h.settings.ok({ action: 'cleantv.weather.show.wind' });
  assert.deepEqual(harness({ local: h.store }).state().show, { name: false, temp: false, range: false, wind: true, icon: false }, 'stored');
  h.store.quota = true;
  h.settings.ok({ action: 'cleantv.weather.show.temp' });
  assert.equal(h.state().show.temp, false, 'a failed write keeps the previous choice');
  assert.equal(h.settings.sections('de')[0].reason, 'Die Wettereinstellungen konnten nicht gespeichert werden.');
  assert.equal(h.render({ layout: 'list' }).list, true, 'List mirrors the widget');
});

test('disabling or removing the package stops requests and hides the widget', () => {
  const h = harness({ weather: withPlace(cached(T0 - 30 * MIN)) });
  h.render();
  const x = h.last();
  h.host({ action: 'toggle', id: 'cleantv-weather' }); h.advance(0);
  assert.equal(x.aborted, true, 'the running request is cancelled');
  assert.equal(h.render(), null);
  h.advance(5 * 60 * MIN); h.render();
  assert.equal(h.xhrs.length, 1);
  h.host({ action: 'toggle', id: 'cleantv-weather' }); h.advance(0);
  assert.equal(h.xhrs.length, 2, 'enabled again: stale data refresh at once');
  h.serve();
  h.host({ action: 'remove', id: 'cleantv-weather' }); h.advance(0);
  h.advance(5 * 60 * MIN); h.render();
  assert.equal(h.xhrs.length, 2);
  assert.equal(h.state().place.name, 'Bonn', 'the place is kept for a later installation');
});
