import {
	CONFIRMATION_STRATEGY_NOT_YET_AVAILABLE_IN_THIS_RUNTIME_ERROR_CODE,
	type ProposerRelativeCounterpartClassification,
	type ProposingAgentWaitBehavior,
	RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_POLICY_VERSION,
	RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES,
	type RelationAffectingConfirmableChangeConfirmationStrategy,
	type RelationAffectingConfirmableChangeKind,
	type RelationAffectingConfirmableChangeUserFacingPresentationChannel,
} from "../core/inter-work-unit-relation-assertion-lifecycle-event-contract";

// dd2db 阶段 2：可确认变更的路由——唯一授权源是 §R3 Y-CONF-13 矩阵（M1–M28，M14 已删）与 Y-CONF-8 的撤销权表，
// 加 d-confirm §5.1 的 R-multi-row-match / R-select / R-upgrade / R-weaken / R-S6-always-allowed。纯函数，不读账本。
// 全表一次写好；本 runtime 实际开放的行与策略单独列出（2.1：M1 与撤销权表；只有 S1），其余明确拒绝，绝不悄悄降级。

const S1: RelationAffectingConfirmableChangeConfirmationStrategy = "applied_immediately_without_user_review";
const S2: RelationAffectingConfirmableChangeConfirmationStrategy =
	"applied_immediately_with_time_boxed_user_veto_window";
const S3: RelationAffectingConfirmableChangeConfirmationStrategy =
	"applied_after_independent_automated_verification_passes_else_fallback";
const S4: RelationAffectingConfirmableChangeConfirmationStrategy =
	"pending_user_decision_then_applied_as_proposed_after_deadline";
const S5: RelationAffectingConfirmableChangeConfirmationStrategy =
	"pending_user_decision_then_lapsed_and_returned_to_proposer_after_deadline";
const S6: RelationAffectingConfirmableChangeConfirmationStrategy =
	"pending_until_explicit_user_decision_without_deadline";

const S1_THROUGH_S6 = [S1, S2, S3, S4, S5, S6] as const;
const S2_THROUGH_S6 = [S2, S3, S4, S5, S6] as const;

export interface ConfirmationAuthorityRow {
	confirmationAuthorityRowId: string;
	relationAffectingConfirmableChangeKind: RelationAffectingConfirmableChangeKind;
	confirmationAuthorityRowContentSummary: string;
	allowedConfirmationStrategies: readonly RelationAffectingConfirmableChangeConfirmationStrategy[];
	defaultConfirmationStrategy: RelationAffectingConfirmableChangeConfirmationStrategy;
	// R-weaken：选了比默认更弱的策略时由 runtime 自动记录的风险标签（当前矩阵里只有 M5 有更弱的选项）。
	automaticallyDerivedRiskLabelsWhenWeakerThanDefault: readonly string[];
	introducedInDd2dbPhase: string;
}

function defineConfirmationAuthorityRow(row: ConfirmationAuthorityRow): ConfirmationAuthorityRow {
	return row;
}

const CREATION = "asserted_relation_or_work_unit_gate_creation" as const;
const UNARY = "unary_requirement_obligation_outcome_declaration" as const;

