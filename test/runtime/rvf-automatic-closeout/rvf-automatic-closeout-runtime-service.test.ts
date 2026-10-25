import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	getTaskMessageInjectionLedgerPath,
	recordTaskMessageTerminalDeliveryOutcome,
	type TaskMessageInjectionRecord,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";
import { computeRvfTextSha256 } from "../../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import type { CodexNativeConversationTurn } from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { buildRvfAutomaticCloseoutPrompt } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-prompt";
import { createRvfAutomaticCloseoutRuntimeService } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-runtime-service";
import {
	getRvfAutomaticCloseoutStorePath,
	updateRvfAutomaticCloseoutRecords,
} from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import {
	createTerminalInputBoxOccupancyTrackerState,
	resolveTerminalInputBoxOccupancy,
} from "../../../src/terminal/terminal-input-box-occupancy";
import { enqueueAgentIdleGatedProgrammaticTaskChatMessage } from "../../../src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const mocked = vi.hoisted(() => ({
	directory: "",
	board: vi.fn(),
	persistedConversationSessions: vi.fn(),
	request: vi.fn(),
	persist: vi.fn(),
	controlEndpoint: vi.fn(),
}));
vi.mock("../../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: () => mocked.directory,
	getWorkspacesRootPath: () => dirname(mocked.directory),
	loadWorkspaceBoardById: mocked.board,
	loadPersistedWorkspaceStateById: async () => ({
		board: await mocked.board(),
		sessions: mocked.persistedConversationSessions(),
	}),
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: mocked.persist,
}));
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withCodexAppServerRequestConnection: async (
		_input: unknown,
		operation: (port: { request: typeof mocked.request }) => Promise<unknown>,
	) => operation({ request: mocked.request }),
	withRunningCodexAppServerControlSocketConnection: async (
		operation: (port: { request: typeof mocked.request }) => Promise<unknown>,
		endpoint?: { socketPath: string },
	) => {
		mocked.controlEndpoint(endpoint);
		return operation({ request: mocked.request });
	},
}));
// 本套只验证收尾生命周期；原生原文与 checkpoint 的真实核验在 capture 分界专用套件覆盖。
vi.mock("../../../src/rvf-automatic-closeout/codex-native-review-start-message-evidence", () => ({
	isExplicitRvfManualCommand: () => false,
	readCodexNativeReviewStartMessageEvidence: async () => ({ receivedAt: new Date().toISOString() }),
}));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

