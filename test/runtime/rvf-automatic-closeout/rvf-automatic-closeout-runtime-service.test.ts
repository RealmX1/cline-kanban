import { mkdir, writeFile } from "node:fs/promises";
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
	async function complete() {
		const run = join(fixture.fixtureRootDirectoryPath, "runs", "run");
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
		const receiptDirectory = join(rvfHome, "review-start-independent-user-turn-boundary-receipts");
		const canonical = Object.fromEntries(
			Object.entries(captured.receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		);
		await writeFile(
			join(receiptDirectory, `${token}.run-binding.json`),
			JSON.stringify({
				run_id: "run",
				run_dir: run,
				receipt_sha256: computeRvfTextSha256(JSON.stringify(canonical)),
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
	return { service, dependencies, scope, token, complete, manager, runtimeApi, source, rvfHome };
}
describe("RVF 宿主自动收尾与持久投递链", () => {
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
	it("用户恢复工作后，新的独立开审回合可以登记新 run，旧 run 继续保持暂停", async () => {
		const context = await setup();
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
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
		expect(records.map((record) => record.status)).toEqual(["paused", "awaiting_rvf_completion"]);
	});

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
