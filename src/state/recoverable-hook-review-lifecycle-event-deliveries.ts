import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
	type RuntimeHookIngestRequest,
	type RuntimeHookIngestResponse,
	type RuntimeTaskSessionSummary,
	runtimeHookIngestRequestSchema,
} from "../core/api-contract";
import {
	projectRecoverableHookReviewLifecycleEvent,
	type RecoverableHookReviewLifecycleEvent,
	resolveHookReviewLifecyclePromptSubmissionOrdering,
} from "../core/recoverable-hook-review-lifecycle-event";
import {
	canObserveCompletedAgentTurnForCurrentUnacceptedPromptSubmission,
	isParkedAwaitingDispatchedBackgroundWork,
	resolveSessionFacets,
} from "../core/session-activity";
import { lockedFileSystem } from "../fs/locked-file-system";
import { assertWorkspaceBackgroundStateWritesAreAllowed } from "./duplicate-project-consolidation-status";

const DEFAULT_RUNTIME_PROCESS_INSTANCE_OBSERVATION_ID = randomUUID();

const deliverySchema = z
	.object({
		deliveryIdempotencyKey: z.string(),
		requestFingerprint: z.string(),
		receivedSequenceNumber: z.number().int().nonnegative(),
		admittedAtEpochMs: z.number(),
		admissionRuntimeProcessInstanceId: z.string().uuid(),
		applicationAttemptRuntimeProcessInstanceIds: z.array(z.string().uuid()),
		applicationConfirmationRuntimeProcessInstanceId: z.string().uuid().nullable(),
		applicationConfirmedAtEpochMs: z.number().nullable(),
		request: runtimeHookIngestRequestSchema.transform((request, context) => {
			const projection = projectRecoverableHookReviewLifecycleEvent(request);
			if (projection) return projection;
			context.addIssue({ code: "custom", message: "恢复文件包含不受支持的生命周期事件。" });
			return z.NEVER;
		}),
		taskIncarnationCreatedAtEpochMs: z.number().nullable(),
		nativeSessionId: z.string().nullable(),
		agentTurnSequence: z.number().nullable(),
		// null 表示受理前没有同毫秒原提交；字段缺失表示没有足够身份观测。
		unacceptedPromptSubmissionIdObservedBeforeAdmission: z.string().min(1).nullable().optional(),
		status: z.enum([
			"pending_application",
			"waiting_for_recovery_evidence",
			"application_started_confirmation_pending",
			"application_confirmed",
			"permanently_rejected",
			"superseded_by_newer_session_state",
		]),
		attemptsStartedInRecoveryCycle: z.number().int().nonnegative(),
		recoveryEvidenceFingerprint: z.string().nullable(),
		snapshotCommitReadinessEvidence: z.string().nullable(),
		nextCheckAtEpochMs: z.number(),
		reviewNotificationReconciliationCompleted: z.boolean(),
		applicationConfirmedNotificationCandidateId: z.string().uuid(),
		failureHistory: z.array(
			z.object({
				observedAtEpochMs: z.number(),
				failureKind: z.string(),
				failureCode: z.string(),
			}),
		),
	})
	.strict();
export type RecoverableHookReviewLifecycleEventDelivery = z.infer<typeof deliverySchema>;
// shortcut: 终结记录持续保留；体量影响读取时，需归档并保留原有去重凭据与失败历史。
const deliveryFileSchema = z
	.object({
		schemaVersion: z.literal(1),
		nextSequenceNumber: z.number().int().positive(),
		deliveries: z.array(deliverySchema),
	})
	.strict();
type DeliveryFile = z.infer<typeof deliveryFileSchema>;

export interface RecoverableHookReviewLifecycleTarget {
	taskIncarnationCreatedAtEpochMs: number | null;
	isTaskExecutionAllowed: boolean;
	summary: RuntimeTaskSessionSummary | null;
	persistedSummary?: RuntimeTaskSessionSummary | null;
	recoveryEvidenceFingerprint: string;
}

