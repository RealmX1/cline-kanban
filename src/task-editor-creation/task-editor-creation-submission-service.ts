import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type {
	RuntimeBoardCard,
	RuntimeCreationResolvedSettings,
	RuntimeTaskCardActionStartAgentSessionResponse,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	type TaskEditorCreationSubmissionRequest,
	taskEditorCreationSubmissionRequestSchema,
} from "../core/task-editor-creation-submission-contract";
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";
import type { WebUiUserDecisionClientCharacteristics } from "../core/work-unit-relation-assertion-write-api-contract";
import type {
	ApplyReferenceRelationModelingChangesRequest,
	ReferenceRelationModelingEditorDraft,
} from "../core/work-unit-relation-modeling-api-contract";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	loadPersistedWorkspaceStateById,
	resolveRegisteredWorkspaceScopeByIdWithoutGitProbe,
} from "../state/workspace-state";
import { requestAutomaticTaskNameBackfill } from "../task-name-suggestion/automatic-task-name-backfill";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { assertWebUiUserDecisionRequestOrigin } from "../trpc/work-unit-relation-assertion-write-api";
import {
	listTaskEditorCreationSubmissions,
	readTaskEditorCreationExplicitStop,
	readTaskEditorCreationSubmission,
	type TaskEditorCreationSubmissionRecord,
	taskEditorCreationFingerprint,
	withTaskEditorCreationSubmissionLock,
	writeTaskEditorCreationSubmission,
} from "./task-editor-creation-submission-store";

