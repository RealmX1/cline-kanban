import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
	reconcileCodexPromptSubmissionAcceptance,
	submittedPromptSha256,
} from "../agent-session-history/codex-prompt-submission-acceptance-reconciliation";
import type {
	RuntimeAgentConversationPromptSubmissionAcceptance,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskCardActionStartAgentSessionRequest,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import {
	type BacklogTaskStartReadinessReport,
	type BacklogTaskStartReadinessReview,
	backlogTaskStartReadinessDecisionSchema,
} from "../core/backlog-task-start-readiness-contract";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	readTaskAssistanceModelProviderRoutingSettings,
	resolveKanbanProviderAccess,
} from "../model-provider-access/kanban-model-provider-settings";
import { readTaskAssistancePreferredProviderRecovery } from "../model-provider-access/task-assistance-model-provider-routing";
import {
	getTaskEntries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../state/queued-task-prompt-delivery-store";
import { loadPersistedWorkspaceStateById } from "../state/workspace-state";
import {
	readTaskEditorCreationExplicitStop,
	readTaskEditorCreationExplicitStopAtLaunchBoundary,
} from "../task-editor-creation/task-editor-creation-submission-store";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import {
	assessBacklogTaskStartReadiness,
	BACKLOG_TASK_START_READINESS_RECENT_TASK_MAXIMUM_AGE_MS,
	waitingForBacklogTaskReadinessEvidence,
} from "./backlog-task-start-readiness-assessment";
import {
	backlogTaskStartReadinessFingerprint,
	collectBacklogTaskStartReadinessEvidence,
	collectRelatedBacklogTaskWorkSummaries,
	fingerprintBacklogTaskStartReadinessInput,
	fingerprintRelatedBacklogTaskWorkSummaries,
	readBacklogTaskRepositoryState,
	readRestrictedBacklogTaskReadinessEvidence,
	readSharedBacklogProjectRepositoryObservation,
} from "./backlog-task-start-readiness-evidence";

import {
	type BacklogTaskStartReadinessOperation,
	readBacklogTaskStartReadinessOperation,
	writeBacklogTaskStartReadinessOperation,
} from "./backlog-task-start-readiness-operation-store";

export class BacklogTaskStartReadinessRuntimeClosingError extends Error {
	constructor() {
		super("运行时正在关闭，原启动等待后继实例接续。");
	}
}

export function assertBacklogTaskStartNotStoppedAtLaunchBoundary(record: BacklogTaskStartReadinessOperation) {
	for (const workspaceId of [record.workspaceId, ...record.previousWorkspaceIds]) {
		const stoppedAt = readTaskEditorCreationExplicitStopAtLaunchBoundary(
			workspaceId,
			record.taskId,
			record.taskIncarnationCreatedAtEpochMs,
		);
		if (stoppedAt !== null && stoppedAt >= record.acceptedAtEpochMs)
			throw new TRPCError({ code: "PRECONDITION_FAILED", message: "用户已 Stop，原启动意图已撤销。" });
	}
}

let inFlightReadinessModelAvailability: ReturnType<typeof readReadinessModelAvailability> | undefined;
function observeReadinessModelAvailabilityFingerprint() {
	inFlightReadinessModelAvailability ??= readReadinessModelAvailability().finally(() => {
		inFlightReadinessModelAvailability = undefined;
	});
	return inFlightReadinessModelAvailability;
}

async function readReadinessModelAvailability() {
	try {
		const routing = await readTaskAssistanceModelProviderRoutingSettings();
		const providers = await Promise.all(
			[
				...new Set(
					[routing.preferredModelProviderId, routing.fallbackModelProviderId].filter((id): id is string =>
						Boolean(id),
					),
				),
			].map(async (id) => {
				const access = await resolveKanbanProviderAccess(id);
				if (!access?.profile.baseUrl || !access.apiKey) return [id, "not_configured"];
				let availability: string;
				try {
					const response = await fetch(`${access.profile.baseUrl.replace(/\/+$/u, "")}/models`, {
						method: "HEAD",
						headers: { Authorization: `Bearer ${access.apiKey}` },
						signal: AbortSignal.timeout(2000),
					});
					availability = `http_${response.status}`;
					await response.body?.cancel();
				} catch {
					availability = "unreachable";
				}
				// 只保存指纹，凭据、配置和网络探测正文都不进入报告。
				return [id, backlogTaskStartReadinessFingerprint([access.profile, access.apiKey]), availability];
			}),
		);
		const recovery = await readTaskAssistancePreferredProviderRecovery(routing);
		return {
			fingerprint: backlogTaskStartReadinessFingerprint([
				routing,
				providers,
				recovery?.cooldownUntilEpochMs === 0 ? recovery.lastFailure?.occurredAtEpochMs : null,
			]),
			cooldownUntilEpochMs: recovery?.cooldownUntilEpochMs ?? 0,
		};
	} catch {
		return { fingerprint: "model_configuration_unreadable", cooldownUntilEpochMs: 0 };
	}
}

function uniquePersistedReadOnlyEvidence(evidence: unknown[]) {
	const requests = new Map<
		string,
		{
			request: {
				kind: "read_repository_file" | "search_repository" | "read_task" | "read_task_git_changes";
				reference: string;
			};
			result: unknown;
		}
	>();
	for (const entry of evidence) {
		if (!entry || typeof entry !== "object" || !("request" in entry) || !("result" in entry)) continue;
		const parsed = backlogTaskStartReadinessDecisionSchema.shape.readOnlyEvidenceRequests.safeParse([entry.request]);
		if (parsed.success && parsed.data[0])
			requests.set(JSON.stringify(parsed.data[0]), { request: parsed.data[0], result: entry.result });
	}
	return [...requests.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, value]) => value);
}

