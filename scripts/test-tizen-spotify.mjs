// Test the Samsung Spotify adapter with a synthetic XHR, crypto, clock, Image, canvas and localStorage.
// No TV, no network, no real Spotify account: every token, code and secret below is synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8');
const SOURCES = { sha: read('sha256.js'), store: read('tizen-store.js'), qr: read('vendor/qrcode.js'), spotify: read('tizen-spotify.js'), host: read('tizen-addons.js') };
const RELAY = 'https://cleantv-spotify.tobiaspsi96.workers.dev', TOKEN = 'https://accounts.spotify.com/api/token', PLAYER = 'https://api.spotify.com/v1/me/player';
const POLL = PLAYER + '?additional_types=episode', CLIENT_ID = '6058b47c8aab44dd87826487377bdf6c', PREFIX = 'cleantv.spotify.v1';
const UPSTREAM = '{"api":1,"id":"spotify","name":"Spotify","version":"1.0.0","kind":"spotify","description":"Spotify playback and account controls","author":"CleanFrame","license":"MIT"}\n';
const PACKAGE = JSON.parse(UPSTREAM);
// RFC 7636 Appendix B: these 32 octets give this verifier and challenge.
const RFC_OCTETS = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121];
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ID = '0123456789abcdef0123456789abcdef', COVER = 'ab67616d00001e02' + 'c'.repeat(24);
const MESSAGES = {
  relay: 'Could not reach cleantv-spotify.tobiaspsi96.workers.dev (no connection, certificate or access policy).',
  accounts: 'Could not reach accounts.spotify.com (no connection, certificate or access policy).',
  api: 'Could not reach api.spotify.com (no connection, certificate or access policy).',
  images: 'Could not reach i.scdn.co (no connection, certificate or access policy).'
};
const hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const plain = value => JSON.parse(JSON.stringify(value));
const BYTE_STATE = new Array(16).fill(1), BYTE_SECRET = new Array(32).fill(2);
const TV_STATE = b64url(BYTE_STATE), SECRET = b64url(BYTE_SECRET);

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map, quota: false,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (this.quota) { const e = new Error('Quota exceeded'); e.name = 'QuotaExceededError'; throw e; } map.set(key, String(value)); },
    removeItem(key) { map.delete(key); }
  };
}
function record(data, seq = 1) { const json = JSON.stringify(data); return JSON.stringify({ v: 1, seq, sum: hex(json), data: json }); }
/* localStorage with the Spotify package installed (and enabled unless said otherwise), optionally a stored sign-in. */
function seeded({ enabled = true, refreshToken } = {}) {
  const seed = { 'cleantv.addons.v1.a': record({ installed: { spotify: { ...PACKAGE, enabled } }, catalog: [], catalogInfo: { checked: false, total: 0, compatible: 0 } }) };
  if (refreshToken) seed[PREFIX + '.a'] = record({ refreshToken });
  return storage(seed);
}
/* The current Spotify record: the slot with the highest seq, as CleanTVStore reads it. */
function stored(local) { const out = []; for (const k of ['.a', '.b']) { const t = local.getItem(PREFIX + k); if (t) out.push(JSON.parse(t)); } return out.sort((a, b) => b.seq - a.seq).map(r => JSON.parse(r.data))[0] || null; }

