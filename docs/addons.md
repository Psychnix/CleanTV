# Add-on API 2

The Android host downloads the reviewed public catalog from AntoinS/cleanframe-addons. See that repository's README, package.schema.json and examples for the public authoring contract. API 1 uses declarative JSON packages and remains supported. The new host reads catalog-v2.json; catalog.json is unchanged for older hosts. Downloaded JavaScript and HTML are never executed. API 2 adds reviewed, separately installed native APKs.

Spotify's native adapter remains part of the host API. Its installed package enables the widget; removing the package stops Home observation and removes the widget. Account credentials and appearance preferences are deliberately retained, as stated in the confirmation dialog. Use Spotify → Sign out before removal to clear CleanFrame's account grant. The native Spotify application is unaffected.

A first upgrade seeds the Spotify package from bundled assets. Later package state is kept in addons.json through Android AtomicFile, independently of Home preferences. Saved installations work offline. Failed downloads, validation or disk writes retain previous state. Explicit refresh fetches catalog changes; downloads are never automatic. A single executor serializes operations; the UI receives completion asynchronously.

Third-party text and clock widgets are rendered as textContent using host templates, with at most three active cards. Cards occupy a fixed Home region and are hidden while the Spotify player is expanded. Clock timezone is an optional valid IANA identifier. Long text is clipped to the card; authors should keep content concise. Arbitrary rendering, custom scripts, network data providers and additional native capabilities require a later host API revision.

Management is available at Settings → Add-ons on the TV. The Mac preview can show the layout; a normal browser has no native download/storage access and reports that honestly. Tests use an explicit synthetic adapter, never real account credentials.


## Samsung (Tizen) host

The Tizen build has its own host in `app/tizen-addons.js`. It reads the reviewed catalog `https://raw.githubusercontent.com/Psychnix/cleanframe-addons/main/cleantv-catalog.json` (catalog API 2, at most 32 entries) and downloads packages from the same base address plus the entry's `path`. Downloaded JavaScript and HTML are never executed: packages are declarative JSON, and every behaviour lives in the host.

Network use follows a user action only: nothing is requested at startup or for `state`, and only Refresh catalog, Download/Update and Update all download. Every operation, including Remove and Enable/Disable, runs one at a time ("Another add-on operation is running."). Each request is a plain GET without custom headers or credentials, with a 15-second timeout. The catalog is limited to 128 KiB; a redirect to another address, a non-200 response, invalid UTF-8 or JSON, or an invalid text, clock or registered-kind entry keeps the previous catalog. Native entries, Spotify without a registered `spotify` kind, kinds this build does not know and clocks whose time zone this TV engine cannot format (Chromium 47 knows fewer zone names than Android) are counted but not offered, so newer catalogs stay readable. Only the host's own messages, or a registered kind's own message, are shown; every host message has a German translation in `app/addons.js`.

Install and update:

- The entry must be in the last checked catalog ("Refresh the catalog before downloading."). After a restart that is the stored catalog, so Discover and Download work without a new refresh.
- `GET BASE + path` is limited to 64 KiB, and the final response address must be exactly that URL.
- The SHA-256 of the raw bytes must equal the entry's `sha256` ("Package checksum mismatch.").
- The package, read by the same rules as its catalog entry, must equal that entry without `path` and `sha256` ("Package does not match catalog."). Its kind's validator runs again before it is stored.
- An update keeps the kind ("An update cannot change the add-on type.") and must be strictly newer ("This add-on is already up to date."). It keeps the activation state.
- Update all handles one package at a time and stops at the first failure ("Update stopped: …").
- At most three text or clock widgets are active. A new one beyond that arrives disabled, and enabling a fourth is refused ("Disable another widget first (maximum three active widgets)."). Registered kinds do not count toward this limit.