// Y-CONF-13 矩阵最终版。行内容只作审计与报错文案；哪一行命中由各写入动词的分类函数决定。
export const CONFIRMATION_MATRIX_ROWS_BY_ROW_ID: Record<string, ConfirmationAuthorityRow> = Object.fromEntries(
	[
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M1",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary: "reference assertion where the proposer is one of the endpoints",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S1,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M2",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"reference assertion where the proposer is not an endpoint (extractors, suggesters, J2 exporter)",
			allowedConfirmationStrategies: S2_THROUGH_S6,
			defaultConfirmationStrategy: S2,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M3",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"decomposed subtask derived on the spot, parent card is the proposer or its self-derived counterpart",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S1,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M4",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary: "decomposed subtask attaching an existing independent card",
			allowedConfirmationStrategies: [S3, S5, S6],
			defaultConfirmationStrategy: S3,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M5",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"obligation change that only affects obligations inside the proposer's pure delegation subtree",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S2,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: ["bypasses_user_review_before_effect"],
			introducedInDd2dbPhase: "2/4a",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M6",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary: "obligation change that rewrites obligations of an independent card",
			allowedConfirmationStrategies: [S3, S5, S6],
			defaultConfirmationStrategy: S3,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M7",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"user requirement items leave every holder without being satisfied (drop, obsolete, abandon)",
			allowedConfirmationStrategies: [S6],
			defaultConfirmationStrategy: S6,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2/4a",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M8",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary: "full coverage (including cumulative coverage)",
			allowedConfirmationStrategies: [S3, S6],
			defaultConfirmationStrategy: S3,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "4a",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M9",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary: "partial coverage",
			allowedConfirmationStrategies: [S3, S6],
			defaultConfirmationStrategy: S3,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "4a",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M10",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"gate whose waiting work unit is the proposer or its self-derived counterpart; notify / carry / propose_start",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S1,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "3",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M10i",
			relationAffectingConfirmableChangeKind: CREATION,
			// G12 已拍板为 B（2026-09-30），所以允许集是 S1–S6；开放时机仍是 3g。
			confirmationAuthorityRowContentSummary: "self-waiting gate with inject",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S1,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "3g",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M11",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"gate whose waiting work unit is an independent counterpart; notify / carry / propose_start",
			allowedConfirmationStrategies: S2_THROUGH_S6,
			defaultConfirmationStrategy: S2,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "3",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M11i",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"gate whose waiting work unit is an independent counterpart, with inject",
			allowedConfirmationStrategies: [S5, S6],
			defaultConfirmationStrategy: S6,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "3",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M12",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"gate with start whose waiting work unit is outside the proposer subtree",
			allowedConfirmationStrategies: [S6],
			defaultConfirmationStrategy: S6,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "3",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M12a",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"gate with start whose waiting work unit is self-derived from the proposer",
			allowedConfirmationStrategies: [S1, S6],
			defaultConfirmationStrategy: S1,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "3",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M13",
			relationAffectingConfirmableChangeKind: "relation_triggered_side_effect_execution_requiring_confirmation",
			confirmationAuthorityRowContentSummary: "gate-triggered start that needs confirmation (24h from creation)",
			allowedConfirmationStrategies: [S5, S6],
			defaultConfirmationStrategy: S5,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "3",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M15a",
			relationAffectingConfirmableChangeKind: "extraction_run_activation_into_effect_after_sampled_preview",
			confirmationAuthorityRowContentSummary: "first run activation of an extractor implementation version",
			allowedConfirmationStrategies: [S6],
			defaultConfirmationStrategy: S6,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2b",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M15b",
			relationAffectingConfirmableChangeKind: "extracted_historical_fact_record_acceptance_into_effect",
			confirmationAuthorityRowContentSummary: "circumstantial-evidence-only extracted record",
			allowedConfirmationStrategies: [S3, S6],
			defaultConfirmationStrategy: S6,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2b",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M17",
			relationAffectingConfirmableChangeKind: UNARY,
			confirmationAuthorityRowContentSummary:
				"own completion of code delivery whose shared landing criterion has been observed",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S2,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: ["bypasses_user_review_before_effect"],
			introducedInDd2dbPhase: "4a",
		}),
		...["M18", "M19", "M20", "M23"].map((confirmationAuthorityRowId) =>
			defineConfirmationAuthorityRow({
				confirmationAuthorityRowId,
				relationAffectingConfirmableChangeKind: UNARY,
				confirmationAuthorityRowContentSummary:
					"unary obligation outcome or reopening that only the user can decide",
				allowedConfirmationStrategies: [S6],
				defaultConfirmationStrategy: S6,
				automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
				introducedInDd2dbPhase: "4a",
			}),
		),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M21",
			relationAffectingConfirmableChangeKind: "requirement_obligation_reopening",
			confirmationAuthorityRowContentSummary:
				"reopening of self or a self-derived counterpart, not decided by the user",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S1,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "4a",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M22",
			relationAffectingConfirmableChangeKind: "requirement_obligation_reopening",
			confirmationAuthorityRowContentSummary: "reopening of an independent counterpart, not decided by the user",
			allowedConfirmationStrategies: S2_THROUGH_S6,
			defaultConfirmationStrategy: S2,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "4a",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M24",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary: "forbid resource mutation constraining the proposer or its subtree",
			allowedConfirmationStrategies: S1_THROUGH_S6,
			defaultConfirmationStrategy: S1,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M25",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"forbid resource mutation constraining an independent counterpart (warn only)",
			allowedConfirmationStrategies: S2_THROUGH_S6,
			defaultConfirmationStrategy: S2,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2",
		}),
		defineConfirmationAuthorityRow({
			confirmationAuthorityRowId: "M28",
			relationAffectingConfirmableChangeKind: CREATION,
			confirmationAuthorityRowContentSummary:
				"discharge-group relation whose discharged side resolves to the proposer's own work unit",
			allowedConfirmationStrategies: [S3, S5, S6],
			defaultConfirmationStrategy: S3,
			automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
			introducedInDd2dbPhase: "2/4a",
		}),
	].map((row) => [row.confirmationAuthorityRowId, row]),
);

