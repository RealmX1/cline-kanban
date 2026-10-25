import { appendFile, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	type TaskMessageInjectionRecord,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";
import * as diagnosticEventJournal from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { type LockRequest, lockedFileSystem } from "../../../src/fs/locked-file-system";
import { computeRvfTextSha256 } from "../../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import type { CodexNativeConversationTurn } from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { collectPreReviewConversationRestoreIdleGateBlockers } from "../../../src/rvf-automatic-closeout/pre-review-conversation-restore-idle-gate-recovery";
import { RvfAutomaticCloseoutPauseError } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-coordinator";
import { buildRvfAutomaticCloseoutPrompt } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-prompt";
import { createRvfAutomaticCloseoutRuntimeService } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-runtime-service";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
} from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import {
	claimRvfCloseoutExecutionStage,
	observeExistingRvfLandExecutionResultOnce,
} from "../../../src/rvf-automatic-closeout/rvf-closeout-execution-stage-recovery";
import { observeExistingRvfBaseIntegrationStateOnce } from "../../../src/rvf-automatic-closeout/rvf-closeout-existing-base-integration-observation";
import { captureRvfCloseoutSkillInstallationVersionReference } from "../../../src/rvf-automatic-closeout/rvf-closeout-historical-skill-installation-evidence";
import {
	remainingRvfCloseoutStages,
	remainingRvfCloseoutVerificationStages,
} from "../../../src/rvf-automatic-closeout/rvf-closeout-recovery-supervisor";
import * as skillSnapshotStore from "../../../src/rvf-automatic-closeout/rvf-closeout-skill-attachment-snapshot-store";
import {
	captureRvfCloseoutAcceptedSkillSnapshot,
	captureRvfCloseoutExpectedSkillSnapshot,
	readRvfCloseoutSkillSnapshots,
	writeRvfCloseoutSkillSnapshot,
} from "../../../src/rvf-automatic-closeout/rvf-closeout-skill-attachment-snapshot-store";
import * as baseIntegrationEvidence from "../../../src/rvf-automatic-closeout/validate-rvf-automatic-closeout-execution-result";
import { verifyCodexNativeCloseoutSkillAttachmentEvidence } from "../../../src/rvf-automatic-closeout/verify-codex-native-closeout-skill-attachment-evidence";
import {
	getWorkspaceQueuedTaskPromptDeliveriesPath,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../../../src/state/queued-task-prompt-delivery-store";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { reduceSessionTransition } from "../../../src/terminal/session-state-machine";
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
	const initialNativeTranscriptPath = join(fixture.fixtureRootDirectoryPath, "initial-native-transcript.jsonl");
	await writeFile(initialNativeTranscriptPath, "");
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
			transcriptPath: initialNativeTranscriptPath,
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
		getTaskTerminalInputSideMutationSnapshot: (): ReturnType<
			TerminalSessionManager["getTaskTerminalInputSideMutationSnapshot"]
		> => ({
			runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
			humanTerminalInputMutationSequenceNumber: 0,
			hasUncommittedInput: false,
			inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
		}),
		hasPendingProgrammaticTaskChatInputDelivery: vi.fn(() => false),
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
async function setupPreviouslyEnqueuedCloseoutWithFrozenHistoricalPrompt() {
	const context = await setup("codex-closeout-conversation");
	vi.stubEnv("HOME", context.fixture.isolatedHomeDirectoryPath);
	await context.complete();
	await context.service.sweepPendingCloseoutsOnce();
	const firstSubmission = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls[0]?.[1];
	if (!firstSubmission) throw new Error("缺少首次收尾投递请求");
	const frozenPromptText = `${firstSubmission.text}\n首次投递时的旧版本模板说明。`;
	const ledgerPath = getTaskMessageInjectionLedgerPath(mocked.directory);
	await withTaskMessageInjectionLedgerLock(ledgerPath, async (records) => ({
		records: records.map((entry) => ({ ...entry, prompt_sha256: computeRvfTextSha256(frozenPromptText) })),
		result: null,
	}));
	const queuePath = getWorkspaceQueuedTaskPromptDeliveriesPath(context.scope.workspaceId);
	const queueSnapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(context.scope.workspaceId);
	for (const entry of queueSnapshot.entriesByTaskId[firstSubmission.taskId] ?? []) entry.text = frozenPromptText;
	await writeFile(queuePath, JSON.stringify(queueSnapshot));
	const frozenLedger = await readFile(ledgerPath, "utf8");
	const frozenQueue = await readFile(queuePath, "utf8");
	return {
		...context,
		firstSubmission,
		frozenPromptText,
		ledgerPath,
		queuePath,
		queueSnapshot,
		frozenLedger,
		frozenQueue,
		storePath: getRvfAutomaticCloseoutStorePath(context.scope.workspaceId),
	};
}

async function persistBoundHistoricalCloseoutPromptDigest(
	context: Awaited<ReturnType<typeof setupPreviouslyEnqueuedCloseoutWithFrozenHistoricalPrompt>>,
) {
	const record = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
	if (!record?.runId || !record.handoffSha256) throw new Error("缺少收尾 run 与 handoff 绑定");
	const reference = await writeRvfCloseoutSkillSnapshot({
		schema: "rvf-closeout-skill-attachment-snapshot/v1",
		workspaceId: record.workspaceId,
		taskId: record.taskId,
		decisionToken: record.receipt.decision_token,
		runId: record.runId,
		handoffSha256: record.handoffSha256,
		promptDeliveryIdempotencyKey: record.promptDeliveryIdempotencyKey,
		promptSha256: computeRvfTextSha256(context.frozenPromptText),
		phase: "expected_installation",
		capturedAt: record.createdAt,
		skills: [],
	});
	await updateRvfAutomaticCloseoutRecords(context.storePath, (records) => ({
		records: records.map((entry) => ({
			...entry,
			skillAttachmentEvidenceHistory: [...(entry.skillAttachmentEvidenceHistory ?? []), reference],
		})),
		value: null,
	}));
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
	it("fork 前出现待确认输入时不创建分支，接受确认后仅创建一次", async () => {
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
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(0);
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
		context.repo.runGit(["switch", "--create", "task-awaiting-local-base-integration"]);
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
		context.repo.runGit(["update-ref", "refs/heads/main", landCommitSha]);
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
	it("后继候选不会继承父版本已经激活的原生回退资格", async () => {
		const context = await setup();
		await context.complete();
		await writeFile(
			join(context.run, "artifacts", "inputs", "scope.contract.json"),
			JSON.stringify({
				run_id: "run",
				review_candidate_snapshot_version_id: "expanded-version",
				review_candidate_snapshot: {
					review_candidate_snapshot_version_id: "expanded-version",
					automatic_closeout_eligibility: { status: "unavailable" },
				},
			}),
		);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]).toMatchObject({
			status: "paused",
			pauseReason: expect.stringContaining("后继候选"),
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
					transcriptPath: changed === "transcript" ? "/replacement.jsonl" : identity.transcriptPath,
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
	it("模板升级后重启复用首次投递回执与冻结正文，等待真实确认且不重复入队", async () => {
		const context = await setupPreviouslyEnqueuedCloseoutWithFrozenHistoricalPrompt();
		const { firstSubmission, frozenPromptText, ledgerPath, queuePath, frozenLedger, frozenQueue } = context;
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage({}, context.scope.workspaceId, {
				...firstSubmission,
				text: frozenPromptText,
				promptSha256: computeRvfTextSha256(frozenPromptText),
			}),
		).toMatchObject({ ok: true, injectionLedgerRecordDisposition: "already_existed" });
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage({}, context.scope.workspaceId, firstSubmission),
		).toMatchObject({ ok: false, idempotencyConflict: true });
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await restarted.sweepPendingCloseoutsOnce();
		await restarted.sweepPendingCloseoutsOnce();
		const storePath = getRvfAutomaticCloseoutStorePath(context.scope.workspaceId);
		expect((await readRvfAutomaticCloseoutRecords(storePath))[0]).toMatchObject({
			status: "submitting_closeout_prompt",
			waitingReasonCode: "closeout_delivery_confirmation_pending",
			pauseReason: null,
		});
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
		expect(await readFile(ledgerPath, "utf8")).toBe(frozenLedger);
		expect(await readFile(queuePath, "utf8")).toBe(frozenQueue);
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: firstSubmission.taskId,
			idempotencyKey: firstSubmission.idempotencyKey,
			status: "delivered_and_submit_confirmed",
			nowIso: new Date().toISOString(),
		});
		await restarted.sweepPendingCloseoutsOnce();
		expect((await readRvfAutomaticCloseoutRecords(storePath))[0]?.status).toBe("closeout_prompt_submitted");
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
		expect(await readTaskMessageInjectionLedger(ledgerPath)).toMatchObject([
			{
				prompt_sha256: computeRvfTextSha256(frozenPromptText),
				terminal_delivery_status: "delivered_and_submit_confirmed",
			},
		]);
		expect(await readFile(queuePath, "utf8")).toBe(frozenQueue);
	});
	it.each(["来源冲突", "会话冲突", "重复回执", "原失败", "显式停止", "原生身份变化"] as const)(
		"模板升级后的回执复用仍拒绝%s，不覆盖旧账本或重新入队",
		async (scenario) => {
			const context = await setupPreviouslyEnqueuedCloseoutWithFrozenHistoricalPrompt();
			await recordTaskMessageTerminalDeliveryOutcome({
				ledgerPath: context.ledgerPath,
				taskId: context.firstSubmission.taskId,
				idempotencyKey: context.firstSubmission.idempotencyKey,
				status: scenario === "原失败" ? "delivery_failed" : "delivered_and_submit_confirmed",
				...(scenario === "原失败" ? { failureReason: "cancelled_before_delivery" as const } : {}),
				nowIso: new Date().toISOString(),
			});
			await withTaskMessageInjectionLedgerLock(context.ledgerPath, async (records) => ({
				records:
					scenario === "重复回执"
						? [...records, ...records]
						: records.map((entry) => ({
								...entry,
								...(scenario === "来源冲突" ? { source: "other_source" } : {}),
								...(scenario === "会话冲突" ? { attempt_id: "other_conversation" } : {}),
							})),
				result: null,
			}));
			if (scenario === "显式停止")
				await context.service.pauseForExplicitStop(context.scope.workspaceId, context.firstSubmission.taskId);
			if (scenario === "原生身份变化")
				context.manager.applyAgentNativeConversationSessionIdentity(context.firstSubmission.taskId, {
					sourceAgentId: "codex",
					nativeSessionId: "other_native_session",
					transcriptPath: "/other-native.jsonl",
					observedAt: Date.now(),
				});
			const ledgerBeforeRestart = await readFile(context.ledgerPath, "utf8");
			const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			await restarted.sweepPendingCloseoutsOnce();
			expect((await readRvfAutomaticCloseoutRecords(context.storePath))[0]?.status).toBe("paused");
			if (scenario === "原失败")
				expect((await readRvfAutomaticCloseoutRecords(context.storePath))[0]?.pauseReason).toContain(
					"cancelled_before_delivery",
				);
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
			expect(await readFile(context.ledgerPath, "utf8")).toBe(ledgerBeforeRestart);
		},
	);
	it("旧队列缺账本时先等待正文摘要，确认未发送后复用冻结正文恢复，不重排或延长队列截止", async () => {
		const context = await setupPreviouslyEnqueuedCloseoutWithFrozenHistoricalPrompt();
		await withTaskMessageInjectionLedgerLock(context.ledgerPath, async () => ({ records: [], result: null }));
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await restarted.sweepPendingCloseoutsOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
		expect((await readRvfAutomaticCloseoutRecords(context.storePath))[0]?.status).toBe("submitting_closeout_prompt");
		await persistBoundHistoricalCloseoutPromptDigest(context);
		for (const entry of context.queueSnapshot.entriesByTaskId[context.firstSubmission.taskId] ?? [])
			entry.text = "被改写且不匹配首次不可变摘要的正文";
		await writeFile(context.queuePath, JSON.stringify(context.queueSnapshot));
		await restarted.sweepPendingCloseoutsOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
		expect(await readTaskMessageInjectionLedger(context.ledgerPath)).toEqual([]);
		await writeFile(context.queuePath, context.frozenQueue);
		await restarted.sweepPendingCloseoutsOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledTimes(2);
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls[1]?.[1]).toMatchObject({
			text: context.frozenPromptText,
			promptSha256: computeRvfTextSha256(context.frozenPromptText),
			idempotencyKey: context.firstSubmission.idempotencyKey,
		});
		expect(await readWorkspaceQueuedTaskPromptDeliverySnapshot(context.scope.workspaceId)).toEqual(
			JSON.parse(context.frozenQueue),
		);
		expect(await readTaskMessageInjectionLedger(context.ledgerPath)).toMatchObject([
			{
				prompt_sha256: computeRvfTextSha256(context.frozenPromptText),
				terminal_delivery_status: "accepted_pending_submit_confirmation",
			},
		]);
		expect((await readRvfAutomaticCloseoutRecords(context.storePath))[0]?.status).toBe("submitting_closeout_prompt");
	});
	it.each(["delivered_and_submit_confirmed", "delivery_failed"] as const)(
		"旧队列可能已发送且缺账本时只等原回执 %s，证据恢复后自动接续并保留原结果",
		async (status) => {
			const context = await setupPreviouslyEnqueuedCloseoutWithFrozenHistoricalPrompt();
			await persistBoundHistoricalCloseoutPromptDigest(context);
			await withTaskMessageInjectionLedgerLock(context.ledgerPath, async () => ({ records: [], result: null }));
			const entry = context.queueSnapshot.entriesByTaskId[context.firstSubmission.taskId]?.[0];
			if (!entry?.programmaticInjectionLedgerReceiptLink) throw new Error("缺少绑定收尾的队列条目");
			entry.deliveryState = "handed_to_transport";
			entry.deliveryAttemptCount = 1;
			entry.lastAttemptedAt = Date.now();
			await writeFile(context.queuePath, JSON.stringify(context.queueSnapshot));
			const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			await restarted.sweepPendingCloseoutsOnce();
			expect((await readRvfAutomaticCloseoutRecords(context.storePath))[0]?.status).toBe(
				"submitting_closeout_prompt",
			);
			await writeFile(context.queuePath, JSON.stringify({ entriesByTaskId: {} }));
			await restarted.sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
			entry.deliveryState = status === "delivery_failed" ? "settled_failed" : "settled_delivered";
			entry.settledAt = Date.now();
			entry.programmaticInjectionLedgerReceiptLink.settledTerminalDeliveryReceipt = {
				status,
				reason: status === "delivery_failed" ? "runtime_restarted_before_confirmation" : null,
			};
			await writeFile(context.queuePath, JSON.stringify(context.queueSnapshot));
			const settledQueue = await readFile(context.queuePath, "utf8");
			await restarted.sweepPendingCloseoutsOnce();
			expect((await readRvfAutomaticCloseoutRecords(context.storePath))[0]?.status).toBe(
				status === "delivery_failed" ? "paused" : "closeout_prompt_submitted",
			);
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
			expect(await readTaskMessageInjectionLedger(context.ledgerPath)).toEqual([]);
			expect(await readFile(context.queuePath, "utf8")).toBe(settledQueue);
		},
	);
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
		"Skill 核验中 %s 分别核验历史事实与当前资格",
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
			if (scenario === "installation_changed") {
				expect(
					await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request),
				).toMatchObject({ status: "recovered" });
				return;
			}
			expect(
				await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request),
			).toMatchObject({
				status: "blocked",
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
			expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/loaded/list")).toHaveLength(
				callsPerAttempt * 3,
			);
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
					expect(
						mocked.request.mock.calls.filter((call) => call[0] === "thread/loaded/list").length,
					).toBeLessThanOrEqual(callsPerAttempt * maximumAttempts);
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

	it.each(["runtime_incarnation", "process_start"] as const)(
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
				expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/loaded/list")).toHaveLength(
					callsPerAttempt * 3,
				);
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
				const service = context.service;
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
		const after = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
		const prior = JSON.parse(before.toString("utf8"));
		const withoutMachineProgress = (records: typeof after) =>
			records.map(
				({
					automaticRecoveryProgress: _progress,
					...entry
				}: {
					automaticRecoveryProgress?: unknown;
					[key: string]: unknown;
				}) => entry,
			);
		expect(withoutMachineProgress(after)).toEqual(withoutMachineProgress(prior));
		expect(after[0]?.automaticRecoveryProgress.kind).toBe("machine_waiting");
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
			const closeoutValidationStarted = createExecutionResultInterleavingSignal();
			const releaseCloseoutValidation = createExecutionResultInterleavingSignal();
			const delayedCoordinator = createRvfAutomaticCloseoutRuntimeService({
				...context.dependencies,
				getManager: async () => {
					const record = (
						await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId))
					)[0];
					// 已有回执不再重入队；在 coordinator 持久认领后的核验阶段注入同一迟到写回竞态。
					if (!record?.activeCoordinatorOperationClaimId) return context.manager;
					closeoutValidationStarted.resolve();
					await releaseCloseoutValidation.promise;
					if (enqueueOutcome === "failed") throw new RvfAutomaticCloseoutPauseError("迟到的投递失败");
					return context.manager;
				},
			});
			const coordinatorSweep = delayedCoordinator.sweepPendingCloseoutsOnce();
			await closeoutValidationStarted.promise;
			const executionReporter = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			try {
				await executionReporter.reportExecutionResult(context.scope, context.land);
				await executionReporter.reportExecutionResult(context.scope, context.baseBranchSync);
				await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			} finally {
				releaseCloseoutValidation.resolve();
				await coordinatorSweep;
			}
			const completed = (await executionReporter.status(context.scope, { taskId: "task" })).records[0];
			expect(completed).toMatchObject({
				status: "completed",
				landExecutionResult: { outcome: "completed", commitSha: context.land.commitSha },
				baseBranchSyncExecutionResult: { outcome: "completed", commitSha: context.land.commitSha },
				activeCoordinatorOperationClaimId: null,
			});
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
			expect(context.manager.publishRvfAutomaticCloseoutPaused).not.toHaveBeenCalled();
		},
	);
});