function assertBacklogTaskShelvingAndStageAllowReadinessOperation(
	record: BacklogTaskStartReadinessOperation,
	card: RuntimeBoardCard,
	columnId: string,
) {
	const shelving = card.taskShelvingState;
	const shelvingBlocksStart =
		shelving?.isShelved &&
		(!record.startRequested ||
			columnId !== "backlog" ||
			shelving.lastChangedAt !== record.authorizedBacklogUnshelvingLastChangedAt);
	if (shelvingBlocksStart || card.taskClosureSummary || !["backlog", "in_progress"].includes(columnId))
		throw new TRPCError({ code: "PRECONDITION_FAILED", message: "任务已搁置、关闭或离开可启动阶段。" });
}

export async function assertBacklogTaskStartOperationEligible(
	record: BacklogTaskStartReadinessOperation,
	card: RuntimeBoardCard,
	columnId: string,
) {
	if (card.id !== record.taskId || card.createdAt !== record.taskIncarnationCreatedAtEpochMs)
		throw new TRPCError({ code: "CONFLICT", message: "任务身份已变化，旧开启操作不再执行。" });
	const stops = await Promise.all(
		[...new Set([record.workspaceId, ...record.previousWorkspaceIds])].map((workspaceId) =>
			readTaskEditorCreationExplicitStop(workspaceId, card.id, card.createdAt),
		),
	);
	const stoppedAt = stops.find((value) => value !== null && value >= record.acceptedAtEpochMs) ?? null;
	if (stoppedAt !== null && stoppedAt >= record.acceptedAtEpochMs) {
		record.startRequested = false;
		record.review.phase = "stopped";
		record.review.summary = "用户已 Stop，原启动意图已撤销。";
		await writeBacklogTaskStartReadinessOperation(record);
		throw new TRPCError({ code: "PRECONDITION_FAILED", message: record.review.summary });
	}
	assertBacklogTaskShelvingAndStageAllowReadinessOperation(record, card, columnId);
}

// 由目标卡片的命令串行器调用，保留原受理时间和各项目中的 Stop 证据。
export async function transferBacklogTaskStartReadinessIntentAfterMigration(
	scope: RuntimeTrpcWorkspaceScope,
	record: BacklogTaskStartReadinessOperation,
) {
	const source = await readBacklogTaskStartReadinessOperation(
		record.workspaceId,
		record.taskId,
		record.taskIncarnationCreatedAtEpochMs,
	);
	if (!source?.startRequested || source.review.operationId !== record.review.operationId) return null;
	if (source.agentProcessLaunchMayHaveBegunAtEpochMs) throw new Error("原启动事实尚未明确，不能跨项目重复启动。");
	const destination = await readBacklogTaskStartReadinessOperation(
		scope.workspaceId,
		source.taskId,
		source.taskIncarnationCreatedAtEpochMs,
	);
	const previousWorkspaceIds = [...new Set([...source.previousWorkspaceIds, source.workspaceId])];
	const stops = await Promise.all(
		[...previousWorkspaceIds, scope.workspaceId].map((workspaceId) =>
			readTaskEditorCreationExplicitStop(workspaceId, source.taskId, source.taskIncarnationCreatedAtEpochMs),
		),
	);
	const wasStopped = stops.some((stoppedAt) => stoppedAt !== null && stoppedAt >= source.acceptedAtEpochMs);
	const alreadyTransferred = destination?.review.operationId === source.review.operationId;
	const destinationHasOwnStart = destination?.startRequested || destination?.agentProcessLaunchMayHaveBegunAtEpochMs;
	let transferred: typeof source | null = null;
	if (!wasStopped && (!destinationHasOwnStart || alreadyTransferred)) {
		transferred = alreadyTransferred
			? destination
			: {
					...source,
					workspaceId: scope.workspaceId,
					workspacePath: scope.workspacePath,
					previousWorkspaceIds,
					authorizedBacklogUnshelvingLastChangedAt: undefined,
					reports: [...(destination?.reports ?? []), ...source.reports],
					lastDependencyFingerprint: null,
				};
		await writeBacklogTaskStartReadinessOperation(transferred);
	}
	source.startRequested = false;
	source.review.phase = wasStopped ? "stopped" : "invalidated";
	source.review.summary = wasStopped ? "用户已 Stop，迁移不会恢复原启动。" : "任务已迁移，原项目不再执行启动。";
	await writeBacklogTaskStartReadinessOperation(source);
	return transferred;
}