function harness({ local = storage(), tizen = true, platform, random = [], hidden = false } = {}) {
  let now = 1_800_000_000_000, seq = 0, timers = [];
  const xhrs = [], events = [], logs = [], images = [], qrData = [], listeners = {}, docListeners = {}, canvas = { rects: 0 };
  const h = { xhrs, events, logs, images, qrData, canvas, local, auto: null };
  class FakeXHR {
    constructor() { this.headers = {}; this.status = 0; this.responseText = ''; this.responseURL = ''; this.at = now; this.storeAtSend = null; xhrs.push(this); }
    open(method, url, async) { Object.assign(this, { method, url, async }); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader(name) { const key = Object.keys(this.responseHeaders || {}).find(k => k.toLowerCase() === name.toLowerCase()); return key ? this.responseHeaders[key] : null; }
    send(body) {
      this.body = body; this.sent = true; this.storeAtSend = stored(local);
      if (h.auto) window.setTimeout(() => { if (!this.done && !this.aborted) h.auto(this); }, 0);
    }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    respond({ status = 200, body = '', headers = {}, url } = {}) {
      assert.ok(!this.done && !this.aborted, 'responding to a finished request: ' + this.url);
      this.done = true; this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.responseHeaders = headers; this.responseURL = url === undefined ? this.url : url;
      if (this.responseType === 'arraybuffer') { const b = Buffer.from(this.responseText, 'utf8'); this.response = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      if (this.onload) this.onload();
    }
    fail() { this.done = true; if (this.onerror) this.onerror(); }
    expire() { this.done = true; if (this.ontimeout) this.ontimeout(); }
  }
  class FakeEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  class FakeImage { set src(value) { this._src = value; images.push(this); } get src() { return this._src; } load() { this.onload(); } error() { this.onerror(); } }
  const queue = random.map(bytes => Uint8Array.from(bytes));
  let counter = 0;
  const document = {
    hidden,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return { width: 0, height: 0, getContext: () => ({ fillRect: () => { canvas.rects++; } }), toDataURL: type => (canvas.type = type, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB') };
    }
  };
  const window = {
    FrameDevice: platform ? { platform } : { launchApp() {}, capabilities: { art: false, home: true, settings: true } },
    XMLHttpRequest: FakeXHR, CustomEvent: FakeEvent, Image: FakeImage, Uint8Array, TextDecoder, Intl, localStorage: local, document,
    crypto: { getRandomValues(bytes) { const next = queue.shift(); if (next) bytes.set(next.subarray(0, bytes.length)); else for (let i = 0; i < bytes.length; i++) bytes[i] = (counter++ * 37 + 11) & 255; return bytes; } },
    Date: { now: () => now },
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout(id) { timers = timers.filter(t => t.id !== id); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(event) { events.push({ type: event.type, detail: plain(event.detail) }); (listeners[event.type] || []).forEach(fn => fn(event)); }
  };
  if (tizen) window.tizen = { application: {} };
  const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) => logs.push(args)]));
  const context = vm.createContext({ window, console });
  vm.runInContext(SOURCES.sha, context); vm.runInContext(SOURCES.store, context);
  vm.runInContext(SOURCES.qr, context);
  // Spy on the QR text, keep the real encoder.
  const real = vm.runInContext('qrcode', context);
  window.qrcode = (type, level) => { const q = real(type, level), add = q.addData; q.addData = (data, mode) => { qrData.push(data); return add(data, mode); }; return q; };
  vm.runInContext(SOURCES.spotify, context);
  vm.runInContext(SOURCES.host, context);
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift(); now = Math.max(now, t.at); t.fn();
    }
    now = end;
  }
  return Object.assign(h, {
    window, spotify: window.FrameDevice.spotify, addons: window.FrameDevice.addons, advance, flush: () => advance(0), now: () => now,
    state: () => plain(window.FrameDevice.spotify.state()), link: () => plain(window.FrameDevice.spotify.link('state')),
    last: () => xhrs[xhrs.length - 1], to: url => xhrs.filter(x => x.url === url || x.url.split('?')[0] === url), open: () => xhrs.filter(x => x.sent && !x.done && !x.aborted),
    hide() { document.hidden = true; (docListeners.visibilitychange || []).forEach(fn => fn()); },
    spotifyEvents: () => events.filter(e => e.type === 'cleanframe:spotify').map(e => e.detail),
    timers: () => timers.slice()
  });
}
const TOKENS = (n = 1, extra = {}) => ({ access_token: 'access-' + n, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-' + n, scope: 'user-read-playback-state user-modify-playback-state', ...extra });
const form = xhr => Object.fromEntries(new URLSearchParams(xhr.body));
/* GET /me/player while something plays on device dev-1. */
function playing(patch = {}, item = {}) {
  return {
    device: { id: 'dev-1', is_active: true, is_restricted: false, name: 'Kitchen speaker', type: 'Speaker' },
    progress_ms: 10000, is_playing: true, currently_playing_type: 'track', actions: { disallows: {} },
    item: { type: 'track', name: 'QA Track', duration_ms: 200000, artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
      album: { images: [{ url: 'https://i.scdn.co/image/ab67616d0000b273' + 'c'.repeat(24), width: 640, height: 640 }, { url: 'https://i.scdn.co/image/' + COVER, width: 300, height: 300 }, { url: 'https://i.scdn.co/image/ab67616d00004851' + 'c'.repeat(24), width: 64, height: 64 }] }, ...item },
    ...patch
  };
}
/* Full QR sign-in with RFC 7636 randomness; returns the harness with the TV linked. */
function signIn(h, tokens = TOKENS()) {
  h.spotify.link('begin');
  const pair = h.last();
  pair.respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000);
  const tvState = JSON.parse(pair.body).state;
  h.last().respond({ body: { code: 'code-1', state: ID + '.' + tvState } });
  h.last().respond({ body: tokens });
  h.flush();
  return h;
}
const linked = (options = {}) => harness({ local: seeded({ refreshToken: 'refresh-0' }), ...options });
/* Linked TV that answers every request: token refreshes with access-N, the player with `player(xhr)`. */
function serving(player, options) {
  const h = linked(options);
  let n = 0;
  h.auto = xhr => {
    if (xhr.url === TOKEN) xhr.respond({ body: TOKENS(++n, { refresh_token: undefined }) });
    else xhr.respond(player(xhr));
  };
  return h;
}
const gets = h => h.xhrs.filter(x => x.url === POLL);
const gaps = list => list.slice(1).map((x, i) => x.at - list[i].at);

test('outside Tizen and on Android the adapter stays away', () => {
  for (const h of [harness({ tizen: false }), harness({ platform: 'android' })]) {
    assert.equal(h.window.FrameDevice.spotify, undefined);
    assert.equal((h.window.FrameDevice.capabilities || {}).spotify, undefined);
  }
});

test('the spotify kind accepts the upstream package exactly and refuses other IDs', () => {
  const h = harness(), CATALOG = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/cleantv-catalog.json';
  const entry = { ...PACKAGE, path: 'packages/spotify/1.0.0.json', sha256: hex(UPSTREAM) };
  assert.equal(entry.sha256, 'fea1dd06487e7a0674ae477d616395d7d9bcc6c63b80bfe1a19cabc632124a3e', 'the committed upstream bytes');
  assert.equal(h.window.CleanTVAddonKinds.registered('spotify'), true);
  assert.equal(h.window.FrameDevice.capabilities.spotify, true);
  h.addons({ action: 'refresh' }); h.last().respond({ body: JSON.stringify({ api: 2, addons: [entry] }) }); h.flush();
  assert.equal(h.addons({ action: 'state' }).catalog[0].id, 'spotify');
  h.addons({ action: 'install', id: 'spotify' });
  assert.equal(h.last().url, 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/packages/spotify/1.0.0.json');
  h.last().respond({ body: UPSTREAM }); h.flush();
  const state = h.addons({ action: 'state' });
  assert.equal(state.error, '');
  assert.deepEqual(plain(state.installed.spotify), { ...PACKAGE, enabled: true });
  assert.equal(h.window.CleanTVAddons.enabled('spotify'), true);
  h.addons({ action: 'refresh' }); h.last().respond({ body: JSON.stringify({ api: 2, addons: [{ ...entry, id: 'other-spotify', path: 'packages/other-spotify/1.0.0.json' }] }) }); h.flush();
  assert.equal(h.addons({ action: 'state' }).error, 'Unsupported widget kind.');
  assert.equal(h.xhrs.filter(x => x.url.indexOf('https://raw.githubusercontent.com/') !== 0).length, 0, 'installing contacts no Spotify host');
  assert.equal(CATALOG, h.xhrs[0].url);
});

test('no network without the installed and enabled package', () => {
  for (const local of [storage(), seeded({ enabled: false, refreshToken: 'refresh-0' })]) {
    const h = harness({ local });
    h.spotify.observe(true); h.advance(600000);
    h.spotify.link('begin'); h.flush();
    let error = null; h.spotify.control('toggle', e => { error = e; });
    h.advance(600000);
    assert.equal(h.xhrs.length, 0, 'no request at all');
    assert.equal(h.link().phase, 'failed');
    assert.equal(h.link().message, 'Enable the Spotify add-on first.');
    assert.equal(error.message, 'Sign in with QR to enable controls.');
  }
  // Enabling the package lets main.js observe; disabling it again stops polling and aborts requests.
  const h = harness({ local: seeded({ enabled: false, refreshToken: 'refresh-0' }) });
  h.addons({ action: 'toggle', id: 'spotify' }); h.flush();
  h.spotify.observe(true); h.flush();
  assert.equal(h.last().url, TOKEN, 'now the stored sign-in is used');
  h.last().respond({ body: TOKENS(1) });
  assert.equal(h.last().url, POLL);
  const inflight = h.last();
  h.addons({ action: 'toggle', id: 'spotify' }); h.flush();
  assert.equal(inflight.aborted, true, 'the running request is aborted');
  const count = h.xhrs.length;
  h.advance(3600000);
  assert.equal(h.xhrs.length, count, 'nothing after the package was disabled');
});

test('PKCE (RFC 7636 Appendix B), pairing, QR and the 2 s relay poll', () => {
  const h = linked({ random: [RFC_OCTETS, BYTE_STATE, BYTE_SECRET] });
  h.spotify.link('begin');
  assert.equal(h.link().phase, 'preparing');
  const pair = h.last();
  assert.deepEqual({ method: pair.method, url: pair.url, async: pair.async, headers: pair.headers, credentials: pair.withCredentials },
    { method: 'POST', url: RELAY + '/pair', async: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, credentials: false });
  assert.deepEqual(JSON.parse(pair.body), { challenge: RFC_CHALLENGE, state: TV_STATE, pollHash: hex(SECRET) });
  assert.ok(!pair.body.includes(RFC_VERIFIER) && !pair.body.includes(SECRET), 'neither verifier nor secret leaves the TV');
  pair.respond({ body: { id: ID, expiresIn: 600 } });
  const link = h.link();
  assert.deepEqual({ ...link, qr: undefined }, { phase: 'pending', qr: undefined, code: '012345', expiresAt: h.now() + 600000 });
  assert.match(link.qr, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.deepEqual(h.qrData, [RELAY + '/start/' + ID]);
  assert.ok(h.canvas.rects > 200 && h.canvas.type === 'image/png', 'modules drawn on a canvas');
  h.advance(1999);
  assert.equal(h.xhrs.length, 1, 'no poll before 2 s');
  h.advance(1);
  let poll = h.last();
  assert.deepEqual({ method: poll.method, url: poll.url, body: JSON.parse(poll.body), headers: poll.headers }, { method: 'POST', url: RELAY + '/poll/' + ID, body: { secret: SECRET }, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
  poll.respond({ body: { pending: true } });
  h.advance(1000); assert.equal(h.xhrs.length, 2, 'one request at a time, 2 s apart');
  h.advance(1000); poll = h.last();
  assert.equal(poll.url, RELAY + '/poll/' + ID);
  poll.respond({ body: { code: 'code-1', state: ID + '.' + TV_STATE } });
  const exchange = h.last();
  assert.equal(exchange.url, TOKEN);
  assert.deepEqual(exchange.headers, { 'Content-Type': 'application/x-www-form-urlencoded' }, 'no Authorization header');
  assert.deepEqual(form(exchange), { grant_type: 'authorization_code', code: 'code-1', redirect_uri: RELAY + '/callback', client_id: CLIENT_ID, code_verifier: RFC_VERIFIER });
  assert.ok(!/client_secret/.test(exchange.body));
  exchange.respond({ body: TOKENS(1) }); h.flush();
  assert.equal(h.link().phase, 'connected');
  assert.deepEqual(stored(h.local), { refreshToken: 'refresh-1' });
  const s = h.state();
  assert.equal(s.webLinked, true); assert.equal(s.webApi, 'linked'); assert.equal(s.errorMessage, '');
  h.advance(60000);
  assert.equal(h.xhrs.length, 4, 'the relay is not polled after the exchange; nothing polls the player until observed');
});

test('a state mismatch fails and never redeems the code', () => {
  for (const state of [ID + '.' + 'x'.repeat(22), 'f'.repeat(32) + '.' + TV_STATE, TV_STATE, undefined]) {
    const h = linked({ random: [RFC_OCTETS, BYTE_STATE, BYTE_SECRET] });
    h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
    h.advance(2000); h.last().respond({ body: { code: 'code-1', state } });
    assert.equal(h.link().phase, 'failed', String(state));
    assert.equal(h.link().message, 'Sign-in could not be verified. Please try again.');
    assert.equal(h.to(TOKEN).length, 0);
    h.advance(60000);
    assert.equal(h.xhrs.length, 2, 'the session ended');
  }
});

test('relay outcomes: cancel on the phone, expiry, 404, Back and leaving the app', () => {
  let h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000); h.last().respond({ body: { error: 'access_denied' } });
  assert.equal(h.link().phase, 'cancelled');

  h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 5 } });
  h.auto = xhr => xhr.respond({ body: { pending: true } });
  h.advance(10000);
  assert.equal(h.link().phase, 'expired');
  assert.equal(h.xhrs.length, 3, 'polls at 2 s and 4 s, none after the expiry');

  h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000); h.last().respond({ status: 404, body: { error: 'not_found' } });
  assert.equal(h.link().phase, 'expired');

  h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000);
  const inflight = h.last();
  h.spotify.link('cancel');
  assert.equal(inflight.aborted, true, 'Back aborts the running poll');
  assert.equal(h.link().phase, 'idle');
  h.advance(60000); assert.equal(h.xhrs.length, 2);

  h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.hide();
  assert.equal(h.link().phase, 'cancelled');
  h.advance(60000); assert.equal(h.xhrs.length, 1, 'leaving the app ends the session');
});

