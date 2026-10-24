import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTaskCommand } from "../../../src/commands/task";
import {
	type CodexNativePromptDeliveryEvidence,
	type RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
	type RuntimeTaskChatSendRequest,
	type RuntimeWorkspaceStateResponse,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import { readTaskMessageInjectionLedger } from "../../../src/core/task-message-injection-ledger";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../../../src/state/queued-task-prompt-delivery-store";
import { enqueueAgentIdleGatedProgrammaticTaskChatMessage } from "../../../src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue";

const harness = vi.hoisted(() => ({
	workspaceDirectory: "",
	state: null as RuntimeWorkspaceStateResponse | null,
	immediateRequests: [] as RuntimeTaskChatSendRequest[],
	queuedRequests: [] as RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest[],
	nativeEvidence: null as CodexNativePromptDeliveryEvidence | null,
}));

vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => dirname(harness.workspaceDirectory),
	loadWorkspaceContext: async () => ({
		repoPath: "/isolated/repo",
		workspaceId: "workspace-cli-test",
		statePath: harness.workspaceDirectory,
	}),
	getWorkspaceDirectoryPath: () => harness.workspaceDirectory,
	getWorkspacesRootPath: () => dirname(harness.workspaceDirectory),
	loadWorkspaceBoardById: async () => harness.state?.board,
	loadPersistedWorkspaceStateById: async () => harness.state,
	detectGitRepositoryInfo: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(),
	resolveWorkspacePath: vi.fn(),
}));

vi.mock("@trpc/client", () => ({
	httpBatchLink: () => ({}),
	createTRPCProxyClient: () => ({
		workspace: { getState: { query: async () => harness.state } },
		runtime: {
			sendTaskChatMessage: {
				mutate: async (input: RuntimeTaskChatSendRequest) => {
					harness.immediateRequests.push(input);
					return {
						ok: true,
						summary: harness.state?.sessions[input.targetTaskConversationSessionId ?? input.taskId],
						message: { id: "confirmed-message" },
						terminalDelivery: {
							status: "delivered_and_submit_confirmed",
							reason: null,
							...(harness.nativeEvidence ? { codexNativePromptDeliveryEvidence: harness.nativeEvidence } : {}),
						},
					};
				},
			},
			enqueueAgentIdleGatedProgrammaticTaskChatMessage: {
				mutate: async (input: RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest) => {
					harness.queuedRequests.push(input);
					return enqueueAgentIdleGatedProgrammaticTaskChatMessage(
						{ getTaskSessionSummary: (id) => harness.state?.sessions[id] ?? null },
						"workspace-cli-test",
						input,
					);
				},
			},
		},
	}),
}));

function session(taskId: string, workspaceTaskId?: string) {
	return runtimeTaskSessionSummarySchema.parse({
		taskId,
		state: "idle",
		agentId: "codex",
		workspacePath: "/isolated/repo",
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: `${taskId}-incarnation`,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: `${taskId}-native`,
			transcriptPath: null,
			observedAt: 1,
		},
		...(workspaceTaskId
			? {
					taskConversationSessionMetadata: {
						workspaceTaskId,
						taskConversationSessionRole: "task_collaborator",
						taskConversationSessionContextSource: "started_from_scratch",
						parentTaskConversationSessionId: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: null,
					},
				}
			: {}),
	});
}

async function runMessage(extraArguments: string[] = []) {
	const chunks: string[] = [];
	const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		chunks.push(String(chunk));
		return true;
	});
	try {
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync([
			"node",
			"kanban",
			"task",
			"message",
			"--project-path",
			"/isolated/repo",
			"--task-id",
			"task-1",
			"--prompt",
			"RVF 决策点边界标记",
			"--source",
			"review-validate-fix",
			"--idempotency-key",
			"decision-token-key",
			...extraArguments,
		]);
		return JSON.parse(chunks.join(""));
	} finally {
		output.mockRestore();
	}
}

async function ledger() {
	return readTaskMessageInjectionLedger(join(harness.workspaceDirectory, "task-message-injections.json"));
}

