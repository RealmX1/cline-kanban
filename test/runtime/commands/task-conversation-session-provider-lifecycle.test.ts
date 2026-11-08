import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TRPCClient } from "@trpc/client";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTaskConversationSessionCommands } from "../../../src/commands/task-conversation-session";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { reconstructTaskSessionSummaryFromPersistedRecordWithoutLiveAgentProcess } from "../../../src/terminal/session-manager";
import type { RuntimeAppRouter } from "../../../src/trpc/app-router";
import { createTempDir } from "../../utilities/temp-dir";

const temporaryDirectories: ReturnType<typeof createTempDir>[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) directory.cleanup();
});

function requestFile(request: Record<string, unknown>) {
	const directory = createTempDir("kanban-frozen-conversation-session-request-");
	temporaryDirectories.push(directory);
	const path = join(directory.path, "frozen-conversation-session-request.json");
	writeFileSync(path, JSON.stringify(request));
	return path;
}

const frozenCreationRequest = {
	taskId: "host-task",
	expectedTaskIncarnationCreatedAtEpochMs: 100,
	creatorTaskConversationSessionId: "host-task",
	idempotencyKey: "stable-execution-request",
	sessionRole: "task_collaborator",
	contextSource: "fresh",
	agentId: "codex",
	startInPlanMode: false,
	initialMessage: "核对冻结材料并写入持久结果",
	creationReason: "独立工程执行",
};

function fixture() {
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "task-conversation-session-original",
		turnOwner: "user",
		liveness: "interrupted",
		userTurnKind: "interrupted",
		agentId: "codex",
		workspacePath: "/isolated-project-worktree",
		pid: null,
		startedAt: 10,
		runtimeSessionIncarnationId: "original-runtime",
		updatedAt: 20,
		lastOutputAt: 20,
		reviewReason: null,
		exitCode: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "original-native-session",
			transcriptPath: null,
			observedAt: 20,
		},
		taskConversationSessionMetadata: {
			workspaceTaskId: "host-task",
			taskConversationSessionRole: "task_collaborator",
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: "host-task",
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
			creationRequestId: "creation-request",
			taskConversationSessionLaunchSettings: {
				taskAgentPermissionMode: "ask_for_every_tool_use",
				startInPlanMode: false,
				sessionTransport: "pty_terminal",
			},
		},
	});
	const card = { id: "host-task", createdAt: 100, baseRef: "main", worktreeMode: "worktree" };
	const creation = {
		requestId: "creation-request",
		taskId: card.id,
		taskIncarnationCreatedAt: card.createdAt,
		taskConversationSessionId: summary.taskId,
		status: "started",
	};
	const state = {
		board: { columns: [{ id: "in_progress", cards: [card] }] },
		sessions: { [summary.taskId]: summary },
	};
	const create = vi.fn(async () => ({ ok: true, creation, summary }));
	const preview = vi.fn(async () => ({ ok: true, resolvedSettings: { startInPlanMode: { value: false } } }));
	const lookup = vi.fn(async (): Promise<Record<string, unknown> | null> => ({ ok: true, creation, summary }));
	const get = vi.fn(
		async (): Promise<Record<string, unknown>> => ({
			summary,
			creation,
			taskConversationSessionExplicitlyStopped: true,
			reports: [],
			history: { messages: [], nextCursor: null },
		}),
	);
	const getState = vi.fn(async () => state);
	const start = vi.fn(async () => ({ ok: true, summary }));
	const boundResume = vi.fn(async () => ({ ok: true, status: "resumed", summary }));
	const stop = vi.fn(
		async (): Promise<Record<string, unknown>> => ({
			ok: true,
			summary,
			explicitStopRecorded: true,
			processExitConfirmed: true,
		}),
	);
	const getTaskContext = vi.fn(async () => ({ taskId: card.id, path: summary.workspacePath, exists: true }));
	const resolveWorkspace = vi.fn(async () => "isolated-workspace");
	const createClient = vi.fn(
		() =>
			({
				runtime: {
					createTaskConversationSession: { mutate: create },
					previewTaskConversationSession: { query: preview },
					lookupTaskConversationSessionCreation: { query: lookup },
					getTaskConversationSession: { query: get },
					startTaskSession: { mutate: start },
					resumeTaskConversationSession: { mutate: boundResume },
					stopTaskSession: { mutate: stop },
				},
				workspace: { getState: { query: getState }, getTaskContext: { query: getTaskContext } },
			}) as unknown as TRPCClient<RuntimeAppRouter>,
	);
	const run = async (argumentsAfterSubcommand: string[]) => {
		let output: Record<string, unknown> | undefined;
		let error: unknown;
		const command = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
		registerTaskConversationSessionCommands(command, {
			resolveWorkspace,
			createClient,
			run: async (handler) => {
				try {
					output = await handler();
				} catch (cause) {
					error = cause;
				}
			},
		});
		try {
			await command.parseAsync(["node", "kanban", "conversation-session", ...argumentsAfterSubcommand]);
		} catch (cause) {
			error = cause;
		}
		return { output, error };
	};
	return {
		run,
		summary,
		card,
		creation,
		state,
		create,
		preview,
		lookup,
		get,
		getState,
		start,
		boundResume,
		stop,
		getTaskContext,
		resolveWorkspace,
	};
}

