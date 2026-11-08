"""只用合成记录验证分析入口，不读取宿主转录或运行记录中的命令。"""
import hashlib
import json
import shutil
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[3]
ANALYZER = REPOSITORY / 'scripts/agent-command-and-inline-script-usage-analysis/analyze_declared_execution_records_and_generate_usage_report.py'


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    return path


def execution(identity='execution-fixture', command='kanban task get --task-id example', **changes):
    return {'executionId': identity, 'at': '2026-10-30T01:00:00Z', 'cwd': '/synthetic-project',
            'command': command, 'exitCode': 0, **changes}


class AnalysisFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='command-analysis-fixture-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = write_json(self.root / 'normalized-executions.json', [execution()])
        self.manifest = {
            'schemaVersion': 'agent-command-usage-analysis-input/v1',
            'analysisWindow': {'startInclusive': '2026-10-28T12:30:00Z', 'endExclusive': '2026-11-04T12:30:00Z'},
            'sourceInputs': [{'path': self.source.name, 'format': 'phase-one-normalized-executions-json',
                              'coverage': 'direct-cli-subset', 'sha256': self.digest(self.source)}],
            'excludedExecutionSelectors': [],
            'goalSampleSelection': {'maximumRecordCount': 60, 'maximumRecordsPerStructureCluster': 5,
                                    'minimumStructureClusterCount': 10},
        }
        self.manifest_path = self.root / 'analysis-input-manifest.json'
        self.output = self.root / 'analysis-artifacts'

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def replace_source(self, records):
        write_json(self.source, records)
        self.manifest['sourceInputs'][0]['sha256'] = self.digest(self.source)

    def run_analysis(self, expected_status=0):
        write_json(self.manifest_path, self.manifest)
        result = subprocess.run([sys.executable, '-B', str(ANALYZER), '--input-manifest', str(self.manifest_path),
                                 '--analysis-artifacts-directory', str(self.output)],
                                capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertEqual(result.returncode, expected_status, result.stdout + result.stderr)
        if expected_status in (0, 3):
            receipt = json.loads(result.stdout)
            self.observation = Path(receipt['observationDirectory'])
            return receipt, json.loads((self.observation / 'aggregate-usage-summary.json').read_text())
        return result

    def private_records(self):
        return json.loads((self.observation / 'private-normalized-executions.json').read_text())['records']


class ManifestAndReplayTests(AnalysisFixture):
    def test_unencodable_execution_strings_do_not_discard_valid_records(self):
        for source_format in ['phase-one-normalized-executions-json', 'codex-command-execution-jsonl']:
            with self.subTest(source_format=source_format):
                records = [execution('valid-unicode', output='有效记录🌟'),
                           execution('invalid-high-surrogate-output', output='\ud800'),
                           execution('invalid-low-surrogate-output', output='\udfff'),
                           execution('invalid-command', command='\ud800'),
                           execution('invalid-cwd', cwd='\ud800'), execution('\ud800')]
                if source_format == 'phase-one-normalized-executions-json':
                    records.append(execution('invalid-prior-source', source={'file': '\ud800', 'line': 1}))
                    content = json.dumps(records, ensure_ascii=True)
                else:
                    content = '\n'.join(json.dumps({
                        'timestamp': row['at'], 'type': 'event_msg', 'payload': {'type': 'item_completed', 'item': {
                            'type': 'CommandExecution', 'id': row['executionId'], 'cwd': row['cwd'],
                            'command': ['/bin/sh', '-c', row['command']], 'exit_code': row['exitCode'],
                            'aggregated_output': row.get('output')}}}, ensure_ascii=True) for row in records)
                self.source.write_text(content, encoding='utf-8')
                source_digest = self.digest(self.source)
                self.manifest['sourceInputs'] = [{'path': self.source.name, 'format': source_format,
                                                 'coverage': 'completed-shell-executions', 'sha256': source_digest}]
                receipt, summary = self.run_analysis()
                self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
                self.assertEqual(summary['counts']['malformedRecordCount'], len(records) - 1)
                self.assertIsNone(summary['coverage']['allShellExecutionCount'])
                self.assertEqual(summary['coverage']['unavailableRequiredSourceCount'], 0)
                self.assertEqual(receipt['agentSummary']['attention']['malformedRecordCount'], len(records) - 1)
                self.assertEqual(receipt['agentSummary']['observedToolOutputCharacterCount'], len('有效记录🌟'))
                self.assertEqual([row['executionId'] for row in self.private_records()], ['valid-unicode'])
                replay, repeated_summary = self.run_analysis()
                self.assertTrue(replay['reusedCompletedObservation'])
                self.assertEqual(summary, repeated_summary)
                self.assertEqual(source_digest, self.digest(self.source))

    def test_cache_binds_resolved_source_paths_used_by_exclusions(self):
        observations = []
        counts = []
        original_source = self.source
        self.manifest['excludedExecutionSelectors'] = [{'sourcePathContains': 'excluded-source-location'}]
        for location in ['excluded-source-location', 'included-source-location']:
            directory = self.root / location
            directory.mkdir()
            (directory / original_source.name).write_bytes(original_source.read_bytes())
            self.manifest_path = directory / 'analysis-input-manifest.json'
            receipt, summary = self.run_analysis()
            observations.append(receipt['observationId'])
            counts.append(summary['counts']['knownDistinctCompletedExecutions'])
            self.assertFalse(receipt['reusedCompletedObservation'])
        self.assertEqual(counts, [0, 1])
        self.assertNotEqual(*observations)

    def test_cache_and_frozen_recovery_restore_private_artifact_permissions(self):
        self.run_analysis()
        for remove_source in [False, True]:
            observation = self.observation
            observation.chmod(0o755)
            for path in observation.iterdir():
                path.chmod(0o644)
            if remove_source:
                self.source.unlink()
            receipt, summary = self.run_analysis()
            self.assertEqual(observation.stat().st_mode & 0o7777, 0o700)
            self.assertTrue(all(path.stat().st_mode & 0o7777 == 0o600 for path in observation.iterdir()))
            self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
            self.assertEqual(receipt['reusedCompletedObservation'], not remove_source)

    def test_declared_subset_is_not_all_shell_executions_and_replay_is_deterministic(self):
        before = self.digest(self.source)
        first, summary = self.run_analysis()
        self.assertEqual(summary['coverage']['scope'], 'declared-subsets-only')
        self.assertIsNone(summary['coverage']['allShellExecutionCount'])
        self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
        records = (self.observation / 'private-normalized-executions.json').read_bytes()
        second, replay = self.run_analysis()
        self.assertEqual(first['observationId'], second['observationId'])
        self.assertTrue(second['reusedCompletedObservation'])
        self.assertEqual(summary, replay)
        self.assertEqual(records, (self.observation / 'private-normalized-executions.json').read_bytes())
        self.assertEqual(before, self.digest(self.source))

    def test_native_completed_events_windows_filters_and_malformed_lines(self):
        native = self.root / 'native-records.jsonl'
        def event(identity, at, status='item_completed'):
            return {'timestamp': at, 'type': 'event_msg', 'payload': {'type': status, 'item': {
                'type': 'CommandExecution', 'id': identity, 'cwd': '/synthetic-project',
                'command': ['/bin/sh', '-c', 'printf 合成'], 'exit_code': 0, 'aggregated_output': '合成'}}}
        native.write_text('\n'.join([json.dumps(event('kept', '2026-10-28T12:30:00Z')),
                                    json.dumps(event('excluded-end', '2026-11-04T12:30:00Z')),
                                    json.dumps(event('not-completed', '2026-10-30T00:00:00Z', 'item_started')),
                                    '{invalid JSON', json.dumps(event('filtered', '2026-10-30T00:00:00Z'))]), encoding='utf-8')
        self.manifest['sourceInputs'] = [{'path': native.name, 'format': 'codex-command-execution-jsonl',
                                        'coverage': 'completed-shell-executions', 'sha256': self.digest(native)}]
        self.manifest['excludedExecutionSelectors'] = [{'executionId': 'filtered'}]
        _, summary = self.run_analysis()
        self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
        self.assertEqual(summary['counts']['malformedRecordCount'], 1)
        self.assertEqual(self.private_records()[0]['executionId'], 'kept')

    def test_identical_copies_merge_but_real_repeats_and_identity_conflicts_survive(self):
        self.replace_source([execution('copy'), execution('copy'), execution('real-repeat'),
                             execution('conflict'), execution('conflict', command='kanban task list')])
        _, summary = self.run_analysis()
        self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 2)
        self.assertEqual(summary['counts']['duplicateSourceCopiesRemoved'], 1)
        self.assertEqual(summary['counts']['conflictedExecutionVariantCount'], 2)
        variants = [row for row in self.private_records() if row['executionId'] == 'conflict']
        self.assertEqual(len(variants), 2)
        self.assertTrue(all(row['identityConflicted'] for row in variants))

    def test_missing_required_source_is_partial_and_recovers_from_bound_frozen_records(self):
        self.run_analysis()
        self.source.unlink()
        _, summary = self.run_analysis()
        self.assertEqual(summary['coverage']['recoveredSourceCount'], 1)
        self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
        self.manifest['sourceInputs'][0]['sha256'] = 'a' * 64
        _, partial = self.run_analysis(3)
        self.assertEqual(partial['coverage']['unavailableRequiredSourceCount'], 1)
        self.assertEqual(partial['counts']['knownDistinctCompletedExecutions'], 0)
        _, repeated = self.run_analysis(3)
        self.assertEqual(partial, repeated)

    def test_corrupt_completed_artifact_is_replayed_instead_of_accepted(self):
        first, _ = self.run_analysis()
        (self.observation / 'aggregate-usage-summary.json').write_text('{broken')
        second, _ = self.run_analysis()
        self.assertEqual(first['observationId'], second['observationId'])
        self.assertFalse(second['reusedCompletedObservation'])

    def test_invalid_contract_and_material_drift_do_not_claim_success(self):
        self.manifest['schemaVersion'] = 'unknown'
        self.run_analysis(2)
        self.assertFalse(self.output.exists())
        self.manifest['schemaVersion'] = 'agent-command-usage-analysis-input/v1'
        self.manifest['sourceInputs'][0]['sha256'] = 'b' * 64
        _, summary = self.run_analysis(3)
        self.assertEqual(summary['coverage']['unavailableRequiredSourceCount'], 1)