async function setup(
	mainConversationSessionId = "task",
	withoutPreReviewPrefix = false,
	physicalRunDirectoryName = "run",
	commitTaskChangesBeforeReview = false,
) {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "rvf-runtime-closeout" });
	await writeFile(join(repo.repositoryPath, "implementation.txt"), "实现\n");
	repo.commitAllRepositoryFilesAtDate({ message: "实现", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
	if (commitTaskChangesBeforeReview) {
		repo.runGit(["switch", "--create", "task-with-committed-review-candidate"]);
		await writeFile(join(repo.repositoryPath, "implementation.txt"), "开审前已提交的任务实现\n");
		repo.commitAllRepositoryFilesAtDate({
			message: "feat: 开审前已提交的任务实现",
			authorAndCommitterIsoDate: "2026-01-02T00:00:00Z",
		});
	}
	const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-home");
	vi.stubEnv("RVF_HOME", rvfHome);
	mocked.directory = join(fixture.fixtureRootDirectoryPath, "workspace");
	await mkdir(mocked.directory);
	const scope = { workspaceId: "workspace", workspacePath: repo.repositoryPath };
	const token = "0123456789abcdef";
	const boundaryText = `RVF 发起决策点 · RVF_DECISION_TOKEN=${token}`;
	const source = [
		...(!withoutPreReviewPrefix ? [{ id: "implementation", status: "completed", items: [] }] : []),
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
	mocked.persistedConversationSessions.mockImplementation(() => ({ [summary.taskId]: summary }));
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
		resolveTaskTerminalInputBoxOccupancy: vi.fn<TerminalSessionManager["resolveTaskTerminalInputBoxOccupancy"]>(
			async () => ({
				hasUncommittedInput: false,
				inputSideByteTrackingSaysNonEmpty: false,
				inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
				screenReadingSaysNonEmpty: false as boolean | null,
				unrecoverablePasteCount: 0,
			}),
		),
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
		publishRvfAutomaticCloseoutWaiting: vi.fn(),
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
			initiated_by_explicit_user_request: false,
			candidate_summary: { kanban_task_id: "task", candidates: [] },
		}),
	);
	const result = await service.capture(scope, { taskId: "task", decisionToken: token });
	if (result.status !== "captured") throw new Error(JSON.stringify(result));
	const captured = { receipt: result.receipt };
	const run = join(fixture.fixtureRootDirectoryPath, "runs", physicalRunDirectoryName);
	const bindingPath = join(
		rvfHome,
		"review-start-independent-user-turn-boundary-receipts",
		`${token}.run-binding.json`,
	);
	const runReceiptPath = join(run, "inputs", "automatic-closeout-review-start-receipt.json");
	async function bindRun() {
		await mkdir(dirname(runReceiptPath), { recursive: true });
		await writeFile(runReceiptPath, JSON.stringify(captured.receipt));
		await mkdir(join(run, "artifacts", "inputs"), { recursive: true });
		await writeFile(
			join(run, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({ run_id: "run", base_ref: "main" }),
		);
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
		fixture,
		repo,
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
	it.each(["pending", "unconfirmed"] as const)(
		"本代输入接受为 %s 时保留原生会话，确认接受后才继续恢复",
		async (status) => {
			const context = await setup();
			await context.complete();
			const summary = context.manager.getSummary();
			summary.runtimeSessionIncarnationId = "current-incarnation";
			summary.agentConversationPromptSubmissionAcceptance = {
				status,
				attemptedAtMs: Date.now(),
				runtimeSessionIncarnationId: "current-incarnation",
			};
			await context.service.sweepPendingCloseoutsOnce();
			expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
			expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
			expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.waitingReasonCode).toBe(
				"agent_turn_not_ready_for_closeout",
			);
			summary.agentConversationPromptSubmissionAcceptance = {
				...summary.agentConversationPromptSubmissionAcceptance,
				status: "accepted",
				confirmedAtMs: Date.now(),
				eventId: "accepted-current-input",
				nativeSessionId: "native",
			};
			await context.service.sweepPendingCloseoutsOnce();
			expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		},
	);
	it("上一 incarnation 的待确认提交不阻断当前空闲会话的恢复", async () => {
		const context = await setup();
		await context.complete();
		const summary = context.manager.getSummary();
		summary.runtimeSessionIncarnationId = "current-incarnation";
		summary.agentConversationPromptSubmissionAcceptance = {
			status: "pending",
			attemptedAtMs: Date.now(),
			runtimeSessionIncarnationId: "previous-incarnation",
		};
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
	});
	it("恢复期间出现待确认输入时不停止会话，接受确认后复用已创建的 fork", async () => {
		const context = await setup();
		await context.complete();
		const summary = context.manager.getSummary();
		summary.runtimeSessionIncarnationId = "current-incarnation";
		const readOccupancy = context.manager.resolveTaskTerminalInputBoxOccupancy.getMockImplementation();
		if (!readOccupancy) throw new Error("缺少输入框观测实现");
		context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementationOnce(async (taskId) => {
			const occupancy = await readOccupancy(taskId);
			summary.agentConversationPromptSubmissionAcceptance = {
				status: "pending",
				attemptedAtMs: Date.now(),
				runtimeSessionIncarnationId: "current-incarnation",
			};
			return occupancy;
		});
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
		if (!summary.agentConversationPromptSubmissionAcceptance) throw new Error("缺少本代输入提交记录");
		summary.agentConversationPromptSubmissionAcceptance = {
			...summary.agentConversationPromptSubmissionAcceptance,
			status: "accepted",
			confirmedAtMs: Date.now(),
		};
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	});
	it("Codex 未建模输入框读屏且输入侧确认无草稿时继续恢复", async () => {
		const context = await setup();
		await context.complete();
		context.manager.resolveTaskTerminalInputBoxOccupancy.mockResolvedValue({
			hasUncommittedInput: false,
			inputSideByteTrackingSaysNonEmpty: false,
			inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
			screenReadingSaysNonEmpty: null,
			unrecoverablePasteCount: 0,
		});
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
	});
	it("Codex 读屏未建模但输入侧存在真实草稿时保留输入并等待", async () => {
		const context = await setup();
		await context.complete();
		context.manager.resolveTaskTerminalInputBoxOccupancy.mockResolvedValue({
			hasUncommittedInput: true,
			inputSideByteTrackingSaysNonEmpty: true,
			inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
			screenReadingSaysNonEmpty: null,
			unrecoverablePasteCount: 0,
		});
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.waitingReasonCode).toBe(
			"terminal_input_box_not_confirmed_empty",
		);
	});
	it("接管 hosted Codex PTY 后保留未知草稿，直到观察到用户明确提交才恢复", async () => {
		const context = await setup();
		await context.complete();
		const adoptedTerminalManager = new TerminalSessionManager();
		onTestFinished(() => adoptedTerminalManager.dispose());
		adoptedTerminalManager.hydrateFromRecord({ task: context.manager.getSummary() }, new Set(["task"]));
		const adoptedHandle = {
			pid: 123,
			write: vi.fn(),
			resize: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			stop: vi.fn(),
			hasExited: () => false,
			wasInterrupted: () => false,
		};
		const adoptionOutcomes = await adoptedTerminalManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			{
				taskId: "task",
				hostedSessionKind: "task_agent_session",
				pid: 123,
				spawnedAtEpochMs: 1,
				cols: 100,
				rows: 30,
				exitedWhileRuntimeWasAbsent: false,
				terminalSessionAdoptionRecord: null,
				adoptHostedTerminalPtyProcess: async ({ onCatchUpOutput }) => {
					onCatchUpOutput(Buffer.from("› 接管前留下的未提交草稿\r\n", "utf8"));
					return adoptedHandle;
				},
				terminateHostedTerminalPtyProcessAfterRefusedAdoption: vi.fn(),
			},
		]);
		expect(adoptionOutcomes[0]?.adoptionOutcome).toBe("adopted_running_session");
		context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementation(() =>
			adoptedTerminalManager.resolveTaskTerminalInputBoxOccupancy("task"),
		);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
		expect(adoptedHandle.write).not.toHaveBeenCalled();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.waitingReasonCode).toBe(
			"terminal_input_box_not_confirmed_empty",
		);
		adoptedTerminalManager.writeInput("task", Buffer.from("\r"));
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
	});
	it("原生 fork 期间输入账本变成未知时，最终检查保留原会话且重试复用已创建的 fork", async () => {
		const context = await setup();
		await context.complete();
		const knownEmptyOccupancy = resolveTerminalInputBoxOccupancy({
			trackerState: createTerminalInputBoxOccupancyTrackerState(),
			inputBoxReading: null,
		});
		const adoptedUnknownOccupancy = resolveTerminalInputBoxOccupancy({
			trackerState: createTerminalInputBoxOccupancyTrackerState("unknown"),
			inputBoxReading: null,
		});
		context.manager.resolveTaskTerminalInputBoxOccupancy
			.mockResolvedValueOnce(knownEmptyOccupancy)
			.mockResolvedValueOnce(adoptedUnknownOccupancy);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.waitingReasonCode).toBe(
			"terminal_input_box_not_confirmed_empty",
		);
		context.manager.resolveTaskTerminalInputBoxOccupancy.mockResolvedValue(knownEmptyOccupancy);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	});
	it("逻辑 run id 与物理目录名不同仍按真实绑定激活和识别完成", async () => {
		const context = await setup("task", false, "independently-named-run-directory");
		await context.complete();
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
			runId: "run",
			runDirectory: context.run,
			status: "submitting_closeout_prompt",
		});
	});
	it("只有实际 land 与 base 提交证据都成立时才完成，重复报告保持幂等", async () => {
		const context = await setup();
		await context.complete();
		await context.service.sweepPendingCloseoutsOnce();
		const record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		if (!record?.handoffSha256) throw new Error("缺少交接绑定");
		await expect(
			context.service.reportExecutionResult(context.scope, {
				taskId: "task",
				decisionToken: context.token,
				runId: "run",
				handoffSha256: record.handoffSha256,
				stage: "land",
				outcome: "completed",
				commitSha: context.captured.receipt.worktree_head_commit_sha,
			}),
		).rejects.toThrow("等待真实提交确认");
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath: getTaskMessageInjectionLedgerPath(mocked.directory),
			taskId: "task",
			idempotencyKey: record.promptDeliveryIdempotencyKey,
			status: "delivered_and_submit_confirmed",
			nowIso: new Date().toISOString(),
		});
		await context.service.sweepPendingCloseoutsOnce();
		await writeFile(join(context.repo.repositoryPath, "implementation.txt"), "已经落地的修复\n");
		const landCommitSha = context.repo.commitAllRepositoryFilesAtDate({
			message: "fix: 隔离 land 提交",
			authorAndCommitterIsoDate: "2026-01-02T00:00:00Z",
		});
		const binding = {
			taskId: "task",
			decisionToken: context.token,
			runId: "run",
			handoffSha256: record.handoffSha256,
		};
		const gitDirectory = context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim();
		const evidencePath = join(gitDirectory, "rvf", "evidence", "reviewed-task-candidate-evidence.json");
		const evidence = JSON.stringify({
			subject: {
				head_oid: landCommitSha,
				worktree_realpath: context.repo.repositoryPath,
				git_common_dir_realpath: gitDirectory,
			},
			review: { run_id: "run", protocol_valid: true },
		});
		const land = { ...binding, stage: "land" as const, outcome: "completed" as const, commitSha: landCommitSha };
		await expect(
			context.service.reportExecutionResult(context.scope, {
				...binding,
				stage: "base_branch_sync",
				outcome: "completed",
				commitSha: landCommitSha,
				baseRef: "main",
			}),
		).rejects.toThrow("尚未确认 land");
		await expect(context.service.reportExecutionResult(context.scope, land)).rejects.toThrow();
		await mkdir(dirname(evidencePath), { recursive: true });
		await writeFile(evidencePath, evidence);
		await writeFile(`${evidencePath}.sha256`, "错误摘要");
		await expect(context.service.reportExecutionResult(context.scope, land)).rejects.toThrow("摘要");
		await writeFile(`${evidencePath}.sha256`, computeRvfTextSha256(evidence));
		await expect(
			context.service.reportExecutionResult(context.scope, {
				...land,
				commitSha: context.captured.receipt.worktree_head_commit_sha,
			}),
		).rejects.toThrow("绑定");
		const first = await context.service.reportExecutionResult(context.scope, land);
		expect(first.record.status).toBe("closeout_prompt_submitted");
		expect((await context.service.reportExecutionResult(context.scope, land)).record).toEqual(first.record);
		const baseTipBeforeDeferral = context.repo.runGit(["rev-parse", "main"]).stdout;
		const deferred = await context.service.reportExecutionResult(context.scope, {
			...binding,
			stage: "base_branch_sync",
			outcome: "blocked",
			blockedReasonKind: "agent_assessed_not_ready_for_base_sync",
			reason: "当前候选仍依赖未闭合的协议变更，暂不整合到本地 main",
			baseBranchSyncReassessmentCondition: "协议依赖闭合且相应验证通过后重新评估",
		});
		expect(deferred.record.baseBranchSyncExecutionResult).toMatchObject({
			outcome: "blocked",
			blockedReasonKind: "agent_assessed_not_ready_for_base_sync",
			baseBranchSyncReassessmentCondition: "协议依赖闭合且相应验证通过后重新评估",
		});
		expect(deferred.record.landExecutionResult?.outcome).toBe("completed");
		expect(deferred.record.status).not.toBe("completed");
		const sendsBeforeDeferral = context.manager.forceStopTaskSession.mock.calls.length;
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledTimes(sendsBeforeDeferral);
		expect(context.repo.runGit(["rev-parse", "main"]).stdout).toBe(baseTipBeforeDeferral);
		const completed = await context.service.reportExecutionResult(context.scope, {
			...binding,
			stage: "base_branch_sync",
			outcome: "completed",
			commitSha: landCommitSha,
			baseRef: "refs/heads/main",
		});
		expect(completed.record.status).toBe("completed");
		expect(completed.record.baseBranchSyncExecutionResult?.commitSha).toBe(landCommitSha);
		await expect(
			context.service.reportExecutionResult(context.scope, { ...land, handoffSha256: "f".repeat(64) }),
		).rejects.toThrow("绑定");
	});
	it("开审前已有任务提交且工作区干净时，凭当前 run 证据复用同一 HEAD 完成 land 和 base 同步", async () => {
		const context = await setup("task", false, "run", true);
		await context.complete();
		await context.service.sweepPendingCloseoutsOnce();
		const record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		if (!record?.handoffSha256) throw new Error("缺少交接绑定");
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath: getTaskMessageInjectionLedgerPath(mocked.directory),
			taskId: "task",
			idempotencyKey: record.promptDeliveryIdempotencyKey,
			status: "delivered_and_submit_confirmed",
			nowIso: new Date().toISOString(),
		});
		await context.service.sweepPendingCloseoutsOnce();
		const reviewedCommitSha = context.captured.receipt.worktree_head_commit_sha;
		const baseCommitSha = context.repo.runGit(["rev-parse", "main"]).stdout.trim();
		expect(reviewedCommitSha).not.toBe(baseCommitSha);
		expect(context.repo.runGit(["rev-list", "--count", "main..HEAD"]).stdout.trim()).toBe("1");
		expect(context.repo.runGit(["status", "--porcelain"]).stdout).toBe("");
		const gitDirectory = context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim();
		const evidencePath = join(gitDirectory, "rvf", "evidence", "reviewed-task-candidate-evidence.json");
		await mkdir(dirname(evidencePath), { recursive: true });
		const evidence = {
			subject: {
				head_oid: reviewedCommitSha,
				worktree_realpath: context.repo.repositoryPath,
				git_common_dir_realpath: gitDirectory,
			},
			review: { run_id: "run", protocol_valid: true },
		};
		const land = {
			taskId: "task",
			decisionToken: context.token,
			runId: "run",
			handoffSha256: record.handoffSha256,
			stage: "land" as const,
			outcome: "completed" as const,
			commitSha: reviewedCommitSha,
		};
		await expect(context.service.reportExecutionResult(context.scope, land)).rejects.toThrow();
		const evidenceText = JSON.stringify(evidence);
		await writeFile(evidencePath, evidenceText);
		await writeFile(`${evidencePath}.sha256`, "错误摘要");
		await expect(context.service.reportExecutionResult(context.scope, land)).rejects.toThrow("摘要");
		const invalidEvidenceCandidates = [
			{ ...evidence, review: { ...evidence.review, run_id: "other-run" } },
			{ ...evidence, subject: { ...evidence.subject, head_oid: baseCommitSha } },
			{ ...evidence, subject: { ...evidence.subject, worktree_realpath: context.rvfHome } },
			{ ...evidence, subject: { ...evidence.subject, git_common_dir_realpath: context.rvfHome } },
		];
		for (const invalidEvidence of invalidEvidenceCandidates) {
			const invalidEvidenceText = JSON.stringify(invalidEvidence);
			await writeFile(evidencePath, invalidEvidenceText);
			await writeFile(`${evidencePath}.sha256`, computeRvfTextSha256(invalidEvidenceText));
			await expect(context.service.reportExecutionResult(context.scope, land)).rejects.toThrow("绑定");
		}
		await writeFile(evidencePath, evidenceText);
		await writeFile(`${evidencePath}.sha256`, computeRvfTextSha256(evidenceText));
		const landed = await context.service.reportExecutionResult(context.scope, land);
		expect(landed.record.landExecutionResult).toMatchObject({ outcome: "completed", commitSha: reviewedCommitSha });
		context.repo.runGit(["branch", "--force", "main", reviewedCommitSha]);
		const completed = await context.service.reportExecutionResult(context.scope, {
			...land,
			stage: "base_branch_sync",
			baseRef: "main",
		});
		expect(completed.record.status).toBe("completed");
		expect(completed.record.baseBranchSyncExecutionResult?.commitSha).toBe(reviewedCommitSha);
		expect(context.repo.runGit(["rev-parse", "HEAD"]).stdout.trim()).toBe(reviewedCommitSha);
		expect(context.repo.runGit(["status", "--porcelain"]).stdout).toBe("");
	});
	it("主会话 summary 尚未水合时持久等待，恢复信息后继续而非永久暂停", async () => {
		const context = await setup();
		await context.complete();
		const hydrated = context.manager.listSummaries;
		const summaries = vi.spyOn(context.manager, "listSummaries");
		summaries.mockReturnValue([]);
		await context.service.sweepPendingCloseoutsOnce();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
			status: "restoring_pre_review_conversation",
			waitingReasonCode: "main_conversation_session_summary_unavailable",
			waitingSince: expect.any(Number),
			pauseReason: null,
		});
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		summaries.mockImplementation(hydrated);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
			status: "submitting_closeout_prompt",
			waitingReasonCode: "closeout_delivery_confirmation_pending",
		});
	});
	it("未确认自动注册的运行只进入人工交接，不执行原生恢复", async () => {
		const context = await setup();
		await context.complete();
		await writeFile(
			join(context.run, "artifacts", "automatic-closeout-registration.json"),
			JSON.stringify({
				run_id: "run",
				decision_token: context.token,
				status: "disabled",
			}),
		);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
			status: "paused",
			pauseReason: expect.stringContaining("人工收尾"),
		});
	});
	it("同一等待原因超过 30 秒只通知一次，重启不重置等待时刻或重复通知", async () => {
		const context = await setup();
		await context.complete();
		vi.spyOn(context.manager, "listSummaries").mockReturnValue([]);
		const started = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(started);
		try {
			await context.service.sweepPendingCloseoutsOnce();
			clock.mockReturnValue(started + 29_999);
			await context.service.sweepPendingCloseoutsOnce();
			expect(context.manager.publishRvfAutomaticCloseoutWaiting).not.toHaveBeenCalled();
			clock.mockReturnValue(started + 30_000);
			await context.service.sweepPendingCloseoutsOnce();
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect(context.manager.publishRvfAutomaticCloseoutWaiting).toHaveBeenCalledOnce();
			expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.waitingSince).toBe(
				started,
			);
		} finally {
			clock.mockRestore();
		}
	});
	it("首条独立开审消息不因缺少可选自动恢复前缀而被阻断", async () => {
		const context = await setup("task", true);
		expect(
			await context.service.activateAfterRunBinding(context.scope, { taskId: "task", decisionToken: context.token }),
		).toMatchObject({
			receipt: context.captured.receipt,
			automaticCloseoutActivationStatus: "skipped_no_completed_pre_review_conversation_prefix",
		});
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	});

	it("每次查询读取当前原生分支并回显新 nonce；重启不复用旧观测", async () => {
		const context = await setup();
		const summary = context.manager.getSummary();
		summary.runtimeSessionIncarnationId = "11111111-2222-4333-8444-555555555555";
		summary.codexNativeSessionControlEndpoint = {
			socketPath: "/isolated/current-session/s",
			workspaceId: context.scope.workspaceId,
			conversationSessionId: summary.taskId,
			runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
		};
		const request = {
			taskId: "task",
			idempotencyKey: `rvf-decision-point-${context.token}`,
			requestNonce: "nonce-one",
		};
		const original = mocked.request.getMockImplementation();
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) =>
			method === "thread/loaded/list" ? { data: ["native"], nextCursor: null } : original?.(method, parameters),
		);
		const first = await context.service.observeBoundary(context.scope, request);
		expect(first.review_start_boundary_active_branch_observation).toMatchObject({
			request_nonce: "nonce-one",
			native_active_branch_user_message_ids: ["boundary-message"],
			native_active_branch_user_turn_id: "boundary",
		});
		context.source.pop();
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		const second = await restarted.observeBoundary(context.scope, { ...request, requestNonce: "nonce-two" });
		expect(second.review_start_boundary_active_branch_observation).toMatchObject({
			request_nonce: "nonce-two",
			native_active_branch_user_message_ids: [],
			native_active_branch_user_turn_id: "",
		});
		mocked.request.mockImplementation(async () => ({ data: [], nextCursor: null }));
		const missing = await restarted.observeBoundary(context.scope, { ...request, requestNonce: "nonce-three" });
		expect(missing.review_start_boundary_active_branch_observation).toBeUndefined();
		expect(missing.review_start_boundary_pending_reason).toContain("尚未确认");
	});

	it("只查询当前 incarnation 的专属端点，跨 task 或陈旧端点均等待", async () => {
		const context = await setup();
		const summary = context.manager.getSummary();
		const incarnation = "11111111-2222-4333-8444-555555555555";
		summary.runtimeSessionIncarnationId = incarnation;
		summary.codexNativeSessionControlEndpoint = {
			socketPath: "/isolated/current-session/s",
			workspaceId: context.scope.workspaceId,
			conversationSessionId: summary.taskId,
			runtimeSessionIncarnationId: incarnation,
		};
		const original = mocked.request.getMockImplementation();
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) =>
			method === "thread/loaded/list" ? { data: ["native"], nextCursor: null } : original?.(method, parameters),
		);
		const request = {
			taskId: "task",
			idempotencyKey: `rvf-decision-point-${context.token}`,
			requestNonce: "current-nonce",
		};
		const accepted = await context.service.observeBoundary(context.scope, request);
		expect(accepted.review_start_boundary_active_branch_observation?.request_nonce).toBe("current-nonce");
		expect(mocked.controlEndpoint).toHaveBeenLastCalledWith({
			socketPath: "/isolated/current-session/s",
			onDiagnostic: expect.any(Function),
		});
		for (const invalidEndpoint of [
			{ ...summary.codexNativeSessionControlEndpoint, workspaceId: "another-workspace" },
			{ ...summary.codexNativeSessionControlEndpoint, conversationSessionId: "another-session" },
			{ ...summary.codexNativeSessionControlEndpoint, runtimeSessionIncarnationId: "stale-incarnation" },
			null,
			undefined,
		]) {
			summary.codexNativeSessionControlEndpoint = invalidEndpoint;
			mocked.controlEndpoint.mockClear();
			const rejected = await context.service.observeBoundary(context.scope, request);
			expect(rejected.review_start_boundary_active_branch_observation).toBeUndefined();
			expect(rejected.review_start_boundary_pending_reason).toContain("本代会话");
			expect(mocked.controlEndpoint).not.toHaveBeenCalled();
		}
	});

	it.each([
		"socket_path",
		"endpoint_workspace",
		"endpoint_conversation",
		"incarnation",
		"transcript_path",
		"native_session",
		"started_at",
		"workspace_path",
	])("观测中 %s 改变（含原地修改）时不返回成功观测", async (replacement) => {
		const context = await setup();
		const summary = context.manager.getSummary();
		summary.runtimeSessionIncarnationId = "11111111-2222-4333-8444-555555555555";
		summary.codexNativeSessionControlEndpoint = {
			socketPath: "/isolated/current-session/s",
			workspaceId: context.scope.workspaceId,
			conversationSessionId: summary.taskId,
			runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
		};
		const original = mocked.request.getMockImplementation();
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/loaded/list") return { data: ["native"], nextCursor: null };
			const response = await original?.(method, parameters);
			if (method === "thread/turns/list") {
				const endpoint = summary.codexNativeSessionControlEndpoint;
				const identity = summary.agentNativeConversationSessionIdentity;
				if (replacement === "socket_path" && endpoint) endpoint.socketPath = "/isolated/replacement/s";
				if (replacement === "endpoint_workspace" && endpoint) endpoint.workspaceId = "replacement";
				if (replacement === "endpoint_conversation" && endpoint) endpoint.conversationSessionId = "replacement";
				if (replacement === "incarnation") summary.runtimeSessionIncarnationId = "replacement";
				if (replacement === "transcript_path" && identity) identity.transcriptPath = "/replacement.jsonl";
				if (replacement === "native_session" && identity) identity.nativeSessionId = "replacement";
				if (replacement === "started_at") summary.startedAt = 2;
				if (replacement === "workspace_path") summary.workspacePath = "/replacement";
			}
			return response;
		});
		const response = await context.service.observeBoundary(context.scope, {
			taskId: "task",
			idempotencyKey: `rvf-decision-point-${context.token}`,
			requestNonce: `replacement-${replacement}`,
		});
		expect(response.review_start_boundary_active_branch_observation).toBeUndefined();
		expect(response.reason_code).toBe("review_start_boundary_binding_invalidated");
		expect(response.recovery_action).toBe("request_new_boundary_after_turn_completion");
	});

	it("捕获默认仅保存非活跃分界，重启和重试不重捕获或扫描完成事实", async () => {
		const context = await setup();
		const captured = (await context.service.status(context.scope, { taskId: "task" })).records[0];
		expect(captured?.status).toBe("captured_review_start_boundary");
		const requestCount = mocked.request.mock.calls.length;
		context.source.push({ id: "bootstrap-followup", status: "completed", items: [] });
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		expect(await restarted.capture(context.scope, { taskId: "task", decisionToken: context.token })).toEqual({
			status: "captured",
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
		expect(await restarted.capture(context.scope, input)).toEqual({ status: "captured", ...context.captured });
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
				initiated_by_explicit_user_request: false,
				candidate_summary: { kanban_task_id: "task", candidates: [] },
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
		const rejectedCapture = expect(capture).resolves.toMatchObject({
			status: "pending",
			reason_code: "review_start_boundary_host_session_unavailable",
		});
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
		const closeoutText = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls[0]?.[1].text;
		expect(closeoutText).toContain("$rvf-land");
		expect(closeoutText).toContain("默认继续使用 $base-branch-sync");
		expect(closeoutText).toContain("agent_assessed_not_ready_for_base_sync");
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
					initiated_by_explicit_user_request: false,
					candidate_summary: { kanban_task_id: "task", candidates: [] },
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
	it.each(["same_turn", "expired", "withdrawn"])("已知捕获失败 %s 返回可恢复诊断，且不写正式记录", async (kind) => {
		const context = await setup();
		const token = "fedcba9876543210";
		const original = JSON.parse(
			await readFile(join(context.rvfHome, "agentic-initiation-decision-tokens", `${context.token}.json`), "utf8"),
		);
		await writeFile(
			join(context.rvfHome, "agentic-initiation-decision-tokens", `${token}.json`),
			JSON.stringify({
				...original,
				token,
				state: kind === "withdrawn" ? "withdrawn" : "injected",
				expires_at: kind === "expired" ? new Date(0).toISOString() : new Date(Date.now() + 60000).toISOString(),
			}),
		);
		if (kind === "same_turn")
			context.source.at(-1)?.items.push({
				id: "extra-message",
				type: "userMessage",
				content: [{ type: "input_text", text: "同回合附加消息" }],
			});
		expect(await context.service.capture(context.scope, { taskId: "task", decisionToken: token })).toMatchObject({
			status: "invalidated",
			reason_code:
				kind === "expired"
					? "review_start_boundary_token_expired"
					: kind === "same_turn"
						? "native_independent_user_turn_contains_multiple_messages"
						: "review_start_boundary_binding_invalidated",
			recovery_action: "request_new_boundary_after_turn_completion",
		});
		expect((await context.service.status(context.scope, { taskId: "task" })).records).toHaveLength(1);
	});
});

function createExecutionResultInterleavingSignal() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function setupLateNativeCloseoutPromptAcceptance(mainConversationSessionId = "task") {
	const context = await setup(mainConversationSessionId);
	await context.complete();
	await context.service.sweepPendingCloseoutsOnce();
	let record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
	if (!record?.handoffSha256) throw new Error("缺少收尾绑定");
	const ledgerPath = getTaskMessageInjectionLedgerPath(mocked.directory);
	const epoch = Date.now() - 180_000;
	const iso = (offset: number) => new Date(epoch + offset).toISOString();
	await recordTaskMessageTerminalDeliveryOutcome({
		ledgerPath,
		taskId: mainConversationSessionId,
		idempotencyKey: record.promptDeliveryIdempotencyKey,
		status: "delivery_failed",
		failureReason: "submit_confirmation_budget_exhausted",
		nowIso: iso(16_419),
	});
	await withTaskMessageInjectionLedgerLock(ledgerPath, async (records) => ({
		records: records.map((entry) =>
			entry.idempotency_key === record?.promptDeliveryIdempotencyKey
				? {
						...entry,
						created_at: iso(0),
						agent_idle_gate_passed_at: iso(31),
					}
				: entry,
		),
		result: undefined,
	}));
	await context.service.sweepPendingCloseoutsOnce();
	const transcriptPath = join(context.fixture.fixtureRootDirectoryPath, "restored-closeout-native-evidence.jsonl");
	await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), (records) => ({
		records: records.map((entry) => ({ ...entry, restoredTranscriptPath: transcriptPath })),
		value: undefined,
	}));
	record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
	if (!record?.handoffSha256) throw new Error("缺少暂停绑定");
	const summary = context.manager.getSummary();
	Object.assign(summary, {
		runtimeSessionIncarnationId: "restored-incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "restored",
			transcriptPath,
			observedAt: Date.now(),
		},
		codexNativeSessionControlEndpoint: {
			workspaceId: context.scope.workspaceId,
			conversationSessionId: mainConversationSessionId,
			runtimeSessionIncarnationId: "restored-incarnation",
			socketPath: "/isolated-restored-native-control",
		},
	});
	const text = buildRvfAutomaticCloseoutPrompt(record);
	async function writeNativeEvidence(
		options: {
			text?: string;
			includeMessage?: boolean;
			duplicate?: boolean;
			metadataSessionId?: string;
			nativeMessageRecordedAtMs?: number;
			skillAttachment?: { name: string; path: string; body: string };
			skillExpansionMetadata?: unknown;
		} = {},
	) {
		const nativeMessage = {
			type: "event_msg",
			timestamp: iso(options.nativeMessageRecordedAtMs ?? 121_575),
			payload: {
				type: "item_completed",
				turn_id: "closeout-user-turn",
				item: {
					type: "UserMessage",
					id: "closeout-native-user-message",
					content: [
						{ type: "text", text: options.text ?? text },
						...(options.skillAttachment
							? [{ type: "skill", name: options.skillAttachment.name, path: options.skillAttachment.path }]
							: []),
					],
				},
			},
		};
		const lines = [
			{
				type: "session_meta",
				timestamp: iso(-1000),
				payload: {
					id: options.metadataSessionId ?? "restored",
					originator: "codex-tui",
					source: "vscode",
					cli_version: "0.164.0",
					cwd: context.repo.repositoryPath,
				},
			},
			{
				type: "event_msg",
				timestamp: iso(1366),
				payload: {
					type: "task_started",
					turn_id: "closeout-user-turn",
					turn_attribution: { turn_trigger: "user" },
				},
			},
			{ type: "compacted", timestamp: iso(120_800), payload: { message: "隔离的压缩摘要" } },
			{
				type: "event_msg",
				timestamp: iso(120_813),
				payload: {
					type: "item_completed",
					turn_id: "closeout-user-turn",
					item: { type: "ContextCompaction", id: "compaction" },
				},
			},
			...(options.includeMessage === false ? [] : [nativeMessage]),
			...(options.skillAttachment
				? [
						{
							type: "response_item",
							timestamp: iso((options.nativeMessageRecordedAtMs ?? 121_575) + 2),
							payload: {
								type: "message",
								role: "user",
								content: [
									{
										type: "input_text",
										text: `<skill>\n<name>${options.skillAttachment.name}</name>\n<path>${options.skillAttachment.path}</path>\n${options.skillAttachment.body}\n</skill>`,
									},
								],
								internal_chat_message_metadata_passthrough:
									options.skillExpansionMetadata === undefined
										? {
												turn_id: "closeout-user-turn",
												content_item_kinds: ["skills.selected_skill_instructions"],
												content_item_metadata: [{ provenance: { type: "skills" } }],
											}
										: options.skillExpansionMetadata,
							},
						},
					]
				: []),
			...(options.duplicate ? [nativeMessage] : []),
		];
		await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	}
	await writeNativeEvidence();
	const activeTurns: CodexNativeConversationTurn[] = [
		{ id: "implementation", status: "completed", items: [] },
		{
			id: "closeout-user-turn",
			status: "completed",
			items: [{ id: "closeout-native-user-message", type: "userMessage", content: [{ type: "text", text }] }],
		},
	];
	mocked.request.mockImplementation(async (method: string) =>
		method === "thread/loaded/list"
			? { data: ["restored"], nextCursor: null }
			: { data: activeTurns, nextCursor: null },
	);
	const request = {
		taskId: "task",
		decisionToken: context.token,
		runId: "run",
		handoffSha256: record.handoffSha256,
		dryRun: false,
	};
	return { ...context, record, request, ledgerPath, transcriptPath, activeTurns, writeNativeEvidence };
}

