// Test the legacy custom-property resolver in plain Node. No browser, no TV.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app/legacy.js', import.meta.url), 'utf8');
function load(window, extra = {}) { vm.runInNewContext(source, { window, ...extra }); return window.CleanFrameLegacy; }
const L = load({ CSS: { supports: () => true }, location: { search: '' } });
const I = L._internals;
const DEFS = [{ key: 'root', tokens: [':root', 'html'] }, { key: 'stage', tokens: ['#stage', '.stage'] }, { key: 'home', tokens: ['#home', '.home'] }, { key: 'sheet', tokens: ['#sheet', '.sheet'] }, { key: 'dock', tokens: ['#dock', '.dock'] }];
const plain = value => JSON.parse(JSON.stringify(value));

/* A small DOM stand-in: each context is an element with an ancestor chain; selectors use
   descendant/child combinators, classes, ids, tags and :root, matched right to left. */
function tree(spec) {
  const nodes = {};
  for (const [key, parent, tag, id, className] of spec) nodes[key] = { key, parent, tag, id, className, inline: {} };
  function chain(n) { const out = []; for (let x = n; x; x = nodes[x.parent]) out.push(x); return out; }
  function fits(c, el) {
    return (!c.tag || c.tag === el.tag) && c.ids.every(i => i === el.id) && c.classes.every(k => (' ' + el.className + ' ').includes(' ' + k + ' ')) && c.pseudo.every(p => p === 'root' ? !el.parent : false);
  }
  function matches(el, sel) {
    const list = I.compounds(sel).list, up = chain(el);
    if (!fits(list[list.length - 1], up[0])) return false;
    let i = 1;
    for (let k = list.length - 2; k >= 0; k--) { while (i < up.length && !fits(list[k], up[i])) i++; if (i++ >= up.length) return false; }
    return true;
  }
  return {
    nodes,
    contexts: () => Object.values(nodes).map(n => ({ key: n.key, parent: n.parent, depth: chain(n).length - 1, tag: n.tag, id: n.id, className: n.className, inline: n.inline, matches: sel => matches(n, sel) })),
    preKey: () => Object.values(nodes).map(n => n.className + JSON.stringify(n.inline)).join('|')
  };
}
const DOM = [['root', null, 'html', '', ''], ['stage', 'root', 'main', 'stage', 'stage'], ['home', 'stage', 'div', 'home', 'home'], ['sheet', 'stage', 'div', 'sheet', 'sheet'], ['dock', 'home', 'div', 'dock', 'dock']];
function resolver(css, options = {}) { return I.createResolver(css, { defs: DEFS, rootKey: 'root', fallbackKey: 'stage', ...options }); }
function run(r, t, extra = {}) { return r.run({ preKey: null, contexts: t.contexts, media: () => true, ...extra }); }
function css(r) { return r.text(); }

test('inactive engines get a no-op API without XHR, DOM changes or polyfills', () => {
  const touched = [];
  const window = new Proxy({ CSS: { supports: (p, v) => p === '--a' && v === '0' }, location: { search: '' } }, { get(t, k) { if (!(k in t) && typeof k === 'string') touched.push(k); return t[k]; } });
  const api = load(window);
  assert.equal(api.active, false);
  for (const name of ['apply', 'setVar', 'removeVar']) assert.equal(api[name]({ style: {} }, '--x', '1'), undefined);
  assert.deepEqual(touched.filter(k => !['CleanFrameLegacy', 'CleanFrameForceLegacy'].includes(k)), []);
});

test('a failing start shows the error on screen and never hides the stage', () => {
  const appended = [], listeners = {};
  const el = () => ({ style: {}, setAttribute() {}, appendChild(c) { appended.push(c); c.parentNode = this; }, insertBefore(c) { appended.push(c); } });
  const document = { body: el(), documentElement: el(), head: el(), getElementsByTagName: () => [], createElement: el, addEventListener() {} };
  const window = { CSS: { supports: () => true }, location: { search: '?legacy=1' }, addEventListener: (n, f) => { listeners[n] = f; }, Element: function () {} };
  window.Element.prototype = { matches() {}, closest() {} };
  const api = load(window, { document, setTimeout, clearTimeout, Date });
  assert.equal(api.active, true);
  assert.equal(appended.filter(c => c.id === 'legacyBoot').length, 0);
  const overlay = appended.find(c => c.id === 'legacyErrors');
  assert.match(overlay.textContent, /style\.css link not found/);
  assert.doesNotThrow(() => api.apply());
  listeners.error({ message: 'Boom', filename: 'file:///app/main.js', lineno: 12, colno: 3 });
  assert.match(overlay.textContent, /Boom @ main\.js:12:3/);
  listeners.error({ message: 'Boom', filename: 'file:///app/main.js', lineno: 12, colno: 3 });
  assert.match(overlay.textContent, /\(x2\)/);
});

