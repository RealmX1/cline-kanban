# 隔离原生实验：Git 由统一 fixture 提供；仅启停本实验的前台 app-server 与 TUI。
import atexit
import signal
import os, sys, json, threading, http.server, subprocess, pty, select, time, re, struct, fcntl, termios
from pathlib import Path

def close_owned_child_process(child):
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()

def handle_termination_signal(signum, frame):
    raise SystemExit(143)
signal.signal(signal.SIGTERM, handle_termination_signal)
root = Path(sys.argv[1])
cfg = root / 'c'
cfg.mkdir()
repo = Path(sys.argv[2])
source_root = Path(sys.argv[3])
node_binary = sys.argv[4]
codex_binary = sys.argv[5]

class Server(http.server.BaseHTTPRequestHandler):
    count = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        Server.count += 1
        n = Server.count
        text = f'BOUNDARY_TEST_REPLY_{n}'
        msg = {'id': f'msg_{n}', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        resp = {'id': f'resp_{n}', 'object': 'response', 'created_at': int(time.time()), 'status': 'completed', 'model': 'gpt-5.4', 'output': [msg], 'usage': {'input_tokens': 8, 'output_tokens': 4, 'total_tokens': 12}}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        events = [('response.created', {'response': {**resp, 'status': 'in_progress', 'output': []}}), ('response.output_item.added', {'output_index': 0, 'item': {**msg, 'status': 'in_progress', 'content': []}}), ('response.content_part.added', {'item_id': msg['id'], 'output_index': 0, 'content_index': 0, 'part': {'type': 'output_text', 'text': '', 'annotations': []}}), ('response.output_text.delta', {'item_id': msg['id'], 'output_index': 0, 'content_index': 0, 'delta': text}), ('response.output_text.done', {'item_id': msg['id'], 'output_index': 0, 'content_index': 0, 'text': text}), ('response.output_item.done', {'output_index': 0, 'item': msg}), ('response.completed', {'response': resp})]
        for name, d in events:
            self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps({'type': name, **d}) + '\n\n').encode())
            self.wfile.flush()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Server)