test('every network failure names its host; timeouts too', () => {
  let h = linked();
  h.spotify.link('begin'); h.last().fail();
  assert.deepEqual(h.link(), { phase: 'unreachable', message: MESSAGES.relay });
  h.spotify.link('begin'); h.last().expire();
  assert.deepEqual(h.link(), { phase: 'unreachable', message: 'cleantv-spotify.tobiaspsi96.workers.dev did not respond in time.' });
  // A relay poll failure is shown but polling continues until expiry.
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000); h.last().fail(); h.flush();
  assert.equal(h.link().phase, 'pending'); assert.equal(h.link().message, MESSAGES.relay);
  h.advance(2000); h.last().respond({ body: { pending: true } });
  assert.equal(h.link().message, undefined, 'recovered');
  h.advance(2000); h.last().respond({ body: { code: 'c', state: h.xhrs.filter(x => x.url === RELAY + '/pair').slice(-1).map(x => ID + '.' + JSON.parse(x.body).state)[0] } });
  h.last().fail();
  assert.deepEqual(h.link(), { phase: 'unreachable', message: MESSAGES.accounts });

  h = linked();
  h.spotify.observe(true); h.flush();
  h.last().fail(); h.flush();
  assert.equal(h.state().errorMessage, MESSAGES.accounts, 'token refresh');
  h.advance(10000); h.last().respond({ body: TOKENS(1) }); h.last().fail(); h.flush();
  assert.equal(h.state().errorMessage, MESSAGES.api, 'player');
  h.advance(20000); h.last().expire(); h.flush();
  assert.equal(h.state().errorMessage, 'api.spotify.com did not respond in time.');
  h.advance(40000); h.last().respond({ body: playing() }); h.flush();
  assert.equal(h.state().errorMessage, '', 'cleared on success');
  assert.equal(h.images.length, 1); h.images[0].error(); h.flush();
  assert.equal(h.state().errorMessage, MESSAGES.images, 'cover');
  assert.equal(h.state().art, '');
});

