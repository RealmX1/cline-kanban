"""将静态线索保留为候选目标；公开输出只使用固定类别和聚合数值。"""
from collections import Counter, defaultdict
import ast
import hashlib
from html import escape
import json
import math
import re

from shell_command_and_inline_script_parsing import classify_nonzero_output, classify_script, observable_kanban_cli_subprocess_routes


GOAL_FAMILIES = {
    'query-task-and-preserve-snapshot': ('查询任务并保留结果', '优先原生查询；保存快照须验证失败时旧文件保护。', ['kanban', 'jq']),
    'read-or-select-existing-file-or-json': ('读取或选择既有文件/JSON', '先确定文本或JSON；JSON可用已安装jq，文本按字符或行选工具；写入和多步校验另列契约。', ['jq', 'rg', 'tail']),
    'read-exact-review-evidence': ('读取精确绑定评审证据', '优先直接读取已绑定文件；不得以latest替代精确run/revision。', ['rg']),
    'read-fixed-log-fragment': ('读取固定日志片段', '先确定字节、字符或行；按行读取才可直接采用tail配方。', ['tail']),
    'repeat-investigation-analysis': ('重复调查与分析', '优先持久复用现有调查器；不要每轮重新撰写分析主体。', ['python3']),
    'source-or-business-content-generation': ('源码或业务正文生成', '正文可能是目标本身；长度不能证明冗余。', []),
    'unresolved-operation-goal': ('目标待证或其他计算', '继续静态补证；不得从cwd或文本相似推定真实目标。', []),
}
CANDIDATE_FAMILIES = set(GOAL_FAMILIES) - {'source-or-business-content-generation', 'unresolved-operation-goal'}


def length_distribution(values):
    values = sorted(values)
    return {'count': len(values), 'totalCharacters': sum(values),
            'medianCharacters': values[math.ceil(len(values) * .5) - 1] if values else None,
            'p95Characters': values[math.ceil(len(values) * .95) - 1] if values else None,
            'maximumCharacters': values[-1] if values else None}


def shell_outcome_category(row):
    if row['exitCode'] == 0:
        return 'shell_success'
    if row['exitCode'] is None:
        return 'shell_exit_unknown'
    if row['directCli'] is None and '包装 Kanban CLI 调用' not in row['staticPurposeLabelsNonExclusive']:
        return 'nonzero_source_unproven'
    classification = classify_nonzero_output({'exitCode': row['exitCode'], 'output': row['output'] or '',
                                               'help': bool(row['directCli'] and row['directCli']['help'])})
    for prefix, category in [('unknown option', 'unknown_cli_option'), ('required option', 'missing_cli_option'),
                             ('unknown command', 'unknown_cli_command'), ('CLI 已成功', 'cli_succeeded_downstream_failed'),
                             ('帮助已成功', 'help_succeeded_downstream_failed'), ('运行时连接', 'runtime_connection_or_timeout'),
                             ('身份门禁', 'identity_gate_rejected'), ('CLI 业务', 'cli_business_rejected')]:
        if classification and classification.startswith(prefix):
            return category
    return 'nonzero_source_unproven'


