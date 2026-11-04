import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateCodexConfigurationProfileFields } from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { mutateCodexConfigurationSyncStore } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { listUnrestoredCodexProfileAdoptionRetainedInput } from "../../../src/codex-configuration-sync/codex-profile-adoption-retained-terminal-input";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { createIdleHarnessBackgroundSessionReclaimWatchState } from "../../../src/terminal/harness-background-session-reclaim-watch-after-unsafe-resume-refusal";
import { type StartTaskSessionRequest, TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTerminalInputBoxOccupancyTrackerState } from "../../../src/terminal/terminal-input-box-occupancy";
import { createTempDir } from "../../utilities/temp-dir";

let isolatedHome: ReturnType<typeof createTempDir>;
beforeEach(() => {
	isolatedHome = createTempDir("codex-profile-safe-adoption-");
	vi.stubEnv("HOME", isolatedHome.path);
	vi.stubEnv("CODEX_HOME", isolatedHome.path);
	vi.stubEnv("CODEX_SQLITE_HOME", isolatedHome.path);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	isolatedHome.cleanup();
});

function installOwnedCodexSession(nativeSessionId = randomUUID()) {
	const manager = new TerminalSessionManager();
	const originalWrite = vi.fn();
	const replacementWrite = vi.fn();
	const originalActive = {
		session: { write: originalWrite, stop: vi.fn() },
		inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
		deferredStartupPromptText: null,
		programmaticDeliveryReceipt: null,
		lastUserInputAt: null,
		outputReactionEngine: null,
		submitConfirmGeneration: 0,
	};
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "profile-owned-session",
		agentId: "codex",
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		workspacePath: isolatedHome.path,
		pid: 12,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		runtimeSessionIncarnationId: randomUUID(),
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: `${isolatedHome.path}/native.jsonl`,
			observedAt: 1,
		},
		codexNativeSessionControlEndpoint: {
			workspaceId: "profile-fixture",
			conversationSessionId: "profile-owned-session",
			runtimeSessionIncarnationId: randomUUID(),
			socketPath: `${isolatedHome.path}/control.sock`,
		},
	});
	const request: StartTaskSessionRequest = {
		taskId: summary.taskId,
		agentId: "codex",
		binary: "codex",
		args: [],
		cwd: isolatedHome.path,
		prompt: "",
		workspaceId: "profile-fixture",
		resumePriorAgentConversationWithoutResendingPrompt: true,
	};
	const entry = {
		summary,
		active: originalActive as typeof originalActive | null,
		listeners: new Map(),
		harnessBackgroundSessionReclaimWatchState: createIdleHarnessBackgroundSessionReclaimWatchState(),
		suppressAutoRestartOnExit: false,
		restartRequest: { kind: "task" as const, request },
		terminalStateMirror: null,
	};
	const internals = manager as unknown as {
		entries: Map<string, typeof entry>;
		deferTaskSessionResumeWaitingForNativeConversationIdentity: () => Promise<boolean>;
		resolveTaskSessionRequestWithCodexConversationStorageHome: (
			request: StartTaskSessionRequest,
		) => Promise<StartTaskSessionRequest>;
		refuseCodexResumeWithoutPersistedConversationBeforeAnyDestructiveStep: () => Promise<void>;
		refuseOrPinKanbanAssignedAgentNativeConversationResumeTargetBeforeAnyDestructiveStep: () => Promise<void>;
		reclaimOrRefuseHarnessBackgroundSessionHoldingResumeTargetBeforeAnyDestructiveStep: () => Promise<void>;
		resolveResumeAddressingForTaskSessionStart: () => { kind: string };
		readCurrentCodexNativeTurnExecution: () => Promise<{
			summaryBeforeRead: typeof summary;
			observation: { executionStatus: string };
		} | null>;
		resolveInteractivePromptReadiness: () => Promise<"prompt">;
		startTaskSessionHoldingPerTaskStartAndCodexStorageExclusivity: (
			request: StartTaskSessionRequest,
			origin: string,
			arrival: unknown,
			pendingUserDecisionKind?: unknown,
			isTaskSessionStartStillRequested?: () => boolean,
		) => Promise<typeof summary>;
	};
	internals.entries.set(summary.taskId, entry);
	vi.spyOn(internals, "deferTaskSessionResumeWaitingForNativeConversationIdentity").mockResolvedValue(false);
	vi.spyOn(internals, "resolveTaskSessionRequestWithCodexConversationStorageHome").mockImplementation(
		async (request) => request,
	);
	for (const method of [
		"refuseCodexResumeWithoutPersistedConversationBeforeAnyDestructiveStep",
		"refuseOrPinKanbanAssignedAgentNativeConversationResumeTargetBeforeAnyDestructiveStep",
		"reclaimOrRefuseHarnessBackgroundSessionHoldingResumeTargetBeforeAnyDestructiveStep",
	] as const)
		vi.spyOn(internals, method).mockResolvedValue();
	vi.spyOn(internals, "resolveResumeAddressingForTaskSessionStart").mockReturnValue({
		kind: "resume_recorded_native_session",
	});
	const nativeExecution = vi
		.spyOn(internals, "readCurrentCodexNativeTurnExecution")
		.mockResolvedValue({ summaryBeforeRead: summary, observation: { executionStatus: "finished" } });
	const occupancy = vi.spyOn(manager, "resolveTaskTerminalInputBoxOccupancy").mockResolvedValue({
		hasUncommittedInput: false,
		inputSideByteTrackingSaysNonEmpty: false,
		inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
		screenReadingSaysNonEmpty: false,
		unrecoverablePasteCount: 0,
	});
	vi.spyOn(internals, "resolveInteractivePromptReadiness").mockResolvedValue("prompt");
	const stop = vi.spyOn(manager, "forceStopTaskSession").mockImplementation(async () => {
		entry.active = null;
	});
	const start = vi
		.spyOn(internals, "startTaskSessionHoldingPerTaskStartAndCodexStorageExclusivity")
		.mockImplementation(async () => {
			entry.active = {
				...originalActive,
				session: { write: replacementWrite, stop: vi.fn() },
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			};
			entry.summary = { ...entry.summary, runtimeSessionIncarnationId: randomUUID() };
			return entry.summary;
		});
	const claim = vi.fn(async () => true);
	const readTaskExecutionEligibilityFingerprint = vi.fn(async (): Promise<string | null> => "eligible-original-task");
	const refresh = () =>
		manager.refreshTaskTerminal(
			{
				...request,
				configurationProfileAutomaticAdoptionGuard: {
					profileId: "profile",
					expectedRuntimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? "",
					expectedNativeSessionId: nativeSessionId,
					pendingProcessReplacementRetainedInputRecordPath: entry.active
						? undefined
						: manager.getPendingCodexProfileProcessReplacementRetainedInputRecordPath(summary.taskId),
					readTaskExecutionEligibilityFingerprint,
					onBeforeProcessReplacement: claim,
				},
			},
			"codex_configuration_profile_safe_auto_resume",
		);
	return {
		manager,
		internals,
		entry,
		stop,
		start,
		claim,
		readTaskExecutionEligibilityFingerprint,
		occupancy,
		nativeExecution,
		refresh,
		originalWrite,
		replacementWrite,
		nativeSessionId,
	};
}

