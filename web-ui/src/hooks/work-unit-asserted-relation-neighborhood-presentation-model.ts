// dd2db 2.1 Relations 面板里「断言型关系」的展示模型（纯函数）：把 getRelationNeighborhoodSummary 响应里的
// assertedRelations（当前生效的那些）整理成面板主体视角的行与分组。
//
// 与 runtime 的文本渲染（src/inter-work-unit-relation-ledger/asserted-relation-neighborhood-summary-text-rendering.ts）
// 同一套规则，只是产出结构：
// - 读法以面板主体视角成句：主体是 S 用正向读法、是 A 用反向读法；对称 kind 两端读法相同（读法逐字取 kind 注册表）；
// - 每行带决策来源标签（你直接断言 / 你确认过 / 独立核验通过 / agent 断言·你没审过）；
// - 分组：(a) 贡献过内容的 agent 全是本卡、或经用户 / 核验确认的；(b) 其余未经确认的（含对称 kind 由本卡首断、
//   又被对端 agent 重断言并入的）——理由是别的 agent 写的话，面板按引用数据展示，不当成说明文字；
// - 注册表标为默认不可见的 kind（泛相关）收进默认折叠的一组，与 1b 的折叠计数同理；
// - 本版界面不认识的 kind 按通用读法照常列出（标明不认识），绝不崩、也不静默吞掉。

