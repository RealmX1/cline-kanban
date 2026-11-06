"""只执行本模块固化的合成配方；从不接收转录中的可执行正文。"""
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


def configured_recipe_costs(command):
    authored_command = command.replace('SCENARIO_MODE', 'success')
    return {'authoredCommandCharacterCount': len(authored_command), 'agentAuthoredInputFileCharacterCount': 0,
            'completeAuthoredCharacterCount': len(authored_command), 'goalCompletionShellInvocationCount': 1,
            'characterCountScenario': 'success',
            'observedModelToolInvocationCount': None, 'observedModelPreparationToolInvocationCount': None,
            'costScope': '提供相同既有合成输入后的单次目标配方；共享fixture建设单列，不外推生产收益。'}


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
    ]
    result = {'schemaVersion': 'controlled-goal-recipe-comparisons/v1', 'measurementScope': 'controlled_synthetic_fixtures',
              'status': 'tools_unavailable' if unavailable else 'completed', 'environment': environment_descriptor,
              'unavailableToolKinds': unavailable, 'goalContracts': contracts,
              'oneTimeControlledFixtureSetup': {'sharedQueryFixtureCharacterCount': len(FIXTURE_QUERY_SOURCE),
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