// Y-CONF-8 撤销权表（取代 R-revoke；命中多行取交集）。M15c、M26、M27 按「命中的内容行」路由，不单独成行。
export const RELATION_ASSERTION_REVOCATION_AUTHORITY_ROWS_BY_ROW_ID: Record<string, ConfirmationAuthorityRow> =
	Object.fromEntries(
		[
			defineConfirmationAuthorityRow({
				confirmationAuthorityRowId:
					"M16:revoking_assertion_effective_with_user_explicit_consent_by_non_web_ui_user",
				relationAffectingConfirmableChangeKind: "applied_asserted_relation_or_work_unit_gate_revocation",
				confirmationAuthorityRowContentSummary:
					"the revoked assertion became effective with the user's explicit consent and the revoker is not the Web UI user",
				allowedConfirmationStrategies: [S6],
				defaultConfirmationStrategy: S6,
				automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
				introducedInDd2dbPhase: "2",
			}),
			defineConfirmationAuthorityRow({
				confirmationAuthorityRowId: "M16:revoked_by_original_asserter_only_reducing_automation_or_risk",
				relationAffectingConfirmableChangeKind: "applied_asserted_relation_or_work_unit_gate_revocation",
				confirmationAuthorityRowContentSummary:
					"the revoker is the original asserter and the revocation only reduces automatic actions or risk",
				allowedConfirmationStrategies: S1_THROUGH_S6,
				defaultConfirmationStrategy: S1,
				automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
				introducedInDd2dbPhase: "2",
			}),
			defineConfirmationAuthorityRow({
				confirmationAuthorityRowId: "M16:revoked_by_non_original_asserter_only_reducing_automation_or_risk",
				relationAffectingConfirmableChangeKind: "applied_asserted_relation_or_work_unit_gate_revocation",
				confirmationAuthorityRowContentSummary:
					"the revoker is not the original asserter and the revocation only reduces automatic actions or risk (the original asserter is notified)",
				allowedConfirmationStrategies: S2_THROUGH_S6,
				defaultConfirmationStrategy: S2,
				automaticallyDerivedRiskLabelsWhenWeakerThanDefault: [],
				introducedInDd2dbPhase: "2",
			}),
		].map((row) => [row.confirmationAuthorityRowId, row]),
	);

// 本 runtime 实际开放写入的行与策略。其余行的写入动词还不存在；其余策略选了就明确拒绝（不降级）。
const CONFIRMATION_AUTHORITY_ROW_IDS_OPENED_FOR_WRITES_IN_THIS_RUNTIME = new Set([
	"M1",
	...Object.keys(RELATION_ASSERTION_REVOCATION_AUTHORITY_ROWS_BY_ROW_ID),
]);
const CONFIRMATION_STRATEGIES_AVAILABLE_IN_THIS_RUNTIME =
	new Set<RelationAffectingConfirmableChangeConfirmationStrategy>([S1]);

