import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listAuthoredVerificationDefinitions,
	upsertAuthoredVerificationDefinition,
} from "../../../src/deployment/authored-verification-definitions";
import * as verificationState from "../../../src/deployment/post-deploy-verification-state";
import { cleanupVerificationAssets, ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import {
	allocateVerificationExecutionAttempt,
	mutateVerificationExecutionAttempt,
	readVerificationExecutionAttempt,
	verificationExecutionAttemptDirectory,
} from "../../../src/deployment/verification-execution-attempt-store";
import {
	observeVerificationExecutionAttempt,
	reconcileVerificationExecutionAttempts,
	startVerificationExecutionRecoveryLifecycle,
} from "../../../src/deployment/verification-execution-recovery";
import { buildVerificationExecutionRunSnapshot } from "../../../src/deployment/verification-script-runner";
import * as ownedCommandSupervisor from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

let sandbox: ReturnType<typeof createTempDir>;
beforeEach(() => {
	sandbox = createTempDir("pdv-execution-recovery-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
	vi.spyOn(ownedCommandSupervisor, "readSystemBootIdentity").mockResolvedValue("boot-one");
	vi.spyOn(ownedCommandSupervisor, "readProcessIdentity").mockResolvedValue(null);
	vi.spyOn(ownedCommandSupervisor, "inspectOwnedCommandSupervisor").mockResolvedValue("unknown");
	vi.spyOn(ownedCommandSupervisor, "cancelOwnedCommandProcesses").mockResolvedValue({});
	vi.spyOn(ownedCommandSupervisor, "launchOwnedCommandSupervisor").mockResolvedValue();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	sandbox.cleanup();
});

async function allocateAttempt(legacyUnowned = false) {
	return allocateVerificationExecutionAttempt({
		workspaceId: "workspace",
		deploymentId: "deployment",
		taskId: "task",
		postDeployVerificationTaskInstanceId: randomUUID(),
		verificationId: randomUUID(),
		itemId: "item",
		verificationDefinitionFingerprint: "definition",
		startedAtIso: new Date().toISOString(),
		script: { entrypoint: "run.js", interpreter: "node", timeoutMs: 300_000 },
		legacyUnowned,
	});
}

describe("持久 attempt 补证预算", () => {
	it("重启后的观察合并独立监督者预算，耗尽时继续展示具体 PID 和恢复条件", async () => {
		const attempt = await allocateAttempt();
		const id = attempt.verificationExecutionAttemptId;
		await writeFile(
			join(verificationExecutionAttemptDirectory(id), `supervisor-progress-${id}.json`),
			JSON.stringify({
				launchNonce: id,
				status: "running",
				returncode: 0,
				ownedProcesses: [],
				updatedAtEpochMs: Date.now(),
				nativeOwnershipUnproven: true,
				unprovenOwnershipProcesses: [
					{ pid: 999993, processStartIdentity: "unavailable", reason: "native_process_snapshot_incomplete" },
				],
				postScriptOwnershipRecoveryBudget: {
					evidenceFingerprint: "native-evidence",
					unchangedEvidenceProbeCount: 3,
					nextActiveProbeAtEpochMs: 123456,
				},
			}),
		);
		const run = await observeVerificationExecutionAttempt(id);
		expect(run.status).toBe("running");
		expect(run.recoveryObservation?.reason).toBe("unchanged_evidence_budget_exhausted");
		expect(run.recoveryObservation?.unchangedEvidenceProbeCount).toBe(3);
		expect(run.recoveryObservation?.message).toContain("999993");
		expect(run.recoveryObservation?.nextActiveProbeAtEpochMs).toBe(123456);
	});
	it("首读以后才持久化的终结回执优先于 owner 已退出的中断兜底", async () => {
		const attempt = await allocateAttempt();
		const id = attempt.verificationExecutionAttemptId;
		vi.mocked(ownedCommandSupervisor.inspectOwnedCommandSupervisor).mockImplementation(async () => {
			await writeFile(
				join(verificationExecutionAttemptDirectory(id), `supervisor-progress-${id}.json`),
				JSON.stringify({
					launchNonce: id,
					status: "exited",
					returncode: 0,
					ownedProcesses: [],
					updatedAtEpochMs: Date.now(),
				}),
			);
			return "exited";
		});
		expect((await observeVerificationExecutionAttempt(id)).status).toBe("passed");
		expect((await readVerificationExecutionAttempt(id)).terminalRun?.status).toBe("passed");
	});
	it("正文已结束但监督者仍活，超时前公开具体归属待核验原因", async () => {
		const attempt = await allocateAttempt();
		const id = attempt.verificationExecutionAttemptId;
		const owner = {
			launchNonce: id,
			pid: 999991,
			startAndCommand: "Wed Oct 28 12:00:00 2026 supervisor",
			nativeProcessGenerationIdentity: "native-supervisor",
		};
		vi.mocked(ownedCommandSupervisor.readProcessIdentity).mockResolvedValue(owner);
		vi.mocked(ownedCommandSupervisor.inspectOwnedCommandSupervisor).mockResolvedValue("running");
		await writeFile(
			join(verificationExecutionAttemptDirectory(id), `supervisor-identity-${id}.json`),
			JSON.stringify(owner),
		);
		await writeFile(
			join(verificationExecutionAttemptDirectory(id), `supervisor-progress-${id}.json`),
			JSON.stringify({
				launchNonce: id,
				status: "running",
				returncode: 0,
				ownedProcesses: [],
				updatedAtEpochMs: Date.now(),
				nativeOwnershipUnproven: true,
				unprovenOwnershipProcesses: [
					{
						pid: 999992,
						processStartIdentity: "unavailable",
						reason: "native_environment_or_process_generation_unavailable",
					},
				],
			}),
		);
		const run = await observeVerificationExecutionAttempt(id);
		expect(run.status).toBe("running");
		expect(run.recoveryObservation?.reason).toBe("awaiting_exit_confirmation");
		expect(run.recoveryObservation?.message).toContain("999992");
		expect(run.recoveryObservation?.unprovenProcessIdentities?.[0]?.reason).toBe(
			"native_environment_or_process_generation_unavailable",
		);
		expect((await readVerificationExecutionAttempt(id)).cancellationIntent).toBeNull();
	});
	it("相同证据最多补查三次且间隔十五秒，重新读取 sidecar 仍受预算约束", async () => {
		const attempt = await allocateAttempt();
		const now = Date.now();
		for (const offset of [0, 14_999, 15_000, 30_000, 45_000]) {
			const run = await observeVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, now + offset);
			expect(run.status).toBe("running");
		}
		expect(ownedCommandSupervisor.inspectOwnedCommandSupervisor).toHaveBeenCalledTimes(3);
		const persisted = await readVerificationExecutionAttempt(attempt.verificationExecutionAttemptId);
		expect(persisted.recoveryBudget.unchangedEvidenceProbeCount).toBe(3);
		expect(
			(await observeVerificationExecutionAttempt(persisted.verificationExecutionAttemptId, now + 60_000))
				.recoveryObservation?.reason,
		).toBe("unchanged_evidence_budget_exhausted");
		expect(ownedCommandSupervisor.inspectOwnedCommandSupervisor).toHaveBeenCalledTimes(3);
		expect(ownedCommandSupervisor.launchOwnedCommandSupervisor).not.toHaveBeenCalled();
	});

	it("预算耗尽后，进程身份变化自动重新补证，晚到终结回执直接解除占用", async () => {
		const attempt = await allocateAttempt();
		const id = attempt.verificationExecutionAttemptId;
		const now = Date.now();
		for (const offset of [0, 15_000, 30_000]) await observeVerificationExecutionAttempt(id, now + offset);
		await writeFile(
			join(verificationExecutionAttemptDirectory(id), `supervisor-identity-${id}.json`),
			JSON.stringify({
				launchNonce: id,
				pid: 999991,
				startAndCommand: "Wed Oct 28 12:00:00 2026 supervisor",
			}),
		);
		await observeVerificationExecutionAttempt(id, now + 31_000);
		expect(ownedCommandSupervisor.inspectOwnedCommandSupervisor).toHaveBeenCalledTimes(4);
		await writeFile(
			join(verificationExecutionAttemptDirectory(id), `supervisor-progress-${id}.json`),
			JSON.stringify({
				launchNonce: id,
				status: "exited",
				ownedProcesses: [],
				updatedAtEpochMs: now + 32_000,
				returncode: 0,
			}),
		);
		expect((await observeVerificationExecutionAttempt(id, now + 32_000)).status).toBe("passed");
		expect((await readVerificationExecutionAttempt(id)).launchStage).toBe("terminal");
	});

	it("旧 running 不因年龄或新 runtime 启动而解锁，真实 boot 变化后自动恢复", async () => {
		const attempt = await allocateAttempt(true);
		for (const offset of [0, 15_000, 30_000, 86_400_000]) {
			expect(
				(
					await observeVerificationExecutionAttempt(
						attempt.verificationExecutionAttemptId,
						Date.now() + offset,
						"boot-one",
					)
				).status,
			).toBe("running");
		}
		const changedBootRun = await observeVerificationExecutionAttempt(
			attempt.verificationExecutionAttemptId,
			Date.now(),
			"boot-two",
		);
		expect(changedBootRun.status).toBe("errored");
		expect(changedBootRun.outputExcerpt).toContain("开机代际");
		expect(ownedCommandSupervisor.launchOwnedCommandSupervisor).not.toHaveBeenCalled();
	});

	it("没有启动材料的超时执行先持久化取消，再确认尚未派发", async () => {
		const attempt = await allocateAttempt();
		await mutateVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, (current) => {
			current.deadlineAtEpochMs = 1;
		});
		vi.mocked(ownedCommandSupervisor.inspectOwnedCommandSupervisor).mockResolvedValue("not_started");
		const run = await observeVerificationExecutionAttempt(attempt.verificationExecutionAttemptId);
		expect(run.status).toBe("timed_out");
		expect(
			(await readVerificationExecutionAttempt(attempt.verificationExecutionAttemptId)).cancellationIntent?.reason,
		).toBe("deadline_elapsed");
	});

	it("错 attempt 的终结回执不能解除占用", async () => {
		const attempt = await allocateAttempt();
		const id = attempt.verificationExecutionAttemptId;
		await writeFile(
			join(verificationExecutionAttemptDirectory(id), `supervisor-progress-${id}.json`),
			JSON.stringify({
				launchNonce: randomUUID(),
				status: "exited",
				ownedProcesses: [],
				updatedAtEpochMs: Date.now(),
				returncode: 0,
			}),
		);
		expect((await observeVerificationExecutionAttempt(id)).status).toBe("running");
	});

	it("延后清理后重注册同 id，新定义与新资产不被旧 attempt 清理", async () => {
		const attempt = await allocateAttempt();
		const assetsDir = await ensureVerificationAssetsDir(attempt.verificationId);
		const definition = {
			verificationId: attempt.verificationId,
			workspaceId: "workspace",
			taskId: "task",
			kind: "automated_script" as const,
			label: "定义 A",
			guidance: null,
			script: attempt.script,
			cleanup: { mode: "automatic" as const, assetsDir, manualSteps: [] },
			createdAtIso: new Date().toISOString(),
		};
		await upsertAuthoredVerificationDefinition(definition, definition.createdAtIso);
		expect((await cleanupVerificationAssets(attempt.verificationId)).skippedReason).toBe(
			"awaiting-execution-exit-confirmation",
		);
		await upsertAuthoredVerificationDefinition(
			{ ...definition, label: "定义 B", script: { entrypoint: "new-run.js", interpreter: "node", timeoutMs: 1000 } },
			new Date().toISOString(),
		);
		const newAsset = join(assetsDir, "new-run.js");
		await writeFile(newAsset, "新一代验证资产");
		await mutateVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, (current) => {
			current.launchStage = "terminal";
			current.terminalRun = buildVerificationExecutionRunSnapshot(current, {
				status: "errored",
				exitCode: null,
				finishedAtIso: new Date().toISOString(),
				outputExcerpt: "旧执行退出",
			});
		});
		await reconcileVerificationExecutionAttempts();
		await expect(access(newAsset)).resolves.toBeUndefined();
		expect((await listAuthoredVerificationDefinitions({}, new Date().toISOString()))[0]?.label).toBe("定义 B");
	});

	it("迁移时 boot 不可读，后续首次可信观察只建立基线，再经历真实变化才解锁", async () => {
		vi.mocked(ownedCommandSupervisor.readSystemBootIdentity).mockResolvedValueOnce(null);
		const attempt = await allocateAttempt(true);
		const id = attempt.verificationExecutionAttemptId;
		expect((await observeVerificationExecutionAttempt(id, Date.now(), "boot-A")).status).toBe("running");
		const firstObservation = await readVerificationExecutionAttempt(id);
		expect(firstObservation.systemBootIdentity).toBeNull();
		expect(firstObservation.firstTrustedObservedSystemBootIdentity).toBe("boot-A");
		expect((await observeVerificationExecutionAttempt(id, Date.now() + 15_000, "boot-A")).status).toBe("running");
		expect((await readVerificationExecutionAttempt(id)).recoveryBudget.unchangedEvidenceProbeCount).toBe(2);
		expect((await observeVerificationExecutionAttempt(id, Date.now() + 30_000, "boot-B")).status).toBe("errored");
	});

	it("只改变心跳与输出不重置三次有效补证预算", async () => {
		const attempt = await allocateAttempt();
		const id = attempt.verificationExecutionAttemptId;
		const now = Date.now();
		for (const offset of [0, 15_000, 30_000, 45_000]) {
			await writeFile(
				join(verificationExecutionAttemptDirectory(id), `supervisor-progress-${id}.json`),
				JSON.stringify({
					launchNonce: id,
					status: "running",
					ownedProcesses: [],
					updatedAtEpochMs: now + offset,
					outputTail: String(offset),
				}),
			);
			await observeVerificationExecutionAttempt(id, now + offset);
		}
		expect(ownedCommandSupervisor.inspectOwnedCommandSupervisor).toHaveBeenCalledTimes(3);
		expect((await readVerificationExecutionAttempt(id)).recoveryBudget.unchangedEvidenceProbeCount).toBe(3);
	});

	it("一百个已应用 terminal 历史每轮只读一次公共快照，且不再查进程", async () => {
		for (let index = 0; index < 100; index++) {
			const attempt = await allocateAttempt();
			await mutateVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, (current) => {
				current.launchStage = "terminal";
				current.terminalRun = buildVerificationExecutionRunSnapshot(current, {
					status: "failed",
					exitCode: 1,
					finishedAtIso: new Date().toISOString(),
					outputExcerpt: "历史结果",
				});
			});
		}
		const readSnapshot = vi
			.spyOn(verificationState, "readPostDeployVerificationStateCorruptionTolerant")
			.mockResolvedValue({ deploymentGroups: [] });
		await reconcileVerificationExecutionAttempts();
		expect(readSnapshot).toHaveBeenCalledTimes(1);
		expect(ownedCommandSupervisor.inspectOwnedCommandSupervisor).not.toHaveBeenCalled();
	});

	it("lifecycle 无浏览器立即扫描，定时续查且 stop 后不再运行", async () => {
		await allocateAttempt(true);
		vi.mocked(ownedCommandSupervisor.readSystemBootIdentity).mockClear();
		vi.useFakeTimers();
		const lifecycle = startVerificationExecutionRecoveryLifecycle();
		await lifecycle.reconcileNow();
		expect(ownedCommandSupervisor.readSystemBootIdentity).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(15_000);
		await lifecycle.reconcileNow();
		expect(ownedCommandSupervisor.readSystemBootIdentity).toHaveBeenCalledTimes(2);
		await lifecycle.stop();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(ownedCommandSupervisor.readSystemBootIdentity).toHaveBeenCalledTimes(2);
	});
});