beforeEach(async () => {
	process.exitCode = undefined;
	harness.workspaceDirectory = join(await mkdtemp(join(tmpdir(), "kanban-cli-target-session-")), "workspace-cli-test");
	await mkdir(harness.workspaceDirectory);
	harness.immediateRequests.length = 0;
	harness.queuedRequests.length = 0;
	harness.nativeEvidence = null;
	harness.state = {
		repoPath: "/isolated/repo",
		statePath: harness.workspaceDirectory,
		git: { currentBranch: "main", defaultBranch: "main", branches: [] },
		revision: 0,
		board: {
			columns: [
				{
					id: "in_progress",
					title: "进行中",
					cards: [
						{
							id: "task-1",
							title: "任务",
							prompt: "实现",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
							mainTaskConversationSessionId: "independent-main",
						},
					],
				},
			],
		},
		sessions: {
			"task-1": session("task-1"),
			"independent-main": session("independent-main", "task-1"),
			peer: session("peer", "task-1"),
			foreign: session("foreign", "other-task"),
		},
	};
});

afterEach(async () => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
	await rm(dirname(harness.workspaceDirectory), { recursive: true, force: true });
});

describe("task message 的卡片与会话精确绑定", () => {
	it("即时原生回执的消息身份写入账本并随 CLI 结果返回", async () => {
		harness.nativeEvidence = {
			clientUserMessageId: "client-message-1",
			nativeSessionId: "thread-1",
			nativeTurnId: "turn-2",
			nativeUserMessageId: "user-2",
		};
		expect(await runMessage()).toMatchObject({ codex_native_prompt_delivery_evidence: harness.nativeEvidence });
		expect(await ledger()).toMatchObject([{ codex_native_prompt_delivery_evidence: harness.nativeEvidence }]);
	});
	it.each([undefined, "independent-main", "peer", "task-1"])(
		"即时投递目标 %s，移除 ID 相等限制并透传选定会话",
		async (attemptId) => {
			const target = attemptId ?? "independent-main";
			expect(await runMessage(attemptId ? ["--attempt-id", attemptId] : [])).toMatchObject({
				ok: true,
				task_id: "task-1",
				attempt_id: target,
			});
			expect(harness.immediateRequests).toMatchObject([
				{ taskId: "task-1", targetTaskConversationSessionId: target },
			]);
			expect(await ledger()).toMatchObject([
				{ task_id: "task-1", attempt_id: target, terminal_delivery_status: "delivered_and_submit_confirmed" },
			]);
		},
	);

	it.each(["unknown", "foreign"])("非法目标 %s 在受理前拒绝，不留 pending 或调用 transport", async (attemptId) => {
		expect(await runMessage(["--attempt-id", attemptId])).toMatchObject({ ok: false });
		expect(harness.immediateRequests).toHaveLength(0);
		expect(await ledger()).toEqual([]);
	});

	it("同 key 的隐式重试不随换主改投，显式改目标则冲突", async () => {
		await runMessage();
		if (!harness.state) throw new Error("测试状态缺失");
		harness.state.board.columns[0].cards[0].mainTaskConversationSessionId = "peer";
		expect(await runMessage()).toMatchObject({ ok: true, attempt_id: "independent-main" });
		expect(await runMessage(["--attempt-id", "peer"])).toMatchObject({
			ok: false,
			error: expect.stringContaining("Idempotency conflict"),
		});
		expect(harness.immediateRequests).toHaveLength(1);
		expect(await ledger()).toHaveLength(1);
	});

	it("独立主会话的排队请求沿用 RVF 参数，并绑定原生会话与 incarnation", async () => {
		const result = await runMessage([
			"--attempt-id",
			"independent-main",
			"--deliver-when-agent-idle",
			"--max-wait-for-agent-idle-ms",
			"600000",
			"--require-native-independent-user-turn-for-session",
			"independent-main-native",
		]);
		expect(result, JSON.stringify(result)).toMatchObject({ ok: true, attempt_id: "independent-main" });
		expect(harness.queuedRequests).toMatchObject([
			{
				taskId: "task-1",
				attemptId: "independent-main",
				requiredNativeIndependentUserTurnSessionId: "independent-main-native",
			},
		]);
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace-cli-test");
		expect(snapshot.entriesByTaskId["independent-main"]).toMatchObject([
			{
				taskId: "independent-main",
				workspaceTaskId: "task-1",
				requiredNativeIndependentUserTurnSessionIncarnationId: "independent-main-incarnation",
			},
		]);
	});
});