export async function prepareBacklogTaskStartReadiness(input: {
	scope: RuntimeTrpcWorkspaceScope;
	card: RuntimeBoardCard;
	board: RuntimeBoardData;
	request: RuntimeTaskCardActionStartAgentSessionRequest;
	evidence: KanbanRequestOriginActorEvidence;
	startRequested: boolean;
	taskEditorCreationStartAcceptedAtEpochMs?: number;
	authorizeUnshelvingForExplicitBacklogStart?: boolean;
	publishReview: (review: BacklogTaskStartReadinessReview | undefined) => Promise<void>;
}) {
	const { scope, card, request } = input;
	let record = await readBacklogTaskStartReadinessOperation(scope.workspaceId, card.id, card.createdAt);
	const authorizedBacklogUnshelvingLastChangedAt =
		input.authorizeUnshelvingForExplicitBacklogStart && card.taskShelvingState?.isShelved
			? card.taskShelvingState.lastChangedAt
			: undefined;
	const startAuthorizationChanged =
		input.startRequested &&
		(!record?.startRequested ||
			(authorizedBacklogUnshelvingLastChangedAt !== undefined &&
				record.authorizedBacklogUnshelvingLastChangedAt !== authorizedBacklogUnshelvingLastChangedAt));
	if (
		request.resumeBacklogTaskStartReadinessOperationId &&
		(record?.review.operationId !== request.resumeBacklogTaskStartReadinessOperationId || !record.startRequested)
	)
		throw new TRPCError({ code: "CONFLICT", message: "原启动操作已变化，不能接续过期操作。" });
	if (!input.startRequested && record?.startRequested)
		throw new TRPCError({ code: "CONFLICT", message: "已有待处理的启动请求，不能同时进行独立开启复核。" });
	if (!record || (record.review.phase === "stopped" && !request.resumeBacklogTaskStartReadinessOperationId)) {
		record = {
			schemaVersion: 1,
			workspaceId: scope.workspaceId,
			workspacePath: scope.workspacePath,
			taskId: card.id,
			taskIncarnationCreatedAtEpochMs: card.createdAt,
			acceptedAtEpochMs: Date.now(),
			startRequested: input.startRequested,
			acceptedStartRequest: { ...request, expectedTaskIncarnationCreatedAtEpochMs: card.createdAt },
			acceptedRequestOriginEvidence: input.evidence,
			review: { operationId: randomUUID(), phase: "reviewing", summary: "启动前复核", updatedAtEpochMs: Date.now() },
			reports: record?.reports ?? [],
			completedReadOnlyRoundCount: 0,
			readOnlyEvidence: [],
			lastDependencyFingerprint: null,
			sameDependencyAttemptCount: 0,
			nextAttemptAtEpochMs: 0,
			agentProcessLaunchMayHaveBegunAtEpochMs: null,
			previousWorkspaceIds: record?.previousWorkspaceIds ?? [],
			launchingSessionSnapshot: null,
			initialPromptSha256: null,
			appliedRevisionTaskFingerprint: null,
			failureHistory: record?.failureHistory ?? [],
			conditionOverrides: record?.conditionOverrides ?? [],
		};
	}
	if (startAuthorizationChanged) {
		record.startRequested = true;
		record.authorizedBacklogUnshelvingLastChangedAt = authorizedBacklogUnshelvingLastChangedAt;
		record.acceptedAtEpochMs = input.taskEditorCreationStartAcceptedAtEpochMs ?? Date.now();
		record.startRequestedByTaskEditorCreationSubmission = undefined;
		record.acceptedStartRequest = { ...request, expectedTaskIncarnationCreatedAtEpochMs: card.createdAt };
		record.acceptedRequestOriginEvidence = input.evidence;
	}
	if (input.taskEditorCreationStartAcceptedAtEpochMs !== undefined)
		record.startRequestedByTaskEditorCreationSubmission = true;
	await assertBacklogTaskStartOperationEligible(record, card, "backlog");
	const persist = async (publishAssessment = true) => {
		record.review.updatedAtEpochMs = Date.now();
		await writeBacklogTaskStartReadinessOperation(record);
		await input.publishReview(publishAssessment ? record.review : undefined);
	};
	const hasExplicitStartConditions = Boolean(card.backlogTaskStartReadinessConditionsText?.trim());
	const requestedConditionOverride = hasExplicitStartConditions
		? request.overrideUnmetBacklogTaskStartConditions
		: undefined;
	if (
		!hasExplicitStartConditions &&
		request.overrideUnmetBacklogTaskStartConditions &&
		!request.resumeBacklogTaskStartReadinessOperationId
	)
		throw new TRPCError({ code: "CONFLICT", message: "任务未声明开启条件，无可覆盖的条件。" });
	if (
		input.startRequested &&
		!hasExplicitStartConditions &&
		(record.startRequestedByTaskEditorCreationSubmission ||
			record.acceptedAtEpochMs - card.createdAt < BACKLOG_TASK_START_READINESS_RECENT_TASK_MAXIMUM_AGE_MS)
	) {
		record.unconditionedStartWithoutReadinessReviewTaskFingerprint = fingerprintBacklogTaskStartReadinessInput(card);
		record.review.phase = "ready";
		record.review.summary = "已受理直接启动，正在准备原会话。";
		record.nextAttemptAtEpochMs = 0;
		await persist(false);
		return { record, report: null, canStart: true };
	}
	const wasStartingWithoutReadinessReview = Boolean(record.unconditionedStartWithoutReadinessReviewTaskFingerprint);
	record.unconditionedStartWithoutReadinessReviewTaskFingerprint = undefined;
	if (!record.reports.length || wasStartingWithoutReadinessReview) {
		record.review.phase = "reviewing";
		record.review.summary = "启动前复核";
		await persist();
	} else if (startAuthorizationChanged) await writeBacklogTaskStartReadinessOperation(record);
	try {
		const [collected, modelAvailability] = await Promise.all([
			collectBacklogTaskStartReadinessEvidence({
				workspaceId: scope.workspaceId,
				repositoryPath: scope.workspacePath,
				card,
				board: input.board,
			}),
			observeReadinessModelAvailabilityFingerprint(),
		]);
		const evidenceRepositoryPath = collected.executionRepository
			? collected.executionRepositoryPath
			: scope.workspacePath;
		const taskFingerprint = fingerprintBacklogTaskStartReadinessInput(card);
		const priorReport = record.reports.at(-1);
		const buildDependencyBaseFingerprint = (assessedTaskFingerprint: string) =>
			backlogTaskStartReadinessFingerprint([
				assessedTaskFingerprint,
				collected.fingerprint,
				collected.executionRepositoryPath,
				collected.executionRepository?.fingerprint,
				collected.historyCoverage,
				collected.commitCountSinceCreation,
				collected.changedRepositoryPaths,
				collected.uncertaintyReasons,
				fingerprintRelatedBacklogTaskWorkSummaries(collected.relatedTaskSummaries),
				Math.floor(collected.taskAgeMs / BACKLOG_TASK_START_READINESS_RECENT_TASK_MAXIMUM_AGE_MS),
				modelAvailability.fingerprint,
			]);
		const observedReadOnlyEvidence = await Promise.all(
			uniquePersistedReadOnlyEvidence(record.readOnlyEvidence).map(async ({ request }) => ({
				request,
				result: await readRestrictedBacklogTaskReadinessEvidence({
					repositoryPath: evidenceRepositoryPath,
					projectRepositoryPath: scope.workspacePath,
					board: input.board,
					...request,
				}),
			})),
		);
		const buildDependencyFingerprint = (base: string) =>
			backlogTaskStartReadinessFingerprint([base, observedReadOnlyEvidence]);
		const priorAssessmentTaskFingerprint =
			priorReport && isBacklogTaskReadinessRevisionFromReport(card, priorReport)
				? priorReport.taskFingerprint
				: taskFingerprint;
		const priorAssessmentDependencyBaseFingerprint = buildDependencyBaseFingerprint(priorAssessmentTaskFingerprint);
		const priorAssessmentDependencyFingerprint = buildDependencyFingerprint(priorAssessmentDependencyBaseFingerprint);
		const dependencyBaseFingerprint =
			priorAssessmentDependencyFingerprint === record.lastDependencyFingerprint
				? priorAssessmentDependencyBaseFingerprint
				: buildDependencyBaseFingerprint(taskFingerprint);
		const dependencyFingerprint = buildDependencyFingerprint(dependencyBaseFingerprint);
		const dependenciesUnchanged =
			dependencyFingerprint === record.lastDependencyFingerprint &&
			(hasExplicitStartConditions || priorReport?.decision.conclusion !== "conditions_not_met");
		if (
			dependenciesUnchanged &&
			priorReport?.decision.conclusion === "waiting_for_evidence" &&
			modelAvailability.cooldownUntilEpochMs > Date.now()
		) {
			record.nextAttemptAtEpochMs = modelAvailability.cooldownUntilEpochMs;
			await writeBacklogTaskStartReadinessOperation(record);
			return { record, report: priorReport, canStart: false };
		}
		if (!dependenciesUnchanged) {
			if (priorReport) record.review.operationId = randomUUID();
			record.completedReadOnlyRoundCount = 0;
			record.readOnlyEvidence = [];
			record.sameDependencyAttemptCount = 0;
			record.lastDependencyFingerprint = dependencyFingerprint;
		}
		if (
			dependenciesUnchanged &&
			record.sameDependencyAttemptCount >= 3 &&
			priorReport?.decision.conclusion === "waiting_for_evidence" &&
			!requestedConditionOverride
		)
			return { record, report: priorReport, canStart: false };
		if (
			dependenciesUnchanged &&
			priorReport &&
			!["ready", "revise_remaining_work", "waiting_for_evidence"].includes(priorReport.decision.conclusion) &&
			!requestedConditionOverride
		) {
			if (priorReport.decision.conclusion === "no_remaining_work" && record.startRequested) {
				record.startRequested = false;
				await writeBacklogTaskStartReadinessOperation(record);
			}
			return { record, report: priorReport, canStart: false };
		}
		let decision =
			dependenciesUnchanged &&
			priorReport?.taskFingerprint === priorAssessmentTaskFingerprint &&
			priorReport.repositoryFingerprint === collected.fingerprint &&
			priorReport.decision.conclusion !== "waiting_for_evidence"
				? priorReport.decision
				: null;
		if (!decision && record.sameDependencyAttemptCount >= 3)
			decision = waitingForBacklogTaskReadinessEvidence(
				"同一证据的自动重试已用完，等待仓库、相关任务或辅助 AI 配置／可用性变化后接续。",
			);
		if (!decision) {
			record.review.phase = "reviewing";
			record.review.summary = "启动前复核";
			await persist();
			record.sameDependencyAttemptCount++;
			await writeBacklogTaskStartReadinessOperation(record);
			decision = await assessBacklogTaskStartReadiness(card, collected, {
				operationId: record.review.operationId,
				completedReadOnlyRoundCount: record.completedReadOnlyRoundCount,
				previousReadOnlyEvidence: record.readOnlyEvidence,
				readEvidence: async (request) => ({
					request,
					result: await readRestrictedBacklogTaskReadinessEvidence({
						repositoryPath: evidenceRepositoryPath,
						projectRepositoryPath: scope.workspacePath,
						board: input.board,
						...request,
					}),
				}),
				onReadOnlyRound: async (round, evidence) => {
					record.completedReadOnlyRoundCount = round;
					record.readOnlyEvidence = [...evidence];
					record.lastDependencyFingerprint = backlogTaskStartReadinessFingerprint([
						dependencyBaseFingerprint,
						uniquePersistedReadOnlyEvidence(record.readOnlyEvidence),
					]);
					await writeBacklogTaskStartReadinessOperation(record);
				},
			});
		}
		const report =
			priorReport && decision === priorReport.decision
				? priorReport
				: {
						operationId: record.review.operationId,
						workspaceId: scope.workspaceId,
						taskId: card.id,
						taskIncarnationCreatedAtEpochMs: card.createdAt,
						assessedAtEpochMs: Date.now(),
						taskFingerprint,
						repositoryFingerprint: collected.fingerprint,
						evidence: { ...collected, readOnlyEvidence: record.readOnlyEvidence },
						decision,
						previousTaskContent: {
							title: card.title,
							taskDescription: card.taskDescription,
							prompt: card.prompt,
						},
					};
		if (
			!priorReport ||
			backlogTaskStartReadinessFingerprint([
				priorReport.operationId,
				priorReport.taskFingerprint,
				priorReport.repositoryFingerprint,
				priorReport.decision,
			]) !==
				backlogTaskStartReadinessFingerprint([
					report.operationId,
					report.taskFingerprint,
					report.repositoryFingerprint,
					report.decision,
				])
		)
			record.reports.push(report);
		const override =
			requestedConditionOverride ??
			(hasExplicitStartConditions
				? record.conditionOverrides
						.filter(
							(entry) =>
								entry.operationId === record.review.operationId &&
								entry.dependencyFingerprint === dependencyFingerprint,
						)
						.at(-1)
				: undefined);
		if (override) {
			if (override.operationId !== record.review.operationId || decision.conclusion !== "conditions_not_met")
				throw new TRPCError({
					code: "CONFLICT",
					message: "只能显式覆盖当前复核中尚未满足的条件；其他门禁继续有效。",
				});
			if (
				requestedConditionOverride &&
				!record.conditionOverrides.some(
					(entry) => entry.operationId === override.operationId && entry.reason === override.reason,
				)
			)
				record.conditionOverrides.push({
					...override,
					dependencyFingerprint,
					acceptedAtEpochMs: Date.now(),
					requestOriginEvidence: input.evidence,
				});
		}
		if (decision.conclusion === "no_remaining_work") record.startRequested = false;
		record.review.phase = decision.conclusion === "revise_remaining_work" || override ? "ready" : decision.conclusion;
		record.review.summary = override ? `已显式覆盖开启条件：${override.reason}` : decision.summary;
		record.nextAttemptAtEpochMs = Date.now() + 15000 * Math.max(1, record.sameDependencyAttemptCount);
		await persist();
		return { record, report: record.reports.at(-1) ?? report, canStart: record.review.phase === "ready" };
	} catch (error) {
		if (error instanceof TRPCError) throw error;
		record.failureHistory.push({
			occurredAtEpochMs: Date.now(),
			message: error instanceof Error ? error.message : String(error),
		});
		record.review.phase = "waiting_for_evidence";
		record.review.summary = "证据暂不可读，保留启动意图并等待依赖恢复。";
		record.nextAttemptAtEpochMs = Date.now() + 15000;
		await persist();
		return { record, report: record.reports.at(-1) ?? null, canStart: false };
	}
}

