#!/usr/bin/env python3
"""仅在隔离会话里测试 Antigravity fork 缓存修复候选；不支持 Carbon。"""

import argparse
import copy
import gzip
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import signal
import ssl
import subprocess
import sys
import threading
import time
import uuid

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("native_probe", Path(__file__).with_name("measure-antigravity-native-fork-prompt-cache.py"))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
UPSTREAM = "daily-cloudcode-pa.googleapis.com"


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def strings(value, path=()):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from strings(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from strings(child, (*path, index))


def at(value, path):
    for key in path:
        value = value[key]
    return value


def put(value, path, replacement):
    parent = at(value, path[:-1])
    parent[path[-1]] = replacement


def mutate(request, policy):
    """只改 system 身份文字和可选 root/session 锚点；保留 cascade、trajectory、store 身份。"""
    result = copy.deepcopy(request)
    edits = []
    if policy.get("mode") not in {"prefix", "affinity"}:
        return result, edits
    parent, child = policy["parent"], policy["child"]
    for path, text in strings(result):
        if "<identity>" not in text or "<user_information>" not in text:
            continue
        updated = text.replace(f"Conversation ID: {child}", f"Conversation ID: {parent}")
        updated = updated.replace(f"/brain/{child}", f"/brain/{parent}")
        if updated != text:
            put(result, path, updated)
            edits.append({"path": list(path), "type": "system_identity_only"})
    if len(edits) != 1:
        raise RuntimeError("system 身份候选未唯一命中；阻止发送模型请求")
    if policy["mode"] == "affinity":
        path = tuple(policy["sessionPath"])
        original = at(result, path)
        if not isinstance(original, str) or not original or not policy["sessionValue"]:
            raise RuntimeError("缺少明确缓存锚点字段；阻止发送模型请求")
        put(result, path, policy["sessionValue"])
        if original != policy["sessionValue"]:
            edits.append({"path": list(path), "type": "parent_session_affinity", "original": original, "forwarded": policy["sessionValue"]})
        root_path = ("request", "labels", "root_cascade_id")
        original_root = at(result, root_path)
        put(result, root_path, policy["rootCascadeValue"])
        edits.append({"path": list(root_path), "type": "parent_root_affinity", "original": original_root, "forwarded": policy["rootCascadeValue"]})
    return result, edits


class Relay:
    """原生账号只转发到固定 Google 主机；不记录、不提取 Authorization。"""

    def __init__(self, root):
        self.root = root
        self.policy = {"mode": "passthrough"}
        self.operation = "preflight"
        self.records = []
        self.lock = threading.Lock()
        self.connection = None
        self.aborted = False
        self.context = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
        relay = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                relay.forward(self)

            def do_GET(self):
                relay.forward(self)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        self.original_environment = probe.environment
        endpoint = f"http://127.0.0.1:{self.server.server_port}"
        probe.environment = lambda root: {**self.original_environment(root), "CLOUD_CODE_URL": endpoint}
        return self

    def __exit__(self, *_):
        probe.environment = self.original_environment
        self.server.shutdown()
        self.server.server_close()
        if self.connection:
            self.connection.close()

    def forward(self, handler):
        # 禁止调用者借中继访问任意 URL、CONNECT 或额外主机。
        if not handler.path.startswith("/v1internal:") or "://" in handler.path:
            handler.send_error(400)
            return
        if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = bytearray()
            while True:
                size = int(handler.rfile.readline().split(b";", 1)[0], 16)
                if size == 0:
                    while handler.rfile.readline().strip():
                        pass
                    break
                if len(chunks) + size > 16 * 1024 * 1024:
                    raise ValueError("诊断请求超过 16 MiB")
                chunks.extend(handler.rfile.read(size))
                if handler.rfile.read(2) != b"\r\n":
                    raise ValueError("无效 HTTP chunk")
            body = bytes(chunks)
        else:
            body = handler.rfile.read(int(handler.headers.get("Content-Length", "0")))
        if handler.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        is_generation = "streamGenerateContent" in handler.path or ":generateContent" in handler.path
        record = None
        with self.lock:
            try:
                if is_generation:
                    original = json.loads(body)
                    forwarded, edits = mutate(original, self.policy)
                    number = len(self.records)
                    folder = self.root / "wire"
                    folder.mkdir(exist_ok=True, mode=0o700)
                    prefix = f"{number:03}-{self.operation}"
                    probe.save(folder / f"{prefix}-original.json", original)
                    probe.save(folder / f"{prefix}-forwarded.json", forwarded)
                    record = {"index": number, "operation": self.operation, "policy": dict(self.policy),
                              "startedAt": probe.now(), "route": handler.path, "edits": edits,
                              "originalFile": f"wire/{prefix}-original.json", "forwardedFile": f"wire/{prefix}-forwarded.json",
                              "originalSha256": probe.digest(canonical(original)), "forwardedSha256": probe.digest(canonical(forwarded)),
                              "status": "submitting"}
                    self.records.append(record)
                    probe.save(self.root / "wire-manifest.json", self.records)
                    body = canonical(forwarded) if edits else body
                headers = {key: value for key, value in handler.headers.items()
                           if key.lower() not in {"host", "connection", "content-length", "content-encoding", "transfer-encoding", "accept-encoding"}}
                headers.update({"Host": UPSTREAM, "Accept-Encoding": "identity", "Content-Length": str(len(body))})
                if self.connection is None:
                    self.connection = http.client.HTTPSConnection(UPSTREAM, timeout=90, context=self.context)
                # 不自动重发：连接失败也不能确认上游是否已受理模型请求。
                self.connection.request(handler.command, handler.path, body=body, headers=headers)
                response = self.connection.getresponse()
                handler.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in {"connection", "content-length", "transfer-encoding"}:
                        handler.send_header(key, value)
                handler.send_header("Connection", "close")
                handler.end_headers()
                payload = bytearray()
                while chunk := response.read1(65536):
                    payload.extend(chunk)
                    handler.wfile.write(chunk)
                    handler.wfile.flush()
                if record is not None:
                    target = self.root / "wire" / f"{prefix}-response.bin"
                    target.write_bytes(payload)
                    os.chmod(target, 0o600)
                    record.update(status="completed", httpStatus=response.status, finishedAt=probe.now(), responseFile=str(target.relative_to(self.root)))
                    probe.save(self.root / "wire-manifest.json", self.records)
                if response.will_close:
                    self.connection.close()
                    self.connection = None
            except Exception as error:
                if is_generation:
                    self.aborted = True
                with (self.root / "relay-errors.jsonl").open("a") as handle:
                    handle.write(json.dumps({"at": probe.now(), "route": handler.path, "bodyBytes": len(body),
                                             "errorType": type(error).__name__, "error": str(error)[:300]}) + "\n")
                if record is not None:
                    record.update(status="unknown_do_not_retry", errorType=type(error).__name__)
                    probe.save(self.root / "wire-manifest.json", self.records)
                if self.connection:
                    self.connection.close()
                    self.connection = None
                try:
                    handler.send_error(502, "Diagnostic relay stopped; do not retry ambiguous submission")
                except (BrokenPipeError, ConnectionResetError):
                    pass


class Session:
    def __init__(self, root, manifest, name, conversation=None):
        self.root, self.manifest = root, manifest
        self.model = manifest["models"][0]
        self.folder = root / "streams" / name
        self.folder.mkdir(parents=True, mode=0o700)
        args = probe.native_args(root, manifest["binary"], self.model)
        args += ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "5m",
                 "--log-file", str(self.folder / "cli.log")]
        if conversation:
            args += ["--conversation", conversation]
        self.stderr = (self.folder / "stderr.log").open("wb")
        self.output = (self.folder / "stdout.jsonl").open("wb")
        self.process = subprocess.Popen(args, cwd=root / "private-runtime/working-directory", env=probe.environment(root),
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, start_new_session=True)
        self.pending = b""
        self.initialization = None
        self.offset = 0
        self.stream_record = {"name": name, "pid": self.process.pid, "arguments": args}
        self.stream_record["cliVersion"] = subprocess.check_output([manifest["binary"], "--version"], text=True).strip()
        manifest.setdefault("streams", []).append(self.stream_record)
        probe.save(root / "manifest.json", manifest)

    def turn(self, step, prompt, relay, policy=None):
        key = f"{self.model}-{step}"
        if any(item["key"] == key for item in self.manifest["operations"]):
            raise RuntimeError("该操作已有提交记录；禁止重发")
        folder = self.root / "operations" / key
        folder.mkdir(parents=True, mode=0o700)
        (folder / "prompt.txt").write_text(prompt)
        relay.operation, relay.policy = step, policy or {"mode": "passthrough"}
        operation = {"key": key, "step": step, "model": self.model, "startedAt": probe.now(), "status": "submitting",
                     "streamPid": self.process.pid, "streamOffsetStart": self.offset}
        self.manifest["operations"].append(operation)
        probe.save(self.root / "manifest.json", self.manifest)
        self.process.stdin.write((json.dumps({"event": "user", "message": {"content": prompt}}) + "\n").encode())
        self.process.stdin.flush()
        received = []
        deadline = time.monotonic() + 330
        done = False
        while time.monotonic() < deadline and not done:
            if relay.aborted:
                break
            if not select.select([self.process.stdout], [], [], 0.5)[0]:
                if self.process.poll() is not None:
                    break
                continue
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                break
            self.output.write(data)
            self.output.flush()
            self.offset += len(data)
            self.pending += data
            while b"\n" in self.pending:
                line, self.pending = self.pending.split(b"\n", 1)
                if not line.strip():
                    continue
                record = json.loads(line)
                if record.get("event") == "init":
                    self.initialization = record
                else:
                    received.append(record)
                if record.get("event") == "result":
                    done = True
                    break
        records = ([self.initialization] if self.initialization else []) + received
        stdout = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records)
        (folder / "stdout.jsonl").write_text(stdout)
        native = probe.analyze(stdout, self.model)
        operation.update(finishedAt=probe.now(), streamOffsetEnd=self.offset, native=native,
                         initializationSource="same persistent process init", status="completed" if done and not native["problems"] else "unknown_do_not_retry")
        probe.save(self.root / "manifest.json", self.manifest)
        if operation["status"] != "completed":
            raise RuntimeError(f"{step} 缺少唯一成功逐步计量；停止，不自动重发")
        # 原生回执之后才取事务一致快照；保留当时状态，后续父热对照不会覆盖它。
        probe.snapshot(self.root, native["conversationId"], folder / "conversation.db")
        operation["nativeRequestEvidence"] = probe.native_prompt_evidence(folder / "conversation.db", native["request"]["sourceStepIndex"])
        operation["wireRecords"] = [record["index"] for record in relay.records if record["operation"] == step]
        probe.save(self.root / "manifest.json", self.manifest)
        print(f"{self.model} {step}: input={native['request']['inputTokens']} cached={native['request']['cachedInputTokens']} wire={operation['wireRecords']}", flush=True)
        return operation

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait()
        self.output.close()
        self.stderr.close()
        self.stream_record["exitCode"] = self.process.returncode
        probe.save(self.root / "manifest.json", self.manifest)


