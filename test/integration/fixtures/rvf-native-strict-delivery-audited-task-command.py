"""透明记录实际 CLI 交互；不替换、补全或解释产品响应。"""
import os,sys,json,subprocess,time,uuid
from pathlib import Path
command=[os.environ['RVF_NATIVE_E2E_NODE'],os.environ['RVF_NATIVE_E2E_CLI'],'task',*sys.argv[1:]]
started=time.time()
completed=subprocess.run(command,capture_output=True,text=True)
root=Path(os.environ['RVF_NATIVE_E2E_ROOT'])/'actual-cli-exchanges';root.mkdir(exist_ok=True)
(root/(str(time.time_ns())+'-'+uuid.uuid4().hex+'.json')).write_text(json.dumps({'argv':command,'started_at':started,'completed_at':time.time(),'exit':completed.returncode,'stdout':completed.stdout,'stderr':completed.stderr},ensure_ascii=False,indent=2))
sys.stdout.write(completed.stdout);sys.stderr.write(completed.stderr)
raise SystemExit(completed.returncode)