// d-confirm §2.2 的全序（只用于上调）：S5 与 S6 同档。
function rankConfirmationStrategyForPolicyFloorUpgrade(
	strategy: RelationAffectingConfirmableChangeConfirmationStrategy,
): number {
	return strategy === S6 ? 4 : RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES.indexOf(strategy);
}

function findConfirmationAuthorityRow(rowId: string): ConfirmationAuthorityRow {
	const row =
		CONFIRMATION_MATRIX_ROWS_BY_ROW_ID[rowId] ?? RELATION_ASSERTION_REVOCATION_AUTHORITY_ROWS_BY_ROW_ID[rowId];
	if (!row) {
		throw new Error(`Unknown confirmation authority row ${rowId}.`);
	}
	return row;
}

// 写进 `relation_affecting_confirmable_change_created_and_routed` 事件的判定依据（d-confirm §8）。
export interface RelationAffectingConfirmableChangeConfirmationRoutingDecision {
	confirmationRoutingKind: "routed_through_confirmation_authority_rows";
	confirmationPolicyVersion: number;
	matchedConfirmationAuthorityRowIds: string[];
	appliedConfirmationPolicyModifierRuleIds: string[];
	allowedConfirmationStrategiesOfMatchedRows: RelationAffectingConfirmableChangeConfirmationStrategy[];
	defaultConfirmationStrategyOfMatchedRows: RelationAffectingConfirmableChangeConfirmationStrategy;
	agentSelectedConfirmationStrategy: RelationAffectingConfirmableChangeConfirmationStrategy | null;
	strategySelectionRationale: string | null;
	effectiveConfirmationStrategy: RelationAffectingConfirmableChangeConfirmationStrategy;
	confirmationStrategyUpgradedByPolicyFloor: boolean;
	automaticallyDerivedRiskLabels: string[];
	// S1 没有截止时刻；S2/S4/S5 开放时按（行, 策略）确定性派生（d-confirm §2.4）。
	deadlineClockStartRule: string | null;
	confirmationDecisionDeadlineAt: number | null;
	userFacingPresentationChannels: RelationAffectingConfirmableChangeUserFacingPresentationChannel[];
	proposingAgentWaitBehavior: ProposingAgentWaitBehavior;
	proposerRelativeCounterpartClassification: ProposerRelativeCounterpartClassification;
}

// Web UI 用户带 nonce 的直接断言 / 直接撤销不进确认体系，直接生效（d-confirm §1.3），但同样留下判定记录。
export interface RelationAffectingConfirmableChangeAssertedDirectlyByWebUiUserRoutingDecision {
	confirmationRoutingKind: "asserted_directly_by_user_in_web_ui_outside_confirmation_authority_rows";
	confirmationPolicyVersion: number;
	userFacingPresentationChannels: RelationAffectingConfirmableChangeUserFacingPresentationChannel[];
}

export type RelationAffectingConfirmableChangeRoutingDecisionRecordedInLedger =
	| RelationAffectingConfirmableChangeConfirmationRoutingDecision
	| RelationAffectingConfirmableChangeAssertedDirectlyByWebUiUserRoutingDecision;

export function buildRoutingDecisionForChangeAssertedDirectlyByWebUiUser(): RelationAffectingConfirmableChangeAssertedDirectlyByWebUiUserRoutingDecision {
	return {
		confirmationRoutingKind: "asserted_directly_by_user_in_web_ui_outside_confirmation_authority_rows",
		confirmationPolicyVersion: RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_POLICY_VERSION,
		userFacingPresentationChannels: ["relations_panel_passive_display_only"],
	};
}

export type RelationAffectingConfirmableChangeConfirmationRoutingResult =
	| { routingSucceeded: true; routingDecision: RelationAffectingConfirmableChangeConfirmationRoutingDecision }
	| {
			routingSucceeded: false;
			routingRefusalErrorCode: string;
			routingRefusalMessage: string;
			// 拒绝时也把算到哪一步给出来，CLI 报错与 --dry-run 都用它说清楚「需要哪种策略、为什么不行」。
			partialRoutingDecision: Pick<
				RelationAffectingConfirmableChangeConfirmationRoutingDecision,
				| "matchedConfirmationAuthorityRowIds"
				| "allowedConfirmationStrategiesOfMatchedRows"
				| "defaultConfirmationStrategyOfMatchedRows"
			>;
	  };

