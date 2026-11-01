// Tests the Spotify pairing relay with an in-memory Durable Object namespace and env. No network,
// no Cloudflare account. Codes, states and secrets here are synthetic.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import worker, { SpotifyPairing, same } from './worker.js';

const ORIGIN = 'https://cleantv-spotify.tobiaspsi96.workers.dev';
const CLIENT_ID = '6058b47c8aab44dd87826487377bdf6c';
const REDIRECT = ORIGIN + '/callback';
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const hex = text => createHash('sha256').update(text, 'utf8').digest('hex');

/* In-memory storage with the Durable Object storage calls the worker uses. */
class Storage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(key) { return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined; }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async deleteAll() { this.map.clear(); }
  async setAlarm(at) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
  async getAlarm() { return this.alarm; }
}
function environment(vars = {}) {
  const objects = new Map();
  const namespace = {
    idFromName: name => ({ name }),
    get(id) {
      if (!objects.has(id.name)) { const storage = new Storage(); objects.set(id.name, { storage, object: new SpotifyPairing({ storage }) }); }
      const { object } = objects.get(id.name);
      return { fetch: (input, init) => object.fetch(new Request(input, init)) };
    }
  };
  return { env: { CLIENT_ID, REDIRECT_URI: REDIRECT, PAIRINGS: namespace, ...vars }, objects };
}
/* A synthetic clock: Date.now() is replaced for the duration of each test. */
function clock(t) {
  const real = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = real; });
  return { advance: ms => { now += ms; }, get now() { return now; } };
}
function call(env, path, { method = 'GET', body, type = 'text/plain;charset=UTF-8', headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); if (type) init.headers['Content-Type'] = type; }
  return worker.fetch(new Request(ORIGIN + path, init), env);
}
function tvSide() {
  const verifier = b64url(randomBytes(32)), secret = b64url(randomBytes(32)), state = b64url(randomBytes(16));
  return { verifier, secret, state, challenge: createHash('sha256').update(verifier).digest('base64url'), pollHash: hex(secret) };
}
async function pair(env, tv = tvSide()) {
  const response = await call(env, '/pair', { method: 'POST', body: { challenge: tv.challenge, state: tv.state, pollHash: tv.pollHash } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.match(body.id, /^[a-f0-9]{32}$/);
  assert.equal(body.expiresIn, 600);
  return { ...tv, id: body.id };
}
const poll = (env, id, secret) => call(env, '/poll/' + id, { method: 'POST', body: { secret } });

test('the whole flow: pair, start, callback, then one poll delivers the code once', async t => {
  clock(t);
  const { env, objects } = environment();
  const tv = await pair(env);
  assert.equal(objects.get(tv.id).storage.alarm, Date.now() + 600000, 'an alarm deletes the pairing after ten minutes');
  const stored = await objects.get(tv.id).storage.get('pairing');
  assert.deepEqual(Object.keys(stored).sort(), ['challenge', 'expiresAt', 'pollHash', 'result', 'state'], 'no secret or verifier reaches the relay');
  assert.notEqual(stored.pollHash, tv.secret);

  let response = await poll(env, tv.id, tv.secret);
  assert.deepEqual(await response.json(), { pending: true }, 'pending before the callback');

  response = await call(env, '/start/' + tv.id);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const target = new URL(response.headers.get('location'));
  assert.equal(target.origin + target.pathname, 'https://accounts.spotify.com/authorize');
  assert.deepEqual(Object.fromEntries(target.searchParams), {
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge_method: 'S256',
    code_challenge: tv.challenge, scope: 'user-read-playback-state user-modify-playback-state', state: tv.id + '.' + tv.state
  });

  const code = 'AQ' + b64url(randomBytes(120));
  response = await call(env, '/callback?code=' + code + '&state=' + tv.id + '.' + tv.state);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Verbunden – du kannst zum Fernseher zurückkehren\./);
  assert.ok(!html.includes(code) && !html.includes(tv.state), 'the page never repeats the code or state');

  response = await poll(env, tv.id, tv.secret);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code, state: tv.id + '.' + tv.state });
  assert.equal(objects.get(tv.id).storage.map.size, 0, 'the record is deleted after delivery');
  assert.equal(objects.get(tv.id).storage.alarm, null);

  response = await poll(env, tv.id, tv.secret);
  assert.equal(response.status, 404, 'a second poll finds nothing');
  response = await call(env, '/start/' + tv.id);
  assert.equal(response.status, 404, 'the start link is spent');
});

