/* Two-slot localStorage records for CleanTV host data. A write never touches the slot that
   holds the current record, so a failed or mangled write leaves the previous one readable. */
(function () {
  'use strict';
  var BUDGET = 131072, FAILED = 'Could not save add-ons.';
  // Own prefixes only: Home preferences (cleantv.home.v1, cleanframe.*) are never read or written.
  var PREFIX = /^cleantv\.(?!home\.)[a-z][a-z0-9-]{0,31}\.v[0-9]{1,3}$/;

  function storage() { try { return window.localStorage || null; } catch (e) { return null; } }
  function get(key) { var s = storage(); try { return s ? s.getItem(key) : null; } catch (e) { return null; } }
  /* {slot, seq, data} for a valid record, {newer: true} for a later format, otherwise null. */
  function inspect(key) {
    var text = get(key), record, data;
    if (typeof text !== 'string') return null;
    try { record = JSON.parse(text); } catch (e) { return null; }
    if (!record || typeof record !== 'object') return null;
    if (typeof record.v === 'number' && record.v > 1) return { newer: true };
    if (record.v !== 1 || typeof record.seq !== 'number' || record.seq % 1 !== 0 || record.seq < 1 || record.seq > 9007199254740991) return null;
    if (typeof record.data !== 'string' || typeof record.sum !== 'string' || record.sum !== window.CleanTVSha256.text(record.data)) return null;
    try { data = JSON.parse(record.data); } catch (e) { return null; }
    return { slot: key, seq: record.seq, data: data };
  }
  function slots(prefix) { return [inspect(prefix + '.a'), inspect(prefix + '.b')]; }
  function winner(found) {
    var a = found[0] && !found[0].newer ? found[0] : null, b = found[1] && !found[1].newer ? found[1] : null;
    return a && b ? (b.seq > a.seq ? b : a) : a || b;
  }
  function fail() { throw new Error(FAILED); }

  window.CleanTVStore = {
    read: function (prefix) {
      if (!PREFIX.test(prefix)) return null;
      var best = winner(slots(prefix));
      return best ? best.data : null;
    },
    write: function (prefix, data) {
      var s = storage(), found, best, key, json, record, back;
      if (!PREFIX.test(prefix) || !s) fail();
      found = slots(prefix);
      // A slot in a newer format belongs to a later version of the app: read-only here.
      if (found[0] && found[0].newer || found[1] && found[1].newer) fail();
      try { json = JSON.stringify(data); } catch (e) { fail(); }
      if (typeof json !== 'string' || json.length > BUDGET) fail();
      best = winner(found);
      key = best && best.slot === prefix + '.a' ? prefix + '.b' : prefix + '.a';
      record = JSON.stringify({ v: 1, seq: best ? best.seq + 1 : 1, sum: window.CleanTVSha256.text(json), data: json });
      try { s.setItem(key, record); back = s.getItem(key); } catch (e) { fail(); }
      if (back !== record) {
        // A mangled copy must not outrank the intact previous record.
        try { s.removeItem(key); } catch (e) { /* the sum still rejects it */ }
        fail();
      }
      return true;
    },
    clear: function (prefix) {
      var s = storage();
      if (!PREFIX.test(prefix) || !s) return;
      try { s.removeItem(prefix + '.a'); s.removeItem(prefix + '.b'); } catch (e) { /* nothing stored */ }
    }
  };
}());
