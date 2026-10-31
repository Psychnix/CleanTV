/* Engines without CSS custom properties (Chromium before 49, such as 2017 Tizen 3.0 TVs) get
   style.css with every var() resolved for the live stage. Everywhere else this file is inert. */
(function () {
  'use strict';
  function noop() {}
  var api = window.CleanFrameLegacy = { active: false, apply: noop, setVar: noop, removeVar: noop };
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function trim(s) { return s.trim(); }

  /* ---------- CSS model (pure; Node tests reach it through _internals) ---------- */
  var VAR = /(^|[^\w-])var\(/i, VARS = /(?:^|[^\w-])var\(\s*(--[^\s,)]+)/gi, BADVAR = /(^|[^\w-])var\((?!\s*--)/i, WORD = /[\w\-%.\u0080-\uffff]/, IDENT = /[\w\-\u0080-\uffff]/;
  var STRIP = /("(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)|\/\*[\s\S]*?(?:\*\/|$)/g;
  var OPAQUE = /"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|(^|[^\w-])(url\(\s*)(?=[^"'\s])(?:[^)\\]|\\[\s\S])*/gi;
  var OLD_ELEMENT = /^(before|after|first-line|first-letter)$/, NEEDS_DECLS = /--|var\(|clip-path|filter|mask|user-select|font-variant-numeric/i;
  // Chromium 47 knows only the -webkit- form of these; the twin is added, never substituted.
  var TWINS = { 'clip-path': 1, filter: 1, mask: 1, 'mask-image': 1, 'mask-size': 1, 'mask-repeat': 1, 'mask-position': 1, 'mask-origin': 1, 'mask-clip': 1, 'user-select': 1 };
  var NORMAL = 0, INLINE = 1e15, IMPORTANT = 2e15;

  function stripComments(s) {
    return s.replace(STRIP, function (m, str, at) { return str || (WORD.test(s.charAt(at - 1)) && WORD.test(s.charAt(at + m.length)) ? ' ' : ''); });
  }
  /* Strings and unquoted url() bodies blanked, so var() is found only where the engine sees one. */
  function opaque(s) {
    return s.replace(OPAQUE, function (m, pre, head) { return head ? pre + head + m.slice(pre.length + head.length).replace(/[\s\S]/g, ' ') : m.replace(/[\s\S]/g, ' '); });
  }
  function skipString(s, i) {
    for (var q = s.charAt(i++); i < s.length; i++) { if (s.charAt(i) === '\\') i++; else if (s.charAt(i) === q) return i + 1; }
    return i;
  }
  /* First top-level index of one of `chars` (outside brackets and strings), or -1. */
  function findTop(s, chars, i) {
    for (var depth = 0, c; i < s.length; i++) {
      c = s.charAt(i);
      if (!depth && chars.indexOf(c) >= 0) return i;
      if (c === '"' || c === '\'') i = skipString(s, i) - 1;
      else if (c === '\\') i++;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
    return -1;
  }
  /* Index of the bracket that closes the one at s[i]. */
  function closeAt(s, i) {
    for (var depth = 0, c; i < s.length; i++) {
      c = s.charAt(i);
      if (c === '"' || c === '\'') i = skipString(s, i) - 1;
      else if (c === '\\') i++;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if ((c === ')' || c === ']' || c === '}') && --depth <= 0) return i;
    }
    return s.length;
  }
  function splitTop(s, sep) {
    var parts = [], i = 0, j;
    while ((j = findTop(s, sep, i)) >= 0) { parts.push(s.slice(i, j)); i = j + 1; }
    parts.push(s.slice(i));
    return parts;
  }
  function parseDecls(body) {
    var out = [];
    splitTop(body, ';').forEach(function (part) {
      var i = findTop(part, ':', 0), prop, value, m, custom, seen;
      if (i < 0 || !(prop = trim(part.slice(0, i)))) return;
      value = trim(part.slice(i + 1)); m = /!\s*important\s*$/i.exec(value);
      if (m) value = trim(value.slice(0, m.index));
      // A var() without a custom property name makes the declaration invalid when parsed.
      custom = prop.slice(0, 2) === '--'; seen = opaque(value);
      if (BADVAR.test(seen)) return;
      out.push({ prop: custom ? prop : prop.toLowerCase(), value: value, important: !!m, custom: custom, hasVar: VAR.test(seen) });
    });
    return out;
  }
  /* Rules, @media/@supports groups (nested) and other at-rules (kept as text). */
  function parseRules(s, counter) {
    var items = [], i = 0, j, k, head, name, body;
    counter = counter || { n: 0 };
    while (i < s.length && (j = findTop(s, '{;}', i)) >= 0) {
      head = trim(s.slice(i, j));
      if (s.charAt(j) !== '{') { if (s.charAt(j) === ';' && head.charAt(0) === '@') items.push({ type: 'at', text: head + ';' }); i = j + 1; continue; }
      k = closeAt(s, j); body = s.slice(j + 1, k); i = k + 1;
      if (head.charAt(0) === '@') {
        name = head.slice(1).split(/[\s({]/)[0].toLowerCase();
        if (name === 'media' || name === 'supports') items.push({ type: 'group', name: name, head: head, prelude: trim(head.slice(name.length + 1)), rules: parseRules(body, counter) });
        else items.push({ type: 'at', text: head + '{' + body + '}' });
      } else if (head) items.push({ type: 'style', selector: head, body: body, order: counter.n++ });
    }
    return items;
  }
  function readIdent(s, i) {
    while (i < s.length && (IDENT.test(s.charAt(i)) || s.charAt(i) === '\\')) i += s.charAt(i) === '\\' ? 2 : 1;
    return i;
  }
  function weigh(s) { return s[0] * 1e6 + s[1] * 1e3 + s[2]; }
  function specificity(sel) {
    var a = 0, b = 0, c = 0, i = 0, ch, j, name, inner, best;
    while (i < sel.length) {
      ch = sel.charAt(i);
      if (ch === '#' || ch === '.') { if (ch === '#') a++; else b++; i = readIdent(sel, i + 1); }
      else if (ch === '[') { b++; i = closeAt(sel, i) + 1; }
      else if (ch === ':' && sel.charAt(i + 1) === ':') { c++; i = readIdent(sel, i + 2); if (sel.charAt(i) === '(') i = closeAt(sel, i) + 1; }
      else if (ch === ':') {
        j = readIdent(sel, i + 1); name = sel.slice(i + 1, j).toLowerCase(); inner = null; i = j;
        if (sel.charAt(i) === '(') { j = closeAt(sel, i); inner = sel.slice(i + 1, j); i = j + 1; }
        if (OLD_ELEMENT.test(name)) c++;
        else if (inner !== null && /^(not|is|matches|-webkit-any|has)$/.test(name)) {
          best = [0, 0, 0];
          splitTop(inner, ',').forEach(function (part) { var x = specificity(part); if (weigh(x) > weigh(best)) best = x; });
          a += best[0]; b += best[1]; c += best[2];
        } else if (name !== 'where') b++;
      } else if (IDENT.test(ch) || ch === '\\') { c++; i = readIdent(sel, i); }
      else i++;
    }
    return [a, b, c];
  }
  /* Compound selectors, left to right. `simple` means matching depends only on classes,
     ids and tags along the ancestor chain, so class names alone can key the cache. */
  function compounds(sel) {
    var list = [], cur = null, i = 0, ch, j, name, arg, element, simple = true;
    function part() { return cur || (cur = { ids: [], classes: [], pseudo: [], tag: '', element: false }); }
    while (i < sel.length) {
      ch = sel.charAt(i);
      if (/[\s>+~]/.test(ch)) { if (cur) list.push(cur); cur = null; if (ch === '+' || ch === '~') simple = false; i++; }
      else if (ch === '#' || ch === '.') { j = readIdent(sel, i + 1); part()[ch === '#' ? 'ids' : 'classes'].push(sel.slice(i + 1, j)); i = j; }
      else if (ch === '[') { part(); simple = false; i = closeAt(sel, i) + 1; }
      else if (ch === ':') {
        element = sel.charAt(i + 1) === ':'; j = readIdent(sel, i + (element ? 2 : 1)); name = sel.slice(i + (element ? 2 : 1), j).toLowerCase(); i = j; arg = '';
        if (sel.charAt(i) === '(') { j = closeAt(sel, i); arg = sel.slice(i + 1, j); i = j + 1; }
        part().pseudo.push(name);
        if (element || OLD_ELEMENT.test(name)) cur.element = true;
        else if (name !== 'root' && !(name === 'not' && /^\s*[.#]?[\w-]+\s*$/.test(arg))) simple = false;
      } else if (ch === '*') { part(); i++; }
      else { j = readIdent(sel, i); if (j > i) { part().tag = sel.slice(i, j).toLowerCase(); i = j; } else { simple = false; i++; } }
    }
    if (cur) list.push(cur);
    return { list: list, simple: simple };
  }
  /* Where a rule's elements live, whatever their state: pseudo-elements, dynamic and negated
     pseudo-classes and is-/on-/has- state classes are dropped for querySelectorAll. */
  function queryOf(sel) {
    var out = [], comb = true;
    sel = sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/gi, '').replace(/::?(before|after|first-line|first-letter|selection|placeholder|-webkit-[\w-]+)(?![\w-])|:(focus-visible|focus-within|focus|hover|active)(?![\w-])/gi, '').replace(/\.(?:is|on|has)-[\w-]+/g, '');
    trim(sel.replace(/\s*([>+~])\s*/g, ' $1 ').replace(/\s+/g, ' ')).split(' ').forEach(function (t) {
      var c = /^[>+~]$/.test(t);
      if (!t) return;
      if (c && comb) out.push('*');
      out.push(t); comb = c;
    });
    if (comb && out.length) out.push('*');
    return out.join(' ');
  }
  function varsOf(decls) {
    var out = [], m;
    decls.forEach(function (d) { var seen = opaque(d.value); VARS.lastIndex = 0; while ((m = VARS.exec(seen))) if (out.indexOf(m[1]) < 0) out.push(m[1]); });
    return out;
  }
  /* Replaces every var(); null when one has neither a value nor a usable fallback, unless
     `loose`, which writes `unset` in its place. Adjacent tokens stay separate. */
  function substitute(value, lookup, loose) {
    var out = '', i = 0, re = /var\(/ig, seen = opaque(value), m, end, inner, comma, v;
    while ((m = re.exec(seen))) {
      if (m.index > 0 && /[\w-]/.test(value.charAt(m.index - 1))) continue;
      end = closeAt(value, m.index + 3); inner = value.slice(m.index + 4, end); comma = findTop(inner, ',', 0);
      v = lookup(trim(comma < 0 ? inner : inner.slice(0, comma)));
      if ((v === null || v === undefined) && comma >= 0) v = substitute(trim(inner.slice(comma + 1)), lookup, loose);
      if (v === null || v === undefined) { if (!loose) return null; v = 'unset'; }
      out += value.slice(i, m.index);
      if (v && WORD.test(out.charAt(out.length - 1)) && WORD.test(v.charAt(0))) out += '/**/';
      out += v; i = end + 1; re.lastIndex = i;
      if (v && WORD.test(v.charAt(v.length - 1)) && WORD.test(value.charAt(i))) out += '/**/';
    }
    return out + value.slice(i);
  }
  function lookupIn(env) { return function (name) { return name.slice(0, 2) === '--' && env[name] !== undefined ? env[name] : null; }; }
  /* Computed custom properties of one element: its winning declarations resolved against
     itself, everything else inherited. Cycles and unresolvable values become invalid (null). */
  function computeEnv(parent, declared) {
    var env = {}, state = {}, stack = [], cyclic = {}, k;
    for (k in parent) if (has(parent, k)) env[k] = parent[k];
    function inherited(name) { return has(parent, name) ? parent[name] : null; }
    function get(name) {
      var raw, kw, v, i;
      if (!has(declared, name)) return inherited(name);
      if (state[name] === 2) return env[name];
      if (state[name] === 1) { for (i = stack.length - 1; i >= 0; i--) { cyclic[stack[i]] = true; if (stack[i] === name) break; } return null; }
      state[name] = 1; stack.push(name);
      raw = declared[name]; kw = raw.toLowerCase();
      v = kw === 'initial' ? null : kw === 'inherit' || kw === 'unset' || kw === 'revert' ? inherited(name) : substitute(raw, get);
      stack.pop(); state[name] = 2;
      env[name] = cyclic[name] ? null : v;
      return env[name];
    }
    for (k in declared) if (has(declared, k)) get(k);
    return env;
  }
  function block(decls) { return decls.map(function (d) { return d.prop + ':' + d.value + (d.important ? '!important' : ''); }).join(';'); }
  function prefixed(decls) {
    var seen = {}, out = [];
    decls.forEach(function (d) { seen[d.prop] = true; });
    decls.forEach(function (d) {
      if (has(TWINS, d.prop) && !has(seen, '-webkit-' + d.prop)) out.push({ prop: '-webkit-' + d.prop, value: d.value, important: d.important });
      // Manrope has a tnum feature; Chromium 47 predates font-variant-numeric.
      if (d.prop === 'font-variant-numeric' && /tabular-nums/i.test(d.value) && !has(seen, 'font-feature-settings') && !has(seen, '-webkit-font-feature-settings')) out.push({ prop: '-webkit-font-feature-settings', value: '"tnum"', important: d.important });
      out.push(d);
    });
    return out.length === decls.length ? decls : out;
  }
  function hasToken(c, t) {
    var k = t.charAt(0), v = t.slice(1);
    return k === '#' ? c.ids.indexOf(v) >= 0 : k === '.' ? c.classes.indexOf(v) >= 0 : k === ':' ? c.pseudo.indexOf(v) >= 0 : c.tag === t;
  }
  function subjectOk(s, c) {
    var cls = ' ' + c.className + ' ', i;
    if (s.tag && s.tag !== c.tag || s.ids.length && (s.ids.length > 1 || s.ids[0] !== c.id)) return false;
    for (i = 0; i < s.classes.length; i++) if (cls.indexOf(' ' + s.classes[i] + ' ') < 0) return false;
    return true;
  }

  /* opts: defs [{key, tokens}] parent-first, rootKey, fallbackKey, and optional engine probes
     valid(selectorList), validAt(atRule), supports(prop, value). */
  function createResolver(text, opts) {
    var model = { declaring: [], dynamic: [], conds: [], classOnly: true, units: null }, diag = { ambiguous: {}, notes: [] }, st = { pre: null, key: null, envs: null, tree: null, shape: '', sensitive: [], unsettled: [], proof: '' };
    function baseOf(list) {
      var i, d, s;
      for (i = list.length - 1; i >= 0; i--) for (d = opts.defs.length - 1; d >= 0; d--) if (opts.defs[d].tokens.some(hasToken.bind(null, list[i]))) return opts.defs[d].key;
      s = list[list.length - 1];
      return s && (s.tag === 'html' || s.tag === 'body' || s.pseudo.indexOf('root') >= 0) ? opts.rootKey : opts.fallbackKey;
    }
    function build(items, media) {
      var units = [];
      items.forEach(function (it) {
        var decls, plain = [], sels, custom = [], dyn = false, fixed, u;
        if (it.type === 'group') { units.push({ kind: 'group', head: it.head, units: build(it.rules, media.concat([it])) }); return; }
        if (it.type === 'at') {
          if (/^@charset/i.test(it.text) || opts.validAt && !opts.validAt(it.text)) return;
          if (VAR.test(opaque(it.text))) {
            u = { kind: 'at', raw: it.text, text: null, rule: null }; units.push(u); model.dynamic.push(u);
            diag.notes.push('var() in ' + trim(it.text.split('{')[0]) + ' uses the root values, not those of the animated element.');
          }
          else units.push({ kind: 'text', style: false, text: it.text });
          return;
        }
        // The engine drops a whole list when one selector is unknown; so does this.
        if (opts.valid && !opts.valid(it.selector)) return;
        if (!NEEDS_DECLS.test(it.body)) { units.push({ kind: 'text', style: true, text: it.selector + '{' + it.body + '}' }); return; }
        decls = parseDecls(it.body);
        decls.forEach(function (d) { if (d.custom) custom.push(d); else { plain.push(d); if (d.hasVar) dyn = true; } });
        sels = splitTop(it.selector, ',').map(trim);
        if (custom.length) sels.forEach(function (sel) {
          var c = compounds(sel), s = c.list[c.list.length - 1];
          if (!c.simple) model.classOnly = false;
          if (!s || s.element) diag.notes.push('Custom properties declared on a pseudo-element are not resolved: ' + sel);
          media.forEach(function (g) { if (model.conds.indexOf(g) < 0) model.conds.push(g); });
          model.declaring.push({ sel: sel, subject: s, element: !s || s.element, spec: weigh(specificity(sel)), order: it.order, media: media, decls: custom });
        });
        if (!plain.length) return;
        if (!dyn) { fixed = prefixed(plain); units.push({ kind: 'text', style: true, text: it.selector + '{' + (fixed === plain && !custom.length ? it.body : block(fixed)) + '}' }); return; }
        // Each selector of a list resolves on its own; consecutive rules cascade identically.
        sels.forEach(function (sel) { u = { kind: 'rule', sel: sel, query: queryOf(sel), base: baseOf(compounds(sel).list), decls: plain, vars: varsOf(plain), block: null, ctx: null, rule: null }; units.push(u); model.dynamic.push(u); });
      });
      return units;
    }
    model.units = build(parseRules(stripComments(text)), []);

    function cascade(list, inline) {
      var win = {}, declared = {}, k;
      function put(name, value, rank) { if (!has(win, name) || rank >= win[name].rank) win[name] = { value: value, rank: rank }; }
      list.forEach(function (n) { var d = model.declaring[n]; d.decls.forEach(function (x) { put(x.prop, x.value, (x.important ? IMPORTANT : NORMAL) + d.spec * 1e4 + d.order); }); });
      for (k in inline) if (has(inline, k)) put(k, inline[k], INLINE);
      for (k in win) if (has(win, k)) declared[k] = win[k].value;
      return declared;
    }
    function inside(k, base, parents) { for (k = parents[k]; k !== null && k !== undefined; k = parents[k]) if (k === base) return true; return false; }
    function val(env, name) { return env[name] === undefined ? null : env[name]; }
    function differs(vars, a, b) { return vars.some(function (v) { return val(a, v) !== val(b, v); }); }
    /* The selector names a scope or defaults to the stage. When a descendant context changes
       one of the rule's variables, the contexts of the matching elements decide; without
       any, the changing context is used when it is unique along a chain. */
    function pick(u, t, locate) {
      var base = t.envs[u.base] ? u.base : t.envs[opts.fallbackKey] ? opts.fallbackKey : t.ctxs[0].key, found = [], seen, keys, best, deepest;
      t.ctxs.forEach(function (c) {
        var p = t.envs[c.parent];
        if (p && inside(c.key, base, t.parents) && differs(u.vars, t.envs[c.key], p)) found.push(c.key);
      });
      u.hot = found.length > 0;
      if (!u.hot) return base;
      seen = locate && locate(u.query);
      if (seen) {
        keys = Object.keys(seen).filter(function (k) { return t.envs[k]; });
        best = keys.reduce(function (a, b) { return a === null || seen[b] > seen[a] ? b : a; }, null);
        if (best !== null) {
          if (keys.some(function (k) { return differs(u.vars, t.envs[k], t.envs[best]); })) diag.ambiguous[u.sel] = 'elements in ' + keys.join(',');
          return best;
        }
      }
      deepest = found.reduce(function (a, b) { return t.depth[b] > t.depth[a] ? b : a; });
      if (found.every(function (k) { return k === deepest || inside(deepest, k, t.parents); })) return deepest;
      diag.ambiguous[u.sel] = found.join(',');
      return base;
    }
    function evidence(units, locate) {
      return locate ? units.map(function (u) { var s = locate(u.query); return u.query + '=' + (s ? Object.keys(s).sort().join(',') : ''); }).join('|') : '';
    }
    function renderRule(u, t, locate) {
      var ctx = pick(u, t, locate), lookup = lookupIn(t.envs[ctx]), decls, text;
      decls = u.decls.map(function (d) {
        if (!d.hasVar) return d;
        var v = substitute(d.value, lookup);
        if (v !== null && opts.supports && !opts.supports(d.prop, v)) v = null;
        // Invalid at computed-value time: the declaration behaves as `unset`.
        return { prop: d.prop, value: v === null ? 'unset' : v, important: d.important };
      });
      u.ctx = ctx; text = block(prefixed(decls));
      if (text === u.block) return false;
      u.block = text; return true;
    }
    function renderAt(u, env) {
      var text = substitute(u.raw, lookupIn(env), true);
      if (text === u.text) return false;
      u.text = text; return true;
    }
    /* input: preKey (null disables the fast path), contexts() parent-first
       [{key, parent, depth, tag, id, className, inline, matches(sel)}], media(name, prelude),
       optional locate(selector) -> {contextKey: matching element count} or null. */
    /* Variables whose value differs in any context; null when the context tree changed. */
    function changedNames(a, b, shape) {
      var out = {}, c, k;
      if (!a || shape !== st.shape) return null;
      for (c in b) if (has(b, c)) {
        for (k in b[c]) if (has(b[c], k) && val(b[c], k) !== val(a[c], k)) out[k] = true;
        for (k in a[c]) if (has(a[c], k) && val(b[c], k) !== val(a[c], k)) out[k] = true;
      }
      return out;
    }
    function run(input) {
      var ctxs, key = [], matched = {}, envs = {}, parents = {}, depth = {}, changed = [], cache = {}, locate = null, proof, shape, dirty = {}, moved;
      if (input.locate) locate = function (q) { if (!has(cache, q)) cache[q] = q ? input.locate(q) : null; return cache[q]; };
      // Unchanged classes and variables: only rules still waiting for their elements are rechecked.
      if (input.preKey !== null && input.preKey !== undefined && input.preKey === st.pre && !(locate && st.unsettled.some(function (u) { return locate(u.query); }))) return { kind: 'fast', changed: changed };
      ctxs = input.contexts();
      ctxs.forEach(function (c) {
        var list = [];
        model.declaring.forEach(function (d, n) {
          if (!d.element && subjectOk(d.subject, c) && d.media.every(function (g) { return input.media(g.name, g.prelude); }) && c.matches(d.sel)) list.push(n);
        });
        matched[c.key] = list; parents[c.key] = c.parent; depth[c.key] = c.depth;
        key.push(c.key + '<' + c.parent + ':' + list.join(',') + ':' + Object.keys(c.inline).sort().map(function (k) { return k + '=' + c.inline[k]; }).join(';'));
      });
      key = key.join('|'); st.pre = input.preKey; proof = evidence(st.sensitive, locate);
      if (key === st.key && proof === st.proof) return { kind: 'same', changed: changed };
      if (key !== st.key) {
        st.key = key; shape = ctxs.map(function (c) { return c.key + '<' + c.parent; }).join();
        ctxs.forEach(function (c) { envs[c.key] = computeEnv(envs[c.parent] || {}, cascade(matched[c.key], c.inline)); });
        dirty = changedNames(st.envs, envs, shape);
        st.envs = envs; st.shape = shape; st.tree = { ctxs: ctxs, envs: envs, parents: parents, depth: depth };
      }
      // Only rules reading a changed variable, or placed by element evidence that moved, re-render.
      moved = proof !== st.proof;
      model.dynamic.forEach(function (u) {
        if (u.kind === 'at') { if (renderAt(u, st.envs[opts.rootKey] || {})) changed.push(u); return; }
        if (dirty && !(moved && u.hot) && u.block !== null && !u.vars.some(function (v) { return has(dirty, v); })) return;
        if (renderRule(u, st.tree, locate)) changed.push(u);
      });
      // Rules whose context depends on where their elements are; rechecked on each full run.
      st.sensitive = model.dynamic.filter(function (u) { return u.hot; }); st.proof = evidence(st.sensitive, locate);
      st.unsettled = locate ? st.sensitive.filter(function (u) { return !locate(u.query); }) : [];
      return { kind: changed.length ? 'changed' : 'resolved', changed: changed };
    }
    function emit(units) {
      return units.map(function (u) { return u.kind === 'group' ? u.head + '{' + emit(u.units) + '}' : u.kind === 'rule' ? u.sel + '{' + u.block + '}' : u.text; }).join('\n');
    }
    /* Binds dynamic units to the parsed rules; false when the engine kept a different set. */
    function attach(units, rules, owner) {
      var k = 0, ok = true;
      units.forEach(function (u) {
        var r = rules[k++];
        if (!ok || !r) { ok = false; return; }
        if (u.kind === 'group') ok = !!r.cssRules && attach(u.units, r.cssRules, r);
        else if (u.kind === 'text') ok = (r.type === 1) === u.style;
        else { ok = u.kind !== 'rule' || r.type === 1; u.rule = r; u.owner = owner; }
      });
      return ok && k === rules.length;
    }
    function update(changed) {
      changed.forEach(function (u) {
        if (u.kind === 'rule') { u.rule.style.cssText = u.block; return; }
        var i = Array.prototype.indexOf.call(u.owner.cssRules, u.rule);
        u.owner.deleteRule(i); u.owner.insertRule(u.text, i); u.rule = u.owner.cssRules[i];
      });
    }
    /* Declaring selectors that also match elements outside the contexts, whose values are not
       cascaded there: count(selector) -> number of such elements. A development aid. */
    function strays(count) {
      var out = {};
      model.declaring.forEach(function (d) { var n = !d.element && count(d.sel); if (n) out[d.sel] = n; });
      return out;
    }
    return { model: model, diagnostics: diag, state: st, run: run, strays: strays, text: function () { return emit(model.units); }, attach: function (sheet) { return attach(model.units, sheet.cssRules, sheet); }, update: update };
  }

  api._internals = { opaque: opaque, queryOf: queryOf, stripComments: stripComments, splitTop: splitTop, parseDecls: parseDecls, parseRules: parseRules, specificity: specificity, compounds: compounds, substitute: substitute, computeEnv: computeEnv, prefixed: prefixed, createResolver: createResolver };

  var native = false;
  try { native = !!(window.CSS && window.CSS.supports && window.CSS.supports('--a', '0')); } catch (e) { native = false; }
  if (native && !/[?&]legacy=1(?:&|$)/.test(window.location && window.location.search || '') && window.CleanFrameForceLegacy !== true) return;

  /* ---------- Legacy engine only ---------- */
  api.active = true;
  var DEFS = [
    { key: 'root', tokens: [':root', 'html'] },
    { key: 'stage', id: 'stage', tokens: ['#stage', '.stage'] },
    { key: 'home', id: 'home', tokens: ['#home', '.home'] },
    { key: 'sheet', id: 'sheet', tokens: ['#sheet', '.sheet'] },
    { key: 'utils', id: 'utils', tokens: ['#utils', '.quiet-utils', '.utils'] },
    { key: 'dock', id: 'dock', tokens: ['#dock', '.dock'] },
    { key: 'spotify', id: 'spotifyPlayer', tokens: ['#spotifyPlayer', '.spotify-player'] }
  ];
  // Until the first resolved sheet is in place: no flash of unresolved colours, no transitions.
  var BOOT = '#stage{opacity:0!important}#stage,#stage *,#stage *::before,#stage *::after{-webkit-transition:none!important;transition:none!important;-webkit-animation:none!important;animation:none!important}';
  var OVERLAY = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;padding:12px 16px;border-radius:8px;background:rgba(110,0,0,.92);color:#fff;font:20px/28px monospace;white-space:pre-wrap;word-wrap:break-word;pointer-events:none';
  var SAFE_PSEUDO = /^(root|not|first-child|last-child|only-child|empty|hover|active|focus|checked|disabled|link|visited|before|after|nth-child|nth-of-type|first-of-type|last-of-type)$/;
  var EP = window.Element && window.Element.prototype, matchesFn = EP && (EP.matches || EP.webkitMatchesSelector);
  var now = window.performance && window.performance.now ? function () { return window.performance.now(); } : function () { return Date.now(); };
  var resolver = null, link = null, style = null, boot = null, scratch = null, handles = false, busy = false, timer = 0, watchdog = 0;
  var reg = [], regVersion = 0, nodes = null, treeEls = [], watched = [], treeVersion = 0, mqls = {}, supportCache = {}, lines = [], overlay = null;
  var stats = { compile: 0, applies: 0, first: null, last: null, kind: '', max: 0, changes: 0, lastChange: null, errors: lines };

  /* Diagnostics: there is no remote inspector on these TVs, so errors are shown on screen. */
  function describe(e) {
    var at = e && e.stack && /([^\/\s()]+\.js):(\d+):(\d+)/.exec(e.stack);
    return e && e.message ? e.message + (at ? ' @ ' + at[1] + ':' + at[2] + ':' + at[3] : '') : String(e);
  }
  function report(text) {
    text = String(text).slice(0, 400);
    if (lines.length && lines[lines.length - 1].text === text) lines[lines.length - 1].n++;
    else { lines.push({ text: text, n: 1 }); if (lines.length > 6) lines.shift(); }
    try {
      if (!overlay) { overlay = document.createElement('div'); overlay.id = 'legacyErrors'; overlay.setAttribute('aria-hidden', 'true'); overlay.style.cssText = OVERLAY; }
      if (!overlay.parentNode || document.body && overlay.parentNode !== document.body) (document.body || document.documentElement).appendChild(overlay);
      overlay.textContent = lines.map(function (l) { return l.text + (l.n > 1 ? ' (x' + l.n + ')' : ''); }).join('\n');
    } catch (ignore) { /* The overlay is best effort. */ }
  }
  window.addEventListener('error', function (ev) {
    if (ev && ev.message !== undefined) report(ev.message + ' @ ' + String(ev.filename || '').split('/').pop() + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0));
  });
  window.addEventListener('unhandledrejection', function (ev) { report('Unhandled rejection: ' + describe(ev.reason)); });
  // Chromium 47 has no unhandledrejection event; report throws inside callbacks instead.
  if (window.Promise && !('onunhandledrejection' in window)) (function () {
    var then = window.Promise.prototype.then;
    function guard(fn) { return typeof fn !== 'function' ? fn : function (value) { try { return fn(value); } catch (e) { report(describe(e) + ' (promise callback)'); throw e; } }; }
    window.Promise.prototype.then = function (ok, fail) { return then.call(this, guard(ok), guard(fail)); };
  }());

  /* design.js uses matches() and closest(); both predate Chromium 47 but are kept guarded. */
  function define(o, name, fn) { try { Object.defineProperty(o, name, { configurable: true, writable: true, value: fn }); } catch (e) { o[name] = fn; } }
  if (EP && !EP.matches && EP.webkitMatchesSelector) define(EP, 'matches', EP.webkitMatchesSelector);
  if (EP && !EP.closest) define(EP, 'closest', function (sel) { for (var el = this; el && el.nodeType === 1; el = el.parentNode) if (el.matches(sel)) return el; return null; });

  /* Without OpenType variations Manrope would draw its default ExtraLight outlines at every
     weight, synthesising 600. Later faces with the same descriptors win, so static instances
     replace it. A forced resolver on a modern engine keeps the variable face. */
  if (!native) try {
    var faces = document.createElement('style');
    faces.id = 'legacyFonts';
    faces.textContent = [400, 500, 600, 700].map(function (w) { return '@font-face{font-family:Manrope;src:url(assets/manrope-' + w + '.woff2) format("woff2");font-weight:' + w + '}'; }).join('\n');
    document.head.appendChild(faces);
  } catch (e) { report('Legacy fonts: ' + describe(e)); }

  /* ---------- Engine probes ---------- */
  function scratchOk(rule) {
    try {
      if (!scratch) { scratch = document.createElement('style'); scratch.media = 'not all'; document.head.appendChild(scratch); }
      scratch.sheet.insertRule(rule, 0); scratch.sheet.deleteRule(0); return true;
    } catch (e) { return false; }
  }
  function validSelector(sel) {
    var re = /::?([\w-]+)(\(([^)]*)\))?/g, m;
    while ((m = re.exec(sel))) if (!SAFE_PSEUDO.test(m[1].toLowerCase()) || m[3] && /[\s>+~:\[]/.test(trim(m[3]))) return scratchOk(sel + '{}');
    return true;
  }
  function supports(prop, value) {
    var k = prop + ':' + value;
    if (!has(supportCache, k)) {
      // Unknown properties are left for the engine to drop; known ones with bad values become unset.
      try { supportCache[k] = !window.CSS || !window.CSS.supports || !window.CSS.supports(prop, 'inherit') || window.CSS.supports(prop, value); } catch (e) { supportCache[k] = true; }
    }
    return supportCache[k];
  }
  function media(name, prelude) {
    var k = name + ' ' + prelude;
    try {
      if (name === 'media') { if (!has(mqls, k)) mqls[k] = window.matchMedia ? window.matchMedia(prelude) : null; return !mqls[k] || mqls[k].matches; }
      if (!has(mqls, k)) mqls[k] = !!(window.CSS && window.CSS.supports && window.CSS.supports(prelude));
      return mqls[k];
    } catch (e) { return false; }
  }

  /* ---------- Context elements and JS-set variables ---------- */
  function entry(el, make) {
    for (var i = 0; i < reg.length; i++) if (reg[i].el === el) return reg[i];
    if (make) { reg.push({ el: el, vars: {} }); return reg[reg.length - 1]; }
    return null;
  }
  function setVar(el, name, value) {
    var e, absent = value === null || value === undefined;
    if (!el || typeof name !== 'string' || name.slice(0, 2) !== '--' || !(e = entry(el, !absent))) return;
    if (absent) { if (!has(e.vars, name)) return; delete e.vars[name]; }
    else { value = String(value); if (e.vars[name] === value) return; e.vars[name] = value; }
    regVersion++;
    if (!timer) timer = setTimeout(function () { timer = 0; apply(); }, 0);
  }
  function tree() {
    var els = DEFS.map(function (d) { return d.id ? document.getElementById(d.id) : document.documentElement; });
    reg.forEach(function (r) { if (els.indexOf(r.el) < 0 && document.documentElement.contains(r.el)) els.push(r.el); });
    if (nodes && els.length === treeEls.length && els.every(function (el, n) { return el === treeEls[n]; })) return;
    treeEls = els; treeVersion++; nodes = []; watched = [];
    els.forEach(function (el, n) {
      var depth = 0, p = el;
      if (!el) return;
      while ((p = p.parentNode) && p.nodeType === 1) { depth++; if (watched.indexOf(p) < 0) watched.push(p); }
      if (watched.indexOf(el) < 0) watched.push(el);
      nodes.push({ el: el, key: n < DEFS.length ? DEFS[n].key : 'x' + n + (el.id ? ':' + el.id : ''), depth: depth, n: n, parent: null });
    });
    nodes.sort(function (a, b) { return a.depth - b.depth || a.n - b.n; });
    nodes.forEach(function (node) {
      for (var p = node.el.parentNode; p && p.nodeType === 1 && node.parent === null; p = p.parentNode) nodes.forEach(function (o) { if (o.el === p) node.parent = o.key; });
    });
    DEFS.forEach(function (d) {
      d.tokens.forEach(function (t) { if (t.charAt(0) === '.' && document.getElementsByClassName(t.slice(1)).length > 1) resolver.diagnostics.notes.push('Several ' + t + ' elements; #' + d.id + ' is the context.'); });
    });
  }
  function contexts() {
    return nodes.map(function (node) {
      var el = node.el, e = entry(el, false);
      return { key: node.key, parent: node.parent, depth: node.depth, tag: el.tagName.toLowerCase(), id: el.id || '', className: (el.getAttribute('class') || '').replace(/\s+/g, ' '), inline: e ? e.vars : {},
        matches: function (sel) { try { return matchesFn.call(el, sel); } catch (x) { return false; } } };
    });
  }
  function contextOf(el) {
    for (var p = el, n; p; p = p.parentNode) for (n = 0; n < nodes.length; n++) if (nodes[n].el === p) return nodes[n].key;
    return null;
  }
  function locate(sel) {
    var seen = null, list, i, key;
    try { list = document.querySelectorAll(sel); } catch (e) { return null; }
    for (i = 0; i < list.length && i < 64; i++) if ((key = contextOf(list[i])) !== null) { seen = seen || {}; seen[key] = (seen[key] || 0) + 1; }
    return seen;
  }
  /* Class names of the contexts and their ancestors key the cache when every declaring
     selector depends on classes only; a normal key press then costs a string compare. */
  function preKey() {
    if (!resolver.model.classOnly) return null;
    var out = treeVersion + '#' + regVersion + '#', i;
    for (i = 0; i < watched.length; i++) out += (watched[i].getAttribute('class') || '') + '|';
    resolver.model.conds.forEach(function (g) { out += media(g.name, g.prelude) ? '1' : '0'; });
    return out;
  }

  /* ---------- Apply ---------- */
  function reveal() {
    clearTimeout(watchdog);
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
    boot = null;
  }
  function failed(e) {
    report('Legacy CSS: ' + describe(e));
    // Before the first swap the original stylesheet stays; afterwards the last resolved one does.
    if (style && !link.disabled) { if (style.parentNode) style.parentNode.removeChild(style); style = null; }
    reveal();
  }
  function write(changed) {
    if (style) { if (handles) resolver.update(changed); else style.textContent = resolver.text(); return; }
    style = document.createElement('style'); style.id = 'legacyResolved'; style.textContent = resolver.text();
    link.parentNode.insertBefore(style, link.nextSibling);
    handles = resolver.attach(style.sheet);
    if (!handles) resolver.diagnostics.notes.push('The engine kept a different rule set; updates rewrite the whole sheet.');
    link.disabled = true;
    // Settle the resolved values while transitions are still suppressed, then show the stage.
    if (document.body) document.body.offsetWidth;
    reveal();
  }
  function apply() {
    var t0 = now(), r = null, ms;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!resolver || busy) { if (!resolver) reveal(); return; }
    busy = true;
    try {
      tree();
      r = resolver.run({ preKey: preKey(), contexts: contexts, media: media, locate: locate });
      if (r.kind === 'changed' || !style) write(r.changed);
    } catch (e) { failed(e); }
    busy = false;
    ms = now() - t0; stats.applies++; stats.last = ms; stats.kind = r ? r.kind : 'error'; stats.max = Math.max(stats.max, ms);
    if (stats.first === null && style) stats.first = ms;
    if (r && r.kind === 'changed') { stats.changes++; stats.lastChange = ms; }
  }
  /* Development aid: rules whose elements sit in a context with other values than the one used. */
  function audit() {
    var out = [], envs = resolver.state.envs || {};
    function val(key, v) { return envs[key][v] === undefined ? null : envs[key][v]; }
    resolver.model.dynamic.forEach(function (u) {
      var seen = u.kind === 'rule' && u.ctx && locate(u.query);
      Object.keys(seen || {}).forEach(function (key) {
        if (key !== u.ctx && u.vars.some(function (v) { return val(key, v) !== val(u.ctx, v); })) out.push({ selector: u.sel, assigned: u.ctx, actual: key, elements: seen[key] });
      });
    });
    function context(el) { return nodes.some(function (node) { return node.el === el; }); }
    var strays = resolver.strays(function (sel) {
      var list, n = 0, i;
      try { list = document.querySelectorAll(sel); } catch (e) { return 0; }
      for (i = 0; i < list.length; i++) if (!context(list[i])) n++;
      return n;
    });
    Object.keys(strays).forEach(function (sel) { out.push({ selector: sel, declares: 'outside the contexts', elements: strays[sel] }); });
    return out;
  }

  api.apply = apply;
  api.setVar = setVar;
  api.removeVar = function (el, name) { setVar(el, name, null); };
  api._internals.stats = stats;
  api._internals.env = function () { return resolver && resolver.state.envs; };
  api._internals.text = function () { return resolver && style ? resolver.text() : ''; };
  api._internals.diagnostics = function () { return resolver ? resolver.diagnostics : null; };
  api._internals.audit = function () { return resolver ? audit() : []; };
  api._internals.unsettled = function () { return resolver ? resolver.state.unsettled.map(function (u) { return u.query; }) : []; };
  try {
    var links = document.getElementsByTagName('link'), i, t0 = now();
    for (i = links.length - 1; i >= 0 && !link; i--) if (/(^|\/)style\.css([?#]|$)/.test(links[i].getAttribute('href') || '')) link = links[i];
    if (!link) throw new Error('style.css link not found');
    var request = new window.XMLHttpRequest();
    request.open('GET', link.getAttribute('href'), false);
    request.send(null);
    // Packaged widgets read file: URLs, which report status 0.
    if (!(request.status === 200 || request.status === 0) || !request.responseText) throw new Error('style.css could not be read (' + request.status + ')');
    resolver = createResolver(request.responseText, { defs: DEFS, rootKey: 'root', fallbackKey: 'stage', valid: validSelector, validAt: scratchOk, supports: supports });
    stats.compile = now() - t0;
    if (scratch && scratch.parentNode) scratch.parentNode.removeChild(scratch);
    boot = document.createElement('style'); boot.id = 'legacyBoot'; boot.textContent = BOOT;
    link.parentNode.insertBefore(boot, link.nextSibling);
    // main.js applies during its first render. If it never does, resolve anyway, then
    // make sure the stage can never stay hidden.
    document.addEventListener('DOMContentLoaded', function () { if (!style) apply(); });
    watchdog = setTimeout(function () {
      if (!style) apply();
      reveal();
      if (!style) report('Legacy CSS was not applied; the original stylesheet is shown.');
    }, 4000);
  } catch (e) {
    resolver = null; reveal(); report('Legacy CSS: ' + describe(e));
  }
}());