describe("完整恢复闭环：独立结果与阶段认领", () => {
	it("base 暂缓的重新评估条件变化须追加历史，相同报告重放保持幂等", async () => {
		const context = await setupExecutionResultInterleavingEvidence();
		context.manager.getSummary().runtimeSessionIncarnationId = "base-deferral-condition-incarnation";
		const report = {
			...context.binding,
			stage: "base_branch_sync" as const,
			outcome: "blocked" as const,
			blockedReasonKind: "agent_assessed_not_ready_for_base_sync" as const,
			reason: "协议依赖尚未闭合",
			baseBranchSyncReassessmentCondition: "协议依赖闭合后重新评估",
		};
		const first = await context.service.reportExecutionResult(context.scope, report);
		const changed = { ...report, baseBranchSyncReassessmentCondition: "协议依赖闭合且新增整合验证通过后重新评估" };
		const second = await context.service.reportExecutionResult(context.scope, changed);
		expect(second.record.baseBranchSyncExecutionResult?.baseBranchSyncReassessmentCondition).toBe(
			changed.baseBranchSyncReassessmentCondition,
		);
		expect(second.record.executionResultReportHistory).toHaveLength(
			(first.record.executionResultReportHistory?.length ?? 0) + 1,
		);
		expect((await context.service.reportExecutionResult(context.scope, changed)).record).toEqual(second.record);
	});
	it("完整恢复闭环的新执行代际不能用自述受阻报告释放旧认领", async () => {
		const context = await setupExecutionResultInterleavingEvidence();
		context.manager.getSummary().runtimeSessionIncarnationId = "old-claim-owner-incarnation";
		const request = { ...context.binding, stage: "land" as const };
		const claimed = await context.service.claimExecutionStage(context.scope, request);
		if (claimed.status !== "claimed") throw new Error("隔离阶段未认领");
		context.manager.getSummary().runtimeSessionIncarnationId = "new-claim-owner-incarnation";
		await expect(
			context.service.reportExecutionResult(context.scope, {
				...request,
				outcome: "blocked",
				reason: "新代尚未取得旧执行结果",
				blockedReasonKind: "machine_precondition",
				stageExecutionClaimId: claimed.claim.stageExecutionClaimId,
			}),
		).rejects.toThrow("代际");
		const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
		expect(saved[0].stageExecutionClaims[0].status).toBe("claimed");
	});
	it.each(["user_restriction", "evidence_conflict"] as const)(
		"完整恢复闭环保留 failed 报告中的明确禁止分类：%s",
		async (blockedReasonKind) => {
			const context = await setupExecutionResultInterleavingEvidence();
			context.manager.getSummary().runtimeSessionIncarnationId = "classified-failure-incarnation";
			await context.service.reportExecutionResult(context.scope, {
				...context.binding,
				stage: "land",
				outcome: "failed",
				blockedReasonKind,
				reason: "阶段存在明确限制或证据冲突",
			});
			expect(
				await context.service.claimExecutionStage(context.scope, { ...context.binding, stage: "land" }),
			).toMatchObject({ status: "blocked" });
		},
	);
	it("完整恢复闭环不会把新认领的同语义受阻报告当作旧报告重放", async () => {
		const context = await setupExecutionResultInterleavingEvidence();
		context.manager.getSummary().runtimeSessionIncarnationId = "new-claim-report-incarnation";
		const request = { ...context.binding, stage: "land" as const };
		for (let attempt = 0; attempt < 2; attempt++) {
			const claimed = await context.service.claimExecutionStage(context.scope, request);
			if (claimed.status !== "claimed") throw new Error("隔离阶段未取得认领");
			await context.service.reportExecutionResult(context.scope, {
				...request,
				outcome: "blocked",
				blockedReasonKind: "machine_precondition",
				reason: "等待同一机器前置条件",
				deliveryAttemptId: claimed.claim.deliveryAttemptId,
				stageExecutionClaimId: claimed.claim.stageExecutionClaimId,
			});
		}
		const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
		expect(saved[0].executionResultReportHistory).toHaveLength(2);
		expect(saved[0].stageExecutionClaims.map((claim: { status: string }) => claim.status)).toEqual([
			"released",
			"released",
		]);
	});
	it("完整恢复闭环不凭未知原接受直接认领写入阶段", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.writeNativeEvidence({ includeMessage: false });
		const result = await context.service.claimExecutionStage(context.scope, { ...context.request, stage: "land" });
		expect(result.status).toBe("waiting");
		const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
		expect(saved[0].stageExecutionClaims).toBeUndefined();
	});
	it.each(["matching", "matching_reused", "tampered", "missing", "corrupt_ledger"])(
		"RVF-002 完整恢复闭环在旧接受未知且原控制面消失时仍核验实际 Land：%s",
		async (evidenceScenario) => {
			const evidenceDigest =
				evidenceScenario === "corrupt_ledger" || evidenceScenario === "matching_reused"
					? "matching"
					: evidenceScenario;
			const context = await setupExecutionResultInterleavingEvidence();
			const storePath = getRvfAutomaticCloseoutStorePath(context.scope.workspaceId);
			const bound = (await context.service.status(context.scope, { taskId: "task" })).records[0];
			if (!bound?.runDirectory) throw new Error("缺少绑定 run");
			await withTaskMessageInjectionLedgerLock(
				getTaskMessageInjectionLedgerPath(mocked.directory),
				async (records) => ({
					records: records.map((entry) => ({
						...entry,
						terminal_delivery_status: "delivery_failed" as const,
						terminal_delivery_failure_reason: "submit_confirmation_budget_exhausted" as const,
					})),
					result: undefined,
				}),
			);
			await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
				records: records.map((entry) => ({
					...entry,
					status: "paused" as const,
					pauseReason: "收尾投递失败：submit_confirmation_budget_exhausted",
				})),
				value: undefined,
			}));
			const candidatePath = context.repo
				.runGit([
					"rev-parse",
					"--path-format=absolute",
					"--git-path",
					"rvf/evidence/reviewed-task-candidate-evidence.json",
				])
				.stdout.trim();
			const candidateDigest = computeRvfTextSha256(await readFile(candidatePath));
			await writeFile(
				join(bound.runDirectory, "artifacts", "rvf-land-commit-result.json"),
				JSON.stringify({
					schema_version: 1,
					run_id: "run",
					run_dir: bound.runDirectory,
					repo_root: context.repo.repositoryPath,
					head_oid_after_commit: context.land.commitSha,
					result: {
						exit_code: 0,
						commit_oid: context.land.commitSha,
						candidate_evidence: {
							status: evidenceScenario === "matching_reused" ? "reused" : "written",
							...(evidenceDigest === "missing"
								? {}
								: {
										candidate_evidence_sha256:
											evidenceDigest === "matching" ? candidateDigest : "f".repeat(64),
									}),
						},
						round_baseline_seal: { sealed: true },
					},
				}),
			);
			const resultBytes = await readFile(join(bound.runDirectory, "artifacts", "rvf-land-commit-result.json"));
			const immutableDirectory = join(bound.runDirectory, "artifacts", "rvf-land-commit-execution-results");
			await mkdir(immutableDirectory);
			await writeFile(join(immutableDirectory, `${computeRvfTextSha256(resultBytes)}.json`), resultBytes);
			context.manager.getSummary().codexNativeSessionControlEndpoint = undefined;
			if (evidenceScenario === "corrupt_ledger")
				await writeFile(getTaskMessageInjectionLedgerPath(mocked.directory), "{隔离损坏的旧投递账本");
			const ledgerBefore = await readFile(getTaskMessageInjectionLedgerPath(mocked.directory));
			if (evidenceDigest !== "matching") {
				await expect(context.service.reportExecutionResult(context.scope, context.land)).rejects.toThrow("摘要");
				expect(
					(await context.service.status(context.scope, { taskId: "task" })).records[0]?.landExecutionResult,
				).toBeUndefined();
				const clock = vi.spyOn(Date, "now");
				const now = Date.now();
				try {
					for (const offset of [16_000, 32_000, 48_000]) {
						clock.mockReturnValue(now + offset);
						await context.service.sweepPendingCloseoutsOnce();
					}
					const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
					await restarted.status(context.scope, { taskId: "task" });
					const saved = JSON.parse(await readFile(storePath, "utf8"));
					expect(saved[0].independentLandResultObservationBudget?.count).toBe(3);
				} finally {
					clock.mockRestore();
				}
				expect(await readFile(getTaskMessageInjectionLedgerPath(mocked.directory))).toEqual(ledgerBefore);
				return;
			}
			const controlObservations: boolean[] = [];
			const getManager = context.dependencies.getManager;
			context.dependencies.getManager = async () => {
				const saved = JSON.parse(await readFile(storePath, "utf8"));
				controlObservations.push(saved[0].landExecutionResult?.outcome === "completed");
				return getManager();
			};
			await context.service.status(context.scope, { taskId: "task" });
			expect(controlObservations.every(Boolean)).toBe(true);
			const result = await context.service.reportExecutionResult(context.scope, context.land);
			expect(result.record.landExecutionResult).toMatchObject({
				outcome: "completed",
				verificationBasis: "verified_stage_execution",
				executionEvidenceSha256: computeRvfTextSha256(resultBytes),
			});
			expect(result.record.lateNativePromptAcceptanceRecoveryReceipt).toBeUndefined();
			expect(await readFile(getTaskMessageInjectionLedgerPath(mocked.directory))).toEqual(ledgerBefore);
		},
	);
	it.each(["missing", "wrong_digest", "symbolic_link"] as const)(
		"RVF-003 独立 Land 预算耗尽后仅补齐候选摘要即可重新验收：%s",
		async (sidecarScenario) => {
			const context = await setupExecutionResultInterleavingEvidence();
			let record = (await context.service.status(context.scope, { taskId: "task" })).records[0];
			if (!record?.runDirectory) throw new Error("缺少绑定 run");
			const candidatePath = context.repo
				.runGit([
					"rev-parse",
					"--path-format=absolute",
					"--git-path",
					"rvf/evidence/reviewed-task-candidate-evidence.json",
				])
				.stdout.trim();
			const candidateDigest = computeRvfTextSha256(await readFile(candidatePath));
			const canonicalBytes = JSON.stringify({
				run_id: record.runId,
				run_dir: record.runDirectory,
				repo_root: context.repo.repositoryPath,
				head_oid_after_commit: context.land.commitSha,
				result: {
					exit_code: 0,
					commit_oid: context.land.commitSha,
					candidate_evidence: { status: "written", candidate_evidence_sha256: candidateDigest },
					round_baseline_seal: { sealed: true },
				},
			});
			await writeFile(join(record.runDirectory, "artifacts", "rvf-land-commit-result.json"), canonicalBytes);
			const immutableDirectory = join(record.runDirectory, "artifacts", "rvf-land-commit-execution-results");
			await mkdir(immutableDirectory);
			await writeFile(join(immutableDirectory, `${computeRvfTextSha256(canonicalBytes)}.json`), canonicalBytes);
			if (sidecarScenario === "missing") await rm(`${candidatePath}.sha256`);
			else if (sidecarScenario === "wrong_digest") await writeFile(`${candidatePath}.sha256`, "错误摘要");
			else {
				const sidecarTarget = `${candidatePath}.sha256-symlink-target`;
				await writeFile(sidecarTarget, candidateDigest);
				await rm(`${candidatePath}.sha256`);
				await symlink(sidecarTarget, `${candidatePath}.sha256`);
			}
			const dependencies = {
				workspaceId: context.scope.workspaceId,
				rvfHome: context.rvfHome,
				getMainSummary: async () => context.manager.getSummary(),
				isStopped: () => false,
				verifyLateAcceptance: async () => undefined,
			};
			const now = Date.now();
			const clock = vi.spyOn(Date, "now");
			try {
				for (const offset of [0, 16_000, 32_000, 48_000]) {
					clock.mockReturnValue(now + offset);
					record = await observeExistingRvfLandExecutionResultOnce(dependencies, record);
				}
				expect(record.independentLandResultObservationBudget?.count).toBe(3);
				expect(record.landExecutionResult).toBeUndefined();
				const exhaustedFingerprint = record.independentLandResultObservationBudget?.fingerprint;
				await rm(`${candidatePath}.sha256`, { force: true });
				await writeFile(`${candidatePath}.sha256`, candidateDigest);
				clock.mockReturnValue(now + 92_001);
				record = await observeExistingRvfLandExecutionResultOnce(dependencies, record);
				expect(record.independentLandResultObservationBudget?.fingerprint).not.toBe(exhaustedFingerprint);
				expect(record.independentLandResultObservationBudget?.count).toBe(1);
				expect(record.landExecutionResult).toMatchObject({
					outcome: "completed",
					commitSha: context.land.commitSha,
					verificationBasis: "verified_stage_execution",
				});
			} finally {
				clock.mockRestore();
			}
		},
	);
	it("完整恢复闭环的阶段认领同代幂等且显式 Stop 禁止新认领", async () => {
		const context = await setupExecutionResultInterleavingEvidence();
		context.manager.getSummary().runtimeSessionIncarnationId = "claim-incarnation";
		const request = { ...context.binding, stage: "land" as const };
		const first = await context.service.claimExecutionStage(context.scope, request);
		expect(first.status).toBe("claimed");
		expect(await context.service.claimExecutionStage(context.scope, request)).toEqual(first);
		context.manager.getSummary().runtimeSessionIncarnationId = "replacement-incarnation";
		expect(await context.service.claimExecutionStage(context.scope, request)).toMatchObject({ status: "waiting" });
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		expect(await context.service.claimExecutionStage(context.scope, request)).toMatchObject({ status: "blocked" });
	});
	it.each(
		(["land", "base_branch_sync"] as const).flatMap((stage) =>
			(["permission", "question", "plan_review", "needs_input"] as const).map((userTurnKind) => ({
				stage,
				userTurnKind,
			})),
		),
	)("RVF-001 认领写锁内出现 $userTurnKind 时等待用户决策：$stage", async ({ stage, userTurnKind }) => {
		const context = await setupExecutionResultInterleavingEvidence();
		if (stage === "base_branch_sync") await context.service.reportExecutionResult(context.scope, context.land);
		const initial = { ...context.manager.getSummary(), runtimeSessionIncarnationId: "modal-decision-incarnation" };
		let observations = 0;
		const result = await claimRvfCloseoutExecutionStage(
			{
				workspaceId: context.scope.workspaceId,
				rvfHome: context.rvfHome,
				getMainSummary: async () => ({
					...initial,
					userTurnKind: ++observations === 1 ? "review" : userTurnKind,
				}),
				isStopped: () => false,
				verifyLateAcceptance: async () => undefined,
			},
			{ ...context.binding, stage },
		);
		expect(observations).toBe(2);
		expect(result).toMatchObject({ status: "waiting", reason: expect.stringContaining("用户决策") });
		const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
		expect(saved[0].stageExecutionClaims).toBeUndefined();
	});
	it("完整恢复闭环在认领写锁内发现执行会话换代时不生成认领", async () => {
		const context = await setupExecutionResultInterleavingEvidence();
		const initial = { ...context.manager.getSummary(), runtimeSessionIncarnationId: "initial-incarnation" };
		let observations = 0;
		const result = await claimRvfCloseoutExecutionStage(
			{
				workspaceId: context.scope.workspaceId,
				rvfHome: context.rvfHome,
				getMainSummary: async () => ({
					...initial,
					runtimeSessionIncarnationId: ++observations === 1 ? "initial-incarnation" : "replacement-incarnation",
				}),
				isStopped: () => false,
				verifyLateAcceptance: async () => undefined,
			},
			{ ...context.binding, stage: "land" },
		);
		expect(result.status).toBe("blocked");
		expect(
			(await context.service.status(context.scope, { taskId: "task" })).records[0]?.stageExecutionClaims,
		).toBeUndefined();
	});
});

