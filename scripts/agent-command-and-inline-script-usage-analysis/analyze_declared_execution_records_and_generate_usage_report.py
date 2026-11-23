"""按显式清单只读分析命令记录；产物与来源冻结均留在指定目录。"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile
import traceback

from execution_record_parsing.extract_cli_routes_and_inline_script_bodies import UnresolvedShellExpansion, describe_inline_script_exclusion_reason, extract_inline_scripts, identify_cli
from candidate_goal_usage_reporting.classify_candidate_goals_and_render_privacy_safe_usage_report import agent_readable_usage_summary, render_safe_usage_html, safe_goal_usage_summary
from synthetic_recipe_validation.compare_fixed_recipe_results_and_preparation_costs import compare_fixed_goal_recipes, controlled_comparison_environment
from reviewed_execution_result_correlation.correlate_native_executions_with_reviewed_analysis_materials import summarize_reviewed_execution_results


INPUT_SCHEMA_VERSION = 'agent-command-usage-analysis-input/v1'
ANALYZER_VERSION = 'agent-command-and-inline-script-usage-analysis/v1'
SOURCE_FORMATS = {'codex-command-execution-jsonl', 'phase-one-normalized-executions-json'}
COVERAGE_KINDS = {'completed-shell-executions', 'direct-cli-subset', 'inline-script-subset'}


class InvalidAnalysisInput(ValueError):
    pass


def material_digest(content):
    return hashlib.sha256(content).hexdigest()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def json_digest(value):
    return material_digest(canonical_json(value).encode('utf-8'))


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def utc_instant(value):
    if not isinstance(value, str):
        raise InvalidAnalysisInput('invalid_timestamp')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError('timezone_required')
        return result.astimezone(timezone.utc)
    except ValueError as error:
        raise InvalidAnalysisInput('invalid_timestamp') from error


def require_object(value, allowed_keys, required_keys=()):
    if not isinstance(value, dict) or set(value) - set(allowed_keys) or not set(required_keys) <= set(value):
        raise InvalidAnalysisInput('invalid_object_fields')


def validate_manifest(manifest):
    require_object(manifest, ['schemaVersion', 'analysisWindow', 'sourceInputs', 'excludedExecutionSelectors',
                              'baselineReference', 'goalSampleSelection', 'executionResultReviews'], ['schemaVersion', 'analysisWindow', 'sourceInputs'])
    if manifest['schemaVersion'] != INPUT_SCHEMA_VERSION:
        raise InvalidAnalysisInput('unsupported_input_version')
    window = manifest['analysisWindow']
    require_object(window, ['startInclusive', 'endExclusive'], ['startInclusive', 'endExclusive'])
    if utc_instant(window['startInclusive']) >= utc_instant(window['endExclusive']):
        raise InvalidAnalysisInput('invalid_window')
    if not isinstance(manifest['sourceInputs'], list) or not manifest['sourceInputs']:
        raise InvalidAnalysisInput('sources_required')
    for source in manifest['sourceInputs']:
        require_object(source, ['path', 'format', 'coverage', 'sha256', 'required'], ['path', 'format', 'coverage'])
        if not isinstance(source['path'], str) or not source['path'] or not isinstance(source['format'], str) or not isinstance(source['coverage'], str) or source['format'] not in SOURCE_FORMATS or source['coverage'] not in COVERAGE_KINDS:
            raise InvalidAnalysisInput('invalid_source')
        if 'sha256' in source and (not isinstance(source['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', source['sha256'])):
            raise InvalidAnalysisInput('invalid_material_digest')
        if 'required' in source and not isinstance(source['required'], bool):
            raise InvalidAnalysisInput('invalid_source_requirement')
    selectors = manifest.get('excludedExecutionSelectors', [])
    if not isinstance(selectors, list):
        raise InvalidAnalysisInput('invalid_exclusions')
    for selector in selectors:
        require_object(selector, ['executionId', 'workingDirectoryPathContains', 'sourcePathContains'])
        if not selector or not all(isinstance(value, str) and value for value in selector.values()):
            raise InvalidAnalysisInput('invalid_exclusion')
    selection = manifest.get('goalSampleSelection', {})
    require_object(selection, ['maximumRecordCount', 'maximumRecordsPerStructureCluster', 'minimumStructureClusterCount'])
    for key, minimum, maximum in [('maximumRecordCount', 1, 60), ('maximumRecordsPerStructureCluster', 2, 5), ('minimumStructureClusterCount', 1, 30)]:
        if key in selection and (type(selection[key]) is not int or not minimum <= selection[key] <= maximum):
            raise InvalidAnalysisInput('invalid_sampling_bound')
    if 'baselineReference' in manifest:
        baseline = manifest['baselineReference']
        require_object(baseline, ['algorithmVersion', 'cliSummary', 'inlineScriptSummary'], ['algorithmVersion'])
        if baseline['algorithmVersion'] != 'phase-one-prototype/v1' or len(baseline) < 2:
            raise InvalidAnalysisInput('unsupported_baseline')
        for key in ['cliSummary', 'inlineScriptSummary']:
            if key in baseline:
                reference = baseline[key]
                require_object(reference, ['path', 'sha256'], ['path', 'sha256'])
                if not isinstance(reference['path'], str) or not isinstance(reference['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', reference['sha256']):
                    raise InvalidAnalysisInput('invalid_baseline_reference')
    if 'executionResultReviews' in manifest:
        reference = manifest['executionResultReviews']
        require_object(reference, ['path', 'sha256'], ['path', 'sha256'])
        if not isinstance(reference['path'], str) or not reference['path'] or not isinstance(reference['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', reference['sha256']):
            raise InvalidAnalysisInput('invalid_execution_result_review_reference')


def completed_artifact_manifest(directory):
    try:
        manifest_path = directory / 'private-analysis-run-manifest.json'
        if directory.is_symlink() or manifest_path.is_symlink():
            return None
        manifest = read_json(manifest_path)
        if manifest['analyzerVersion'] != ANALYZER_VERSION or manifest['status'] not in ['completed', 'partial']:
            return None
        owner = {'analyzerVersion': ANALYZER_VERSION, 'observationId': manifest['observationId']}
        if read_json(directory / 'analysis-artifact-owner.json') != owner:
            return None
        required_artifacts = {'analysis-artifact-owner.json', 'aggregate-usage-summary.json', 'private-normalized-executions.json',
                              'private-goal-evidence-catalog.json', 'private-frozen-analysis-input-manifest.json',
                              'goal-recipe-comparison-results.json', 'agent-command-usage-analysis.html'}
        if not required_artifacts <= set(manifest['artifactSha256']):
            return None
        for name, digest in manifest['artifactSha256'].items():
            path = directory / name
            if Path(name).name != name or path.is_symlink() or material_digest(path.read_bytes()) != digest:
                return None
        if 'executionResultReviews' in read_json(directory / 'private-frozen-analysis-input-manifest.json') and not {
                'private-frozen-execution-result-reviews.json', 'private-reviewed-execution-result-bindings.json'} <= set(manifest['artifactSha256']):
            return None
        # 仅在归属及全部内容摘要通过后修复权限；缓存与冻结恢复共用此入口。
        if directory.stat().st_mode & 0o7777 != 0o700:
            directory.chmod(0o700)
        for name in [*manifest['artifactSha256'], manifest_path.name]:
            path = directory / name
            if path.stat().st_mode & 0o7777 != 0o600:
                path.chmod(0o600)
        return manifest
    except (OSError, ValueError, KeyError, TypeError):
        return None


def recover_frozen_source(output_directory, specification):
    if not specification.get('sha256') or not output_directory.is_dir():
        return None
    for directory in sorted(output_directory.glob('observation-*')):
        manifest = completed_artifact_manifest(directory)
        if manifest is None:
            continue
        for binding in manifest['sourceBindings']:
            if any(binding['specification'][key] != specification[key] for key in ['format', 'coverage']) or binding['materialSha256'] != specification['sha256'] or binding['unavailableReason'] is not None:
                continue
            name = binding.get('frozenSourceArtifact')
            if name and name in manifest['artifactSha256']:
                result = read_json(directory / name)
                return {**result, 'recoveryKind': 'verified_frozen_source', 'recoveredFromObservationId': manifest['observationId']}
    return None


def normalize_execution(row, source_location):
    if not isinstance(row, dict) or not isinstance(row.get('command'), str):
        raise ValueError('invalid_execution')
    utc_instant(row.get('at'))
    if not isinstance(row.get('cwd', ''), str) or (row.get('exitCode') is not None and type(row['exitCode']) is not int):
        raise ValueError('invalid_execution_context')
    identity = row.get('executionId')
    if identity is not None and (not isinstance(identity, str) or not identity):
        raise ValueError('invalid_execution_identity')
    if isinstance(row.get('source'), dict):
        prior_locator = {key: value for key, value in row['source'].items()
                         if (key == 'file' and isinstance(value, str)) or (key == 'line' and type(value) is int)}
        source_location = {**source_location, 'declaredPriorSourceLocator': prior_locator}
    if isinstance(row.get('inlineCode'), str):
        source_location = {**source_location, 'priorInlineScriptCodeCharacterCount': len(row['inlineCode'])}
    normalized_execution = {'executionId': identity, 'at': row['at'], 'cwd': row.get('cwd', ''), 'command': row['command'],
                            'exitCode': row.get('exitCode'), 'output': row.get('output') if isinstance(row.get('output'), str) else None,
                            'sources': [source_location]}
    # 在逐记录错误边界拒绝不可编码字符串，避免后续摘要或冻结中断整份分析。
    canonical_json(normalized_execution).encode('utf-8')
    return normalized_execution


def read_execution_result_review_source(reference, manifest_directory, output_directory):
    if reference is None:
        return None
    result = {'specification': reference, 'materialSha256': None, 'contentText': None,
              'unavailableReason': None, 'primarySourceFailure': None, 'primaryObservedSha256': None,
              'recoveredFromObservationId': None}
    try:
        content = (manifest_directory / reference['path']).read_bytes()
        result['primaryObservedSha256'] = material_digest(content)
        if result['primaryObservedSha256'] != reference['sha256']:
            result['unavailableReason'] = 'declared_review_material_digest_mismatch'
        else:
            return {**result, 'materialSha256': reference['sha256'], 'contentText': content.decode('utf-8')}
    except FileNotFoundError:
        result['unavailableReason'] = 'declared_review_source_missing'
    except (OSError, UnicodeError):
        result['unavailableReason'] = 'declared_review_source_unreadable'
    for directory in sorted(output_directory.glob('observation-*')):
        completed = completed_artifact_manifest(directory)
        name = 'private-frozen-execution-result-reviews.json'
        if completed is None or name not in completed['artifactSha256']:
            continue
        try:
            frozen = read_json(directory / name)
        except (OSError, ValueError, TypeError):
            continue
        if not isinstance(frozen, dict):
            continue
        text = frozen.get('contentText')
        if isinstance(text, str) and frozen.get('materialSha256') == reference['sha256'] and material_digest(text.encode('utf-8')) == reference['sha256']:
            return {**result, 'materialSha256': reference['sha256'], 'contentText': text, 'unavailableReason': None,
                    'primarySourceFailure': result['unavailableReason'], 'recoveredFromObservationId': completed['observationId']}
    return result


def native_execution(event):
    if not isinstance(event, dict) or event.get('type') != 'event_msg':
        return None
    payload = event.get('payload', {})
    if not isinstance(payload, dict) or payload.get('type') != 'item_completed':
        return None
    item = payload.get('item', {})
    if not isinstance(item, dict) or item.get('type') != 'CommandExecution':
        return None
    argv = item.get('command')
    if not isinstance(argv, list) or not argv or not all(isinstance(value, str) for value in argv):
        raise ValueError('invalid_command_argv')
    command = argv[-1] if len(argv) == 3 and argv[1] in ['-c', '-lc'] else shlex.join(argv)
    return {'executionId': item.get('id'), 'at': event.get('timestamp'), 'cwd': item.get('cwd', ''),
            'command': command, 'exitCode': item.get('exit_code'), 'output': item.get('aggregated_output')}


def read_declared_source(specification, manifest_directory, output_directory):
    path = (manifest_directory / specification['path']).resolve()
    result = {'specification': specification, 'materialSha256': None, 'files': [], 'records': [],
              'issueCounts': {}, 'recoveryKind': None, 'unavailableReason': None,
              'primarySourceFailure': None, 'primaryObservedSha256': None}
    if not path.exists():
        recovered = recover_frozen_source(output_directory, specification)
        return {**recovered, 'primarySourceFailure': 'declared_source_missing', 'primaryObservedSha256': None} if recovered else {**result, 'unavailableReason': 'declared_source_missing'}
    issues = Counter()
    try:
        if path.is_dir():
            if specification['format'] != 'codex-command-execution-jsonl':
                raise InvalidAnalysisInput('directory_format_unsupported')
            paths = sorted(path.rglob('*.jsonl'))
            if not paths or any(not candidate.resolve().is_relative_to(path) for candidate in paths):
                return {**result, 'unavailableReason': 'empty_or_escaping_source_directory'}
        else:
            paths = [path]
        material_files = []
        for candidate in paths:
            content = candidate.read_bytes()
            digest = material_digest(content)
            material_files.append((candidate, content, digest))
        result['files'] = [{'path': str(candidate), 'sha256': digest} for candidate, _, digest in material_files]
        result['materialSha256'] = material_files[0][2] if path.is_file() else json_digest([
            {'path': str(candidate.relative_to(path)), 'sha256': digest} for candidate, _, digest in material_files])
        if specification.get('sha256') not in [None, result['materialSha256']]:
            recovered = recover_frozen_source(output_directory, specification)
            if recovered:
                return {**recovered, 'primarySourceFailure': 'material_digest_mismatch', 'primaryObservedSha256': result['materialSha256']}
            return {**result, 'unavailableReason': 'material_digest_mismatch'}
        for candidate, content, digest in material_files:
            if specification['format'] == 'phase-one-normalized-executions-json':
                rows = json.loads(content)
                if not isinstance(rows, list):
                    return {**result, 'unavailableReason': 'invalid_normalized_source'}
                entries = enumerate(rows, 1)
            else:
                entries = enumerate(content.decode('utf-8').splitlines(), 1)
            for position, entry in entries:
                try:
                    if specification['format'] == 'codex-command-execution-jsonl':
                        if not entry.strip():
                            continue
                        row = native_execution(json.loads(entry))
                        if row is None:
                            continue
                    else:
                        row = entry
                    location = {'file': str(candidate), 'position': position, 'materialSha256': digest}
                    result['records'].append(normalize_execution(row, location))
                except (ValueError, TypeError, KeyError, RecursionError):
                    issues['malformed_record'] += 1
    except InvalidAnalysisInput:
        raise
    except (OSError, ValueError, UnicodeError):
        result['unavailableReason'] = 'source_unreadable_or_invalid'
    result['issueCounts'] = dict(issues)
    return result


def deduplicate_executions(sources, manifest):
    start = utc_instant(manifest['analysisWindow']['startInclusive'])
    end = utc_instant(manifest['analysisWindow']['endExclusive'])
    grouped = defaultdict(list)
    excluded = 0
    for source in sources:
        for row in source['records']:
            if not start <= utc_instant(row['at']) < end:
                continue
            if any(all(row.get('executionId') == value if key == 'executionId' else
                       value in row['cwd'] if key == 'workingDirectoryPathContains' else
                       any(value in location['file'] for location in row['sources'])
                       for key, value in selector.items()) for selector in manifest.get('excludedExecutionSelectors', [])):
                excluded += 1
                continue
            grouped[row['executionId'] or ('missing_identity', json_digest(row))].append(row)
    records = []
    duplicates = 0
    for group in grouped.values():
        variants = []
        for row in sorted(group, key=canonical_json):
            same = next((other for other in variants if all(other[key] == row[key] for key in ['at', 'cwd', 'command', 'exitCode'])
                         and (row['output'] is None or other['output'] is None or row['output'] == other['output'])), None)
            if same is None:
                variants.append({**row, 'sources': list(row['sources'])})
            else:
                duplicates += 1
                same['sources'].extend(row['sources'])
                if same['output'] is None:
                    same['output'] = row['output']
        for row in variants:
            row['sources'] = sorted(row['sources'], key=canonical_json)
            row['identityConflicted'] = len(variants) > 1
            records.append(row)
    return sorted(records, key=lambda row: (utc_instant(row['at']), row['executionId'] or '', json_digest(row))), duplicates, excluded


def analyze_records(records):
    for row in records:
        row['inlineScripts'] = []
        try:
            row['inlineScripts'] = extract_inline_scripts(row['command'])
            row['directCli'] = identify_cli(row['command'], row['cwd'])
            row['parseStatus'] = 'recognized_supported_subset'
        except UnresolvedShellExpansion:
            row['directCli'] = None
            row['parseStatus'] = 'shell_expansion_unresolved'
        except (ValueError, RecursionError):
            row['directCli'] = None
            row['parseStatus'] = 'unsupported_shell_syntax'
        row['inlineExtractionExclusionReason'] = None if row['inlineScripts'] else describe_inline_script_exclusion_reason(row['command'])
        if row['parseStatus'] == 'shell_expansion_unresolved':
            row['inlineExtractionExclusionReason'] = 'shell_expansion_unresolved'
        if row['inlineExtractionExclusionReason'] in ['script_file_evaluation_arguments_unresolved', 'script_file_or_delegated_arguments_unresolved']:
            row['parseStatus'] = 'delegated_interpreter_input_unresolved'
        row['metrics'] = {
            'authoredCommandCharacterCount': len(row['command']),
            'agentAuthoredInlineScriptCharacterCount': sum(len(script['body']) for script in row['inlineScripts']) if row['inlineScripts'] or row['parseStatus'] == 'recognized_supported_subset' else None,
            'agentAuthoredInputFileCharacterCount': None, 'modelToolInvocationPayloadCharacterCount': None,
            'preparationToolInvocationCount': None, 'goalCompletionToolInvocationCount': None,
            'correctiveAttemptCount': None, 'firstAttemptSuccessful': None,
            'knownAuthoredCharacterSubtotal': len(row['command']), 'completeAuthoredCharacterCount': None,
            'tokenCount': None, 'goalElapsedTimeMs': None, 'usageOpportunityCount': None,
            'observedToolOutputCharacterCount': len(row['output']) if row['output'] is not None else None,
        }
        row['operationGoalObservationId'] = None


def aggregate_usage(sources, records, duplicate_count, excluded_count, manifest):
    known = [row for row in records if row['executionId'] and not row['identityConflicted']]
    unavailable = sum(bool(source['unavailableReason']) and source['specification'].get('required', True) for source in sources)
    optional_unavailable = sum(bool(source['unavailableReason']) and not source['specification'].get('required', True) for source in sources)
    identity_or_record_uncertain = any(row['identityConflicted'] or row['executionId'] is None for row in records) or any(source['issueCounts'].get('malformed_record', 0) for source in sources)
    is_subset = any(source['specification']['coverage'] != 'completed-shell-executions' for source in sources)
    return {
        'schemaVersion': 'agent-command-usage-aggregate/v1', 'analyzerVersion': ANALYZER_VERSION,
        'analysisWindow': manifest['analysisWindow'],
        'coverage': {'scope': 'declared-subsets-only' if is_subset else 'declared-completed-events',
                     'allShellExecutionCount': None if is_subset or unavailable or optional_unavailable or identity_or_record_uncertain else len(known),
                     'declaredSourceCount': len(sources), 'unavailableRequiredSourceCount': unavailable,
                     'unavailableOptionalSourceCount': optional_unavailable,
                     'recoveredSourceCount': sum(source['recoveryKind'] is not None for source in sources),
                     'sourceCoverageKinds': sorted({source['specification']['coverage'] for source in sources})},
        'counts': {'knownDistinctCompletedExecutions': len(known), 'duplicateSourceCopiesRemoved': duplicate_count,
                   'conflictedExecutionVariantCount': sum(row['identityConflicted'] for row in records),
                   'missingIdentityRecordCount': sum(row['executionId'] is None for row in records),
                   'malformedRecordCount': sum(source['issueCounts'].get('malformed_record', 0) for source in sources),
                   'excludedRecordCopyCount': excluded_count,
                   'directCliExecutions': sum(row['directCli'] is not None for row in known),
                   'inlineScriptExecutions': sum(bool(row['inlineScripts']) for row in known)},
        'limitations': ['仅代表清单声明的来源；子集并集不代表全部shell执行。',
                         '归属与同目标重试缺证时保持未知；不执行记录中的命令。',
                         '字符不是token；准备成本、生产收益和机会分母尚未证实。'],
    }


def historical_baseline_bridge(manifest, manifest_directory, summary, records):
    reference = manifest.get('baselineReference')
    baseline = {'algorithmVersion': 'phase-one-prototype/v1', 'verificationStatus': 'not_supplied',
                'independentNonHelpDirectCliExecutions': None, 'inlineScriptExecutions': None,
                'historicalAllShellExecutionCount': None}
    bridge = []
    unavailable = 0
    material_bindings = []
    if reference:
        baseline['verificationStatus'] = 'verified'
        for key in ['cliSummary', 'inlineScriptSummary']:
            if key not in reference:
                continue
            binding = reference[key]
            material_binding = {'kind': key, 'path': binding['path'], 'expectedSha256': binding['sha256'], 'observedSha256': None, 'verificationStatus': 'unavailable'}
            try:
                content = (manifest_directory / binding['path']).read_bytes()
                material_binding['observedSha256'] = material_digest(content)
                if material_digest(content) != binding['sha256']:
                    raise ValueError('baseline_material_mismatch')
                old = json.loads(content)
                if key == 'cliSummary':
                    values = {'independentNonHelpDirectCliExecutions': old['singleNonHelpLengths']['count']}
                    window = old['window']
                else:
                    values = {'inlineScriptExecutions': old['inlineScriptExecutions']['count'],
                              'historicalAllShellExecutionCount': old['totalObservedShellExecutions']}
                    window = {'startInclusive': old['window'][0], 'endExclusive': old['window'][1]}
                if any(type(value) is not int or value < 0 for value in values.values()):
                    raise ValueError('invalid_baseline_count')
                if any(utc_instant(window[field]) != utc_instant(manifest['analysisWindow'][field]) for field in ['startInclusive', 'endExclusive']):
                    baseline['verificationStatus'] = 'window_differs'
                baseline.update(values)
                material_binding['verificationStatus'] = 'verified'
            except (OSError, ValueError, KeyError, TypeError, IndexError):
                unavailable += 1
                baseline['verificationStatus'] = 'source_unavailable_or_invalid'
            material_bindings.append(material_binding)
        independent = sum(row['directCli'] is not None and row['directCli']['single'] and not row['directCli']['help']
                          for row in records if row['executionId'] and not row['identityConflicted'])
        for metric, current in [('independentNonHelpDirectCliExecutions', independent),
                                 ('inlineScriptExecutions', summary['counts']['inlineScriptExecutions'])]:
            historical = baseline[metric]
            if type(historical) is int:
                bridge.append({'metric': metric, 'historicalValue': historical, 'declaredInputValue': current,
                               'difference': current - historical,
                               'comparability': 'requires_coverage_and_parser_review',
                               'explanations': ['输入覆盖按清单保留，未重读历史全部shell分母。',
                                                '新版保留身份冲突、修正解释器位置及不支持语法；差异须结合私有记录复核。']})
    return {'historicalBaseline': baseline, 'baselineMetricBridge': bridge}, unavailable, material_bindings


def write_artifact(directory, name, value):
    path = directory / name
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    path.chmod(0o600)
    return material_digest(path.read_bytes())


def write_text_artifact(directory, name, value):
    path = directory / name
    path.write_text(value, encoding='utf-8')
    path.chmod(0o600)
    return material_digest(path.read_bytes())


def frozen_input_manifest(manifest, manifest_directory, sources):
    frozen = json.loads(canonical_json(manifest))
    for specification, source in zip(frozen['sourceInputs'], sources):
        specification['path'] = str((manifest_directory / specification['path']).resolve())
        if source['unavailableReason'] is None:
            specification['sha256'] = source['materialSha256']
    for key in ['cliSummary', 'inlineScriptSummary']:
        reference = frozen.get('baselineReference', {}).get(key)
        if reference:
            reference['path'] = str((manifest_directory / reference['path']).resolve())
    if 'executionResultReviews' in frozen:
        reference = frozen['executionResultReviews']
        reference['path'] = str((manifest_directory / reference['path']).resolve())
    return frozen


def require_existing_observation_directory_ownership(directory, owner):
    if directory.exists():
        try:
            if directory.is_symlink() or read_json(directory / 'analysis-artifact-owner.json') != owner:
                raise InvalidAnalysisInput('unowned_observation_directory')
            directory.chmod(0o700)
        except (OSError, ValueError, TypeError) as error:
            raise InvalidAnalysisInput('unowned_observation_directory') from error


def run_analysis(manifest_path, output_directory):
    try:
        manifest = read_json(manifest_path)
    except (OSError, UnicodeError) as error:
        reason = 'manifest_path_unresolvable' if isinstance(error, OSError) and error.errno == errno.ELOOP else 'manifest_unreadable'
        raise InvalidAnalysisInput(reason) from error
    validate_manifest(manifest)
    if output_directory.exists() and not output_directory.is_dir():
        raise InvalidAnalysisInput('artifacts_directory_is_file')
    for source in manifest['sourceInputs']:
        source_path = (manifest_path.parent / source['path']).resolve()
        if source_path.is_dir() and output_directory.is_relative_to(source_path):
            raise InvalidAnalysisInput('artifacts_inside_source_directory')
    sources = [read_declared_source(specification, manifest_path.parent, output_directory) for specification in manifest['sourceInputs']]
    review_source = read_execution_result_review_source(manifest.get('executionResultReviews'), manifest_path.parent, output_directory)
    analyzer_directory = Path(__file__).parent
    analyzer_digest = json_digest({path.relative_to(analyzer_directory).as_posix(): material_digest(path.read_bytes())
                                   for path in sorted(analyzer_directory.rglob('*.py'))})
    records, duplicates, excluded = deduplicate_executions(sources, manifest)
    analyze_records(records)
    summary = aggregate_usage(sources, records, duplicates, excluded, manifest)
    catalog, goal_summary = safe_goal_usage_summary(records, manifest.get('goalSampleSelection', {}))
    summary.update(goal_summary)
    reviewed_results, review_feedback = summarize_reviewed_execution_results(records, review_source)
    summary['executionResultFeedback'] = review_feedback
    summary['coverage']['unavailableRequiredExecutionResultReviewCount'] = int(review_feedback['status'] == 'partial')
    baseline_summary, unavailable_baselines, baseline_bindings = historical_baseline_bridge(manifest, manifest_path.parent, summary, records)
    summary.update(baseline_summary)
    summary['coverage']['unavailableRequiredBaselineCount'] = unavailable_baselines
    comparison_environment, _ = controlled_comparison_environment()
    observation_id = json_digest({'manifest': manifest, 'manifestDirectory': str(manifest_path.parent.resolve()),
                                  'analyzerSha256': analyzer_digest, 'baseline': baseline_summary,
                                  'baselineMaterialBindings': baseline_bindings,
                                  'controlledComparisonEnvironment': comparison_environment,
                                  'executionResultReviewSource': {key: review_source[key] for key in [
                                      'materialSha256', 'unavailableReason', 'primarySourceFailure', 'primaryObservedSha256']}
                                      if review_source is not None else None,
                                  'sources': [{**{key: source[key] for key in ['materialSha256', 'recoveryKind', 'unavailableReason', 'primarySourceFailure', 'primaryObservedSha256', 'files']},
                                               'resolvedDeclaredPath': str((manifest_path.parent / specification['path']).resolve()),
                                               'normalizedRecordsSha256': json_digest(source['records'])}
                                              for specification, source in zip(manifest['sourceInputs'], sources)]})
    directory = output_directory / f'observation-{observation_id}'
    completed = completed_artifact_manifest(directory)
    if completed and completed['observationId'] == observation_id and 'agent-readable-analysis-summary.json' in completed['artifactSha256']:
        return completed, directory, True
    owner = {'analyzerVersion': ANALYZER_VERSION, 'observationId': observation_id}
    require_existing_observation_directory_ownership(directory, owner)
    output_directory.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.preparing-command-analysis-', dir=output_directory))
    try:
        artifact_digests = {}
        artifact_digests['analysis-artifact-owner.json'] = write_artifact(staging, 'analysis-artifact-owner.json', owner)
        artifact_digests['private-frozen-analysis-input-manifest.json'] = write_artifact(staging, 'private-frozen-analysis-input-manifest.json', frozen_input_manifest(manifest, manifest_path.parent, sources))
        bindings = []
        for index, source in enumerate(sources):
            frozen_name = f'private-frozen-source-{index:03d}.json'
            artifact_digests[frozen_name] = write_artifact(staging, frozen_name, source)
            bindings.append({key: source[key] for key in ['specification', 'materialSha256', 'unavailableReason']})
            bindings[-1]['frozenSourceArtifact'] = frozen_name
        artifact_digests['private-normalized-executions.json'] = write_artifact(staging, 'private-normalized-executions.json', {'schemaVersion': 1, 'records': records})
        artifact_digests['private-goal-evidence-catalog.json'] = write_artifact(staging, 'private-goal-evidence-catalog.json', catalog)
        if review_source is not None:
            artifact_digests['private-frozen-execution-result-reviews.json'] = write_artifact(staging, 'private-frozen-execution-result-reviews.json', review_source)
            artifact_digests['private-reviewed-execution-result-bindings.json'] = write_artifact(staging, 'private-reviewed-execution-result-bindings.json', reviewed_results)
        comparisons = compare_fixed_goal_recipes(staging)
        artifact_digests['goal-recipe-comparison-results.json'] = write_artifact(staging, 'goal-recipe-comparison-results.json', comparisons)
        summary['controlledGoalComparisons'] = {'status': comparisons['status'], 'measurementScope': comparisons['measurementScope'],
            'goalContracts': [{'id': contract['id'], 'resultContract': contract['resultContract'],
                              'recipes': [{key: recipe[key] for key in ['id', 'costs', 'equivalentUnderContract', 'status', 'unavailableToolKinds']} for recipe in contract['recipes']]}
                             for contract in comparisons['goalContracts']]}
        artifact_digests['aggregate-usage-summary.json'] = write_artifact(staging, 'aggregate-usage-summary.json', summary)
        artifact_digests['agent-readable-analysis-summary.json'] = write_artifact(staging, 'agent-readable-analysis-summary.json', agent_readable_usage_summary(summary))
        artifact_digests['agent-command-usage-analysis.html'] = write_text_artifact(staging, 'agent-command-usage-analysis.html', render_safe_usage_html(summary))
        completed = {'analyzerVersion': ANALYZER_VERSION, 'analyzerSha256': analyzer_digest, 'observationId': observation_id,
                     'inputManifestSha256': material_digest(manifest_path.read_bytes()),
                     'status': 'partial' if summary['coverage']['unavailableRequiredSourceCount'] or unavailable_baselines or review_feedback['status'] == 'partial' else 'completed',
                     'baselineBindings': baseline_bindings,
                     'sourceBindings': bindings, 'artifactSha256': artifact_digests,
                     'recoveryPolicy': {'automaticAttemptsPerMaterialFingerprint': 1, 'retryWhen': '来源或分析器指纹变化；中断可整体只读重放。'}}
        write_artifact(staging, 'private-analysis-run-manifest.json', completed)
        if directory.exists():
            require_existing_observation_directory_ownership(directory, owner)
            concurrent_completion = completed_artifact_manifest(directory)
            if concurrent_completion and 'agent-readable-analysis-summary.json' in concurrent_completion['artifactSha256']:
                return concurrent_completion, directory, True
            preserved = output_directory / f'interrupted-{observation_id}-{os.urandom(6).hex()}'
            directory.rename(preserved)
        staging.rename(directory)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return completed, directory, False


def analyze_one_declared_manifest(manifest_path, output_directory):
    try:
        if sys.version_info < (3, 11):
            raise InvalidAnalysisInput('python_3_11_required')
        try:
            manifest_path = manifest_path.resolve()
        except (OSError, RuntimeError) as error:
            raise InvalidAnalysisInput('manifest_path_unresolvable') from error
        completed, directory, reused = run_analysis(manifest_path, output_directory.resolve())
        # EXPERIMENT_NODE: 用真实使用记录比较默认摘要与仅路径回执的总读取成本，再调整默认返回。
        return {'status': completed['status'], 'observationId': completed['observationId'],
                'observationDirectory': str(directory), 'reusedCompletedObservation': reused,
                'agentSummary': read_json(directory / 'agent-readable-analysis-summary.json'),
                'detailFiles': ['aggregate-usage-summary.json', 'agent-command-usage-analysis.html',
                                'private-analysis-run-manifest.json', 'private-goal-evidence-catalog.json']}, 3 if completed['status'] == 'partial' else 0
    except InvalidAnalysisInput as error:
        failure = {'errorCategory': 'invalid_analysis_input', 'reasonCode': str(error)}
        code = 2
    except json.JSONDecodeError as error:
        failure = {'errorCategory': 'invalid_analysis_input', 'reasonCode': 'invalid_json',
                   'jsonLine': error.lineno, 'jsonColumn': error.colno}
        code = 2
    except FileNotFoundError:
        failure = {'errorCategory': 'invalid_analysis_input', 'reasonCode': 'declared_file_missing'}
        code = 2
    except Exception as error:
        failure = {'errorCategory': 'internal_analysis_failure', 'exceptionType': type(error).__name__}
        failure['diagnosticFrames'] = [{'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
                                       for frame in traceback.extract_tb(error.__traceback__)[-5:]]
        code = 1
    return {'status': 'failed', 'inputManifestPath': str(manifest_path), **failure}, code


def main():
    parser = argparse.ArgumentParser(description='按显式清单离线分析命令与内联脚本；不执行被分析命令。')
    parser.add_argument('--input-manifest', required=True, type=Path, action='append', help='含窗口、来源与覆盖范围的JSON清单；可重复以批量分析')
    parser.add_argument('--analysis-artifacts-directory', required=True, type=Path, help='保存私有证据与聚合报告的持久目录')
    arguments = parser.parse_args()
    results = [analyze_one_declared_manifest(path, arguments.analysis_artifacts_directory)
               for path in arguments.input_manifest]
    if len(results) == 1:
        receipt, code = results[0]
        print(json.dumps(receipt, ensure_ascii=False), file=sys.stderr if code in (1, 2) else sys.stdout)
        return code
    analyses = [receipt for receipt, _ in results]
    codes = [code for _, code in results]
    completed_any = any('observationId' in receipt for receipt in analyses)
    status = 'completed' if all(code == 0 for code in codes) else 'partial' if completed_any else 'failed'
    print(json.dumps({'status': status, 'analyses': analyses,
                      'distinctAnalysisObservationCount': len({receipt['observationId'] for receipt in analyses if 'observationId' in receipt})}, ensure_ascii=False))
    return 0 if status == 'completed' else 3 if status == 'partial' else 1 if 1 in codes else 2


if __name__ == '__main__':
    sys.exit(main())