import {
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitRelation,
	isAssertedInterWorkUnitReferenceRelationKind,
	isAssertedRelationPresentedAsAssertedByReaderOrConfirmed,
	listRelationContributingAgentWorkUnitRefsOfAssertedRelation,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import type {
	GetRelationNeighborhoodSummaryResponse,
	WorkUnitDisplayEntry,
} from "@runtime-work-unit-relation-read-api-contract";
import {
	areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit,
	buildWorkUnitRelationNeighborPresentation,
	type KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel,
	type WorkUnitRelationNeighborPresentation,
} from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";

type InterWorkUnitRelationWorkUnitReference = WorkUnitDisplayEntry["workUnit"];

const WEB_UI_USER_GESTURE_KANBAN_ACTOR_KIND = "kanban_web_ui_user_gesture_with_verified_page_load_nonce";

export type AssertedRelationDecisionSourceCategory =
	| "asserted_directly_by_user_in_web_ui"
	| "confirmed_by_user_in_web_ui"
	| "independently_verified_by_automated_verifier"
	| "agent_assertion_not_reviewed_by_user";

export const ASSERTED_RELATION_DECISION_SOURCE_LABEL_BY_DECISION_SOURCE_CATEGORY: Record<
	AssertedRelationDecisionSourceCategory,
	string
> = {
	asserted_directly_by_user_in_web_ui: "Asserted by you",
	confirmed_by_user_in_web_ui: "Confirmed by you",
	independently_verified_by_automated_verifier: "Independently verified",
	agent_assertion_not_reviewed_by_user: "Agent assertion · not reviewed by you",
};

export type AssertedRelationAsserterPresentation =
	| { relationAsserterKind: "panel_subject_work_unit"; relationAsserterDisplayLabel: string }
	| { relationAsserterKind: "web_ui_user"; relationAsserterDisplayLabel: string }
	| {
			relationAsserterKind: "other_work_unit";
			relationAsserterDisplayLabel: string;
			relationAsserterNeighbor: WorkUnitRelationNeighborPresentation;
	  }
	// 断言方不是工作单元、也不是 Web UI 用户（例如将来的系统组件）：原样显示行动者种类。
	| { relationAsserterKind: "other_kanban_actor"; relationAsserterDisplayLabel: string };

export interface AssertedRelationKindSpecificAttributeSummaryEntry {
	attributeKey: string;
	attributeDisplayLabel: string;
	attributeDisplayValues: string[];
}

export interface AssertedRelationRowFromPanelSubjectPerspective {
	relationId: string;
	relationKind: string;
	isRelationKindRecognizedByThisWebUi: boolean;
	panelSubjectRoleInRelationStatement: "relation_statement_subject" | "relation_statement_anchor";
	readingPhraseFromPanelSubjectPerspective: string;
	counterpartNeighbor: WorkUnitRelationNeighborPresentation;
	assertedRelationDecisionSourceCategory: AssertedRelationDecisionSourceCategory;
	assertedRelationDecisionSourceLabel: string;
	relationAsserter: AssertedRelationAsserterPresentation;
	// 首个断言方以外、面板主体以外、经重断言并入过内容的 agent 工作单元（对称 kind 的另一端点会并进同一条关系）。
	otherAgentWorkUnitNeighborsThatMergedContentByReassertion: WorkUnitRelationNeighborPresentation[];
	// 没经用户或核验确认、且贡献过内容的 agent 不全是面板主体：理由是别的 agent 写的话，只能按引用数据展示。
	isUnilaterallyDeclaredByAnotherWorkUnitWithoutConfirmation: boolean;
	relationAssertionRationaleOneSentence: string;
	relationAssertionEvidencePointers: string[];
	assertedRelationKindSpecificAttributeSummaryEntries: AssertedRelationKindSpecificAttributeSummaryEntry[];
	relationFirstEstablishedAt: number;
	relationLastUpdatedAt: number;
}

export interface WorkUnitAssertedRelationNeighborhoodPresentation {
	// (a) 由本卡断言，或经用户 / 独立核验确认（含用户直接断言）。
	assertedByPanelSubjectOrConfirmedRelationRows: AssertedRelationRowFromPanelSubjectPerspective[];
	// (b) 由别的工作单元单方面声明、未经用户或核验确认。
	unilaterallyDeclaredByAnotherWorkUnitRelationRows: AssertedRelationRowFromPanelSubjectPerspective[];
	// 注册表标为默认不可见的 kind（泛相关）：不分断言方，收进默认折叠的一组。
	collapsedByDefaultRelationRows: AssertedRelationRowFromPanelSubjectPerspective[];
	effectiveAssertedRelationCount: number;
}

export function resolveAssertedRelationDecisionSourceCategory(
	decisionSourcesOfEffectiveAssertion: readonly string[],
): AssertedRelationDecisionSourceCategory {
	// 优先级与 runtime 文本渲染一致：用户直接断言 > 用户确认 > 独立核验通过 > 其余都算「agent 断言、用户没审过」。
	if (
		decisionSourcesOfEffectiveAssertion.includes(
			"asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
		)
	) {
		return "asserted_directly_by_user_in_web_ui";
	}
	if (decisionSourcesOfEffectiveAssertion.includes("user_decided_in_web_ui_with_verified_user_decision_nonce")) {
		return "confirmed_by_user_in_web_ui";
	}
	if (
		decisionSourcesOfEffectiveAssertion.some((decisionSource) =>
			decisionSource.startsWith("independent_automated_verification_passed"),
		)
	) {
		return "independently_verified_by_automated_verifier";
	}
	return "agent_assertion_not_reviewed_by_user";
}

// 已知专有属性的展示名，数组顺序即展示顺序；不认识的属性排在后面、按键名展示。
const KNOWN_KIND_SPECIFIC_ATTRIBUTE_DISPLAY_LABELS: ReadonlyArray<readonly [string, string]> = [
	["concernedAspectSummary", "Aspect"],
	["concernNature", "Nature"],
	["claimsUnderVerification", "Claims"],
	["reusedOutputSummary", "Reused output"],
	["reusedOutputPointers", "Reused output pointers"],
	["originatedRequirementPortionSummary", "Requirement portion"],
	["sharedCrossRepositoryContractPointer", "Shared contract"],
	["relatednessRationaleOneSentence", "Relatedness"],
];

function renderUnknownAttributeValueAsDisplayText(attributeValue: unknown): string {
	if (typeof attributeValue === "string") {
		return attributeValue;
	}
	try {
		return JSON.stringify(attributeValue) ?? String(attributeValue);
	} catch {
		return String(attributeValue);
	}
}

function renderKindSpecificAttributeDisplayValues(attributeKey: string, attributeValue: unknown): string[] {
	if (attributeKey === "claimsUnderVerification" && Array.isArray(attributeValue)) {
		return attributeValue.map((claim) => {
			const { claimSummary, verificationVerdict } = (claim ?? {}) as {
				claimSummary?: unknown;
				verificationVerdict?: unknown;
			};
			return `${renderUnknownAttributeValueAsDisplayText(claimSummary)} (${renderUnknownAttributeValueAsDisplayText(verificationVerdict)})`;
		});
	}
	if (attributeKey === "concernNature" && typeof attributeValue === "string") {
		return [attributeValue.replaceAll("_", " ")];
	}
	if (Array.isArray(attributeValue)) {
		return attributeValue.map(renderUnknownAttributeValueAsDisplayText);
	}
	if (attributeValue === null || attributeValue === undefined || attributeValue === "") {
		return [];
	}
	return [renderUnknownAttributeValueAsDisplayText(attributeValue)];
}

export function buildAssertedRelationKindSpecificAttributeSummaryEntries(
	relation: Pick<
		AssertedInterWorkUnitRelation,
		"assertedRelationKindSpecificAttributes" | "relationAssertionRationaleOneSentence"
	>,
): AssertedRelationKindSpecificAttributeSummaryEntry[] {
	const attributes = relation.assertedRelationKindSpecificAttributes;
	const knownAttributeKeys = new Set(
		KNOWN_KIND_SPECIFIC_ATTRIBUTE_DISPLAY_LABELS.map(([attributeKey]) => attributeKey),
	);
	const orderedAttributeKeysWithDisplayLabels: Array<readonly [string, string]> = [
		...KNOWN_KIND_SPECIFIC_ATTRIBUTE_DISPLAY_LABELS.filter(([attributeKey]) => attributeKey in attributes),
		...Object.keys(attributes)
			.filter((attributeKey) => !knownAttributeKeys.has(attributeKey))
			.sort()
			.map((attributeKey) => [attributeKey, attributeKey] as const),
	];
	const summaryEntries: AssertedRelationKindSpecificAttributeSummaryEntry[] = [];
	for (const [attributeKey, attributeDisplayLabel] of orderedAttributeKeysWithDisplayLabels) {
		const attributeValue = attributes[attributeKey];
		// 泛相关的一句话理由是写入时从断言理由自动填的，与理由相同就不重复展示。
		if (
			attributeKey === "relatednessRationaleOneSentence" &&
			attributeValue === relation.relationAssertionRationaleOneSentence
		) {
			continue;
		}
		const attributeDisplayValues = renderKindSpecificAttributeDisplayValues(attributeKey, attributeValue);
		if (attributeDisplayValues.length === 0) {
			continue;
		}
		summaryEntries.push({ attributeKey, attributeDisplayLabel, attributeDisplayValues });
	}
	return summaryEntries;
}

function findDisplayEntryOfWorkUnit(
	relationNeighborhoodSummary: GetRelationNeighborhoodSummaryResponse,
	workUnit: InterWorkUnitRelationWorkUnitReference,
): WorkUnitDisplayEntry | null {
	return (
		relationNeighborhoodSummary.neighborWorkUnits.find((neighborDisplayEntry) =>
			areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(neighborDisplayEntry.workUnit, workUnit),
		) ?? null
	);
}

function describeNeighborForAsserterLabel(neighbor: WorkUnitRelationNeighborPresentation): string {
	if (neighbor.neighborWorkUnitType === "kanban_board_card") {
		return neighbor.neighborKanbanBoardCardCurrentTitle ?? `task ${neighbor.neighborKanbanBoardCardTaskId}`;
	}
	return neighbor.neighborWorkUnitDisplayLabel;
}

// 本版界面不认识的 kind：没有读法短语可取，用通用读法并点明主体在陈述里的角色，方向至少不会读反。
function buildGenericReadingPhraseForUnrecognizedAssertedRelationKind(
	relationKind: string,
	isPanelSubjectTheRelationStatementSubject: boolean,
): string {
	return isPanelSubjectTheRelationStatementSubject
		? `has an asserted relation "${relationKind}" (as subject) with`
		: `has an asserted relation "${relationKind}" (as anchor) with`;
}

function compareAssertedRelationRowsByMostRecentlyUpdatedFirst(
	left: AssertedRelationRowFromPanelSubjectPerspective,
	right: AssertedRelationRowFromPanelSubjectPerspective,
): number {
	return right.relationLastUpdatedAt - left.relationLastUpdatedAt;
}

export function buildWorkUnitAssertedRelationNeighborhoodPresentation(input: {
	relationNeighborhoodSummary: GetRelationNeighborhoodSummaryResponse;
	currentKanbanProjectWorkspaceId: string | null;
	knownKanbanProjectByWorkspaceId: KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel;
}): WorkUnitAssertedRelationNeighborhoodPresentation {
	const { relationNeighborhoodSummary } = input;
	const panelSubjectWorkUnit = relationNeighborhoodSummary.subjectWorkUnit.workUnit;
	// 旧 runtime 的响应没有 assertedRelations：当作没有断言型关系，而不是崩。
	const assertedRelations = relationNeighborhoodSummary.assertedRelations ?? [];
	const buildNeighborPresentationOfWorkUnit = (workUnit: InterWorkUnitRelationWorkUnitReference) =>
		buildWorkUnitRelationNeighborPresentation({
			neighborWorkUnit: workUnit,
			neighborDisplayEntry: findDisplayEntryOfWorkUnit(relationNeighborhoodSummary, workUnit),
			currentKanbanProjectWorkspaceId: input.currentKanbanProjectWorkspaceId,
			knownKanbanProjectByWorkspaceId: input.knownKanbanProjectByWorkspaceId,
		});

	const assertedByPanelSubjectOrConfirmedRelationRows: AssertedRelationRowFromPanelSubjectPerspective[] = [];
	const unilaterallyDeclaredByAnotherWorkUnitRelationRows: AssertedRelationRowFromPanelSubjectPerspective[] = [];
	const collapsedByDefaultRelationRows: AssertedRelationRowFromPanelSubjectPerspective[] = [];

	for (const relation of assertedRelations) {
		const isPanelSubjectTheRelationStatementSubject = areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(
			relation.relationStatementSubjectWorkUnitRef,
			panelSubjectWorkUnit,
		);
		const counterpartWorkUnit = isPanelSubjectTheRelationStatementSubject
			? relation.relationStatementAnchorWorkUnitRef
			: relation.relationStatementSubjectWorkUnitRef;
		const relationKindRegistryEntry = isAssertedInterWorkUnitReferenceRelationKind(relation.relationKind)
			? ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relation.relationKind]
			: null;
		const readingPhraseFromPanelSubjectPerspective = relationKindRegistryEntry
			? isPanelSubjectTheRelationStatementSubject
				? relationKindRegistryEntry.forwardReadingPhraseFromSubject
				: relationKindRegistryEntry.inverseReadingPhraseFromAnchor
			: buildGenericReadingPhraseForUnrecognizedAssertedRelationKind(
					relation.relationKind,
					isPanelSubjectTheRelationStatementSubject,
				);

		const relationAsserterWorkUnit = relation.relationAsserterWorkUnitRef;
		let relationAsserter: AssertedRelationAsserterPresentation;
		if (relationAsserterWorkUnit === null) {
			relationAsserter =
				relation.relationAsserterActorKind === WEB_UI_USER_GESTURE_KANBAN_ACTOR_KIND
					? { relationAsserterKind: "web_ui_user", relationAsserterDisplayLabel: "you" }
					: {
							relationAsserterKind: "other_kanban_actor",
							relationAsserterDisplayLabel: relation.relationAsserterActorKind,
						};
		} else if (
			areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(relationAsserterWorkUnit, panelSubjectWorkUnit)
		) {
			relationAsserter = {
				relationAsserterKind: "panel_subject_work_unit",
				relationAsserterDisplayLabel: "this task",
			};
		} else {
			const relationAsserterNeighbor = buildNeighborPresentationOfWorkUnit(relationAsserterWorkUnit);
			relationAsserter = {
				relationAsserterKind: "other_work_unit",
				relationAsserterDisplayLabel: describeNeighborForAsserterLabel(relationAsserterNeighbor),
				relationAsserterNeighbor,
			};
		}

		const isPanelSubjectWorkUnit = (workUnit: InterWorkUnitRelationWorkUnitReference): boolean =>
			areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(workUnit, panelSubjectWorkUnit);
		const otherAgentWorkUnitNeighborsThatMergedContentByReassertion =
			listRelationContributingAgentWorkUnitRefsOfAssertedRelation(relation)
				.filter(
					(contributingWorkUnit) =>
						!isPanelSubjectWorkUnit(contributingWorkUnit) &&
						!(
							relationAsserterWorkUnit !== null &&
							areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(
								contributingWorkUnit,
								relationAsserterWorkUnit,
							)
						),
				)
				.map(buildNeighborPresentationOfWorkUnit);
		const decisionSourcesOfEffectiveAssertion = relation.decisionSourcesOfEffectiveAssertion ?? [];
		const assertedRelationDecisionSourceCategory = resolveAssertedRelationDecisionSourceCategory(
			decisionSourcesOfEffectiveAssertion,
		);
		const assertedRelationRow: AssertedRelationRowFromPanelSubjectPerspective = {
			relationId: relation.relationId,
			relationKind: relation.relationKind,
			isRelationKindRecognizedByThisWebUi: relationKindRegistryEntry !== null,
			panelSubjectRoleInRelationStatement: isPanelSubjectTheRelationStatementSubject
				? "relation_statement_subject"
				: "relation_statement_anchor",
			readingPhraseFromPanelSubjectPerspective,
			counterpartNeighbor: buildNeighborPresentationOfWorkUnit(counterpartWorkUnit),
			assertedRelationDecisionSourceCategory,
			assertedRelationDecisionSourceLabel:
				ASSERTED_RELATION_DECISION_SOURCE_LABEL_BY_DECISION_SOURCE_CATEGORY[assertedRelationDecisionSourceCategory],
			relationAsserter,
			otherAgentWorkUnitNeighborsThatMergedContentByReassertion,
			// 与 runtime 文本渲染同一判据（契约文件 isAssertedRelationPresentedAsAssertedByReaderOrConfirmed）。
			isUnilaterallyDeclaredByAnotherWorkUnitWithoutConfirmation:
				!isAssertedRelationPresentedAsAssertedByReaderOrConfirmed({
					relation,
					isReaderWorkUnit: isPanelSubjectWorkUnit,
				}),
			relationAssertionRationaleOneSentence: relation.relationAssertionRationaleOneSentence,
			relationAssertionEvidencePointers: relation.relationAssertionEvidencePointers ?? [],
			assertedRelationKindSpecificAttributeSummaryEntries: buildAssertedRelationKindSpecificAttributeSummaryEntries({
				assertedRelationKindSpecificAttributes: relation.assertedRelationKindSpecificAttributes ?? {},
				relationAssertionRationaleOneSentence: relation.relationAssertionRationaleOneSentence,
			}),
			relationFirstEstablishedAt: relation.relationFirstEstablishedAt,
			relationLastUpdatedAt: relation.relationLastUpdatedAt,
		};

		if (relationKindRegistryEntry && !relationKindRegistryEntry.defaultVisibleInNeighborhoodSummary) {
			collapsedByDefaultRelationRows.push(assertedRelationRow);
			continue;
		}
		if (assertedRelationRow.isUnilaterallyDeclaredByAnotherWorkUnitWithoutConfirmation) {
			unilaterallyDeclaredByAnotherWorkUnitRelationRows.push(assertedRelationRow);
			continue;
		}
		assertedByPanelSubjectOrConfirmedRelationRows.push(assertedRelationRow);
	}

	return {
		assertedByPanelSubjectOrConfirmedRelationRows: assertedByPanelSubjectOrConfirmedRelationRows.sort(
			compareAssertedRelationRowsByMostRecentlyUpdatedFirst,
		),
		unilaterallyDeclaredByAnotherWorkUnitRelationRows: unilaterallyDeclaredByAnotherWorkUnitRelationRows.sort(
			compareAssertedRelationRowsByMostRecentlyUpdatedFirst,
		),
		collapsedByDefaultRelationRows: collapsedByDefaultRelationRows.sort(
			compareAssertedRelationRowsByMostRecentlyUpdatedFirst,
		),
		effectiveAssertedRelationCount: assertedRelations.length,
	};
}
