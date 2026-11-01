"""Samsung (Tizen) television for the editor.

Finds the TV from .local/device.json over sdb, reuses CleanTV's page inspector (cached forward plus a
/json check) and offers one explicit, announced step that restarts CleanTV in debug mode. The Chrome 47
inspector delivers no pixels, so Live is a mirror: a node helper evaluates one fixed, read-only
expression about once a second and the editor redraws that state. Nothing here installs, launches
outside that explicit restart, writes TV storage or reads credentials. See docs/editor.md, "Samsung".
"""
from contextlib import contextmanager
import copy
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
import urllib.request

from local_config import load_settings

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts/editor-tizen-cdp.mjs'
EXPRESSION_PATH = ROOT / 'scripts/editor-tizen-mirror.js'
PAGE_URL = 'file:///index.html'
SOCKET_PATH = re.compile(r'^ws://[^/?#]+(/devtools/page/[A-Za-z0-9._-]{1,128})$')
ADDON_FIELDS = ['id', 'name', 'kind', 'version', 'enabled', 'text', 'timeZone']
WALL_FIELDS = ['id', 'name', 'rev', 'tone', 'ut', 'frostVeil', 'listColumn', 'dockQuiet', 'clockMist']
RELEASE = 'Für Samsung bereitet der Editor keine Übertragung vor. Installation: npm run package und npm run tv:install (docs/development.md).'
OFFLINE = 'TV nicht erreichbar. Ist der Fernseher eingeschaltet und im selben Netz?'
DEBUG_OFF = 'Debug-Modus aus. Für den Live-Spiegel „CleanTV im Debug-Modus neu starten“ wählen.'
# The kill can take a moment on the TV; a "closed" reply means CleanTV had not fully stopped yet.
DEBUG_ATTEMPTS = 5
DEBUG_RETRY_DELAY = 1.5


class DebugRefused(ValueError):
    """The TV answered `closed`: CleanTV was not fully stopped or the timeout argument was missing."""


def tizen_config(root=ROOT):
    """Address from .local/device.json, sdb and app identity from the signing settings; no device I/O."""
    path = Path(root) / '.local/device.json'
    if not path.exists():
        return None
    try:
        host = json.loads(path.read_text(encoding='utf-8')).get('host')
        host = str(ipaddress.IPv4Address(host))
    except (ValueError, TypeError, AttributeError, OSError, ipaddress.AddressValueError):
        return dict(error='In .local/device.json fehlt eine gültige IPv4-Adresse des Fernsehers.')
    try:
        settings = load_settings(Path(root))
    except (ValueError, OSError) as error:
        return dict(error='Die Tizen-Einstellungen sind nicht lesbar: ' + str(error)[:200])
    sdb = settings['sdk_path'] / ('tools/sdb.exe' if os.name == 'nt' else 'tools/sdb')
    identity = settings['identity']
    return dict(sdb=[str(sdb)], host=host, target=host + ':26101', app_id=identity['app_id'],
                package_id=identity['package_id'], label='Samsung-Fernseher')


def detect_platform(storage, root=ROOT):
    """An ADB tv.json keeps the Android integration; otherwise a device.json selects Samsung."""
    if (Path(storage) / 'tv.json').exists():
        return 'android'
    return 'tizen' if (Path(root) / '.local/device.json').exists() else 'android'


def choose_target(targets):
    """CleanTV's page in an inspector listing. ws is only the socket path, or None while attached."""
    if not isinstance(targets, list):
        return None
    for item in targets:
        if isinstance(item, dict) and item.get('type') == 'page' and item.get('url') == PAGE_URL:
            match = SOCKET_PATH.match(str(item.get('webSocketDebuggerUrl') or ''))
            return dict(id=str(item.get('id', ''))[:128], title=str(item.get('title', ''))[:80], url=PAGE_URL,
                        ws=match.group(1) if match and '..' not in match.group(1) else None)
    return None