test('the callback stores once; a second callback cannot replace the code', async t => {
  clock(t);
  const { env } = environment();
  const tv = await pair(env);
  const first = await call(env, '/callback?code=first-code&state=' + tv.id + '.' + tv.state);
  assert.equal(first.status, 200);
  const second = await call(env, '/callback?code=other-code&state=' + tv.id + '.' + tv.state);
  assert.equal(second.status, 409);
  assert.match(await second.text(), /bereits verwendet/);
  assert.equal((await call(env, '/start/' + tv.id)).status, 409, 'start after the callback says the link was used');
  assert.deepEqual(await (await poll(env, tv.id, tv.secret)).json(), { code: 'first-code', state: tv.id + '.' + tv.state });
});

test('a wrong secret gets 403 and leaves the code for the right one', async t => {
  clock(t);
  const { env } = environment();
  const tv = await pair(env);
  await call(env, '/callback?code=the-code&state=' + tv.id + '.' + tv.state);
  for (const secret of [tvSide().secret, tv.pollHash.slice(0, 43), tv.secret.slice(0, 42) + (tv.secret[42] === 'A' ? 'B' : 'A')]) {
    const response = await poll(env, tv.id, secret);
    assert.equal(response.status, 403, secret === tv.pollHash.slice(0, 43) ? 'the hash itself is not the secret' : 'wrong secret');
    assert.deepEqual(await response.json(), { error: 'forbidden' });
  }
  assert.deepEqual(await (await poll(env, tv.id, tv.secret)).json(), { code: 'the-code', state: tv.id + '.' + tv.state });
});

test('a callback with a wrong TV state is refused and stores nothing', async t => {
  clock(t);
  const { env } = environment();
  const tv = await pair(env);
  const response = await call(env, '/callback?code=injected&state=' + tv.id + '.' + tvSide().state);
  assert.equal(response.status, 400);
  assert.deepEqual(await (await poll(env, tv.id, tv.secret)).json(), { pending: true });
});

test('pairings expire after ten minutes, also before the alarm runs', async t => {
  const time = clock(t);
  const { env, objects } = environment();
  const tv = await pair(env);
  time.advance(599_000);
  assert.deepEqual(await (await poll(env, tv.id, tv.secret)).json(), { pending: true });
  time.advance(1_000);
  assert.equal((await poll(env, tv.id, tv.secret)).status, 404, 'expired at exactly ten minutes');
  assert.equal((await call(env, '/start/' + tv.id)).status, 404);
  const late = await call(env, '/callback?code=late&state=' + tv.id + '.' + tv.state);
  assert.equal(late.status, 404);
  assert.match(await late.text(), /abgelaufen/);

  const other = await pair(env);
  await objects.get(other.id).object.alarm();
  assert.equal(objects.get(other.id).storage.map.size, 0, 'the alarm deletes the record');
  assert.equal((await poll(env, other.id, other.secret)).status, 404);
  assert.equal((await poll(env, 'f'.repeat(32), other.secret)).status, 404, 'unknown ids are 404');
  assert.equal((await poll(env, 'NOT-AN-ID', other.secret)).status, 404);
});

test('an error callback reaches the TV once as {error}', async t => {
  clock(t);
  const { env } = environment();
  const tv = await pair(env);
  const response = await call(env, '/callback?error=access_denied&state=' + tv.id + '.' + tv.state);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Anmeldung abgebrochen/);
  assert.deepEqual(await (await poll(env, tv.id, tv.secret)).json(), { error: 'access_denied' });
  assert.equal((await poll(env, tv.id, tv.secret)).status, 404);
  for (const query of ['?error=access_denied', '?code=x&error=access_denied&state=' + tv.id + '.' + tv.state, '?error=Bad%20Error&state=' + tv.id + '.' + tv.state,
    '?code=bad%20code&state=' + tv.id + '.' + tv.state, '?code=x&state=nope', '']) {
    const bad = await call(env, '/callback' + query);
    assert.equal(bad.status, 400, query);
  }
});

