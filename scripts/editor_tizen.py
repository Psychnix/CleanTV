"""Samsung (Tizen) television for the editor.

Finds the TV from .local/device.json over sdb, reuses CleanTV's page inspector (cached forward plus a
/json check) and offers one explicit, announced step that restarts CleanTV in debug mode. The Chrome 47
inspector delivers no pixels, so Live is a mirror: a node helper evaluates one fixed, read-only
expression about once a second and the editor redraws that state. Nothing here installs, launches
outside that explicit restart, writes TV storage or reads credentials. See docs/editor.md, "Samsung".
"""
import copy
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
        raise ValueError('Der Fernseher hat den Debug-Start abgelehnt („closed“). CleanTV lief noch oder das Zeitlimit fehlte. Bitte erneut versuchen.')
    raise ValueError('Der Debug-Start wurde vom Fernseher nicht bestätigt. ' + output.strip()[:160])


def capture(state):
    """Draft import from one mirrored state: preferences, design, Home app records, add-ons, add-on photos."""
    from editor_server import PREF_KEYS
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
    return dict(platform='tizen', version=version, preferences={key: copy.deepcopy(committed[key]) for key in PREF_KEYS},
                design=copy.deepcopy(state['design']), apps=apps, addons=addons, wallpapers=wallpapers)


class TizenTelevision:
    platform = 'tizen'

    def __init__(self, store, config=None):
        self.store = store
        self._config = tizen_config() if config is None else config
        self.lock = threading.Lock()
        self.device_lock = threading.Lock()
        self.cached = None
        self.forwarded = None
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

    def forward(self):
        if self.forwarded is None and self._config and not self._config.get('error'):
            try:
                value = json.loads(self.cache_path().read_text())
            except (OSError, ValueError):
                value = None
            if (isinstance(value, dict) and value.get('target') == self._config['target']
                    and all(isinstance(value.get(k), int) and 0 < value[k] < 65536 for k in ['local', 'remote'])):
                self.forwarded = value
        return self.forwarded

    def listing(self, port):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:%d/json' % port, timeout=2) as response:
            return json.loads(response.read(1_000_000))

    def inspector(self):
        """The cached forward and CleanTV's page on it, or None when debug mode is off. Local HTTP only."""
        forward = self.forward()
        if not forward:
            return None
        try:
            targets = self.listing(forward['local'])
        except (OSError, ValueError):
            return None
        return dict(port=forward['local'], target=choose_target(targets))

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
                found = self.inspector()
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

    def restart_debug(self):
        """Explicit owner action: CleanTV restarts on the TV. Settings, add-ons and sign-ins stay."""
        from editor_server import atomic
        with self.device_lock:
            config = self.usable()
            target = config['target']
            self.mirror.pause()
            if not self.attach():
                raise ValueError(OFFLINE)
            self.sdb(['-s', target, 'shell', '0', 'kill', config['package_id']], timeout=30)
            # Only with the timeout argument, and only after the app stopped, does the TV open a debug port.
            # The kill can take a moment on the TV, so a "closed" reply is retried once.
            launch = ['-s', target, 'shell', '0', 'debug', config['app_id'], '300']
            try:
                remote = parse_debug_port(self.sdb(launch, timeout=60))
            except ValueError as error:
                if 'closed' not in str(error):
                    raise
                time.sleep(2)
                remote = parse_debug_port(self.sdb(launch, timeout=60))
            previous = self.forward()
            if previous:
                try:
                    self.sdb(['-s', target, 'forward', '--remove', 'tcp:%d' % previous['local']])
                except ValueError:
                    pass
            local = self.free_port()
            self.sdb(['-s', target, 'forward', 'tcp:%d' % local, 'tcp:%d' % remote])
            self.forwarded = dict(target=target, local=local, remote=remote)
            atomic(self.cache_path(), self.forwarded)
            deadline = time.monotonic() + 20
            while True:
                found = self.inspector()
                if found and found['target']:
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
            result = subprocess.run(['node', str(HELPER), str(found['port']), '--once'], capture_output=True, timeout=30,
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
                    self.follow(found['port'])
                except OSError as error:
                    self.update(phase='error', message='Der Lesehelfer (Node.js) konnte nicht starten: ' + str(error)[:160])
                if not self.stop_event.is_set() and not self.idle():
                    self.stop_event.wait(2)
        finally:
            with self.condition:
                if self.phase not in ['unconfigured']:
                    self.phase = 'stopped'
                self.worker = None
                self.condition.notify_all()

    def follow(self, port):
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
