// CleanTV Spotify pairing relay: a Cloudflare Worker with one SQLite-backed Durable Object per pairing.
//
// The TV keeps the PKCE verifier and a random poll secret; the relay only stores the challenge, the
// TV's state, the SHA-256 of the poll secret and, after the phone signed in, the one-time
// authorization code. Without the verifier that code cannot be redeemed, so the relay never holds
// anything that grants account access. Pairings expire after ten minutes (an alarm deletes them).
//
// Never log codes, states or secrets: this file contains no console calls on purpose, and errors are
// answered without details.

const TTL = 600;                 // seconds a pairing lives
const MAX_BODY = 1024;           // bytes accepted for /pair and /poll
const SCOPE = 'user-read-playback-state user-modify-playback-state';
const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const ID = /^[a-f0-9]{32}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;         // base64url SHA-256, as S256 produces
const TV_STATE = /^[A-Za-z0-9_-]{22,64}$/;
const POLL_HASH = /^[a-f0-9]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const CODE = /^[A-Za-z0-9._~-]{1,2048}$/;
const ERROR = /^[a-z_]{1,64}$/;
const STATE = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{22,64})$/;
const CLIENT_ID = /^[0-9a-f]{32}$/;

const API_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

class Failure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/* Constant-time comparison of two strings (the length is not secret: hashes and states have fixed lengths). */
export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Durable Object: one pairing record, internal routes only ---------- */
export class SpotifyPairing {
  constructor(state) { this.storage = state.storage; }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const input = await request.json();
    let record = await this.storage.get('pairing');
    if (record && record.expiresAt <= Date.now()) { await this.clear(); record = undefined; }
    if (op === 'create') {
      if (record) return Response.json({ error: 'exists' }, { status: 409 });
      record = { challenge: input.challenge, state: input.state, pollHash: input.pollHash, expiresAt: input.expiresAt, result: null };
      await this.storage.put('pairing', record);
      await this.storage.setAlarm(record.expiresAt);
      return Response.json({ ok: true });
    }
    if (!record) return Response.json({ error: 'not_found' }, { status: 404 });
    if (op === 'peek') return Response.json({ state: record.state, challenge: record.challenge, pending: !record.result });
    if (op === 'callback') {
      if (!same(input.tvState, record.state)) return Response.json({ error: 'state' }, { status: 403 });
      // Stored once: a second callback for the same pairing changes nothing.
      if (record.result) return Response.json({ error: 'used' }, { status: 409 });
      record.result = input.result;
      await this.storage.put('pairing', record);
      return Response.json({ ok: true });
    }
    if (op === 'poll') {
      if (!same(input.hash, record.pollHash)) return Response.json({ error: 'forbidden' }, { status: 403 });
      if (!record.result) return Response.json({ pending: true });
      // Delivered exactly once, then the record is gone.
      const result = record.result;
      await this.clear();
      return Response.json(result);
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  async alarm() { await this.clear(); }

  async clear() {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
  }
}

function pairing(env, id) {
  const stub = env.PAIRINGS.get(env.PAIRINGS.idFromName(id));
  return async (op, input) => {
    const response = await stub.fetch('https://pairing/' + op, { method: 'POST', body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
}

/* ---------- HTTP helpers ---------- */
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function preflight() {
  return new Response(null, { status: 204, headers: { ...API_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
}
/* A small JSON object, sent as text/plain (no CORS preflight from the TV) or application/json. */
async function readJson(request, keys) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'text/plain' && type !== 'application/json') throw new Failure(415, 'unsupported_media_type');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^[0-9]{1,9}$/.test(length) || Number(length) > MAX_BODY)) throw new Failure(413, 'too_large');
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Failure(413, 'too_large'); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Failure(400, 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Failure(400, 'invalid_json');
  if (Object.keys(body).sort().join() !== [...keys].sort().join()) throw new Failure(400, 'invalid_fields');
  return body;
}

/* ---------- Pages for the phone: no external resources, no script ---------- */
const STYLE = 'body{margin:0;font:18px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#121212;color:#f4f4f1}main{max-width:32em;margin:18vh auto;padding:0 24px}h1{font-size:24px;line-height:1.3;margin:0 0 12px}p{margin:0;color:#bdbdbd}';
let styleHash = null;
async function page(status, title, line) {
  styleHash = styleHash || 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(STYLE)))));
  const html = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="referrer" content="no-referrer"><title>CleanTV · Spotify</title><style>' + STYLE + '</style></head>'
    + '<body><main><h1>' + title + '</h1>' + (line ? '<p>' + line + '</p>' : '') + '</main></body></html>';
  return new Response(html, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src '" + styleHash + "'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY'
  } });
}
const PAGES = {
  connected: [200, 'Verbunden – du kannst zum Fernseher zurückkehren.', ''],
  cancelled: [200, 'Anmeldung abgebrochen.', 'Am Fernseher kannst du einen neuen QR-Code erstellen.'],
  expired: [404, 'Dieser Anmeldelink ist abgelaufen.', 'Erstelle am Fernseher einen neuen QR-Code.'],
  used: [409, 'Dieser Anmeldelink wurde bereits verwendet.', 'Am Fernseher kannst du einen neuen QR-Code erstellen.'],
  invalid: [400, 'Dieser Anmeldelink ist ungültig.', 'Scanne den QR-Code am Fernseher erneut.'],
  missing: [404, 'Diese Seite gibt es nicht.', ''],
  broken: [500, 'Die Anmeldung ist gerade nicht möglich.', 'Bitte versuche es später erneut.']
};
const show = name => page(...PAGES[name]);

