"""真实原生链路联验；所有状态均来自统一 Git fixture，wrapper 在清理前归档证据。"""
import http.server,threading,json,sys,os,time,subprocess,signal,socket,shlex,traceback,urllib.request,urllib.error,hashlib
from pathlib import Path
base=Path(__file__).resolve().parent
options=json.loads(sys.argv[1])
root=Path(options['fixtureRoot'])/'native-strict-delivery-through-dispatch'; root.mkdir(parents=True,exist_ok=True)
(root/'isolated-chain-options.json').write_text(json.dumps(options,ensure_ascii=False,indent=2))
node=options['nodeBinary']
cli=Path(options['packagedCliPath']); repo=Path(options['repositoryPath']); home=Path(os.environ['HOME']); cfg=root/'isolated-codex-home'
cfg.mkdir(parents=True,exist_ok=True)
rvf_scripts=str(Path(options['consumerRepository'])/'plugins/review-validate-fix/skills/review-validate-fix/scripts')
# 调用环境必须由统一 Git fixture 构造；保留它管理的 HOME、temp 与 GIT 安全配置。
env={k:v for k,v in os.environ.items() if not k.startswith(('CODEX_','KANBAN_','RVF_','CLINE_','OPENAI_','ANTHROPIC_','CLAUDE_','OTEL_'))}
env.update(CODEX_HOME=str(cfg),RVF_HOME=str(root/'isolated-rvf-home'),RVF_USER_LOCAL_DATA_ROOT=str(root/'isolated-user-local-data'),CODEX_RVF_LOG_ROOT=str(root/'rvf-runs'),CODEX_RVF_PREP_ROOT=str(root/'isolated-prep-files'),TERM='xterm-256color',NO_COLOR='1',DO_NOT_TRACK='1',PYTHONDONTWRITEBYTECODE='1',KANBAN_AGENT_SESSION_PTY_HOST_MODE='disabled',RVF_NATIVE_E2E_ROOT=str(root),RVF_NATIVE_E2E_RVF_SCRIPTS=rvf_scripts,RVF_NATIVE_E2E_NODE=node,RVF_NATIVE_E2E_CLI=str(cli),CODEX_RVF_CLINE_KANBAN_TASK_CMD=shlex.join([sys.executable,str(base/'rvf-native-strict-delivery-audited-task-command.py')]))
def log(msg): print(time.strftime('%H:%M:%S'),msg,flush=True)
def command(args,label,timeout=40,check=True):
    c=subprocess.run(args,cwd=repo,env=env,capture_output=True,text=True,timeout=timeout)
    (root/(label+'.json')).write_text(json.dumps({'argv':args,'exit':c.returncode,'stdout':c.stdout,'stderr':c.stderr},ensure_ascii=False,indent=2))
    if check and c.returncode: raise RuntimeError(label+' '+c.stdout[-1000:]+' '+c.stderr[-1000:])
    return c