describe("完整恢复闭环：持久预算和快照", () => {
	it.each(["同一安装文件", "不同安装文件"])(
		"RVF-006 历史快照按 realPath 区分%s，安装删除后仍保留去重依据",
		async (scenario) => {
			const context = await setupLateNativeCloseoutWithSkillAttachment();
			const firstAliasPath = join(context.fixture.fixtureRootDirectoryPath, "recorded-first-skill-alias.md");
			const secondAliasPath = join(context.fixture.fixtureRootDirectoryPath, "recorded-second-skill-alias.md");
			const secondInstallationPath = join(context.fixture.fixtureRootDirectoryPath, "second-installed-skill.md");
			await writeFile(secondInstallationPath, context.skill.body);
			await symlink(context.skill.path, firstAliasPath);
			await symlink(scenario === "同一安装文件" ? context.skill.path : secondInstallationPath, secondAliasPath);
			const skillReferences = [
				{ type: "skill" as const, name: "rvf-land", path: firstAliasPath },
				{ type: "skill" as const, name: context.skill.name, path: secondAliasPath },
			];
			context.catalogEntry.skills = skillReferences.map((reference) => ({ ...reference, enabled: true }));
			const text = buildRvfAutomaticCloseoutPrompt(context.record);
			const expected = await captureRvfCloseoutExpectedSkillSnapshot({
				record: context.record,
				port: { request: mocked.request },
				text,
				idempotencyKey: context.record.promptDeliveryIdempotencyKey,
			});
			if (!expected) throw new Error("缺少事件绑定的预期 Skill 快照");
			const historicalSnapshots = await readRvfCloseoutSkillSnapshots({
				...context.record,
				skillAttachmentEvidenceHistory: [expected],
			});
			expect(historicalSnapshots).toHaveLength(1);
			await Promise.all(
				[firstAliasPath, secondAliasPath, context.skill.path, secondInstallationPath].map((path) => rm(path)),
			);
			const request = vi.fn();
			const verification = verifyCodexNativeCloseoutSkillAttachmentEvidence({
				port: { request },
				worktree: context.repo.repositoryPath,
				text,
				skillReferences,
				nativeSkillExpansionTexts: skillReferences.map(
					(reference) =>
						`<skill>\n<name>${reference.name}</name>\n<path>${reference.path}</path>\n${context.skill.body}\n</skill>`,
				),
				historicalSnapshots,
			});
			if (scenario === "同一安装文件") await expect(verification).rejects.toThrow("重复");
			else await expect(verification).resolves.toBeTypeOf("function");
			expect(request).not.toHaveBeenCalled();
		},
	);
	it("完整恢复闭环在历史别名快照重新可用时自动刷新证据预算并补证", async () => {
		const context = await setupLateNativeCloseoutWithSkillAttachment();
		const alias = join(context.fixture.fixtureRootDirectoryPath, "historically-bound-skill-alias.md");
		await symlink(context.skill.path, alias);
		context.reference.path = alias;
		const raw = (await readFile(context.transcriptPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const entry of raw)
			for (const part of entry.payload?.item?.content ?? []) if (part.type === "skill") part.path = alias;
		await writeFile(context.transcriptPath, `${raw.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const reference = await skillSnapshotStore.writeRvfCloseoutSkillSnapshot({
			schema: "rvf-closeout-skill-attachment-snapshot/v1",
			workspaceId: context.scope.workspaceId,
			taskId: "task",
			decisionToken: context.token,
			runId: context.record.runId ?? "",
			handoffSha256: context.record.handoffSha256 ?? "",
			promptDeliveryIdempotencyKey: context.record.promptDeliveryIdempotencyKey,
			promptSha256: computeRvfTextSha256(buildRvfAutomaticCloseoutPrompt(context.record)),
			phase: "expected_installation",
			capturedAt: Date.now(),
			skills: [
				{
					referenceName: context.skill.name,
					referencePath: alias,
					canonicalName: context.skill.name,
					canonicalPath: context.skill.path,
					realPath: context.skill.path,
					instructionText: context.skill.body,
				},
			],
		});
		await updateRvfAutomaticCloseoutRecords(
			getRvfAutomaticCloseoutStorePath(context.scope.workspaceId),
			(records) => ({
				records: records.map((entry) => ({ ...entry, skillAttachmentEvidenceHistory: [reference] })),
				value: undefined,
			}),
		);
		const path = join(
			dirname(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId)),
			"rvf-closeout-skill-attachment-snapshots",
			`${reference.snapshotSha256}.json`,
		);
		const bytes = await readFile(path);
		await rm(path);
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			for (const offset of [0, 16_000, 32_000]) {
				clock.mockReturnValue(now + offset);
				await context.service.sweepPendingCloseoutsOnce();
			}
			await writeFile(path, bytes);
			clock.mockReturnValue(now + 48_000);
			const recovered = (
				await createRvfAutomaticCloseoutRuntimeService(context.dependencies).status(context.scope, {
					taskId: "task",
				})
			).records[0];
			expect(recovered?.lateNativePromptAcceptanceRecoveryReceipt).toBeDefined();
		} finally {
			clock.mockRestore();
		}
	});
	it("完整恢复闭环的 dry-run 跳过损坏的备用快照且不写诊断日志", async () => {
		const context = await setupLateNativeCloseoutWithSkillAttachment();
		await updateRvfAutomaticCloseoutRecords(
			getRvfAutomaticCloseoutStorePath(context.scope.workspaceId),
			(records) => ({
				records: records.map((entry) => ({
					...entry,
					skillAttachmentEvidenceHistory: [
						{
							schema: "rvf-closeout-skill-attachment-evidence/v1" as const,
							phase: "expected_installation" as const,
							snapshotSha256: "f".repeat(64),
							promptDeliveryIdempotencyKey: entry.promptDeliveryIdempotencyKey,
							capturedAt: Date.now(),
						},
					],
				})),
				value: undefined,
			}),
		);
		const journal = vi
			.spyOn(diagnosticEventJournal, "appendDiagnosticEventToRotatingJsonlJournal")
			.mockImplementation(() => undefined);
		onTestFinished(() => journal.mockRestore());
		expect(
			await context.service.reconcileLateNativePromptAcceptance(context.scope, { ...context.request, dryRun: true }),
		).toMatchObject({ status: "eligible" });
		expect(journal).not.toHaveBeenCalled();
	});
	it("完整恢复闭环的实际快照采集失败不阻止严格补证恢复", async () => {
		const context = await setupLateNativeCloseoutWithSkillAttachment();
		const capture = vi
			.spyOn(skillSnapshotStore, "captureRvfCloseoutAcceptedSkillSnapshot")
			.mockRejectedValue(new Error("隔离快照暂不可写"));
		onTestFinished(() => capture.mockRestore());
		const ledgerBefore = await readFile(context.ledgerPath);
		expect(await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request)).toMatchObject({
			status: "recovered",
		});
		expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
	});
	it("完整恢复闭环的同证据预算在 service 重建后仍不重置", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		mocked.request.mockRejectedValue(new Error("控制面暂不可读"));
		await context.service.status(context.scope, { taskId: "task" });
		const before = mocked.request.mock.calls.length;
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await restarted.status(context.scope, { taskId: "task" });
		expect(mocked.request.mock.calls.length).toBe(before);
		const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
		expect(saved[0].automaticRecoveryProgress).toMatchObject({
			kind: "machine_waiting",
			verificationAttemptCount: 1,
		});
	});
	it("完整恢复闭环分别保存预期和实际快照，文件删除后仍能读取实际历史", async () => {
		const context = await setupLateNativeCloseoutWithSkillAttachment();
		const expected = await captureRvfCloseoutExpectedSkillSnapshot({
			record: context.record,
			port: { request: mocked.request },
			text: "请用 $base-branch-sync",
			idempotencyKey: context.record.promptDeliveryIdempotencyKey,
		});
		const ledger: TaskMessageInjectionRecord[] = JSON.parse(await readFile(context.ledgerPath, "utf8"));
		const entry = ledger.find((item) => item.idempotency_key === context.record.promptDeliveryIdempotencyKey);
		if (!entry || !expected) throw new Error("缺少预期快照或投递");
		const actual = await captureRvfCloseoutAcceptedSkillSnapshot(context.record, {
			idempotencyKey: entry.idempotency_key,
			promptSha256: entry.prompt_sha256,
			createdAt: entry.created_at,
		});
		if (!actual) throw new Error("缺少实际快照");
		await rm(context.skill.path);
		const snapshots = await readRvfCloseoutSkillSnapshots({
			...context.record,
			skillAttachmentEvidenceHistory: [expected, actual],
		});
		expect(snapshots.map((item) => item.phase)).toEqual(["expected_installation", "accepted_native_expansion"]);
		expect(snapshots[1]?.skills[0]?.instructionText).toBe(context.skill.body);
	});
});

describe("完整恢复闭环：自动控制面与受控续验", () => {
	it.each([false, true])("RVF-004：续验准备瞬时失败后退避重试且不重复入队：原接受已知=%s", async (acceptanceKnown) => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		if (acceptanceKnown) {
			expect(
				await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request),
			).toMatchObject({ status: "recovered" });
			const summary = context.manager.getSummary();
			const endpoint = summary.codexNativeSessionControlEndpoint;
			summary.liveness = "exited";
			summary.pid = null;
			summary.codexNativeSessionControlEndpoint = undefined;
			await context.service.sweepPendingCloseoutsOnce();
			summary.liveness = "live";
			summary.pid = 123;
			summary.codexNativeSessionControlEndpoint = endpoint;
		} else {
			await context.writeNativeEvidence({ includeMessage: false });
			const originalTurn = context.activeTurns[1];
			if (!originalTurn) throw new Error("缺少原回合");
			originalTurn.items = [];
		}
		const originalRequest = mocked.request.getMockImplementation();
		if (!originalRequest) throw new Error("缺少隔离原生控制面");
		let preparationQueries = 0;
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/turns/list") {
				const saved = JSON.parse(
					await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"),
				);
				if (
					saved[0].automaticRecoveryProgress?.reasonCode ===
						"continuation_preparation_native_history_query_pending" &&
					++preparationQueries === 1
				)
					throw new Error("隔离续验准备首次查询超时");
			}
			return originalRequest(method, parameters);
		});
		const before = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			for (const offset of acceptanceKnown ? [48_000] : [0, 16_000, 32_000, 48_000]) {
				clock.mockReturnValue(now + offset);
				await context.service.sweepPendingCloseoutsOnce();
			}
			expect(preparationQueries).toBe(1);
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(before);
			const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			clock.mockReturnValue(now + 62_999);
			await restarted.sweepPendingCloseoutsOnce();
			expect(preparationQueries).toBe(1);
			clock.mockReturnValue(now + 64_000);
			await restarted.sweepPendingCloseoutsOnce();
			expect(preparationQueries).toBe(2);
			const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
			expect(saved[0].promptDeliveryAttempts).toHaveLength(1);
			expect(saved[0].automaticRecoveryProgress.continuationPreparationObservationBudget.count).toBe(2);
			await restarted.sweepPendingCloseoutsOnce();
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(before + 1);
		} finally {
			clock.mockRestore();
		}
	});
	it("RVF-004：续验准备持续查询失败共用持久三次预算，恢复服务能力不刷新同证据预算", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.writeNativeEvidence({ includeMessage: false });
		const originalTurn = context.activeTurns[1];
		if (!originalTurn) throw new Error("缺少原回合");
		originalTurn.items = [];
		const originalRequest = mocked.request.getMockImplementation();
		if (!originalRequest) throw new Error("缺少隔离原生控制面");
		let preparationQueries = 0;
		let controlUnavailable = true;
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/turns/list") {
				preparationQueries += 1;
				if (controlUnavailable) throw new Error("隔离续验准备控制面持续超时");
			}
			return originalRequest(method, parameters);
		});
		const before = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			for (const offset of [0, 16_000, 32_000, 48_000, 64_000, 80_000, 96_000]) {
				clock.mockReturnValue(now + offset);
				await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			}
			expect(preparationQueries).toBe(3);
			controlUnavailable = false;
			clock.mockReturnValue(now + 112_000);
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect(preparationQueries).toBe(3);
			const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
			expect(saved[0].automaticRecoveryProgress.continuationPreparationObservationBudget.count).toBe(3);
			expect(saved[0].promptDeliveryAttempts ?? []).toHaveLength(0);
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(before);
		} finally {
			clock.mockRestore();
		}
	});
	it("RVF-004：原接受预算耗尽后清空未提交草稿自动续验，原转录与失败账本保持不变", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.writeNativeEvidence({ includeMessage: false });
		const originalTurn = context.activeTurns[1];
		if (!originalTurn) throw new Error("缺少原回合");
		originalTurn.items = [];
		const transcriptBefore = await readFile(context.transcriptPath);
		const ledgerBefore = JSON.parse(await readFile(context.ledgerPath, "utf8")) as TaskMessageInjectionRecord[];
		context.manager.resolveTaskTerminalInputBoxOccupancy.mockResolvedValue({
			hasUncommittedInput: true,
			inputSideByteTrackingSaysNonEmpty: true,
			inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: false,
			screenReadingSaysNonEmpty: true,
			unrecoverablePasteCount: 0,
		});
		const before = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
		mocked.request.mockClear();
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			for (const offset of [0, 16_000, 32_000, 48_000]) {
				clock.mockReturnValue(now + offset);
				await context.service.sweepPendingCloseoutsOnce();
			}
			expect(mocked.request).not.toHaveBeenCalled();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(before);
			const waiting = JSON.parse(
				await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"),
			);
			expect(waiting[0].automaticRecoveryProgress).toMatchObject({
				reasonCode: "terminal_input_box_not_confirmed_empty",
				nativePromptAcceptanceVerificationReasonCode: "native_prompt_acceptance_not_proven",
			});
			context.manager.resolveTaskTerminalInputBoxOccupancy.mockResolvedValue({
				hasUncommittedInput: false,
				inputSideByteTrackingSaysNonEmpty: false,
				inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
				screenReadingSaysNonEmpty: false,
				unrecoverablePasteCount: 0,
			});
			clock.mockReturnValue(now + 64_000);
			const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			await restarted.sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(before + 1);
			const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
			expect(saved[0].promptDeliveryAttempts).toHaveLength(1);
			expect(saved[0].automaticRecoveryProgress.verificationAttemptCount).toBe(3);
			expect(await readFile(context.transcriptPath)).toEqual(transcriptBefore);
			const ledgerAfter = JSON.parse(await readFile(context.ledgerPath, "utf8")) as TaskMessageInjectionRecord[];
			expect(
				ledgerAfter.find((entry) => entry.idempotency_key === context.record.promptDeliveryIdempotencyKey),
			).toEqual(ledgerBefore.find((entry) => entry.idempotency_key === context.record.promptDeliveryIdempotencyKey));
			await restarted.sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(before + 1);
		} finally {
			clock.mockRestore();
		}
	});
	it("完整恢复闭环的同会话启动暂时失败会有界重试，跨 service 共用三次预算", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.writeNativeEvidence({ includeMessage: false });
		const summary = context.manager.getSummary();
		summary.liveness = "exited";
		summary.pid = null;
		summary.codexNativeSessionControlEndpoint = undefined;
		context.runtimeApi.startTaskSession.mockResolvedValue({ ok: false, summary: context.manager.getSummary() });
		const before = context.runtimeApi.startTaskSession.mock.calls.length;
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			for (const offset of [0, 16_000, 32_000, 48_000, 64_000]) {
				clock.mockReturnValue(now + offset);
				await context.service.sweepPendingCloseoutsOnce();
			}
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.startTaskSession.mock.calls.length - before).toBe(3);
		} finally {
			clock.mockRestore();
		}
	});
	it("完整恢复闭环在已补证转录后来丢失时保留收据并自动建立受控续验", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		const recovered = await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request);
		if (recovered.status !== "recovered") throw new Error("隔离原接受未恢复");
		await rm(context.transcriptPath);
		expect(
			await context.service.claimExecutionStage(context.scope, { ...context.request, stage: "land" }),
		).toMatchObject({ status: "waiting" });
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			for (const offset of [0, 16_000, 32_000, 48_000]) {
				clock.mockReturnValue(now + offset);
				await context.service.sweepPendingCloseoutsOnce();
			}
			const saved = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
			expect(saved[0].lateNativePromptAcceptanceRecoveryReceipt).toEqual(recovered.receipt);
			expect(saved[0].promptDeliveryAttempts).toHaveLength(1);
		} finally {
			clock.mockRestore();
		}
	});
	it("完整恢复闭环的续验入队失败使用持久三次预算，不因 service 重建无限重试", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.writeNativeEvidence({ includeMessage: false });
		const originalTurn = context.activeTurns[1];
		if (!originalTurn) throw new Error("缺少原回合");
		originalTurn.items = [];
		context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mockResolvedValue({
			ok: false,
			error: "隔离入队暂不可用",
		});
		const before = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			for (const offset of [0, 16_000, 32_000, 48_000, 64_000, 80_000, 96_000, 112_000]) {
				clock.mockReturnValue(now + offset);
				await context.service.sweepPendingCloseoutsOnce();
			}
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length - before).toBe(3);
		} finally {
			clock.mockRestore();
		}
	});
	it.each([false, true])(
		"完整恢复闭环自动恢复同一已退出原生会话，重启不重复启动：原接受已知=%s",
		async (acceptanceKnown) => {
			const context = await setupLateNativeCloseoutPromptAcceptance();
			if (acceptanceKnown)
				expect(
					await context.service.reconcileLateNativePromptAcceptance(context.scope, context.request),
				).toMatchObject({ status: "recovered" });
			else await context.writeNativeEvidence({ includeMessage: false });
			const summary = context.manager.getSummary();
			const endpoint = summary.codexNativeSessionControlEndpoint;
			summary.liveness = "exited";
			summary.pid = null;
			summary.codexNativeSessionControlEndpoint = undefined;
			const before = context.runtimeApi.startTaskSession.mock.calls.length;
			await context.service.sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.startTaskSession.mock.calls.length).toBe(before + 1);
			expect(context.runtimeApi.startTaskSession).toHaveBeenLastCalledWith(
				context.scope,
				expect.objectContaining({
					prompt: "",
					resumePriorAgentConversationWithoutResendingPrompt: true,
				}),
			);
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect(context.runtimeApi.startTaskSession.mock.calls.length).toBe(before + 1);
			if (acceptanceKnown) {
				summary.liveness = "live";
				summary.runtimeSessionIncarnationId = "known-acceptance-resumed-incarnation";
				if (!endpoint) throw new Error("缺少隔离原生控制面");
				summary.codexNativeSessionControlEndpoint = {
					...endpoint,
					runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
				};
				await context.service.sweepPendingCloseoutsOnce();
				const saved = JSON.parse(
					await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"),
				);
				expect(saved[0].promptDeliveryAttempts).toHaveLength(1);
			}
		},
	);
	it.each([false, true])(
		"完整恢复闭环为缺失接受创建至多一次续验，保留原键且跨重启不重复入队：工作区漂移=%s",
		async (workspaceChanged) => {
			const context = await setupLateNativeCloseoutPromptAcceptance();
			await context.writeNativeEvidence({ includeMessage: false });
			const originalTurn = context.activeTurns[1];
			if (!originalTurn) throw new Error("缺少原回合");
			const originalItems = originalTurn.items;
			originalTurn.items = [];
			if (workspaceChanged)
				await writeFile(join(context.repo.repositoryPath, "implementation.txt"), "续验准备前已有工作区漂移\n");
			const before = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
			const now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			try {
				for (const offset of [0, 16_000, 32_000, 48_000]) {
					clock.mockReturnValue(now + offset);
					await context.service.sweepPendingCloseoutsOnce();
				}
				const records = JSON.parse(
					await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"),
				);
				expect(records[0].promptDeliveryIdempotencyKey).toBe(context.record.promptDeliveryIdempotencyKey);
				expect(records[0].promptDeliveryAttempts).toHaveLength(1);
				expect(records[0].lateNativePromptAcceptanceRecoveryReceipt).toBeUndefined();
				expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(
					before + 1,
				);
				await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
				expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length).toBe(
					before + 1,
				);
				const attempt = records[0].promptDeliveryAttempts[0];
				if (workspaceChanged) {
					expect(attempt.purpose).toBe("inspect_existing_state");
					originalTurn.items = originalItems;
					await context.writeNativeEvidence();
					clock.mockReturnValue(now + 64_000);
					const recovered = (await context.service.status(context.scope, { taskId: "task" })).records[0];
					expect(recovered?.lateNativePromptAcceptanceRecoveryReceipt).toBeDefined();
					expect(recovered?.promptDeliveryAttempts).toHaveLength(1);
					return;
				}
				expect(attempt.purpose).toBe("execute_remaining_stages");
				const turnId = "accepted-continuation-turn";
				const messageId = "accepted-continuation-message";
				const content = [{ type: "text", text: attempt.promptText }];
				const eventRecords = [
					{
						type: "event_msg",
						timestamp: new Date(attempt.createdAt + 1000).toISOString(),
						payload: { type: "task_started", turn_id: turnId, turn_attribution: { turn_trigger: "user" } },
					},
					{
						type: "event_msg",
						timestamp: new Date(attempt.createdAt + 1002).toISOString(),
						payload: {
							type: "item_completed",
							turn_id: turnId,
							item: { type: "UserMessage", id: messageId, content },
						},
					},
				];
				await writeFile(
					context.transcriptPath,
					`${await readFile(context.transcriptPath, "utf8")}${eventRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				);
				context.activeTurns.push({
					id: turnId,
					status: "completed",
					items: [{ id: messageId, type: "userMessage", content }],
				});
				clock.mockReturnValue(attempt.createdAt + 2000);
				const request = {
					...context.request,
					stage: "land" as const,
					deliveryAttemptId: attempt.deliveryAttemptId,
				};
				const previousNativeRequest = mocked.request.getMockImplementation();
				if (!previousNativeRequest) throw new Error("缺少隔离原生控制面");
				mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
					const identity = context.manager.getSummary().agentNativeConversationSessionIdentity;
					if (identity) identity.observedAt += 1;
					return previousNativeRequest(method, parameters);
				});
				expect(await context.service.claimExecutionStage(context.scope, request)).toMatchObject({
					status: "claimed",
				});
				const originalTranscript = await readFile(context.transcriptPath, "utf8");
				const rewrittenRecords = originalTranscript
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				rewrittenRecords[0].payload.historyMarker = "隔离历史前缀被改写";
				await writeFile(
					context.transcriptPath,
					`${rewrittenRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				);
				expect(await context.service.claimExecutionStage(context.scope, request)).toMatchObject({
					status: "waiting",
				});
				await writeFile(context.transcriptPath, originalTranscript);
				await writeFile(join(context.repo.repositoryPath, "implementation.txt"), "续验排队后出现新的工作区改动\n");
				expect(await context.service.claimExecutionStage(context.scope, request)).toMatchObject({
					status: "waiting",
				});
				const inspected = JSON.parse(
					await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"),
				);
				expect(inspected[0].promptDeliveryAttempts[0].executionRequiresReadOnlyInspection).toBe(true);
			} finally {
				clock.mockRestore();
			}
		},
	);
});

it("完整恢复闭环的预算耗尽后 service 重建不能重新获得三次尝试", async () => {
	const context = await setupLateNativeCloseoutPromptAcceptance();
	mocked.request.mockRejectedValue(new Error("暂不可读"));
	mocked.request.mockClear();
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		for (const offset of [0, 16_000, 32_000, 48_000]) {
			clock.mockReturnValue(now + offset);
			await context.service.sweepPendingCloseoutsOnce();
		}
		const count = mocked.request.mock.calls.filter((call) => call[0] === "thread/loaded/list").length;
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/loaded/list")).toHaveLength(count);
		expect(count).toBe(3);
	} finally {
		clock.mockRestore();
	}
});

it("完整恢复闭环只按事件绑定的 Git 版本恢复旧手册，保留完整换行并拒绝错误摘要", async () => {
	const context = await setupLateNativeCloseoutPromptAcceptance();
	const path = join(context.repo.repositoryPath, "historical-closeout-SKILL.md");
	const instructionText = "旧版本手册，保留尾部换行。\n\n";
	await writeFile(path, instructionText);
	context.repo.commitAllRepositoryFilesAtDate({
		message: "隔离历史手册",
		authorAndCommitterIsoDate: "2026-01-03T00:00:00Z",
	});
	const reference = await captureRvfCloseoutSkillInstallationVersionReference({
		record: context.record,
		idempotencyKey: context.record.promptDeliveryIdempotencyKey,
		promptSha256: computeRvfTextSha256(buildRvfAutomaticCloseoutPrompt(context.record)),
		skill: {
			referenceName: "base-branch-sync",
			referencePath: path,
			canonicalName: "base-branch-sync",
			canonicalPath: path,
			realPath: path,
			instructionText,
		},
	});
	expect(reference.gitVersion).toBeDefined();
	await rm(path);
	const snapshots = await readRvfCloseoutSkillSnapshots({
		...context.record,
		skillInstallationVersionReferences: [reference],
	});
	expect(snapshots[0]?.skills[0]?.instructionText).toBe(instructionText);
	expect(
		await readRvfCloseoutSkillSnapshots({
			...context.record,
			skillInstallationVersionReferences: [{ ...reference, instructionSha256: "0".repeat(64) }],
		}),
	).toEqual([]);
});

it("完整恢复闭环不把 Git 中损坏的 UTF-8 blob 误绑到有效安装正文", async () => {
	const context = await setupLateNativeCloseoutPromptAcceptance();
	const path = join(context.repo.repositoryPath, "historical-invalid-utf8-closeout-SKILL.md");
	await writeFile(path, Buffer.from([0xf0, 0x9f, 0x92]));
	context.repo.commitAllRepositoryFilesAtDate({
		message: "隔离损坏的历史 blob",
		authorAndCommitterIsoDate: "2026-01-03T00:00:00Z",
	});
	await writeFile(path, "\ufffd");
	const reference = await captureRvfCloseoutSkillInstallationVersionReference({
		record: context.record,
		idempotencyKey: context.record.promptDeliveryIdempotencyKey,
		promptSha256: "a".repeat(64),
		skill: {
			referenceName: "base-branch-sync",
			referencePath: path,
			canonicalName: "base-branch-sync",
			canonicalPath: path,
			realPath: path,
			instructionText: "\ufffd",
		},
	});
	expect(reference.gitVersion).toBeUndefined();
});

it.each(["native_fork", "restore_start"])(
	"长期服务仍存活时 %s 区分已登记暂停与真实 unknown，并以原生事实补证",
	async (failureStage) => {
		const context = await setup();
		await context.complete();
		if (failureStage === "restore_start")
			context.runtimeApi.startTaskSession.mockRejectedValueOnce(new Error("原生恢复响应未知"));
		else {
			const originalRequest = mocked.request.getMockImplementation();
			mocked.request.mockImplementation(async (method: string, input: Record<string, unknown>) => {
				if (method === "thread/fork") throw new Error("原生 fork 响应未知");
				return originalRequest?.(method, input);
			});
		}
		await context.service.sweepPendingCloseoutsOnce();
		const control = join(
			context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim(),
			"rvf-independent-backup-route",
		);
		const reservations = join(control, "normal-mutations");
		if (failureStage === "native_fork") {
			expect(await readdir(reservations)).toEqual([]);
			const [record] = JSON.parse(
				await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"),
			);
			expect(record.status).toBe("paused");
			expect(record.pauseReason).toContain("原生 fork 未确认");
			expect(record.nativeForkAttemptStartedAt).toBeTypeOf("number");
			await context.service.sweepPendingCloseoutsOnce();
			expect(mocked.request.mock.calls.filter(([method]) => method === "thread/fork")).toHaveLength(1);
			expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
			return;
		}
		const [name] = await readdir(reservations);
		if (!name) throw new Error("缺少未知操作的登记");
		const reservationBefore = JSON.parse(await readFile(join(reservations, name), "utf8"));
		expect(reservationBefore).toMatchObject({ pid: process.pid, outcome: "unknown" });
		await mkdir(join(control, "active-owner"));
		const transcriptPath = join(context.fixture.fixtureRootDirectoryPath, "unknown-operation-native-evidence.jsonl");
		await writeFile(transcriptPath, "尚无原生静止证据\n");
		const summary = context.manager.getSummary();
		const expectedNativeSessionId = failureStage === "restore_start" ? "restored" : "native";
		Object.assign(summary, {
			runtimeSessionIncarnationId: "restored-incarnation",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: expectedNativeSessionId,
				transcriptPath,
				observedAt: Date.now(),
			},
			codexNativeSessionControlEndpoint: {
				workspaceId: context.scope.workspaceId,
				conversationSessionId: "task",
				runtimeSessionIncarnationId: "restored-incarnation",
				socketPath: "/isolated-control",
			},
		});
		await updateRvfAutomaticCloseoutRecords(
			getRvfAutomaticCloseoutStorePath(context.scope.workspaceId),
			(records) => ({
				records: records.map((record) => ({ ...record, restoredTranscriptPath: transcriptPath })),
				value: undefined,
			}),
		);
		let nativeIdleVerified = false;
		mocked.request.mockImplementation(async (method: string) => {
			if (method === "thread/loaded/list") return { data: [expectedNativeSessionId], nextCursor: null };
			if (method === "thread/read")
				return {
					thread: {
						id: expectedNativeSessionId,
						status: { type: nativeIdleVerified ? "idle" : "active" },
						canAcceptDirectInput: nativeIdleVerified,
					},
				};
			return {
				data: [{ id: "implementation", status: nativeIdleVerified ? "completed" : "inProgress", items: [] }],
				nextCursor: null,
			};
		});
		await context.service.sweepPendingCloseoutsOnce();
		expect(await readdir(reservations)).toContain(name);
		const requestsAfterUnproven = mocked.request.mock.calls.length;
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(mocked.request.mock.calls).toHaveLength(requestsAfterUnproven);
		nativeIdleVerified = true;
		await writeFile(transcriptPath, "原生回合已完成，控制面可直接接受输入\n");
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(await readdir(reservations)).not.toContain(name);
		const reconciledBytes = await readFile(join(control, "reconciled-normal-mutations", name));
		const reconciled = JSON.parse(reconciledBytes.toString("utf8"));
		if (process.env.KANBAN_EMIT_ISOLATED_NORMAL_CLOSEOUT_RESERVATION_FOR_INTEROPERABILITY === "1")
			process.stdout.write(`隔离 Node reservation 原始字节（base64）：${reconciledBytes.toString("base64")}\n`);
		expect(reconciled).toMatchObject({
			outcome: "unknown",
			operation_state: "settled",
			native_outcome_evidence: {
				schema: "kanban-normal-closeout-quiescence/v1",
				native_control_verified_idle: true,
				queued_delivery_absent: true,
				terminal_delivery_pending: false,
			},
		});
		expect(context.runtimeApi.startTaskSession).toHaveBeenCalledTimes(failureStage === "restore_start" ? 1 : 0);
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
	},
);

it.each(["confirmed", "failed"])("实际投递 reservation 跨过临写预检，收到 %s 终态后才结算", async (outcome) => {
	const context = await setup();
	await context.complete();
	await context.service.sweepPendingCloseoutsOnce();
	const [record] = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
	const input = {
		taskId: record.conversationSessionId,
		source: "rvf_automatic_closeout",
		idempotencyKey: record.promptDeliveryIdempotencyKey,
	};
	const control = join(
		context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim(),
		"rvf-independent-backup-route",
	);
	const directory = join(control, "normal-mutations");
	await context.service.validateCloseoutPromptDelivery(context.scope, input, "before_first_transport_write");
	const [name] = await readdir(directory);
	expect(name).toBeDefined();
	if (outcome === "failed") {
		await mkdir(join(control, "active-owner"));
		await expect(
			context.service.validateCloseoutPromptDelivery(context.scope, input, "after_transport_write"),
		).rejects.toThrow("备用路线");
		await context.service.settleCloseoutPromptTerminalDelivery(context.scope, input, false);
		const value = JSON.parse(await readFile(join(directory, name as string), "utf8"));
		expect(value).toMatchObject({
			operation_kind: "terminal_delivery",
			operation_state: "settled",
			outcome: "unknown",
		});
	} else {
		await context.service.settleCloseoutPromptTerminalDelivery(context.scope, input, true);
		expect(await readdir(directory)).toEqual([]);
	}
});

it("首次实际写入前已接管时拒绝且不遗留没有开始的终端 reservation", async () => {
	const context = await setup();
	await context.complete();
	await context.service.sweepPendingCloseoutsOnce();
	const [record] = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
	const control = join(
		context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim(),
		"rvf-independent-backup-route",
	);
	await mkdir(join(control, "active-owner"));
	await expect(
		context.service.validateCloseoutPromptDelivery(
			context.scope,
			{
				taskId: record.conversationSessionId,
				source: "rvf_automatic_closeout",
				idempotencyKey: record.promptDeliveryIdempotencyKey,
			},
			"before_first_transport_write",
		),
	).rejects.toThrow("备用路线");
	expect(await readdir(join(control, "normal-mutations"))).toEqual([]);
});

it.each(["active", "consumed"])("排队后的实际临写出口在备用 %s 状态拒绝旧收尾投递", async (kind) => {
	const context = await setup();
	await context.complete();
	await context.service.sweepPendingCloseoutsOnce();
	const [record] = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
	expect(record.waitingReasonCode).toBe("closeout_delivery_confirmation_pending");
	const control = join(
		context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim(),
		"rvf-independent-backup-route",
	);
	if (kind === "active") await mkdir(join(control, "active-owner"), { recursive: true });
	else {
		await mkdir(join(control, "consumed-original-runs"), { recursive: true });
		await writeFile(join(control, "consumed-original-runs", `${computeRvfTextSha256(context.run)}.json`), "消费事实");
	}
	await expect(
		context.service.validateCloseoutPromptDelivery(context.scope, {
			taskId: record.conversationSessionId,
			source: "rvf_automatic_closeout",
			idempotencyKey: record.promptDeliveryIdempotencyKey,
		}),
	).rejects.toThrow("备用路线");
});

it.each(["active", "consumed"])("备用 %s 状态仍记录接管前的真实原生接受且保留失败历史", async (kind) => {
	const context = await setupLateNativeCloseoutPromptAcceptance();
	const ledgerBefore = await readFile(context.ledgerPath);
	const transcriptBefore = await readFile(context.transcriptPath);
	const control = join(
		context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim(),
		"rvf-independent-backup-route",
	);
	if (kind === "active") await mkdir(join(control, "active-owner"), { recursive: true });
	else {
		await mkdir(join(control, "consumed-original-runs"), { recursive: true });
		await writeFile(join(control, "consumed-original-runs", `${computeRvfTextSha256(context.run)}.json`), "消费事实");
	}
	const beforeEnqueues = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
	const beforeStarts = context.runtimeApi.startTaskSession.mock.calls.length;
	await context.service.sweepPendingCloseoutsOnce();
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	const [record] = JSON.parse(await readFile(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), "utf8"));
	expect(record.lateNativePromptAcceptanceRecoveryReceipt).toMatchObject({
		previousPauseReason: "收尾投递失败：submit_confirmation_budget_exhausted",
		originalDeliveryFailure: { status: "delivery_failed", failureReason: "submit_confirmation_budget_exhausted" },
		nativeUserMessageId: "closeout-native-user-message",
	});
	expect(await readFile(context.ledgerPath)).toEqual(ledgerBefore);
	expect(await readFile(context.transcriptPath)).toEqual(transcriptBefore);
	expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls).toHaveLength(beforeEnqueues);
	expect(context.runtimeApi.startTaskSession.mock.calls).toHaveLength(beforeStarts);
	expect(record.landExecutionResult).toBeUndefined();
	expect(record.baseBranchSyncExecutionResult).toBeUndefined();
	expect(record.independentBackupRouteSuppressionObservation).toBeDefined();
});

it.each(["active", "consumed"])("完整恢复闭环在备用 %s 状态不恢复或重派原 run", async (kind) => {
	const context = await setupLateNativeCloseoutPromptAcceptance();
	await context.writeNativeEvidence({ includeMessage: false });
	const originalTurn = context.activeTurns[1];
	if (!originalTurn) throw new Error("缺少隔离原回合");
	originalTurn.items = [];
	const gitDirectory = context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim();
	const control = join(gitDirectory, "rvf-independent-backup-route");
	if (kind === "active") await mkdir(join(control, "active-owner"), { recursive: true });
	else {
		const consumed = join(control, "consumed-original-runs");
		await mkdir(consumed, { recursive: true });
		await writeFile(join(consumed, `${computeRvfTextSha256(context.run)}.json`), "合成备用完成事实");
	}
	const store = getRvfAutomaticCloseoutStorePath(context.scope.workspaceId);
	const [beforeRecord] = JSON.parse(await readFile(store, "utf8"));
	const beforeEnqueues = context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls.length;
	await context.service.sweepPendingCloseoutsOnce();
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	const [record] = JSON.parse(await readFile(store, "utf8"));
	expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mock.calls).toHaveLength(beforeEnqueues);
	expect(record.status).toBe(beforeRecord.status);
	expect(record.pauseReason).toBe(beforeRecord.pauseReason);
	expect(record.promptDeliveryAttempts).toEqual(beforeRecord.promptDeliveryAttempts);
	expect(record.landExecutionResult).toEqual(beforeRecord.landExecutionResult);
	expect(record.baseBranchSyncExecutionResult).toEqual(beforeRecord.baseBranchSyncExecutionResult);
	expect(record.independentBackupRouteSuppressionObservation).toMatchObject({
		originalRunDirectory: context.run,
		reason: kind === "active" ? "active_backup_route_ownership" : "original_run_consumed_by_backup_route",
	});
});

async function setupIdleGateRecoveryNativeEvidence() {
	const context = await setup();
	const summary = context.manager.getSummary();
	const transcriptPath = join(context.fixture.fixtureRootDirectoryPath, "idle-gate-native.jsonl");
	context.captured.receipt.transcript_path = transcriptPath;
	summary.runtimeSessionIncarnationId = "idle-gate-incarnation";
	summary.agentNativeConversationSessionIdentity = {
		sourceAgentId: "codex",
		nativeSessionId: "native",
		transcriptPath,
		observedAt: 1,
	};
	summary.codexNativeSessionControlEndpoint = {
		workspaceId: context.scope.workspaceId,
		conversationSessionId: summary.taskId,
		runtimeSessionIncarnationId: "idle-gate-incarnation",
		socketPath: "/isolated-idle-gate-control",
	};
	summary.turnOwner = "agent";
	summary.userTurnKind = null;
	summary.agentConversationPromptSubmissionAcceptance = {
		status: "unconfirmed",
		attemptedAtMs: Date.now() - 1000,
		runtimeSessionIncarnationId: "idle-gate-incarnation",
	};
	const recordedAt = new Date().toISOString();
	const text = context.source[1]?.items[0]?.content[0]?.text ?? "";
	const nativeRecords = [
		{
			type: "session_meta",
			payload: { id: "native", originator: "codex-tui", source: "cli", cwd: context.repo.repositoryPath },
		},
		{
			type: "event_msg",
			timestamp: recordedAt,
			payload: { type: "task_started", turn_id: "boundary", turn_attribution: { turn_trigger: "user" } },
		},
		{
			type: "event_msg",
			timestamp: recordedAt,
			payload: {
				type: "item_completed",
				turn_id: "boundary",
				item: { id: "boundary-message", type: "UserMessage", content: [{ type: "text", text }] },
			},
		},
	];
	const writeTranscript = () =>
		writeFile(transcriptPath, `${nativeRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	await writeTranscript();
	await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), (records) => ({
		records: records.map((entry) => ({ ...entry, receipt: context.captured.receipt })),
		value: null,
	}));
	const ledgerPath = getTaskMessageInjectionLedgerPath(mocked.directory);
	const boundaryLedger: TaskMessageInjectionRecord = {
		task_id: "task",
		source: "review-validate-fix",
		idempotency_key: context.captured.receipt.idempotency_key,
		prompt_sha256: computeRvfTextSha256(text),
		message_id: "ledger-message",
		created_at: new Date(Date.now() - 1500).toISOString(),
		terminal_delivery_status: "delivery_failed",
		terminal_delivery_failure_reason: "codex_native_prompt_delivery_unconfirmed",
		terminal_delivery_status_updated_at: recordedAt,
		codex_native_prompt_delivery_evidence: {
			clientUserMessageId: "client-message",
			nativeSessionId: "native",
			nativeTurnId: "boundary",
			nativeUserMessageId: "boundary-message",
		},
	};
	await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({ records: [boundaryLedger], result: null }));
	const fallback = mocked.request.getMockImplementation();
	let nativeAvailable = true;
	let turnStatus = "completed";
	let activeFlags: string[] = [];
	let canAcceptDirectInput = true;
	mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
		if ((method === "thread/read" || method === "thread/loaded/list") && !nativeAvailable)
			throw new Error("隔离的暂时断线");
		if (method === "thread/loaded/list") return { data: ["native"], nextCursor: null };
		if (method === "thread/read")
			return { thread: { id: "native", status: { type: "idle", activeFlags }, canAcceptDirectInput } };
		if (method === "thread/turns/list" && parameters.sortDirection === "desc")
			return {
				data: turnStatus === "empty" ? [] : [{ ...context.source.at(-1), status: turnStatus }],
				nextCursor: null,
			};
		return fallback?.(method, parameters);
	});
	await context.complete();
	const state = async () => (await context.service.status(context.scope, { taskId: "task" })).records[0];
	return {
		...context,
		summary,
		nativeRecords,
		writeTranscript,
		transcriptPath,
		ledgerPath,
		boundaryLedger,
		state,
		setNativeAvailable: (available: boolean) => {
			nativeAvailable = available;
		},
		setNativeTurnStatus: (status: string) => {
			turnStatus = status;
		},
		setActiveFlags: (flags: string[]) => {
			activeFlags = flags;
		},
		setCanAcceptDirectInput: (canAccept: boolean) => {
			canAcceptDirectInput = canAccept;
		},
	};
}

