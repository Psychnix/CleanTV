/* Spotify on the Samsung host: the Web API with Authorization Code + PKCE, run on the TV. The relay
   only carries the one-time authorization code from the phone; the verifier never leaves the TV.
   Behaviour lives here, never in the downloaded package. Network only while the Spotify package is
   installed and enabled, and only to the fixed origins in app/config.xml. Only the refresh token is
   stored (CleanTVStore, cleantv.spotify.v1); the access token, the verifier and the relay secret stay
   in memory and never reach events, state() or logs. */
(function () {
  'use strict';
  var device = window.FrameDevice;
  if (!window.tizen || !device || device.platform === 'android') return;
  function queue(name) {
    var r = window[name];
    if (!r) { r = window[name] = { queue: [] }; r.register = function () { r.queue.push(Array.prototype.slice.call(arguments)); }; }
    return r;
  }
  // The upstream package is accepted as it is; like Android, the spotify kind needs the ID spotify.
  queue('CleanTVAddonKinds').register('spotify', { widget: false, validate: function (entry) {
    if (entry.id !== 'spotify') throw new Error('Unsupported widget kind.');
    return {};
  } });

  var SHA = window.CleanTVSha256, STORE = window.CleanTVStore;
  var CLIENT_ID = '6058b47c8aab44dd87826487377bdf6c';
  var RELAY = 'https://cleantv-spotify.tobiaspsi96.workers.dev', REDIRECT = RELAY + '/callback';
  var TOKEN = 'https://accounts.spotify.com/api/token', PLAYER = 'https://api.spotify.com/v1/me/player';
  var COVER = 'https://i.scdn.co/image/';
  var HOST = { relay: 'cleantv-spotify.tobiaspsi96.workers.dev', accounts: 'accounts.spotify.com', api: 'api.spotify.com', images: 'i.scdn.co' };
  var SCOPES = ['user-read-playback-state', 'user-modify-playback-state'], PREFIX = 'cleantv.spotify.v1';
  // Poll cadence in ms: playing, paused, nothing playing (then slower after five minutes), after a control.
  var PLAYING = 5000, PAUSED = 15000, IDLE = 30000, IDLE_LONG = 60000, IDLE_AFTER = 300000, AFTER_CONTROL = 750, TRACK_END = 750;
  // Backoff: 429 without a readable Retry-After doubles from 30 s to 5 min; 5xx and network errors from 10 s to 60 s.
  var LIMITED = 30000, LIMITED_MAX = 300000, FAILED = 10000, FAILED_MAX = 60000, DENIED = 60000, GAP = 1000;
  var PAIR_POLL = 2000, PAIR_TTL = 600, REFRESH_EARLY = 60000, TIMEOUT = 8000, SLOW = 15000, TEXT_LIMIT = 262144;
  // A held card: the vanish must come within 60 s after CleanTV became visible; 30 min of nothing playing end it.
  var HOLD_WINDOW = 60000, HOLD_MAX = 1800000;
  var FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }, PLAIN = { 'Content-Type': 'text/plain;charset=UTF-8' };
  var SECRET = /^[\x21-\x7e]{1,4096}$/, PAIR_ID = /^[a-f0-9]{32}$/;
  var IMAGE = /^https:\/\/(?:i\.scdn\.co|image-cdn-(?:ak|fa)\.spotifycdn\.com)\/image\/([a-f0-9]{40})$/;
  // English host messages; app/i18n.js holds the German text.
  var M = {
    off: 'Enable the Spotify add-on first.', crypto: 'This TV cannot create a secure sign-in code.',
    relay: 'The sign-in service answered unexpectedly. Please try again.', qr: 'The QR code could not be drawn.',
    state: 'Sign-in could not be verified. Please try again.', scope: 'Spotify did not grant the required permissions.',
    refused: 'Spotify refused the sign-in. Please try again.', save: 'Could not save the Spotify sign-in.',
    premium: 'Spotify Premium is required for playback controls.', again: 'Sign in to Spotify again.',
    denied: "Spotify denied access. Check Premium and the Developer app's users.", busy: 'Spotify is busy. Try again later.',
    device: 'No active Spotify device supports this control.', gone: 'Spotify no longer has an active device.',
    apply: 'Spotify could not apply the request. Try again later.', connect: 'Spotify could not connect. Check your network or sign in again.',
    signin: 'Sign in with QR to enable controls.', signout: 'Could not sign out. Please try again.', held: 'Continue in Spotify'
  };
  /* Status 0 is a failed request (TLS, DNS, access policy), -1 a timeout. Naming the host tells which hop broke. */
  function offline(status, host) { return status === -1 ? host + ' did not respond in time.' : 'Could not reach ' + host + ' (no connection, certificate or access policy).'; }

  function now() { return window.Date.now(); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function allowed() { var a = window.CleanTVAddons; return !!(a && typeof a.enabled === 'function' && a.enabled('spotify')); }
  function hidden() { return !!(window.document && window.document.hidden); }
  function text(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
  function number(value) { return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0; }
  function parse(body) {
    var value;
    if (typeof body !== 'string' || !body || body.length > TEXT_LIMIT) return null;
    try { value = JSON.parse(body); } catch (e) { return null; }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }
  function form(fields) { return Object.keys(fields).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(fields[key]); }).join('&'); }
  function random(length) {
    var c = window.crypto, bytes;
    if (!c || typeof c.getRandomValues !== 'function' || !window.Uint8Array) return null;
    bytes = new window.Uint8Array(length);
    try { c.getRandomValues(bytes); } catch (e) { return null; }
    return bytes;
  }
  function seconds(xhr) {
    var value = null;
    // Spotify does not expose Retry-After to CORS clients today; it is used whenever the TV can read it.
    try { value = xhr && xhr.getResponseHeader('Retry-After'); } catch (e) { value = null; }
    return typeof value === 'string' && /^\s*[0-9]{1,5}\s*$/.test(value) ? Math.min(3600, Math.max(1, +value)) : null;
  }

  /* One XHR without credentials; done(status, text, xhr). Our own abort calls nothing. */
  function send(o, done) {
    var xhr = new window.XMLHttpRequest(), over = false;
    function end(status, body) { if (!over) { over = true; done(status, body, xhr); } }
    try {
      xhr.open(o.method, o.url, true);
      xhr.timeout = o.timeout || TIMEOUT;
      xhr.withCredentials = false;
      Object.keys(o.headers || {}).forEach(function (name) { xhr.setRequestHeader(name, o.headers[name]); });
      xhr.onload = function () {
        // XHR follows redirects; only the fixed address is accepted.
        if (xhr.responseURL && xhr.responseURL !== o.url) { end(0, ''); return; }
        end(xhr.status, typeof xhr.responseText === 'string' ? xhr.responseText : '');
      };
      xhr.onerror = function () { end(0, ''); };
      xhr.ontimeout = function () { end(-1, ''); };
      xhr.onabort = function () { over = true; };
      xhr.send(o.body === undefined ? null : o.body);
    } catch (e) { window.setTimeout(function () { end(0, ''); }, 0); }
    return { abort: function () { if (!over) { over = true; try { xhr.abort(); } catch (e) { /* already finished */ } } } };
  }

  /* ---------- Stored sign-in: the refresh token only ---------- */
  var refreshToken = null, access = null, waiting = null;
  try {
    var saved = STORE.read(PREFIX);
    if (saved && typeof saved.refreshToken === 'string' && SECRET.test(saved.refreshToken)) refreshToken = saved.refreshToken;
  } catch (e) { refreshToken = null; }
  function keep(token) { try { STORE.write(PREFIX, { refreshToken: token }); return true; } catch (e) { return false; } }
  function forget() { refreshToken = null; access = null; try { STORE.clear(PREFIX); } catch (e) { /* the next sign-in replaces it */ } }

  /* ---------- Public state, published only when it changes ---------- */
  function idle() { return { status: 'idle', title: '', artist: '', duration: 0, position: 0, speed: 1, art: '', artColor: '', artLight: false, actions: { previous: false, toggle: false, next: false }, deviceName: '' }; }
  var player = idle(), webApi = refreshToken ? 'linked' : 'unlinked', problem = '', notice = '';
  // said: the notice the last failed control set, shown until saidUntil and then cleared by a healthy poll.
  var deviceId = '', blocked = false, sent = null, sentAt = 0, queued = false, said = '', saidUntil = 0;
  function snapshot() {
    var s = copy(player), linked = !!refreshToken && webApi !== 'reauth';
    // As on Android, webLinked means a sign-in is stored, so Sign out stays usable in reauth.
    s.connection = 'connected'; s.permission = true; s.webLinked = !!refreshToken;
    s.webApi = refreshToken || webApi === 'reauth' || webApi === 'signout_failed' ? webApi : 'unlinked';
    s.errorMessage = problem || notice || '';
    // A held card's one action opens the Spotify app, so Premium does not matter for it.
    if (!linked || blocked && !player.held) s.actions = { previous: false, toggle: false, next: false };
    return s;
  }
  /* The progress bar extrapolates; a pure position update is sent only when it drifts by 2 s or more. */
  function changed(next) {
    var a, b, expected;
    if (!sent) return true;
    a = copy(next); b = copy(sent); delete a.position; delete b.position;
    if (JSON.stringify(a) !== JSON.stringify(b)) return true;
    expected = sent.position + (sent.status === 'playing' ? now() - sentAt : 0);
    return Math.abs(next.position - expected) >= 2000;
  }
  // Asynchronous, so a listener that renders never runs inside main.js's own render.
  function publish() {
    if (queued) return;
    queued = true;
    window.setTimeout(function () {
      var next = snapshot();
      queued = false;
      if (!changed(next)) return;
      sent = next; sentAt = now();
      window.dispatchEvent(new window.CustomEvent('cleanframe:spotify', { detail: copy(next) }));
    }, 0);
  }

  /* ---------- Access token in memory, refreshed shortly before it expires ---------- */
  function bearer(body) {
    return !!body && typeof body.token_type === 'string' && /^bearer$/i.test(body.token_type) && typeof body.access_token === 'string' && SECRET.test(body.access_token)
      && typeof body.expires_in === 'number' && body.expires_in > 0;
  }
  /* cb(null) with a usable access token, or cb({kind, message}). One refresh at a time. */
  function token(force, cb) {
    var used = refreshToken;
    if (!force && access && now() < access.expiresAt - REFRESH_EARLY) { cb(null); return; }
    if (!used) { cb({ kind: 'reauth', message: M.again }); return; }
    if (!allowed()) { cb({ kind: 'off', message: M.off }); return; }
    if (waiting) { waiting.push(cb); return; }
    waiting = [cb];
    send({ method: 'POST', url: TOKEN, headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: used, client_id: CLIENT_ID }), timeout: SLOW }, function (status, body, xhr) {
      var data = parse(body), list = waiting, failure = null;
      waiting = null;
      // Signed out or signed in again meanwhile: this answer belongs to the old sign-in.
      if (refreshToken !== used) failure = { kind: 'stale', message: M.apply };
      else if (status <= 0) failure = { kind: 'offline', message: offline(status, HOST.accounts) };
      else if (status === 200 && bearer(data)) {
        // A rotated refresh token is saved before the new access token is used.
        if (typeof data.refresh_token === 'string' && SECRET.test(data.refresh_token) && data.refresh_token !== used) {
          refreshToken = data.refresh_token;
          if (!keep(refreshToken)) notice = M.save;
        }
        access = { token: data.access_token, expiresAt: now() + data.expires_in * 1000 };
      } else if (status === 400 && data && data.error === 'invalid_grant') { forget(); failure = { kind: 'reauth', message: M.again }; }
      else if (status === 400 || status === 401) failure = { kind: 'reauth', message: M.again };
      else if (status === 429) failure = { kind: 'busy', message: M.busy, retry: seconds(xhr) };
      else failure = { kind: 'error', message: M.connect };
      list.forEach(function (fn) { fn(failure); });
    });
  }
  /* An authorised Web API call: one forced refresh after a 401. done(failure) or done(null, status, text, xhr). */
  function api(method, url, done) {
    var handle = { live: true, xhr: null, abort: function () { handle.live = false; if (handle.xhr) handle.xhr.abort(); } };
    function attempt(retried) {
      token(retried, function (failure) {
        if (!handle.live) return;
        if (!failure && !allowed()) failure = { kind: 'off', message: M.off };
        if (failure) { handle.live = false; done(failure); return; }
        handle.xhr = send({ method: method, url: url, headers: { Authorization: 'Bearer ' + access.token } }, function (status, body, xhr) {
          handle.xhr = null;
          if (!handle.live) return;
          if (status === 401 && !retried) { access = null; attempt(true); return; }
          handle.live = false;
          done(null, status, body, xhr);
        });
      });
    }
    attempt(false);
    return handle;
  }

  /* ---------- Playback polling (only while main.js observes) ---------- */
  var observing = false, timer = 0, polling = null, failures = 0, limits = 0, idleSince = 0, holdUntil = 0, lastPoll = 0, endKey = '';
  var art = { want: '', ready: '', loading: '', failed: '' };
  // seen: the last 200 with an item {at, tv, id, playing, position}; shownAt: when CleanTV last became visible.
  var seen = null, shownAt = hidden() ? 0 : now();
  function halt() { window.clearTimeout(timer); timer = 0; if (polling) { polling.abort(); polling = null; } }
  /* Nothing playing; also ends a held card and forgets the last state. */
  function clearPlayer() { player = idle(); deviceId = ''; art.want = ''; seen = null; }
  /* Unverified: the device type the Samsung Spotify app reports for itself. Spotify names TVs "TV";
     docs/addons.md asks to confirm it on the TV. Every other type (phone, speaker, computer) is never held. */
  var THIS_TV = 'tv';
  function onThisTv(d) { return typeof d.type === 'string' && d.type.toLowerCase() === THIS_TV; }
  /* Tizen pauses the Spotify app on this TV when CleanTV comes to the front, and its Connect device
     vanishes a few seconds later. If the last state came from this TV during this visit and the vanish
     follows the return within 60 s, the card keeps that track as paused and main.js opens Spotify on OK. */
  function holdable() { return !!seen && seen.tv && seen.at >= shownAt && now() - shownAt <= HOLD_WINDOW; }
  /* A 200 without an item that names another device (an ad or a gap on a phone) is not this TV's vanish. */
  function elsewhere(body) {
    var d = body && body.device && typeof body.device === 'object' ? body.device : null;
    return !!d && (!onThisTv(d) || !!seen && !!seen.id && typeof d.id === 'string' && d.id !== seen.id);
  }
  function hold() {
    // player still holds the last mapped track; a playing one is advanced to the vanish.
    var position = seen.position + (seen.playing ? now() - seen.at : 0);
    player.status = 'paused'; player.position = player.duration ? Math.min(position, player.duration) : position;
    player.actions = { previous: false, toggle: true, next: false }; player.held = true;
  }
  function schedule(delay) {
    window.clearTimeout(timer); timer = 0;
    if (!observing || !refreshToken || webApi === 'reauth' || !allowed()) return;
    timer = window.setTimeout(tick, Math.max(0, delay));
  }
  function backoff() { var d = Math.min(FAILED * Math.pow(2, failures), FAILED_MAX); failures++; holdUntil = now() + d; return d; }
  function limited(retry) {
    var d = retry ? retry * 1000 : Math.min(LIMITED * Math.pow(2, limits), LIMITED_MAX);
    limits++; holdUntil = now() + d;
    return d;
  }
  function healthy() {
    failures = 0; limits = 0; holdUntil = 0; problem = ''; webApi = 'connected';
    // A control error stays at least 5 s, then a successful poll replaces it. Premium, save and cover notices are never in said.
    if (notice !== said) said = '';
    else if (said && now() >= saidUntil) notice = said = '';
  }
  function fail(f) {
    if (f.kind === 'reauth') { webApi = 'reauth'; problem = M.again; clearPlayer(); halt(); }
    else if (f.kind === 'off') { clearPlayer(); halt(); }
    else if (f.kind === 'stale') schedule(0);
    else if (f.kind === 'busy') { webApi = 'rate_limited'; problem = f.message; schedule(limited(f.retry)); }
    else { webApi = 'unavailable'; problem = f.message; schedule(backoff()); }
    publish();
  }
  function tick() {
    timer = 0;
    if (!observing || !refreshToken || !allowed() || hidden() || polling) return;
    lastPoll = now();
    polling = api('GET', PLAYER + '?additional_types=episode', function (failure, status, body, xhr) {
      polling = null;
      if (failure) fail(failure);
      else received(status, parse(body), xhr);
    });
  }
  function received(status, body, xhr) {
    var item = body && body.item && typeof body.item === 'object' ? body.item : null;
    if (status <= 0) { webApi = 'unavailable'; problem = offline(status, HOST.api); schedule(backoff()); }
    else if (status === 401) { fail({ kind: 'reauth', message: M.again }); return; }
    else if (status === 403) { webApi = 'unavailable'; problem = M.denied; holdUntil = now() + DENIED; schedule(DENIED); }
    else if (status === 429) { webApi = 'rate_limited'; problem = M.busy; schedule(limited(seconds(xhr))); }
    else if (status >= 500) { webApi = 'unavailable'; problem = M.busy; schedule(backoff()); }
    else if (status === 204 || status === 200 && body && !item) {
      // Nothing playing: 30 s, then 60 s after five minutes. A held card stays for 30 minutes of this.
      healthy(); deviceId = '';
      if (!idleSince) idleSince = now();
      if (elsewhere(body)) clearPlayer();
      else if (!player.held && holdable()) hold();
      else if (!player.held || now() - idleSince >= HOLD_MAX) clearPlayer();
      schedule(now() - idleSince >= IDLE_AFTER ? IDLE_LONG : IDLE);
    } else if (status === 200 && body) { healthy(); idleSince = 0; schedule(show(body, item)); }
    else { webApi = 'unavailable'; problem = M.apply; schedule(backoff()); }
    publish();
  }
  /* Maps GET /me/player and returns the next poll delay. */
  function show(body, item) {
    var d = body.device && typeof body.device === 'object' ? body.device : {}, dis = body.actions && body.actions.disallows || {};
    var playing = body.is_playing === true, episode = item.type === 'episode', progress = number(body.progress_ms), duration = number(item.duration_ms);
    var restricted, title = text(item.name, 300), podcast = item.show && typeof item.show === 'object' ? item.show : {}, remaining = duration - progress, key;
    deviceId = typeof d.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(d.id) ? d.id : '';
    restricted = d.is_restricted === true || !deviceId;
    if (title !== player.title) notice = notice === M.premium ? notice : '';
    player = {
      status: playing ? 'playing' : 'paused', title: title,
      artist: episode ? text(podcast.publisher || podcast.name, 300) : (Array.isArray(item.artists) ? item.artists : []).map(function (a) { return a && typeof a.name === 'string' ? a.name : ''; }).filter(Boolean).join(', ').slice(0, 300),
      duration: duration, position: duration ? Math.min(progress, duration) : progress, speed: 1,
      art: cover(episode ? item.images || podcast.images : item.album && item.album.images), artColor: '', artLight: false,
      actions: { previous: !restricted && !dis.skipping_prev, toggle: !restricted && !(playing ? dis.pausing : dis.resuming), next: !restricted && !dis.skipping_next },
      deviceName: text(d.name, 120)
    };
    seen = { at: now(), tv: onThisTv(d), id: deviceId, playing: playing, position: player.position };
    // While playing, poll once at the end of each track to catch the next one. A track still at its end
    // after that poll (a stalled device keeps a stale playing state) falls back to 5 s.
    if (!playing) { endKey = ''; return PAUSED; }
    if (!duration || remaining + TRACK_END >= PLAYING) { endKey = ''; return PLAYING; }
    key = typeof item.uri === 'string' && item.uri ? item.uri : title;
    if (key === endKey) return PLAYING;
    endKey = key;
    return Math.max(TRACK_END, remaining + TRACK_END);
  }
  /* The image nearest to 300 px, rewritten to i.scdn.co (the one image origin config.xml allows) and
     shown only after it loaded. No pixel analysis: the cover colour stays the host fallback. */
  function cover(images) {
    var best = null;
    (Array.isArray(images) ? images : []).forEach(function (image) {
      var m = image && typeof image.url === 'string' && IMAGE.exec(image.url), distance;
      if (!m) return;
      distance = Math.abs((number(image.width) || number(image.height) || 300) - 300);
      if (!best || distance < best.distance) best = { distance: distance, url: COVER + m[1] };
    });
    art.want = best ? best.url : '';
    if (!art.want) return '';
    if (art.want === art.ready) return art.want;
    if (art.want !== art.loading && art.want !== art.failed) preload(art.want);
    return '';
  }
  function preload(url) {
    var image;
    if (typeof window.Image !== 'function') return;
    art.loading = url; image = new window.Image();
    image.onload = function () {
      if (art.loading === url) art.loading = '';
      art.ready = url; art.failed = '';
      if (art.want === url && player.status !== 'idle') { player.art = url; if (notice === offline(0, HOST.images)) notice = ''; publish(); }
    };
    image.onerror = function () {
      if (art.loading === url) art.loading = '';
      art.failed = url;
      if (art.want === url) { player.art = ''; notice = notice || offline(0, HOST.images); publish(); }
    };
    image.src = url;
  }
  function observe(enabled, done) {
    observing = !!enabled;
    // Poll at once on return, but keep a running backoff and at most one poll per second.
    if (observing) schedule(Math.max(holdUntil, lastPoll + GAP) - now()); else halt();
    if (typeof done === 'function') done(null);
  }
  function control(command, done) {
    var finish = typeof done === 'function' ? done : function () {}, method, path;
    if (command !== 'previous' && command !== 'toggle' && command !== 'next') { finish({ message: M.device }); return; }
    if (!allowed() || !refreshToken || webApi === 'reauth') { finish({ message: M.signin }); return; }
    // The held track has no Connect device left; only the Spotify app itself can continue it.
    if (player.held) { finish({ message: M.held }); return; }
    if (blocked) { finish({ message: M.premium }); return; }
    if (!deviceId || !player.actions[command]) { finish({ message: M.device }); return; }
    method = command === 'toggle' ? 'PUT' : 'POST';
    path = command === 'toggle' ? player.status === 'playing' ? '/pause' : '/play' : '/' + command;
    halt();
    api(method, PLAYER + path + '?device_id=' + encodeURIComponent(deviceId), function (failure, status, body, xhr) {
      var data, message;
      if (failure) { fail(failure); finish({ message: failure.message }); return; }
      if (status >= 200 && status < 300) {
        notice = notice === M.premium ? notice : '';
        if (command === 'toggle') player.status = path === '/pause' ? 'paused' : 'playing';
        publish(); finish(null); schedule(AFTER_CONTROL);
        return;
      }
      data = parse(body);
      if (status <= 0) message = offline(status, HOST.api);
      else if (status === 403 && data && data.error && data.error.reason === 'PREMIUM_REQUIRED') { blocked = true; message = M.premium; }
      // A player reason (for example UNKNOWN for "Restriction violated") is not an access problem.
      else if (status === 403) message = data && data.error && typeof data.error.reason === 'string' && data.error.reason ? M.apply : M.denied;
      else if (status === 404) message = M.gone;
      else if (status === 429) message = M.busy;
      else message = M.apply;
      notice = message; said = message === M.premium ? '' : message; saidUntil = now() + PLAYING;
      publish(); finish({ message: message });
      schedule(status === 429 ? limited(seconds(xhr)) : AFTER_CONTROL);
    });
  }

  /* ---------- QR sign-in through the relay ---------- */
  var session = null, link = { phase: 'idle' };
  function setLink(next) {
    link = next;
    window.setTimeout(function () { window.dispatchEvent(new window.CustomEvent('cleanframe:spotify-link', { detail: { phase: link.phase } })); }, 0);
  }
  function close(s) { window.clearTimeout(s.timer); if (s.request) s.request.abort(); s.verifier = s.secret = s.tvState = ''; if (session === s) session = null; }
  function end(s, next) { close(s); setLink(next); }
  /* The QR code as a PNG data URI, drawn once per sign-in (vendor/qrcode.js). */
  function draw(value) {
    var make = window.qrcode, doc = window.document, qr, count, scale, size, canvas, context, r, c, uri;
    if (typeof make !== 'function' || !doc) return '';
    try {
      qr = make(0, 'M'); qr.addData(value, 'Byte'); qr.make();
      count = qr.getModuleCount(); scale = Math.max(4, Math.floor(640 / (count + 8))); size = (count + 8) * scale;
      canvas = doc.createElement('canvas'); canvas.width = size; canvas.height = size;
      context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size); context.fillStyle = '#000000';
      for (r = 0; r < count; r++) for (c = 0; c < count; c++) if (qr.isDark(r, c)) context.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
      uri = canvas.toDataURL('image/png');
    } catch (e) { return ''; }
    return typeof uri === 'string' && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(uri) ? uri : '';
  }
  function begin() {
    var verifier, tvState, secret, s;
    if (session) close(session);
    if (!allowed()) { setLink({ phase: 'failed', message: M.off }); return; }
    verifier = random(32); tvState = random(16); secret = random(32);
    if (!verifier || !tvState || !secret || !SHA) { setLink({ phase: 'failed', message: M.crypto }); return; }
    s = session = { verifier: SHA.base64url(verifier), tvState: SHA.base64url(tvState), secret: SHA.base64url(secret), timer: 0, request: null };
    setLink({ phase: 'preparing' });
    s.request = send({ method: 'POST', url: RELAY + '/pair', headers: PLAIN, timeout: SLOW,
      body: JSON.stringify({ challenge: SHA.base64url(SHA.raw(SHA.utf8(s.verifier))), state: s.tvState, pollHash: SHA.text(s.secret) }) }, function (status, body) {
      var data = parse(body), qr;
      if (session !== s) return;
      s.request = null;
      if (status <= 0) { end(s, { phase: 'unreachable', message: offline(status, HOST.relay) }); return; }
      if (status !== 200 || !data || typeof data.id !== 'string' || !PAIR_ID.test(data.id) || typeof data.expiresIn !== 'number' || !(data.expiresIn > 0)) { end(s, { phase: 'failed', message: M.relay }); return; }
      s.id = data.id; s.expiresAt = now() + Math.min(data.expiresIn, PAIR_TTL) * 1000;
      qr = draw(RELAY + '/start/' + s.id);
      if (!qr) { end(s, { phase: 'failed', message: M.qr }); return; }
      setLink({ phase: 'pending', qr: qr, code: s.id.slice(0, 6).toUpperCase(), expiresAt: s.expiresAt });
      s.timer = window.setTimeout(function () { wait(s); }, PAIR_POLL);
    });
  }
  /* Every 2 s while the QR screen is open, one request at a time, until expiry. */
  function wait(s) {
    var again = function (message) {
      if ((link.message || '') !== message) { link = copy(link); if (message) link.message = message; else delete link.message; setLink(link); }
      s.timer = window.setTimeout(function () { wait(s); }, PAIR_POLL);
    };
    if (session !== s) return;
    if (now() >= s.expiresAt) { end(s, { phase: 'expired' }); return; }
    if (!allowed()) { end(s, { phase: 'cancelled' }); return; }
    s.request = send({ method: 'POST', url: RELAY + '/poll/' + s.id, headers: PLAIN, body: JSON.stringify({ secret: s.secret }) }, function (status, body) {
      var data = parse(body);
      if (session !== s) return;
      s.request = null;
      if (status <= 0) again(offline(status, HOST.relay));
      else if (status === 404) end(s, { phase: 'expired' });
      else if (status >= 500 || status === 429) again(M.relay);
      else if (status !== 200 || !data) end(s, { phase: 'failed', message: M.relay });
      else if (data.pending === true) again('');
      else if (typeof data.error === 'string') end(s, { phase: 'cancelled' });
      else if (typeof data.code !== 'string' || !data.code || data.state !== s.id + '.' + s.tvState) end(s, { phase: 'failed', message: M.state });
      else if (!allowed()) end(s, { phase: 'cancelled' });
      else exchange(s, data.code);
    });
  }
  function granted(data) {
    var scopes = data && typeof data.scope === 'string' ? data.scope.split(' ') : [];
    return SCOPES.every(function (scope) { return scopes.indexOf(scope) >= 0; });
  }
  /* The code is redeemed here, with the verifier that never left the TV. No client secret exists. */
  function exchange(s, code) {
    s.request = send({ method: 'POST', url: TOKEN, headers: FORM, timeout: SLOW,
      body: form({ grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: s.verifier }) }, function (status, body) {
      var data = parse(body);
      if (session !== s) return;
      s.request = null;
      if (status <= 0) { end(s, { phase: 'unreachable', message: offline(status, HOST.accounts) }); return; }
      if (status !== 200 || !bearer(data) || typeof data.refresh_token !== 'string' || !SECRET.test(data.refresh_token)) { end(s, { phase: 'failed', message: M.refused }); return; }
      if (!granted(data)) { end(s, { phase: 'failed', message: M.scope }); return; }
      if (!keep(data.refresh_token)) { end(s, { phase: 'failed', message: M.save }); return; }
      refreshToken = data.refresh_token; access = { token: data.access_token, expiresAt: now() + data.expires_in * 1000 };
      webApi = 'linked'; problem = ''; notice = ''; blocked = false; failures = 0; limits = 0; holdUntil = 0;
      // A new sign-in may be another account: its playback starts from nothing, without the old hold.
      clearPlayer(); idleSince = 0;
      end(s, { phase: 'connected' });
      publish();
      schedule(0);
    });
  }
  function cancel() { if (session) close(session); setLink({ phase: 'idle' }); }

  function signOut(done) {
    var finish = typeof done === 'function' ? done : function () {};
    if (session) end(session, { phase: 'idle' });
    halt();
    try { STORE.clear(PREFIX); } catch (e) { webApi = 'signout_failed'; publish(); finish({ message: M.signout }); return; }
    refreshToken = null; access = null; blocked = false; problem = ''; notice = '';
    clearPlayer(); webApi = 'unlinked'; failures = 0; limits = 0; holdUntil = 0; idleSince = 0;
    publish(); finish(null);
  }

  // Removing or disabling the package stops all Spotify traffic at once; credentials stay, as on Android.
  window.addEventListener('cleanframe:addons', function () {
    if (allowed()) return;
    if (session) end(session, { phase: 'cancelled' });
    halt(); clearPlayer(); publish();
  });
  if (window.document && typeof window.document.addEventListener === 'function') window.document.addEventListener('visibilitychange', function () {
    if (!hidden()) { shownAt = now(); return; }
    // Leaving the app or standby cancels sign-in, as on Android; main.js also stops observing.
    if (session) end(session, { phase: 'cancelled' });
    halt();
    // A hold belongs to one visit: meanwhile the Spotify app may resume, elsewhere too.
    if (player.held) { clearPlayer(); publish(); } else seen = null;
  });

  device.capabilities = device.capabilities || {};
  device.capabilities.spotify = true;
  device.spotify = {
    state: snapshot,
    observe: observe,
    control: control,
    // Android's media-access screen has no Samsung equivalent; main.js hides that row here.
    access: function (done) { if (typeof done === 'function') done(null); },
    link: function (operation) {
      if (operation === 'state') return copy(link);
      if (operation === 'begin') { begin(); return { ok: true }; }
      if (operation === 'cancel') { cancel(); return { ok: true }; }
      throw new Error('Unknown Spotify sign-in action.');
    },
    signOut: signOut
  };
}());