async function setupLateNativeCloseoutWithSkillAttachment() {
	const context = await setupLateNativeCloseoutPromptAcceptance();
	const skillDirectory = join(context.fixture.fixtureRootDirectoryPath, "installed-closeout-skill");
	await mkdir(skillDirectory);
	const skill = {
		name: "base-branch-sync",
		path: join(skillDirectory, "SKILL.md"),
		body: "核对本地 base 的隔离手册。\n",
	};
	await writeFile(skill.path, skill.body);
	await context.writeNativeEvidence({ skillAttachment: skill });
	const reference = { type: "skill", name: skill.name, path: skill.path };
	const message = context.activeTurns[1]?.items[0];
	if (!message?.content) throw new Error("缺少隔离的原生消息");
	message.content.push(reference);
	const catalogEntry = {
		cwd: context.repo.repositoryPath,
		skills: [{ name: skill.name, path: skill.path, enabled: true }],
		errors: [],
	};
	const previousRequest = mocked.request.getMockImplementation();
	mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) =>
		method === "skills/list" ? { data: [catalogEntry] } : previousRequest?.(method, parameters),
	);
	return { ...context, skill, message, reference, catalogEntry };
}

describe("RVF 迟到原生收尾接受补证与暂停结果报告", () => {
	it("合法 Skill 附件可自动补证，dry-run 与重建幂等且原失败、正文和投递次数不变", async () => {
		const context = await setupLateNativeCloseoutWithSkillAttachment();
		const ledgerBefore = await readFile(context.ledgerPath);
		const transcriptBefore = await readFile(context.transcriptPath);
		const storeBefore = await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId));
		const enqueueCount = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
		expect(
			await context.service.reconcileLateNativePromptAcceptance(context.scope, { ...context.request, dryRun: true }),
		).toMatchObject({ status: "eligible" });
		expect(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId))).toEqual(storeBefore);
		await context.service.sweepPendingCloseoutsOnce();
		const recovered = await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request);
		expect(recovered).toMatchObject({
			status: "already_recovered",
			receipt: { originalDeliveryFailure: { status: "delivery_failed" } },
		});
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		expect(await restarted.reconcileLateNativePromptAcceptance(context.scope, context.request)).toEqual(recovered);
		expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
		expect(await readFile(context.transcriptPath)).toEqual(transcriptBefore);
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(enqueueCount);
	});
	it.each(["错回合", "普通用户来源", "无可信归属"])(
		"Skill 展开为 %s 时保持 unknown，暂停和原失败账本不变",
		async (scenario) => {
			const context = await setupLateNativeCloseoutWithSkillAttachment();
			await context.writeNativeEvidence({
				skillAttachment: context.skill,
				skillExpansionMetadata:
					scenario === "无可信归属"
						? null
						: {
								turn_id: scenario === "错回合" ? "another-user-turn" : "closeout-user-turn",
								content_item_kinds: [
									scenario === "普通用户来源" ? "user.text" : "skills.selected_skill_instructions",
								],
								content_item_metadata: [
									{ provenance: { type: scenario === "普通用户来源" ? "user" : "skills" } },
								],
							},
			});
			const storePath = getRvfAutomaticCloseoutStorePath(context.scope.workspaceId);
			const storeBefore = await readFile(storePath);
			const ledgerBefore = await readFile(context.ledgerPath);
			mocked.request.mockClear();
			expect(
				await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request),
			).toMatchObject({
				status: "unknown",
				reasonCode: "native_prompt_acceptance_not_proven",
			});
			expect(await readFile(storePath)).toEqual(storeBefore);
			expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
			expect(mocked.request).not.toHaveBeenCalled();
		},
	);
	it.each([
		"attachment_removed",
		"attachment_changed",
		"unknown_attachment",
		"duplicate_with_unknown_attachment",
	] as const)("活动分支 %s 时拒绝恢复，不能只修转录 reader", async (scenario) => {
		const context = await setupLateNativeCloseoutWithSkillAttachment();
		if (!context.message.content) throw new Error("缺少消息正文");
		if (scenario === "attachment_removed") context.message.content.pop();
		if (scenario === "attachment_changed") context.reference.path = "/unrelated/SKILL.md";
		if (scenario === "unknown_attachment") context.message.content.push({ type: "unknown_future_attachment" });
		if (scenario === "duplicate_with_unknown_attachment")
			context.activeTurns.push({
				id: "another-turn",
				status: "completed",
				items: [
					{ ...context.message, id: "another-message", content: [...context.message.content, { type: "image" }] },
				],
			});
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "blocked",
			reasonCode: "native_message_not_on_active_branch",
		});
	});
	it.each(["stop", "identity_changed", "installation_changed"] as const)(
		"Skill 核验中 %s 仍阻止旧回调写入恢复凭据",
		async (scenario) => {
			const context = await setupLateNativeCloseoutWithSkillAttachment();
			const independentStopper = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			const originalRequest = mocked.request.getMockImplementation();
			mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
				if (method === "thread/turns/list") {
					if (scenario === "stop")
						await independentStopper.pauseForExplicitStop(context.scope.workspaceId, "task");
					if (scenario === "identity_changed")
						context.manager.getSummary().runtimeSessionIncarnationId = "another-incarnation";
					if (scenario === "installation_changed") await writeFile(context.skill.path, "变更后的手册");
				}
				return originalRequest?.(method, parameters);
			});
			expect(
				await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request),
			).toMatchObject({
				status: scenario === "installation_changed" ? "unknown" : "blocked",
				reasonCode:
					scenario === "stop"
						? "record_changed"
						: scenario === "identity_changed"
							? "session_binding_changed"
							: "native_prompt_acceptance_not_proven",
			});
			if (scenario === "stop") {
				const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
				expect(await restarted.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
					status: "blocked",
					reasonCode: "explicit_stop",
				});
			}
		},
	);
	it("自动补证对未知证据退避并限次，新转录证据到达后重新核验", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		const originalRequest = mocked.request.getMockImplementation();
		mocked.request.mockRejectedValue(new Error("原生控制面暂不可读"));
		mocked.request.mockClear();
		const ledgerBefore = await readFile(context.ledgerPath);
		const observedAt = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(observedAt);
		try {
			await context.service.status(context.scope, { taskId: "task" });
			const callsPerAttempt = mocked.request.mock.calls.length;
			expect(callsPerAttempt).toBeGreaterThan(0);
			await context.service.status(context.scope, { taskId: "task" });
			expect(mocked.request).toHaveBeenCalledTimes(callsPerAttempt);
			for (const offset of [16_000, 32_000, 48_000]) {
				clock.mockReturnValue(observedAt + offset);
				await context.service.status(context.scope, { taskId: "task" });
			}
			expect(mocked.request).toHaveBeenCalledTimes(callsPerAttempt * 3);
			if (!originalRequest) throw new Error("缺少原生控制面测试适配器。");
			mocked.request.mockImplementation(originalRequest);
			await context.writeNativeEvidence({ nativeMessageRecordedAtMs: 121_576 });
			const state = await context.service.status(context.scope, { taskId: "task" });
			expect(state.records[0]?.status).toBe("closeout_prompt_submitted");
			expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
		} finally {
			clock.mockRestore();
		}
	});

	it.each(["liveness", "prompt_acceptance", "control_endpoint", "record_updated_at"] as const)(
		"%s 的无关变化不重置同转录的十五秒退避与三次预算",
		async (changedObservation) => {
			const context = await setupLateNativeCloseoutPromptAcceptance();
			mocked.request.mockRejectedValue(new Error("原生控制面暂不可读"));
			mocked.request.mockClear();
			const ledgerBefore = await readFile(context.ledgerPath);
			const transcriptBefore = await readFile(context.transcriptPath);
			const enqueueCount = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
			const observedAt = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(observedAt);
			try {
				await context.service.status(context.scope, { taskId: "task" });
				const callsPerAttempt = mocked.request.mock.calls.length;
				expect(callsPerAttempt).toBeGreaterThan(0);
				let observationSequence = 0;
				for (const [offset, maximumAttempts] of [
					[1, 1],
					[14_999, 1],
					[15_000, 2],
					[29_999, 2],
					[30_000, 3],
					[45_000, 3],
					[60_000, 3],
				]) {
					clock.mockReturnValue(observedAt + offset);
					observationSequence += 1;
					const summary = context.manager.getSummary();
					if (changedObservation === "liveness") {
						Object.assign(summary, { turnOwner: "user", liveness: "retrying", userTurnKind: "review" });
						await context.service.status(context.scope, { taskId: "task" });
						Object.assign(summary, { turnOwner: "user", liveness: "live", userTurnKind: "review" });
					} else if (changedObservation === "prompt_acceptance") {
						summary.agentConversationPromptSubmissionAcceptance = {
							status: observationSequence % 2 ? "pending" : "accepted",
							attemptedAtMs: observedAt + observationSequence,
							runtimeSessionIncarnationId: "restored-incarnation",
						};
					} else if (changedObservation === "control_endpoint") {
						const endpoint = summary.codexNativeSessionControlEndpoint;
						if (!endpoint) throw new Error("缺少本代原生控制端点。");
						summary.codexNativeSessionControlEndpoint = {
							...endpoint,
							socketPath: `/isolated-restored-native-control-${observationSequence}`,
						};
					} else {
						await updateRvfAutomaticCloseoutRecords(
							getRvfAutomaticCloseoutStorePath(context.scope.workspaceId),
							(records) => ({
								records: records.map((entry) => ({ ...entry, updatedAt: observedAt + observationSequence })),
								value: undefined,
							}),
						);
					}
					const state = await context.service.status(context.scope, { taskId: "task" });
					expect(state.records[0]?.status).toBe("paused");
					expect(mocked.request.mock.calls.length).toBeLessThanOrEqual(callsPerAttempt * maximumAttempts);
				}
				expect(await readFile(context.transcriptPath)).toEqual(transcriptBefore);
				expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
				expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(
					enqueueCount,
				);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.each(["runtime_incarnation", "process_start", "service_restart"] as const)(
		"%s 在相同转录已耗尽自动补证预算后仍可恢复",
		async (changedGeneration) => {
			const context = await setupLateNativeCloseoutPromptAcceptance();
			const originalRequest = mocked.request.getMockImplementation();
			mocked.request.mockRejectedValue(new Error("原生控制面暂不可读"));
			mocked.request.mockClear();
			const ledgerBefore = await readFile(context.ledgerPath);
			const transcriptBefore = await readFile(context.transcriptPath);
			const enqueueCount = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
			const observedAt = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(observedAt);
			try {
				await context.service.status(context.scope, { taskId: "task" });
				const callsPerAttempt = mocked.request.mock.calls.length;
				expect(callsPerAttempt).toBeGreaterThan(0);
				for (const offset of [15_000, 30_000, 45_000]) {
					clock.mockReturnValue(observedAt + offset);
					await context.service.status(context.scope, { taskId: "task" });
				}
				expect(mocked.request).toHaveBeenCalledTimes(callsPerAttempt * 3);
				if (!originalRequest) throw new Error("缺少原生控制面测试适配器。");
				mocked.request.mockImplementation(originalRequest);
				const summary = context.manager.getSummary();
				if (changedGeneration === "runtime_incarnation") {
					const endpoint = summary.codexNativeSessionControlEndpoint;
					if (!endpoint) throw new Error("缺少本代原生控制端点。");
					summary.runtimeSessionIncarnationId = "replacement-incarnation";
					summary.codexNativeSessionControlEndpoint = {
						...endpoint,
						runtimeSessionIncarnationId: "replacement-incarnation",
					};
				} else if (changedGeneration === "process_start") {
					summary.startedAt = (summary.startedAt ?? 0) + 1;
				}
				const service =
					changedGeneration === "service_restart"
						? createRvfAutomaticCloseoutRuntimeService(context.dependencies)
						: context.service;
				const state = await service.status(context.scope, { taskId: "task" });
				expect(state.records[0]?.status).toBe("closeout_prompt_submitted");
				expect(await readFile(context.transcriptPath)).toEqual(transcriptBefore);
				expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
				expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(
					enqueueCount,
				);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("补证期间的内部状态查询读取快照，不重入自己持有的 workspace 队列", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		const originalRequest = mocked.request.getMockImplementation();
		let readDuringVerification = false;
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/loaded/list" && !readDuringVerification) {
				readDuringVerification = true;
				expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe("paused");
			}
			return originalRequest?.(method, parameters);
		});
		await context.service.sweepPendingCloseoutsOnce();
		expect(readDuringVerification).toBe(true);
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe(
			"closeout_prompt_submitted",
		);
	});

	it.each(["background_sweep", "status_query", "service_restart"] as const)(
		"%s 自动补证真实迟到接受，保留失败账本且不重新投递",
		async (trigger) => {
			const context = await setupLateNativeCloseoutPromptAcceptance();
			const ledgerBefore = await readFile(context.ledgerPath);
			const enqueueCount = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
			const service =
				trigger === "service_restart"
					? createRvfAutomaticCloseoutRuntimeService(context.dependencies)
					: context.service;
			if (trigger === "status_query") await service.status(context.scope, { taskId: "task" });
			else await service.sweepPendingCloseoutsOnce();
			const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
			const records = Array.isArray(saved) ? saved : saved.records;
			expect(records[0]).toMatchObject({
				status: "closeout_prompt_submitted",
				lateNativePromptAcceptanceRecoveryReceipt: {
					originalDeliveryFailure: { status: "delivery_failed" },
				},
			});
			expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(
				enqueueCount,
			);
		},
	);

	it("跨 service 单飞；恢复后停止的持久标记不能被服务重建或旧凭据绕过", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		const anotherService = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		const originalRequest = mocked.request.getMockImplementation();
		let checkedBusy = false;
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/loaded/list" && !checkedBusy) {
				checkedBusy = true;
				expect(
					await anotherService.reconcileLateNativePromptAcceptance(context.scope, context.request),
				).toMatchObject({
					status: "unknown",
					reasonCode: "record_operation_busy",
				});
			}
			return originalRequest?.(method, parameters);
		});
		expect((await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).status).toBe(
			"recovered",
		);
		await anotherService.pauseForExplicitStop(context.scope.workspaceId, "task");
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		expect(await restarted.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "blocked",
			reasonCode: "explicit_stop",
		});
	});
	it("核验期间原地修改原生身份也会拒绝，不能被共享 summary 对象掩盖", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		const originalRequest = mocked.request.getMockImplementation();
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/turns/list") {
				const identity = context.manager.getSummary().agentNativeConversationSessionIdentity;
				if (identity) identity.nativeSessionId = "different-native";
			}
			return originalRequest?.(method, parameters);
		});
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "blocked",
			reasonCode: "session_binding_changed",
		});
	});
	it("公开诊断不摘录损坏 JSON 中的私密正文；旧补证在活动分支撤回后不能登记 completed", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		const bytes = await readFile(context.transcriptPath, "utf8");
		await writeFile(context.transcriptPath, `${bytes}{"secret":"PRIVATE_TRANSCRIPT_SENTINEL`);
		const invalid = await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request);
		expect(invalid.status).toBe("unknown");
		expect(JSON.stringify(invalid)).not.toContain("PRIVATE_TRANSCRIPT_SENTINEL");
		await writeFile(context.transcriptPath, bytes);
		expect((await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).status).toBe(
			"recovered",
		);
		context.activeTurns.splice(1);
		await expect(
			context.service.reportExecutionResult(context.scope, {
				...context.request,
				stage: "land",
				outcome: "completed",
				commitSha: context.captured.receipt.worktree_head_commit_sha,
			}),
		).rejects.toThrow("活动分支");
	});
	it("先开回合、超时、压缩后正文落盘：只追加补证，原失败与 Git/WIP 不变，重启重试幂等", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance("independent-main");
		const ledgerBefore = await readFile(context.ledgerPath);
		const sourceBefore = await readFile(context.transcriptPath);
		const statusBefore = context.repo.runGit(["status", "--porcelain=v2"]).stdout;
		const storePath = getRvfAutomaticCloseoutStorePath(context.scope.workspaceId);
		const recordBefore = await readFile(storePath);
		const enqueueCount = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
		const forkCount = mocked.request.mock.calls.filter((call) => call[0] === "thread/fork").length;
		const dry = await context.service.reconcileLateNativePromptAcceptance(context.scope, {
			...context.request,
			dryRun: true,
		});
		expect(dry.status).toBe("eligible");
		expect(await readFile(storePath)).toEqual(recordBefore);
		const recovered = await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request);
		expect(recovered.status).toBe("recovered");
		if (recovered.status !== "recovered") throw new Error(JSON.stringify(recovered));
		expect(recovered.record.status).toBe("closeout_prompt_submitted");
		expect(recovered.receipt.previousPauseReason).toBe(context.record.pauseReason);
		expect(Date.parse(recovered.receipt.nativeTurnStartedAt)).toBeLessThan(
			Date.parse(recovered.receipt.originalDeliveryFailure.statusUpdatedAt),
		);
		expect(Date.parse(recovered.receipt.nativeUserMessageRecordedAt)).toBeGreaterThan(
			Date.parse(recovered.receipt.originalDeliveryFailure.statusUpdatedAt),
		);
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		const again = await restarted.reconcileLateNativePromptAcceptance(context.scope, context.request);
		expect(again).toMatchObject({
			status: "already_recovered",
			receipt: recovered.receipt,
			record: recovered.record,
		});
		await restarted.sweepPendingCloseoutsOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(enqueueCount);
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(forkCount);
		expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
		expect(await readFile(context.transcriptPath)).toEqual(sourceBefore);
		expect(context.repo.runGit(["status", "--porcelain=v2"]).stdout).toBe(statusBefore);
	});
	it.each(["land", "base_branch_sync"] as const)(
		"paused 保存 %s 受阻历史；completed 请求自动补证后仍须真实阶段证据",
		async (stage) => {
			const context = await setupLateNativeCloseoutPromptAcceptance();
			const report = { ...context.request, stage, outcome: "blocked" as const, reason: "确认预算耗尽，尚未执行" };
			const first = await context.service.reportExecutionResult(context.scope, report);
			expect(first.record.status).toBe("paused");
			expect(first.record.pauseReason).toBe(context.record.pauseReason);
			expect(first.record.executionResultReportHistory).toHaveLength(1);
			expect((await context.service.reportExecutionResult(context.scope, report)).record).toEqual(first.record);
			const failed = await context.service.reportExecutionResult(context.scope, {
				...report,
				outcome: "failed",
				reason: "实际检查失败",
			});
			expect(failed.record.executionResultReportHistory?.map((entry) => entry.outcome)).toEqual([
				"blocked",
				"failed",
			]);
			expect((await context.service.reportExecutionResult(context.scope, report)).record).toEqual(failed.record);
			await expect(
				context.service.reportExecutionResult(context.scope, { ...report, handoffSha256: "f".repeat(64) }),
			).rejects.toThrow("绑定");
			await expect(
				context.service.reportExecutionResult(context.scope, {
					...report,
					outcome: "completed",
					commitSha: context.captured.receipt.worktree_head_commit_sha,
					...(stage === "base_branch_sync" ? { baseRef: "main" } : {}),
				}),
			).rejects.toThrow(stage === "land" ? "reviewed-task-candidate-evidence.json" : "尚未确认 land 成功");
			const after = (await context.service.status(context.scope, { taskId: "task" })).records[0];
			expect(after?.status).toBe("closeout_prompt_submitted");
			expect(after?.executionResultReportHistory?.map((entry) => entry.outcome)).toEqual(["blocked", "failed"]);
		},
	);
	it.each([
		{ name: "只有 task_started 与 compaction", options: { includeMessage: false } },
		{ name: "正文不符", options: { text: "其他用户消息" } },
		{ name: "重复正文", options: { duplicate: true } },
		{ name: "原生元数据身份不符", options: { metadataSessionId: "different" } },
	])("$name 保持 unknown，不产生补证或重投", async ({ options }) => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.writeNativeEvidence(options);
		const before = await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId));
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "unknown",
			reasonCode: "native_prompt_acceptance_not_proven",
		});
		expect(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId))).toEqual(before);
		await context.service.sweepPendingCloseoutsOnce();
		expect(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId))).toEqual(before);
	});
	it("实时分支已回退、无控制面或缺页均不复活历史记录", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		context.activeTurns.splice(1);
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "blocked",
			reasonCode: "native_message_not_on_active_branch",
		});
		context.manager.getSummary().codexNativeSessionControlEndpoint = undefined;
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "unknown",
			reasonCode: "native_control_unavailable",
		});
	});
	it("核验中与核验后的显式停止均持久生效，新 service 不能凭旧补证恢复", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		const independentStopper = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		const originalRequest = mocked.request.getMockImplementation();
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/loaded/list")
				await independentStopper.pauseForExplicitStop(context.scope.workspaceId, "task");
			return originalRequest?.(method, parameters);
		});
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "blocked",
		});
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		expect(await restarted.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "blocked",
			reasonCode: "explicit_stop",
		});
	});
	it("恢复后 completed 仍逐项校验真实 evidence 与本地 base 祖先，保存早先 blocked 历史", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.service.reportExecutionResult(context.scope, {
			...context.request,
			stage: "land",
			outcome: "blocked",
			reason: "等待补证",
		});
		expect((await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).status).toBe(
			"recovered",
		);
		const commitSha = context.captured.receipt.worktree_head_commit_sha;
		const land = { ...context.request, stage: "land" as const, outcome: "completed" as const, commitSha };
		await expect(context.service.reportExecutionResult(context.scope, land)).rejects.toThrow();
		const gitDirectory = context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim();
		const evidencePath = join(gitDirectory, "rvf", "evidence", "reviewed-task-candidate-evidence.json");
		const evidence = JSON.stringify({
			subject: {
				head_oid: commitSha,
				worktree_realpath: context.repo.repositoryPath,
				git_common_dir_realpath: gitDirectory,
			},
			review: { run_id: "run", protocol_valid: true },
		});
		await mkdir(dirname(evidencePath), { recursive: true });
		await writeFile(evidencePath, evidence);
		await writeFile(`${evidencePath}.sha256`, "错误摘要");
		await expect(context.service.reportExecutionResult(context.scope, land)).rejects.toThrow("摘要");
		await writeFile(`${evidencePath}.sha256`, computeRvfTextSha256(evidence));
		await context.service.reportExecutionResult(context.scope, land);
		const base = { ...land, stage: "base_branch_sync" as const, baseRef: "main" };
		await expect(context.service.reportExecutionResult(context.scope, { ...base, baseRef: "other" })).rejects.toThrow(
			"base ref",
		);
		const completed = await context.service.reportExecutionResult(context.scope, base);
		expect(completed.record.status).toBe("completed");
		expect(completed.record.executionResultReportHistory?.map((entry) => entry.outcome)).toEqual([
			"blocked",
			"completed",
			"completed",
		]);
		expect((await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).status).toBe(
			"already_recovered",
		);
	});
	it("核验分页循环、端点换代、绑定错误和 handoff 改字节都保持拒绝", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		expect(
			await context.service.reconcileLateNativePromptAcceptance(context.scope, {
				...context.request,
				runId: "wrong",
			}),
		).toMatchObject({ status: "blocked", reasonCode: "binding_mismatch" });
		mocked.request.mockResolvedValue({ data: ["restored"], nextCursor: "same-cursor" });
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "unknown",
			reasonCode: "native_control_unavailable",
		});
		await writeFile(context.record.handoffPath ?? "", "已经改变的 handoff");
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "unknown",
			reasonCode: "completion_evidence_unavailable",
		});
	});
	it("38fd3 正常确认对照：confirmed 与 completed 不进入补证，重复扫描不再 fork 或投递", async () => {
		const context = await setupExecutionResultInterleavingEvidence();
		const request = { ...context.binding, dryRun: false };
		const recordsBefore = await context.service.status(context.scope, { taskId: "task" });
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, request)).toMatchObject({
			status: "blocked",
			reasonCode: "pause_reason_not_eligible",
		});
		expect(await context.service.status(context.scope, { taskId: "task" })).toEqual(recordsBefore);
		await context.service.reportExecutionResult(context.scope, context.land);
		const completed = await context.service.reportExecutionResult(context.scope, context.baseBranchSync);
		const enqueueCount = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
		const forkCount = mocked.request.mock.calls.filter((call) => call[0] === "thread/fork").length;
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await restarted.sweepPendingCloseoutsOnce();
		await restarted.sweepPendingCloseoutsOnce();
		expect(await restarted.reconcileLateNativePromptAcceptance(context.scope, request)).toMatchObject({
			status: "blocked",
			reasonCode: "pause_reason_not_eligible",
		});
		expect(completed.record.lateNativePromptAcceptanceRecoveryReceipt).toBeUndefined();
		expect((await restarted.status(context.scope, { taskId: "task" })).records[0]).toEqual(completed.record);
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(enqueueCount);
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(forkCount);
	});
});