describe("RVF 完成后空闲门禁的原生补证与自动接续", () => {
	it("接受漏报与陈旧 agent 投影只补恢复资格，跨重启仅 fork、切换及投递一次", async () => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		const ledgerBefore = (await readTaskMessageInjectionLedger(context.ledgerPath))[0];
		const acceptanceBefore = structuredClone(context.summary.agentConversationPromptSubmissionAcceptance);
		const activityBefore = context.summary.lastEffectiveAgentConversationActivityObservation;
		await context.service.sweepPendingCloseoutsOnce();
		const recovery = (await context.state())?.preReviewConversationRestoreIdleGateRecovery;
		expect(recovery).toMatchObject({
			status: "qualified",
			attemptCount: 1,
			blockingConditions: [
				"turn_owner_not_user",
				"user_turn_kind_not_review",
				"current_process_prompt_acceptance_unconfirmed",
			],
			qualification: { acceptedNativeUserMessageId: "boundary-message", nativeCompletedTurnId: "boundary" },
		});
		expect((await readTaskMessageInjectionLedger(context.ledgerPath))[0]).toEqual(ledgerBefore);
		expect(context.summary.agentConversationPromptSubmissionAcceptance).toEqual(acceptanceBefore);
		expect(context.summary.lastEffectiveAgentConversationActivityObservation).toEqual(activityBefore);
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledOnce();
		expect(context.runtimeApi.startTaskSession).toHaveBeenCalledOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
	});
	it.each(["failed", "interrupted", "inProgress", "empty"])("最新回合 %s 不作为完成证明", async (status) => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		context.setNativeTurnStatus(status);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.lastFailureCode).toBe(
			"native_completed_idle_input_ready_not_proven",
		);
	});
	it.each(["waitingOnApproval", "waitingOnUserInput", "input_unavailable"])(
		"原生 %s 继续阻止恢复",
		async (condition) => {
			const context = await setupIdleGateRecoveryNativeEvidence();
			if (condition === "input_unavailable") context.setCanAcceptDirectInput(false);
			else context.setActiveFlags([condition]);
			await context.service.sweepPendingCloseoutsOnce();
			expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		},
	);
	it("完整补证三次预算与 60 秒健康探测跨重启保留，端点恢复后自动接续", async () => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		context.setNativeAvailable(false);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		onTestFinished(() => clock.mockRestore());
		for (let attempt = 1; attempt <= 3; attempt++) {
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.attemptCount).toBe(attempt);
			now += 15_000;
		}
		const countBeforeHealthProbe = mocked.controlEndpoint.mock.calls.length;
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(mocked.controlEndpoint).toHaveBeenCalledTimes(countBeforeHealthProbe);
		context.setNativeAvailable(true);
		now += 60_000;
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
	});
	it.each(["question", "plan_review", "permission", "needs_input"] as const)(
		"真实 %s 待答不启动补证",
		async (kind) => {
			const context = await setupIdleGateRecoveryNativeEvidence();
			context.summary.turnOwner = "user";
			context.summary.userTurnKind = kind;
			mocked.controlEndpoint.mockClear();
			await context.service.sweepPendingCloseoutsOnce();
			expect(mocked.controlEndpoint).not.toHaveBeenCalled();
			expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.blockingConditions).toContain(
				"user_turn_kind_not_review",
			);
		},
	);
	it.each(["park", "in_flight", "starting", "draft"])("%s 条件不能由原生完成证据覆盖", async (condition) => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		if (condition === "park")
			context.manager.getAwaitingDispatchedBackgroundWork = () => ({ parked: true, label: null, sinceMs: null });
		if (condition === "in_flight") context.manager.hasPendingProgrammaticTaskChatInputDelivery.mockReturnValue(true);
		if (condition === "starting") context.summary.liveness = "starting";
		if (condition === "draft") {
			const occupancy = await context.manager.resolveTaskTerminalInputBoxOccupancy("task");
			if (!occupancy) throw new Error("缺少输入框观测");
			context.manager.resolveTaskTerminalInputBoxOccupancy.mockResolvedValue({
				...occupancy,
				hasUncommittedInput: true,
			});
		}
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(0);
	});
	it.each(["message_id", "digest", "timestamp", "duplicate", "human_input"])(
		"拒绝 %s 歧义或不属于本次提交的接受证据",
		async (condition) => {
			const context = await setupIdleGateRecoveryNativeEvidence();
			if (condition === "human_input")
				context.summary.agentConversationPromptSubmissionAcceptance = {
					status: "unconfirmed",
					attemptedAtMs: Date.now() + 2000,
					runtimeSessionIncarnationId: "idle-gate-incarnation",
				};
			else
				await withTaskMessageInjectionLedgerLock(context.ledgerPath, async (records) => ({
					records: records.flatMap((entry) => {
						if (condition === "message_id")
							return [
								{
									...entry,
									codex_native_prompt_delivery_evidence: {
										clientUserMessageId: "client-message",
										nativeSessionId: "native",
										nativeTurnId: "boundary",
										nativeUserMessageId: "other-message",
									},
								},
							];
						if (condition === "digest") return [{ ...entry, prompt_sha256: "wrong-digest" }];
						if (condition === "timestamp")
							return [{ ...entry, created_at: new Date(Date.now() + 60_000).toISOString() }];
						return [entry, { ...entry }];
					}),
					result: null,
				}));
			await context.service.sweepPendingCloseoutsOnce();
			expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		},
	);
	it.each(["submission", "identity", "new_turn", "park", "stop", "new_run"])(
		"原生查询期间出现 %s 使旧资格失效，fork 前保留现场",
		async (condition) => {
			const context = await setupIdleGateRecoveryNativeEvidence();
			const original = mocked.request.getMockImplementation();
			let changed = false;
			mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
				const result = await original?.(method, parameters);
				if (method === "thread/read" && !changed) {
					changed = true;
					if (condition === "submission")
						context.summary.agentConversationPromptSubmissionAcceptance = {
							status: "pending",
							attemptedAtMs: Date.now() + 1000,
							runtimeSessionIncarnationId: "idle-gate-incarnation",
						};
					if (condition === "identity") context.summary.runtimeSessionIncarnationId = "replacement-incarnation";
					if (condition === "new_turn") context.summary.agentResponseGenerationTurnSequence = 999;
					if (condition === "park")
						context.manager.getAwaitingDispatchedBackgroundWork = () => ({
							parked: true,
							label: null,
							sinceMs: null,
						});
					if (condition === "stop") await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
					if (condition === "new_run") {
						const contextState = await context.state();
						if (!contextState) throw new Error("缺少原恢复记录");
						await updateRvfAutomaticCloseoutRecords(
							getRvfAutomaticCloseoutStorePath(context.scope.workspaceId),
							(records) => ({
								records: [
									...records,
									{
										...contextState,
										receipt: { ...contextState.receipt, decision_token: "fedcba9876543210" },
										createdAt: Date.now() + 1,
										status: "captured_review_start_boundary",
									},
								],
								value: null,
							}),
						);
					}
				}
				return result;
			});
			await context.service.sweepPendingCloseoutsOnce();
			expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
			expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(0);
		},
	);
	it("独立记录进程、回合、待答、本代提交、停放和在途投递的组合阻塞", async () => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		context.summary.liveness = "starting";
		expect(
			collectPreReviewConversationRestoreIdleGateBlockers({
				summary: context.summary,
				backgroundWorkParked: true,
				programmaticDeliveryInFlight: true,
			}),
		).toEqual([
			"process_liveness_not_ready",
			"turn_owner_not_user",
			"user_turn_kind_not_review",
			"background_work_parked",
			"programmatic_delivery_in_flight",
		]);
	});
});

