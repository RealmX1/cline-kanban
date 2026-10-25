"""隔离联验的受控 reviewer 和收尾执行器；不替代产品 gate、凭据或 Git 结果。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(os.environ['RVF_NATIVE_E2E_ROOT'])
scripts = Path(os.environ['RVF_NATIVE_E2E_RVF_SCRIPTS'])
options = json.loads((root / 'isolated-chain-options.json').read_text())
mint = json.loads((root / 'actual-mint-result.json').read_text())
token = mint['token']
environment = dict(os.environ)


def execute(arguments, label):
    result = subprocess.run(arguments, env=environment, cwd=options['repositoryPath'], capture_output=True, text=True, timeout=60)
    (root / (label + '.json')).write_text(json.dumps({'argv': arguments, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}, ensure_ascii=False, indent=2))
    if result.returncode:
        raise RuntimeError(label + ': ' + result.stdout[-4000:] + result.stderr[-4000:])
    return result


start = json.loads((root / 'actual-start-result.json').read_text())
# run 目录从真实 start 回执读取，绝不猜 latest 或目录名。
prepared = start['detail']
run = Path(prepared['run_dir'])
run_id = prepared['run_id']
artifacts = run / 'artifacts'

if sys.argv[1] == 'review':
    reviewers = []
    for reviewer_id in ('controlled-reviewer-a', 'controlled-reviewer-b'):
        result_path = artifacts / 'reviewers' / reviewer_id / 'review-result.json'
        # 两个受控本地进程实际检查候选字节，再通过产品 writer 写规范结果。
        execute([sys.executable, '-c', "from pathlib import Path; assert Path('implementation.txt').read_text() == 'native reviewed implementation\\n'"], reviewer_id + '-validation')
        execute([sys.executable, str(scripts / 'write_review_result.py'), 'no-issues', '--out', str(result_path), '--audit-summary', '受控隔离候选内容检查通过'], reviewer_id + '-result')
        reviewers.append({'reviewer_id': reviewer_id, 'returncode': 0})
    (artifacts / 'reviewers' / 'reviewer-plan.json').write_text(json.dumps({'schema_version': 1, 'status': 'completed', 'reviewers': reviewers}))
    handoff = artifacts / 'handoff.md'
    handoff.write_text('# 隔离受控审查交接\n\n- handoff_status: COMPLETED\n- review_status: COMPLETED\n\n## 本次 review\n\n共 0 条，0 真实修复 / 0 误报 / 0 升级\n')
    execute([sys.executable, str(scripts / 'validation_result_cache.py'), 'run', '--repo', options['repositoryPath'], '--name', 'isolated-candidate-content', '--rvf-run-dir', str(run), '--', sys.executable, '-c', "from pathlib import Path; assert Path('implementation.txt').read_text() == 'native reviewed implementation\\n'"], 'actual-reviewed-content-validation')
    execute([sys.executable, str(scripts / 'rvf_run_finalize.py'), '--run-dir', str(run), '--handoff', str(handoff), '--decision-kind', 'handoff'], 'actual-rvf-finalize')
    finalized = json.loads((artifacts / '.finalize.lock').read_text())
    if finalized['errors']:
        raise RuntimeError(json.dumps(finalized['errors']))
else:
    handoff = artifacts / 'handoff.md'
    binding = {'taskId': os.environ['KANBAN_TASK_ID'], 'decisionToken': token, 'runId': run_id, 'handoffSha256': hashlib.sha256(handoff.read_bytes()).hexdigest()}
    execute([sys.executable, str(scripts / 'rvf_land.py'), 'prepare', '--repo', options['repositoryPath'], '--run-dir', str(run), '--handoff', str(handoff), '--format', 'json'], 'actual-land-prepare')
    message = artifacts / 'isolated-land-commit-message.txt'
    message.write_text('[TEST,AGENT]落地隔离 RVF 候选\n')
    land = json.loads(execute([sys.executable, str(scripts / 'rvf_land.py'), 'commit', '--repo', options['repositoryPath'], '--run-dir', str(run), '--message-file', str(message)], 'actual-land-commit').stdout)
    commit = land['commit_oid']

    def report(stage, commit_sha, **extra):
        path = artifacts / ('automatic-closeout-' + stage + '-execution-result.json')
        path.write_text(json.dumps({**binding, 'stage': stage, 'outcome': 'completed', 'commitSha': commit_sha, **extra}))
        return json.loads(execute([options['nodeBinary'], options['packagedCliPath'], 'task', 'report-rvf-automatic-closeout-execution-result', '--project-path', options['repositoryPath'], '--result-file', str(path)], 'actual-' + stage + '-report').stdout)

    report('land', commit)
    execute([sys.executable, options['baseBranchSyncScript'], '--task-worktree', options['repositoryPath'], '--base-worktree', options['baseWorktreePath'], '--base-ref', 'main'], 'actual-local-base-handback')
    completed = report('base_branch_sync', commit, baseRef='main')
    (root / 'actual-closeout-completed.json').write_text(json.dumps(completed, ensure_ascii=False, indent=2))