test('token exchange, refresh with rotation saved before use, and 401 handling', () => {
  const h = linked();
  assert.equal(h.state().webLinked, true, 'a stored sign-in survives a restart');
  h.spotify.observe(true); h.flush();
  let refresh = h.last();
  assert.equal(refresh.url, TOKEN);
  assert.deepEqual(form(refresh), { grant_type: 'refresh_token', refresh_token: 'refresh-0', client_id: CLIENT_ID });
  assert.deepEqual(refresh.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
  refresh.respond({ body: TOKENS(1, { refresh_token: 'refresh-rotated' }) });
  const get = h.last();
  assert.equal(get.url, POLL);
  assert.deepEqual(get.headers, { Authorization: 'Bearer access-1' });
  assert.deepEqual(get.storeAtSend, { refreshToken: 'refresh-rotated' }, 'the rotated token was stored before the access token was used');
  get.respond({ body: playing({ is_playing: false }) }); h.flush();
  assert.equal(h.state().webApi, 'connected');
  // Within the hour no refresh; within the last minute before expiry the next poll refreshes first.
  h.auto = xhr => xhr.url === TOKEN ? xhr.respond({ body: TOKENS(2, { refresh_token: undefined }) }) : xhr.respond({ body: playing({ is_playing: false }) });
  h.advance(3600000 - 60000 - 15000 - 1);
  assert.equal(h.to(TOKEN).length, 1);
  h.advance(30000);
  assert.equal(h.to(TOKEN).length, 2, 'refreshed shortly before expiry');
  assert.deepEqual(form(h.to(TOKEN)[1]).refresh_token, 'refresh-rotated');
  assert.equal(gets(h).slice(-1)[0].headers.Authorization, 'Bearer access-2');
  assert.deepEqual(stored(h.local), { refreshToken: 'refresh-rotated' }, 'kept when Spotify sends no new refresh token');
  // A 401 refreshes once and retries; a second 401 asks to sign in again and stops polling.
  h.auto = null;
  h.advance(15000);
  h.last().respond({ status: 401, body: { error: { status: 401, message: 'The access token expired' } } });
  refresh = h.last(); assert.equal(refresh.url, TOKEN, 'forced refresh');
  refresh.respond({ body: TOKENS(3, { refresh_token: undefined }) });
  assert.equal(h.last().url, POLL); assert.equal(h.last().headers.Authorization, 'Bearer access-3');
  h.last().respond({ status: 401, body: '' }); h.flush();
  const s = h.state();
  assert.deepEqual([s.webApi, s.webLinked, s.errorMessage, s.status], ['reauth', false, 'Sign in to Spotify again.', 'idle']);
  const count = h.xhrs.length;
  h.advance(600000); assert.equal(h.xhrs.length, count, 'no polling after reauth');
});

test('invalid_grant forgets the sign-in; a new QR sign-in links again', () => {
  const h = linked();
  h.spotify.observe(true); h.flush();
  h.last().respond({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } }); h.flush();
  assert.equal(h.local.getItem(PREFIX + '.a'), null, 'the dead refresh token is removed');
  assert.deepEqual([h.state().webApi, h.state().webLinked], ['reauth', false]);
  h.advance(600000); assert.equal(h.xhrs.length, 1);
  signIn(h, TOKENS(5));
  assert.deepEqual(stored(h.local), { refreshToken: 'refresh-5' });
  h.flush();
  assert.equal(h.last().url, POLL, 'observing resumes at once');
  assert.equal(h.last().headers.Authorization, 'Bearer access-5');
  assert.equal(h.state().webApi, 'linked');
});