def enrich_goal_family_evidence(row):
    body = '\n'.join(script['body'] for script in row['inlineScripts'])
    try:
        related, labels, structure = classify_script(body) if body else (False, [], None)
    except (RecursionError, ValueError, TypeError):
        related, labels, structure = False, [], None
    text = body or row['command']
    direct_route = row['directCli']['route'] if row['directCli'] else ''
    wraps_cli = '包装 Kanban CLI 调用' in labels
    writes = '生成或改写文件' in labels
    write_only_syntax = False
    read_path_literals = []
    read_call_observed = False
    call_names = set()
    wrapped_routes = []
    try:
        # 字符串中的代码/业务正文不是调用证据；这里只观察语法，仍不推定控制流执行。
        calls = [node for node in ast.walk(ast.parse(body)) if isinstance(node, ast.Call)]
        call_names = {node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else '' for node in calls}
        for node in calls:
            if isinstance(node.func, ast.Attribute) and node.func.attr in ['read_text', 'read_bytes']:
                read_call_observed = True
                read_path_literals.extend(child.value for child in ast.walk(node.func.value) if isinstance(child, ast.Constant) and isinstance(child.value, str))
            if isinstance(node.func, ast.Name) and node.func.id == 'open' and node.args:
                mode = node.args[1] if len(node.args) > 1 else next((keyword.value for keyword in node.keywords if keyword.arg == 'mode'), ast.Constant(value='r'))
                if isinstance(mode, ast.Constant) and isinstance(mode.value, str) and mode.value in ['r', 'rt', 'rb'] and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    read_call_observed = True
                    read_path_literals.append(node.args[0].value)
        read_call_observed |= bool(call_names & {'load', 'loads', 'read', 'readline', 'readlines', 'readFileSync'})
        wrapped_routes = observable_kanban_cli_subprocess_routes(body, row['cwd'])
        write_only_syntax = bool(call_names & {'write_text', 'write_bytes', 'writeFileSync', 'appendFileSync'}) and not bool(call_names & {
            'read_text', 'read_bytes', 'readFileSync', 'open', 'read', 'load', 'loads', 'run', 'check_output', 'urlopen', 'get', 'post', 'fetch', 'request'})
    except (SyntaxError, ValueError, RecursionError):
        pass
    if row['directCli'] is not None:
        family = 'query-task-and-preserve-snapshot' if direct_route in ['task get', 'task get-current-task'] else 'unresolved-operation-goal'
    elif write_only_syntax or (writes and re.search(r'\.(?:tsx?|jsx?|py|md|html|css)[\'\"]', body)):
        family = 'source-or-business-content-generation'
    elif wraps_cli:
        family = 'query-task-and-preserve-snapshot' if wrapped_routes and all(route in ['task get', 'task get-current-task'] for route in wrapped_routes) else 'unresolved-operation-goal'
    elif any(re.search(r'agent-review|review-result|reviewer-findings|rvf.*(?:summary|result)|review.*\.json', path, re.I) for path in read_path_literals):
        family = 'read-exact-review-evidence'
    elif '日志或进程调查' in labels and call_names & {'walk', 'Counter', 'run', 'check_output', 'read_text', 'load', 'loads'} and re.search(r'CommandExecution|rollout|diagnostic-event|ast\.walk|Counter\(', body):
        family = 'repeat-investigation-analysis'
    elif read_call_observed and any(re.search(r'(?:\.log|stderr|stdout|日志)', path) for path in read_path_literals):
        family = 'read-fixed-log-fragment'
    elif read_call_observed:
        family = 'read-or-select-existing-file-or-json'
    else:
        family = 'unresolved-operation-goal'
    cluster_kind = 'python-ast' if structure else 'shell-shape' if row['directCli'] else 'exact-text-only'
    cluster_material = structure or (json.dumps({'route': direct_route, 'help': row['directCli']['help']}, sort_keys=True) if row['directCli'] else text)
    row['structuralClusterId'] = hashlib.sha256(cluster_material.encode('utf-8')).hexdigest()
    row['structuralClusterKind'] = cluster_kind
    row['operationGoalFamilyId'] = family
    row['goalClaimStatus'] = 'heuristic_candidate'
    row['explicitKanbanContent'] = related or row['directCli'] is not None
    row['staticPurposeLabelsNonExclusive'] = labels
    row['shellOutcomeCategory'] = shell_outcome_category(row)
    row['goalCounterEvidence'] = ['缺少可靠的同目标身份；相似代码不证明相同目标。', '准备文件成本未知。']
    if writes:
        row['goalCounterEvidence'].append('含文件写入；不能自动简化为纯读取。')
    if row['directCli'] is not None and family == 'unresolved-operation-goal':
        row['goalCounterEvidence'].append('已识别其他领域CLI路由；不按参数正文或路径词推断为读取。')
    if re.search(r'\blatest\b', text):
        row['goalCounterEvidence'].append('含latest定位；不能视为精确评审绑定。')
    if row['identityConflicted']:
        row['goalCounterEvidence'].append('原生执行身份存在材料冲突，排除独立执行计数。')