class ParserAndGoalEvidenceTests(AnalysisFixture):
    def test_deep_output_json_keeps_result_unknown_and_other_records_analyzable(self):
        deep_output = '{"nested":' * 1500 + 'null' + '}' * 1500
        self.replace_source([execution('deep-output', exitCode=1, output=deep_output),
                             execution('other-success'),
                             execution('other-cli-error', exitCode=1, output="error: unknown option '--synthetic'")])
        source_digest = self.digest(self.source)
        _, summary = self.run_analysis()
        self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 3)
        self.assertEqual(summary['shellOutcomeClassifications'], {
            'nonzero_source_unproven': 1, 'shell_success': 1, 'unknown_cli_option': 1})
        by_identity = {row['executionId']: row for row in self.private_records()}
        self.assertEqual(by_identity['deep-output']['output'], deep_output)
        self.assertEqual(by_identity['deep-output']['shellOutcomeCategory'], 'nonzero_source_unproven')
        self.assertEqual(source_digest, self.digest(self.source))

    def test_quoted_body_evidence_is_independent_of_unrelated_environment_expansion(self):
        commands = {
            'unquoted-heredoc': 'python3 - <<PY\nprint("$SYNTHETIC_UNOBSERVED_VALUE")\nPY',
            'quoted-heredoc': "python3 - <<'PY'\nprint(\"$SYNTHETIC_LITERAL_TEXT\")\nPY",
            'dynamic-environment': 'env NOTE="$SYNTHETIC_UNOBSERVED_VALUE" python3 -c \'print(1)\'',
            'quoted-eval': 'python3 -c \'print("$SYNTHETIC_LITERAL_TEXT")\'',
        }
        self.replace_source([execution(identity, command=command) for identity, command in commands.items()])
        self.run_analysis()
        by_identity = {row['executionId']: row for row in self.private_records()}
        unknown = by_identity['unquoted-heredoc']
        self.assertEqual(unknown['parseStatus'], 'shell_expansion_unresolved')
        self.assertEqual(unknown['inlineScripts'], [])
        self.assertIsNone(unknown['metrics']['agentAuthoredInlineScriptCharacterCount'])
        for identity, body in [('quoted-heredoc', 'print("$SYNTHETIC_LITERAL_TEXT")\n'),
                               ('dynamic-environment', 'print(1)'),
                               ('quoted-eval', 'print("$SYNTHETIC_LITERAL_TEXT")')]:
            row = by_identity[identity]
            self.assertEqual(row['parseStatus'], 'recognized_supported_subset', identity)
            self.assertEqual(row['inlineScripts'], [{'language': 'Python', 'body': body}], identity)
            self.assertEqual(row['metrics']['agentAuthoredInlineScriptCharacterCount'], len(body), identity)

    def test_dynamic_shell_expansion_keeps_inline_body_and_cost_unknown_without_execution(self):
        sentinel = self.root / 'shell-expansion-must-not-execute'
        commands = ['python3 -c "$PRIVATE_SCRIPT"', 'node --eval="${PRIVATE_SCRIPT}"',
                    "echo $(python3 -c 'print(1)')", "echo `node -e 'console.log(1)'`",
                    'python3 - <<PY\nprint("$PRIVATE_VALUE")\nPY',
                    'python3 -c "$(touch ' + shlex.quote(str(sentinel)) + ')"']
        self.replace_source([execution(str(index), command=command) for index, command in enumerate(commands)])
        self.run_analysis()
        self.assertFalse(sentinel.exists())
        for row in self.private_records():
            self.assertEqual(row['inlineScripts'], [], row['command'])
            self.assertNotEqual(row['parseStatus'], 'recognized_supported_subset', row['command'])
            self.assertIsNone(row['metrics']['agentAuthoredInlineScriptCharacterCount'], row['command'])

    def test_literal_shell_metacharacters_remain_known_and_option_terminators_stop_evaluation(self):
        sys.path.insert(0, str(ANALYZER.parent))
        from execution_record_parsing.extract_cli_routes_and_inline_script_bodies import extract_inline_scripts
        for command in ["python3 -- -c 'script filename argument'", "node -- -e 'script filename argument'",
                        "node -- --eval='script filename argument'"]:
            self.assertEqual(extract_inline_scripts(command), [], command)
        for body in ['print("$PRIVATE_SCRIPT")', 'print("$(literal) `literal`")']:
            self.assertEqual(extract_inline_scripts('python3 -c ' + shlex.quote(body))[0]['body'], body)
        escaped = 'python3 -c "print(\'\\$literal\')"'
        self.assertTrue(extract_inline_scripts(escaped))

    def test_wrapped_cli_routes_and_actual_file_reads_control_goal_candidates(self):
        bodies = {
            'publish': "import subprocess; subprocess.run(['kanban','task','visualization','publish','--source-html-file','review-result.html'])",
            'delete': "import subprocess; subprocess.run(['kanban','task','delete','--task-id','example'])",
            'literal': 'print("review-result.json")',
            'literal-code': 'print("Path(\'review-result.json\').read_text()")',
            'query': "import subprocess; cli=['node','/bin/kanban']; subprocess.run(cli+['task','get','--task-id','example'])",
            'read': "from pathlib import Path; print(Path('review-result.json').read_text())",
            'open': "print(open('review-result.json').read())",
        }
        self.replace_source([execution(identity, command='python3 -c ' + shlex.quote(body)) for identity, body in bodies.items()])
        _, summary = self.run_analysis()
        by_identity = {row['executionId']: row for row in self.private_records()}
        for identity in ['publish', 'delete', 'literal', 'literal-code']:
            self.assertEqual(by_identity[identity]['operationGoalFamilyId'], 'unresolved-operation-goal', identity)
        self.assertEqual(by_identity['query']['operationGoalFamilyId'], 'query-task-and-preserve-snapshot')
        for identity in ['read', 'open']:
            self.assertEqual(by_identity[identity]['operationGoalFamilyId'], 'read-exact-review-evidence')
        self.assertEqual(summary['operationGoalFamilyCandidateCounts']['query-task-and-preserve-snapshot'], 1)
        self.assertEqual(summary['operationGoalFamilyCandidateCounts']['read-exact-review-evidence'], 2)

    def test_original_parser_checks_and_interpreter_position_boundaries(self):
        sys.path.insert(0, str(ANALYZER.parent))
        from execution_record_parsing.extract_cli_routes_and_inline_script_bodies import extract_inline_scripts, verify_extraction, verify_parser
        verify_parser()
        verify_extraction()
        for command in ["printf '%s' 'python3 -c example'", "python3 existing.py -c 'argument, not code'",
                        "node existing.js --eval 'argument, not code'", "rg -e 'node' code",
                        "cat <<'DOC'\npython3 -c 'example'\nDOC"]:
            self.assertEqual(extract_inline_scripts(command), [], command)
        for command, body in [("python3 -c 'print(\"多行\")\nprint(2)'", 'print("多行")\nprint(2)'),
                              ("node --input-type=module -e 'console.log(1)'", 'console.log(1)'),
                              ("node --import tsx --input-type=module - <<'JS'\nconsole.log(1)\nJS", 'console.log(1)\n'),
                              ("python3 -X utf8 -c 'print(1)'", 'print(1)'),
                              ("node 2> errors.log <<'JS'\nconsole.log(1)\nJS", 'console.log(1)\n')]:
            self.assertEqual(extract_inline_scripts(command)[0]['body'], body)
        self.assertEqual(extract_inline_scripts("node existing.mjs <<'HTML'\n<h1>正文</h1>\nHTML"), [])
        self.assertEqual(extract_inline_scripts("echo okay #; python3 -c 'comment-only'"), [])

    def test_private_commands_sources_and_error_values_never_enter_public_export(self):
        sentinel = self.root / 'PRIVATE_SENTINEL_MUST_NOT_EXECUTE'
        command = f'python3 -c "from pathlib import Path; Path({str(sentinel)!r}).touch()"'
        self.replace_source([execution('PRIVATE_EXECUTION_ID', command=command,
                                      source={'file': '/PRIVATE_TRANSCRIPT_PATH', 'line': 42}),
                             execution('PRIVATE_CLI_ID', command='kanban PRIVATE_ROUTE --reason PRIVATE_PARAMETER',
                                       output="error: unknown option 'PRIVATE_OPTION'", exitCode=1)])
        _, summary = self.run_analysis()
        public = (self.observation / 'aggregate-usage-summary.json').read_text() + (self.observation / 'agent-command-usage-analysis.html').read_text()
        self.assertNotIn('PRIVATE_', public)
        self.assertFalse(sentinel.exists())
        self.assertEqual(summary['shellOutcomeClassifications']['unknown_cli_option'], 1)
        self.assertIn('/PRIVATE_TRANSCRIPT_PATH', json.dumps(self.private_records()))

    def test_similar_ast_and_nearby_success_do_not_invent_goal_identity_or_free_preparation(self):
        self.replace_source([execution('first', command="python3 -c 'import json; print(json.load(open(\"a.json\")))'", exitCode=1),
                             execution('second', command="python3 -c 'import json; print(json.load(open(\"b.json\")))'",
                                       at='2026-10-30T01:01:00Z'),
                             execution('unknown', command="python3 -c 'unclosed")])
        self.run_analysis()
        records = self.private_records()
        for row in records:
            self.assertIsNone(row['operationGoalObservationId'])
            self.assertIsNone(row['metrics']['correctiveAttemptCount'])
            self.assertIsNone(row['metrics']['firstAttemptSuccessful'])
            self.assertIsNone(row['metrics']['agentAuthoredInputFileCharacterCount'])
            self.assertIsNone(row['metrics']['completeAuthoredCharacterCount'])
        self.assertIsNone(next(row for row in records if row['executionId'] == 'unknown')['metrics']['agentAuthoredInlineScriptCharacterCount'])
        catalog = json.loads((self.observation / 'private-goal-evidence-catalog.json').read_text())
        self.assertTrue(all(row['goalClaimStatus'] == 'heuristic_candidate' for row in catalog['samples']))
        self.assertTrue(all(row['operationGoalObservationId'] is None for row in catalog['samples']))

    def test_sampling_is_bounded_deterministic_and_reports_actual_structural_coverage(self):
        rows = []
        for cluster in range(12):
            for member in range(6):
                body = f'def inspect_fixture_{cluster}():\n return {member}\nprint(inspect_fixture_{cluster}())'
                rows.append(execution(f'cluster-{cluster}-{member}', command='python3 -c ' + shlex.quote(body)))
        for cluster in range(40):
            for member in range(2):
                rows.append(execution(f'exact-{cluster}-{member}', command='printf ' + str(cluster) + 'x' * 1000))
        self.replace_source(rows)
        _, summary = self.run_analysis()
        catalog = json.loads((self.observation / 'private-goal-evidence-catalog.json').read_text())
        self.assertLessEqual(len(catalog['samples']), 60)
        self.assertGreaterEqual(summary['goalEvidence']['sampledStructuralClusterCount'], 10)
        by_cluster = {}
        for sample in catalog['samples']:
            by_cluster[sample['structuralClusterId']] = by_cluster.get(sample['structuralClusterId'], 0) + 1
        self.assertTrue(all(2 <= count <= 5 for count in by_cluster.values()))
        self.assertLessEqual(len(summary['thirdPhaseCandidates']), 5)
        self.assertTrue(all(not row['nativeCapabilityEntryCriteriaProven'] for row in summary['thirdPhaseCandidates']))
        samples_before = catalog['samples']
        self.replace_source(list(reversed(rows)))
        self.run_analysis()
        repeated = json.loads((self.observation / 'private-goal-evidence-catalog.json').read_text())
        self.assertEqual([row['executionId'] for row in samples_before], [row['executionId'] for row in repeated['samples']])

    def test_sampling_keeps_cluster_pairs_whole_when_record_budget_is_odd(self):
        rows = [execution(f'cluster-{cluster}-{member}', command='python3 -c ' + shlex.quote(
            f'def inspect_fixture_{cluster}():\n return {member}\nprint(inspect_fixture_{cluster}())'))
            for cluster in range(2) for member in range(2)]
        self.replace_source(rows)
        self.manifest['goalSampleSelection']['minimumStructureClusterCount'] = 2
        for maximum, expected_cluster_sizes in [(1, []), (3, [2]), (4, [2, 2])]:
            with self.subTest(maximumRecordCount=maximum):
                self.manifest['goalSampleSelection']['maximumRecordCount'] = maximum
                _, summary = self.run_analysis()
                catalog = json.loads((self.observation / 'private-goal-evidence-catalog.json').read_text())
                cluster_sizes = {}
                for sample in catalog['samples']:
                    key = sample['structuralClusterId']
                    cluster_sizes[key] = cluster_sizes.get(key, 0) + 1
                self.assertEqual(sorted(cluster_sizes.values()), expected_cluster_sizes)
                self.assertLessEqual(len(catalog['samples']), maximum)
                self.assertEqual(summary['goalEvidence']['structuralClusterTargetMet'], maximum == 4)
                self.assertEqual(summary['goalEvidence']['singletonClusterCount'], 0)
                if maximum < 4:
                    self.assertIn('预算不足', ''.join(summary['goalEvidence']['samplingLimitations']))

    def test_sampling_rejects_a_per_cluster_limit_below_the_two_record_minimum(self):
        self.manifest['goalSampleSelection']['maximumRecordsPerStructureCluster'] = 1
        result = self.run_analysis(2)
        self.assertEqual(json.loads(result.stderr)['errorCategory'], 'invalid_analysis_input')
        self.assertFalse(self.output.exists())

    def test_sampling_preserves_source_singletons_without_claiming_cluster_target_met(self):
        rows = [execution(f'cluster-{cluster}-{member}', command='python3 -c ' + shlex.quote(
            f'def inspect_fixture_{cluster}():\n return {member}\nprint(inspect_fixture_{cluster}())'))
            for cluster, count in [(0, 2), (1, 1)] for member in range(count)]
        self.replace_source(rows)
        self.manifest['goalSampleSelection']['minimumStructureClusterCount'] = 2
        _, summary = self.run_analysis()
        coverage = summary['goalEvidence']
        self.assertEqual(coverage['sampledExecutionVariantCount'], 3)
        self.assertEqual(coverage['sampledStructuralClusterCount'], 2)
        self.assertEqual(coverage['singletonClusterCount'], 1)
        self.assertFalse(coverage['structuralClusterTargetMet'])

    def test_historical_baseline_is_hash_bound_and_does_not_replace_observed_denominator(self):
        baseline = write_json(self.root / 'baseline-summary.json', {
            'totalObservedShellExecutions': 33013,
            'inlineScriptExecutions': {'count': 9542}, 'window': ['2026-10-28T12:30:00Z', '2026-11-04T12:30:00Z'],
            'longScriptSamples': [{'executionId': 'PRIVATE_BASELINE_ID'}]})
        self.manifest['baselineReference'] = {'algorithmVersion': 'phase-one-prototype/v1',
                                              'inlineScriptSummary': {'path': baseline.name, 'sha256': self.digest(baseline)}}
        _, summary = self.run_analysis()
        self.assertEqual(summary['historicalBaseline']['inlineScriptExecutions'], 9542)
        self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
        self.assertIsNone(summary['coverage']['allShellExecutionCount'])
        self.assertNotIn('PRIVATE_BASELINE_ID', json.dumps(summary))
        self.assertTrue(summary['baselineMetricBridge'])

    def test_prior_script_file_labels_have_explicit_scope_bridge(self):
        self.replace_source([execution('stdin', command="node existing.mjs <<'HTML'\n<h1>正文</h1>\nHTML", inlineCode='<h1>正文</h1>'),
                             execution('delegate', command="python3 delegated.py -c 'print(1)'", inlineCode='print(1)')])
        _, summary = self.run_analysis()
        self.assertEqual(summary['priorInlineClassificationBridge']['excludedOrUnresolvedByCategory'],
                         {'script_file_evaluation_arguments_unresolved': 1, 'script_file_standard_input_unclassified': 1})
        delegate = next(row for row in self.private_records() if row['executionId'] == 'delegate')
        self.assertIsNone(delegate['metrics']['agentAuthoredInlineScriptCharacterCount'])
        self.assertIn('observedLaunchPrefixCharacters', summary['commandComposition'])

    def test_business_literal_and_native_publish_do_not_become_read_goals(self):
        generated_source = 'import json\nprint(json.load(open("audit.log")))\n'
        body = 'from pathlib import Path\nPath("generated-program").write_text(' + repr(generated_source) + ')'
        self.replace_source([execution('generation', command='python3 -c ' + shlex.quote(body)),
                             execution('publish', command='kanban task visualization publish --source-html-file ./review-result.html')])
        self.run_analysis()
        by_identity = {row['executionId']: row for row in self.private_records()}
        self.assertEqual(by_identity['generation']['operationGoalFamilyId'], 'source-or-business-content-generation')
        self.assertEqual(by_identity['publish']['operationGoalFamilyId'], 'unresolved-operation-goal')