export function isBacklogTaskReadinessRevisionFromReport(
	card: RuntimeBoardCard,
	report: BacklogTaskStartReadinessReport,
) {
	const revision = card.backlogTaskStartReadinessExecutionRevision;
	return (
		revision?.operationId === report.operationId &&
		revision.assessedAtEpochMs === report.assessedAtEpochMs &&
		revision.revisedTaskFingerprint === fingerprintBacklogTaskStartReadinessInput(card)
	);
}

export function assertBacklogTaskStartInputStillCurrent(
	record: BacklogTaskStartReadinessOperation,
	card: RuntimeBoardCard,
	columnId: string,
) {
	assertBacklogTaskShelvingAndStageAllowReadinessOperation(record, card, columnId);
	if (record.unconditionedStartWithoutReadinessReviewTaskFingerprint) {
		if (
			record.unconditionedStartWithoutReadinessReviewTaskFingerprint !==
			fingerprintBacklogTaskStartReadinessInput(card)
		)
			throw new TRPCError({ code: "CONFLICT", message: "启动准备期间任务已编辑，等待重新核验当前启动资格。" });
		return null;
	}
	const report = record.reports.at(-1);
	if (
		!report ||
		(report.taskFingerprint !== fingerprintBacklogTaskStartReadinessInput(card) &&
			!isBacklogTaskReadinessRevisionFromReport(card, report))
	)
		throw new TRPCError({ code: "CONFLICT", message: "复核期间任务已编辑，旧结果失效，等待重新复核。" });
	return report;
}