async function setupExecutionResultInterleavingEvidence() {
	const context = await setup();
	await context.complete();
	await context.service.sweepPendingCloseoutsOnce();
	const record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
	if (!record?.handoffSha256) throw new Error("缺少交接绑定");
	await recordTaskMessageTerminalDeliveryOutcome({
		ledgerPath: getTaskMessageInjectionLedgerPath(mocked.directory),
		taskId: "task",
		idempotencyKey: record.promptDeliveryIdempotencyKey,
		status: "delivered_and_submit_confirmed",
		nowIso: new Date().toISOString(),
	});
	await writeFile(join(context.repo.repositoryPath, "implementation.txt"), "已验证的并发收尾修复\n");
	const commitSha = context.repo.commitAllRepositoryFilesAtDate({
		message: "fix: 验证并发收尾的真实提交",
		authorAndCommitterIsoDate: "2026-01-02T00:00:00Z",
	});
	const gitDirectory = context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim();
	const evidencePath = join(gitDirectory, "rvf", "evidence", "reviewed-task-candidate-evidence.json");
	const evidence = JSON.stringify({
		subject: {
			head_oid: commitSha,
			worktree_realpath: context.repo.repositoryPath,
			git_common_dir_realpath: gitDirectory,
		},
		review: { run_id: "run", protocol_valid: true },
	});
	await mkdir(dirname(evidencePath), { recursive: true });
	await writeFile(evidencePath, evidence);
	await writeFile(`${evidencePath}.sha256`, computeRvfTextSha256(evidence));
	const binding = {
		taskId: "task",
		decisionToken: context.token,
		runId: "run",
		handoffSha256: record.handoffSha256,
	};
	const land = { ...binding, stage: "land" as const, outcome: "completed" as const, commitSha };
	const baseBranchSync = {
		...binding,
		stage: "base_branch_sync" as const,
		outcome: "completed" as const,
		commitSha,
		baseRef: "main",
	};
	return { ...context, binding, land, baseBranchSync };
}

