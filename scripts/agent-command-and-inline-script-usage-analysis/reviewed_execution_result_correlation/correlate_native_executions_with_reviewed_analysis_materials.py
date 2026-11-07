"""校验原生执行与已审阅分析回执、清单和对照材料的关联；审阅声明不证明目标或授权。"""
from collections import Counter, defaultdict
import hashlib
import json
import re


REVIEW_FIELDS = {'executionId', 'commandSha256', 'analysisReceiptMaterialSha256',
                 'analysisManifestMaterialSha256', 'comparisonResultsMaterialSha256'}
COMPARISON_STATUSES = {'completed', 'execution_failed', 'tools_unavailable'}
RECIPE_STATUSES = {*COMPARISON_STATUSES, 'pending'}


def is_material_digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def parse_execution_result_review_document(text):
    document = json.loads(text)
    if not isinstance(document, dict) or set(document) != {'schemaVersion', 'observationContext', 'materialTextsBySha256', 'reviews'}:
        raise ValueError('invalid_review_document')
    if document['schemaVersion'] != 'agent-command-execution-result-reviews/v1' or document['observationContext'] != 'development_validation':
        raise ValueError('unsupported_review_context')
    materials = document['materialTextsBySha256']
    if not isinstance(materials, dict) or not 1 <= len(materials) <= 180:
        raise ValueError('invalid_review_materials')
    for digest, content in materials.items():
        if not is_material_digest(digest) or not isinstance(content, str) or hashlib.sha256(content.encode('utf-8')).hexdigest() != digest:
            raise ValueError('invalid_review_material_digest')
    if not isinstance(document['reviews'], list) or not 1 <= len(document['reviews']) <= 60:
        raise ValueError('invalid_review_bound')
    for review in document['reviews']:
        if not isinstance(review, dict) or set(review) != REVIEW_FIELDS or not isinstance(review['executionId'], str) or not review['executionId']:
            raise ValueError('invalid_execution_review')
        review['executionId'].encode('utf-8')
        if not all(is_material_digest(review[key]) for key in REVIEW_FIELDS - {'executionId'}):
            raise ValueError('invalid_execution_review_digest')
    return document


def verify_analysis_result_materials(review, materials):
    receipt, manifest, comparison = [json.loads(materials[review[key]]) for key in [
        'analysisReceiptMaterialSha256', 'analysisManifestMaterialSha256', 'comparisonResultsMaterialSha256']]
    if not all(isinstance(value, dict) for value in [receipt, manifest, comparison]):
        raise ValueError('invalid_result_material')
    if not is_material_digest(receipt['observationId']) or receipt['observationId'] != manifest['observationId']:
        raise ValueError('result_observation_identity_mismatch')
    if receipt['status'] not in ['completed', 'partial'] or receipt['status'] != manifest['status']:
        raise ValueError('analysis_result_status_mismatch')
    if not is_material_digest(manifest['analyzerSha256']):
        raise ValueError('invalid_analyzer_version_digest')
    if manifest['artifactSha256']['goal-recipe-comparison-results.json'] != review['comparisonResultsMaterialSha256']:
        raise ValueError('result_material_binding_mismatch')
    if comparison['schemaVersion'] != 'controlled-goal-recipe-comparisons/v1' or comparison['status'] not in COMPARISON_STATUSES:
        raise ValueError('unsupported_comparison_result')
    if not isinstance(comparison['goalContracts'], list) or not comparison['goalContracts']:
        raise ValueError('missing_comparison_contracts')
    recipes = []
    for contract in comparison['goalContracts']:
        if not isinstance(contract, dict) or not isinstance(contract.get('recipes'), list) or not contract['recipes']:
            raise ValueError('missing_comparison_recipes')
        recipes.extend(contract['recipes'])
    if any(not isinstance(recipe, dict) or recipe.get('status') not in RECIPE_STATUSES
           or (recipe.get('equivalentUnderContract') is not None and type(recipe['equivalentUnderContract']) is not bool)
           for recipe in recipes):
        raise ValueError('invalid_comparison_recipe_status')
    if comparison['status'] == 'execution_failed' or any(recipe['status'] == 'execution_failed' for recipe in recipes):
        outcome = 'comparison_execution_failed'
    elif comparison['status'] == 'completed' and all(recipe['status'] == 'completed' and type(recipe.get('equivalentUnderContract')) is bool for recipe in recipes):
        outcome = 'comparison_execution_complete'
    else:
        outcome = 'comparison_evidence_pending'
    return {'resultObservationId': receipt['observationId'], 'analyzerSha256': manifest['analyzerSha256'],
            'comparisonResultsSha256': review['comparisonResultsMaterialSha256'], 'comparisonOutcome': outcome}