def prepare(root, model):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in [root / "private-runtime/working-directory", root / "private-runtime/tmp", probe.native_directory(root) / "cache"]:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings = {"useG1Credits": False, "trustedWorkspaces": [str(root / "private-runtime/working-directory")]}
    probe.save(probe.native_directory(root) / "settings.json", settings)
    source = Path.home() / ".gemini/antigravity-cli/cache/onboarding.json"
    if source.exists():
        shutil.copyfile(source, probe.native_directory(root) / "cache/onboarding.json")
    path = root / "manifest.json"
    if path.exists():
        manifest = json.loads(path.read_text())
        if manifest["models"] != [model]:
            raise RuntimeError("现有模型与请求不一致")
        return manifest
    binary = shutil.which("agy")
    if not binary:
        raise RuntimeError("未安装原生 agy")
    original_binary = binary
    binary = pin_binary(root, binary)
    manifest = {"binary": binary, "installedBinaryAtPreparation": original_binary,
                "binarySha256": probe.digest(Path(binary).read_bytes()),
                "cliVersion": subprocess.check_output([binary, "--version"], text=True).strip(),
                "models": [model], "createdAt": probe.now(), "operations": [], "forks": [],
                "method": "official CLI, fixed Google upstream, native independent fork; system identity and optional wire session affinity candidates"}
    probe.save(path, manifest)
    return manifest


