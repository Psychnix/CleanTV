// Legacy CSS resolver equivalence. The same states render with native custom properties
// (/home/) and with the forced resolver (/home/?legacy=1); computed styles must agree. Synthetic
// stylesheets compare the resolver with the engine directly, sabotaged resolvers must be caught,
// and a pass with custom properties reported missing runs the old-engine gates. No TV.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openPreview, root } from './browser.mjs';

const PRIMARY = ['stremio', 'netflix', 'disneyplus', 'youtube', 'appletv', 'primevideo', 'abciview', 'sbs', 'applemusic'];
const IDS = ['IkWsFHtOY9.Stremio', 'org.tizen.netflix-app', 'MCmYXNxgcu.DisneyPlus', '9Ur5IzDKqV.TizenYouTube', 'com.samsung.tv.aria-video', 'org.tizen.primevideo', 'mWK87Xghap.ABCiview', 'OyE7OuxlUi.SBSOnDemand', 'org.tizen.apple.apple-music'];
const NAMES = ['Stremio', 'Netflix', 'Disney+', 'YouTube', 'Apple TV', 'Prime Video', 'ABC iview', 'SBS On Demand', 'Apple Music'];
const CATALOG = IDS.map((id, i) => ({ id, name: NAMES[i], show: true, iconPath: '' })).concat([{ id: 'AbCdEf1234.FamilyApp', name: 'Family TV', show: true, iconPath: '' }]);
const SEED = { dock: PRIMARY, wallpaper: 'misty', mode: 'fixed', lastApp: 'netflix', theme: 'shore' };
// An installed text widget in the Tizen host's two-slot record (tizen-store.js), with no host widget registered.
const ADDON_DATA = JSON.stringify({ installed: { note: { api: 1, id: 'note', name: 'Note', version: '1.0.0', kind: 'text', description: 'Short note', author: 'QA', license: 'MIT', text: 'Hello from the legacy check', enabled: true } }, catalog: [], catalogInfo: { checked: false, total: 0, compatible: 0 } });
const ADDONS = JSON.stringify({ v: 1, seq: 1, sum: createHash('sha256').update(ADDON_DATA).digest('hex'), data: ADDON_DATA });
// Computed on every rendered element of the stage, plus html and body.
const PROPS = ['display', 'visibility', 'opacity', 'color', 'background-color', 'background-image', 'box-shadow', 'text-shadow',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-width', 'border-left-width',
  'border-top-left-radius', 'border-bottom-right-radius', 'outline-color', 'width', 'height', 'top', 'left', 'right', 'bottom', 'transform',
  'font-family', 'font-weight', 'font-size', 'letter-spacing', 'line-height', 'font-variant-numeric', 'font-feature-settings', '-webkit-mask-image', 'clip-path',
  'stroke', 'fill', 'transition-property', 'transition-duration', 'transition-timing-function', 'animation-name', 'z-index'];
const PSEUDO = ['content', 'opacity', 'background-color', 'background-image', 'box-shadow', 'border-top-left-radius'];
// The one intentional difference, and a required one: legacy adds -webkit-font-feature-settings:"tnum"
// beside font-variant-numeric:tabular-nums, which Chromium 47 lacks; the rendered digits are the same.
function expected(prop, rec) { return prop === 'font-feature-settings' && rec[prop] === 'normal' && /tabular-nums/.test(rec['font-variant-numeric']) ? '"tnum"' : rec[prop]; }

function harness({ catalog, seed, adaptive, addons }) {
  if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('cleantv.home.v1', JSON.stringify(seed)); if (addons) localStorage.setItem('cleantv.addons.v1.a', addons); sessionStorage.setItem('__seeded', '1'); }
  // Legacy engines run without adaptive ink, so the main pass compares both renderings without it.
  if (!adaptive) Object.defineProperty(window, 'CleanFrameAdaptiveInk', { configurable: true, get: () => ({}), set: () => {} });
  // A fixed wall clock keeps clock and date widths identical; timers keep the real Date.now.
  const RealDate = Date, fixed = new RealDate(2026, 9, 31, 10, 8, 0).getTime();
  window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixed])); } };
  window.tizen = {
    ApplicationControlData: function (key, value) { this.key = key; this.value = value; },
    ApplicationControl: function (operation, uri, mime, category, data) { Object.assign(this, { operation, uri, mime, category, data }); },
    application: {
      getCurrentApplication() { return { appInfo: { id: 'nClrkHome1.FrameHome' }, hide() {} }; },
      // Only old engines probe installed apps; this engine keeps the reference IDs.
      getAppInfo(id) { return { id: id || 'nClrkHome1.FrameHome', name: id, show: true, iconPath: '' }; },
      getAppsInfo(ok) { setTimeout(() => ok(catalog.map(a => ({ ...a }))), 0); },
      launch(id, ok) { setTimeout(ok, 0); },
      launchAppControl(control, id, ok) { setTimeout(ok, 0); }
    }
  };
}

function snapshot({ props, pseudo }) {
  document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { /* infinite or idle */ } });
  const stage = document.getElementById('stage'), out = {};
  function path(el) {
    if (el === document.documentElement) return 'html';
    if (el.id) return '#' + el.id;
    const parent = el.parentElement, index = Array.prototype.indexOf.call(parent.children, el);
    return path(parent) + '>' + el.tagName.toLowerCase() + (el.getAttribute('class') ? '.' + el.getAttribute('class').trim().split(/\s+/).join('.') : '') + '[' + index + ']';
  }
  [document.documentElement, document.body, stage].concat(Array.from(stage.querySelectorAll('*'))).forEach(el => {
    if (el !== document.documentElement && !el.getClientRects().length) return;
    const cs = getComputedStyle(el), rec = {};
    props.forEach(p => { rec[p] = cs.getPropertyValue(p); });
    ['::before', '::after'].forEach(pe => {
      const ps = getComputedStyle(el, pe);
      if (ps.content && ps.content !== 'none' && ps.content !== 'normal') pseudo.forEach(p => { rec[pe + ' ' + p] = ps.getPropertyValue(p); });
    });
    out[path(el)] = rec;
  });
  return out;
}

// The real old-engine path in this browser: CSS.supports reports no custom properties, so legacy.js,
// main.js and device.js take their Chromium 47 branches, against a synthetic 2017 TV.
function oldEngine({ installed, model, seed, tabular, hide }) {
  if (seed && !sessionStorage.getItem('__seeded')) { localStorage.setItem('cleantv.home.v1', JSON.stringify(seed)); sessionStorage.setItem('__seeded', '1'); }
  const supports = CSS.supports.bind(CSS);
  CSS.supports = function (a) { return a === '--a' ? false : supports.apply(CSS, arguments); };
  delete Intl.DateTimeFormat.prototype.formatToParts;
  if (!tabular) { let p = CSSStyleDeclaration.prototype; while (p && !Object.prototype.hasOwnProperty.call(p, 'fontVariantNumeric')) p = Object.getPrototypeOf(p); if (p) delete p.fontVariantNumeric; }
  const RealDate = Date, fixed = new RealDate(2026, 9, 31, 10, 8, 0).getTime();
  window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixed])); } };
  window.__calls = [];
  window.tizen = {
    ApplicationControlData: function (key, value) { this.key = key; this.value = value; },
    ApplicationControl: function () {},
    systeminfo: { getCapability: key => key === 'http://tizen.org/system/model_name' ? model : null },
    application: {
      getCurrentApplication() { const app = { appInfo: { id: 'nClrkHome1.FrameHome' } }; if (hide) app.hide = () => window.__calls.push('hide'); return app; },
      getAppInfo(id) { if (installed.indexOf(id) < 0) { const e = new Error('Not installed'); e.name = 'NotFoundError'; throw e; } return { id, name: id, show: true }; },
      getAppsInfo(ok) { setTimeout(() => ok(installed.map(id => ({ id, name: id.split('.').pop(), show: true, iconPath: '' }))), 0); },
      launch(id, ok) { window.__calls.push(id); setTimeout(ok, 0); },
      launchAppControl(c, id, ok) { window.__calls.push('control:' + id); setTimeout(ok, 0); }
    }
  };
}
// IDs on the 2017 UE40MU6179, as in test-device.mjs.
const MU6179 = ['9Ur5IzDKqV.TizenYouTube', 'org.tizen.netflix-app', 'RN1MCdNq8t.Netflix', 'MCmYXNxgcu.DisneyPlus', 'evKhCgZelL.AmazonIgnitionLauncher2',
  'Y6A54cEa22.AppleTV', 'rJeHak5zRg.Spotify', 'org.tizen.browser', 'org.volt.firstscreen', 'org.tizen.menu', 'org.tizen.art-app'];

