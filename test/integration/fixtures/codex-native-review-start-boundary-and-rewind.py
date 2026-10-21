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
manual_command = 'managed-manual-review-command' in sys.argv[6:]
native_profile_without_control_host = 'native-profile-without-control-host' in sys.argv[6:]
boundary_text = 'now $review-validate-fix:review-validate-fix your own work.' if manual_command else 'RVF 发起决策点 · RVF_DECISION_TOKEN=0123456789abcdef'

class Server(http.server.BaseHTTPRequestHandler):
    count = 0
    request_bodies = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        Server.request_bodies.append(self.rfile.read(int(self.headers.get('Content-Length', 0))).decode())
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
hook.write_text('import json,pathlib,sys,os\ne=json.load(sys.stdin)\np=pathlib.Path(__file__).with_suffix(".observed")\nwith pathlib.Path(__file__).with_suffix(".task-identities.jsonl").open("a") as observed:\n observed.write(json.dumps({"task_id":os.environ.get("KANBAN_TASK_ID"),"native_session_id":e.get("session_id")})+"\\n")\nif not p.exists():\n p.write_text("done")\n print(json.dumps({"decision":"block","reason":"BOUNDARY_HOOK_CONTEXT_ONLY 仅返回模拟回复。"}))\n')
(cfg / 'hooks.json').write_text(json.dumps({'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': f'{sys.executable} {hook}', 'timeout': 5}]}]}}))
(cfg / 'config.toml').write_text(f'model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离回环测试"\nbase_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.{json.dumps(str(repo))}]\ntrust_level="trusted"\n')
if native_profile_without_control_host:
    # 基础 provider 只连拒绝连接的回环端口，成功回复必须来自实际选中的 profile。
    (cfg / 'config.toml').write_text((cfg / 'config.toml').read_text().replace(f'127.0.0.1:{server.server_port}', '127.0.0.1:1'))
    (cfg / 'review-profile.config.toml').write_text(f'model="gpt-5.4"\nmodel_provider="isolated_profile_loopback"\ndeveloper_instructions="PROFILE_NATIVE_CONFIGURATION_MARKER 仅返回模拟回复。"\n[model_providers.isolated_profile_loopback]\nname="隔离 profile 回环测试"\nbase_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n')
env = {k: v for k, v in os.environ.items() if not k.startswith(('CODEX_', 'KANBAN_', 'RVF_', 'OPENAI_', 'ANTHROPIC_'))}
env.update({'CODEX_HOME': str(cfg), 'TERM': 'xterm-256color', 'NO_COLOR': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
app_server = None
app_server_log = None
managed_control_host = any(mode in sys.argv[6:] for mode in ['managed-control-host', 'managed-manual-review-command'])
if managed_control_host or native_profile_without_control_host:
    env['KANBAN_TASK_ID'] = 'synthetic-native-task'
    prepared = subprocess.run([node_binary, str(source_root / 'test/integration/fixtures/codex-native-session-control-host-prepare-launch.cjs'), json.dumps({'sourceRoot': str(source_root), 'repositoryPath': str(repo), 'codexBinary': codex_binary, 'profileName': 'review-profile' if native_profile_without_control_host else None})], env=env, capture_output=True, text=True, timeout=15)
    if prepared.returncode:
        raise RuntimeError(prepared.stderr)
    launch = json.loads(prepared.stdout)
    socket_path = Path(launch['endpoint']['socketPath']) if launch['endpoint'] else None
    tui_command = [launch['binary'], *launch['args']]
    print('PRODUCT_NATIVE_CONTROL_ENDPOINT', json.dumps(launch['endpoint']), flush=True)
else:
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
    tui_command = [codex_binary, '--remote', 'unix://' + str(socket_path), '--no-alt-screen', '-C', str(repo), 'BOUNDARY_ORIGINAL_IMPLEMENTATION_TURN']
minted_at = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 140, 0, 0))
p = subprocess.Popen(tui_command, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
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
    options = {'sourceRoot': str(source_root), 'repositoryPath': str(repo), 'rvfHome': str(root / 'rvf'), 'mintedAt': minted_at, 'afterRewind': label == 'AFTER_REWIND', 'consumerRepository': os.environ.get('KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY'), 'nativeControlSocketPath': str(socket_path), 'manualCommand': manual_command, 'boundaryText': boundary_text}
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
                    if text == boundary_text:
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
    if native_profile_without_control_host:
        if not Server.count or not all('PROFILE_NATIVE_CONFIGURATION_MARKER' in body and json.loads(body).get('model') == 'gpt-5.4' for body in Server.request_bodies):
            raise RuntimeError('原生 profile 的 provider、model 或指令未被实际消费')
        if launch['endpoint'] is not None or launch['binary'] != codex_binary or launch['args'] != ['--profile', 'review-profile', '--no-alt-screen', '-C', str(repo), 'BOUNDARY_ORIGINAL_IMPLEMENTATION_TURN']:
            raise RuntimeError('profile 启动未保留原生 TUI argv，或错误登记了控制端点')
        print('PRODUCT_NATIVE_PROFILE_CONFIGURATION_VERIFIED', json.dumps({'provider': 'isolated_profile_loopback', 'model': 'gpt-5.4', 'requests': Server.count, 'original_argv': launch['args'], 'endpoint': launch['endpoint']}, ensure_ascii=False), flush=True)
        print('PRODUCT_NATIVE_CONTROL_UNAVAILABLE_FOR_PROFILE', flush=True)
    if managed_control_host:
        hook_identities = [json.loads(line) for line in hook.with_suffix('.task-identities.jsonl').read_text().splitlines()]
        if not hook_identities or any(item['task_id'] != 'synthetic-native-task' for item in hook_identities):
            raise RuntimeError('原生 hook 未继承本会话的任务身份')
        if not any('CONTROL_HOST_CONFIGURATION_MARKER' in body for body in Server.request_bodies):
            raise RuntimeError('原生宿主没有保留本次启动配置覆盖')
        print('PRODUCT_NATIVE_HOOK_IDENTITY_AND_CONFIGURATION_VERIFIED', flush=True)
    if Server.count and not native_profile_without_control_host:
        os.write(master, ('\x15' + boundary_text).encode())
        drain(1)
        os.write(master, b'\r')
        drain(10)
        native_reader_probe()
        if 'preserve-review-boundary' not in sys.argv[6:]:
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
    if app_server is not None:
        close_owned_child_process(app_server)
    if app_server_log is not None:
        app_server_log.close()
    if managed_control_host:
        print('PRODUCT_NATIVE_CONTROL_CLEANED', not socket_path.exists(), flush=True)
