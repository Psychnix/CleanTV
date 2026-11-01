// Test the on-screen keyboard model (app/cleantv-keyboard.js) with a synthetic clock. No DOM, TV or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const SOURCE = readFileSync(new URL('../app/cleantv-keyboard.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ tizen = true, closeView = true } = {}) {
  let now = 0, nextId = 1;
  const timers = [], calls = { suggest: [], cancelled: [], choose: [], close: [], keys: [] }, listeners = {};
  const window = {
    setTimeout(fn, ms) { const id = nextId++; timers.push({ id, at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    addEventListener(type, fn, capture) { (listeners[type] = listeners[type] || []).push({ fn, capture }); }
  };
  if (tizen) window.tizen = { tvinputdevice: {
    registerKeyBatch(names) { calls.keys.push(['register', names.join('')]); },
    unregisterKeyBatch(names) { calls.keys.push(['unregister', names.join('')]); }
  } };
  if (closeView) window.CleanTVViews = { close(name) { calls.close.push(name); return true; } };
  const document = { documentElement: { contains: () => false } };
  vm.runInContext(SOURCE, vm.createContext({ window, document }));
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift(); now = t.at; t.fn();
    }
    now = end;
  };
  let reply = null;
  const options = {
    name: 'cleantv.qa.keyboard', title: () => 'QA', min: 2, max: 16,
    suggest(query, lang, done) { calls.suggest.push({ query, lang, at: now }); reply = done; return () => calls.cancelled.push(query); },
    choose(item, lang, done) { calls.choose.push(item.name); reply = done; return () => calls.cancelled.push('choice ' + item.name); }
  };
  const view = window.CleanTVKeyboard.create(options);
  const layout = window.CleanTVKeyboard.layout();
  const t = { id: 'cleantv.qa.keyboard', data: {}, f: {} };
  view.norm(t);
  /* Focus a key the way the remote does (QA-style) and press OK. */
  function keyOf(id) { for (let r = 0; r < layout.length; r++) for (const key of layout[r]) if (key.id === id) return { r, x: key.col }; throw Error('No key ' + id); }
  function press(id) { const k = keyOf(id); t.f.zone = 'keys'; t.f.r = k.r; t.f.x = k.x; return view.key(t, 'ok'); }
  function type(text) { for (const ch of text) press(ch === ' ' ? 'space' : ch === '-' ? 'hyphen' : { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[ch.toLowerCase()] || ch.toLowerCase()); }
  const focused = () => t.f.zone === 'list' ? 'item ' + t.f.i : layout[t.f.r].find(k => t.f.x >= k.col && t.f.x < k.col + k.w).id;
  return { window, view, layout, t, calls, advance, press, type, focused, reply: (...args) => reply(...args), done: () => reply, keyOf };
}
const items = n => Array.from({ length: n }, (_, i) => ({ name: 'Place ' + i, detail: 'Region' }));

test('the layout has A–Z, umlauts, ß, digits, hyphen, space, delete and OK on a 10-column grid', () => {
  const { layout } = harness();
  assert.equal(layout.length, 5);
  for (const row of layout) assert.equal(row.reduce((n, k) => n + k.w, 0), 10, 'every row fills ten columns');
  const ids = layout.flat().map(k => k.id).join(' ');
  assert.equal(ids, 'a b c d e f g h i j k l m n o p q r s t u v w x y z ae oe ue ss 1 2 3 4 5 6 7 8 9 0 hyphen space delete ok');
});

test('arrows move without wrapping and keep the column across wide keys', () => {
  const h = harness(), { t, view } = h;
  assert.equal(h.focused(), 'a');
  view.key(t, 'left'); view.key(t, 'up');
  assert.equal(h.focused(), 'a', 'no wrap at the top-left corner');
  for (let i = 0; i < 12; i++) view.key(t, 'right');
  assert.equal(h.focused(), 'j', 'no wrap at the right edge without suggestions');
  for (let i = 0; i < 8; i++) view.key(t, 'down');
  assert.equal(h.focused(), 'ok', 'no wrap at the bottom');
  view.key(t, 'up');
  assert.equal(h.focused(), '0', 'Up from OK returns to the remembered column');
  view.key(t, 'left'); view.key(t, 'left'); view.key(t, 'down');
  assert.equal(h.focused(), 'ok', 'columns 7 to 9 belong to OK');
  view.key(t, 'up');
  assert.equal(h.focused(), '8');
  view.key(t, 'left'); view.key(t, 'left'); view.key(t, 'down');
  assert.equal(h.focused(), 'delete');
  view.key(t, 'left');
  assert.equal(h.focused(), 'space', 'Left from Delete reaches the wide Space key');
  view.key(t, 'up');
  assert.equal(h.focused(), '2', 'Space remembers its first column');
  view.key(t, 'down'); view.key(t, 'left');
  assert.equal(h.focused(), 'hyphen');
});

test('typing capitalises words, keeps ß and umlauts, and refuses leading or doubled separators', () => {
  const h = harness();
  h.press('space'); h.press('hyphen');
  assert.equal(h.t.kb.value, '', 'no leading space or hyphen');
  h.type('bad neustadt');
  assert.equal(h.t.kb.value, 'Bad Neustadt');
  h.press('space'); h.press('space');
  assert.equal(h.t.kb.value, 'Bad Neustadt ', 'one space only');
  h.press('delete'); h.press('delete');
  assert.equal(h.t.kb.value, 'Bad Neustad');
  const g = harness();
  g.type('ößü-ärgern');
  assert.equal(g.t.kb.value, 'Ößü-Ärgern', 'ß is never upper-cased to SS; a hyphen starts a word');
  const m = harness();
  m.type('abcdefghijklmnopqrs');
  assert.equal(m.t.kb.value, 'Abcdefghijklmnop', 'the maximum length holds');
});

test('suggestions wait 400 ms after the last change, need two characters and cancel the previous search', () => {
  const h = harness();
  h.type('b');
  h.advance(1000);
  assert.equal(h.calls.suggest.length, 0, 'one character starts nothing');
  assert.equal(h.t.kb.status, 'short');
  h.type('o'); h.advance(399);
  assert.equal(h.calls.suggest.length, 0);
  h.type('n'); h.advance(399);
  assert.equal(h.calls.suggest.length, 0, 'each change restarts the wait');
  h.advance(1);
  assert.deepEqual(plain(h.calls.suggest), [{ query: 'Bon', lang: 'en', at: 1799 }]);
  assert.equal(h.t.kb.status, 'searching');
  h.type('n');
  assert.deepEqual(h.calls.cancelled, ['Bon'], 'the running search is cancelled when the text changes');
  const stale = h.done();
  h.advance(400);
  assert.equal(h.calls.suggest[1].query, 'Bonn');
  const current = h.done();
  stale(null, items(3));
  assert.equal(h.t.kb.items.length, 0, 'a late answer for older text is ignored');
  current(null, items(3), '');
  assert.equal(h.t.kb.items.length, 3);
  assert.equal(h.t.kb.status, 'done');
  h.press('delete'); h.press('delete'); h.press('delete');
  assert.equal(h.t.kb.status, 'short');
  assert.equal(h.t.kb.items.length, 0, 'too short clears the list');
});

test('OK on the OK key goes to the first suggestion or searches at once', () => {
  const h = harness();
  h.type('bo');
  h.press('ok');
  assert.equal(h.calls.suggest.length, 1, 'OK skips the remaining wait');
  h.reply(null, items(2));
  h.press('ok');
  assert.equal(h.focused(), 'item 0');
  h.view.key(h.t, 'down'); h.view.key(h.t, 'down');
  assert.equal(h.focused(), 'item 1', 'no wrap at the end of the list');
  h.view.key(h.t, 'left');
  assert.equal(h.focused(), 'ok', 'Left returns to the last column of the row it came from');
  h.view.key(h.t, 'right');
  assert.equal(h.focused(), 'item 1', 'Right from the last column enters the list');
});

test('the list scrolls to keep focus within seven rows', () => {
  const h = harness();
  h.type('ne'); h.advance(400); h.reply(null, items(20));
  h.press('ok');
  for (let i = 0; i < 9; i++) h.view.key(h.t, 'down');
  assert.equal(h.t.f.i, 9);
  assert.equal(h.t.kb.top, 3);
  for (let i = 0; i < 9; i++) h.view.key(h.t, 'up');
  assert.equal(h.t.kb.top, 0);
});

test('a choice closes the view on success and stays with the message on failure', () => {
  const h = harness();
  h.type('bonn'); h.advance(400); h.reply(null, items(2));
  h.press('ok'); h.view.key(h.t, 'down');
  h.view.key(h.t, 'ok');
  assert.deepEqual(h.calls.choose, ['Place 1']);
  assert.equal(h.t.kb.status, 'choosing');
  assert.equal(h.view.key(h.t, 'ok'), true, 'keys wait while the choice resolves');
  assert.equal(h.calls.choose.length, 1);
  h.reply('No coordinates.');
  assert.equal(h.t.kb.status, 'error');
  assert.equal(h.t.kb.message, 'No coordinates.');
  assert.deepEqual(h.calls.close, []);
  h.view.key(h.t, 'ok');
  h.reply('');
  assert.deepEqual(h.calls.close, ['cleantv.qa.keyboard']);
  assert.equal(h.t.kb.closed, true);
});

test('Back cancels a pending search or choice and releases the remote digits', () => {
  const h = harness();
  assert.deepEqual(h.calls.keys, [['register', '0123456789']], 'the remote digits are registered once when the view opens');
  h.view.norm(h.t);
  assert.equal(h.calls.keys.length, 1);
  h.type('bonn'); h.advance(400); h.reply(null, items(1));
  h.press('ok'); h.view.key(h.t, 'ok');
  assert.equal(h.view.key(h.t, 'back'), false, 'Back is left to the host, which closes the view');
  assert.deepEqual(h.calls.cancelled, ['choice Place 0']);
  assert.deepEqual(h.calls.keys[1], ['unregister', '0123456789']);
  h.reply('');
  assert.deepEqual(h.calls.close, [], 'a late choice after Back closes nothing');
  const g = harness();
  g.type('bo'); g.advance(400);
  g.view.key(g.t, 'back');
  assert.deepEqual(g.calls.cancelled, ['Bo']);
  g.type('n'); g.advance(1000);
  assert.equal(g.calls.suggest.length, 1, 'nothing runs after the view closed');
});

test('without CleanTVViews.close the view says it saved; without Tizen nothing is registered', () => {
  const h = harness({ tizen: false, closeView: false });
  h.type('bo'); h.advance(400); h.reply(null, items(1));
  h.press('ok'); h.view.key(h.t, 'ok'); h.reply('');
  assert.equal(h.t.kb.status, 'chosen');
  assert.deepEqual(h.calls.keys, []);
});