release_boundary=threading.Event(); requests=[]
signal.signal(signal.SIGTERM,lambda signum,frame: (_ for _ in ()).throw(SystemExit(143)))
class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        n=len(requests)+1; requests.append(body); (root/f'provider-request-{n}.json').write_text(json.dumps(body,ensure_ascii=False,indent=2))
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        def event(kind,**values):
            self.wfile.write(('event: '+kind+'\ndata: '+json.dumps({'type':kind,**values})+'\n\n').encode()); self.wfile.flush()
        response={'id':f'resp_{n}','object':'response','created_at':int(time.time()),'status':'completed','model':'gpt-5.4','output':[],'usage':{'input_tokens':10,'output_tokens':5,'total_tokens':15}}
        try:
            event('response.created',response={**response,'status':'in_progress'})
            messages=[i for i in body.get('input',[]) if i.get('type')=='message' and i.get('role')=='user']
            user_texts=[''.join(part.get('text','') for part in item.get('content',[])) for item in messages]
            is_title=any('Generate a concise, single-line task title' in text for text in user_texts)
            is_boundary=any(text.startswith('RVF 发起决策点 · ') for text in user_texts)
            is_closeout=any('RVF_AUTOMATIC_CLOSEOUT_TOKEN=' in text for text in user_texts)
            has_tool_result=any(i.get('type')=='function_call_output' for i in body.get('input',[]))
            execute_closeout=is_closeout and not (root/'actual-closeout-driver-started.json').exists()
            if execute_closeout or (not is_title and not is_boundary and not has_tool_result):
                available=[t.get('name') for t in body.get('tools',[])]; log('原生工具 '+str(available))
                if 'exec_command' not in available: raise RuntimeError('原生exec_command不可用')
                arguments=json.dumps({'cmd':"printf 'native reviewed implementation\\n' > implementation.txt",'yield_time_ms':1000,'max_output_tokens':1000})
                if execute_closeout:
                    (root/'actual-closeout-driver-started.json').write_text(json.dumps({'request':n,'at':time.time()}))
                    arguments=json.dumps({'cmd':shlex.join([sys.executable,str(base/'rvf-native-controlled-review-and-closeout.py'),'closeout']),'yield_time_ms':1000,'max_output_tokens':2000})
                item={'id':'fc_e2e','type':'function_call','call_id':'call_e2e','name':'exec_command','arguments':arguments,'status':'completed'}
                event('response.output_item.added',output_index=0,item={**item,'arguments':'','status':'in_progress'})
                event('response.function_call_arguments.delta',item_id=item['id'],output_index=0,delta=arguments)
                event('response.function_call_arguments.done',item_id=item['id'],output_index=0,arguments=arguments)
                event('response.output_item.done',output_index=0,item=item)
                response['output']=[item]
            else:
                if is_boundary:
                    (root/'boundary-provider-request-started.json').write_text(json.dumps({'request':n,'at':time.time()}))
                    deadline=time.time()+240
                    while not release_boundary.wait(1):
                        if time.time()>deadline: raise RuntimeError('boundary等待超时')
                        self.wfile.write(b': isolated wait\n\n'); self.wfile.flush()
                text='隔离分界回合已完成。' if is_boundary else '隔离实现已完成。'
                item={'id':f'msg_{n}','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':text,'annotations':[]}]}
                event('response.output_item.added',output_index=0,item={**item,'content':[],'status':'in_progress'})
                event('response.content_part.added',item_id=item['id'],output_index=0,content_index=0,part={'type':'output_text','text':'','annotations':[]})
                event('response.output_text.delta',item_id=item['id'],output_index=0,content_index=0,delta=text)
                event('response.output_text.done',item_id=item['id'],output_index=0,content_index=0,text=text)
                event('response.output_item.done',output_index=0,item=item); response['output']=[item]
            event('response.completed',response=response)
        except (BrokenPipeError,ConnectionResetError): pass
        except BaseException:
            (root/'provider-failure.txt').write_text(traceback.format_exc())
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=server.serve_forever,daemon=True).start()
hook_command=shlex.join([sys.executable,str(base/'rvf-native-strict-delivery-stop-enqueue.py')])
# hooks.json 的信任交互由实际终端输入自动选择，不修改原生信任账本。
(cfg/'hooks.json').write_text(json.dumps({'hooks':{'Stop':[{'hooks':[{'type':'command','command':hook_command,'timeout':45}]}]}},ensure_ascii=False))
(cfg/'config.toml').write_text(f'''model="gpt-5.4"
model_provider="isolated_loopback"
check_for_update_on_startup=false
approval_policy="never"
sandbox_mode="danger-full-access"
[model_providers.isolated_loopback]
name="隔离原生联验回环"
base_url="http://127.0.0.1:{server.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
request_max_retries=0
stream_max_retries=0
[projects.{json.dumps(str(repo))}]
trust_level="trusted"
[tui]
screen_reader_detection_done=true
''')
probe=socket.socket(); probe.bind(('127.0.0.1',0)); port=probe.getsockname()[1]; probe.close()
env['KANBAN_RUNTIME_PORT']=str(port); env['KANBAN_RUNTIME_HOST']='127.0.0.1'
origin=f'http://127.0.0.1:{port}'; workspace=None; task=None; runtime=None
runtime_log=(root/'runtime.log').open('w')
def rpc(procedure,value=None):
    headers={'Content-Type':'application/json'}
    if workspace: headers['x-kanban-workspace-id']=workspace
    req=urllib.request.Request(origin+'/api/trpc/'+procedure,data=None if value is None else json.dumps(value).encode(),headers=headers,method='GET' if value is None else 'POST')
    try:
        with urllib.request.urlopen(req,timeout=15) as r: result=json.load(r)
    except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode())
    if 'result' not in result: raise RuntimeError(result)
    return result['result']['data']