const lifecycleArguments = (operation: string) => [
	operation,
	"--task-id",
	"host-task",
	"--task-incarnation",
	"100",
	"--session-id",
	"task-conversation-session-original",
	"--expected-native-session-id",
	"original-native-session",
];

describe("完整会话创建请求的公共 CLI", () => {
	it.each(["create", "preview", "lookup"])("%s 消费同一完整冻结请求", async (operation) => {
		const f = fixture();
		const result = await f.run([operation, "--request-file", requestFile(frozenCreationRequest)]);
		expect(result.error).toBeUndefined();
		expect({ create: f.create, preview: f.preview, lookup: f.lookup }[operation]).toHaveBeenCalledWith(
			frozenCreationRequest,
		);
	});
	it("lookup 未找到只返回明确未登记，不创建", async () => {
		const f = fixture();
		f.lookup.mockResolvedValue(null);
		const result = await f.run(["lookup", "--request-file", requestFile(frozenCreationRequest)]);
		expect(result.error).toBeUndefined();
		expect(result.output).toMatchObject({ ok: true, found: false, creation: null, summary: null });
		expect(f.create).not.toHaveBeenCalled();
	});
	it("缺少显式 Plan 设置在解析项目之前拒绝", async () => {
		const f = fixture();
		const { startInPlanMode: _unused, ...request } = frozenCreationRequest;
		const result = await f.run(["create", "--request-file", requestFile(request)]);
		expect(result.error).toBeDefined();
		expect(f.resolveWorkspace).not.toHaveBeenCalled();
	});
	it("冻结请求不得混入另一份正文或设置", async () => {
		const f = fixture();
		const result = await f.run([
			"create",
			"--request-file",
			requestFile(frozenCreationRequest),
			"--message",
			"不同正文",
		]);
		expect(result.error).toBeDefined();
		expect(f.create).not.toHaveBeenCalled();
	});
});

