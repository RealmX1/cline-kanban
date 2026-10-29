import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	createTaskCommandExecutionService,
	type TaskCommandExecutionDependencies,
} from "../../../src/task-command-execution/task-command-execution-service";
import {
	mutateTaskCommandExecutions,
	readTaskCommandExecutions,
} from "../../../src/task-command-execution/task-command-execution-store";

const isolatedHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: (workspaceId: string) => join(isolatedHome.path, workspaceId),
	getRuntimeHomePath: () => isolatedHome.path,
}));

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "owned-command-execution-"));
	isolatedHome.path = directory;
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function fixture(
	readDeliveryRecoveryEvidenceSha256?: TaskCommandExecutionDependencies["readDeliveryRecoveryEvidenceSha256"],
) {
	const summary = {
		taskId: "task-session",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		workspacePath: directory,
		runtimeSessionIncarnationId: "session-incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native-session",
			observedAt: 1,
		},
	} as RuntimeTaskSessionSummary;
	const owner = {
		isNativeInputSubmissionBusy: false,
		taskId: "task",
		taskIncarnationCreatedAtEpochMs: 7,
		conversationSessionId: summary.taskId,
		nativeSessionId: "native-session",
		worktreePath: directory,
		summary,
	};
	const launch = vi.fn<NonNullable<TaskCommandExecutionDependencies["launch"]>>(async () => undefined);
	const deliver = vi.fn<TaskCommandExecutionDependencies["deliver"]>(async (_record, validate, settled) => {
		await validate("before_transport_acceptance");
		await validate("before_first_transport_write");
		await settled({ status: "delivered_and_submit_confirmed", reason: null });
		return { ok: true, summary, terminalDelivery: { status: "delivered_and_submit_confirmed", reason: null } };
	});
	const cancel = vi.fn<NonNullable<TaskCommandExecutionDependencies["cancel"]>>(async () => ({
		localProcessStatus: "exited",
		nativeCancellationStatus: "unknown",
	}));
	const reconcileDelivery = vi.fn<TaskCommandExecutionDependencies["reconcileDelivery"]>(async () => "unknown");
	const readOwner = vi.fn<TaskCommandExecutionDependencies["readOwner"]>(async () => owner);
	const inspectWorker = vi.fn<NonNullable<TaskCommandExecutionDependencies["inspectWorker"]>>(async () => "running");
	const park = vi.fn<TaskCommandExecutionDependencies["park"]>(async (record) => {
		summary.awaitingDispatchedBackgroundWork = {
			sinceMs: 1,
			owningCommandExecutionIds: [
				...new Set([
					...(summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds ?? []),
					record.executionId,
				]),
			],
		};
		return true;
	});
	const unpark = vi.fn<TaskCommandExecutionDependencies["unpark"]>(async (record) => {
		const current = summary.awaitingDispatchedBackgroundWork;
		if (!current?.owningCommandExecutionIds?.includes(record.executionId)) return;
		const remaining = current.owningCommandExecutionIds.filter((id) => id !== record.executionId);
		summary.awaitingDispatchedBackgroundWork = remaining.length
			? { ...current, owningCommandExecutionIds: remaining }
			: undefined;
	});
	const service = createTaskCommandExecutionService({
		readOwner,
		readDeliveryRecoveryEvidenceSha256,
		launch,
		cancel,
		deliver,
		inspectWorker,
		park,
		unpark,
		reconcileDelivery,
		listWorkspaceIds: async () => ["workspace"],
		warn: () => undefined,
	});
	const request = {
		taskId: "task",
		idempotencyKey: "same-work",
		specification: {
			command: [process.execPath, "-e", "process.exit(0)"],
			resumeCommand: [process.execPath, "-e", "process.exit(0)"],
			workingDirectory: directory,
			resultFile: join(directory, "business-result.json"),
			materialSha256: "a".repeat(64),
			label: "隔离命令",
		},
	};
	return {
		service,
		request,
		owner,
		summary,
		launch,
		deliver,
		cancel,
		reconcileDelivery,
		inspectWorker,
		park,
		unpark,
		readOwner,
	};
}