def parse_debug_port(output):
    """Port from `sdb shell 0 debug <app> 300`. Without the timeout, or while running, the TV says closed."""
    output = output or ''
    match = re.search(r'successfully launched pid\s*=\s*\d+\s+with debug\s+\d+\s+port:\s*(\d{1,5})\b', output)
    if match and 0 < int(match.group(1)) < 65536:
        return int(match.group(1))
    if 'closed' in output.lower():
        raise DebugRefused('Der Fernseher hat den Debug-Start abgelehnt („closed“). CleanTV war noch nicht ganz beendet oder das Zeitlimit fehlte.')
    raise ValueError('Der Debug-Start wurde vom Fernseher nicht bestätigt. ' + output.strip()[:160])


def capture(state):
    """Draft import from one mirrored state: preferences, design, Home app records, add-ons, add-on photos."""
    from editor_server import PREF_KEYS, OPTIONAL_PREF_KEYS
    if not isinstance(state, dict) or state.get('ready') is not True:
        raise ValueError('CleanTV ist am Fernseher noch nicht bereit. Bitte kurz warten und erneut versuchen.')
    view = state.get('state') if isinstance(state.get('state'), dict) else {}
    committed = view.get('committed') if isinstance(view.get('committed'), dict) else {}
    missing = [key for key in PREF_KEYS if key not in committed]
    if missing:
        raise ValueError('Der TV-Stand ist unvollständig: ' + ', '.join(missing))
    version = (state.get('app') or {}).get('version')
    if not isinstance(version, str) or not version or not isinstance(state.get('design'), dict):
        raise ValueError('Version oder Design von CleanTV konnten nicht gelesen werden.')
    apps = []
    for record in (view.get('appRecords') or [])[:256]:
        if isinstance(record, dict) and isinstance(record.get('appId'), str) and isinstance(record.get('name'), str):
            brand = record.get('brand') if isinstance(record.get('brand'), str) and re.fullmatch(r'[a-z0-9]{0,24}', record.get('brand')) else ''
            apps.append(dict(id=str(record.get('id') or record['appId']), appId=record['appId'], name=record['name'][:240], brand=brand))
    installed = (state.get('addons') or {}).get('installed') or {}
    addons = [{key: item[key] for key in ADDON_FIELDS if key in item} for item in installed.values() if isinstance(item, dict)][:100]
    entries = ((state.get('walls') or {}).get('entries') or [])[:200]
    wallpapers = [{key: entry[key] for key in WALL_FIELDS if key in entry} for entry in entries if isinstance(entry, dict) and not entry.get('gone')]
    preferences = {key: copy.deepcopy(committed[key]) for key in PREF_KEYS}
    for key in OPTIONAL_PREF_KEYS:
        if key in committed:
            preferences[key] = copy.deepcopy(committed[key])
    return dict(platform='tizen', version=version, preferences=preferences,
                design=copy.deepcopy(state['design']), apps=apps, addons=addons, wallpapers=wallpapers)