class ControlledGoalRecipeTests(AnalysisFixture):
    def test_required_json_field_preserves_false_null_empty_values_and_rejects_invalid_input(self):
        self.run_analysis()
        comparisons = json.loads((self.observation / 'goal-recipe-comparison-results.json').read_text())
        contract = next(item for item in comparisons['goalContracts'] if item['id'] == 'read-required-json-field')
        recipes = {recipe['id']: recipe for recipe in contract['recipes']}
        for name in ['python-required-json-field', 'python-short-required-json-field', 'jq-required-json-field']:
            recipe = recipes[name]
            if recipe['status'] == 'tools_unavailable':
                self.assertIsNone(recipe['equivalentUnderContract'])
                continue
            self.assertTrue(recipe['equivalentUnderContract'], recipe)
            self.assertEqual({case['id'] for case in recipe['scenarios']}, {
                'array_value', 'null_value', 'false_value', 'zero_value', 'empty_string', 'empty_array',
                'empty_object', 'literal_shell_code', 'missing_field', 'invalid_json', 'empty_input',
                'multiple_documents', 'array_root', 'missing_file',
            })
            self.assertTrue(all(case['sourceFilesUnchanged'] and case['inputWasNotExecuted']
                                for case in recipe['scenarios']))
        rejected = recipes['jq-exit-status-as-value-validation']
        if rejected['status'] == 'completed':
            self.assertFalse(rejected['equivalentUnderContract'])
        else:
            self.assertIsNone(rejected['equivalentUnderContract'])

    def test_bound_current_task_snapshot_checks_identity_atomic_replacement_and_unsafe_targets(self):
        self.run_analysis()
        comparisons = json.loads((self.observation / 'goal-recipe-comparison-results.json').read_text())
        contract = next(item for item in comparisons['goalContracts'] if item['id'] == 'save-bound-current-task-snapshot')
        self.assertEqual(len(contract['recipes']), 2)
        for recipe in contract['recipes']:
            if recipe['status'] == 'tools_unavailable':
                self.assertIsNone(recipe['equivalentUnderContract'])
                continue
            self.assertTrue(recipe['equivalentUnderContract'], recipe)
            self.assertEqual({case['id'] for case in recipe['scenarios']}, {
                'success', 'new_snapshot', 'query_failure', 'invalid_json', 'missing_fields',
                'wrong_task', 'wrong_project', 'missing_session', 'wrong_session', 'multiple_documents',
                'target_symlink', 'dangling_target_symlink', 'target_directory', 'temporary_creation_failure',
                'atomic_replace_failure', 'query_terminated',
            })
            success = next(case for case in recipe['scenarios'] if case['id'] == 'success')
            self.assertTrue(success['replacedFileIdentity'])
            self.assertEqual(success['snapshotMode'], '600')
            self.assertTrue(all(not case['temporaryFileLeftBehind'] for case in recipe['scenarios']))
        inline, persisted = [recipe['costs'] for recipe in contract['recipes']]
        self.assertGreater(persisted['completeAuthoredCharacterCount'], inline['completeAuthoredCharacterCount'])
        self.assertLess(persisted['reusedPreparedInputAuthoredCharacterCount'], inline['authoredCommandCharacterCount'])

    def test_documented_recipes_are_the_same_fixed_commands_that_are_executed(self):
        sys.path.insert(0, str(ANALYZER.parent))
        from synthetic_recipe_validation import compare_fixed_recipe_results_and_preparation_costs as comparisons_module
        documentation = (REPOSITORY / 'docs/agent-command-json-and-task-snapshot-recipes.md').read_text(encoding='utf-8')
        for recipe in [comparisons_module.JSON_FIELD_JQ_RECIPE, comparisons_module.JSON_FIELD_SHORT_PYTHON_RECIPE,
                       comparisons_module.BOUND_TASK_SNAPSHOT_SHELL_RECIPE]:
            self.assertIn('```sh\n' + recipe + '\n```', documentation)

    def test_missing_jq_only_pauses_dependent_recipes(self):
        sys.path.insert(0, str(ANALYZER.parent))
        from synthetic_recipe_validation import compare_fixed_recipe_results_and_preparation_costs as comparisons_module
        descriptor, tools = comparisons_module.controlled_comparison_environment()
        descriptor['toolAvailability']['jq'] = False
        descriptor['toolImplementationDigests'].pop('jq', None)
        tools['jq'] = None
        self.output.mkdir()
        with patch.object(comparisons_module, 'controlled_comparison_environment', return_value=(descriptor, tools)):
            comparisons = comparisons_module.compare_fixed_goal_recipes(self.output)
        self.assertIn('jq', comparisons['unavailableToolKinds'])
        recipes = {recipe['id']: recipe for contract in comparisons['goalContracts'] for recipe in contract['recipes']}
        for name in ['shell-validated-atomic-save', 'shell-direct-redirection', 'jq-required-json-field',
                     'shell-bound-current-task-atomic-save', 'shell-persisted-current-task-atomic-save']:
            self.assertEqual(recipes[name]['scenarios'], [])
            self.assertIsNone(recipes[name]['equivalentUnderContract'])
        self.assertEqual(len(recipes['python-checked-save']['scenarios']), 4)
        self.assertTrue(recipes['python-checked-save']['equivalentUnderContract'])
        self.assertTrue(recipes['python-short-required-json-field']['equivalentUnderContract'])
        for name in ['python-exact-character-slice', 'python-short-exact-character-slice']:
            self.assertEqual(len(recipes[name]['scenarios']), 2)
            self.assertTrue(recipes[name]['equivalentUnderContract'])
        if descriptor['toolAvailability']['tail']:
            self.assertEqual(len(recipes['tail-byte-slice']['scenarios']), 2)
            self.assertFalse(recipes['tail-byte-slice']['equivalentUnderContract'])
        self.assertEqual(list(self.output.iterdir()), [])

    def test_snapshot_error_propagation_and_old_artifact_preservation(self):
        self.run_analysis()
        comparisons = json.loads((self.observation / 'goal-recipe-comparison-results.json').read_text())
        snapshot = next(item for item in comparisons['goalContracts'] if item['id'] == 'query-and-preserve-complete-snapshot')
        recipes = {recipe['id']: recipe for recipe in snapshot['recipes']}
        self.assertTrue(recipes['python-checked-save']['equivalentUnderContract'])
        if recipes['shell-validated-atomic-save']['status'] == 'completed':
            self.assertTrue(recipes['shell-validated-atomic-save']['equivalentUnderContract'])
        else:
            self.assertEqual(recipes['shell-validated-atomic-save']['status'], 'tools_unavailable')
        rejected = recipes['shell-direct-redirection']
        self.assertFalse(rejected['equivalentUnderContract'])
        if rejected['status'] == 'completed':
            failed_query = next(case for case in rejected['scenarios'] if case['id'] == 'query_failure')
            self.assertFalse(failed_query['oldSnapshotPreserved'])
        else:
            self.assertEqual(rejected['status'], 'tools_unavailable')
        for recipe in recipes.values():
            cost = recipe['costs']
            self.assertIsNotNone(cost['agentAuthoredInputFileCharacterCount'])
            self.assertIsNotNone(cost['completeAuthoredCharacterCount'])
            self.assertEqual(cost['completeAuthoredCharacterCount'], cost['authoredCommandCharacterCount'] + cost['agentAuthoredInputFileCharacterCount'])
            self.assertEqual(cost['goalCompletionShellInvocationCount'], 1)
            self.assertIsNone(cost['observedModelToolInvocationCount'])

    def test_unicode_units_and_exact_binding_reject_shorter_recipes(self):
        self.run_analysis()
        comparisons = json.loads((self.observation / 'goal-recipe-comparison-results.json').read_text())
        self.assertEqual(len(comparisons['goalContracts']), 4)
        evidence = next(item for item in comparisons['goalContracts'] if item['id'] == 'read-bound-unicode-log-fragment')
        recipes = {recipe['id']: recipe for recipe in evidence['recipes']}
        self.assertTrue(recipes['python-exact-character-slice']['equivalentUnderContract'])
        self.assertTrue(recipes['python-short-exact-character-slice']['equivalentUnderContract'])
        self.assertFalse(recipes['tail-byte-slice']['equivalentUnderContract'])
        self.assertFalse(recipes['latest-evidence-substitution']['equivalentUnderContract'])
        self.assertLess(recipes['tail-byte-slice']['costs']['authoredCommandCharacterCount'],
                        recipes['python-exact-character-slice']['costs']['authoredCommandCharacterCount'])
        self.assertEqual(comparisons['measurementScope'], 'controlled_synthetic_fixtures')