threading.Thread(target=server.serve_forever, daemon=True).start()
hook = root / 'isolated-stop-feedback-fixture.py'
hook.write_text('import json,pathlib,sys\ne=json.load(sys.stdin)\np=pathlib.Path(__file__).with_suffix(".observed")\nif not p.exists():\n p.write_text("done")\n print(json.dumps({"decision":"block","reason":"BOUNDARY_HOOK_CONTEXT_ONLY 仅返回模拟回复。"}))\n')
(cfg / 'hooks.json').write_text(json.dumps({'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': f'{sys.executable} {hook}', 'timeout': 5}]}]}}))
(cfg / 'config.toml').write_text(f'model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离回环测试"\nbase_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.{json.dumps(str(repo))}]\ntrust_level="trusted"\n')
env = {k: v for k, v in os.environ.items() if not k.startswith(('CODEX_', 'KANBAN_', 'RVF_', 'OPENAI_', 'ANTHROPIC_'))}
env.update({'CODEX_HOME': str(cfg), 'TERM': 'xterm-256color', 'NO_COLOR': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
socket_directory = cfg / 'app-server-control'
socket_directory.mkdir()
socket_path = socket_directory / 'app-server-control.sock'
app_server_log = (root / 'isolated-app-server.log').open('w')
app_server = subprocess.Popen([codex_binary, 'app-server', '--listen', 'unix://' + str(socket_path)], env=env, stdout=app_server_log, stderr=app_server_log)
atexit.register(close_owned_child_process, app_server)
deadline = time.monotonic() + 8
while not socket_path.exists() and time.monotonic() < deadline:
    if app_server.poll() is not None:
        raise RuntimeError('隔离原生控制面启动失败')
    time.sleep(0.05)
minted_at = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 140, 0, 0))
p = subprocess.Popen([codex_binary, '--remote', 'unix://' + str(socket_path), '--no-alt-screen', '-C', str(repo), 'BOUNDARY_ORIGINAL_IMPLEMENTATION_TURN'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
atexit.register(close_owned_child_process, p)
os.close(slave)
chunks = []

def drain(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.15)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            chunks.append(chunk)
            if b'\x1b[6n' in chunk:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in chunk:
                os.write(master, b'\x1b[?1;2c')
        if p.poll() is not None:
            break

def plain():
    return re.sub('\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\))', '', b''.join(chunks).decode(errors='replace'))

def users():
    out = []
    for file in cfg.rglob('*.jsonl'):
        if '/sessions/' not in str(file):
            continue
        for line in file.read_text().splitlines():
            try:
                d = json.loads(line)
            except:
                continue
            v = d.get('payload', {})
            if d.get('type') == 'response_item' and v.get('type') == 'message' and (v.get('role') == 'user'):
                text = ' '.join((x.get('text', '') for x in v.get('content', []) if isinstance(x, dict)))
                if 'BOUNDARY_' in text:
                    out.append(text)
    return out
native_receipt = None

def query_live_branch(label):
    if native_receipt is None:
        return
    options = {'sourceRoot': str(source_root), 'repositoryPath': str(repo), 'rvfHome': str(root / 'rvf'), 'mintedAt': minted_at, 'afterRewind': label == 'AFTER_REWIND', 'consumerRepository': os.environ.get('KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY')}
    result = subprocess.run([node_binary, str(source_root / 'test/integration/fixtures/codex-native-review-start-boundary-probe.cjs'), json.dumps(native_receipt), json.dumps(options)], env=env, capture_output=True, text=True, timeout=12)
    print(label + '_LIVE_BRANCH', result.returncode, result.stdout, result.stderr, flush=True)
    if result.returncode:
        raise RuntimeError('产品分界捕获或原生实时观测失败')

def native_reader_probe(after_rewind=False):
    global native_receipt
    if native_receipt is None:
        for path in cfg.rglob('*.jsonl'):
            session_id = None
            for line in path.read_text().splitlines():
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                payload = entry.get('payload', {})
                if entry.get('type') == 'session_meta':
                    session_id = payload.get('id')
                item = payload.get('item') or {}
                if entry.get('type') == 'event_msg' and payload.get('type') == 'item_completed' and (item.get('type') == 'UserMessage'):
                    content = item.get('content') or []
                    text = ''.join((part.get('text', '') for part in content if isinstance(part, dict)))
                    if text == 'RVF 发起决策点 · RVF_DECISION_TOKEN=0123456789abcdef':
                        native_receipt = {'session_id': session_id, 'native_turn_id': payload.get('turn_id'), 'native_user_message_id': item.get('id'), 'transcript_path': str(path)}
    query_live_branch('AFTER_REWIND' if after_rewind else 'BEFORE_REWIND')
try:
    deadline = time.monotonic() + 45
    trusted = False
    while time.monotonic() < deadline:
        drain(1)
        if 'Hooks need review' in plain() and (not trusted):
            os.write(master, b'2\r')
            trusted = True
        if Server.count >= 2:
            drain(2)
            break
        if p.poll() is not None:
            break
    for session_file in cfg.rglob('*.jsonl'):
        for line in session_file.read_text().splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get('type') == 'session_meta':
                meta = record.get('payload', {})
                print('NATIVE_SESSION_METADATA', json.dumps({key: meta.get(key) for key in ['originator', 'cli_version', 'source']}, ensure_ascii=False), flush=True)
                break
    print('FIRST_SCREEN', plain()[-1300:], flush=True)
    print('AFTER_HOOK', json.dumps({'requests': Server.count, 'hook_observed': hook.with_suffix('.observed').exists(), 'users': users()}, ensure_ascii=False), flush=True)
    if Server.count:
        os.write(master, '\x15RVF 发起决策点 · RVF_DECISION_TOKEN=0123456789abcdef'.encode())
        drain(1)
        os.write(master, b'\r')
        drain(10)
        native_reader_probe()
        if len(sys.argv) <= 6 or sys.argv[6] != 'preserve-review-boundary':
            os.write(master, b'\x1b')
            drain(0.4)
            os.write(master, b'\x1b')
            drain(2)
            print('SECOND_REWIND_SCREEN', plain()[-1400:], flush=True)
            print('FINAL_USERS', json.dumps(users(), ensure_ascii=False), flush=True)
            os.write(master, b'\r')
            drain(3)
            print('SELECT_REWIND_BOUNDARY_SCREEN', plain()[-1600:], flush=True)
            native_reader_probe(after_rewind=True)
finally:
    p.terminate()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    os.close(master)
    server.shutdown()
    app_server.terminate()
    try:
        app_server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        app_server.kill()
        app_server.wait()
    app_server_log.close()