class TizenTelevision:
    platform = 'tizen'

    def __init__(self, store, config=None):
        self.store = store
        self._config = tizen_config() if config is None else config
        self.lock = threading.Lock()
        # Re-entrant: restart_debug holds it and calls inspector()/tunnel(), which take it again.
        self.device_lock = threading.RLock()
        self.cached = None
        # Local ports with a live sdb forward. A forward exists only while a reader runs inside tunnel().
        self.open_forwards = set()
        self.mirror = TizenMirror(self)

    def config(self):
        return self._config

    def usable(self):
        config = self._config
        if not config:
            raise ValueError('Kein Samsung-Fernseher eingerichtet. Bitte die TV-Adresse in .local/device.json eintragen.')
        if config.get('error'):
            raise ValueError(config['error'])
        if not Path(config['sdb'][0]).is_file():
            raise ValueError('Das Samsung-Werkzeug sdb fehlt. Bitte Tizen Studio einrichten (docs/development.md).')
        return config

    def sdb(self, args, timeout=15):
        # Fixed argument lists only: the browser never supplies a host, command or path.
        config = self.usable()
        try:
            result = subprocess.run([*config['sdb'], *args], capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise ValueError('sdb antwortet nicht rechtzeitig.') from None
        output = (result.stdout + result.stderr).decode('utf-8', errors='replace')
        if result.returncode:
            raise ValueError(output.strip()[:300] or 'sdb antwortet nicht.')
        return output

    def listed(self):
        target = self.usable()['target']
        return any(line.split()[:2] == [target, 'device'] for line in self.sdb(['devices']).splitlines())

    def attach(self):
        if self.listed():
            return True
        try:
            self.sdb(['connect', self.usable()['target']], timeout=20)
        except ValueError:
            pass
        return self.listed()

    def cache_path(self):
        return self.store.path / 'tizen-inspector.json'

    def remote(self):
        """The remembered remote debug port on the TV, or None. Only the remote port is cached; a first
        build also stored a persistent local port, which is removed once and then dropped for good."""
        with self.device_lock:
            if not self._config or self._config.get('error'):
                return None
            try:
                value = json.loads(self.cache_path().read_text())
            except (OSError, ValueError):
                return None
            if not (isinstance(value, dict) and value.get('target') == self._config['target']
                    and isinstance(value.get('remote'), int) and 0 < value['remote'] < 65536):
                return None
            if isinstance(value.get('local'), int):
                try:
                    self.sdb(['-s', self._config['target'], 'forward', '--remove', 'tcp:%d' % value['local']])
                except ValueError:
                    pass
                self.remember_remote(value['remote'])  # rewrite without the stale local port
            return value['remote']

    def remember_remote(self, remote):
        from editor_server import atomic
        with self.device_lock:
            atomic(self.cache_path(), dict(target=self.usable()['target'], remote=int(remote)))

    def forget_remote(self):
        with self.device_lock:
            try:
                self.cache_path().unlink()
            except OSError:
                pass

    @contextmanager
    def tunnel(self):
        """A short-lived sdb forward to the TV's debug port, open only while a reader runs inside it and
        always removed afterwards. sdb binds it on all network interfaces, not loopback-only."""
        target = self.usable()['target']
        remote = self.remote()
        if remote is None:
            raise ValueError(DEBUG_OFF)
        with self.device_lock:
            local = None
            for attempt in range(3):
                candidate = self.free_port()
                try:
                    self.sdb(['-s', target, 'forward', 'tcp:%d' % candidate, 'tcp:%d' % remote])
                    local = candidate
                    break
                except ValueError as error:
                    if 'bind' not in str(error).lower() or attempt == 2:
                        raise
            self.open_forwards.add(local)
        try:
            yield local
        finally:
            with self.device_lock:
                try:
                    self.sdb(['-s', target, 'forward', '--remove', 'tcp:%d' % local])
                except ValueError:
                    pass
                self.open_forwards.discard(local)

    def listing(self, port):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:%d/json' % port, timeout=2) as response:
            return json.loads(response.read(1_000_000))

    def inspector(self, forget=False):
        """CleanTV's page over a short-lived forward, or None when debug mode is off. Local HTTP only.
        A failed forward keeps the remote (host/transport issue); a dead debug port is forgotten when
        forget is set, so a later status offers the explicit restart again."""
        if self.remote() is None:
            return None
        try:
            with self.tunnel() as port:
                try:
                    targets = self.listing(port)
                except (OSError, http.client.HTTPException, ValueError):
                    if forget:
                        self.forget_remote()
                    return None
        except ValueError:
            return None
        return dict(target=choose_target(targets))

    def status(self):
        with self.lock:
            if self.cached and time.time() - self.cached['checkedAt'] < 10:
                return self.decorate(self.cached.copy())
            result = dict(platform='tizen', configured=False, connected=False, debug=False, cleantv=False,
                          state='unconfigured', checkedAt=time.time(), label='Samsung-Fernseher')
            try:
                config = self.usable()
                result.update(configured=True, label=config['label'], address=config['target'], state='offline')
                if not self.attach():
                    raise ValueError(OFFLINE)
                result.update(connected=True, state='connected', message='TV verbunden · ' + DEBUG_OFF)
                found = self.inspector(forget=True)
                if found:
                    result.update(debug=True, state='debug', message='TV verbunden · Debug-Modus an · CleanTV-Seite nicht gefunden. Bitte CleanTV am Fernseher öffnen.')
                if found and found['target']:
                    result.update(cleantv=True, state='ready', message='TV verbunden · Debug-Modus an · CleanTV bereit')
            except (ValueError, OSError) as error:
                result['message'] = OFFLINE if result['state'] == 'offline' else str(error)
            self.cached = result
            return self.decorate(result.copy())

    def decorate(self, result):
        result = self.with_release(result)
        version = self.mirror.version()
        if version:
            result['version'] = version
        return result

    def with_release(self, result):
        result.update(ready=False, releaseState='unsupported', releaseMessage=RELEASE)
        return result

    def connect(self):
        with self.device_lock:
            config = self.usable()
            try:
                self.sdb(['connect', config['target']], timeout=20)
            except ValueError:
                pass
        with self.lock:
            self.cached = None
        return self.status()

    def free_port(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            return probe.getsockname()[1]

    def relaunch_plain(self):
        """Bring CleanTV back with a normal launch after a failed debug start, so the TV is never dark."""
        config = self.usable()
        self.sdb(['-s', config['target'], 'shell', '0', 'execute', config['app_id']], timeout=45)

    def after_failed_debug(self, prefix):
        """Recover CleanTV after the kill, then describe what happened. Returns the error to raise."""
        try:
            self.relaunch_plain()
        except ValueError:
            return ValueError(prefix + ' CleanTV ließ sich auch nicht normal starten. Bitte CleanTV am Fernseher mit der Fernbedienung öffnen.')
        return ValueError(prefix + ' CleanTV wurde normal wieder gestartet. Bitte das Bild am Fernseher prüfen und erneut versuchen.')

    def restart_debug(self):
        """Explicit owner action: CleanTV restarts on the TV. Settings, add-ons and sign-ins stay."""
        with self.device_lock:
            config = self.usable()
            target = config['target']
            self.mirror.pause()
            if not self.attach():
                raise ValueError(OFFLINE)
            self.sdb(['-s', target, 'shell', '0', 'kill', config['package_id']], timeout=30)
            # Only with the timeout argument, and only after the app stopped, does the TV open a debug port.
            # A "closed" reply means CleanTV had not fully stopped yet, so it is retried a few times.
            # Any failure after the kill must still bring CleanTV back, so it is never left dark.
            launch = ['-s', target, 'shell', '0', 'debug', config['app_id'], '300']
            remote = None
            for attempt in range(DEBUG_ATTEMPTS):
                try:
                    remote = parse_debug_port(self.sdb(launch, timeout=60))
                    break
                except DebugRefused:
                    if attempt + 1 < DEBUG_ATTEMPTS:
                        time.sleep(DEBUG_RETRY_DELAY)
                        continue
                    raise self.after_failed_debug('Der Fernseher hat den Debug-Start mehrfach abgelehnt.')
                except ValueError:
                    raise self.after_failed_debug('Der Debug-Start ist fehlgeschlagen.')
            self.remember_remote(remote)
            # Poll /json inside one short-lived forward until CleanTV's page reports in.
            deadline = time.monotonic() + 20
            with self.tunnel() as port:
                while True:
                    try:
                        found = choose_target(self.listing(port))
                    except (OSError, http.client.HTTPException, ValueError):
                        found = None
                    if found:
                        break
                    if time.monotonic() > deadline:
                        raise ValueError('CleanTV wurde im Debug-Modus gestartet, aber die Seite meldet sich nicht. Bitte erneut versuchen.')
                    time.sleep(.5)
        with self.lock:
            self.cached = None
        return self.status()

    def read_once(self):
        found = self.inspector()
        if not found:
            raise ValueError('CleanTV ist nicht im Debug-Modus. Bitte zuerst „CleanTV im Debug-Modus neu starten“ wählen.')
        if not found['target']:
            raise ValueError('CleanTV wurde im TV-Inspektor nicht gefunden. Bitte CleanTV am Fernseher öffnen.')
        try:
            with self.tunnel() as port:
                result = subprocess.run(['node', str(HELPER), str(port), '--once'], capture_output=True, timeout=30,
                                        cwd=ROOT, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise ValueError('Der TV-Stand konnte nicht rechtzeitig gelesen werden.') from None
        message = 'Der TV-Stand konnte nicht gelesen werden.'
        for line in result.stdout.decode('utf-8', errors='replace').splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if item.get('type') == 'state' and isinstance(item.get('state'), dict):
                return item['state']
            if item.get('type') == 'error':
                message = str(item.get('message', message))[:300]
        raise ValueError(message)

    def read_draft(self):
        # The page inspector serves one client: a running mirror is reused instead of a second read.
        state = self.mirror.fresh(3)
        if state is None and self.mirror.running():
            state = self.mirror.wait_fresh(5)
        return capture(state if state is not None else self.read_once())

    def screenshot(self):
        raise ValueError('Samsung-Fernseher liefern über den Debug-Kanal kein Bild. Live zeigt den nachgezeichneten Spiegel.')

    def addon_diagnostics(self):
        return dict(package=None, checkedAt=time.time(), installed=False, status=None,
                    message='Die TV-Diagnose gibt es nur für das Android-Add-on.')


class TizenMirror:
    """One shared reader per editor process. It runs while a visible editor tab polls, then stops."""
    IDLE = 6.0

    def __init__(self, tv):
        self.tv = tv
        self.condition = threading.Condition()
        self.stop_event = threading.Event()
        self.worker = None
        self.process = None
        self.closed = False
        self.state = None
        self.seq = 0
        self.phase = 'stopped'
        self.message = ''
        self.touched = 0.0
        self.ticked = None
        try:
            self.local_version = json.loads((ROOT / 'package.json').read_text())['version']
        except (OSError, ValueError, KeyError):
            self.local_version = ''

    def frames(self, profile='native'):
        raise ValueError('Samsung-Fernseher liefern kein Videobild. Live zeigt den nachgezeichneten Spiegel.')
        yield b''  # pragma: no cover - keeps this a generator like LiveVideo.frames

    def running(self):
        return bool(self.worker and self.worker.is_alive())

    def version(self):
        with self.condition:
            if self.phase != 'live':
                return None
            app = (self.state or {}).get('app') or {}
            return app.get('version') if isinstance(app.get('version'), str) else None

    def status(self):
        with self.condition:
            return dict(state=self.phase, viewers=1 if self.running() else 0, frames=self.seq, fps=0, resolution=[1920, 1080],
                        profile='mirror', error=self.message if self.phase == 'error' else None,
                        age=round(time.monotonic() - self.ticked, 2) if self.ticked else None)

    def read(self, since, wait=2.5):
        """Long poll: returns at once on news, otherwise after `wait`. The state is sent only when new."""
        with self.condition:
            self.touched = time.monotonic()
            self.ensure()
            phase = self.phase
            # News is a new state or a new phase; a sequence number without any state is not.
            self.condition.wait_for(lambda: self.seq != since and self.state is not None or self.phase != phase or self.closed, timeout=wait)
            self.touched = time.monotonic()
            result = dict(seq=self.seq, phase=self.phase, message=self.message, localVersion=self.local_version,
                          age=round(time.monotonic() - self.ticked, 2) if self.ticked else None)
            if self.seq != since and self.state is not None:
                result['state'] = copy.deepcopy(self.state)
            return result

    def fresh(self, max_age):
        with self.condition:
            if self.state is not None and self.phase == 'live' and self.ticked and time.monotonic() - self.ticked <= max_age:
                return copy.deepcopy(self.state)
            return None

    def wait_fresh(self, timeout):
        deadline = time.monotonic() + timeout
        with self.condition:
            self.touched = time.monotonic()
            self.condition.wait_for(lambda: self.phase == 'live' and self.ticked and time.monotonic() - self.ticked < 3 or time.monotonic() > deadline, timeout=timeout)
        return self.fresh(3)

    def ensure(self):
        if self.closed or self.running():
            return
        self.stop_event.clear()
        self.phase, self.message = 'starting', ''
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def idle(self):
        return time.monotonic() - self.touched > self.IDLE

    def update(self, **values):
        with self.condition:
            for key, value in values.items():
                setattr(self, key, value)
            self.condition.notify_all()

    def run(self):
        try:
            while not self.stop_event.is_set() and not self.idle():
                try:
                    found = self.tv.inspector()
                except (ValueError, OSError):
                    found = None
                if not found or not found.get('target'):
                    config = self.tv.config()
                    if not config or config.get('error'):
                        self.update(phase='unconfigured', message=(config or {}).get('error') or 'Kein Samsung-Fernseher eingerichtet.')
                    else:
                        self.update(phase='debug-off', message=DEBUG_OFF)
                    self.stop_event.wait(2)
                    continue
                self.update(phase='connecting', message='')
                try:
                    self.follow()
                except OSError as error:
                    self.update(phase='error', message='Der Lesehelfer (Node.js) konnte nicht starten: ' + str(error)[:160])
                except ValueError:
                    # A lost sdb forward (Wi-Fi blip, sdb restart): re-create it next loop, never restart CleanTV.
                    pass
                if not self.stop_event.is_set() and not self.idle():
                    self.stop_event.wait(2)
        finally:
            with self.condition:
                if self.phase not in ['unconfigured']:
                    self.phase = 'stopped'
                # Drop the mirrored TV values (title, place, device name); the sequence keeps counting.
                self.state = None
                self.ticked = None
                self.worker = None
                self.condition.notify_all()

    def follow(self):
        # The forward lives only for this reader; it is removed the moment the helper stops.
        with self.tv.tunnel() as port:
            self.follow_on(port)

    def follow_on(self, port):
        process = subprocess.Popen(['node', str(HELPER), str(port)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, cwd=ROOT)
        with self.condition:
            self.process = process
        try:
            for line in process.stdout:
                if self.stop_event.is_set() or self.idle():
                    break
                if len(line) > 2_000_000:
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                with self.condition:
                    if item.get('type') == 'state' and isinstance(item.get('state'), dict):
                        if item['state'] != self.state:
                            self.state = item['state']
                            self.seq += 1
                        self.phase, self.message, self.ticked = 'live', '', time.monotonic()
                    elif item.get('type') == 'tick':
                        self.ticked = time.monotonic()
                        if self.state is not None:
                            self.phase = 'live'
                    elif item.get('type') == 'error':
                        self.phase, self.message = 'error', str(item.get('message', ''))[:300]
                    self.condition.notify_all()
        finally:
            self.end(process)

    def end(self, process):
        try:
            process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdout.close()
        with self.condition:
            if self.process is process:
                self.process = None
            if self.phase == 'live':
                self.phase = 'connecting'
            self.condition.notify_all()

    def pause(self):
        """Ends the current inspector session (before a debug restart); a polling tab reconnects."""
        with self.condition:
            process = self.process
        if process and process.poll() is None:
            process.terminate()

    def close(self):
        self.closed = True
        self.stop_event.set()
        self.pause()
        with self.condition:
            self.condition.notify_all()
        worker = self.worker
        if worker and worker is not threading.current_thread():
            worker.join(timeout=8)
        # A clean reader removes its own forward; this clears anything a crashed reader left listening.
        target = (self.tv.config() or {}).get('target')
        for local in list(self.tv.open_forwards):
            if target:
                try:
                    self.tv.sdb(['-s', target, 'forward', '--remove', 'tcp:%d' % local])
                except ValueError:
                    pass
            self.tv.open_forwards.discard(local)
        with self.condition:
            # Nothing stale is served after Live closes (#2).
            self.state = None
            self.ticked = None