test('forced activation works where custom properties exist', () => {
  for (const window of [{ location: { search: '?a=1&legacy=1' } }, { CleanFrameForceLegacy: true, location: { search: '' } }]) {
    window.CSS = { supports: () => true }; window.addEventListener = () => {};
    const document = { getElementsByTagName: () => [], createElement: () => ({ style: {}, setAttribute() {} }), documentElement: { appendChild() {} }, addEventListener() {} };
    assert.equal(load(window, { document, setTimeout, clearTimeout, Date }).active, true);
  }
  assert.equal(load({ CSS: { supports: () => true }, location: { search: '?legacy=10' } }).active, false);
});

test('comments, strings, url() and !important parse robustly', () => {
  assert.equal(I.stripComments('a/* x */{b:"/* kept */";c:1/**/2}'), 'a{b:"/* kept */";c:1 2}');
  assert.equal(I.stripComments('a{b:1}/* open'), 'a{b:1}');
  const decls = I.parseDecls(' background : url(data:image/svg+xml;utf8,<svg a="b;c">) no-repeat ; content:";:"!important;--Mixed:a:b(c;d);filter:drop-shadow(0 0 1px rgba(0,0,0,.5)) ! IMPORTANT; broken ');
  assert.deepEqual(plain(decls).map(d => [d.prop, d.value, d.important]), [
    ['background', 'url(data:image/svg+xml;utf8,<svg a="b;c">) no-repeat', false],
    ['content', '";:"', true], ['--Mixed', 'a:b(c;d)', false], ['filter', 'drop-shadow(0 0 1px rgba(0,0,0,.5))', true]]);
  assert.deepEqual(plain(I.splitTop('a:not(.b,.c), d[e=","], f', ',')), ['a:not(.b,.c)', ' d[e=","]', ' f']);
});

test('rules, @media groups and verbatim at-rules', () => {
  const items = I.parseRules('@import url("x.css");a{b:1}@media (max-width:10px){c{d:var(--e)}@media print{f{g:h}}}@keyframes k{0%{opacity:0}to{opacity:1}}@font-face{font-family:X;src:url(x.woff)}}stray{z:1}');
  assert.deepEqual(plain(items).map(i => i.type), ['at', 'style', 'group', 'at', 'at', 'style']);
  assert.equal(items[0].text, '@import url("x.css");');
  assert.equal(items[2].prelude, '(max-width:10px)');
  assert.deepEqual(plain(items[2].rules).map(i => i.type), ['style', 'group']);
  assert.equal(items[3].text, '@keyframes k{0%{opacity:0}to{opacity:1}}');
  assert.equal(items[5].selector, 'stray');
});

test('specificity counts ids, classes, attributes, pseudo-classes, types and pseudo-elements', () => {
  const cases = { '*': [0, 0, 0], 'li': [0, 0, 1], 'ul li::before': [0, 0, 3], 'a:before': [0, 0, 2], '.a.b': [0, 2, 0], '#x .y[z="1"]:hover': [1, 3, 0],
    '.tile:not(.is-focus):not(.is-lifted)': [0, 3, 0], ':not(#a, .b)': [1, 0, 0], ':where(#a) .b': [0, 1, 0], ':is(.a, div)': [0, 1, 0], '.stage.util-at-top .quiet-utils': [0, 3, 0], ':root': [0, 1, 0], 'li:nth-child(2n+1)': [0, 1, 1] };
  for (const [sel, expected] of Object.entries(cases)) assert.deepEqual(plain(I.specificity(sel)), expected, sel);
});