describe("RVF 执行完成事实的跨 service 持久单调性", () => {
	it.each([
		{ stage: "land", outcome: "failed" },
		{ stage: "land", outcome: "blocked" },
		{ stage: "land", outcome: "completed" },
		{ stage: "base_branch_sync", outcome: "failed" },
		{ stage: "base_branch_sync", outcome: "blocked" },
		{ stage: "base_branch_sync", outcome: "completed" },
	] as const)("$stage 的迟到 $outcome 报告不能覆盖已完成结果", async ({ stage, outcome }) => {
		const context = await setupExecutionResultInterleavingEvidence();
		if (stage === "base_branch_sync") await context.service.reportExecutionResult(context.scope, context.land);
		const validationStarted = createExecutionResultInterleavingSignal();
		const releaseValidation = createExecutionResultInterleavingSignal();
		const delayedReporter = createRvfAutomaticCloseoutRuntimeService({
			...context.dependencies,
			getManager: async () => {
				validationStarted.resolve();
				await releaseValidation.promise;
				return context.manager;
			},
		});
		const completedReport = stage === "land" ? context.land : context.baseBranchSync;
		const delayedReport =
			outcome === "completed"
				? completedReport
				: { ...context.binding, stage, outcome, reason: "先开始验证、后到达写锁的失败报告" };
		const delayedOutcome = delayedReporter.reportExecutionResult(context.scope, delayedReport).then(
			(value) => ({ value, error: null }),
			(error: unknown) => ({ value: null, error }),
		);
		await validationStarted.promise;
		let now = Date.now();
		const currentTime = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			if (stage === "land") await context.service.reportExecutionResult(context.scope, context.land);
			const completed = await context.service.reportExecutionResult(context.scope, context.baseBranchSync);
			now += 1;
			releaseValidation.resolve();
			const delayed = await delayedOutcome;
			expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toEqual(completed.record);
			if (outcome === "completed") {
				expect(delayed.error).toBeNull();
				expect(delayed.value?.record).toEqual(completed.record);
			} else {
				expect(delayed.error).toBeInstanceOf(Error);
				expect(String(delayed.error)).toContain("已确认的执行结果");
			}
		} finally {
			releaseValidation.resolve();
			await delayedOutcome;
			currentTime.mockRestore();
		}
	});

	it("跨 service 的用户持久暂停仍阻止迟到执行报告", async () => {
		const context = await setupExecutionResultInterleavingEvidence();
		const validationStarted = createExecutionResultInterleavingSignal();
		const releaseValidation = createExecutionResultInterleavingSignal();
		const delayedReporter = createRvfAutomaticCloseoutRuntimeService({
			...context.dependencies,
			getManager: async () => {
				validationStarted.resolve();
				await releaseValidation.promise;
				return context.manager;
			},
		});
		const delayedOutcome = delayedReporter.reportExecutionResult(context.scope, context.land).then(
			() => null,
			(error: unknown) => error,
		);
		await validationStarted.promise;
		try {
			await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		} finally {
			releaseValidation.resolve();
		}
		expect(await delayedOutcome).toBeInstanceOf(Error);
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
			status: "paused",
			pauseReason: "用户明确停止会话，自动收尾已暂停。",
		});
		expect(
			(await context.service.status(context.scope, { taskId: "task" })).records[0]?.landExecutionResult,
		).toBeUndefined();
	});

	it.each(["submitted", "failed"] as const)(
		"coordinator 的迟到 $0 写回保留另一 service 已确认的 completed",
		async (enqueueOutcome) => {
			const context = await setupExecutionResultInterleavingEvidence();
			const enqueueStarted = createExecutionResultInterleavingSignal();
			const releaseEnqueue = createExecutionResultInterleavingSignal();
			context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mockImplementation(
				async (_scope, input) => {
					const response = await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
						{},
						context.scope.workspaceId,
						input,
					);
					enqueueStarted.resolve();
					await releaseEnqueue.promise;
					return enqueueOutcome === "failed" ? { ok: false, error: "迟到的投递失败" } : response;
				},
			);
			const coordinatorSweep = context.service.sweepPendingCloseoutsOnce();
			await enqueueStarted.promise;
			const executionReporter = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			try {
				await executionReporter.reportExecutionResult(context.scope, context.land);
				await executionReporter.reportExecutionResult(context.scope, context.baseBranchSync);
				await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			} finally {
				releaseEnqueue.resolve();
				await coordinatorSweep;
			}
			const completed = (await executionReporter.status(context.scope, { taskId: "task" })).records[0];
			expect(completed).toMatchObject({
				status: "completed",
				landExecutionResult: { outcome: "completed", commitSha: context.land.commitSha },
				baseBranchSyncExecutionResult: { outcome: "completed", commitSha: context.land.commitSha },
				activeCoordinatorOperationClaimId: null,
			});
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(2);
			expect(context.manager.publishRvfAutomaticCloseoutPaused).not.toHaveBeenCalled();
		},
	);
});