export function routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows(input: {
	matchedConfirmationAuthorityRowIds: string[];
	agentSelectedConfirmationStrategy: RelationAffectingConfirmableChangeConfirmationStrategy | null;
	strategySelectionRationale: string | null;
}): RelationAffectingConfirmableChangeConfirmationRoutingResult {
	const rows = input.matchedConfirmationAuthorityRowIds.map(findConfirmationAuthorityRow);
	if (rows.length === 0) {
		throw new Error("A relation-affecting confirmable change must match at least one confirmation authority row.");
	}
	// R-multi-row-match：允许集取交集；默认取各行默认中最严的；交集为空取 S6（R-S6-always-allowed 保证 S6 永远在）。
	const intersectedAllowedStrategies = RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES.filter(
		(strategy) => rows.every((row) => row.allowedConfirmationStrategies.includes(strategy)),
	);
	const allowedStrategies = intersectedAllowedStrategies.length > 0 ? intersectedAllowedStrategies : [S6];
	const strictestRowDefault = rows
		.map((row) => row.defaultConfirmationStrategy)
		.reduce((strictest, candidate) =>
			rankConfirmationStrategyForPolicyFloorUpgrade(candidate) >
			rankConfirmationStrategyForPolicyFloorUpgrade(strictest)
				? candidate
				: strictest,
		);
	const defaultStrategy = allowedStrategies.includes(strictestRowDefault) ? strictestRowDefault : S6;
	const partialRoutingDecision = {
		matchedConfirmationAuthorityRowIds: rows.map((row) => row.confirmationAuthorityRowId),
		allowedConfirmationStrategiesOfMatchedRows: allowedStrategies,
		defaultConfirmationStrategyOfMatchedRows: defaultStrategy,
	};
	const rowNotOpenedYet = rows.find(
		(row) => !CONFIRMATION_AUTHORITY_ROW_IDS_OPENED_FOR_WRITES_IN_THIS_RUNTIME.has(row.confirmationAuthorityRowId),
	);
	if (rowNotOpenedYet) {
		return {
			routingSucceeded: false,
			routingRefusalErrorCode: "confirmation_authority_row_not_yet_opened_for_writes_in_this_runtime",
			routingRefusalMessage: `This change matches confirmation matrix row ${rowNotOpenedYet.confirmationAuthorityRowId} (${rowNotOpenedYet.confirmationAuthorityRowContentSummary}), which opens in dd2db phase ${rowNotOpenedYet.introducedInDd2dbPhase}; this runtime does not accept it yet.`,
			partialRoutingDecision,
		};
	}
	// R-select / R-upgrade：选在允许集内就用它；不在就取允许集中全序不低于所选的最低项（同档优先行默认，否则 S6）。
	let effectiveStrategy = defaultStrategy;
	let upgradedByPolicyFloor = false;
	if (input.agentSelectedConfirmationStrategy) {
		const selected = input.agentSelectedConfirmationStrategy;
		if (allowedStrategies.includes(selected)) {
			effectiveStrategy = selected;
		} else {
			const selectedRank = rankConfirmationStrategyForPolicyFloorUpgrade(selected);
			const candidates = allowedStrategies.filter(
				(strategy) => rankConfirmationStrategyForPolicyFloorUpgrade(strategy) >= selectedRank,
			);
			const lowestCandidateRank = Math.min(...candidates.map(rankConfirmationStrategyForPolicyFloorUpgrade));
			const lowestRankCandidates = candidates.filter(
				(strategy) => rankConfirmationStrategyForPolicyFloorUpgrade(strategy) === lowestCandidateRank,
			);
			effectiveStrategy = lowestRankCandidates.includes(defaultStrategy)
				? defaultStrategy
				: (lowestRankCandidates.find((strategy) => strategy === S6) ?? lowestRankCandidates[0] ?? S6);
			upgradedByPolicyFloor = true;
		}
		// R-select：只有偏离默认时才必须附理由。
		if (effectiveStrategy !== defaultStrategy && !input.strategySelectionRationale?.trim()) {
			return {
				routingSucceeded: false,
				routingRefusalErrorCode: "strategy_selection_rationale_required_when_deviating_from_row_default",
				routingRefusalMessage: `The selected confirmation strategy ${effectiveStrategy} deviates from the row default ${defaultStrategy}; pass --strategy-selection-rationale explaining why.`,
				partialRoutingDecision,
			};
		}
	}
	if (!CONFIRMATION_STRATEGIES_AVAILABLE_IN_THIS_RUNTIME.has(effectiveStrategy)) {
		return {
			routingSucceeded: false,
			routingRefusalErrorCode: CONFIRMATION_STRATEGY_NOT_YET_AVAILABLE_IN_THIS_RUNTIME_ERROR_CODE,
			routingRefusalMessage: `This change needs confirmation strategy ${effectiveStrategy} (matched ${partialRoutingDecision.matchedConfirmationAuthorityRowIds.join(" + ")}), which this runtime does not offer yet; it is not silently applied with a weaker strategy. The user can make this change in the Kanban Web UI Relations panel instead.`,
			partialRoutingDecision,
		};
	}
	const automaticallyDerivedRiskLabels =
		rankConfirmationStrategyForPolicyFloorUpgrade(effectiveStrategy) <
		rankConfirmationStrategyForPolicyFloorUpgrade(defaultStrategy)
			? [...new Set(rows.flatMap((row) => row.automaticallyDerivedRiskLabelsWhenWeakerThanDefault))]
			: [];
	return {
		routingSucceeded: true,
		routingDecision: {
			confirmationRoutingKind: "routed_through_confirmation_authority_rows",
			confirmationPolicyVersion: RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_POLICY_VERSION,
			...partialRoutingDecision,
			appliedConfirmationPolicyModifierRuleIds: [],
			agentSelectedConfirmationStrategy: input.agentSelectedConfirmationStrategy,
			strategySelectionRationale: input.strategySelectionRationale?.trim() || null,
			effectiveConfirmationStrategy: effectiveStrategy,
			confirmationStrategyUpgradedByPolicyFloor: upgradedByPolicyFloor,
			automaticallyDerivedRiskLabels,
			deadlineClockStartRule: null,
			confirmationDecisionDeadlineAt: null,
			userFacingPresentationChannels: ["relations_panel_passive_display_only"],
			proposingAgentWaitBehavior: "proposing_agent_continues_without_waiting",
			proposerRelativeCounterpartClassification:
				"counterpart_classification_not_evaluated_because_matched_rows_do_not_depend_on_it",
		},
	};
}

