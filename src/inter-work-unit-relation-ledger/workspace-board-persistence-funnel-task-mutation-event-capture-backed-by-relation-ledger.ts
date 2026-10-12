import { randomUUID } from "node:crypto";

import packageJson from "../../package.json" with { type: "json" };
import {
	type RuntimeAgentNativeConversationSessionIdentity,
	type RuntimeBoardData,
	type RuntimeTaskSessionSummary,
	runtimeBoardDataSchema,
} from "../core/api-contract";
import type {
	CapturingKanbanRuntimeInstanceIdentity,
	InterWorkUnitRelationLedgerEventDraft,
	KanbanActor,
	TaskMutationOccurrenceCaptureMode,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { createShortTaskId } from "../core/task-id";
import type {
	TaskMutationIntentWithResolvedActor,
	WorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
} from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import type {
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	PendingBoardFileWriteTaskMutationEventBatchResolution,
	TaskCardIdentityForGlobalTaskIdentityRegistry,
} from "./inter-work-unit-relation-ledger-database-worker-client";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";
import { resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations } from "./web-ui-board-mutation-initiator-annotation-pairing-with-board-diff-occurrences";
import {
	type BoardDerivedTaskMutationOccurrence,
	buildWorkspaceBoardSnapshotWithRetainedFieldContents,
	collectRetainedFieldContentsReferencedByOccurrences,
	diffWorkspaceBoardSnapshotsIntoTaskMutationOccurrences,
	type WorkspaceBoardSnapshotForTaskMutationDiff,
} from "./workspace-board-task-mutation-occurrence-diff";

const KANBAN_RUNTIME_CODE_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
const TASK_MUTATION_CAPTURE_SYSTEM_COMPONENT_NAME = "inter_work_unit_relation_ledger_task_mutation_capture";
// 5 位十六进制 id 空间约 105 万；登记簿千级时一批 16 个候选全撞的概率可以忽略，4 批是保险。
const TASK_ID_ALLOCATION_CANDIDATES_PER_BATCH = 16;
const TASK_ID_ALLOCATION_MAXIMUM_CANDIDATE_BATCHES = 4;

function collectTaskCardIdentitiesOfCreatedTaskCards(
	occurrences: BoardDerivedTaskMutationOccurrence[],
): TaskCardIdentityForGlobalTaskIdentityRegistry[] {
	return occurrences.flatMap((occurrence) =>
		occurrence.eventKind === "task_card_created_on_board" && occurrence.taskIncarnationCreatedAtEpochMs !== null
			? [{ taskId: occurrence.taskId, taskIncarnationCreatedAtEpochMs: occurrence.taskIncarnationCreatedAtEpochMs }]
			: [],
	);
}

// J2（Y-BACKFILL-6 第 1 步）：旧 link 机制在 1a 退役，schema 读盘时静默剥掉 `dependencies`。激活基线那一刻
// 从 board.json 原文里把残留的每条边读出来，记成族 3 事实；阶段 2 再投影成泛相关参照，阶段 3 一键升级为门。
// 只在基线时读：基线之后 runtime 的第一次写盘就会把这个键从盘上去掉。
function readLegacyBoardDependenciesRemainingInPersistedBoardFileRawText(
	persistedBoardFileRawText: string | null,
): Array<Record<string, unknown>> {
	if (persistedBoardFileRawText === null) {
		return [];
	}
	try {
		const rawBoard = JSON.parse(persistedBoardFileRawText) as { dependencies?: unknown };
		return Array.isArray(rawBoard.dependencies)
			? rawBoard.dependencies.filter(
					(dependency): dependency is Record<string, unknown> =>
						typeof dependency === "object" && dependency !== null,
				)
			: [];
	} catch {
		return [];
	}
}

// 卡片主会话（会话 id = taskId）在激活时刻最后一次落盘的 summary。facet 经 resolveSessionFacets 读，legacy state 只作附带记录。
function describeMainConversationSessionLastPersistedSummaryAtBaseline(
	mainConversationSessionSummary: RuntimeTaskSessionSummary | undefined,
): Record<string, unknown> | null {
	if (!mainConversationSessionSummary) {
		return null;
	}
	const facets = resolveSessionFacets(mainConversationSessionSummary);
	return {
		legacyProjectedSessionState: mainConversationSessionSummary.state,
		liveness: facets.liveness,
		turnOwner: facets.turnOwner,
		userTurnKind: facets.userTurnKind,
		agentId: mainConversationSessionSummary.agentId ?? null,
		summaryUpdatedAt: mainConversationSessionSummary.updatedAt ?? null,
	};
}

// 两条记账路径（漏斗内 sessions 变化、只写 sessions 的身份落盘）共用的「新身份」判据：只看 harness 与原生会话 id。
// observedAt 前移是同一身份的再次确认（时间水位），transcriptPath 变化也不换会话，二者都不是新身份。
function isNewNativeConversationSessionIdentityForKanbanTaskConversationSession(
	previouslyPersistedIdentity: RuntimeAgentNativeConversationSessionIdentity | null | undefined,
	nextIdentity: RuntimeAgentNativeConversationSessionIdentity,
): boolean {
	return (
		previouslyPersistedIdentity?.sourceAgentId !== nextIdentity.sourceAgentId ||
		previouslyPersistedIdentity.nativeSessionId !== nextIdentity.nativeSessionId
	);
}

export function createCapturingKanbanRuntimeInstanceIdentity(): CapturingKanbanRuntimeInstanceIdentity {
	return {
		kanbanRuntimeInstanceId: randomUUID(),
		kanbanRuntimeProcessId: process.pid,
		kanbanRuntimeCodeVersion: KANBAN_RUNTIME_CODE_VERSION,
	};
}

const EMPTY_WORKSPACE_BOARD_SNAPSHOT: WorkspaceBoardSnapshotForTaskMutationDiff = {
	taskCardSnapshotEntriesByTaskId: {},
};

// 漏斗外检出的变更：不知道是谁、也不知道确切何时（occurredAt 取检出时刻，payload 里明示）。
const ACTOR_FOR_BOARD_CHANGE_DETECTED_OUTSIDE_RUNTIME_PERSISTENCE_FUNNEL: KanbanActor = {
	kanbanActorKind: "unresolved_actor",
	unresolvedActorReason: "board_change_detected_outside_runtime_persistence_funnel",
};

// 漏斗写入的 board 是内存对象；检出时比较的是盘上读回并经 schema 解析的对象。两边都按「读回形状」取快照，
// 避免 schema transform 的细微差别被误报成字段变更。
function normalizeBoardToPersistedReadBackShape(board: RuntimeBoardData): RuntimeBoardData {
	return runtimeBoardDataSchema.parse(JSON.parse(JSON.stringify(board)));
}

export function createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger(input: {
	ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
	capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity;
	now?: () => number;
}): WorkspaceBoardPersistenceFunnelTaskMutationEventCapture {
	const { ledgerClient, capturingKanbanRuntimeInstance } = input;
	const now = input.now ?? Date.now;

	function buildEventDraft(options: {
		eventFamily: InterWorkUnitRelationLedgerEventDraft["eventFamily"];
		eventKind: string;
		occurredAt: number;
		actor: KanbanActor;
		intent: TaskMutationIntentWithResolvedActor | null;
		idempotencyKey: string | null;
		subjectWorkspaceId: string;
		subjectTaskId: string | null;
		eventPayload: Record<string, unknown>;
	}): InterWorkUnitRelationLedgerEventDraft {
		const { intent } = options;
		return {
			eventFamily: options.eventFamily,
			eventKind: options.eventKind,
			occurredAt: options.occurredAt,
			actor: options.actor,
			actorNativeConversationSessionIdentity: intent?.actorNativeConversationSessionIdentity ?? null,
			actorKanbanTaskConversationSessionId: intent?.actorKanbanTaskConversationSessionId ?? null,
			actorRepositoryIdentityAtEventTime: intent?.actorRepositoryIdentityAtEventTime ?? null,
			onBehalfOfInitiatingWorkUnit: intent?.onBehalfOfInitiatingWorkUnit ?? null,
			causedBySystemExecutedCause: intent?.causedBySystemExecutedCause ?? null,
			recordCaptureChannel: "live_runtime_capture",
			capturingKanbanRuntimeInstance,
			invokingKanbanCliCodeVersion: intent?.invokingKanbanCliCodeVersion ?? null,
			occurredAtConversationTurnReference: intent?.occurredAtConversationTurnReference ?? null,
			idempotencyKey: options.idempotencyKey,
			subjectWorkspaceId: options.subjectWorkspaceId,
			subjectTaskId: options.subjectTaskId,
			eventPayload: options.eventPayload,
		};
	}

	function buildTaskMutationEventDrafts(options: {
		workspaceId: string;
		occurrences: BoardDerivedTaskMutationOccurrence[];
		taskMutationOccurrenceCaptureMode: TaskMutationOccurrenceCaptureMode;
		intent: TaskMutationIntentWithResolvedActor | null;
		boardRevisionAfterMutation: number;
		occurredAt: number;
	}): InterWorkUnitRelationLedgerEventDraft[] {
		const requestLevelResolvedKanbanActor =
			options.intent?.resolvedKanbanActor ?? ACTOR_FOR_BOARD_CHANGE_DETECTED_OUTSIDE_RUNTIME_PERSISTENCE_FUNNEL;
		return options.occurrences.map((occurrence, occurrenceIndex) => {
			const { actor, pairedWebUiBoardMutationInitiator } =
				resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations({
					requestLevelResolvedKanbanActor,
					occurrence,
					webUiBoardMutationInitiatorAnnotations:
						options.intent?.webUiBoardMutationInitiatorAnnotationsForTaskMutationEventCapture ?? [],
				});
			return buildEventDraft({
				eventFamily: "task_mutation_event",
				eventKind: occurrence.eventKind,
				occurredAt: options.occurredAt,
				actor,
				intent: options.intent,
				idempotencyKey: options.intent?.idempotencyKey
					? `${options.intent.idempotencyKey}#board-derived-occurrence-${occurrenceIndex}`
					: null,
				subjectWorkspaceId: options.workspaceId,
				subjectTaskId: occurrence.taskId,
				eventPayload: {
					subjectKanbanBoardCard:
						occurrence.taskIncarnationCreatedAtEpochMs === null
							? null
							: {
									workUnitType: "kanban_board_card",
									workspaceId: options.workspaceId,
									taskId: occurrence.taskId,
									taskIncarnationCreatedAtEpochMs: occurrence.taskIncarnationCreatedAtEpochMs,
								},
					taskMutationOccurrenceCaptureMode: options.taskMutationOccurrenceCaptureMode,
					taskMutationIntentKind: options.intent?.taskMutationIntentKind ?? null,
					boardRevisionAfterMutation: options.boardRevisionAfterMutation,
					occurredAtIsDetectionTimeNotActualOccurrenceTime:
						options.taskMutationOccurrenceCaptureMode ===
						"detected_by_board_diff_outside_runtime_persistence_funnel",
					pairedWebUiBoardMutationInitiator,
					...occurrence.eventPayloadSpecificToEventKind,
				},
			});
		});
	}

	// 族 2：原生会话身份 sidecar 的读取 / 变化。会话身份键 = {宿主 agentId, 原生 id}（Y-EVENT-11）。
	function buildAgentConversationSessionNativeIdentityEventDraft(options: {
		eventKind: string;
		workspaceId: string;
		kanbanTaskConversationSessionId: string;
		sessionSummary: RuntimeTaskSessionSummary;
		intent: TaskMutationIntentWithResolvedActor | null;
		occurredAt: number;
	}): InterWorkUnitRelationLedgerEventDraft | null {
		const identity = options.sessionSummary.agentNativeConversationSessionIdentity;
		if (!identity) {
			return null;
		}
		return buildEventDraft({
			eventFamily: "agent_conversation_session_identity_event",
			eventKind: options.eventKind,
			occurredAt: options.occurredAt,
			actor: {
				kanbanActorKind: "kanban_runtime_system_component",
				kanbanRuntimeSystemComponentName: TASK_MUTATION_CAPTURE_SYSTEM_COMPONENT_NAME,
			},
			intent: options.intent,
			idempotencyKey: null,
			subjectWorkspaceId: options.workspaceId,
			subjectTaskId: options.kanbanTaskConversationSessionId,
			eventPayload: {
				kanbanTaskConversationSessionId: options.kanbanTaskConversationSessionId,
				sessionSummaryAgentId: options.sessionSummary.agentId,
				conversationSessionIdentityKey: {
					conversationSessionHostKanbanAgentId: identity.sourceAgentId,
					nativeConversationSessionId: identity.nativeSessionId,
				},
				agentNativeConversationSessionIdentityObservedAt: identity.observedAt,
				agentNativeConversationSessionTranscriptPath: identity.transcriptPath,
				taskConversationSessionMetadata: options.sessionSummary.taskConversationSessionMetadata ?? null,
			},
		});
	}

	function buildNativeIdentityChangeEventDrafts(options: {
		workspaceId: string;
		previousSessions: Record<string, RuntimeTaskSessionSummary>;
		nextSessions: Record<string, RuntimeTaskSessionSummary>;
		intent: TaskMutationIntentWithResolvedActor;
		occurredAt: number;
	}): InterWorkUnitRelationLedgerEventDraft[] {
		const drafts: InterWorkUnitRelationLedgerEventDraft[] = [];
		for (const [kanbanTaskConversationSessionId, nextSummary] of Object.entries(options.nextSessions)) {
			const nextIdentity = nextSummary.agentNativeConversationSessionIdentity;
			const previousIdentity =
				options.previousSessions[kanbanTaskConversationSessionId]?.agentNativeConversationSessionIdentity;
			if (
				!nextIdentity ||
				!isNewNativeConversationSessionIdentityForKanbanTaskConversationSession(previousIdentity, nextIdentity)
			) {
				continue;
			}
			const draft = buildAgentConversationSessionNativeIdentityEventDraft({
				eventKind: "new_native_conversation_session_identity_observed_for_kanban_task_conversation_session",
				workspaceId: options.workspaceId,
				kanbanTaskConversationSessionId,
				sessionSummary: nextSummary,
				intent: options.intent,
				occurredAt: options.occurredAt,
			});
			if (draft) drafts.push(draft);
		}
		return drafts;
	}

	// 激活基线时一次性读取既有 sidecar（Y-EVENT-13）：只对激活时刻及以后的归属解析生效。
	function buildSidecarSeedingEventDraftsAtLiveCaptureActivation(options: {
		workspaceId: string;
		persistedBoard: RuntimeBoardData;
		persistedSessions: Record<string, RuntimeTaskSessionSummary>;
		occurredAt: number;
	}): InterWorkUnitRelationLedgerEventDraft[] {
		const drafts: InterWorkUnitRelationLedgerEventDraft[] = [];
		for (const [kanbanTaskConversationSessionId, sessionSummary] of Object.entries(options.persistedSessions)) {
			const draft = buildAgentConversationSessionNativeIdentityEventDraft({
				eventKind: "persisted_session_native_identity_sidecar_read_at_live_capture_activation",
				workspaceId: options.workspaceId,
				kanbanTaskConversationSessionId,
				sessionSummary,
				intent: null,
				occurredAt: options.occurredAt,
			});
			if (draft) drafts.push(draft);
		}
		for (const column of options.persistedBoard.columns) {
			for (const card of column.cards) {
				if (!card.taskAgentSessionInitialization) continue;
				drafts.push(
					buildEventDraft({
						eventFamily: "agent_conversation_session_identity_event",
						eventKind: "persisted_card_agent_session_initialization_sidecar_read_at_live_capture_activation",
						occurredAt: options.occurredAt,
						actor: {
							kanbanActorKind: "kanban_runtime_system_component",
							kanbanRuntimeSystemComponentName: TASK_MUTATION_CAPTURE_SYSTEM_COMPONENT_NAME,
						},
						intent: null,
						idempotencyKey: null,
						subjectWorkspaceId: options.workspaceId,
						subjectTaskId: card.id,
						eventPayload: {
							subjectKanbanBoardCard: {
								workUnitType: "kanban_board_card",
								workspaceId: options.workspaceId,
								taskId: card.id,
								taskIncarnationCreatedAtEpochMs: card.createdAt,
							},
							taskAgentSessionInitialization: card.taskAgentSessionInitialization,
							sourceConversationSessionIdentityKey: {
								conversationSessionHostKanbanAgentId: card.taskAgentSessionInitialization.sourceAgentId,
								nativeConversationSessionId: card.taskAgentSessionInitialization.sourceSessionId,
							},
						},
					}),
				);
			}
		}
		return drafts;
	}

	return {
		async reconcileLedgerWithPersistedBoardWithinBoardLock(reconcileInput) {
			const captureState = await ledgerClient.readWorkspaceTaskMutationCaptureState(
				reconcileInput.workspaceId,
				reconcileInput.persistedBoardFileSha256,
			);
			if (captureState.lastCommittedSnapshotMatchesPersistedBoardFileWithoutPendingBatches) {
				return;
			}
			const lastCommittedSnapshot = captureState.lastCommittedSnapshot;
			const occurredAt = now();
			const current = buildWorkspaceBoardSnapshotWithRetainedFieldContents(reconcileInput.persistedBoard);
			const currentSnapshot = {
				boardFileSha256: reconcileInput.persistedBoardFileSha256,
				boardRevision: reconcileInput.persistedBoardRevision,
				workspaceBoardSnapshot: current.snapshot,
			};

			if (lastCommittedSnapshot === null && captureState.pendingBatches.length === 0) {
				// 激活基线（Y-EVENT-4 族 3）：首次见到该 workspace 时记录整板现状，而不是给每张存量卡补发「创建」事件。
				await ledgerClient.resolvePendingBatchesAndRecordDetectedEvents({
					workspaceId: reconcileInput.workspaceId,
					pendingBatchResolutions: [],
					detectedEventDrafts: [
						buildEventDraft({
							eventFamily: "fact_observed_by_kanban_runtime_event",
							eventKind: "board_state_baseline_observed_at_live_task_mutation_capture_activation",
							occurredAt,
							actor: {
								kanbanActorKind: "kanban_runtime_system_component",
								kanbanRuntimeSystemComponentName: TASK_MUTATION_CAPTURE_SYSTEM_COMPONENT_NAME,
							},
							intent: null,
							idempotencyKey: null,
							subjectWorkspaceId: reconcileInput.workspaceId,
							subjectTaskId: null,
							eventPayload: {
								observedFactKind: "board_state_baseline_observed_at_live_task_mutation_capture_activation",
								workspaceRepositoryPath: reconcileInput.workspaceRepositoryPath,
								boardRevisionAtBaseline: reconcileInput.persistedBoardRevision,
								boardFileSha256AtBaseline: reconcileInput.persistedBoardFileSha256,
								baselineTaskCards: Object.values(current.snapshot.taskCardSnapshotEntriesByTaskId).map(
									(entry) => ({
										kanbanBoardCard: {
											workUnitType: "kanban_board_card",
											workspaceId: reconcileInput.workspaceId,
											taskId: entry.taskId,
											taskIncarnationCreatedAtEpochMs: entry.taskIncarnationCreatedAtEpochMs,
										},
										boardColumnId: entry.boardColumnId,
										fieldValueSha256ByFieldName: entry.fieldValueSha256ByFieldName,
										// Y-BACKFILL-3：4a 据此把「激活时在 Done 且会话被中断」的存量卡推导为 open。
										mainConversationSessionLastPersistedSummaryAtBaseline:
											describeMainConversationSessionLastPersistedSummaryAtBaseline(
												reconcileInput.persistedSessions[entry.taskId],
											),
									}),
								),
							},
						}),
						...readLegacyBoardDependenciesRemainingInPersistedBoardFileRawText(
							reconcileInput.persistedBoardFileRawText,
						).map((legacyBoardDependency, legacyBoardDependencyIndex) =>
							buildEventDraft({
								eventFamily: "fact_observed_by_kanban_runtime_event",
								eventKind: "legacy_board_dependency_observed_at_retirement",
								occurredAt,
								actor: {
									kanbanActorKind: "kanban_runtime_system_component",
									kanbanRuntimeSystemComponentName: TASK_MUTATION_CAPTURE_SYSTEM_COMPONENT_NAME,
								},
								intent: null,
								idempotencyKey: `legacy-board-dependency-retirement:${reconcileInput.workspaceId}:${
									typeof legacyBoardDependency.id === "string"
										? legacyBoardDependency.id
										: `index-${legacyBoardDependencyIndex}`
								}`,
								subjectWorkspaceId: reconcileInput.workspaceId,
								subjectTaskId: null,
								eventPayload: {
									observedFactKind: "legacy_board_dependency_observed_at_retirement",
									legacyBoardDependencyAsPersistedBeforeRetirement: legacyBoardDependency,
								},
							}),
						),
						...buildSidecarSeedingEventDraftsAtLiveCaptureActivation({
							workspaceId: reconcileInput.workspaceId,
							persistedBoard: reconcileInput.persistedBoard,
							persistedSessions: reconcileInput.persistedSessions,
							occurredAt,
						}),
					],
					retainedFieldContents: [...current.retainedFieldContentsBySha256.values()],
					currentSnapshot,
					// 基线里的每张卡（含 trash 列）都占住自己的 id（Y-EVENT-12 的 id 保留播种）。
					observedTaskCardIdentities: Object.values(current.snapshot.taskCardSnapshotEntriesByTaskId).map(
						(entry) => ({
							taskId: entry.taskId,
							taskIncarnationCreatedAtEpochMs: entry.taskIncarnationCreatedAtEpochMs,
						}),
					),
				});
				return;
			}

			let snapshotAfterResolvedPendingBatches =
				lastCommittedSnapshot?.workspaceBoardSnapshot ?? EMPTY_WORKSPACE_BOARD_SNAPSHOT;
			// 悬挂批次按盘上 board 的字节哈希结算。不以 revision 为判据：只写 sessions 的漏斗会在批次之后单独推进
			// revision，按 revision 比会把已经落盘的变更误判为 abandoned。
			const pendingBatchResolutions: PendingBoardFileWriteTaskMutationEventBatchResolution[] =
				captureState.pendingBatches.map((pendingBatch) => {
					if (pendingBatch.expectedBoardFileSha256AfterWrite === reconcileInput.persistedBoardFileSha256) {
						snapshotAfterResolvedPendingBatches = pendingBatch.nextWorkspaceBoardSnapshot;
						return { pendingBatchId: pendingBatch.pendingBatchId, pendingBatchResolution: "commit" };
					}
					return { pendingBatchId: pendingBatch.pendingBatchId, pendingBatchResolution: "abandon" };
				});
			const detectedOccurrences = diffWorkspaceBoardSnapshotsIntoTaskMutationOccurrences(
				snapshotAfterResolvedPendingBatches,
				current.snapshot,
			);
			await ledgerClient.resolvePendingBatchesAndRecordDetectedEvents({
				workspaceId: reconcileInput.workspaceId,
				pendingBatchResolutions,
				detectedEventDrafts: buildTaskMutationEventDrafts({
					workspaceId: reconcileInput.workspaceId,
					occurrences: detectedOccurrences,
					taskMutationOccurrenceCaptureMode: "detected_by_board_diff_outside_runtime_persistence_funnel",
					intent: null,
					boardRevisionAfterMutation: reconcileInput.persistedBoardRevision,
					occurredAt,
				}),
				retainedFieldContents: collectRetainedFieldContentsReferencedByOccurrences(
					detectedOccurrences,
					current.retainedFieldContentsBySha256,
				),
				currentSnapshot,
				observedTaskCardIdentities: collectTaskCardIdentitiesOfCreatedTaskCards(detectedOccurrences),
			});
		},

		async recordPendingTaskMutationEventsBeforeBoardFileWrite(recordInput) {
			const previous = buildWorkspaceBoardSnapshotWithRetainedFieldContents(recordInput.previousBoard);
			const next = buildWorkspaceBoardSnapshotWithRetainedFieldContents(
				normalizeBoardToPersistedReadBackShape(recordInput.nextBoard),
			);
			const occurrences = diffWorkspaceBoardSnapshotsIntoTaskMutationOccurrences(previous.snapshot, next.snapshot);
			const occurredAt = now();
			const nativeIdentityChangeEventDrafts = buildNativeIdentityChangeEventDrafts({
				workspaceId: recordInput.workspaceId,
				previousSessions: recordInput.previousSessions,
				nextSessions: recordInput.nextSessions,
				intent: recordInput.taskMutationIntentWithResolvedActor,
				occurredAt,
			});
			if (occurrences.length === 0) {
				// board 没变：没有 board 哈希可供两阶段结算。身份变化是 runtime 已在内存里观测到的事实，直接提交。
				if (nativeIdentityChangeEventDrafts.length > 0) {
					await ledgerClient.appendCommittedEvents({ eventDrafts: nativeIdentityChangeEventDrafts });
				}
				return null;
			}
			const retainedFieldContentsBySha256 = new Map([
				...previous.retainedFieldContentsBySha256,
				...next.retainedFieldContentsBySha256,
			]);
			const pendingBatchId = randomUUID();
			await ledgerClient.recordPendingTaskMutationEventBatch({
				workspaceId: recordInput.workspaceId,
				pendingBatchId,
				expectedBoardFileSha256AfterWrite: recordInput.nextBoardFileSha256,
				expectedBoardRevisionAfterWrite: recordInput.nextBoardRevision,
				nextWorkspaceBoardSnapshot: next.snapshot,
				eventDrafts: buildTaskMutationEventDrafts({
					workspaceId: recordInput.workspaceId,
					occurrences,
					taskMutationOccurrenceCaptureMode: "captured_within_runtime_persistence_funnel",
					intent: recordInput.taskMutationIntentWithResolvedActor,
					boardRevisionAfterMutation: recordInput.nextBoardRevision,
					occurredAt,
				}).concat(nativeIdentityChangeEventDrafts),
				retainedFieldContents: collectRetainedFieldContentsReferencedByOccurrences(
					occurrences,
					retainedFieldContentsBySha256,
				),
				createdTaskCardIdentities: collectTaskCardIdentitiesOfCreatedTaskCards(occurrences),
			});
			return { pendingBatchId };
		},

		async commitPendingTaskMutationEventsAfterBoardFileWrite(commitInput) {
			// 三个 JSON 已经写完，board 变更已成事实：提交失败不能让调用方以为写入失败。
			// 批次保持 pending，下一次漏斗通过时按盘上哈希结算。
			try {
				await ledgerClient.commitPendingTaskMutationEventBatch(commitInput);
			} catch (error) {
				logInterWorkUnitRelationLedgerDiagnosticWarning(
					`commit of pending task mutation event batch ${commitInput.pendingBatchId} failed; it will be resolved on the next persistence funnel pass: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		async allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry(allocationInput) {
			for (let attempt = 0; attempt < TASK_ID_ALLOCATION_MAXIMUM_CANDIDATE_BATCHES; attempt += 1) {
				const candidateTaskIds = Array.from({ length: TASK_ID_ALLOCATION_CANDIDATES_PER_BATCH }, () =>
					createShortTaskId(randomUUID),
				);
				const allocatedTaskId = await ledgerClient.allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry({
					candidateTaskIds,
					requestingWorkspaceId: allocationInput.requestingWorkspaceId,
				});
				if (allocatedTaskId !== null) {
					return allocatedTaskId;
				}
			}
			throw new Error("Could not allocate a task id that is unique against the global task identity registry.");
		},

		recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking(recordInput) {
			const nextIdentity = recordInput.sessionSummary.agentNativeConversationSessionIdentity;
			if (
				!nextIdentity ||
				!isNewNativeConversationSessionIdentityForKanbanTaskConversationSession(
					recordInput.previouslyPersistedAgentNativeConversationSessionIdentity,
					nextIdentity,
				)
			) {
				return;
			}
			const draft = buildAgentConversationSessionNativeIdentityEventDraft({
				eventKind: "new_native_conversation_session_identity_observed_for_kanban_task_conversation_session",
				workspaceId: recordInput.workspaceId,
				kanbanTaskConversationSessionId: recordInput.kanbanTaskConversationSessionId,
				sessionSummary: recordInput.sessionSummary,
				intent: null,
				occurredAt: now(),
			});
			if (!draft) {
				return;
			}
			void ledgerClient.appendCommittedEvents({ eventDrafts: [draft] }).catch((error: unknown) => {
				logInterWorkUnitRelationLedgerDiagnosticWarning(
					`could not record native conversation session identity observation: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		},
	};
}
