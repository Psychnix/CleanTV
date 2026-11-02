// Raw Chrome DevTools Protocol reader for CleanTV on a Samsung TV (Chrome 47 page inspector).
// editor_tizen.py owns sdb, the debug launch and the local forward; this helper only receives the
// local port, talks to 127.0.0.1 and evaluates the one fixed, read-only expression in
// editor-tizen-mirror.js. Output: one JSON line per message on stdout, never logged elsewhere.
//   node editor-tizen-cdp.mjs <port>          about once a second; a "state" line only on change
//   node editor-tizen-cdp.mjs <port> --once   one "state" line, then exit
import {readFileSync, writeSync} from 'node:fs';

const EXPRESSION = readFileSync(new URL('./editor-tizen-mirror.js', import.meta.url), 'utf8');
const PAGE = 'file:///index.html', SOCKET_PATH = /^\/devtools\/page\/[A-Za-z0-9._-]{1,128}$/, LIMIT = 1_000_000;
// Test-only override for a faster fake inspector; the editor server never sets it.
const INTERVAL = Math.min(5000, Math.max(50, Number(process.env.CLEANTV_MIRROR_INTERVAL_MS) || 1000));
const port = Number(process.argv[2]), once = process.argv.includes('--once');
// Synchronous writes: a line is complete on the pipe before any process.exit().
function emit(value) {
  const data = Buffer.from(JSON.stringify(value) + '\n');
  for (let offset = 0; offset < data.length;) {
    try { offset += writeSync(1, data, offset); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  }
}
function fail(message, code = 1) { emit({type: 'error', message: String(message).slice(0, 300)}); process.exit(code); }
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Ungültiger lokaler Port.');

function chooseTarget(targets) {
  if (!Array.isArray(targets)) return null;
  const page = targets.find(t => t && t.type === 'page' && t.url === PAGE);
  if (!page) return null;
  let path = null;
  try {
    const url = new URL(String(page.webSocketDebuggerUrl || ''));
    if (url.protocol === 'ws:' && SOCKET_PATH.test(url.pathname) && !url.search) path = url.pathname;
  } catch { path = null; }
  return {id: page.id, path};
}

let list;
try {
  const response = await fetch('http://127.0.0.1:' + port + '/json', {signal: AbortSignal.timeout(5000)});
  list = await response.json();
} catch { fail('Der TV-Inspektor antwortet nicht. Ist CleanTV im Debug-Modus?'); }
const target = chooseTarget(list);
if (!target) fail('CleanTV wurde im TV-Inspektor nicht gefunden.');
if (!target.path) fail('Der TV-Inspektor ist bereits belegt, zum Beispiel durch Chrome DevTools. Bitte dort schließen.');

// Only the path comes from the TV's listing; host and port stay the local forward.
const socket = new WebSocket('ws://127.0.0.1:' + port + target.path);
const pending = new Map();
let next = 0, closing = false;
socket.addEventListener('message', event => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(Error('Der TV-Inspektor lehnt die Anfrage ab: ' + String(message.error.message || '').slice(0, 120)));
  else waiter.resolve(message.result || {});
});
socket.addEventListener('close', () => { if (!closing) fail('Die Verbindung zum TV-Inspektor wurde beendet.', 2); });
socket.addEventListener('error', () => { if (!closing) fail('Die Verbindung zum TV-Inspektor ist fehlgeschlagen.', 2); });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('timeout')), 8000);
  socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
}).catch(() => fail('Der TV-Inspektor nimmt keine Verbindung an.', 2));

function call(method, params, timeout = 10000) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Der TV antwortet nicht rechtzeitig.')); }, timeout);
    pending.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params}));
  });
}
async function read() {
  // Chrome 47 reports exceptions as wasThrown; newer inspectors as exceptionDetails.
  const response = await call('Runtime.evaluate', {expression: EXPRESSION, returnByValue: true});
  if (response.wasThrown || response.exceptionDetails) throw Error('Der Lesebefehl ist im TV fehlgeschlagen.');
  const value = response.result && response.result.value;
  if (typeof value !== 'string' || value.length > LIMIT) throw Error('Der TV hat keinen gültigen Zustand geliefert.');
  return value;
}
function stop(code = 0) { closing = true; try { socket.close(); } catch { /* closed */ } process.exit(code); }

try {
  if (once) { emit({type: 'state', state: JSON.parse(await read())}); stop(0); }
  // The editor closes stdin when no visible tab reads the mirror any more.
  process.stdin.on('end', () => stop(0));
  process.stdin.on('close', () => stop(0));
  process.stdin.resume();
  let last = null;
  for (;;) {
    const started = Date.now(), value = await read();
    if (value !== last) { last = value; emit({type: 'state', state: JSON.parse(value)}); }
    emit({type: 'tick', ms: Date.now() - started});
    await new Promise(resolve => setTimeout(resolve, Math.max(50, INTERVAL - (Date.now() - started))));
  }
} catch (error) { fail(error.message); }