export interface RecoverableHookReviewLifecycleApplicationBoundary {
	isRecovery: boolean;
	canRecordHistoricalAgentTurnCompletion: boolean;
	unacceptedPromptSubmissionIdObservedBeforeAdmission?: string | null;
	confirmApplication: () => Promise<void>;
}
export type RecoverableHookReviewLifecycleApplication = (
	request: RuntimeHookIngestRequest,
	boundary?: RecoverableHookReviewLifecycleApplicationBoundary,
) => Promise<RuntimeHookIngestResponse>;

interface RecoverableHookReviewLifecycleEventDeliveriesOptions {
	runtimeProcessInstanceId?: string;
	getWorkspaceDeliveryFilePath: (workspaceId: string) => string;
	isMainTaskConversationSession?: (request: RuntimeHookIngestRequest) => Promise<boolean>;
	readTarget: (request: RuntimeHookIngestRequest) => Promise<RecoverableHookReviewLifecycleTarget>;
	probeSnapshotCommitReadiness?: (request: RecoverableHookReviewLifecycleEvent) => Promise<string>;
	persistApplicationConfirmation: (
		request: RecoverableHookReviewLifecycleEvent,
		taskIncarnationCreatedAtEpochMs: number,
	) => Promise<void>;
	onApplicationConfirmed: (
		request: RecoverableHookReviewLifecycleEvent,
		notificationCandidateId: string,
		unacceptedPromptSubmissionIdObservedBeforeAdmission?: string | null,
	) => Promise<void>;
	warn: (message: string) => void;
	readNow?: () => number;
	waitBeforeRetry?: (milliseconds: number) => Promise<void>;
}

function isTerminal(delivery: RecoverableHookReviewLifecycleEventDelivery): boolean {
	return ["application_confirmed", "permanently_rejected", "superseded_by_newer_session_state"].includes(
		delivery.status,
	);
}

function hasSnapshotStorageFailure(delivery: RecoverableHookReviewLifecycleEventDelivery): boolean {
	return ["EIO", "EACCES", "ENOSPC", "EROFS", "ELOCKED", "SQLITE_BUSY", "SQLITE_LOCKED"].includes(
		delivery.failureHistory.at(-1)?.failureCode ?? "",
	);
}

function fingerprintRequest(request: RuntimeHookIngestRequest): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				request.workspaceId,
				request.taskId,
				request.hookRuntimeSessionIncarnationId,
				request.hookEventCapturedAtEpochMs,
				request.metadata?.source,
				request.metadata?.hookEventName,
				request.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
				request.agentNativeConversationSessionIdentity?.sourceAgentId ?? null,
			]),
		)
		.digest("hex");
}

export class RecoverableHookReviewLifecycleEventDeliveries {
	private readonly inFlightApplications = new Map<string, Promise<RuntimeHookIngestResponse>>();
	private stopping = false;
	private readonly readNow: () => number;
	private readonly runtimeProcessInstanceId: string;
	constructor(private readonly options: RecoverableHookReviewLifecycleEventDeliveriesOptions) {
		this.readNow = options.readNow ?? Date.now;
		this.runtimeProcessInstanceId =
			options.runtimeProcessInstanceId ?? DEFAULT_RUNTIME_PROCESS_INSTANCE_OBSERVATION_ID;
	}