`FrameDevice.addons` keeps the Android contract (`state`, `refresh`, `install`, `remove`, `toggle`, `updateAll`; `cleanframe:addons` after every operation). The state has no `readOnly` field any more. Installed packages, the last good catalog and `catalogInfo` are stored through `CleanTVStore` under `cleantv.addons.v1` as `{installed: {id: package + enabled}, catalog, catalogInfo}`. A failed write keeps the previous state ("Could not save add-ons."). A stored package this build cannot read (for example a kind whose module is absent after a downgrade) is kept unchanged in storage but not offered. It still counts as the installed version of its ID: a catalog entry with that ID and another kind is refused ("An update cannot change the add-on type."), an older or equal version is refused ("This add-on is already up to date."), and only a newer version of the same kind replaces it (also through Update all), keeping its activation state within the widget limit. Add-on IDs match `^[a-z][a-z0-9-]{0,47}$` except `constructor`, the one `Object.prototype` key that pattern could match; a catalog listing it fails like any other invalid ID.

`app/config.xml` grants the public `internet` privilege and these origins, in this order, each with `subdomains="false"`: `https://raw.githubusercontent.com`, `https://api.open-meteo.com`, `https://geocoding-api.open-meteo.com`, `https://openplzapi.org`, `https://accounts.spotify.com`, `https://api.spotify.com`, `https://i.scdn.co`, `https://cleantv-spotify.tobiaspsi96.workers.dev` (the Spotify sign-in relay, see Spotify on Samsung). `scripts/check.py` asserts exactly this list, requires every `https://` string literal in `app/tizen-*.js` and `app/cleantv-*.js` to use one of these origins, and rejects CSP or navigation elements, which would switch the Tizen runtime to CSP mode and block the inline styles that `legacy.js` inserts. `scripts/check-browser.mjs` reads the same list and reports any request to one of these origins that a test did not explicitly allow.

## CleanTV host interfaces

These interfaces are for host modules bundled with the app (wallpapers, weather, Spotify). Runtime code stays ES5 and refers to browser globals as `window.X`. Custom properties set from JavaScript go through `setVar`/`removeVar` in `main.js`; modules use the stage-level variables below instead of setting their own.

Load order in `app/index.html`: `device.js`, `sha256.js`, `tizen-store.js`, then modules that register an add-on kind, then `tizen-addons.js`, …, `main.js`. A module that loads before the owner of a registry queues its registration; the owner replays the queue in order when it loads. For the `main.js` registries (`CleanTVAddonSettings`, `CleanTVViews`, `CleanTVWidgets`) the helper below works in either order. `CleanTVAddonKinds` registrations must load before `tizen-addons.js`, because stored packages are read once when it loads; a later `register()` throws (`Add-on kinds must be registered before tizen-addons.js loads: <kind>`), on every platform.

```js
function cleantv(name) {
  var r = window[name];
  if (!r) { r = window[name] = { queue: [] }; r.register = function () { r.queue.push(Array.prototype.slice.call(arguments)); }; }
  return r;
}
cleantv('CleanTVAddonKinds').register('weather', { validate: validateWeather, widget: false });
cleantv('CleanTVAddonSettings').register('weather', settingsProvider);
cleantv('CleanTVWidgets').register('weather', { order: 10, render: renderWeather });
```

A registration that throws is reported asynchronously and does not stop the host. `CleanTVAddonKinds` belongs to `tizen-addons.js`; `CleanTVAddonSettings`, `CleanTVViews`, `CleanTVWidgets` and `CleanTVIcon` belong to `main.js` and exist once it has loaded.

### `window.CleanTVSha256` (`app/sha256.js`)

Own FIPS 180-4 implementation, no third-party code.

- `bytes(Uint8Array)` → lowercase hex digest.
- `raw(Uint8Array)` → `Uint8Array(32)`.
- `text(string)` → hex digest of the string's UTF-8 bytes.
- `base64url(Uint8Array)` → base64url without padding.
- `utf8(string)` → `Uint8Array` with the UTF-8 bytes (a host addition, used for PKCE: `base64url(raw(utf8(verifier)))`).

Inputs other than `Uint8Array` throw a `TypeError`.

