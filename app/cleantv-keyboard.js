/* CleanTV on-screen keyboard (docs/addons.md, "On-screen keyboard"). A reusable full-screen view
   for remote typing: CleanTVKeyboard.create(options) returns a CleanTVViews view; a module registers
   it under its own name and opens it with CleanTVAddonSettings.open(name). The keyboard owns typing,
   remote focus and the live suggestions (debounced, cancelled when the text changes); the module
   owns the search and what a choice means. This file makes no network requests. */
(function () {
  'use strict';
  var COLUMNS = 10, VISIBLE = 7, PITCH_X = 100, PITCH_Y = 96;
  var LETTERS = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZÄÖÜß', '1234567890'];
  var NAMES = { 'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue', 'ß': 'ss' };
  var CASED = /^[A-Za-zÄÖÜäöü]$/, TYPED = /^[A-Za-zÄÖÜäöüß0-9 -]$/;
  var DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  var KEYS = LETTERS.map(function (row) {
    var list = [], c;
    for (c = 0; c < COLUMNS; c++) list.push({ id: NAMES[row.charAt(c)] || row.charAt(c).toLowerCase(), ch: row.charAt(c), col: c, w: 1 });
    return list;
  });
  KEYS.push([{ id: 'hyphen', ch: '-', col: 0, w: 1 }, { id: 'space', ch: ' ', col: 1, w: 4 }, { id: 'delete', ch: '', col: 5, w: 2 }, { id: 'ok', ch: '', col: 7, w: 3 }]);
  var de = {
    'Space': 'Leerzeichen', 'Delete': 'Löschen', 'Suggestions': 'Vorschläge', 'Searching…': 'Suche …',
    'No matches.': 'Keine Treffer.', '1 match': '1 Treffer', ' matches': ' Treffer', 'Start typing.': 'Zum Suchen tippen.',
    'Type at least ': 'Mindestens ', ' characters.': ' Zeichen eingeben.', 'Saving…': 'Wird übernommen …', 'Saved.': 'Übernommen.',
    'Type': 'Eingeben', 'Delete the last character': 'Letztes Zeichen löschen', 'Go to the suggestions': 'Zu den Vorschlägen',
    'Search now': 'Jetzt suchen', 'Choose this suggestion': 'Vorschlag übernehmen', 'Back closes without saving.': 'Zurück schließt ohne Speichern.'
  };
  function tr(lang, text) { return lang === 'de' && de[text] || text; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function trim(s) { return String(s).replace(/\s+/g, ' ').replace(/^ | $/g, ''); }

  /* ---------- Model (no DOM; scripts/test-cleantv-keyboard.mjs) ---------- */
  function keyAt(r, x) {
    var row = KEYS[r], i;
    for (i = 0; i < row.length; i++) if (x >= row[i].col && x < row[i].col + row[i].w) return row[i];
    return row[row.length - 1];
  }
  function setup(t, o) {
    if (t.kb) return t.kb;
    var value = t.data && typeof t.data.value === 'string' ? trim(t.data.value).slice(0, o.max) : '';
    t.f = t.f || {};
    if (t.f.zone !== 'keys' && t.f.zone !== 'list') { t.f.zone = 'keys'; t.f.r = 0; t.f.x = 0; t.f.i = 0; }
    t.kb = { value: value, items: [], top: 0, status: 'empty', message: '', serial: 0, pickSerial: 0, timer: 0, cancel: null, pick: null, closed: false, lang: 'en', el: null };
    if (value) changed(t, o);
    return t.kb;
  }
  function upperNext(value) { return !value || /[ -]$/.test(value); }
  function insert(t, o, ch) {
    var kb = t.kb, value = kb.value;
    if (value.length >= o.max || !TYPED.test(ch)) return false;
    if ((ch === ' ' || ch === '-') && (!value || /[ -]$/.test(value))) return false;
    if (CASED.test(ch)) ch = upperNext(value) ? ch.toUpperCase() : ch.toLowerCase();
    kb.value = value + ch;
    changed(t, o);
    return true;
  }
  function erase(t, o) {
    if (!t.kb.value) return false;
    t.kb.value = t.kb.value.slice(0, -1);
    changed(t, o);
    return true;
  }
  function stopSearch(kb) {
    if (kb.timer) { window.clearTimeout(kb.timer); kb.timer = 0; }
    if (kb.cancel) { var cancel = kb.cancel; kb.cancel = null; try { cancel(); } catch (e) { /* the request is gone */ } }
  }
  /* The text changed: the previous search is cancelled and a new one waits `delay` ms. */
  function changed(t, o) {
    var kb = t.kb, query = trim(kb.value), serial = ++kb.serial;
    stopSearch(kb);
    if (query.length < o.min) {
      kb.items = []; kb.top = 0; kb.message = '';
      kb.status = query ? 'short' : 'empty';
      if (t.f.zone === 'list') t.f.zone = 'keys';
      return;
    }
    kb.status = 'waiting';
    kb.timer = window.setTimeout(function () { kb.timer = 0; search(t, o, serial); }, o.delay);
  }
  function search(t, o, serial) {
    var kb = t.kb, query = trim(kb.value), handle;
    if (kb.closed || serial !== kb.serial) return;
    kb.status = 'searching';
    handle = o.suggest(query, kb.lang, function (error, items, note) {
      if (kb.closed || serial !== kb.serial) return;
      kb.cancel = null;
      if (error) { kb.status = 'error'; kb.message = String(error); kb.items = []; }
      else {
        kb.items = (Array.isArray(items) ? items : []).filter(function (item) { return item && typeof item.name === 'string' && item.name; }).slice(0, o.limit);
        kb.status = kb.items.length ? 'done' : 'none'; kb.message = typeof note === 'string' ? note : '';
      }
      t.f.i = clamp(t.f.i || 0, 0, Math.max(0, kb.items.length - 1));
      if (!kb.items.length && t.f.zone === 'list') t.f.zone = 'keys';
      scroll(t);
      paint(t, o);
    });
    if (!kb.closed && serial === kb.serial && kb.status === 'searching') kb.cancel = typeof handle === 'function' ? handle : null;
    paint(t, o);
  }
  function scroll(t) {
    var kb = t.kb, n = kb.items.length;
    if (t.f.zone === 'list') { if (t.f.i < kb.top) kb.top = t.f.i; if (t.f.i > kb.top + VISIBLE - 1) kb.top = t.f.i - VISIBLE + 1; }
    kb.top = clamp(kb.top, 0, Math.max(0, n - VISIBLE));
  }
  function move(t, k) {
    var f = t.f, kb = t.kb, key = keyAt(f.r, f.x);
    if (f.zone === 'list') {
      if (k === 'up' && f.i > 0) f.i--;
      else if (k === 'down' && f.i < kb.items.length - 1) f.i++;
      else if (k === 'left') { f.zone = 'keys'; f.x = keyAt(f.r, COLUMNS - 1).col; }
      scroll(t);
      return;
    }
    // No wrapping. Left and Right set the remembered column; Up and Down keep it across wide keys.
    if (k === 'left' && key.col > 0) f.x = keyAt(f.r, key.col - 1).col;
    else if (k === 'right' && key.col + key.w < COLUMNS) f.x = key.col + key.w;
    else if (k === 'right' && kb.items.length) { f.zone = 'list'; f.i = clamp(f.i || 0, 0, kb.items.length - 1); scroll(t); }
    else if (k === 'up' && f.r > 0) f.r--;
    else if (k === 'down' && f.r < KEYS.length - 1) f.r++;
  }
  function pick(t, o, item) {
    var kb = t.kb, serial;
    if (!item || kb.status === 'choosing') return;
    stopSearch(kb);
    kb.status = 'choosing'; kb.message = '';
    serial = ++kb.pickSerial;
    kb.pick = null;
    var handle = o.choose(item, kb.lang, function (error) {
      if (kb.closed || serial !== kb.pickSerial) return;
      kb.pick = null;
      if (error) { kb.status = 'error'; kb.message = String(error); paint(t, o); return; }
      close(t, o);
    });
    if (!kb.closed && serial === kb.pickSerial && kb.status === 'choosing') kb.pick = typeof handle === 'function' ? handle : null;
  }
  function press(t, o) {
    var kb = t.kb, key = keyAt(t.f.r, t.f.x);
    if (t.f.zone === 'list') { pick(t, o, kb.items[t.f.i]); return; }
    if (key.id === 'delete') erase(t, o);
    else if (key.id === 'ok') {
      if (kb.items.length) { t.f.zone = 'list'; t.f.i = 0; kb.top = 0; }
      else if (kb.timer) { window.clearTimeout(kb.timer); kb.timer = 0; search(t, o, kb.serial); }
    } else insert(t, o, key.ch);
  }
  /* Leaving cancels every pending search or choice; the remote digits are released. */
  function finish(t) {
    var kb = t.kb;
    if (!kb || kb.closed) return;
    kb.closed = true;
    stopSearch(kb);
    if (kb.pick) { var cancel = kb.pick; kb.pick = null; try { cancel(); } catch (e) { /* the request is gone */ } }
    if (current && current.t === t) current = null;
    digits(false);
  }
  function close(t, o) {
    finish(t);
    var views = window.CleanTVViews;
    if (!(views && typeof views.close === 'function' && views.close(o.name))) { t.kb.status = 'chosen'; paint(t, o); }
  }

  /* ---------- Remote digits and a hardware keyboard ---------- */
  // The remote's number keys reach the app only while registered; they are released when the view closes.
  var current = null, digitsOn = false;
  function digits(on) {
    var input = window.tizen && window.tizen.tvinputdevice;
    if (!input || digitsOn === on) return;
    digitsOn = on;
    try {
      if (typeof input[on ? 'registerKeyBatch' : 'unregisterKeyBatch'] === 'function') input[on ? 'registerKeyBatch' : 'unregisterKeyBatch'](DIGITS);
      else DIGITS.forEach(function (name) { try { input[on ? 'registerKey' : 'unregisterKey'](name); } catch (e) { /* key unavailable */ } });
    } catch (e) { /* this TV keeps its default digit handling */ }
  }
  function attached(el) { return !!(el && document.documentElement && document.documentElement.contains(el)); }
  function live() { return !!(current && !current.t.kb.closed && attached(current.t.kb.el)); }
  // Capture phase, before main.js maps Backspace to Back: in this view it deletes, and characters type.
  window.addEventListener('keydown', function (ev) {
    var code = ev.keyCode, ch = '', del = false, t, o;
    // A view left without Back (another scene took over) releases the digits at the next key.
    if (!live()) { if (digitsOn) { current = null; digits(false); } return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (code === 8) del = true;
    else if (code >= 48 && code <= 57 && !ev.shiftKey) ch = String(code - 48);
    else if (code >= 96 && code <= 105) ch = String(code - 96);
    else if (typeof ev.key === 'string' && ev.key.length === 1 && TYPED.test(ev.key)) ch = ev.key;
    else if (code >= 65 && code <= 90) ch = String.fromCharCode(code);
    else if (code === 32) ch = ' ';
    else if (code === 189 || code === 173 || code === 109) ch = '-';
    if (!ch && !del) return;
    ev.preventDefault(); ev.stopPropagation();
    t = current.t; o = current.o;
    if (t.kb.status === 'choosing') return;
    if (del) erase(t, o); else insert(t, o, ch);
    paint(t, o);
  }, true);

  /* ---------- Rendering: built once per view, then only classes and text change ---------- */
  function setClass(el, name, on) {
    var has = (' ' + el.className + ' ').indexOf(' ' + name + ' ') >= 0;
    if (on && !has) el.className += ' ' + name;
    else if (!on && has) el.className = (' ' + el.className + ' ').replace(' ' + name + ' ', ' ').replace(/^ | $/g, '');
  }
  function setText(el, text) { if (el._text !== text) { el._text = text; el.textContent = text; } }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function label(key, lang, upper) {
    if (key.id === 'space') return tr(lang, 'Space');
    if (key.id === 'delete') return tr(lang, 'Delete');
    if (key.id === 'ok') return 'OK';
    return CASED.test(key.ch) && !upper ? key.ch.toLowerCase() : key.ch;
  }
  function chevron(d) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>'; }
  function build(el, o, lang) {
    var html = '<div class="kb"><h2 class="s-title kb-title">' + esc(o.title(lang)) + '</h2>'
      + '<div class="kb-field"><span class="kb-value"></span><span class="kb-caret" aria-hidden="true"></span><span class="kb-placeholder">' + esc(o.placeholder ? o.placeholder(lang) : '') + '</span></div><div class="kb-keys">', r, j;
    KEYS.forEach(function (row, r) {
      row.forEach(function (key) {
        html += '<button type="button" tabindex="-1" class="kb-key' + (key.w > 1 ? ' is-wide' : '') + '" data-z="kb" data-i="' + r + '" data-action="cleantv.kb.' + key.id + '"'
          + ' style="left:' + key.col * PITCH_X + 'px;top:' + r * PITCH_Y + 'px;width:' + (key.w * PITCH_X - 12) + 'px">' + esc(label(key, lang, true)) + '</button>';
      });
    });
    html += '</div><div class="kb-side"><h3 class="kb-label">' + esc(tr(lang, 'Suggestions')) + '</h3><div class="kb-list">';
    for (j = 0; j < VISIBLE; j++) html += '<button type="button" tabindex="-1" class="kb-item" data-z="kb-item" data-i="' + j + '" style="top:' + j * PITCH_Y + 'px" hidden><span class="kb-name"></span><span class="kb-detail"></span></button>';
    html += '</div><div class="row-cue kb-cue kb-before" aria-hidden="true">' + chevron('m5 15.5 7-7 7 7') + '</div><div class="row-cue kb-cue kb-after" aria-hidden="true">' + chevron('m5 8.5 7 7 7-7') + '</div><p class="kb-status" aria-live="polite"></p></div>'
      + '<p class="kb-hint"><span class="remote-key">OK</span><span class="kb-hint-ok"></span><span class="kb-hint-back"></span></p></div>';
    el.innerHTML = html;
    var root = el.firstChild, keys = root.querySelectorAll('.kb-key'), items = root.querySelectorAll('.kb-item');
    el._kb = { lang: lang, root: root, value: root.querySelector('.kb-value'), placeholder: root.querySelector('.kb-placeholder'), keys: {}, items: [], upper: true,
      before: root.querySelector('.kb-before'), after: root.querySelector('.kb-after'), status: root.querySelector('.kb-status'), ok: root.querySelector('.kb-hint-ok'), back: root.querySelector('.kb-hint-back') };
    for (r = 0; r < keys.length; r++) el._kb.keys[keys[r].getAttribute('data-action').slice(11)] = keys[r];
    for (j = 0; j < items.length; j++) el._kb.items.push({ el: items[j], name: items[j].firstChild, detail: items[j].lastChild });
    setText(el._kb.back, tr(lang, 'Back closes without saving.'));
  }
  function statusText(kb, o) {
    var lang = kb.lang, n = kb.items.length;
    if (kb.status === 'empty') return o.hint ? o.hint(lang) : tr(lang, 'Start typing.');
    if (kb.status === 'short') return tr(lang, 'Type at least ') + o.min + tr(lang, ' characters.');
    if (kb.status === 'waiting' || kb.status === 'searching') return tr(lang, 'Searching…');
    if (kb.status === 'choosing') return tr(lang, 'Saving…');
    if (kb.status === 'chosen') return tr(lang, 'Saved.');
    if (kb.status === 'error' || kb.message) return kb.message;
    if (kb.status === 'none') return tr(lang, 'No matches.');
    return n === 1 ? tr(lang, '1 match') : n + tr(lang, ' matches');
  }
  function paint(t, o) {
    var kb = t.kb, ui = kb && kb.el && kb.el._kb, f = t.f, focus, upper, id, j, row, item, index, hint;
    if (!ui || !attached(kb.el)) return;
    setText(ui.value, kb.value);
    setClass(ui.placeholder, 'is-off', !!kb.value);
    upper = upperNext(kb.value);
    if (upper !== ui.upper) {
      ui.upper = upper;
      KEYS.forEach(function (r) { r.forEach(function (key) { if (CASED.test(key.ch)) setText(ui.keys[key.id], label(key, ui.lang, upper)); }); });
    }
    focus = f.zone === 'keys' ? keyAt(f.r, f.x).id : '';
    for (id in ui.keys) if (Object.prototype.hasOwnProperty.call(ui.keys, id)) setClass(ui.keys[id], 'is-focus', id === focus);
    for (j = 0; j < ui.items.length; j++) {
      row = ui.items[j]; index = kb.top + j; item = kb.items[index];
      row.el.hidden = !item;
      if (!item) { row.el.removeAttribute('data-action'); continue; }
      row.el.setAttribute('data-action', 'cleantv.kb.pick.' + index);
      row.el.setAttribute('aria-label', item.name + (item.detail ? ', ' + item.detail : ''));
      setText(row.name, item.name); setText(row.detail, typeof item.detail === 'string' ? item.detail : '');
      setClass(row.el, 'is-focus', f.zone === 'list' && f.i === index);
      setClass(row.el, 'is-busy', kb.status === 'choosing' && f.i === index);
    }
    setClass(ui.before, 'is-on', kb.top > 0);
    setClass(ui.after, 'is-on', kb.top + VISIBLE < kb.items.length);
    setText(ui.status, statusText(kb, o));
    setClass(ui.status, 'is-error', kb.status === 'error');
    hint = f.zone === 'list' ? 'Choose this suggestion' : focus === 'delete' ? 'Delete the last character' : focus === 'ok' ? kb.items.length ? 'Go to the suggestions' : 'Search now' : 'Type';
    setText(ui.ok, tr(ui.lang, hint));
  }

  window.CleanTVKeyboard = {
    /* options: { name, title(lang), placeholder(lang), hint(lang), suggest(query, lang, done) → cancel?,
       choose(item, lang, done) → cancel?, min = 2, max = 40, delay = 400, limit = 100 }.
       done(error, items, note) lists suggestions { name, detail }; done(error) after a choice. */
    create: function (options) {
      var o = {
        name: options.name, title: options.title, placeholder: options.placeholder, hint: options.hint, suggest: options.suggest, choose: options.choose,
        min: options.min > 0 ? options.min : 2, max: options.max > 0 ? options.max : 40, delay: options.delay >= 0 ? options.delay : 400, limit: options.limit > 0 ? options.limit : 100
      };
      if (typeof o.name !== 'string' || typeof o.title !== 'function' || typeof o.suggest !== 'function' || typeof o.choose !== 'function') throw new Error('Keyboard needs name, title(), suggest() and choose().');
      return {
        norm: function (t) { setup(t, o); if (!t.kb.closed) digits(true); },
        key: function (t, k) {
          var kb = setup(t, o);
          if (k === 'back') { finish(t); return false; }
          if (kb.closed || kb.status === 'choosing') return true;
          if (k === 'ok') press(t, o); else move(t, k);
          return true;
        },
        render: function (el, t, ctx) {
          var kb = setup(t, o);
          kb.lang = ctx && ctx.language === 'de' ? 'de' : 'en';
          if (!el._kb || el._kb.lang !== kb.lang || !attached(el._kb.root)) build(el, o, kb.lang);
          kb.el = el;
          if (!kb.closed) current = { t: t, o: o };
          paint(t, o);
        }
      };
    },
    /* The key layout, for checks: rows of { id, ch, col, w } on a 10-column grid. */
    layout: function () { return JSON.parse(JSON.stringify(KEYS)); }
  };
}());