it("空闲资格已确认但停止前出现人工输入时保留已创建的唯一 fork，后续不复用旧接受证明", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const originalRequest = mocked.request.getMockImplementation();
	mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
		const result = await originalRequest?.(method, parameters);
		if (method === "thread/fork")
			context.summary.agentConversationPromptSubmissionAcceptance = {
				status: "pending",
				attemptedAtMs: Date.now() + 1000,
				runtimeSessionIncarnationId: "idle-gate-incarnation",
			};
		return result;
	});
	await context.service.sweepPendingCloseoutsOnce();
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	expect((await context.state())?.restoredNativeSessionId).toBe("restored");
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
});
it("同一健康状态下完整消息查询中断，能力恢复后有界重试并自动继续", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const originalRequest = mocked.request.getMockImplementation();
	let completeQueryAvailable = false;
	mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
		if (method === "thread/turns/list" && parameters.itemsView === "full" && !completeQueryAvailable)
			throw new Error("隔离的完整消息查询断线");
		return originalRequest?.(method, parameters);
	});
	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	onTestFinished(() => clock.mockRestore());
	for (let attempt = 0; attempt < 3; attempt++) {
		await context.service.sweepPendingCloseoutsOnce();
		now += 15_000;
	}
	expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.attemptCount).toBe(3);
	completeQueryAvailable = true;
	now += 60_000;
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
});

