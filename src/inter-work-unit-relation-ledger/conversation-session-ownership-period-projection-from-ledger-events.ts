import { z } from "zod";

import { runtimeTaskAgentSessionInitializationReuseModeSchema } from "../core/api-contract";
import {
	type AgentConversationSessionIdentityKey,
	agentConversationSessionIdentityKeySchema,
	type InterWorkUnitRelationWorkUnitReference,
	type KanbanBoardCardWorkUnitQualifiedReference,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import { buildInterWorkUnitRelationWorkUnitKey } from "./kanban-board-card-identity-projection-from-ledger-events";

// dd2db 1b：会话归属时段登记簿的投影（Q4、d-vocab §3.1、Y-EVENT-18），以及由同一批身份事件推出的
// 采纳 / fork 来源关系。三者出自同一批族 2 事件，所以不会成为两份真相（d-vocab §2.2）。
//
// 归属规则（live 观测）：
// - 一个原生会话 id 首次在某张卡的会话里被观测到，就归这张卡；同一张卡的重复观测（含 T11 修复部署前的
//   重复「新身份」事件）只是去重。
// - 看板外独立会话以行动者身份出现时，id 归该独立会话。
// - 卡以 resume 方式续接了别人名下的 id（或 id 在另一张卡里被观测到）= 采纳：归属转给采纳方。
//   源卡之后又以同一 id 出现 = 共享会话冲突，只记诊断、不把归属转回去（Y-EVENT-18）。
// - fork 不转移归属，只记一条 fork 来源。
//
// 激活播种（runtime 激活时一次性读出的身份 sidecar / 初始化 sidecar）描述的是激活之前就已发生的历史，而激活批次
// 按 workspace 索引顺序逐个提交——提交顺序不是历史顺序。所以播种事实先登记进只增不减的索引（关系投影在按序消费
// 一批事件之前预扫描这一批），「推断源会话持有者」据此与播种的提交顺序无关；播种身份按序到达时的规则也不同于 live：
// - 卡此前已有过该 id 的时段（被「推断源会话持有者」按播种事实提前登记过）：同一条历史事实按序到达，只补会话 id。
// - 卡是该 id 的播种 resume 采纳方：先确立采纳前的持有者（播种原主卡或看板外独立会话占位），再按采纳转移。
// - 否则该 id 无人持有时卡直接成为持有者；已归别的工作单元时不转移：先前推断过独立会话占位 = 迟到的播种事实推翻了
//   推断，要求持有方从头重放；否则 = 两张卡在激活时都声称持有它且没有 resume 初始化能解释，只记共享会话冲突诊断。

const conversationSessionInitializationForProvenanceProjectionSchema = z.object({
	sourceAgentId: z.string(),
	sourceSessionId: z.string(),
	sourceSessionReuseMode: runtimeTaskAgentSessionInitializationReuseModeSchema,
});
export type ConversationSessionInitializationForProvenanceProjection = z.infer<
	typeof conversationSessionInitializationForProvenanceProjectionSchema
>;

export function readConversationSessionInitializationForProvenanceProjection(
	value: unknown,
): ConversationSessionInitializationForProvenanceProjection | null {
	const parsed = conversationSessionInitializationForProvenanceProjectionSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function readAgentConversationSessionIdentityKeyFromLedgerValue(
	value: unknown,
): AgentConversationSessionIdentityKey | null {
	const parsed = agentConversationSessionIdentityKeySchema.safeParse(value);
	return parsed.success
		? {
				conversationSessionHostKanbanAgentId: parsed.data.conversationSessionHostKanbanAgentId,
				nativeConversationSessionId: parsed.data.nativeConversationSessionId,
			}
		: null;
}

export type ConversationSessionOwnershipPeriodEstablishmentRoute =
	| "observed_in_kanban_task_conversation_session"
	| "seeded_from_session_identity_sidecar_at_live_capture_activation"
	| "acted_as_kanban_unmanaged_standalone_agent_conversation_session"
	// 卡片 resume / fork 的源会话此前从未在账本里出现、也没有任何卡在激活时播种过它：它只能是看板外独立会话，起始时刻未知。
	| "inferred_kanban_unmanaged_standalone_owner_of_resumed_or_forked_source_session";

export interface ConversationSessionOwnershipPeriod {
	conversationSessionIdentityKey: AgentConversationSessionIdentityKey;
	owningWorkUnit: InterWorkUnitRelationWorkUnitReference;
	ownershipPeriodStartedAt: number | null;
	ownershipPeriodEndedAt: number | null;
	ownershipPeriodEstablishmentRoute: ConversationSessionOwnershipPeriodEstablishmentRoute;
	// 卡内哪些 kanban 会话观测到过它（main / by-the-way）。
	observedInKanbanTaskConversationSessionIds: string[];
}

export interface ConversationSessionOwnershipConflictDiagnostic {
	conversationSessionIdentityKey: AgentConversationSessionIdentityKey;
	currentOwningWorkUnit: InterWorkUnitRelationWorkUnitReference;
	previouslyOwningKanbanBoardCardObservedAgain: KanbanBoardCardWorkUnitQualifiedReference;
	conflictObservedAt: number;
	conflictObservedInEventId: string;
}

export type ConversationSessionProvenanceRelationKind =
	| "provenance_resumed_and_adopted_conversation_session_of"
	| "provenance_forked_conversation_session_of";

// 推出的一次来源关系发生；由关系投影按去重键合并。
export interface ConversationSessionProvenanceRelationOccurrence {
	relationKind: ConversationSessionProvenanceRelationKind;
	subjectKanbanBoardCard: KanbanBoardCardWorkUnitQualifiedReference;
	anchorWorkUnit: InterWorkUnitRelationWorkUnitReference;
	occurredAt: number;
	recordedRelationKindSpecificAttributes: Record<string, unknown>;
}

interface TaskAgentSessionInitializationAwaitingSessionStart {
	taskAgentSessionInitialization: ConversationSessionInitializationForProvenanceProjection;
	setByActivationTimeSidecarRead: boolean;
}

// 一条激活时读出的身份 sidecar 事实：这张卡（经它的某个 kanban 会话）在激活那一刻持有这个原生会话 id。
export interface SeededConversationSessionIdentityFactReadAtLiveCaptureActivation {
	owningKanbanBoardCard: KanbanBoardCardWorkUnitQualifiedReference;
	kanbanTaskConversationSessionId: string | null;
	// sidecar 里记下的身份观测时刻（`agentNativeConversationSessionIdentityObservedAt`）；缺失为 null。
	sessionIdentitySidecarObservedAt: number | null;
	seedingLedgerEventId: string;
}

// 激活播种事实索引：只增不减，按 eventId 去重（同一事件重复登记是空操作）。持有方从头重放时新状态继承这份索引，
// 所以重放中「推断源会话持有者」一开始就看得到全部已提交的播种事实。
export interface LiveCaptureActivationSeededFactIndexForConversationSessionOwnership {
	ledgerEventIdsAlreadyRegisteredIntoSeededFactIndex: Set<string>;
	// （workspace, taskId）→ 激活基线里那一世卡片的完整引用；身份事件本身不带 incarnation，靠它补全。
	kanbanBoardCardObservedAtLiveCaptureActivationBaselineByWorkspaceAndTaskId: Map<
		string,
		KanbanBoardCardWorkUnitQualifiedReference
	>;
	seededConversationSessionIdentityFactsByConversationSessionIdentityKey: Map<
		string,
		SeededConversationSessionIdentityFactReadAtLiveCaptureActivation[]
	>;
	// 卡键 → 它在激活时的 resume 初始化所续接的源会话身份键（fork 不登记：fork 不转移归属）。
	seededResumeSourceConversationSessionIdentityKeyByAdoptingCardKey: Map<string, string>;
}

export interface ConversationSessionOwnershipProjectionState {
	ownershipPeriodsByConversationSessionIdentityKey: Map<string, ConversationSessionOwnershipPeriod[]>;
	conversationSessionIdentityKeysTouchedByWorkUnitKey: Map<string, Set<string>>;
	// 卡上设了 resume / fork 初始化、还没观测到会话启动的；会话启动（观测到身份）时兑现成来源关系。
	taskAgentSessionInitializationsAwaitingSessionStartByCardKey: Map<
		string,
		TaskAgentSessionInitializationAwaitingSessionStart
	>;
	// 只记卡的主会话（main）观测到的身份：卡上的 resume / fork 初始化描述的是主会话的启动。
	mostRecentObservedConversationSessionIdentityKeyByCardKey: Map<string, AgentConversationSessionIdentityKey>;
	conversationSessionOwnershipConflictDiagnostics: ConversationSessionOwnershipConflictDiagnostic[];
	liveCaptureActivationSeededFactIndex: LiveCaptureActivationSeededFactIndexForConversationSessionOwnership;
	// 本次投影里曾被推断为「看板外独立会话」占位持有过的身份键（不继承：重放时从空开始）。
	conversationSessionIdentityKeysEverOwnedByInferredStandalonePlaceholder: Set<string>;
	// 迟到的播种事实推翻了先前按序做出的归属判断（典型：先推断出独立会话占位，之后另一个 workspace 才播种出真正的
	// 原主卡）。纯投影不回溯改写已铸出的关系；持有方据此用继承播种事实索引的新状态从全局序号 0 重放。
	retroactiveRebuildRequiredBecauseLateSeededActivationFactContradictsEarlierOwnershipDecision: boolean;
}

function createEmptyLiveCaptureActivationSeededFactIndexForConversationSessionOwnership(): LiveCaptureActivationSeededFactIndexForConversationSessionOwnership {
	return {
		ledgerEventIdsAlreadyRegisteredIntoSeededFactIndex: new Set(),
		kanbanBoardCardObservedAtLiveCaptureActivationBaselineByWorkspaceAndTaskId: new Map(),
		seededConversationSessionIdentityFactsByConversationSessionIdentityKey: new Map(),
		seededResumeSourceConversationSessionIdentityKeyByAdoptingCardKey: new Map(),
	};
}

export function createEmptyConversationSessionOwnershipProjectionState(): ConversationSessionOwnershipProjectionState {
	return createEmptyConversationSessionOwnershipProjectionStateInheritingLiveCaptureActivationSeededFactIndex(
		createEmptyLiveCaptureActivationSeededFactIndexForConversationSessionOwnership(),
	);
}

// 从头重放用：除播种事实索引（直接共享同一份，只增不减）外全部清空。
export function createEmptyConversationSessionOwnershipProjectionStateInheritingLiveCaptureActivationSeededFactIndex(
	inheritedLiveCaptureActivationSeededFactIndex: LiveCaptureActivationSeededFactIndexForConversationSessionOwnership,
): ConversationSessionOwnershipProjectionState {
	return {
		ownershipPeriodsByConversationSessionIdentityKey: new Map(),
		conversationSessionIdentityKeysTouchedByWorkUnitKey: new Map(),
		taskAgentSessionInitializationsAwaitingSessionStartByCardKey: new Map(),
		mostRecentObservedConversationSessionIdentityKeyByCardKey: new Map(),
		conversationSessionOwnershipConflictDiagnostics: [],
		liveCaptureActivationSeededFactIndex: inheritedLiveCaptureActivationSeededFactIndex,
		conversationSessionIdentityKeysEverOwnedByInferredStandalonePlaceholder: new Set(),
		retroactiveRebuildRequiredBecauseLateSeededActivationFactContradictsEarlierOwnershipDecision: false,
	};
}

export function buildConversationSessionIdentityKeyString(identityKey: AgentConversationSessionIdentityKey): string {
	return `${identityKey.conversationSessionHostKanbanAgentId}:${identityKey.nativeConversationSessionId}`;
}

function buildWorkspaceAndTaskIdKeyOfLiveCaptureActivationBaselineCard(workspaceId: string, taskId: string): string {
	return `${workspaceId}\u0000${taskId}`;
}

// 返回 false = 这个事件已经登记过（重放或重复 apply），调用方跳过。
function claimLedgerEventIdForSeededFactIndexRegistration(
	seededFactIndex: LiveCaptureActivationSeededFactIndexForConversationSessionOwnership,
	ledgerEventId: string,
): boolean {
	if (seededFactIndex.ledgerEventIdsAlreadyRegisteredIntoSeededFactIndex.has(ledgerEventId)) {
		return false;
	}
	seededFactIndex.ledgerEventIdsAlreadyRegisteredIntoSeededFactIndex.add(ledgerEventId);
	return true;
}

export function registerKanbanBoardCardsObservedAtLiveCaptureActivationBaselineIntoSeededFactIndex(
	state: ConversationSessionOwnershipProjectionState,
	input: { ledgerEventId: string; baselineKanbanBoardCards: KanbanBoardCardWorkUnitQualifiedReference[] },
): void {
	const seededFactIndex = state.liveCaptureActivationSeededFactIndex;
	if (!claimLedgerEventIdForSeededFactIndexRegistration(seededFactIndex, input.ledgerEventId)) {
		return;
	}
	for (const baselineKanbanBoardCard of input.baselineKanbanBoardCards) {
		seededFactIndex.kanbanBoardCardObservedAtLiveCaptureActivationBaselineByWorkspaceAndTaskId.set(
			buildWorkspaceAndTaskIdKeyOfLiveCaptureActivationBaselineCard(
				baselineKanbanBoardCard.workspaceId,
				baselineKanbanBoardCard.taskId,
			),
			baselineKanbanBoardCard,
		);
	}
}

export function findKanbanBoardCardObservedAtLiveCaptureActivationBaseline(
	state: ConversationSessionOwnershipProjectionState,
	workspaceId: string,
	taskId: string,
): KanbanBoardCardWorkUnitQualifiedReference | null {
	return (
		state.liveCaptureActivationSeededFactIndex.kanbanBoardCardObservedAtLiveCaptureActivationBaselineByWorkspaceAndTaskId.get(
			buildWorkspaceAndTaskIdKeyOfLiveCaptureActivationBaselineCard(workspaceId, taskId),
		) ?? null
	);
}

export function registerSeededConversationSessionIdentityFactIntoSeededFactIndex(
	state: ConversationSessionOwnershipProjectionState,
	input: {
		ledgerEventId: string;
		identityKey: AgentConversationSessionIdentityKey;
		owningKanbanBoardCard: KanbanBoardCardWorkUnitQualifiedReference;
		kanbanTaskConversationSessionId: string | null;
		sessionIdentitySidecarObservedAt: number | null;
	},
): void {
	const seededFactIndex = state.liveCaptureActivationSeededFactIndex;
	if (!claimLedgerEventIdForSeededFactIndexRegistration(seededFactIndex, input.ledgerEventId)) {
		return;
	}
	const identityKeyString = buildConversationSessionIdentityKeyString(input.identityKey);
	const seededFacts =
		seededFactIndex.seededConversationSessionIdentityFactsByConversationSessionIdentityKey.get(identityKeyString) ??
		[];
	seededFacts.push({
		owningKanbanBoardCard: input.owningKanbanBoardCard,
		kanbanTaskConversationSessionId: input.kanbanTaskConversationSessionId,
		sessionIdentitySidecarObservedAt: input.sessionIdentitySidecarObservedAt,
		seedingLedgerEventId: input.ledgerEventId,
	});
	seededFactIndex.seededConversationSessionIdentityFactsByConversationSessionIdentityKey.set(
		identityKeyString,
		seededFacts,
	);
}

export function registerSeededResumeInitializationIntoSeededFactIndex(
	state: ConversationSessionOwnershipProjectionState,
	input: {
		ledgerEventId: string;
		adoptingCard: KanbanBoardCardWorkUnitQualifiedReference;
		resumedSourceIdentityKey: AgentConversationSessionIdentityKey;
	},
): void {
	const seededFactIndex = state.liveCaptureActivationSeededFactIndex;
	if (!claimLedgerEventIdForSeededFactIndexRegistration(seededFactIndex, input.ledgerEventId)) {
		return;
	}
	seededFactIndex.seededResumeSourceConversationSessionIdentityKeyByAdoptingCardKey.set(
		buildInterWorkUnitRelationWorkUnitKey(input.adoptingCard),
		buildConversationSessionIdentityKeyString(input.resumedSourceIdentityKey),
	);
	// 同一激活批次被账本分页拆开时，采纳方的身份 sidecar 可能已在上一页按序消费过（当时不知道它是 resume 采纳方，
	// 被当成了直接持有者或记成了冲突），resume 初始化此刻才登记：先前的判断不成立，要求持有方从头重放。
	if (
		hasOrderedOwnershipDecisionAboutCardAndConversationSession(
			state,
			input.adoptingCard,
			input.resumedSourceIdentityKey,
		)
	) {
		state.retroactiveRebuildRequiredBecauseLateSeededActivationFactContradictsEarlierOwnershipDecision = true;
	}
}

function hasOrderedOwnershipDecisionAboutCardAndConversationSession(
	state: ConversationSessionOwnershipProjectionState,
	card: KanbanBoardCardWorkUnitQualifiedReference,
	identityKey: AgentConversationSessionIdentityKey,
): boolean {
	const identityKeyString = buildConversationSessionIdentityKeyString(identityKey);
	return (
		listOwnershipPeriodsOfConversationSession(state, identityKey).some((period) =>
			isSameWorkUnit(period.owningWorkUnit, card),
		) ||
		state.conversationSessionOwnershipConflictDiagnostics.some(
			(diagnostic) =>
				buildConversationSessionIdentityKeyString(diagnostic.conversationSessionIdentityKey) ===
					identityKeyString && isSameWorkUnit(diagnostic.previouslyOwningKanbanBoardCardObservedAgain, card),
		)
	);
}

function isSeededResumeAdopterOfConversationSession(
	state: ConversationSessionOwnershipProjectionState,
	card: KanbanBoardCardWorkUnitQualifiedReference,
	identityKeyString: string,
): boolean {
	return (
		state.liveCaptureActivationSeededFactIndex.seededResumeSourceConversationSessionIdentityKeyByAdoptingCardKey.get(
			buildInterWorkUnitRelationWorkUnitKey(card),
		) === identityKeyString
	);
}

function rememberConversationSessionIdentityKeyTouchedByWorkUnit(
	state: ConversationSessionOwnershipProjectionState,
	workUnit: InterWorkUnitRelationWorkUnitReference,
	identityKey: AgentConversationSessionIdentityKey,
): void {
	const workUnitKey = buildInterWorkUnitRelationWorkUnitKey(workUnit);
	const identityKeyStrings = state.conversationSessionIdentityKeysTouchedByWorkUnitKey.get(workUnitKey) ?? new Set();
	identityKeyStrings.add(buildConversationSessionIdentityKeyString(identityKey));
	state.conversationSessionIdentityKeysTouchedByWorkUnitKey.set(workUnitKey, identityKeyStrings);
}

function listOwnershipPeriodsOfConversationSession(
	state: ConversationSessionOwnershipProjectionState,
	identityKey: AgentConversationSessionIdentityKey,
): ConversationSessionOwnershipPeriod[] {
	return (
		state.ownershipPeriodsByConversationSessionIdentityKey.get(
			buildConversationSessionIdentityKeyString(identityKey),
		) ?? []
	);
}

function findCurrentOwnershipPeriod(
	state: ConversationSessionOwnershipProjectionState,
	identityKey: AgentConversationSessionIdentityKey,
): ConversationSessionOwnershipPeriod | null {
	return listOwnershipPeriodsOfConversationSession(state, identityKey).at(-1) ?? null;
}

// 写入点名一个原生会话时按「此刻」查归属（d-vocab §2.1）：已被某张卡采纳的会话存成那张卡的引用；没人认领时为 null。
export function findCurrentlyOwningWorkUnitOfConversationSessionIdentity(
	state: ConversationSessionOwnershipProjectionState,
	identityKey: AgentConversationSessionIdentityKey,
): InterWorkUnitRelationWorkUnitReference | null {
	return findCurrentOwnershipPeriod(state, identityKey)?.owningWorkUnit ?? null;
}

function appendOwnershipPeriod(
	state: ConversationSessionOwnershipProjectionState,
	period: ConversationSessionOwnershipPeriod,
): void {
	const identityKeyString = buildConversationSessionIdentityKeyString(period.conversationSessionIdentityKey);
	const periods = state.ownershipPeriodsByConversationSessionIdentityKey.get(identityKeyString) ?? [];
	periods.push(period);
	state.ownershipPeriodsByConversationSessionIdentityKey.set(identityKeyString, periods);
	rememberConversationSessionIdentityKeyTouchedByWorkUnit(
		state,
		period.owningWorkUnit,
		period.conversationSessionIdentityKey,
	);
}

function rememberKanbanTaskConversationSessionObservedInOwnershipPeriod(
	period: ConversationSessionOwnershipPeriod,
	kanbanTaskConversationSessionId: string | null,
): void {
	if (
		kanbanTaskConversationSessionId &&
		!period.observedInKanbanTaskConversationSessionIds.includes(kanbanTaskConversationSessionId)
	) {
		period.observedInKanbanTaskConversationSessionIds.push(kanbanTaskConversationSessionId);
	}
}

function buildStandaloneSessionWorkUnit(
	identityKey: AgentConversationSessionIdentityKey,
): InterWorkUnitRelationWorkUnitReference {
	return {
		workUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
		conversationSessionHostKanbanAgentId: identityKey.conversationSessionHostKanbanAgentId,
		nativeConversationSessionId: identityKey.nativeConversationSessionId,
	};
}

function isSameWorkUnit(
	left: InterWorkUnitRelationWorkUnitReference,
	right: InterWorkUnitRelationWorkUnitReference,
): boolean {
	return buildInterWorkUnitRelationWorkUnitKey(left) === buildInterWorkUnitRelationWorkUnitKey(right);
}

// 激活时播种了这个 id、且不是它的 resume 采纳方（也不是被排除的卡）的卡里，sidecar 观测最早的那张 = 原主。
// 观测时刻缺失的排在最后；同时刻按登记顺序（全局提交序号）取先到的。
function findSeededOriginalOwnerFactOfConversationSession(
	state: ConversationSessionOwnershipProjectionState,
	identityKey: AgentConversationSessionIdentityKey,
	cardExcludedFromOriginalOwnerCandidates: KanbanBoardCardWorkUnitQualifiedReference | null,
): SeededConversationSessionIdentityFactReadAtLiveCaptureActivation | null {
	const identityKeyString = buildConversationSessionIdentityKeyString(identityKey);
	const seededFacts =
		state.liveCaptureActivationSeededFactIndex.seededConversationSessionIdentityFactsByConversationSessionIdentityKey.get(
			identityKeyString,
		) ?? [];
	let earliestOriginalOwnerFact: SeededConversationSessionIdentityFactReadAtLiveCaptureActivation | null = null;
	for (const seededFact of seededFacts) {
		if (
			(cardExcludedFromOriginalOwnerCandidates &&
				isSameWorkUnit(seededFact.owningKanbanBoardCard, cardExcludedFromOriginalOwnerCandidates)) ||
			isSeededResumeAdopterOfConversationSession(state, seededFact.owningKanbanBoardCard, identityKeyString)
		) {
			continue;
		}
		if (
			!earliestOriginalOwnerFact ||
			(seededFact.sessionIdentitySidecarObservedAt ?? Number.POSITIVE_INFINITY) <
				(earliestOriginalOwnerFact.sessionIdentitySidecarObservedAt ?? Number.POSITIVE_INFINITY)
		) {
			earliestOriginalOwnerFact = seededFact;
		}
	}
	return earliestOriginalOwnerFact;
}

// resume / fork 的源会话在那一刻归谁。
// - 已有当前时段：归其持有者。被排除的采纳方卡（激活时 resume 了它的卡自己）恰是当前持有者、且这是它自己的
//   播种时段时，要的是它之前的持有者。
// - 没有当前时段：先查播种事实（见 findSeededOriginalOwnerFactOfConversationSession），找到原主就为它登记播种时段；
//   找不到才推定为看板外独立会话（登记一个起点未知的占位时段，并记下这个 id 有过推断占位）。
function resolveOrInferCurrentOwnerOfSourceConversationSession(
	state: ConversationSessionOwnershipProjectionState,
	sourceIdentityKey: AgentConversationSessionIdentityKey,
	adoptingCardExcludedFromSourceOwnerResolution: KanbanBoardCardWorkUnitQualifiedReference | null,
): InterWorkUnitRelationWorkUnitReference {
	const periods = listOwnershipPeriodsOfConversationSession(state, sourceIdentityKey);
	const currentPeriod = periods.at(-1);
	if (currentPeriod) {
		if (
			adoptingCardExcludedFromSourceOwnerResolution &&
			isSameWorkUnit(currentPeriod.owningWorkUnit, adoptingCardExcludedFromSourceOwnerResolution) &&
			currentPeriod.ownershipPeriodEstablishmentRoute ===
				"seeded_from_session_identity_sidecar_at_live_capture_activation"
		) {
			const periodBeforeAdoptingCardSeededPeriod = periods.at(-2);
			if (periodBeforeAdoptingCardSeededPeriod) {
				return periodBeforeAdoptingCardSeededPeriod.owningWorkUnit;
			}
			// 采纳方的身份 sidecar 按序到达时，它的 resume 初始化还不在索引里（同一激活批次被账本分页拆开），它被当成了
			// 直接持有者。从头重放时索引已齐，会先确立采纳前的持有者再转移。
			state.retroactiveRebuildRequiredBecauseLateSeededActivationFactContradictsEarlierOwnershipDecision = true;
		}
		return currentPeriod.owningWorkUnit;
	}
	const seededOriginalOwnerFact = findSeededOriginalOwnerFactOfConversationSession(
		state,
		sourceIdentityKey,
		adoptingCardExcludedFromSourceOwnerResolution,
	);
	if (seededOriginalOwnerFact) {
		appendOwnershipPeriod(state, {
			conversationSessionIdentityKey: sourceIdentityKey,
			owningWorkUnit: seededOriginalOwnerFact.owningKanbanBoardCard,
			ownershipPeriodStartedAt: seededOriginalOwnerFact.sessionIdentitySidecarObservedAt,
			ownershipPeriodEndedAt: null,
			ownershipPeriodEstablishmentRoute: "seeded_from_session_identity_sidecar_at_live_capture_activation",
			observedInKanbanTaskConversationSessionIds: seededOriginalOwnerFact.kanbanTaskConversationSessionId
				? [seededOriginalOwnerFact.kanbanTaskConversationSessionId]
				: [],
		});
		return seededOriginalOwnerFact.owningKanbanBoardCard;
	}
	const standaloneSessionWorkUnit = buildStandaloneSessionWorkUnit(sourceIdentityKey);
	appendOwnershipPeriod(state, {
		conversationSessionIdentityKey: sourceIdentityKey,
		owningWorkUnit: standaloneSessionWorkUnit,
		ownershipPeriodStartedAt: null,
		ownershipPeriodEndedAt: null,
		ownershipPeriodEstablishmentRoute:
			"inferred_kanban_unmanaged_standalone_owner_of_resumed_or_forked_source_session",
		observedInKanbanTaskConversationSessionIds: [],
	});
	state.conversationSessionIdentityKeysEverOwnedByInferredStandalonePlaceholder.add(
		buildConversationSessionIdentityKeyString(sourceIdentityKey),
	);
	return standaloneSessionWorkUnit;
}

// 把 id 的归属转给采纳方。返回采纳关系；旧主人是同一张卡、或旧主人是「曾被采纳走的源卡又出现」时返回 null。
function transferConversationSessionOwnershipToAdoptingCard(
	state: ConversationSessionOwnershipProjectionState,
	input: {
		identityKey: AgentConversationSessionIdentityKey;
		adoptingCard: KanbanBoardCardWorkUnitQualifiedReference;
		kanbanTaskConversationSessionId: string | null;
		observedAt: number;
		eventId: string;
		ownershipPeriodEstablishmentRoute: ConversationSessionOwnershipPeriodEstablishmentRoute;
	},
): ConversationSessionProvenanceRelationOccurrence | null {
	const currentPeriod = findCurrentOwnershipPeriod(state, input.identityKey);
	const observedInKanbanTaskConversationSessionIds = input.kanbanTaskConversationSessionId
		? [input.kanbanTaskConversationSessionId]
		: [];
	if (!currentPeriod) {
		appendOwnershipPeriod(state, {
			conversationSessionIdentityKey: input.identityKey,
			owningWorkUnit: input.adoptingCard,
			ownershipPeriodStartedAt: input.observedAt,
			ownershipPeriodEndedAt: null,
			ownershipPeriodEstablishmentRoute: input.ownershipPeriodEstablishmentRoute,
			observedInKanbanTaskConversationSessionIds,
		});
		return null;
	}
	if (isSameWorkUnit(currentPeriod.owningWorkUnit, input.adoptingCard)) {
		rememberKanbanTaskConversationSessionObservedInOwnershipPeriod(
			currentPeriod,
			input.kanbanTaskConversationSessionId,
		);
		return null;
	}
	const adoptingCardOwnedThisSessionBefore = listOwnershipPeriodsOfConversationSession(state, input.identityKey).some(
		(period) => isSameWorkUnit(period.owningWorkUnit, input.adoptingCard),
	);
	if (adoptingCardOwnedThisSessionBefore) {
		state.conversationSessionOwnershipConflictDiagnostics.push({
			conversationSessionIdentityKey: input.identityKey,
			currentOwningWorkUnit: currentPeriod.owningWorkUnit,
			previouslyOwningKanbanBoardCardObservedAgain: input.adoptingCard,
			conflictObservedAt: input.observedAt,
			conflictObservedInEventId: input.eventId,
		});
		return null;
	}
	currentPeriod.ownershipPeriodEndedAt = input.observedAt;
	appendOwnershipPeriod(state, {
		conversationSessionIdentityKey: input.identityKey,
		owningWorkUnit: input.adoptingCard,
		ownershipPeriodStartedAt: input.observedAt,
		ownershipPeriodEndedAt: null,
		ownershipPeriodEstablishmentRoute: input.ownershipPeriodEstablishmentRoute,
		observedInKanbanTaskConversationSessionIds,
	});
	return {
		relationKind: "provenance_resumed_and_adopted_conversation_session_of",
		subjectKanbanBoardCard: input.adoptingCard,
		anchorWorkUnit: currentPeriod.owningWorkUnit,
		occurredAt: input.observedAt,
		recordedRelationKindSpecificAttributes: {
			adoptedNativeConversationSessionIdentity: input.identityKey,
			conversationSessionOwnershipTransferredAt: input.observedAt,
		},
	};
}

function consumeTaskAgentSessionInitializationAtObservedSessionStart(
	state: ConversationSessionOwnershipProjectionState,
	input: {
		card: KanbanBoardCardWorkUnitQualifiedReference;
		awaitingInitialization: TaskAgentSessionInitializationAwaitingSessionStart;
		// null：会话确实启动过，但账本里没有它的身份观测（激活前的老卡、没有身份 sidecar 的 harness）。
		observedIdentityKey: AgentConversationSessionIdentityKey | null;
		identityObservationSource: string;
		observedAt: number;
		eventId: string;
	},
): ConversationSessionProvenanceRelationOccurrence[] {
	const initialization = input.awaitingInitialization.taskAgentSessionInitialization;
	const sourceIdentityKey: AgentConversationSessionIdentityKey = {
		conversationSessionHostKanbanAgentId: initialization.sourceAgentId,
		nativeConversationSessionId: initialization.sourceSessionId,
	};
	if (initialization.sourceSessionReuseMode === "fork_existing_session") {
		const forkSourceOwner = resolveOrInferCurrentOwnerOfSourceConversationSession(state, sourceIdentityKey, null);
		if (isSameWorkUnit(forkSourceOwner, input.card)) {
			return [];
		}
		const forkedIntoDifferentIdentity =
			input.observedIdentityKey !== null &&
			buildConversationSessionIdentityKeyString(input.observedIdentityKey) !==
				buildConversationSessionIdentityKeyString(sourceIdentityKey);
		return [
			{
				relationKind: "provenance_forked_conversation_session_of",
				subjectKanbanBoardCard: input.card,
				anchorWorkUnit: forkSourceOwner,
				occurredAt: input.observedAt,
				recordedRelationKindSpecificAttributes: {
					forkedFromNativeConversationSessionIdentity: sourceIdentityKey,
					forkedIntoNativeConversationSessionIdentity: forkedIntoDifferentIdentity
						? input.observedIdentityKey
						: null,
					identityObservationSource: input.identityObservationSource,
				},
			},
		];
	}
	// resume：先确立源会话此刻的持有者（播种原主卡或推定的看板外独立会话），再按采纳转移归属。激活时读出的初始化
	// 把卡自己排除在外：它自己的播种身份只证明它 resume 之后持有该 id，不能当成采纳前的持有者。
	resolveOrInferCurrentOwnerOfSourceConversationSession(
		state,
		sourceIdentityKey,
		input.awaitingInitialization.setByActivationTimeSidecarRead ? input.card : null,
	);
	const adoption = transferConversationSessionOwnershipToAdoptingCard(state, {
		identityKey: sourceIdentityKey,
		adoptingCard: input.card,
		kanbanTaskConversationSessionId: null,
		observedAt: input.observedAt,
		eventId: input.eventId,
		ownershipPeriodEstablishmentRoute: "observed_in_kanban_task_conversation_session",
	});
	return adoption ? [adoption] : [];
}

// 卡上设置（或清除）了 resume / fork 初始化。激活时 sidecar 读出的初始化描述的是一次已经发生的启动，
// 满足其一就立即兑现：该卡已观测到会话（激活批次里身份 sidecar 先于初始化 sidecar），或该卡在激活基线里
// 已经离开 backlog（激活前的老卡多半没有身份 sidecar——实测 3484 上 51 张全是这样，其中 46 张 codex fork）。
export function applyTaskAgentSessionInitializationSetOnKanbanBoardCard(
	state: ConversationSessionOwnershipProjectionState,
	input: {
		card: KanbanBoardCardWorkUnitQualifiedReference;
		taskAgentSessionInitialization: ConversationSessionInitializationForProvenanceProjection | null;
		setByActivationTimeSidecarRead: boolean;
		cardHadLeftBacklogAtLiveCaptureActivationBaseline: boolean;
		observedAt: number;
		eventId: string;
	},
): ConversationSessionProvenanceRelationOccurrence[] {
	const cardKey = buildInterWorkUnitRelationWorkUnitKey(input.card);
	if (!input.taskAgentSessionInitialization) {
		state.taskAgentSessionInitializationsAwaitingSessionStartByCardKey.delete(cardKey);
		return [];
	}
	const awaitingInitialization: TaskAgentSessionInitializationAwaitingSessionStart = {
		taskAgentSessionInitialization: input.taskAgentSessionInitialization,
		setByActivationTimeSidecarRead: input.setByActivationTimeSidecarRead,
	};
	const alreadyObservedIdentityKey =
		state.mostRecentObservedConversationSessionIdentityKeyByCardKey.get(cardKey) ?? null;
	if (
		input.setByActivationTimeSidecarRead &&
		(alreadyObservedIdentityKey || input.cardHadLeftBacklogAtLiveCaptureActivationBaseline)
	) {
		return consumeTaskAgentSessionInitializationAtObservedSessionStart(state, {
			card: input.card,
			awaitingInitialization,
			observedIdentityKey: alreadyObservedIdentityKey,
			identityObservationSource: alreadyObservedIdentityKey
				? "session_identity_sidecar_read_at_live_capture_activation"
				: "session_start_inferred_from_card_having_left_backlog_at_live_capture_activation_baseline",
			observedAt: input.observedAt,
			eventId: input.eventId,
		});
	}
	state.taskAgentSessionInitializationsAwaitingSessionStartByCardKey.set(cardKey, awaitingInitialization);
	return [];
}

// 激活播种的身份 sidecar 按序到达（规则见文件头「激活播种」一节）。
function applyConversationSessionIdentitySeededAtLiveCaptureActivationArrivingInOrder(
	state: ConversationSessionOwnershipProjectionState,
	input: {
		card: KanbanBoardCardWorkUnitQualifiedReference;
		identityKey: AgentConversationSessionIdentityKey;
		kanbanTaskConversationSessionId: string | null;
		observedAt: number;
		eventId: string;
	},
): ConversationSessionProvenanceRelationOccurrence[] {
	const identityKeyString = buildConversationSessionIdentityKeyString(input.identityKey);
	const periods = listOwnershipPeriodsOfConversationSession(state, input.identityKey);
	const periodsOwnedByThisCard = periods.filter((period) => isSameWorkUnit(period.owningWorkUnit, input.card));
	const latestPeriodOwnedByThisCard = periodsOwnedByThisCard.at(-1);
	if (latestPeriodOwnedByThisCard) {
		rememberKanbanTaskConversationSessionObservedInOwnershipPeriod(
			latestPeriodOwnedByThisCard,
			input.kanbanTaskConversationSessionId,
		);
		return [];
	}
	const cardIsSeededResumeAdopterOfThisSession = isSeededResumeAdopterOfConversationSession(
		state,
		input.card,
		identityKeyString,
	);
	const transferToSeededResumeAdopter = (): ConversationSessionProvenanceRelationOccurrence[] => {
		const adoption = transferConversationSessionOwnershipToAdoptingCard(state, {
			identityKey: input.identityKey,
			adoptingCard: input.card,
			kanbanTaskConversationSessionId: input.kanbanTaskConversationSessionId,
			observedAt: input.observedAt,
			eventId: input.eventId,
			ownershipPeriodEstablishmentRoute: "seeded_from_session_identity_sidecar_at_live_capture_activation",
		});
		return adoption ? [adoption] : [];
	};
	const currentPeriod = periods.at(-1);
	if (!currentPeriod) {
		if (cardIsSeededResumeAdopterOfThisSession) {
			resolveOrInferCurrentOwnerOfSourceConversationSession(state, input.identityKey, input.card);
			return transferToSeededResumeAdopter();
		}
		appendOwnershipPeriod(state, {
			conversationSessionIdentityKey: input.identityKey,
			owningWorkUnit: input.card,
			ownershipPeriodStartedAt: input.observedAt,
			ownershipPeriodEndedAt: null,
			ownershipPeriodEstablishmentRoute: "seeded_from_session_identity_sidecar_at_live_capture_activation",
			observedInKanbanTaskConversationSessionIds: input.kanbanTaskConversationSessionId
				? [input.kanbanTaskConversationSessionId]
				: [],
		});
		return [];
	}
	if (cardIsSeededResumeAdopterOfThisSession) {
		return transferToSeededResumeAdopter();
	}
	if (state.conversationSessionIdentityKeysEverOwnedByInferredStandalonePlaceholder.has(identityKeyString)) {
		state.retroactiveRebuildRequiredBecauseLateSeededActivationFactContradictsEarlierOwnershipDecision = true;
		return [];
	}
	state.conversationSessionOwnershipConflictDiagnostics.push({
		conversationSessionIdentityKey: input.identityKey,
		currentOwningWorkUnit: currentPeriod.owningWorkUnit,
		previouslyOwningKanbanBoardCardObservedAgain: input.card,
		conflictObservedAt: input.observedAt,
		conflictObservedInEventId: input.eventId,
	});
	return [];
}

export function applyConversationSessionIdentityObservedInKanbanBoardCard(
	state: ConversationSessionOwnershipProjectionState,
	input: {
		card: KanbanBoardCardWorkUnitQualifiedReference;
		identityKey: AgentConversationSessionIdentityKey;
		kanbanTaskConversationSessionId: string | null;
		// false = 卡的旁路（by-the-way）会话：只登记归属，不兑现卡上的初始化、不算卡的主会话已启动。
		observedInMainKanbanTaskConversationSessionOfCard: boolean;
		observedBySessionIdentitySidecarReadAtLiveCaptureActivation: boolean;
		observedAt: number;
		eventId: string;
	},
): ConversationSessionProvenanceRelationOccurrence[] {
	const cardKey = buildInterWorkUnitRelationWorkUnitKey(input.card);
	const provenanceRelationOccurrences: ConversationSessionProvenanceRelationOccurrence[] = [];
	if (input.observedInMainKanbanTaskConversationSessionOfCard) {
		const awaitingInitialization = state.taskAgentSessionInitializationsAwaitingSessionStartByCardKey.get(cardKey);
		if (awaitingInitialization) {
			state.taskAgentSessionInitializationsAwaitingSessionStartByCardKey.delete(cardKey);
			provenanceRelationOccurrences.push(
				...consumeTaskAgentSessionInitializationAtObservedSessionStart(state, {
					card: input.card,
					awaitingInitialization,
					observedIdentityKey: input.identityKey,
					identityObservationSource: input.observedBySessionIdentitySidecarReadAtLiveCaptureActivation
						? "session_identity_sidecar_read_at_live_capture_activation"
						: "kanban_task_conversation_session_native_identity_observation",
					observedAt: input.observedAt,
					eventId: input.eventId,
				}),
			);
		}
		state.mostRecentObservedConversationSessionIdentityKeyByCardKey.set(cardKey, input.identityKey);
	}
	if (input.observedBySessionIdentitySidecarReadAtLiveCaptureActivation) {
		provenanceRelationOccurrences.push(
			...applyConversationSessionIdentitySeededAtLiveCaptureActivationArrivingInOrder(state, {
				card: input.card,
				identityKey: input.identityKey,
				kanbanTaskConversationSessionId: input.kanbanTaskConversationSessionId,
				observedAt: input.observedAt,
				eventId: input.eventId,
			}),
		);
		return provenanceRelationOccurrences;
	}
	const adoption = transferConversationSessionOwnershipToAdoptingCard(state, {
		identityKey: input.identityKey,
		adoptingCard: input.card,
		kanbanTaskConversationSessionId: input.kanbanTaskConversationSessionId,
		observedAt: input.observedAt,
		eventId: input.eventId,
		ownershipPeriodEstablishmentRoute: "observed_in_kanban_task_conversation_session",
	});
	if (adoption) {
		provenanceRelationOccurrences.push(adoption);
	}
	return provenanceRelationOccurrences;
}

// 看板外独立会话以行动者身份出现：id 还没人认领时归它。已归某张卡的 id 不会解析成独立会话行动者（1a 的解析顺序）。
export function applyKanbanUnmanagedStandaloneSessionActedAsActor(
	state: ConversationSessionOwnershipProjectionState,
	input: { identityKey: AgentConversationSessionIdentityKey; actedAt: number },
): void {
	if (findCurrentOwnershipPeriod(state, input.identityKey)) {
		return;
	}
	appendOwnershipPeriod(state, {
		conversationSessionIdentityKey: input.identityKey,
		owningWorkUnit: buildStandaloneSessionWorkUnit(input.identityKey),
		ownershipPeriodStartedAt: input.actedAt,
		ownershipPeriodEndedAt: null,
		ownershipPeriodEstablishmentRoute: "acted_as_kanban_unmanaged_standalone_agent_conversation_session",
		observedInKanbanTaskConversationSessionIds: [],
	});
}

export function listConversationSessionOwnershipPeriodsOfWorkUnit(
	state: ConversationSessionOwnershipProjectionState,
	workUnit: InterWorkUnitRelationWorkUnitReference,
): ConversationSessionOwnershipPeriod[] {
	const identityKeyStrings =
		state.conversationSessionIdentityKeysTouchedByWorkUnitKey.get(buildInterWorkUnitRelationWorkUnitKey(workUnit)) ??
		new Set<string>();
	const periods: ConversationSessionOwnershipPeriod[] = [];
	for (const identityKeyString of identityKeyStrings) {
		for (const period of state.ownershipPeriodsByConversationSessionIdentityKey.get(identityKeyString) ?? []) {
			if (isSameWorkUnit(period.owningWorkUnit, workUnit)) {
				periods.push(period);
			}
		}
	}
	return periods.sort((left, right) => (left.ownershipPeriodStartedAt ?? 0) - (right.ownershipPeriodStartedAt ?? 0));
}

export function listConversationSessionOwnershipConflictDiagnosticsTouchingWorkUnit(
	state: ConversationSessionOwnershipProjectionState,
	workUnit: InterWorkUnitRelationWorkUnitReference,
): ConversationSessionOwnershipConflictDiagnostic[] {
	return state.conversationSessionOwnershipConflictDiagnostics.filter(
		(diagnostic) =>
			isSameWorkUnit(diagnostic.currentOwningWorkUnit, workUnit) ||
			isSameWorkUnit(diagnostic.previouslyOwningKanbanBoardCardObservedAgain, workUnit),
	);
}