	private async readFile(workspaceId: string): Promise<DeliveryFile> {
		try {
			const file = deliveryFileSchema.parse(
				JSON.parse(await readFile(this.options.getWorkspaceDeliveryFilePath(workspaceId), "utf8")),
			);
			// 损坏或旧版本的正文不能在恢复时混入可执行投影。
			const receivedSequences = new Set<number>();
			const deliveryKeys = new Set<string>();
			for (const delivery of file.deliveries) {
				const projection = projectRecoverableHookReviewLifecycleEvent(delivery.request);
				if (
					!projection ||
					projection.workspaceId !== workspaceId ||
					projection.hookEventDeliveryIdempotencyKey !== delivery.deliveryIdempotencyKey ||
					fingerprintRequest(projection) !== delivery.requestFingerprint ||
					receivedSequences.has(delivery.receivedSequenceNumber) ||
					deliveryKeys.has(delivery.deliveryIdempotencyKey) ||
					delivery.receivedSequenceNumber >= file.nextSequenceNumber
				)
					throw new Error("生命周期恢复记录身份校验失败。");
				receivedSequences.add(delivery.receivedSequenceNumber);
				deliveryKeys.add(delivery.deliveryIdempotencyKey);
				delivery.request = projection;
			}
			return file;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { schemaVersion: 1, nextSequenceNumber: 1, deliveries: [] };
			throw error;
		}
	}

	async list(workspaceId: string): Promise<RecoverableHookReviewLifecycleEventDelivery[]> {
		return (await this.readFile(workspaceId)).deliveries;
	}

	async probeWorkspaceHookReviewLifecycleEventDeliveryAdmissionLockReadiness(workspaceId: string): Promise<string> {
		try {
			// 只探测受理所用的同一把内核锁；无写入释放锁也必须产生恢复证据。
			await lockedFileSystem.withLock(
				{ path: this.options.getWorkspaceDeliveryFilePath(workspaceId), retries: { retries: 0 } },
				async () => undefined,
			);
			return "lifecycle_admission_lock_available";
		} catch (error) {
			return `lifecycle_admission_unavailable:${String((error as NodeJS.ErrnoException).code ?? "UNKNOWN")}`;
		}
	}

	private async mutate<T>(workspaceId: string, mutation: (file: DeliveryFile) => T): Promise<T> {
		const path = this.options.getWorkspaceDeliveryFilePath(workspaceId);
		return await lockedFileSystem.withLock({ path }, async () => {
			await assertWorkspaceBackgroundStateWritesAreAllowed(workspaceId);
			const file = await this.readFile(workspaceId);
			const result = mutation(file);
			await lockedFileSystem.writeJsonFileAtomic(path, file, { lock: null, durable: true, fileMode: 0o600 });
			return result;
		});
	}

	private async save(delivery: RecoverableHookReviewLifecycleEventDelivery): Promise<void> {
		await this.mutate(delivery.request.workspaceId, (file) => {
			const index = file.deliveries.findIndex(
				(entry) => entry.deliveryIdempotencyKey === delivery.deliveryIdempotencyKey,
			);
			if (index < 0) throw new Error("生命周期恢复记录已失去归属。");
			file.deliveries[index] = delivery;
		});
	}