export interface TaskEditorCreationIdentityLocation {
	workspaceId: string;
	taskIncarnationCreatedAtEpochMs: number;
	permanentlyRemoved: boolean;
	workspaceIdsUsedByTaskIncarnation?: string[];
}
interface TaskEditorCreationSubmissionServiceDependencies {
	resolveCreationSettings?: (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
	) => Promise<RuntimeCreationResolvedSettings>;
	findSession?: (workspaceId: string, conversationSessionId: string) => RuntimeTaskSessionSummary | null;
	resolveIdentity: (workspaceId: string, card: RuntimeBoardCard) => Promise<TaskEditorCreationIdentityLocation | null>;
	persistCard: (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
		evidence: KanbanRequestOriginActorEvidence,
	) => Promise<unknown>;
	applyAcceptedRelations: (
		input: ApplyReferenceRelationModelingChangesRequest,
		authorization: { submissionId: string; acceptedAtEpochMs: number },
	) => Promise<unknown>;
	startAgent: (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
		record: TaskEditorCreationSubmissionRecord,
		beforeAgentProcessLaunch: () => Promise<void>,
	) => Promise<RuntimeTaskCardActionStartAgentSessionResponse>;
	readDependencyFingerprint: (record: TaskEditorCreationSubmissionRecord) => Promise<unknown>;
	warn: (message: string) => void;
	onStatusChanged?: () => void;
}
const terminalPhases = new Set(["completed", "stopped", "identity_conflict", "waiting_for_authorization"]);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createTaskEditorCreationSubmissionService(deps: TaskEditorCreationSubmissionServiceDependencies) {
	const runtimeInstanceId = randomUUID();
	const executing = new Map<string, Promise<void>>();
	const completedSubmissionIds = new Set<string>();
	const reportedUnreadableRecords = new Set<string>();
	const lastPublishedProgressBySubmissionId = new Map<string, string>();
	const persistRecord = async (record: TaskEditorCreationSubmissionRecord) => {
		await writeTaskEditorCreationSubmission(record);
		if (record.status.phase === "completed") completedSubmissionIds.add(record.status.submissionId);
		const { cardPersisted, startCompleted, phase, lastError, recoveryCondition } = record.status;
		const progressFingerprint = JSON.stringify([cardPersisted, startCompleted, phase, lastError, recoveryCondition]);
		if (lastPublishedProgressBySubmissionId.get(record.status.submissionId) !== progressFingerprint) {
			lastPublishedProgressBySubmissionId.set(record.status.submissionId, progressFingerprint);
			deps.onStatusChanged?.();
		}
	};
	const readIncompleteRecords = async () => {
		const records = await listTaskEditorCreationSubmissions(completedSubmissionIds, (path, error) => {
			const failureKey = taskEditorCreationFingerprint([path, messageOf(error)]);
			if (reportedUnreadableRecords.has(failureKey)) return;
			reportedUnreadableRecords.add(failureKey);
			deps.warn(`创建提交记录不可读，保留原文件并继续其他提交 ${path}: ${messageOf(error)}`);
		});
		for (const record of records)
			if (record.status.phase === "completed") completedSubmissionIds.add(record.status.submissionId);
		return records;
	};
	let closed = false;
	let timer: ReturnType<typeof setInterval> | null = null;
	let sweeping: Promise<void> | null = null;
	const observation = async (record: TaskEditorCreationSubmissionRecord) => {
		const identity = await deps.resolveIdentity(record.status.workspaceId, record.request.newTaskCard);
		if (
			identity &&
			(identity.permanentlyRemoved ||
				identity.taskIncarnationCreatedAtEpochMs !== record.status.taskIncarnationCreatedAtEpochMs)
		)
			throw new TRPCError({
				code: "CONFLICT",
				message: "原任务已删除或同 ID 身份已变化，创建提交不会重建或覆盖它。",
			});
		const workspaceId = identity?.workspaceId ?? record.status.workspaceId;
		const scope = await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe(workspaceId);
		if (!scope) throw new Error("目标项目暂不可用，等待项目恢复。");
		const state = await loadPersistedWorkspaceStateById(workspaceId);
		const column = state.board.columns.find((entry) => entry.cards.some((card) => card.id === record.status.taskId));
		const card = column?.cards.find((entry) => entry.id === record.status.taskId);
		if (card && card.createdAt !== record.status.taskIncarnationCreatedAtEpochMs)
			throw new TRPCError({ code: "CONFLICT", message: "同 ID 任务身份已变化，未执行旧提交。" });
		if (!card && (record.status.cardPersisted || identity))
			throw new TRPCError({ code: "CONFLICT", message: "原任务已不在看板，创建提交不会复活它。" });
		const liveSession = card ? deps.findSession?.(workspaceId, resolveMainTaskConversationSessionId(card)) : null;
		const session = liveSession ?? (card ? state.sessions[resolveMainTaskConversationSessionId(card)] : undefined);
		return {
			scope: { workspaceId: scope.workspaceId, workspacePath: scope.repoPath },
			card,
			column,
			session,
			liveSession,
			workspaceIdsUsedByTaskIncarnation: identity?.workspaceIdsUsedByTaskIncarnation ?? [],
		};
	};
	const assertEligible = async (record: TaskEditorCreationSubmissionRecord) => {
		const current = await observation(record);
		const stops = await Promise.all(
			[
				...new Set([
					record.status.workspaceId,
					current.scope.workspaceId,
					...current.workspaceIdsUsedByTaskIncarnation,
				]),
			].map((workspaceId) =>
				readTaskEditorCreationExplicitStop(
					workspaceId,
					record.status.taskId,
					record.status.taskIncarnationCreatedAtEpochMs,
				),
			),
		);
		const stoppedAt = stops.find((value) => value !== null && value >= record.status.acceptedAtEpochMs) ?? null;
		if (stoppedAt !== null && stoppedAt >= record.status.acceptedAtEpochMs) {
			record.status.phase = "stopped";
			throw new Error("用户已 Stop，后续创建步骤已停止。可在任务详情另行启动任务。");
		}
		if (
			current.card?.taskShelvingState?.isShelved ||
			(current.column && !["backlog", "in_progress"].includes(current.column.id))
		)
			throw new Error("任务已搁置、关闭或离开可启动阶段，等待恢复执行资格。");
		if (closed) throw new Error("运行时正在关闭，创建后续步骤等待后继实例恢复。");
		return current;
	};
	const recoveryFingerprint = async (record: TaskEditorCreationSubmissionRecord) => {
		let current: unknown;
		try {
			const value = await observation(record);
			current = [
				value.scope.workspaceId,
				value.card,
				value.column?.id,
				value.session,
				await Promise.all(
					[record.status.workspaceId, value.scope.workspaceId, ...value.workspaceIdsUsedByTaskIncarnation].map(
						(workspaceId) =>
							readTaskEditorCreationExplicitStop(
								workspaceId,
								record.status.taskId,
								record.status.taskIncarnationCreatedAtEpochMs,
							),
					),
				),
			];
		} catch (error) {
			current = messageOf(error);
		}
		let dependencies: unknown;
		try {
			dependencies = await deps.readDependencyFingerprint(record);
		} catch (error) {
			dependencies = messageOf(error);
		}
		return taskEditorCreationFingerprint([current, dependencies]);
	};
	const reconcileStartEvidence = async (record: TaskEditorCreationSubmissionRecord) => {
		const current = await observation(record);
		if (
			current.card?.mostRecentlyLaunchedAgentSessionAgentId ||
			(current.liveSession?.pid != null &&
				resolveSessionFacets(current.liveSession).liveness === "live" &&
				current.liveSession.startedAt != null &&
				current.liveSession.startedAt >= record.request.newTaskCard.createdAt)
		) {
			record.status.startCompleted = true;
			return true;
		}
		return false;
	};
	const runRound = async (workspaceId: string, submissionId: string, force = false) =>
		withTaskEditorCreationSubmissionLock(workspaceId, submissionId, async () => {
			const record = await readTaskEditorCreationSubmission(workspaceId, submissionId);
			if (!record || closed || terminalPhases.has(record.status.phase)) return;
			const fingerprint = await recoveryFingerprint(record);
			if (
				!force &&
				record.lastAttemptRuntimeInstanceId === runtimeInstanceId &&
				record.lastRecoveryConditionFingerprint === fingerprint
			)
				return;
			record.lastAttemptRuntimeInstanceId = runtimeInstanceId;
			record.lastRecoveryConditionFingerprint = fingerprint;
			record.status.attemptsInCurrentRecoveryRound = 0;
			await persistRecord(record);
			for (let attempt = 1; attempt <= 3 && !closed; attempt++) {
				record.status.attemptsInCurrentRecoveryRound = attempt;
				try {
					if (
						record.status.cardPersisted &&
						record.status.relationsCompleted &&
						record.status.startRequested &&
						(await reconcileStartEvidence(record))
					) {
						record.status.phase = "completed";
						record.status.lastError = null;
						record.status.recoveryCondition = null;
						break;
					}
					let current = await observation(record);
					if (!current.card) {
						current = await assertEligible(record);
						if (!record.acceptedUserAuthorization) throw new Error("旧草稿缺少创建授权，未重建原任务。");
						if (!record.status.resolvedSettings && deps.resolveCreationSettings) {
							record.status.resolvedSettings = await deps.resolveCreationSettings(
								current.scope,
								record.request.newTaskCard,
							);
							await persistRecord(record);
							await assertEligible(record);
						}
						const settings = record.status.resolvedSettings;
						const agentId = settings?.effectiveAgentId.value;
						const cardWithFrozenStartupSettings = settings
							? {
									...record.request.newTaskCard,
									agentId,
									startInPlanMode: settings.startInPlanMode.value,
									taskAgentPermissionMode: settings.effectiveTaskAgentPermissionMode.value,
									codexConfigurationProfileId: settings.codexConfigurationProfileId.value ?? undefined,
									ompAgentSessionTransport:
										agentId === "omp"
											? (settings.sessionTransport.value as "pty_terminal" | "acp_stdio_subprocess")
											: undefined,
									terminalAgentModelOverrideSettings:
										settings.modelId.value &&
										(agentId === "claude" ||
											agentId === "codex" ||
											agentId === "cursor" ||
											agentId === "kimi" ||
											agentId === "omp")
											? { agentId, modelId: settings.modelId.value }
											: undefined,
								}
							: record.request.newTaskCard;
						record.status.phase = "saving_card";
						await persistRecord(record);
						await deps.persistCard(
							current.scope,
							cardWithFrozenStartupSettings,
							record.acceptedUserAuthorization.requestOriginActorEvidence,
						);
					}
					// 保存成功是历史事实，后续换世或删除只阻止执行，不能撤回保存确认。
					record.status.cardPersisted = true;
					if (record.request.suggestNameAfterCreation)
						await requestAutomaticTaskNameBackfill(current.scope, record.request.newTaskCard).catch(() =>
							deps.warn("自动命名登记未完成；创建继续，原任务名称保留。"),
						);
					await persistRecord(record);
					await assertEligible(record);
					if (!record.status.relationsCompleted) {
						if (!record.acceptedUserAuthorization) {
							record.status.phase = "waiting_for_authorization";
							break;
						}
						record.status.phase = "saving_relations";
						await persistRecord(record);
						await assertEligible(record);
						await deps.applyAcceptedRelations(
							{
								workUnit: {
									workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
									kanbanBoardCard: {
										workUnitType: "kanban_board_card",
										workspaceId: record.status.workspaceId,
										taskId: record.status.taskId,
										taskIncarnationCreatedAtEpochMs: record.status.taskIncarnationCreatedAtEpochMs,
									},
								},
								modelingSubmissionId: record.relationModelingSubmissionId,
								referenceRelationDrafts: record.request.referenceRelationDrafts,
								relationRevocations: record.request.relationRevocations,
								webUiUserDecisionClientCharacteristics:
									record.acceptedUserAuthorization.webUiUserDecisionClientCharacteristics,
							},
							{ submissionId, acceptedAtEpochMs: record.acceptedUserAuthorization.acceptedAtEpochMs },
						);
						record.status.relationsCompleted = true;
						await persistRecord(record);
					}
					if (
						record.status.startRequested &&
						!record.status.startCompleted &&
						!(await reconcileStartEvidence(record))
					) {
						if (record.agentProcessLaunchMayHaveBegun) {
							record.status.phase = "waiting_for_evidence";
							record.status.recoveryCondition =
								"等待原启动的会话、原生身份或卡片启动记录补证；不重发 Initial Prompt。";
							break;
						}
						current = await assertEligible(record);
						if (!current.card) throw new Error("启动前无法确认任务身份。");
						record.status.phase = "starting_agent";
						await persistRecord(record);
						const result = await deps.startAgent(current.scope, current.card, record, async () => {
							await assertEligible(record);
							record.agentProcessLaunchMayHaveBegun = true;
							try {
								await persistRecord(record);
								await assertEligible(record);
							} catch (error) {
								// 门禁尚未返回给 transport，明确失败就仍能证明没有 spawn。
								record.agentProcessLaunchMayHaveBegun = false;
								await persistRecord(record);
								throw error;
							}
						});
						if (
							!["agent_session_started", "agent_session_already_in_agent_turn_so_start_was_skipped"].includes(
								result.agentSessionStartOutcome,
							)
						)
							throw new Error(result.agentSessionStartFailureMessage ?? "Agent 启动尚未完成。");
						record.status.startCompleted = true;
					}
					record.status.phase = "completed";
					record.status.lastError = null;
					record.status.recoveryCondition = null;
					break;
				} catch (error) {
					record.status.lastError = messageOf(error);
					record.failureHistory.push({ occurredAtEpochMs: Date.now(), message: messageOf(error) });
					if (error instanceof TRPCError && error.code === "CONFLICT") record.status.phase = "identity_conflict";
					else if (record.status.phase !== "stopped")
						record.status.phase = record.agentProcessLaunchMayHaveBegun
							? "waiting_for_evidence"
							: "waiting_for_dependency";
					record.status.recoveryCondition = record.agentProcessLaunchMayHaveBegun
						? "等待原启动的持久证据，禁止重复发送 Initial Prompt。"
						: "项目、任务资格、账本或启动依赖变化，或运行时重启后，自动开始下一轮，最多三次。";
					await persistRecord(record);
					if (terminalPhases.has(record.status.phase) || record.agentProcessLaunchMayHaveBegun) break;
				}
			}
			record.lastRecoveryConditionFingerprint = await recoveryFingerprint(record);
			await persistRecord(record);
		});
	const enqueue = (workspaceId: string, submissionId: string, force = false) => {
		const key = `${workspaceId}:${submissionId}`;
		if (closed || executing.has(key)) return;
		const running = runRound(workspaceId, submissionId, force)
			.catch((error: unknown) => {
				deps.warn(`创建提交恢复失败 ${key}: ${messageOf(error)}`);
			})
			.finally(() => executing.delete(key));
		executing.set(key, running);
	};
	const accept = async (
		scope: RuntimeTrpcWorkspaceScope,
		request: TaskEditorCreationSubmissionRequest,
		evidence: KanbanRequestOriginActorEvidence,
	) => {
		request = taskEditorCreationSubmissionRequestSchema.parse(request);
		assertWebUiUserDecisionRequestOrigin(evidence, request.webUiUserDecisionClientCharacteristics);
		const status = await withTaskEditorCreationSubmissionLock(scope.workspaceId, request.submissionId, async () => {
			const existing = await readTaskEditorCreationSubmission(scope.workspaceId, request.submissionId);
			const fingerprint = taskEditorCreationFingerprint(request);
			if (existing) {
				if (existing.requestFingerprint !== fingerprint)
					throw new TRPCError({ code: "CONFLICT", message: "提交 ID 已绑定另一份冻结输入，未执行本次更改。" });
				return existing.status;
			}
			const existingCard = (await loadPersistedWorkspaceStateById(scope.workspaceId)).board.columns
				.flatMap((column) => column.cards)
				.find((card) => card.id === request.newTaskCard.id);
			if (existingCard)
				throw new TRPCError({ code: "CONFLICT", message: "任务已由其他创建提交保存，不能复用它的新建身份。" });
			const acceptedAt = Date.now();
			const record: TaskEditorCreationSubmissionRecord = {
				schemaVersion: 1,
				request,
				workspacePath: scope.workspacePath,
				requestFingerprint: fingerprint,
				relationModelingSubmissionId: request.submissionId,
				acceptedUserAuthorization: {
					verifiedPageLoadNonceAtAcceptance: true,
					acceptedAtEpochMs: acceptedAt,
					webUiUserDecisionClientCharacteristics: request.webUiUserDecisionClientCharacteristics,
					requestOriginActorEvidence: {
						decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
						webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
					},
				},
				agentProcessLaunchMayHaveBegun: false,
				lastAttemptRuntimeInstanceId: null,
				lastRecoveryConditionFingerprint: null,
				failureHistory: [],
				status: {
					submissionId: request.submissionId,
					workspaceId: scope.workspaceId,
					taskId: request.newTaskCard.id,
					taskIncarnationCreatedAtEpochMs: request.newTaskCard.createdAt,
					cardPersisted: false,
					relationsCompleted: request.referenceRelationDrafts.length + request.relationRevocations.length === 0,
					startRequested: request.startAgentAfterCreation,
					startCompleted: false,
					phase: "saving_card",
					lastError: null,
					recoveryCondition: null,
					attemptsInCurrentRecoveryRound: 0,
					acceptedAtEpochMs: acceptedAt,
					updatedAtEpochMs: acceptedAt,
				},
			};
			await persistRecord(record);
			return record.status;
		});
		enqueue(scope.workspaceId, request.submissionId);
		return status;
	};
	const sweep = async () => {
		for (const record of await readIncompleteRecords()) {
			if (!terminalPhases.has(record.status.phase)) enqueue(record.status.workspaceId, record.status.submissionId);
		}
	};
	return {
		submit: accept,
		getStatus: async (scope: RuntimeTrpcWorkspaceScope, input: { submissionId: string }) =>
			(await readTaskEditorCreationSubmission(scope.workspaceId, input.submissionId))?.status ?? null,
		listForTask: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string; taskIncarnationCreatedAtEpochMs: number },
		) => {
			const result = [];
			for (const record of await readIncompleteRecords()) {
				if (
					record.status.taskId !== input.taskId ||
					record.status.taskIncarnationCreatedAtEpochMs !== input.taskIncarnationCreatedAtEpochMs
				)
					continue;
				const location = await deps.resolveIdentity(record.status.workspaceId, record.request.newTaskCard);
				if ((location?.workspaceId ?? record.status.workspaceId) === scope.workspaceId) result.push(record.status);
			}
			return result;
		},
		retry: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: {
				submissionId: string;
				webUiUserDecisionClientCharacteristics: WebUiUserDecisionClientCharacteristics;
			},
			evidence: KanbanRequestOriginActorEvidence,
		) => {
			assertWebUiUserDecisionRequestOrigin(evidence, input.webUiUserDecisionClientCharacteristics);
			await withTaskEditorCreationSubmissionLock(scope.workspaceId, input.submissionId, async () => {
				const record = await readTaskEditorCreationSubmission(scope.workspaceId, input.submissionId);
				if (!record) throw new TRPCError({ code: "NOT_FOUND" });
				if (record.status.phase === "waiting_for_authorization") {
					if (Object.keys(record.legacyEditorDraft?.invalidReferenceRelationDetailsFormsByDraftId ?? {}).length)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "旧关系草稿包含未完成的详情，原文已保留。请在原任务的关系编辑入口核对后保存。",
						});
					record.acceptedUserAuthorization = {
						verifiedPageLoadNonceAtAcceptance: true,
						acceptedAtEpochMs: Date.now(),
						webUiUserDecisionClientCharacteristics: input.webUiUserDecisionClientCharacteristics,
						requestOriginActorEvidence: {
							decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
							webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
						},
					};
					record.status.phase = "saving_relations";
					await persistRecord(record);
				}
			});
			enqueue(scope.workspaceId, input.submissionId, true);
			return (await readTaskEditorCreationSubmission(scope.workspaceId, input.submissionId))?.status ?? null;
		},
		migrateLegacyDraft: async (workspaceId: string, draft: ReferenceRelationModelingEditorDraft) => {
			if (!draft.createdTaskId) return draft;
			let originalSnapshot = draft.createdTaskCardSnapshot;
			if (!originalSnapshot) {
				const originalSubmissions = (await listTaskEditorCreationSubmissions()).filter(
					(record) =>
						record.acceptedUserAuthorization &&
						record.relationModelingSubmissionId === draft.modelingSubmissionId &&
						record.status.workspaceId === (draft.createdTaskWorkspaceId ?? workspaceId) &&
						record.status.taskId === draft.createdTaskId,
				);
				if (originalSubmissions.length === 1)
					originalSnapshot = originalSubmissions[0]?.request.newTaskCard ?? null;
			}
			const snapshot = originalSnapshot;
			if (!snapshot) throw new Error("旧创建草稿身份尚未确认，保留原草稿等待补证。");
			const location = await deps.resolveIdentity(draft.createdTaskWorkspaceId ?? workspaceId, snapshot);
			if (
				!location ||
				location.permanentlyRemoved ||
				location.taskIncarnationCreatedAtEpochMs !== snapshot.createdAt
			)
				throw new Error("旧创建草稿身份已变化，原始草稿保留用于核验，未写入任何任务。");
			const scope = await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe(
				draft.createdTaskWorkspaceId ?? workspaceId,
			);
			if (!scope) throw new Error("旧草稿所属项目暂不可用。");
			const submissionId = `${taskEditorCreationFingerprint([workspaceId, draft.modelingSubmissionId, snapshot.id, snapshot.createdAt]).slice(0, 8)}-${taskEditorCreationFingerprint(draft.modelingSubmissionId).slice(0, 4)}-4000-8000-${taskEditorCreationFingerprint([snapshot.id, snapshot.createdAt]).slice(0, 12)}`;
			const hasPendingLegacyRelations =
				draft.referenceRelationDrafts.length +
					draft.relationRevocations.length +
					Object.keys(draft.invalidReferenceRelationDetailsFormsByDraftId ?? {}).length >
				0;
			await withTaskEditorCreationSubmissionLock(scope.workspaceId, submissionId, async () => {
				if (await readTaskEditorCreationSubmission(scope.workspaceId, submissionId)) return;
				const request = taskEditorCreationSubmissionRequestSchema.parse({
					submissionId,
					newTaskCard: snapshot,
					referenceRelationDrafts: draft.referenceRelationDrafts,
					relationRevocations: draft.relationRevocations,
					startAgentAfterCreation: false,
					webUiUserDecisionClientCharacteristics: {
						triggeringDomEventIsTrusted: false,
						navigatorWebdriver: false,
						navigatorUserAgent: "旧草稿未记录用户手势",
					},
				});
				await persistRecord({
					schemaVersion: 1,
					legacyEditorDraft: draft,
					request,
					workspacePath: scope.repoPath,
					requestFingerprint: taskEditorCreationFingerprint(request),
					relationModelingSubmissionId: draft.modelingSubmissionId,
					acceptedUserAuthorization: null,
					agentProcessLaunchMayHaveBegun: false,
					lastAttemptRuntimeInstanceId: null,
					lastRecoveryConditionFingerprint: null,
					failureHistory: [],
					status: {
						submissionId,
						workspaceId: scope.workspaceId,
						taskId: snapshot.id,
						taskIncarnationCreatedAtEpochMs: snapshot.createdAt,
						cardPersisted: true,
						relationsCompleted: !hasPendingLegacyRelations,
						startRequested: false,
						startCompleted: false,
						phase: hasPendingLegacyRelations ? "waiting_for_authorization" : "completed",
						lastError: "旧草稿的关系已转入任务详情，尚未取得保存关系的用户授权；未推测启动意图。",
						recoveryCondition: "在原任务详情确认并重试关系保存。",
						attemptsInCurrentRecoveryRound: 0,
						acceptedAtEpochMs: Date.now(),
						updatedAtEpochMs: Date.now(),
					},
				});
			});
			return {
				...draft,
				createdTaskId: null,
				createdTaskCardSnapshot: null,
				createdTaskWorkspaceId: undefined,
				referenceRelationDrafts: [],
				relationRevocations: [],
				invalidReferenceRelationDetailsFormsByDraftId: undefined,
				creationPrompt:
					draft.creationPrompt && draft.creationPrompt !== snapshot.prompt ? draft.creationPrompt : "",
				creationTitle: draft.creationTitle && draft.creationTitle !== snapshot.title ? draft.creationTitle : "",
			};
		},
		start() {
			const kick = () => {
				if (!closed && !sweeping)
					sweeping = sweep()
						.catch((error: unknown) => deps.warn(`扫描创建提交失败: ${messageOf(error)}`))
						.finally(() => {
							sweeping = null;
						});
			};
			kick();
			timer ??= setInterval(kick, 5_000);
			timer.unref();
		},
		sweep,
		async settle() {
			await sweeping;
			await Promise.all([...executing.values()]);
		},
		async close() {
			closed = true;
			if (timer) clearInterval(timer);
			await sweeping;
			await Promise.all([...executing.values()]);
		},
	};
}
export type TaskEditorCreationSubmissionService = ReturnType<typeof createTaskEditorCreationSubmissionService>;