it.each(["request_failure", "incomplete_response"])(
	"后续历史分页 %s 时只探测失败 cursor，跨重启恢复后同端点自动取得完整资格",
	async (failureMode) => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		const originalRequest = mocked.request.getMockImplementation();
		let secondPageAvailable = false;
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/turns/list" && parameters.threadId === "native" && parameters.sortDirection === "asc") {
				if (parameters.cursor === null)
					return { data: context.source.slice(0, 1), nextCursor: "second-history-page" };
				if (parameters.cursor === "second-history-page") {
					if (!secondPageAvailable) {
						if (failureMode === "request_failure") throw new Error("隔离的后续历史分页断线");
						return { data: [{ id: "boundary", status: "completed" }], nextCursor: null };
					}
					return { data: context.source.slice(1), nextCursor: null };
				}
			}
			return originalRequest?.(method, parameters);
		});
		mocked.request.mockClear();
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		onTestFinished(() => clock.mockRestore());
		for (let attempt = 0; attempt < 3; attempt++) {
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			now += 15_000;
		}
		const firstPageReads = () =>
			mocked.request.mock.calls.filter(
				([method, parameters]) =>
					method === "thread/turns/list" && parameters.sortDirection === "asc" && parameters.cursor === null,
			).length;
		expect(firstPageReads()).toBe(3);
		const evidenceBeforeRecovery = (await context.state())?.preReviewConversationRestoreIdleGateRecovery
			?.evidenceFingerprint;
		for (let probe = 0; probe < 2; probe++) {
			now += 60_000;
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect(firstPageReads()).toBe(3);
			expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery).toMatchObject({
				attemptCount: 3,
				failedNativeConversationTurnHistoryPageRead: {
					cursor: "second-history-page",
					lastCapabilityProbeAtMs: now,
					lastCapabilityProbeStatus: "unavailable",
				},
			});
			expect(
				mocked.request.mock.calls.filter(([, parameters]) => parameters.cursor === "second-history-page"),
			).toHaveLength(4 + probe);
		}
		secondPageAvailable = true;
		now += 60_000;
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery).toMatchObject({
			status: "qualified",
			evidenceFingerprint: evidenceBeforeRecovery,
			failedNativeConversationTurnHistoryPageRead: null,
			qualification: { acceptedNativeUserMessageId: "boundary-message", nativeCompletedTurnId: "boundary" },
		});
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	},
);

it.each(["draft", "park", "in_flight"])(
	"运行时条件等待 %s 不消耗补证预算，解除后同端点自动重新取证",
	async (condition) => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		const originalRequest = mocked.request.getMockImplementation();
		const originalOccupancy = context.manager.resolveTaskTerminalInputBoxOccupancy.getMockImplementation();
		let runtimeConditionActive = false;
		let introduceConditionDuringNativeQuery = true;
		mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
			const result = await originalRequest?.(method, parameters);
			if (method === "thread/read" && introduceConditionDuringNativeQuery) runtimeConditionActive = true;
			return result;
		});
		context.manager.getAwaitingDispatchedBackgroundWork = () => ({
			parked: condition === "park" && runtimeConditionActive,
			label: null,
			sinceMs: null,
		});
		context.manager.hasPendingProgrammaticTaskChatInputDelivery.mockImplementation(
			() => condition === "in_flight" && runtimeConditionActive,
		);
		context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementation(async (taskId) => {
			const occupancy = await originalOccupancy?.(taskId);
			if (!occupancy) return null;
			return { ...occupancy, hasUncommittedInput: condition === "draft" && runtimeConditionActive };
		});
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		onTestFinished(() => clock.mockRestore());
		for (let attempt = 0; attempt < 3; attempt++) {
			runtimeConditionActive = false;
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery).toMatchObject({
				status: "waiting_for_runtime_conditions",
				attemptCount: 0,
				lastFailureCode: null,
				resumeCondition: "runtime_guards_clear",
			});
			now += 15_000;
		}
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		introduceConditionDuringNativeQuery = false;
		runtimeConditionActive = false;
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	},
);

it("运行时条件等待中的持续草稿不查询原生证据，清空后无需更换证据指纹便继续", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const originalOccupancy = context.manager.resolveTaskTerminalInputBoxOccupancy.getMockImplementation();
	let draftPresent = true;
	context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementation(async (taskId) => {
		const occupancy = await originalOccupancy?.(taskId);
		return occupancy ? { ...occupancy, hasUncommittedInput: draftPresent } : null;
	});
	mocked.controlEndpoint.mockClear();
	for (let attempt = 0; attempt < 4; attempt++)
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect(mocked.controlEndpoint).not.toHaveBeenCalled();
	expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.attemptCount).toBe(0);
	const fingerprintWhileWaiting = (await context.state())?.preReviewConversationRestoreIdleGateRecovery
		?.evidenceFingerprint;
	draftPresent = false;
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.evidenceFingerprint).toBe(
		fingerprintWhileWaiting,
	);
	expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
});

it("运行时条件等待解除可恢复历史上已耗尽且健康指纹未变的补证预算", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const originalOccupancy = context.manager.resolveTaskTerminalInputBoxOccupancy.getMockImplementation();
	let draftPresent = true;
	context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementation(async (taskId) => {
		const occupancy = await originalOccupancy?.(taskId);
		return occupancy ? { ...occupancy, hasUncommittedInput: draftPresent } : null;
	});
	await context.service.sweepPendingCloseoutsOnce();
	const recoveryWhileWaiting = (await context.state())?.preReviewConversationRestoreIdleGateRecovery;
	if (!recoveryWhileWaiting) throw new Error("缺少运行时等待补证记录");
	await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), (records) => ({
		records: records.map((record) => ({
			...record,
			preReviewConversationRestoreIdleGateRecovery: {
				...recoveryWhileWaiting,
				status: "waiting_for_evidence_change",
				attemptCount: 3,
				lastFailureCode: "native_evidence_query_unavailable",
				lastNativeHealthFingerprint: JSON.stringify([
					JSON.stringify(["boundary", "completed", "idle", [], true]),
					"ready",
				]),
				nextProbeAtMs: Date.now() + 60_000,
			},
		})),
		value: null,
	}));
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.status).toBe(
		"waiting_for_runtime_conditions",
	);
	draftPresent = false;
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
	expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
});

it("原生补证预算耗尽后的内部等待保留原失败原因，不再被 catch 分类为查询失败", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	context.setNativeTurnStatus("failed");
	let now = Date.now();
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	onTestFinished(() => clock.mockRestore());
	for (let attempt = 0; attempt < 3; attempt++) {
		await context.service.sweepPendingCloseoutsOnce();
		now += 15_000;
	}
	const nativeFailureCode = (await context.state())?.preReviewConversationRestoreIdleGateRecovery?.lastFailureCode;
	expect(nativeFailureCode).toBe("native_completed_idle_input_ready_not_proven");
	for (let probe = 0; probe < 2; probe++) {
		now += 60_000;
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery).toMatchObject({
			status: "waiting_for_evidence_change",
			attemptCount: 3,
			lastFailureCode: nativeFailureCode,
		});
	}
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
});
it("本 run 明确绑定的程序化续跑凭原生消息 ID、摘要与时间完成接受补证", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const text = `RVF_DECISION_TOKEN=${context.token}\nrun_id=run\n继续本轮审查`;
	context.source.push({
		id: "continuation",
		status: "completed",
		items: [{ id: "continuation-message", type: "userMessage", content: [{ type: "text", text }] }],
	});
	const time = new Date().toISOString();
	context.nativeRecords.push(
		{
			type: "event_msg",
			timestamp: time,
			payload: { type: "task_started", turn_id: "continuation", turn_attribution: { turn_trigger: "user" } },
		},
		{
			type: "event_msg",
			timestamp: time,
			payload: {
				type: "item_completed",
				turn_id: "continuation",
				item: { id: "continuation-message", type: "UserMessage", content: [{ type: "text", text }] },
			},
		},
	);
	await context.writeTranscript();
	await withTaskMessageInjectionLedgerLock(context.ledgerPath, async (records) => ({
		records: [
			...records,
			{
				...context.boundaryLedger,
				idempotency_key: `rvf-continuation-${context.token}`,
				prompt_sha256: computeRvfTextSha256(text),
				terminal_delivery_status: "delivered_and_submit_confirmed",
				terminal_delivery_failure_reason: undefined,
				codex_native_prompt_delivery_evidence: {
					clientUserMessageId: "continuation-client",
					nativeSessionId: "native",
					nativeTurnId: "continuation",
					nativeUserMessageId: "continuation-message",
				},
			},
		],
		result: null,
	}));
	await context.service.sweepPendingCloseoutsOnce();
	expect(
		(await context.state())?.preReviewConversationRestoreIdleGateRecovery?.qualification?.acceptedNativeUserMessageId,
	).toBe("continuation-message");
	expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
});

async function appendCompletedNativeRunContinuationWithFailedDelivery(
	context: Awaited<ReturnType<typeof setupIdleGateRecoveryNativeEvidence>>,
	continuationSequence: number,
	text = `RVF_DECISION_TOKEN=${context.token}\nrun_id=run\n继续本轮审查 ${continuationSequence}`,
) {
	const nativeTurnId = `failed-ledger-continuation-${continuationSequence}`;
	const nativeUserMessageId = `${nativeTurnId}-message`;
	const recordedAt = new Date().toISOString();
	context.source.push({
		id: nativeTurnId,
		status: "completed",
		items: [{ id: nativeUserMessageId, type: "userMessage", content: [{ type: "text", text }] }],
	});
	context.nativeRecords.push(
		{
			type: "event_msg",
			timestamp: recordedAt,
			payload: { type: "task_started", turn_id: nativeTurnId, turn_attribution: { turn_trigger: "user" } },
		},
		{
			type: "event_msg",
			timestamp: recordedAt,
			payload: {
				type: "item_completed",
				turn_id: nativeTurnId,
				item: { id: nativeUserMessageId, type: "UserMessage", content: [{ type: "text", text }] },
			},
		},
	);
	await withTaskMessageInjectionLedgerLock(context.ledgerPath, async (records) => ({
		records: [
			...records,
			{
				...context.boundaryLedger,
				idempotency_key: `${nativeTurnId}-${context.token}`,
				prompt_sha256: computeRvfTextSha256(text),
				codex_native_prompt_delivery_evidence: {
					clientUserMessageId: `${nativeTurnId}-client`,
					nativeSessionId: "native",
					nativeTurnId,
					nativeUserMessageId,
				},
			},
		],
		result: null,
	}));
	await context.writeTranscript();
	return nativeUserMessageId;
}

it.each([1, 2])(
	"本 run 的 %s 条失败账本续跑经精确补证后通过后续分支门禁，失败历史保持原样",
	async (continuationCount) => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		let lastNativeUserMessageId = "";
		for (let index = 1; index <= continuationCount; index++)
			lastNativeUserMessageId = await appendCompletedNativeRunContinuationWithFailedDelivery(context, index);
		const failedLedgerBefore = await readTaskMessageInjectionLedger(context.ledgerPath);
		await context.service.sweepPendingCloseoutsOnce();
		expect(
			(await context.state())?.preReviewConversationRestoreIdleGateRecovery?.qualification
				?.acceptedNativeUserMessageId,
		).toBe(lastNativeUserMessageId);
		expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledOnce();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
		expect(
			(await readTaskMessageInjectionLedger(context.ledgerPath)).filter((entry) =>
				failedLedgerBefore.some((before) => before.idempotency_key === entry.idempotency_key),
			),
		).toEqual(failedLedgerBefore);
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
	},
);

