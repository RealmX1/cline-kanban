"""用实际生成的监管器做有界隔离验收；只回收本夹具创建并再次核验世代的进程。"""

import argparse
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import tempfile
import time


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--supervisor-source", default="src/task-command-execution/task-command-execution-supervisor.ts")
parser.add_argument("--historical-process-count", type=int, default=1582, choices=[0, 100, 1582, 10000])
parser.add_argument("--duration-seconds", type=int, default=60, choices=[5, 60])
args = parser.parse_args()
node = shutil.which("node")
if node is None:
    raise SystemExit("缺少 Node 可执行文件")
source_file = Path(args.supervisor_source).read_text()
source = source_file.split("const supervisorSource = String.raw`", 1)[1].split("`;\n", 1)[0]
historical = [dict(pid=2000000 + index, startAndCommand="Thu Jan 1 00:00:00 1970 retired-test-generation")
              for index in range(args.historical_process_count)]
assert "let settled=null;" in source
source = source.replace("let settled=null;", "for(const entry of " + json.dumps(historical) + "){rememberOwned(entry);}let settled=null;", 1)


def read_start_identity(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, timeout=5, env={**os.environ, "LC_ALL": "C"})
    return result.stdout.split() if result.returncode == 0 else None


with tempfile.TemporaryDirectory(prefix="kanban-command-supervision-resource-acceptance-") as temporary:
    directory = Path(temporary)
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("KANBAN_") or key == "NODE_OPTIONS":
            env.pop(key)
    for key in ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]:
        env[key] = temporary
    env["LC_ALL"] = "C"
    entrypoint = directory / "owned-command-supervisor.mjs"
    entrypoint.write_text(source)
    descendant_body = """
const fs=require('node:fs');const cp=require('node:child_process');
const started=cp.execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).trim();
fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,started}));
setTimeout(()=>{},Number(process.argv[2]));
"""
    root_body = """
const cp=require('node:child_process');const path=require('node:path');
for(let index=0;index<3;index++)cp.spawn(process.execPath,['-e',process.argv[1],path.join(process.cwd(),'created-descendant-'+index+'.json'),process.argv[2]],{stdio:'ignore'}).unref();
setTimeout(()=>{},1000);
"""
    materials = dict(directory=temporary, launchNonce="isolated-resource-acceptance", executionId="isolated-resource-acceptance",
                     revocationFile=str(directory / "revocation.json"), workingDirectory=temporary,
                     command=[node, "-e", root_body, descendant_body, str(args.duration_seconds * 1000)],
                     deadlineAtEpochMs=int(time.time() * 1000) + (args.duration_seconds + 15) * 1000)
    materials_path = directory / "materials.json"
    materials_path.write_text(json.dumps(materials))
    baseline = resource.getrusage(resource.RUSAGE_CHILDREN)
    started_at = time.monotonic()
    with (directory / "supervisor.log").open("w") as log:
        supervisor = subprocess.Popen([node, str(entrypoint), str(materials_path)], env=env, stdout=log, stderr=log)
        try:
            supervisor.wait(timeout=args.duration_seconds + 20)
            usage = resource.getrusage(resource.RUSAGE_CHILDREN)
            progress = json.loads((directory / "supervisor-progress-isolated-resource-acceptance.json").read_text())
            assert supervisor.returncode == 0, (directory / "supervisor.log").read_text()
            assert progress["status"] == "exited", progress
            assert len(progress["ownedProcesses"]) >= args.historical_process_count + 4, "夹具未证明已追踪三个后代"
            cpu_seconds = usage.ru_utime + usage.ru_stime - baseline.ru_utime - baseline.ru_stime
            result = dict(durationSeconds=time.monotonic() - started_at, historicalProcesses=args.historical_process_count,
                          supervisorAndQueryChildrenCpuSeconds=cpu_seconds, status=progress["status"],
                          progressUpdatedAtEpochMs=progress["updatedAtEpochMs"], node=node)
            print(json.dumps(result), flush=True)
            hard_limit = max(1, 6 * args.duration_seconds / 60)
            assert cpu_seconds <= hard_limit, "监管器及查询子进程 CPU 超过硬档"
            if cpu_seconds > 2 * args.duration_seconds / 60:
                print("资源软档告警：监管器及查询子进程 CPU 超过正常目标", flush=True)
        finally:
            (directory / "revocation.json").write_text("cancel isolated fixture")
            for manifest in directory.glob("created-descendant-*.json"):
                child = json.loads(manifest.read_text())
                if read_start_identity(child["pid"]) == child["started"].split():
                    try:
                        os.kill(child["pid"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            if supervisor.poll() is None:
                supervisor.kill()
            supervisor.wait(timeout=5)
