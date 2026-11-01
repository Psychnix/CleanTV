# CleanTV Spotify relay (Cloudflare Worker)

The Samsung TV signs in to Spotify with Authorization Code + PKCE. The phone cannot hand the authorization code back to a TV app, so this small Worker carries it once:

1. The TV posts `{challenge, state, pollHash}` to `POST /pair` and gets `{id, expiresIn}`. `pollHash` is the SHA-256 hex of a random secret that stays on the TV; the PKCE verifier also stays on the TV.
2. The TV shows a QR code for `https://cleantv-spotify.tobiaspsi96.workers.dev/start/<id>` and, next to it, the first six characters of the ID as "Code am Handy" ("Code on your phone"). `GET /start/<id>` redirects the phone (302) to `https://accounts.spotify.com/authorize` with `response_type=code`, the client ID, the redirect URI, `code_challenge_method=S256`, the challenge, the two scopes, `state=<id>.<tvState>` and `show_dialog=true`, so Spotify shows its consent screen even to an account that approved the app before.
3. Spotify redirects to `GET /callback?code&state` (or `error&state`). The Worker stores the result once. For a code it shows a German page with the same six characters ("Steht dieser Code gerade auf deinem Fernseher? Nur dann weiter.") and a plain link to `/confirm/<id>/<nonce>`; the nonce is random per callback and appears only on that page. Reloading the page with the same code shows the same link; another code gets "bereits verwendet". An error (`access_denied`) shows "Anmeldung abgebrochen" and needs no confirmation.
4. Opening the link (`GET /confirm/<id>/<nonce>`; `HEAD` and other methods get 405) marks the code as confirmed and shows "Verbunden". A wrong nonce shows "ungültig" and releases nothing; a second confirmation changes nothing.
5. The TV polls `POST /poll/<id>` with `{secret}` every 2 s. The Worker compares `sha256(secret)` with `pollHash` in constant time and returns `{code, state}` (or `{error}`) exactly once, then deletes the record. Before the callback, and for a code before the confirmation, it answers `{pending: true}`; unknown or expired IDs get 404, a wrong secret 403.
6. The TV checks the state and redeems the code at `accounts.spotify.com/api/token` with its verifier. The Worker never sees the verifier, a token or a client secret, so a code at the relay or in the phone's history is useless without the verifier. The relay releases it only to the poll secret of the pairing it belongs to, after the phone confirmed the TV's code.

Why the confirmation: anyone can create a pairing and send its `/start` link, or an `accounts.spotify.com/authorize` link with the same `state` and without `show_dialog`, to someone else. For an account that approved the app before, Spotify may then redirect to `/callback` without a consent screen, and without the confirmation the pairing's creator would receive a code it can redeem with its own verifier: a refresh token that reads and controls the victim's playback. The phone page names the code that belongs to the link; on a link someone else sent, it does not match the TV (which usually shows no code at all). Remaining risk: a victim who follows a phishing message that also quotes the code and taps the link anyway. A stronger option, if ever needed: the phone page shows a random code that the user types on the TV, and `/poll` requires it, at the cost of entering it with the remote.

Each pairing is one SQLite-backed Durable Object (`idFromName(id)`), deleted by an alarm ten minutes after creation and refused after that even if the alarm runs late. Workers KV is not used: it caches a missing key at the edge for up to 60 s, so a poll before the callback could hide the code.

API routes accept JSON sent as `text/plain` (the TV avoids a CORS preflight) or `application/json`, answer `OPTIONS` preflights and send `Access-Control-Allow-Origin: *`. Bodies are limited to 1024 bytes and every field is validated. Pages load nothing external and carry a strict Content-Security-Policy (no script, one hashed inline style), `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The Worker logs nothing; `wrangler.toml` keeps Workers Logs off because request logs would contain `/callback` URLs.

`CLIENT_ID` and `REDIRECT_URI` are public `[vars]` in `wrangler.toml`. There is no client secret, and none may be added.

## Deploy (main agent or owner, from this folder)

Requires Node.js (for `npx`) and the owner's Cloudflare account. No `npm install` is needed: the Worker has no dependencies.

```sh
cd relay/spotify-worker
npx wrangler@4.151.1 login          # opens the browser; sign in to the owner's Cloudflare account
npx wrangler@4.151.1 deploy         # creates cleantv-spotify, the Durable Object class and migration v1
```

The account's workers.dev subdomain must be `tobiaspsi96`, so the Worker answers at `https://cleantv-spotify.tobiaspsi96.workers.dev`. If Cloudflare shows another subdomain, stop: the TV (`app/tizen-spotify.js`, `app/config.xml`) and the Spotify Developer app expect exactly this address.

