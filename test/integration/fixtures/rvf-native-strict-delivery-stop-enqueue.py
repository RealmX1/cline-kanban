"""真实 Stop 内铸币并请求 strict 队列，保留回合尚未完成时的现场。"""
import json, os, sys, subprocess, time, traceback, urllib.request
from pathlib import Path
root=Path(os.environ['RVF_NATIVE_E2E_ROOT'])
request=json.load(sys.stdin)
marker=root/'stop-enqueue-started.json'
if marker.exists():
    print('{}'); raise SystemExit(0)
marker.write_text(json.dumps(request,ensure_ascii=False,indent=2))
try:
    sys.path.insert(0,os.environ['RVF_NATIVE_E2E_RVF_SCRIPTS'])
    import _rvf_pyroot
    import stop_decision_candidate_summary as summaries
    import rvf_decision_token_store as tokens
    from rvf_review_start_boundary_request import _send_boundary_message
    event={'cwd':request['cwd'],'session_id':request['session_id'],'transcript_path':request['transcript_path']}
    summary=summaries.build_candidate_summary(event=event,cwd=request['cwd'],repo=request['cwd'],ledger=None)
    summary['origin_transcript_path']=request['transcript_path']
    (root/'actual-candidate-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    mint=tokens.mint_decision_token(worktree=request['cwd'],session_id=request['session_id'],candidate_fingerprint=summary['candidate_fingerprint'],candidate_summary=summary,delivery_transport=tokens.DECISION_POINT_DELIVERY_TRANSPORT_CLINE_KANBAN_TASK_CHAT_SESSION)
    if not mint.token: raise RuntimeError(mint.outcome)
    payload=mint.record.payload
    (root/'actual-mint-result.json').write_text(json.dumps({'token':mint.token,'outcome':mint.outcome,'payload':payload},ensure_ascii=False,indent=2))
    native_event=subprocess.run([os.environ['RVF_NATIVE_E2E_NODE'],os.environ['RVF_NATIVE_E2E_CLI'],'hooks','codex-hook','--event','to_review','--source','codex'],input=json.dumps(request),capture_output=True,text=True,timeout=15)
    (root/'actual-stop-hook-summary-report.json').write_text(json.dumps({'exit':native_event.returncode,'stdout':native_event.stdout,'stderr':native_event.stderr},ensure_ascii=False,indent=2))
    result=_send_boundary_message(payload=payload,summary=summary,reason='隔离真实原生联验',now=tokens.utc_now())
    (root/'strict-enqueue-response.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    # 在 Stop 仍未返回的两秒内，队列必须保持待投，不能把第二条消息塞进同一 turn。
    request_state=urllib.request.Request('http://127.0.0.1:'+os.environ['KANBAN_RUNTIME_PORT']+'/api/trpc/workspace.getState',headers={'x-kanban-workspace-id':os.environ['KANBAN_HOOK_WORKSPACE_ID']})
    with urllib.request.urlopen(request_state,timeout=10) as response: state=json.load(response)['result']['data']
    (root/'summary-while-stop-not-returned.json').write_text(json.dumps(state['sessions'][os.environ['KANBAN_TASK_ID']],ensure_ascii=False,indent=2))
    time.sleep(2)
    records=[json.loads(line) for line in Path(request['transcript_path']).read_text().splitlines()]
    selected=[record for record in records if record.get('type')=='event_msg' and record.get('payload',{}).get('type') in ['task_started','task_complete'] or (record.get('type')=='event_msg' and (record.get('payload',{}).get('item') or {}).get('type')=='UserMessage')]
    (root/'native-events-while-stop-not-returned.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2))
    for path in (Path(os.environ['HOME'])/'.cline/kanban/workspaces').glob('*/queued-task-prompt-deliveries.json'):
        (root/'queue-while-stop-not-returned.json').write_text(path.read_text())
    (root/'stop-returning.json').write_text(json.dumps({'at':time.time(),'token':mint.token}))
except BaseException:
    (root/'stop-enqueue-failure.txt').write_text(traceback.format_exc())
print('{}')