/* ---------- Routes ---------- */
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const api = path === '/pair' || /^\/poll\/[^/]*$/.test(path);
  if (!CLIENT_ID.test(env.CLIENT_ID || '') || !/^https:\/\/[a-z0-9.-]+\/callback$/.test(env.REDIRECT_URI || '')) return api ? json({ error: 'not_configured' }, 500) : show('broken');
  if (api) {
    if (method === 'OPTIONS') return preflight();
    if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' });
    if (path === '/pair') {
      const body = await readJson(request, ['challenge', 'state', 'pollHash']);
      if (typeof body.challenge !== 'string' || !CHALLENGE.test(body.challenge) || typeof body.state !== 'string' || !TV_STATE.test(body.state)
        || typeof body.pollHash !== 'string' || !POLL_HASH.test(body.pollHash)) return json({ error: 'invalid_fields' }, 400);
      const id = randomId();
      const created = await pairing(env, id)('create', { challenge: body.challenge, state: body.state, pollHash: body.pollHash, expiresAt: Date.now() + TTL * 1000 });
      if (created.status !== 200) return json({ error: 'unavailable' }, 503);
      return json({ id, expiresIn: TTL });
    }
    const id = path.slice('/poll/'.length);
    if (!ID.test(id)) return json({ error: 'not_found' }, 404);
    const body = await readJson(request, ['secret']);
    if (typeof body.secret !== 'string' || !SECRET.test(body.secret)) return json({ error: 'invalid_fields' }, 400);
    const result = await pairing(env, id)('poll', { hash: await sha256hex(body.secret) });
    if (result.status === 404) return json({ error: 'not_found' }, 404);
    if (result.status === 403) return json({ error: 'forbidden' }, 403);
    if (result.body.pending === true) return json({ pending: true });
    return json(typeof result.body.error === 'string' ? { error: result.body.error } : { code: result.body.code, state: result.body.state });
  }
  // GET only: a HEAD or prefetch must never consume a callback.
  if (method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  const start = /^\/start\/([^/]*)$/.exec(path);
  if (start) {
    if (!ID.test(start[1])) return show('expired');
    const found = await pairing(env, start[1])('peek', {});
    if (found.status !== 200) return show('expired');
    if (!found.body.pending) return show('used');
    const target = new URL(AUTHORIZE);
    target.search = new URLSearchParams({
      response_type: 'code', client_id: env.CLIENT_ID, redirect_uri: env.REDIRECT_URI, code_challenge_method: 'S256',
      code_challenge: found.body.challenge, scope: SCOPE, state: start[1] + '.' + found.body.state
    }).toString();
    return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  if (path === '/callback') {
    const params = url.searchParams, code = params.get('code'), error = params.get('error'), match = STATE.exec(params.get('state') || '');
    if (!match || (code === null) === (error === null)) return show('invalid');
    if (code !== null && !CODE.test(code)) return show('invalid');
    if (error !== null && !ERROR.test(error)) return show('invalid');
    const result = code !== null ? { code, state: match[0] } : { error };
    const stored = await pairing(env, match[1])('callback', { tvState: match[2], result });
    if (stored.status === 404) return show('expired');
    if (stored.status === 403) return show('invalid');
    if (stored.status === 409) return show('used');
    return show(code !== null ? 'connected' : 'cancelled');
  }
  return show('missing');
}

export default {
  async fetch(request, env) {
    const api = /^\/(pair|poll\/)/.test(new URL(request.url).pathname);
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof Failure) return json({ error: error.code }, error.status);
      return api ? json({ error: 'unavailable' }, 500) : show('broken');
    }
  }
};