export async function assertBacklogTaskReadinessReportStillCurrent(
	record: BacklogTaskStartReadinessOperation,
	card: RuntimeBoardCard,
	columnId: string,
	launchingWorkspacePath?: string,
) {
	await assertBacklogTaskStartOperationEligible(record, card, columnId);
	const report = assertBacklogTaskStartInputStillCurrent(record, card, columnId);
	if (!report) return null;
	const readRepository =
		launchingWorkspacePath === undefined
			? readSharedBacklogProjectRepositoryObservation
			: readBacklogTaskRepositoryState;
	const repository = await readRepository(record.workspaceId, record.workspacePath, card.baseRef);
	if (repository.fingerprint !== report.repositoryFingerprint || !repository.repositoryStateAvailable)
		throw new TRPCError({ code: "CONFLICT", message: "复核期间仓库发生变化或状态未知，旧结果失效，等待重新复核。" });
	const assessedExecutionPath = report.evidence.executionRepositoryPath;
	const assessedExecutionRepository = report.evidence.executionRepository;
	let evidenceRepositoryPath = record.workspacePath;
	if (launchingWorkspacePath !== undefined) {
		if (assessedExecutionPath !== launchingWorkspacePath)
			throw new TRPCError({ code: "CONFLICT", message: "实际启动目录与复核目录不一致，等待重新复核。" });
		const executionRepository =
			launchingWorkspacePath === record.workspacePath
				? repository
				: await readBacklogTaskRepositoryState(record.workspaceId, launchingWorkspacePath, card.baseRef);
		const matchesAssessedWorktree = assessedExecutionRepository
			? typeof assessedExecutionRepository === "object" &&
				"fingerprint" in assessedExecutionRepository &&
				executionRepository.fingerprint === assessedExecutionRepository.fingerprint
			: executionRepository.currentRepository.gitCommonDirectoryPath ===
					repository.currentRepository.gitCommonDirectoryPath &&
				executionRepository.headCommit === repository.currentRepository.commit &&
				repository.headCommit === repository.currentRepository.commit &&
				!executionRepository.hasWorkingTreeChanges &&
				!repository.hasWorkingTreeChanges;
		if (!matchesAssessedWorktree || !executionRepository.repositoryStateAvailable)
			throw new TRPCError({ code: "CONFLICT", message: "实际任务工作树的状态未纳入当前复核，等待重新复核。" });
		evidenceRepositoryPath = launchingWorkspacePath;
	} else if (typeof assessedExecutionPath === "string" && assessedExecutionRepository) {
		evidenceRepositoryPath = assessedExecutionPath;
	}
	const currentState = await loadPersistedWorkspaceStateById(record.workspaceId);
	if (
		fingerprintRelatedBacklogTaskWorkSummaries(collectRelatedBacklogTaskWorkSummaries(currentState.board, card)) !==
		fingerprintRelatedBacklogTaskWorkSummaries(report.evidence.relatedTaskSummaries)
	)
		throw new TRPCError({ code: "CONFLICT", message: "复核期间相关任务发生变化，旧结果失效。" });
	const readOnlyEvidence = uniquePersistedReadOnlyEvidence(
		Array.isArray(report.evidence.readOnlyEvidence) ? report.evidence.readOnlyEvidence : [],
	);
	const currentReadOnlyEvidence = await Promise.all(
		readOnlyEvidence.map(async ({ request }) => ({
			request,
			result: await readRestrictedBacklogTaskReadinessEvidence({
				repositoryPath: evidenceRepositoryPath,
				projectRepositoryPath: record.workspacePath,
				board: currentState.board,
				...request,
			}),
		})),
	);
	if (
		backlogTaskStartReadinessFingerprint(currentReadOnlyEvidence) !==
		backlogTaskStartReadinessFingerprint(readOnlyEvidence)
	)
		throw new TRPCError({ code: "CONFLICT", message: "复核引用的文件或未合入任务工作已变化，旧结果失效。" });
	await assertBacklogTaskStartOperationEligible(record, card, columnId);
	return report;
}