test('cascade: !important beats inline, inline beats rules, then specificity and source order', () => {
  const t = tree(DOM);
  const r = resolver('.stage.stage{--a:spec}.stage{--a:order1;--b:x}.stage{--a:order2;--c:normal}#stage{--d:id}.stage{--d:class}.stage{--e:important!important}#stage{--e:id-normal}.x{color:var(--a) var(--b) var(--c) var(--d) var(--e) var(--f)}');
  t.nodes.stage.inline = { '--c': 'inline', '--e': 'inline', '--f': 'inline' };
  run(r, t);
  assert.match(css(r), /\.x\{color:spec x inline id important inline\}/);
});

test('custom properties inherit and resolve at the declaring element', () => {
  const t = tree(DOM);
  const r = resolver(':root{--ink:#111;--shadow:0 0 var(--size)}.stage{--size:2px;--alias:var(--ink)}.home{--ink:#222;--size:9px}.home .x{color:var(--alias);text-shadow:var(--shadow)}.sheet .y{color:var(--ink)}');
  run(r, t);
  const out = css(r);
  // --alias was computed on the stage, so Home's own --ink does not change it.
  assert.match(out, /\.home \.x\{color:#111;text-shadow:unset\}/);
  assert.match(out, /\.sheet \.y\{color:#111\}/);
  assert.equal(plain(r.state.envs.home)['--size'], '9px');
});

test('fallback chains, empty fallbacks, nested functions and token separation', () => {
  const t = tree(DOM);
  const r = resolver(':root{--n:4;--u:px;--empty:}.a{width:var(--missing,var(--also-missing,3px));height:calc(var(--n)*2px);margin:var(--x,);top:var(--n)var(--u);background:rgba(10,8,6,var(--missing, .2))}');
  run(r, t);
  assert.match(css(r), /\.a\{width:3px;height:calc\(4\*2px\);margin:;top:4\/\*\*\/px;background:rgba\(10,8,6,\.2\)\}/);
});

test('cycles invalidate every member; dependants use their fallback', () => {
  const env = I.computeEnv({ '--keep': 'parent' }, { '--a': 'var(--b, 1)', '--b': 'var(--a)', '--self': 'var(--self, 2)', '--c': 'var(--a, 5)', '--d': 'var(--keep)', '--i': 'inherit', '--n': 'initial' });
  assert.equal(env['--a'], null); assert.equal(env['--b'], null); assert.equal(env['--self'], null);
  assert.equal(env['--c'], '5'); assert.equal(env['--d'], 'parent'); assert.equal(env['--n'], null);
  assert.equal(env['--keep'], 'parent');
});

test('unresolvable declarations become unset and keep !important', () => {
  const t = tree(DOM);
  const r = resolver('.a{color:var(--nope)!important;opacity:.5;--x:1}', { supports: (p, v) => !(p === 'opacity' && v === 'bad') });
  run(r, t);
  assert.match(css(r), /^\.a\{color:unset!important;opacity:\.5\}$/);
  const bad = resolver(':root{--o:bad}.b{opacity:var(--o)}', { supports: (p, v) => v !== 'bad' });
  run(bad, t);
  assert.match(css(bad), /\.b\{opacity:unset\}/);
});

test('selector lists split only where variables are used; invalid lists are dropped whole', () => {
  const t = tree(DOM);
  const r = resolver(':root{--c:red}.a,.b{color:var(--c);margin:0}.c,.d{color:blue}:root{--only:1}.e,.f:focus-visible{color:var(--c)}', { valid: sel => !/focus-visible/.test(sel) });
  run(r, t);
  assert.equal(css(r), '.a{color:red;margin:0}\n.b{color:red;margin:0}\n.c,.d{color:blue}');
});

test('prefix twins are added once, before the original', () => {
  const r = resolver('.a{clip-path:inset(0 round 3px);filter:none}.b{-webkit-mask-image:none;mask-image:none;mask-size:1px}.c{font-variant-numeric:tabular-nums;user-select:none}');
  run(r, tree(DOM));
  assert.equal(css(r), '.a{-webkit-clip-path:inset(0 round 3px);clip-path:inset(0 round 3px);-webkit-filter:none;filter:none}\n.b{-webkit-mask-image:none;mask-image:none;-webkit-mask-size:1px;mask-size:1px}\n.c{-webkit-font-feature-settings:"tnum";font-variant-numeric:tabular-nums;-webkit-user-select:none;user-select:none}');
  assert.deepEqual(plain(I.prefixed([{ prop: 'color', value: 'red' }])), [{ prop: 'color', value: 'red' }]);
});

test('@media keeps its condition; declarations inside it follow media()', () => {
  const t = tree(DOM);
  const r = resolver(':root{--a:1}@media (x){:root{--a:2}.m{order:var(--a)}}.n{order:var(--a)}@keyframes k{to{opacity:var(--a)}}');
  let on = true;
  run(r, t, { media: () => on });
  assert.equal(css(r), '@media (x){.m{order:2}}\n.n{order:2}\n@keyframes k{to{opacity:2}}');
  on = false;
  run(r, t, { media: () => on });
  assert.equal(css(r), '@media (x){.m{order:1}}\n.n{order:1}\n@keyframes k{to{opacity:1}}');
});

test('contexts: scope tokens, variables set below the stage and ambiguous branches', () => {
  const t = tree(DOM);
  const r = resolver(':root{--w:1px}.home{--b:home}.sheet{--b:sheet}.digit{width:var(--w)}.dock .tile{width:var(--tile)}.label{color:var(--b)}.home .label{color:var(--b)}');
  t.nodes.home.inline = { '--w': '7px' };
  t.nodes.dock.inline = { '--tile': '176px' };
  run(r, t);
  const out = css(r);
  assert.match(out, /\.digit\{width:7px\}/);
  assert.match(out, /\.dock \.tile\{width:176px\}/);
  assert.match(out, /\.label\{color:unset\}/);
  assert.match(out, /\.home \.label\{color:home\}/);
  assert.equal(r.diagnostics.ambiguous['.label'], 'home,sheet');
});

test('element evidence places rules and waits for elements that do not exist yet', () => {
  const t = tree(DOM);
  const r = resolver(':root{--ink:root}.sheet{--ink:sheet}.row.is-focus{color:var(--ink)}');
  let where = null;
  const locate = q => { assert.equal(q, '.row'); return where; };
  run(r, t, { locate, preKey: 'k' });
  assert.match(css(r), /\.row\.is-focus\{color:sheet\}/);
  assert.equal(r.state.unsettled.length, 1);
  assert.equal(run(r, t, { locate, preKey: 'k' }).kind, 'fast');
  where = { stage: 3 };
  const next = run(r, t, { locate, preKey: 'k' });
  assert.equal(next.kind, 'changed');
  assert.match(css(r), /\.row\.is-focus\{color:root\}/);
  assert.equal(r.state.unsettled.length, 0);
  assert.equal(I.queryOf('.f-glass .s-head .btn.is-focus::before'), '.f-glass .s-head .btn');
  assert.equal(I.queryOf('.is-lifted .nudge:not(.x)'), '.nudge');
  assert.equal(I.queryOf('.a > .is-b'), '.a > *');
});

test('signature caching: fast path, unchanged matches, and only affected rules re-render', () => {
  const t = tree(DOM);
  const r = resolver(':root{--a:1}.stage.dark{--a:2}.x{order:var(--a)}.dock .y{width:var(--w)}.z{order:var(--b,0)}');
  let calls = 0;
  const contexts = () => { calls++; return t.contexts(); };
  assert.equal(r.run({ preKey: t.preKey(), contexts, media: () => true }).kind, 'changed');
  assert.equal(r.run({ preKey: t.preKey(), contexts, media: () => true }).kind, 'fast');
  assert.equal(calls, 1);
  t.nodes.stage.className = 'stage other';
  assert.equal(r.run({ preKey: t.preKey(), contexts, media: () => true }).kind, 'same');
  t.nodes.dock.inline = { '--w': '5px' };
  const dock = r.run({ preKey: t.preKey(), contexts, media: () => true });
  assert.deepEqual(plain(dock.changed.map(u => u.sel)), ['.dock .y']);
  t.nodes.stage.className = 'stage dark';
  const theme = r.run({ preKey: t.preKey(), contexts, media: () => true });
  assert.deepEqual(plain(theme.changed.map(u => u.sel)), ['.x']);
  assert.equal(css(r), '.x{order:2}\n.dock .y{width:5px}\n.z{order:0}');
});

test('CSSOM handles update only the changed rules', () => {
  const t = tree(DOM);
  const r = resolver(':root{--a:1}.s{color:red}@media (x){.m{order:var(--a)}}.n{order:var(--a)}@keyframes k{to{opacity:var(--a)}}');
  run(r, t);
  const rule = (type, extra = {}) => ({ type, style: {}, ...extra });
  const media = rule(4, { cssRules: [rule(1)] });
  const sheet = { cssRules: [rule(1), media, rule(1), rule(7)], deleteRule(i) { this.cssRules.splice(i, 1); }, insertRule(text, i) { this.cssRules.splice(i, 0, rule(7, { text })); } };
  assert.equal(r.attach(sheet), true);
  t.nodes.root.inline = { '--a': '3' };
  const result = run(r, t);
  r.update(result.changed);
  assert.equal(media.cssRules[0].style.cssText, 'order:3');
  assert.equal(sheet.cssRules[2].style.cssText, 'order:3');
  assert.equal(sheet.cssRules[3].text, '@keyframes k{to{opacity:3}}');
  assert.equal(sheet.cssRules[0].style.cssText, undefined);
  assert.equal(r.attach({ cssRules: [rule(1), media, rule(1)] }), false);
});

test('the shipped stylesheet resolves with no var() left', () => {
  const t = tree(DOM);
  t.nodes.stage.className = 'stage bg-photo l-dock tone-light tr-mist br-mist fv-2 util-at-top';
  const r = resolver(readFileSync(new URL('../app/style.css', import.meta.url), 'utf8'));
  run(r, t);
  const out = css(r);
  assert.doesNotMatch(out, /var\(/i);
  assert.doesNotMatch(out, /(^|[;{])--[\w-]+:/);
  assert.match(out, /\.stage\{[^}]*background:#0d0d0d/);
  assert.match(out, /\.m-frost \.mat-veil\{background:rgba\(12,10,8,\.20\)\}/);
  assert.match(out, /\.ut-tr\{background:radial-gradient\([^}]*rgba\(10,8,6,\.44\)[^}]*!important\}/);
  assert.ok(r.model.classOnly);
});

test('var() inside strings and url() bodies is text; a var() without a custom property name is invalid', () => {
  assert.equal(I.opaque('a "var(--b)" url(var(--c)) url( "d" ) e').length, 'a "var(--b)" url(var(--c)) url( "d" ) e'.length);
  assert.equal(I.opaque('"x"var(--a) url(a\\)b) var(--b)'), '   var(--a) url(    ) var(--b)');
  const t = tree(DOM);
  const r = resolver(':root{--a:1;--p:"x.png";--s:"var(--a)";--k:red;--k:var(k)}.x::before{content:"var(--a)"}.y::before{content:"a var(--a) b" var(--s)}.z{background-image:url(var(--p))}.w{color:red}.stage .w{color:var(w, blue)}.v{color:var(--k)}');
  run(r, t);
  assert.equal(css(r), '.x::before{content:"var(--a)"}\n.y::before{content:"a var(--a) b" "var(--a)"}\n.z{background-image:url(var(--p))}\n.w{color:red}\n.v{color:red}');
});

test('upper-case VAR() keeps following its variable', () => {
  const t = tree(DOM);
  const r = resolver(':root{--a:red}.stage.dark{--a:blue}.x{color:VAR(--a)}');
  run(r, t, { preKey: 'light' });
  assert.equal(css(r), '.x{color:red}');
  t.nodes.stage.className = 'stage dark';
  assert.equal(run(r, t, { preKey: 'dark' }).kind, 'changed');
  assert.equal(css(r), '.x{color:blue}');
});

test('unsupported placements are reported: at-rule values, pseudo-element declarations and non-context elements', () => {
  const r = resolver(':root{--o:.5}.home{--o:.2}@keyframes k{to{opacity:var(--o)}}.x::before{--a:blue;content:"a";color:var(--a)}.tile{--t:1}');
  assert.deepEqual(plain(r.diagnostics.notes), ['var() in @keyframes k uses the root values, not those of the animated element.', 'Custom properties declared on a pseudo-element are not resolved: .x::before']);
  assert.deepEqual(plain(r.strays(sel => sel === '.tile' ? 3 : sel === '.home' ? 0 : 9)), { '.tile': 3, ':root': 9 });
  const shipped = resolver(readFileSync(new URL('../app/style.css', import.meta.url), 'utf8'));
  assert.deepEqual(plain(shipped.diagnostics.notes), []);
});