describe("精确侧会话的公共生命周期 CLI", () => {
	it("resume 沿原身份与原设置接续，空正文且不操作主任务", async () => {
		const f = fixture();
		const result = await f.run(lifecycleArguments("resume"));
		expect(result.error).toBeUndefined();
		expect(result.output).toMatchObject({ ok: true, operation: "resume", status: "resumed" });
		expect(f.boundResume).toHaveBeenCalledWith({
			taskId: f.card.id,
			expectedTaskIncarnationCreatedAtEpochMs: f.card.createdAt,
			taskConversationSessionId: f.summary.taskId,
			expectedNativeConversationSessionId: "original-native-session",
		});
		expect(f.start).not.toHaveBeenCalled();
		expect(f.stop).not.toHaveBeenCalled();
	});
	it("stop 只停止核验过的侧会话", async () => {
		const f = fixture();
		const result = await f.run(lifecycleArguments("stop"));
		expect(result.error).toBeUndefined();
		expect(result.output).toMatchObject({ ok: true, operation: "stop", status: "stopped" });
		expect(f.stop).toHaveBeenCalledExactlyOnceWith({ taskId: f.summary.taskId, confirmProcessExit: true });
		expect(f.start).not.toHaveBeenCalled();
	});
	it("冷重建归零进程活性后仍按原执行目录恢复", async () => {
		const f = fixture();
		const reconstructed = reconstructTaskSessionSummaryFromPersistedRecordWithoutLiveAgentProcess(
			{ ...f.summary, liveness: "live", pid: 42 },
			{ logsReconciliation: false },
		);
		f.state.sessions[f.summary.taskId] = reconstructed;
		expect(reconstructed.pid).toBeNull();
		expect(reconstructed.workspacePath).toBe(f.summary.workspacePath);
		expect((await f.run(lifecycleArguments("resume"))).output).toMatchObject({ ok: true, status: "resumed" });
		expect(f.boundResume).toHaveBeenCalledTimes(1);
	});
	it("预留side缺摘要仍持久撤销，退出事实保持未知", async () => {
		const f = fixture();
		delete f.state.sessions[f.summary.taskId];
		f.get.mockResolvedValue({ creation: f.creation, summary: null, taskConversationSessionExplicitlyStopped: true });
		f.stop.mockResolvedValue({ ok: false, summary: null, explicitStopRecorded: true, processExitConfirmed: false });
		const result = await f.run(lifecycleArguments("stop").slice(0, -2));
		expect(f.stop).toHaveBeenCalledExactlyOnceWith({ taskId: f.summary.taskId, confirmProcessExit: true });
		expect(result.output).toMatchObject({
			ok: false,
			status: "awaiting_stop_evidence",
			explicitStopRecorded: true,
			processExitConfirmed: false,
		});
	});
	it.each([
		{ explicitStopRecorded: false, processExitConfirmed: true },
		{ explicitStopRecorded: true, processExitConfirmed: false },
		{},
	])("停止受理不冒充持久撤销和退出完成 %j", async (evidence) => {
		const f = fixture();
		f.stop.mockResolvedValue({ ok: true, summary: f.summary, ...evidence });
		const result = await f.run(lifecycleArguments("stop"));
		expect(result.output).toMatchObject({ ok: false, status: "awaiting_stop_evidence" });
	});
	it.each(["resume", "stop"])("%s 拒绝宿主换代或原生身份不匹配", async (operation) => {
		const f = fixture();
		f.card.createdAt = 101;
		const changedTask = await f.run(lifecycleArguments(operation));
		expect(changedTask.output).toMatchObject({ ok: false, status: "identity_mismatch" });
		f.card.createdAt = 100;
		if (f.summary.agentNativeConversationSessionIdentity)
			f.summary.agentNativeConversationSessionIdentity.nativeSessionId = "different-native";
		const changedNative = await f.run(lifecycleArguments(operation));
		expect(changedNative.output).toMatchObject({ ok: false, status: "identity_mismatch" });
		expect(f.start).not.toHaveBeenCalled();
		expect(f.stop).not.toHaveBeenCalled();
	});
	it("原生身份缺证不以新建会话冒充恢复", async () => {
		const f = fixture();
		f.summary.agentNativeConversationSessionIdentity = null;
		const result = await f.run(lifecycleArguments("resume"));
		expect(result.output).toMatchObject({ ok: false, status: "identity_unknown" });
		expect(f.start).not.toHaveBeenCalled();
	});
	it("await 期间宿主换代，在调用生命周期 RPC 前复查拒绝", async () => {
		const f = fixture();
		f.get.mockImplementationOnce(async () => {
			f.card.createdAt = 101;
			return { summary: f.summary, creation: f.creation, reports: [], history: { messages: [], nextCursor: null } };
		});
		const result = await f.run(lifecycleArguments("stop"));
		expect(result.output).toMatchObject({ ok: false, status: "identity_mismatch" });
		expect(f.stop).not.toHaveBeenCalled();
	});
	it("RPC 后绑定变化只报告未知，不把陈旧成功当成当前资格", async () => {
		const f = fixture();
		f.stop.mockImplementationOnce(async () => {
			f.card.createdAt = 101;
			return { ok: true, summary: f.summary };
		});
		const result = await f.run(lifecycleArguments("stop"));
		expect(result.output).toMatchObject({ ok: false, status: "identity_mismatch", executionMayHaveOccurred: true });
		expect(f.stop).toHaveBeenCalledTimes(1);
	});
	it("停止期间同native的新代启动也不能返回已停止", async () => {
		const f = fixture();
		f.stop.mockImplementationOnce(async () => {
			f.state.sessions[f.summary.taskId] = { ...f.summary, runtimeSessionIncarnationId: "replacement-runtime" };
			return { ok: true, summary: f.summary, explicitStopRecorded: true, processExitConfirmed: true };
		});
		expect((await f.run(lifecycleArguments("stop"))).output).toMatchObject({
			ok: false,
			status: "identity_mismatch",
		});
	});
});
