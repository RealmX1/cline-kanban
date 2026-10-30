import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
	ForkedWorkBranchExecutor,
	ForkedWorkBranchRequest,
} from "agent-conversation-exploration-thread-graph/core";
import * as nativeProcesses from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelSessionOwnedBackgroundAgentExecutions,
	createSessionOwnedBackgroundAgentExecutor,
	hasSessionOwnedBackgroundAgentExecutionRequiringRetention,
	requestSessionOwnedBackgroundAgentExecutionCancellation,
} from "../../../src/state/session-owned-background-agent-executions";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

// Git/npm 安装产物使用原生 ESM namespace；经模块工厂隔离导出，不能直接 spyOn 原件。
vi.mock("agent-conversation-exploration-thread-graph/harness-claude-code", async (importOriginal) => ({
	...(await importOriginal<typeof nativeProcesses>()),
	readNativeSystemBootIdentity: vi.fn(),
	observeExecutionOwnedProcesses: vi.fn(),
	readNativeProcessOwnershipSnapshot: vi.fn(),
	signalMatchingOwnedProcesses: vi.fn(),
	confirmOwnedProcessCancellation: vi.fn(),
}));

let isolatedHome: ReturnType<typeof createTempDir>;
const owner = { workspaceId: "isolated-workspace", taskId: "parent-task" };
const request: ForkedWorkBranchRequest = {
	parentSession: { harnessKind: "dsh", nativeSessionId: "native-parent" },
	promptText: "隔离回归",
	outputSchema: { type: "object", properties: {} },
};
const observation = {
	processPid: 870001,
	processStartIdentity: "870001 870001 Thu Oct 29 00:00:00 2026",
	ownedDescendantStartIdentities: {},
	observedAtEpochMs: 1,
	lastOutputActivityAtEpochMs: null,
};
const nativeSnapshot = new Map([
	[
		870001,
		{
			processPid: 870001,
			parentProcessPid: 1,
			processGroupId: 870001,
			startIdentity: observation.processStartIdentity,
		},
	],
]);