def sample_goal_evidence(records, selection):
    maximum = selection.get('maximumRecordCount', 60)
    per_cluster = selection.get('maximumRecordsPerStructureCluster', 5)
    minimum_clusters = selection.get('minimumStructureClusterCount', 10)
    groups = defaultdict(list)
    for row in records:
        groups[row['structuralClusterId']].append(row)
    priority = sorted(groups, key=lambda key: (len(groups[key]) < 2,
                      -max(len(row['command']) for row in groups[key]), key))
    # 先给可静态识别的结构簇保留名额，避免长文本组耗尽样本预算。
    chosen = [key for key in priority if groups[key][0]['structuralClusterKind'] != 'exact-text-only'][:minimum_clusters]
    represented_families = {groups[key][0]['operationGoalFamilyId'] for key in chosen}
    for key in priority:
        family = groups[key][0]['operationGoalFamilyId']
        if family not in represented_families:
            chosen.append(key)
            represented_families.add(family)
    for key in priority:
        if key not in chosen:
            chosen.append(key)
    samples = []
    selected_groups = []
    record_budget_prevented_minimum_cluster_sample = False
    for key in chosen:
        group = sorted(groups[key], key=lambda row: (-len(row['command']), row['executionId'] or '', row['command']))
        count = min(2, per_cluster, len(group))
        if maximum - len(samples) < count:
            record_budget_prevented_minimum_cluster_sample = True
            continue
        selected_groups.append((key, group))
        samples.extend(group[:count])
    for key, group in selected_groups:
        for row in group[min(2, per_cluster):per_cluster]:
            if len(samples) < maximum:
                samples.append(row)
    catalog = {'schemaVersion': 'agent-command-goal-evidence/v1', 'samples': [
        {key: row[key] for key in ['executionId', 'at', 'sources', 'structuralClusterId', 'structuralClusterKind',
                                   'operationGoalFamilyId', 'operationGoalObservationId', 'goalClaimStatus',
                                   'staticPurposeLabelsNonExclusive', 'goalCounterEvidence', 'metrics']} for row in samples]}
    sampled_cluster_counts = Counter(row['structuralClusterId'] for row in samples)
    sampled_structural_cluster_counts = Counter(row['structuralClusterId'] for row in samples if row['structuralClusterKind'] != 'exact-text-only')
    sampling_limitations = ['按目标族和长尾确定抽样，不代表总体目标比例。', '样本不足如实保留，不补造目标或样本。']
    if record_budget_prevented_minimum_cluster_sample:
        sampling_limitations.append('样本预算不足以容纳部分簇的最低配额，已跳过这些簇。')
    if 1 in sampled_structural_cluster_counts.values():
        sampling_limitations.append('源材料仅有1例的结构簇保留为单例，不计入满足至少2例的结构簇目标。')
    coverage = {'sampledExecutionVariantCount': len(samples), 'sampledStructuralClusterCount': len(sampled_structural_cluster_counts),
                'requestedMinimumStructuralClusterCount': minimum_clusters,
                'structuralClusterTargetMet': sum(count >= 2 for count in sampled_structural_cluster_counts.values()) >= minimum_clusters,
                'singletonClusterCount': sum(count == 1 for count in sampled_cluster_counts.values()),
                'unsupportedOrExactTextOnlySampleCount': sum(row['structuralClusterKind'] == 'exact-text-only' for row in samples),
                'goalIdentityProvenSampleCount': 0,
                'samplingLimitations': sampling_limitations}
    return catalog, coverage