class ExecutionResultReviewTests(AnalysisFixture):
    def setUp(self):
        super().setUp()
        self.review_path = self.root / 'private-execution-result-reviews.json'
        self.review_document = {'schemaVersion': 'agent-command-execution-result-reviews/v1',
                                'observationContext': 'development_validation',
                                'materialTextsBySha256': {}, 'reviews': []}
        self.records = []

    def add_material(self, value):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        self.review_document['materialTextsBySha256'][digest] = text
        return digest

    def add_review(self, identity, observation='a', version='b', result_status='completed', equivalence_result=False):
        command = 'npm run analyze:agent-command-and-inline-script-usage -- --fixture ' + identity
        self.records.append(execution(identity, command=command))
        comparison = {'schemaVersion': 'controlled-goal-recipe-comparisons/v1', 'status': result_status,
                      'goalContracts': [{'recipes': [{'status': result_status,
                                                      'equivalentUnderContract': equivalence_result}]}]}
        comparison_digest = self.add_material(comparison)
        manifest_digest = self.add_material({'observationId': observation * 64, 'status': 'completed',
                                             'analyzerSha256': version * 64,
                                             'artifactSha256': {'goal-recipe-comparison-results.json': comparison_digest}})
        receipt_digest = self.add_material({'observationId': observation * 64, 'status': 'completed',
                                            'observationDirectory': '/PRIVATE_REVIEW_SOURCE_PATH_SENTINEL/' + identity})
        self.review_document['reviews'].append({
            'executionId': identity, 'commandSha256': hashlib.sha256(command.encode('utf-8')).hexdigest(),
            'analysisReceiptMaterialSha256': receipt_digest, 'analysisManifestMaterialSha256': manifest_digest,
            'comparisonResultsMaterialSha256': comparison_digest,
        })

    def save_reviews(self):
        self.replace_source(self.records)
        write_json(self.review_path, self.review_document)
        self.manifest['executionResultReviews'] = {'path': self.review_path.name, 'sha256': self.digest(self.review_path)}

    def test_native_calls_result_observations_versions_and_business_outcomes_are_separate(self):
        self.add_review('PRIVATE_REVIEW_EXECUTION_SENTINEL-1', result_status='execution_failed')
        self.add_review('PRIVATE_REVIEW_EXECUTION_SENTINEL-2', observation='c', version='d')
        self.add_review('PRIVATE_REVIEW_EXECUTION_SENTINEL-3', observation='c', version='d')
        self.review_document['reviews'].append(dict(self.review_document['reviews'][0]))
        self.save_reviews()
        receipt, summary = self.run_analysis()
        feedback = summary['executionResultFeedback']
        self.assertEqual(feedback['verifiedExecutionBindingCount'], 3)
        self.assertEqual(feedback['distinctResultObservationCount'], 2)
        self.assertEqual(feedback['distinctAnalyzerVersionCount'], 2)
        self.assertEqual(feedback['duplicateReviewCopyCount'], 1)
        self.assertEqual(feedback['cliZeroExitWithIncompleteComparisonCount'], 1)
        self.assertEqual(receipt['agentSummary']['attention']['cliZeroExitWithIncompleteComparisonCount'], 1)
        self.assertEqual(feedback['comparisonOutcomeCounts']['comparison_execution_complete'], 2)
        self.assertEqual(feedback['comparisonOutcomeCounts']['comparison_execution_failed'], 1)
        self.assertEqual(len(feedback['analyzerVersionCohorts']), 2)
        frozen_manifest = json.loads((self.observation / 'private-frozen-analysis-input-manifest.json').read_text())
        self.assertEqual(Path(frozen_manifest['executionResultReviews']['path']), self.review_path.resolve())
        self.assertIsNone(summary['costs']['firstAttemptSuccessRate'])
        self.assertTrue(all(row['operationGoalObservationId'] is None for row in self.private_records()))
        public = (self.observation / 'aggregate-usage-summary.json').read_text() + (self.observation / 'agent-command-usage-analysis.html').read_text()
        self.assertNotIn('PRIVATE_REVIEW_', public)
        self.assertIn('原生调用与结果反馈', public)

    def test_changed_command_and_missing_native_execution_do_not_prove_association(self):
        self.add_review('actual')
        self.add_review('not-in-source', observation='c')
        self.review_document['reviews'][0]['commandSha256'] = 'f' * 64
        self.records.pop()
        self.save_reviews()
        _, summary = self.run_analysis(expected_status=3)
        self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
        self.assertEqual(summary['executionResultFeedback']['verifiedExecutionBindingCount'], 0)
        self.assertEqual(summary['executionResultFeedback']['unavailableReviewCount'], 2)

    def test_missing_tools_and_nonzero_process_exit_keep_distinct_facts(self):
        self.add_review('waiting-for-tools', result_status='tools_unavailable')
        self.add_review('nonzero-cli', observation='c')
        self.records[-1]['exitCode'] = 7
        self.add_review('unknown-comparison-result', observation='e', equivalence_result=None)
        self.save_reviews()
        _, summary = self.run_analysis()
        feedback = summary['executionResultFeedback']
        self.assertEqual(feedback['verifiedExecutionBindingCount'], 3)
        self.assertEqual(feedback['comparisonOutcomeCounts'], {
            'comparison_execution_complete': 1, 'comparison_evidence_pending': 2})
        self.assertEqual(feedback['cliZeroExitWithIncompleteComparisonCount'], 2)
        bindings = json.loads((self.observation / 'private-reviewed-execution-result-bindings.json').read_text())
        nonzero = next(binding for binding in bindings if binding['executionId'] == 'nonzero-cli')
        self.assertEqual(nonzero['nativeExitCode'], 7)

    def test_conflicting_execution_reviews_and_result_identities_remain_unresolved(self):
        self.add_review('same-execution')
        self.add_review('same-execution', observation='c')
        self.save_reviews()
        _, summary = self.run_analysis(expected_status=3)
        self.assertEqual(summary['executionResultFeedback']['verifiedExecutionBindingCount'], 0)
        self.review_document['reviews'] = []
        self.records = []
        self.add_review('first')
        self.add_review('second', version='d')
        self.save_reviews()
        _, summary = self.run_analysis(expected_status=3)
        self.assertEqual(summary['executionResultFeedback']['verifiedExecutionBindingCount'], 0)

    def test_material_digest_and_manifest_result_binding_are_required(self):
        self.add_review('actual')
        self.review_document['reviews'][0]['comparisonResultsMaterialSha256'] = self.add_material({
            'schemaVersion': 'controlled-goal-recipe-comparisons/v1', 'status': 'completed', 'goalContracts': []})
        self.save_reviews()
        _, summary = self.run_analysis(expected_status=3)
        self.assertEqual(summary['executionResultFeedback']['verifiedExecutionBindingCount'], 0)
        self.review_document['materialTextsBySha256']['f' * 64] = '$(touch review-input-was-executed)'
        self.save_reviews()
        self.run_analysis(expected_status=3)
        self.assertFalse((self.root / 'review-input-was-executed').exists())

    def test_frozen_review_recovers_missing_source_but_not_corrupt_cached_material(self):
        self.add_review('actual')
        self.save_reviews()
        self.run_analysis()
        self.review_path.unlink()
        _, summary = self.run_analysis()
        self.assertEqual(summary['executionResultFeedback']['verifiedExecutionBindingCount'], 1)
        frozen = json.loads((self.observation / 'private-frozen-execution-result-reviews.json').read_text())
        self.assertEqual(frozen['primarySourceFailure'], 'declared_review_source_missing')
        recovered_observation = self.observation
        for _ in range(3):
            receipt, _ = self.run_analysis()
            self.assertTrue(receipt['reusedCompletedObservation'])
            self.assertEqual(self.observation, recovered_observation)
        for path in self.output.glob('observation-*/private-frozen-execution-result-reviews.json'):
            path.write_text('{corrupt')
        _, summary = self.run_analysis(expected_status=3)
        self.assertEqual(summary['executionResultFeedback']['verifiedExecutionBindingCount'], 0)
        self.assertIsNone(summary['executionResultFeedback']['submittedReviewCount'])

    def test_review_reference_contract_and_document_bounds_are_enforced(self):
        self.manifest['executionResultReviews'] = {'path': 'missing', 'sha256': 'bad'}
        self.run_analysis(expected_status=2)
        self.add_review('actual')
        self.review_document['reviews'] *= 61
        self.save_reviews()
        self.run_analysis(expected_status=3)
        self.review_document['reviews'] = [dict(self.review_document['reviews'][0])]
        self.review_document['reviews'][0]['executionId'] = '\ud800'
        self.review_path.write_text(json.dumps(self.review_document, ensure_ascii=True), encoding='utf-8')
        self.manifest['executionResultReviews']['sha256'] = self.digest(self.review_path)
        self.run_analysis(expected_status=3)