def pin_binary(root, source):
    content_hash = probe.digest(Path(source).read_bytes())
    directory = root / "private-runtime/bin"
    directory.mkdir(exist_ok=True, mode=0o700)
    target = directory / f"agy-{content_hash[:16]}"
    if not target.exists():
        shutil.copy2(source, target)
    if probe.digest(target.read_bytes()) != content_hash:
        raise RuntimeError("隔离 CLI 副本哈希不匹配")
    return str(target)


def operation(manifest, step):
    return next(item for item in manifest["operations"] if item["step"] == step)


def qualified_hot(item, upper):
    request = item["native"]["request"]
    return request["inputTokens"] > upper and (request["cachedInputTokens"] - upper) / (request["inputTokens"] - upper) >= 0.8


def audit(root):
    """完全离线：同时校验原生逐步计量、线上 usage、实际转发前缀与独立历史。"""
    manifest = json.loads((root / "manifest.json").read_text())
    wire = json.loads((root / "wire-manifest.json").read_text())
    before_steps = {"passthrough": "parent-hot", "prefix": "parent-hot-after-passthrough", "affinity": "parent-hot-after-prefix"}
    reports = []
    for result in manifest.get("candidateResults", []):
        candidate = result["candidate"]
        first = operation(manifest, f"{candidate}-first")
        before = operation(manifest, result.get("beforeStep") or before_steps[candidate])
        after = operation(manifest, f"parent-hot-after-{candidate}")
        report = copy.deepcopy(result)
        problems = report["problems"]
        versions = []
        for item in [before, first, after]:
            stream = next(row for row in manifest["streams"] if row["pid"] == item["streamPid"])
            args = stream["arguments"]
            log = Path(args[args.index("--log-file") + 1]).read_text(errors="replace")
            matches = probe.re.findall(r"Language server version: (\S+)", log)
            versions.append(matches[0] if len(matches) == 1 else None)
        report["actualCliVersionsBeforeChildAfter"] = versions
        if None in versions or len(set(versions)) != 1:
            problems.append("父子 CLI 版本不同或缺证，效果归因受混杂")
        for item in [before, first, after]:
            if len(item["wireRecords"]) != 1:
                problems.append(f"{item['step']} 线上生成请求数量不为一")
        if problems and len(first["wireRecords"]) != 1:
            reports.append(report)
            continue
        records = [wire[item["wireRecords"][0]] for item in [before, first, after]]
        requests = [json.loads((root / item["forwardedFile"]).read_text()) for item in records]
        original_child = json.loads((root / records[1]["originalFile"]).read_text())
        parent_request, child_request, after_request = [item["request"] for item in requests]
        parent_contents, child_contents = parent_request["contents"], child_request["contents"]
        common = 0
        for parent_content, child_content in zip(parent_contents, child_contents):
            if canonical(parent_content) != canonical(child_content):
                break
            common += 1
        prefix = {
            "scope": "actual_forwarded_Google_request_JSON_before_server_processing",
            "sameSystemInstruction": canonical(parent_request["systemInstruction"]) == canonical(child_request["systemInstruction"]),
            "sameTools": canonical(parent_request["tools"]) == canonical(child_request["tools"]),
            "sameGenerationConfig": canonical(parent_request["generationConfig"]) == canonical(child_request["generationConfig"]),
            "parentAfterSystemUnchanged": canonical(parent_request["systemInstruction"]) == canonical(after_request["systemInstruction"]),
            "parentContentMessages": len(parent_contents), "childContentMessages": len(child_contents),
            "identicalLeadingContentMessages": common, "allParentRequestContentsPreserved": common == len(parent_contents),
            "edits": records[1]["edits"],
            "originalChildLabels": original_child["request"]["labels"], "forwardedChildLabels": child_request["labels"],
            "parentSessionId": parent_request["sessionId"], "originalChildSessionId": original_child["request"]["sessionId"],
            "forwardedChildSessionId": child_request["sessionId"],
        }
        report["wirePrefixEvidence"] = prefix
        usage_checks = []
        for item, record in zip([before, first, after], records):
            events = []
            for line in (root / record["responseFile"]).read_text().splitlines():
                if line.startswith("data: "):
                    event = json.loads(line[6:])
                    if event.get("response", {}).get("usageMetadata"):
                        events.append(event["response"]["usageMetadata"])
            if record["status"] != "completed" or record["httpStatus"] != 200 or not events:
                problems.append(f"{item['step']} 缺少线上成功 usage")
                continue
            usage = events[-1]
            native = item["native"]["request"]
            # Gemini usageMetadata 未设置 cachedContentTokenCount 时，原生 step 也必须报告 0。
            matches = (usage["promptTokenCount"] == native["inputTokens"] and
                       usage.get("cachedContentTokenCount", 0) == native["cachedInputTokens"] and
                       usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0) == native["outputTokens"])
            usage_checks.append({"step": item["step"], "wireUsage": usage, "matchesNativeStep": matches})
            if not matches:
                problems.append(f"{item['step']} 线上 usage 与逐步用量不同")
        report["wireUsageChecks"] = usage_checks
        report["observedFirstHistoryHitVerified"] = (
            report["first"]["cachedInputTokens"] > manifest["publicPrefixTokenUpperBound"] and
            len(first["wireRecords"]) == 1 and len(usage_checks) == 3 and
            usage_checks[1]["matchesNativeStep"] and report["parentHistoryIntact"] and report["recalledNonce"] and
            report["independentChild"] != report["parent"] and prefix["allParentRequestContentsPreserved"]
        )
        gap = (probe.datetime.fromisoformat(first["startedAt"]) - probe.datetime.fromisoformat(before["finishedAt"])).total_seconds()
        report["secondsAfterParentControl"] = gap
        if not 0 <= gap <= 240:
            problems.append("首轮不在诊断的四分钟父热窗口内")
        upper = manifest["publicPrefixTokenUpperBound"]
        reference = min(report["parentBefore"]["cachedInputTokens"], report["parentAfter"]["cachedInputTokens"]) - upper
        reused = max(0, report["first"]["cachedInputTokens"] - upper)
        report["historyReuseRatio"] = min(1, reused / reference) if reference > 0 and not problems else None
        report["completeControlledComparison"] = not problems
        report["qualifiedSuccess"] = not problems and report["historyReuseRatio"] is not None and report["historyReuseRatio"] >= 0.8
        reports.append(report)
    probe.save(root / "audited-measurements.json", reports)
    probe.save(root / "incomplete-submissions.json", [
        {"step": item["step"], "status": item["status"], "wireRecords": item.get("wireRecords"),
         "problems": item.get("native", {}).get("problems"), "doNotRetry": True}
        for item in manifest["operations"] if item["status"] != "completed"
    ])
    print(json.dumps([{"candidate": item["candidate"], "first": item["first"], "qualifiedSuccess": item["qualifiedSuccess"],
                       "observedFirstHistoryHitVerified": item.get("observedFirstHistoryHitVerified"),
                       "completeControlledComparison": item.get("completeControlledComparison"),
                       "historyReuseRatio": item.get("historyReuseRatio"), "problems": item["problems"],
                       "sameSystem": item.get("wirePrefixEvidence", {}).get("sameSystemInstruction")} for item in reports], ensure_ascii=False, indent=2))