	async ingest(
		request: RuntimeHookIngestRequest,
		apply: RecoverableHookReviewLifecycleApplication,
		isRecovery = false,
	): Promise<RuntimeHookIngestResponse> {
		const projection = projectRecoverableHookReviewLifecycleEvent(request);
		if (!projection) return await apply(request);
		if (this.stopping)
			return { ok: false, failureKind: "runtime_dependency_unavailable", error: "运行时正在停止接收生命周期事件。" };
		try {
			const alreadyAdmitted = (await this.list(projection.workspaceId)).some(
				(entry) => entry.deliveryIdempotencyKey === projection.hookEventDeliveryIdempotencyKey,
			);
			if (
				!alreadyAdmitted &&
				this.options.isMainTaskConversationSession &&
				!(await this.options.isMainTaskConversationSession(projection))
			) {
				return await apply(request);
			}
			let unacceptedPromptSubmissionIdObservedBeforeAdmission: string | null | undefined;
			if (!alreadyAdmitted) {
				try {
					const { summary } = await this.options.readTarget(projection);
					const submission = summary?.agentConversationPromptSubmissionAcceptance;
					const capturedAtEpochMs = Math.min(projection.hookEventCapturedAtEpochMs, this.readNow());
					if (summary?.runtimeSessionIncarnationId === projection.hookRuntimeSessionIncarnationId) {
						if (submission?.attemptedAtMs !== capturedAtEpochMs)
							unacceptedPromptSubmissionIdObservedBeforeAdmission = null;
						else if (canObserveCompletedAgentTurnForCurrentUnacceptedPromptSubmission(summary, capturedAtEpochMs))
							unacceptedPromptSubmissionIdObservedBeforeAdmission = submission.submissionId;
					}
				} catch {
					// 观测不可用仍先持久受理；后续同毫秒歧义保持未知，不阻断其他事件。
				}
			}
			const delivery = await this.mutate(projection.workspaceId, (file) => {
				const existing = file.deliveries.find(
					(entry) => entry.deliveryIdempotencyKey === projection.hookEventDeliveryIdempotencyKey,
				);
				if (existing) {
					if (
						existing.requestFingerprint !==
						fingerprintRequest({
							...projection,
							hookEventCapturedAtEpochMs: Math.min(
								projection.hookEventCapturedAtEpochMs,
								existing.admittedAtEpochMs,
							),
						})
					)
						throw new Error("生命周期投递幂等标识与原事件不一致。");
					return existing;
				}
				// 已受理的记录永不为新事件让位；容量不足让发送者保留原条目。
				if (file.deliveries.filter((entry) => !isTerminal(entry)).length >= 512)
					throw new Error("生命周期恢复待对账容量已满。");
				const admittedAtEpochMs = this.readNow();
				const acceptedProjection = {
					...projection,
					hookEventCapturedAtEpochMs: Math.min(projection.hookEventCapturedAtEpochMs, admittedAtEpochMs),
				};
				const admitted: RecoverableHookReviewLifecycleEventDelivery = {
					deliveryIdempotencyKey: projection.hookEventDeliveryIdempotencyKey,
					requestFingerprint: fingerprintRequest(acceptedProjection),
					admittedAtEpochMs,
					admissionRuntimeProcessInstanceId: this.runtimeProcessInstanceId,
					applicationAttemptRuntimeProcessInstanceIds: [],
					applicationConfirmationRuntimeProcessInstanceId: null,
					applicationConfirmedAtEpochMs: null,
					receivedSequenceNumber: file.nextSequenceNumber++,
					request: {
						...acceptedProjection,
						notificationCandidateId: projection.notificationCandidateId ?? randomUUID(),
					},
					taskIncarnationCreatedAtEpochMs: null,
					nativeSessionId: null,
					agentTurnSequence: null,
					unacceptedPromptSubmissionIdObservedBeforeAdmission,
					status: "pending_application",
					attemptsStartedInRecoveryCycle: 0,
					recoveryEvidenceFingerprint: null,
					snapshotCommitReadinessEvidence: null,
					nextCheckAtEpochMs: 0,
					reviewNotificationReconciliationCompleted: false,
					applicationConfirmedNotificationCandidateId: randomUUID(),
					failureHistory: [],
				};
				file.deliveries.push(admitted);
				return admitted;
			});
			return await this.runSingleApplication(delivery, apply, isRecovery, request);
		} catch (error) {
			this.options.warn(
				`生命周期事件未能持久受理，发送者须保留原条目：${error instanceof Error ? error.message : String(error)}`,
			);
			return { ok: false, failureKind: "runtime_dependency_unavailable", error: "生命周期事件尚未确认持久受理。" };
		}
	}