it.each(["wrong_message_id", "other_run", "human_input"])(
	"失败账本续跑中的 %s 不能借独立资格通过分支门禁",
	async (condition) => {
		const context = await setupIdleGateRecoveryNativeEvidence();
		const text =
			condition === "other_run"
				? `RVF_DECISION_TOKEN=${context.token}\nrun_id=other-run\n继续审查`
				: condition === "human_input"
					? "人工插话，请执行另一件事"
					: undefined;
		await appendCompletedNativeRunContinuationWithFailedDelivery(context, 1, text);
		if (condition === "wrong_message_id")
			await withTaskMessageInjectionLedgerLock(context.ledgerPath, async (records) => ({
				records: records.map((entry) =>
					entry.idempotency_key === context.boundaryLedger.idempotency_key
						? entry
						: {
								...entry,
								codex_native_prompt_delivery_evidence: {
									clientUserMessageId: "wrong-client",
									nativeSessionId: "native",
									nativeTurnId: "failed-ledger-continuation-1",
									nativeUserMessageId: "wrong-message",
								},
							},
				),
				result: null,
			}));
		const failedLedgerBefore = await readTaskMessageInjectionLedger(context.ledgerPath);
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
		expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
		expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(0);
		expect(await readTaskMessageInjectionLedger(context.ledgerPath)).toEqual(failedLedgerBefore);
	},
);

it("失败账本续跑补证后活动分支返回同正文的其他消息 ID，后续门禁仍拒绝恢复", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const acceptedMessageId = await appendCompletedNativeRunContinuationWithFailedDelivery(context, 1);
	const originalRequest = mocked.request.getMockImplementation();
	let replacedActiveBranchMessage = false;
	mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
		if (
			method === "thread/turns/list" &&
			parameters.threadId === "native" &&
			parameters.sortDirection === "asc" &&
			(await context.state())?.preReviewConversationRestoreIdleGateRecovery?.qualification
		) {
			replacedActiveBranchMessage = true;
			return {
				data: context.source.map((turn) => ({
					...turn,
					items: turn.items.map((item) =>
						item.id === acceptedMessageId ? { ...item, id: "other-branch-message" } : item,
					),
				})),
				nextCursor: null,
			};
		}
		return originalRequest?.(method, parameters);
	});
	await context.service.sweepPendingCloseoutsOnce();
	expect(replacedActiveBranchMessage).toBe(true);
	expect(
		(await context.state())?.preReviewConversationRestoreIdleGateRecovery?.qualification?.acceptedNativeUserMessageId,
	).toBe(acceptedMessageId);
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
	expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(0);
});

async function installActualTerminalInputTrackerForRestore(
	context: Awaited<ReturnType<typeof setupIdleGateRecoveryNativeEvidence>>,
) {
	const inputManager = new TerminalSessionManager();
	onTestFinished(() => inputManager.dispose());
	inputManager.hydrateFromRecord(
		{
			task: {
				...context.summary,
				turnOwner: "user",
				userTurnKind: "review",
				codexNativeSessionControlEndpoint: null,
				agentConversationPromptSubmissionAcceptance: undefined,
			},
		},
		new Set(["task"]),
	);
	const adoptionOutcomes = await inputManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
		{
			taskId: "task",
			hostedSessionKind: "task_agent_session",
			pid: 123,
			spawnedAtEpochMs: 1,
			cols: 100,
			rows: 30,
			exitedWhileRuntimeWasAbsent: false,
			terminalSessionAdoptionRecord: null,
			adoptHostedTerminalPtyProcess: async () => ({
				pid: 123,
				write: vi.fn(),
				resize: vi.fn(),
				pause: vi.fn(),
				resume: vi.fn(),
				stop: vi.fn(),
				hasExited: () => false,
				wasInterrupted: () => false,
			}),
			terminateHostedTerminalPtyProcessAfterRefusedAdoption: vi.fn(),
		},
	]);
	expect(adoptionOutcomes[0]?.adoptionOutcome).toBe("adopted_running_session");
	inputManager.writeInput("task", Buffer.from("\r"));
	const incarnation = inputManager.getSummary("task")?.runtimeSessionIncarnationId;
	context.summary.runtimeSessionIncarnationId = incarnation;
	if (incarnation && context.summary.codexNativeSessionControlEndpoint)
		context.summary.codexNativeSessionControlEndpoint.runtimeSessionIncarnationId = incarnation;
	if (incarnation && context.summary.agentConversationPromptSubmissionAcceptance)
		context.summary.agentConversationPromptSubmissionAcceptance.runtimeSessionIncarnationId = incarnation;
	context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementation(() =>
		inputManager.resolveTaskTerminalInputBoxOccupancy("task"),
	);
	context.manager.getTaskTerminalInputSideMutationSnapshot = () =>
		inputManager.getTaskTerminalInputSideMutationSnapshot("task");
	return inputManager;
}

it("真实输入管理器在同毫秒输入并清空后仍推进版本，summary 与空框状态保持原值", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const inputManager = await installActualTerminalInputTrackerForRestore(context);
	const summaryBeforeInput = inputManager.getSummary("task");
	const mutationBeforeInput = inputManager.getTaskTerminalInputSideMutationSnapshot("task");
	const fixedTimestamp = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(fixedTimestamp);
	onTestFinished(() => clock.mockRestore());
	inputManager.writeInput("task", Buffer.from("同毫秒输入"));
	inputManager.writeInput("task", Buffer.from("\u0003"));
	const mutationAfterClear = inputManager.getTaskTerminalInputSideMutationSnapshot("task");
	expect(mutationAfterClear?.humanTerminalInputMutationSequenceNumber).toBeGreaterThan(
		mutationBeforeInput?.humanTerminalInputMutationSequenceNumber ?? 0,
	);
	expect(mutationAfterClear?.hasUncommittedInput).toBe(false);
	expect(inputManager.getSummary("task")).toEqual(summaryBeforeInput);
});

it("真实 tracker 持续空白时仍只创建一个 fork 并投递一次收尾", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	await installActualTerminalInputTrackerForRestore(context);
	await context.service.sweepPendingCloseoutsOnce();
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect(context.manager.forceStopTaskSession).toHaveBeenCalledOnce();
	expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
});

it.each([
	{ stage: "fork", change: "draft" },
	{ stage: "stop", change: "draft" },
	{ stage: "fork", change: "native_message" },
	{ stage: "stop", change: "native_message" },
])("最终保存期间 $stage 前出现 $change 且 summary 未变时保留输入并拒绝副作用", async ({ stage, change }) => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const inputManager = await installActualTerminalInputTrackerForRestore(context);
	const originalOccupancy = context.manager.resolveTaskTerminalInputBoxOccupancy.getMockImplementation();
	let finalOccupancyReadFinished = false;
	let injected = false;
	context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementation(async (taskId) => {
		const occupancy = await originalOccupancy?.(taskId);
		const record = await context.state();
		if (
			record?.nativeForkAttemptStartedAt != null &&
			(stage === "stop"
				? record.nativeIdentitySwitchStartedAt != null
				: record.nativeIdentitySwitchStartedAt === null)
		)
			finalOccupancyReadFinished = true;
		return occupancy ?? null;
	});
	const originalWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
	const writeSpy = vi
		.spyOn(lockedFileSystem, "writeJsonFileAtomic")
		.mockImplementation(async (path, payload, options) => {
			await originalWrite(path, payload, options);
			if (
				path !== getRvfAutomaticCloseoutStorePath(context.scope.workspaceId) ||
				!finalOccupancyReadFinished ||
				injected
			)
				return;
			injected = true;
			const summaryBeforeInput = structuredClone(inputManager.getSummary("task"));
			if (change === "draft") inputManager.writeInput("task", Buffer.from("\u001b[200~请保留未提交草稿\u001b[201~"));
			else
				await appendFile(
					context.transcriptPath,
					`${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "最后出现的人工消息" }] } })}\n`,
				);
			expect(inputManager.getSummary("task")).toEqual(summaryBeforeInput);
		});
	onTestFinished(() => writeSpy.mockRestore());
	await context.service.sweepPendingCloseoutsOnce();
	expect(injected).toBe(true);
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
	expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(stage === "fork" ? 0 : 1);
	if (change === "draft")
		expect((await inputManager.resolveTaskTerminalInputBoxOccupancy("task"))?.inputSideByteTrackingSaysNonEmpty).toBe(
			true,
		);
});

it("另一运行时在停止旧进程前的最终原生查询期间持久 Stop，当前运行时立即让位", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const originalRequest = mocked.request.getMockImplementation();
	const independentStopper = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
	let stopped = false;
	mocked.request.mockImplementation(async (method: string, parameters: Record<string, unknown>) => {
		const result = await originalRequest?.(method, parameters);
		if (method === "thread/read" && !stopped) {
			const record = (
				await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId))
			)[0];
			if (record?.nativeIdentitySwitchStartedAt != null) {
				stopped = true;
				await independentStopper.pauseForExplicitStop(context.scope.workspaceId, "task");
			}
		}
		return result;
	});
	await context.service.sweepPendingCloseoutsOnce();
	expect(stopped).toBe(true);
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
	expect((await context.state())?.explicitStopRequestedAt).toBeDefined();
	expect((await context.state())?.status).toBe("paused");
});

it("持久 Stop 在最终输入框查询返回时到达，停止前的 claim 检查仍阻止执行", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	const independentStopper = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
	const originalOccupancy = context.manager.resolveTaskTerminalInputBoxOccupancy.getMockImplementation();
	let stopped = false;
	context.manager.resolveTaskTerminalInputBoxOccupancy.mockImplementation(async (taskId) => {
		const occupancy = await originalOccupancy?.(taskId);
		const record = (
			await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId))
		)[0];
		if (record?.nativeIdentitySwitchStartedAt != null && !stopped) {
			stopped = true;
			await independentStopper.pauseForExplicitStop(context.scope.workspaceId, "task");
		}
		return occupancy ?? null;
	});
	await context.service.sweepPendingCloseoutsOnce();
	expect(stopped).toBe(true);
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
	expect((await context.state())?.status).toBe("paused");
});

async function setupQualifiedRestoreInterruptedAfterOldProcessExit(exitCode: number) {
	const context = await setupIdleGateRecoveryNativeEvidence();
	context.manager.forceStopTaskSession.mockImplementationOnce(async () => {
		Object.assign(
			context.summary,
			reduceSessionTransition(context.summary, { type: "process.exit", exitCode, interrupted: false }).patch,
		);
		throw new Error("模拟旧进程已停止、运行时尚未切换身份时中断");
	});
	await context.service.sweepPendingCloseoutsOnce();
	expect(context.summary).toMatchObject({ turnOwner: "user", liveness: "exited", userTurnKind: "error", pid: null });
	const firstRecord = await context.state();
	expect(firstRecord?.nativeIdentitySwitchStartedAt).not.toBeNull();
	expect(firstRecord?.restoredNativeSessionId).toBe("restored");
	expect(firstRecord?.preReviewConversationRestoreIdleGateRecovery?.qualification).not.toBeNull();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
	context.manager.isTaskSessionAutomaticContinuationSuppressed = () => true;
	return { ...context, firstRecord };
}

it.each([129, 143])("已补证且旧进程以 %s 退出后运行时中断，重启复用原资格和 fork 完成身份切换", async (exitCode) => {
	const context = await setupQualifiedRestoreInterruptedAfterOldProcessExit(exitCode);
	const ledgerBeforeRestart = await readTaskMessageInjectionLedger(context.ledgerPath);
	context.runtimeApi.startTaskSession.mockImplementation(async () => {
		const summary = context.manager.getSummary();
		summary.liveness = "live";
		return { ok: true, summary };
	});
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).toHaveBeenCalledOnce();
	expect(context.runtimeApi.startTaskSession).toHaveBeenCalledOnce();
	expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).toHaveBeenCalledOnce();
	expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.qualification).toEqual(
		context.firstRecord?.preReviewConversationRestoreIdleGateRecovery?.qualification,
	);
	expect(
		(await readTaskMessageInjectionLedger(context.ledgerPath)).filter(
			(entry) => entry.idempotency_key === context.boundaryLedger.idempotency_key,
		),
	).toEqual(ledgerBeforeRestart);
});

it("原始 error 退出且从未补证时不能创建 fork 或自动切换身份", async () => {
	const context = await setupIdleGateRecoveryNativeEvidence();
	Object.assign(
		context.summary,
		reduceSessionTransition(context.summary, { type: "process.exit", exitCode: 129, interrupted: false }).patch,
	);
	await context.service.sweepPendingCloseoutsOnce();
	expect((await context.state())?.preReviewConversationRestoreIdleGateRecovery?.qualification).toBeNull();
	expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(0);
	expect(context.manager.forceStopTaskSession).not.toHaveBeenCalled();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
	expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
	expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
});

it.each([
	{ condition: "missing_qualification", description: "缺少恢复资格" },
	{ condition: "missing_fork_identity", description: "缺少持久 fork 身份" },
	{ condition: "missing_fork_stage", description: "缺少持久 fork 阶段" },
	{ condition: "missing_identity_switch_stage", description: "缺少持久身份切换阶段" },
	{ condition: "replacement_incarnation", description: "incarnation 已替换" },
	{ condition: "replacement_native_identity", description: "原生身份已替换" },
	{ condition: "replacement_control_endpoint", description: "控制端点已替换" },
	{ condition: "explicit_stop", description: "存在明确 Stop" },
	{ condition: "user_interrupted_exit", description: "退出由用户中断" },
])("旧进程退出后 $description 不能复用恢复资格", async ({ condition }) => {
	const context = await setupQualifiedRestoreInterruptedAfterOldProcessExit(129);
	const ledgerBeforeRestart = await readTaskMessageInjectionLedger(context.ledgerPath);
	await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), (records) => ({
		records: records.map((record) => ({
			...record,
			...(condition === "missing_qualification" && record.preReviewConversationRestoreIdleGateRecovery
				? {
						preReviewConversationRestoreIdleGateRecovery: {
							...record.preReviewConversationRestoreIdleGateRecovery,
							qualification: null,
						},
					}
				: {}),
			...(condition === "missing_fork_identity"
				? { restoredNativeSessionId: null, restoredTranscriptPath: null }
				: {}),
			...(condition === "missing_fork_stage" ? { nativeForkAttemptStartedAt: null } : {}),
			...(condition === "missing_identity_switch_stage" ? { nativeIdentitySwitchStartedAt: null } : {}),
		})),
		value: null,
	}));
	if (condition === "replacement_incarnation") context.summary.runtimeSessionIncarnationId = "replacement-incarnation";
	if (condition === "replacement_native_identity" && context.summary.agentNativeConversationSessionIdentity)
		context.summary.agentNativeConversationSessionIdentity.nativeSessionId = "replacement-native-thread";
	if (condition === "replacement_control_endpoint" && context.summary.codexNativeSessionControlEndpoint)
		context.summary.codexNativeSessionControlEndpoint.socketPath = "/replacement-control-endpoint";
	if (condition === "explicit_stop") await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
	if (condition === "user_interrupted_exit")
		Object.assign(
			context.summary,
			reduceSessionTransition(context.summary, { type: "process.exit", exitCode: 129, interrupted: true }).patch,
		);
	await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
	expect(context.manager.applyAgentNativeConversationSessionIdentity).not.toHaveBeenCalled();
	expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
	expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
	expect(mocked.request.mock.calls.filter((call) => call[0] === "thread/fork")).toHaveLength(1);
	expect(await readTaskMessageInjectionLedger(context.ledgerPath)).toEqual(ledgerBeforeRestart);
});

async function setupHistoricalBaseIntegrationObservation() {
	const context = await setupExecutionResultInterleavingEvidence();
	const storePath = getRvfAutomaticCloseoutStorePath(context.scope.workspaceId);
	const record = (await readRvfAutomaticCloseoutRecords(storePath))[0];
	if (!record?.runDirectory) throw new Error("缺少绑定 run");
	const gitDirectory = context.repo.runGit(["rev-parse", "--absolute-git-dir"]).stdout.trim();
	const candidatePath = join(gitDirectory, "rvf", "evidence", "reviewed-task-candidate-evidence.json");
	const canonical = JSON.stringify({
		run_id: record.runId,
		run_dir: record.runDirectory,
		repo_root: record.receipt.worktree,
		head_oid_after_commit: context.land.commitSha,
		result: {
			exit_code: 0,
			commit_oid: context.land.commitSha,
			candidate_evidence: {
				status: "written",
				candidate_evidence_sha256: computeRvfTextSha256(await readFile(candidatePath)),
			},
			round_baseline_seal: { sealed: true },
		},
	});
	await writeFile(join(record.runDirectory, "artifacts", "rvf-land-commit-result.json"), canonical);
	const immutableDirectory = join(record.runDirectory, "artifacts", "rvf-land-commit-execution-results");
	await mkdir(immutableDirectory);
	await writeFile(join(immutableDirectory, `${computeRvfTextSha256(canonical)}.json`), canonical);
	await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
		records: records.map((entry) => ({
			...entry,
			status: "paused" as const,
			pauseReason: "收尾投递失败：submit_confirmation_budget_exhausted",
			baseBranchSyncExecutionResult: { outcome: "blocked" as const, reason: "历史结果未对账", reportedAt: 1 },
		})),
		value: undefined,
	}));
	context.manager.getSummary().codexNativeSessionControlEndpoint = undefined;
	context.runtimeApi.startTaskSession.mockClear();
	context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mockClear();
	return { ...context, storePath, candidatePath, gitDirectory, boundRecord: record };
}

