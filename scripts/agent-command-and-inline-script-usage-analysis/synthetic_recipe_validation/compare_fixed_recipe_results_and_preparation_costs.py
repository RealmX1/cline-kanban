"""在隔离合成场景中对比固定配方的结果、失败语义与准备成本；不执行转录正文。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile


FIXTURE_QUERY_DOCUMENT = {'ok': True, 'task': {'id': 'synthetic-task', 'title': '合成任务', 'retainedField': ['完整', '结果']}}
FIXTURE_QUERY_SOURCE = '''import json, sys
mode = sys.argv[1]
if mode == 'query_failure':
    print('受控查询失败', file=sys.stderr)
    sys.exit(7)
if mode == 'invalid_json':
    print('{invalid-json')
elif mode == 'missing_fields':
    print('{"ok":true}')
else:
    print(json.dumps({'ok': True, 'task': {'id': 'synthetic-task', 'title': '合成任务', 'retainedField': ['完整', '结果']}}, ensure_ascii=False))
'''
SNAPSHOT_PYTHON_RECIPE = '''python3 - SCENARIO_MODE <<'PY'
import json, subprocess, sys
from pathlib import Path
response = subprocess.run([sys.executable, 'fixture-query.py', sys.argv[1]], check=True, capture_output=True, text=True, encoding='utf-8')
document = json.loads(response.stdout)
assert document['ok'] is True
selected = {key: document['task'][key] for key in ['id', 'title']}
Path('task-snapshot.json').write_text(response.stdout, encoding='utf-8')
print(json.dumps(selected, ensure_ascii=False))
PY'''
SNAPSHOT_ATOMIC_SHELL_RECIPE = '''snapshot_candidate=$(mktemp ./task-snapshot.XXXXXX) &&
trap 'rm -f "$snapshot_candidate"' EXIT &&
python3 fixture-query.py SCENARIO_MODE > "$snapshot_candidate" &&
jq -e '.ok == true and (.task | has("id") and has("title"))' "$snapshot_candidate" >/dev/null &&
jq '{id:.task.id,title:.task.title}' "$snapshot_candidate" &&
mv "$snapshot_candidate" task-snapshot.json'''
SNAPSHOT_UNSAFE_SHELL_RECIPE = '''python3 fixture-query.py SCENARIO_MODE > task-snapshot.json && jq '{id:.task.id,title:.task.title}' task-snapshot.json'''
EVIDENCE_PYTHON_RECIPE = '''python3 - <<'PY'
from pathlib import Path
print(Path('review-evidence-bound/log.txt').read_text(encoding='utf-8')[-4:], end='')
PY'''
EVIDENCE_SHORT_PYTHON_RECIPE = '''python3 -c "print(open('review-evidence-bound/log.txt',encoding='utf-8').read()[-4:],end='')"'''
JSON_FIELD_PYTHON_RECIPE = '''python3 - <<'PY'
import json
from pathlib import Path
record = json.loads(Path('./result.json').read_text(encoding='utf-8'))
print(json.dumps(record['findings'], ensure_ascii=False, indent=2))
PY'''
JSON_FIELD_SHORT_PYTHON_RECIPE = """python3 -c 'import json;print(json.dumps(json.load(open("./result.json",encoding="utf-8"))["findings"],ensure_ascii=False))'"""
JSON_FIELD_JQ_RECIPE = '''jq -cs 'if length==1 and (.[0]|has("findings")) then .[0].findings else error("缺字段或非单个对象") end' -- ./result.json'''
BOUND_TASK_SNAPSHOT_SHELL_RECIPE = '''(
set -eu
: "${KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH:?}" "${KANBAN_TASK_ID:?}" "${KANBAN_PROJECT_PATH:?}" "${KANBAN_TASK_CONVERSATION_SESSION_ID:?}"
if [ -L ./task-snapshot.json ] || { [ -e ./task-snapshot.json ] && [ ! -f ./task-snapshot.json ]; }; then
  exit 1
fi
umask 077
snapshot_candidate=$(mktemp ./task-snapshot.XXXXXX)
trap 'rm -f "$snapshot_candidate"' 0
trap 'exit 1' HUP INT TERM
"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" task get-current-task > "$snapshot_candidate"
jq -se --arg task "$KANBAN_TASK_ID" --arg project "$KANBAN_PROJECT_PATH" '
  length == 1 and (.[0] | .ok == true and .workspacePath == $project and
    .task.id == $task and (.task.title | type) == "string")
' "$snapshot_candidate" >/dev/null
mv -f "$snapshot_candidate" ./task-snapshot.json
)'''
BOUND_TASK_QUERY_DOCUMENT = {'ok': True, 'workspacePath': '/synthetic project', 'task': FIXTURE_QUERY_DOCUMENT['task']}
BOUND_TASK_QUERY_SOURCE = '''import json, os, signal, sys
if sys.argv[1:] != ['task', 'get-current-task'] or os.environ.get('KANBAN_TASK_CONVERSATION_SESSION_ID') != 'synthetic-session':
    sys.exit(8)
mode = os.environ['FIXTURE_QUERY_SCENARIO']
document = {'ok': True, 'workspacePath': '/synthetic project', 'task': {'id': 'synthetic-task', 'title': '合成任务', 'retainedField': ['完整', '结果']}}
if mode in ['query_failure', 'query_terminated']:
    print('{partial-query', flush=True)
    if mode == 'query_terminated':
        os.kill(os.getpid(), signal.SIGTERM)
    sys.exit(7)
if mode == 'invalid_json':
    print('{invalid-json')
    sys.exit(0)
if mode == 'missing_fields':
    document['task'].pop('title')
if mode == 'wrong_task':
    document['task']['id'] = 'different-task'
if mode == 'wrong_project':
    document['workspacePath'] = '/different-project'
print(json.dumps(document, ensure_ascii=False))
if mode == 'multiple_documents':
    print('{}')
'''


def controlled_comparison_environment():
    tools = {'posix_shell': '/bin/sh', **{name: shutil.which(name) for name in ['jq', 'tail', 'mktemp', 'mv', 'rm']}}
    available = {name: bool(path and Path(path).is_file()) for name, path in tools.items()}
    return {'pythonVersion': '.'.join(map(str, sys.version_info[:3])), 'platform': sys.platform,
            'toolAvailability': available,
            'toolImplementationDigests': {name: hashlib.sha256(Path(path).read_bytes()).hexdigest()
                                           for name, path in tools.items() if available[name]}}, tools


def run_fixed_fixture_command(command, directory, environment):
    process = subprocess.Popen(['/bin/sh', '-c', command], cwd=directory, env=environment,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=5)
        return process.returncode, output
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise


def configured_recipe_costs(command, prepared_input_character_count=0):
    authored_command = command.replace('SCENARIO_MODE', 'success')
    return {'authoredCommandCharacterCount': len(authored_command), 'agentAuthoredInputFileCharacterCount': prepared_input_character_count,
            'completeAuthoredCharacterCount': len(authored_command) + prepared_input_character_count,
            'reusedPreparedInputAuthoredCharacterCount': len(authored_command), 'goalCompletionShellInvocationCount': 1,
            'characterCountScenario': 'success',
            'observedModelToolInvocationCount': None, 'observedModelPreparationToolInvocationCount': None,
            'costScope': '提供相同既有合成输入后的单次目标配方；共享fixture建设单列，不外推生产收益。'}


def compare_first_batch_recipe_scenarios(contracts, root, environment):
    values = {'array_value': ['完整', {'severity': 0}], 'null_value': None, 'false_value': False,
              'zero_value': 0, 'empty_string': '', 'empty_array': [], 'empty_object': {},
              'literal_shell_code': '$(touch recipe-input-executed); __import__("os").system("false")'}
    invalid_inputs = {'missing_field': '{}', 'invalid_json': '{invalid', 'empty_input': '',
                      'multiple_documents': '{"findings":1}\n{"findings":2}', 'array_root': '[]', 'missing_file': None}
    for recipe in contracts[2]['recipes']:
        if recipe['unavailableToolKinds']:
            continue
        for scenario in [*values, *invalid_inputs]:
            directory = root / f'{recipe["id"]}-{scenario}'
            directory.mkdir()
            source = directory / 'result.json'
            text = json.dumps({'findings': values[scenario]}, ensure_ascii=False) if scenario in values else invalid_inputs[scenario]
            if text is not None:
                source.write_text(text, encoding='utf-8')
            before = source.read_bytes() if source.exists() else None
            code, output = run_fixed_fixture_command(recipe['authoredCommand'], directory, environment)
            try:
                selected = json.loads(output)
                output_parsed = True
            except (ValueError, UnicodeError):
                selected = None
                output_parsed = False
            unchanged = (source.read_bytes() if source.exists() else None) == before
            not_executed = not (directory / 'recipe-input-executed').exists()
            satisfied = (code == 0 and output_parsed and json.dumps(selected, sort_keys=True) == json.dumps(values[scenario], sort_keys=True)) if scenario in values else (code != 0 and not output)
            recipe['scenarios'].append({'id': scenario, 'exitWasZero': code == 0, 'sourceFilesUnchanged': unchanged,
                                        'inputWasNotExecuted': not_executed, 'contractSatisfied': satisfied and unchanged and not_executed})
        recipe['equivalentUnderContract'] = all(case['contractSatisfied'] for case in recipe['scenarios'])
        recipe['status'] = 'completed'

    query = root / 'bound fixture cli'
    query.write_text(f'#!{sys.executable}\n' + BOUND_TASK_QUERY_SOURCE, encoding='utf-8')
    query.chmod(0o700)
    for recipe in contracts[3]['recipes']:
        if recipe['unavailableToolKinds']:
            continue
        for scenario in ['success', 'new_snapshot', 'query_failure', 'invalid_json', 'missing_fields',
                         'wrong_task', 'wrong_project', 'missing_session', 'wrong_session', 'multiple_documents',
                         'target_symlink', 'dangling_target_symlink', 'target_directory', 'temporary_creation_failure',
                         'atomic_replace_failure', 'query_terminated']:
            directory = root / f'{recipe["id"]}-{scenario}'
            directory.mkdir()
            if 'preparedScript' in recipe:
                script = directory / recipe['preparedScript']['fileName']
                script.write_text(recipe['preparedScript']['source'], encoding='utf-8')
                script.chmod(0o600)
            snapshot = directory / 'task-snapshot.json'
            previous = b'{"oldSnapshot":"keep"}\n'
            if scenario != 'new_snapshot':
                snapshot.write_bytes(previous)
                snapshot.chmod(0o644)
            target = directory / 'symlink-referent.json'
            if scenario in ['target_symlink', 'dangling_target_symlink']:
                snapshot.unlink()
                if scenario == 'target_symlink':
                    target.write_bytes(previous)
                snapshot.symlink_to(target)
            if scenario == 'target_directory':
                snapshot.unlink()
                snapshot.mkdir()
                (snapshot / 'must-retain.json').write_bytes(previous)
            previous_inode = snapshot.lstat().st_ino if snapshot.is_symlink() or snapshot.exists() else None
            scenario_environment = {**environment, 'KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH': str(query),
                                    'KANBAN_TASK_ID': 'synthetic-task', 'KANBAN_PROJECT_PATH': '/synthetic project',
                                    'KANBAN_TASK_CONVERSATION_SESSION_ID': 'synthetic-session', 'FIXTURE_QUERY_SCENARIO': scenario}
            if scenario == 'missing_session':
                scenario_environment.pop('KANBAN_TASK_CONVERSATION_SESSION_ID')
            if scenario == 'wrong_session':
                scenario_environment['KANBAN_TASK_CONVERSATION_SESSION_ID'] = 'unrelated-session'
            if scenario in ['temporary_creation_failure', 'atomic_replace_failure']:
                fault_tools = directory / 'fault-injection-tools'
                fault_tools.mkdir()
                tool = fault_tools / ('mktemp' if scenario == 'temporary_creation_failure' else 'mv')
                tool.write_text('#!/bin/sh\nexit 23\n', encoding='utf-8')
                tool.chmod(0o700)
                scenario_environment['PATH'] = str(fault_tools) + os.pathsep + environment['PATH']
            code, output = run_fixed_fixture_command(recipe['authoredCommand'], directory, scenario_environment)
            leftovers = any(path != snapshot for path in directory.glob('task-snapshot.*'))
            mode = f'{snapshot.stat().st_mode & 0o777:o}' if snapshot.is_file() else None
            if scenario in ['success', 'new_snapshot']:
                complete = snapshot.read_bytes() == (json.dumps(BOUND_TASK_QUERY_DOCUMENT, ensure_ascii=False) + '\n').encode('utf-8')
                replaced = previous_inode is None or snapshot.lstat().st_ino != previous_inode
                satisfied = code == 0 and not output and complete and replaced and mode == '600'
            else:
                replaced = False
                if scenario == 'target_directory':
                    preserved = snapshot.is_dir() and (snapshot / 'must-retain.json').read_bytes() == previous
                elif scenario in ['target_symlink', 'dangling_target_symlink']:
                    preserved = snapshot.is_symlink() and (target.read_bytes() == previous if target.exists() else scenario == 'dangling_target_symlink')
                else:
                    preserved = snapshot.read_bytes() == previous and mode == '644'
                satisfied = code != 0 and not output and preserved and snapshot.lstat().st_ino == previous_inode
            recipe['scenarios'].append({'id': scenario, 'exitWasZero': code == 0, 'snapshotMode': mode,
                                        'replacedFileIdentity': replaced, 'temporaryFileLeftBehind': leftovers,
                                        'contractSatisfied': satisfied and not leftovers})
        recipe['equivalentUnderContract'] = all(case['contractSatisfied'] for case in recipe['scenarios'])
        recipe['status'] = 'completed'


def compare_fixed_goal_recipes(artifacts_directory):
    environment_descriptor, tools = controlled_comparison_environment()
    unavailable = sorted(name for name, available in environment_descriptor['toolAvailability'].items() if not available)
    contracts = [
        {'id': 'query-and-preserve-complete-snapshot',
         'resultContract': '既有私有快照模式为600；成功保存完整JSON并输出id/title；查询、解析或缺字段失败时非零退出、保留旧快照且无临时文件；允许JSON排版和非零码数值不同。',
         'recipes': [{'id': name, 'authoredCommand': command, 'costs': configured_recipe_costs(command),
                      'equivalentUnderContract': False, 'scenarios': []}
                     for name, command in [('python-checked-save', SNAPSHOT_PYTHON_RECIPE),
                                            ('shell-validated-atomic-save', SNAPSHOT_ATOMIC_SHELL_RECIPE),
                                            ('shell-direct-redirection', SNAPSHOT_UNSAFE_SHELL_RECIPE)]]},
        {'id': 'read-bound-unicode-log-fragment',
         'resultContract': '读取精确绑定的UTF-8文本最后4个Unicode码点，保留换行；绑定文件缺失时非零退出，不切换latest。',
         'recipes': [{'id': name, 'authoredCommand': command, 'costs': configured_recipe_costs(command),
                      'equivalentUnderContract': False, 'scenarios': []}
                     for name, command in [('python-exact-character-slice', EVIDENCE_PYTHON_RECIPE),
                                            ('python-short-exact-character-slice', EVIDENCE_SHORT_PYTHON_RECIPE),
                                            ('tail-byte-slice', 'tail -c 4 review-evidence-bound/log.txt'),
                                            ('latest-evidence-substitution', 'tail -c 4 latest-review/log.txt')]]},
        {'id': 'read-required-json-field',
         'resultContract': '单个JSON对象必需的findings字段作为JSON值输出，保留null/false/0与空值；缺字段、空输入、多文档、坏JSON或根类型错误时非零且无stdout；输入不变、不执行内容。数值限定工具可无损表示范围。',
         'recipes': [{'id': name, 'authoredCommand': command, 'costs': configured_recipe_costs(command),
                      'equivalentUnderContract': None, 'scenarios': []}
                     for name, command in [('python-required-json-field', JSON_FIELD_PYTHON_RECIPE),
                                            ('python-short-required-json-field', JSON_FIELD_SHORT_PYTHON_RECIPE),
                                            ('jq-required-json-field', JSON_FIELD_JQ_RECIPE),
                                            ('jq-exit-status-as-value-validation', "jq -ce '.findings' -- ./result.json")]]},
        {'id': 'save-bound-current-task-snapshot',
         'resultContract': '在用户控制且无并发写入的私有目录中，原生校验当前会话并核对task/project；原始完整JSON以600同目录原子替换；查询/解析/身份/写入失败时旧文件和模式不变；拒绝目录及普通/悬空symlink，无暂存残留。不保证SIGKILL/断电清理与磁盘fsync。',
         'recipes': [{'id': 'shell-bound-current-task-atomic-save', 'authoredCommand': BOUND_TASK_SNAPSHOT_SHELL_RECIPE,
                      'costs': configured_recipe_costs(BOUND_TASK_SNAPSHOT_SHELL_RECIPE),
                      'equivalentUnderContract': None, 'scenarios': []},
                     {'id': 'shell-persisted-current-task-atomic-save',
                      'authoredCommand': 'sh ./save-bound-current-task-snapshot.sh',
                      'preparedScript': {'fileName': 'save-bound-current-task-snapshot.sh', 'source': BOUND_TASK_SNAPSHOT_SHELL_RECIPE},
                      'costs': configured_recipe_costs('sh ./save-bound-current-task-snapshot.sh', len(BOUND_TASK_SNAPSHOT_SHELL_RECIPE)),
                      'equivalentUnderContract': None, 'scenarios': []}]},
    ]
    result = {'schemaVersion': 'controlled-goal-recipe-comparisons/v1', 'measurementScope': 'controlled_synthetic_fixtures',
              'status': 'tools_unavailable' if unavailable else 'completed', 'environment': environment_descriptor,
              'unavailableToolKinds': unavailable, 'goalContracts': contracts,
              'oneTimeControlledFixtureSetup': {'sharedQueryFixtureCharacterCount': len(FIXTURE_QUERY_SOURCE),
                                                 'boundCurrentTaskQueryFixtureCharacterCount': len(BOUND_TASK_QUERY_SOURCE),
                                                 'observedModelToolInvocationCount': None},
              'limitations': ['仅证明上述合成场景；不证明所有文件系统故障或生产任务均等价。',
                              '输入文件为两配方共用的既有fixture；若真实任务需要额外准备文件，须另行计费。']}
    recipe_tool_dependencies = {
        'python-checked-save': {'posix_shell'},
        'shell-validated-atomic-save': {'posix_shell', 'jq', 'mktemp', 'mv', 'rm'},
        'shell-direct-redirection': {'posix_shell', 'jq'},
        'python-exact-character-slice': {'posix_shell'},
        'python-short-exact-character-slice': {'posix_shell'},
        'tail-byte-slice': {'posix_shell', 'tail'},
        'latest-evidence-substitution': {'posix_shell', 'tail'},
        'python-required-json-field': {'posix_shell'},
        'python-short-required-json-field': {'posix_shell'},
        'jq-required-json-field': {'posix_shell', 'jq'},
        'jq-exit-status-as-value-validation': {'posix_shell', 'jq'},
        'shell-bound-current-task-atomic-save': {'posix_shell', 'jq', 'mktemp', 'mv', 'rm'},
        'shell-persisted-current-task-atomic-save': {'posix_shell', 'jq', 'mktemp', 'mv', 'rm'},
    }
    for contract in contracts:
        for recipe in contract['recipes']:
            recipe['unavailableToolKinds'] = sorted(recipe_tool_dependencies[recipe['id']] & set(unavailable))
            recipe['status'] = 'tools_unavailable' if recipe['unavailableToolKinds'] else 'pending'
            recipe['equivalentUnderContract'] = None
    with tempfile.TemporaryDirectory(prefix='controlled-goal-recipes-', dir=artifacts_directory) as temporary:
        root = Path(temporary)
        binary_directory = root / 'bound-fixture-tools'
        binary_directory.mkdir()
        (binary_directory / 'python3').symlink_to(sys.executable)
        if environment_descriptor['toolAvailability']['posix_shell']:
            (binary_directory / 'sh').symlink_to(tools['posix_shell'])
        for name, path in tools.items():
            if name != 'posix_shell' and environment_descriptor['toolAvailability'][name]:
                (binary_directory / name).symlink_to(path)
        environment = {'PATH': str(binary_directory), 'HOME': str(root), 'USERPROFILE': str(root),
                       'CODEX_HOME': str(root / 'codex-configuration'), 'CODEX_SQLITE_HOME': str(root / 'codex-storage'),
                       'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'LC_ALL': 'C'}
        try:
            for recipe in contracts[0]['recipes']:
                if recipe['unavailableToolKinds']:
                    continue
                for scenario in ['success', 'query_failure', 'invalid_json', 'missing_fields']:
                    directory = root / f'{recipe["id"]}-{scenario}'
                    directory.mkdir()
                    (directory / 'fixture-query.py').write_text(FIXTURE_QUERY_SOURCE, encoding='utf-8')
                    snapshot = directory / 'task-snapshot.json'
                    previous = '{"oldSnapshot":"必须保留"}\n'.encode('utf-8')
                    snapshot.write_bytes(previous)
                    snapshot.chmod(0o600)
                    code, output = run_fixed_fixture_command(recipe['authoredCommand'].replace('SCENARIO_MODE', scenario), directory, environment)
                    preserved = snapshot.read_bytes() == previous
                    leftovers = any(path.name != 'task-snapshot.json' for path in directory.glob('task-snapshot.*'))
                    try:
                        selected = json.loads(output)
                        saved = json.loads(snapshot.read_bytes())
                    except (ValueError, UnicodeError):
                        selected, saved = None, None
                    mode_preserved = snapshot.stat().st_mode & 0o777 == 0o600
                    satisfied = ((code == 0 and saved == FIXTURE_QUERY_DOCUMENT and selected == {'id': 'synthetic-task', 'title': '合成任务'} and not leftovers) if scenario == 'success' else (code != 0 and preserved and not output and not leftovers)) and mode_preserved
                    recipe['scenarios'].append({'id': scenario, 'exitWasZero': code == 0, 'oldSnapshotPreserved': preserved,
                                                'snapshotModePreserved': mode_preserved, 'temporaryFileLeftBehind': leftovers, 'contractSatisfied': satisfied})
                recipe['equivalentUnderContract'] = all(case['contractSatisfied'] for case in recipe['scenarios'])
                recipe['status'] = 'completed'
            compare_first_batch_recipe_scenarios(contracts, root, environment)
            bound_text = '已绑定的旧评审：精确🧪尾部\n'
            for recipe in contracts[1]['recipes']:
                if recipe['unavailableToolKinds']:
                    continue
                for scenario in ['unicode_success', 'bound_file_missing']:
                    directory = root / f'{recipe["id"]}-{scenario}'
                    (directory / 'review-evidence-bound').mkdir(parents=True)
                    (directory / 'latest-review').mkdir()
                    if scenario == 'unicode_success':
                        (directory / 'review-evidence-bound/log.txt').write_text(bound_text, encoding='utf-8')
                    (directory / 'latest-review/log.txt').write_text('另一次评审：different\n', encoding='utf-8')
                    before = {str(path.relative_to(directory)): path.read_bytes() for path in directory.rglob('*') if path.is_file()}
                    code, output = run_fixed_fixture_command(recipe['authoredCommand'], directory, environment)
                    after = {str(path.relative_to(directory)): path.read_bytes() for path in directory.rglob('*') if path.is_file()}
                    satisfied = (code == 0 and output == bound_text[-4:].encode('utf-8')) if scenario == 'unicode_success' else (code != 0 and not output)
                    recipe['scenarios'].append({'id': scenario, 'exitWasZero': code == 0, 'sourceFilesUnchanged': before == after,
                                                'contractSatisfied': satisfied and before == after})
                recipe['equivalentUnderContract'] = all(case['contractSatisfied'] for case in recipe['scenarios'])
                recipe['status'] = 'completed'
        except (subprocess.TimeoutExpired, OSError):
            result['status'] = 'execution_failed'
            result['failureCategory'] = 'controlled_process_failed_or_timed_out'
            for contract in contracts:
                for recipe in contract['recipes']:
                    if recipe['status'] == 'pending':
                        recipe['status'] = 'execution_failed'
                        recipe['equivalentUnderContract'] = None
    return result
