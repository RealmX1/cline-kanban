# 只操作调用方统一 fixture 的 HOME、仓库和本次派生的原生 TUI；模型只连接本地桩。
import atexit
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import shutil
import termios
import threading
import time

root, repository, codex_binary = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
codex_home = root / "isolated-codex-home"
codex_home.mkdir()
observations_path = root / "native-compaction-hook-observations.jsonl"
provider_observations = []
compaction_requested = threading.Event()
release_compaction = threading.Event()


def close_owned_child(child):
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def terminate_probe(signum, frame):
    raise SystemExit(143)


signal.signal(signal.SIGTERM, terminate_probe)
hook_path = root / "record-native-compaction-hook.py"
hook_path.write_text(
    "import json,pathlib,sys,time\n"
    "payload=json.load(sys.stdin)\n"
    f"with pathlib.Path({str(observations_path)!r}).open('a') as output:\n"
    " output.write(json.dumps({'observed_at_ms':int(time.time()*1000),'payload':payload})+'\\n')\n"
)
hook_command = f"{sys.executable!r} {str(hook_path)!r}"
if not (root / "native-validated-hook-arguments.json").exists():
    (codex_home / "hooks.json").write_text(json.dumps({"hooks": {
    event: [{"hooks": [{"type": "command", "command": hook_command, "timeout": 5}]}]
    for event in ["PreCompact", "PostCompact", "UserPromptSubmit", "Stop"]
    }}))