def wait(condition,seconds,label):
    deadline=time.time()+seconds
    while time.time()<deadline:
        if runtime and runtime.poll() is not None: raise RuntimeError('runtime退出 '+str(runtime.returncode))
        value=condition()
        if value:return value
        time.sleep(.5)
    raise TimeoutError(label)
try:
    runtime=subprocess.Popen([node,str(cli),'--no-open','--no-passcode','--port',str(port)],cwd=repo,env=env,stdout=runtime_log,stderr=runtime_log,start_new_session=True)
    (root/'owned-runtime-process.json').write_text(json.dumps({'pid':runtime.pid,'port':port,'argv':[node,str(cli)]}))
    def healthy():
        try:
            with urllib.request.urlopen(origin+'/api/trpc/runtime.getState',timeout=2) as response: return response.status != 503
        except urllib.error.HTTPError as error: return error.code != 503
        except Exception:return False
    wait(healthy,60,'runtime启动')
    log('runtime已启动 '+str(port))
    create=command([node,str(cli),'task','create','--project-path',str(repo),'--title','[TEST,AGENT]隔离原生 RVF 链路联验','--prompt','通过实际 exec_command 修改 implementation.txt，然后完成本回合。','--base-ref','main','--agent-id','codex','--start-in-plan-mode','false','--worktree-mode','inplace','--task-agent-permission-mode','bypass_all_permission_prompts','--auto-review-enabled','false'],'actual-task-create')
    task=json.loads(create.stdout)['task']['id']; env['KANBAN_TASK_ID']=task; env['KANBAN_PROJECT_PATH']=str(repo)
    paths=list((home/'.cline/kanban/workspaces').glob('*/board.json')); assert len(paths)==1,paths
    workspace=paths[0].parent.name; env['KANBAN_HOOK_WORKSPACE_ID']=workspace; env['KANBAN_HOOK_TASK_ID']=task
    start=rpc('runtime.startTaskSession',{'taskId':task,'prompt':'通过实际 exec_command 修改 implementation.txt，然后完成本回合。','baseRef':'main','agentId':'codex','worktreeMode':'inplace','startInPlanMode':False,'taskAgentPermissionMode':'bypass_all_permission_prompts'})
    (root/'actual-session-start.json').write_text(json.dumps(start,ensure_ascii=False,indent=2)); assert start['ok'],start
    log('原生会话已启动 '+task)
    # 若原生 hook 信任提示出现，两个原生按键选择允许 hook；无生产配置参与。
    time.sleep(3)
    if not requests:
        rpc('runtime.sendTaskSessionInput',{'taskId':task,'text':'2\r','appendNewline':False})
        log('已通过终端输入处理隔离 hook 信任提示')
    wait(lambda:(root/'actual-mint-result.json').exists() or (root/'stop-enqueue-failure.txt').exists(),90,'原生工具执行及Stop铸币')
    if (root/'stop-enqueue-failure.txt').exists(): raise RuntimeError((root/'stop-enqueue-failure.txt').read_text())
    wait(lambda:(root/'strict-enqueue-response.json').exists() or (root/'stop-enqueue-failure.txt').exists(),30,'strict入队')
    if (root/'stop-enqueue-failure.txt').exists(): raise RuntimeError((root/'stop-enqueue-failure.txt').read_text())
    wait(lambda:(root/'queue-while-stop-not-returned.json').exists(),10,'Stop未完成队列证据')
    queue=json.loads((root/'queue-while-stop-not-returned.json').read_text()); entries=[e for v in queue['entriesByTaskId'].values() for e in v]
    assert len(entries)==1 and entries[0]['deliveryState']=='queued',entries
    summary_pending=json.loads((root/'summary-while-stop-not-returned.json').read_text())
    assert summary_pending['turnOwner']=='user' and summary_pending['userTurnKind']=='review',summary_pending
    log('反例通过：summary已空闲但原生Stop尚未返回，strict消息保持queued')
    wait(lambda:(root/'boundary-provider-request-started.json').exists(),90,'真实下一用户回合')
    state=rpc('workspace.getState'); (root/'state-at-native-boundary.json').write_text(json.dumps(state,ensure_ascii=False,indent=2))
    summary=state['sessions'][task]; identity=summary['agentNativeConversationSessionIdentity']; transcript=Path(identity['transcriptPath'])
    events=[json.loads(l) for l in transcript.read_text().splitlines()]
    native=[{'at':e.get('timestamp'),'kind':e.get('payload',{}).get('type'),'turn':e.get('payload',{}).get('turn_id'),'item':e.get('payload',{}).get('item')} for e in events if e.get('type')=='event_msg' and e.get('payload',{}).get('type') in ['task_started','task_complete','item_completed']]
    (root/'native-turn-events.json').write_text(json.dumps(native,ensure_ascii=False,indent=2))
    mint=json.loads((root/'actual-mint-result.json').read_text()); expected=mint['token']
    markers=[e for e in native if (e.get('item') or {}).get('type')=='UserMessage' and expected in json.dumps(e)]
    assert len(markers)==1,markers
    boundary=markers[0]['turn']; users=[e for e in native if e['turn']==boundary and (e.get('item') or {}).get('type')=='UserMessage']
    assert len(users)==1,users
    previous_complete=[e for e in native if e['kind']=='task_complete' and e['turn']!=boundary]
    assert previous_complete, native
    log('真实独立UserMessage与前回合完成已证实')
    consumer=command([sys.executable,str(base/'rvf-native-strict-delivery-actual-consumer.py')],'actual-rvf-consumer',timeout=180,check=False)
    if consumer.returncode: raise RuntimeError('RVF consumer失败 '+consumer.stdout[-3000:]+' '+consumer.stderr[-3000:])
    command([sys.executable,str(base/'rvf-native-controlled-review-and-closeout.py'),'review'],'actual-controlled-review-and-finalize',timeout=90)
    release_boundary.set()
    wait(lambda:(root/'actual-closeout-completed.json').exists(),180,'原生恢复、唯一投递与 land/base 结果闭环')
    closeout=json.loads((root/'actual-closeout-completed.json').read_text())
    assert closeout['record']['status']=='completed',closeout
    restored_state=rpc('workspace.getState')
    restored_identity=restored_state['sessions'][task]['agentNativeConversationSessionIdentity']
    assert restored_identity['nativeSessionId']==closeout['record']['restoredNativeSessionId']
    restored_records=[json.loads(line) for line in Path(restored_identity['transcriptPath']).read_text().splitlines()]
    closeout_messages=[entry for entry in restored_records if entry.get('type')=='event_msg' and (entry.get('payload',{}).get('item') or {}).get('type')=='UserMessage' and 'RVF_AUTOMATIC_CLOSEOUT_TOKEN='+expected in json.dumps(entry,ensure_ascii=False)]
    assert len(closeout_messages)==1,closeout_messages
    (root/'unique-restored-closeout-user-message.json').write_text(json.dumps(closeout_messages,ensure_ascii=False,indent=2))
    (root/'complete-chain-verification.json').write_text(json.dumps({'status':'passed','task':task,'workspace':workspace,'native_session_id':identity['nativeSessionId'],'boundary_turn_id':boundary,'marker_user_message_count':len(users),'controlled_reviewer_only':True,'runtime_pid':runtime.pid},ensure_ascii=False,indent=2))
    log('真实runtime→strict queue→checkpoint/nonce→start/prepare→dispatch通过')
