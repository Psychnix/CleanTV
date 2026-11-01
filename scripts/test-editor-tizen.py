"""Samsung (Tizen) editor backend with a fake sdb and a fake Chrome 47 inspector. No TV access."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import urllib.request

from editor_server import Store, Editor, ROOT, PREF_KEYS
from preview import PreviewServer
import editor_tizen
from editor_tizen import (TizenTelevision, capture, choose_target, detect_platform, parse_debug_port,
                          tizen_config, EXPRESSION_PATH, HELPER)

STATE = json.loads((ROOT / 'scripts/fixtures/tizen-mirror-state.json').read_text(encoding='utf-8'))
TARGET = '192.0.2.10:26101'  # TEST-NET address, never a real TV
CONFIG = dict(host='192.0.2.10', target=TARGET, app_id='TestPkg001.CleanTV', package_id='TestPkg001', label='Samsung-Fernseher')
# Plays the sdb commands the editor may use; every call is logged for the assertions.
FAKE_SDB = r'''
import json, sys
state_path = sys.argv[1]
args = sys.argv[2:]
state = json.load(open(state_path, encoding='utf-8'))
with open(state['log'], 'a', encoding='utf-8') as log: log.write(json.dumps(args) + '\n')
target = state['target']
def save(): json.dump(state, open(state_path, 'w', encoding='utf-8'))
def out(text, code=0):
    sys.stdout.write(text); sys.stdout.flush(); sys.exit(code)
if args == ['devices']:
    out('List of devices attached \n' + (target + '          device          TestModel\n' if state.get('connected') else ''))
if args[:1] == ['connect'] and args[1:] == [target]:
    if state.get('reachable'):
        state['connected'] = True; save(); out('connecting to %s ...\nconnected to %s\n' % (target, target))
    out('connecting to %s ...\nfailed to connect to %s\n' % (target, target))
if args[:2] == ['-s', target] and args[2:4] == ['shell', '0'] and args[4:5] == ['execute']:
    if state.get('execute_fails'): out('error: launch failed\n', 1)
    out('... successfully launched pid = 8740\n')
if args[:2] == ['-s', target] and args[2:5] == ['shell', '0', 'kill']:
    if state.get('kill_stops', True): state['running'] = False; save()
    out('Pkgid: %s is Terminated\n' % args[5])
if args[:2] == ['-s', target] and args[2:5] == ['shell', '0', 'debug']:
    if state.get('debug_refuses') or state.get('running') or len(args) < 7: out(state.get('debug_reply', 'closed') + '\n')
    state['running'] = True; save()
    out('... successfully launched pid = 8732 with debug 1 port: %d\n' % state.get('remote', 48283))
if args[:2] == ['-s', target] and args[2] == 'forward':
    if args[3:4] == ['--remove']:
        state.setdefault('removes', []).append(args[4:]); save(); out('')
    if state.get('bind_fails'):
        out('error: cannot bind to port %s\n' % args[3], 1)
    state.setdefault('forwards', []).append(args[3:]); save(); out('')
out('error: unknown command\n', 1)
'''


class FakeInspector:
    """Chrome 47 style /json listing plus a minimal WebSocket CDP endpoint."""
    def __init__(self, values, targets=None):
        self.values, self.expressions, self.methods = list(values), [], []
        self.connected, self.closed, self.lock = threading.Event(), threading.Event(), threading.Lock()
        inspector = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_GET(self):
                if self.path in ['/json', '/json/list']:
                    raw = json.dumps(inspector.targets).encode()
                    self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw); return
                if self.path == '/devtools/page/page1' and self.headers.get('Upgrade', '').lower() == 'websocket':
                    accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                    self.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n').encode()); self.wfile.flush()
                    inspector.connected.set()
                    try:
                        inspector.serve(self.rfile, self.wfile)
                    finally:
                        inspector.closed.set(); self.close_connection = True
                    return
                self.send_error(404)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_port
        self.targets = targets if targets is not None else [
            dict(description='', devtoolsFrontendUrl='/devtools/inspector.html?ws=127.0.0.1:%d/devtools/page/page1' % self.port, id='page1',
                 title='CleanTV', type='page', url='file:///index.html', webSocketDebuggerUrl='ws://127.0.0.1:%d/devtools/page/page1' % self.port)]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def serve(self, reader, writer):
        while True:
            head = reader.read(2)
            if len(head) < 2:
                return
            opcode, length = head[0] & 15, head[1] & 127
            if length == 126: length = struct.unpack('>H', reader.read(2))[0]
            elif length == 127: length = struct.unpack('>Q', reader.read(8))[0]
            mask = reader.read(4) if head[1] & 128 else b'\0\0\0\0'
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(reader.read(length)))
            if opcode == 8:
                return
            if opcode != 1:
                continue
            message = json.loads(payload)
            with self.lock:
                self.methods.append(message['method'])
                if message['method'] == 'Runtime.evaluate':
                    self.expressions.append(message['params']['expression'])
                    value = self.values.pop(0) if len(self.values) > 1 else self.values[0]
                    reply = dict(id=message['id'], result=dict(result=dict(type='string', value=value), wasThrown=False))
                else:
                    reply = dict(id=message['id'], error=dict(code=-32601, message="'%s' wasn't found" % message['method']))
            data = json.dumps(reply).encode()
            header = bytes([0x81]) + (bytes([len(data)]) if len(data) < 126 else bytes([126]) + struct.pack('>H', len(data)) if len(data) < 65536 else bytes([127]) + struct.pack('>Q', len(data)))
            writer.write(header + data); writer.flush()

    def close(self):
        self.server.shutdown(); self.server.server_close()


def state(**changes):
    value = copy.deepcopy(STATE)
    for path, item in changes.items():
        target = value
        keys = path.split('__')
        for key in keys[:-1]:
            target = target[key]
        target[keys[-1]] = item
    return value


class TizenBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.sdb_state = self.dir / 'sdb-state.json'
        self.log = self.dir / 'sdb-log.jsonl'
        (self.dir / 'fake-sdb.py').write_text(FAKE_SDB, encoding='utf-8')
        self.fake_sdb(reachable=True, connected=False, running=True)
        self.store = Store(self.dir / 'editor', platform='tizen')
        self.tv = self.store.tv
        self.tv._config = dict(CONFIG, sdb=[sys.executable, str(self.dir / 'fake-sdb.py'), str(self.sdb_state)])
        self.inspectors = []

    def tearDown(self):
        self.store.live.close()
        if self.store.live.worker:
            self.store.live.worker.join(timeout=5)
        self.store.agent.close()
        for inspector in self.inspectors:
            inspector.close()
        self.temp.cleanup()

    def fake_sdb(self, **values):
        self.sdb_state.write_text(json.dumps(dict(dict(target=TARGET, log=str(self.log)), **values)), encoding='utf-8')

    def calls(self):
        return [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines()] if self.log.exists() else []

    def inspector(self, values=None, targets=None):
        fake = FakeInspector(values or [json.dumps(STATE)], targets)
        self.inspectors.append(fake)
        return fake

    def remember_forward(self, remote=48283, local=None):
        (self.dir / 'editor').mkdir(parents=True, exist_ok=True)
        value = dict(target=TARGET, remote=remote)
        if local is not None:
            value['local'] = local  # legacy cache from the first build
        (self.dir / 'editor' / 'tizen-inspector.json').write_text(json.dumps(value))

    def cache(self):
        path = self.dir / 'editor' / 'tizen-inspector.json'
        return json.loads(path.read_text()) if path.exists() else None

    def forward_creates(self):
        return [c for c in self.calls() if c[2:3] == ['forward'] and c[3:4] != ['--remove']]

    def forward_removes(self):
        return [c for c in self.calls() if c[2:4] == ['forward', '--remove']]

    # --- Discovery -------------------------------------------------------------------------
    def test_finds_the_tv_from_device_and_signing_settings(self):
        root = self.dir / 'checkout'
        (root / 'app').mkdir(parents=True)
        shutil.copy(ROOT / 'app/config.xml', root / 'app/config.xml')
        storage = root / '.local/editor'
        self.assertIsNone(tizen_config(root))
        self.assertEqual(detect_platform(storage, root), 'android')
        (root / '.local').mkdir()
        sdk = self.dir / 'sdk'
        (sdk / 'tools').mkdir(parents=True)
        (sdk / 'tools' / ('sdb.exe' if os.name == 'nt' else 'sdb')).write_bytes(b'')
        (root / '.local/device.json').write_text(json.dumps({'host': '192.0.2.10'}))
        (root / '.local/signing.json').write_text(json.dumps({'profile': 'Test', 'sdk_path': str(sdk), 'package_id': 'TestPkg001', 'app_id': 'TestPkg001.CleanTV'}))
        config = tizen_config(root)
        self.assertEqual(config['target'], TARGET)
        self.assertEqual((config['app_id'], config['package_id']), ('TestPkg001.CleanTV', 'TestPkg001'))
        self.assertEqual(Path(config['sdb'][0]).parent, sdk / 'tools')
        self.assertEqual(detect_platform(storage, root), 'tizen')
        storage.mkdir(parents=True)
        (storage / 'tv.json').write_text('{}')
        self.assertEqual(detect_platform(storage, root), 'android', 'An ADB tv.json keeps the Android integration')
        (root / '.local/device.json').write_text(json.dumps({'host': 'tv.example; rm -rf /'}))
        self.assertIn('error', tizen_config(root))

    def test_unreachable_tv_is_reported_without_debug_actions(self):
        self.fake_sdb(reachable=False, connected=False, running=True)
        status = self.tv.status()
        self.assertEqual(status['platform'], 'tizen')
        self.assertFalse(status['connected'])
        self.assertEqual(status['state'], 'offline')
        self.assertIn('TV nicht erreichbar', status['message'])
        self.assertFalse(status['ready'])
        self.assertEqual(self.calls(), [['devices'], ['connect', TARGET], ['devices']])

    def test_status_connects_and_reports_debug_mode_off(self):
        status = self.tv.status()
        self.assertTrue(status['connected'])
        self.assertFalse(status['debug'])
        self.assertEqual(status['state'], 'connected')
        self.assertIn('TV verbunden', status['message'])
        self.assertIn('Debug-Modus aus', status['message'])
        self.assertEqual(self.calls(), [['devices'], ['connect', TARGET], ['devices']], 'Status never restarts or forwards')
        self.assertEqual(self.tv.status()['checkedAt'], status['checkedAt'], 'Status is cached')

    def test_status_reuses_an_existing_inspector(self):
        fake = self.inspector()
        self.remember_forward(remote=48283)
        self.fake_sdb(reachable=True, connected=True, running=True)
        with patch.object(self.tv, 'free_port', return_value=fake.port):
            status = self.tv.status()
        self.assertTrue(status['debug'])
        self.assertTrue(status['cleantv'])
        self.assertEqual(status['state'], 'ready')
        self.assertIn('Debug-Modus an', status['message'])
        self.assertIn('CleanTV bereit', status['message'])
        self.assertEqual(self.forward_creates(), [['-s', TARGET, 'forward', 'tcp:%d' % fake.port, 'tcp:48283']],
                         'Status opens one short-lived forward for the /json read')
        self.assertEqual(self.forward_removes(), [['-s', TARGET, 'forward', '--remove', 'tcp:%d' % fake.port]],
                         'The status forward is always removed afterwards')
        self.assertEqual(self.tv.open_forwards, set(), 'Nothing stays listening after status')
        self.assertEqual(self.cache(), dict(target=TARGET, remote=48283), 'Only the remote port is cached')
        self.assertFalse(fake.connected.is_set(), 'Status reads only the /json listing')

    def test_restart_kills_relaunches_with_timeout_and_forwards(self):
        fake = self.inspector()
        self.fake_sdb(reachable=True, connected=True, running=True, remote=48283)
        with patch.object(self.tv, 'free_port', return_value=fake.port):
            status = self.tv.restart_debug()
        calls = self.calls()
        self.assertIn(['-s', TARGET, 'shell', '0', 'kill', 'TestPkg001'], calls)
        self.assertIn(['-s', TARGET, 'shell', '0', 'debug', 'TestPkg001.CleanTV', '300'], calls)
        self.assertLess(calls.index(['-s', TARGET, 'shell', '0', 'kill', 'TestPkg001']), calls.index(['-s', TARGET, 'shell', '0', 'debug', 'TestPkg001.CleanTV', '300']))
        self.assertIn(['-s', TARGET, 'forward', 'tcp:%d' % fake.port, 'tcp:48283'], calls)
        self.assertEqual(status['state'], 'ready')
        self.assertEqual(self.cache(), dict(target=TARGET, remote=48283), 'Only the remote debug port is cached, never a local port')
        self.assertEqual(len(self.forward_creates()), len(self.forward_removes()), 'The restart forward is removed after the page answers')
        self.assertEqual(self.tv.open_forwards, set())

    def test_restart_leaves_no_forward_open(self):
        fake = self.inspector()
        self.fake_sdb(reachable=True, connected=True, running=True, remote=48283)
        with patch.object(self.tv, 'free_port', return_value=fake.port):
            self.tv.restart_debug()
        self.assertEqual(self.tv.open_forwards, set(), 'The restart poll forward is closed')
        self.assertEqual(len(self.forward_creates()), len(self.forward_removes()))

    def test_cached_legacy_forward_is_removed_not_reused(self):
        # A first-build cache named a persistent local port; it is removed once and dropped from the cache.
        self.remember_forward(remote=48283, local=49999)
        self.fake_sdb(reachable=True, connected=True, running=True)
        self.assertEqual(self.tv.remote(), 48283)
        self.assertIn(['-s', TARGET, 'forward', '--remove', 'tcp:49999'], self.calls())
        self.assertEqual(self.cache(), dict(target=TARGET, remote=48283), 'The stale local port is dropped for good')
        self.assertEqual(self.tv.remote(), 48283, 'The migrated cache reads again without another removal')
        self.assertEqual(self.forward_removes().count(['-s', TARGET, 'forward', '--remove', 'tcp:49999']), 1)

    def test_status_forgets_a_debug_port_that_no_longer_answers(self):
        # Nothing listens on the forward: the cached debug port is gone, so status forgets it.
        self.remember_forward(remote=48283)
        self.fake_sdb(reachable=True, connected=True, running=True)
        status = self.tv.status()
        self.assertEqual(status['state'], 'connected')
        self.assertFalse(status['debug'])
        self.assertIsNone(self.cache(), 'A dead debug port is forgotten')
        self.assertEqual(len(self.forward_creates()), len(self.forward_removes()), 'The probe forward is removed')
        self.assertEqual(self.tv.open_forwards, set())

    def test_status_survives_a_forward_that_cannot_bind(self):
        # sdb cannot open the forward (port clash). Status stays connected and keeps the remote for a retry.
        self.remember_forward(remote=48283)
        self.fake_sdb(reachable=True, connected=True, running=True, bind_fails=True)
        status = self.tv.status()
        self.assertEqual(status['state'], 'connected')
        self.assertFalse(status['debug'])
        self.assertEqual(self.cache(), dict(target=TARGET, remote=48283), 'A bind failure keeps the remote for a later retry')
        self.assertGreaterEqual(len(self.forward_creates()), 3, 'Three local ports are tried before giving up')
        self.assertEqual(self.tv.open_forwards, set(), 'A forward that never bound is not left open')

    def test_mirror_removes_its_forward_when_the_reader_stops(self):
        fake = self.inspector([json.dumps(STATE)])
        self.remember_forward(remote=48283)
        mirror = self.store.mirror
        mirror.IDLE = 0.6
        with patch.dict(os.environ, CLEANTV_MIRROR_INTERVAL_MS='100'), \
             patch.object(self.tv, 'free_port', return_value=fake.port), \
             patch.object(self.tv, 'inspector', return_value=dict(target=dict(id='page1', ws='/devtools/page/page1'))):
            result = mirror.read(-1, wait=5)
            while 'state' not in result:
                result = mirror.read(result['seq'], wait=5)
            worker = mirror.worker
            worker.join(timeout=8)
            self.assertFalse(worker.is_alive())
        self.assertGreaterEqual(len(self.forward_creates()), 1)
        self.assertEqual(len(self.forward_creates()), len(self.forward_removes()), 'Every reader forward is removed')
        self.assertEqual(self.tv.open_forwards, set(), 'Nothing stays listening after the reader stops')

    def test_import_once_removes_its_forward_even_on_failure(self):
        # The helper fails (no inspector on the forward); the short-lived forward is still removed.
        self.remember_forward(remote=48283)
        _, etag = self.store.read()
        with patch.object(self.store.mirror, 'fresh', return_value=None), \
             patch.object(self.tv, 'inspector', return_value=dict(target=dict(id='page1', ws='/devtools/page/page1'))):
            with self.assertRaises(ValueError):
                self.store.import_tv(etag)
        self.assertEqual(self.tv.open_forwards, set())
        self.assertEqual(len(self.forward_creates()), len(self.forward_removes()), 'The import forward is removed even on failure')

    def test_close_removes_a_forward_left_open_by_a_crashed_reader(self):
        self.tv.open_forwards.add(51515)
        self.store.mirror.close()
        self.assertEqual(self.tv.open_forwards, set())
        self.assertIn(['-s', TARGET, 'forward', '--remove', 'tcp:51515'], self.calls())

    def test_the_forward_exposure_is_explained_to_the_owner(self):
        workspace = (ROOT / 'editor/workspace.js').read_text(encoding='utf-8')
        self.assertIn('alle Netzwerkschnittstellen', workspace, 'The restart dialog warns that the forward is not loopback-only')
        docs = (ROOT / 'docs/editor.md').read_text(encoding='utf-8')
        self.assertIn('all network interfaces', docs)

    def test_debug_launch_parsing_and_closed_reply(self):
        self.assertEqual(parse_debug_port('... successfully launched pid = 8732 with debug 1 port: 48283\n'), 48283)
        for reply in ['closed\n', '', 'successfully launched pid = 1 with debug 1 port: 99999']:
            with self.assertRaises(ValueError):
                parse_debug_port(reply)
        with self.assertRaises(ValueError) as error:
            parse_debug_port('closed')
        self.assertIn('closed', str(error.exception))
        self.fake_sdb(reachable=True, connected=True, running=True, kill_stops=False)
        with self.assertRaises(ValueError) as error:
            self.tv.restart_debug()
        self.assertIn('closed', str(error.exception))
        self.assertFalse(any(call[2:3] == ['forward'] for call in self.calls()), 'No forward after a refused launch')

    def test_json_target_choice(self):
        page = dict(id='page1', type='page', title='CleanTV', url='file:///index.html', webSocketDebuggerUrl='ws://127.0.0.1:9333/devtools/page/page1')
        other = [dict(page, id='w', type='service_worker'), dict(page, id='x', url='file:///other.html'), dict(page, id='y', type='iframe')]
        self.assertEqual(choose_target(other + [page])['id'], 'page1')
        self.assertEqual(choose_target(other + [page])['ws'], '/devtools/page/page1')
        self.assertIsNone(choose_target(other))
        self.assertIsNone(choose_target('not a list'))
        attached = dict(page)
        attached.pop('webSocketDebuggerUrl')
        self.assertIsNone(choose_target([attached])['ws'], 'An attached inspector is recognised but not used')
        self.assertIsNone(choose_target([dict(page, webSocketDebuggerUrl='ws://evil.example/devtools/page/../../x')])['ws'])

    # --- Mirror -----------------------------------------------------------------------------
    def helper_lines(self, fake, seconds):
        env = dict(os.environ, CLEANTV_MIRROR_INTERVAL_MS='100')
        process = subprocess.Popen(['node', str(HELPER), str(fake.port)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=ROOT)
        lines = []
        reader = threading.Thread(target=lambda: lines.extend(json.loads(line) for line in process.stdout), daemon=True)
        reader.start()
        time.sleep(seconds)
        process.stdin.close()
        process.wait(timeout=5)
        reader.join(timeout=5)
        process.stdout.close()
        process.stderr.close()
        return lines, process.returncode

    def test_helper_speaks_raw_cdp_and_emits_only_changes(self):
        a, b = json.dumps(STATE), json.dumps(state(where__focusAction='home.app.netflix'))
        fake = self.inspector([a, a, a, b, b, a])
        lines, code = self.helper_lines(fake, 1.6)
        self.assertEqual(code, 0, 'The helper ends when its stdin closes')
        states = [line['state'] for line in lines if line['type'] == 'state']
        self.assertEqual([s['where']['focusAction'] for s in states], ['home.app.youtube', 'home.app.netflix', 'home.app.youtube'])
        self.assertGreaterEqual(sum(line['type'] == 'tick' for line in lines), 6)
        expression = EXPRESSION_PATH.read_text(encoding='utf-8')
        self.assertTrue(fake.expressions)
        self.assertTrue(all(sent == expression for sent in fake.expressions), 'Only the fixed repository expression is evaluated')
        self.assertEqual(set(fake.methods), {'Runtime.evaluate'})

    def test_helper_refuses_an_inspector_that_is_already_attached(self):
        fake = self.inspector(targets=[dict(id='page1', type='page', title='CleanTV', url='file:///index.html')])
        result = subprocess.run(['node', str(HELPER), str(fake.port), '--once'], capture_output=True, timeout=20, cwd=ROOT)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('belegt', json.loads(result.stdout.decode().splitlines()[-1])['message'])

    def test_mirror_relays_changes_and_stops_when_unused(self):
        a, b = json.dumps(STATE), json.dumps(state(where__focusAction='home.app.netflix'))
        fake = self.inspector([a, a, b])
        self.remember_forward(remote=48283)
        mirror = self.store.mirror
        mirror.IDLE = 1.0
        with patch.dict(os.environ, CLEANTV_MIRROR_INTERVAL_MS='100'), \
             patch.object(self.tv, 'free_port', return_value=fake.port), \
             patch.object(self.tv, 'inspector', return_value=dict(target=dict(id='page1', ws='/devtools/page/page1'))):
            first = mirror.read(-1, wait=8)
            while 'state' not in first:
                first = mirror.read(first['seq'], wait=8)
            self.assertEqual(first['phase'], 'live')
            self.assertEqual(first['localVersion'], json.loads((ROOT / 'package.json').read_text())['version'])
            second = mirror.read(first['seq'], wait=8)
            self.assertEqual(second['state']['where']['focusAction'], 'home.app.netflix')
            self.assertEqual(second['seq'], first['seq'] + 1)
            quiet = mirror.read(second['seq'], wait=.4)
            self.assertNotIn('state', quiet, 'Unchanged state is not sent again')
            self.assertIsNotNone(mirror.fresh(3))
            worker = mirror.worker
            worker.join(timeout=8)
            self.assertFalse(worker.is_alive(), 'The reader stops once no editor tab asks for it')
            self.assertTrue(fake.closed.wait(5), 'The CDP WebSocket is closed')
            self.assertEqual(mirror.status()['state'], 'stopped')
        self.assertEqual(len(self.forward_creates()), len(self.forward_removes()), 'Every reader forward is removed')
        self.assertEqual(self.tv.open_forwards, set(), 'Nothing stays listening after the reader stops')

    def test_mirror_without_debug_mode_waits_and_never_restarts(self):
        self.store.mirror.IDLE = .5
        with patch.object(self.tv, 'inspector', return_value=None), patch.object(self.tv, 'restart_debug') as restart:
            result = self.store.mirror.read(-1, wait=1.5)
            self.assertEqual(result['phase'], 'debug-off')
            self.assertIn('Debug-Modus', result['message'])
            self.store.mirror.worker.join(timeout=8)
            restart.assert_not_called()
        self.assertEqual([c for c in self.calls() if c[2:3] in (['shell'], ['forward'])], [])

    def test_video_is_refused_on_samsung(self):
        with self.assertRaises(ValueError):
            next(self.store.live.frames('smooth'))
        with self.assertRaises(ValueError):
            self.tv.screenshot()
        self.assertFalse(self.tv.addon_diagnostics()['installed'])

    # --- Import -----------------------------------------------------------------------------
    def test_import_reads_the_samsung_page_once(self):
        fake = self.inspector([json.dumps(STATE)])
        self.remember_forward(remote=48283)
        before, etag = self.store.read()
        with patch.object(self.tv, 'free_port', return_value=fake.port), \
             patch.object(self.tv, 'inspector', return_value=dict(target=dict(id='page1', ws='/devtools/page/page1'))):
            result = self.store.import_tv(etag)
        project, _ = self.store.read()
        committed = STATE['state']['committed']
        self.assertEqual(project['preferences'], {key: committed[key] for key in PREF_KEYS})
        self.assertEqual(project['basePrefs'], project['preferences'])
        source = project['tvSource']
        self.assertEqual(source['platform'], 'tizen')
        self.assertEqual(source['version'], '0.9.0')
        self.assertEqual({a['kind'] for a in source['addons']}, {'spotify', 'weather', 'wallpapers'})
        self.assertEqual(source['apps'], [dict(id='rJeHak5zRg.Spotify', appId='rJeHak5zRg.Spotify', name='Spotify', brand='spotify')])
        self.assertTrue(result['sourceMatches'])
        self.assertEqual(json.loads((self.store.path / 'snapshots' / (result['snapshot'] + '.json')).read_text())['project'], before)
        saved = (self.store.path / 'project.json').read_text(encoding='utf-8')
        for private in ['Testtitel', 'Teststadt', 'Testgerät']:
            self.assertNotIn(private, saved, 'Spotify and weather details are never stored in the draft')
        self.assertEqual(len(fake.expressions), 1)
        self.assertEqual(len(self.forward_creates()), len(self.forward_removes()), 'The import forward is removed')
        self.assertEqual(self.tv.open_forwards, set())

    def test_import_uses_the_running_mirror_instead_of_a_second_client(self):
        _, etag = self.store.read()
        with patch.object(self.store.mirror, 'fresh', return_value=copy.deepcopy(STATE)), \
             patch.object(self.tv, 'read_once', side_effect=AssertionError('second inspector client')):
            self.store.import_tv(etag)
        self.assertEqual(self.store.read()[0]['tvSource']['platform'], 'tizen')

    def test_import_rejects_a_page_that_is_not_ready(self):
        _, etag = self.store.read()
        with patch.object(self.tv, 'read_once', return_value=state(ready=False)), patch.object(self.store.mirror, 'fresh', return_value=None):
            with self.assertRaises(ValueError):
                self.store.import_tv(etag)
        self.assertFalse((self.store.path / 'snapshots').exists())

    def test_capture_keeps_only_safe_fields(self):
        value = state()
        value['addons']['installed']['spotify']['token'] = 'PRIVATE'
        value['state']['appRecords'][0]['icon'] = '/opt/usr/apps/x/icon.png'
        captured = capture(value)
        self.assertNotIn('PRIVATE', json.dumps(captured))
        self.assertNotIn('icon', json.dumps(captured['apps']))
        self.assertEqual(captured['platform'], 'tizen')

    # --- Fixed expression ---------------------------------------------------------------------
    def test_fixed_expression_reads_no_storage_tokens_or_device_ids(self):
        source = EXPRESSION_PATH.read_text(encoding='utf-8')
        code = re.sub(r'/\*.*?\*/', '', source, flags=re.S)
        for forbidden in [r'localStorage', r'sessionStorage', r'indexedDB', r'cookie', r'setItem', r'removeItem', r'cleantv\.spotify',
                          r'token', r'verifier', r'\bcode\b', r'refresh', r'duid', r'serial', r'\bmac\b', r'systeminfo', r'webapis', r'productinfo',
                          r'\.activate\(', r'\.nav\(', r'\.scene\(', r'\.look\(', r'\.preferences\(', r'\.render\(', r'\.focus\(', r'\.set\(',
                          r'\.reload\(', r'\.request\(', r'\.sync\(', r'\.picker\(', r'\.bind\(', r'\.resolve\(', r'\.launch', r'signIn', r'\beval\b',
                          r'XMLHttpRequest', r'fetch', r'postMessage', r'\.apps\(', r'dispatchEvent']:
            self.assertIsNone(re.search(forbidden, code, re.I), 'Forbidden in the TV expression: ' + forbidden)
        self.assertTrue(code.strip().startswith('(function () {') and code.strip().endswith('}())'))


class TizenRouteTests(unittest.TestCase):
    def serve(self, platform):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        store = Store(Path(temp.name), platform=platform)
        if platform == 'tizen':
            store.tv._config = None
        server = PreviewServer(('127.0.0.1', 0), Editor)
        server.include_private_fonts = False
        server.store = store
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), store.live.close(), store.agent.close()))
        return 'http://127.0.0.1:%d' % server.server_port, store

    def get(self, url):
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_android_keeps_video_and_has_no_mirror(self):
        base, _ = self.serve('android')
        self.assertEqual(json.loads(self.get(base + '/api/editor/tv/status')[1])['platform'], 'android')
        code, body = self.get(base + '/api/editor/tv/mirror?since=-1')
        self.assertEqual(code, 409)
        page = self.get(base + '/home/?editor=1')[1].decode()
        self.assertIn('/editor/mock.js', page)
        self.assertNotIn('/editor/tv-mirror.js', page)

    def test_samsung_routes_serve_the_tizen_page_without_device_access(self):
        base, store = self.serve('tizen')
        status = json.loads(self.get(base + '/api/editor/tv/status')[1])
        self.assertEqual((status['platform'], status['configured'], status['state']), ('tizen', False, 'unconfigured'))
        mirror = json.loads(self.get(base + '/api/editor/tv/mirror?since=-1')[1])
        self.assertIn(mirror['phase'], ['starting', 'unconfigured'])
        page = self.get(base + '/home/?mirror=1')[1].decode()
        self.assertIn('/editor/tv-mirror.js', page)
        self.assertIn('CleanTVMirror.beforeMain()', page)
        self.assertNotIn('/editor/mock.js', page)
        self.assertNotIn('CleanTVMirrorBoot=', page, 'Mirror data reaches the frame from the editor, not the HTML')
        self.assertLess(page.index('/editor/tv-mirror.js'), page.index('android-device.js'))
        self.assertLess(page.index('CleanTVMirror.beforeMain()'), page.index('src="main.js"'))
        self.assertEqual(self.get(base + '/editor/tv-mirror.js')[0], 200)
        self.assertEqual(self.get(base + '/editor/mirror.js')[0], 200)
        # No body: the token check refuses first, and an unread body would reset the socket on Windows.
        request = urllib.request.Request(base + '/api/editor/tv/debug', data=b'', method='POST', headers={'Content-Type': 'application/json'})
        try:
            urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10)
            self.fail('POST without token must fail')
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 403)
        project, _ = store.read()
        project['tvSource'] = dict(platform='tizen', version='0.9.0', apps=[], addons=[])
        (store.path / 'project.json').write_text(json.dumps(project))
        draft = self.get(base + '/home/?editor=1')[1].decode()
        self.assertIn('/editor/tv-mirror.js', draft)
        self.assertIn('"mode":"draft"', draft.replace(' ', ''))
        self.assertNotIn('/editor/mock.js', draft)


if __name__ == '__main__':
    unittest.main()
