import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import * as recoveryObservation from "../../../src/task-command-execution/read-only-task-command-execution-recovery-evidence-observation";
import * as continuationNotices from "../../../src/task-command-execution/task-command-execution-continuation-notices";
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

it("生产方先持久撤销后崩溃，旧业务结果和通知清单也不能恢复交回", async () => {
	const f = fixture();
	const producerExecutionRevocationFile = join(directory, "producer-execution-revocation.json");
	const noticesFile = join(directory, "continuation-notices.json");
	const record = await f.service.start("workspace", {
		...f.request,
		specification: {
			...f.request.specification,
			producerExecutionRevocationFile,
			continuationNoticesFile: noticesFile,
		},
	});
	const acceptedNotice = { noticeId: "accepted-findings", stage: "findings", text: "发现已交回。" };
	await writeFile(noticesFile, JSON.stringify({ notices: [acceptedNotice] }));
	await f.service.sweepExecution("workspace", record.executionId);
	const accepted = (await f.service.inspect("workspace", record)).resultDelivery;
	expect(accepted?.state).toBe("native_accepted");
	await writeFile(f.request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
	await writeFile(
		noticesFile,
		JSON.stringify({ notices: [{ noticeId: "late-final", stage: "final", text: "旧最终通知。" }] }),
	);
	await writeFile(
		producerExecutionRevocationFile,
		JSON.stringify({ source: "explicit_stop", scope: "exact_rvf_run" }),
	);
	await f.service.sweepExecution("workspace", record.executionId);
	await f.service.sweepExecution("workspace", record.executionId);
	const cancelled = await f.service.inspect("workspace", record);
	expect(cancelled.revokedAtEpochMs).not.toBeNull();
	expect(cancelled.resultDelivery).toEqual(accepted);
	expect(f.deliver).toHaveBeenCalledTimes(1);
	expect(f.launch).toHaveBeenCalledTimes(1);
	expect(JSON.parse(await readFile(record.revocationFile, "utf8")).source).toBe(
		"producer_execution_revocation_evidence_file",
	);
});

it("最终写前读取结束后出现生产方撤销原件，仍不执行原生写入", async () => {
	const f = fixture();
	const producerExecutionRevocationFile = join(directory, "producer-execution-revocation.json");
	const noticesFile = join(directory, "continuation-notices.json");
	const record = await f.service.start("workspace", {
		...f.request,
		specification: {
			...f.request.specification,
			producerExecutionRevocationFile,
			continuationNoticesFile: noticesFile,
		},
	});
	await writeFile(
		noticesFile,
		JSON.stringify({ notices: [{ noticeId: "before-stop", stage: "final", text: "停止前通知。" }] }),
	);
	const actual = continuationNotices.assertTaskCommandContinuationNoticeStillEligible;
	const eligibility = vi
		.spyOn(continuationNotices, "assertTaskCommandContinuationNoticeStillEligible")
		.mockImplementation(async (current) => {
			await actual(current);
			const persisted = await f.service.inspect("workspace", record);
			if (persisted.resultDelivery?.state === "submission_unknown")
				await writeFile(producerExecutionRevocationFile, JSON.stringify({ source: "explicit_stop" }));
		});
	let nativeWriteCount = 0;
	f.deliver.mockImplementationOnce(async (_current, validate) => {
		await validate("before_first_transport_write");
		nativeWriteCount += 1;
		return { ok: true, summary: f.summary };
	});
	try {
		await f.service.sweepExecution("workspace", record.executionId);
		expect(nativeWriteCount).toBe(0);
		await f.service.sweepExecution("workspace", record.executionId);
		expect((await f.service.inspect("workspace", record)).revokedAtEpochMs).not.toBeNull();
		expect(f.deliver).toHaveBeenCalledTimes(1);
	} finally {
		eligibility.mockRestore();
	}
});

describe("所属执行与一次逻辑交回", () => {
	it("确证未提交的回退更换正文后使用新消息身份以保留冻结账本", async () => {
		const f = fixture();
		const record = await f.service.start("workspace", f.request);
		const frozenLedgerMessageSha256ByResultId = new Map<string, string>();
		let nativeMessageWriteCount = 0;
		let immutableLedgerMessageIdentityConflictCount = 0;
		f.deliver.mockImplementation(async (deliveryRecord, validate, settled) => {
			const delivery = deliveryRecord.resultDelivery;
			if (!delivery || !delivery.attemptId) throw new Error("缺少本次投递身份");
			const existing = frozenLedgerMessageSha256ByResultId.get(delivery.resultId);
			// 对应 runtime-server：账本在 transport 之前登记，随后才进入写前阶段。
			if (existing && existing !== delivery.textSha256) {
				immutableLedgerMessageIdentityConflictCount += 1;
				throw new Error("所属结果的原生发送意图与冻结身份不符");
			}
			frozenLedgerMessageSha256ByResultId.set(delivery.resultId, delivery.textSha256);
			await validate("before_first_transport_write");
			if (delivery.text.includes("结果：agent_review_ready")) {
				const receipt = {
					status: "delivery_failed" as const,
					reason: null,
					failureNote: "ACP 在原生 prompt 登记前因忙碌拒绝写入",
					nativePromptSubmissionNotStartedEvidence: {
						source: "acp_input_rejected_before_prompt_registration" as const,
						reason: "request_busy" as const,
						clientUserMessageId: delivery.resultId,
						submissionAttemptId: delivery.attemptId,
						nativeSessionId: deliveryRecord.originatingNativeSessionId,
					},
				};
				await settled(receipt);
				return { ok: false, summary: f.summary, terminalDelivery: receipt };
			}
			nativeMessageWriteCount += 1;
			const receipt = { status: "delivered_and_submit_confirmed" as const, reason: null };
			await settled(receipt);
			return { ok: true, summary: f.summary, terminalDelivery: receipt };
		});
		await writeFile(f.request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await f.service.sweepExecution("workspace", record.executionId);
		const unsubmitted = await f.service.inspect("workspace", record);
		expect(unsubmitted.resultDelivery?.state).toBe("known_not_submitted");
		expect(unsubmitted.resultDelivery?.attemptCount).toBe(1);
		const frozenResultId = unsubmitted.resultDelivery?.resultId;
		const frozenText = unsubmitted.resultDelivery?.text;
		await writeFile(f.request.specification.resultFile, JSON.stringify({ disposition: "agent_judgment_required" }));
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).toHaveBeenCalledTimes(2);
		expect(immutableLedgerMessageIdentityConflictCount).toBe(0);
		expect(nativeMessageWriteCount).toBe(1);
		const delivered = f.deliver.mock.calls[1]?.[0].resultDelivery;
		expect(delivered?.text).toContain("结果：agent_judgment_required");
		expect(delivered?.resultId).not.toBe(frozenResultId);
		const accepted = await f.service.inspect("workspace", record);
		expect(accepted.resultDelivery?.state).toBe("native_accepted");
		expect(accepted.resultDelivery?.text).toContain("结果：agent_judgment_required");
		expect(accepted.resultDelivery?.resultId).toBe(delivered?.resultId);
		expect(accepted.resultDeliveryHistory).toHaveLength(1);
		expect(accepted.resultDeliveryHistory[0]?.resultId).toBe(frozenResultId);
		expect(accepted.resultDeliveryHistory[0]?.text).toBe(frozenText);
		expect(accepted.resultDeliveryHistory[0]?.state).toBe("known_not_submitted");
		expect(accepted.resultDeliveryHistory[0]?.attemptCount).toBe(1);
		expect(frozenLedgerMessageSha256ByResultId.get(frozenResultId ?? "")).toBe(
			accepted.resultDeliveryHistory[0]?.textSha256,
		);
	});

	it("精简通知不把完整业务 JSON 和验证脚本写进主会话", async () => {
		const f = fixture();
		const record = await f.service.start("workspace", f.request);
		await writeFile(
			f.request.specification.resultFile,
			JSON.stringify({
				disposition: "agent_review_ready",
				validation: { commands: ["完整验证脚本不应进入默认续接上下文"] },
				agentContinuationNotice: {
					noticeId: "final-revision-1",
					stage: "final_agent_review",
					text: "RVF 已完成，待最终审阅。摘要：/持久目录/agent-review-summary.md",
				},
			}),
		);
		await f.service.sweepExecution("workspace", record.executionId);
		const delivered = f.deliver.mock.calls[0]?.[0];
		expect(delivered?.resultDelivery?.text).toContain("RVF 已完成");
		expect(delivered?.resultDelivery?.text).not.toContain("完整验证脚本");
	});

	it("后台 findings 与最终修订分别只交回一次，原生接受历史追加保留", async () => {
		const f = fixture();
		const noticesFile = join(directory, "agent-continuation-notices.json");
		const record = await f.service.start("workspace", {
			...f.request,
			specification: { ...f.request.specification, continuationNoticesFile: noticesFile },
		});
		const reviewerNotice = {
			noticeId: "reviewers-ready",
			stage: "reviewer_findings_available",
			text: "匿名发现可供并行核对。",
		};
		await writeFile(noticesFile, JSON.stringify({ notices: [reviewerNotice] }));
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).toHaveBeenCalledTimes(1);
		expect(f.launch).toHaveBeenCalledTimes(1);
		const finalNotice = { noticeId: "final-1", stage: "final_agent_review", text: "第一版结果。" };
		await writeFile(noticesFile, JSON.stringify({ notices: [reviewerNotice, finalNotice] }));
		await writeFile(
			f.request.specification.resultFile,
			JSON.stringify({ disposition: "agent_review_ready", agentContinuationNotice: finalNotice }),
		);
		await f.service.sweepExecution("workspace", record.executionId);
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).toHaveBeenCalledTimes(2);
		const pending = {
			disposition: "machine_evidence_pending",
			recovery: {
				action: "resume_same_run",
				continuation_request_id: "registered-context-fact-1",
				maximum_unchanged_retries: 0,
				trigger: "registered_context_supplement_changed",
			},
		};
		await writeFile(f.request.specification.resultFile, JSON.stringify(pending));
		await writeFile(noticesFile, JSON.stringify({ notices: [reviewerNotice] }));
		f.inspectWorker.mockResolvedValue("exited");
		await f.service.sweepExecution("workspace", record.executionId);
		const advancedTime = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
		try {
			await f.service.sweepExecution("workspace", record.executionId);
			expect(f.launch).toHaveBeenCalledTimes(2);
		} finally {
			advancedTime.mockRestore();
		}
		const revisedNotice = { ...finalNotice, noticeId: "final-2", text: "补充已覆盖的最新结果。" };
		await writeFile(noticesFile, JSON.stringify({ notices: [reviewerNotice, revisedNotice] }));
		await writeFile(
			f.request.specification.resultFile,
			JSON.stringify({ disposition: "agent_review_ready", agentContinuationNotice: revisedNotice }),
		);
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).toHaveBeenCalledTimes(3);
		const revised = await f.service.inspect("workspace", record);
		expect(revised.resultDeliveryHistory).toHaveLength(2);
		expect(revised.resultDeliveryHistory.every((delivery) => delivery.state === "native_accepted")).toBe(true);
	});

	it("保留策略使 Esc/Ctrl+C 仅打断主回合；明确任务停止仍持久撤销", async () => {
		const f = fixture();
		const record = await f.service.start("workspace", {
			...f.request,
			specification: { ...f.request.specification, ownerSessionInterruptPolicy: "preserve_execution" },
		});
		await f.service.handleOwnerSessionInterrupt("workspace", "task-session");
		expect((await f.service.inspect("workspace", record)).revokedAtEpochMs).toBeNull();
		expect(f.cancel).not.toHaveBeenCalled();
		await f.service.cancelForTask("workspace", "task");
		const intent = JSON.parse(await readFile(record.revocationFile, "utf8"));
		expect(intent.source).toBe("explicit_task_session_stop");
		expect(intent.scope).toBe("task_owned_command_executions");
		expect(intent.requestBasis).toBeTruthy();
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.launch).toHaveBeenCalledTimes(1);
		expect(f.deliver).not.toHaveBeenCalled();
	});

	it("结果已提交但接受未知时，重建服务先对账旧消息，再交回新修订", async () => {
		const f = fixture();
		const noticesFile = join(directory, "continuation-notices.json");
		const record = await f.service.start("workspace", {
			...f.request,
			specification: { ...f.request.specification, continuationNoticesFile: noticesFile },
		});
		const first = { noticeId: "final-before-late-context", stage: "final_agent_review", text: "补充到达前的结果。" };
		await writeFile(noticesFile, JSON.stringify({ notices: [first] }));
		f.deliver.mockImplementationOnce(async (_record, validate) => {
			await validate("before_first_transport_write");
			throw new Error("原生提交可能已接受，传输回执丢失");
		});
		await f.service.sweepExecution("workspace", record.executionId);
		expect((await f.service.inspect("workspace", record)).resultDelivery?.state).toBe("submission_unknown");
		f.service.stop();
		const restarted = fixture();
		const revised = { ...first, noticeId: "final-after-late-context", text: "已覆盖迟到补充的结果。" };
		await writeFile(noticesFile, JSON.stringify({ notices: [revised] }));
		restarted.reconcileDelivery.mockResolvedValue("native_accepted");
		await restarted.service.sweepExecution("workspace", record.executionId);
		expect(restarted.reconcileDelivery).toHaveBeenCalledTimes(1);
		expect(restarted.deliver).not.toHaveBeenCalled();
		await restarted.service.sweepExecution("workspace", record.executionId);
		expect(restarted.deliver).toHaveBeenCalledTimes(1);
		expect(restarted.deliver.mock.calls[0]?.[0].resultDelivery?.text).toContain(revised.text);
		const final = await restarted.service.inspect("workspace", record);
		expect(final.resultDeliveryHistory[0]?.text).toContain(first.text);
		expect(final.resultDeliveryHistory[0]?.state).toBe("native_accepted");
	});

	it("主会话忙碌时先保存通知，实际写入前撤回旧修订，后台工作继续", async () => {
		const f = fixture();
		const noticesFile = join(directory, "continuation-notices.json");
		const record = await f.service.start("workspace", {
			...f.request,
			specification: { ...f.request.specification, continuationNoticesFile: noticesFile },
		});
		const notice = { noticeId: "pending-review", stage: "final_agent_review", text: "旧修订" };
		await writeFile(noticesFile, JSON.stringify({ notices: [notice] }));
		f.owner.isNativeInputSubmissionBusy = true;
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).not.toHaveBeenCalled();
		f.owner.isNativeInputSubmissionBusy = false;
		let wrote = false;
		f.deliver.mockImplementationOnce(async (_record, validate) => {
			await writeFile(noticesFile, JSON.stringify({ notices: [] }));
			await validate("before_first_transport_write");
			wrote = true;
			return { ok: true, summary: f.summary };
		});
		await f.service.sweepExecution("workspace", record.executionId);
		expect(wrote).toBe(false);
		expect((await f.service.inspect("workspace", record)).revokedAtEpochMs).toBeNull();
		expect(f.cancel).not.toHaveBeenCalled();
	});
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

	it("语义观察优先时千次心跳和进程重启不补发预算，未知观察保持原预算", async () => {
		const first = fixture();
		first.inspectWorker.mockResolvedValue("exited");
		const semanticObservation = vi
			.spyOn(recoveryObservation, "readOnlyTaskCommandExecutionRecoveryEvidenceObservation")
			.mockResolvedValue("b".repeat(64));
		const heartbeatFile = join(directory, "controller-heartbeat.json");
		const record = await first.service.start("workspace", {
			...first.request,
			specification: {
				...first.request.specification,
				recoveryEvidenceObservationMode: "semantic_observation_only",
				readOnlyRecoveryEvidenceObservationCommand: [process.execPath, "-e", ""],
				recoveryEvidencePaths: [heartbeatFile],
			},
		});
		const pending = {
			disposition: "machine_evidence_pending",
			recovery: { action: "resume_same_run", maximum_unchanged_retries: 0 },
		};
		await writeFile(first.request.specification.resultFile, JSON.stringify(pending));
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await first.service.sweepExecution("workspace", record.executionId);
			for (let heartbeat = 0; heartbeat < 1000; heartbeat++) {
				await writeFile(heartbeatFile, JSON.stringify({ last_observed_at: heartbeat }));
				now += 30_001;
				await first.service.sweepExecution("workspace", record.executionId);
			}
			expect(first.launch).toHaveBeenCalledTimes(1);
			const saved = await first.service.inspect("workspace", record);
			first.service.stop();
			const resumed = fixture();
			resumed.inspectWorker.mockResolvedValue("exited");
			semanticObservation.mockResolvedValue("read_only_observation_unavailable");
			now += 30_001;
			await resumed.service.sweepExecution("workspace", record.executionId);
			const unknown = await resumed.service.inspect("workspace", record);
			expect(unknown.lastRecoveryEvidenceSha256).toBe(saved.lastRecoveryEvidenceSha256);
			expect(unknown.unchangedRecoveryAttemptCount).toBe(saved.unchangedRecoveryAttemptCount);
			expect(unknown.recoveryEvidenceObservationStatus).toBe("unknown");
			semanticObservation.mockResolvedValue("c".repeat(64));
			now += 30_001;
			await resumed.service.sweepExecution("workspace", record.executionId);
			expect(resumed.launch).toHaveBeenCalledTimes(1);
			semanticObservation.mockResolvedValue("b".repeat(64));
			now += 30_001;
			await resumed.service.sweepExecution("workspace", record.executionId);
			expect(resumed.launch).toHaveBeenCalledTimes(1);
			now += 30_001;
			await resumed.service.sweepExecution("workspace", record.executionId);
			expect(resumed.launch).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
			semanticObservation.mockRestore();
		}
	}, 120_000);

	it("语义观察按当前重试上限收放同一证据的剩余次数，不沿用首次快照", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const semanticObservation = vi
			.spyOn(recoveryObservation, "readOnlyTaskCommandExecutionRecoveryEvidenceObservation")
			.mockResolvedValue("b".repeat(64));
		const record = await service.start("workspace", {
			...request,
			specification: {
				...request.specification,
				recoveryEvidenceObservationMode: "semantic_observation_only",
				readOnlyRecoveryEvidenceObservationCommand: [process.execPath, "-e", ""],
			},
		});
		const pending = (maximumUnchangedRetries: number) => ({
			disposition: "machine_evidence_pending",
			recovery: { action: "resume_same_run", maximum_unchanged_retries: maximumUnchangedRetries },
		});
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await writeFile(request.specification.resultFile, JSON.stringify(pending(3)));
			await service.sweepExecution("workspace", record.executionId);
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
			await writeFile(request.specification.resultFile, JSON.stringify(pending(0)));
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
			const lowered = Object.values(
				(await service.inspect("workspace", record)).recoveryEvidenceAttemptBudgets ?? {},
			);
			expect(lowered).toEqual([
				{ resumeAttemptsUsed: 1, maximumResumeAttempts: 0, includesEvidenceTransitionLaunch: false },
			]);
		} finally {
			clock.mockRestore();
			semanticObservation.mockRestore();
		}
	});

	it("语义观察把上限从 0 调高后补发尚未使用的次数", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const semanticObservation = vi
			.spyOn(recoveryObservation, "readOnlyTaskCommandExecutionRecoveryEvidenceObservation")
			.mockResolvedValue("b".repeat(64));
		const record = await service.start("workspace", {
			...request,
			specification: {
				...request.specification,
				recoveryEvidenceObservationMode: "semantic_observation_only",
				readOnlyRecoveryEvidenceObservationCommand: [process.execPath, "-e", ""],
			},
		});
		const pending = (maximumUnchangedRetries: number) => ({
			disposition: "machine_evidence_pending",
			recovery: { action: "resume_same_run", maximum_unchanged_retries: maximumUnchangedRetries },
		});
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await writeFile(request.specification.resultFile, JSON.stringify(pending(0)));
			await service.sweepExecution("workspace", record.executionId);
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(1);
			await writeFile(request.specification.resultFile, JSON.stringify(pending(1)));
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
			semanticObservation.mockRestore();
		}
	});

	it("新语义证据在上限降到 0 后不再使用登记时多出来的次数，事后调高才补剩余次数", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const semanticObservation = vi
			.spyOn(recoveryObservation, "readOnlyTaskCommandExecutionRecoveryEvidenceObservation")
			.mockResolvedValue("b".repeat(64));
		const record = await service.start("workspace", {
			...request,
			specification: {
				...request.specification,
				recoveryEvidenceObservationMode: "semantic_observation_only",
				readOnlyRecoveryEvidenceObservationCommand: [process.execPath, "-e", ""],
			},
		});
		const pending = (maximumUnchangedRetries: number) => ({
			disposition: "machine_evidence_pending",
			recovery: { action: "resume_same_run", maximum_unchanged_retries: maximumUnchangedRetries },
		});
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await writeFile(request.specification.resultFile, JSON.stringify(pending(1)));
			await service.sweepExecution("workspace", record.executionId);
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
			semanticObservation.mockResolvedValue("c".repeat(64));
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(3);
			await writeFile(request.specification.resultFile, JSON.stringify(pending(0)));
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(3);
			const transition = Object.values(
				(await service.inspect("workspace", record)).recoveryEvidenceAttemptBudgets ?? {},
			).find((budget) => budget.includesEvidenceTransitionLaunch);
			expect(transition).toEqual({
				resumeAttemptsUsed: 1,
				maximumResumeAttempts: 1,
				includesEvidenceTransitionLaunch: true,
			});
			await writeFile(request.specification.resultFile, JSON.stringify(pending(1)));
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(4);
		} finally {
			clock.mockRestore();
			semanticObservation.mockRestore();
		}
	});

	it("已消费的 continuation 在追加观察器后不重新领取恢复次数", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const record = await service.start("workspace", request);
		const pending = (continuationRequestId: string) => ({
			disposition: "machine_evidence_pending",
			recovery: {
				action: "resume_same_run",
				continuation_request_id: continuationRequestId,
				maximum_unchanged_retries: 0,
			},
		});
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const semanticObservation = vi
			.spyOn(recoveryObservation, "readOnlyTaskCommandExecutionRecoveryEvidenceObservation")
			.mockResolvedValue("b".repeat(64));
		try {
			await writeFile(request.specification.resultFile, JSON.stringify(pending("same-pending-request")));
			await service.sweepExecution("workspace", record.executionId);
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
			await service.registerRecoveryEvidenceObservation("workspace", {
				taskId: record.taskId,
				executionId: record.executionId,
				expectedMaterialSha256: record.materialSha256,
				command: [process.execPath, "-e", ""],
				mode: "semantic_observation_only",
			});
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
			const bound = await service.inspect("workspace", record);
			expect(bound.launchAttemptCount).toBe(2);
			expect(Object.values(bound.recoveryEvidenceAttemptBudgets ?? {})).toEqual([
				{ resumeAttemptsUsed: 0, maximumResumeAttempts: 0, includesEvidenceTransitionLaunch: false },
			]);
		} finally {
			clock.mockRestore();
			semanticObservation.mockRestore();
		}
	});

	it("追加观察器时 continuation 已换成新请求，仍允许一次语义恢复", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const record = await service.start("workspace", request);
		const pending = (continuationRequestId: string) => ({
			disposition: "machine_evidence_pending",
			recovery: {
				action: "resume_same_run",
				continuation_request_id: continuationRequestId,
				maximum_unchanged_retries: 0,
			},
		});
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const semanticObservation = vi
			.spyOn(recoveryObservation, "readOnlyTaskCommandExecutionRecoveryEvidenceObservation")
			.mockResolvedValue("b".repeat(64));
		try {
			await writeFile(request.specification.resultFile, JSON.stringify(pending("request-a")));
			await service.sweepExecution("workspace", record.executionId);
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(2);
			await service.registerRecoveryEvidenceObservation("workspace", {
				taskId: record.taskId,
				executionId: record.executionId,
				expectedMaterialSha256: record.materialSha256,
				command: [process.execPath, "-e", ""],
				mode: "semantic_observation_only",
			});
			await writeFile(request.specification.resultFile, JSON.stringify(pending("request-b")));
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(3);
		} finally {
			clock.mockRestore();
			semanticObservation.mockRestore();
		}
	});

	it("已读到旧记录的扫描在观察器登记后不再按诊断心跳派发", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const diagnostic = join(directory, "diagnostic-heartbeat.json");
		await writeFile(diagnostic, "heartbeat-0");
		const record = await service.start("workspace", {
			...request,
			specification: { ...request.specification, recoveryEvidencePaths: [diagnostic] },
		});
		await writeFile(
			request.specification.resultFile,
			JSON.stringify({
				disposition: "machine_evidence_pending",
				recovery: { action: "resume_same_run", maximum_unchanged_retries: 0 },
			}),
		);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(1);
			let releaseInspection: () => void = () => undefined;
			const inspectionBlocked = new Promise<void>((resolve) => {
				releaseInspection = () => resolve();
			});
			let reportInspectionEntered: () => void = () => undefined;
			const inspectionEntered = new Promise<void>((resolve) => {
				reportInspectionEntered = () => resolve();
			});
			let alreadyBlocked = false;
			inspectWorker.mockImplementation(async () => {
				if (!alreadyBlocked) {
					alreadyBlocked = true;
					reportInspectionEntered();
					await inspectionBlocked;
				}
				return "exited";
			});
			await writeFile(diagnostic, "heartbeat-1");
			now += 30_001;
			const inFlight = service.sweepExecution("workspace", record.executionId);
			await inspectionEntered;
			await service.registerRecoveryEvidenceObservation("workspace", {
				taskId: record.taskId,
				executionId: record.executionId,
				expectedMaterialSha256: record.materialSha256,
				command: [process.execPath, "-e", "process.exitCode=2"],
				mode: "semantic_observation_only",
			});
			releaseInspection();
			await inFlight;
			const afterStaleSweep = await service.inspect("workspace", record);
			expect(afterStaleSweep.launchAttemptCount).toBe(1);
			expect(afterStaleSweep.recoveryEvidenceObservationStatus).toBe("unknown");
			now += 30_001;
			await service.sweepExecution("workspace", record.executionId);
			expect(launch).toHaveBeenCalledTimes(1);
			expect((await service.inspect("workspace", record)).recoveryEvidenceObservationStatus).toBe("unknown");
		} finally {
			clock.mockRestore();
		}
	});

	it("旧执行只追加绑定原材料的观察器，保留 spec、预算和撤销", async () => {
		const { service, request } = fixture();
		const record = await service.start("workspace", request);
		const registration = {
			taskId: record.taskId,
			executionId: record.executionId,
			expectedMaterialSha256: record.materialSha256,
			command: [process.execPath, "-e", ""],
			mode: "semantic_observation_only" as const,
		};
		await expect(
			service.registerRecoveryEvidenceObservation("workspace", {
				...registration,
				expectedMaterialSha256: "b".repeat(64),
			}),
		).rejects.toThrow("材料摘要");
		const attached = await service.registerRecoveryEvidenceObservation("workspace", registration);
		expect(attached.specification).toEqual(record.specification);
		expect(attached.materialSha256).toBe(record.materialSha256);
		expect(attached.launchAttemptCount).toBe(record.launchAttemptCount);
		expect(attached.unchangedRecoveryAttemptCount).toBe(record.unchangedRecoveryAttemptCount);
		expect(
			(await service.registerRecoveryEvidenceObservation("workspace", registration))
				.recoveryEvidenceObservationRegistration,
		).toEqual(attached.recoveryEvidenceObservationRegistration);
		await service.cancel("workspace", record);
		await expect(service.registerRecoveryEvidenceObservation("workspace", registration)).rejects.toThrow("撤销");
	});

	it.each(["semantic_change", "changing_failure_text"])(
		"只读恢复观察 %s 仅在稳定语义变化后重新取得有界预算",
		async (scenario) => {
			const { service, request, launch, inspectWorker } = fixture();
			inspectWorker.mockResolvedValue("exited");
			const observationFile = join(directory, "stable-observation.json");
			await writeFile(observationFile, JSON.stringify({ evidenceSha256: "b".repeat(64) }));
			const observationCommand = [
				process.execPath,
				"-e",
				scenario === "semantic_change"
					? `process.stdout.write(JSON.stringify({...JSON.parse(require('node:fs').readFileSync(${JSON.stringify(observationFile)},'utf8')),sampledAt:Date.now(),nonce:Math.random()}))`
					: `process.stderr.write(require('node:fs').readFileSync(${JSON.stringify(observationFile)},'utf8'));process.exitCode=2`,
			];
			const record = await service.start("workspace", {
				...request,
				specification: { ...request.specification, readOnlyRecoveryEvidenceObservationCommand: observationCommand },
			});
			await writeFile(
				request.specification.resultFile,
				JSON.stringify({
					disposition: "machine_evidence_pending",
					recovery: { action: "resume_same_run", maximum_unchanged_retries: 1 },
				}),
			);
			let now = Date.now();
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			try {
				await service.sweepExecution("workspace", record.executionId);
				now += 30_001;
				await service.sweepExecution("workspace", record.executionId);
				expect(launch).toHaveBeenCalledTimes(2);
				now += 30_001;
				await service.sweepExecution("workspace", record.executionId);
				expect(launch).toHaveBeenCalledTimes(2);
				await writeFile(observationFile, JSON.stringify({ evidenceSha256: "c".repeat(64) }));
				now += 30_001;
				await service.sweepExecution("workspace", record.executionId);
				expect(launch).toHaveBeenCalledTimes(scenario === "semantic_change" ? 3 : 2);
				await service.cancel("workspace", record);
				now += 30_001;
				await service.sweepExecution("workspace", record.executionId);
				expect(launch).toHaveBeenCalledTimes(scenario === "semantic_change" ? 3 : 2);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("Stop 会终止在途只读观察，不继续派发业务恢复", async () => {
		const { service, request, launch, inspectWorker } = fixture();
		inspectWorker.mockResolvedValue("exited");
		const startedFile = join(directory, "read-only-observation-started.txt");
		const descendantProcessIdentityFile = join(directory, "read-only-observation-descendant-process.txt");
		const record = await service.start("workspace", {
			...request,
			specification: {
				...request.specification,
				readOnlyRecoveryEvidenceObservationCommand: [
					process.execPath,
					"-e",
					`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(descendantProcessIdentityFile)},String(process.pid));setTimeout(()=>{},20000)`)}],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(startedFile)},'started');setTimeout(()=>{},20000)`,
				],
			},
		});
		await writeFile(
			request.specification.resultFile,
			JSON.stringify({ disposition: "machine_evidence_pending", recovery: { action: "resume_same_run" } }),
		);
		const sweep = service.sweepExecution("workspace", record.executionId).catch(() => undefined);
		await vi.waitFor(async () => expect(await readFile(startedFile, "utf8")).toBe("started"));
		let descendantProcessId = 0;
		await vi.waitFor(async () => {
			descendantProcessId = Number(await readFile(descendantProcessIdentityFile, "utf8"));
			expect(descendantProcessId).toBeGreaterThan(0);
		});
		await service.cancel("workspace", record);
		await sweep;
		await vi.waitFor(
			() => {
				try {
					const status = execFileSync("ps", ["-p", String(descendantProcessId), "-o", "stat="], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					}).trim();
					// kill(pid, 0) 对已结束、尚待宿主收尸的 zombie 也成功；原生 Z 状态已不能继续观察或产生副作用。
					expect(status).toMatch(/^Z/u);
				} catch (error) {
					if (!(error instanceof Error && "status" in error && error.status === 1)) throw error;
				}
			},
			{ timeout: 5_000 },
		);
		expect(launch).toHaveBeenCalledTimes(1);
		expect((await service.inspect("workspace", record)).businessDisposition).toBe("cancelled");
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

	it("写前复核发现修订尚未写入时退回未提交，并交回新通知", async () => {
		const f = fixture();
		const noticesFile = join(directory, "continuation-notices.json");
		const record = await f.service.start("workspace", {
			...f.request,
			specification: { ...f.request.specification, continuationNoticesFile: noticesFile },
		});
		const first = { noticeId: "before-rewrite", stage: "final_agent_review", text: "写前仍有效的修订。" };
		const revised = { noticeId: "after-rewrite", stage: "final_agent_review", text: "清单在未知标记之后被替换。" };
		await writeFile(noticesFile, JSON.stringify({ notices: [first] }));
		const originalUnpark = f.unpark.getMockImplementation();
		if (!originalUnpark) throw new Error("缺少 unpark fixture");
		f.unpark.mockImplementation(async (current) => {
			const persisted = (await readTaskCommandExecutions("workspace")).find(
				(item) => item.executionId === record.executionId,
			);
			if (persisted?.resultDelivery?.state === "submission_unknown")
				await writeFile(noticesFile, JSON.stringify({ notices: [revised] }));
			await originalUnpark(current);
		});
		let wrote = false;
		f.deliver.mockImplementationOnce(async (_ignored, validate) => {
			await validate("before_first_transport_write");
			wrote = true;
			return { ok: true, summary: f.summary };
		});
		await f.service.sweepExecution("workspace", record.executionId);
		expect(wrote).toBe(false);
		const stuck = await f.service.inspect("workspace", record);
		expect(stuck.resultDelivery?.state).toBe("known_not_submitted");
		expect(stuck.resultDelivery?.producerNoticeId).toBe(first.noticeId);
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).toHaveBeenCalledTimes(2);
		expect(f.deliver.mock.calls[1]?.[0].resultDelivery?.text).toContain(revised.text);
		expect(f.deliver.mock.calls[1]?.[0].resultDelivery?.producerNoticeId).toBe(revised.noticeId);
		const delivered = await f.service.inspect("workspace", record);
		expect(delivered.resultDelivery?.state).toBe("native_accepted");
		expect(delivered.resultDeliveryHistory.some((delivery) => delivery.producerNoticeId === first.noticeId)).toBe(
			true,
		);
	});

	it("未写出的通用回退在结果变为待证或需判断后不再发送成功文案", async () => {
		const f = fixture();
		const record = await f.service.start("workspace", f.request);
		await writeFile(f.request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		f.owner.isNativeInputSubmissionBusy = true;
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).not.toHaveBeenCalled();
		const pending = await f.service.inspect("workspace", record);
		expect(pending.resultDelivery?.text).toContain("结果：agent_review_ready");
		const pendingResultId = pending.resultDelivery?.resultId;
		await writeFile(
			f.request.specification.resultFile,
			JSON.stringify({ disposition: "machine_evidence_pending", recovery: { action: "resume_same_run" } }),
		);
		f.owner.isNativeInputSubmissionBusy = false;
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).not.toHaveBeenCalled();
		await writeFile(f.request.specification.resultFile, JSON.stringify({ disposition: "agent_judgment_required" }));
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).toHaveBeenCalledTimes(1);
		const text = f.deliver.mock.calls[0]?.[0].resultDelivery?.text ?? "";
		expect(f.deliver.mock.calls[0]?.[0].resultDelivery?.resultId).toBe(pendingResultId);
		expect(text).toContain("结果：agent_judgment_required");
		expect(text).not.toContain("结果：agent_review_ready");
	});

	it("未声明清单时，通用回退无论是否已接受都不能挡住后来的专用通知", async () => {
		const f = fixture();
		const record = await f.service.start("workspace", f.request);
		await writeFile(f.request.specification.resultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		f.owner.isNativeInputSubmissionBusy = true;
		await f.service.sweepExecution("workspace", record.executionId);
		expect((await f.service.inspect("workspace", record)).resultDelivery?.producerNoticeId).toBeNull();
		const notice = {
			noticeId: "judgment-after-fallback",
			stage: "agent_judgment_required",
			text: "需要判断：验证失败，不能沿用通用成功文案。",
		};
		await writeFile(
			f.request.specification.resultFile,
			JSON.stringify({ disposition: "agent_judgment_required", agentContinuationNotice: notice }),
		);
		f.owner.isNativeInputSubmissionBusy = false;
		await f.service.sweepExecution("workspace", record.executionId);
		expect(f.deliver).toHaveBeenCalledTimes(1);
		expect(f.deliver.mock.calls[0]?.[0].resultDelivery?.producerNoticeId).toBe(notice.noticeId);
		expect(f.deliver.mock.calls[0]?.[0].resultDelivery?.text).toContain(notice.text);
		const accepted = fixture();
		const acceptedResultFile = join(directory, "accepted-fallback-result.json");
		const acceptedRecord = await accepted.service.start("workspace", {
			...accepted.request,
			idempotencyKey: "accepted-fallback",
			specification: { ...accepted.request.specification, resultFile: acceptedResultFile },
		});
		await writeFile(acceptedResultFile, JSON.stringify({ disposition: "agent_review_ready" }));
		await accepted.service.sweepExecution("workspace", acceptedRecord.executionId);
		expect(accepted.deliver).toHaveBeenCalledTimes(1);
		await writeFile(
			acceptedResultFile,
			JSON.stringify({ disposition: "agent_judgment_required", agentContinuationNotice: notice }),
		);
		await accepted.service.sweepExecution("workspace", acceptedRecord.executionId);
		expect(accepted.deliver).toHaveBeenCalledTimes(2);
		expect(accepted.deliver.mock.calls[1]?.[0].resultDelivery?.text).toContain(notice.text);
		const final = await accepted.service.inspect("workspace", acceptedRecord);
		expect(final.businessDisposition).toBe("agent_judgment_required");
		expect(final.resultDeliveryHistory).toHaveLength(1);
		expect(final.resultDeliveryHistory[0]?.producerNoticeId).toBeNull();
		expect(final.resultDelivery?.producerNoticeId).toBe(notice.noticeId);
	});

	it("最后一次通知读取返回后仍核验撤销，明确停止不再写入", async () => {
		const f = fixture();
		const noticesFile = join(directory, "continuation-notices.json");
		const record = await f.service.start("workspace", {
			...f.request,
			specification: { ...f.request.specification, continuationNoticesFile: noticesFile },
		});
		const notice = { noticeId: "stop-during-read", stage: "final_agent_review", text: "停止前的通知。" };
		await writeFile(noticesFile, JSON.stringify({ notices: [notice] }));
		const actual = continuationNotices.assertTaskCommandContinuationNoticeStillEligible;
		const eligibility = vi
			.spyOn(continuationNotices, "assertTaskCommandContinuationNoticeStillEligible")
			.mockImplementation(async (current) => {
				await actual(current);
				const persisted = (await readTaskCommandExecutions("workspace")).find(
					(item) => item.executionId === record.executionId,
				);
				if (persisted?.resultDelivery?.state === "submission_unknown") await f.service.cancel("workspace", record);
			});
		let wroteAfterStop = false;
		f.deliver.mockImplementationOnce(async (_ignored, validate) => {
			await validate("before_first_transport_write");
			wroteAfterStop = true;
			return { ok: true, summary: f.summary };
		});
		try {
			await f.service.sweepExecution("workspace", record.executionId);
			expect(wroteAfterStop).toBe(false);
			const stopped = await f.service.inspect("workspace", record);
			expect(stopped.revokedAtEpochMs).not.toBeNull();
			expect(stopped.resultDelivery?.state).not.toBe("submission_unknown");
			expect(f.deliver).toHaveBeenCalledTimes(1);
		} finally {
			eligibility.mockRestore();
		}
	});

	it("不同 continuation_request_id 触发新的恢复，同一请求的未变化重试仍受预算限制", async () => {
		const f = fixture();
		f.inspectWorker.mockResolvedValue("exited");
		const record = await f.service.start("workspace", f.request);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const pending = (continuationRequestId: string) => ({
			disposition: "machine_evidence_pending",
			recovery: {
				action: "resume_same_run",
				continuation_request_id: continuationRequestId,
				maximum_unchanged_retries: 0,
				trigger: "registered_context_supplement_changed",
			},
		});
		try {
			await writeFile(f.request.specification.resultFile, JSON.stringify(pending("request-a")));
			await f.service.sweepExecution("workspace", record.executionId);
			expect(f.launch).toHaveBeenCalledTimes(2);
			now += 31_000;
			await f.service.sweepExecution("workspace", record.executionId);
			expect(f.launch).toHaveBeenCalledTimes(2);
			await writeFile(f.request.specification.resultFile, JSON.stringify(pending("request-b")));
			await f.service.sweepExecution("workspace", record.executionId);
			expect(f.launch).toHaveBeenCalledTimes(3);
		} finally {
			clock.mockRestore();
		}
	});

	it("缺省打断策略与基线材料摘要等价，重试不改写已保存摘要", async () => {
		const f = fixture();
		const specification = f.request.specification;
		const legacyMaterial = {
			command: specification.command,
			resumeCommand: specification.resumeCommand,
			resumeCommandPreservesBusinessSingleFlight: false,
			workingDirectory: specification.workingDirectory,
			resultFile: specification.resultFile,
			materialSha256: specification.materialSha256,
			label: specification.label,
			recoveryEvidencePaths: [] as string[],
		};
		const legacyHash = createHash("sha256").update(JSON.stringify(legacyMaterial)).digest("hex");
		const parsedHash = createHash("sha256")
			.update(
				JSON.stringify({
					command: specification.command,
					resumeCommand: specification.resumeCommand,
					resumeCommandPreservesBusinessSingleFlight: false,
					ownerSessionInterruptPolicy: "cancel_execution",
					workingDirectory: specification.workingDirectory,
					resultFile: specification.resultFile,
					materialSha256: specification.materialSha256,
					label: specification.label,
					recoveryEvidencePaths: [] as string[],
				}),
			)
			.digest("hex");
		const record = await f.service.start("workspace", f.request);
		expect(record.materialSha256).toBe(legacyHash);
		const retry = await f.service.start("workspace", {
			...f.request,
			specification: { ...specification, ownerSessionInterruptPolicy: "cancel_execution" },
		});
		expect(retry.executionId).toBe(record.executionId);
		expect(retry.materialSha256).toBe(legacyHash);
		await mutateTaskCommandExecutions("workspace", (records) => ({
			records: records.map((item) =>
				item.executionId === record.executionId ? { ...item, materialSha256: parsedHash } : item,
			),
			result: undefined,
		}));
		const preserved = await f.service.start("workspace", f.request);
		expect(preserved.executionId).toBe(record.executionId);
		expect(preserved.materialSha256).toBe(parsedHash);
		await expect(
			f.service.start("workspace", {
				...f.request,
				specification: { ...specification, ownerSessionInterruptPolicy: "preserve_execution" },
			}),
		).rejects.toThrow("幂等键已用于不同材料或任务 incarnation");
	});
});