export async function observeBacklogTaskInitialLaunchReceipt(
	record: BacklogTaskStartReadinessOperation,
	session: RuntimeTaskSessionSummary | null | undefined,
	additionalSessions: ReadonlyArray<RuntimeTaskSessionSummary | null | undefined> = [],
) {
	const launchTimestamp = record.agentProcessLaunchMayHaveBegunAtEpochMs;
	const prepared = record.launchingSessionSnapshot;
	const generation = prepared?.runtimeSessionIncarnationId;
	const promptSha256 = record.initialPromptSha256;
	if (launchTimestamp === null || !prepared || !generation || !promptSha256) return false;

	const knownSessions = [session, ...additionalSessions].filter(
		(candidate): candidate is RuntimeTaskSessionSummary => candidate != null,
	);
	const sameGenerationSession = knownSessions.find(
		(candidate) => candidate.taskId === prepared.taskId && candidate.runtimeSessionIncarnationId === generation,
	);
	const observed = sameGenerationSession ?? prepared;
	const persistedLaunchReceiptVerification = prepared.agentConversationPromptSubmissionAcceptance?.verification;
	const persistedOriginalGenerationEventId = persistedLaunchReceiptVerification?.requiredNativeEventId;
	let differentGenerationLacksStart = false;
	// 后续摘要会替换旧摘要。已知的第一条换代边界只允许收紧。
	let exclusiveAcceptedBeforeMs = persistedLaunchReceiptVerification?.exclusiveAcceptedBeforeMs;
	for (const candidate of knownSessions) {
		if (candidate.taskId !== prepared.taskId || candidate.runtimeSessionIncarnationId === generation) continue;
		if (typeof candidate.startedAt !== "number" || !Number.isFinite(candidate.startedAt)) {
			differentGenerationLacksStart = true;
			continue;
		}
		exclusiveAcceptedBeforeMs =
			exclusiveAcceptedBeforeMs === undefined
				? candidate.startedAt
				: Math.min(exclusiveAcceptedBeforeMs, candidate.startedAt);
	}
	const originalGenerationEventId =
		persistedOriginalGenerationEventId ??
		[observed, prepared]
			.map((summary) => summary.agentConversationPromptSubmissionAcceptance)
			.find(
				(candidate) =>
					candidate?.runtimeSessionIncarnationId === generation &&
					candidate.attemptedAtMs >= launchTimestamp &&
					typeof candidate.eventId === "string" &&
					candidate.eventId.length > 0,
			)?.eventId;
	const launchReceiptCandidates = [
		prepared.agentConversationPromptSubmissionAcceptance,
		observed.agentConversationPromptSubmissionAcceptance,
	].filter(
		(candidate): candidate is RuntimeAgentConversationPromptSubmissionAcceptance =>
			candidate?.runtimeSessionIncarnationId === generation &&
			candidate.attemptedAtMs >= launchTimestamp &&
			candidate.submittedPromptSha256 === promptSha256,
	);
	if (
		launchReceiptCandidates.some(
			(candidate) =>
				candidate.status === "accepted" &&
				(candidate.confirmedAtMs ?? 0) >= launchTimestamp &&
				(!persistedOriginalGenerationEventId || candidate.eventId === persistedOriginalGenerationEventId),
		)
	)
		return true;

	try {
		const queue = await readWorkspaceQueuedTaskPromptDeliverySnapshot(record.workspaceId).catch(() => null);
		if (
			queue &&
			getTaskEntries(queue, prepared.taskId).some(
				(entry) =>
					entry.managedDelivery?.messageType === "session_startup" &&
					entry.managedDelivery.targetRuntimeSessionIncarnationId === generation &&
					entry.managedDelivery.terminalDeliveryReceipt?.status === "delivered_and_submit_confirmed" &&
					submittedPromptSha256(entry.text, "preserve_internal_whitespace") === promptSha256,
			)
		)
			return true;

		const nativeIdentity =
			observed.agentNativeConversationSessionIdentity ?? prepared.agentNativeConversationSessionIdentity;
		// 换代后若不知道新代次何时开始，共享转录里的同文记录无法归给原代次。
		if (prepared.agentId === "codex" && nativeIdentity?.sourceAgentId === "codex" && !differentGenerationLacksStart) {
			// 摘要可能没有正文摘要，或已被后续提交覆盖。沿原启动的代次、时刻和正文摘要只读核对。
			const candidate = launchReceiptCandidates.find(
				(candidate) =>
					candidate.status !== "accepted" &&
					(!candidate.nativeSessionId || candidate.nativeSessionId === nativeIdentity.nativeSessionId),
			) ?? {
				status: "pending" as const,
				attemptedAtMs: launchTimestamp,
				runtimeSessionIncarnationId: generation,
				nativeSessionId: nativeIdentity.nativeSessionId,
				submittedPromptSha256: promptSha256,
			};
			const observation = await reconcileCodexPromptSubmissionAcceptance({
				summary: {
					...prepared,
					agentNativeConversationSessionIdentity: nativeIdentity,
					agentConversationPromptSubmissionAcceptance: candidate,
				},
				observedAtMs: Date.now(),
				maximumReadBytes: 256000,
				requiredNativeEventId: originalGenerationEventId,
				exclusiveAcceptedBeforeMs,
			});
			if (observation) {
				record.launchingSessionSnapshot = {
					...prepared,
					agentNativeConversationSessionIdentity: observation.verification.transcriptCursor
						?.verifiedSessionMetadata
						? nativeIdentity
						: prepared.agentNativeConversationSessionIdentity,
					agentConversationPromptSubmissionAcceptance: {
						...candidate,
						verification: observation.verification,
						...(observation.accepted
							? {
									status: "accepted",
									confirmedAtMs: observation.accepted.acceptedAtMs,
									eventId: observation.accepted.eventId,
								}
							: {}),
					},
				};
				await writeBacklogTaskStartReadinessOperation(record);
				return Boolean(observation.accepted);
			}
		}
	} catch {
		/* 原生记录或投递回执暂不可读时保留未知，不启动新进程补证。 */
	}
	return false;
}