test('a sign-in that cannot be stored or lacks a scope fails cleanly', () => {
  let h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000); h.last().respond({ body: { code: 'c', state: ID + '.' + JSON.parse(h.xhrs[0].body).state } });
  h.last().respond({ body: TOKENS(1, { scope: 'user-read-playback-state' }) });
  assert.deepEqual(h.link(), { phase: 'failed', message: 'Spotify did not grant the required permissions.' });
  assert.deepEqual(stored(h.local), { refreshToken: 'refresh-0' }, 'the previous sign-in is untouched');
  h = linked();
  h.local.quota = true;
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000); h.last().respond({ body: { code: 'c', state: ID + '.' + JSON.parse(h.xhrs[0].body).state } });
  h.last().respond({ body: TOKENS(1) });
  assert.deepEqual(h.link(), { phase: 'failed', message: 'Could not save the Spotify sign-in.' });
  h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000); h.last().respond({ body: { code: 'c', state: ID + '.' + JSON.parse(h.xhrs[0].body).state } });
  h.last().respond({ status: 400, body: { error: 'invalid_grant' } });
  assert.deepEqual(h.link(), { phase: 'failed', message: 'Spotify refused the sign-in. Please try again.' });
  h = linked();
  h.spotify.link('begin'); h.last().respond({ body: { id: 'not-an-id', expiresIn: 600 } });
  assert.deepEqual(h.link(), { phase: 'failed', message: 'The sign-in service answered unexpectedly. Please try again.' });
});