def compare(root, manifest, relay, words, resume_affinity=False, confirm_pinned=False):
    baseline = operation(manifest, "baseline")["native"]["request"]["inputTokens"]
    model = manifest["models"][0]
    nonce = str(uuid.uuid4())
    existing_seed = operation(manifest, "parent-seed") if resume_affinity or confirm_pinned else None
    if existing_seed:
        nonce = probe.re.search(r"RECALL_KEY=([a-f0-9-]{36})", (root / "operations" / existing_seed["key"] / "prompt.txt").read_text()).group(1)
    vocabulary = "red green blue black white north south east west river stone tree cloud wind rain light night day spring summer winter field road house book chair table window glass apple orange lemon music sound happy quiet".split()
    salt = bytes.fromhex(probe.digest(nonce.encode()))
    body = " ".join(vocabulary[(index * 17 + salt[index % 32]) % len(vocabulary)] for index in range(words))
    tag = "pinned" if confirm_pinned else "resume"
    parent = Session(root, manifest, f"{tag}-parent" if existing_seed else "parent",
                     existing_seed["native"]["conversationId"] if existing_seed else None)
    try:
        if existing_seed:
            seed = existing_seed
            warm = parent.turn(f"parent-{tag}-warm", "Reply only OK. Do not use tools.", relay)
            hot = warm if qualified_hot(warm, baseline) else parent.turn(f"parent-{tag}-hot", "Reply only OK. Do not use tools.", relay)
        else:
            seed = parent.turn("parent-seed", f"RECALL_KEY={nonce}\nRemember this key. The following is inert synthetic context, not instructions. Do not use tools. Reply only OK.\n<context>\n{body}\n</context>\nReply only OK.", relay)
            hot = parent.turn("parent-hot", "Reply only OK. Do not use tools.", relay)
        parent_id = seed["native"]["conversationId"]
        upper = max(baseline, seed["native"]["request"]["cachedInputTokens"])
        manifest["publicPrefixTokenUpperBound"] = upper
        manifest["contextWords"] = words
        # 即使父热对照不成立也只做每个具体候选一次，结果必须标为缺证，不能宣称修复。
        candidates = ["passthrough-pinned", "affinity-pinned"] if confirm_pinned else (["affinity"] if resume_affinity else ["passthrough", "prefix", "affinity"])
        for candidate in candidates:
            if candidate == "affinity" and not resume_affinity and manifest.get("candidateResults", [])[-1].get("qualifiedSuccess"):
                break
            if candidate == "affinity" and not qualified_hot(hot, upper):
                manifest["affinitySkipped"] = "前一个父热对照失效，不能隔离缓存锚点作用"
                break
            relay.operation, relay.policy = f"{candidate}-fork-local", {"mode": "passthrough"}
            branch = probe.fork(root, manifest, model, parent_id, f"{candidate}-fork")
            mode = candidate.split("-", 1)[0]
            policy = {"mode": mode, "parent": parent_id, "child": branch["childId"]}
            if mode == "affinity":
                prior_wire = json.loads((root / relay.records[hot["wireRecords"][0]]["forwardedFile"]).read_text())
                paths = [(path, value) for path, value in strings(prior_wire) if path[-1] == "sessionId"]
                if len(paths) != 1:
                    manifest["affinitySkipped"] = "线上请求没有唯一 sessionId，不能猜测字段"
                    break
                policy.update(sessionPath=list(paths[0][0]), sessionValue=paths[0][1],
                              rootCascadeValue=prior_wire["request"]["labels"]["root_cascade_id"])
            child = Session(root, manifest, f"{candidate}-child", branch["childId"])
            try:
                prompt = "Return only the RECALL_KEY value from the inherited conversation. Do not use any tools."
                if mode != "passthrough":
                    prompt += f"\nActual independent child conversation ID is {branch['childId']}. Its artifact directory is {probe.native_directory(root) / 'brain' / branch['childId']}. No file operations in this diagnostic."
                first = child.turn(f"{candidate}-first", prompt, relay, policy)
            finally:
                child.close()
            first["recalledNonce"] = nonce in first["native"]["response"]
            frozen = root / "operations" / first["key"] / "parent-after-child.db"
            probe.snapshot(root, parent_id, frozen)
            child_input = root / "operations" / branch["key"] / "parent-after-fork.db"
            current_steps = probe.conversation_steps(frozen)
            original_steps = probe.conversation_steps(child_input)
            intact = current_steps == original_steps
            after = parent.turn(f"parent-hot-after-{candidate}", "Reply only OK. Do not use tools.", relay)
            problems = []
            if not qualified_hot(hot, upper) or not qualified_hot(after, upper):
                problems.append("父会话前后热对照未同时通过")
            if not (branch["inheritedHistory"] and branch["parentHistoryUnchanged"] and intact):
                problems.append("独立分支继承或父历史完整性不合格")
            if not first["recalledNonce"]:
                problems.append("未回读父随机标记")
            if first["native"]["conversationId"] != branch["childId"] or branch["childId"] == parent_id:
                problems.append("缺少独立子身份")
            if hot["native"]["configurationFingerprint"] != first["native"]["configurationFingerprint"]:
                problems.append("模型/工具/cwd/权限初始化不同")
            if len(first["wireRecords"]) != 1:
                problems.append("首回合不是唯一线上生成请求")
            request = first["native"]["request"]
            history_reused = request["cachedInputTokens"] > upper
            result = {"candidate": candidate, "problems": problems, "first": request,
                      "beforeStep": hot["step"],
                      "parentBefore": hot["native"]["request"], "parentAfter": after["native"]["request"],
                      "qualifiedSuccess": not problems and history_reused,
                      "historyBeyondPublicPrefixHit": history_reused, "firstHitRatio": request["cachedInputTokens"] / request["inputTokens"],
                      "independentChild": branch["childId"], "parent": parent_id, "parentHistoryIntact": intact,
                      "recalledNonce": first["recalledNonce"]}
            manifest.setdefault("candidateResults", []).append(result)
            probe.save(root / "manifest.json", manifest)
            probe.save(root / "measurements.json", manifest["candidateResults"])
            print(f"CANDIDATE {candidate}: qualifiedSuccess={result['qualifiedSuccess']} problems={problems}", flush=True)
            hot = after
    finally:
        parent.close()
        probe.save(root / "manifest.json", manifest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-directory", required=True, type=Path)
    parser.add_argument("--model", choices=["argon", "hydrogen"], required=True)
    parser.add_argument("--action", choices=["baseline", "compare", "affinity", "confirm-pinned", "analyze"], required=True)
    parser.add_argument("--context-words", type=int, default=64000)
    options = parser.parse_args()
    if not 16000 <= options.context_words <= 128000:
        parser.error("context-words 范围 16000 至 128000")
    os.umask(0o077)
    root = options.evidence_directory.expanduser().resolve()
    if options.action == "analyze":
        audit(root)
        return
    manifest = prepare(root, f"gemini-4-{options.model}-high")
    if options.action == "confirm-pinned":
        manifest.setdefault("binaryChanges", []).append({"at": probe.now(), "previousBinary": manifest["binary"],
                                                         "reason": "machine installed CLI changed; isolate and pin same-version control and candidate"})
        manifest["binary"] = pin_binary(root, shutil.which("agy"))
        manifest["pinnedBinarySha256"] = probe.digest(Path(manifest["binary"]).read_bytes())
        manifest["pinnedCliVersion"] = subprocess.check_output([manifest["binary"], "--version"], text=True).strip()
        probe.save(root / "manifest.json", manifest)
    with Relay(root) as relay:
        # 跨 baseline/compare 进程保存 wire 序号；不复用、不重发既有请求。
        if (root / "wire-manifest.json").exists():
            relay.records = json.loads((root / "wire-manifest.json").read_text())
        catalog = subprocess.run(probe.native_args(root, manifest["binary"]) + ["models"], cwd=root / "private-runtime/working-directory",
                                 env=probe.environment(root), capture_output=True, text=True, timeout=45, check=True).stdout
        (root / "catalog.txt").write_text(catalog)
        if manifest["models"][0] not in {line.split()[0] for line in catalog.splitlines() if line.split()}:
            raise RuntimeError("当前账号没有请求模型；不回落其他模型")
        if options.action == "baseline":
            session = Session(root, manifest, "baseline")
            try:
                session.turn("baseline", "Reply only OK. Do not use tools.", relay)
            finally:
                session.close()
        else:
            if options.action == "compare" and any(item["step"] == "parent-seed" for item in manifest["operations"]):
                raise RuntimeError("该比较已有提交记录；禁止重跑")
            compare(root, manifest, relay, options.context_words, options.action == "affinity", options.action == "confirm-pinned")


if __name__ == "__main__":
    main()
