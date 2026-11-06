import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedSessionHookSpoolDrainCoordinator } from "../../../src/agent-session-pty-host/runtime-client/hosted-session-hook-spool-drain-coordinator";
import type { RuntimeHookIngestRequest, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import {
	RecoverableHookReviewLifecycleEventDeliveries,
	type RecoverableHookReviewLifecycleTarget,
} from "../../../src/state/recoverable-hook-review-lifecycle-event-deliveries";

const isolatedKernelLockAccount = vi.hoisted(() => ({ homeDirectory: "" }));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof NodeOs>();
	return {
		...original,
		userInfo: () => ({ ...original.userInfo(), homedir: isolatedKernelLockAccount.homeDirectory }),
	};
});

describe("生命周期事件的持久受理与恢复对账", () => {
	let directory: string;
	let target: RecoverableHookReviewLifecycleTarget;
	let now: number;
	const application = vi.fn();
	const confirm = vi.fn();
	const notify = vi.fn();
	const runtimeIncarnation = randomUUID();
	const request = (key = "stop-1"): RuntimeHookIngestRequest => ({
		workspaceId: "project",
		taskId: "task",
		event: "to_review",
		metadata: { source: "claude", hookEventName: "Stop", finalMessage: "不能进入恢复文件的正文" },
		hookRuntimeSessionIncarnationId: runtimeIncarnation,
		hookEventDeliveryIdempotencyKey: key,
		hookEventCapturedAtEpochMs: 2_000,
	});
	function createService(
		overrides: Partial<ConstructorParameters<typeof RecoverableHookReviewLifecycleEventDeliveries>[0]> = {},
	) {
		return new RecoverableHookReviewLifecycleEventDeliveries({
			getWorkspaceDeliveryFilePath: () => join(directory, "deliveries.json"),
			readTarget: async () => target,
			persistApplicationConfirmation: confirm,
			onApplicationConfirmed: notify,
			readNow: () => now,
			waitBeforeRetry: async () => undefined,
			warn: () => undefined,
			...overrides,
		});
	}
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "kanban-recoverable-hook-review-"));
		isolatedKernelLockAccount.homeDirectory = directory;
		now = 3_000;
		target = {
			taskIncarnationCreatedAtEpochMs: 100,
			isTaskExecutionAllowed: true,
			recoveryEvidenceFingerprint: "dependencies-unavailable",
			summary: {
				taskId: "task",
				agentId: "claude",
				runtimeSessionIncarnationId: runtimeIncarnation,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "claude",
					nativeSessionId: "native-1",
					transcriptPath: "/isolated/session.jsonl",
					observedAt: 1_000,
				},
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				agentResponseGenerationTurnSequence: 1,
				agentResponseGenerationTurnStarted: { startedAt: 1_000, turnSequence: 1 },
				startedAt: 1_000,
				updatedAt: 1_000,
				pid: 123,
				workspacePath: "/isolated/project",
				reviewReason: null,
				exitCode: null,
			} as RuntimeTaskSessionSummary,
		};
		confirm.mockReset().mockImplementation(async () => undefined);
		notify.mockReset().mockResolvedValue(undefined);
		application.mockReset().mockImplementation(async (body, boundary) => {
			if (target.summary)
				target.summary = {
					...target.summary,
					turnOwner: "user",
					userTurnKind: "review",
					reviewReason: "hook",
					lastAppliedHookReviewLifecycleEventDelivery: {
						deliveryIdempotencyKey: body.hookEventDeliveryIdempotencyKey,
						capturedAtEpochMs: body.hookEventCapturedAtEpochMs,
						runtimeSessionIncarnationId: runtimeIncarnation,
					},
				};
			await boundary?.confirmApplication();
			return { ok: true };
		});
	});
	afterEach(async () => rm(directory, { recursive: true, force: true }));
	it("三次 EIO 后条目仍在，重启不重置预算，证据变化后自动恢复", async () => {
		application.mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
		const first = createService();
		expect(await first.ingest(request(), application)).toMatchObject({
			ok: true,
			lifecycleEventDeliveryStatus: "durably_accepted_pending_application",
		});
		expect(application).toHaveBeenCalledTimes(3);
		const restarted = createService();
		now += 15_000;
		await restarted.reconcileWorkspace("project", application);
		expect(application).toHaveBeenCalledTimes(3);
		const records = await restarted.list("project");
		expect(records[0]).toMatchObject({ status: "waiting_for_recovery_evidence", attemptsStartedInRecoveryCycle: 3 });
		target.recoveryEvidenceFingerprint = "dependencies-ready";
		application.mockImplementation(async (body, boundary) => {
			if (!target.summary) throw new Error("缺少会话夹具。");
			target.summary = {
				...target.summary,
				lastAppliedHookReviewLifecycleEventDelivery: {
					deliveryIdempotencyKey: body.hookEventDeliveryIdempotencyKey,
					capturedAtEpochMs: 2_000,
					runtimeSessionIncarnationId: runtimeIncarnation,
				},
			};
			await boundary?.confirmApplication();
			return { ok: true };
		});
		now += 15_000;
		await restarted.reconcileWorkspace("project", application);
		expect(application).toHaveBeenCalledTimes(4);
		expect((await restarted.list("project"))[0]?.status).toBe("application_confirmed");
		expect(notify).toHaveBeenCalledTimes(1);
	});
	it("已应用但确认响应丢失时先对账，超过 32 条后仍不重放", async () => {
		confirm.mockRejectedValueOnce(new Error("确认响应丢失"));
		const service = createService();
		await service.ingest(request(), application);
		expect(application).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 40; index += 1) {
			await service.ingest(request(`later-${index}`), application);
		}
		const beforeReplay = application.mock.calls.length;
		await createService().ingest(request(), application);
		expect(application).toHaveBeenCalledTimes(beforeReplay);
		expect((await service.list("project"))[0]?.status).toBe("application_confirmed");
	});
	it.each([false, true])("已有回执但快照持续 EIO 时，确认写入也遵守预算（已持久化=%s）", async (persisted) => {
		let readiness = "workspace_snapshot_commit_unavailable:EIO";
		confirm.mockRejectedValue(Object.assign(new Error("快照不可写"), { code: "EIO" }));
		if (persisted)
			confirm.mockImplementation(async () => {
				target.persistedSummary = target.summary;
				throw Object.assign(new Error("快照投影修复失败"), { code: "EIO" });
			});
		const service = createService({ probeSnapshotCommitReadiness: async () => readiness });
		await service.ingest(request(), application);
		expect(application).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledTimes(3);
		expect((await service.list("project"))[0]).toMatchObject({
			status: "waiting_for_recovery_evidence",
			attemptsStartedInRecoveryCycle: 3,
		});
		for (let scan = 0; scan < 5; scan += 1) {
			now += 15_000;
			await createService({ probeSnapshotCommitReadiness: async () => readiness }).reconcileWorkspace(
				"project",
				application,
			);
		}
		expect(confirm).toHaveBeenCalledTimes(3);
		expect((await service.list("project"))[0]?.failureHistory).toHaveLength(3);
		readiness = "workspace_snapshot_commit_writable";
		confirm.mockResolvedValue(undefined);
		now += 15_000;
		await service.reconcileWorkspace("project", application);
		expect(confirm).toHaveBeenCalledTimes(4);
		expect(application).toHaveBeenCalledTimes(1);
		expect((await service.list("project"))[0]?.status).toBe("application_confirmed");
	});
	it.each(
		["Stop", "AfterAgent", "agent-turn-complete"].flatMap((hookEventName) =>
			[
				{ attemptedAtMs: 1_500, capturedAtEpochMs: 2_000 },
				{ attemptedAtMs: 2_000, capturedAtEpochMs: 2_000 },
				{ attemptedAtMs: 3_000, capturedAtEpochMs: 4_000 },
			].map((timing) => ({ hookEventName, ...timing })),
		),
	)(
		"待接受补证的无工具 $hookEventName 沿既有完成链应用（提交时刻=$attemptedAtMs）",
		async ({ hookEventName, attemptedAtMs, capturedAtEpochMs }) => {
			if (!target.summary) throw new Error("缺少会话夹具。");
			target.summary = {
				...target.summary,
				turnOwner: "user",
				userTurnKind: "review",
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					attemptedAtMs,
					submissionId: "submission-before-stop-admission",
					runtimeSessionIncarnationId: runtimeIncarnation,
				},
			};
			expect(
				await createService().ingest(
					{
						...request(),
						hookEventCapturedAtEpochMs: capturedAtEpochMs,
						metadata: { source: "claude", hookEventName },
					},
					application,
				),
			).toMatchObject({ lifecycleEventDeliveryStatus: "application_confirmed" });
			expect(application).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]?.[2]).toBe(attemptedAtMs < 2_000 ? null : "submission-before-stop-admission");
		},
	);
	it("重启后的直接重送也恢复已受理的原回合，后续扫描不重复应用", async () => {
		const originalApplication = application.getMockImplementation();
		application.mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
		await createService({ runtimeProcessInstanceId: randomUUID() }).ingest(request(), application);
		if (!target.summary || !originalApplication) throw new Error("缺少应用夹具。");
		target.summary = { ...target.summary, pid: null, turnOwner: null, userTurnKind: null, liveness: "exited" };
		target.recoveryEvidenceFingerprint = "restarted-session";
		application.mockImplementation(originalApplication);
		const restarted = createService({ runtimeProcessInstanceId: randomUUID() });
		expect(await restarted.ingest(request(), application)).toMatchObject({
			lifecycleEventDeliveryStatus: "application_confirmed",
		});
		expect(application.mock.calls[3]?.[1]).toMatchObject({
			isRecovery: true,
			canRecordHistoricalAgentTurnCompletion: true,
		});
		now += 15_000;
		await restarted.reconcileWorkspace("project", application);
		expect(application).toHaveBeenCalledTimes(4);
	});
	it.each(["direct", "restarted-direct", "restarted-scan"])(
		"同毫秒新输入阻挡待应用 Stop 及其通知（%s）",
		async (recoveryRoute) => {
			application.mockRejectedValue(new Error("暂时失败"));
			const service = createService({ runtimeProcessInstanceId: randomUUID() });
			await service.ingest(request(), application);
			if (!target.summary) throw new Error("缺少会话夹具。");
			target.summary = {
				...target.summary,
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					attemptedAtMs: 2_000,
					submissionId: "new-submission-after-stop-admission",
					runtimeSessionIncarnationId: runtimeIncarnation,
				},
			};
			target.recoveryEvidenceFingerprint = "new-input-same-millisecond";
			now += 15_000;
			const recoveryService = recoveryRoute.startsWith("restarted")
				? createService({ runtimeProcessInstanceId: randomUUID() })
				: service;
			if (recoveryRoute === "restarted-scan") await recoveryService.reconcileWorkspace("project", application);
			else await recoveryService.ingest(request(), application);
			expect(application).toHaveBeenCalledTimes(3);
			expect(notify).not.toHaveBeenCalled();
			expect((await service.list("project"))[0]?.status).toBe("superseded_by_newer_session_state");
		},
	);
	it.each([false, true])("同毫秒原提交身份跨重启保存，后继同毫秒提交仍被识别（替换身份=%s）", async (replace) => {
		if (!target.summary) throw new Error("缺少会话夹具。");
		target.summary = {
			...target.summary,
			turnOwner: "user",
			userTurnKind: "review",
			agentConversationPromptSubmissionAcceptance: {
				status: "pending",
				attemptedAtMs: 2_000,
				submissionId: "submission-before-stop-admission",
				runtimeSessionIncarnationId: runtimeIncarnation,
			},
		};
		const originalApplication = application.getMockImplementation();
		application.mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
		const service = createService({ runtimeProcessInstanceId: randomUUID() });
		await service.ingest(request(), application);
		expect((await service.list("project"))[0]).toMatchObject({
			status: "waiting_for_recovery_evidence",
			unacceptedPromptSubmissionIdObservedBeforeAdmission: "submission-before-stop-admission",
		});
		if (!target.summary.agentConversationPromptSubmissionAcceptance || !originalApplication)
			throw new Error("缺少提交身份或应用夹具。");
		if (replace)
			target.summary.agentConversationPromptSubmissionAcceptance.submissionId = "new-submission-after-admission";
		target.recoveryEvidenceFingerprint = "storage-recovered";
		application.mockImplementation(originalApplication);
		now += 15_000;
		const restarted = createService({ runtimeProcessInstanceId: randomUUID() });
		await restarted.ingest(request(), application);
		await restarted.reconcileWorkspace("project", application);
		expect(application).toHaveBeenCalledTimes(replace ? 3 : 4);
		expect(notify).toHaveBeenCalledTimes(replace ? 0 : 1);
		expect((await restarted.list("project"))[0]?.status).toBe(
			replace ? "superseded_by_newer_session_state" : "application_confirmed",
		);
	});
	it("受理前观测之后、应用之前的同毫秒输入不会冒领原提交", async () => {
		const originalTarget = structuredClone(target);
		if (!target.summary) throw new Error("缺少会话夹具。");
		target.summary.agentConversationPromptSubmissionAcceptance = {
			status: "pending",
			attemptedAtMs: 2_000,
			submissionId: "racing-new-submission",
			runtimeSessionIncarnationId: runtimeIncarnation,
		};
		const readTarget = vi.fn().mockResolvedValue(target).mockResolvedValueOnce(originalTarget);
		expect(await createService({ readTarget }).ingest(request(), application)).toMatchObject({
			lifecycleEventDeliveryStatus: "superseded_by_newer_session_state",
		});
		expect(application).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
	it("旧记录与缺少稳定身份的同毫秒提交保持未知，不写死过期或重复尝试", async () => {
		if (!target.summary) throw new Error("缺少会话夹具。");
		target.summary = {
			...target.summary,
			turnOwner: "user",
			userTurnKind: "review",
			agentConversationPromptSubmissionAcceptance: {
				status: "pending",
				attemptedAtMs: 2_000,
				runtimeSessionIncarnationId: runtimeIncarnation,
			},
		};
		const service = createService();
		expect(await service.ingest(request(), application)).toMatchObject({
			lifecycleEventDeliveryStatus: "durably_accepted_pending_application",
		});
		const savedBeforeRechecks = await readFile(join(directory, "deliveries.json"), "utf8");
		for (let index = 0; index < 5; index += 1) {
			now += 15_000;
			await createService().reconcileWorkspace("project", application);
		}
		expect(await readFile(join(directory, "deliveries.json"), "utf8")).toBe(savedBeforeRechecks);
		expect(application).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect((await service.list("project"))[0]).toMatchObject({
			status: "waiting_for_recovery_evidence",
			attemptsStartedInRecoveryCycle: 0,
			failureHistory: [],
		});
		// 后继输入时间水位明确推进后，恢复扫描可以独立确认旧事件已过期。
		target.summary.agentConversationPromptSubmissionAcceptance = {
			...target.summary.agentConversationPromptSubmissionAcceptance,
			status: "pending",
			runtimeSessionIncarnationId: runtimeIncarnation,
			attemptedAtMs: 2_001,
			submissionId: "definitely-new-submission",
		};
		now += 15_000;
		await createService().reconcileWorkspace("project", application);
		expect((await service.list("project"))[0]?.status).toBe("superseded_by_newer_session_state");
	});
	it("准入锁无写入释放后，能力探测证据改变而目标文件元数据不变", async () => {
		const service = createService();
		const coordinator = new HostedSessionHookSpoolDrainCoordinator({
			warn: () => undefined,
			recordSpooledHookEventDroppedAfterApplyRetriesExhausted: async () => {
				throw new Error("完成事件不得丢弃。");
			},
			waitBeforeRetryingSpooledHookEventApply: async () => undefined,
		});
		let acknowledged = false;
		const applySpooledEvent = vi.fn(async () => ({
			ok: false,
			failureKind: "runtime_dependency_unavailable" as const,
		}));
		coordinator.bindSpooledHookIngestRequestApplier(applySpooledEvent);
		coordinator.registerHookSpoolDrainTargetHostedSession({
			hostedSessionKey: "isolated-host",
			workspaceId: "project",
			taskId: "task",
			readHookSpoolEntries: async () =>
				acknowledged
					? []
					: [{ hookSpoolEntrySequenceNumber: 1, spooledAtEpochMs: now, spooledHookIngestRequest: request() }],
			acknowledgeHookSpoolEntriesThrough: () => {
				acknowledged = true;
			},
		});
		await coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("project", "task");
		expect(applySpooledEvent).toHaveBeenCalledTimes(3);
		let releaseLock: () => void = () => undefined;
		let observeLockAcquired: () => void = () => undefined;
		const lockAcquired = new Promise<void>((resolve) => {
			observeLockAcquired = resolve;
		});
		const lockReleaseRequested = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const holdingLock = lockedFileSystem.withLock({ path: join(directory, "deliveries.json") }, async () => {
			observeLockAcquired();
			await lockReleaseRequested;
		});
		await lockAcquired;
		const beforeRelease = await stat(directory);
		try {
			expect(await service.probeWorkspaceHookReviewLifecycleEventDeliveryAdmissionLockReadiness("project")).toBe(
				"lifecycle_admission_unavailable:ELOCKED",
			);
			for (let scan = 0; scan < 5; scan += 1) {
				await coordinator.retryRetainedLifecycleEventsAfterAdmissionEvidenceChanges(
					"project",
					JSON.stringify([
						"unchanged-directory-and-snapshot",
						await service.probeWorkspaceHookReviewLifecycleEventDeliveryAdmissionLockReadiness("project"),
					]),
				);
			}
			expect(applySpooledEvent).toHaveBeenCalledTimes(6);
		} finally {
			releaseLock();
			await holdingLock;
		}
		const afterRelease = await stat(directory);
		expect([
			afterRelease.dev,
			afterRelease.ino,
			afterRelease.mode,
			afterRelease.size,
			afterRelease.mtimeMs,
			afterRelease.ctimeMs,
		]).toEqual([
			beforeRelease.dev,
			beforeRelease.ino,
			beforeRelease.mode,
			beforeRelease.size,
			beforeRelease.mtimeMs,
			beforeRelease.ctimeMs,
		]);
		expect(await service.probeWorkspaceHookReviewLifecycleEventDeliveryAdmissionLockReadiness("project")).toBe(
			"lifecycle_admission_lock_available",
		);
		applySpooledEvent.mockResolvedValue({ ok: true, failureKind: "runtime_dependency_unavailable" });
		await coordinator.retryRetainedLifecycleEventsAfterAdmissionEvidenceChanges(
			"project",
			JSON.stringify([
				"unchanged-directory-and-snapshot",
				await service.probeWorkspaceHookReviewLifecycleEventDeliveryAdmissionLockReadiness("project"),
			]),
		);
		expect(applySpooledEvent).toHaveBeenCalledTimes(7);
		expect(acknowledged).toBe(true);
		await coordinator.forgetEveryHookSpoolDrainTargetAndWaitForRunningDrainLoopsToStop();
	});
	it("旧 Stop 不覆盖新输入或更换后的原生会话", async () => {
		application.mockRejectedValue(new Error("暂时失败"));
		const service = createService();
		await service.ingest(request(), application);
		if (!target.summary) throw new Error("缺少会话夹具。");
		target.summary = {
			...target.summary,
			agentResponseGenerationTurnSequence: 2,
			agentResponseGenerationTurnStarted: { startedAt: 4_000, turnSequence: 2 },
		};
		now += 15_000;
		target.recoveryEvidenceFingerprint = "new-user-turn";
		await service.reconcileWorkspace("project", application);
		expect(application).toHaveBeenCalledTimes(3);
		expect((await service.list("project"))[0]?.status).toBe("superseded_by_newer_session_state");
	});
	it.each([false, true])("只保存最小生命周期投影，决策和 prompt 不进入恢复链（host 暂存=%s）", async (isRecovery) => {
		const service = createService();
		const hookCliProcessResourceUsage = {
			lifetimeMaximumResidentSetSizeKibibytes: 123,
			cumulativeUserCpuTimeSeconds: 0.1,
			cumulativeSystemCpuTimeSeconds: 0.2,
			hookCliProcessUptimeMs: 300,
			hookIngestDeliveryAttempt: 1,
		};
		await service.ingest({ ...request(), hookCliProcessResourceUsage }, application, isRecovery);
		expect(application.mock.calls[0]?.[0].metadata.finalMessage).toBe("不能进入恢复文件的正文");
		expect(application.mock.calls[0]?.[0].hookCliProcessResourceUsage).toEqual(hookCliProcessResourceUsage);
		expect(notify.mock.calls[0]?.[0].metadata.finalMessage).toBe("不能进入恢复文件的正文");
		expect((await service.list("project"))[0]?.reviewNotificationReconciliationCompleted).toBe(true);
		expect(await readFile(join(directory, "deliveries.json"), "utf8")).not.toContain("不能进入恢复文件的正文");
		expect(await readFile(join(directory, "deliveries.json"), "utf8")).not.toContain("hookCliProcessResourceUsage");
		await service.ingest({ ...request("prompt"), submittedPromptText: "私有输入" }, application);
		expect(await readFile(join(directory, "deliveries.json"), "utf8")).not.toContain("私有输入");
	});
	it.each([false, true])(
		"通知交接失败后重启仅重试稳定候选，不重放领域应用（候选已登记=%s）",
		async (registeredBeforeFailure) => {
			const registeredCandidates = new Set<string>();
			notify.mockImplementationOnce(async (_, candidateId: string) => {
				if (registeredBeforeFailure) registeredCandidates.add(candidateId);
				throw new Error("通知持久交接未完成");
			});
			notify.mockImplementation(async (_, candidateId: string) => {
				registeredCandidates.add(candidateId);
			});
			await createService().ingest(request(), application);
			const beforeRestart = (await createService().list("project"))[0];
			expect(beforeRestart).toMatchObject({
				status: "application_confirmed",
				reviewNotificationReconciliationCompleted: false,
			});
			expect(application).toHaveBeenCalledTimes(1);
			expect(registeredCandidates.size).toBe(registeredBeforeFailure ? 1 : 0);
			await createService().reconcileWorkspace("project", application);
			const afterRestart = (await createService().list("project"))[0];
			expect(afterRestart).toMatchObject({
				status: "application_confirmed",
				reviewNotificationReconciliationCompleted: true,
			});
			expect(application).toHaveBeenCalledTimes(1);
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledTimes(2);
			expect(registeredCandidates.size).toBe(1);
			expect(notify.mock.calls.map(([, candidateId]) => candidateId)).toEqual([
				beforeRestart?.applicationConfirmedNotificationCandidateId,
				beforeRestart?.applicationConfirmedNotificationCandidateId,
			]);
			expect(beforeRestart?.applicationConfirmedNotificationCandidateId).not.toBe(
				beforeRestart?.request.notificationCandidateId,
			);
			expect(await readFile(join(directory, "deliveries.json"), "utf8")).not.toContain("不能进入恢复文件的正文");
		},
	);
	it("同代 Stop 自带匹配 agent 的原生身份时，沿既有应用链补证，不陷入身份等待", async () => {
		if (!target.summary) throw new Error("缺少会话夹具。");
		const identity = target.summary.agentNativeConversationSessionIdentity;
		if (!identity) throw new Error("缺少原生身份夹具。");
		target.summary = { ...target.summary, agentNativeConversationSessionIdentity: undefined };
		const service = createService();
		expect(
			await service.ingest({ ...request(), agentNativeConversationSessionIdentity: identity }, application),
		).toMatchObject({ lifecycleEventDeliveryStatus: "application_confirmed" });
		expect(application).toHaveBeenCalledTimes(1);
		expect((await service.list("project"))[0]?.nativeSessionId).toBe(identity?.nativeSessionId);
	});
	it("原生身份声明的 agent 不匹配时不应用完成事件", async () => {
		const service = createService();
		expect(
			await service.ingest(
				{
					...request(),
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: "native-1",
						transcriptPath: null,
						observedAt: 1_000,
					},
				},
				application,
			),
		).toMatchObject({ lifecycleEventDeliveryStatus: "superseded_by_newer_session_state" });
		expect(application).not.toHaveBeenCalled();
	});
	it("身份不变时由真实存储能力恢复接续，失败条件不变则不重复执行", async () => {
		let readiness = "workspace_snapshot_commit_unavailable:EIO";
		const options = { probeSnapshotCommitReadiness: async () => readiness };
		const originalApplication = application.getMockImplementation();
		application.mockRejectedValue(Object.assign(new Error("瞬时存储失败"), { code: "EIO" }));
		await createService(options).ingest(request(), application);
		now += 15_000;
		await createService(options).reconcileWorkspace("project", application);
		expect(application).toHaveBeenCalledTimes(3);
		if (!originalApplication) throw new Error("缺少应用夹具。");
		application.mockImplementation(originalApplication);
		readiness = "workspace_snapshot_commit_writable";
		now += 15_000;
		await createService(options).reconcileWorkspace("project", application);
		expect(application).toHaveBeenCalledTimes(4);
		expect((await createService(options).list("project"))[0]?.status).toBe("application_confirmed");
	});
	it("损坏的归属记录不退回空存储，也不向其他工作区应用", async () => {
		const service = createService();
		await service.ingest(request(), application);
		const path = join(directory, "deliveries.json");
		const file = JSON.parse(await readFile(path, "utf8"));
		file.deliveries[0].request.workspaceId = "other-project";
		await writeFile(path, JSON.stringify(file));
		await expect(service.list("project")).rejects.toThrow("身份校验失败");
		expect(await service.ingest(request("next"), application)).toMatchObject({ ok: false });
		expect(application).toHaveBeenCalledTimes(1);
	});
	it("容量不足保留已受理记录；明确 Stop 不进入应用", async () => {
		const service = createService();
		application.mockRejectedValue(new Error("依赖等待"));
		await service.ingest(request(), application);
		const path = join(directory, "deliveries.json");
		const file = JSON.parse(await readFile(path, "utf8"));
		const template = file.deliveries[0];
		file.nextSequenceNumber = 513;
		file.deliveries = Array.from({ length: 512 }, (_, index) => ({
			...template,
			deliveryIdempotencyKey: `stored-${index}`,
			receivedSequenceNumber: index + 1,
			request: { ...template.request, hookEventDeliveryIdempotencyKey: `stored-${index}` },
		}));
		const fullText = JSON.stringify(file);
		await writeFile(path, fullText);
		expect(await service.ingest(request("overflow"), application)).toMatchObject({ ok: false });
		expect(await readFile(path, "utf8")).toBe(fullText);
		target.isTaskExecutionAllowed = false;
		now += 15_000;
		await service.ingest(request("stored-0"), application);
		expect(application).toHaveBeenCalledTimes(3);
	});
});