// Small stylesheets on a stand-in stage, natively and through createResolver. `reported` marks a
// documented limitation: the result may differ, but the resolver must say so.
const SYNTHETIC_HTML = '<main id="stage" class="stage"><div id="scene" class="scene"><div id="home" class="home"><span class="x" id="hx"></span><nav id="utils" class="utils quiet-utils"><b class="x u" id="ux"></b></nav><div id="dock" class="dock"><i class="x tile" id="dx"></i></div></div></div><div id="sheet" class="sheet"><span class="x" id="sx"></span></div></main>';
const SYNTHETIC = [
  { name: 'specificity: :not() counts its argument', css: '.stage:not(#nope){--a:red}.stage.stage{--a:blue}.x{color:var(--a)}' },
  { name: 'specificity: attribute vs class', css: '#stage[id]{--a:red}#stage.stage{--a:blue}.x{color:var(--a)}' },
  { name: 'specificity: type selectors', css: 'main.stage{--a:red}.stage{--a:blue}.x{color:var(--a)}' },
  { name: 'specificity: html:root', css: 'html:root{--a:red}:root{--a:blue}.x{color:var(--a)}' },
  { name: 'specificity: universal and combinator', css: '* .stage{--a:red}body > .stage{--a:blue}.x{color:var(--a)}' },
  { name: '!important custom property in an earlier rule', css: '.stage{--a:red!important}#stage.stage{--a:blue}.x{color:var(--a)}' },
  { name: '!important rule beats an inline variable', css: '.home{--a:red!important}.home .x{color:var(--a)}', inline: { home: { '--a': 'blue' } } },
  { name: 'inline variable beats rules', css: '#home.home{--a:red}.home .x{color:var(--a)}', inline: { home: { '--a': 'blue' } } },
  { name: 'later @media rule wins', css: '.stage{--a:red}@media all{.stage{--a:blue}}.x{color:var(--a)}' },
  { name: 'unmatched @media', css: '.stage{--a:red}@media (max-width:10px){.stage{--a:blue}}.x{color:var(--a)}' },
  { name: '@supports group', css: '.stage{--a:red}@supports (display:flex){.stage{--a:blue}}.x{color:var(--a)}' },
  { name: 'custom property declared in @media', css: '@media all{:root{--a:red}}.x{color:var(--a)}' },
  { name: 'inheritance and resolution at the declaring element', css: ':root{--al:var(--b)}.stage{--b:red}.x{color:var(--al,green)}' },
  { name: 'invalid at computed-value time does not inherit', css: '.stage{--a:red}.home{--a:var(--nope)}.home .x{color:var(--a,green)}' },
  { name: 'nested var() in a fallback referencing a descendant', css: '.stage{--a:var(--d,red)}.dock{--d:blue}.dock .x{color:var(--a)}' },
  { name: 'nested fallbacks and commas', css: ':root{--n:3px}.x{width:var(--nope,calc(1px + var(--n,2px)));height:var(--nope,var(--nope2,7px));box-shadow:var(--nope,0 0 1px red,0 0 2px blue)}', props: ['width', 'height', 'box-shadow'] },
  { name: 'fallback inside rgba()', css: '.x{background-color:rgba(12,10,8,var(--nope,.5))}', props: ['background-color'] },
  { name: 'unresolved value is unset, not dropped', css: '.x{color:red}.stage .x{color:var(--nope)}' },
  { name: 'unresolved value with !important', css: '.stage .x{color:var(--nope)!important}.x{color:red!important}' },
  { name: 'empty custom value', css: ':root{--e: ;}.x{color:red}.stage .x{color:var(--e)}' },
  { name: 'empty fallback', css: '.x{color:red}.stage .x{color:var(--nope,)}' },
  { name: 'cycle', css: ':root{--a:var(--b);--b:var(--a)}.x{color:var(--a,green)}' },
  { name: 'cycle through a fallback', css: ':root{--a:var(--q,var(--b));--b:var(--a,red)}.x{color:var(--b,green);background-color:var(--a,blue)}', props: ['color', 'background-color'] },
  { name: 'inherit and initial', css: '.stage{--a:red;--b:blue}.home{--a:inherit;--b:initial}.home .x{color:var(--a);background-color:var(--b,green)}', props: ['color', 'background-color'] },
  { name: 'comment with braces and semicolons', css: ':root{--a:red /* ;} */}.x{color:var(--a)/*}*/;background-color:green}', props: ['color', 'background-color'] },
  { name: 'string with braces', css: ':root{--a:"}{;"}.x::after{content:var(--a)}', props: [], pseudo: true },
  { name: 'var() inside strings', css: ':root{--a:1;--s:"var(--a)"}.x::before{content:"a var(--a) b" var(--a)}.u::after{content:var(--s)}', props: [], pseudo: true },
  { name: 'var() inside url() is a bad url', css: ':root{--a:"x.png"}.x{background-image:url(var(--a))}', props: ['background-image'] },
  { name: 'url() with parentheses', css: ':root{--a:red}.x{background:url("a(b).png") no-repeat,linear-gradient(var(--a),var(--a))}', props: ['background-image', 'background-repeat'] },
  { name: 'var() name without dashes is invalid', css: '.x{color:red}.stage .x{color:var(a, blue)}' },
  { name: 'upper-case VAR()', css: ':root{--a:red}.x{color:VAR(--a)}' },
  { name: 'whitespace around the name', css: ':root{--a:red}.x{color:var( --a )}' },
  { name: 'case-sensitive names', css: ':root{--Ab:red;--ab:blue}.x{color:var(--Ab)}' },
  { name: 'adjacent tokens', css: ':root{--n:4;--u:px;--m:2px}.x{margin-left:var(--n)var(--u);margin-top:var(--m)var(--m)}', props: ['margin-left', 'margin-top'] },
  { name: 'shorthand before a longhand', css: ':root{--c:red}.x{background:var(--c)}.stage .x{background-color:blue}', props: ['background-color'] },
  { name: 'longhand before a shorthand', css: ':root{--c:red}.stage .x{background-color:blue}.x{background:var(--c)}', props: ['background-color'] },
  { name: 'selector list members in different contexts', css: ':root{--a:red}.home{--a:green}.x.u,.stage .u{color:var(--a)}' },
  { name: 'invalid selector list member drops the rule', css: ':root{--a:red}.x{color:blue}.x,.x:unknown-pseudo{color:var(--a)}' },
  { name: 'consumer on html', css: ':root{--a:red}html{color:var(--a)}.x{color:inherit}' },
  { name: 'consumer on body', css: ':root{--a:red}.stage{--a:blue}body{background-color:var(--a)}', props: ['background-color'] },
  { name: 'transition shorthand', css: ':root{--t:180ms;--e:cubic-bezier(.2,.7,.2,1)}.x{transition:transform var(--t) var(--e),opacity 120ms linear}', props: ['transition-duration', 'transition-timing-function', 'transition-property'] },
  { name: 'tnum twin beside a later font-feature-settings', css: '.x{font-variant-numeric:tabular-nums}.stage .x{font-feature-settings:"liga" 0}', props: ['font-feature-settings', 'font-variant-numeric'] },
  { name: 'state class in a declaring selector', css: ':root{--a:red}.stage.is-on{--a:blue}.x{color:var(--a)}', classes: { stage: 'stage is-on' } },
  { name: 'declaring :not(state)', css: ':root{--a:red}.stage:not(.is-on){--a:blue}.x{color:var(--a)}' },
  { name: 'declaration on a non-context ancestor', css: ':root{--a:red}.scene{--a:blue}.home .x{color:var(--a)}', reported: 'stray' },
  { name: 'declaration on a non-context leaf', css: ':root{--a:red}.tile{--a:blue}.x{color:var(--a)}', reported: 'stray' },
  { name: 'declaration on a pseudo-element', css: ':root{--a:red}.x::before{--a:blue;content:"a";color:var(--a)}', props: [], pseudo: true, reported: 'note' },
  { name: 'var() in @keyframes', css: ':root{--o:.5}.home{--o:.2}@keyframes k{from{opacity:var(--o)}to{opacity:var(--o)}}.x{animation:k 1s paused}', props: ['opacity'], reported: 'note' }
];
function synthetic([c, html]) {
  const I = window.CleanTVLegacy._internals, props = c.props || ['color'];
  document.body.innerHTML = html;
  for (const id in c.classes || {}) document.getElementById(id).className = c.classes[id];
  for (const id in c.inline || {}) for (const k in c.inline[id]) document.getElementById(id).style.setProperty(k, c.inline[id][k]);
  const sheet = document.createElement('style'), scratch = document.createElement('style');
  sheet.textContent = c.css; scratch.media = 'not all'; document.head.append(sheet, scratch);
  const els = [document.documentElement, document.body].concat(Array.from(document.body.querySelectorAll('*')));
  const snap = () => els.map(el => {
    const cs = getComputedStyle(el), r = { el: el.id || el.tagName.toLowerCase() };
    props.forEach(p => { r[p] = cs.getPropertyValue(p); });
    if (c.pseudo) ['::before', '::after'].forEach(pe => { const ps = getComputedStyle(el, pe); r[pe + ' content'] = ps.content; r[pe + ' color'] = ps.color; });
    return r;
  });
  const native = snap();
  const ok = rule => { try { scratch.sheet.insertRule(rule, 0); scratch.sheet.deleteRule(0); return true; } catch (e) { return false; } };
  const DEFS = [{ key: 'root', tokens: [':root', 'html'] }, { key: 'stage', id: 'stage', tokens: ['#stage', '.stage'] }, { key: 'home', id: 'home', tokens: ['#home', '.home'] },
    { key: 'sheet', id: 'sheet', tokens: ['#sheet', '.sheet'] }, { key: 'utils', id: 'utils', tokens: ['#utils', '.quiet-utils', '.utils'] }, { key: 'dock', id: 'dock', tokens: ['#dock', '.dock'] }];
  let r, text = '', error = null;
  try {
    r = I.createResolver(c.css, { defs: DEFS, rootKey: 'root', fallbackKey: 'stage', valid: sel => ok(sel + '{}'), validAt: ok, supports: (p, v) => !CSS.supports(p, 'inherit') || CSS.supports(p, v) });
    const nodes = DEFS.map(d => ({ key: d.key, el: d.id ? document.getElementById(d.id) : document.documentElement }));
    nodes.forEach(n => { n.depth = 0; for (let q = n.el.parentNode; q && q.nodeType === 1; q = q.parentNode) n.depth++; n.parent = null; for (let q = n.el.parentNode; q && q.nodeType === 1 && n.parent === null; q = q.parentNode) nodes.forEach(o => { if (o.el === q) n.parent = o.key; }); });
    nodes.sort((a, b) => a.depth - b.depth);
    const contexts = () => nodes.map(n => { const inline = {}; for (let i = 0; i < n.el.style.length; i++) if (n.el.style[i].slice(0, 2) === '--') inline[n.el.style[i]] = n.el.style.getPropertyValue(n.el.style[i]).trim();
      return { key: n.key, parent: n.parent, depth: n.depth, tag: n.el.tagName.toLowerCase(), id: n.el.id, className: n.el.getAttribute('class') || '', inline, matches: sel => { try { return n.el.matches(sel); } catch (e) { return false; } } }; });
    const contextOf = el => { for (let p = el; p; p = p.parentNode) for (const n of nodes) if (n.el === p) return n.key; return null; };
    const locate = sel => { let list, seen = null; try { list = document.querySelectorAll(sel); } catch (e) { return null; } for (const el of list) { const k = contextOf(el); if (k !== null) { seen = seen || {}; seen[k] = (seen[k] || 0) + 1; } } return seen; };
    r.run({ preKey: null, contexts, media: (n, p) => n === 'media' ? matchMedia(p).matches : CSS.supports(p), locate });
    text = r.text();
  } catch (e) { error = String(e && e.message || e); }
  sheet.textContent = text;
  const legacy = snap(), diffs = [];
  native.forEach((n, i) => { for (const k in n) if (n[k] !== legacy[i][k]) diffs.push(n.el + ' ' + k + ': ' + n[k] + ' / ' + legacy[i][k]); });
  const strays = r ? Object.keys(r.strays(sel => { try { return Array.from(document.querySelectorAll(sel)).filter(el => !['stage', 'home', 'sheet', 'utils', 'dock'].includes(el.id) && el !== document.documentElement).length; } catch (e) { return 0; } })) : [];
  sheet.remove(); scratch.remove();
  return { error, diffs, text, notes: r ? r.diagnostics.notes : [], strays };
}