def safe_goal_usage_summary(records, selection):
    for row in records:
        enrich_goal_family_evidence(row)
    catalog, coverage = sample_goal_evidence(records, selection)
    known = [row for row in records if row['executionId'] and not row['identityConflicted']]
    family_counts = Counter(row['operationGoalFamilyId'] for row in known)
    candidates = []
    for family in sorted(CANDIDATE_FAMILIES, key=lambda family: (-family_counts[family], family)):
        if not family_counts[family]:
            continue
        label, alternative, tools = GOAL_FAMILIES[family]
        candidates.append({'operationGoalFamilyId': family, 'label': label, 'candidateExecutionCount': family_counts[family],
                           'existingAlternative': alternative, 'requiredTools': tools, 'applicability': 'requires_contract_review',
                           'gap': '现有入口是否满足完整结果、错误传播和准备成本，仍须逐项验证。',
                           'nativeCapabilityEntryCriteriaProven': False,
                           'nextEvidence': ['至少5次同结果契约执行、2个可信任务或会话归属。', '完整语义及现有能力缺口。'],
                           'distinctProvenTaskOrSessionCount': None})
    costs = {'authoredCommands': length_distribution([len(row['command']) for row in known]),
             'inlineScripts': length_distribution([row['metrics']['agentAuthoredInlineScriptCharacterCount'] for row in known
                                                    if row['metrics']['agentAuthoredInlineScriptCharacterCount'] is not None and row['inlineScripts']]),
             'knownAuthoredCharacterSubtotal': sum(len(row['command']) for row in known),
             'completeAuthoredCharacterCount': None, 'agentAuthoredInputFileCharacterCount': None,
             'firstAttemptSuccessRate': None, 'goalCompletionToolInvocationCount': None,
             'tokenSavings': None, 'elapsedTimeSavingsMs': None, 'usageOpportunityCount': None,
             'overlapRule': '内联脚本和工具payload是command的包含项，不重复相加。'}
    prior_inline = [row for row in known if any('priorInlineScriptCodeCharacterCount' in source for source in row['sources'])]
    inline_bridge = {'observedPriorInlineClassificationCount': len(prior_inline),
                     'retainedAsSupportedInlineCount': sum(bool(row['inlineScripts']) for row in prior_inline),
                     'excludedOrUnresolvedByCategory': dict(sorted(Counter(row['inlineExtractionExclusionReason'] for row in prior_inline if not row['inlineScripts']).items())),
                     'scopeNote': '旧标签与受支持原生内联的差异；文件stdin、代理runner或嵌套参数不自动认定为旧误报，保留待证。'}
    direct = [row['directCli'] for row in known if row['directCli'] and row['directCli']['single'] and not row['directCli']['help']]
    composition = {'independentNonHelpDirectCliCount': len(direct),
                   'observedLaunchPrefixCharacters': length_distribution([item['prefixCharacters'] for item in direct]),
                   'explicitTaskAndProjectIdentityCharacters': length_distribution([item['identityCharacters'] for item in direct]),
                   'observedBusinessBodyCharacters': length_distribution([item['payloadCharacters'] for item in direct]),
                   'fixedBoilerplateCharacterCount': None,
                   'limitation': '词元跨度表示观察到的组成，不自动证明全部都是可删除的固定样板。'}
    return catalog, {'goalEvidence': coverage, 'operationGoalFamilyCandidateCounts': dict(sorted(family_counts.items())),
                     'shellOutcomeClassifications': dict(sorted(Counter(row['shellOutcomeCategory'] for row in known).items())),
                     'costs': costs, 'commandComposition': composition, 'priorInlineClassificationBridge': inline_bridge,
                     'thirdPhaseCandidates': candidates[:5]}


def render_safe_usage_html(summary):
    counts = summary['counts']
    families = summary['operationGoalFamilyCandidateCounts']
    maximum = max(families.values(), default=1)
    rows = ''.join(f'<tr data-family="{family}"><th scope="row">{escape(GOAL_FAMILIES[family][0])}</th>'
                   f'<td>{count:,}</td><td><progress value="{count}" max="{maximum}" aria-label="候选次数 {count}"></progress></td></tr>'
                   for family, count in sorted(families.items(), key=lambda entry: (-entry[1], entry[0])))
    options = ''.join(f'<option value="{family}">{escape(GOAL_FAMILIES[family][0])}</option>' for family in families)
    candidates = ''.join(f'<li><strong>{escape(candidate["label"])}</strong><p>{escape(candidate["existingAlternative"])}</p>'
                         '<p>原生能力进入条件尚未证实；先核对结果契约与真实归属。</p></li>' for candidate in summary['thirdPhaseCandidates'])
    comparisons = summary['controlledGoalComparisons']
    comparison_rows = ''.join(f'<tr><th scope="row">{escape(recipe["id"])}</th><td>{recipe["costs"]["completeAuthoredCharacterCount"]}</td>'
                              f'<td>{"待验证" if recipe["status"] != "completed" else "通过" if recipe["equivalentUnderContract"] else "拒绝"}</td></tr>'
                              for contract in comparisons['goalContracts'] for recipe in contract['recipes'])
    composition = summary['commandComposition']
    missing_required = summary['coverage']['unavailableRequiredSourceCount'] + summary['coverage']['unavailableRequiredBaselineCount']
    coverage_notice = '<p class="notice">部分结果：必要来源或历史基线缺失，不能视为完整分析。</p>' if missing_required else ''
    safe_payload = {key: summary[key] for key in ['counts', 'coverage', 'costs', 'commandComposition', 'goalEvidence', 'operationGoalFamilyCandidateCounts']}
    payload = json.dumps(safe_payload, ensure_ascii=False).replace('<', '\\u003c')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>命令与内联脚本：目标和完整成本</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111827;color:#f3f4f6}body{max-width:1000px;margin:auto;padding:clamp(16px,4vw,48px);line-height:1.65}h1{font-size:clamp(28px,4vw,44px);line-height:1.2}h2{margin-top:2em}p{max-width:75ch}main{min-width:0}.metrics{display:flex;gap:24px;flex-wrap:wrap;margin:32px 0}.metric{border-top:2px solid #6ee7b7;padding-top:12px;flex:1;min-width:180px}.metric strong{display:block;font-size:36px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;padding:12px 4px;border-bottom:1px solid #374151;overflow-wrap:anywhere}th{width:52%}td{width:24%}progress{max-width:100%;width:100%;accent-color:#6ee7b7}select{background:#1f2937;color:#f3f4f6;border:1px solid #9ca3af;padding:8px;max-width:100%}a{color:#6ee7b7}li{margin-bottom:20px}small{color:#cbd5e1}.notice{border-left:3px solid #fbbf24;padding-left:16px}*:focus-visible{outline:3px solid #6ee7b7;outline-offset:4px}</style>