test('polling cadence: 5 s playing, track end + 750 ms, 15 s paused, 30 s idle then 60 s', () => {
  let h = serving(() => ({ body: playing() }));
  h.spotify.observe(true); h.advance(30000);
  assert.deepEqual(gaps(gets(h)).slice(0, 5), [5000, 5000, 5000, 5000, 5000]);
  h = serving(() => ({ body: playing({ progress_ms: 197000 }) }));
  h.spotify.observe(true); h.advance(10000);
  assert.equal(gaps(gets(h))[0], 3750, 'the poll lands 750 ms after the track ends');
  h = serving(() => ({ body: playing({ is_playing: false }) }));
  h.spotify.observe(true); h.advance(60000);
  assert.deepEqual(gaps(gets(h)), [15000, 15000, 15000, 15000]);
  h = serving(() => ({ status: 204 }));
  h.spotify.observe(true); h.advance(600000);
  const idle = gaps(gets(h));
  assert.deepEqual(idle.slice(0, 10), new Array(10).fill(30000));
  assert.ok(idle.slice(11).every(g => g === 60000) && idle.length > 12, 'slower after five minutes: ' + idle.join());
  assert.equal(h.state().status, 'idle', '204 means nothing is playing');
  // Not observing (Home hidden, a sheet open, the app in the background) means no polls.
  h.spotify.observe(false);
  const count = h.xhrs.length;
  h.advance(600000);
  assert.equal(h.xhrs.length, count);
  h.spotify.observe(true); h.flush();
  assert.equal(h.xhrs.length, count + 1, 'one poll at once on return');
  h.hide(); h.advance(600000);
  assert.equal(h.xhrs.length, count + 1, 'a hidden document stops polling');
});

test('backoff: 5xx and network errors 10 s to 60 s, 429 Retry-After or 30 s to 5 min', () => {
  let h = serving(() => ({ status: 503 }));
  h.spotify.observe(true); h.advance(400000);
  assert.deepEqual(gaps(gets(h)).slice(0, 6), [10000, 20000, 40000, 60000, 60000, 60000]);
  assert.equal(h.state().webApi, 'unavailable');
  h = linked();
  let fail = true;
  h.auto = xhr => xhr.url === TOKEN ? xhr.respond({ body: TOKENS(1, { refresh_token: undefined }) }) : fail ? xhr.fail() : xhr.respond({ body: playing() });
  h.spotify.observe(true); h.advance(75000);
  assert.deepEqual(gaps(gets(h)), [10000, 20000, 40000]);
  fail = false; h.advance(60000);
  assert.deepEqual(gaps(gets(h)).slice(3, 5), [60000, 5000], 'a success resets the backoff');
  h = serving(() => ({ status: 429, headers: { 'Retry-After': '7' } }));
  h.spotify.observe(true); h.advance(30000);
  assert.deepEqual(gaps(gets(h)).slice(0, 3), [7000, 7000, 7000], 'a readable Retry-After is respected');
  assert.deepEqual([h.state().webApi, h.state().errorMessage], ['rate_limited', 'Spotify is busy. Try again later.']);
  h = serving(() => ({ status: 429 }));
  h.spotify.observe(true); h.advance(2000000);
  assert.deepEqual(gaps(gets(h)).slice(0, 6), [30000, 60000, 120000, 240000, 300000, 300000], 'no readable header: doubling to five minutes');
  // Returning to Home does not skip a running backoff.
  h.spotify.observe(false); const count = h.xhrs.length; h.spotify.observe(true); h.flush();
  assert.equal(h.xhrs.length, count);
});