const STATES = [], EXTENDED = [], WIDGETS = [], CARDS = [];
let target = STATES;
function state(name, prefs, steps = []) { if (!process.env.CHECK_STATE || name.toLowerCase().includes(process.env.CHECK_STATE.toLowerCase())) target.push({ name, prefs, steps }); }
const base = { bg: 'photo', wall: 'misty', layout: 'dock', apps: 'both', controls: 'icons', focus: 'glass', material: 'soft', font: 'manrope', controlsPosition: 'auto', language: 'en', dateVisible: true };
const look = patch => ({ ...base, ...patch });
for (const bg of ['dark', 'light']) for (const layout of ['dock', 'list']) {
  state(bg + ' ' + layout, look({ bg, layout }));
  state(bg + ' ' + layout + ' type focus, utility', look({ bg, layout, focus: 'type', controls: 'both' }), [['nav', layout === 'dock' ? 'up' : 'right']]);
}
for (const wall of ['misty', 'cove', 'peaks', 'bridge', 'golden', 'sydney', 'night', 'summit']) for (const layout of ['dock', 'list']) state('photo ' + wall + ' ' + layout, look({ wall, layout }));
state('photo peaks dock frost, second tile', look({ wall: 'peaks', material: 'frost' }), [['nav', 'right']]);
state('photo golden dock frost, utility', look({ wall: 'golden', material: 'frost', controls: 'both' }), [['nav', 'up']]);
// Wallpapers with the base veil have no fv- class: the Frost veil then uses its var() fallback.
state('photo cove dock frost, base veil', look({ wall: 'cove', material: 'frost' }), [['nav', 'right']]);
state('photo forest list glass frost, base veil', look({ wall: 'forest', layout: 'list', material: 'frost' }), [['nav', 'down']]);
state('photo bridge list type, utility', look({ wall: 'bridge', layout: 'list', focus: 'type', controls: 'text' }), [['nav', 'right'], ['nav', 'down']]);
state('photo sydney list glass, third row', look({ wall: 'sydney', layout: 'list' }), [['nav', 'down'], ['nav', 'down']]);
for (const apps of ['icons', 'text']) for (const layout of ['dock', 'list']) state('photo cove ' + layout + ' apps ' + apps, look({ wall: 'cove', layout, apps }), [['nav', layout === 'dock' ? 'right' : 'down']]);
for (const controlsPosition of ['top', 'bottom']) state('photo night dock controls ' + controlsPosition, look({ wall: 'night', controlsPosition, controls: 'text' }), [['nav', 'up']]);
state('dark dock controls bottom, utility', look({ bg: 'dark', controlsPosition: 'bottom' }), [['focus', 'util.settings']]);
for (const font of ['geist', 'newsreader']) {
  state('photo peaks list font ' + font, look({ wall: 'peaks', layout: 'list', font }));
  state('photo misty dock font ' + font + ', utility', look({ font, controls: 'both' }), [['nav', 'up']]);
  state('light list font ' + font + ' apps icons', look({ bg: 'light', layout: 'list', font, apps: 'icons' }));
}
state('German photo dock', look({ language: 'de', wall: 'golden' }), [['nav', 'up']]);
state('German light list', look({ language: 'de', bg: 'light', layout: 'list' }));
state('Settings overview, photo', look({ wall: 'bridge' }), [['scene', 'settings']]);
state('Settings overview, light, German', look({ bg: 'light', language: 'de' }), [['scene', 'settings'], ['nav', 'down']]);
for (const g of ['background', 'layout', 'typography', 'focus', 'clock', 'addons', 'language', 'samsung']) state('Settings ' + g + ' detail, photo', look({ wall: 'peaks' }), [['scene', 'settings'], ['act', 'settings.group.' + g]]);
state('Settings add-ons discover, light, German', look({ bg: 'light', language: 'de' }), [['scene', 'settings'], ['act', 'settings.group.addons'], ['act', 'addon.tab.discover']]);
state('Settings layout detail, dark list', look({ bg: 'dark', layout: 'list' }), [['scene', 'settings'], ['act', 'settings.group.layout'], ['nav', 'down']]);
state('Settings focus detail, light type', look({ bg: 'light', focus: 'type' }), [['scene', 'settings'], ['act', 'settings.group.focus']]);
state('Wallpaper picker', look({ wall: 'summit' }), [['scene', 'settings'], ['act', 'settings.group.background'], ['act', 'background.wallpaper']]);
state('All apps, photo glass', look({ wall: 'cove' }), [['scene', 'apps'], ['nav', 'down']]);
state('All apps, dark type', look({ bg: 'dark', focus: 'type' }), [['scene', 'apps']]);
state('Home editor, light', look({ bg: 'light' }), [['scene', 'editor'], ['focus', 'editor.move.youtube'], ['nav', 'right']]);
state('Home editor, photo glass', look({ wall: 'night' }), [['scene', 'editor']]);
state('Leave message, photo', look({ wall: 'golden' }), [['nav', 'back']]);
state('Leave message, dark German', look({ bg: 'dark', language: 'de' }), [['nav', 'back']]);
// Adaptive ink and the clear tint redefine variables inside Home and the sheet. Old engines gate
// both off, but a forced resolver on this engine must still render them identically.
target = EXTENDED;
state('adaptive night dock, utility', look({ wall: 'night', controls: 'both' }), [['nav', 'up']]);
state('adaptive peaks list, second row', look({ wall: 'peaks', layout: 'list' }), [['nav', 'down']]);
state('adaptive amber dock icons, app name', look({ wall: 'amber', apps: 'icons' }), [['nav', 'right']]);
state('adaptive sydney list, layout detail', look({ wall: 'sydney', layout: 'list' }), [['scene', 'settings'], ['act', 'settings.group.layout']]);
state('adaptive mint dock, settings overview', look({ wall: 'mint' }), [['scene', 'settings']]);
state('adaptive summit list type, utility', look({ wall: 'summit', layout: 'list', focus: 'type', controls: 'text' }), [['nav', 'right']]);
state('tint bridge dock', look({ wall: 'bridge', material: 'tint' }), [['nav', 'right']]);
state('tint goldcoast list, all apps', look({ wall: 'goldcoast', layout: 'list', material: 'tint' }), [['scene', 'apps'], ['nav', 'down']]);
state('tint alpine dock, editor', look({ wall: 'alpine', material: 'tint' }), [['scene', 'editor']]);
state('tint misty dock, utility', look({ wall: 'misty', material: 'tint', controls: 'both' }), [['nav', 'up']]);
state('tint cove dock, focus detail', look({ wall: 'cove', material: 'tint' }), [['scene', 'settings'], ['act', 'settings.group.focus']]);
// A stored text widget renders in #addonWidgets; the CleanTV widget slot stays empty without a host widget.
target = WIDGETS;
state('installed text widget, empty widget slot, photo dock', look({ wall: 'golden' }));
state('installed text widget, empty widget slot, dark list', look({ bg: 'dark', layout: 'list', dateVisible: false }));
state('installed text widget, settings add-ons', look({ wall: 'peaks' }), [['scene', 'settings'], ['act', 'settings.group.addons']]);
// A host widget card resolves --cw-* and its registered glass plate on every background family.
target = CARDS;
state('widget card, photo misty dock', look({ wall: 'misty' }));
state('widget card, photo peaks dock', look({ wall: 'peaks' }));
state('widget card, photo peaks list', look({ wall: 'peaks', layout: 'list' }));
state('widget card, photo cove list, top controls', look({ wall: 'cove', layout: 'list', controlsPosition: 'top' }));
state('widget card, light dock, no date', look({ bg: 'light', dateVisible: false }));
state('widget card, dark list', look({ bg: 'dark', layout: 'list' }));