def summarize_reviewed_execution_results(records, source):
    summary = {'status': 'not_supplied' if source is None else 'partial',
               'observationContext': 'development_validation' if source is not None else None,
               'submittedReviewCount': 0 if source is None else None, 'duplicateReviewCopyCount': 0,
               'verifiedExecutionBindingCount': 0, 'unavailableReviewCount': None if source is not None else 0,
               'distinctResultObservationCount': 0, 'distinctAnalyzerVersionCount': 0,
               'cliZeroExitWithIncompleteComparisonCount': 0, 'comparisonOutcomeCounts': {}, 'analyzerVersionCohorts': [],
               'productionBenefitsProven': False,
               'associationSemantics': '显式审阅的执行与结果材料关联；不证明原生业务目标、首次成功率或用户授权。'}
    if source is None or source['unavailableReason']:
        return [], summary
    try:
        document = parse_execution_result_review_document(source['contentText'])
    except (ValueError, TypeError, RecursionError, UnicodeError):
        source['unavailableReason'] = 'invalid_review_document'
        return [], summary
    summary['submittedReviewCount'] = len(document['reviews'])
    grouped = defaultdict(list)
    executions = defaultdict(list)
    for record in records:
        executions[record['executionId']].append(record)
    for review in document['reviews']:
        grouped[review['executionId']].append(review)
    results = []
    for identity, copies in sorted(grouped.items()):
        variants = {json.dumps(review, sort_keys=True): review for review in copies}
        summary['duplicateReviewCopyCount'] += len(copies) - len(variants)
        for _, review in sorted(variants.items()):
            result = {**review, 'status': 'unavailable', 'unavailableReason': None}
            candidates = executions[identity]
            if len(variants) > 1:
                result['unavailableReason'] = 'execution_review_identity_conflict'
            elif len(candidates) != 1 or candidates[0]['identityConflicted']:
                result['unavailableReason'] = 'native_execution_missing_or_conflicted'
            elif hashlib.sha256(candidates[0]['command'].encode('utf-8')).hexdigest() != review['commandSha256']:
                result['unavailableReason'] = 'native_command_digest_mismatch'
            else:
                try:
                    result.update(verify_analysis_result_materials(review, document['materialTextsBySha256']))
                    result.update({'status': 'verified', 'nativeExitCode': candidates[0]['exitCode']})
                except (ValueError, TypeError, KeyError, RecursionError):
                    result['unavailableReason'] = 'result_material_unavailable_or_inconsistent'
            results.append(result)
    observation_variants = defaultdict(set)
    for result in results:
        if result['status'] == 'verified':
            observation_variants[result['resultObservationId']].add((result['analyzerSha256'], result['comparisonResultsSha256']))
    for result in results:
        if result['status'] == 'verified' and len(observation_variants[result['resultObservationId']]) > 1:
            result.update({'status': 'unavailable', 'unavailableReason': 'result_observation_identity_conflict'})
    verified = [result for result in results if result['status'] == 'verified']
    summary.update({'status': 'verified' if len(verified) == len(results) else 'partial',
                    'verifiedExecutionBindingCount': len(verified), 'unavailableReviewCount': len(results) - len(verified),
                    'distinctResultObservationCount': len({result['resultObservationId'] for result in verified}),
                    'distinctAnalyzerVersionCount': len({result['analyzerSha256'] for result in verified}),
                    'cliZeroExitWithIncompleteComparisonCount': sum(result['nativeExitCode'] == 0 and result['comparisonOutcome'] != 'comparison_execution_complete' for result in verified),
                    'comparisonOutcomeCounts': dict(sorted(Counter(result['comparisonOutcome'] for result in verified).items()))})
    for index, digest in enumerate(sorted({result['analyzerSha256'] for result in verified}), 1):
        cohort = [result for result in verified if result['analyzerSha256'] == digest]
        summary['analyzerVersionCohorts'].append({'versionGroup': index, 'verifiedExecutionCount': len(cohort),
            'distinctObservationCount': len({result['resultObservationId'] for result in cohort}),
            'comparisonOutcomeCounts': dict(sorted(Counter(result['comparisonOutcome'] for result in cohort).items()))})
    return results, summary
