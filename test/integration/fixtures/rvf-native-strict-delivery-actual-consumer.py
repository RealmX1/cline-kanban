"""只替换 reviewer 执行器；开审、prepare、dispatch 和安全 gate 均用产品实现。"""
import os,sys,json,subprocess,time
from pathlib import Path
root=Path(os.environ['RVF_NATIVE_E2E_ROOT'])
sys.path.insert(0,os.environ['RVF_NATIVE_E2E_RVF_SCRIPTS'])
import _rvf_pyroot
import rvf_agent_decision_cli as cli
mint=json.loads((root/'actual-mint-result.json').read_text())
token=mint['token']; payload=mint['payload']; transcript=payload['candidate_summary']['origin_transcript_path']
os.environ['CODEX_THREAD_ID']=payload['session_id']
os.environ['KANBAN_TASK_ID']=str(payload['candidate_summary']['kanban_task_id'])
def save(name,result):
    value=result.to_dict(); (root/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)); print(name,json.dumps(value,ensure_ascii=False),flush=True)
    if result.exit_code: raise RuntimeError(name+' '+json.dumps(value,ensure_ascii=False))
    return value
result=save('actual-start-result.json',cli.run_start(token=token,reason='隔离原生联验：真实分界已经到达',repo=payload['worktree'],session_id=payload['session_id'],transcript_path=transcript))
lookup=cli.token_store.read_decision_token(token)
record,overlay=cli._load_overlay_for_scope(token,roots=cli.AgentDecisionRoots(),now=cli.utc_now())
artifacts=overlay['prepare_artifacts']
scope=Path(artifacts['scope_of_work'])
scope.write_text('''# 本次实现与审查目标

本次隔离原生联验通过真实 Codex TUI 的命令执行工具修改 implementation.txt，将初始实现改为待审实现。
审查目标是核实该文件修改保持预期行为，并证明发起消息来自独立原生用户回合，候选内容、当前 HEAD、本地 base、不可变 checkpoint 与本次随机 nonce 始终一致。

## 具体修改

implementation.txt 保存本次原生命令写入的内容。其余文件不属于候选集。请检查候选 diff、文件身份和本轮 scope contract，确认没有混入跨任务修改。

## 验证与边界

本次以本地回环服务返回模型内容；原生 TUI、真实宿主控制 socket、持久队列、产品 capture、checkpoint 和 RVF prepare/dispatch 均使用实际实现。外部 reviewer 只运行明确记录的受控本地子进程，不代表生产 reviewer 完成。
''')
save('actual-scope-rerender-result.json',cli.run_scope_rerender_scope_of_work(token=token))
def controlled_reviewer(**kwargs):
    command=[sys.executable,'-c','import os,json; print(json.dumps({"controlled_reviewer":True,"pid":os.getpid(),"result":"isolated_dispatch_executed"}))']
    child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    stdout,stderr=child.communicate(timeout=10)
    evidence={'command':command,'pid':child.pid,'returncode':child.returncode,'stdout':stdout,'stderr':stderr,'production_external_harness_completed':False,'dispatch_inputs':kwargs}
    (root/'controlled-reviewer-process.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    return {'status':cli.DISPATCH_OUTCOME_OK if child.returncode==0 else cli.DISPATCH_OUTCOME_FAILED,'returncode':child.returncode,'controlled_local_process_evidence':str(root/'controlled-reviewer-process.json')}
save('actual-dispatch-result.json',cli.run_dispatch(token=token,strictness='light',reviewer_dispatcher=controlled_reviewer))
(root/'actual-final-token.json').write_text(json.dumps(cli.token_store.read_decision_token(token).payload,ensure_ascii=False,indent=2))