class AgentInteractionSummaryAndBatchTests(AnalysisFixture):
    def test_output_observation_distinguishes_empty_unknown_and_excludes_conflicting_identity(self):
        private_output = 'PRIVATE_TOOL_OUTPUT_SENTINEL' * 2000
        self.replace_source([execution('long', output=private_output), execution('empty', output=''),
                             execution('unknown'), execution('conflict', output='不得混算'),
                             execution('conflict', command='different-command', output='也不得混算')])
        receipt, summary = self.run_analysis()
        burden = summary['agentInteractionBurden']
        self.assertEqual(burden['agentIntervention']['knownToolExecutionCount'], 3)
        self.assertIsNone(burden['agentIntervention']['agentTurnCount'])
        self.assertEqual(burden['agentInput']['observedToolOutputCharacterCount'], len(private_output))
        self.assertEqual(burden['agentInput']['executionsWithObservedOutputCount'], 2)
        self.assertEqual(burden['agentInput']['executionsWithoutObservedOutputCount'], 1)
        self.assertIsNone(burden['actualCost'])
        self.assertIsNone(burden['contextEffectivenessChange'])
        self.assertIsNone(burden['capabilityChange'])
        self.assertEqual(receipt['agentSummary']['observedToolOutputCharacterCount'], len(private_output))
        self.assertLess(len(json.dumps(receipt)), len(private_output) // 10)
        self.assertNotIn('PRIVATE_TOOL_OUTPUT_SENTINEL', json.dumps(receipt))
        self.assertNotIn('PRIVATE_TOOL_OUTPUT_SENTINEL', (self.observation / 'agent-command-usage-analysis.html').read_text())
        self.assertIn('低效轮次、无效写与无效读', (self.observation / 'agent-command-usage-analysis.html').read_text())

    def test_partial_summary_surfaces_missing_source_and_preserves_detail_entry(self):
        self.source.unlink()
        receipt, summary = self.run_analysis(3)
        self.assertEqual(receipt['agentSummary']['attention']['unavailableRequiredSourceCount'], 1)
        self.assertEqual(receipt['agentSummary']['attention']['comparisonStatus'], summary['controlledGoalComparisons']['status'])
        self.assertIn('private-analysis-run-manifest.json', receipt['detailFiles'])
        self.assertEqual(json.loads((self.observation / 'agent-readable-analysis-summary.json').read_text()), receipt['agentSummary'])

    def test_summary_surfaces_unavailable_required_baseline(self):
        self.manifest['baselineReference'] = {'algorithmVersion': 'phase-one-prototype/v1',
                                              'cliSummary': {'path': 'absent-baseline.json', 'sha256': 'a' * 64}}
        receipt, summary = self.run_analysis(3)
        self.assertEqual(receipt['status'], 'partial')
        self.assertEqual(summary['coverage']['unavailableRequiredBaselineCount'], 1)
        self.assertEqual(receipt['agentSummary']['attention']['unavailableRequiredBaselineCount'], 1)
        self.assertEqual(receipt['agentSummary']['knownExecutionCount'], 1)

    def test_summary_distinguishes_missing_execution_identity_from_no_executions(self):
        self.replace_source([execution(None, output='PRIVATE_UNATTRIBUTABLE_OUTPUT')])
        self.manifest['sourceInputs'][0]['coverage'] = 'completed-shell-executions'
        receipt, summary = self.run_analysis()
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(receipt['agentSummary']['knownExecutionCount'], 0)
        self.assertEqual(summary['counts']['missingIdentityRecordCount'], 1)
        self.assertEqual(receipt['agentSummary']['attention']['missingIdentityRecordCount'], 1)
        self.assertIsNone(summary['coverage']['allShellExecutionCount'])
        self.assertNotIn('PRIVATE_UNATTRIBUTABLE_OUTPUT', json.dumps(receipt))

    def run_batch(self, paths, expected_status):
        command = [sys.executable, '-B', str(ANALYZER), '--analysis-artifacts-directory', str(self.output)]
        for path in paths:
            command.extend(['--input-manifest', str(path)])
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, expected_status, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_batch_continues_after_bad_input_and_counts_reused_observation_once(self):
        write_json(self.manifest_path, self.manifest)
        broken = self.root / 'broken-analysis-manifest.json'
        broken.write_text('\n{PRIVATE_INVALID_JSON', encoding='utf-8')
        result = self.run_batch([broken, self.manifest_path, self.manifest_path], 3)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['distinctAnalysisObservationCount'], 1)
        self.assertEqual(len(result['analyses']), 3)
        failure, first, reused = result['analyses']
        self.assertEqual(failure['reasonCode'], 'invalid_json')
        self.assertEqual(failure['jsonLine'], 2)
        self.assertEqual(first['status'], 'completed')
        self.assertTrue(reused['reusedCompletedObservation'])
        self.assertEqual(first['observationId'], reused['observationId'])
        self.assertNotIn('PRIVATE_INVALID_JSON', json.dumps(result))

    def test_batch_all_invalid_has_nonzero_status_and_specific_reason_without_raw_input(self):
        invalid = write_json(self.root / 'invalid-analysis-manifest.json', {})
        missing = self.root / 'missing-analysis-manifest.json'
        result = self.run_batch([invalid, missing], 2)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['distinctAnalysisObservationCount'], 0)
        self.assertEqual([item['reasonCode'] for item in result['analyses']], ['invalid_object_fields', 'manifest_unreadable'])

    def test_unresolvable_manifest_preserves_prior_and_following_batch_receipts(self):
        write_json(self.manifest_path, self.manifest)
        unresolvable_manifest = self.root / 'self-referential-analysis-manifest.json'
        unresolvable_manifest.symlink_to(unresolvable_manifest.name)
        result = self.run_batch([self.manifest_path, unresolvable_manifest, self.manifest_path], 3)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['distinctAnalysisObservationCount'], 1)
        first, failure, replay = result['analyses']
        self.assertEqual(first['status'], 'completed')
        self.assertEqual(failure['status'], 'failed')
        self.assertEqual(failure['reasonCode'], 'manifest_path_unresolvable')
        self.assertEqual(failure['inputManifestPath'], str(unresolvable_manifest))
        self.assertEqual(first['observationId'], replay['observationId'])
        self.assertTrue(replay['reusedCompletedObservation'])
        all_failed = self.run_batch([unresolvable_manifest, unresolvable_manifest], 2)
        self.assertEqual(all_failed['status'], 'failed')
        self.assertEqual(all_failed['distinctAnalysisObservationCount'], 0)
        single = subprocess.run([sys.executable, '-B', str(ANALYZER), '--input-manifest', str(unresolvable_manifest),
                                 '--analysis-artifacts-directory', str(self.output)],
                                capture_output=True, text=True, encoding='utf-8', timeout=20)
        self.assertEqual(single.returncode, 2)
        self.assertEqual(single.stdout, '')
        self.assertEqual(json.loads(single.stderr)['reasonCode'], 'manifest_path_unresolvable')

    def test_batch_preserves_partial_and_complete_observations_independently(self):
        partial = {**self.manifest, 'sourceInputs': [{**self.manifest['sourceInputs'][0], 'path': 'absent.json'}]}
        partial_path = write_json(self.root / 'partial-analysis-manifest.json', partial)
        write_json(self.manifest_path, self.manifest)
        result = self.run_batch([partial_path, self.manifest_path], 3)
        self.assertEqual([item['status'] for item in result['analyses']], ['partial', 'completed'])
        self.assertEqual(result['distinctAnalysisObservationCount'], 2)
        self.assertEqual(result['analyses'][0]['agentSummary']['attention']['unavailableRequiredSourceCount'], 1)

    def test_tampered_agent_summary_is_rebuilt_before_returning_cached_receipt(self):
        receipt, _ = self.run_analysis()
        summary_path = self.observation / 'agent-readable-analysis-summary.json'
        summary_path.write_text('{"fabricatedSuccess":true}', encoding='utf-8')
        replay, _ = self.run_analysis()
        self.assertFalse(replay['reusedCompletedObservation'])
        self.assertEqual(receipt['agentSummary'], replay['agentSummary'])
        self.assertNotIn('fabricatedSuccess', summary_path.read_text())

    def test_legacy_frozen_material_without_agent_summary_still_recovers_source(self):
        self.run_analysis()
        legacy_manifest_path = self.observation / 'private-analysis-run-manifest.json'
        legacy_manifest = json.loads(legacy_manifest_path.read_text())
        legacy_manifest['artifactSha256'].pop('agent-readable-analysis-summary.json')
        write_json(legacy_manifest_path, legacy_manifest)
        (self.observation / 'agent-readable-analysis-summary.json').unlink()
        self.source.unlink()
        receipt, summary = self.run_analysis()
        self.assertEqual(summary['coverage']['recoveredSourceCount'], 1)
        self.assertEqual(receipt['agentSummary']['knownExecutionCount'], 1)


