import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	getTaskMessageInjectionLedgerPath,
	recordTaskMessageTerminalDeliveryOutcome,
	type TaskMessageInjectionRecord,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";
import { computeRvfTextSha256 } from "../../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { createRvfAutomaticCloseoutRuntimeService } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-runtime-service";
import { enqueueAgentIdleGatedProgrammaticTaskChatMessage } from "../../../src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const mocked = vi.hoisted(() => ({ directory: "", board: vi.fn(), request: vi.fn(), persist: vi.fn() }));
vi.mock("../../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: () => mocked.directory,
	getWorkspacesRootPath: () => dirname(mocked.directory),
	loadWorkspaceBoardById: mocked.board,
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: mocked.persist,
}));
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withCodexAppServerRequestConnection: async (
		_input: unknown,
		operation: (port: { request: typeof mocked.request }) => Promise<unknown>,
	) => operation({ request: mocked.request }),
}));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

async function setup(mainConversationSessionId = "task") {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "rvf-runtime-closeout" });
	await writeFile(join(repo.repositoryPath, "implementation.txt"), "实现\n");
	repo.commitAllRepositoryFilesAtDate({ message: "实现", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
	const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-home");
	vi.stubEnv("RVF_HOME", rvfHome);
	mocked.directory = join(fixture.fixtureRootDirectoryPath, "workspace");
	await mkdir(mocked.directory);
	const scope = { workspaceId: "workspace", workspacePath: repo.repositoryPath };
	const token = "0123456789abcdef";
	const boundaryText = `RVF 发起决策点 · RVF_DECISION_TOKEN=${token}`;
	const source = [
		{ id: "implementation", status: "completed", items: [] },
		{
			id: "boundary",
			status: "completed",
			items: [{ id: "boundary-message", type: "userMessage", content: [{ type: "text", text: boundaryText }] }],
		},
	];
	mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) =>
		method === "thread/fork"
			? { thread: { id: "restored", path: "/restored.jsonl", cwd: repo.repositoryPath } }
			: { data: parameters.threadId === "restored" ? source.slice(0, 1) : source, nextCursor: null },
	);
	let summary: RuntimeTaskSessionSummary = {
		taskId: mainConversationSessionId,
		taskConversationSessionMetadata:
			mainConversationSessionId === "task"
				? undefined
				: {
						workspaceTaskId: "task",
						taskConversationSessionRole: "task_collaborator",
						taskConversationSessionContextSource: "started_from_scratch",
						taskConversationSessionLaunchSettings: {
							taskAgentPermissionMode: "ask_for_every_tool_use",
							sessionTransport: "pty_terminal",
						},
						parentTaskConversationSessionId: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: null,
					},
		state: "awaiting_review",
		agentId: "codex",
		workspacePath: repo.repositoryPath,
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath: "/native.jsonl",
			observedAt: 1,
		},
	};
	mocked.board.mockResolvedValue({
		columns: [
			{
				id: "review",
				cards: [
					{
						id: "task",
						mainTaskConversationSessionId:
							mainConversationSessionId === "task" ? undefined : mainConversationSessionId,
						prompt: "原始需求",
						startInPlanMode: false,
						baseRef: "main",
					},
				],
			},
		],
	});
	const manager = {
		listSummaries: () =>
			mainConversationSessionId === "task"
				? [summary]
				: [
						summary,
						{
							...summary,
							taskId: "task",
							agentId: "claude" as const,
							taskConversationSessionMetadata: undefined,
						},
					],
		getSummary: () => summary,
		isTaskSessionAutomaticContinuationSuppressed: () => false,
		getAwaitingDispatchedBackgroundWork: () => ({ parked: false, label: null, sinceMs: null }),
		resolveTaskTerminalInputBoxOccupancy: vi.fn(async () => ({
			hasUncommittedInput: false,
			inputSideByteTrackingSaysNonEmpty: false,
			screenReadingSaysNonEmpty: false,
			unrecoverablePasteCount: 0,
		})),
		forceStopTaskSession: vi.fn(async () => {}),
		applyAgentNativeConversationSessionIdentity: vi.fn(
			(
				_task: string,
				identity: NonNullable<RuntimeTaskSessionSummary["agentNativeConversationSessionIdentity"]>,
			) => {
				summary = { ...summary, agentNativeConversationSessionIdentity: identity };
				return summary;
			},
		),
		publishRvfAutomaticCloseoutPaused: vi.fn(),
	};
	const runtimeApi = {
		cancelTaskChatDelivery: vi.fn(async () => ({ ok: true, cancelResult: "no_pending_delivery" as const })),
		startTaskSession: vi.fn(async () => ({ ok: true, summary })),
		enqueueAgentIdleGatedProgrammaticTaskChatMessage: vi.fn(
			async (_scope: unknown, input: Parameters<typeof enqueueAgentIdleGatedProgrammaticTaskChatMessage>[2]) =>
				enqueueAgentIdleGatedProgrammaticTaskChatMessage({}, scope.workspaceId, input),
		),
	};
	const dependencies = {
		getManager: async () => manager,
		runtimeApi,
		listWorkspaces: async () => [scope],
		warn: vi.fn(),
	};
	const service = createRvfAutomaticCloseoutRuntimeService(dependencies);
	const tokenDirectory = join(rvfHome, "agentic-initiation-decision-tokens");
	await mkdir(tokenDirectory, { recursive: true });
	await writeFile(
		join(tokenDirectory, `${token}.json`),
		JSON.stringify({
			token,
			session_id: "native",
			worktree: repo.repositoryPath,
			candidate_fingerprint: "candidate",
			state: "injected",
			minted_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			candidate_summary: {},
		}),
	);
	const captured = await service.capture(scope, { taskId: "task", decisionToken: token });
	const run = join(fixture.fixtureRootDirectoryPath, "runs", "run");
	const bindingPath = join(
		rvfHome,
		"review-start-independent-user-turn-boundary-receipts",
		`${token}.run-binding.json`,
	);
	const runReceiptPath = join(run, "inputs", "automatic-closeout-review-start-receipt.json");
	async function bindRun() {
		await mkdir(dirname(runReceiptPath), { recursive: true });
		await writeFile(runReceiptPath, JSON.stringify(captured.receipt));
		const canonical = Object.fromEntries(
			Object.entries(captured.receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		);
		await writeFile(
			bindingPath,
			JSON.stringify({
				run_id: "run",
				run_dir: run,
				receipt_sha256: computeRvfTextSha256(JSON.stringify(canonical)),
			}),
		);
	}
	async function complete(activate = true) {
		await bindRun();
		if (activate) await service.activateAfterRunBinding(scope, { taskId: "task", decisionToken: token });
		const artifacts = join(run, "artifacts");
		await mkdir(artifacts, { recursive: true });
		const handoffPath = join(artifacts, "handoff.md");
		await writeFile(handoffPath, "RVF 修复已完成");
		await writeFile(
			join(artifacts, ".finalize.lock"),
			JSON.stringify({
				run_id: "run",
				run_dir: run,
				repo: repo.repositoryPath,
				decision_kind: "handoff-advisory",
				completed_at: "now",
				errors: [],
			}),
		);
		const notifications = join(rvfHome, "automatic-closeout-completion-notifications");
		await mkdir(notifications);
		await writeFile(
			join(notifications, `${token}.json`),
			JSON.stringify({
				schema: "rvf-automatic-closeout-completion/v1",
				decision_token: token,
				session_id: "native",
				worktree: repo.repositoryPath,
				run_id: "run",
				run_dir: run,
				handoff_path: handoffPath,
				handoff_sha256: computeRvfTextSha256("RVF 修复已完成"),
			}),
		);
	}
	return {
		service,
		dependencies,
		scope,
		token,
		complete,
		bindRun,
		bindingPath,
		runReceiptPath,
		captured,
		run,
		manager,
		runtimeApi,
		source,
		rvfHome,
	};
}
describe("RVF 宿主自动收尾与持久投递链", () => {
	it("捕获默认仅保存非活跃分界，重启和重试不重捕获或扫描完成事实", async () => {
		const context = await setup();
		const captured = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		expect(captured?.status).toBe("captured_review_start_boundary");
		const requestCount = mocked.request.mock.calls.length;
		context.source.push({ id: "bootstrap-followup", status: "completed", items: [] });
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		expect(await restarted.capture(context.scope, { taskId: "task", decisionToken: context.token })).toEqual({
			receipt: captured?.receipt,
		});
		await restarted.sweepPendingCloseoutsOnce();
		expect((await restarted.status(context.scope, { taskId: "task" })).records).toEqual([captured]);
		expect(mocked.request).toHaveBeenCalledTimes(requestCount);
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
		await expect(
			restarted.validateCloseoutPromptDelivery(context.scope, {
				taskId: "task",
				source: "rvf_automatic_closeout",
				idempotencyKey: captured?.promptDeliveryIdempotencyKey,
			}),
		).rejects.toThrow("尚未激活");
	});
	it("即使已存在成功通知，未显式激活的捕获在重启后也不恢复或投递", async () => {
		const context = await setup();
		await context.complete(false);
		const captured = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		mocked.request.mockClear();
		await context.service.sweepPendingCloseoutsOnce();
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await restarted.sweepPendingCloseoutsOnce();
		expect((await restarted.status(context.scope, { taskId: "task" })).records).toEqual([captured]);
		expect(mocked.request).not.toHaveBeenCalled();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
	});
	it("只有完整 run 双向绑定才能激活，重复激活与重启不改分界或阶段时间", async () => {
		const context = await setup();
		const input = { taskId: "task", decisionToken: context.token };
		await expect(context.service.activateAfterRunBinding(context.scope, input)).rejects.toThrow();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe(
			"captured_review_start_boundary",
		);
		await context.bindRun();
		expect(await context.service.activateAfterRunBinding(context.scope, input)).toEqual(context.captured);
		const active = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		expect(active).toMatchObject({
			status: "awaiting_rvf_completion",
			runId: "run",
			runDirectory: context.run,
			preReviewTurnIds: ["implementation"],
			receipt: context.captured.receipt,
		});
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		expect(await restarted.activateAfterRunBinding(context.scope, input)).toEqual(context.captured);
		expect((await restarted.status(context.scope, { taskId: "task" })).records).toEqual([active]);
	});
	it("两个服务同时激活同一绑定时幂等复用一条记录", async () => {
		const context = await setup();
		await context.bindRun();
		const other = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		const input = { taskId: "task", decisionToken: context.token };
		expect(
			await Promise.all([
				context.service.activateAfterRunBinding(context.scope, input),
				other.activateAfterRunBinding(context.scope, input),
			]),
		).toEqual([context.captured, context.captured]);
		expect((await context.service.status(context.scope, { taskId: "task" })).records).toHaveLength(1);
	});
	it.each([
		"run_id",
		"run_dir",
		"receipt_sha256",
		"receipt_token",
		"receipt_checkpoint",
		"extra_receipt_field",
		"missing_receipt",
	])("错误的 $0 绑定不能激活或启动任何恢复", async (corruption) => {
		const context = await setup();
		await context.bindRun();
		const binding = JSON.parse(await readFile(context.bindingPath, "utf8"));
		const receipt = { ...context.captured.receipt };
		if (corruption === "run_id") binding.run_id = "another-run";
		if (corruption === "run_dir") binding.run_dir = dirname(context.run);
		if (corruption === "receipt_sha256") binding.receipt_sha256 = "wrong-digest";
		if (corruption === "receipt_token") receipt.decision_token = "fedcba9876543210";
		if (corruption === "receipt_checkpoint") receipt.checkpoint_tree = "another-tree";
		await writeFile(context.bindingPath, JSON.stringify(binding));
		await writeFile(
			context.runReceiptPath,
			JSON.stringify({ ...receipt, ...(corruption === "extra_receipt_field" ? { extra: true } : {}) }),
		);
		if (corruption === "missing_receipt") await rm(context.runReceiptPath);
		await expect(
			context.service.activateAfterRunBinding(context.scope, { taskId: "task", decisionToken: context.token }),
		).rejects.toThrow();
		await context.service.sweepPendingCloseoutsOnce();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe(
			"captured_review_start_boundary",
		);
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	});
	it("run 内凭据通过软链接指向其他目录时拒绝激活", async () => {
		const context = await setup();
		await context.bindRun();
		const outsideReceipt = join(context.rvfHome, "outside-receipt.json");
		await writeFile(outsideReceipt, JSON.stringify(context.captured.receipt));
		await rm(context.runReceiptPath);
		await symlink(outsideReceipt, context.runReceiptPath);
		await expect(
			context.service.activateAfterRunBinding(context.scope, { taskId: "task", decisionToken: context.token }),
		).rejects.toThrow("不属于该 run");
	});
	it.each(["主会话", "原生身份", "transcript", "worktree"])("激活前$0改变时保留非活跃捕获", async (changed) => {
		const context = await setup();
		await context.bindRun();
		const summary = context.manager.getSummary();
		const identity = summary.agentNativeConversationSessionIdentity;
		if (!identity) throw new Error("测试缺少原生身份");
		vi.spyOn(context.manager, "listSummaries").mockReturnValue([
			{
				...summary,
				taskId: changed === "主会话" ? "replacement" : summary.taskId,
				workspacePath: changed === "worktree" ? context.rvfHome : summary.workspacePath,
				agentNativeConversationSessionIdentity: {
					...identity,
					nativeSessionId: changed === "原生身份" ? "replacement" : "native",
					transcriptPath: changed === "transcript" ? "/replacement.jsonl" : "/native.jsonl",
				},
			},
		]);
		await expect(
			context.service.activateAfterRunBinding(context.scope, { taskId: "task", decisionToken: context.token }),
		).rejects.toThrow();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe(
			"captured_review_start_boundary",
		);
	});
	it("激活期间显式停止不会被旧回调覆盖，重启后也不能重新激活", async () => {
		const context = await setup();
		await context.bindRun();
		const board = await mocked.board();
		let releaseBoard!: () => void;
		let markBoardStarted!: () => void;
		const boardStarted = new Promise<void>((resolve) => {
			markBoardStarted = resolve;
		});
		const boardReleased = new Promise<void>((resolve) => {
			releaseBoard = resolve;
		});
		mocked.board.mockImplementationOnce(async () => {
			markBoardStarted();
			await boardReleased;
			return board;
		});
		const input = { taskId: "task", decisionToken: context.token };
		const activation = context.service.activateAfterRunBinding(context.scope, input);
		const rejectedActivation = expect(activation).rejects.toThrow("停止");
		await boardStarted;
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		releaseBoard();
		await rejectedActivation;
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await expect(restarted.activateAfterRunBinding(context.scope, input)).rejects.toThrow("暂停");
		expect((await restarted.status(context.scope, { taskId: "task" })).records[0]?.status).toBe("paused");
		expect(await restarted.capture(context.scope, input)).toEqual(context.captured);
	});
	it("捕获期间按当前主会话停止，不会登记晚到的非活跃分界", async () => {
		const context = await setup("codex-handover-target");
		const nextToken = "fedcba9876543210";
		context.source.push({
			id: "next-boundary",
			status: "completed",
			items: [
				{
					id: "next-message",
					type: "userMessage",
					content: [{ type: "text", text: `RVF 发起决策点 · RVF_DECISION_TOKEN=${nextToken}` }],
				},
			],
		});
		await writeFile(
			join(context.rvfHome, "agentic-initiation-decision-tokens", `${nextToken}.json`),
			JSON.stringify({
				token: nextToken,
				session_id: "native",
				worktree: context.scope.workspacePath,
				candidate_fingerprint: "next",
				state: "injected",
				minted_at: new Date().toISOString(),
				expires_at: new Date(Date.now() + 60_000).toISOString(),
				candidate_summary: {},
			}),
		);
		let releaseRead!: () => void;
		let markReadStarted!: () => void;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const readReleased = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const request = mocked.request.getMockImplementation();
		mocked.request.mockImplementationOnce(async (method, parameters) => {
			markReadStarted();
			await readReleased;
			return request?.(method, parameters);
		});
		const capture = context.service.capture(context.scope, { taskId: "task", decisionToken: nextToken });
		const rejectedCapture = expect(capture).rejects.toThrow("停止");
		await readStarted;
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "codex-handover-target");
		releaseRead();
		await rejectedCapture;
		const records = (await context.service.status(context.scope, { taskId: "task" })).records;
		expect(records).toHaveLength(1);
		expect(records[0]?.status).toBe("paused");
	});
	it("无人点击时自动恢复并入队，确认提交后终结投递阶段；重启复用同一记录与队列", async () => {
		const context = await setup();
		await context.complete();
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(context.runtimeApi.startTaskSession).toHaveBeenCalledWith(
			context.scope,
			expect.objectContaining({ resumePriorAgentConversationWithoutResendingPrompt: true, prompt: "" }),
		);
		let record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		expect(record?.status).toBe("submitting_closeout_prompt");
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls[0]?.[1].text).toContain(
			"$rvf-land 和 $base-branch-sync",
		);
		if (!record) throw new Error("缺少持久记录");
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath: getTaskMessageInjectionLedgerPath(mocked.directory),
			taskId: "task",
			idempotencyKey: record.promptDeliveryIdempotencyKey,
			status: "delivered_and_submit_confirmed",
			nowIso: new Date().toISOString(),
		});
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await restarted.sweepPendingCloseoutsOnce();
		await restarted.sweepPendingCloseoutsOnce();
		record = (await restarted.status(context.scope, { taskId: "task" })).records[0];
		expect(record?.status).toBe("closeout_prompt_submitted");
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	});
	it("fork 请求结果不明时不盲目重建分支，重启仍保留暂停原因", async () => {
		const context = await setup();
		await context.complete();
		const existingImplementation = mocked.request.getMockImplementation();
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/fork") throw new Error("传输断开，原生操作是否发生未知");
			return existingImplementation?.(method, parameters);
		});
		await context.service.sweepPendingCloseoutsOnce();
		const status = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		expect(status).toMatchObject({
			status: "paused",
			pauseReason: expect.stringContaining("fork 未确认"),
			restoredNativeSessionId: null,
			nativeForkAttemptStartedAt: expect.any(Number),
		});
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
	});

	it("交接后的 Codex 主会话按当前绑定恢复，不被旧主会话的旧角色误导", async () => {
		const context = await setup("codex-handover-target");
		await context.complete();
		await context.service.sweepPendingCloseoutsOnce();
		const record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		expect(record?.conversationSessionId).toBe("codex-handover-target");
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledWith("codex-handover-target");
		expect(context.runtimeApi.startTaskSession).toHaveBeenCalledWith(
			context.scope,
			expect.objectContaining({
				taskId: "codex-handover-target",
				workspaceTaskId: "task",
				taskAgentPermissionMode: "ask_for_every_tool_use",
				taskConversationSessionMetadata: expect.objectContaining({
					taskConversationSessionRole: "main",
					taskConversationSessionRoleAtCreation: "task_collaborator",
				}),
			}),
		);
	});

	it.each([
		{ ledgerTaskId: "task", source: "review-validate-fix", deliveryStatus: "delivered_and_submit_confirmed" },
		{
			ledgerTaskId: "codex-handover-target",
			source: "review-validate-fix",
			deliveryStatus: "delivered_and_submit_confirmed",
		},
		{
			ledgerTaskId: "task",
			source: "review-validate-fix",
			deliveryStatus: "delivered_queued_behind_active_agent_turn",
		},
		{ ledgerTaskId: "task", source: "rvf_automatic_closeout", deliveryStatus: "delivered_and_submit_confirmed" },
		{
			ledgerTaskId: "codex-handover-target",
			source: "rvf_automatic_closeout",
			deliveryStatus: "delivered_and_submit_confirmed",
		},
	] as const)(
		"按 $ledgerTaskId 寻址且 $source 已提交的 RVF 消息允许恢复（$deliveryStatus）",
		async ({ ledgerTaskId, source, deliveryStatus }) => {
			const context = await setup("codex-handover-target");
			await context.complete();
			const text = "RVF 后台工作已完成，请继续当前 run。";
			context.source.push({
				id: "registered-rvf-followup",
				status: "completed",
				items: [{ id: "rvf-followup-message", type: "userMessage", content: [{ type: "text", text }] }],
			});
			const nowIso = new Date().toISOString();
			await withTaskMessageInjectionLedgerLock(
				getTaskMessageInjectionLedgerPath(mocked.directory),
				async (records) => ({
					records: [
						...records,
						{
							task_id: ledgerTaskId,
							source,
							idempotency_key: "rvf-followup",
							prompt_sha256: computeRvfTextSha256(text),
							message_id: "rvf-followup-message",
							terminal_delivery_status: deliveryStatus,
							terminal_delivery_status_updated_at: nowIso,
							created_at: nowIso,
						},
					],
					result: null,
				}),
			);
			await context.service.sweepPendingCloseoutsOnce();
			expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe(
				"submitting_closeout_prompt",
			);
			expect(context.manager.forceStopTaskSession).toHaveBeenCalledWith("codex-handover-target");
		},
	);

	it.each([
		{ ledgerTaskId: "another-task", source: "review-validate-fix", deliveryStatus: "delivered_and_submit_confirmed" },
		{ ledgerTaskId: "task", source: "user", deliveryStatus: "delivered_and_submit_confirmed" },
		{ ledgerTaskId: "codex-handover-target", source: "rvf_automatic_closeout", deliveryStatus: "delivery_failed" },
		{
			ledgerTaskId: "codex-handover-target",
			source: "rvf_automatic_closeout",
			deliveryStatus: "accepted_pending_submit_confirmation",
		},
	] satisfies {
		ledgerTaskId: string;
		source: string;
		deliveryStatus: TaskMessageInjectionRecord["terminal_delivery_status"];
	}[])(
		"同正文的 $source 账本不能放行其他任务或未确认投递（$ledgerTaskId / $deliveryStatus）",
		async ({ ledgerTaskId, source, deliveryStatus }) => {
			const context = await setup("codex-handover-target");
			await context.complete();
			const text = "保留这条人工指令。";
			context.source.push({
				id: "unregistered-human-turn",
				status: "completed",
				items: [{ id: "human-message", type: "userMessage", content: [{ type: "text", text }] }],
			});
			const nowIso = new Date().toISOString();
			await withTaskMessageInjectionLedgerLock(
				getTaskMessageInjectionLedgerPath(mocked.directory),
				async (records) => ({
					records: [
						...records,
						{
							task_id: ledgerTaskId,
							source,
							idempotency_key: "unrelated-or-unconfirmed-message",
							prompt_sha256: computeRvfTextSha256(text),
							message_id: "unrelated-message",
							terminal_delivery_status: deliveryStatus,
							terminal_delivery_status_updated_at: nowIso,
							created_at: nowIso,
						},
					],
					result: null,
				}),
			);
			await context.service.sweepPendingCloseoutsOnce();
			expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
				status: "paused",
				pauseReason: expect.stringContaining("用户消息"),
			});
			expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		},
	);

	it("人工插话使本轮暂停，不能丢掉用户新上下文", async () => {
		const context = await setup();
		await context.complete();
		context.source.push({
			id: "human",
			status: "completed",
			items: [{ id: "human-message", type: "userMessage", content: [{ type: "text", text: "先不要提交" }] }],
		});
		await context.service.sweepPendingCloseoutsOnce();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
			status: "paused",
			pauseReason: expect.stringContaining("用户消息"),
		});
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(context.manager.publishRvfAutomaticCloseoutPaused).toHaveBeenCalledOnce();
	});
	it("明确停止跨服务重启保持暂停，不再自动续跑", async () => {
		const context = await setup();
		await context.complete();
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe("paused");
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
	});
	it.each(["task", "codex-handover-target"])(
		"用户恢复 $0 后，新分界可以登记，旧 run 继续暂停",
		async (mainSessionId) => {
			const context = await setup(mainSessionId);
			await context.service.pauseForExplicitStop(context.scope.workspaceId, mainSessionId);
			const nextToken = "fedcba9876543210";
			context.source.push(
				{ id: "resumed-implementation", status: "completed", items: [] },
				{
					id: "next-boundary",
					status: "completed",
					items: [
						{
							id: "next-message",
							type: "userMessage",
							content: [{ type: "text", text: `RVF 发起决策点 · RVF_DECISION_TOKEN=${nextToken}` }],
						},
					],
				},
			);
			await writeFile(
				join(context.rvfHome, "agentic-initiation-decision-tokens", `${nextToken}.json`),
				JSON.stringify({
					token: nextToken,
					session_id: "native",
					worktree: context.scope.workspacePath,
					candidate_fingerprint: "next-candidate",
					state: "injected",
					minted_at: new Date().toISOString(),
					expires_at: new Date(Date.now() + 60_000).toISOString(),
					candidate_summary: {},
				}),
			);
			await context.service.capture(context.scope, { taskId: "task", decisionToken: nextToken });
			const records = (await context.service.status(context.scope, { taskId: "task" })).records;
			expect(records.map((record) => record.status)).toEqual(["paused", "captured_review_start_boundary"]);
		},
	);

	it("无通知不误用历史 handoff；错误摘要不会恢复", async () => {
		const context = await setup();
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		await context.complete();
		await writeFile(
			join(context.rvfHome, "automatic-closeout-completion-notifications", `${context.token}.json`),
			"{}",
		);
		await context.service.sweepPendingCloseoutsOnce();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe("paused");
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
	});
});