### `window.CleanTVStore` (`app/tizen-store.js`)

- `read(prefix)` → the stored data object, or `null`.
- `write(prefix, data)` → `true`, or throws `Error('Could not save add-ons.')`.
- `clear(prefix)` removes both slots.

Each prefix has two localStorage slots, `<prefix>.a` and `<prefix>.b`, each holding `{"v":1,"seq":N,"sum":"<sha256 hex of the data JSON>","data":"<json string>"}`. A write goes to the slot that does not hold the current record, with `seq + 1`, and reads it back; on a quota error or a mismatch (the mangled copy is removed) the previous slot stays intact. `read` drops slots with a bad sum, bad JSON or `v` other than 1 and returns the valid record with the highest `seq`. A slot with `v` greater than 1 belongs to a later version: `read` ignores it and `write` throws. The data JSON may have at most 131072 characters. Prefixes have the form `cleantv.<name>.v<n>` (`cleantv.addons.v1`; later `cleantv.wallpapers.v1`, `cleantv.weather.v1`, `cleantv.spotify.v1`). The store never reads or writes `cleantv.home.v1`, `cleanframe.home.v1` or `cleanframe.shore.v1`.

### `window.CleanTVAddonKinds` (`app/tizen-addons.js`)

`register(kind, { validate: function (entry) { … return sanitized; }, widget: false })`

- Register before `tizen-addons.js` loads (through the queue above); a call after that throws.
- `kind` matches `^[a-z][a-z0-9-]{0,31}$`; `text`, `clock` and `native` are reserved, and a kind registers once. `widget` must be `false`: registered kinds never use the text/clock cards and do not count toward the three-widget limit.
- The host first checks the shared identity and metadata (API 1, ID, version, name, description, author, licence, and for catalog entries `path` and `sha256`). `validate` then receives a copy of the entry without `path` and `sha256` and returns the sanitized package. The host keeps its own `api`, `id`, `name`, `version`, `kind`, `description`, `author`, `license`, `permissions`, `path` and `sha256`; `enabled` is the host's.
- To reject an entry, throw `new Error('<own message>.')` (a plain `Error`, one line ending with a period). The whole refresh then fails with that message and keeps the previous catalog. Any other exception becomes "Invalid package metadata.". Add a German translation for own messages to `app/addons.js`.
- The same validator runs for the downloaded package and for stored packages at startup.
- `registered(kind)` → whether a kind is registered.

### `window.CleanTVAddons` (`app/tizen-addons.js`)

- `installed(id)` → a copy of the installed package (including `enabled`), or `null`.
- `enabled(id)` → `true` when installed and not disabled.
- `on(fn)` → calls `fn(state)` after every add-on operation; returns a function that removes the listener. Modules loading before `tizen-addons.js` can listen for `cleanframe:addons` instead.

Outside a Samsung TV (browser preview, Android) these exist but report nothing installed.

### `window.CleanTVAddonSettings` (`app/main.js`)

`register(id, { title(lang), sections(lang), ok(item), key(t, k) })`