except BaseException:
    (root/'chain-failure.txt').write_text(traceback.format_exc()); log(traceback.format_exc()); raise
finally:
    release_boundary.set()
    if task and workspace and runtime and runtime.poll() is None:
        try:
            stopped=rpc('runtime.stopTaskSession',{'taskId':task}); (root/'actual-session-stop.json').write_text(json.dumps(stopped,ensure_ascii=False,indent=2))
        except Exception as e:(root/'cleanup-warning.txt').write_text(str(e))
    if runtime and runtime.poll() is None:
        runtime.terminate()
        try:runtime.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(runtime.pid,signal.SIGKILL); runtime.wait()
    server.shutdown(); runtime_log.close()
    socket_paths=[]
    state_path=root/'state-at-native-boundary.json'
    if state_path.exists():
        state=json.loads(state_path.read_text())
        for summary in state.get('sessions',{}).values():
            endpoint=summary.get('codexNativeSessionControlEndpoint')
            if endpoint: socket_paths.append({'path':endpoint['socketPath'],'exists_after_cleanup':Path(endpoint['socketPath']).exists()})
    (root/'control-socket-cleanup.json').write_text(json.dumps(socket_paths,indent=2))
    (root/'cleanup.json').write_text(json.dumps({'runtime_exit':runtime.returncode if runtime else None,'provider_closed':True,'at':time.time()},indent=2))