	private async runSingleApplication(
		delivery: RecoverableHookReviewLifecycleEventDelivery,
		apply: RecoverableHookReviewLifecycleApplication,
		isRecovery: boolean,
		requestAtDirectAdmission?: RuntimeHookIngestRequest,
	): Promise<RuntimeHookIngestResponse> {
		const key = JSON.stringify([delivery.request.workspaceId, delivery.deliveryIdempotencyKey]);
		const existing = this.inFlightApplications.get(key);
		if (existing) return await existing;
		const application = lockedFileSystem
			.withLock(
				{
					path: `${this.options.getWorkspaceDeliveryFilePath(delivery.request.workspaceId)}.${createHash("sha256").update(key).digest("hex")}.application`,
					retries: { retries: 0 },
				},
				async () => {
					const current = (await this.list(delivery.request.workspaceId)).find(
						(entry) => entry.deliveryIdempotencyKey === delivery.deliveryIdempotencyKey,
					);
					if (!current) throw new Error("生命周期投递记录不存在。");
					return await this.applyWithinOwnership(current, apply, isRecovery, requestAtDirectAdmission);
				},
			)
			.catch((error: unknown): RuntimeHookIngestResponse => {
				this.options.warn(`生命周期事件保留待对账：${error instanceof Error ? error.message : String(error)}`);
				return { ok: true, lifecycleEventDeliveryStatus: "durably_accepted_pending_application" };
			});
		this.inFlightApplications.set(key, application);
		try {
			return await application;
		} finally {
			this.inFlightApplications.delete(key);
		}
	}

	private response(delivery: RecoverableHookReviewLifecycleEventDelivery): RuntimeHookIngestResponse {
		return {
			ok: delivery.status !== "permanently_rejected",
			lifecycleEventDeliveryStatus:
				delivery.status === "application_confirmed"
					? "application_confirmed"
					: delivery.status === "superseded_by_newer_session_state"
						? "superseded_by_newer_session_state"
						: delivery.status === "permanently_rejected"
							? "permanently_rejected"
							: "durably_accepted_pending_application",
			...(delivery.status === "permanently_rejected"
				? { failureKind: "permanent_business_rejection" as const, error: "生命周期事件已确定拒绝，保留失败记录。" }
				: {}),
		};
	}

	private async confirmApplication(delivery: RecoverableHookReviewLifecycleEventDelivery): Promise<void> {
		delivery.status = "application_confirmed";
		delivery.applicationConfirmationRuntimeProcessInstanceId = this.runtimeProcessInstanceId;
		delivery.applicationConfirmedAtEpochMs ??= this.readNow();
		await this.save(delivery);
	}

