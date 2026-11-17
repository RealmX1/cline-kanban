#!/usr/bin/env python3
"""隔离 Antigravity 会话的单组缓存诊断；Carbon 必须显式选择，prepare 不发模型请求。"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import pty
import select
import shutil
import signal
import sqlite3
import subprocess
import sys
import struct
import termios
import time
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def proto_varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError("原生 protobuf varint 超界")


def proto_fields(data):
    # 仅读取私有诊断快照中的 wire 字段；没有 protobuf schema，不推测其他字段语义。
    fields = []
    offset = 0
    while offset < len(data):
        key, offset = proto_varint(data, offset)
        number, wire = key >> 3, key & 7
        if number < 1:
            raise ValueError("原生 protobuf 字段号无效")
        if wire == 0:
            value, offset = proto_varint(data, offset)
        elif wire in {1, 2, 5}:
            if wire == 2:
                size, offset = proto_varint(data, offset)
            else:
                size = 8 if wire == 1 else 4
            value = data[offset:offset + size]
            offset += size
        else:
            raise ValueError("未支持的原生 protobuf wire 类型")
        if offset > len(data):
            raise ValueError("原生 protobuf 长度越界")
        fields.append((number, wire, value))
    return fields


def native_prompt_evidence(database, step_index):
    """解码已观察的 agy 1.5.9 gen_metadata 布局；只是本地记录，不冒充 HTTP 请求抓包。"""
    try:
        candidates = []
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
            for generation, data in connection.execute("SELECT idx, data FROM gen_metadata ORDER BY idx"):
                fields = proto_fields(data)
                step_indices = []
                for number, wire, value in fields:
                    if number == 2 and wire == 2:
                        offset = 0
                        while offset < len(value):
                            index, offset = proto_varint(value, offset)
                            step_indices.append(index)
                if step_index not in step_indices:
                    continue
                for number, wire, value in fields:
                    if number != 1 or wire != 2:
                        continue
                    for inner_number, inner_wire, text in proto_fields(value):
                        if inner_number == 1 and inner_wire == 2:
                            prompt = text.decode("utf-8")
                            if prompt.startswith("<identity>") and "<user_information>" in prompt:
                                candidates.append((generation, prompt))
        if len(candidates) != 1:
            raise ValueError("没有与本次 step 唯一绑定的 system prompt，布局可能变化")
        generation, prompt = candidates[0]
        normalized = re.sub(r"(?<=Conversation ID: )[a-f0-9-]{36}", "<CONVERSATION>", prompt)
        normalized = re.sub(r"(?<=/brain/)[a-f0-9-]{36}", "<CONVERSATION>", normalized)
        return {
            "status": "captured", "scope": "locally_recorded_system_prompt_not_wire_capture",
            "sourceGenerationIndex": generation, "sourceStepIndex": step_index,
            "systemPromptSha256": digest(prompt.encode()), "systemPromptCharacters": len(prompt),
            "normalizedSystemPromptSha256": digest(normalized.encode()),
            "normalizationDiagnosticOnly": True,
        }
    except (ValueError, IndexError, UnicodeDecodeError, sqlite3.DatabaseError) as error:
        return {"status": "unavailable", "reason": str(error)}


def save(path, data):
    temporary = path.with_name(path.name + ".writing")
    with temporary.open("w", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def analyze(stdout, expected_model=None):
    records = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    results = [row["result"] for row in records if row.get("event") == "result"]
    initializations = [row for row in records if row.get("event") == "init"]
    problems = []
    if len(results) != 1 or results[0].get("status") != "SUCCESS":
        problems.append("没有唯一成功 result")
    if len(initializations) != 1 or not initializations[0].get("init", {}).get("model"):
        problems.append("没有唯一原生模型初始化回执")
    elif expected_model and initializations[0]["init"]["model"] != expected_model:
        problems.append("原生 init 模型与请求模型不同")
    steps = {}
    for row in records:
        step = row.get("step_update", {})
        if step.get("state") == "DONE":
            steps[step["step_index"]] = step
    main = [step for step in steps.values() if step.get("step_type") == "agent_response"]
    if len(main) != 1:
        problems.append("没有唯一主 agent_response，不能把多次请求合计当首轮")
    if any(step.get("step_type") in {"tool", "compaction", "subagent"} or step.get("subagent_info") for step in steps.values()):
        problems.append("本次发生工具、子代理或压缩")
    step = main[0] if len(main) == 1 else {}
    usage = step.get("usage", {})
    keys = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"]
    if not all(type(usage.get(key)) is int and usage[key] >= 0 for key in keys):
        problems.append("逐步 usage 字段缺失，不能用零补齐")
    request = None
    if not problems:
        # agy 的 input_tokens 排除 cache_read_tokens；result.usage 是累计值，不能当本次请求。
        total_input = usage["input_tokens"] + usage["cache_read_tokens"]
        if total_input <= 0:
            problems.append("总输入无效")
        request = {
            "inputTokens": total_input,
            "uncachedInputTokens": usage["input_tokens"],
            "cachedInputTokens": usage["cache_read_tokens"],
            "outputTokens": usage["output_tokens"],
            "thinkingTokens": usage["thinking_tokens"],
            "sourceStepIndex": step["step_index"],
        }
    result = results[0] if len(results) == 1 else {}
    initialization = initializations[0] if len(initializations) == 1 else {}
    config = initialization.get("init", {})
    if step and step.get("conversation_id") != result.get("conversation_id"):
        problems.append("步骤与结果的原生会话身份不一致")
    if initialization.get("conversation_id") != result.get("conversation_id"):
        problems.append("模型初始化与结果的原生会话身份不一致")
    return {
        "problems": problems,
        "request": request,
        "conversationId": result.get("conversation_id"),
        "response": result.get("response"),
        "model": config.get("model"),
        "configurationFingerprint": digest(json.dumps(config, sort_keys=True).encode()),
        "configurationFingerprintScope": "native_init_model_tools_cwd_permissions_only",
        "permissionMode": config.get("permission_mode"),
        "cumulativeResultUsage": result.get("usage"),
        "otherCompletedSteps": [step for step in steps.values() if step.get("step_type") != "agent_response"],
    }


def environment(root):
    # 保留真实 HOME 仅供原生账号/keyring 使用；所有会话、配置、缓存与日志由原生目录参数隔离。
    allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
               "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]
    return {**{key: os.environ[key] for key in allowed if key in os.environ},
            "TMPDIR": str(root / "private-runtime/tmp"), "TERM": "xterm-256color",
            "AGY_CLI_DISABLE_AUTO_UPDATE": "1"}


def native_args(root, binary, model=None):
    args = [binary, "--gemini_dir", str(root / "private-runtime/home/.gemini"),
            "--app_data_dir", "antigravity-cli", "--settings", '{"useG1Credits":false}']
    if model:
        args += ["--model", model, "--effort", "high"]
    return args


def native_directory(root):
    return root / "private-runtime/home/.gemini/antigravity-cli"


def snapshot(root, conversation_id, destination):
    source = native_directory(root) / "conversations" / f"{conversation_id}.db"
    if not source.exists():
        raise RuntimeError("本次原生 ID 没有对应的私有会话 store")
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as original, sqlite3.connect(destination) as copy:
        original.backup(copy)
    os.chmod(destination, 0o600)
    return source


def collect(root, operation):
    folder = root / "operations" / operation["key"]
    operation["native"] = analyze((folder / "stdout.jsonl").read_text(), operation["model"])
    if operation["exitCode"] != 0 or operation["native"]["problems"]:
        raise RuntimeError(f"{operation['key']} 缺乏成功计量；查看私有 stdout/stderr，不自动重发")
    target = folder / "conversation.db"
    if not target.exists():
        snapshot(root, operation["native"]["conversationId"], target)
    operation["nativeRequestEvidence"] = native_prompt_evidence(target, operation["native"]["request"]["sourceStepIndex"])
    return operation


def invoke(root, manifest, model, step, prompt, parent=None):
    key = f"{model}-{step}"
    old = next((item for item in manifest["operations"] if item["key"] == key), None)
    if old:
        if old.get("status") != "completed":
            raise RuntimeError(f"{key} 提交状态未知，禁止重发")
        return collect(root, old)
    folder = root / "operations" / key
    folder.mkdir(parents=True, mode=0o700)
    (folder / "prompt.txt").write_text(prompt)
    args = native_args(root, manifest["binary"], model)
    args += ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "5m",
             "--log-file", str(folder / "cli.log")]
    if parent:
        args += ["--conversation", parent]
    # 私有 cwd 的原生缓存限定 project，不从真实工作目录恢复会话。
    operation = {"key": key, "step": step, "model": model, "prompt": prompt,
                 "status": "submitting", "startedAt": now(), "arguments": args}
    manifest["operations"].append(operation)
    save(root / "manifest.json", manifest)
    with (folder / "stdout.jsonl").open("wb") as out, (folder / "stderr.log").open("wb") as err:
        process = subprocess.Popen(args, cwd=root / "private-runtime/working-directory", env=environment(root),
                                   stdin=subprocess.PIPE, stdout=out, stderr=err, start_new_session=True)
        operation["pid"] = process.pid
        save(root / "manifest.json", manifest)
        try:
            process.communicate((json.dumps({"event": "user", "message": {"content": prompt}}) + "\n").encode(), timeout=330)
        except subprocess.TimeoutExpired:
            operation["timedOut"] = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        operation.update(exitCode=process.returncode, finishedAt=now(),
                         status="completed" if process.returncode == 0 else "unknown_do_not_retry")
        save(root / "manifest.json", manifest)
    collect(root, operation)
    save(root / "manifest.json", manifest)
    request = operation["native"]["request"]
    print(f"{key}: input={request['inputTokens']} cached={request['cachedInputTokens']}", flush=True)
    return operation


def fork(root, manifest, model, parent, fork_key="native-fork"):
    key = f"{model}-{fork_key}"
    old = next((item for item in manifest["forks"] if item["key"] == key), None)
    if old:
        if old.get("status") == "completed":
            return old
        if old.get("status") == "not_submitted_onboarding" and old.get("noNativeForkObserved"):
            return fork_pty(root, manifest, model, parent, old)
        if old.get("ptyStartedAt"):
            raise RuntimeError("PTY 创建状态未知，须先核对 native cache、store 与回执，禁止重发")
        rejection = root / "operations" / key / "stdout.txt"
        report = json.loads(rejection.read_text()) if rejection.exists() else {}
        if not (old.get("exitCode") == 2 and "/fork is not available in print mode" in report.get("error", "")
                and report.get("num_turns") == 0 and report.get("usage", {}).get("total_tokens") == 0):
            raise RuntimeError("原生 fork 提交状态未知，禁止重新创建")
        old["headlessRejection"] = dict(old)
        old["recoveryEvidence"] = "CLI 明确拒绝 print /fork，num_turns 与全部 usage 为零；改走原生 PTY，未重发模型回合"
        return fork_pty(root, manifest, model, parent, old)
    folder = root / "operations" / key
    folder.mkdir(parents=True, mode=0o700)
    args = native_args(root, manifest["binary"], model)
    args += ["--conversation", parent, "--log-file", str(folder / "cli.log")]
    operation = {"key": key, "parentId": parent, "startedAt": now(), "status": "prepared", "arguments": args}
    manifest["forks"].append(operation)
    save(root / "manifest.json", manifest)
    return fork_pty(root, manifest, model, parent, operation)


def conversation_steps(database):
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        return connection.execute("SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx").fetchall()


def fork_pty(root, manifest, model, parent, operation):
    folder = root / "operations" / operation["key"]
    before = folder / f"parent-before-fork-{time.time_ns()}.db"
    snapshot(root, parent, before)
    operation["parentBeforeSnapshot"] = str(before.relative_to(root))
    source_onboarding = Path.home() / ".gemini/antigravity-cli/cache/onboarding.json"
    target_onboarding = native_directory(root) / "cache/onboarding.json"
    if source_onboarding.exists():
        shutil.copyfile(source_onboarding, target_onboarding)
    args = native_args(root, manifest["binary"], model) + ["--conversation", parent,
            "--log-file", str(folder / "fork-pty-cli.log")]
    operation.update(arguments=args, status="submitting_pty", ptyStartedAt=now())
    save(root / "manifest.json", manifest)
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(root / "private-runtime/working-directory")
        os.execvpe(args[0], args, environment(root))
    operation["pid"] = pid
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    started = time.monotonic()
    sent = False
    pending_enter = None
    exit_started = None
    cache = native_directory(root) / "cache/last_conversations.json"
    operation["nativeIdsBefore"] = sorted(path.stem for path in (native_directory(root) / "conversations").glob("*.db"))
    exited = False
    try:
        with (folder / "fork.pty.log").open("wb") as log:
            while time.monotonic() - started < 55:
                ready = select.select([master], [], [], 0.1)[0]
                if ready:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    log.write(data)
                    log.flush()
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
                    if b"\x1b]11;?" in data:
                        os.write(master, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
                    if b"\x1b[c" in data:
                        os.write(master, b"\x1b[?1;2c")
                elapsed = time.monotonic() - started
                if not sent and elapsed >= 5:
                    os.write(master, b"/fork")
                    pending_enter = time.monotonic() + 0.5
                    sent = True
                    operation["forkCommandSentAt"] = now()
                    save(root / "manifest.json", manifest)
                if pending_enter is not None and time.monotonic() >= pending_enter:
                    os.write(master, b"\r")
                    pending_enter = None
                if sent and cache.exists() and not exit_started:
                    mapping = json.loads(cache.read_text())
                    child = mapping.get(str(root / "private-runtime/working-directory"))
                    if child and child != parent and child not in operation["nativeIdsBefore"]:
                        operation["childId"] = child
                        operation["identitySource"] = "原生 last_conversations.json 的当前 cwd 绑定，独立 store 与 /fork PTY 回执交叉核验"
                        operation["forkObservedAt"] = now()
                        save(root / "manifest.json", manifest)
                        os.write(master, b"/exit")
                        pending_enter = time.monotonic() + 0.5
                        exit_started = time.monotonic()
                waited, status = os.waitpid(pid, os.WNOHANG)
                if waited:
                    operation["ptyExitStatus"] = status
                    exited = True
                    break
                if exit_started and time.monotonic() - exit_started > 8:
                    break
    finally:
        if not exited:
            try:
                os.killpg(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            for _ in range(30):
                waited, status = os.waitpid(pid, os.WNOHANG)
                if waited:
                    operation["ptyExitStatus"] = status
                    exited = True
                    break
                time.sleep(0.1)
            if not exited:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                os.waitpid(pid, 0)
        os.close(master)
    if not operation.get("childId"):
        operation["status"] = "unknown_do_not_retry"
        save(root / "manifest.json", manifest)
        raise RuntimeError("PTY /fork 尚未确认独立子身份；保留原生证据，未发送分身首轮")
    child = folder / "child-before-first-turn.db"
    after = folder / "parent-after-fork.db"
    snapshot(root, operation["childId"], child)
    snapshot(root, parent, after)
    parent_steps = conversation_steps(before)
    child_steps = conversation_steps(child)
    operation["parentHistoryUnchanged"] = parent_steps == conversation_steps(after)
    operation["inheritedHistory"] = bool(parent_steps) and child_steps[:len(parent_steps)] == parent_steps
    operation.update(status="completed", finishedAt=now())
    save(root / "manifest.json", manifest)
    print(f"{model}: native PTY fork created independent child", flush=True)
    return operation


def summary(manifest):
    result = []
    for model in manifest["models"]:
        operations = {item["step"]: item for item in manifest["operations"] if item["model"] == model}
        if not all(key in operations and operations[key].get("native", {}).get("request") for key in
                   ["baseline", "parent-seed", "parent-hot", "fork-first"]):
            result.append({"model": model, "status": "insufficient_evidence", "reason": "步骤未完成"})
            continue
        baseline = operations["baseline"]["native"]["request"]
        seed = operations["parent-seed"]["native"]["request"]
        hot_operation = operations.get("parent-hot-refresh", operations["parent-hot"])
        hot = hot_operation["native"]["request"]
        hot_after_operation = operations.get("parent-hot-after")
        hot_after = hot_after_operation["native"]["request"] if hot_after_operation else None
        fork_operation = operations["fork-first"]
        child = operations["fork-first"]["native"]["request"]
        upper = max(baseline["inputTokens"], seed["cachedInputTokens"])
        problems = []
        if hot["inputTokens"] <= upper or (hot["cachedInputTokens"] - upper) / (hot["inputTokens"] - upper) < 0.8:
            problems.append("父热对照无效")
        if not hot_after or (hot_after["inputTokens"] <= upper or (hot_after["cachedInputTokens"] - upper) / (hot_after["inputTokens"] - upper) < 0.8):
            problems.append("分支后父热对照无效")
        branch = next((item for item in manifest["forks"] if item["key"] == f"{model}-native-fork"), {})
        if not branch.get("parentHistoryUnchanged") or not branch.get("inheritedHistory"):
            problems.append("父历史完整性或分支继承缺证")
        if branch.get("childId") != fork_operation["native"]["conversationId"] or branch.get("childId") == branch.get("parentId"):
            problems.append("子身份不匹配或没有独立分支")
        if hot_operation["native"].get("configurationFingerprint") != fork_operation["native"].get("configurationFingerprint"):
            problems.append("原生模型、工具、cwd 或权限配置发生变化")
        gap = (datetime.fromisoformat(fork_operation["startedAt"]) - datetime.fromisoformat(hot_operation["finishedAt"])).total_seconds()
        if not 0 <= gap <= 240:
            problems.append("首轮启动超出四分钟热对照窗口")
        if not operations["fork-first"].get("recalledNonce"):
            problems.append("未回读父随机标记")
        for operation in operations.values():
            problems.extend(operation.get("native", {}).get("problems", []))
        reference = min(hot["cachedInputTokens"], hot_after["cachedInputTokens"]) - upper if hot_after else 0
        parent_prompt = hot_operation.get("nativeRequestEvidence", {})
        child_prompt = fork_operation.get("nativeRequestEvidence", {})
        after_prompt = hot_after_operation.get("nativeRequestEvidence", {}) if hot_after_operation else {}
        prefix = {"scope": "locally_recorded_system_prompt_not_wire_capture", "fullRequestPrefixEquality": "not_tested"}
        if parent_prompt.get("status") == child_prompt.get("status") == "captured":
            prefix.update({
                "parentSystemPromptSha256": parent_prompt["systemPromptSha256"],
                "childSystemPromptSha256": child_prompt["systemPromptSha256"],
                "sameSystemPrompt": parent_prompt["systemPromptSha256"] == child_prompt["systemPromptSha256"],
                "equalAfterDiagnosticIdNormalization": parent_prompt["normalizedSystemPromptSha256"] == child_prompt["normalizedSystemPromptSha256"],
                "parentAfterSystemPromptMatchesBefore": None if after_prompt.get("status") != "captured" else parent_prompt["systemPromptSha256"] == after_prompt["systemPromptSha256"],
            })
        result.append({"model": model, "status": "measured" if not problems else "insufficient_evidence", "problems": problems,
                       "publicPrefixTokenUpperBound": upper, "parentHot": hot, "parentHotAfter": hot_after, "forkFirst": child,
                       "secondsAfterParentControl": gap, "parentHistoryUnchanged": branch.get("parentHistoryUnchanged"),
                       "inheritedHistory": branch.get("inheritedHistory"), "recalledNonce": fork_operation.get("recalledNonce"),
                       "forkHitRatio": child["cachedInputTokens"] / child["inputTokens"],
                       "requestPrefixEvidence": prefix,
                       "historyReuseRatio": None if problems else max(0, min(1,
                           (child["cachedInputTokens"] - upper) / reference))})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-directory", required=True, type=Path)
    parser.add_argument("--models", default="hydrogen,argon")
    parser.add_argument("--context-words", default=64000, type=int)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--analyze-only", action="store_true")
    parser.add_argument("--continue", dest="continue_run", action="store_true")
    options = parser.parse_args()
    root = options.evidence_directory.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if options.analyze_only:
        manifest = json.loads((root / "manifest.json").read_text())
        for operation in manifest["operations"]:
            operation["native"] = analyze((root / "operations" / operation["key"] / "stdout.jsonl").read_text(), operation["model"])
            stored = root / "operations" / operation["key"] / "conversation.db"
            if stored.exists() and operation["native"]["request"]:
                operation["nativeRequestEvidence"] = native_prompt_evidence(stored, operation["native"]["request"]["sourceStepIndex"])
        save(root / "manifest.json", manifest)
        report = summary(manifest)
        save(root / "measurements.json", report)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return
    families = options.models.split(",")
    if not families or len(set(families)) != len(families) or any(family not in {"hydrogen", "argon", "carbon"} for family in families):
        parser.error("models 只能为 hydrogen、argon、carbon，Carbon 必须显式选择")
    if not 16000 <= options.context_words <= 128000:
        parser.error("context-words 应为 16000 至 128000")
    models = [f"gemini-4-{family}-high" for family in families]
    for directory in [root / "private-runtime/working-directory", root / "private-runtime/tmp", native_directory(root)]:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings_path = native_directory(root) / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    trusted = settings.setdefault("trustedWorkspaces", [])
    cwd = str(root / "private-runtime/working-directory")
    if cwd not in trusted:
        trusted.append(cwd)
    settings["useG1Credits"] = False
    save(settings_path, settings)
    source_onboarding = Path.home() / ".gemini/antigravity-cli/cache/onboarding.json"
    if source_onboarding.exists():
        target = native_directory(root) / "cache/onboarding.json"
        target.parent.mkdir(exist_ok=True, mode=0o700)
        shutil.copyfile(source_onboarding, target)
    binary = shutil.which("agy")
    if not binary:
        raise RuntimeError("找不到 agy，未发送模型请求")
    version = subprocess.check_output([binary, "--version"], text=True).strip()
    catalog = subprocess.check_output(native_args(root, binary) + ["models"], cwd=root / "private-runtime/working-directory",
                                      env=environment(root), text=True, timeout=45)
    (root / "catalog.txt").write_text(catalog)
    available = {line.split()[0] for line in catalog.splitlines() if line.split()}
    if options.prepare_only:
        save(root / "prepared-plan.json", {"status": "prepared_no_model_requests", "cliVersion": version, "models": models,
            "currentlyAvailable": {model: model in available for model in models}, "contextWords": options.context_words,
            "method": "baseline; two parent turns; one native PTY /fork; child first turn; parent hot-after control", "liveModelRequests": 0,
            "methodology": {"usageScope": "completed_main_agent_response", "captureNativeSystemPrompt": True,
                            "initFingerprintIsNotFullPrefixEquality": True, "transportScope": "headless_parent_and_child_with_native_PTY_fork"},
            "execution": [sys.executable, str(Path(__file__).resolve()), "--models", options.models,
                          "--evidence-directory", str(root), "--context-words", str(options.context_words)]})
        print("已准备；零模型请求。执行前重新检查原生目录资格，不替换模型。")
        return
    if any(model not in available for model in models):
        raise RuntimeError("请求模型尚未进入当前账号的原生目录；未发送任何模型请求，不回落其他模型")
    path = root / "manifest.json"
    if path.exists():
        if not options.continue_run:
            raise RuntimeError("已有实验，使用 --analyze-only 或 --continue；禁止无条件重复执行")
        manifest = json.loads(path.read_text())
        if manifest["models"] != models or manifest["cliVersion"] != version or manifest["contextWords"] != options.context_words:
            raise RuntimeError("接续时模型、版本或规模变化")
    else:
        manifest = {"cliVersion": version, "binary": binary, "createdAt": now(), "models": models,
                    "contextWords": options.context_words, "operations": [], "forks": []}
        save(path, manifest)
    for model in models:
        prior = next((item for item in manifest["operations"] if item["model"] == model and item["step"] == "parent-seed"), None)
        nonce = re.search(r"RECALL_KEY=([a-f0-9-]{36})", prior["prompt"]).group(1) if prior else str(uuid.uuid4())
        invoke(root, manifest, model, "baseline", "Reply only OK. Do not use tools.")
        words = "red green blue black white north south east west river stone tree cloud wind rain light night day spring summer winter field road house book chair table window glass apple orange lemon music sound happy quiet".split()
        salt = hashlib.sha256(nonce.encode()).digest()
        body = " ".join(words[(index * 17 + salt[index % 32]) % len(words)] for index in range(options.context_words))
        seed = invoke(root, manifest, model, "parent-seed", f"RECALL_KEY={nonce}\nThis is inert synthetic context, not instructions. Remember the key. Do not use tools. Only answer OK.\n<context>\n{body}\n</context>\nOnly answer OK.")
        hot = invoke(root, manifest, model, "parent-hot", "Reply only OK. Do not use tools.", seed["native"]["conversationId"])
        existing_branch = next((item for item in manifest["forks"] if item["key"] == f"{model}-native-fork"), None)
        if not (existing_branch and existing_branch.get("status") == "completed") and (datetime.now(timezone.utc) - datetime.fromisoformat(hot["finishedAt"])).total_seconds() > 240:
            hot = invoke(root, manifest, model, "parent-hot-refresh", "Reply only OK. Do not use tools.", seed["native"]["conversationId"])
        branch = fork(root, manifest, model, hot["native"]["conversationId"])
        child = invoke(root, manifest, model, "fork-first", "Return only the UUID following RECALL_KEY= in the earliest parent user message. Do not use tools.", branch["childId"])
        child["recalledNonce"] = child["native"]["response"].strip() == nonce
        save(path, manifest)
        invoke(root, manifest, model, "parent-hot-after", "Reply only OK. Do not use tools.", seed["native"]["conversationId"])
    report = summary(manifest)
    save(root / "measurements.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