test('controls use device_id; 204, 403 PREMIUM_REQUIRED, 404 and 429 Retry-After', () => {
  const h = linked();
  h.spotify.observe(true); h.flush();
  h.last().respond({ body: TOKENS(1, { refresh_token: undefined }) });
  h.last().respond({ body: playing() }); h.flush();
  assert.deepEqual(h.state().actions, { previous: true, toggle: true, next: true });
  let result = 'pending';
  h.spotify.control('toggle', e => { result = e; });
  const pause = h.last();
  assert.deepEqual({ method: pause.method, url: pause.url, body: pause.body, auth: pause.headers.Authorization }, { method: 'PUT', url: PLAYER + '/pause?device_id=dev-1', body: null, auth: 'Bearer access-1' });
  pause.respond({ status: 204 }); h.flush();
  assert.equal(result, null);
  assert.equal(h.state().status, 'paused', 'the button follows at once');
  h.advance(749); assert.equal(h.last(), pause);
  h.advance(1); assert.equal(h.last().url, POLL, 'a poll 750 ms after a control');
  h.last().respond({ body: playing({ is_playing: false }) }); h.flush();
  h.spotify.control('toggle'); assert.deepEqual([h.last().method, h.last().url], ['PUT', PLAYER + '/play?device_id=dev-1']); h.last().respond({ status: 202 });
  h.flush(); h.advance(750); h.last().respond({ body: playing() }); h.flush();
  h.spotify.control('next'); assert.deepEqual([h.last().method, h.last().url], ['POST', PLAYER + '/next?device_id=dev-1']); h.last().respond({ status: 204 });
  h.flush(); h.advance(750); h.last().respond({ body: playing() }); h.flush();
  h.spotify.control('previous'); assert.deepEqual([h.last().method, h.last().url], ['POST', PLAYER + '/previous?device_id=dev-1']);
  h.last().respond({ status: 404, body: { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } } });
  h.flush();
  assert.equal(h.state().errorMessage, 'Spotify no longer has an active device.');
  h.advance(750); h.last().respond({ body: playing() }); h.flush();
  h.spotify.control('next', e => { result = e; });
  h.last().respond({ status: 429, headers: { 'Retry-After': '9' } }); h.flush();
  assert.equal(result.message, 'Spotify is busy. Try again later.');
  h.advance(8999); assert.notEqual(h.last().url, POLL);
  h.advance(1); assert.equal(h.last().url, POLL, 'the next poll waits for Retry-After');
  h.last().respond({ body: playing() }); h.flush();
  h.spotify.control('toggle', e => { result = e; });
  h.last().respond({ status: 403, body: { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } } }); h.flush();
  assert.equal(result.message, 'Spotify Premium is required for playback controls.');
  assert.deepEqual(h.state().actions, { previous: false, toggle: false, next: false }, 'controls are disabled for the session');
  assert.equal(h.state().errorMessage, 'Spotify Premium is required for playback controls.');
  const count = h.xhrs.length;
  h.spotify.control('next', e => { result = e; });
  assert.equal(h.xhrs.length, count, 'no further control requests');
  assert.equal(result.message, 'Spotify Premium is required for playback controls.');
  h.advance(750); h.last().respond({ body: playing({}, { name: 'Another track' }) }); h.flush();
  assert.equal(h.state().errorMessage, 'Spotify Premium is required for playback controls.', 'the Premium notice stays');
  // A restricted device and disallowed actions disable buttons without a request.
  h.advance(5000); h.last().respond({ body: playing({ device: { id: 'dev-2', is_restricted: true, name: 'TV' } }) }); h.flush();
  const before = h.xhrs.length;
  h.spotify.control('toggle', e => { result = e; });
  assert.equal(h.xhrs.length, before);
});

test('mapping: titles, artists, episodes, disallows and the 300 px cover from i.scdn.co after it loaded', () => {
  const h = linked();
  h.spotify.observe(true); h.flush();
  h.last().respond({ body: TOKENS(1, { refresh_token: undefined }) });
  h.last().respond({ body: playing({ actions: { disallows: { skipping_prev: true, pausing: true } } }) }); h.flush();
  let s = h.state();
  assert.deepEqual({ status: s.status, title: s.title, artist: s.artist, duration: s.duration, position: s.position, deviceName: s.deviceName, actions: s.actions, art: s.art, permission: s.permission, connection: s.connection, artColor: s.artColor },
    { status: 'playing', title: 'QA Track', artist: 'Artist A, Artist B', duration: 200000, position: 10000, deviceName: 'Kitchen speaker', actions: { previous: false, toggle: false, next: true }, art: '', permission: true, connection: 'connected', artColor: '' });
  assert.deepEqual(h.images.map(i => i.src), ['https://i.scdn.co/image/' + COVER], 'the 300 px image is preloaded');
  h.images[0].load(); h.flush();
  assert.equal(h.state().art, 'https://i.scdn.co/image/' + COVER);
  h.advance(5000);
  h.last().respond({ body: playing({}, { type: 'episode', name: 'QA Episode', artists: undefined, album: undefined, show: { publisher: 'QA Publisher', name: 'Show' },
    images: [{ url: 'https://image-cdn-ak.spotifycdn.com/image/' + 'd'.repeat(40), width: 300, height: 300 }] }) }); h.flush();
  s = h.state();
  assert.deepEqual([s.title, s.artist], ['QA Episode', 'QA Publisher']);
  assert.equal(h.images[1].src, 'https://i.scdn.co/image/' + 'd'.repeat(40), 'other Spotify CDN hosts are rewritten to i.scdn.co');
  h.advance(5000);
  h.last().respond({ body: playing({}, { album: { images: [{ url: 'https://evil.example/image/' + 'e'.repeat(40) }, { url: 'https://i.scdn.co/image/short' }] } }) }); h.flush();
  assert.equal(h.images.length, 2, 'foreign or malformed cover URLs are never loaded');
  assert.equal(h.state().art, '');
  h.advance(5000);
  h.last().respond({ body: { device: { id: 'dev-1' }, is_playing: false, item: null, currently_playing_type: 'ad' } }); h.flush();
  assert.equal(h.state().status, 'idle', 'no item hides the card');
});