	private async applyWithinOwnership(
		delivery: RecoverableHookReviewLifecycleEventDelivery,
		apply: RecoverableHookReviewLifecycleApplication,
		isRecovery: boolean,
		requestAtDirectAdmission?: RuntimeHookIngestRequest,
	): Promise<RuntimeHookIngestResponse> {
		if (isTerminal(delivery)) {
			await this.completeNotification(delivery, requestAtDirectAdmission);
			return this.response(delivery);
		}
		isRecovery ||= delivery.admissionRuntimeProcessInstanceId !== this.runtimeProcessInstanceId;
		let target = await this.options.readTarget(delivery.request);
		if (this.stopping) return this.response(delivery);
		const summary = target.summary;
		const nativeIdentity =
			summary?.agentNativeConversationSessionIdentity ??
			(delivery.request.agentNativeConversationSessionIdentity?.sourceAgentId === summary?.agentId
				? delivery.request.agentNativeConversationSessionIdentity
				: undefined);
		const receipt = [target.persistedSummary].find(
			(candidate) =>
				candidate?.lastAppliedHookReviewLifecycleEventDelivery?.deliveryIdempotencyKey ===
					delivery.deliveryIdempotencyKey &&
				candidate.lastAppliedHookReviewLifecycleEventDelivery.runtimeSessionIncarnationId ===
					delivery.request.hookRuntimeSessionIncarnationId,
		);
		const hasPersistedApplicationReceipt = Boolean(
			receipt &&
				target.taskIncarnationCreatedAtEpochMs !== null &&
				delivery.taskIncarnationCreatedAtEpochMs === target.taskIncarnationCreatedAtEpochMs,
		);
		const promptSubmissionOrdering = summary
			? resolveHookReviewLifecyclePromptSubmissionOrdering(
					summary,
					delivery.request.hookEventCapturedAtEpochMs,
					delivery.unacceptedPromptSubmissionIdObservedBeforeAdmission,
				)
			: "unknown";
		if (target.taskIncarnationCreatedAtEpochMs === null) {
			delivery.status = "permanently_rejected";
			await this.save(delivery);
			return this.response(delivery);
		}
		if (
			!hasPersistedApplicationReceipt &&
			(!target.isTaskExecutionAllowed ||
				(delivery.taskIncarnationCreatedAtEpochMs !== null &&
					delivery.taskIncarnationCreatedAtEpochMs !== target.taskIncarnationCreatedAtEpochMs) ||
				(summary?.runtimeSessionIncarnationId &&
					summary.runtimeSessionIncarnationId !== delivery.request.hookRuntimeSessionIncarnationId) ||
				(delivery.nativeSessionId &&
					nativeIdentity &&
					delivery.nativeSessionId !== nativeIdentity.nativeSessionId) ||
				(delivery.request.agentNativeConversationSessionIdentity &&
					summary?.agentId &&
					delivery.request.agentNativeConversationSessionIdentity.sourceAgentId !== summary.agentId) ||
				(delivery.request.agentNativeConversationSessionIdentity &&
					nativeIdentity &&
					delivery.request.agentNativeConversationSessionIdentity.nativeSessionId !==
						nativeIdentity.nativeSessionId) ||
				(summary &&
					(summary.agentResponseGenerationTurnStarted?.startedAt ?? 0) >
						delivery.request.hookEventCapturedAtEpochMs) ||
				promptSubmissionOrdering === "superseded" ||
				(delivery.agentTurnSequence !== null &&
					(summary?.agentResponseGenerationTurnSequence ?? 0) > delivery.agentTurnSequence))
		) {
			delivery.status = "superseded_by_newer_session_state";
			await this.save(delivery);
			return this.response(delivery);
		}
		if (!hasPersistedApplicationReceipt && summary && promptSubmissionOrdering === "unknown") {
			if (
				delivery.status !== "waiting_for_recovery_evidence" ||
				delivery.recoveryEvidenceFingerprint !== target.recoveryEvidenceFingerprint
			) {
				delivery.status = "waiting_for_recovery_evidence";
				delivery.recoveryEvidenceFingerprint = target.recoveryEvidenceFingerprint;
				delivery.nextCheckAtEpochMs = this.readNow() + 15_000;
				await this.save(delivery);
			}
			return this.response(delivery);
		}
		if (
			!hasPersistedApplicationReceipt &&
			(!summary?.runtimeSessionIncarnationId ||
				!nativeIdentity ||
				isParkedAwaitingDispatchedBackgroundWork(summary) ||
				["waiting_backoff", "waiting_machine_evidence", "sending", "reconciling_acceptance", "executing"].includes(
					summary.automaticAgentFailureContinuation?.phase ?? "",
				))
		) {
			delivery.status = "waiting_for_recovery_evidence";
			delivery.nextCheckAtEpochMs = this.readNow() + 15_000;
			await this.save(delivery);
			return this.response(delivery);
		}
		const snapshotCommitReadinessEvidence =
			delivery.status === "waiting_for_recovery_evidence" &&
			hasSnapshotStorageFailure(delivery) &&
			this.options.probeSnapshotCommitReadiness
				? ((await this.options.probeSnapshotCommitReadiness?.(delivery.request)) ?? null)
				: delivery.snapshotCommitReadinessEvidence;
		if (
			delivery.status === "waiting_for_recovery_evidence" &&
			delivery.recoveryEvidenceFingerprint === target.recoveryEvidenceFingerprint &&
			delivery.snapshotCommitReadinessEvidence === snapshotCommitReadinessEvidence
		)
			return this.response(delivery);
		if (
			delivery.recoveryEvidenceFingerprint !== target.recoveryEvidenceFingerprint ||
			delivery.snapshotCommitReadinessEvidence !== snapshotCommitReadinessEvidence
		) {
			delivery.attemptsStartedInRecoveryCycle = 0;
			delivery.recoveryEvidenceFingerprint = target.recoveryEvidenceFingerprint;
			delivery.snapshotCommitReadinessEvidence = snapshotCommitReadinessEvidence;
		}
		const taskIncarnationCreatedAtEpochMs = target.taskIncarnationCreatedAtEpochMs;
		delivery.taskIncarnationCreatedAtEpochMs = taskIncarnationCreatedAtEpochMs;
		delivery.nativeSessionId ??= nativeIdentity?.nativeSessionId ?? null;
		delivery.agentTurnSequence ??= summary?.agentResponseGenerationTurnSequence ?? 0;
		while (!this.stopping && delivery.attemptsStartedInRecoveryCycle < 3) {
			if (delivery.attemptsStartedInRecoveryCycle > 0)
				await (this.options.waitBeforeRetry ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
					delivery.attemptsStartedInRecoveryCycle === 1 ? 100 : 400,
				);
			// 每次副作用前再核对：等待锁、退避与读盘期间可能换代或出现新输入。
			target = await this.options.readTarget(delivery.request);
			if (this.stopping) break;
			const currentSummary = target.summary;
			if (!currentSummary && !hasPersistedApplicationReceipt) break;
			if (
				!hasPersistedApplicationReceipt &&
				currentSummary &&
				(!target.isTaskExecutionAllowed ||
					target.taskIncarnationCreatedAtEpochMs !== delivery.taskIncarnationCreatedAtEpochMs ||
					currentSummary.runtimeSessionIncarnationId !== delivery.request.hookRuntimeSessionIncarnationId ||
					(currentSummary.agentNativeConversationSessionIdentity?.nativeSessionId ??
						(delivery.request.agentNativeConversationSessionIdentity?.sourceAgentId === currentSummary.agentId
							? delivery.request.agentNativeConversationSessionIdentity.nativeSessionId
							: null)) !== delivery.nativeSessionId ||
					(currentSummary.agentResponseGenerationTurnSequence ?? 0) !== delivery.agentTurnSequence ||
					resolveHookReviewLifecyclePromptSubmissionOrdering(
						currentSummary,
						delivery.request.hookEventCapturedAtEpochMs,
						delivery.unacceptedPromptSubmissionIdObservedBeforeAdmission,
					) === "superseded")
			) {
				delivery.status = "superseded_by_newer_session_state";
				await this.save(delivery);
				return this.response(delivery);
			}
			if (
				!hasPersistedApplicationReceipt &&
				currentSummary &&
				resolveHookReviewLifecyclePromptSubmissionOrdering(
					currentSummary,
					delivery.request.hookEventCapturedAtEpochMs,
					delivery.unacceptedPromptSubmissionIdObservedBeforeAdmission,
				) === "unknown"
			)
				break;
			const currentReceipt = currentSummary?.lastAppliedHookReviewLifecycleEventDelivery;
			const hasUncommittedApplicationReceipt =
				currentReceipt?.deliveryIdempotencyKey === delivery.deliveryIdempotencyKey;
			const canRecordHistoricalAgentTurnCompletion =
				Boolean(currentSummary) &&
				isRecovery &&
				delivery.agentTurnSequence > 0 &&
				currentSummary?.pid === null &&
				resolveSessionFacets(currentSummary).turnOwner === null &&
				["none", "exited"].includes(resolveSessionFacets(currentSummary).liveness);
			if (
				!hasPersistedApplicationReceipt &&
				!hasUncommittedApplicationReceipt &&
				currentSummary &&
				resolveSessionFacets(currentSummary).turnOwner !== "agent" &&
				!canObserveCompletedAgentTurnForCurrentUnacceptedPromptSubmission(
					currentSummary,
					delivery.request.hookEventCapturedAtEpochMs,
				) &&
				!canRecordHistoricalAgentTurnCompletion
			) {
				delivery.status = "superseded_by_newer_session_state";
				await this.save(delivery);
				return this.response(delivery);
			}
			delivery.status = "application_started_confirmation_pending";
			delivery.attemptsStartedInRecoveryCycle += 1;
			delivery.applicationAttemptRuntimeProcessInstanceIds.push(this.runtimeProcessInstanceId);
			await this.save(delivery);
			try {
				if (hasPersistedApplicationReceipt || hasUncommittedApplicationReceipt) {
					await this.options.persistApplicationConfirmation(
						delivery.request,
						delivery.taskIncarnationCreatedAtEpochMs,
					);
					await this.confirmApplication(delivery);
					break;
				}
				const response = await apply(
					requestAtDirectAdmission
						? { ...requestAtDirectAdmission, ...delivery.request, metadata: requestAtDirectAdmission.metadata }
						: delivery.request,
					{
						isRecovery,
						canRecordHistoricalAgentTurnCompletion,
						unacceptedPromptSubmissionIdObservedBeforeAdmission:
							delivery.unacceptedPromptSubmissionIdObservedBeforeAdmission,
						confirmApplication: async () => {
							await this.options.persistApplicationConfirmation(
								delivery.request,
								taskIncarnationCreatedAtEpochMs,
							);
							await this.confirmApplication(delivery);
						},
					},
				);
				if (isTerminal(delivery)) break;
				if (response.failureKind === "permanent_business_rejection") {
					delivery.status = "permanently_rejected";
					await this.save(delivery);
					return this.response(delivery);
				}
				throw Object.assign(new Error("生命周期应用尚未确认。"), {
					code: response.retryableRuntimeDependencyFailureCode ?? response.failureKind ?? "UNCONFIRMED",
				});
			} catch (error) {
				delivery.failureHistory.push({
					observedAtEpochMs: this.readNow(),
					failureKind: "runtime_dependency_unavailable",
					failureCode: String((error as NodeJS.ErrnoException).code ?? "UNKNOWN").slice(0, 80),
				});
				await this.save(delivery);
			}
		}
		if (delivery.status !== "application_confirmed") {
			delivery.status = "waiting_for_recovery_evidence";
			delivery.snapshotCommitReadinessEvidence =
				hasSnapshotStorageFailure(delivery) && this.options.probeSnapshotCommitReadiness
					? `workspace_snapshot_commit_unavailable:${delivery.failureHistory.at(-1)?.failureCode}`
					: null;
			delivery.nextCheckAtEpochMs = this.readNow() + 15_000;
			await this.save(delivery);
		}
		await this.completeNotification(delivery, requestAtDirectAdmission);
		return this.response(delivery);
	}

