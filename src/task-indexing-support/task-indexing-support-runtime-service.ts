import { randomUUID } from "node:crypto";
import type { RuntimeConfigState } from "../config/runtime-config";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../core/api-contract";
import { runtimeAgentIdSchema } from "../core/api-contract";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "../core/inter-work-unit-relation-ledger-event-contract";
import { addTaskToColumn } from "../core/task-board-mutations";
import { resolveTaskCreateBaseRef } from "../core/task-create-base-ref-resolution";
import type {
	AppendTaskCommentRequest,
	IncomingWorkItem,
	TaskIndexingSupportExecutorSettings,
} from "../core/task-indexing-support-contract";
import { incomingWorkItemSchema } from "../core/task-indexing-support-contract";
import {
	type ReferenceRelationModelingSuggestionsRequest,
	referenceRelationModelingDraftSchema,
} from "../core/work-unit-relation-modeling-api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable,
	buildTaskMutationIntentForKanbanRuntimeSystemComponent,
} from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import type { RuntimeTaskIndexingSupportReferenceAssertionWritePort } from "../trpc/work-unit-relation-assertion-write-api";
import { appendTaskCommentThroughRuntimeBoardMutation } from "./append-task-comment-to-latest-task-card";
import { collectTaskIndexingMaterials } from "./collect-task-indexing-materials";
import { analyzeIncomingWorkItemRelations } from "./incoming-work-item-relation-analysis";
import {
	listDurableIncomingWorkItemTriageOperations,
	triageIncomingWorkItemWithDurableOperation,
} from "./incoming-work-item-triage-operation";
import { taskIndexingTextFingerprint } from "./shared-task-indexing-context";
import {
	loadAndAdvanceSharedTaskIndexingContext,
	readTaskIndexingSupportExecutorSettings,
	readTaskIndexingSupportJsonFile,
	saveTaskIndexingSupportExecutorSettings,
	taskIndexingSupportWorkspaceStoragePath,
} from "./task-indexing-support-storage";

const SUPPORT_COMPONENT_NAME = "task_indexing_support_relation_triage";
export interface TaskIndexingSupportRuntimeDependencies {
	listLiveSessionSummaries: (workspaceId: string) => readonly RuntimeTaskSessionSummary[];
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	broadcastState: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	referenceAssertionWritePort: RuntimeTaskIndexingSupportReferenceAssertionWritePort;
}

export function isUntriagedRvfFindingTask(task: { title?: string; prompt: string }): boolean {
	const lines = task.prompt.split(/\r?\n/u);
	return (
		(task.title ?? "").startsWith("[RVF 发现]") &&
		lines[0] === "KANBAN_TASK_ORIGIN=rvf_validated_out_of_scope_finding" &&
		lines[1] === "KANBAN_SUPPORT_AGENT_RELATION_TRIAGE_STATUS=not_triaged"
	);
}