describe("所属执行与一次逻辑交回", () => {
	it.each(["unknown", "exited"] as const)(
		"初查 %s 后复核仍运行不消耗恢复预算，确证退出后仍能派发恢复",
		async (initialInspection) => {
			const f = fixture();
			const first = await f.service.start("workspace", {
				...f.request,
				specification: { ...f.request.specification, resumeCommandPreservesBusinessSingleFlight: true },
			});
			let now = Date.now();
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			try {
				for (let attempt = 0; attempt < 2; attempt++) {
					now += 30_001;
					f.inspectWorker.mockResolvedValueOnce(initialInspection).mockResolvedValueOnce("running");
					await f.service.sweepExecution("workspace", first.executionId);
				}
				const skipped = await f.service.inspect("workspace", first);
				expect(f.launch).toHaveBeenCalledTimes(1);
				expect(skipped.lastRecoveryEvidenceSha256).toBeNull();
				expect(skipped.unchangedRecoveryAttemptCount).toBe(0);
				expect(skipped.nextRecoveryAtEpochMs).toBeNull();
				expect(skipped.unprovenSupervisorRecoveryObservation?.unprovenSingleFlightResumeAttemptCount ?? 0).toBe(0);
				now += 30_001;
				f.inspectWorker.mockResolvedValue("exited");
				await f.service.sweepExecution("workspace", first.executionId);
				expect(f.launch).toHaveBeenCalledTimes(2);
				expect((await f.service.inspect("workspace", first)).launchAttemptCount).toBe(2);
				now += 30_001;
				await f.service.sweepExecution("workspace", first.executionId);
				expect(f.launch).toHaveBeenCalledTimes(3);
				now += 30_001;
				await f.service.sweepExecution("workspace", first.executionId);
				expect(f.launch).toHaveBeenCalledTimes(3);
				expect((await f.service.inspect("workspace", first)).unchangedRecoveryAttemptCount).toBe(1);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("已登记业务单飞的恢复动作可在监督者缺证时有界接续，保留旧启动归属", async () => {
		const f = fixture();
		const first = await f.service.start("workspace", {
			...f.request,
			specification: { ...f.request.specification, resumeCommandPreservesBusinessSingleFlight: true },
		});
		f.inspectWorker.mockResolvedValue("unknown");
		await f.service.sweepExecution("workspace", first.executionId);
		let current = await f.service.inspect("workspace", first);
		expect(f.launch).toHaveBeenCalledTimes(2);
		expect(current.launchAttemptCount).toBe(2);
		expect(current.previousLaunchNonces).toEqual([first.launchNonce]);
		expect(current.unprovenSupervisorRecoveryObservation?.unprovenSingleFlightResumeAttemptCount).toBe(1);
		await mutateTaskCommandExecutions("workspace", (records) => ({
			records: records.map((record) => ({ ...record, nextRecoveryAtEpochMs: 0 })),
			result: undefined,
		}));
		await f.service.sweepExecution("workspace", first.executionId);
		current = await f.service.inspect("workspace", first);
		expect(f.launch).toHaveBeenCalledTimes(2);
		expect(current.unprovenSupervisorRecoveryObservation?.recoveryAction).toBe("await_process_or_native_evidence");
		await f.service.cancel("workspace", current);
		expect(f.cancel.mock.calls[0]?.[0].previousLaunchNonces).toEqual([first.launchNonce]);
	});

	it("未声明业务单飞时监督者缺证保持未知，并持久保存替代核验和恢复条件", async () => {
		const f = fixture();
		const first = await f.service.start("workspace", f.request);
		f.inspectWorker.mockResolvedValue("unknown");
		await f.service.sweepExecution("workspace", first.executionId);
		const current = await f.service.inspect("workspace", first);
		expect(f.launch).toHaveBeenCalledTimes(1);
		expect(current.unprovenSupervisorRecoveryObservation?.missingEvidence).toBe("supervisor_or_owned_process_exit");
		expect(current.unprovenSupervisorRecoveryObservation?.equivalentEvidenceSources).toContain(
			"producer_registered_business_single_flight",
		);
	});
	it("首次 park 连续失败后按间隔探测恢复，不消耗业务重试预算", async () => {
		const { service, request, park, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("not_started");
		const originalPark = park.getMockImplementation();
		if (!originalPark) throw new Error("缺少 park fixture");
		park.mockRejectedValue(new Error("park 依赖暂不可用"));
		await expect(service.start("workspace", request)).rejects.toThrow("park");
		const [record] = await readTaskCommandExecutions("workspace");
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			for (let attempt = 0; attempt < 4; attempt++) {
				now += 30_001;
				await service.sweepExecution("workspace", record.executionId).catch(() => undefined);
			}
			expect(launch).not.toHaveBeenCalled();
			const parkAttempts = park.mock.calls.length;
			await service.sweepExecution("workspace", record.executionId);
			expect(park).toHaveBeenCalledTimes(parkAttempts);
			park.mockImplementation(originalPark);
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			const recovered = await service.inspect("workspace", record);
			expect(launch).toHaveBeenCalledTimes(1);
			expect(recovered.launchAttemptCount).toBe(1);
			expect(recovered.unchangedRecoveryAttemptCount).toBe(0);
			expect(recovered.parkOwned).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});
	it("artifact 目录创建失败后在同一 runtime 恢复首次派发", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("not_started");
		await mkdir(join(directory, "workspace"), { recursive: true });
		const obstruction = join(directory, "workspace", "task-command-executions");
		await writeFile(obstruction, "暂时不可创建目录");
		await expect(service.start("workspace", request)).rejects.toThrow();
		const [record] = await readTaskCommandExecutions("workspace");
		await rm(obstruction);
		await service.start("workspace", request);
		await service.sweepExecution("workspace", record.executionId);
		expect(launch).toHaveBeenCalledTimes(1);
		expect((await service.inspect("workspace", record)).launchState).toBe("running");
	});
	it("Stop 完成后迟到的初次 park 不会重新留下所属等待", async () => {
		const { service, request, park, launch, summary } = fixture();
		const originalPark = park.getMockImplementation();
		if (!originalPark) throw new Error("缺少 park fixture");
		let entered!: () => void;
		let release!: () => void;
		const parked = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		park.mockImplementationOnce(async (record) => {
			entered();
			await gate;
			return originalPark(record);
		});
		const starting = service.start("workspace", request).catch(() => undefined);
		await parked;
		await service.cancelForTask("workspace", request.taskId);
		release();
		await starting;
		const [record] = await readTaskCommandExecutions("workspace");
		await service.sweepExecution("workspace", record.executionId);
		expect(record.revokedAtEpochMs).not.toBeNull();
		expect((await service.inspect("workspace", record)).parkOwned).toBe(false);
		expect(summary.awaitingDispatchedBackgroundWork).toBeUndefined();
		expect(launch).not.toHaveBeenCalled();
	});
	it("结果重试保留并等待普通后台工作解除", async () => {
		const { service, request, deliver, summary } = fixture();
		const accepted = deliver.getMockImplementation();
		if (!accepted) throw new Error("缺少成功投递 fixture");
		deliver.mockImplementationOnce(async () => {
			throw new Error("临时不可写");
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		expect((await service.inspect("workspace", record)).resultDelivery?.attemptId).not.toBeNull();
		summary.awaitingDispatchedBackgroundWork = {
			sinceMs: 1,
			owningCommandExecutionIds: [record.executionId],
			hasUnownedBackgroundWorkWait: true,
		};
		await mutateTaskCommandExecutions("workspace", (records) => ({
			records: records.map((value) => ({
				...value,
				resultDelivery: value.resultDelivery && {
					...value.resultDelivery,
					lastPreflightFailureEvidenceSha256: null,
					retryPreflightNotBeforeEpochMs: null,
				},
			})),
			result: undefined,
		}));
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(summary.awaitingDispatchedBackgroundWork?.hasUnownedBackgroundWorkWait).toBe(true);
		summary.awaitingDispatchedBackgroundWork.hasUnownedBackgroundWorkWait = false;
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(2);
	});
	it("原生请求忙碌时不消耗发送预算，park 保持相同 facet 也能在可写后交回", async () => {
		const { service, request, owner, deliver, summary, park } = fixture();
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		owner.isNativeInputSubmissionBusy = true;
		summary.turnOwner = "user";
		summary.userTurnKind = "permission";
		park.mockResolvedValue(false);
		await service.sweepExecution("workspace", record.executionId);
		expect((await service.inspect("workspace", record)).parkOwned).toBe(true);
		summary.turnOwner = "agent";
		summary.userTurnKind = null;
		for (let index = 0; index < 4; index++) await service.sweepExecution("workspace", record.executionId);
		expect(deliver).not.toHaveBeenCalled();
		expect((await service.inspect("workspace", record)).resultDelivery?.attemptCount).toBe(0);
		owner.isNativeInputSubmissionBusy = false;
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect((await service.inspect("workspace", record)).resultDelivery?.state).toBe("native_accepted");
	});
	it("同一结果路径的点段、符号链接和不存在的父目录别名不能注册第二个执行", async () => {
		const { service, request } = fixture();
		await mkdir(join(directory, "published-results"));
		await symlink(join(directory, "published-results"), join(directory, "published-results-alias"));
		request.specification.resultFile = join(directory, "published-results", "not-created", "result.json");
		await service.start("workspace", request);
		for (const resultFile of [
			`${directory}/published-results/../published-results/not-created/result.json`,
			join(directory, "published-results-alias", "not-created", "result.json"),
		]) {
			await expect(
				service.start("workspace", {
					...request,
					idempotencyKey: resultFile,
					specification: { ...request.specification, resultFile },
				}),
			).rejects.toThrow("唯一结果路径");
		}
	});

	it("三次忙碌拒绝后保留计数，空闲证据变化仍可交回同一逻辑结果", async () => {
		let recoveryEvidence = "busy-1";
		const { service, request, deliver } = fixture(async () => recoveryEvidence);
		const acceptedDelivery = deliver.getMockImplementation();
		if (!acceptedDelivery) throw new Error("缺少成功投递 fixture");
		deliver.mockImplementation(async (record, validate, settled) => {
			if (recoveryEvidence === "idle") return acceptedDelivery(record, validate, settled);
			await validate("before_first_transport_write");
			if (!record.resultDelivery?.attemptId) throw new Error("缺少精确投递尝试");
			const receipt = {
				status: "delivery_failed" as const,
				reason: "no_active_terminal_session" as const,
				nativePromptSubmissionNotStartedEvidence: {
					source: "acp_input_rejected_before_prompt_registration" as const,
					clientUserMessageId: record.resultDelivery.resultId,
					submissionAttemptId: record.resultDelivery.attemptId,
					nativeSessionId: record.originatingNativeSessionId,
					reason: "request_busy" as const,
				},
			};
			await settled(receipt);
			return { ok: false, summary: null, terminalDelivery: receipt };
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		for (let index = 1; index <= 3; index++) {
			recoveryEvidence = `busy-${index}`;
			await service.sweepExecution("workspace", record.executionId);
		}
		for (let index = 0; index < 4; index++) await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(3);
		recoveryEvidence = "idle";
		await service.sweepExecution("workspace", record.executionId);
		const recovered = await service.inspect("workspace", record);
		expect(deliver).toHaveBeenCalledTimes(4);
		expect(recovered.resultDelivery?.attemptCount).toBe(4);
		expect(recovered.resultDelivery?.state).toBe("native_accepted");
		expect(recovered.logicalResultCount).toBe(1);
		expect(recovered.parkOwned).toBe(false);
	});

	it("启动尚未完成时恢复扫描不会重派发或切换 nonce", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("not_started");
		let enterLaunch!: (record: Parameters<TaskCommandExecutionDependencies["deliver"]>[0]) => void;
		let releaseLaunch!: () => void;
		const entered = new Promise<Parameters<TaskCommandExecutionDependencies["deliver"]>[0]>((resolve) => {
			enterLaunch = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		launch.mockImplementationOnce(async (record) => {
			enterLaunch(record);
			await release;
		});
		const starting = service.start("workspace", request);
		const record = await entered;
		const recovering = service.sweepExecution("workspace", record.executionId);
		releaseLaunch();
		await Promise.all([starting, recovering]);
		expect(launch).toHaveBeenCalledTimes(1);
	});

	it("旧结果路径不能被新的所属执行复用", async () => {
		const { service, request, deliver } = fixture();
		await writeFile(
			request.specification.resultFile,
			JSON.stringify({ disposition: "agent_review_ready", result: "旧结果" }),
		);
		await expect(service.start("workspace", request)).rejects.toThrow("唯一结果路径");
		expect(deliver).not.toHaveBeenCalled();
	});

	it("Stop 对所有所属执行先撤销，再等待任何慢取消", async () => {
		const { service, request, cancel } = fixture();
		const first = await service.start("workspace", request);
		const second = await service.start("workspace", {
			...request,
			idempotencyKey: "second",
			specification: { ...request.specification, resultFile: join(directory, "second-result.json") },
		});
		cancel.mockImplementation(async () => {
			for (const record of [first, second])
				expect(JSON.parse(await readFile(record.revocationFile, "utf8")).executionId).toBe(record.executionId);
			return { nativeCancellationStatus: "unknown" };
		});
		await service.cancelForTask("workspace", "task");
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	it("已冻结结果在原文件消失后继续交回，不重新启动业务", async () => {
		const { service, request, deliver, launch, inspectWorker } = fixture();
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		await rm(request.specification.resultFile);
		inspectWorker.mockResolvedValue("exited");
		await service.sweepExecution("workspace", record.executionId);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("归属异步核验期间 Stop 会阻止实际写入", async () => {
		const { service, request, owner, deliver, readOwner } = fixture();
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		let wroteAfterStop = false;
		deliver.mockImplementationOnce(async (_record, validate) => {
			readOwner.mockImplementationOnce(async () => {
				await service.cancel("workspace", record);
				return owner;
			});
			await validate("before_first_transport_write");
			wroteAfterStop = true;
			return { ok: true, summary: null };
		});
		await service.sweepExecution("workspace", record.executionId);
		expect(wroteAfterStop).toBe(false);
		expect((await service.inspect("workspace", record)).resultDelivery?.attemptCount).toBe(0);
	});

	it("原生接受后排队的成功回执完成交回，显式取消仍撤销所属工作", async () => {
		const { service, request, deliver, cancel } = fixture();
		deliver.mockImplementationOnce(async (_record, validate, settled) => {
			await validate("before_first_transport_write");
			const receipt = { status: "delivered_queued_behind_active_agent_turn" as const, reason: null };
			await settled(receipt);
			return { ok: true, summary: null, terminalDelivery: receipt };
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		expect((await service.inspect("workspace", record)).resultDelivery?.state).toBe("native_accepted");
		await service.cancel("workspace", record);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect((await service.inspect("workspace", record)).revokedAtEpochMs).not.toBeNull();
	});
	it("相同材料复用，改变材料报冲突，快速完成只交回一次", async () => {
		const { service, request, launch, deliver } = fixture();
		const first = await service.start("workspace", request);
		const again = await service.start("workspace", request);
		expect(first.executionId).toBe(again.executionId);
		expect(launch).toHaveBeenCalledTimes(1);
		await expect(
			service.start("workspace", { ...request, specification: { ...request.specification, label: "不同材料" } }),
		).rejects.toThrow("材料");
		await writeFile(
			request.specification.resultFile,
			JSON.stringify({ disposition: "agent_review_ready", status: "ready_to_commit" }),
		);
		await service.sweepExecution("workspace", first.executionId);
		await service.sweepExecution("workspace", first.executionId);
		expect(deliver).toHaveBeenCalledTimes(1);
		const state = await service.inspect("workspace", { taskId: "task", executionId: first.executionId });
		expect(state.resultDelivery?.state).toBe("native_accepted");
		expect(state.logicalResultCount).toBe(1);
	});

	it("退出码 0 和机器等待不产生 Agent 结果", async () => {
		const { service, request, deliver } = fixture();
		const record = await service.start("workspace", request);
		await writeFile(
			request.specification.resultFile,
			JSON.stringify({
				disposition: "machine_evidence_pending",
				recovery: {
					trigger: "credentials_changed",
					action: "resume_same_run",
					maximum_unchanged_retries: 1,
				},
			}),
		);
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).not.toHaveBeenCalled();
		const state = await service.inspect("workspace", { taskId: "task", executionId: record.executionId });
		expect(state.businessDisposition).toBe("machine_evidence_pending");
		expect(state.recovery).toBeTruthy();
	});

	it("没有截止时间的机器等待按已登记动作有界恢复，进度时间戳不重置预算", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const record = await service.start("workspace", request);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const pending = {
				disposition: "machine_evidence_pending",
				recovery: { trigger: "transient_failure", action: "resume_same_run", maximum_unchanged_retries: 1 },
			};
			await writeFile(request.specification.resultFile, JSON.stringify(pending));
			await service.sweepExecution("workspace", record.executionId);
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
			await writeFile(request.specification.resultFile, JSON.stringify({ ...pending, updated_at: now }));
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});

	it("原生主会话变化只暂停结果交回，机器进度和恢复继续", async () => {
		const { service, request, owner, launch, inspectWorker, deliver } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const record = await service.start("workspace", request);
		owner.nativeSessionId = "replacement-native-session";
		await writeFile(
			request.specification.resultFile,
			JSON.stringify({
				disposition: "machine_evidence_pending",
				recovery: { action: "resume_same_run", maximum_unchanged_retries: 1, retry_not_before_epoch_ms: 1 },
			}),
		);
		await service.sweepExecution("workspace", record.executionId);
		await service.sweepExecution("workspace", record.executionId);
		expect((await service.inspect("workspace", record)).businessDisposition).toBe("machine_evidence_pending");
		expect(launch).toHaveBeenCalledTimes(2);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("同一会话的两个已完成执行分别解除自己的等待并交回", async () => {
		const { service, request, deliver, summary } = fixture();
		const first = await service.start("workspace", request);
		const secondRequest = {
			...request,
			idempotencyKey: "second-work",
			specification: { ...request.specification, resultFile: join(directory, "second-business-result.json") },
		};
		const second = await service.start("workspace", secondRequest);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await writeFile(secondRequest.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", first.executionId);
		await service.sweepExecution("workspace", second.executionId);
		await service.sweepExecution("workspace", first.executionId);
		expect(deliver).toHaveBeenCalledTimes(2);
		expect(summary.awaitingDispatchedBackgroundWork).toBeUndefined();
	});

	it("Stop 先持久撤销，重启及迟到结果不能恢复派发或交回", async () => {
		const { service, request, deliver, cancel } = fixture();
		const record = await service.start("workspace", request);
		cancel.mockImplementationOnce(async (current) => {
			expect(JSON.parse(await readFile(current.revocationFile, "utf8")).executionId).toBe(record.executionId);
			return { localProcessStatus: "exited", nativeCancellationStatus: "unknown" };
		});
		await service.cancel("workspace", { taskId: "task", executionId: record.executionId });
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).not.toHaveBeenCalled();
		expect(
			(await service.inspect("workspace", { taskId: "task", executionId: record.executionId })).revokedAtEpochMs,
		).toBeTruthy();
	});

	it("撤销原件已落盘而执行记录尚未更新的崩溃窗口也不会交回", async () => {
		const { service, request, deliver } = fixture();
		const record = await service.start("workspace", request);
		await writeFile(record.revocationFile, JSON.stringify({ executionId: record.executionId, revokedAtEpochMs: 19 }));
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).not.toHaveBeenCalled();
		const restored = await service.inspect("workspace", record);
		expect(restored.revokedAtEpochMs).toBe(19);
		expect(restored.revokedLaunchAttemptCount).toBe(restored.launchAttemptCount);
		expect(restored.revokedResultWriteAttemptCount).toBe(0);
	});

	it("模态审批和 task incarnation 变化阻止交回", async () => {
		const { service, request, deliver, owner, summary } = fixture();
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		summary.turnOwner = "user";
		summary.userTurnKind = "permission";
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).not.toHaveBeenCalled();
		summary.turnOwner = "agent";
		summary.userTurnKind = null;
		owner.taskIncarnationCreatedAtEpochMs = 8;
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("提交未知只补证，不换 key 重发", async () => {
		const { service, request, deliver, reconcileDelivery } = fixture();
		deliver.mockImplementationOnce(async (_record, validate) => {
			await validate("before_first_transport_write");
			throw new Error("模拟写入后、受理回执前进程退出");
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		await service.sweepExecution("workspace", record.executionId);
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(reconcileDelivery).toHaveBeenCalledTimes(1);
		expect(
			(await service.inspect("workspace", { taskId: "task", executionId: record.executionId })).resultDelivery
				?.state,
		).toBe("submission_unknown");
	});

	it("超时失败保留提交未知和所属等待，不把失败当成可重投证据", async () => {
		const { service, request, deliver, summary } = fixture();
		deliver.mockImplementationOnce(async (_record, validate, settled) => {
			await validate("before_first_transport_write");
			await settled({ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" });
			return {
				ok: false,
				summary: null,
				terminalDelivery: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
			};
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect((await service.inspect("workspace", record)).resultDelivery?.state).toBe("submission_unknown");
		expect(summary.awaitingDispatchedBackgroundWork?.owningCommandExecutionIds).toContain(record.executionId);
	});

	it("精确绑定尝试的 ACP 未派发证据允许有界重投", async () => {
		const { service, request, deliver } = fixture();
		deliver.mockImplementationOnce(async (record, validate, settled) => {
			await validate("before_first_transport_write");
			if (!record.resultDelivery?.attemptId) throw new Error("测试未取得精确投递尝试");
			const receipt = {
				status: "delivery_failed" as const,
				reason: "no_active_terminal_session" as const,
				nativePromptSubmissionNotStartedEvidence: {
					source: "acp_input_rejected_before_prompt_registration" as const,
					clientUserMessageId: record.resultDelivery.resultId,
					submissionAttemptId: record.resultDelivery.attemptId,
					nativeSessionId: record.originatingNativeSessionId,
					reason: "request_busy" as const,
				},
			};
			await settled(receipt);
			return { ok: false, summary: null, terminalDelivery: receipt };
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		expect((await service.inspect("workspace", record)).resultDelivery?.state).toBe("known_not_submitted");
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(1);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001);
		try {
			await service.sweepExecution("workspace", record.executionId);
			expect(deliver).toHaveBeenCalledTimes(2);
			expect((await service.inspect("workspace", record)).resultDelivery?.state).toBe("native_accepted");
		} finally {
			clock.mockRestore();
		}
	});

	it("transport 等待可写状态期间不重复派发，也不消耗真实写入尝试", async () => {
		const { service, request, deliver } = fixture();
		deliver.mockImplementationOnce(async (_record, validate) => {
			await validate("before_transport_acceptance");
			return {
				ok: true,
				summary: null,
				terminalDelivery: { status: "accepted_pending_submit_confirmation", reason: null },
			};
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		await service.sweepExecution("workspace", record.executionId);
		expect(deliver).toHaveBeenCalledTimes(1);
		const state = await service.inspect("workspace", record);
		expect(state.resultDelivery?.attemptCount).toBe(0);
		expect(state.resultDelivery?.awaitingTransportReceipt).toBe(true);
	});

	it("旧托管者迟到回执不能接受新托管记录", async () => {
		const { service, request, deliver } = fixture();
		let lateReceipt: Parameters<TaskCommandExecutionDependencies["deliver"]>[2] | null = null;
		deliver.mockImplementationOnce(async (_record, validate, settled) => {
			await validate("before_first_transport_write");
			lateReceipt = settled;
			return {
				ok: true,
				summary: null,
				terminalDelivery: { status: "accepted_pending_submit_confirmation", reason: null },
			};
		});
		const record = await service.start("workspace", request);
		await writeFile(request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await service.sweepExecution("workspace", record.executionId);
		await mutateTaskCommandExecutions("workspace", (records) => ({
			records: records.map((item) => ({ ...item, custodianRuntimeProcessInstanceId: "different-runtime" })),
			result: undefined,
		}));
		if (!lateReceipt) throw new Error("未登记原投递回执");
		await (lateReceipt as Parameters<TaskCommandExecutionDependencies["deliver"]>[2])({
			status: "delivered_and_submit_confirmed",
			reason: null,
		});
		expect((await service.inspect("workspace", record)).resultDelivery?.state).toBe("submission_unknown");
	});
});
