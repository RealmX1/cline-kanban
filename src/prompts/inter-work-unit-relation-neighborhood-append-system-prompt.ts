import { isHomeAgentSessionId } from "../core/home-agent-session";
import {
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitRelation,
	isAssertedInterWorkUnitReferenceRelationKind,
} from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import type {
	CapturingKanbanRuntimeInstanceIdentity,
	InterWorkUnitRelationLedgerEventDraft,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import { findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId } from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import {
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
	startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking,
} from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { assembleRecordedRelationNeighborhoodSummaryOfWorkUnit } from "../inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-assembly";
import { resolveAppendSystemPromptCommandPrefix } from "./append-system-prompt";

// dd2db 1b「会话启动时注入邻域摘要」：卡片会话启动时，若它与别的工作单元之间有默认可见的关系
// （谁建了它、从谁的会话 fork / 采纳、谁改过它的需求、它建了谁、阶段 2 起还有断言的参照关系……），把邻域摘要作为一段
// append system prompt 注入。只是启动那一刻的快照；agent 要最新的就跑 CLI。
//
// 绝不阻断会话启动：账本不可用、卡认不出、读超时一律退化为不注入。ACP 通道没有 system prompt 机制，不经过这里；
// Cline 通道已停止维护（AGENTS.md），不接。
// EXPERIMENT_NODE: 启动注入的读超时 2s——runtime 刚起时首读要全量重放账本（3484 实测约 0.6s），超时只是这次不注入。
const NEIGHBORHOOD_SUMMARY_READ_TIMEOUT_MS_AT_SESSION_START = 2_000;

const SESSION_START_RELATION_NEIGHBORHOOD_INJECTOR_SYSTEM_COMPONENT_NAME =
	"kanban_runtime_session_start_inter_work_unit_relation_neighborhood_injector";

export function renderInterWorkUnitRelationNeighborhoodAppendSystemPrompt(
	renderedNeighborhoodSummaryText: string,
	kanbanCommandPrefix: string,
): string {
	return `# Kanban Relations Of This Task

Kanban records how this task relates to other Kanban work units (task cards and standalone agent sessions): who created it, whose conversation session it forked or resumed, who amended its requirements, which work units it acted on, and which reference relations were asserted about it. Use it to find the context this task came from. This is a snapshot taken when the session started; refresh it with \`${kanbanCommandPrefix} work-unit get-relation-neighborhood-summary\`, and resolve any task id it mentions with \`${kanbanCommandPrefix} task get --task-id <id>\` (works across projects).

${renderedNeighborhoodSummaryText}`;
}

interface InterWorkUnitRelationNeighborhoodReadForSessionStartInjection {
	renderedNeighborhoodSummaryText: string;
	subjectKanbanBoardCard: KanbanBoardCardWorkUnitQualifiedReference;
	// 注入文本里真正列出的断言型关系（默认折叠的只计数，不算进入会话）。
	assertedRelationsListedInInjectedText: AssertedInterWorkUnitRelation[];
}

// 注入回执的待提交内容：解析阶段只备好，会话成功启动之后才提交（见 commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded）。
export interface AssertedRelationInjectionReceiptPendingSuccessfulSessionLaunch {
	workspaceId: string;
	kanbanTaskConversationSessionId: string;
	subjectKanbanBoardCard: KanbanBoardCardWorkUnitQualifiedReference;
	assertedRelationsListedInInjectedText: Array<
		Pick<AssertedInterWorkUnitRelation, "relationId" | "assertedRelationStateVersion">
	>;
}

// 注入回执的确定性幂等键：同一个 Kanban 会话、同一条关系的同一版本只记一次——同一会话重启 / 再次启动注入的
// 还是这一版，就不再追加。关系升版本（合并、撤销……）后再注入是新的一版，照常记。
export function buildIdempotencyKeyOfAssertedRelationInjectionReceipt(input: {
	workspaceId: string;
	kanbanTaskConversationSessionId: string;
	relationId: string;
	assertedRelationStateVersion: number;
}): string {
	return [
		"effective_inter_work_unit_relation_assertion_injected_into_conversation_session",
		input.workspaceId,
		input.kanbanTaskConversationSessionId,
		input.relationId,
		`asserted-relation-state-version-${input.assertedRelationStateVersion}`,
	].join(":");
}

// d-confirm §3.5 注入回执：断言型关系进入会话上下文就留下（会话，时刻，关系 id 与版本）。之后关系被撤销时，
// 2.3 的修订通知据此知道该告诉哪些会话。按条记：每条关系一条事件、各带自己的幂等键，同一会话重启时
// 只跳过已记过的那几条，新进入的照常记。
export function buildAssertedRelationInjectionReceiptEventDrafts(input: {
	assertedRelationInjectionReceipt: AssertedRelationInjectionReceiptPendingSuccessfulSessionLaunch;
	occurredAt: number;
	capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity;
}): InterWorkUnitRelationLedgerEventDraft[] {
	const receipt = input.assertedRelationInjectionReceipt;
	return receipt.assertedRelationsListedInInjectedText.map((relation) => ({
		eventFamily: "inter_work_unit_relation_assertion_lifecycle_event",
		eventKind: "effective_inter_work_unit_relation_assertions_injected_into_conversation_session",
		occurredAt: input.occurredAt,
		actor: {
			kanbanActorKind: "kanban_runtime_system_component",
			kanbanRuntimeSystemComponentName: SESSION_START_RELATION_NEIGHBORHOOD_INJECTOR_SYSTEM_COMPONENT_NAME,
		},
		actorNativeConversationSessionIdentity: null,
		actorKanbanTaskConversationSessionId: null,
		actorRepositoryIdentityAtEventTime: null,
		onBehalfOfInitiatingWorkUnit: null,
		causedBySystemExecutedCause: null,
		recordCaptureChannel: "live_runtime_capture",
		capturingKanbanRuntimeInstance: input.capturingKanbanRuntimeInstance,
		invokingKanbanCliCodeVersion: null,
		occurredAtConversationTurnReference: null,
		idempotencyKey: buildIdempotencyKeyOfAssertedRelationInjectionReceipt({
			workspaceId: receipt.workspaceId,
			kanbanTaskConversationSessionId: receipt.kanbanTaskConversationSessionId,
			relationId: relation.relationId,
			assertedRelationStateVersion: relation.assertedRelationStateVersion,
		}),
		subjectWorkspaceId: receipt.subjectKanbanBoardCard.workspaceId,
		subjectTaskId: receipt.subjectKanbanBoardCard.taskId,
		eventPayload: {
			injectedIntoKanbanTaskConversationSession: {
				workspaceId: receipt.workspaceId,
				kanbanTaskConversationSessionId: receipt.kanbanTaskConversationSessionId,
			},
			injectionSubjectKanbanBoardCard: receipt.subjectKanbanBoardCard,
			assertedRelationInjectionChannel: "session_start_append_system_prompt",
			injectedAssertedRelations: [
				{
					relationId: relation.relationId,
					assertedRelationStateVersion: relation.assertedRelationStateVersion,
				},
			],
		},
	}));
}

// 后台记账：不阻塞、失败只记告警、纳入停用 drain；幂等键已记过的条目由 worker 在同一事务里原子跳过。
// 追加之前不得 await：调用即同步入队，排在调用之后发起的账本读取之前。
function recordAssertedRelationInjectionReceiptWithoutBlocking(
	assertedRelationInjectionReceipt: AssertedRelationInjectionReceiptPendingSuccessfulSessionLaunch,
): void {
	const occurredAt = Date.now();
	startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking({
		backgroundLedgerEventRecordingDescriptionForDiagnostics: `asserted relation injection receipt for ${assertedRelationInjectionReceipt.kanbanTaskConversationSessionId}`,
		recordIntoLedgerOfBoundLiveCapture: async (boundLiveCapture) => {
			await boundLiveCapture.appendCommittedEventsSkippingDraftsWhoseIdempotencyKeyIsAlreadyRecordedIntoLedgerOfBoundLiveCapture(
				{
					eventDrafts: buildAssertedRelationInjectionReceiptEventDrafts({
						assertedRelationInjectionReceipt,
						occurredAt,
						capturingKanbanRuntimeInstance: boundLiveCapture.capturingKanbanRuntimeInstance,
					}),
				},
			);
		},
	});
}

export interface InterWorkUnitRelationNeighborhoodSessionStartInjection {
	interWorkUnitRelationNeighborhoodAppendSystemPromptText: string;
	// 解析阶段**绝不**记注入回执：此刻 adapter 还没准备、PTY 也还没 spawn，注入可能根本不会发生。只有在会话成功启动、
	// 且这段文本确实进了本次启动（system prompt 追加或拼进首条 prompt）之后才调用（prepareAgentLaunch 判断是否用上，
	// session-manager 在装载新会话之后调用）。文本里没有列出断言型关系 ⇒ null（没有回执可记）。不阻塞、绝不抛错。
	commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded: (() => void) | null;
}

export async function resolveInterWorkUnitRelationNeighborhoodSessionStartInjection(input: {
	workspaceId: string | undefined;
	taskId: string;
}): Promise<InterWorkUnitRelationNeighborhoodSessionStartInjection | null> {
	const workspaceId = input.workspaceId;
	if (!workspaceId || isHomeAgentSessionId(input.taskId)) {
		return null;
	}
	const neighborhoodRead: Promise<InterWorkUnitRelationNeighborhoodReadForSessionStartInjection | null> =
		readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture(async (reader) => {
			// by-the-way 会话的 taskId 是会话 id 而不是卡 id，认不出卡就不注入。
			const cardProjection = findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId(
				reader.projectionState.kanbanBoardCardIdentityProjectionState,
				workspaceId,
				input.taskId,
			);
			if (!cardProjection) {
				return null;
			}
			const neighborhood = await assembleRecordedRelationNeighborhoodSummaryOfWorkUnit(
				reader,
				cardProjection.kanbanBoardCard,
				() => null,
			);
			return neighborhood.hasAnyRelationVisibleByDefault
				? {
						renderedNeighborhoodSummaryText: neighborhood.renderedNeighborhoodSummaryText,
						subjectKanbanBoardCard: cardProjection.kanbanBoardCard,
						assertedRelationsListedInInjectedText: neighborhood.assertedRelations.filter(
							(relation) =>
								isAssertedInterWorkUnitReferenceRelationKind(relation.relationKind) &&
								ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relation.relationKind]
									.defaultVisibleInNeighborhoodSummary,
						),
					}
				: null;
		}).catch(() => null);
	let readTimeout: ReturnType<typeof setTimeout> | undefined;
	const readTimedOut = new Promise<null>((resolve) => {
		readTimeout = setTimeout(() => resolve(null), NEIGHBORHOOD_SUMMARY_READ_TIMEOUT_MS_AT_SESSION_START);
	});
	try {
		const neighborhoodForInjection = await Promise.race([neighborhoodRead, readTimedOut]);
		if (!neighborhoodForInjection) {
			return null;
		}
		const assertedRelationInjectionReceipt: AssertedRelationInjectionReceiptPendingSuccessfulSessionLaunch = {
			workspaceId,
			kanbanTaskConversationSessionId: input.taskId,
			subjectKanbanBoardCard: neighborhoodForInjection.subjectKanbanBoardCard,
			assertedRelationsListedInInjectedText: neighborhoodForInjection.assertedRelationsListedInInjectedText,
		};
		return {
			interWorkUnitRelationNeighborhoodAppendSystemPromptText:
				renderInterWorkUnitRelationNeighborhoodAppendSystemPrompt(
					neighborhoodForInjection.renderedNeighborhoodSummaryText,
					resolveAppendSystemPromptCommandPrefix(),
				),
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded:
				assertedRelationInjectionReceipt.assertedRelationsListedInInjectedText.length > 0
					? () => recordAssertedRelationInjectionReceiptWithoutBlocking(assertedRelationInjectionReceipt)
					: null,
		};
	} finally {
		clearTimeout(readTimeout);
	}
}