class DiscoveryAndBoundaryTests(AnalysisFixture):
    def test_nested_module_changes_invalidate_cached_observation(self):
        copied_source_directory = self.root / 'isolated-analyzer-source-copy'
        shutil.copytree(ANALYZER.parent, copied_source_directory, ignore=shutil.ignore_patterns('__pycache__'))
        copied_entry = copied_source_directory / ANALYZER.name
        nested_module = copied_source_directory / 'execution_record_parsing/extract_cli_routes_and_inline_script_bodies.py'
        with patch(f'{__name__}.ANALYZER', copied_entry):
            first, _ = self.run_analysis()
            nested_module.write_bytes(nested_module.read_bytes() + '\n# 验证子目录源码更新不会复用旧观察。\n'.encode('utf-8'))
            changed, summary = self.run_analysis()
            self.assertNotEqual(first['observationId'], changed['observationId'])
            self.assertFalse(changed['reusedCompletedObservation'])
            self.assertEqual(summary['counts']['knownDistinctCompletedExecutions'], 1)
            repeated, _ = self.run_analysis()
            self.assertEqual(changed['observationId'], repeated['observationId'])
            self.assertTrue(repeated['reusedCompletedObservation'])

    def test_npm_entry_and_python_ci_prerequisite_are_connected(self):
        package = json.loads((REPOSITORY / 'package.json').read_text())
        self.assertEqual(package['scripts']['analyze:agent-command-and-inline-script-usage'],
                         'python3 -B scripts/agent-command-and-inline-script-usage-analysis/analyze_declared_execution_records_and_generate_usage_report.py')
        workflow = (REPOSITORY / '.github/workflows/test.yml').read_text()
        python_step = workflow.split('uses: actions/setup-python@v5')[0].rsplit('- name:', 1)[1]
        self.assertNotIn('if: matrix.os', python_step)

    def test_optional_source_loss_keeps_overall_denominator_unknown(self):
        self.manifest['sourceInputs'][0]['coverage'] = 'completed-shell-executions'
        self.manifest['sourceInputs'].append({'path': 'not-available.jsonl', 'format': 'codex-command-execution-jsonl',
                                             'coverage': 'completed-shell-executions', 'required': False})
        _, summary = self.run_analysis()
        self.assertIsNone(summary['coverage']['allShellExecutionCount'])
        self.assertEqual(summary['coverage']['unavailableOptionalSourceCount'], 1)

    def test_directory_inputs_freeze_file_material_and_refuse_escaping_symlink(self):
        directory = self.root / 'declared-native-records'
        directory.mkdir()
        (directory / 'empty-session.jsonl').write_text('{"type":"session_meta"}\n')
        self.manifest['sourceInputs'] = [{'path': directory.name, 'format': 'codex-command-execution-jsonl',
                                         'coverage': 'completed-shell-executions'}]
        self.run_analysis()
        frozen = json.loads((self.observation / 'private-frozen-source-000.json').read_text())
        self.assertEqual(len(frozen['files']), 1)
        (directory / 'escaping.jsonl').symlink_to(self.source)
        self.run_analysis(3)

    def test_input_type_errors_are_rejected_and_output_does_not_collide_with_sources(self):
        self.manifest['sourceInputs'][0]['format'] = []
        self.run_analysis(2)
        self.manifest['sourceInputs'][0]['format'] = 'phase-one-normalized-executions-json'
        self.output = self.source
        before = self.source.read_bytes()
        self.run_analysis(2)
        self.assertEqual(self.source.read_bytes(), before)

    def test_drift_can_use_exact_frozen_material_without_erasing_primary_failure(self):
        self.run_analysis()
        write_json(self.source, [execution('different-material')])
        _, summary = self.run_analysis()
        self.assertEqual(summary['coverage']['recoveredSourceCount'], 1)
        frozen = json.loads((self.observation / 'private-frozen-source-000.json').read_text())
        self.assertEqual(frozen['primarySourceFailure'], 'material_digest_mismatch')
        self.assertEqual(self.private_records()[0]['executionId'], 'execution-fixture')

    def test_existing_unowned_observation_directory_is_preserved(self):
        self.run_analysis()
        for path in self.observation.iterdir():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        unrelated = self.observation / 'unrelated-user-file'
        unrelated.write_text('必须保留')
        self.run_analysis(2)
        self.assertEqual(unrelated.read_text(), '必须保留')

    def test_invalid_historical_count_stays_private_and_partial(self):
        baseline = write_json(self.root / 'invalid-baseline.json', {
            'totalObservedShellExecutions': 33013, 'inlineScriptExecutions': {'count': 'PRIVATE_INVALID_COUNT'},
            'window': ['2026-10-28T12:30:00Z', '2026-11-04T12:30:00Z']})
        self.manifest['baselineReference'] = {'algorithmVersion': 'phase-one-prototype/v1',
                                              'inlineScriptSummary': {'path': baseline.name, 'sha256': self.digest(baseline)}}
        _, summary = self.run_analysis(3)
        self.assertIsNone(summary['historicalBaseline']['inlineScriptExecutions'])
        self.assertNotIn('PRIVATE_INVALID_COUNT', json.dumps(summary))

    def test_generated_frozen_manifest_recovers_unpinned_original_after_relocation(self):
        del self.manifest['sourceInputs'][0]['sha256']
        self.run_analysis()
        self.manifest = json.loads((self.observation / 'private-frozen-analysis-input-manifest.json').read_text())
        self.assertEqual(self.manifest['sourceInputs'][0]['sha256'], self.digest(self.source))
        self.source.unlink()
        _, summary = self.run_analysis()
        self.assertEqual(summary['coverage']['recoveredSourceCount'], 1)


if __name__ == '__main__':
    unittest.main()
