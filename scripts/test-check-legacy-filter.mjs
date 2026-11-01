// The CHECK_STATE filter of check-legacy.mjs selects states by a case-insensitive part of their name,
// Spotify states included. CHECK_LEGACY_LIST prints the selection and exits before the preview starts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('./check-legacy.mjs', import.meta.url));
const CARDS = ['Spotify card on Tizen, photo dock', 'Spotify card on Tizen, dark list, German', 'Spotify card on Tizen, light dock', 'Spotify card on Tizen, expanded', 'Spotify settings on Tizen'];
const QR = 'Spotify QR screen on Tizen', OLD = 'Spotify card and QR on the old engine';
function list(filter) {
  const env = { ...process.env, CHECK_LEGACY_LIST: '1' };
  delete env.CHECK_STATE;
  if (filter !== undefined) env.CHECK_STATE = filter;
  return JSON.parse(execFileSync(process.execPath, [SCRIPT], { env, encoding: 'utf8', timeout: 30000 }));
}
const spotify = names => names.filter(name => /spotify/i.test(name));

test('without a filter every state runs once, with all Spotify states', () => {
  const names = list();
  assert.equal(new Set(names).size, names.length, 'state names are unique');
  assert.deepEqual(spotify(names), CARDS.concat(QR, OLD));
  assert.ok(names.length > 100, 'base, extended, widget, card and weather states are listed too');
});

test('a filter without the word Spotify still selects matching Spotify states', () => {
  for (const [filter, wanted] of [['dark list', [CARDS[1]]], ['German', [CARDS[1]]], ['light dock', [CARDS[2]]], ['expanded', [CARDS[3]]], ['Tizen', CARDS.concat(QR)], ['old engine', [OLD]]]) {
    const names = list(filter);
    assert.ok(names.every(name => name.toLowerCase().includes(filter.toLowerCase())), filter + ': only matching names');
    assert.deepEqual(spotify(names), wanted, filter);
  }
  const dark = list('dark list');
  assert.ok(dark.includes('dark list') && dark.includes('Settings layout detail, dark list'), 'other groups keep their matches');
});

test('a Spotify filter is case-insensitive, and other filters select no Spotify state', () => {
  assert.deepEqual(list('SPOTIFY'), CARDS.concat(QR, OLD));
  assert.deepEqual(spotify(list('spotify card')), CARDS.slice(0, 4).concat(OLD));
  assert.deepEqual(spotify(list('weather')), []);
  assert.deepEqual(list('no state has this name'), []);
});