test('events are sent only on change, asynchronously, with no secret in any event, state, link or log', () => {
  const h = linked({ random: [RFC_OCTETS, BYTE_STATE, BYTE_SECRET] });
  h.spotify.link('begin'); h.last().respond({ body: { id: ID, expiresIn: 600 } });
  h.advance(2000); h.last().respond({ body: { code: 'code-secret-1', state: ID + '.' + TV_STATE } });
  h.last().respond({ body: TOKENS(7) }); h.flush();
  const seen = [], quiet = h.events.length;
  h.spotify.observe(true);
  assert.equal(h.events.length, quiet, 'observe dispatches nothing synchronously');
  const before = h.spotifyEvents().length;
  h.flush(); h.last().respond({ body: playing() });
  assert.equal(h.spotifyEvents().length, before, 'not inside the response handler');
  h.flush();
  assert.equal(h.spotifyEvents().length, before + 1);
  for (let i = 0; i < 4; i++) { h.advance(5000); h.last().respond({ body: playing({ progress_ms: 10000 + (i + 1) * 5000 }) }); h.flush(); }
  assert.equal(h.spotifyEvents().length, before + 1, 'steady playback sends no event; the bar extrapolates');
  h.advance(5000); h.last().respond({ body: playing({ progress_ms: 90000 }) }); h.flush();
  assert.equal(h.spotifyEvents().length, before + 2, 'a seek is sent');
  h.advance(5000); h.last().respond({ body: playing({}, { name: 'Next track' }) }); h.flush();
  assert.equal(h.spotifyEvents().length, before + 3);
  h.spotify.control('toggle'); h.last().respond({ status: 204 }); h.flush();
  h.spotify.signOut(); h.flush();
  seen.push(JSON.stringify(h.events), JSON.stringify(h.state()), JSON.stringify(h.link()), JSON.stringify(h.logs));
  const all = seen.join('\n');
  for (const secret of ['access-7', 'refresh-7', 'refresh-0', 'code-secret-1', RFC_VERIFIER, SECRET, TV_STATE]) assert.ok(!all.includes(secret), 'leaked: ' + secret.slice(0, 4));
  assert.deepEqual(h.logs, [], 'nothing is logged');
  assert.ok(h.events.every(e => e.type !== 'cleanframe:spotify-link' || JSON.stringify(Object.keys(e.detail)) === '["phase"]'));
});

test('storage holds only the refresh token; sign out clears everything; a reload stays linked', () => {
  let h = signIn(linked({ local: seeded() }), TOKENS(1));
  const keys = [...h.local.map.keys()].sort();
  assert.deepEqual(keys.filter(k => k.startsWith(PREFIX)), [PREFIX + '.a']);
  assert.equal(JSON.parse(h.local.getItem(PREFIX + '.a')).data, '{"refreshToken":"refresh-1"}');
  for (const value of h.local.map.values()) assert.ok(!value.includes('access-1') && !value.includes('code-1'), 'no access token or code in storage');
  // A reload reads the stored sign-in and refreshes with it.
  h = harness({ local: h.local });
  assert.deepEqual([h.state().webApi, h.state().webLinked], ['linked', true]);
  h.spotify.observe(true); h.flush();
  assert.equal(form(h.last()).refresh_token, 'refresh-1');
  h.last().respond({ body: TOKENS(2) });
  assert.deepEqual(stored(h.local), { refreshToken: 'refresh-2' }, 'rotation replaces the stored token');
  h.last().respond({ body: playing() }); h.flush();
  let done = 'pending';
  h.spotify.signOut(e => { done = e; }); h.flush();
  assert.equal(done, null);
  assert.deepEqual([...h.local.map.keys()].filter(k => k.startsWith(PREFIX)), [], 'both slots are removed');
  const s = h.state();
  assert.deepEqual([s.webApi, s.webLinked, s.status, s.title, s.errorMessage], ['unlinked', false, 'idle', '', '']);
  const count = h.xhrs.length;
  h.spotify.observe(true); h.advance(600000);
  assert.equal(h.xhrs.length, count, 'no request after sign-out');
  h = harness({ local: h.local });
  assert.equal(h.state().webLinked, false, 'still signed out after a reload');
});
