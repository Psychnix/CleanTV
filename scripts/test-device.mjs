// Test the production adapter with a synthetic API and clock. No TV access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/device.js', import.meta.url), 'utf8');
// installed: IDs getAppInfo finds (omit it for an API without getAppInfo); model: systeminfo
// model_name; customProperties: false for a Chromium 47 engine; hide: the app can hide itself.
function harness({ installed, model, customProperties = true, probeError, hide } = {}) {
  let now = 0, next = 0;
  const timers = new Map(), requests = [], launches = [], probes = [], hidden = [];
  const application = {
    getCurrentApplication: () => hide ? { appInfo: { id: 'Owner12345.Home' }, hide: () => hidden.push(true) } : { appInfo: { id: 'Owner12345.Home' } },
    getAppsInfo: (ok, fail) => requests.push({ ok, fail }),
    launch: (id, ok, fail) => launches.push({ id, ok, fail })
  };
  if (installed) application.getAppInfo = id => {
    probes.push(id);
    if (probeError) throw { name: probeError, message: 'Synthetic ' + probeError };
    if (!installed.includes(id)) throw { name: 'NotFoundError', message: 'Not installed: ' + id };
    return { id, name: id, show: true };
  };
  const tizen = { application };
  if (model !== undefined) tizen.systeminfo = { getCapability: key => { if (key !== 'http://tizen.org/system/model_name') throw Error('Unexpected key'); return model; } };
  const window = { tizen, CSS: { supports: (name, value) => name === '--a' && value === '0' ? customProperties : true } };
  vm.runInNewContext(source, {
    window, tizen: window.tizen,
    setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  }
  return { device: window.FrameDevice, requests, launches, probes, hidden, advance };
}
const REFERENCE = ['org.tizen.art-app', 'com.samsung.tv.csfs', 'com.samsung.tv.coba.setting'];
// IDs installed on the 2017 UE40MU6179 (Tizen 3.0).
const MU6179 = ['9Ur5IzDKqV.TizenYouTube', 'org.tizen.netflix-app', 'RN1MCdNq8t.Netflix', 'MCmYXNxgcu.DisneyPlus', 'evKhCgZelL.AmazonIgnitionLauncher2',
  'Y6A54cEa22.AppleTV', 'rJeHak5zRg.Spotify', 'org.tizen.browser', 'org.volt.firstscreen', 'org.tizen.menu', 'org.tizen.art-app'];

test('a 500-app catalogue can arrive after the old eight-second deadline', () => {
  const h = harness(), results = [];
  h.device.apps((error, apps) => results.push({ error, apps }));
  assert.equal(h.requests.length, 1);
  h.advance(15000);
  assert.equal(results.length, 0);
  h.requests[0].ok(Array.from({ length: 500 }, (_, i) => ({ id: 'App' + String(i).padStart(7, '0') + '.Consumer', name: 'App ' + i, show: true })));
  assert.equal(results.length, 1);
  assert.equal(results[0].error, null);
  assert.equal(results[0].apps.length, 500);
});

test('catalogue timeout and late callbacks finish only once', () => {
  const h = harness(), results = [];
  h.device.apps((error, apps) => results.push({ error, apps }));
  h.advance(19999);
  assert.equal(results.length, 0);
  h.advance(1);
  assert.equal(results.length, 1);
  assert.match(results[0].error.message, /did not respond/);
  h.requests[0].ok([]);
  h.requests[0].fail({ message: 'Late failure' });
  assert.equal(results.length, 1);
});

test('regional streaming apps stay distinct and system helpers stay hidden', () => {
  const h = harness();
  let apps;
  h.device.apps((error, value) => { assert.equal(error, null); apps = value; });
  h.requests[0].ok([
    { id: 'Owner12345.Home', name: 'My Home', show: true },
    { id: '9Ur5IzDKqV.TizenYouTube', name: 'YouTube', show: false },
    { id: 'PvWgqxV3Xa.YouTubeTV', name: 'YouTube TV', show: false },
    { id: 'cj37Ni3qXM.HBONow', name: 'HBO Max', show: false },
    { id: '2022ePop01.SmartTV', name: 'Smart TV', show: true },
    { id: 'd0m1lV1nt2.emanual', name: 'User Guide', show: true },
    { id: 'Hidden1234.Consumer', name: 'Hidden app', show: false }
  ]);
  assert.equal(apps.length, 3);
  assert.equal(apps.find(a => a.name === 'YouTube').brand, 'youtube');
  assert.equal(apps.find(a => a.name === 'YouTube TV').brand, '');
  assert.equal(apps.find(a => a.name === 'HBO Max').brand, 'hbomax');
});

test('launch keeps its eight-second deadline independently of discovery', () => {
  const h = harness(), results = [];
  h.device.launchApp('Synthetic.App', error => results.push(error));
  h.advance(8000);
  assert.equal(results.length, 1);
  assert.match(results[0].message, /did not respond/);
  h.launches[0].ok();
  assert.equal(results.length, 1);
});

const OLD = { customProperties: false };
test('has() reports installed, missing and unknown apps on older engines', () => {
  const h = harness({ ...OLD, installed: ['Synthetic.App'] });
  assert.equal(h.device.has('Synthetic.App'), true);
  assert.equal(h.device.has('Missing.App'), false);
  assert.equal(h.device.has('Missing.App'), false);
  assert.equal(h.probes.filter(id => id === 'Missing.App').length, 1);
  assert.equal(harness(OLD).device.has('Synthetic.App'), null);
  assert.equal(harness({ ...OLD, installed: [], probeError: 'SecurityError' }).device.has('Synthetic.App'), null);
  const window = { CSS: { supports: () => true } };
  vm.runInNewContext(source, { window, setTimeout, clearTimeout });
  assert.equal(window.FrameDevice.has('Synthetic.App'), null);
  assert.deepEqual({ ...window.FrameDevice.capabilities }, { art: true, home: true, settings: true });
});

test('brand candidates keep the reference ID unless the TV reports another one', () => {
  const unknown = harness(OLD), reference = harness({ ...OLD, installed: ['org.tizen.primevideo', 'evKhCgZelL.AmazonIgnitionLauncher2'] });
  const older = harness({ ...OLD, installed: MU6179 }), none = harness({ ...OLD, installed: [] });
  for (const h of [unknown, reference, none]) assert.equal(h.device.appId('primevideo'), 'org.tizen.primevideo');
  assert.equal(older.device.appId('primevideo'), 'evKhCgZelL.AmazonIgnitionLauncher2');
  assert.equal(older.device.appId('appletv'), 'Y6A54cEa22.AppleTV');
  assert.equal(older.device.appId('netflix'), 'org.tizen.netflix-app');
  assert.equal(older.device.appId('youtube'), '9Ur5IzDKqV.TizenYouTube');
  assert.equal(older.device.appId('stremio'), 'IkWsFHtOY9.Stremio');
  assert.equal(older.device.has(older.device.appId('stremio')), false);
  assert.equal(older.device.appId('constructor'), null);
  older.device.launch('appletv', () => {});
  assert.equal(older.launches.at(-1).id, 'Y6A54cEa22.AppleTV');
});

test('Samsung Home and TV settings use the first installed system screen', () => {
  const reference = harness({ ...OLD, installed: REFERENCE }), older = harness({ ...OLD, installed: MU6179, model: 'UE40MU6179' });
  for (const h of [reference, older, harness(OLD)]) { h.device.home(() => {}); h.device.settings(() => {}); }
  assert.deepEqual(reference.launches.map(l => l.id), ['com.samsung.tv.csfs', 'com.samsung.tv.coba.setting']);
  assert.deepEqual(older.launches.map(l => l.id), ['org.volt.firstscreen', 'org.tizen.menu']);
  const missing = harness({ ...OLD, installed: [] }), results = [];
  assert.deepEqual({ ...missing.device.capabilities }, { art: false, home: false, settings: false });
  missing.device.home(error => results.push(error));
  assert.equal(missing.launches[0].id, 'com.samsung.tv.csfs');
  missing.launches[0].fail({ name: 'NotFoundError', message: 'Not installed' });
  assert.match(results[0].message, /could not open/);
});

test('on older engines Art Mode needs the art app and The Frame', () => {
  const art = options => harness({ ...OLD, ...options }).device.capabilities.art;
  assert.equal(art({ installed: REFERENCE, model: 'QE55LS03DAUXXN' }), true);
  assert.equal(art({ installed: REFERENCE, model: 'UE55LS003AUXXU' }), true);
  assert.equal(art({ installed: MU6179, model: 'UE40MU6179' }), false);
  assert.equal(art({ installed: REFERENCE, model: 'QN43Q60BAFXZA' }), false);
  assert.equal(art({ installed: [], model: 'QE55LS03DAUXXN' }), false);
  for (const model of [undefined, '', '23_PONTUSM_FTV']) assert.equal(art({ installed: MU6179, model }), false);
  assert.deepEqual({ ...harness({ installed: MU6179, model: 'UE40MU6179', customProperties: false }).device.capabilities }, { art: false, home: true, settings: true });
});

test('older-model catalogue lists one entry per brand, German services and no helpers', () => {
  const h = harness({ ...OLD, installed: MU6179 });
  let apps;
  h.device.apps((error, value) => { assert.equal(error, null); apps = value; });
  h.requests[0].ok([
    { id: 'RN1MCdNq8t.Netflix', name: 'Netflix', show: true },
    { id: 'org.tizen.netflix-app', name: 'Netflix', show: true },
    { id: 'evKhCgZelL.AmazonIgnitionLauncher2', name: 'Prime Video', show: true },
    { id: 'Y6A54cEa22.AppleTV', name: 'Apple TV', show: true },
    { id: 'SrAoJxGQUf.ARD', name: 'ARD Mediathek', show: true },
    { id: 'yPSlpvfeTf.ZDFmediathek', name: 'ZDFmediathek', show: true },
    { id: 'KbRHmu0vrC.TVNOWPREMIUM', name: 'RTL+', show: false },
    { id: 'Aa11Bb22Cc.Weather', name: 'Weather', show: true },
    { id: 'MCmYXNxgcu.DisneyPlusPreviewService', name: 'Disney+ Preview', show: true },
    { id: 'rJeHak5zRg.SpotifyService', name: 'Spotify', show: true },
    { id: 'Qq12Ww34Ee.service', name: 'Helper', show: true },
    { id: 'Zx98Cv76Bn.PrivacyChoices', name: 'Privacy Choices', show: true },
    { id: 'Mn45Bv67Cx.OTApp', name: 'OT', show: true },
    { id: 'Lk09Jh87Gf.MultiScreenWebLauncher', name: 'MultiScreen', show: true },
    { id: '17emanual3.emanual', name: 'e-Manual', show: true },
    { id: '2017ePop01.SmartTV', name: 'Smart TV', show: true },
    { id: 'Po12Iu34Yt.ThinExtra', name: 'Thin Extra', show: true },
    { id: 'Ty56Ui78Op.ADPlayer', name: 'AD Player', show: true },
    { id: 'XyZ1234567.MultiScreenGame', name: 'Party Game', show: true },
    { id: 'Ab12Cd34Ef.EPOPularity', name: 'Quiz', show: true }
  ]);
  assert.deepEqual(Array.from(apps, a => a.appId), ['org.tizen.netflix-app', 'Y6A54cEa22.AppleTV', 'evKhCgZelL.AmazonIgnitionLauncher2', 'SrAoJxGQUf.ARD', 'KbRHmu0vrC.TVNOWPREMIUM', 'yPSlpvfeTf.ZDFmediathek', 'XyZ1234567.MultiScreenGame', 'Ab12Cd34Ef.EPOPularity', 'Aa11Bb22Cc.Weather']);
  assert.deepEqual(Array.from(apps.slice(0, 3), a => a.brand), ['netflix', 'appletv', 'primevideo']);
});

test('an alternative ID stands in for its brand when only it is installed', () => {
  const h = harness(OLD);
  let apps;
  h.device.apps((error, value) => { apps = value; });
  h.requests[0].ok([{ id: 'RN1MCdNq8t.Netflix', name: 'Netflix', show: true }]);
  assert.deepEqual(Array.from(apps, a => [a.appId, a.brand]), [['RN1MCdNq8t.Netflix', 'netflix']]);
});

test('newer engines keep the reference targets, Art Mode, Home and catalogue rules without probing', () => {
  const h = harness({ installed: [], model: 'QN43Q60BAFXZA', hide: true });
  assert.deepEqual({ ...h.device.capabilities }, { art: true, home: true, settings: true });
  assert.equal(h.device.has('org.tizen.art-app'), null);
  assert.equal(h.device.appId('primevideo'), 'org.tizen.primevideo');
  h.device.home(() => {}); h.device.settings(() => {}); h.device.launch('netflix', () => {});
  assert.deepEqual(h.launches.map(l => l.id), ['com.samsung.tv.csfs', 'com.samsung.tv.coba.setting', 'org.tizen.netflix-app']);
  h.launches[0].fail({ name: 'NotFoundError', message: 'Not installed' });
  assert.deepEqual(h.hidden, []);
  assert.deepEqual(h.probes, []);
  let apps;
  h.device.apps((error, value) => { apps = value; });
  h.requests[0].ok([
    { id: 'org.tizen.netflix-app', name: 'Netflix', show: true },
    { id: 'RN1MCdNq8t.Netflix', name: 'Netflix', show: true },
    { id: 'Zx98Cv76Bn.PrivacyChoices', name: 'Privacy Choices', show: true },
    { id: 'SrAoJxGQUf.ARD', name: 'ARD Mediathek', show: false }
  ]);
  assert.deepEqual(Array.from(apps, a => [a.appId, a.brand]), [['org.tizen.netflix-app', 'netflix'], ['RN1MCdNq8t.Netflix', ''], ['Zx98Cv76Bn.PrivacyChoices', '']]);
});

test('an older TV hides CleanFrame when Samsung Home is missing or refuses to open', () => {
  const none = harness({ ...OLD, installed: [], hide: true }), results = [];
  assert.equal(none.device.capabilities.home, true);
  none.device.home(error => results.push(error));
  assert.deepEqual([none.launches.length, none.hidden.length, results[0]], [0, 1, null]);
  const refused = harness({ ...OLD, installed: MU6179, hide: true });
  refused.device.home(error => results.push(error));
  assert.equal(refused.launches[0].id, 'org.volt.firstscreen');
  refused.launches[0].fail({ name: 'SecurityError', message: 'Not permitted' });
  assert.deepEqual([refused.hidden.length, results[1]], [1, null]);
  const opened = harness({ ...OLD, installed: MU6179, hide: true });
  opened.device.home(error => results.push(error));
  opened.launches[0].ok();
  assert.deepEqual([opened.hidden.length, results[2]], [0, null]);
});