<main><p>离线分析 · 声明来源 · 聚合导出</p><h1>命令变短，目标也要完整</h1>
<p class="notice">目标族来自静态线索，尚非同目标完成率。输入子集不能代表全部使用；准备文件、token和生产耗时缺证时保持未知。</p>''' + coverage_notice + '''
<div class="metrics">''' + f'<div class="metric"><strong>{counts["knownDistinctCompletedExecutions"]:,}</strong>可计独立执行</div><div class="metric"><strong>{counts["inlineScriptExecutions"]:,}</strong>含内联脚本的执行</div><div class="metric"><strong>{summary["goalEvidence"]["sampledStructuralClusterCount"]}</strong>已抽样结构簇</div></div>' + '''
<h2>哪些目标值得进一步核对</h2><label for="goal-filter">筛选目标族</label> <select id="goal-filter"><option value="all">全部候选目标</option>''' + options + '''</select>
<table><caption>候选标签分布，不外推为总体目标比例</caption><thead><tr><th>候选目标族</th><td>执行次数</td><td>相对分布</td></tr></thead><tbody>''' + rows + '''</tbody></table>
<h2>命令组成与完整成本</h2><p>''' + f'在{composition["independentNonHelpDirectCliCount"]}条独立非帮助CLI中，观察到的启动前缀中位{composition["observedLaunchPrefixCharacters"]["medianCharacters"]}字符，显式任务和项目身份中位{composition["explicitTaskAndProjectIdentityCharacters"]["medianCharacters"]}字符。' + '''这些是词元组成，不自动证明全部可以删除。</p><p>可观察command字符小计：''' + f'{summary["costs"]["knownAuthoredCharacterSubtotal"]:,}' + '''。内联代码已包含在command中，不重复相加。准备文件、完整目标调用链、首次成功率及生产收益仍为未知。</p>
<h2>同目标受控对照</h2><p>完整快照保存与精确Unicode证据读取。表中字符包含配方所需的新输入文件；共用的既有fixture建设单列于对照JSON，不能外推生产收益。</p>
<table><caption>相同结果契约，检查成功、失败与副作用</caption><thead><tr><th>合成配方</th><td>完整配方字符</td><td>语义检查</td></tr></thead><tbody>''' + comparison_rows + '''</tbody></table>
<h2>下一批候选与门槛</h2><ol>''' + candidates + '''</ol><p>先比较结果、身份、错误传播与旧产物保护，再比较字符数。低调用量不能直接推断能力无用。</p>
<small>本页不含原始命令、执行ID、会话ID、原始路径或stderr参数值；私有证据保留在独立产物中。</small></main>
<script type="application/json" id="aggregate-usage">''' + payload + '''</script><script>
document.getElementById('goal-filter').addEventListener('change',event=>{for(const row of document.querySelectorAll('tr[data-family]'))row.hidden=event.target.value!=='all'&&row.dataset.family!==event.target.value});
</script></html>'''