beforeEach(() => {
	vi.resetAllMocks();
	isolatedHome = createTempDir("background-agent-retention-home-");
	vi.stubEnv("HOME", isolatedHome.path);
	vi.mocked(nativeProcesses.readNativeProcessOwnershipSnapshot).mockResolvedValue(new Map());
	vi.mocked(nativeProcesses.signalMatchingOwnedProcesses).mockResolvedValue("confirmed");
	vi.mocked(nativeProcesses.confirmOwnedProcessCancellation).mockResolvedValue("confirmed");
	vi.mocked(nativeProcesses.readNativeSystemBootIdentity).mockResolvedValue("boot-generation-1");
	vi.mocked(nativeProcesses.observeExecutionOwnedProcesses).mockImplementation(async (input) => {
		const current = await nativeProcesses.readNativeProcessOwnershipSnapshot();
		return {
			ownedStartIdentities: new Map(
				[...input.recordedStartIdentities].filter(
					([pid, identity]) => current.get(pid)?.startIdentity === identity,
				),
			),
			hasUnprovenOrphanOwnership: false,
		};
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	isolatedHome.cleanup();
});

function ownedExecutor(executor: ForkedWorkBranchExecutor) {
	return createSessionOwnedBackgroundAgentExecutor({
		...owner,
		runtimeSessionIncarnationId: "incarnation",
		purpose: "exploration_thread_graph_maintenance",
		executor,
	});
}

async function originalRecordPath(): Promise<string> {
	const directory = join(getWorkspaceDirectoryPath(owner.workspaceId), "session-owned-background-agent-executions");
	const filenames = await readdir(directory);
	return join(directory, filenames.find((name) => name.endsWith(".execution.json")) ?? "missing");
}

describe("后台 Agent 持久归属与恢复", () => {
	it("控制器退出后不重复派发活进程，退出证据恢复后自动解除回收保护", async () => {
		const snapshot = vi.mocked(nativeProcesses.readNativeProcessOwnershipSnapshot).mockResolvedValue(nativeSnapshot);
		const first = ownedExecutor({
			start: async (input) => {
				await input.beforeProcessSpawn?.();
				input.onProcessObservation?.({
					...observation,
					executionOwnershipToken: input.executionOwnershipToken ?? "missing-token",
				});
				throw new Error("模拟控制器丢失结果");
			},
		});
		await expect(first.start(request)).rejects.toThrow("丢失结果");
		const path = await originalRecordPath();
		const original = await readFile(path, "utf8");
		expect(await hasSessionOwnedBackgroundAgentExecutionRequiringRetention(owner)).toBe(true);
		const startAgain = vi.fn(async () => ({ stopReason: "completed" as const, outputText: "完成" }));
		await expect(ownedExecutor({ start: startAgain }).start(request)).rejects.toThrow("活跃或退出未知");
		expect(startAgain).not.toHaveBeenCalled();
		snapshot.mockRejectedValueOnce(new Error("原生查询不可用"));
		expect(await hasSessionOwnedBackgroundAgentExecutionRequiringRetention(owner)).toBe(true);
		snapshot.mockResolvedValue(new Map());
		expect(await hasSessionOwnedBackgroundAgentExecutionRequiringRetention(owner)).toBe(false);
		expect(await readFile(path, "utf8")).toBe(original);
	});

	it("重启后显式取消仍能按持久身份清理，并单独保存确认", async () => {
		const snapshot = vi.mocked(nativeProcesses.readNativeProcessOwnershipSnapshot).mockResolvedValue(nativeSnapshot);
		const terminate = vi.mocked(nativeProcesses.signalMatchingOwnedProcesses).mockImplementation(async () => {
			snapshot.mockResolvedValue(new Map());
			return "confirmed";
		});
		await expect(
			ownedExecutor({
				start: async (input) => {
					await input.beforeProcessSpawn?.();
					input.onProcessObservation?.({
						...observation,
						executionOwnershipToken: input.executionOwnershipToken ?? "missing-token",
					});
					throw new Error("模拟重启");
				},
			}).start(request),
		).rejects.toThrow("重启");
		const path = await originalRecordPath();
		const original = await readFile(path, "utf8");
		await cancelSessionOwnedBackgroundAgentExecutions(owner);
		expect(terminate).toHaveBeenCalledWith(
			new Map([[observation.processPid, observation.processStartIdentity]]),
			"SIGTERM",
		);
		expect(JSON.parse(await readFile(`${path}.cancellation-observation.json`, "utf8"))).toMatchObject({
			confirmation: "confirmed",
		});
		expect(await readFile(path, "utf8")).toBe(original);
	});

	it("取消意图先于结果发布时，不等待清理也不能发布 completed", async () => {
		let finishDelegate:
			| ((value: { stopReason: "completed"; outputText: string; structured: { forbidden: boolean } }) => void)
			| undefined;
		let entered = false;
		const pending = ownedExecutor({
			start: async (input) => {
				await input.beforeProcessSpawn?.();
				entered = true;
				return await new Promise((resolve) => {
					finishDelegate = resolve;
				});
			},
		}).start(request);
		await vi.waitFor(() => expect(entered).toBe(true));
		const cancellation = await requestSessionOwnedBackgroundAgentExecutionCancellation(owner);
		finishDelegate?.({
			stopReason: "completed",
			outputText: "已结束但取消先取得发布资格",
			structured: { forbidden: true },
		});
		const result = await pending;
		expect(result.stopReason).toBe("cancelled");
		expect(result.structured).toBeUndefined();
		await cancellation.processCancellationConfirmationCompleted;
	});

	it("登记前的原生准备等待期间 Stop，也阻止此前请求派发并允许之后的新请求", async () => {
		let releasePreflight: ((boot: string) => void) | undefined;
		let preflightEntered = false;
		vi.mocked(nativeProcesses.readNativeSystemBootIdentity).mockImplementationOnce(async () => {
			preflightEntered = true;
			return await new Promise<string>((resolve) => {
				releasePreflight = resolve;
			});
		});
		const delegate = vi.fn(async (input: ForkedWorkBranchRequest) => {
			await input.beforeProcessSpawn?.();
			return { stopReason: "completed" as const, outputText: "模拟后续新请求" };
		});
		const executor = ownedExecutor({ start: delegate });
		const pending = executor.start(request);
		await vi.waitFor(() => expect(preflightEntered).toBe(true));
		const cancellation = await requestSessionOwnedBackgroundAgentExecutionCancellation(owner);
		releasePreflight?.("boot-generation-1");
		expect(await pending).toMatchObject({
			stopReason: "cancelled",
			cancellationConfirmation: "not_started",
			localProcessLaunchStatus: "not_started",
		});
		expect(delegate).not.toHaveBeenCalled();
		await cancellation.processCancellationConfirmationCompleted;
		expect(await hasSessionOwnedBackgroundAgentExecutionRequiringRetention(owner)).toBe(false);
		expect(await executor.start(request)).toMatchObject({ stopReason: "completed" });
		expect(delegate).toHaveBeenCalledTimes(1);
	});

	it("辅助取消代际原件缺失不等于新 Stop，健康请求仍可完成", async () => {
		const previousStop = await requestSessionOwnedBackgroundAgentExecutionCancellation(owner);
		await previousStop.processCancellationConfirmationCompleted;
		let finish: (() => void) | undefined;
		const pending = ownedExecutor({
			start: async (input) => {
				await input.beforeProcessSpawn?.();
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return { stopReason: "completed", outputText: "健康新请求" };
			},
		}).start(request);
		await vi.waitFor(() => expect(finish).toBeDefined());
		const directory = join(getWorkspaceDirectoryPath(owner.workspaceId), "session-owned-background-agent-executions");
		const filename = (await readdir(directory)).find((name) =>
			name.endsWith(".admission-cancellation-generation.json"),
		);
		expect(filename).toBeDefined();
		await unlink(join(directory, filename ?? "missing"));
		finish?.();
		expect(await pending).toMatchObject({ stopReason: "completed" });
	});

	it("未越过派发屏障的失败可自动恢复，实际没有启动 Agent", async () => {
		let started = 0;
		await expect(
			ownedExecutor({
				start: async () => {
					throw new Error("派发前配置失败");
				},
			}).start(request),
		).rejects.toThrow("配置失败");
		expect(await hasSessionOwnedBackgroundAgentExecutionRequiringRetention(owner)).toBe(false);
		const path = await originalRecordPath();
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			launchState: "not_started",
			status: "finished",
		});
		await ownedExecutor({
			start: async () => {
				started++;
				return { stopReason: "completed", outputText: "已恢复" };
			},
		}).start(request);
		expect(started).toBe(1);
	});

	it("首次 PID 回报前的缺证保留未知，原生开机代际变化后自动解除", async () => {
		vi.mocked(nativeProcesses.readNativeProcessOwnershipSnapshot).mockResolvedValue(new Map());
		vi.mocked(nativeProcesses.observeExecutionOwnedProcesses).mockRejectedValue(new Error("原生归属查询不可用"));
		const terminate = vi.mocked(nativeProcesses.signalMatchingOwnedProcesses);
		await expect(
			ownedExecutor({
				start: async (input) => {
					await input.beforeProcessSpawn?.();
					throw new Error("派发后退出证据未知");
				},
			}).start(request),
		).rejects.toThrow("未知");
		expect(await hasSessionOwnedBackgroundAgentExecutionRequiringRetention(owner)).toBe(true);
		await cancelSessionOwnedBackgroundAgentExecutions(owner);
		expect(terminate).not.toHaveBeenCalled();
		const path = await originalRecordPath();
		expect(JSON.parse(await readFile(`${path}.cancellation-observation.json`, "utf8"))).toMatchObject({
			confirmation: "unknown",
		});
		vi.mocked(nativeProcesses.readNativeSystemBootIdentity).mockResolvedValue("boot-generation-2");
		expect(await hasSessionOwnedBackgroundAgentExecutionRequiringRetention(owner)).toBe(false);
		await cancelSessionOwnedBackgroundAgentExecutions(owner);
		expect(JSON.parse(await readFile(`${path}.cancellation-observation.json`, "utf8"))).toMatchObject({
			confirmation: "confirmed",
		});
		expect(terminate).not.toHaveBeenCalled();
	});
});