describe("历史 base 整合状态的独立观察", () => {
	it("并发扫描先补登 Land/base，原失败历史、Git refs 和投递账本保持原样，重启及迟到报告幂等", async () => {
		const context = await setupHistoricalBaseIntegrationObservation();
		const refs = context.repo.runGit(["show-ref"]).stdout;
		const ledgerPath = getTaskMessageInjectionLedgerPath(mocked.directory);
		const ledger = await readFile(ledgerPath);
		context.dependencies.getManager = vi.fn(async () => {
			throw new Error("已完成任务无需读取或恢复 Agent");
		});
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await Promise.all([context.service.sweepPendingCloseoutsOnce(), restarted.sweepPendingCloseoutsOnce()]);
		const saved = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
		expect(saved).toMatchObject({
			status: "completed",
			pauseReason: "收尾投递失败：submit_confirmation_budget_exhausted",
			baseBranchSyncExecutionResult: {
				outcome: "completed",
				verificationBasis: "verified_base_integration_state",
				baseIntegrationObservation: {
					source: "observed_local_base_ancestry",
					workspaceId: context.scope.workspaceId,
					taskId: "task",
					decisionToken: context.token,
					runId: "run",
					baseRef: "refs/heads/main",
					baseCommitSha: context.land.commitSha,
					landCommitSha: context.land.commitSha,
				},
			},
		});
		expect(saved.executionResultReportHistory?.map((entry) => entry.outcome)).toEqual([
			"blocked",
			"completed",
			"completed",
		]);
		await restarted.sweepPendingCloseoutsOnce();
		await expect(
			restarted.reportExecutionResult(context.scope, {
				...context.baseBranchSync,
				outcome: "failed",
				reason: "迟到失败",
			}),
		).rejects.toThrow("不能");
		expect(await readRvfAutomaticCloseoutRecords(context.storePath)).toEqual([saved]);
		expect(await readFile(ledgerPath)).toEqual(ledger);
		expect(context.repo.runGit(["show-ref"]).stdout).toBe(refs);
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
	});

	it("base 尚未整合时持久保留三次预算，耗尽后只探测变化，ref 恢复后自动收口", async () => {
		const context = await setupHistoricalBaseIntegrationObservation();
		context.repo.runGit(["switch", "--create", "historical-task-land"]);
		context.repo.runGit(["update-ref", "refs/heads/main", `${context.land.commitSha}^`]);
		await context.service.reportExecutionResult(context.scope, context.land);
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const dependencies = {
			workspaceId: context.scope.workspaceId,
			rvfHome: context.rvfHome,
			isStopped: () => false,
			getMainSummary: async () => {
				throw new Error("禁止恢复会话");
			},
			verifyLateAcceptance: async () => undefined,
		};
		try {
			for (const offset of [0, 15_001, 30_002, 90_003, 150_004]) {
				clock.mockReturnValue(now + offset);
				const record = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
				await observeExistingRvfBaseIntegrationStateOnce(dependencies, record);
			}
			let saved = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
			expect(saved.baseBranchSyncExecutionResult?.outcome).toBe("blocked");
			expect(saved.independentBaseIntegrationObservationBudget?.count).toBe(3);
			const fingerprint = saved.independentBaseIntegrationObservationBudget?.fingerprint;
			context.repo.runGit(["update-ref", "refs/heads/main", context.land.commitSha]);
			clock.mockReturnValue(now + 210_005);
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			saved = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
			expect(saved.status).toBe("completed");
			expect(saved.independentBaseIntegrationObservationBudget).toMatchObject({ count: 1 });
			expect(saved.independentBaseIntegrationObservationBudget?.fingerprint).not.toBe(fingerprint);
		} finally {
			clock.mockRestore();
		}
	});

	it("HEAD 前置条件恢复后跨 service 重建刷新已耗尽预算，只读核验完成且不恢复 Agent", async () => {
		const context = await setupHistoricalBaseIntegrationObservation();
		await context.service.reportExecutionResult(context.scope, context.land);
		context.repo.runGit(["switch", "--detach", `${context.land.commitSha}^`]);
		const refs = context.repo.runGit(["show-ref"]).stdout;
		const ledgerPath = getTaskMessageInjectionLedgerPath(mocked.directory);
		const ledger = await readFile(ledgerPath);
		context.dependencies.getManager = vi.fn(async () => {
			throw new Error("历史 base 核验无需读取或恢复 Agent");
		});
		const verification = vi.spyOn(baseIntegrationEvidence, "readBoundRvfBaseIntegrationState");
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const dependencies = {
			workspaceId: context.scope.workspaceId,
			rvfHome: context.rvfHome,
			isStopped: () => false,
			getMainSummary: async () => {
				throw new Error("禁止恢复会话");
			},
			verifyLateAcceptance: async () => undefined,
		};
		try {
			for (const [offset, expectedVerificationCount] of [
				[0, 1],
				[14_999, 1],
				[15_001, 2],
				[30_000, 2],
				[30_002, 3],
				[90_003, 3],
				[150_004, 3],
			]) {
				clock.mockReturnValue(now + offset);
				const record = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
				await observeExistingRvfBaseIntegrationStateOnce(dependencies, record);
				expect(verification).toHaveBeenCalledTimes(expectedVerificationCount);
			}
			const exhausted = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
			expect(exhausted.baseBranchSyncExecutionResult?.outcome).toBe("blocked");
			expect(exhausted.independentBaseIntegrationObservationBudget?.count).toBe(3);
			const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
			await restarted.sweepPendingCloseoutsOnce();
			expect(verification).toHaveBeenCalledTimes(3);
			context.repo.runGit(["switch", "main"]);
			clock.mockReturnValue(now + 210_003);
			await restarted.sweepPendingCloseoutsOnce();
			expect(verification).toHaveBeenCalledTimes(3);
			clock.mockReturnValue(now + 210_005);
			await restarted.sweepPendingCloseoutsOnce();
			const completed = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
			expect(completed.status).toBe("completed");
			expect(completed.baseBranchSyncExecutionResult).toMatchObject({
				outcome: "completed",
				verificationBasis: "verified_base_integration_state",
			});
			expect(completed.independentBaseIntegrationObservationBudget?.count).toBe(1);
			expect(completed.independentBaseIntegrationObservationBudget?.fingerprint).not.toBe(
				exhausted.independentBaseIntegrationObservationBudget?.fingerprint,
			);
			expect(verification.mock.calls.length).toBeGreaterThan(3);
			expect(context.repo.runGit(["show-ref"]).stdout).toBe(refs);
			expect(await readFile(ledgerPath)).toEqual(ledger);
			expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
		} finally {
			verification.mockRestore();
			clock.mockRestore();
		}
	});

	it.each(["wrong_common_directory", "tampered_candidate_digest", "wrong_base_ref", "changed_handoff"])(
		"独立 base 观察拒绝错误证据且不覆盖旧阻塞：%s",
		async (scenario) => {
			const context = await setupHistoricalBaseIntegrationObservation();
			await context.service.reportExecutionResult(context.scope, context.land);
			if (scenario === "wrong_common_directory") {
				const candidate = JSON.parse(await readFile(context.candidatePath, "utf8"));
				candidate.subject.git_common_dir_realpath = context.fixture.fixtureRootDirectoryPath;
				const text = JSON.stringify(candidate);
				await writeFile(context.candidatePath, text);
				await writeFile(`${context.candidatePath}.sha256`, computeRvfTextSha256(text));
			} else if (scenario === "tampered_candidate_digest")
				await writeFile(`${context.candidatePath}.sha256`, "f".repeat(64));
			else if (scenario === "wrong_base_ref")
				await writeFile(
					join(context.boundRecord.runDirectory ?? "", "artifacts", "inputs", "scope.contract.json"),
					JSON.stringify({ base_ref: "refs/remotes/origin/main" }),
				);
			else await writeFile(context.boundRecord.handoffPath ?? "", "篡改 handoff");
			await context.service.sweepPendingCloseoutsOnce();
			const saved = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
			expect(saved.status).not.toBe("completed");
			expect(saved.baseBranchSyncExecutionResult).toMatchObject({ outcome: "blocked", reason: "历史结果未对账" });
			expect(saved.independentBaseIntegrationObservationBudget?.count).toBe(1);
			expect(saved.independentBaseIntegrationObservationBudget?.reason).toBeTruthy();
			expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
		},
	);

	it.each(["explicit_stop", "active_backup", "consumed_backup"])(
		"%s 保持停止与接管边界，不自动补登或唤醒",
		async (scenario) => {
			const context = await setupHistoricalBaseIntegrationObservation();
			if (scenario === "explicit_stop")
				await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
			else {
				const control = join(context.gitDirectory, "rvf-independent-backup-route");
				if (scenario === "active_backup") await mkdir(join(control, "active-owner"), { recursive: true });
				else {
					const consumed = join(control, "consumed-original-runs");
					await mkdir(consumed, { recursive: true });
					await writeFile(
						join(consumed, `${computeRvfTextSha256(context.boundRecord.runDirectory ?? "")}.json`),
						"{}",
					);
				}
			}
			await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
			const saved = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
			expect(saved.status).toBe("paused");
			expect(saved.landExecutionResult).toBeUndefined();
			expect(saved.baseBranchSyncExecutionResult?.outcome).toBe("blocked");
			expect(saved.promptDeliveryAttempts).toBeUndefined();
			expect(saved.stageExecutionClaims).toBeUndefined();
			expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
			expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
		},
	);

	it("旧未分类 blocked 进入只读续验，仍拒绝阶段认领，明确分类追加来源和历史", async () => {
		const context = await setupLateNativeCloseoutPromptAcceptance();
		await context.writeNativeEvidence({ includeMessage: false });
		const storePath = getRvfAutomaticCloseoutStorePath(context.scope.workspaceId);
		await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
			records: records.map((entry) => ({
				...entry,
				landExecutionResult: { outcome: "blocked" as const, reason: "旧报告原因未知", reportedAt: 1 },
				baseBranchSyncExecutionResult: { outcome: "blocked" as const, reason: "旧报告原因未知", reportedAt: 2 },
			})),
			value: undefined,
		}));
		let saved = (await readRvfAutomaticCloseoutRecords(storePath))[0];
		expect(remainingRvfCloseoutStages(saved)).toEqual([]);
		expect(remainingRvfCloseoutVerificationStages(saved)).toEqual(["land", "base_branch_sync"]);
		context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mockClear();
		await context.service.sweepPendingCloseoutsOnce();
		saved = (await readRvfAutomaticCloseoutRecords(storePath))[0];
		expect(saved.promptDeliveryAttempts?.[0]).toMatchObject({ purpose: "inspect_existing_state" });
		expect(saved.promptDeliveryAttempts?.[0]?.promptText).toContain("允许申请执行的阶段=无");
		expect(
			await context.service.claimExecutionStage(context.scope, { ...context.request, stage: "land" }),
		).not.toMatchObject({ status: "claimed" });
		const result = await context.service.reportExecutionResult(context.scope, {
			...context.request,
			stage: "land",
			outcome: "blocked",
			reason: "原生记录中的用户消息要求不提交",
			blockedReasonKind: "user_restriction",
			deliveryAttemptId: saved.promptDeliveryAttempts?.[0]?.deliveryAttemptId,
		});
		expect(result.record.landExecutionResult).toMatchObject({
			blockedReasonKind: "user_restriction",
			blockedReasonClassificationSource: "bound_agent_report",
		});
		expect(result.record.executionResultReportHistory?.map((entry) => entry.outcome)).toEqual([
			"blocked",
			"blocked",
			"blocked",
		]);
	});
});

it.each([
	"base_ref_drift",
	"explicit_stop_before_persist",
	"backup_claim_before_persist",
	"explicit_stop_during_final_revalidation",
	"backup_claim_during_final_revalidation",
	"operation_lock_lost_during_final_revalidation",
])("base 核验结束后出现 %s 时，写入前重验拒绝登记成功", async (scenario) => {
	const context = await setupHistoricalBaseIntegrationObservation();
	await context.service.reportExecutionResult(context.scope, context.land);
	await updateRvfAutomaticCloseoutRecords(context.storePath, (records) => ({
		records: records.map((entry) => ({
			...entry,
			stageExecutionClaims: [
				{
					stageExecutionClaimId: "historical-base-stage-claim",
					stage: "base_branch_sync" as const,
					deliveryAttemptId: `initial-${context.token}`,
					nativeSessionId: "restored",
					runtimeSessionIncarnationId: "historical-base-stage-claim-incarnation",
					claimedAt: 1,
					status: "claimed" as const,
				},
			],
		})),
		value: undefined,
	}));
	const readState = baseIntegrationEvidence.readBoundRvfBaseIntegrationState;
	let reads = 0;
	let stopped = false;
	const triggerRead = scenario.endsWith("during_final_revalidation") ? 3 : 2;
	let compromiseOperationLock: () => void = () => {
		throw new Error("尚未捕获观察操作锁。");
	};
	const originalWithLocks = lockedFileSystem.withLocks.bind(lockedFileSystem);
	const operationLockObservation = vi
		.spyOn(lockedFileSystem, "withLocks")
		.mockImplementation(async <T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> => {
			const operationLock = requests.find((request) =>
				request.path.startsWith(`${context.storePath}.record-operation-`),
			);
			if (operationLock)
				compromiseOperationLock = () => operationLock.onCompromised?.(new Error("模拟观察操作锁失效"));
			return originalWithLocks(requests, operation);
		});
	const observation = vi
		.spyOn(baseIntegrationEvidence, "readBoundRvfBaseIntegrationState")
		.mockImplementation(async (record) => {
			const result = await readState(record);
			if (++reads === triggerRead) {
				if (scenario.startsWith("explicit_stop_")) stopped = true;
				else if (scenario === "operation_lock_lost_during_final_revalidation") compromiseOperationLock();
				else if (scenario.startsWith("backup_claim_"))
					await mkdir(join(context.gitDirectory, "rvf-independent-backup-route", "active-owner"), {
						recursive: true,
					});
				else {
					context.repo.runGit(["switch", "--create", "task-with-drifted-base"]);
					context.repo.runGit(["update-ref", "refs/heads/main", `${context.land.commitSha}^`]);
				}
			}
			return result;
		});
	try {
		const record = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
		const observed = observeExistingRvfBaseIntegrationStateOnce(
			{
				workspaceId: context.scope.workspaceId,
				rvfHome: context.rvfHome,
				isStopped: () => stopped,
				getMainSummary: async () => context.manager.getSummary(),
				verifyLateAcceptance: async () => undefined,
			},
			record,
		);
		if (scenario === "operation_lock_lost_during_final_revalidation")
			await expect(observed).rejects.toThrow("操作锁已失效");
		else await observed;
		const saved = (await readRvfAutomaticCloseoutRecords(context.storePath))[0];
		expect(reads).toBe(triggerRead);
		expect(saved.baseBranchSyncExecutionResult).toEqual(record.baseBranchSyncExecutionResult);
		expect(saved.executionResultReportHistory).toEqual(record.executionResultReportHistory);
		expect(saved.stageExecutionClaims).toEqual(record.stageExecutionClaims);
		expect(saved.status).toBe(record.status);
		expect(saved.pauseReason).toBe(record.pauseReason);
		expect(saved.updatedAt).toBe(record.updatedAt);
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
		expect(context.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
	} finally {
		observation.mockRestore();
		operationLockObservation.mockRestore();
	}
});