In the Spotify Developer Dashboard (owner), the app with client ID `6058b47c8aab44dd87826487377bdf6c` needs the redirect URI `https://cleantv-spotify.tobiaspsi96.workers.dev/callback` exactly, Web API enabled, and the owner's account under Settings → User Management.

Do not run `wrangler tail` while signing in: it would show `/callback` URLs, which contain the one-time code.

## Test

Offline, from the repository root: `npm run check:relay` (node:test with an in-memory Durable Object, see `test.mjs`).

After deploying, with curl (no Spotify account needed until step 4):

```sh
W=https://cleantv-spotify.tobiaspsi96.workers.dev
# 1. Preflight and pairing (synthetic values; the hash belongs to the secret below).
curl -si -X OPTIONS "$W/pair" -H 'Origin: null' -H 'Access-Control-Request-Method: POST' | head -n 8
SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
HASH=$(printf %s "$SECRET" | sha256sum | cut -d' ' -f1)
curl -s "$W/pair" -H 'Content-Type: text/plain' \
  -d "{\"challenge\":\"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM\",\"state\":\"AAAAAAAAAAAAAAAAAAAAAA\",\"pollHash\":\"$HASH\"}"
# -> {"id":"<32 hex>","expiresIn":600}
ID=<id from above>
# 2. Pending, wrong secret, start redirect.
curl -s "$W/poll/$ID" -H 'Content-Type: text/plain' -d "{\"secret\":\"$SECRET\"}"          # {"pending":true}
curl -s -o /dev/null -w '%{http_code}\n' "$W/poll/$ID" -H 'Content-Type: text/plain' -d '{"secret":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}'   # 403
curl -si "$W/start/$ID" | grep -i '^location'      # https://accounts.spotify.com/authorize?...&state=<ID>.AAAA...&show_dialog=true
# 3. A synthetic callback, still pending until the confirmation, then exactly one delivery.
curl -s "$W/callback?code=test-code&state=$ID.AAAAAAAAAAAAAAAAAAAAAA" | grep -o '/confirm/[a-f0-9]*/[a-f0-9]*'   # /confirm/<ID>/<nonce>
CONFIRM=<path from above>
curl -s "$W/poll/$ID" -H 'Content-Type: text/plain' -d "{\"secret\":\"$SECRET\"}"          # {"pending":true}
curl -s -o /dev/null -w '%{http_code}\n' -I "$W$CONFIRM"   # 405: HEAD never confirms
curl -s -o /dev/null -w '%{http_code}\n' "$W$CONFIRM"      # 200 (Verbunden)
curl -s "$W/poll/$ID" -H 'Content-Type: text/plain' -d "{\"secret\":\"$SECRET\"}"          # {"code":"test-code","state":"<ID>.AAAA..."}
curl -s -o /dev/null -w '%{http_code}\n' "$W/poll/$ID" -H 'Content-Type: text/plain' -d "{\"secret\":\"$SECRET\"}"   # 404
# 4. End to end: on the TV, Settings → Add-ons → Spotify → Settings → Sign in with QR.
```

## Privacy notes

- Stored per pairing, for at most ten minutes: the PKCE challenge, the TV's random state, the SHA-256 of the poll secret and, after sign-in, the authorization code (or Spotify's error) with the confirmation nonce and whether the phone confirmed it. The record is deleted when the TV collects it or the alarm fires.
- Never stored or seen: the PKCE verifier, the poll secret, access or refresh tokens, Spotify credentials, a client secret.
- Cloudflare still processes request metadata (IP address, user agent) as the hosting provider. Workers Logs stay disabled.
- A stored code is useless without the verifier, which only the pairing's creator holds, and it is released only after the phone confirmed the code shown on the TV (see "Why the confirmation" above).
- Anyone can create pairings; each costs one short-lived Durable Object. If abuse appears, add a Cloudflare rate-limiting rule for `/pair`.