export function createTaskIndexingSupportRuntimeService(deps: TaskIndexingSupportRuntimeDependencies) {
	const lifetime = new AbortController();
	const backgroundRuns = new Map<string, Promise<void>>();
	let automaticBackfillTimer: ReturnType<typeof setTimeout> | null = null;
	let automaticBackfillRun: Promise<void> | null = null;
	const collect = (workspaceId: string, includeRecapSources = true) =>
		collectTaskIndexingMaterials({
			workspaceId,
			includeRecapSources,
			listLiveSessionSummaries: deps.listLiveSessionSummaries,
		});
	const systemIntent = (kind: string) =>
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(kind, SUPPORT_COMPONENT_NAME);
	const appendRelatedFinding = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: {
			taskReference: KanbanBoardCardWorkUnitQualifiedReference;
			commentId: string;
			text: string;
			expectedRequirementsFingerprint?: string;
		},
	) => {
		if (input.taskReference.workspaceId !== scope.workspaceId) throw new Error("分诊不向跨项目任务追加发现。");
		await appendTaskCommentThroughRuntimeBoardMutation({
			scope,
			request: {
				taskId: input.taskReference.taskId,
				taskIncarnationCreatedAtEpochMs: input.taskReference.taskIncarnationCreatedAtEpochMs,
				taskCommentEntryId: input.commentId,
				commentText: input.text,
			},
			intent: systemIntent("task_indexing_support_related_finding_comment_appended"),
			expectedRequirementsFingerprint: input.expectedRequirementsFingerprint,
			broadcastState: deps.broadcastState,
		});
	};
	const triageIncomingWorkItem = async (scope: RuntimeTrpcWorkspaceScope, rawItem: IncomingWorkItem) => {
		const item = incomingWorkItemSchema.parse(rawItem);
		return await triageIncomingWorkItemWithDurableOperation({
			workspaceId: scope.workspaceId,
			item,
			operationDirectoryPath: taskIndexingSupportWorkspaceStoragePath(
				scope.workspaceId,
				"incoming-work-item-triage-operations",
			),
			effects: {
				allocateTaskIdentity: async () => {
					const id = await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
						requestingWorkspaceId: scope.workspaceId,
					});
					if (!id) throw new Error("分诊只能在已激活身份登记簿的 runtime 内建卡。");
					return {
						workUnitType: "kanban_board_card",
						workspaceId: scope.workspaceId,
						taskId: id,
						taskIncarnationCreatedAtEpochMs: Date.now(),
					};
				},
				readCurrentMaterials: async () => (await collect(scope.workspaceId, false)).materials,
				analyze: async (materials) => {
					if (
						item.existing_finding_task &&
						!materials.some(
							(material) =>
								JSON.stringify(material.taskReference) === JSON.stringify(item.existing_finding_task),
						)
					)
						throw new Error("补查发现卡身份不存在，未采用旧请求。");
					const collected = await collect(scope.workspaceId);
					return (
						await analyzeIncomingWorkItemRelations({
							workspaceId: scope.workspaceId,
							item,
							...collected,
							settings: await readTaskIndexingSupportExecutorSettings(scope.workspaceId),
							abortSignal: lifetime.signal,
						})
					).analysis;
				},
				createBacklogTask: async ({ taskReference }) => {
					const config = await deps.loadScopedRuntimeConfig(scope);
					const result = await mutateWorkspaceState(
						scope.workspacePath,
						systemIntent("task_indexing_support_incoming_work_item_backlog_task_created"),
						(state) => {
							const existing = state.board.columns
								.flatMap((column) => column.cards)
								.find((card) => card.id === taskReference.taskId);
							if (existing) {
								if (existing.createdAt !== taskReference.taskIncarnationCreatedAtEpochMs)
									throw new Error("已分配的新卡身份冲突，拒绝覆盖。");
								return { board: state.board, value: undefined, save: false };
							}
							const baseRef = resolveTaskCreateBaseRef({
								explicitlyRequestedBaseRef: item.creation_settings.base_ref,
								rememberedBaseRefForProject:
									config.userInterfacePreferencesSharedAcrossBrowserOrigins
										.mostRecentlyUsedTaskCreateBaseRefByProjectId[scope.workspaceId],
								repository: state.git,
							}).baseRef;
							const rvf = item.origin === "rvf_validated_out_of_scope_finding";
							const agentId: RuntimeAgentId | undefined = item.creation_settings.agent_id
								? runtimeAgentIdSchema.parse(item.creation_settings.agent_id)
								: undefined;
							const created = addTaskToColumn(
								state.board,
								"backlog",
								{
									taskId: taskReference.taskId,
									title: item.title,
									prompt: item.prompt,
									baseRef,
									startInPlanMode: rvf
										? true
										: (item.creation_settings.start_in_plan_mode ?? config.newTaskStartInPlanModeByDefault),
									autoReviewEnabled: false,
									agentId,
									workspaceDefaultAgentIdForNewTasks: config.selectedAgentId,
									ompAgentSessionTransportForNewTasks: config.ompAgentSessionTransportForNewTasks,
								},
								randomUUID,
								taskReference.taskIncarnationCreatedAtEpochMs,
							);
							return { board: created.board, value: undefined };
						},
					);
					if (result.saved) await deps.broadcastState(scope.workspaceId, scope.workspacePath);
				},
				appendComment: (input) => appendRelatedFinding(scope, input),
				assertUnverifiedRelations: async ({ subject, analysis, expectedRequirementsFingerprintByTaskIdentity }) => {
					for (const candidate of analysis.relation_candidates) {
						if (
							candidate.cross_project ||
							candidate.task_reference.workspaceId !== subject.workspaceId ||
							JSON.stringify(subject) === JSON.stringify(candidate.task_reference)
						)
							continue;
						await deps.referenceAssertionWritePort.assertUnverifiedReferenceRelationAsTaskIndexingSupport({
							subject,
							candidate,
							expectedRequirementsFingerprintByTaskIdentity,
						});
					}
				},
				recordDisposition: async ({ response, commentTaskReference }) => {
					await runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture(
						async (client, instance) => {
							await client.appendCommittedEventsSkippingDraftsWhoseIdempotencyKeyIsAlreadyRecorded({
								eventDrafts: [
									{
										eventFamily: "fact_observed_by_kanban_runtime_event",
										eventKind: "incoming_work_item_relation_triage_disposition_recorded",
										occurredAt: response.as_of,
										actor: {
											kanbanActorKind: "kanban_runtime_system_component",
											kanbanRuntimeSystemComponentName: SUPPORT_COMPONENT_NAME,
										},
										actorNativeConversationSessionIdentity: null,
										actorKanbanTaskConversationSessionId: null,
										actorRepositoryIdentityAtEventTime: {
											workspaceId: scope.workspaceId,
											repositoryPath: scope.workspacePath,
										},
										onBehalfOfInitiatingWorkUnit: item.source_task ?? null,
										causedBySystemExecutedCause: null,
										recordCaptureChannel: "live_runtime_capture",
										capturingKanbanRuntimeInstance: instance,
										invokingKanbanCliCodeVersion: null,
										occurredAtConversationTurnReference: null,
										idempotencyKey: `${response.operation_id}:disposition`,
										subjectWorkspaceId: scope.workspaceId,
										subjectTaskId: commentTaskReference.taskId,
										eventPayload: {
											incomingWorkItem: item,
											disposition: response,
											relatedFindingCommentTask: commentTaskReference,
											relationClaimsConfirmation: "unverified_support_agent_claims",
										},
									},
								],
							});
						},
					);
				},
			},
		});
	};
	const service = {
		suggestReferenceRelationsForTaskModeling: async (
			scope: RuntimeTrpcWorkspaceScope,
			request: ReferenceRelationModelingSuggestionsRequest,
		) => {
			const collected = await collect(scope.workspaceId);
			const selector = request.workUnit;
			const currentTask =
				selector?.workUnitSelectorKind === "kanban_board_card_by_bare_task_id"
					? collected.materials.find(
							(material) =>
								material.taskReference.workspaceId === scope.workspaceId &&
								material.taskReference.taskId === selector.bareTaskId,
						)
					: null;
			if (selector && !currentTask) throw new Error("关系建议只能分析当前项目中可确认身份的任务。");
			const prompt = currentTask?.prompt ?? request.draftTaskPrompt;
			if (!prompt?.trim())
				return {
					availability: "unavailable" as const,
					unavailableReason: "请先填写任务要求，再获取关系建议。",
					contextAsOf: Date.now(),
					contextCompleteness: ["current_task_requirements_missing"],
					candidates: [],
				};
			const item = incomingWorkItemSchema.parse({
				schema_version: 1,
				work_item_key: "interactive-relation-suggestion",
				title: currentTask?.title ?? request.draftTaskTitle,
				prompt,
				existing_finding_task: currentTask?.taskReference,
			});
			const result = await analyzeIncomingWorkItemRelations({
				workspaceId: scope.workspaceId,
				item,
				...collected,
				excludeExistingFindingTaskFromRelationSuggestions: true,
				settings: await readTaskIndexingSupportExecutorSettings(scope.workspaceId),
				abortSignal: lifetime.signal,
			});
			return {
				availability: "available" as const,
				unavailableReason: null,
				contextAsOf: result.context.asOf,
				contextCompleteness: result.context.contextCompleteness,
				candidates: result.analysis.relation_candidates.map((candidate) => {
					const id = `support-relation-${taskIndexingTextFingerprint(JSON.stringify(candidate)).slice(0, 32)}`;
					return {
						candidateId: id,
						relationDraft: referenceRelationModelingDraftSchema.parse({
							draftId: id,
							counterpartWorkUnit: candidate.task_reference,
							relationKind: candidate.relation_kind,
							relationAssertionRationaleOneSentence: candidate.rationale.slice(0, 600),
							relationAssertionEvidencePointers: candidate.evidence.map((pointer) => pointer.slice(0, 1000)),
							assertedRelationKindSpecificAttributes:
								candidate.relation_kind === "reference_concerns_behavior_or_state_of"
									? {
											concernNature: "checks_scope_overlap_with",
											concernedAspectSummary: candidate.rationale.slice(0, 600),
										}
									: {},
						}),
						rationale: `${candidate.cross_project ? "跨项目可能相关：" : ""}${candidate.rationale}`,
						evidencePointers: candidate.evidence,
					};
				}),
			};
		},
		getTaskIndexingContext: async (scope: RuntimeTrpcWorkspaceScope) => {
			const collected = await collect(scope.workspaceId);
			const context = await loadAndAdvanceSharedTaskIndexingContext({
				workspaceId: scope.workspaceId,
				materials: collected.materials,
				settings: await readTaskIndexingSupportExecutorSettings(scope.workspaceId),
				instructionVersion: "shared-task-indexing-context-v1",
				now: Date.now(),
			});
			context.contextCompleteness.push(...collected.missingContextParts);
			return context;
		},
		getExecutorSettings: (scope: RuntimeTrpcWorkspaceScope) =>
			readTaskIndexingSupportExecutorSettings(scope.workspaceId),
		setExecutorSettings: (scope: RuntimeTrpcWorkspaceScope, settings: TaskIndexingSupportExecutorSettings) =>
			saveTaskIndexingSupportExecutorSettings(scope.workspaceId, settings),
		appendTaskComment: async (
			scope: RuntimeTrpcWorkspaceScope,
			request: AppendTaskCommentRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) =>
			await appendTaskCommentThroughRuntimeBoardMutation({
				scope,
				request,
				intent: await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
					taskMutationIntentKind: "task_comment_appended_through_runtime",
					kanbanRequestOriginActorEvidence: evidence,
				}),
				broadcastState: deps.broadcastState,
			}),
		triageIncomingWorkItem,
		analyzeIncomingWorkItem: async (scope: RuntimeTrpcWorkspaceScope, item: IncomingWorkItem) => {
			const collected = await collect(scope.workspaceId);
			return await analyzeIncomingWorkItemRelations({
				workspaceId: scope.workspaceId,
				item,
				...collected,
				settings: await readTaskIndexingSupportExecutorSettings(scope.workspaceId),
				abortSignal: lifetime.signal,
			});
		},
		backfillUntriagedRvfFindings: async (scope: RuntimeTrpcWorkspaceScope) => {
			const board = await loadWorkspaceBoardById(scope.workspaceId);
			const recordedOperations = await listDurableIncomingWorkItemTriageOperations(
				taskIndexingSupportWorkspaceStoragePath(scope.workspaceId, "incoming-work-item-triage-operations"),
			);
			const results: { taskId: string; status: "completed" | "already_completed" | "failed"; error?: string }[] = [];
			for (const task of board.columns.flatMap((column) => column.cards).filter(isUntriagedRvfFindingTask)) {
				if (lifetime.signal.aborted) break;
				const key = `rvf-existing-finding:${task.id}:${task.createdAt}`;
				const matchesFindingCard = (reference: KanbanBoardCardWorkUnitQualifiedReference | null | undefined) =>
					reference?.workspaceId === scope.workspaceId &&
					reference.taskId === task.id &&
					reference.taskIncarnationCreatedAtEpochMs === task.createdAt;
				const matchingOperations = recordedOperations.filter(
					(operation) =>
						matchesFindingCard(operation.allocatedTask) ||
						matchesFindingCard(operation.incomingWorkItem.existing_finding_task),
				);
				if (matchingOperations.some((operation) => operation.completed)) {
					results.push({ taskId: task.id, status: "already_completed" });
					continue;
				}
				try {
					await triageIncomingWorkItem(
						scope,
						matchingOperations[0]?.incomingWorkItem ??
							incomingWorkItemSchema.parse({
								schema_version: 1,
								work_item_key: key,
								title: task.title,
								prompt: task.prompt,
								origin: "rvf_validated_out_of_scope_finding",
								existing_finding_task: {
									workUnitType: "kanban_board_card",
									workspaceId: scope.workspaceId,
									taskId: task.id,
									taskIncarnationCreatedAtEpochMs: task.createdAt,
								},
							}),
					);
					results.push({ taskId: task.id, status: "completed" });
				} catch (error) {
					results.push({
						taskId: task.id,
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return { results };
		},
	};
	const api = {
		...service,
		readBackfillStatus: async (scope: RuntimeTrpcWorkspaceScope) =>
			await readTaskIndexingSupportJsonFile(
				taskIndexingSupportWorkspaceStoragePath(scope.workspaceId, "rvf-findings-backfill-status.json"),
			),
		scheduleBackfill: async (scope: RuntimeTrpcWorkspaceScope) => {
			lifetime.signal.throwIfAborted();
			if (backgroundRuns.has(scope.workspaceId)) return { scheduled: false, alreadyRunning: true };
			const path = taskIndexingSupportWorkspaceStoragePath(scope.workspaceId, "rvf-findings-backfill-status.json");
			const scheduledStatusPersisted = lockedFileSystem.writeJsonFileAtomic(path, {
				state: "scheduled",
				scheduledAt: Date.now(),
			});
			const run = (async () => {
				try {
					await scheduledStatusPersisted;
					const result = await service.backfillUntriagedRvfFindings(scope);
					await lockedFileSystem.writeJsonFileAtomic(path, {
						state: lifetime.signal.aborted ? "interrupted" : "completed",
						completedAt: Date.now(),
						...result,
					});
				} catch (error) {
					await lockedFileSystem.writeJsonFileAtomic(path, {
						state: "failed",
						error: error instanceof Error ? error.message : String(error),
						completedAt: Date.now(),
					});
				}
			})().finally(() => backgroundRuns.delete(scope.workspaceId));
			backgroundRuns.set(scope.workspaceId, run);
			void run.catch(() => {});
			await scheduledStatusPersisted;
			return { scheduled: true, alreadyRunning: false };
		},
		startAutomaticBackfill: (
			listScopes: () => Promise<RuntimeTrpcWorkspaceScope[]>,
			warn: (message: string) => void,
		) => {
			if (automaticBackfillTimer || automaticBackfillRun || lifetime.signal.aborted) return;
			automaticBackfillTimer = setTimeout(() => {
				automaticBackfillTimer = null;
				automaticBackfillRun = (async () => {
					for (const scope of await listScopes()) {
						if (lifetime.signal.aborted) break;
						await api.scheduleBackfill(scope);
						await backgroundRuns.get(scope.workspaceId);
					}
				})().catch((error: unknown) => {
					if (!lifetime.signal.aborted)
						warn(
							`范围外发现自动补查失败，可用 support 命令重试：${error instanceof Error ? error.message : String(error)}`,
						);
				});
			}, 1000);
			automaticBackfillTimer.unref();
		},
		close: async () => {
			lifetime.abort();
			if (automaticBackfillTimer) clearTimeout(automaticBackfillTimer);
			await Promise.allSettled([
				...backgroundRuns.values(),
				...(automaticBackfillRun ? [automaticBackfillRun] : []),
			]);
		},
	};
	return api;
}

export type TaskIndexingSupportRuntimeService = ReturnType<typeof createTaskIndexingSupportRuntimeService>;