class ModelProvider(http.server.BaseHTTPRequestHandler):
    normal_response_count = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        items = body.get("input", [])
        is_remote_compaction = self.path.endswith("/compact") or any(
            isinstance(item, dict) and item.get("type") == "compaction_trigger" for item in items
        )
        current_hooks = hooks()
        # 自定义 provider 的原生本地压缩仍调用 responses；用已发生且未完成的原生阶段判读该请求。
        is_compaction = is_remote_compaction or sum(
            event["payload"].get("hook_event_name") == "PreCompact" for event in current_hooks
        ) > sum(event["payload"].get("hook_event_name") == "PostCompact" for event in current_hooks)
        provider_observations.append({
            "observed_at_ms": int(time.time() * 1000),
            "path": self.path,
            "is_compaction": is_compaction,
            "input_item_types": [item.get("type") for item in items if isinstance(item, dict)],
        })
        if is_compaction:
            compaction_requested.set()
            if not release_compaction.wait(timeout=30):
                self.send_error(500, "隔离探针未释放压缩响应")
                return
            item = {"id": "isolated_compaction", "type": "compaction", "encrypted_content": "isolated-opaque-compaction"}
            if self.path.endswith("/compact"):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"id": "isolated_compact", "output": [item], "usage": {"input_tokens": 8, "output_tokens": 4, "total_tokens": 12}}).encode())
                return
        if not is_remote_compaction:
            if not is_compaction:
                ModelProvider.normal_response_count += 1
            item = {
                "id": f"isolated_message_{len(provider_observations)}", "type": "message", "role": "assistant",
                "status": "completed", "content": [{"type": "output_text", "text": "隔离回复就绪", "annotations": []}],
            }
        # 首次回复仅报告测试专用高用量，迫使下一回合走真实原生自动压缩；不推断历史生产阈值。
        tokens = 20000 if not is_compaction and ModelProvider.normal_response_count == 1 else 8
        result = {
            "id": f"isolated_response_{len(provider_observations)}", "object": "response", "created_at": int(time.time()),
            "status": "completed", "model": "gpt-5.4", "output": [item],
            "usage": {"input_tokens": tokens, "output_tokens": 4, "total_tokens": tokens + 4},
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event_type, fields in [
            ("response.created", {"response": {**result, "status": "in_progress", "output": []}}),
            ("response.output_item.done", {"output_index": 0, "item": item}),
            ("response.completed", {"response": result}),
        ]:
            self.wfile.write(("event: " + event_type + "\ndata: " + json.dumps({"type": event_type, **fields}) + "\n\n").encode())
            self.wfile.flush()


provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ModelProvider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
(codex_home / "config.toml").write_text(
    'model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n'
    'model_auto_compact_token_limit=10000\n[features]\nhooks=true\n'
    '[model_providers.isolated_loopback]\nname="隔离压缩模型桩"\n'
    f'base_url="http://127.0.0.1:{provider.server_port}/v1"\n'
    'wire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n'
    f'[projects.{json.dumps(str(repository))}]\ntrust_level="trusted"\n'
)
environment = {key: value for key, value in os.environ.items() if not key.startswith(("CODEX_", "KANBAN_", "RVF_", "OPENAI_", "ANTHROPIC_", "CLAUDE_"))}
environment.update({"CODEX_HOME": str(codex_home), "TERM": "xterm-256color", "PYTHONDONTWRITEBYTECODE": "1"})
version = subprocess.run([codex_binary, "--version"], env=environment, capture_output=True, text=True, timeout=10).stdout.strip()
socket_directory = Path(tempfile.mkdtemp(prefix="native-compact-control-", dir="/tmp"))
atexit.register(shutil.rmtree, socket_directory, True)
socket_path = socket_directory / "s"
native_hook_arguments_path = root / "native-validated-hook-arguments.json"
native_hook_arguments = json.loads(native_hook_arguments_path.read_text()) if native_hook_arguments_path.exists() else ["--dangerously-bypass-hook-trust"]
app_server_output = (root / "native-compaction-app-server.log").open("w")
app_server = subprocess.Popen([codex_binary, *native_hook_arguments, "app-server", "--listen", "unix://" + str(socket_path)], env=environment, stdout=app_server_output, stderr=app_server_output)
atexit.register(close_owned_child, app_server)
deadline = time.monotonic() + 10
while not socket_path.exists() and time.monotonic() < deadline:
    if app_server.poll() is not None:
        raise RuntimeError("隔离原生控制宿主未启动")
    time.sleep(0.05)
(root / "native-compaction-control-endpoint.json").write_text(json.dumps({"socket_path": str(socket_path)}))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
child = subprocess.Popen([
    codex_binary, "--remote", "unix://" + str(socket_path), "--dangerously-bypass-approvals-and-sandbox",
    "--no-alt-screen", "-C", str(repository), "ISOLATED_COMPACTION_FIRST_PROMPT",
], env=environment, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
atexit.register(close_owned_child, child)
os.close(slave)
output = bytearray()


def drain():
    readable, _, _ = select.select([master], [], [], 0.05)
    if not readable:
        return
    try:
        chunk = os.read(master, 65536)
    except OSError:
        return
    output.extend(chunk)
    if b"\x1b[6n" in chunk:
        os.write(master, b"\x1b[1;1R")
    if b"\x1b[c" in chunk:
        os.write(master, b"\x1b[?1;2c")


def hooks():
    if not observations_path.exists():
        return []
    return [json.loads(line) for line in observations_path.read_text().splitlines() if line]


def wait_until(predicate, description, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        drain()
        if predicate():
            return
        if child.poll() is not None:
            break
    raise RuntimeError(description)


try:
    wait_until(lambda: any(event["payload"].get("hook_event_name") == "Stop" for event in hooks()), "首回合没有完成")
    submitted_at_ms = int(time.time() * 1000)
    os.write(master, b"ISOLATED_COMPACTION_SECOND_PROMPT")
    # 与生产相同，先让粘贴进入 composer，再只提交一次 CR。
    deadline = time.monotonic() + 0.4
    while time.monotonic() < deadline:
        drain()
    submitted_at_ms = int(time.time() * 1000)
    os.write(master, b"\r")
    wait_until(compaction_requested.is_set, "自动压缩没有向本地模型桩发请求")
    wait_until(lambda: any(event["payload"].get("hook_event_name") == "PreCompact" for event in hooks()), "自动压缩开始 hook 不存在")
    pre = next(event for event in hooks() if event["payload"].get("hook_event_name") == "PreCompact")
    if pre["observed_at_ms"] - submitted_at_ms >= 15000:
        raise RuntimeError("自动压缩开始 hook 晚于旧确认预算")
    if pre["payload"].get("trigger") != "auto" or not pre["payload"].get("turn_id"):
        raise RuntimeError("自动压缩开始 hook 缺少可信关联字段")
    # provider 保持未完成；证明开始信号不是完成时追记的 started_at_ms。
    if any(event["payload"].get("hook_event_name") == "PostCompact" for event in hooks()):
        raise RuntimeError("压缩完成 hook 先于受控响应")
    (root / "native-compaction-control-observation-ready.json").write_text(json.dumps({"socket_path": str(socket_path), "pre_compact": pre}))
    wait_until(lambda: (root / "native-compaction-control-observation-completed").exists(), "调用方没有完成实时控制面核验")
    release_compaction.set()
    wait_until(lambda: any(event["payload"].get("hook_event_name") == "PostCompact" for event in hooks()), "压缩完成 hook 不存在")
    wait_until(lambda: sum(event["payload"].get("hook_event_name") == "Stop" for event in hooks()) >= 2, "压缩后的第二回合未完成")
    post = next(event for event in hooks() if event["payload"].get("hook_event_name") == "PostCompact")
    if any(pre["payload"].get(key) != post["payload"].get(key) for key in ["session_id", "turn_id", "trigger"]):
        raise RuntimeError("开始/结束 hook 绑定不一致")
    result = {"binary_version": version, "submitted_at_ms": submitted_at_ms, "pre_compact": pre, "post_compact": post, "provider_requests": provider_observations}
    (root / "native-compaction-hook-capability-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print("NATIVE_AUTOMATIC_COMPACTION_HOOK_CAPABILITY_VERIFIED", json.dumps(result, ensure_ascii=False), flush=True)
finally:
    release_compaction.set()
    (root / "native-compaction-tui-output.log").write_bytes(output)
    (root / "native-compaction-provider-observations.json").write_text(json.dumps(provider_observations, ensure_ascii=False, indent=2))
    close_owned_child(child)
    close_owned_child(app_server)
    app_server_output.close()
    provider.shutdown()
    provider.server_close()
    os.close(master)