const failures = [], notes = [];
let compared = { states: 0, elements: 0, values: 0, intentional: 0 };
function fail(name, detail) { failures.push({ name, detail }); console.error('FAIL ' + name + (detail ? ': ' + JSON.stringify(detail).slice(0, 1500) : '')); }

async function open(preview, query, { extra, adaptive, addons, legacySource, mainSource, wait = true } = {}) {
  const page = await preview.browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.setDefaultTimeout(15000);
  page.__errors = [];
  page.on('pageerror', error => page.__errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) page.__errors.push(response.status() + ' ' + response.url()); });
  await page.addInitScript(harness, { catalog: CATALOG, seed: SEED, adaptive: !!adaptive, addons: addons ? ADDONS : '' });
  if (extra) await page.addInitScript(extra);
  if (legacySource) await page.route('**/legacy.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: legacySource }));
  if (mainSource) await page.route('**/main.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: mainSource }));
  await page.goto(preview.baseURL + '/home/' + query);
  if (wait) await ready(page);
  return page;
}
const ready = page => page.waitForFunction(() => window.ShoreQA && ShoreQA.ready(), null, { timeout: 15000 });
async function drive(page, s) {
  await page.evaluate(p => ShoreQA.preferences(p), s.prefs);
  await ready(page);
  // Each state starts on the same tile; steps from earlier states must not accumulate.
  if (!(await page.evaluate(() => { ShoreQA.scene('home'); return ShoreQA.focus('home.app.netflix'); }))) throw Error('Home has no Netflix tile');
  await ready(page);
  for (const [kind, arg] of s.steps) {
    // A key that moves nothing would compare a different state than the name says.
    const ok = await page.evaluate(([k, a]) => {
      const before = JSON.stringify(ShoreQA.where());
      if (k === 'nav') { ShoreQA.nav(a); return JSON.stringify(ShoreQA.where()) !== before; }
      return k === 'scene' ? !!ShoreQA.scene(a) : k === 'act' ? !!ShoreQA.activate(a) : ShoreQA.focus(a);
    }, [kind, arg]);
    if (!ok) throw Error(kind + ' ' + arg + (kind === 'nav' ? ' moved nothing' : ' is unavailable'));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  await ready(page);
  // Row ghosts, reflow and font-switch classes clear within 220 ms.
  await page.waitForTimeout(350);
  return page.evaluate(() => ({ look: ShoreQA.state().look, shown: ShoreQA.state().shown, where: ShoreQA.where(), fonts: ShoreQA.state().fonts.available, stage: document.getElementById('stage').className }));
}
function compare(name, a, b, quiet) {
  const mismatches = [];
  for (const key of new Set(Object.keys(a).concat(Object.keys(b)))) {
    if (!a[key] || !b[key]) { mismatches.push({ element: key, only: a[key] ? 'native' : 'legacy' }); continue; }
    if (!quiet) compared.elements++;
    for (const prop of Object.keys(a[key])) {
      const want = expected(prop, a[key]);
      if (b[key][prop] !== want) mismatches.push({ element: key, prop, native: a[key][prop], legacy: b[key][prop], expected: want });
      else if (!quiet && want !== a[key][prop]) compared.intentional++;
      if (!quiet) compared.values++;
    }
  }
  if (quiet) return mismatches.length;
  compared.states++;
  if (mismatches.length) fail('Equivalent styles: ' + name, { count: mismatches.length, first: mismatches.slice(0, 12) });
  return mismatches.length;
}
async function sheetFacts(page) {
  return page.evaluate(() => {
    const L = window.CleanTVLegacy, style = document.getElementById('legacyResolved'), link = document.querySelector('link[href="style.css"]');
    const cssom = style ? Array.from(style.sheet.cssRules).map(r => r.cssText).join('\n') : '';
    return { active: L.active, style: !!style, textVar: style ? /var\(/i.test(style.textContent) : null, cssomVar: /var\(/i.test(cssom), current: L._internals.text ? /var\(/i.test(L._internals.text()) : null,
      linkDisabled: link.disabled, boot: !!document.getElementById('legacyBoot'), overlay: document.getElementById('legacyErrors') ? document.getElementById('legacyErrors').textContent : null,
      audit: L._internals.audit ? L._internals.audit() : null, diagnostics: L._internals.diagnostics ? L._internals.diagnostics() : null, stats: L._internals.stats || null };
  });
}

async function pass(native, legacy, states) {
  for (const s of states) {
    // Both pages always finish a state, so one failure cannot shift the next comparison.
    const [ra, rb] = await Promise.allSettled([drive(native, s), drive(legacy, s)]), a = ra.value, b = rb.value;
    if (ra.status === 'rejected' || rb.status === 'rejected') { fail('Drive ' + s.name, (ra.reason || rb.reason).message); continue; }
    // The forced resolver runs on a modern engine, so no old-engine gate may change the state.
    if (JSON.stringify(a) !== JSON.stringify(b)) { fail('Same state: ' + s.name, { native: a, legacy: b }); continue; }
    if (s.prefs.font !== 'manrope' && a.look.font !== s.prefs.font) { fail('Font offered: ' + s.name, a.fonts); continue; }
    const [sa, sb] = await Promise.all([native.evaluate(snapshot, { props: PROPS, pseudo: PSEUDO }), legacy.evaluate(snapshot, { props: PROPS, pseudo: PSEUDO })]);
    compare(s.name, sa, sb);
    const facts = await sheetFacts(legacy);
    if (facts.audit.length) fail('Context audit: ' + s.name, facts.audit.slice(0, 8));
    if (Object.keys(facts.diagnostics.ambiguous).length) notes.push(s.name + ': ambiguous contexts ' + JSON.stringify(facts.diagnostics.ambiguous));
    if (facts.diagnostics.notes.length) fail('No resolver diagnostics: ' + s.name, facts.diagnostics.notes);
    if (facts.cssomVar || facts.current || facts.overlay) fail('Resolved sheet stays clean: ' + s.name, facts);
  }
}

const preview = await openPreview({ publicFonts: true });
let extended = [];
try {
  const native = await open(preview, ''), legacy = await open(preview, '?legacy=1');
  const nf = await sheetFacts(native), lf = await sheetFacts(legacy);
  if (nf.active || nf.style || nf.boot || nf.linkDisabled) fail('Native engine leaves legacy.js inert', nf);
  if (!lf.active || !lf.style || lf.textVar || lf.cssomVar || lf.current || !lf.linkDisabled || lf.boot || lf.overlay) fail('Forced resolver replaces style.css', lf);
  await pass(native, legacy, STATES);
  if (EXTENDED.length) {
    extended = [await open(preview, '', { adaptive: true }), await open(preview, '?legacy=1', { adaptive: true })];
    await pass(extended[0], extended[1], EXTENDED);
  }
  if (WIDGETS.length) {
    const pair = [await open(preview, '', { addons: true }), await open(preview, '?legacy=1', { addons: true })];
    extended = extended.concat(pair);
    const shown = await pair[1].evaluate(() => { const slot = document.getElementById('cleantvWidgets'); return { card: document.querySelector('#addonWidgets .addon-widget p')?.textContent, slot: !!slot && slot.parentElement.id === 'home' && slot.children.length === 0 }; });
    if (shown.card !== 'Hello from the legacy check' || !shown.slot) fail('Stored text widget and empty widget slot render', shown);
    await pass(pair[0], pair[1], WIDGETS);
  }
  if (CARDS.length) {
    const widget = () => {
      const queue = window.CleanTVWidgets = { queue: [] };
      queue.register = function () { queue.queue.push(Array.prototype.slice.call(arguments)); };
      queue.register('qa', { render: el => { if (!el.firstChild) el.innerHTML = '<span class="cw-title">Berlin</span><span class="cw-big">' + window.CleanTVIcon('<circle cx="24" cy="24" r="9"/>', 48) + '21°</span><span class="cw-small">Wind 12 km/h</span>'; } });
    };
    const pair = [await open(preview, '', { extra: widget }), await open(preview, '?legacy=1', { extra: widget })];
    extended = extended.concat(pair);
    const card = await pair[1].evaluate(() => { const el = document.querySelector('#cleantvWidgets .cw-card'); return el && el.getClientRects().length ? getComputedStyle(el).color : null; });
    if (!card) fail('A registered widget card renders under the resolver', card);
    await pass(pair[0], pair[1], CARDS);
  }

  // The resolver against the engine on synthetic stylesheets; documented limitations must be reported.
  const source = readFileSync(root + 'app/legacy.js', 'utf8');
  const scratchPage = await preview.browser.newPage();
  async function differential(code) {
    await scratchPage.setContent('<!doctype html><html><head></head><body></body></html>');
    await scratchPage.addScriptTag({ content: code });
    const out = [];
    for (const c of SYNTHETIC) out.push({ c, ...(await scratchPage.evaluate(synthetic, [c, SYNTHETIC_HTML])) });
    return out;
  }
  let synthetics = 0;
  for (const { c, error, diffs, text, notes: said, strays } of await differential(source)) {
    if (error) fail('Synthetic ' + c.name, error);
    else if (c.reported === 'note' ? !said.length : c.reported === 'stray' ? !strays.length : said.length || diffs.length) fail('Synthetic ' + c.name, { diffs, text, notes: said, strays });
    else synthetics++;
  }

  // Negative controls: each sabotaged resolver must be caught by the shipped states or the synthetic sheets.
  const SABOTAGE = [
    ['inheritance', 'for (k in parent) if (has(parent, k)) env[k] = parent[k];', '', 'photo misty dock'],
    ['var() fallbacks', 'if ((v === null || v === undefined) && comma >= 0) v = substitute(trim(inner.slice(comma + 1)), lookup, loose);', '', 'photo cove dock frost, base veil'],
    ['the tnum twin', "if (d.prop === 'font-variant-numeric'", "if (false && d.prop === 'font-variant-numeric'", 'photo misty dock'],
    ['specificity', '(x.important ? IMPORTANT : NORMAL) + d.spec * 1e4 + d.order', '(x.important ? IMPORTANT : NORMAL) + d.order'],
    ['!important custom properties', '(x.important ? IMPORTANT : NORMAL) + d.spec', 'NORMAL + d.spec'],
    ['inline variables', 'put(k, inline[k], INLINE)', 'put(k, inline[k], 0)'],
    ['unset for unresolved values', "value: v === null ? 'unset' : v", "value: v === null ? '' : v"],
    ['var() fallbacks (synthetic)', 'if ((v === null || v === undefined) && comma >= 0) v = substitute(trim(inner.slice(comma + 1)), lookup, loose);', ''],
    ['string and url() masking', 'seen = opaque(value), m, end', 'seen = value, m, end'],
    ['the var() name check', 'if (BADVAR.test(seen)) return;', '']
  ];
  for (const [what, from, to, stateName] of SABOTAGE) {
    const broken = source.replace(from, to);
    if (broken === source) { fail('Negative control can sabotage ' + what); continue; }
    let found = 0;
    if (stateName) {
      const control = STATES.find(x => x.name === stateName);
      if (!control) { if (!process.env.CHECK_STATE) fail('Negative control state exists: ' + stateName); continue; }
      const sabotaged = await open(preview, '?legacy=1', { legacySource: broken });
      await Promise.all([drive(native, control), drive(sabotaged, control)]);
      const [sa, sb] = await Promise.all([native.evaluate(snapshot, { props: PROPS, pseudo: PSEUDO }), sabotaged.evaluate(snapshot, { props: PROPS, pseudo: PSEUDO })]);
      found = compare('negative control', sa, sb, true);
      await sabotaged.close();
    } else found = (await differential(broken)).filter(x => !x.c.reported).reduce((n, x) => n + x.diffs.length + (x.error ? 1 : 0), 0);
    if (!found) fail('Comparison detects a resolver without ' + what);
    else notes.push('negative control: a resolver without ' + what + ' differs in ' + found + ' values' + (stateName ? ' (' + stateName + ')' : ' (synthetic)'));
  }
  await scratchPage.close();

  // Failure surfaces: the stage must never stay hidden, and errors must reach the screen.
  const surface = page => page.evaluate(() => ({ boot: !!document.getElementById('legacyBoot'), resolved: !!document.getElementById('legacyResolved'), linkDisabled: document.querySelector('link[href="style.css"]').disabled,
    opacity: getComputedStyle(document.getElementById('stage')).opacity, overlay: document.getElementById('legacyErrors') ? document.getElementById('legacyErrors').textContent : '' }));
  const crashed = await open(preview, '?legacy=1', { mainSource: 'throw new Error("QA main.js failure");', wait: false });
  await crashed.waitForLoadState('load');
  let f = await surface(crashed);
  if (f.boot || !f.resolved || !f.linkDisabled || f.opacity !== '1' || !/QA main\.js failure @ main\.js:1/.test(f.overlay)) fail('A main.js failure before the first render still shows the resolved stage and the error', f);
  await crashed.close();
  const noResolver = await open(preview, '?legacy=1', { legacySource: source.replace('function createResolver(text, opts) {', 'function createResolver(text, opts) { throw new Error("QA resolver failure");') });
  f = await surface(noResolver);
  if (f.boot || f.resolved || f.linkDisabled || f.opacity !== '1' || !/Legacy CSS: QA resolver failure/.test(f.overlay)) fail('A resolver failure keeps style.css and shows the error', f);
  await noResolver.evaluate(() => { Promise.reject(new Error('QA rejection')); return new Promise(r => setTimeout(r, 50)); });
  f = await surface(noResolver);
  if (!/Unhandled rejection: QA rejection/.test(f.overlay)) fail('Unhandled rejections reach the overlay', f);
  if (!(await noResolver.evaluate(() => ShoreQA.ready()))) fail('Home still starts when the resolver fails');
  await noResolver.close();

  // apply() cost in this browser, then with 6x CPU throttling as a rough stand-in for a 2017 TV.
  const timing = async () => legacy.evaluate(() => {
    const L = window.CleanTVLegacy, stage = document.getElementById('stage'), dock = document.getElementById('dock'), n = 200, out = {};
    let t = performance.now(); for (let i = 0; i < n; i++) L.apply(); out.noChange = (performance.now() - t) / n;
    t = performance.now(); for (let i = 0; i < n; i++) { stage.classList.toggle('qa-probe'); L.apply(); } out.irrelevantClass = (performance.now() - t) / n;
    t = performance.now(); for (let i = 0; i < 40; i++) { L.setVar(dock, '--tile-w', (200 + i) + 'px'); L.apply(); } out.dockVar = (performance.now() - t) / 40;
    t = performance.now(); for (let i = 0; i < 40; i++) { stage.classList.toggle('bg-light'); L.apply(); } out.themeClass = (performance.now() - t) / 40;
    // The same, including the style recalculation a native class change also costs.
    t = performance.now(); for (let i = 0; i < 40; i++) { stage.classList.toggle('bg-light'); L.apply(); document.body.offsetWidth; } out.themeClassWithStyle = (performance.now() - t) / 40;
    out.unsettledQueries = L._internals.unsettled();
    stage.classList.remove('qa-probe'); ShoreQA.render();
    return out;
  });
  const fast = await timing(), cdp = await legacy.context().newCDPSession(legacy);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const slow = await timing();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const stats = (await sheetFacts(legacy)).stats;
  if (fast.noChange > 1) fail('No-change apply stays cheap', fast);

  // Chromium 47 has no formatToParts; the date must still render in both languages.
  const parts = await open(preview, '?legacy=1', { extra: () => { delete Intl.DateTimeFormat.prototype.formatToParts; } });
  for (const [language, pattern] of [['de', /^Sa\. 31\. Oktober$/], ['en', /^Sat,? 31 October$/]]) {
    await parts.evaluate(l => ShoreQA.preferences({ language: l, dateVisible: true }), language);
    await ready(parts);
    const text = await parts.locator('#caption .clock-date').textContent();
    if (!pattern.test(text)) fail('Date without formatToParts (' + language + ')', text);
  }
  for (const page of [native, legacy, parts].concat(extended)) if (page.__errors.length) fail('No page errors', page.__errors);

  // Old-engine gates, with custom properties reported missing so the resolver runs for real.
  const old = [];
  const openOld = async options => {
    const page = await preview.browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.setDefaultTimeout(15000); page.__errors = []; old.push(page);
    page.on('pageerror', error => page.__errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) page.__errors.push(response.status() + ' ' + response.url()); });
    await page.addInitScript(oldEngine, { model: 'UE40MU6179', installed: MU6179, ...options });
    await page.goto(preview.baseURL + '/home/');
    await ready(page);
    return page;
  };
  const check = (name, pass, detail) => { if (!pass) fail('Old engine: ' + name, detail); else compared.old++; };
  compared.old = 0;
  let page = await openOld({});
  const boot = await page.evaluate(async () => {
    // Each static face must decode in this engine; the variable face keeps its weight range.
    const statics = Array.from(document.fonts).filter(f => f.family.replace(/"/g, '') === 'Manrope' && /^\d+$/.test(f.weight));
    await Promise.all(statics.map(f => f.load().catch(() => null)));
    return { active: CleanTVLegacy.active, resolved: !!document.getElementById('legacyResolved'), overlay: (document.getElementById('legacyErrors') || {}).textContent || '',
      faces: statics.filter(f => f.status === 'loaded').map(f => f.weight).sort(),
      state: ShoreQA.state(), actions: ShoreQA.actions(), cell: document.querySelector('.clock-digit') ? getComputedStyle(document.querySelector('.clock-digit')).width : 'none',
      date: document.querySelector('#caption .clock-date').textContent, caps: FrameDevice.capabilities };
  });
  check('legacy.js resolves the stylesheet without errors', boot.active && boot.resolved && !boot.overlay, boot.overlay);
  check('static Manrope faces load', JSON.stringify(boot.faces) === '["400","500","600","700"]', boot.faces);
  check('a first run keeps only installed reference apps', JSON.stringify(boot.state.dock) === JSON.stringify(['netflix', 'disneyplus', 'youtube', 'appletv', 'primevideo']), boot.state.dock);
  check('fonts are limited to Manrope', JSON.stringify(boot.state.fonts.available) === '["manrope"]', boot.state.fonts);
  check('Art Mode is hidden on a non-Frame model', !boot.actions.includes('util.art') && boot.actions.includes('util.apps') && boot.caps.art === false, boot.actions);
  check('English date without formatToParts', boot.date === 'Sat 31 October', boot.date);
  await page.evaluate(() => ShoreQA.preferences({ wall: 'night', bg: 'photo', layout: 'list', focus: 'glass' }));
  await ready(page);
  const ink = await page.evaluate(() => ({ stage: document.getElementById('stage').className, field: ['phField', 'phFieldAlt'].map(id => document.getElementById(id).style.transform).join('|'), inline: document.getElementById('stage').getAttribute('style') }));
  check('no adaptive ink on an adaptive wallpaper', !/has-adaptive-ink|ink-(tl|tr|br)-/.test(ink.stage) && !/--(tl|tr|br)-/.test(ink.inline || ''), ink);
  check('the field uses a 2D translate', /translate\(/.test(ink.field) && !/translate3d/.test(ink.field), ink.field);
  await page.evaluate(() => { ShoreQA.scene('settings'); ShoreQA.activate('settings.group.focus'); });
  const materials = await page.evaluate(() => ShoreQA.actions().filter(a => a.indexOf('choice.material') === 0));
  check('material choices are Soft and Frost', JSON.stringify(materials) === '["choice.material.soft","choice.material.frost"]', materials);
  await page.evaluate(() => { ShoreQA.scene('settings'); ShoreQA.activate('settings.group.samsung'); ShoreQA.activate('samsung.home'); });
  await page.waitForFunction(() => __calls.length === 1);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); ShoreQA.scene('settings'); ShoreQA.activate('settings.group.samsung'); ShoreQA.activate('samsung.settings'); });
  await page.waitForFunction(() => __calls.length === 2);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); ShoreQA.scene('home'); ShoreQA.activate('home.app.appletv'); });
  await page.waitForFunction(() => __calls.length === 3);
  const calls = await page.evaluate(() => __calls);
  check('system screens and Apple TV use the installed IDs', JSON.stringify(calls) === JSON.stringify(['org.volt.firstscreen', 'org.tizen.menu', 'Y6A54cEa22.AppleTV']), calls);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); ShoreQA.scene('apps'); });
  await page.waitForFunction(() => ShoreQA.state().catalog.loaded);
  const catalog = await page.evaluate(() => ShoreQA.state().catalog.ids);
  check('All apps lists one Netflix and maps alternative IDs to brands', catalog.filter(id => id === 'netflix').length === 1 && !catalog.includes('RN1MCdNq8t.Netflix') && catalog.includes('appletv') && catalog.includes('primevideo'), catalog);
  const cell = boot.cell;
  page = await openOld({ seed: { look: { font: 'geist', material: 'tint', bg: 'photo', layout: 'dock', focus: 'glass', wall: 'misty' }, home: ['netflix', 'stremio'], mode: 'fixed' } });
  const saved = await page.evaluate(() => ({ c: ShoreQA.state().committed, stored: JSON.parse(localStorage.getItem('cleantv.home.v1')).look }));
  check('saved Geist and Clear tint fall back to Manrope and Soft', saved.c.font === 'manrope' && saved.c.material === 'soft' && saved.stored.font === 'manrope', saved);
  check('a saved Home keeps its apps', JSON.stringify(saved.c.home) === '["netflix","stremio"]', saved.c.home);
  page = await openOld({ installed: MU6179.concat('com.samsung.tv.csfs'), model: 'UE55LS003AUXXU' });
  check('a 2017 Frame keeps Art Mode', (await page.evaluate(() => ShoreQA.actions())).includes('util.art'));
  page = await openOld({ installed: [], hide: true });
  const hidden = await page.evaluate(() => { ShoreQA.nav('back'); const view = ShoreQA.state().view; ShoreQA.scene('settings'); ShoreQA.activate('settings.group.samsung'); const actions = ShoreQA.actions(); ShoreQA.activate('samsung.home'); return { view, actions, dock: ShoreQA.state().dock }; });
  await page.waitForFunction(() => __calls.length === 1);
  check('without Samsung targets Back still offers to leave, and leaving hides CleanFrame', hidden.view === 'message' && hidden.actions.includes('samsung.home') && !hidden.actions.includes('samsung.settings') && hidden.dock.length === 9 && JSON.stringify(await page.evaluate(() => __calls)) === '["hide"]', hidden);
  page = await openOld({ installed: [] });
  const none = await page.evaluate(() => { ShoreQA.nav('back'); const view = ShoreQA.state().view; ShoreQA.scene('settings'); return { view, actions: ShoreQA.actions() }; });
  check('without targets or hide() there is no Leave message or Samsung row', none.view === 'home' && !none.actions.includes('settings.group.samsung'), none);
  page = await openOld({ tabular: true });
  const tabular = await page.evaluate(() => document.querySelector('.clock-digit') ? getComputedStyle(document.querySelector('.clock-digit')).width : 'none');
  check('without font-variant-numeric the clock cell matches the tabular measurement', tabular === cell && tabular !== 'none', { tabular, cell });
  for (const p of old) { if (p.__errors.length) fail('Old engine: no page errors', p.__errors); await p.close(); }
  if (!process.env.CHECK_STATE && compared.states !== STATES.length + EXTENDED.length + WIDGETS.length + CARDS.length) fail('Every state is compared', compared);
  // Spotify on Samsung (tizen-spotify.js): the card and the QR screen with and without the resolver, then on
  // the real old-engine path. Routed fakes stand in for the relay, accounts.spotify.com, api.spotify.com and
  // i.scdn.co; playback is paused (a still progress bar) and Date.now is frozen (a still QR countdown).
  if (!process.env.CHECK_STATE || /spotify/i.test(process.env.CHECK_STATE)) {
    const slot = data => { const json = JSON.stringify(data); return JSON.stringify({ v: 1, seq: 1, sum: createHash('sha256').update(json).digest('hex'), data: json }); };
    const SPOTIFY_PACKAGE = { api: 1, id: 'spotify', name: 'Spotify', version: '1.0.0', kind: 'spotify', description: 'Spotify playback and account controls', author: 'CleanFrame', license: 'MIT', enabled: true };
    const seeds = { addons: slot({ installed: { spotify: SPOTIFY_PACKAGE }, catalog: [], catalogInfo: { checked: false, total: 0, compatible: 0 } }), token: slot({ refreshToken: 'qa-legacy-refresh' }) };
    const COVER = 'https://i.scdn.co/image/ab67616d00001e02' + '7'.repeat(24), cors = { 'access-control-allow-origin': '*' };
    const reply = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    const routeSpotify = page => Promise.all([
      page.route(url => url.origin === 'https://cleantv-spotify.tobiaspsi96.workers.dev', route => reply(route, new URL(route.request().url()).pathname === '/pair' ? { id: 'c0ffee' + '0'.repeat(26), expiresIn: 600 } : { pending: true })),
      page.route(url => url.origin === 'https://accounts.spotify.com', route => reply(route, { access_token: 'qa-legacy-access', token_type: 'Bearer', expires_in: 3600, scope: 'user-read-playback-state user-modify-playback-state' })),
      page.route(url => url.origin === 'https://api.spotify.com', route => reply(route, { device: { id: 'qa-device', is_restricted: false, name: 'QA speaker' }, progress_ms: 61000, is_playing: false, actions: { disallows: {} },
        item: { type: 'track', name: 'QA legacy track', duration_ms: 183000, artists: [{ name: 'QA Artist' }], album: { images: [{ url: COVER, width: 300, height: 300 }] } } })),
      page.route(url => url.origin === 'https://i.scdn.co', route => route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: readFileSync(root + 'app/icon.png') }))
    ]);
    // Runs after harness() or oldEngine(): seeds the installed package and a stored sign-in once, and freezes Date.now.
    const spotifyInit = s => {
      if (!sessionStorage.getItem('__spotifySeeded')) { localStorage.setItem('cleantv.addons.v1.a', s.addons); localStorage.setItem('cleantv.spotify.v1.a', s.token); sessionStorage.setItem('__spotifySeeded', '1'); }
      const fixed = Date.now(); Date.now = () => fixed;
    };
    const openSpotify = async (query, engine, options) => {
      const page = await preview.browser.newPage({ viewport: { width: 1920, height: 1080 } });
      page.setDefaultTimeout(15000); page.__errors = [];
      page.on('pageerror', error => page.__errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) page.__errors.push(response.status() + ' ' + response.url()); });
      await routeSpotify(page);
      await page.addInitScript(engine, options);
      await page.addInitScript(spotifyInit, seeds);
      await page.goto(preview.baseURL + '/home/' + query);
      await ready(page);
      await page.waitForFunction(src => { const c = document.getElementById('spotifyCompactCover'); return !document.getElementById('spotifyPlayer').hidden && c.getAttribute('src') === src && c.complete && c.naturalWidth > 0; }, COVER);
      return page;
    };
    const SPOTIFY_STATES = [], from = compared.states;
    target = SPOTIFY_STATES;
    state('Spotify card on Tizen, photo dock', look({ wall: 'golden' }));
    state('Spotify card on Tizen, dark list, German', look({ bg: 'dark', layout: 'list', language: 'de' }));
    state('Spotify card on Tizen, light dock', look({ bg: 'light' }));
    state('Spotify card on Tizen, expanded', look({ wall: 'peaks' }), [['nav', 'down']]);
    state('Spotify settings on Tizen', look({ wall: 'peaks' }), [['scene', 'settings'], ['act', 'settings.group.addons'], ['act', 'addon.details.spotify'], ['act', 'group.spotify']]);
    const pair = [await openSpotify('', harness, { catalog: CATALOG, seed: SEED, adaptive: false, addons: '' }), await openSpotify('?legacy=1', harness, { catalog: CATALOG, seed: SEED, adaptive: false, addons: '' })];
    await pass(pair[0], pair[1], SPOTIFY_STATES);
    // The QR screen: wait on both pages until the drawn PNG has decoded, then compare.
    const qrState = { name: 'Spotify QR screen on Tizen', prefs: look({ wall: 'peaks' }), steps: [['scene', 'settings'], ['act', 'settings.group.addons'], ['act', 'addon.details.spotify'], ['act', 'group.spotify'], ['act', 'spotify.signin']] };
    await Promise.all(pair.map(p => drive(p, qrState)));
    await Promise.all(pair.map(p => p.waitForFunction(() => { const img = document.getElementById('spotifyPairQr'); return img && img.complete && img.naturalWidth > 0; })));
    const [qa, qb] = await Promise.all(pair.map(p => p.evaluate(snapshot, { props: PROPS, pseudo: PSEUDO })));
    compare(qrState.name, qa, qb);
    const qrFacts = await sheetFacts(pair[1]);
    if (qrFacts.audit.length || qrFacts.diagnostics.notes.length || qrFacts.cssomVar || qrFacts.overlay) fail('Resolved sheet stays clean: ' + qrState.name, qrFacts.audit.slice(0, 8));
    const card = await pair[1].evaluate(() => ({ countdown: document.querySelector('.addon-setup-status').innerText }));
    if (!/C0FFEE · 10:00/.test(card.countdown)) fail('The QR screen shows the pairing code and countdown', card);
    if (compared.states - from !== SPOTIFY_STATES.length + 1 && !process.env.CHECK_STATE) fail('Every Spotify state is compared', { compared: compared.states - from, expected: SPOTIFY_STATES.length + 1 });
    for (const p of pair) { if (p.__errors.length) fail('Spotify pages: no page errors', p.__errors); await p.close(); }

    // The real old-engine path (no custom properties) on the UE40MU6179's installed apps.
    const oldPage = await openSpotify('', oldEngine, { model: 'UE40MU6179', installed: MU6179 });
    const oldCard = await oldPage.evaluate(() => {
      const box = document.getElementById('spotifyCompact').getBoundingClientRect(), title = document.getElementById('spotifyCompactTitle');
      return { active: CleanTVLegacy.active, overlay: (document.getElementById('legacyErrors') || {}).textContent || '', title: title.textContent, titleWidth: Math.round(title.getBoundingClientRect().width),
        width: Math.round(box.width), height: Math.round(box.height), surface: getComputedStyle(document.querySelector('.spotify-surface')).backgroundColor, caps: FrameDevice.capabilities.spotify };
    });
    if (!oldCard.active || oldCard.overlay || oldCard.title !== 'QA legacy track' || oldCard.titleWidth < 50 || oldCard.width < 300 || oldCard.height < 60 || !/rgba?\(/.test(oldCard.surface) || oldCard.caps !== true) fail('Old engine: the Spotify card renders', oldCard);
    await oldPage.evaluate(() => { ShoreQA.scene('settings'); ShoreQA.activate('settings.group.addons'); ShoreQA.activate('addon.details.spotify'); ShoreQA.activate('group.spotify'); });
    const oldSettings = await oldPage.evaluate(() => ShoreQA.actions());
    if (!oldSettings.includes('spotify.signin') || oldSettings.includes('spotify.access')) fail('Old engine: Samsung Spotify settings', oldSettings);
    await oldPage.evaluate(() => ShoreQA.activate('spotify.open'));
    await oldPage.waitForFunction(() => __calls.indexOf('rJeHak5zRg.Spotify') >= 0);
    await oldPage.evaluate(() => { window.dispatchEvent(new Event('focus')); ShoreQA.activate('spotify.signin'); });
    await oldPage.waitForFunction(() => { const img = document.getElementById('spotifyPairQr'); return img && img.complete && img.naturalWidth > 0; });
    const oldQr = await oldPage.evaluate(() => { const r = document.getElementById('spotifyPairQr').getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; });
    if (oldQr.width !== 320 || oldQr.height !== 320) fail('Old engine: the QR code renders at 320 px', oldQr);
    if (oldPage.__errors.length) fail('Old engine Spotify: no page errors', oldPage.__errors);
    await oldPage.close();
    compared.old = (compared.old || 0) + 4;
  }
  console.log('Coverage: ' + compared.states + ' states, ' + compared.elements + ' element snapshots, ' + compared.values + ' computed values, ' + PROPS.length + ' properties (+' + PSEUDO.length + ' on ::before/::after); ' + compared.intentional + ' required tnum differences; ' + synthetics + '/' + SYNTHETIC.length + ' synthetic sheets; ' + compared.old + ' old-engine checks.');
  console.log('apply() timings (ms): first ' + stats.first.toFixed(2) + ', compile ' + stats.compile.toFixed(2) + ', last change in a render ' + (stats.lastChange || 0).toFixed(2));
  console.log('  desktop: ' + JSON.stringify(fast, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v));
  console.log('  6x CPU throttle: ' + JSON.stringify(slow, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v));
  notes.forEach(n => console.log('note: ' + n));
} catch (error) { fail('Run', error.stack); }
finally { await preview.close(); }
console.log(failures.length ? failures.length + ' failure(s).' : 'Legacy resolver equivalence passed.');
if (failures.length) process.exitCode = 1;
