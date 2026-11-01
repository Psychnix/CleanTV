// Production UI checks. Mock only the public Tizen boundary; never contact a TV.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openPreview, root } from './browser.mjs';

const KEY = 'cleantv.home.v1';
const PRIMARY = ['stremio', 'netflix', 'disneyplus', 'youtube', 'appletv', 'primevideo', 'abciview', 'sbs', 'applemusic'];
const IDS = ['IkWsFHtOY9.Stremio', 'org.tizen.netflix-app', 'MCmYXNxgcu.DisneyPlus', '9Ur5IzDKqV.TizenYouTube', 'com.samsung.tv.aria-video', 'org.tizen.primevideo', 'mWK87Xghap.ABCiview', 'OyE7OuxlUi.SBSOnDemand', 'org.tizen.apple.apple-music'];
const NAMES = ['Stremio', 'Netflix', 'Disney+', 'YouTube', 'Apple TV', 'Prime Video', 'ABC iview', 'SBS On Demand', 'Apple Music'];
const EXTRA = 'AbCdEf1234.FamilyApp', SPOTIFY = 'rJeHak5zRg.Spotify';
const UNSAFE_NAME = 'Family <img src=x onerror="window.__catalogXss=1"> & TV';
const CATALOG = IDS.map((id, i) => ({ id, name: NAMES[i], show: true, iconPath: '' })).concat([
  { id: EXTRA, name: UNSAFE_NAME, show: true, iconPath: '' },
  { id: SPOTIFY, name: 'Spotify', show: true, iconPath: '' },
  { id: '5b8c3eb16b.BeamCTVDev', name: 'HBO Max', show: true, iconPath: '' },
  { id: 'nClrkHome1.FrameHome', name: 'CleanFrame', show: true },
  { id: 'AbCdEf1234.worker', name: 'Background worker', show: true },
  { id: 'com.samsung.tv.cobalt-yt', name: 'YouTube', show: true }
]);
const walls = JSON.parse(readFileSync(root + 'app/assets/wallpapers/SOURCES.json', 'utf8'));
// Every origin config.xml allows; a request to one of them needs page.__allowExternal.
const EXTERNAL = [...readFileSync(root + 'app/config.xml', 'utf8').matchAll(/<access origin="([^"]+)"/g)].map(m => m[1]);
if (EXTERNAL.length < 8 || !EXTERNAL.includes('https://raw.githubusercontent.com') || !EXTERNAL.includes('https://cleantv-spotify.tobiaspsi96.workers.dev')) throw Error('Unexpected config.xml origins: ' + EXTERNAL.join(', '));
const out = root + '.local/qa/';
mkdirSync(out, { recursive: true });
const sourceFiles = ['app/main.js', 'app/device.js', 'app/index.html', 'app/style.css', 'app/config.xml', 'app/assets/wallpapers/SOURCES.json', 'app/assets/wallpapers/catalog.js', 'app/assets/adaptive-ink.js', 'app/assets/icons/metrics.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(f => [f, createHash('sha256').update(readFileSync(root + f)).digest('hex')]));
const report = { scope: 'Production UI in Chromium; mock public Tizen API only; no TV contacted.', sourceBefore: hashes(), checks: [], failures: [], pageErrors: [], expectedNetworkFailures: [] };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const baseline = (patch = {}) => ({ dock: PRIMARY.slice(), wallpaper: walls[0].id, mode: 'fixed', lastApp: 'netflix', theme: 'shore', ...patch });
let preview, current, section = '';

function check(name, pass, detail) {
  const result = { section, name, passed: !!pass, ...(pass ? {} : { detail }) };
  report.checks.push(result);
  if (!pass) { report.failures.push(result); throw Error(name + (detail ? ': ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
async function run(name, fn) {
  if (process.env.CHECK_SECTION && !name.toLowerCase().includes(process.env.CHECK_SECTION.toLowerCase())) return;
  section = name;
  try { await fn(); console.log(name + ': passed'); }
  catch (error) { if (!report.failures.some(f => f.section === name)) report.failures.push({ section: name, error: error.stack }); console.error(name + ': ' + error.message); }
  finally { await closePage(); }
}
async function closePage() { if (current) { current.__closing = true; await current.close(); current = null; } }

// Production still calls its unmodified device.js adapter.
function installHarness({ seed, previous, legacy, mock, catalog, minuteMs, catalogFailure, noFontAPI, storageFailure, currentAppId, initiallyHidden, pauseHiddenFrames, rejectDecode }) {
  if (!sessionStorage.getItem('__cleanframe_seeded')) {
    if (seed !== undefined) localStorage.setItem('cleantv.home.v1', typeof seed === 'string' ? seed : JSON.stringify(seed));
    if (previous !== undefined) localStorage.setItem('cleanframe.home.v1', typeof previous === 'string' ? previous : JSON.stringify(previous));
    if (legacy !== undefined) localStorage.setItem('cleanframe.shore.v1', typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
    sessionStorage.setItem('__cleanframe_seeded', '1');
  }
  window.ShoreQA = { minuteMs };
  window.__failWrites = !!storageFailure;
  window.__storageAttempts = 0;
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === 'cleantv.home.v1') window.__storageAttempts++;
    if (window.__failWrites && key === 'cleantv.home.v1') throw new DOMException('QA storage failure', 'QuotaExceededError');
    return set.call(this, key, value);
  };
  const queuedFrames = new Map(), requestFrame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
  let nextFrame = 0;
  if (pauseHiddenFrames) {
    window.requestAnimationFrame = callback => {
      if (!document.hidden) return requestFrame(callback);
      const id = --nextFrame; queuedFrames.set(id, callback); return id;
    };
    window.cancelAnimationFrame = id => { if (queuedFrames.has(id)) queuedFrames.delete(id); else cancelFrame(id); };
  }
  window.__setHidden = value => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
    if (!value) { queuedFrames.forEach(callback => requestFrame(callback)); queuedFrames.clear(); }
    document.dispatchEvent(new Event('visibilitychange'));
  };
  if (initiallyHidden) window.__setHidden(true);
  if (rejectDecode) HTMLImageElement.prototype.decode = function () { return Promise.reject(new DOMException('Synthetic decode rejection')); };
  if (noFontAPI) Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
  if (!mock) return;
  window.__tv = { catalog, catalogFailure: !!catalogFailure, launchFailure: false, holdCatalog: false, pending: [], calls: [], catalogCalls: 0 };
  window.tizen = {
    ApplicationControlData: function (key, value) { this.key = key; this.value = value; },
    ApplicationControl: function (operation, uri, mime, category, data) { Object.assign(this, { operation, uri, mime, category, data }); },
    application: {
      getCurrentApplication() { return { appInfo: { id: currentAppId || 'nClrkHome1.FrameHome' } }; },
      getAppsInfo(ok, fail) {
        const tv = window.__tv;
        tv.catalogCalls++;
        const finish = () => tv.catalogFailure ? fail({ name: 'UnknownError', message: 'Catalogue unavailable for QA' }) : ok(tv.catalog.map(a => ({ ...a })));
        if (tv.holdCatalog) tv.pending.push({ ok, fail }); else setTimeout(finish, 0);
      },
      launch(id, ok, fail) {
        const tv = window.__tv; tv.calls.push({ method: 'launch', id });
        setTimeout(() => tv.launchFailure ? fail({ name: 'NotFoundError', message: 'App unavailable for QA' }) : ok(), 0);
      },
      launchAppControl(control, id, ok, fail) {
        const tv = window.__tv; tv.calls.push({ method: 'launchAppControl', id, control });
        setTimeout(() => tv.launchFailure ? fail({ name: 'UnknownError', message: 'Screen unavailable for QA' }) : ok(), 0);
      }
    }
  };
}
async function page(options = {}, setup) {
  current = await preview.browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const owner = current;
  current.setDefaultTimeout(10000);
  const expected = [];
  current.__expectedFailures = expected;
  current.on('pageerror', error => report.pageErrors.push({ section, error: error.message }));
  current.on('response', response => { if (response.status() >= 400 && !expected.some(s => response.url().includes(s))) report.pageErrors.push({ section, status: response.status(), url: response.url() }); });
  // No reviewed external origin is contacted without an explicit opt-in (startup never contacts one).
  current.on('request', request => {
    let origin = '';
    try { origin = new URL(request.url()).origin; } catch { origin = ''; }
    if (EXTERNAL.includes(origin) && !(owner.__allowExternal || []).includes(origin)) report.pageErrors.push({ section, unexpectedExternalRequest: request.url() });
  });
  current.on('requestfailed', request => {
    if (owner.__closing) return;
    const failure = { section, url: request.url(), error: request.failure()?.errorText };
    if (expected.some(s => request.url().includes(s))) report.expectedNetworkFailures.push(failure);
    else if (failure.error !== 'net::ERR_ABORTED') report.pageErrors.push(failure);
  });
  await current.addInitScript(installHarness, { mock: true, catalog: CATALOG, minuteMs: 60000, seed: baseline(), ...options });
  if (setup) await setup(current);
  await current.goto(preview.baseURL + '/home/', { waitUntil: options.settleNetwork === false ? 'domcontentloaded' : 'load' });
  if (options.waitReady !== false) await ready();
  if (options.settleNetwork !== false) await current.waitForLoadState('networkidle');
  return current;
}
const state = () => current.evaluate(() => ShoreQA.state());
const stored = () => current.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
const call = (method, ...args) => current.evaluate(([m, a]) => ShoreQA[m](...a), [method, args]);
const ready = () => current.waitForFunction(() => window.ShoreQA && typeof ShoreQA.ready === 'function' && ShoreQA.ready(), null, { timeout: 15000 });
const nav = (...keys) => call('nav', keys);
async function act(action) { const result = await call('activate', action); if (result === null || result === false) throw Error('Action unavailable: ' + action); return result; }
async function scene(name) { await call('scene', name); await current.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function look(patch) { await call('look', patch); await ready(); }
async function group(name) {
  await scene('settings'); await act('settings.group.' + name);
  await current.waitForFunction(expected => ShoreQA.state().settingsGroup === expected, name);
}
const settingsSnapshot = () => current.evaluate(() => {
  const s = ShoreQA.state();
  const rendered = [...document.getElementById('stage').classList].filter(c => /^(bg|l|a|u|f|m|font)-/.test(c)).sort();
  return { stored: localStorage.getItem('cleantv.home.v1'), committed: s.committed, shown: s.shown, rendered, writes: s.writes, storageAttempts: window.__storageAttempts };
});
const choice = (axis, value) => act('choice.' + axis + '.' + value);
const radios = () => current.evaluate(() => [...document.querySelectorAll('#stage [role="radio"]')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map(e => ({ action: e.getAttribute('data-action'), checked: e.getAttribute('aria-checked'), disabled: e.getAttribute('aria-disabled') === 'true', focused: e.classList.contains('is-focus'), text: e.textContent.trim() })));
async function focusedChoice() {
  const action = (await state()).focusAction;
  return (await radios()).find(r => r.action === action);
}
async function unselectedChoice() {
  for (const direction of ['right', 'right', 'down', 'left', 'left', 'down', 'right', 'right', 'down']) {
    await nav(direction);
    const radio = await focusedChoice();
    if (radio && radio.checked === 'false' && !radio.disabled) return radio;
  }
  throw Error('Remote could not reach an unselected choice');
}
async function walkEnabledChoices() {
  const visited = [];
  for (const direction of ['down', 'down', 'right', 'right', 'up', 'left', 'left', 'down', 'down', 'up', 'up']) {
    await nav(direction);
    const focus = await current.evaluate(() => {
      const action = ShoreQA.state().focusAction;
      const el = [...document.querySelectorAll('#stage [data-action]')].find(e => e.getAttribute('data-action') === action && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      return { action, exists: !!el, disabled: el?.getAttribute('aria-disabled') === 'true', count: ShoreQA.where().focusCount };
    });
    visited.push(focus.action);
    if (!focus.exists || focus.disabled || focus.count !== 1) throw Error('Remote ' + direction + ' focused an unavailable choice: ' + JSON.stringify(focus));
  }
  return visited;
}
async function wallpaper() {
  await group('background'); await act('background.wallpaper');
  await current.waitForFunction(() => ShoreQA.state().view === 'wallpaper' && ShoreQA.state().settingsGroup === 'wallpaper');
}
const wallpaperSettled = id => current.waitForFunction(expected => !ShoreQA.state().pending && ShoreQA.state().shown.wall === expected, id);
const wallpaperRowVisible = id => current.waitForFunction(expected => {
  const list = document.querySelector('.wallpaper-list'), row = document.querySelector('[data-action="wallpaper.choose.' + expected + '"]');
  if (!list || !row || getComputedStyle(row).visibility === 'hidden') return false;
  const bounds = list.getBoundingClientRect(), r = row.getBoundingClientRect();
  return r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1;
}, id);
const wallpaperSaved = () => current.evaluate(() => {
  const s = ShoreQA.state(), bg = document.getElementById('sheetBg'), veil = document.querySelector('.sheet-veil');
  const bgStyle = getComputedStyle(bg), veilStyle = getComputedStyle(veil);
  return { stored: localStorage.getItem('cleantv.home.v1'), committed: s.committed, writes: s.writes, attempts: window.__storageAttempts,
    backdrop: { src: bg.currentSrc || bg.src, opacity: bgStyle.opacity, filter: bgStyle.filter, veil: veilStyle.background, veilOpacity: veilStyle.opacity } };
});
const wallpaperApplied = () => current.locator('.wallpaper-choice[aria-checked="true"]').evaluateAll(elements => elements.map(e => e.getAttribute('data-action')));
const wallpaperBundle = () => current.evaluate(() => Object.fromEntries(['photo', 'matImg', 'phFieldImg', 'phFieldImgAlt', 'utFieldImg', 'utFieldImgAlt'].map(id => [id, document.getElementById(id).currentSrc || document.getElementById(id).src])));
const previewFrame = () => current.evaluate(() => {
  const e = document.getElementById('scene'), r = e.getBoundingClientRect(), css = getComputedStyle(e);
  return { x: r.x, y: r.y, width: r.width, height: r.height, radius: css.borderRadius, transform: css.transform };
});
const wallpaperListGeometry = () => current.evaluate(() => {
  const list = document.querySelector('.wallpaper-list'), bounds = list.getBoundingClientRect(), rows = [...list.querySelectorAll('.wallpaper-choice')];
  const fullyVisible = [], partlyVisible = [], clippedParts = [];
  rows.forEach(row => {
    const r = row.getBoundingClientRect(), action = row.getAttribute('data-action');
    const visible = getComputedStyle(row).visibility !== 'hidden';
    if (visible && r.bottom > bounds.top + 1 && r.top < bounds.bottom - 1) partlyVisible.push(action);
    if (visible && r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1) fullyVisible.push(action);
    const parts = [...row.querySelectorAll('.setting-name, .setting-tick svg')].map(e => e.getBoundingClientRect());
    if (parts.some(p => p.x < r.x - 1 || p.right > r.right + 1 || p.y < r.y - 1 || p.bottom > r.bottom + 1)) clippedParts.push(action);
    const name = row.querySelector('.setting-name'), tick = row.querySelector('.setting-tick svg');
    if (name && tick && name.getBoundingClientRect().right > tick.getBoundingClientRect().left + 1) clippedParts.push(action);
  });
  return { fullyVisible, partlyVisible, clippedParts, focus: ShoreQA.state().focusAction, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, top: ShoreQA.state().wallpaperPicker.top };
});
async function editor() { await scene('settings'); await act('settings.editor'); await current.waitForFunction(() => document.querySelector('[data-action^="editor.move."]')); await current.waitForFunction(() => !ShoreQA.state().catalog.loading); }
async function remove(id) { await act('editor.move.' + id); await nav('back', 'right', 'ok'); }
async function library() { await scene('home'); await act('util.apps'); await current.waitForFunction(() => !ShoreQA.state().catalog.loading); }
async function noLiveFilters() {
  return current.evaluate(() => [...document.querySelectorAll('#stage, #stage *')].filter(e => e.getClientRects().length).map(e => {
    const s = getComputedStyle(e); return { tag: e.tagName, cls: e.className, filter: s.filter, backdrop: s.backdropFilter || s.webkitBackdropFilter || 'none' };
  }).filter(s => /blur|url\(/.test(s.filter) || s.backdrop !== 'none'));
}

try {
  preview = await openPreview();
  await run('Legacy preference migration', async () => {
    for (const theme of ['list', 'shore', 'grid']) {
      await page({ seed: baseline({ theme, dock: ['youtube', 'netflix'], wallpaper: walls[1].id, lastApp: 'youtube', mode: '15' }) });
      const s = await state();
      check(theme + ' preserves order, wallpaper and rotation', same(s.dock, ['youtube', 'netflix']) && s.wallpaper === walls[1].id && s.mode === '15' && s.lastApp === 'youtube', s);
      check(theme + ' maps to intended two-layout appearance', s.look.layout === (theme === 'list' ? 'list' : 'dock') && s.look.bg === (theme === 'list' ? 'dark' : 'photo'), s.look);
      await closePage();
    }
    await page({ seed: undefined, legacy: baseline({ theme: 'list', dock: ['netflix'], lastApp: 'netflix' }) });
    check('Old shore key is read', (await state()).dock.length === 1 && (await state()).look.layout === 'list');
    await look({ controls: 'text' });
    check('Next completed edit writes stable home key', (await stored()).dock[0] === 'netflix');
    await current.reload(); await ready();
    check('Migrated preferences survive reload', (await state()).look.controls === 'text' && (await state()).dock[0] === 'netflix');
    await closePage();
    const previous = baseline({ theme: 'list', dock: ['youtube'], lastApp: 'youtube' });
    await page({ seed: undefined, previous });
    check('Previous cleanframe.home.v1 key is read', same((await state()).dock, ['youtube']) && (await state()).look.layout === 'list');
    await look({ controls: 'text' });
    check('Next edit writes cleantv.home.v1 and keeps the previous key', (await stored()).dock[0] === 'youtube' && await current.evaluate(text => localStorage.getItem('cleanframe.home.v1') === text, JSON.stringify(previous)));
    await current.reload(); await ready();
    check('Preferences migrated from cleanframe.home.v1 survive reload', (await state()).look.controls === 'text' && (await state()).dock[0] === 'youtube');
  });
  await run('Invalid preferences and saved native pins', async () => {
    await page({ seed: '{broken', legacy: baseline({ dock: ['netflix'], lastApp: 'netflix' }) });
    check('Malformed primary recovers valid legacy key', same((await state()).dock, ['netflix']));
    await closePage();
    await page({ seed: { dock: [], wallpaper: 'missing', mode: 'constructor', theme: 'constructor' } });
    const s = await state();
    check('Invalid values recover usable bounded Home', s.dock.length >= 1 && s.dock.length <= 9 && walls.some(w => w.id === s.wallpaper) && ['fixed', 'open', '5', '15', '60'].includes(s.mode), s);
    await closePage();
    await page({ seed: baseline({ dock: [EXTRA, 'netflix'], lastApp: EXTRA }), catalogFailure: true });
    await library();
    check('Discovery failure preserves saved native pin', (await state()).dock.includes(EXTRA));
  });
  await run('Startup fallbacks remain usable', async () => {
    await page({ noFontAPI: true });
    check('Missing font-loading API has usable baseline Home', (await state()).look.font === 'manrope' && (await call('where')).focusCount === 1);
    await closePage();
    await page({ seed: baseline({ mode: 'open' }), storageFailure: true });
    check('Failed open-mode write retains prior photo', (await state()).wallpaper === walls[0].id && (await stored()).wallpaper === walls[0].id);
  });
  await run('Font recovery invalidates fallback measurements', async () => {
    const seed = baseline({ dock: ['sbs', 'netflix'], lastApp: 'sbs', look: { bg: 'photo', layout: 'list', apps: 'both', font: 'manrope', controls: 'both', focus: 'glass', material: 'soft' } });
    const geometry = () => current.evaluate(() => ({
      plate: document.querySelector('#phScene > .ph-plate.is-current').style.width,
      names: [...document.querySelectorAll('.ph-name')].map(e => ({ text: e.textContent, size: e.style.fontSize, top: e.style.top }))
    }));
    await page({ seed });
    const expected = await geometry();
    await closePage();
    let releaseFont, requests = 0;
    const fontGate = new Promise(resolve => { releaseFont = resolve; });
    await page({ seed, settleNetwork: false }, p => p.route('**/assets/manrope.woff2', async route => {
      requests++; await fontGate; await route.continue();
    }));
    check('Slow baseline font keeps Home usable', (await state()).fonts.baselineFallback && (await call('where')).focusCount === 1 && requests > 0);
    releaseFont();
    await current.waitForFunction(() => !ShoreQA.state().fonts.baselineFallback && ShoreQA.state().fonts.loaded.includes('manrope'));
    check('Recovered font restores normal label and focus geometry', same(await geometry(), expected), { expected, actual: await geometry() });
  });
  await run('Hidden boot installs a complete wallpaper without animation frames', async () => {
    await page({ initiallyHidden: true, pauseHiddenFrames: true, rejectDecode: true });
    const before = await stored();
    check('Hidden startup settles with every wallpaper image loaded', await current.evaluate(() => document.hidden && ['photo', 'matImg', 'phFieldImg', 'utFieldImg'].every(id => {
      const image = document.getElementById(id); return image.complete && image.naturalWidth > 0;
    })));
    await current.evaluate(() => window.__setHidden(false)); await ready();
    check('Showing the launcher keeps the same saved appearance', same(await stored(), before) && (await call('where')).focusCount === 1);
    await closePage();
    await page({ rejectDecode: true });
    check('A valid loaded image survives a visible decode rejection', (await state()).shown.wall === (await state()).wallpaper && !(await state()).pending);
  });
  await run('Hidden boot retries failed assets on becoming visible', async () => {
    let failImages = true;
    await page({ initiallyHidden: true, pauseHiddenFrames: true, waitReady: false, settleNetwork: false }, async p => {
      p.__expectedFailures.push('/assets/materials/');
      await p.route('**/assets/materials/*', route => failImages ? route.abort('failed') : route.continue());
    });
    await current.waitForFunction(() => window.ShoreQA && !ShoreQA.state().pending && !ShoreQA.ready());
    const before = await stored();
    failImages = false;
    await current.evaluate(() => window.__setHidden(false)); await ready();
    check('Visible retry restores a complete wallpaper without a preference write', same(await stored(), before) && await current.evaluate(() => document.getElementById('photo').naturalWidth > 0));
  });
  await run('Visibility return preserves an unapplied wallpaper preview', async () => {
    await page(); await wallpaper(); await nav('down'); await wallpaperSettled(walls[1].id);
    const before = await wallpaperBundle(), saved = await wallpaperSaved();
    await current.evaluate(() => { window.__setHidden(true); window.__setHidden(false); });
    check('Returning retains the preview and saved choice', same(await wallpaperBundle(), before) && same(await wallpaperSaved(), saved) && (await state()).wallpaperPicker.candidate === walls[1].id);
  });
  await run('Chromium 85 layout without inset shorthand', async () => {
    await page({}, p => p.route('**/style.css', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(/([;{])inset:0(?=[;}])/g, '$1') });
    }));
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
      await current.setViewportSize(viewport);
      for (const layout of ['dock', 'list']) {
        await look({ layout, focus: 'glass' }); await scene('home');
        const labels = await current.locator(layout === 'dock' ? '.tile-content' : '.ph-name').evaluateAll(elements => elements.filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().width));
        check(layout + ' labels retain width at ' + viewport.width, labels.length > 0 && labels.every(width => width > 0), labels);
        await nav(layout === 'dock' ? 'up' : 'right');
        await current.waitForTimeout(240);
        check('Utility focus and rounded lens align at ' + viewport.width + ' in ' + layout, await current.evaluate(() => {
          const button = document.querySelector('.u.is-focus'), lens = document.querySelector('.ut-lens.is-current');
          return ShoreQA.where().focusCount === 1 && button && lens && Math.abs(button.getBoundingClientRect().top - lens.getBoundingClientRect().top) < 4;
        }));
        await current.screenshot({ path: out + 'compat-' + layout + '-' + viewport.width + '.png' });
        await group('background');
        check('Appearance keeps full stage bounds at ' + viewport.width + ' in ' + layout, await current.locator('.appearance').evaluate(e => {
          const r = e.getBoundingClientRect(), stage = document.getElementById('stage').getBoundingClientRect();
          return Math.abs(r.width - stage.width) < 1 && Math.abs(r.height - stage.height) < 1;
        }));
        await library();
        check('All apps content keeps its width at ' + viewport.width + ' in ' + layout, await current.locator('.gt .panel-content').evaluateAll(elements => elements.length > 0 && elements.every(e => e.getBoundingClientRect().width > 0)));
      }
    }
  });
  await run('Utility control geometry', async () => {
    await page();
    for (const width of [1920, 1280]) {
      await current.setViewportSize({ width, height: width * 9 / 16 });
      for (const layout of ['dock', 'list']) for (const controls of ['icons', 'both', 'text']) {
        await look({ bg: 'photo', layout, controls, focus: 'glass', font: 'manrope' }); await scene('home');
        if ((await call('where')).zone === 'util') await nav('back');
        await nav(layout === 'dock' ? 'up' : 'right');
        await nav(...Array(3).fill(layout === 'dock' ? 'left' : 'up'));
        await current.waitForTimeout(180);
        const spacing = await current.evaluate(({ layout, controls }) => {
          const scale = document.getElementById('stage').getBoundingClientRect().width / 1920;
          return [...document.querySelectorAll('#utils .u')].map(button => {
            const content = button.querySelector('.u-content');
            const children = [...content.children].filter(e => getComputedStyle(e).display !== 'none');
            const visibleWidth = children.reduce((sum, e) => sum + e.getBoundingClientRect().width / scale, 0);
            const gap = controls !== 'both' ? 0 : layout === 'dock' ? 10 : button.dataset.action === 'util.settings' ? 18.9 : 17.9;
            return { action: button.dataset.action, children: children.length, extraWidth: content.getBoundingClientRect().width / scale - visibleWidth, gap };
          });
        }, { layout, controls });
        check(layout + '/' + controls + ' uses spacing between visible children at ' + width,
          spacing.length === 3 && spacing.every(s => s.children === (controls === 'both' ? 2 : 1) && Math.abs(s.extraWidth - s.gap) < .5), spacing);
        const focused = [];
        for (let i = 0; i < 3; i++) {
          if (i) await nav(layout === 'dock' ? 'right' : 'down');
          focused.push(await current.evaluate(() => {
            const button = document.querySelector('#utils .u.is-focus'), lens = document.querySelector('.ut-lens.is-current');
            if (!button || !lens || ShoreQA.where().focusCount !== 1) return false;
            const bounds = lens.getBoundingClientRect();
            const content = [...button.querySelector('.u-content').children].filter(e => getComputedStyle(e).display !== 'none');
            const caption = document.querySelector('.util-focus-label.is-on');
            if (caption && ShoreQA.state().look.layout === 'list') content.push(caption);
            return content.every(e => { const r = e.getBoundingClientRect(); return r.left >= bounds.left - 1 && r.right <= bounds.right + 1 && r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1; });
          }));
        }
        check(layout + '/' + controls + ' keeps each focused control inside its lens at ' + width, focused.every(Boolean), focused);
      }
    }
  });
  await run('Panel spacing geometry', async () => {
    await page();
    for (const width of [1920, 1280]) {
      await current.setViewportSize({ width, height: width * 9 / 16 });
      await look({ layout: 'dock', focus: 'glass' }); await editor();
      const divider = await current.locator('.ed-order-break.is-on').evaluate(e => {
        const scale = document.getElementById('stage').getBoundingClientRect().width / 1920;
        const text = document.createRange(); text.selectNodeContents(e);
        const after = getComputedStyle(e, '::after');
        return (e.getBoundingClientRect().right - text.getBoundingClientRect().right) / scale - parseFloat(after.width);
      });
      check('Editor divider separates its text and line at ' + width, Math.abs(divider - 16) < .5, divider);
      await scene('home'); await nav('back');
      const actions = await current.locator('.msg-acts>button').evaluateAll(elements => {
        const scale = document.getElementById('stage').getBoundingClientRect().width / 1920;
        return elements.length === 2 ? (elements[1].getBoundingClientRect().left - elements[0].getBoundingClientRect().right) / scale : null;
      });
      check('Leave actions retain their separation at ' + width, actions !== null && Math.abs(actions - 12) < .5, actions);
      await scene('settings');
      const groups = await current.locator('.settings-group').evaluateAll(elements => {
        const scale = document.getElementById('stage').getBoundingClientRect().width / 1920;
        return elements.map(e => (e.querySelector('.ico').getBoundingClientRect().left - e.querySelector('.settings-group-copy').getBoundingClientRect().right) / scale);
      });
      check('Settings group arrows stay separate from their copy at ' + width, groups.length === 9 && groups.every(gap => gap >= 31.5), groups);
      await wallpaper();
      const caption = await current.locator('.wallpaper-preview-name').evaluate(e => {
        const scale = document.getElementById('stage').getBoundingClientRect().width / 1920;
        return (e.children[1].getBoundingClientRect().left - e.children[0].getBoundingClientRect().right) / scale;
      });
      check('Wallpaper name and count retain their separation at ' + width, Math.abs(caption - 24) < .5, caption);
    }
  });
  await run('Real catalogue and native launch boundary', async () => {
    await page(); await library();
    const names = await current.locator('[data-action^="apps.open."] .label').allTextContents();
    check('Consumer catalogue excludes services, self and duplicate YouTube', names.length === 12 && names.filter(n => n === 'YouTube').length === 1 && !names.includes('CleanFrame') && !names.includes('Background worker'), names);
    check('Installed names stay text, including HTML punctuation', names.includes(UNSAFE_NAME) && !(await current.evaluate(() => window.__catalogXss)));
    check('Exploration fixtures do not appear', !names.includes('Plex') && !names.includes('Jellyfin'));
    await act('apps.open.' + SPOTIFY); await current.waitForFunction(() => __tv.calls.length > 0);
    check('Extra-brand app launches native ID', (await current.evaluate(() => __tv.calls.at(-1))).id === SPOTIFY);
    await current.evaluate(() => window.dispatchEvent(new Event('focus')));
    await scene('home'); await act('home.app.netflix'); await current.waitForFunction(() => __tv.calls.length === 2);
    check('Primary app keeps verified target', (await current.evaluate(() => __tv.calls.at(-1))).id === IDS[1]);
    await current.evaluate(() => window.dispatchEvent(new Event('focus')));
    await act('util.art'); await current.waitForFunction(() => __tv.calls.length === 3);
    const art = await current.evaluate(() => __tv.calls.at(-1));
    check('Art Mode uses app-control with fullscreen request', art.method === 'launchAppControl' && art.id === 'org.tizen.art-app' && art.control.data.some(d => d.key === 'mode' && d.value[0] === 'fullscreen'), art);
    await current.evaluate(() => window.dispatchEvent(new Event('focus'))); await group('samsung'); await act('samsung.home');
    await current.waitForFunction(() => __tv.calls.length === 4);
    check('Samsung escape keeps CSFS target', (await current.evaluate(() => __tv.calls.at(-1))).id === 'com.samsung.tv.csfs');
    await current.evaluate(() => window.dispatchEvent(new Event('focus'))); await group('samsung'); await act('samsung.settings');
    await current.waitForFunction(() => __tv.calls.length === 5);
    check('TV settings keeps installed target', (await current.evaluate(() => __tv.calls.at(-1))).id === 'com.samsung.tv.coba.setting');
    await current.evaluate(() => { window.dispatchEvent(new Event('focus')); __tv.launchFailure = true; });
    await scene('home'); await act('home.app.netflix'); await current.waitForFunction(() => ShoreQA.where().view === 'message');
    check('Launch failure is shown', /could not|unavailable|try again/i.test(await current.locator('#stage').innerText()));
  });
  await run('Independent app identity self-filter', async () => {
    const appId = 'AbCdEf1234.MyHome';
    await page({ currentAppId: appId, catalog: CATALOG.filter(a => a.id !== 'nClrkHome1.FrameHome').concat({ id: appId, name: 'Family Home', show: true }) });
    await library();
    const independent = await state();
    const names = await current.locator('[data-action^="apps.open."] .label').allTextContents();
    check('Independent build excludes its actual application ID', independent.catalog.ids.includes(EXTRA) && !independent.catalog.ids.includes(appId) && !names.includes('Family Home'));
    await closePage();
    await page();
    await current.evaluate(() => { delete tizen.application.getCurrentApplication; });
    await library();
    const fallback = await state();
    check('Unavailable current-app API keeps reference identity fallback', fallback.catalog.ids.includes(EXTRA) && !fallback.catalog.ids.includes('nClrkHome1.FrameHome'));
  });
  await run('Catalogue failure and retry', async () => {
    await page({ catalogFailure: true }); await library();
    check('Catalogue failure leaves Home intact', same((await state()).dock, PRIMARY));
    await current.evaluate(() => { __tv.catalogFailure = false; }); await act('apps.retry');
    await current.waitForSelector('[data-action="apps.open.' + EXTRA + '"]');
    check('Retry displays real installed names', (await current.locator('[data-action^="apps.open."]').count()) === 12);
  });
  await run('Native icon and failed-image fallback', async () => {
    await page({ catalog: CATALOG.map(a => a.id === EXTRA ? { ...a, iconPath: '/home/assets/icons/netflix.svg' } : a) });
    await library();
    await current.waitForFunction(id => { const row = document.querySelector('[data-action="apps.open.' + id + '"]'); const img = row && row.querySelector('img'); return img && img.complete && img.naturalWidth > 0; }, EXTRA);
    check('Unbranded installed app uses its native icon', await current.evaluate(id => { const img = document.querySelector('[data-action="apps.open.' + id + '"] img'); return img && getComputedStyle(img).display !== 'none' && img.parentNode.classList.contains('has-native-icon'); }, EXTRA));
    current.__expectedFailures.push('/missing-native-icon.png');
    await current.evaluate(id => { __tv.catalog.find(a => a.id === id).iconPath = '/home/assets/icons/missing-native-icon.png'; }, EXTRA);
    await library();
    await current.waitForFunction(id => { const img = document.querySelector('[data-action="apps.open.' + id + '"] img'); return img && img.src.includes('/missing-native-icon.png') && img.complete; }, EXTRA);
    const fallback = await current.evaluate(id => {
      const row = document.querySelector('[data-action="apps.open.' + id + '"]'), mark = row.querySelector('.native-icon'), img = mark && mark.querySelector('img');
      return { html: row.innerHTML, src: img && img.src, imageDisplay: img && getComputedStyle(img).display, initialsVisibility: mark && getComputedStyle(mark.firstChild).visibility, complete: img && img.complete, width: img && img.naturalWidth, text: row.textContent };
    }, EXTRA);
    check('Failed native icon leaves readable initials and app name', fallback.imageDisplay === 'none' && fallback.initialsVisibility === 'visible' && fallback.text.includes('Family'), fallback);
  });
  await run('Catalogue response after closing and reopening', async () => {
    await page();
    await current.evaluate(() => { __tv.holdCatalog = true; });
    await act('util.apps'); await nav('back'); await act('util.apps');
    const count = await current.evaluate(() => __tv.pending.length);
    check('Concurrent catalogue entry is coalesced', count === 1, count);
    await current.evaluate(() => { __tv.holdCatalog = false; __tv.pending.shift().ok(__tv.catalog); });
    await current.waitForFunction(() => !ShoreQA.state().catalog.loading);
    check('Delayed catalogue safely fills reopened view', (await call('where')).view === 'apps' && (await state()).catalog.ids.includes(EXTRA) && (await call('where')).focusCount === 1);
  });
  await run('Immediate edits, undo, move cancellation and limits', async () => {
    await page(); await editor();
    const start = (await state()).dock;
    await remove('netflix');
    check('Remove persists membership and keeps installation', !(await stored()).dock.includes('netflix') && (await current.evaluate(() => __tv.catalog.some(a => a.id === 'org.tizen.netflix-app'))));
    check('Focus follows removal into addable apps', (await state()).focusAction === 'editor.add.netflix', (await state()).focusAction);
    await nav('ok'); check('Second OK restores same position', same((await stored()).dock, start));
    await remove('netflix'); await act('editor.undo'); check('Undo persists previous membership', same((await stored()).dock, start));
    await act('editor.move.netflix'); await nav('down'); check('Unfinished move does not write', same((await stored()).dock, start));
    await nav('back'); check('Back cancels unfinished move', same((await state()).dock, start));
    await act('editor.move.netflix'); await nav('down', 'ok');
    const moved = start.slice(); [moved[1], moved[2]] = [moved[2], moved[1]];
    check('Placed move persists immediately', same((await stored()).dock, moved));
    await act('editor.add.' + EXTRA); check('Nine-app cap prevents addition', (await state()).dock.length === 9 && !(await state()).dock.includes(EXTRA));
    await remove('stremio'); await act('editor.add.' + EXTRA);
    check('Native app can be pinned with stable ID', (await stored()).dock.includes(EXTRA) && (await state()).dock.length === 9);
    check('Native pin retains readable metadata for failed discovery', (await stored()).appRecords.some(a => a.id === EXTRA && a.name === UNSAFE_NAME));
    await current.reload(); await ready(); check('Native pin survives reload', (await state()).dock.includes(EXTRA));
    await editor(); const ids = (await state()).dock;
    for (const id of ids.slice(1)) await remove(id);
    await remove(ids[0]); check('Last Home app cannot be removed', same((await state()).dock, [ids[0]]) && same((await stored()).dock, [ids[0]]));
    check('Editor has no Save action', !(await current.locator('#stage').innerText()).match(/\bSave\b/));
  });
  await run('Actual storage failures are atomic', async () => {
    await page(); await editor(); const before = await stored();
    await current.evaluate(() => { window.__failWrites = true; }); await remove('netflix');
    check('Failed removal changes neither committed state nor storage', same((await state()).dock, before.dock) && same(await stored(), before));
    check('Failed write gives visible feedback', /not saved|couldn.t save|tries again/i.test(await current.locator('#stage').innerText()));
    await current.evaluate(() => { window.__failWrites = false; }); await nav('ok');
    check('Retry commits through same action', !(await stored()).dock.includes('netflix'));
    await scene('home'); const old = await state(), oldStored = await stored();
    await current.evaluate(() => { window.__failWrites = true; }); await call('look', { bg: old.look.bg === 'light' ? 'dark' : 'light' });
    await current.waitForFunction(() => !ShoreQA.state().pending);
    check('Failed appearance write keeps display and preferences', (await state()).look.bg === old.look.bg && same(await stored(), oldStored));
  });
  await run('Appearance axes, fonts, scaling and matching materials', async () => {
    await page();
    for (const bg of ['dark', 'light', 'photo']) for (const layout of ['list', 'dock']) for (const focus of ['type', 'glass']) {
      await look({ bg, layout, focus }); const s = await state();
      check('Independent axes ' + [bg, layout, focus].join('/'), s.look.bg === bg && s.look.layout === layout && s.look.focus === focus && s.shown.bg === bg, s.look);
    }
    for (const axis of ['apps', 'controls']) for (const value of ['icons', 'both', 'text']) { await look({ [axis]: value }); check(axis + ' ' + value + ' persists', (await state()).look[axis] === value); }
    await look({ bg: 'photo', layout: 'dock', focus: 'glass', apps: 'both', controls: 'icons' });
    for (const material of ['soft', 'frost', 'tint']) { await look({ material }); check(material + ' matches displayed bundle', (await state()).shown.material === material && (await state()).look.material === material); }
    const fonts = (await state()).fonts.available; check('Font catalogue includes default', fonts.includes('manrope'));
    for (const font of fonts) {
      await look({ font }); check('Font ' + font + ' settles', (await state()).look.font === font && (await state()).shown.font === font);
      if (font === 'newsreader') {
        for (const layout of ['list', 'dock']) for (const controls of ['icons', 'both', 'text']) {
          await look({ layout, controls });
          const wrong = await current.evaluate(() => [...document.querySelectorAll('.home .clock, .home .u, .home .u-label, .home .ph-name, .home .tile .label, .home .app-focus-name, .home .util-focus-label, .home .wall-keep')].filter(e => !/Newsreader/.test(getComputedStyle(e).fontFamily)).map(e => ({ cls: e.className, font: getComputedStyle(e).fontFamily })));
          check('Newsreader covers Home text ' + layout + '/' + controls, wrong.length === 0, wrong);
        }
      }
    }
    await look({ font: 'manrope' });
    for (const wall of walls) { await look({ wall: wall.id }); check('Wallpaper ' + wall.id + ' has matching bundle', (await state()).shown.wall === wall.id && (await state()).wallpaper === wall.id); }
    for (const layout of ['list', 'dock']) for (const width of [1920, 1280]) {
      await current.setViewportSize({ width, height: width * 9 / 16 }); await look({ layout });
      await current.waitForFunction(w => Math.abs(document.getElementById('stage').getBoundingClientRect().width - w) < 1, width);
      const g = await current.evaluate(() => { const b = document.getElementById('stage').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, focus: ShoreQA.where().focusCount }; });
      check(layout + ' fits ' + width + ' with one focus', Math.abs(g.x) < 1 && Math.abs(g.y) < 1 && Math.abs(g.width - width) < 1 && Math.abs(g.height - width * 9 / 16) < 1 && g.focus === 1, g);
      await current.screenshot({ path: out + 'production-' + layout + '-' + width + '.jpg', quality: 90 });
    }
    check('No live blur/backdrop filters', (await noLiveFilters()).length === 0, await noLiveFilters());
    check('No prototype lab controls in production', await current.evaluate(() => !document.querySelector('[data-lab], #lab, #side') && !document.querySelector('script[src*="prototype"]')));
    const before = (await state()).look; await current.reload(); await ready(); check('Appearance survives reload', same((await state()).look, before));
  });
  await run('Settings overview and visible choices', async () => {
    await page(); await scene('settings');
    const expected = ['settings.group.background', 'settings.group.layout', 'settings.group.typography', 'settings.group.focus', 'settings.editor', 'settings.group.samsung'];
    check('Overview has all six settings groups', same((await call('actions')).filter(a => expected.includes(a)).sort(), expected.slice().sort()));
    const specs = {
      background: { bg: ['dark', 'light', 'photo'] },
      layout: { layout: ['list', 'dock'], apps: ['icons', 'both', 'text'], controls: ['icons', 'both', 'text'] },
      typography: { font: (await state()).fonts.available },
      focus: { focus: ['type', 'glass'], material: ['soft', 'frost', 'tint'] }
    };
    for (const [name, axes] of Object.entries(specs)) {
      await group(name);
      const options = await radios(), committed = (await state()).committed;
      for (const [axis, values] of Object.entries(axes)) {
        const rows = options.filter(r => r.action?.startsWith('choice.' + axis + '.'));
        check(name + ' shows every ' + axis + ' choice together', same(rows.map(r => r.action).sort(), values.map(v => 'choice.' + axis + '.' + v).sort()), rows);
        check(axis + ' checked state identifies only the applied choice', same(rows.filter(r => r.checked === 'true').map(r => r.action), ['choice.' + axis + '.' + committed[axis]]), rows);
      }
      check(name + ' detail has no persistent category rail', !(await call('actions')).some(a => a.startsWith('settings.group.')));
      await nav('back');
      check(name + ' Back restores overview category focus', (await state()).view === 'settings' && (await state()).focusAction === 'settings.group.' + name, await call('where'));
    }
    await group('background');
    const backgroundActions = await call('actions');
    check('Photo tools are reachable from Background', backgroundActions.includes('background.wallpaper') && backgroundActions.includes('background.rotation'), backgroundActions);
    await act('background.rotation');
    const rotationRows = await radios();
    check('All five rotation modes are visible together', same(rotationRows.map(r => r.action).sort(), ['fixed', 'open', '5', '15', '60'].map(v => 'rotation.' + v).sort()), rotationRows);
    await nav('back');
    check('Rotation Back restores its Background row', (await state()).settingsGroup === 'background' && (await state()).focusAction === 'background.rotation', await call('where'));
    await group('samsung');
    const samsungActions = await call('actions');
    check('Samsung group shows both native actions', samsungActions.includes('samsung.home') && samsungActions.includes('samsung.settings'));
  });
  await run('Tizen add-ons: catalog, install, storage and settings', async () => {
    const BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/', CATALOG_URL = BASE + 'cleantv-catalog.json', sha = 'a'.repeat(64);
    const pkg = (id, extra) => ({ api: 1, id, name: 'Note ' + id, version: '1.0.0', kind: 'text', description: 'Short note', author: 'QA', license: 'MIT', text: 'Hello from ' + id, ...extra });
    const packages = { note: pkg('note'), plain: pkg('plain') };
    const listed = item => ({ ...item, path: 'packages/' + item.id + '/' + item.version + '.json', sha256: createHash('sha256').update(JSON.stringify(item)).digest('hex') });
    const upstream = [{ api: 1, id: 'spotify', name: 'Spotify', version: '1.0.0', kind: 'spotify', description: 'Player', author: 'QA', license: 'MIT', path: 'packages/spotify/1.0.0.json', sha256: sha },
      { api: 2, id: 'apple-remote', name: 'iPhone Remote', version: '0.1.2', kind: 'native', description: 'Remote', author: 'QA', license: 'MIT', sha256: sha }];
    let body = { api: 2, addons: upstream }, requests = 0, downloads = [], fail = false;
    const cors = { 'access-control-allow-origin': '*' };
    const serve = async p => {
      await p.route(CATALOG_URL, route => { requests++; return fail ? route.abort() : route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: JSON.stringify(body) }); });
      await p.route(BASE + 'packages/**', route => {
        const id = route.request().url().split('/').slice(-2)[0];
        downloads.push(id);
        return packages[id] ? route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: JSON.stringify(packages[id]) }) : route.fulfill({ status: 404, headers: cors, body: 'missing' });
      });
      // A tiny settings provider for "note" only, queued before main.js publishes the registry.
      await p.addInitScript(() => {
        const queue = window.CleanTVAddonSettings = { queue: [] };
        queue.register = function () { queue.queue.push(Array.prototype.slice.call(arguments)); };
        queue.register('note', {
          title: language => language === 'de' ? 'QA Notiz' : 'QA note settings',
          sections: () => [{ id: 'qa', title: 'QA <b>row</b>', horizontal: true, items: [
            { action: 'cleantv.qa.toggle', label: 'Bold', axis: 'qa', value: true, applied: !!window.__qaOn },
            { action: 'cleantv.qa.location', label: 'Change location' },
            { action: 'settings.back', label: 'Spoofed host action' }] }],
          ok: item => { if (item.action !== 'cleantv.qa.toggle') return false; window.__qaOn = !window.__qaOn; window.__qaOk = (window.__qaOk || 0) + 1; return true; }
        });
      });
    };
    const installed = id => current.waitForFunction(id => CleanFrameAddons.state().installed[id] && !CleanFrameAddons.state().busy, id);
    await page({}, serve);
    check('Startup sends no catalog or package request', requests === 0 && downloads.length === 0);
    const slot = await current.evaluate(() => { const el = document.getElementById('cleantvWidgets'); return { parent: el.parentElement.id, previous: el.previousElementSibling && el.previousElementSibling.id, inScene: !!el.closest('#phScene') }; });
    check('The widget slot follows the caption inside Home, outside the photo list', slot.parent === 'home' && slot.previous === 'caption' && !slot.inScene, slot);
    await scene('settings');
    check('Settings lists Add-ons when the TV host exists', (await call('actions')).includes('settings.group.addons'));
    current.__allowExternal = ['https://raw.githubusercontent.com'];
    await act('settings.group.addons'); await act('addon.tab.discover');
    check('Discover before a refresh asks for one', /Refresh the catalog/.test(await current.locator('#addonEmpty').textContent()) && requests === 0);
    await act('addon.refresh');
    // tizen-spotify.js registers the spotify kind, so the upstream Spotify entry is offered; the native one is not.
    await current.waitForFunction(() => CleanFrameAddons.state().catalogInfo.checked && document.querySelector('[data-action="addon.details.spotify"]'));
    const offered = await call('actions'), counted = await current.evaluate(() => CleanFrameAddons.state().catalogInfo);
    check('Refresh offers Spotify and skips the Android-only entry', requests === 1 && same(counted, { checked: true, total: 2, compatible: 1 }) && offered.includes('addon.details.spotify') && !offered.includes('addon.details.apple-remote'), { counted, offered });
    body = { api: 2, addons: upstream.concat([listed(packages.note), listed(packages.plain)]) };
    await act('addon.refresh');
    await current.waitForFunction(() => document.querySelector('[data-action="addon.details.note"]'));
    await act('addon.details.note');
    let actions = await call('actions');
    check('A compatible widget offers Download and no settings before installation', actions.includes('addon.install.note') && !actions.some(a => /^addon\.(settings|toggle|remove|setup)\./.test(a)), actions);
    await act('addon.install.note'); await installed('note');
    await current.waitForFunction(() => document.querySelector('[data-action="addon.settings.note"]'));
    actions = await call('actions');
    check('The verified package is installed once and its registered settings appear', downloads.join() === 'note' && actions.includes('addon.toggle.note') && actions.includes('addon.remove.note') && actions.includes('addon.settings.note') && !actions.includes('addon.install.note'), { downloads, actions });
    await act('addon.settings.note');
    let s = await state();
    const settingsView = await current.evaluate(() => ({ title: document.getElementById('appearanceTitle').textContent, heading: document.querySelector('#appearanceRows .setting-label')?.innerHTML, radio: document.querySelector('[data-action="cleantv.qa.toggle"]')?.getAttribute('aria-checked'), spoof: !!document.querySelector('#appearanceRows [data-action="settings.back"]') }));
    check('Add-on settings render through the appearance rows', s.settingsGroup === 'addon-settings' && settingsView.title === 'QA note settings' && settingsView.radio === 'false' && !settingsView.spoof && settingsView.heading === 'QA &lt;b&gt;row&lt;/b&gt;', settingsView);
    await act('cleantv.qa.toggle');
    check('OK reaches the provider and the row reflects its state', await current.evaluate(() => window.__qaOk === 1 && document.querySelector('[data-action="cleantv.qa.toggle"]').getAttribute('aria-checked') === 'true'));
    check('Provider choices never change Home preferences', !Object.prototype.hasOwnProperty.call((await stored()), 'qa'));
    const hint = () => current.locator('#appearanceDesc').innerText();
    check('A radio provider row hints that OK applies it', (await state()).focusAction === 'cleantv.qa.toggle' && /Apply selected setting/.test(await hint()), await hint());
    await nav('right');
    const opener = await current.evaluate(() => !!document.querySelector('[data-action="cleantv.qa.location"] .setting-forward'));
    check('A provider row without axis shows a chevron and the Open hint', (await state()).focusAction === 'cleantv.qa.location' && opener && /^OK\s*Open$/.test((await hint()).trim()), { focus: (await state()).focusAction, opener, hint: await hint() });
    await nav('back');
    s = await state();
    check('Back returns from add-on settings to the detail view', s.settingsGroup === 'addon-detail' && (await call('actions')).includes('addon.settings.note'), s.settingsGroup);
    await nav('back'); await act('addon.tab.discover'); await act('addon.details.plain'); await act('addon.install.plain'); await installed('plain');
    actions = await call('actions');
    check('An add-on without a registered provider has no settings button', actions.includes('addon.toggle.plain') && !actions.includes('addon.settings.plain'), actions);
    await nav('back'); await act('addon.details.note'); await act('addon.toggle.note');
    await current.waitForFunction(() => CleanFrameAddons.state().installed.note.enabled === false);
    check('A disabled add-on hides its settings button', !(await call('actions')).includes('addon.settings.note'));
    await act('addon.toggle.note');
    await current.waitForFunction(() => CleanFrameAddons.state().installed.note.enabled !== false);
    await scene('home');
    const cards = () => current.evaluate(() => [...document.querySelectorAll('#addonWidgets .addon-widget')].filter(e => e.getClientRects().length).map(e => e.getAttribute('data-addon') + ':' + e.querySelector('p').textContent));
    check('Installed widgets appear on Home', same(await cards(), ['note:Hello from note', 'plain:Hello from plain']), await cards());
    const keys = await current.evaluate(() => Object.keys(localStorage).sort());
    check('Only the add-on slots were added to storage', same(keys.filter(k => k !== 'cleantv.home.v1'), ['cleantv.addons.v1.a', 'cleantv.addons.v1.b']), keys);
    const before = requests;
    current.__allowExternal = [];
    await current.reload(); await ready(); await current.waitForLoadState('networkidle');
    check('Installed widgets survive a reload without network', requests === before && downloads.length === 2 && same(await cards(), ['note:Hello from note', 'plain:Hello from plain']), { requests, downloads });
    await scene('settings'); await act('settings.group.addons');
    actions = await call('actions');
    check('Installed add-ons are listed after the reload', actions.includes('addon.details.note') && actions.includes('addon.details.plain'), actions);
    await act('addon.tab.discover');
    const offline = await current.evaluate(() => CleanFrameAddons.state().catalogInfo);
    check('Discover shows the stored catalog offline', (await call('actions')).includes('addon.details.plain') && same(offline, { checked: true, total: 4, compatible: 3 }), offline);
    await act('addon.details.note');
    check('The settings button survives the reload', (await call('actions')).includes('addon.settings.note'));
    await nav('back');
    current.__allowExternal = ['https://raw.githubusercontent.com'];
    fail = true; current.__expectedFailures.push('raw.githubusercontent.com');
    await act('addon.refresh');
    await current.waitForFunction(() => /no connection/.test(document.getElementById('appearanceStatus')?.textContent || ''));
    check('A failed refresh keeps the stored catalog and names the cause', !!(await current.$('[data-action="addon.details.note"]')) && /no connection, certificate or access policy/.test(await current.locator('#appearanceStatus').textContent()));
  });
  await run('Tizen Spotify: QR sign-in, card, controls and reload', async () => {
    // Routed fakes for the catalog, the relay, accounts.spotify.com, api.spotify.com and i.scdn.co. Synthetic tokens only.
    const BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/', RELAY = 'https://cleantv-spotify.tobiaspsi96.workers.dev';
    const ACCOUNTS = 'https://accounts.spotify.com', API = 'https://api.spotify.com', IMAGES = 'https://i.scdn.co', COVER = IMAGES + '/image/ab67616d00001e02' + '5'.repeat(24);
    const UPSTREAM = '{"api":1,"id":"spotify","name":"Spotify","version":"1.0.0","kind":"spotify","description":"Spotify playback and account controls","author":"CleanFrame","license":"MIT"}\n';
    const entry = { ...JSON.parse(UPSTREAM), path: 'packages/spotify/1.0.0.json', sha256: createHash('sha256').update(UPSTREAM).digest('hex') };
    const PAIR = 'c0ffee' + '0'.repeat(26), cors = { 'access-control-allow-origin': '*' };
    const log = { catalog: 0, pair: [], polls: 0, token: [], player: 0, controls: [], preflights: [] };
    let approved = false, tvState = '', playingNow = true, refuse = false;
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    const preflight = route => { log.preflights.push(new URL(route.request().url()).origin); return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' } }); };
    const player = () => ({ device: { id: 'qa-device-1', is_active: true, is_restricted: false, name: 'QA speaker' }, progress_ms: 30000, is_playing: playingNow, actions: { disallows: {} },
      item: { type: 'track', name: 'QA Samsung track', duration_ms: 180000, artists: [{ name: 'QA Artist' }], album: { images: [{ url: COVER, width: 300, height: 300 }] } } });
    const serve = async p => {
      await p.route(BASE + 'cleantv-catalog.json', route => { log.catalog++; return route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: JSON.stringify({ api: 2, addons: [entry] }) }); });
      await p.route(BASE + 'packages/spotify/1.0.0.json', route => route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: UPSTREAM }));
      await p.route(url => url.origin === RELAY, route => {
        const r = route.request(), path = new URL(r.url()).pathname;
        if (r.method() === 'OPTIONS') return preflight(route);
        if (path === '/pair') { const body = JSON.parse(r.postData()); log.pair.push({ body, type: r.headers()['content-type'] }); tvState = body.state; return json(route, { id: PAIR, expiresIn: 600 }); }
        if (path === '/poll/' + PAIR) { log.polls++; const result = approved ? { code: 'qa-code-1', state: PAIR + '.' + tvState } : { pending: true }; approved = false; return json(route, result); }
        return json(route, { error: 'not_found' }, 404);
      });
      await p.route(url => url.origin === ACCOUNTS, route => {
        const r = route.request();
        if (r.method() === 'OPTIONS') return preflight(route);
        const body = Object.fromEntries(new URLSearchParams(r.postData() || ''));
        log.token.push({ body, type: r.headers()['content-type'], authorization: r.headers().authorization || '' });
        if (refuse && body.grant_type === 'refresh_token') return json(route, { error: 'invalid_client' }, 400);
        return json(route, { access_token: 'qa-access-' + log.token.length, token_type: 'Bearer', expires_in: 3600, scope: 'user-read-playback-state user-modify-playback-state', ...(body.grant_type === 'authorization_code' ? { refresh_token: 'qa-refresh-1' } : {}) });
      });
      await p.route(url => url.origin === API, route => {
        const r = route.request(), url = new URL(r.url());
        if (r.method() === 'OPTIONS') return preflight(route);
        if (url.pathname === '/v1/me/player') { log.player++; return json(route, player()); }
        log.controls.push({ method: r.method(), path: url.pathname, device: url.searchParams.get('device_id'), auth: r.headers().authorization });
        if (url.pathname === '/v1/me/player/pause') playingNow = false;
        return route.fulfill({ status: 204, headers: cors });
      });
      await p.route(url => url.origin === IMAGES, route => route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: readFileSync(root + 'app/icon.png') }));
    };
    const cardShown = () => current.waitForFunction(() => !document.getElementById('spotifyPlayer').hidden && document.getElementById('spotifyCompactTitle').textContent === 'QA Samsung track');
    const leaks = () => current.evaluate(() => {
      const values = Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]), slots = values.filter(([k]) => k.indexOf('cleantv.spotify.v1') === 0);
      return { keys: slots.map(v => v[0]).sort(), data: slots.map(v => JSON.parse(v[1]).data), stored: values.some(([, v]) => /qa-access|qa-code/.test(v)), state: /qa-access|qa-refresh|qa-code/.test(JSON.stringify(ShoreQA.state())) };
    });
    await page({}, serve);
    check('Startup contacts no catalog, relay or Spotify host', log.catalog === 0 && !log.pair.length && !log.token.length && !log.player);
    current.__allowExternal = ['https://raw.githubusercontent.com'];
    await scene('settings'); await act('settings.group.addons'); await act('addon.tab.discover'); await act('addon.refresh');
    await current.waitForFunction(() => document.querySelector('[data-action="addon.details.spotify"]'));
    await act('addon.details.spotify'); await act('addon.install.spotify');
    await current.waitForFunction(() => CleanFrameAddons.state().installed.spotify && !CleanFrameAddons.state().busy && document.querySelector('[data-action="group.spotify"]'));
    check('Spotify installs from the catalog and offers its settings', (await call('actions')).includes('group.spotify') && !log.token.length && !log.player);
    await act('group.spotify');
    let text = await current.locator('#appearanceRows').innerText(), actions = await call('actions');
    check('Samsung settings offer QR sign-in and Open Spotify, without Android media access', actions.includes('spotify.signin') && actions.includes('spotify.open') && !actions.includes('spotify.access')
      && /Not signed in/.test(text) && /Sign in with QR to show and control your playback/.test(text), { actions, text });
    current.__allowExternal = ['https://raw.githubusercontent.com', RELAY, ACCOUNTS, API, IMAGES];
    await act('spotify.signin');
    await current.waitForFunction(() => /^data:image\/png;base64,/.test(document.getElementById('spotifyPairQr')?.getAttribute('src') || '') && document.getElementById('spotifyPairQr').complete);
    const pair = log.pair[0];
    check('Pairing sends only the challenge, the TV state and the poll hash, as text/plain', log.pair.length === 1 && same(Object.keys(pair.body).sort(), ['challenge', 'pollHash', 'state'])
      && /^[A-Za-z0-9_-]{43}$/.test(pair.body.challenge) && /^[A-Za-z0-9_-]{22}$/.test(pair.body.state) && /^[a-f0-9]{64}$/.test(pair.body.pollHash) && /^text\/plain/.test(pair.type), pair.type);
    const qr = await current.evaluate(() => { const img = document.getElementById('spotifyPairQr'); return { natural: img.naturalWidth, shown: Math.round(img.getBoundingClientRect().width), status: document.querySelector('.addon-setup-status').innerText }; });
    check('The QR screen shows a drawn PNG, the labelled pairing code and the countdown', qr.natural >= 300 && qr.shown === 320 && /Code on your phone: C0FFEE · (10:00|9:5\d)/.test(qr.status) && /Scan the QR code/.test(qr.status), qr);
    approved = true;
    await current.waitForFunction(() => /Spotify is connected/.test(document.querySelector('.addon-setup-status')?.innerText || ''));
    const exchange = log.token[0];
    check('The TV polls the relay, then redeems the code with its verifier and no client secret', log.polls >= 1 && exchange.body.grant_type === 'authorization_code' && exchange.body.code === 'qa-code-1'
      && exchange.body.client_id === '6058b47c8aab44dd87826487377bdf6c' && exchange.body.redirect_uri === RELAY + '/callback' && !('client_secret' in exchange.body) && !exchange.authorization
      && createHash('sha256').update(exchange.body.code_verifier).digest('base64url') === pair.body.challenge && /^application\/x-www-form-urlencoded/.test(exchange.type), Object.keys(exchange.body));
    await nav('back');
    await current.waitForFunction(() => ShoreQA.state().settingsGroup === 'spotify');
    text = await current.locator('#appearanceRows').innerText();
    check('Settings report Account connected and enable Sign out', /Account connected/.test(text) && await current.locator('[data-action="spotify.signout"]').getAttribute('aria-disabled') !== 'true', text);
    await scene('home'); await cardShown();
    await current.waitForFunction(src => { const c = document.getElementById('spotifyCompactCover'); return c.getAttribute('src') === src && !c.hidden && c.complete && c.naturalWidth > 0; }, COVER);
    const card = await current.evaluate(() => ({ title: document.getElementById('spotifyTitle').textContent, artist: document.getElementById('spotifyCompactArtist').textContent, cover: document.getElementById('spotifyCover').getAttribute('src'), fallback: document.getElementById('spotifyCompactFallback').hidden, device: document.getElementById('spotifySource').textContent }));
    check('The Home card shows title, artist, device and the i.scdn.co cover', card.title === 'QA Samsung track' && card.artist === 'QA Artist' && card.cover === COVER && card.fallback && card.device === 'QA speaker', card);
    await current.keyboard.press('ArrowDown');
    check('Remote focus reaches Play/Pause', (await state()).focusAction === 'spotify.toggle', (await state()).focusAction);
    await current.keyboard.press('Enter');
    await current.waitForFunction(() => document.querySelector('[data-action="spotify.toggle"]').getAttribute('aria-label') === 'Play');
    check('Pause sends PUT /me/player/pause with device_id and the in-memory token', same(log.controls, [{ method: 'PUT', path: '/v1/me/player/pause', device: 'qa-device-1', auth: 'Bearer qa-access-1' }]), log.controls.map(c => c.path));
    await current.keyboard.press('ArrowUp'); await current.keyboard.press('Enter');
    await current.waitForFunction(() => __tv.calls.some(c => c.id === 'rJeHak5zRg.Spotify'));
    check('Open Spotify launches the Samsung Spotify app', (await current.evaluate(() => __tv.calls.slice(-1)[0])).id === 'rJeHak5zRg.Spotify');
    await current.evaluate(() => window.dispatchEvent(new Event('focus')));
    let stored = await leaks();
    check('Storage holds only the refresh token; no token or code in storage or QA state', same(stored.keys, ['cleantv.spotify.v1.a']) && same(stored.data, ['{"refreshToken":"qa-refresh-1"}']) && !stored.stored && !stored.state, stored.keys);
    const before = log.token.length;
    await current.reload(); await ready(); await cardShown();
    check('A reload stays linked: one refresh with the stored token, no new pairing', log.token.length === before + 1 && log.token[before].body.grant_type === 'refresh_token' && log.token[before].body.refresh_token === 'qa-refresh-1' && log.pair.length === 1);
    check('The reloaded card shows the paused state', await current.locator('[data-action="spotify.toggle"]').getAttribute('aria-label') === 'Play');
    // A refresh refused without invalid_grant keeps the stored token: as on Android, Sign out stays usable in reauth.
    refuse = true; current.__expectedFailures.push(ACCOUNTS + '/api/token'); await current.reload(); await ready();
    await current.waitForFunction(() => ShoreQA.state().spotify.webApi === 'reauth');
    await scene('settings'); await act('settings.group.addons'); await act('addon.details.spotify'); await act('group.spotify');
    text = await current.locator('#appearanceRows').innerText(); stored = await leaks();
    check('Reauth with a stored token keeps Sign out enabled', /Sign in to Spotify again/.test(text) && same(stored.keys, ['cleantv.spotify.v1.a'])
      && await current.locator('[data-action="spotify.signout"]').getAttribute('aria-disabled') !== 'true', text);
    refuse = false; current.__expectedFailures.splice(current.__expectedFailures.indexOf(ACCOUNTS + '/api/token'), 1);
    await current.reload(); await ready(); await cardShown();
    await scene('settings'); await act('settings.group.addons'); await act('addon.details.spotify'); await act('group.spotify');
    check('Account connected after the reload', /Account connected/.test(await current.locator('#appearanceRows').innerText()));
    await act('spotify.signout'); await act('message.signout');
    await current.waitForFunction(() => ShoreQA.state().spotify.webApi === 'unlinked');
    stored = await leaks();
    check('Sign out removes the stored sign-in', !stored.keys.length && /Not signed in/.test(await current.locator('#appearanceRows').innerText()), stored.keys);
    check('Preflights went only to the routed fakes', log.preflights.every(o => [RELAY, ACCOUNTS, API].includes(o)), log.preflights);
  });
  await run('Tizen Spotify: the TV app paused by CleanTV keeps its card', async () => {
    // Tizen pauses the Samsung Spotify app when CleanTV comes to the front; its Connect device then
    // vanishes (204). Routed fakes for accounts.spotify.com, api.spotify.com and i.scdn.co; a seeded sign-in.
    const ACCOUNTS = 'https://accounts.spotify.com', API = 'https://api.spotify.com', IMAGES = 'https://i.scdn.co', COVER = IMAGES + '/image/ab67616d00001e02' + '6'.repeat(24);
    const cors = { 'access-control-allow-origin': '*' }, PACKAGE = { api: 1, id: 'spotify', name: 'Spotify', version: '1.0.0', kind: 'spotify', description: 'Spotify playback and account controls', author: 'CleanFrame', license: 'MIT', enabled: true };
    const slot = data => { const json = JSON.stringify(data); return JSON.stringify({ v: 1, seq: 1, sum: createHash('sha256').update(json).digest('hex'), data: json }); };
    const seeds = { addons: slot({ installed: { spotify: PACKAGE }, catalog: [], catalogInfo: { checked: false, total: 0, compatible: 0 } }), token: slot({ refreshToken: 'qa-hold-refresh' }) };
    const log = { controls: [] }, live = { type: 'TV', gone: false };
    const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    const serve = async p => {
      p.__allowExternal = [ACCOUNTS, API, IMAGES];
      await p.addInitScript(s => { if (!sessionStorage.getItem('__spotifySeeded')) { localStorage.setItem('cleantv.addons.v1.a', s.addons); localStorage.setItem('cleantv.spotify.v1.a', s.token); sessionStorage.setItem('__spotifySeeded', '1'); } }, seeds);
      await p.route(url => url.origin === ACCOUNTS, route => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors })
        : json(route, { access_token: 'qa-hold-access', token_type: 'Bearer', expires_in: 3600, scope: 'user-read-playback-state user-modify-playback-state' }));
      await p.route(url => url.origin === API, route => {
        const r = route.request(), url = new URL(r.url());
        if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' } });
        if (url.pathname !== '/v1/me/player') { log.controls.push(r.method() + ' ' + url.pathname); return route.fulfill({ status: 204, headers: cors }); }
        if (live.gone) return route.fulfill({ status: 204, headers: cors });
        return json(route, { device: { id: 'qa-tv-1', is_active: true, is_restricted: false, name: 'QA Samsung TV', type: live.type }, progress_ms: 42000, is_playing: true, actions: { disallows: {} },
          item: { type: 'track', name: 'QA held track', duration_ms: 180000, artists: [{ name: 'QA Artist' }], album: { images: [{ url: COVER, width: 300, height: 300 }] } } });
      });
      await p.route(url => url.origin === IMAGES, route => route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: readFileSync(root + 'app/icon.png') }));
    };
    const card = () => current.evaluate(() => {
      const button = action => document.querySelector('[data-action="spotify.' + action + '"]'), source = document.getElementById('spotifySource');
      return { hidden: document.getElementById('spotifyPlayer').hidden, title: document.getElementById('spotifyCompactTitle').textContent,
        play: button('toggle').getAttribute('aria-label'), playDisabled: button('toggle').getAttribute('aria-disabled'), previous: button('previous').getAttribute('aria-disabled'), next: button('next').getAttribute('aria-disabled'),
        source: source.textContent, sourceHidden: source.hidden, compact: document.getElementById('spotifyCompact').getAttribute('aria-label'),
        position: document.getElementById('spotifyPosition').textContent, state: ShoreQA.state().spotify };
    });
    const launches = () => current.evaluate(() => __tv.calls.filter(c => c.method === 'launch' && c.id === 'rJeHak5zRg.Spotify').length);
    await page({}, serve);
    await current.waitForFunction(() => !document.getElementById('spotifyPlayer').hidden && document.getElementById('spotifyCompactTitle').textContent === 'QA held track' && ShoreQA.state().spotify.status === 'playing');
    let shown = await card();
    check('The TV device plays: a normal card without the held field', !('held' in shown.state) && shown.state.deviceName === 'QA Samsung TV' && shown.play === 'Pause' && shown.source === 'QA Samsung TV', shown);
    // The next poll (5 s while playing) finds the device gone.
    live.gone = true;
    await current.waitForFunction(() => ShoreQA.state().spotify.held === true, null, { timeout: 15000 });
    shown = await card();
    check('204 soon after CleanTV came to the front keeps the card as paused', !shown.hidden && shown.title === 'QA held track' && shown.state.status === 'paused' && shown.state.deviceName === 'QA Samsung TV'
      && same(shown.state.actions, { previous: false, toggle: true, next: false }), shown);
    check('The held card reads Continue in Spotify; previous and next are disabled', shown.play === 'Continue in Spotify' && shown.playDisabled === 'false' && shown.previous === 'true' && shown.next === 'true'
      && shown.source === 'Continue in Spotify' && !shown.sourceHidden && shown.compact === 'Continue in Spotify', shown);
    await current.waitForTimeout(1200);
    check('The held position stays still', (await card()).position === shown.position, shown.position);
    await current.keyboard.press('ArrowDown');
    await current.waitForFunction(() => document.getElementById('spotifyPlayer').classList.contains('is-expanded'));
    check('Remote focus reaches the held play button', (await state()).focusAction === 'spotify.toggle', (await state()).focusAction);
    await current.keyboard.press('Enter');
    await current.waitForFunction(() => __tv.calls.some(c => c.id === 'rJeHak5zRg.Spotify'));
    check('OK on the held play button launches rJeHak5zRg.Spotify, without a Web API request', await launches() === 1 && !log.controls.length, log.controls);
    // Once the card is compact again, OK opens Spotify at once instead of revealing the controls.
    await current.waitForFunction(() => !document.getElementById('spotifyPlayer').classList.contains('is-expanded'), null, { timeout: 6000 });
    await current.keyboard.press('Enter');
    await current.waitForFunction(() => __tv.calls.filter(c => c.id === 'rJeHak5zRg.Spotify').length === 2);
    check('OK on the compact held card launches Spotify too', await launches() === 2 && !log.controls.length && (await state()).spotify.held === true, log.controls);
    await current.keyboard.press('ArrowLeft'); await current.keyboard.press('ArrowRight');
    check('Previous and next never take the focus', (await state()).focusAction === 'spotify.toggle', (await state()).focusAction);
    await call('preferences', { language: 'de' });
    shown = await card();
    check('German: In Spotify fortsetzen', shown.play === 'In Spotify fortsetzen' && shown.source === 'In Spotify fortsetzen' && shown.compact === 'In Spotify fortsetzen', shown);
    await scene('settings'); await act('settings.group.addons'); await act('addon.details.spotify'); await act('group.spotify');
    check('German settings status: In Spotify fortsetzen', /In Spotify fortsetzen/.test(await current.locator('#appearanceRows').innerText()));
    await call('preferences', { language: 'en' }); await scene('home');
    check('Still held after the settings round trip', (await state()).spotify.held === true && (await card()).play === 'Continue in Spotify');
    // A phone that vanishes is not held: the card disappears as before.
    live.type = 'Smartphone'; live.gone = false;
    await current.reload(); await ready();
    await current.waitForFunction(() => ShoreQA.state().spotify.status === 'playing' && ShoreQA.state().spotify.deviceName === 'QA Samsung TV');
    live.gone = true;
    await current.waitForFunction(() => document.getElementById('spotifyPlayer').hidden && ShoreQA.state().spotify.status === 'idle', null, { timeout: 15000 });
    check('A Smartphone device that vanishes hides the card', !('held' in (await state()).spotify));
  });
  await run('CleanTV widget slot geometry, ink and glass', async () => {
    // A queued test widget and a queued view, registered before main.js loads.
    const setup = p => p.addInitScript(() => {
      const queued = name => { if (window[name]) return window[name]; const r = window[name] = { queue: [] }; r.register = function () { r.queue.push(Array.prototype.slice.call(arguments)); }; return r; };
      window.__widgetCalls = [];
      queued('CleanTVWidgets').register('qa', { order: 2, render: (el, ctx) => {
        window.__widgetCalls.push(ctx);
        if (window.__widgetEmpty) { el.innerHTML = ''; return; }
        if (!el.firstChild) el.innerHTML = '<span class="cw-title">QA weather</span><span class="cw-big">21°</span><span class="cw-small">Wind 12 km/h</span>' + window.CleanTVIcon('<circle cx="24" cy="24" r="10"/>', 40);
      } });
      queued('CleanTVWidgets').register('qa-first', { order: 1, render: el => { if (!el.firstChild) el.innerHTML = '<span class="cw-small">First</span>'; } });
    });
    await page({}, setup);
    await scene('home');
    const geometry = () => current.evaluate(() => {
      const slot = document.getElementById('cleantvWidgets'), cards = [...slot.children], visible = cards.filter(c => c.getClientRects().length);
      const r = slot.getBoundingClientRect(), clock = document.querySelector('.caption .clock').getBoundingClientRect(), u = document.getElementById('utils').getBoundingClientRect();
      const card = visible[visible.length - 1], field = card && card.querySelector('.cw-field'), img = card && card.querySelector('.cw-field img');
      const cs = card && getComputedStyle(card);
      return { order: cards.map(c => c.getAttribute('data-widget')).filter(id => /^qa/.test(id)), visible: visible.length, hidden: slot.hidden, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), clockRight: Math.round(clock.right), utilsBottom: Math.round(u.bottom),
        card: card && { left: card.offsetLeft + slot.offsetLeft, top: card.offsetTop + slot.offsetTop, width: card.offsetWidth, height: card.offsetHeight, transform: field.style.transform, src: img.getAttribute('src') || '', glass: getComputedStyle(card.querySelector('.cw-glass')).display, background: cs.backgroundColor, color: cs.color, shadow: cs.textShadow, padding: cs.padding, radius: cs.borderRadius },
        clockColor: getComputedStyle(document.querySelector('.caption .clock')).color, stage: document.getElementById('stage').className };
    });
    let g = await geometry();
    check('Widgets keep registration order by `order` and reuse their cards', same(g.order, ['qa-first', 'qa']) && g.visible === 2, g);
    check('Dock slot sits at left 140, top 260 below the clock and date', g.left === 140 && g.top === 260 && !g.hidden, g);
    check('Photo cards use the registered material field aligned to the stage', /assets\/materials\/.*-field-(blur|frost|clear)\.jpg$/.test(g.card.src) && g.card.glass === 'block' && new RegExp('^translate(3d)?\\(' + (-g.card.left) + 'px, ?' + (-g.card.top) + 'px').test(g.card.transform), g.card);
    check('Card contract: padding 20px 24px, radius 24px, clock ink and two-layer shadow', g.card.padding === '20px 24px' && g.card.radius === '24px' && g.card.color === g.clockColor && (g.card.shadow.match(/rgba?\(/g) || []).length === 2, g.card);
    const typeScale = await current.evaluate(() => ['cw-title', 'cw-big', 'cw-small'].map(c => { const s = getComputedStyle(document.querySelector('#cleantvWidgets .' + c)); return [c, s.fontSize, s.lineHeight, s.fontVariantNumeric, s.opacity].join(' '); }));
    check('Type classes follow the contract', same(typeScale, ['cw-title 28px 36px normal 0.8', 'cw-big 48px 56px tabular-nums 1', 'cw-small 28px 36px tabular-nums 0.8']), typeScale);
    const iconMarkup = await current.evaluate(() => { const svg = document.querySelector('#cleantvWidgets .cw-icon'); return svg && [svg.getAttribute('viewBox'), svg.getAttribute('width'), svg.querySelector('.ut-underlay') && svg.querySelector('.ut-underlay').getAttribute('transform'), !!svg.querySelector('.ut-ink circle')].join('|'); });
    check('CleanTVIcon builds the underlay and ink layers on a 48 grid', iconMarkup === '0 0 48 48|40|translate(0 .5)|true', iconMarkup);
    await call('preferences', { dateVisible: false }); await scene('home');
    g = await geometry();
    check('Dock slot moves to top 220 without the date', g.top === 220, g);
    await look({ layout: 'list' }); await call('preferences', { dateVisible: true }); await scene('home');
    g = await geometry();
    check('List slot is right-aligned to the clock at top 300', g.right === 1780 && g.right === g.clockRight && g.top === 300, g);
    check('List cards use the top-right ink', g.card.color === g.clockColor, g.card);
    await call('preferences', { dateVisible: false }); await scene('home');
    check('List slot moves to top 260 without the date', (await geometry()).top === 260);
    await call('preferences', { controlsPosition: 'top' }); await scene('home');
    g = await geometry();
    check('List with top controls places the slot 40px below them', g.top === g.utilsBottom + 40 && g.right === 1780, g);
    await look({ bg: 'dark' }); await scene('home');
    g = await geometry();
    check('Flat backgrounds get a flat translucent plate without shadow', g.card.glass === 'none' && g.card.background !== 'rgba(0, 0, 0, 0)' && g.card.shadow === 'none' && g.card.src === '', g.card);
    await current.evaluate(() => { window.__widgetEmpty = true; });
    await scene('home');
    g = await geometry();
    check('An empty widget hides its card', g.visible === 1 && same(g.order, ['qa-first', 'qa']), g);
    const calls = await current.evaluate(() => window.__widgetCalls.slice(-1)[0]);
    check('Widgets receive language, layout, background and visibility', same(Object.keys(calls).sort(), ['bg', 'language', 'layout', 'visible']) && calls.layout === 'list' && calls.bg === 'dark' && calls.visible === true, calls);
    check('Widget plates use no live filters', (await noLiveFilters()).length === 0, await noLiveFilters());
  });
  await run('CleanTV widgets beside text cards and after late data', async () => {
    // One enabled text add-on in its stored slot, and a host widget whose data arrives after it registered.
    const data = JSON.stringify({ installed: { note: { api: 1, id: 'note', name: 'Note', version: '1.0.0', kind: 'text', description: 'Short note', author: 'QA', license: 'MIT', text: 'A text card next to host widgets', enabled: true } }, catalog: [], catalogInfo: { checked: false, total: 0, compatible: 0 } });
    const record = JSON.stringify({ v: 1, seq: 1, sum: createHash('sha256').update(data).digest('hex'), data });
    await page({}, p => p.addInitScript(r => { if (!localStorage.getItem('cleantv.addons.v1.a')) localStorage.setItem('cleantv.addons.v1.a', r); }, record));
    await scene('home');
    await current.evaluate(() => {
      window.CleanTVWidgets.register('late', { order: 1, render: (el, ctx) => { window.__late = el; window.__lateCtx = ctx; } });
      window.CleanTVWidgets.refresh();
    });
    const fill = html => current.evaluate(h => { window.__late.innerHTML = h; }, html);
    const refresh = () => current.evaluate(() => window.CleanTVWidgets.refresh());
    const layout = () => current.evaluate(() => {
      const box = e => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const shown = sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length).map(box);
      const slot = document.getElementById('cleantvWidgets'), card = slot.querySelector('[data-widget="late"]');
      const move = card && /^translate(?:3d)?\((-?[0-9.]+)px, ?(-?[0-9.]+)px/.exec(card.querySelector('.cw-field').style.transform);
      return { text: shown('#addonWidgets .addon-widget'), host: shown('#cleantvWidgets .cw-card'), slotBottom: Math.round(slot.getBoundingClientRect().bottom),
        card: card && { hidden: card.hidden, shown: card.getClientRects().length > 0, left: card.offsetLeft + slot.offsetLeft, top: card.offsetTop + slot.offsetTop, right: Math.round(card.getBoundingClientRect().right), x: move && +move[1], y: move && +move[2] } };
    });
    const apart = g => g.text.length > 0 && g.host.length > 0 && g.text.every(a => g.host.every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
    const aligned = c => c.x === -c.left && c.y === -c.top;
    let g = await layout();
    check('A late widget without data keeps its card hidden', g.card && g.card.hidden && !g.card.shown && same(g.text.map(r => [r.left, r.top]), [[1000, 260]]), g);
    await fill('<span class="cw-big">21°</span>');
    check('Filling the element alone does not show the card', (await layout()).card.hidden);
    await refresh();
    g = await layout();
    check('refresh() shows the filled card with its plate aligned', !g.card.hidden && g.card.shown && aligned(g.card), g.card);
    await fill('<span class="cw-big">' + 'Leichter Regen und Wind '.repeat(8) + '</span>'); await refresh();
    g = await layout();
    check('A Dock card stays clear of the text cards at x 1000', g.card.right <= 980 && apart(g) && same(g.text.map(r => [r.left, r.top]), [[1000, 260]]) && aligned(g.card), g);
    await look({ layout: 'list' }); await scene('home');
    await fill('<span class="cw-big">21°</span>'); await refresh();
    const narrow = (await layout()).card;
    await fill('<span class="cw-big">21° Leichter Regen</span>'); await refresh();
    g = await layout();
    check('A List card that grows keeps its plate aligned after refresh()', g.card.left < narrow.left && g.card.right === 1780 && aligned(g.card), { narrow, card: g.card });
    for (const [name, patch] of [['List', {}], ['List without the date', { dateVisible: false }], ['List with top controls', { controlsPosition: 'top' }]]) {
      if (Object.keys(patch).length) { await call('preferences', patch); await scene('home'); }
      g = await layout();
      check(name + ': text cards stack right-aligned below the host widgets', apart(g) && g.text.every(r => r.right === 1780) && g.text[0].top === g.slotBottom, g);
    }
    await call('preferences', { controlsPosition: 'auto', dateVisible: true }); await scene('home');
    await fill(''); await refresh();
    g = await layout();
    check('Without a visible host card the text cards keep their own place', g.host.length === 0 && same(g.text.map(r => [r.left, r.top]), [[1000, 260]]), g);
    await current.evaluate(() => window.CleanTVWidgets.render({ visible: true, layout: 'dock', bg: 'bogus', language: 'xx' }));
    const ctx = await current.evaluate(() => window.__lateCtx);
    check('Widgets always receive the host context', same(ctx, { language: 'en', layout: 'list', bg: 'photo', visible: true }), ctx);
    await fill('<span class="cw-big">21°</span>'); await refresh();
    await scene('settings');
    await fill(''); await refresh();
    check('refresh() does nothing while a sheet is open', (await layout()).card.hidden === false);
    await scene('home');
    check('The next Home render picks up the change', (await layout()).card.hidden === true);
  });
  await run('CleanTV widgets above three text cards in List', async () => {
    // Three enabled text add-ons, stored out of alphabetical order, under a host card as tall as the weather card (260px).
    const ids = ['zulu', 'alpha', 'mike'];
    const installed = Object.fromEntries(ids.map(id => [id, { api: 1, id, name: 'Note ' + id, version: '1.0.0', kind: 'text', description: 'Short note', author: 'QA', license: 'MIT', text: 'Text card ' + id, enabled: true }]));
    const data = JSON.stringify({ installed, catalog: [], catalogInfo: { checked: false, total: 0, compatible: 0 } });
    const record = JSON.stringify({ v: 1, seq: 1, sum: createHash('sha256').update(data).digest('hex'), data });
    await page({}, p => p.addInitScript(r => { if (!localStorage.getItem('cleantv.addons.v1.a')) localStorage.setItem('cleantv.addons.v1.a', r); }, record));
    await look({ layout: 'list' }); await scene('home');
    await current.evaluate(() => {
      window.__tall = true;
      window.CleanTVWidgets.register('tall', { order: 1, render: el => { el.innerHTML = window.__tall ? '<div style="width:420px;height:220px"></div>' : ''; } });
      window.CleanTVWidgets.refresh();
    });
    const layout = () => current.evaluate(() => {
      const box = e => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const shown = sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length);
      const compact = document.getElementById('spotifyCompact');
      return { text: shown('#addonWidgets .addon-widget').map(e => ({ id: e.getAttribute('data-addon'), ...box(e) })), host: shown('#cleantvWidgets .cw-card').map(box),
        slotBottom: Math.round(document.getElementById('cleantvWidgets').getBoundingClientRect().bottom), utils: box(document.getElementById('utils')), spotify: compact.getClientRects().length ? box(compact) : null };
    });
    const hit = (a, b) => !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    // A card fits when it ends 32px above the bottom edge and 16px above controls or a player it shares x with.
    const blocked = (r, g) => r.bottom > 1048 || [g.utils, g.spotify].some(o => o && o.left < r.right && r.left < o.right && r.bottom + 16 > o.top && r.top < o.bottom);
    const fits = g => g.text.length > 0 && g.text.every(r => r.right === 1780 && !blocked(r, g) && !hit(r, g.utils) && !hit(r, g.spotify) && g.host.every(h => !hit(r, h)));
    // The first cards in stored order stay directly below the host card, and only as many are left out as needed.
    const first = g => same(g.text.map(r => r.id), ids.slice(0, g.text.length)) && g.text[0].top === g.slotBottom;
    const full = g => { const last = g.text[g.text.length - 1]; return g.text.length === ids.length || blocked({ left: last.left, right: last.right, top: last.bottom + 16, bottom: 2 * last.bottom + 16 - last.top }, g); };
    const counts = {};
    let g;
    for (const [name, patch, render] of [['List after refresh()', null, false], ['List', null, true], ['List without the date', { dateVisible: false }, true], ['List with top controls', { dateVisible: true, controlsPosition: 'top' }, true],
      ['List with bottom controls', { controlsPosition: 'bottom' }, true], ['List with automatic controls again', { controlsPosition: 'auto' }, true]]) {
      if (patch) await call('preferences', patch);
      if (render) await scene('home');
      g = await layout(); counts[name] = g.text.length;
      check(name + ': text cards below a tall host card stay clear of the controls and the bottom edge', g.host.length === 1 && fits(g) && first(g) && full(g), g);
    }
    check('Changing only the controls position applies the limit again', counts['List with automatic controls again'] === counts.List && counts['List with bottom controls'] >= counts.List, counts);
    await current.evaluate(() => { window.__tall = false; window.CleanTVWidgets.refresh(); });
    g = await layout();
    check('Without the host card all three text cards show again in their own place', g.host.length === 0 && same(g.text.map(r => [r.id, r.left, r.top]), [['zulu', 1000, 260], ['alpha', 1000, 436], ['mike', 1000, 612]]), g);
  });
  await run('Weather add-on: install, place keyboard, widget slots and legibility', async () => {
    // Routed catalog, package and Open-Meteo/OpenPLZ answers from recorded fixtures; nothing leaves the machine.
    const BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/', FX = JSON.parse(readFileSync(root + 'scripts/fixtures/weather-api.json', 'utf8'));
    const WEATHER = { api: 1, id: 'cleantv-weather', name: 'Wetter', version: '1.0.0', kind: 'weather', description: 'Aktuelles Wetter unter der Uhr', author: 'Psychnix', license: 'MIT' };
    const entry = { ...WEATHER, path: 'cleantv-packages/cleantv-weather/1.0.0.json', sha256: createHash('sha256').update(JSON.stringify(WEATHER)).digest('hex') };
    const ORIGINS = ['https://raw.githubusercontent.com', 'https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com', 'https://openplzapi.org'];
    const cors = { 'access-control-allow-origin': '*' }, seen = [];
    const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    const key = u => u.searchParams.get('name') + (u.searchParams.get('countryCode') ? '|' + u.searchParams.get('countryCode') : '');
    const serve = async p => {
      await p.route(BASE + 'cleantv-catalog.json', r => { seen.push('catalog'); return json(r, { api: 2, addons: [entry] }); });
      await p.route(BASE + 'cleantv-packages/**', r => { seen.push('package'); return r.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: JSON.stringify(WEATHER) }); });
      await p.route('https://geocoding-api.open-meteo.com/**', r => { const u = new URL(r.request().url()); seen.push('geocoding ' + key(u)); return json(r, FX.geocoding[key(u)] || {}); });
      await p.route('https://openplzapi.org/**', r => { const u = new URL(r.request().url()), k = u.pathname.split('/')[1] + '/' + u.searchParams.get('postalCode'); seen.push('openplz ' + k); return json(r, FX.openplz[k] || []); });
      await p.route('https://api.open-meteo.com/**', r => {
        seen.push('forecast');
        // The recorded answer, dated today and tomorrow in Bonn (UTC+1) so the high and low apply.
        const f = JSON.parse(JSON.stringify(FX.forecast)), day = n => new Date(Date.now() + 3600000 + n * 86400000).toISOString().slice(0, 10);
        f.daily.time = [day(0), day(1)];
        return json(r, f);
      });
    };
    await page({}, serve);
    check('Startup with the weather module but no package requests nothing', seen.length === 0, seen);
    const card = '#cleantvWidgets [data-widget="cleantv-weather"]';
    check('Without the package there is no weather card', await current.evaluate(sel => { const c = document.querySelector(sel); return !c || c.hidden; }, card));
    current.__allowExternal = ORIGINS.slice(0, 1);
    await scene('settings'); await act('settings.group.addons'); await act('addon.tab.discover'); await act('addon.refresh');
    await current.waitForFunction(() => document.querySelector('[data-action="addon.details.cleantv-weather"]'));
    await act('addon.details.cleantv-weather'); await act('addon.install.cleantv-weather');
    await current.waitForFunction(() => CleanFrameAddons.state().installed['cleantv-weather'] && !CleanFrameAddons.state().busy);
    await current.waitForFunction(() => document.querySelector('[data-action="addon.settings.cleantv-weather"]'));
    check('Installing fetches only the catalog and the package', same(seen, ['catalog', 'package']), seen);
    await act('addon.settings.cleantv-weather');
    const rows = await current.evaluate(() => ({ title: document.getElementById('appearanceTitle').textContent, actions: ShoreQA.actions().filter(a => a.indexOf('cleantv.weather.') === 0), reasons: [...document.querySelectorAll('#appearanceRows .setting-reason')].map(e => e.textContent) }));
    check('Weather settings list the place and five display toggles with the credits', rows.title === 'Weather' && same(rows.actions, ['cleantv.weather.place', 'cleantv.weather.show.name', 'cleantv.weather.show.temp', 'cleantv.weather.show.range', 'cleantv.weather.show.wind', 'cleantv.weather.show.icon']) && /Open-Meteo\.com \(CC BY 4\.0\).*GeoNames \(CC BY 4\.0\).*OpenPLZ \(ODbL\)/.test(rows.reasons.join(' ')), rows);
    const fits = await current.evaluate(() => { const rows = document.getElementById('appearanceRows').getBoundingClientRect(), hint = document.getElementById('appearanceDesc').getBoundingClientRect(), scale = document.getElementById('stage').getBoundingClientRect().width / 1920; return { bottom: Math.round(rows.bottom / scale), hint: Math.round(hint.top / scale) }; });
    check('The settings rows end above the OK hint', fits.bottom <= fits.hint, fits);
    check('Choosing nothing yet requests no weather data', same(seen, ['catalog', 'package']), seen);

    // The place keyboard, driven by the remote: arrows and OK on the on-screen keys.
    current.__allowExternal = ORIGINS;
    await act('cleantv.weather.place');
    await current.waitForFunction(() => ShoreQA.where().view === 'cleantv.weather.keyboard');
    const layout = await current.evaluate(() => CleanTVKeyboard.layout());
    const at = id => { for (let r = 0; r < layout.length; r++) for (const k of layout[r]) if (k.id === id) return { r, c: k.col }; throw Error('No key ' + id); };
    const focusKey = async () => (await call('where')).focusAction.replace('cleantv.kb.', '');
    async function press(id) {
      const target = at(id);
      for (let i = 0; i < 24; i++) {
        const now = await focusKey();
        if (now === id) { await nav('ok'); return; }
        const here = at(now);
        await nav(here.r < target.r ? 'down' : here.r > target.r ? 'up' : here.c < target.c ? 'right' : 'left');
      }
      throw Error('The remote could not reach key ' + id);
    }
    let where = await call('where');
    check('The keyboard opens with focus on A and one focused key', where.focusAction === 'cleantv.kb.a' && where.focusCount === 1, where);
    const startsAt = seen.length;
    for (const ch of 'bonn') await press(ch);
    const typed = () => current.locator('.kb-value').textContent();
    check('Remote typing capitalises the first letter', await typed() === 'Bonn', await typed());
    await current.waitForFunction(() => document.querySelector('[data-action="cleantv.kb.pick.0"]'));
    const suggestions = await current.evaluate(() => [...document.querySelectorAll('.kb-item')].filter(e => !e.hidden).map(e => e.querySelector('.kb-name').textContent + ' | ' + e.querySelector('.kb-detail').textContent));
    check('One debounced name search lists the places', same(seen.slice(startsAt), ['geocoding Bonn']) && suggestions[0] === 'Bonn | Nordrhein-Westfalen', { seen: seen.slice(startsAt), suggestions });
    for (let i = 0; i < 12 && !(await call('where')).focusAction.startsWith('cleantv.kb.pick.'); i++) await nav('right');
    where = await call('where');
    check('Right from the last key column enters the suggestions', where.focusAction === 'cleantv.kb.pick.0' && where.focusCount === 1, where);
    await nav('ok');
    await current.waitForFunction(() => ShoreQA.state().settingsGroup === 'addon-settings');
    await current.waitForFunction(() => CleanTVWeather.state().forecast);
    check('OK on a suggestion saves the place, closes the keyboard and loads the forecast', (await current.evaluate(() => CleanTVWeather.state().place.name)) === 'Bonn' && seen[seen.length - 1] === 'forecast');
    await current.waitForFunction(() => /^As of \d\d:\d\d/.test(document.querySelector('.section-cleantv-weather-place .setting-reason')?.textContent || ''));
    check('The settings show the place and the time of the data', /Bonn/.test(await current.locator('[data-action="cleantv.weather.place"]').textContent()));

    // Remote digits for postal codes; Backspace deletes there, Back leaves without saving.
    await act('cleantv.weather.place');
    await current.waitForFunction(() => ShoreQA.where().view === 'cleantv.weather.keyboard');
    await current.keyboard.type('53111');
    await current.waitForFunction(() => document.querySelector('[data-action="cleantv.kb.pick.0"]'));
    check('Digit keys type a postal code and list its places', await typed() === '53111' && /53111 · Nordrhein-Westfalen/.test(await current.locator('.kb-item:not([hidden])').first().textContent()) && seen.includes('openplz de/53111'), seen);
    await current.keyboard.press('Backspace');
    check('Backspace deletes in the keyboard instead of leaving it', await typed() === '5311' && (await call('where')).view === 'cleantv.weather.keyboard');
    await nav('back');
    check('Back closes the keyboard and keeps the place', (await state()).settingsGroup === 'addon-settings' && (await current.evaluate(() => CleanTVWeather.state().place.detail)) === 'Nordrhein-Westfalen');

    // One display toggle through the settings row; the Home preview keeps the slots.
    await act('cleantv.weather.show.wind');
    const toggled = await current.evaluate(() => ({ tick: document.querySelector('[data-action="cleantv.weather.show.wind"]').getAttribute('aria-checked'), wind: document.querySelector('[data-widget="cleantv-weather"] .cw-wx-wind').className }));
    check('A display toggle clears its tick and hides only its slot', toggled.tick === 'false' && / is-off/.test(toggled.wind), toggled);
    await act('cleantv.weather.show.wind');

    // Home: fixed slots in Dock and List for every combination of the five toggles.
    const geometry = () => current.evaluate(sel => {
      const c = document.querySelector(sel), scale = document.getElementById('stage').getBoundingClientRect().width / 1920;
      if (!c || c.hidden || !c.getClientRects().length) return null;
      const box = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(v => Math.round(v / scale)); };
      const slots = {};
      c.querySelectorAll('[data-slot]').forEach(e => { slots[e.getAttribute('data-slot')] = { box: box(e), shown: getComputedStyle(e).visibility !== 'hidden', text: e.textContent }; });
      return { card: box(c), slots, icon: c.querySelector('.cw-wx-icon svg') ? box(c.querySelector('.cw-wx-icon svg')) : null };
    }, card);
    const showOnly = flags => current.evaluate(show => { const s = CleanTVWeather.state(); CleanTVStore.write('cleantv.weather.v1', { place: s.place, show, forecast: s.forecast }); CleanTVWeather.reload(); ShoreQA.render(); }, flags);
    const KEYS = ['name', 'temp', 'range', 'wind', 'icon'];
    for (const layoutName of ['dock', 'list']) {
      await look({ layout: layoutName }); await scene('home');
      const full = await geometry();
      check(layoutName + ': the widget shows Bonn with a 96px pictogram', full && full.slots.name.text === 'Bonn' && full.slots.temp.text === '8°' && /^↑ 10° · ↓ 8°$/.test(full.slots.range.text) && full.slots.wind.text === '5 km/h' && full.icon && full.icon[2] === 96 && full.icon[3] === 96, full);
      check(layoutName + ': the card sits below the clock' + (layoutName === 'dock' ? ' at left 140, top 260' : ', right-aligned at 1780, top 300'), layoutName === 'dock' ? full.card[0] === 140 && full.card[1] === 260 : full.card[0] + full.card[2] === 1780 && full.card[1] === 300, full.card);
      const mirrored = layoutName === 'list' ? full.slots.icon.box[0] > full.slots.temp.box[0] : full.slots.icon.box[0] < full.slots.temp.box[0];
      check(layoutName + ': the pictogram sits ' + (layoutName === 'list' ? 'right of' : 'left of') + ' the temperature', mirrored, full.slots);
      const moved = [];
      for (let mask = 0; mask < 32; mask++) {
        const flags = Object.fromEntries(KEYS.map((k, i) => [k, !(mask & (1 << i))]));
        await showOnly(flags);
        const g = await geometry();
        if (mask === 31) { if (g) moved.push({ mask, expected: 'hidden', g }); continue; }
        const wrong = !g || !same(g.card, full.card) || KEYS.some(k => g.slots[k].shown !== flags[k] || !same(g.slots[k].box, full.slots[k].box));
        if (wrong) moved.push({ mask, g });
      }
      await showOnly(Object.fromEntries(KEYS.map(k => [k, true])));
      check(layoutName + ': every toggle combination keeps each slot and the card in place; all off hides the card', moved.length === 0, moved.slice(0, 3));
    }
    check('The widget plate uses no live filters', (await noLiveFilters()).length === 0, await noLiveFilters());

    // Legibility: the ink against the brightest (or, for dark ink, darkest) tenth of the plate behind it.
    const contrast = async () => {
      const clip = await current.evaluate(sel => { const c = document.querySelector(sel), r = c.getBoundingClientRect(); c.querySelector('.cw-content').style.visibility = 'hidden'; return { x: r.x, y: r.y, width: r.width, height: r.height }; }, card);
      const png = (await current.screenshot({ clip })).toString('base64');
      return current.evaluate(async ([sel, b64]) => {
        const c = document.querySelector(sel); c.querySelector('.cw-content').style.visibility = '';
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const g = canvas.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, canvas.width, canvas.height).data, px = [];
        const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }, L = (r, gg, b) => .2126 * lin(r) + .7152 * lin(gg) + .0722 * lin(b);
        for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2], L(d[i], d[i + 1], d[i + 2])]);
        px.sort((a, b) => a[3] - b[3]);
        const pick = q => px[Math.floor(q * (px.length - 1))], rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);
        const ratio = (ink, alpha) => {
          const inkL = L(ink[0], ink[1], ink[2]), bg = inkL > pick(.5)[3] ? pick(.9) : pick(.1);
          const mix = ink.map((v, i) => v * alpha + bg[i] * (1 - alpha)), m = L(mix[0], mix[1], mix[2]);
          return +((Math.max(m, bg[3]) + .05) / (Math.min(m, bg[3]) + .05)).toFixed(2);
        };
        return { big: ratio(rgb(getComputedStyle(c.querySelector('.cw-big')).color), 1), small: ratio(rgb(getComputedStyle(c).color), .8) };
      }, [card, png]);
    };
    const weak = [];
    for (const layoutName of ['dock', 'list']) {
      for (const w of walls) { await look({ bg: 'photo', wall: w.id, layout: layoutName }); await scene('home'); const r = await contrast(); if (r.big < 4 || r.small < 3) weak.push([layoutName, w.id, r]); }
      for (const bg of ['dark', 'light']) { await look({ bg, layout: layoutName }); await scene('home'); const r = await contrast(); if (r.big < 7 || r.small < 4.5) weak.push([layoutName, bg, r]); }
    }
    check('Weather text is legible on every photo (4:1 temperature, 3:1 smaller lines) and on dark and light (7:1, 4.5:1)', weak.length === 0, weak);

    // 720p: the same layout, scaled with the stage.
    await look({ bg: 'photo', wall: walls[0].id, layout: 'dock' }); await scene('home');
    const big = await geometry();
    await current.setViewportSize({ width: 1280, height: 720 });
    await current.waitForFunction(() => Math.round(document.getElementById('stage').getBoundingClientRect().width) === 1280);
    const small = await geometry();
    const clipped = await current.evaluate(sel => [...document.querySelectorAll(sel + ' [data-slot]')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.getAttribute('data-slot')), card);
    check('At 720p the card and every slot keep their stage geometry without clipping', same(small, big) && clipped.length === 0, { big, small, clipped });
    await current.setViewportSize({ width: 1920, height: 1080 });

    // Restart without adaptive ink, as on the 2017 TV: the stored place and forecast render at once without
    // a request, and the curated ink stays legible on every photo.
    const stored = await current.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /^clean(tv|frame)\./.test(k)).map(k => [k, localStorage.getItem(k)])));
    const before = seen.length;
    await closePage();
    await page({ seed: undefined }, async p => {
      p.__allowExternal = ORIGINS;
      await serve(p);
      await p.addInitScript(entries => {
        if (!sessionStorage.getItem('__cleantv_weather')) { Object.keys(entries).forEach(k => localStorage.setItem(k, entries[k])); sessionStorage.setItem('__cleantv_weather', '1'); }
        Object.defineProperty(window, 'CleanFrameAdaptiveInk', { configurable: true, get: () => ({}), set: () => {} });
      }, stored);
    });
    await scene('home');
    check('After a restart the cached weather shows without a request', (await geometry())?.slots.temp.text === '8°' && seen.length === before, seen.slice(before));
    const curated = [];
    for (const layoutName of ['dock', 'list']) for (const w of walls) { await look({ bg: 'photo', wall: w.id, layout: layoutName }); await scene('home'); const r = await contrast(); if (r.big < 4 || r.small < 3) curated.push([layoutName, w.id, r]); }
    check('Without adaptive ink (2017 TV) the weather text stays legible on every photo', curated.length === 0, curated);
    // Disabling the package hides the card and stops requests.
    await scene('settings'); await act('settings.group.addons'); await act('addon.details.cleantv-weather'); await act('addon.toggle.cleantv-weather');
    await current.waitForFunction(() => CleanFrameAddons.state().installed['cleantv-weather'].enabled === false);
    await scene('home');
    check('A disabled package hides the weather card', (await geometry()) === null && seen.length === before, seen.slice(before));
  });
  await run('Settings focus never changes the applied Home', async () => {
    await page();
    for (const name of ['background', 'layout', 'typography', 'focus', 'samsung']) {
      await group(name); const before = await settingsSnapshot();
      const visited = new Set();
      for (const direction of ['right', 'right', 'down', 'left', 'left', 'down', 'right', 'right', 'down', 'left', 'up', 'up', 'up', 'right']) {
        await nav(direction); visited.add((await state()).focusAction);
        const after = await settingsSnapshot();
        if (!same(after, before)) throw Error(name + ' navigation changed committed state, Home preview or storage: ' + JSON.stringify({ before, after }));
        if ((await call('where')).focusCount !== 1) throw Error(name + ' navigation did not keep one focus');
      }
      check(name + ' arrows browse choices without preview or storage writes', visited.size > 1, [...visited]);
      const firstRadio = (await radios())[0];
      if (firstRadio) {
        await current.locator('[data-action="' + firstRadio.action + '"]').hover();
        check(name + ' pointer hover does not apply a choice', same(await settingsSnapshot(), before));
      }
      await nav('back');
      check(name + ' Back cancels the unconfirmed choice', same(await settingsSnapshot(), before) && (await state()).focusAction === 'settings.group.' + name);
    }
    check('Browsing Samsung does not launch a native app', (await current.evaluate(() => __tv.calls.length)) === 0);
    await group('background'); await act('background.rotation'); const before = await settingsSnapshot();
    await nav('down', 'down', 'up', 'right', 'left');
    check('Rotation arrows do not save a mode', same(await settingsSnapshot(), before));
    await nav('back'); check('Unconfirmed Rotation choice is cancelled', same(await settingsSnapshot(), before) && (await state()).settingsGroup === 'background');
  });
  await run('Settings on-screen Back preserves choice focus', async () => {
    await page(); await group('layout'); const before = await settingsSnapshot();
    const candidate = await unselectedChoice();
    await act('settings.back');
    check('On-screen Back returns to the matching overview category', (await state()).view === 'settings' && (await state()).focusAction === 'settings.group.layout');
    check('On-screen Back keeps unconfirmed choice unapplied', same(await settingsSnapshot(), before));
    await act('settings.group.layout');
    check('Reopening restores the last real choice after on-screen Back', (await state()).focusAction === candidate.action, { expected: candidate.action, actual: (await state()).focusAction });
    await nav('back'); await act('settings.group.layout');
    check('Physical Back also preserves the last real choice', (await state()).focusAction === candidate.action);
  });
  await run('Settings OK applies explicit choices atomically', async () => {
    await page();
    const specs = [
      ['background', 'bg', ['dark', 'light', 'photo']],
      ['layout', 'layout', ['list', 'dock']],
      ['layout', 'apps', ['icons', 'text', 'both']],
      ['layout', 'controls', ['text', 'both', 'icons']],
      ['typography', 'font', (await state()).fonts.available],
      ['focus', 'focus', ['type', 'glass']],
      ['focus', 'material', ['frost', 'tint', 'soft']]
    ];
    for (const [name, axis, values] of specs) {
      await group(name);
      const selected = await settingsSnapshot(); await choice(axis, selected.committed[axis]); await ready();
      check(axis + ' OK on applied choice does not write again', same(await settingsSnapshot(), selected));
      for (const value of values) {
        const before = await settingsSnapshot(); await choice(axis, value); await ready();
        const after = await settingsSnapshot(), rows = await radios();
        const expectedWrites = before.writes + (before.committed[axis] === value ? 0 : 1);
        const untouched = { ...after.committed, [axis]: before.committed[axis] };
        const prefix = { bg: 'bg', layout: 'l', apps: 'a', controls: 'u', focus: 'f', material: 'm', font: 'font' }[axis];
        const shown = !Object.hasOwn(after.shown, axis) || after.shown[axis] === value;
        check(axis + ' OK applies ' + value + ' once', after.committed[axis] === value && shown && after.rendered.includes(prefix + '-' + value) && same(untouched, before.committed) && expectedWrites === after.writes && after.storageAttempts - before.storageAttempts === expectedWrites - before.writes && rows.some(r => r.action === 'choice.' + axis + '.' + value && r.checked === 'true'), { before, after, rows });
      }
      const applied = await settingsSnapshot(); await nav('back');
      check(axis + ' applied choice survives Back', same(await settingsSnapshot(), applied) && (await state()).focusAction === 'settings.group.' + name);
    }
    await group('background'); await act('background.rotation');
    const selected = await settingsSnapshot(); await act('rotation.' + selected.committed.mode);
    check('Rotation OK on applied mode does not write again', same(await settingsSnapshot(), selected));
    for (const value of ['open', '5', '15', '60', 'fixed']) {
      const before = await settingsSnapshot(); await act('rotation.' + value);
      check('Rotation OK applies ' + value + ' once', (await state()).mode === value && (await stored()).mode === value && (await state()).writes === before.writes + 1 && (await radios()).some(r => r.action === 'rotation.' + value && r.checked === 'true'));
    }
    await group('layout'); const before = await settingsSnapshot(), candidate = await unselectedChoice();
    const [, axis, value] = candidate.action.split('.');
    await current.keyboard.down('Enter'); await current.keyboard.down('Enter'); await ready();
    check('Held physical OK applies the focused choice once', (await state()).committed[axis] === value && (await state()).writes === before.writes + 1);
    await current.keyboard.up('Enter');
    await current.keyboard.down('Escape'); await current.keyboard.down('Escape');
    check('Held physical Back closes one settings layer', (await state()).view === 'settings' && (await state()).focusAction === 'settings.group.layout');
    await current.keyboard.up('Escape');
  });
  await run('Settings inactive Material retains its choice', async () => {
    await page(); await look({ material: 'tint' });
    for (const patch of [{ bg: 'dark' }, { bg: 'light' }, { bg: 'photo', layout: 'list', focus: 'type' }]) {
      await look(patch); await group('focus'); const before = await settingsSnapshot();
      const materials = (await radios()).filter(r => r.action.startsWith('choice.material.'));
      check('Material stays visible but inactive for ' + JSON.stringify(patch), materials.length === 3 && materials.every(r => r.disabled) && materials.some(r => r.action === 'choice.material.tint' && r.checked === 'true'), materials);
      const focusBefore = (await state()).focusAction;
      await current.locator('[data-action="choice.material.frost"]').click({ force: true });
      check('Inactive Material ignores pointer focus and application', same(await settingsSnapshot(), before) && (await state()).focusAction === focusBefore);
      await walkEnabledChoices();
      check('Remote navigation skips inactive Material', same(await settingsSnapshot(), before));
      const reason = await current.locator('.setting-reason:visible').allTextContents();
      check('Inactive Material has a visible explanation', reason.some(text => /material/i.test(text) && text.length > 20), reason);
    }
    await look({ bg: 'photo', layout: 'dock', focus: 'glass' }); await group('focus');
    const materials = (await radios()).filter(r => r.action.startsWith('choice.material.'));
    check('Applicable Material restores the remembered selection', materials.every(r => !r.disabled) && materials.some(r => r.action === 'choice.material.tint' && r.checked === 'true'));
  });
  await run('Settings inactive photo tools retain wallpaper preferences', async () => {
    await page();
    for (const bg of ['dark', 'light']) {
      await look({ bg }); await group('background'); const before = await settingsSnapshot();
      for (const action of ['background.wallpaper', 'background.rotation']) {
        check(bg + ' marks ' + action + ' inactive', await current.locator('[data-action="' + action + '"]').getAttribute('aria-disabled') === 'true');
        const focusBefore = (await state()).focusAction;
        await current.locator('[data-action="' + action + '"]').click({ force: true });
        check('Inactive ' + action + ' ignores pointer focus and keeps preferences', same(await settingsSnapshot(), before) && (await state()).settingsGroup === 'background' && (await state()).focusAction === focusBefore);
      }
      await walkEnabledChoices();
      check(bg + ' remote navigation skips inactive photo tools', same(await settingsSnapshot(), before));
      const reason = await current.locator('.setting-reason:visible').allTextContents();
      check(bg + ' explains how to enable photo tools', reason.some(text => /photo/i.test(text) && /wallpaper|rotation/i.test(text)), reason);
    }
  });
  await run('Settings normalises remembered inactive focus', async () => {
    await page(); await group('focus'); await choice('material', 'tint'); await ready();
    await nav('back'); await act('settings.group.background'); await choice('bg', 'dark'); await ready();
    await nav('back'); await act('settings.group.focus');
    const focus = await focusedChoice();
    check('Inactive remembered Material returns to an enabled focus choice', focus && !focus.disabled && focus.action.startsWith('choice.focus.'), focus);
    check('Changing Background preserves remembered Material', (await state()).look.material === 'tint');
    await look({ bg: 'photo' }); await group('background'); await act('background.rotation'); await act('rotation.fixed');
    await look({ bg: 'dark' }); const before = await settingsSnapshot();
    check('All-inactive Rotation restores its enabled Back action', (await state()).focusAction === 'settings.back');
    const visited = await walkEnabledChoices();
    check('All-inactive Rotation traps focus on its enabled Back action', visited.every(a => a === 'settings.back') && same(await settingsSnapshot(), before), visited);
    await current.locator('[data-action="rotation.5"]').click({ force: true });
    check('Inactive Rotation ignores pointer clicks', (await state()).focusAction === 'settings.back' && same(await settingsSnapshot(), before));
    await nav('back');
    const returned = await focusedChoice();
    check('Rotation Back skips its now-inactive Background row', (await state()).settingsGroup === 'background' && returned && !returned.disabled && returned.action.startsWith('choice.bg.'), returned);
  });
  await run('Settings Back cancels pending assets and late callbacks', async () => {
    await page(); await group('focus'); const before = await settingsSnapshot();
    const held = [], pattern = '**/*-field-frost.jpg';
    let releaseImages;
    const blocked = new Promise(resolve => { releaseImages = resolve; });
    await current.route(pattern, async route => { held.push(route.request().url()); await blocked; await route.continue(); });
    try {
      await choice('material', 'frost'); await current.waitForFunction(() => !!ShoreQA.state().pending);
      check('Pending choice keeps the committed Home and storage', same(await settingsSnapshot(), before));
      await nav('back'); await ready();
      check('Back cancels pending choice and restores category focus', same(await settingsSnapshot(), before) && (await state()).view === 'settings' && (await state()).focusAction === 'settings.group.focus');
      releaseImages();
      await current.waitForLoadState('networkidle');
      check('Late image completion cannot commit a cancelled choice', held.length > 0 && same(await settingsSnapshot(), before) && !(await state()).pending);
    } finally { releaseImages(); await current.unroute(pattern); }
  });
  await run('Settings Back cancels a delayed font choice', async () => {
    await page(); await group('typography'); const before = await settingsSnapshot();
    const held = [], pattern = '**/fonts/newsreader/*';
    let releaseFont;
    const blocked = new Promise(resolve => { releaseFont = resolve; });
    await current.route(pattern, async route => { held.push(route.request().url()); await blocked; await route.continue(); });
    try {
      await choice('font', 'newsreader'); await current.waitForFunction(() => !!ShoreQA.state().pending);
      check('Loading a font keeps applied typography and its checked choice', same(await settingsSnapshot(), before) && (await radios()).some(r => r.action === 'choice.font.manrope' && r.checked === 'true'));
      await nav('back'); await ready();
      check('Back cancels the font choice and restores Typography focus', same(await settingsSnapshot(), before) && (await state()).focusAction === 'settings.group.typography');
      releaseFont(); await current.waitForLoadState('networkidle');
      check('Late font completion cannot apply the cancelled choice', held.length > 0 && same(await settingsSnapshot(), before) && !(await state()).pending);
      await group('typography'); await choice('font', 'newsreader'); await ready();
      check('Cancelled font remains available for a fresh explicit apply', (await state()).look.font === 'newsreader' && (await state()).shown.font === 'newsreader' && (await state()).writes === before.writes + 1);
    } finally { releaseFont(); await current.unroute(pattern); }
  });
  await run('Settings choice failure and explicit retry', async () => {
    await page(); await group('focus'); const original = await settingsSnapshot();
    current.__expectedFailures.push('-field-frost.jpg');
    await current.route('**/*-field-frost.jpg', route => route.abort('failed'));
    await choice('material', 'frost'); await current.waitForFunction(() => !ShoreQA.state().pending);
    check('Failed image keeps the applied radio and Home', same(await settingsSnapshot(), original) && (await radios()).some(r => r.action === 'choice.material.soft' && r.checked === 'true'));
    check('Failed explicit choice exposes Retry', (await call('actions')).includes('settings.retry'));
    await current.unroute('**/*-field-frost.jpg'); await act('settings.retry'); await ready();
    check('Retry applies the same failed choice', (await state()).look.material === 'frost' && (await state()).shown.material === 'frost' && (await state()).writes === original.writes + 1);
    await group('background'); const before = await settingsSnapshot();
    await current.evaluate(() => { __failWrites = true; }); await choice('bg', 'light');
    await current.waitForFunction(() => !ShoreQA.state().pending);
    const failed = await settingsSnapshot();
    check('Failed choice write keeps the committed radio and preview', same(failed.committed, before.committed) && same(failed.shown, before.shown) && failed.stored === before.stored && failed.writes === before.writes && (await radios()).some(r => r.action === 'choice.bg.photo' && r.checked === 'true'));
    await current.evaluate(() => { __failWrites = false; }); await act('settings.retry'); await ready();
    check('Storage Retry applies once through the explicit choice', (await state()).look.bg === 'light' && (await state()).shown.bg === 'light' && (await state()).writes === before.writes + 1);
  });
  await run('Settings choices fit both target viewports', async () => {
    await page();
    for (const width of [1920, 1280]) {
      await current.setViewportSize({ width, height: width * 9 / 16 });
      await current.waitForFunction(w => Math.abs(document.getElementById('stage').getBoundingClientRect().width - w) < 1, width);
      for (const name of ['background', 'layout', 'typography', 'focus', 'samsung', 'rotation']) {
        await group(name === 'rotation' ? 'background' : name);
        if (name === 'rotation') await act('background.rotation');
        const geometry = await current.evaluate(() => {
          const stage = document.getElementById('stage').getBoundingClientRect();
          const actions = ShoreQA.actions();
          return [...document.querySelectorAll('#stage [data-action]')].filter(e => actions.includes(e.getAttribute('data-action')) && e.getClientRects().length).map(e => {
            const r = e.getBoundingClientRect();
            const parts = [...e.querySelectorAll('.setting-name, .setting-tick svg')].map(part => part.getBoundingClientRect());
            const partsFit = parts.every(p => p.x >= r.x - 1 && p.y >= r.y - 1 && p.right <= r.right + 1 && p.bottom <= r.bottom + 1);
            const name = e.querySelector('.setting-name'), tick = e.querySelector('.setting-tick svg');
            const noOverlap = !name || !tick || name.getBoundingClientRect().right <= tick.getBoundingClientRect().left + 1;
            return { action: e.getAttribute('data-action'), inside: r.x >= stage.x - 1 && r.y >= stage.y - 1 && r.right <= stage.right + 1 && r.bottom <= stage.bottom + 1, fits: e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1 && partsFit && noOverlap, width: r.width, height: r.height };
          });
        });
        check(name + ' choices fit ' + width + ' without clipping', geometry.length > 0 && geometry.every(g => g.inside && g.fits) && (await call('where')).focusCount === 1, geometry);
        await current.screenshot({ path: out + 'settings-' + name + '-' + width + '.jpg', quality: 90 });
      }
    }
    check('Settings retains pre-rendered materials without live blur', (await noLiveFilters()).length === 0, await noLiveFilters());
  });
  await run('Wallpaper failure, preview cancellation and lazy loading', async () => {
    await page();
    const resources = await current.evaluate(() => performance.getEntriesByType('resource').map(r => r.name));
    check('No wallpaper thumbnails loaded at startup', !resources.some(u => /-thumb\./.test(u)), resources.filter(u => /thumb/.test(u)));
    await wallpaper();
    const original = (await stored()).wallpaper;
    await nav('down'); await wallpaperSettled(walls[1].id);
    check('Preview leaves saved photo unchanged', (await stored()).wallpaper === original);
    await nav('back'); await ready(); check('Back restores committed photo', (await state()).shown.wall === original);
    check('Wallpaper Back returns to its Background row', (await state()).settingsGroup === 'background' && (await state()).focusAction === 'background.wallpaper');
    await scene('home'); const target = walls.find(w => w.id !== original && w.id !== walls[1].id).id;
    current.__expectedFailures.push('/' + target + '-');
    await current.route('**/*' + target + '-*.jpg', route => route.abort('failed'));
    const before = await stored(); await call('look', { wall: target });
    await current.waitForFunction(() => !ShoreQA.state().pending, null, { timeout: 15000 });
    check('Failed load keeps saved and displayed photo', same(await stored(), before) && (await state()).shown.wall === original);
    await current.unroute('**/*' + target + '-*.jpg'); await look({ wall: target });
    check('Material can recover after failure', (await state()).shown.wall === target);
  });
  await run('Wallpaper child keeps the Settings frame at both sizes', async () => {
    await page();
    for (const width of [1920, 1280]) for (const layout of ['list', 'dock']) {
      await scene('home'); await look({ layout });
      await current.setViewportSize({ width, height: width * 9 / 16 });
      await current.waitForFunction(w => Math.abs(document.getElementById('stage').getBoundingClientRect().width - w) < 1, width);
      await group('background'); const frame = await previewFrame(), before = await wallpaperSaved();
      await act('background.wallpaper');
      await current.waitForFunction(() => ShoreQA.state().view === 'wallpaper');
      const names = await current.locator('.wallpaper-choice .setting-name').allTextContents();
      check(layout + ' Wallpaper shows all fifteen named choices at ' + width, same(names, walls.map(w => w.name)), names);
      check('Wallpaper entry keeps the existing Home frame ' + layout + '/' + width, same(await previewFrame(), frame));
      const first = await wallpaperListGeometry();
      check('Wallpaper list shows about six rows with contained labels ' + layout + '/' + width, first.fullyVisible.length >= 5 && first.fullyVisible.length <= 6 && first.partlyVisible.length <= 7 && first.clippedParts.length === 0 && first.fullyVisible.includes(first.focus) && (await call('where')).focusCount === 1, first);
      await nav('down', 'down'); await wallpaperSettled(walls[2].id);
      check('Browsing preserves saved photo and Settings backdrop ' + layout + '/' + width, same(await wallpaperSaved(), before));
      check('Browsing stays in the same right Home frame ' + layout + '/' + width, same(await previewFrame(), frame));
      check('Applied tick stays separate from preview focus ' + layout + '/' + width, same(await wallpaperApplied(), ['wallpaper.choose.' + before.committed.wall]) && (await state()).focusAction === 'wallpaper.choose.' + walls[2].id && (await state()).shown.wall === walls[2].id && (await call('where')).focusCount === 1);
      await current.screenshot({ path: out + 'wallpaper-' + layout + '-' + width + '.jpg', quality: 90 });
      await nav('back'); await ready();
      check('Wallpaper Back restores its Background row ' + layout + '/' + width, (await state()).settingsGroup === 'background' && (await state()).focusAction === 'background.wallpaper' && (await state()).shown.wall === before.committed.wall && same(await previewFrame(), frame));
    }
  });
  await run('Wallpaper applies in place and Back keeps the latest applied photo', async () => {
    await page(); await wallpaper(); const before = await wallpaperSaved();
    check('Applied wallpaper omits the redundant Apply hint', !/apply.*photo/i.test(await current.locator('#appearanceDesc').innerText()));
    await nav('down'); await wallpaperSettled(walls[1].id);
    check('A browsed photo is not saved by focus', same(await wallpaperSaved(), before));
    check('Unsaved preview explains the OK action', /apply.*photo/i.test(await current.locator('#appearanceDesc').innerText()));
    await nav('ok'); await ready();
    const applied = await wallpaperSaved();
    check('OK applies once while staying inside Wallpaper', (await state()).view === 'wallpaper' && applied.committed.wall === walls[1].id && applied.writes === before.writes + 1 && applied.attempts === before.attempts + 1 && same(await wallpaperApplied(), ['wallpaper.choose.' + walls[1].id]));
    check('Successful apply clears its redundant Apply hint', !/apply.*photo/i.test(await current.locator('#appearanceDesc').innerText()));
    check('Applied photo updates the committed Settings backdrop', applied.backdrop.src.includes('/' + walls[1].id + '-panel.jpg'));
    await nav('ok'); await current.keyboard.down('Enter'); await current.keyboard.down('Enter'); await current.keyboard.up('Enter');
    check('Repeated OK on the applied photo is a no-op', same(await wallpaperSaved(), applied));
    await nav('down'); await wallpaperSettled(walls[2].id); await nav('back'); await ready();
    check('Back after apply restores the latest applied photo', (await state()).shown.wall === walls[1].id && same(await wallpaperSaved(), applied) && (await state()).focusAction === 'background.wallpaper');
    await act('background.wallpaper');
    check('Reopening starts at the applied photo', (await state()).focusAction === 'wallpaper.choose.' + walls[1].id && (await state()).wallpaperPicker.candidate === walls[1].id);
    await current.locator('[data-action="wallpaper.choose.' + walls[3].id + '"]').hover();
    check('Pointer hover does not apply or preview another photo', same(await wallpaperSaved(), applied) && (await state()).shown.wall === walls[1].id);
    await current.locator('[data-action="wallpaper.choose.' + walls[3].id + '"]').click(); await ready();
    check('A pointer row click applies that photo once', (await state()).committed.wall === walls[3].id && (await state()).writes === applied.writes + 1 && (await state()).view === 'wallpaper');
    await act('wallpaper.back'); await ready();
    check('On-screen Wallpaper Back restores Background focus', (await state()).settingsGroup === 'background' && (await state()).focusAction === 'background.wallpaper' && (await state()).shown.wall === walls[3].id);
  });
  await run('Wallpaper navigation is bounded and scrolls the catalogue', async () => {
    await page(); await wallpaper(); const before = await wallpaperSaved();
    await nav('up');
    check('Up from the first wallpaper reaches Back without wrapping', (await state()).focusAction === 'wallpaper.back' && (await state()).shown.wall === walls[0].id);
    check('Back still shows its return hint', /background|return/i.test(await current.locator('#appearanceDesc').innerText()));
    await nav('down');
    check('Down from Back restores the current candidate', (await state()).focusAction === 'wallpaper.choose.' + walls[0].id);
    await nav(...Array(walls.length - 1).fill('down')); await wallpaperSettled(walls.at(-1).id); await wallpaperRowVisible(walls.at(-1).id);
    const end = await wallpaperListGeometry();
    check('Last wallpaper scrolls fully into view', end.fullyVisible.includes('wallpaper.choose.' + walls.at(-1).id) && end.top > 0 && end.clippedParts.length === 0, end);
    await nav('down', 'down');
    check('Down at the catalogue end does not wrap', (await state()).focusAction === 'wallpaper.choose.' + walls.at(-1).id && same(await wallpaperSaved(), before));
    await nav('left'); check('Left from a scrolled row reaches Back', (await state()).focusAction === 'wallpaper.back');
    await nav('right'); check('Right from Back restores the scrolled candidate', (await state()).focusAction === 'wallpaper.choose.' + walls.at(-1).id);
    const top = (await state()).wallpaperPicker.top;
    await nav(...Array(walls.length - 1 - top).fill('up')); await wallpaperSettled(walls[top].id);
    await nav('up'); await wallpaperSettled(walls[top - 1].id);
    check('Up from a scrolled top row continues the catalogue', (await state()).focusAction === 'wallpaper.choose.' + walls[top - 1].id && (await state()).view === 'wallpaper');
    await nav(...Array(top - 1).fill('up')); await wallpaperSettled(walls[0].id); await wallpaperRowVisible(walls[0].id);
    const start = await wallpaperListGeometry();
    check('Returning to the first wallpaper resets scrolling', start.top === 0 && start.fullyVisible.includes('wallpaper.choose.' + walls[0].id), start);
    await nav('up', 'up');
    check('Repeated Up stops at Back with no preference writes', (await state()).focusAction === 'wallpaper.back' && same(await wallpaperSaved(), before));
  });
  await run('Wallpaper rapid browsing debounces work and OK is never lost', async () => {
    await page(); await wallpaper(); const before = await wallpaperSaved();
    const immediate = await current.evaluate(() => {
      const at = performance.now(); ShoreQA.nav('down', 'down', 'down');
      return { at, action: ShoreQA.state().focusAction, shown: ShoreQA.state().shown.wall };
    });
    check('Rapid browsing updates row focus before loading the preview', immediate.action === 'wallpaper.choose.' + walls[3].id && immediate.shown === walls[0].id, immediate);
    await wallpaperSettled(walls[3].id);
    const resources = await current.evaluate(() => performance.getEntriesByType('resource').map(r => ({ name: r.name, start: r.startTime })));
    const latest = resources.find(r => r.name.endsWith('/wallpapers/' + walls[3].id + '.jpg'));
    check('Preview work waits for focus to settle', latest && latest.start - immediate.at >= 100, { delay: latest && latest.start - immediate.at });
    check('Fast skipped rows do not load their full wallpaper bundles', !resources.some(r => [walls[1].id, walls[2].id].some(id => r.name.endsWith('/wallpapers/' + id + '.jpg') || r.name.includes('/materials/' + id + '-'))));
    check('Debounced preview never saves from focus', same(await wallpaperSaved(), before));
    await nav('down', 'ok');
    await current.waitForFunction(id => ShoreQA.state().committed.wall === id && !ShoreQA.state().pending, walls[4].id);
    check('OK during focus debounce applies the current candidate once', (await state()).writes === before.writes + 1 && (await state()).shown.wall === walls[4].id && (await state()).view === 'wallpaper');
  });
  await run('Wallpaper newer previews cancel older queued applies', async () => {
    await page(); await wallpaper(); const before = await wallpaperSaved();
    const first = walls[1].id, latest = walls[2].id, pattern = '**/wallpapers/' + first + '.jpg', held = [];
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    await current.route(pattern, async route => { held.push(route.request().url()); await blocked; await route.continue(); });
    try {
      await nav('down'); await current.waitForFunction(id => ShoreQA.state().pending && ShoreQA.state().pending.target.wall === id, first);
      await nav('ok'); check('OK while loading records one explicit apply request', !!(await state()).wallpaperPicker.applyPending && same(await wallpaperSaved(), before));
      await nav('down'); await wallpaperSettled(latest);
      check('Browsing away cancels the queued apply', !(await state()).wallpaperPicker.applyPending && same(await wallpaperSaved(), before));
      check('Latest preview installs a matching photo and material bundle', Object.values(await wallpaperBundle()).every(src => src.includes('/' + latest)), await wallpaperBundle());
      release(); await current.waitForLoadState('networkidle');
      check('Older completion cannot overwrite or apply the latest preview', held.length > 0 && (await state()).shown.wall === latest && Object.values(await wallpaperBundle()).every(src => src.includes('/' + latest)) && same(await wallpaperSaved(), before));
      await nav('back'); await ready();
      check('Back restores the complete committed bundle after rapid browsing', Object.values(await wallpaperBundle()).every(src => src.includes('/' + before.committed.wall)));
    } finally { release(); await current.unroute(pattern); }
  });
  await run('Wallpaper Back cancels loading and queued applies', async () => {
    await page(); await wallpaper();
    await current.locator('[data-action="wallpaper.choose.' + walls[1].id + '"]').click(); await ready();
    const applied = await wallpaperSaved();
    for (const [index, back] of [[2, 'remote'], [3, 'pointer']]) {
      if ((await state()).view !== 'wallpaper') await act('background.wallpaper');
      const target = walls[index].id, pattern = '**/wallpapers/' + target + '.jpg', held = [];
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      await current.route(pattern, async route => { held.push(route.request().url()); await blocked; await route.continue(); });
      try {
        await act('wallpaper.choose.' + target);
        await current.waitForFunction(() => !!ShoreQA.state().pending && !!ShoreQA.state().wallpaperPicker.applyPending);
        if (back === 'remote') await nav('back'); else await current.locator('[data-action="wallpaper.back"]').click();
        await ready();
        check(back + ' Back cancels pending apply and returns to Wallpaper row', (await state()).focusAction === 'background.wallpaper' && (await state()).shown.wall === applied.committed.wall && same(await wallpaperSaved(), applied));
        release(); await current.waitForLoadState('networkidle');
        check(back + ' Back ignores late completion and keeps latest applied photo', held.length > 0 && (await state()).shown.wall === applied.committed.wall && same(await wallpaperSaved(), applied));
      } finally { release(); await current.unroute(pattern); }
    }
  });
  await run('Wallpaper preview failure restores committed photo and retries preview only', async () => {
    await page(); await wallpaper(); const before = await wallpaperSaved();
    await nav('down'); await wallpaperSettled(walls[1].id);
    const target = walls[2].id, pattern = '**/wallpapers/' + target + '.jpg';
    current.__expectedFailures.push('/wallpapers/' + target + '.jpg');
    await current.route(pattern, route => route.abort('failed'));
    await nav('down'); await current.waitForFunction(() => ShoreQA.actions().includes('wallpaper.retry'));
    check('Failed browse restores the committed frame rather than another unsaved preview', (await state()).shown.wall === before.committed.wall && same(await wallpaperSaved(), before) && same(await wallpaperApplied(), ['wallpaper.choose.' + before.committed.wall]));
    check('Failed candidate remains identified for retry', (await state()).wallpaperPicker.candidate === target && /couldn.t|failed|try again/i.test(await current.locator('#appearance').innerText()));
    await current.unroute(pattern); await act('wallpaper.retry'); await wallpaperSettled(target);
    check('Retrying a failed browse does not authorise a save', same(await wallpaperSaved(), before) && !(await state()).wallpaperPicker.applyPending);
    check('Successful preview Retry returns focus to its candidate', (await state()).focusAction === 'wallpaper.choose.' + target);
    await nav('ok'); await ready();
    check('Explicit OK can apply the recovered preview', (await state()).committed.wall === target && (await state()).writes === before.writes + 1);
  });
  await run('Wallpaper explicit apply and storage failures preserve applied state', async () => {
    await page(); await wallpaper(); const before = await wallpaperSaved();
    const target = walls[2].id, pattern = '**/wallpapers/' + target + '.jpg';
    current.__expectedFailures.push('/wallpapers/' + target + '.jpg');
    await current.route(pattern, route => route.abort('failed'));
    await act('wallpaper.choose.' + target); await current.waitForFunction(() => ShoreQA.actions().includes('wallpaper.retry'));
    check('Failed explicit apply changes no committed photo, tick or storage', same(await wallpaperSaved(), before) && same(await wallpaperApplied(), ['wallpaper.choose.' + before.committed.wall]));
    await current.unroute(pattern); await act('wallpaper.retry'); await ready();
    check('Retry preserves explicit apply intent and stays in the picker', (await state()).committed.wall === target && (await state()).writes === before.writes + 1 && (await state()).view === 'wallpaper');
    const applied = await wallpaperSaved(), requests = [];
    current.on('request', request => { if (request.url().endsWith('/wallpapers/' + walls[3].id + '.jpg') || request.url().includes('/materials/' + walls[3].id + '-')) requests.push(request.url()); });
    await nav('down'); await wallpaperSettled(walls[3].id);
    const loadedRequests = requests.length;
    await current.evaluate(() => { __failWrites = true; }); await nav('ok');
    await current.waitForFunction(() => ShoreQA.actions().includes('wallpaper.retry'));
    const failed = await wallpaperSaved();
    check('Failed wallpaper save preserves applied photo, tick and backdrop', failed.stored === applied.stored && same(failed.committed, applied.committed) && same(failed.backdrop, applied.backdrop) && failed.writes === applied.writes && same(await wallpaperApplied(), ['wallpaper.choose.' + target]));
    check('Storage failure restores the committed frame and names the failed candidate', (await state()).shown.wall === target && Object.values(await wallpaperBundle()).every(src => src.includes('/' + target)) && (await state()).wallpaperPicker.candidate === walls[3].id && (await current.locator('#appearance').innerText()).includes(walls[3].name));
    await current.evaluate(() => { __failWrites = false; }); await act('wallpaper.retry'); await ready();
    check('Storage Retry applies the candidate exactly once', (await state()).committed.wall === walls[3].id && (await state()).writes === applied.writes + 1 && (await state()).view === 'wallpaper');
    check('Storage Retry reuses the already-loaded wallpaper bundle', loadedRequests > 0 && requests.length === loadedRequests, requests);
  });
  await run('Wallpaper thumbnails fail without breaking the list or full photo', async () => {
    await page(); const target = walls[5], pattern = '**/wallpapers/' + target.id + '-thumb.jpg';
    current.__expectedFailures.push('/wallpapers/' + target.id + '-thumb.jpg');
    await current.route(pattern, route => route.abort('failed'));
    await wallpaper();
    await current.waitForFunction(id => {
      const slot = document.querySelector('[data-action="wallpaper.choose.' + id + '"] .wallpaper-thumb');
      return slot && slot.classList.contains('is-missing');
    }, target.id);
    await nav(...Array(5).fill('down')); await wallpaperSettled(target.id);
    const fallback = await current.evaluate(id => {
      const row = document.querySelector('[data-action="wallpaper.choose.' + id + '"]'), slot = row.querySelector('.wallpaper-thumb'), img = slot.querySelector('img');
      const r = row.getBoundingClientRect(), b = slot.getBoundingClientRect();
      return { name: row.textContent, slotVisible: getComputedStyle(slot).display !== 'none' && b.width > 0 && b.height > 0,
        ratio: b.width / b.height, inside: b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom,
        imageHidden: !img || getComputedStyle(img).display === 'none' || getComputedStyle(img).visibility === 'hidden' };
    }, target.id);
    check('Broken thumbnail keeps its named 16:9 slot without a broken image glyph', fallback.name.includes(target.name) && fallback.slotVisible && fallback.inside && Math.abs(fallback.ratio - 16 / 9) < 0.05 && fallback.imageHidden, fallback);
    await nav('ok'); await ready();
    check('A missing thumbnail does not prevent applying its full photo', (await state()).committed.wall === target.id && Object.values(await wallpaperBundle()).every(src => src.includes('/' + target.id)));
  });
  await run('Physical-key repeats and Back hierarchy', async () => {
    await page(); await editor(); await remove('netflix');
    await current.keyboard.down('Enter'); await current.keyboard.down('Enter');
    check('Held OK restores once without removing again', (await state()).dock.includes('netflix') && (await state()).dock.length === 9);
    await current.keyboard.up('Enter');
    await current.keyboard.down('Escape'); await current.keyboard.down('Escape');
    check('Held Back closes one layer only', (await call('where')).view === 'settings' && (await state()).focusAction === 'settings.editor');
    await current.keyboard.up('Escape'); await current.keyboard.press('Escape');
    check('Released Back reaches Home', (await call('where')).view === 'home');
  });
  await run('Rotation pauses and warm return', async () => {
    await page({ minuteMs: 120 });
    await group('background'); await act('background.rotation'); await act('rotation.5'); await scene('home');
    const first = (await state()).wallpaper;
    await current.waitForFunction(id => ShoreQA.state().wallpaper !== id, first, { timeout: 4000 });
    check('Timed rotation advances on photo Home', (await state()).mode === '5');
    await scene('settings'); const paused = (await state()).wallpaper; await current.waitForTimeout(850);
    check('Rotation pauses in settings', (await state()).wallpaper === paused);
    await scene('home'); await current.evaluate(() => __setHidden(true)); const hidden = (await state()).wallpaper; await current.waitForTimeout(850);
    check('Rotation pauses when hidden', (await state()).wallpaper === hidden);
    await current.evaluate(() => __setHidden(false));
    await current.waitForFunction(id => ShoreQA.state().wallpaper !== id, hidden, { timeout: 4000 });
    await look({ bg: 'dark' }); const flat = (await state()).wallpaper; await current.waitForTimeout(850);
    check('Flat background retains photo without rotation', (await state()).wallpaper === flat);
    await look({ bg: 'photo', layout: 'list' }); const photoList = (await state()).wallpaper;
    await current.waitForFunction(id => ShoreQA.state().wallpaper !== id, photoList, { timeout: 4000 });
    check('Photo List rotates too', (await state()).look.layout === 'list');
    await current.evaluate(() => { __setHidden(true); document.getElementById('stage').blur(); __setHidden(false); window.dispatchEvent(new Event('focus')); });
    const focus = (await state()).focusAction; await current.keyboard.press('ArrowDown');
    check('Warm return restores remote focus', (await state()).focusAction !== focus && (await call('where')).focusCount === 1);
    const clock = await current.locator('#caption .clock').textContent();
    check('Live 12-hour clock has no AM/PM', /^\s*\d{1,2}:\d{2}\s*$/.test(clock), clock);
  });
  await run('Open rotation and browser fallback', async () => {
    await page({ seed: baseline({ mode: 'open' }) }); check('Open mode advances at cold start', (await state()).wallpaper === walls[1].id);
    const first = (await state()).wallpaper;
    await current.evaluate(() => { __setHidden(true); __setHidden(false); window.dispatchEvent(new Event('focus')); });
    check('Warm return does not repeat open rotation', (await state()).wallpaper === first);
    await current.reload(); await ready(); check('Next cold start advances again', (await state()).wallpaper === walls[2].id);
    await closePage();
    await page({ mock: false }); await act('home.app.netflix'); await current.waitForFunction(() => ShoreQA.where().view === 'message');
    check('Browser launch honestly requires TV', /TV/.test(await current.locator('#stage').innerText()));
    await nav('back'); await library();
    check('Browser All Apps has no installed fixtures', /TV/.test(await current.locator('#stage').innerText()) && !(await current.locator('[data-action^="apps.open."]').count()));
  });
  await run('Add-on wallpapers: streamed picker, favourites, rotation, reload and removal', async () => {
    const BASE = 'https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/', CATALOG_URL = BASE + 'cleantv-catalog.json', INDEX_URL = BASE + 'cleantv-wallpapers/index.json';
    const cors = { 'access-control-allow-origin': '*' };
    const FILES = { jpg: 'image.jpg', thumb: 'thumb.jpg', panel: 'panel.jpg', 'study-soft': 'study-soft.jpg', 'field-blur': 'field-blur.jpg', 'field-frost': 'field-frost.jpg', 'field-clear': 'field-clear.jpg' };
    const asset = (id, role) => root + 'app/assets/' + (role === 'jpg' ? 'wallpapers/' + id + '.jpg' : role === 'thumb' || role === 'panel' ? 'wallpapers/' + id + '-' + role + '.jpg' : 'materials/' + id + '-' + role + '.jpg');
    // Bundled JPEGs stand in for generated output under add-on IDs; twelve photos, so a favourite can be the eleventh.
    const named = [['aw-berg', 'Berg am See', 'summit'], ['aw-see', 'Stiller See', 'alpine'], ['aw-tal', 'Weites Tal', 'amber']];
    // The longest title the generator and the module allow: 120 characters from a file name.
    const LONG = 'Sonnenuntergang ueber dem Wattenmeer bei Ebbe mit Prielen Moewen und einem einsamen Leuchtturm am fernen Horizont Herbst';
    const photos = named.concat(Array.from({ length: 9 }, (_, i) => ['aw-extra-' + (i + 1), i === 8 ? LONG : 'Extra ' + (i + 1), 'mint'])).map(([id, title, from]) => {
      const bytes = Object.fromEntries(Object.keys(FILES).map(role => [role, readFileSync(asset(from, role))]));
      const files = Object.fromEntries(Object.entries(bytes).map(([role, data]) => [role, { path: 'cleantv-wallpapers/generated/' + id + '/' + FILES[role], size: data.length, sha256: createHash('sha256').update(data).digest('hex') }]));
      return { id, title, bytes, entry: { id, title, rev: files.jpg.sha256.slice(0, 12), tone: 'light', ut: { tr: 'mist', br: 'light' }, frostVeil: 0.2, files } };
    });
    const pkg = { api: 1, id: 'cleantv-wallpapers', name: 'Wallpapers', version: '1.0.0', kind: 'wallpapers', description: 'Own photos', author: 'QA', license: 'MIT', index: 'cleantv-wallpapers/index.json' };
    const listing = { ...pkg, path: 'cleantv-packages/cleantv-wallpapers/1.0.0.json', sha256: createHash('sha256').update(JSON.stringify(pkg)).digest('hex') };
    const requests = [];
    const serve = async p => {
      p.on('request', request => { if (request.url().startsWith(BASE)) requests.push({ url: request.url(), type: request.resourceType() }); });
      await p.route(CATALOG_URL, route => route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: JSON.stringify({ api: 2, addons: [listing] }) }));
      await p.route(BASE + listing.path, route => route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: JSON.stringify(pkg) }));
      await p.route(INDEX_URL, route => route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: JSON.stringify({ api: 1, entries: photos.map(x => x.entry) }) }));
      await p.route(BASE + 'cleantv-wallpapers/generated/**', route => {
        const [id, file] = route.request().url().split('/').slice(-2), photo = photos.find(x => x.id === id), role = Object.keys(FILES).find(r => FILES[r] === file);
        // Stiller See streams but cannot be downloaded, so rotation must skip it.
        if (!photo || !role || id === 'aw-see' && route.request().resourceType() !== 'image') return route.fulfill({ status: 404, headers: cors, body: 'missing' });
        return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: cors, body: photo.bytes[role] });
      });
    };
    const downloads = () => requests.filter(r => r.type !== 'image' && r.url.includes('/generated/'));
    const thumbs = () => requests.filter(r => r.url.endsWith('/thumb.jpg')).map(r => r.url.split('/').slice(-2)[0]);
    const storedCopy = id => current.waitForFunction(id => window.CleanTVWallpapers.stored(id), id, { timeout: 20000 });
    const hint = () => current.locator('#appearanceDesc').innerText();
    const starred = () => current.evaluate(() => [...document.querySelectorAll('.wallpaper-star[aria-checked="true"]')].map(e => e.getAttribute('data-action').slice(15)));
    await page({ minuteMs: 120 }, serve);
    check('Startup without the add-on sends no wallpaper request', requests.length === 0, requests);
    current.__allowExternal = ['https://raw.githubusercontent.com'];
    current.__expectedFailures.push('/generated/aw-see/');
    await scene('settings'); await act('settings.group.addons'); await act('addon.tab.discover'); await act('addon.refresh');
    await current.waitForFunction(() => document.querySelector('[data-action="addon.details.cleantv-wallpapers"]'));
    await act('addon.details.cleantv-wallpapers'); await act('addon.install.cleantv-wallpapers');
    await current.waitForFunction(() => CleanFrameWallpapers.filter(w => w.remote).length === 12);
    const ids = await current.evaluate(() => CleanFrameWallpapers.map(w => w.id));
    check('Install fetches the index once and appends the add-on photos after the built-ins', same(ids, walls.map(w => w.id).concat(photos.map(x => x.id))) && requests.filter(r => r.url === INDEX_URL).length === 1 && !downloads().length, { ids, requests });

    await wallpaper();
    const names = await current.locator('.wallpaper-choice .setting-name').allTextContents();
    check('The picker names every photo, add-on titles as they are', same(names, walls.map(w => w.name).concat(photos.map(x => x.title))), names);
    check('Hidden add-on rows stream no thumbnail', !thumbs().length, thumbs());
    await nav('right');
    check('Right moves from a photo to its star', (await state()).focusAction === 'wallpaper.star.' + walls[0].id && (await call('where')).focusCount === 1 && /Add to favourites/.test(await hint()), { focus: (await state()).focusAction, hint: await hint() });
    await nav('ok');
    check('OK stars the photo and saves the favourite', same((await stored()).favourites, [walls[0].id]) && same(await starred(), [walls[0].id]) && /Remove from favourites/.test(await hint()));
    await nav('ok');
    check('OK again removes the star', same((await stored()).favourites, []) && same(await starred(), []));
    await nav('down'); await wallpaperSettled(walls[1].id);
    check('Up and Down keep the star column while browsing', (await state()).focusAction === 'wallpaper.star.' + walls[1].id && (await state()).wallpaperPicker.candidate === walls[1].id);
    await nav('left');
    check('Left returns from the star to its photo', (await state()).focusAction === 'wallpaper.choose.' + walls[1].id);
    const geometry = await current.evaluate(() => [...document.querySelectorAll('.wallpaper-choice')].filter(r => getComputedStyle(r).visibility !== 'hidden').map(row => {
      const r = row.getBoundingClientRect(), star = row.querySelector('.wallpaper-star').getBoundingClientRect(), name = row.querySelector('.setting-name').getBoundingClientRect(), tick = row.querySelector('.setting-tick').getBoundingClientRect();
      return star.left >= r.left && star.right <= r.right && star.top >= r.top && star.bottom <= r.bottom && name.right <= star.left && tick.right <= star.left;
    }));
    check('Each visible star sits inside its row, right of the name and tick', geometry.length >= 5 && geometry.every(Boolean), geometry);

    // To Berg am See (row 16): only rows that become visible stream their thumbnails.
    await nav(...Array(14).fill('down')); await wallpaperSettled('aw-berg');
    check('Only visible add-on rows stream thumbnails', same(thumbs(), ['aw-berg']), thumbs());
    check('A browsed add-on photo streams and saves nothing', (await state()).shown.wall === 'aw-berg' && (await stored()).wallpaper === walls[0].id && !downloads().length
      && (await wallpaperBundle()).photo === BASE + 'cleantv-wallpapers/generated/aw-berg/image.jpg', await wallpaperBundle());
    await nav('ok'); await ready();
    check('OK applies the add-on photo', (await state()).committed.wall === 'aw-berg' && same(await wallpaperApplied(), ['wallpaper.choose.aw-berg']));
    await storedCopy('aw-berg');
    check('Only the chosen photo is downloaded: seven verified files', same(downloads().map(r => r.url.split('/').slice(-2).join('/')).sort(), Object.values(FILES).map(f => 'aw-berg/' + f).sort()), downloads());
    await nav('right', 'ok');
    await nav(...Array(6).fill('up')); await wallpaperSettled('summit'); await nav('ok');
    await nav(...Array(7).fill('down')); await wallpaperSettled('aw-see'); await nav('ok');
    check('Stars mark add-on and built-in photos alike, in starring order', same((await stored()).favourites, ['aw-berg', 'summit', 'aw-see']), (await stored()).favourites);
    await nav('back'); await ready();
    check('Back keeps the applied add-on photo', (await state()).shown.wall === 'aw-berg');

    // Rotation over favourites, in WALLS order, skipping Stiller See (no local copy).
    await act('background.rotation'); await act('rotation.5');
    check('The rotation reason explains favourites', /favourites/.test(await current.locator('#appearanceRows').innerText()));
    await scene('home');
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const before = (await state()).wallpaper;
      await current.waitForFunction(id => ShoreQA.state().wallpaper !== id && !ShoreQA.state().pending, before, { timeout: 8000 });
      seen.push((await state()).wallpaper);
    }
    check('Rotation alternates over the available favourites only', same(seen, ['summit', 'aw-berg', 'summit', 'aw-berg']), seen);
    await current.waitForFunction(() => ShoreQA.state().wallpaper === 'aw-berg' && !ShoreQA.state().pending);
    check('A stored add-on photo rotates in from its local copy', (await wallpaperBundle()).photo.startsWith('blob:'), await wallpaperBundle());
    check('Rotation tried to keep the add-on favourites locally', downloads().some(r => r.url.includes('/aw-see/')) && !(await current.evaluate(() => window.CleanTVWallpapers.stored('aw-see'))));

    // An eleventh add-on favourite keeps its star but gets the storage hint.
    await call('preferences', { mode: 'fixed', wall: 'aw-berg', favourites: photos.slice(3).map(x => x.id).concat(['aw-berg']) }); await ready();
    await call('preferences', { mode: '60' });
    await wallpaper();
    await nav('down'); await wallpaperSettled('aw-see'); await nav('right', 'ok');
    const eleventh = await stored();
    check('An eleventh add-on favourite is starred with a hint that ten are kept', eleventh.favourites.length === 11 && eleventh.favourites.at(-1) === 'aw-see' && /At most 10 add-on favourites/.test(await current.locator('#appearanceStatus').innerText()), eleventh.favourites);
    await nav('left');
    check('The hint disappears with the next key', !/At most 10/.test(await current.locator('#appearanceStatus').innerText()));
    await nav('back'); await ready();
    await act('background.rotation'); await act('rotation.fixed');
    await current.waitForFunction(() => !CleanFrameWallpapers.some(w => w.remote && w.id !== ShoreQA.state().committed.wall && window.CleanTVWallpapers.stored(w.id)), null, { timeout: 20000 });
    check('Rotation off keeps only the chosen add-on photo locally; the stars stay', (await stored()).favourites.length === 11 && await current.evaluate(() => CleanFrameWallpapers.filter(w => w.remote && window.CleanTVWallpapers.stored(w.id)).map(w => w.id).join()) === (await state()).committed.wall);

    // Reload: the saved add-on ID survives start-up validation and its local copy needs no network.
    await look({ wall: 'aw-berg' }); await storedCopy('aw-berg');
    current.__allowExternal = []; const count = requests.length;
    await current.reload(); await ready(); await current.waitForLoadState('networkidle');
    check('After a reload the add-on photo is still chosen and shown from its local copy', (await state()).committed.wall === 'aw-berg' && (await wallpaperBundle()).photo.startsWith('blob:') && requests.length === count, { bundle: await wallpaperBundle(), requests: requests.slice(count) });
    check('Favourites survive the reload', (await stored()).favourites.length === 11);

    // A 120-character add-on title ends with an ellipsis wherever the chosen photo is named, and wraps in the picker status.
    current.__allowExternal = ['https://raw.githubusercontent.com'];
    await look({ wall: 'aw-extra-9' });
    const clipped = (name, limit) => current.evaluate(([name, limit]) => {
      const el = document.querySelector(name), edge = document.querySelector(limit), style = getComputedStyle(el), box = el.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(el);
      // Text past its box stays visible unless overflow clips it.
      const right = style.overflowX === 'visible' ? Math.max(box.right, range.getBoundingClientRect().right) : box.right;
      return { text: el.textContent, right, limit: edge.getBoundingClientRect().left, ellipsis: el.scrollWidth > el.clientWidth && style.textOverflow === 'ellipsis' };
    }, [name, limit]);
    await group('background');
    const detailRow = await clipped('.section-wall .setting-name', '.section-wall .setting-forward');
    check('A long add-on title ends with an ellipsis before the chevron of the Background row', detailRow.text === LONG && detailRow.right <= detailRow.limit + 0.5 && detailRow.ellipsis, detailRow);
    await scene('settings');
    const overviewRow = await clipped('.settings-group[data-id="background"] .settings-group-value', '.settings-group[data-id="background"] > .ico');
    check('A long add-on title ends with an ellipsis before the chevron in the Settings overview', overviewRow.text === LONG && overviewRow.right <= overviewRow.limit + 0.5 && overviewRow.ellipsis, overviewRow);
    await wallpaper();
    const caption = await current.evaluate(() => {
      const status = document.getElementById('appearanceStatus').getBoundingClientRect(), name = document.querySelector('.wallpaper-preview-name').getBoundingClientRect();
      const row = document.querySelector('[data-action="wallpaper.choose.aw-extra-9"]'), title = row.querySelector('.setting-name'), style = getComputedStyle(title);
      return { status: [status.left, status.right, status.bottom], name: [name.left, name.right, name.bottom], rowName: title.getBoundingClientRect().right, star: row.querySelector('.wallpaper-star').getBoundingClientRect().left,
        rowEllipsis: title.scrollWidth > title.clientWidth && style.overflowX === 'hidden' && style.textOverflow === 'ellipsis' };
    });
    check('In the picker a long title wraps inside the status and ends with an ellipsis before the star',
      caption.name[0] >= caption.status[0] && caption.name[1] <= caption.status[1] && caption.status[2] <= 1080 && caption.rowName <= caption.star && caption.rowEllipsis, caption);
    await nav('back'); await ready();

    // Removal switches to the first built-in favourite first, then removes the entries and their data.
    await call('preferences', { favourites: ['summit', 'aw-berg'] });
    await scene('settings'); await act('settings.group.addons'); await act('addon.details.cleantv-wallpapers'); await act('addon.remove.cleantv-wallpapers');
    check('The removal dialog names the wallpapers', /Its wallpapers and stored photos are removed/.test(await current.locator('#sheet').innerText()));
    await act('message.addonRemove');
    await current.waitForFunction(() => !CleanFrameWallpapers.some(w => w.remote), null, { timeout: 15000 });
    const after = await current.evaluate(async () => ({ wall: ShoreQA.state().committed.wall, keys: Object.keys(localStorage).filter(k => k.startsWith('cleantv.wallpapers')), dbs: indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : [] }));
    check('Removal keeps a built-in photo and leaves no add-on data', after.wall === 'summit' && !after.keys.length && !after.dbs.includes('cleantv-wallpapers'), after);

    // With Background Dark or Light the last applied add-on photo is not shown: Disable and removal finish at once.
    const reinstall = async () => {
      await scene('settings'); await act('settings.group.addons'); await act('addon.tab.discover'); await act('addon.refresh');
      await current.waitForFunction(() => document.querySelector('[data-action="addon.details.cleantv-wallpapers"]'));
      await act('addon.details.cleantv-wallpapers'); await act('addon.install.cleantv-wallpapers');
      await current.waitForFunction(() => CleanFrameWallpapers.filter(w => w.remote).length === 12);
    };
    const leftAddon = async () => {
      const gone = await current.waitForFunction(() => !CleanFrameWallpapers.some(w => w.remote), null, { timeout: 15000 }).then(() => true, () => false);
      return current.evaluate(async gone => ({ gone, wall: ShoreQA.state().committed.wall, bg: ShoreQA.state().committed.bg, remote: CleanFrameWallpapers.filter(w => w.remote).length,
        keys: Object.keys(localStorage).filter(k => k.startsWith('cleantv.wallpapers')), dbs: indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : [] }), gone);
    };
    const darkAddonPhoto = async () => {
      await look({ bg: 'photo', wall: 'aw-berg' }); await storedCopy('aw-berg');
      await look({ bg: 'dark' });
    };
    await reinstall(); await darkAddonPhoto();
    await scene('settings'); await act('settings.group.addons'); await act('addon.details.cleantv-wallpapers'); await act('addon.toggle.cleantv-wallpapers');
    const disabled = await leftAddon();
    check('Disable with Background Dark leaves the add-on photos and keeps their data', disabled.gone && walls.some(w => w.id === disabled.wall) && disabled.bg === 'dark' && disabled.keys.length > 0 && disabled.dbs.includes('cleantv-wallpapers'), disabled);
    await act('addon.toggle.cleantv-wallpapers');
    await current.waitForFunction(() => CleanFrameWallpapers.filter(w => w.remote).length === 12);
    await darkAddonPhoto();
    await scene('settings'); await act('settings.group.addons'); await act('addon.details.cleantv-wallpapers'); await act('addon.remove.cleantv-wallpapers'); await act('message.addonRemove');
    const removed = await leftAddon();
    check('Removal with Background Dark finishes: a built-in photo, no entries, no record and no database', removed.gone && walls.some(w => w.id === removed.wall) && removed.bg === 'dark' && !removed.keys.length && !removed.dbs.includes('cleantv-wallpapers'), removed);
  });
  section = 'Run integrity';
  report.sourceAfter = hashes();
  check('No unexpected browser/resource failures', report.pageErrors.length === 0, report.pageErrors);
  check('Sources stayed stable during run', same(report.sourceBefore, report.sourceAfter));
} catch (error) { report.failures.push({ section, error: error.stack }); }
finally {
  await closePage();
  if (preview) await preview.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(out + 'checks.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(report.checks.filter(c => c.passed).length + ' checks passed; ' + report.failures.length + ' failure(s). Report: .local/qa/checks.json');
if (report.failures.length) process.exitCode = 1;