- When the add-on `id` is installed and enabled, its detail view (`addon-detail`) shows Settings (`addon.settings.<id>`). It opens appearance group `addon-settings` with `t.addonId`; Back returns to the detail view.
- `title(lang)` → heading string. `sections(lang)` → the `detailSections` shape: `[{ id, title, horizontal, reason, items: [{ action, label, description, disabled, axis, value, applied }] }]`. Labels are already in `lang`; titles and labels are escaped.
- Namespace actions, for example `cleantv.weather.toggle.wind`. Host prefixes (`settings.`, `addon.`, `group.`, `choice.`) are dropped.
- An item with `axis` is a radio choice; `applied: true` shows its tick (a host addition, because the host does not know the provider's values). Its OK hint is "Apply selected setting". An item without `axis` shows a forward chevron and the hint "Open", for example a row whose `ok()` calls `open()`. An optional `hint` string (already in `lang`, at most 80 characters) replaces either, for example for a row that acts at once. Provider items never change Home preferences.
- `ok(item)` receives the provider's own item object on OK; return `true` when handled. Up/Down/Left/Right move focus between rows and choices as in other appearance groups; disabled items are skipped.
- Optional `key(t, k)` receives each key (`up`, `down`, `left`, `right`, `ok`, `back`) first; return `true` to stop the host's handling.
- The Home preview stays visible next to the rows, and the host renders again after each key.

`open(viewName, data)` → pushes `{ id: viewName, data: data, f: {} }` onto the panel stack when that view was registered through `CleanTVViews`; returns `false` otherwise. Call it from `ok()` or `key()`; the next render shows the view.

### `window.CleanTVViews` (`app/main.js`)

`register(name, { key(t, k), render(el, t, ctx), norm(t) })` for a full-screen sub-view such as the weather keyboard.

- `name` is namespaced with at least one dot (`cleantv.weather.keyboard`) and must not exist yet.
- `render(el, t, ctx)` fills one full-stage container (`.cleantv-view`, 1920 x 1080) after each key; `ctx = { language, bg }`. Keep DOM changes small; mark the focused control with `is-focus` and `data-action` for browser checks.
- `key(t, k)` returns `true` when handled; an unhandled Back closes the view. `norm(t)` is optional.
- `t` is the stack entry; `t.data` holds the `open()` data.

### `window.CleanTVWidgets` (`app/main.js`)

`register(id, { order: n, render: function (el, ctx) { … } })`

- `#cleantvWidgets` is a sibling of `#caption` inside `#home`, outside `#phScene`. `renderHome` calls `CleanTVWidgets.render(ctx)` on every Home render, including the Settings preview. The host builds the `ctx` the widgets receive from its own state and keeps the slot hidden behind the expanded Spotify player whatever `ctx.visible` says.
- `refresh()`: call it after asynchronous data arrives or when the content changes size, instead of only changing `el`. It renders the widgets again from host state, which is the only way card visibility and the plate alignment follow the new content. It does nothing while a sheet or full-screen view is open, before the first render, or when called from inside a widget's `render`.
- Each widget has one card, created once and kept, ordered by `order` and then ID. `render(el, ctx)` fills the card's content element; reuse what is already there. An empty `el` hides the card and its plate.
- `ctx = { language, layout: 'dock' | 'list', bg: 'photo' | 'dark' | 'light', visible }`. `visible` is false in arrange mode and while the Spotify player is expanded; the slot is then hidden.
- Geometry: Dock left 140, top 260 (220 without the date). List right-aligned to the clock's right edge (x 1780), top 300 (260 without the date); with List and Controls position Top right it sits 40px below the controls.
- Cards stack with a 16px gap. They are at most 840px wide in Dock, so they end before the text and clock cards at x 1000, and at most 880px wide in List.
- Text and clock add-on cards (`#addonWidgets`) keep their place (x 1000, top 260) while no host card is visible. In List with visible host cards they move into the same right-aligned column, directly below the host cards, so the two never overlap.

Card and type contract (style.css):

- `.cw-card` (host-created): padding 20px 24px, radius 24px, text colour `var(--cw-ink)`, text shadow `var(--cw-shadow)`. On photos the plate is a registered material field (`assets/materials/<wall>-field-*.jpg`) aligned with `fieldTransform`, with copies of the background scrims and a veil, as `.ut-lens`. Dark and light backgrounds get a flat translucent plate (`var(--plate)`). Nothing is blurred or sampled at runtime.
- `.cw-title` 28/36, weight 500, opacity .8. `.cw-big` 48/56, weight 500, letter-spacing −1.5px, tabular digits. `.cw-small` 28/36, weight 500, opacity .8, tabular digits. With a custom Home font, `.cw-big` uses the clock face and the others the UI face.
- Stage-level variables, defined only in style.css so `legacy.js` resolves them on Chromium 47: `--cw-ink` (white `--ink` on photos; the curated `--clock-ink`/`--dock-clock-ink`, the List top-right ink or the adaptive top-left ink where they exist), `--cw-shadow` (the two-layer shadow on photos, none with a curated clock ink and on flat backgrounds) and `--cw-under` (icon underlay). `--cw-veil` keeps dark ink on a light veil. With adaptive ink `.cw-big` takes the clock ink.

`window.CleanTVIcon(svgInner, size)` → SVG markup with the `ut-underlay`/`ut-ink` layering of `icon()` on a 48-unit viewBox at `size` pixels (8–256). The ink inherits `stroke-width: 1.6` and `currentColor`; inside a card the underlay uses `--cw-under` at 2.8 and disappears on flat backgrounds. `svgInner` is trusted module markup; never pass downloaded text.

Keep widget and view CSS free of `gap`, the `inset` shorthand, `:focus-visible` reliance, `backdrop-filter`, live blur and runtime pixel analysis: Chromium 47 lacks the first ones, and the others are off the TV's animation path by design. `scripts/check.py` rejects `gap` and `inset`; `npm run check:legacy` compares widget cards with and without the resolver.

## Spotify on Samsung

`app/tizen-spotify.js` loads after `tizen-store.js` (with `vendor/qrcode.js`) and before `tizen-addons.js`. On a Samsung TV it registers the `spotify` kind and sets `FrameDevice.spotify` and `FrameDevice.capabilities.spotify` with the Android contract (`state`, `observe`, `control`, `access`, `link`, `signOut`; `cleanframe:spotify` and `cleanframe:spotify-link` events). The upstream package `packages/spotify/1.0.0.json` is accepted unchanged; a `spotify` entry with another ID fails the refresh ("Unsupported widget kind."), as on Android. The package is only a switch: all behaviour is in the host.

`main.js` keeps one Spotify card, settings group and QR setup screen for both platforms. The gate is `FrameDevice.capabilities.spotify`. On Samsung, Open Spotify launches `rJeHak5zRg.Spotify`, the Android-only Media access row is hidden, covers come from `https://i.scdn.co/image/<40 hex>`, and the sign-out note points to spotify.com/account/apps for a full revocation.

### Sign-in (Authorization Code with PKCE on the TV)

- Spotify Developer app: client ID `6058b47c8aab44dd87826487377bdf6c` (public, as PKCE intends), redirect URI exactly `https://cleantv-spotify.tobiaspsi96.workers.dev/callback`, scopes `user-read-playback-state user-modify-playback-state`. No client secret exists anywhere; `scripts/check.py` rejects `client_secret` in `app/` and `relay/`.
- The TV takes 32 random bytes from `crypto.getRandomValues` for the verifier (base64url), computes the S256 challenge with `CleanTVSha256` (`base64url(raw(utf8(verifier)))`), and draws 16 bytes for its state and 32 bytes for a poll secret.
- `POST <relay>/pair` (JSON as `text/plain`, so no CORS preflight) sends `{challenge, state, pollHash}` with `pollHash = sha256 hex(secret)` and returns `{id, expiresIn}`. The QR code for `<relay>/start/<id>` is drawn with `app/vendor/qrcode.js` (qrcode-generator 1.4.4, MIT, see `THIRD_PARTY_NOTICES.md`) onto a canvas and shown as a PNG data URI, with the first six characters of the ID and the countdown.
- While the QR screen is open the TV polls `POST <relay>/poll/<id>` with `{secret}` every 2 s, one request at a time, until expiry (10 minutes). Back, leaving the app and disabling or removing the package cancel the session.
- The returned state must equal `<id>.<state>`; otherwise the sign-in fails ("Sign-in could not be verified."). The TV then redeems the code at `https://accounts.spotify.com/api/token` (form-encoded `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`) and requires a Bearer token, a refresh token and both scopes.

### Tokens

- Only the refresh token is stored, through `CleanTVStore` under `cleantv.spotify.v1` as `{refreshToken}`. A rotated refresh token is saved before the new access token is used; when Spotify sends none, the stored one stays.
- The access token stays in memory and is refreshed before a request when less than 60 seconds remain. A 401 forces one refresh and a retry; a second 401 shows "Sign in to Spotify again." A `400 invalid_grant` (Spotify's refresh tokens expire six months after the original sign-in) removes the stored token.
- Sign out removes both slots and stops all Spotify traffic. Removing the package keeps the sign-in, as on Android; sign out first to clear it.
- Verifier, poll secret, code and tokens never reach `state()`, events, `ShoreQA.state()`, logs or other storage keys.

### Playback

`GET https://api.spotify.com/v1/me/player?additional_types=episode` runs only while `main.js` observes (Home or the Spotify settings visible, package enabled, document visible), one request at a time with an 8-second timeout:

| Situation | Next poll |
| --- | --- |
| Playing | 5 s, or 750 ms after the track's end if sooner |
| Paused | 15 s |
| 204 or no item (nothing playing) | 30 s, then 60 s after five minutes |
| After a control | 750 ms |
| 429 | `Retry-After` when the TV can read it (Spotify sends no `Access-Control-Expose-Headers` today), else 30 s doubling to 5 minutes |
| 5xx or network error | 10 s doubling to 60 s |
| 403 | 60 s ("Spotify denied access. Check Premium and the Developer app's users.") |

Returning to Home polls at once unless a backoff is running, and at most once per second. Controls send `PUT /me/player/play` or `/pause` and `POST /me/player/next` or `/previous` with `?device_id=` of the active device and no body. A 403 with reason `PREMIUM_REQUIRED` shows "Spotify Premium is required for playback controls." and disables the buttons for the session; 404 shows that no device is active; restricted devices and `actions.disallows` disable the matching buttons without a request. `cleanframe:spotify` is sent only when the state changes; a pure progress update only when it drifts by two seconds, because the card extrapolates the bar itself. The cover nearest 300 px from `i.scdn.co` or `image-cdn-ak`/`image-cdn-fa.spotifycdn.com` is rewritten to `https://i.scdn.co/image/<id>`, preloaded with `new Image()` and shown only after it loaded; there is no pixel analysis, so the cover colour stays the host fallback.

### Network and diagnosis

Spotify traffic exists only while the Spotify package is installed and enabled; every URL is a constant in `tizen-spotify.js`. Every failed request (status 0: TLS, DNS, access policy) shows "Could not reach `<host>` (no connection, certificate or access policy)." and every timeout "`<host>` did not respond in time.", both translated, so a TLS failure on the TV names the hop. Root certificates seen from a PC (not verified on the TV): accounts.spotify.com Starfield Root G2 (via Certainly), api.spotify.com DigiCert Global Root G2, i.scdn.co DigiCert Global Root G3 (ECC), the relay GTS Root R4 (cross-signed by GlobalSign Root CA).

### Relay

`relay/spotify-worker/` is the owner's Cloudflare Worker `cleantv-spotify` with one SQLite-backed Durable Object per pairing (deleted by an alarm after ten minutes); see its README for routes, deployment with a pinned `npx wrangler` and curl tests. `npm run check:relay` tests it offline; it is not part of `check:device`.

### Privacy

- The TV stores the refresh token unencrypted in the app's own localStorage, in the same JavaScript context as the UI; Spotify text is rendered with `textContent`. A stolen refresh token allows reading and controlling playback until it is revoked at spotify.com/account/apps.
- The relay stores, per pairing and for at most ten minutes, the PKCE challenge, the TV's state, the hash of the poll secret and the one-time code (or Spotify's error). It never sees the verifier, the poll secret, a token or a client secret, so the code is useless to it. Workers Logs are disabled.
- The phone's browser history keeps the `/callback` address with the one-time code; without the verifier on the TV it cannot be redeemed, and the relay deletes it once the TV collected it.
- Tests use synthetic tokens and routed fakes only (`scripts/test-tizen-spotify.mjs` in `check:device`, the Tizen Spotify section of `check-browser.mjs`, the Spotify states of `check-legacy.mjs`).

## Native packages

The initial native package is `com.cleanframe.addon.appleremote`, interface 1, version 0.1.0. Catalog metadata must include API 2, native kind, exact package/version/code, minimum host, immutable release APK URL, SHA-256 and signing-certificate SHA-256. Download origins are restricted to the approved public repository and GitHub release-asset redirects. The host verifies the archive before creating an Android PackageInstaller session. Android owns confirmation; cancellation leaves the previous installation intact. Downloads are bounded and canceled when the owning manager closes. Pending committed operations are durable and reconciled with PackageManager after callbacks/resume.

Native status uses the small `IRemoteAddon.request` AIDL interface with an explicit interface version. Both endpoints verify package identity and the shared signer before binding or accepting host operations. The signed host owns the visible setup: `setupStatus`, activation, Philips pairing, iPhone pairing and device revocation. Ordinary `status` and ADB diagnostics remain redacted. `setupStatus` adds only the time-limited PIN, expiry and paired-device handles; keys and entered text never reach the WebView. Reading status cannot enable its receiver. Other developers can contribute native source/manifests for review; adding a new executable identity requires an explicit host allowlist update and a maintainer-signed release. Arbitrary APK URLs or self-signed third-party packages are not accepted.

Native services do not consume the three Home widget slots. The first receiver is experimental and omitted from the public catalog until the physical iPhone/TV acceptance gate passes. The protocol fork, source pins, build command and constraints are in [the add-on README](../addons/apple-remote/README.md).

## Editor

The Add-ons workspace keeps an `addonLab` simulation model separate from `tvSource`, normal preferences and design. Local installs, removal, activation and failures use a development-only adapter. Virtual commands operate the preview; simulated text is never sent to the TV or retained in the event log. Undo, snapshots, conflict detection and reload include this model, while a fresh TV import resets it. The package list, detail view and removal dialog are available in the normal visual editor.

TV diagnosis uses only fixed `dumpsys package` and `dumpsys activity service` commands over the existing configured ADB target. It does not start a missing service, install, enable, pair or send keys. Output contains bounded status/events, no pairing PIN, account credentials or entered text. Its polling runs only while the diagnosis workspace is visible.


## Unified setup and verified device scope

Spotify's PKCE exchange runs in `SpotifySignInSession`. The shared frontend renders the QR image, countdown, result and retry; it receives no verifier, refresh token or polling secret. Back, leaving CleanFrame and standby cancel the session. Existing account and player settings use the established storage paths.

The remote detail page opens the shared CleanFrame setup screen. It contains activation, TV and iPhone connection states, a two-minute pairing countdown, paired-device removal with confirmation, and links to Android's keyboard permission/selection dialogs. A small host-owned WebView displays the Philips code-entry sheet over the system pairing screen. The add-on app entry and notification return to CleanFrame. Android install/uninstall, keyboard and optional accessibility permission dialogs remain owned by Android. The optional Philips setup service reads only an actual visible OEM pairing message matching a fresh session marker, for up to 30 seconds; it never stores screen text or reads other apps. It completes the normal authenticated grant and retains existing credentials. Manual entry remains available. Confirmed first installation activates the remote receiver; updates preserve disabled state.

The Google remote listener rejects same-TV control before TLS on the reference firmware. The receiver therefore uses authenticated Philips JointSpace over pinned loopback TLS for navigation and Android's public media-key API for Play/Pause. Text input uses the user-selected CleanFrame input method; no system package or trust check is patched.

The owner confirmed iPhone pairing, reconnection, Home/YouTube navigation, volume, Play/Pause, and live Spotify input with umlauts, emoji, backward deletion, Return/Search and reopening the field in experimental build 18. Cross-app text changes, custom keyboards, arbitrary selection, Netflix, deep-sleep wake and the full reboot/uninstall matrix are not established. The remote release remains explicitly experimental. Private evidence and backups remain in ignored `.local/`.