	private async completeNotification(
		delivery: RecoverableHookReviewLifecycleEventDelivery,
		requestAtDirectAdmission?: RuntimeHookIngestRequest,
	): Promise<void> {
		if (
			this.stopping ||
			delivery.status !== "application_confirmed" ||
			delivery.reviewNotificationReconciliationCompleted
		)
			return;
		await this.options.onApplicationConfirmed(
			requestAtDirectAdmission
				? { ...delivery.request, metadata: requestAtDirectAdmission.metadata }
				: delivery.request,
			delivery.applicationConfirmedNotificationCandidateId,
			delivery.unacceptedPromptSubmissionIdObservedBeforeAdmission,
		);
		delivery.reviewNotificationReconciliationCompleted = true;
		await this.save(delivery);
	}

	async reconcileWorkspace(workspaceId: string, apply: RecoverableHookReviewLifecycleApplication): Promise<void> {
		for (const delivery of (await this.list(workspaceId)).sort(
			(a, b) => a.receivedSequenceNumber - b.receivedSequenceNumber,
		)) {
			if (this.stopping) return;
			if (
				(!isTerminal(delivery) ||
					(delivery.status === "application_confirmed" && !delivery.reviewNotificationReconciliationCompleted)) &&
				this.readNow() >= delivery.nextCheckAtEpochMs
			) {
				await this.runSingleApplication(delivery, apply, true);
			}
		}
	}

	async close(): Promise<void> {
		this.stopping = true;
		await Promise.all(this.inFlightApplications.values());
	}
}