describe("Codex profile 自动续接的执行与恢复门禁", () => {
	it("同一持久启动证据最多三次且跨重启不重置，profile 修正后自动恢复资格", async () => {
		await mutateCodexConfigurationSyncStore((store) => {
			store.sources["recovery-fixture-source"] = {
				home: isolatedHome.path,
				version: 1,
				fields: {},
				observedUserFields: {},
			};
			store.profiles.profile = {
				profileId: "profile",
				name: "恢复验证配置",
				sourceIdentity: "recovery-fixture-source",
				version: ++store.revision,
				fields: {},
				fieldVersions: {},
			};
		});
		const failing = installOwnedCodexSession();
		failing.start.mockRejectedValue(new Error("隔离模拟启动仍不可用"));
		await expect(failing.refresh()).rejects.toThrow("隔离模拟启动仍不可用");
		for (let index = 0; index < 3; index++) await expect(failing.refresh()).rejects.toThrow("隔离模拟启动仍不可用");
		await expect(failing.refresh()).rejects.toThrow("同一持久启动证据已达三次");
		expect(failing.start).toHaveBeenCalledTimes(4);
		const restarted = installOwnedCodexSession(failing.nativeSessionId);
		restarted.entry.active = null;
		await expect(restarted.refresh()).rejects.toThrow("同一持久启动证据已达三次");
		expect(restarted.start).not.toHaveBeenCalled();
		await mutateCodexConfigurationSyncStore((store) =>
			updateCodexConfigurationProfileFields(store, "profile", {
				[JSON.stringify(["config.toml", "features", "shell_snapshot"])]: { value: true },
			}),
		);
		await restarted.refresh();
		expect(restarted.start).toHaveBeenCalledTimes(1);
		expect(restarted.stop).not.toHaveBeenCalled();
	});
	it("启动失败后继续同一持久启动记录，新输入仅恢复一次；显式 Stop 可跨重验取消", async () => {
		const session = installOwnedCodexSession();
		session.stop.mockImplementation(async () => {
			session.manager.writeInput(session.entry.summary.taskId, Buffer.from("跨启动失败保留的草稿"));
			session.entry.active = null;
		});
		session.start.mockRejectedValueOnce(new Error("隔离模拟启动失败"));
		await expect(session.refresh()).rejects.toThrow("隔离模拟启动失败");
		const path = session.manager.getPendingCodexProfileProcessReplacementRetainedInputRecordPath(
			session.entry.summary.taskId,
		);
		expect(path).toBeTruthy();
		const recoveredRuntime = installOwnedCodexSession(session.nativeSessionId);
		recoveredRuntime.entry.active = null;
		await recoveredRuntime.manager.restoreTerminalInputRetainedDuringCodexProfileAdoption();
		await recoveredRuntime.refresh();
		expect(recoveredRuntime.stop).not.toHaveBeenCalled();
		expect(recoveredRuntime.start).toHaveBeenCalledTimes(1);
		expect(recoveredRuntime.replacementWrite).toHaveBeenCalledExactlyOnceWith(Buffer.from("跨启动失败保留的草稿"));
		expect(
			recoveredRuntime.manager.getPendingCodexProfileProcessReplacementRetainedInputRecordPath(
				session.entry.summary.taskId,
			),
		).toBeUndefined();
		const stopped = installOwnedCodexSession();
		stopped.start.mockRejectedValue(new Error("隔离模拟启动失败"));
		await expect(stopped.refresh()).rejects.toThrow();
		stopped.manager.stopTaskSession(stopped.entry.summary.taskId);
		expect(
			stopped.manager.getPendingCodexProfileProcessReplacementRetainedInputRecordPath(stopped.entry.summary.taskId),
		).toBeUndefined();
		await expect(stopped.refresh()).rejects.toThrow();
		expect(stopped.start).toHaveBeenCalledTimes(1);
	});
	it("登记期间 Task 被搁置或结案时取消停止，资格指纹变化后才可重验", async () => {
		const session = installOwnedCodexSession();
		session.readTaskExecutionEligibilityFingerprint
			.mockResolvedValueOnce("eligible-original-task")
			.mockResolvedValueOnce(null);
		await expect(session.refresh()).rejects.toThrow("Task 在预检期间");
		expect(session.stop).not.toHaveBeenCalled();
	});
	it("停旧进程的等待窗口收到显式 Stop 后不再启动，取消事实持久保留", async () => {
		const session = installOwnedCodexSession();
		session.stop.mockImplementation(async () => {
			session.entry.active = null;
			session.manager.stopTaskSession(session.entry.summary.taskId);
		});
		await session.refresh();
		expect(session.start).not.toHaveBeenCalled();
		expect(session.entry.summary.codexConfigurationProfileAutomaticProcessReplacementCancelled).toBe(true);
		expect(
			listUnrestoredCodexProfileAdoptionRetainedInput()[0]?.record.automaticProcessReplacementContinuationStatus,
		).toBe("cancelled_by_explicit_stop");
	});
	it("取消检查传入整个启动漏斗，异步启动准备期间的 Stop 仍使请求失效", async () => {
		const session = installOwnedCodexSession();
		let continuationStillRequested: (() => boolean) | undefined;
		session.start.mockImplementation(
			async (_request, _origin, _arrival, _pending, isTaskSessionStartStillRequested) => {
				continuationStillRequested = isTaskSessionStartStillRequested;
				expect(continuationStillRequested).toBeTypeOf("function");
				expect(continuationStillRequested?.()).toBe(true);
				await Promise.resolve();
				session.manager.stopTaskSession(session.entry.summary.taskId);
				expect(continuationStillRequested?.()).toBe(false);
				return session.entry.summary;
			},
		);
		await session.refresh();
		expect(continuationStillRequested?.()).toBe(false);
	});
	it("真实启动漏斗在异步存储准备后重验 Stop，不继续执行原生会话预检", async () => {
		const session = installOwnedCodexSession();
		session.start.mockRestore();
		vi.mocked(session.internals.resolveTaskSessionRequestWithCodexConversationStorageHome).mockImplementation(
			async (request) => {
				await Promise.resolve();
				if (!session.entry.active) session.manager.stopTaskSession(session.entry.summary.taskId);
				return request;
			},
		);
		vi.mocked(
			session.internals.refuseCodexResumeWithoutPersistedConversationBeforeAnyDestructiveStep,
		).mockImplementation(async () => {
			if (!session.entry.active) throw new Error("已 Stop 的启动不应继续原生预检");
		});
		await session.refresh();
		expect(session.entry.active).toBeNull();
		expect(session.entry.summary.codexConfigurationProfileAutomaticProcessReplacementCancelled).toBe(true);
		expect(
			session.internals.refuseCodexResumeWithoutPersistedConversationBeforeAnyDestructiveStep,
		).toHaveBeenCalledTimes(1);
	});
	it.each([false, true])("旧会话使用绑定转录补证；登记期间转录变化=%s 时重新核验", async (changesDuringClaim) => {
		const session = installOwnedCodexSession();
		session.nativeExecution.mockResolvedValue(null);
		session.entry.summary.codexNativeSessionControlEndpoint = null;
		const transcriptPath = `${isolatedHome.path}/native.jsonl`;
		const line = (type: string, payload: Record<string, unknown>) => `${JSON.stringify({ type, payload })}\n`;
		await writeFile(
			transcriptPath,
			line("session_meta", { id: session.nativeSessionId, cwd: isolatedHome.path, source: "cli" }) +
				line("event_msg", { type: "task_complete", turn_id: "completed-native-turn" }),
		);
		if (changesDuringClaim)
			session.claim.mockImplementation(async () => {
				await appendFile(transcriptPath, line("event_msg", { type: "task_started", turn_id: "new-native-turn" }));
				return true;
			});
		if (changesDuringClaim) {
			await expect(session.refresh()).rejects.toThrow("原生转录");
			expect(session.stop).not.toHaveBeenCalled();
		} else {
			expect((await session.refresh()).agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
				session.nativeSessionId,
			);
			expect(session.stop).toHaveBeenCalledTimes(1);
		}
	});
	it.each(["进行中回合", "待答问题", "未提交草稿", "明确 Stop", "原生回合未知", "输入框不可读"])(
		"%s 时不停止原进程",
		async (condition) => {
			const session = installOwnedCodexSession();
			if (condition === "进行中回合")
				session.entry.summary = {
					...session.entry.summary,
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
				};
			if (condition === "待答问题")
				session.entry.summary = {
					...session.entry.summary,
					turnOwner: "user",
					liveness: "live",
					userTurnKind: "question",
				};
			if (condition === "未提交草稿" && session.entry.active)
				session.entry.active.inputBoxOccupancyTracker.hasUncommittedInputFromInputSideByteTracking = true;
			if (condition === "明确 Stop") session.entry.suppressAutoRestartOnExit = true;
			if (condition === "原生回合未知") session.nativeExecution.mockResolvedValue(null);
			if (condition === "输入框不可读") session.occupancy.mockResolvedValue(null);
			await expect(session.refresh()).rejects.toThrow();
			expect(session.stop).not.toHaveBeenCalled();
			expect(session.start).not.toHaveBeenCalled();
			expect(session.claim).not.toHaveBeenCalled();
		},
	);
	it("登记续接期间出现新输入时取消停止，新的草稿仍在原进程", async () => {
		const session = installOwnedCodexSession();
		session.claim.mockImplementation(async () => {
			session.manager.writeInput(session.entry.summary.taskId, Buffer.from("新增草稿"));
			return true;
		});
		await expect(session.refresh()).rejects.toThrow("证据已变化");
		expect(session.stop).not.toHaveBeenCalled();
		expect(session.originalWrite).toHaveBeenCalledWith(Buffer.from("新增草稿"));
	});
	it("停旧到新输入框就绪之间的新输入只交给新进程，终端协议应答继续直通", async () => {
		const session = installOwnedCodexSession();
		session.stop.mockImplementation(async () => {
			session.manager.writeInput(session.entry.summary.taskId, Buffer.from("新的草稿"));
			session.manager.writeInput(session.entry.summary.taskId, Buffer.from("\u001b[1;1R"));
			session.entry.active = null;
		});
		const summary = await session.refresh();
		expect(session.originalWrite).toHaveBeenCalledExactlyOnceWith(Buffer.from("\u001b[1;1R"));
		expect(session.replacementWrite).toHaveBeenCalledExactlyOnceWith(Buffer.from("新的草稿"));
		expect(summary.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(session.nativeSessionId);
		expect(session.start.mock.calls[0]?.[0].configurationProfileAutomaticAdoptionGuard).toBeUndefined();
		expect(listUnrestoredCodexProfileAdoptionRetainedInput()).toHaveLength(0);
	});
	it("启动失败后的输入由新的运行时从持久记录恢复，重验不会重复发送", async () => {
		const session = installOwnedCodexSession();
		session.stop.mockImplementation(async () => {
			session.manager.writeInput(session.entry.summary.taskId, Buffer.from("保留到下次启动"));
			session.entry.active = null;
		});
		session.start.mockRejectedValue(new Error("启动暂不可用"));
		await expect(session.refresh()).rejects.toThrow("启动暂不可用");
		expect(listUnrestoredCodexProfileAdoptionRetainedInput()).toHaveLength(1);
		const resumed = installOwnedCodexSession(session.nativeSessionId);
		await resumed.manager.restoreTerminalInputRetainedDuringCodexProfileAdoption();
		await resumed.manager.restoreTerminalInputRetainedDuringCodexProfileAdoption();
		expect(resumed.originalWrite).toHaveBeenCalledExactlyOnceWith(Buffer.from("保留到下次启动"));
	});
});
