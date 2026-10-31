/* Public Tizen application APIs. No Mac server, network address or credentials. */
(function () {
  'use strict';
  if (window.FrameDevice && window.FrameDevice.platform === 'android') return;
  // Engines without custom properties are 2017 or older TVs (Tizen 3.0). Only they probe
  // installed apps and use the alternative targets below; newer TVs keep the reference IDs.
  var OLD = !(window.CSS && window.CSS.supports && window.CSS.supports('--a', '0'));
  // Targets in preference order; the first installed ID wins. The first entry is the reference
  // TV's ID, and older models ship some apps and system screens under others.
  var IDS = {
    stremio: ['IkWsFHtOY9.Stremio'], netflix: ['org.tizen.netflix-app', 'RN1MCdNq8t.Netflix'],
    disneyplus: ['MCmYXNxgcu.DisneyPlus'], youtube: ['9Ur5IzDKqV.TizenYouTube'],
    appletv: ['com.samsung.tv.aria-video', 'Y6A54cEa22.AppleTV'], primevideo: ['org.tizen.primevideo', 'evKhCgZelL.AmazonIgnitionLauncher2'],
    abciview: ['mWK87Xghap.ABCiview'], sbs: ['OyE7OuxlUi.SBSOnDemand'],
    applemusic: ['org.tizen.apple.apple-music']
  };
  var HOME = ['com.samsung.tv.csfs', 'org.volt.firstscreen'], SETTINGS = ['com.samsung.tv.coba.setting', 'org.tizen.menu'], ART = 'org.tizen.art-app';
  var STREAMING = ['as6cYRgkPy.Binge', '73iTZRTc34.Stan', '5b8c3eb16b.BeamCTVDev',
    'cj37Ni3qXM.HBONow', 'LBUAQX1exg.Hulu', 'gzcc4LRFBF.Peacock', 'rJyOSqC6Up.CBSAllAccess',
    'Rk72oKFsRS.OtterKidsProd', '70fRFUwYlD.OtterGAProd', 'PvWgqxV3Xa.YouTubeTV',
    'XtU8fQk2gN.ESPN', 'ZmmGjO6VKO.slingtv', 'VtuWAiZdHN.STARZPlay', 'ckfgqqzvt0.dplus',
    'kk8MbItQ0H.VUDU', 'Jz7aUrV2Q4.Twitch', 'OK2Rdkjmsi.IMDbTV', 'Ob3XhAVMu6.amcplus',
    'KaLitts8bq.tenplaySamsungTizen', 'eYuOiOLYQX.KayoSports', 'Ne2ZsPWdKl.9NOW',
    '3KA0pm7a7V.TubiTV', 'rJeHak5zRg.Spotify', 'icp4AvUPiA.7plus'].concat(OLD ? [
    'SrAoJxGQUf.ARD', 'yPSlpvfeTf.ZDFmediathek', 'cg2m3QSB89.7tv', 'KbRHmu0vrC.TVNOWPREMIUM', 'Mo5FtpAjGy.Skyonline',
    'g0nt8dscFO.MagentaTV', 'vbUQClczfR.Wuakitv', 'f5fnjHAVHQ.DeutscheWelle'] : []);
  var CONSUMER_SYSTEM = ['org.tizen.browser', 'com.microsoft.copilot'];
  var EXTRA_BRANDS = {'rJeHak5zRg.Spotify': 'spotify', '5b8c3eb16b.BeamCTVDev': 'hbomax', 'cj37Ni3qXM.HBONow': 'hbomax', '3KA0pm7a7V.TubiTV': 'tubi'};
  var INTERNAL = ['adplatform.ADPlayer', 'WykOS4t4F0.cmsWebApp', '25emanual3.emanual',
    'd0m1lV1nt2.emanual', '2022ePop01.SmartTV',
    'ZODRT12q2l.WebAccountExtension', 'ByJlgt0XeD.CastSettingsApp', 'tv6pbVMQFF.PrivacyChoices'];
  // The same system helpers under older models' IDs: a whole ID segment, optionally year-numbered.
  var HELPER = /(?:^|\.)\d*(?:e-?manual|epop|thinextra|adplayer|otapp|privacychoices|multiscreen)\d*(?:\.|$)/i;
  var SELF = 'nClrkHome1.FrameHome';
  function api() { return window.tizen && window.tizen.application; }
  function selfId() {
    try { return api().getCurrentApplication().appInfo.id || SELF; }
    catch (err) { return SELF; }
  }
  var probes = {};
  /* true or false as an older TV reports the app; null when it cannot tell (newer TVs, web preview, other errors). */
  function has(id) {
    var app = api();
    if (!OLD || !app || typeof app.getAppInfo !== 'function') return null;
    if (!probes.hasOwnProperty(id)) {
      try { probes[id] = !!app.getAppInfo(id); }
      catch (err) { probes[id] = err && err.name === 'NotFoundError' ? false : null; }
    }
    return probes[id];
  }
  function first(ids) { for (var i = 0; i < ids.length; i++) if (has(ids[i]) !== false) return ids[i]; return null; }
  function appId(brand) { return IDS.hasOwnProperty(brand) ? first(IDS[brand]) || IDS[brand][0] : null; }
  /* The Frame: true; another Samsung model code (two letters, then the screen size): false; else null. */
  function frame() {
    var model = '';
    try { model = String(window.tizen.systeminfo.getCapability('http://tizen.org/system/model_name') || ''); } catch (err) { model = ''; }
    return /LS0\d/i.test(model) ? true : /^[A-Z]{2}\d{2}/i.test(model) ? false : null;
  }
  function hideable() {
    try { return OLD && typeof api().getCurrentApplication().hide === 'function'; } catch (err) { return false; }
  }
  // Art Mode exists only on The Frame; an older TV with an unreadable model hides it. Hiding
  // CleanFrame still leaves Home when an older TV has no Samsung Home target.
  var capabilities = OLD ? { art: has(ART) !== false && frame() === true, home: !!first(HOME) || hideable(), settings: !!first(SETTINGS) } : { art: true, home: true, settings: true };
  function unavailable(done) {
    done({ message: 'Open CleanTV on the TV to use this control.', detail: 'The web preview cannot control the TV.' });
  }
  function failure(err) {
    return { message: 'The TV could not open this screen.', detail: err && (err.message || err.name) || 'Try again, or press the remote’s Home button to return to CleanTV.' };
  }
  function bounded(done, timeout) {
    var finished = false, timer = setTimeout(function () { finish({ message: 'The TV did not respond. Please try again.' }); }, timeout || 8000);
    function finish(err, value) { if (finished) return; finished = true; clearTimeout(timer); done(err, value); }
    return finish;
  }
  function launchApp(id, done) {
    if (!api()) { unavailable(done); return; }
    var finish = bounded(done);
    try { api().launch(id, function () { finish(null); }, function (err) { finish(failure(err)); }); }
    catch (err) { finish(failure(err)); }
  }
  function launch(brand, done) {
    if (!appId(brand)) { done({message: 'This app has no launch target.'}); return; }
    launchApp(appId(brand), done);
  }
  function art(done) {
    if (!api()) { unavailable(done); return; }
    var finish = bounded(done);
    try {
      var data = [new tizen.ApplicationControlData('mode', ['fullscreen']), new tizen.ApplicationControlData('requester', ['mobile'])];
      var control = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/default', null, null, null, data);
      api().launchAppControl(control, ART, function () { finish(null); }, function (err) { finish(failure(err)); });
    } catch (err) { finish(failure(err)); }
  }
  function hide(done) {
    try { api().getCurrentApplication().hide(); done(null); } catch (err) { done(failure(err)); }
  }
  function home(done) {
    var id = first(HOME);
    if (!hideable()) launchApp(id || HOME[0], done);
    else if (!id) hide(done);
    else launchApp(id, function (err) { if (err) hide(done); else done(null); });
  }
  function settings(done) { launchApp(first(SETTINGS) || SETTINGS[0], done); }
  function apps(done) {
    if (!api()) { unavailable(done); return; }
    // Large installed catalogues can take longer than a launch response.
    var finish = bounded(done, 20000);
    try {
      api().getAppsInfo(function (list) {
        var known = {}, chosen = {}, present = {}, seen = {}, result = [], self = selfId();
        list.forEach(function (a) { if (a.name) present[a.id] = true; });
        Object.keys(IDS).forEach(function (brand) {
          (OLD ? IDS[brand] : IDS[brand].slice(0, 1)).forEach(function (id) { known[id] = brand; if (present[id] && !chosen[brand]) chosen[brand] = id; });
        });
        list.forEach(function (a) {
          var primary = !!known[a.id], stream = STREAMING.indexOf(a.id) >= 0;
          var consumer = /^[A-Za-z0-9]{10}\.[A-Za-z0-9_-]+$/.test(a.id) || CONSUMER_SYSTEM.indexOf(a.id) >= 0;
          // One entry per brand: the preferred installed ID.
          if (primary && chosen[known[a.id]] !== a.id) return;
          if (a.id === self || INTERNAL.indexOf(a.id) >= 0 || seen[a.id] || !a.name || (!primary && !stream && (!a.show || !consumer))) return;
          if (OLD && !primary && HELPER.test(a.id)) return;
          if (!primary && /(?:service|worker|preview|promotion|plugin|launcher|test|sdk|^ep[ -]|factory|daemon)/i.test(a.name + ' ' + a.id)) return;
          if (/-dummy$/.test(a.id) || a.id === 'com.samsung.tv.cobalt-yt') return;
          seen[a.id] = true;
          result.push({ appId: a.id, name: a.name, brand: known[a.id] || EXTRA_BRANDS[a.id] || '', icon: a.iconPath || '', rank: primary ? Object.keys(IDS).indexOf(known[a.id]) : (stream ? 20 : 30) });
        });
        result.sort(function (a, b) { return a.rank - b.rank || a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
        finish(null, result);
      }, function (err) { finish(failure(err)); });
    } catch (err) { finish(failure(err)); }
  }
  window.FrameDevice = { launch: launch, launchApp: launchApp, art: art, home: home, settings: settings, apps: apps, has: has, appId: appId, capabilities: capabilities };
}());