test('bodies are size-limited and validated strictly', async t => {
  clock(t);
  const { env, objects } = environment();
  const tv = tvSide(), good = { challenge: tv.challenge, state: tv.state, pollHash: tv.pollHash };
  const cases = [
    [{ ...good, extra: 1 }, 400], [{ challenge: tv.challenge, state: tv.state }, 400], [{ ...good, challenge: tv.challenge + 'A' }, 400],
    [{ ...good, challenge: tv.challenge.replace(/.$/, '=') }, 400], [{ ...good, state: 'short' }, 400], [{ ...good, pollHash: tv.pollHash.toUpperCase() }, 400],
    [{ ...good, pollHash: 123 }, 400], ['[1,2]', 400], ['null', 400], ['{"challenge":', 400], [JSON.stringify(good).padEnd(1025, ' '), 413]
  ];
  for (const [body, status] of cases) {
    const response = await call(env, '/pair', { method: 'POST', body });
    assert.equal(response.status, status, JSON.stringify(body).slice(0, 80));
    assert.equal(response.headers.get('access-control-allow-origin'), '*', 'errors stay readable for the TV');
  }
  const huge = await call(env, '/pair', { method: 'POST', body: JSON.stringify(good), headers: { 'Content-Length': '999999' } });
  assert.equal(huge.status, 413, 'a declared length over the limit is refused before reading');
  const invalidUtf8 = await worker.fetch(new Request(ORIGIN + '/pair', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: new Uint8Array([0x7b, 0xff, 0x7d]) }), env);
  assert.equal(invalidUtf8.status, 400);
  assert.equal(objects.size, 0, 'no pairing was created');
  const paired = await pair(env, tv);
  assert.equal((await call(env, '/poll/' + paired.id, { method: 'POST', body: { secret: tv.secret, more: 1 } })).status, 400);
  assert.equal((await call(env, '/poll/' + paired.id, { method: 'POST', body: { secret: 'x' } })).status, 400);
  assert.equal((await call(env, '/poll/' + paired.id, { method: 'POST', body: '{"secret":"' + 'A'.repeat(1100) + '"}' })).status, 413);
});

test('text/plain and application/json bodies are accepted; other types are not', async t => {
  clock(t);
  const { env } = environment();
  const tv = tvSide(), body = { challenge: tv.challenge, state: tv.state, pollHash: tv.pollHash };
  for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/json', 'application/json; charset=utf-8']) assert.equal((await call(env, '/pair', { method: 'POST', body, type })).status, 200, type);
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/octet-stream']) assert.equal((await call(env, '/pair', { method: 'POST', body, type })).status, 415, String(type));
});

test('OPTIONS preflights are answered; other methods are refused', async t => {
  clock(t);
  const { env } = environment();
  for (const path of ['/pair', '/poll/' + 'a'.repeat(32)]) {
    const response = await call(env, path, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
    assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i);
    const get = await call(env, path);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('access-control-allow-origin'), '*');
  }
  assert.equal((await call(env, '/callback?code=x&state=y', { method: 'HEAD' })).status, 405, 'a HEAD request never consumes a callback');
  assert.equal((await call(env, '/start/' + 'a'.repeat(32), { method: 'POST', body: '{}' })).status, 405);
});

test('pages carry a strict CSP, no external resources and no-store', async t => {
  clock(t);
  const { env } = environment();
  const tv = await pair(env);
  for (const path of ['/callback?code=abc&state=' + tv.id + '.' + tv.state, '/start/' + 'b'.repeat(32), '/', '/callback']) {
    const response = await call(env, path), html = await response.text();
    assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/]+=*'/);
    assert.doesNotMatch(csp, /unsafe-inline|script-src/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.doesNotMatch(html, /<script|<link|<img|https?:\/\//i, path);
    assert.match(html, /<html lang="de">/);
    const style = /<style>([^<]*)<\/style>/.exec(html)[1];
    assert.equal(csp.match(/'sha256-([^']+)'/)[1], createHash('sha256').update(style).digest('base64'), 'the CSP hash matches the inline style');
  }
});

test('a missing or malformed configuration fails closed', async t => {
  clock(t);
  for (const vars of [{ CLIENT_ID: '' }, { CLIENT_ID: 'not-hex' }, { REDIRECT_URI: 'http://example.com/callback' }, { REDIRECT_URI: undefined }]) {
    const { env } = environment(vars);
    const tv = tvSide();
    assert.equal((await call(env, '/pair', { method: 'POST', body: { challenge: tv.challenge, state: tv.state, pollHash: tv.pollHash } })).status, 500);
    assert.equal((await call(env, '/start/' + 'a'.repeat(32))).status, 500);
  }
});

test('nothing is logged and comparisons are constant-time helpers', async t => {
  clock(t);
  const logged = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, name, (...args) => logged.push(args));
  const { env } = environment();
  const tv = await pair(env);
  await call(env, '/start/' + tv.id);
  await call(env, '/callback?code=secret-code&state=' + tv.id + '.' + tv.state);
  await poll(env, tv.id, 'A'.repeat(43));
  await poll(env, tv.id, tv.secret);
  await call(env, '/pair', { method: 'POST', body: '{"broken"' });
  assert.deepEqual(logged, []);
  assert.equal(same('abc', 'abc'), true);
  assert.equal(same('abc', 'abd'), false);
  assert.equal(same('abc', 'abcd'), false);
  assert.equal(same('abc', undefined), false);
});