// 参照断言（Y-CONF-13 M1/M2）：只看提议方是不是端点之一。agent 经 CLI 断言时主语就是它自己，所以恒为 M1。
export function classifyReferenceRelationAssertionIntoConfirmationMatrixRows(input: {
	proposerIsOneOfTheRelationEndpoints: boolean;
}): string[] {
	return [input.proposerIsOneOfTheRelationEndpoints ? "M1" : "M2"];
}

// 撤销参照断言（Y-CONF-8）：参照只是上下文，撤销它「只减少自动动作或风险」，按撤销方是否原断言方分行；
// 被撤销的断言生效时含用户显式同意、撤销方又不是 Web UI 用户 → 另命中只允许 S6 的一行，交集后只剩 S6。
export function classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows(input: {
	revokedAssertionIncludesUserExplicitConsent: boolean;
	revokerIsOriginalAsserter: boolean;
}): string[] {
	const rowIds = [
		input.revokerIsOriginalAsserter
			? "M16:revoked_by_original_asserter_only_reducing_automation_or_risk"
			: "M16:revoked_by_non_original_asserter_only_reducing_automation_or_risk",
	];
	if (input.revokedAssertionIncludesUserExplicitConsent) {
		rowIds.push("M16:revoking_assertion_effective_with_user_explicit_consent_by_non_web_ui_user");
	}
	return rowIds;
}
