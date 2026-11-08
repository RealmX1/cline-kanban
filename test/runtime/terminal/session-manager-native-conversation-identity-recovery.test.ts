import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as CodexTranscriptInspection from "../../../src/agent-session-history/codex-native-conversation-transcript-location-for-resume";
import * as CodexNativePluginInstallationCapabilityVerification from "../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-verification";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import {
	getDiagnosticEventJournalActiveFilePath,
	waitForPendingDiagnosticEventJournalWrites,
} from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import type * as AgentAdapters from "../../../src/terminal/agent-session-adapters";
import { createAutomaticAgentFailureContinuationCoordinator } from "../../../src/terminal/automatic-agent-failure-continuation-coordinator";
import {
	type StartTaskSessionRequest,
	TerminalSessionManager,
	type TerminalSessionManagerOptions,
} from "../../../src/terminal/session-manager";
import type * as IdentityRecovery from "../../../src/terminal/task-session-native-conversation-identity-recovery";
import { readTaskSessionResumeRequestWaitingForNativeConversationIdentity } from "../../../src/terminal/task-session-native-conversation-identity-recovery";
import type { HostedTerminalPtyProcessSpawnRequest } from "../../../src/terminal/terminal-pty-process-handle";
import {
	compressedCodexTranscriptFixtureBytes,
	compressedCodexTranscriptFixtureNativeSessionId,
} from "../../utilities/codex-native-resume-compressed-transcript-fixtures";

const prepareLaunch = vi.hoisted(() => vi.fn());
const readOwnedIdentity = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentAdapters>()),
	prepareAgentLaunch: prepareLaunch,
}));
vi.mock("../../../src/terminal/task-session-native-conversation-identity-recovery", async (importOriginal) => ({
	...(await importOriginal<typeof IdentityRecovery>()),
	readTaskSessionNativeConversationIdentityFromOwnedCodexControl: readOwnedIdentity,
}));

let isolatedHome: string;
const managers: TerminalSessionManager[] = [];
const parentId = "11111111-2222-4333-8444-555555555555";
const childId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const incarnation = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";

function createAwaitingIdentitySummary(): RuntimeTaskSessionSummary {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "empty-side-session",
		agentId: "claude",
		state: "awaiting_review",
		reviewReason: "hook",
		workspacePath: isolatedHome,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		exitCode: null,
		runtimeSessionIncarnationId: incarnation,
		taskConversationSessionMetadata: {
			workspaceTaskId: "host-task",
			taskConversationSessionRole: "task_collaborator",
			taskConversationSessionContextSource: "forked_from_main_current_turn",
			parentTaskConversationSessionId: "host-task",
			mainSessionOriginTurnNumber: 1,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
		},
		taskConversationSessionNativeIdentityRecovery: {
			runtimeSessionIncarnationId: incarnation,
			forkSourceNativeSessionId: parentId,
			resumeRequestedAtMs: null,
			consecutiveUnchangedProbeCount: 0,
			lastEvidenceFingerprint: null,
			nextProbeAtMs: 0,
		},
	});
}

function createManager(
	summary = createAwaitingIdentitySummary(),
	beforeHostedSpawnCompletes?: () => Promise<void>,
	additionalOptions: TerminalSessionManagerOptions = {},
) {
	const spawn = vi.fn<(request: HostedTerminalPtyProcessSpawnRequest) => void>();
	const spawnedProcesses: Array<{
		stop: ReturnType<typeof vi.fn>;
		hasExited: () => boolean;
		triggerExit: (exitCode: number) => void;
		triggerOutput: (text: string) => void;
	}> = [];
	// 明确的假 PTY 退出边沿，让测试验证真正重建，而不依赖等待计时器。
	const manager = new TerminalSessionManager({
		...additionalOptions,
		hostedTerminalPtyProcessSpawner: {
			spawnHostedTerminalPtyProcess: async (request) => {
				spawn(request);
				let exited = false;
				const process = {
					pid: 100 + spawn.mock.calls.length,
					write: vi.fn(),
					resize: vi.fn(),
					pause: vi.fn(),
					resume: vi.fn(),
					stop: vi.fn(() => {
						exited = true;
						request.onExit({ exitCode: 0 });
					}),
					hasExited: () => exited,
					wasInterrupted: () => false,
					triggerExit: (exitCode: number) => {
						exited = true;
						request.onExit({ exitCode });
					},
					triggerOutput: (text: string) => request.onData(Buffer.from(text)),
				};
				spawnedProcesses.push(process);
				await beforeHostedSpawnCompletes?.();
				return process;
			},
		},
	});
	manager.hydrateFromRecord({ [summary.taskId]: summary });
	managers.push(manager);
	return { manager, spawn, spawnedProcesses };
}

function resumeRequest(summary: RuntimeTaskSessionSummary): StartTaskSessionRequest {
	return {
		taskId: summary.taskId,
		workspaceTaskId: "host-task",
		agentId: summary.agentId ?? "claude",
		binary: "isolated-fixture-agent",
		args: [],
		cwd: isolatedHome,
		prompt: "不能重发的历史首条消息",
		startInPlanMode: true,
		taskAgentPermissionMode: "ask_for_every_tool_use",
		taskConversationSessionMetadata: summary.taskConversationSessionMetadata,
		taskConversationSessionContextForkSourceNativeSessionId: parentId,
		resumePriorAgentConversationWithoutResendingPrompt: true,
	};
}

function deferredCompletion() {
	let complete: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		complete = resolve;
	});
	return { promise, complete };
}

async function advanceRecovery(manager: TerminalSessionManager): Promise<void> {
	const internals = manager as unknown as {
		entries: Map<string, unknown>;
		advanceTaskSessionNativeConversationIdentityRecovery(entry: unknown): Promise<void>;
	};
	await internals.advanceTaskSessionNativeConversationIdentityRecovery(internals.entries.get("empty-side-session"));
}

beforeEach(async () => {
	isolatedHome = await mkdtemp(join(tmpdir(), "empty-side-identity-recovery-"));
	vi.stubEnv("HOME", isolatedHome);
	vi.stubEnv("CODEX_HOME", join(isolatedHome, ".codex"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(isolatedHome, ".codex"));
	prepareLaunch.mockReset().mockImplementation(async (input: AgentAdapters.AgentAdapterLaunchInput) => ({
		args: input.args,
		env: {},
		resumesPriorAgentConversation: true,
	}));
	readOwnedIdentity.mockReset().mockResolvedValue(null);
});

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(isolatedHome, { recursive: true, force: true });
});

describe("任务会话的原生身份补证恢复", () => {
	it.each([
		{ additionalArguments: undefined },
		{ additionalArguments: ["--model", "retained-model", "resume", parentId] },
	])(
		"Codex 主会话退出 101 后按清空上下文后的最新身份续接，不重发初始需求：$additionalArguments",
		async ({ additionalArguments }) => {
			const summary: RuntimeTaskSessionSummary = {
				...createAwaitingIdentitySummary(),
				agentId: "codex",
				taskConversationSessionMetadata: undefined,
				taskConversationSessionNativeIdentityRecovery: undefined,
			};
			const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
			await mkdir(sessionsDirectory, { recursive: true });
			const transcriptPath = join(sessionsDirectory, `rollout-${childId}.jsonl`);
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
			);
			const { manager, spawn, spawnedProcesses } = createManager(summary);
			manager.attach(summary.taskId, { onState: vi.fn(), onOutput: vi.fn() });
			await manager.startTaskSession({
				taskId: summary.taskId,
				workspaceTaskId: summary.taskId,
				agentId: "codex",
				binary: "isolated-fixture-agent",
				args: [],
				cwd: isolatedHome,
				prompt: "原始需求，不能在崩溃后再次发送",
				startInPlanMode: true,
				additionalAgentStartupArgumentsForThisRestart: additionalArguments,
			});
			manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
				sourceAgentId: "codex",
				nativeSessionId: childId,
				transcriptPath,
				observedAt: Date.now(),
			});
			spawnedProcesses[0].triggerOutput("原生崩溃现场：panic before clear-context handoff\r\n");
			spawnedProcesses[0].triggerExit(101);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
			expect(prepareLaunch.mock.calls.at(-1)?.[0]).toMatchObject({
				prompt: "",
				startInPlanMode: undefined,
				resumePriorAgentConversationWithoutResendingPrompt: true,
				observedAgentNativeConversationSessionResumeAddressing: { sourceSessionId: childId },
			});
			expect(prepareLaunch.mock.calls.at(-1)?.[0].additionalAgentStartupArgumentsForThisRestart).toEqual(
				additionalArguments ? ["--model", "retained-model"] : undefined,
			);
			await waitForPendingDiagnosticEventJournalWrites();
			const diagnosticLines = await readFile(
				getDiagnosticEventJournalActiveFilePath("task-session-abnormal-exit"),
				"utf8",
			);
			expect(JSON.parse(diagnosticLines.trim().split("\n").at(-1) ?? "null")).toMatchObject({
				taskId: summary.taskId,
				exitCode: 101,
				agentNativeConversationSessionIdentity: { nativeSessionId: childId },
				terminalTailText: expect.stringContaining("panic before clear-context handoff"),
			});
		},
	);

	it("主会话身份与转录迟到时保存恢复请求，跨重启保持三次预算并自动接续一次", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const summary: RuntimeTaskSessionSummary = {
			...createAwaitingIdentitySummary(),
			agentId: "codex",
			taskConversationSessionMetadata: undefined,
			taskConversationSessionNativeIdentityRecovery: undefined,
		};
		const first = createManager(summary);
		const request: StartTaskSessionRequest = {
			...resumeRequest(summary),
			prompt: "",
			workspaceTaskId: summary.taskId,
			taskConversationSessionContextForkSourceNativeSessionId: undefined,
			additionalAgentStartupArgumentsForThisRestart: ["--model", "retained-restart-model"],
		};
		await first.manager.refreshTaskTerminal(request);
		await advanceRecovery(first.manager);
		expect(first.spawn).not.toHaveBeenCalled();
		for (let attempt = 0; attempt < 3; attempt++) {
			vi.setSystemTime(Date.now() + 15_000);
			await advanceRecovery(first.manager);
		}
		expect(readOwnedIdentity).toHaveBeenCalledTimes(3);
		const persisted = first.manager.getSummary(summary.taskId);
		if (!persisted) throw new Error("缺少主会话的持久恢复状态");
		first.manager.dispose();
		const restarted = createManager(persisted);
		await advanceRecovery(restarted.manager);
		expect(readOwnedIdentity).toHaveBeenCalledTimes(3);
		restarted.manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "codex",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(restarted.manager);
		expect(restarted.spawn).not.toHaveBeenCalled();
		const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
		await mkdir(sessionsDirectory, { recursive: true });
		await writeFile(
			join(sessionsDirectory, `rollout-${childId}.jsonl`),
			`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
		);
		await advanceRecovery(restarted.manager);
		await advanceRecovery(restarted.manager);
		expect(restarted.spawn).toHaveBeenCalledOnce();
		expect(prepareLaunch.mock.calls.at(-1)?.[0]).toMatchObject({
			prompt: "",
			startInPlanMode: undefined,
			additionalAgentStartupArgumentsForThisRestart: ["--model", "retained-restart-model"],
			resumePriorAgentConversationWithoutResendingPrompt: true,
			observedAgentNativeConversationSessionResumeAddressing: { sourceSessionId: childId },
		});
	});

	it("主会话已有身份但转录尚未落盘时自动等待，转录出现后续接一次", async () => {
		const summary: RuntimeTaskSessionSummary = {
			...createAwaitingIdentitySummary(),
			agentId: "codex",
			taskConversationSessionMetadata: undefined,
			taskConversationSessionNativeIdentityRecovery: undefined,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: childId,
				transcriptPath: null,
				observedAt: Date.now(),
			},
		};
		const { manager, spawn } = createManager(summary);
		await expect(
			manager.refreshTaskTerminal({
				...resumeRequest(summary),
				workspaceTaskId: summary.taskId,
				taskConversationSessionContextForkSourceNativeSessionId: undefined,
			}),
		).resolves.toBeDefined();
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		expect(
			manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs,
		).toBeTypeOf("number");
		const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
		await mkdir(sessionsDirectory, { recursive: true });
		await writeFile(
			join(sessionsDirectory, `rollout-${childId}.jsonl`),
			`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
		);
		await advanceRecovery(manager);
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("转录预检期间迟到的新原生身份不会丢失恢复意图", async () => {
		const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
		await mkdir(sessionsDirectory, { recursive: true });
		for (const id of [parentId, childId])
			await writeFile(
				join(sessionsDirectory, `rollout-${id}.jsonl`),
				`${JSON.stringify({ type: "session_meta", payload: { id, source: "cli" } })}\n`,
			);
		const summary: RuntimeTaskSessionSummary = {
			...createAwaitingIdentitySummary(),
			agentId: "codex",
			taskConversationSessionMetadata: undefined,
			taskConversationSessionNativeIdentityRecovery: undefined,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: parentId,
				transcriptPath: join(sessionsDirectory, `rollout-${parentId}.jsonl`),
				observedAt: Date.now(),
			},
		};
		const { manager, spawn } = createManager(summary);
		const inspect = CodexTranscriptInspection.inspectCodexNativeConversationTranscriptBeforeResume;
		const inspectionSpy = vi.spyOn(CodexTranscriptInspection, "inspectCodexNativeConversationTranscriptBeforeResume");
		inspectionSpy.mockImplementationOnce(async (input) => {
			manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
				sourceAgentId: "codex",
				nativeSessionId: childId,
				transcriptPath: join(sessionsDirectory, `rollout-${childId}.jsonl`),
				observedAt: Date.now() + 1,
			});
			return inspect(input);
		});
		try {
			await manager.refreshTaskTerminal({
				...resumeRequest(summary),
				workspaceTaskId: summary.taskId,
				taskConversationSessionContextForkSourceNativeSessionId: undefined,
			});
			await advanceRecovery(manager);
			expect(spawn).toHaveBeenCalledOnce();
			expect(
				prepareLaunch.mock.calls.at(-1)?.[0].observedAgentNativeConversationSessionResumeAddressing,
			).toMatchObject({ sourceSessionId: childId });
		} finally {
			inspectionSpy.mockRestore();
		}
	});

	it("主会话等待独享控制面补证期间 Stop，迟到原生身份不能启动旧恢复", async () => {
		const entered = deferredCompletion();
		const release = deferredCompletion();
		readOwnedIdentity.mockImplementationOnce(async () => {
			entered.complete();
			await release.promise;
			return { sourceAgentId: "codex", nativeSessionId: childId, transcriptPath: null, observedAt: Date.now() };
		});
		const summary: RuntimeTaskSessionSummary = {
			...createAwaitingIdentitySummary(),
			agentId: "codex",
			taskConversationSessionMetadata: undefined,
			taskConversationSessionNativeIdentityRecovery: undefined,
		};
		const { manager, spawn } = createManager(summary);
		await manager.refreshTaskTerminal({
			...resumeRequest(summary),
			workspaceTaskId: summary.taskId,
			taskConversationSessionContextForkSourceNativeSessionId: undefined,
		});
		await entered.promise;
		manager.stopTaskSession(summary.taskId);
		release.complete();
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		expect(
			manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs,
		).toBeNull();
	});

	it.each(["stop", "native_identity_changed"] as const)(
		"自动恢复准备期间发生 %s，旧准备不能覆盖后续状态",
		async (intervention) => {
			const entered = deferredCompletion();
			const release = deferredCompletion();
			const cleanup = vi.fn(async () => {});
			prepareLaunch.mockImplementation(async (input: AgentAdapters.AgentAdapterLaunchInput) => {
				if (input.resumePriorAgentConversationWithoutResendingPrompt) {
					entered.complete();
					await release.promise;
				}
				return {
					args: input.args,
					env: {},
					resumesPriorAgentConversation: true,
					cleanup: input.resumePriorAgentConversationWithoutResendingPrompt ? cleanup : undefined,
				};
			});
			const summary: RuntimeTaskSessionSummary = {
				...createAwaitingIdentitySummary(),
				agentId: "codex",
				taskConversationSessionMetadata: undefined,
				taskConversationSessionNativeIdentityRecovery: undefined,
			};
			const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
			await mkdir(sessionsDirectory, { recursive: true });
			const transcriptPath = join(sessionsDirectory, `rollout-${childId}.jsonl`);
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
			);
			await writeFile(
				join(sessionsDirectory, `rollout-${parentId}.jsonl`),
				`${JSON.stringify({ type: "session_meta", payload: { id: parentId, source: "cli" } })}\n`,
			);
			const { manager, spawn, spawnedProcesses } = createManager(summary);
			manager.attach(summary.taskId, { onState: vi.fn() });
			await manager.startTaskSession({
				taskId: summary.taskId,
				agentId: "codex",
				binary: "isolated-fixture-agent",
				args: [],
				cwd: isolatedHome,
				prompt: "首次需求",
			});
			manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
				sourceAgentId: "codex",
				nativeSessionId: childId,
				transcriptPath,
				observedAt: Date.now(),
			});
			spawnedProcesses[0].triggerExit(101);
			await entered.promise;
			const internals = manager as unknown as { entries: Map<string, { pendingAutoRestart: Promise<void> | null }> };
			const pending = internals.entries.get(summary.taskId)?.pendingAutoRestart;
			if (intervention === "stop") manager.stopTaskSession(summary.taskId);
			else
				manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
					sourceAgentId: "codex",
					nativeSessionId: parentId,
					transcriptPath: join(sessionsDirectory, `rollout-${parentId}.jsonl`),
					observedAt: Date.now() + 10,
				});
			release.complete();
			await pending;
			await advanceRecovery(manager);
			if (intervention === "native_identity_changed") await advanceRecovery(manager);
			expect(spawn).toHaveBeenCalledTimes(intervention === "stop" ? 1 : 2);
			expect(cleanup).toHaveBeenCalledOnce();
			if (intervention === "stop") expect(manager.getSummary(summary.taskId)?.pid).toBeNull();
			else
				expect(
					prepareLaunch.mock.calls.at(-1)?.[0].observedAgentNativeConversationSessionResumeAddressing,
				).toMatchObject({ sourceSessionId: parentId });
		},
	);

	it.each(["resume", "fork"])("已有身份的 Codex 主会话显式 %s 后，独享原生端点自动回写新身份", async (selection) => {
		const summary: RuntimeTaskSessionSummary = {
			...createAwaitingIdentitySummary(),
			agentId: "codex",
			taskConversationSessionMetadata: undefined,
			taskConversationSessionNativeIdentityRecovery: undefined,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: parentId,
				transcriptPath: null,
				observedAt: Date.now(),
			},
		};
		const { manager, spawn } = createManager(summary);
		await manager.refreshTaskTerminal({
			...resumeRequest(summary),
			workspaceTaskId: summary.taskId,
			taskConversationSessionContextForkSourceNativeSessionId: undefined,
			additionalAgentStartupArgumentsForThisRestart: [selection, childId],
			prompt: "",
		});
		expect(manager.getSummary(summary.taskId)?.agentNativeConversationSessionIdentity).toBeNull();
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery).toMatchObject({
			resumeRequestedAtMs: null,
			runtimeSessionIncarnationId: manager.getSummary(summary.taskId)?.runtimeSessionIncarnationId,
		});
		readOwnedIdentity.mockResolvedValue({
			sourceAgentId: "codex",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(manager.getSummary(summary.taskId)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(childId);
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery).toBeNull();
		expect(spawn).toHaveBeenCalledOnce();
		expect(prepareLaunch.mock.calls.at(-1)?.[0].prompt).toBe("");
	});

	it.each(["prepare", "hosted_spawn"])("旧自动恢复等待 %s 时新启动请求保留正文并取消旧恢复", async (phase) => {
		const entered = deferredCompletion();
		const release = deferredCompletion();
		const cleanup = vi.fn(async () => {});
		prepareLaunch.mockImplementation(async (input: AgentAdapters.AgentAdapterLaunchInput) => {
			if (phase === "prepare" && input.resumePriorAgentConversationWithoutResendingPrompt) {
				entered.complete();
				await release.promise;
			}
			return {
				args: input.args,
				env: {},
				cleanup: input.resumePriorAgentConversationWithoutResendingPrompt ? cleanup : undefined,
			};
		});
		const summary: RuntimeTaskSessionSummary = {
			...createAwaitingIdentitySummary(),
			agentId: "codex",
			taskConversationSessionMetadata: undefined,
			taskConversationSessionNativeIdentityRecovery: undefined,
		};
		const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
		await mkdir(sessionsDirectory, { recursive: true });
		const transcriptPath = join(sessionsDirectory, `rollout-${childId}.jsonl`);
		await writeFile(transcriptPath, `${JSON.stringify({ type: "session_meta", payload: { id: childId } })}\n`);
		const { manager, spawn, spawnedProcesses } = createManager(summary, async () => {
			if (phase === "hosted_spawn" && spawn.mock.calls.length === 2) {
				entered.complete();
				await release.promise;
			}
		});
		const request: StartTaskSessionRequest = {
			taskId: summary.taskId,
			agentId: "codex",
			binary: "isolated-fixture-agent",
			args: [],
			cwd: isolatedHome,
			prompt: "首次需求",
		};
		manager.attach(summary.taskId, { onState: vi.fn() });
		await manager.startTaskSession(request);
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "codex",
			nativeSessionId: childId,
			transcriptPath,
			observedAt: Date.now(),
		});
		spawnedProcesses[0].triggerExit(101);
		await entered.promise;
		const newStart = manager.startTaskSession({ ...request, prompt: "恢复等待期间的新输入" });
		release.complete();
		const newSummary = await newStart;
		await advanceRecovery(manager);
		expect(prepareLaunch.mock.calls.at(-1)?.[0].prompt).toBe("恢复等待期间的新输入");
		expect(prepareLaunch.mock.calls.filter(([input]) => input.prompt === "恢复等待期间的新输入")).toHaveLength(1);
		expect(spawn).toHaveBeenCalledTimes(phase === "prepare" ? 2 : 3);
		expect(newSummary.pid).toBe(phase === "prepare" ? 102 : 103);
		expect(cleanup).toHaveBeenCalledOnce();
		if (phase === "hosted_spawn") expect(spawnedProcesses[1].stop).toHaveBeenCalledOnce();
	});

	it("身份恢复持久请求保留故障 episode，失效 episode 不能在补证后启动", async () => {
		const summary: RuntimeTaskSessionSummary = {
			...createAwaitingIdentitySummary(),
			agentId: "codex",
			taskConversationSessionMetadata: undefined,
			taskConversationSessionNativeIdentityRecovery: undefined,
		};
		const { manager, spawn } = createManager(summary);
		await manager.refreshTaskTerminal({
			...resumeRequest(summary),
			workspaceTaskId: summary.taskId,
			taskConversationSessionContextForkSourceNativeSessionId: undefined,
			automaticFailureContinuationEpisodeId: "no-longer-active-episode",
		});
		await advanceRecovery(manager);
		const persisted = manager.getSummary(summary.taskId);
		if (!persisted) throw new Error("缺少等待身份的持久会话摘要");
		expect(
			(await readTaskSessionResumeRequestWaitingForNativeConversationIdentity(persisted))
				?.automaticFailureContinuationEpisodeId,
		).toBe("no-longer-active-episode");
		const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
		await mkdir(sessionsDirectory, { recursive: true });
		const transcriptPath = join(sessionsDirectory, `rollout-${childId}.jsonl`);
		await writeFile(transcriptPath, `${JSON.stringify({ type: "session_meta", payload: { id: childId } })}\n`);
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "codex",
			nativeSessionId: childId,
			transcriptPath,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		expect(prepareLaunch).not.toHaveBeenCalled();
	});

	it.each(
		(["prepare", "hosted_spawn"] as const).flatMap((phase) =>
			(["cancelled", "expired"] as const).map((episodeTerminalPhase) => ({ phase, episodeTerminalPhase })),
		),
	)(
		"持久恢复等待 $phase 时 episode 变为 $episodeTerminalPhase，旧启动不得装载",
		async ({ phase, episodeTerminalPhase }) => {
			const entered = deferredCompletion();
			const release = deferredCompletion();
			const cleanup = vi.fn(async () => {});
			prepareLaunch.mockImplementation(async (input: AgentAdapters.AgentAdapterLaunchInput) => {
				if (phase === "prepare") {
					entered.complete();
					await release.promise;
				}
				return { args: input.args, env: {}, resumesPriorAgentConversation: true, cleanup };
			});
			const summary: RuntimeTaskSessionSummary = {
				...createAwaitingIdentitySummary(),
				agentId: "codex",
				taskConversationSessionMetadata: undefined,
				taskConversationSessionNativeIdentityRecovery: undefined,
			};
			const coordinator = createAutomaticAgentFailureContinuationCoordinator({
				now: () => Date.now(),
				publish: () => {},
				schedule: () => {},
				clearScheduled: () => {},
				canAttempt: () => true,
				submit: async () => ({ outcome: "deferred" }),
				target: () => ({
					agentId: "codex",
					workspaceId: "isolated-workspace",
					taskId: summary.taskId,
					conversationSessionId: summary.taskId,
					taskIncarnationCreatedAtEpochMs: 1,
					runtimeSessionIncarnationId: incarnation,
					nativeSessionId: null,
					ownerProcessId: null,
					executionWorkingDirectoryPath: isolatedHome,
					nativeTranscriptPath: null,
					faultTurnIdentity: "isolated-failed-turn",
				}),
			});
			coordinator.observeFailure("model_capacity", "isolated-failed-turn");
			const episode = coordinator.snapshot();
			if (!episode) throw new Error("未建立隔离故障 episode");
			summary.automaticAgentFailureContinuation = episode;
			const { manager, spawn, spawnedProcesses } = createManager(summary, async () => {
				if (phase === "hosted_spawn") {
					entered.complete();
					await release.promise;
				}
			});
			await manager.refreshTaskTerminal({
				...resumeRequest(summary),
				workspaceTaskId: summary.taskId,
				taskConversationSessionContextForkSourceNativeSessionId: undefined,
				automaticFailureContinuationEpisodeId: episode.episodeId,
			});
			const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
			await mkdir(sessionsDirectory, { recursive: true });
			const transcriptPath = join(sessionsDirectory, `rollout-${childId}.jsonl`);
			await writeFile(transcriptPath, `${JSON.stringify({ type: "session_meta", payload: { id: childId } })}\n`);
			manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
				sourceAgentId: "codex",
				nativeSessionId: childId,
				transcriptPath,
				observedAt: Date.now(),
			});
			await entered.promise;
			// 只改变 fixture 的 episode 活性，避免 Stop 等其它取消机制掩盖 episode 门禁。
			const internals = manager as unknown as { entries: Map<string, { summary: RuntimeTaskSessionSummary }> };
			const currentEpisode = internals.entries.get(summary.taskId)?.summary.automaticAgentFailureContinuation;
			if (!currentEpisode) throw new Error("缺少当前隔离 episode");
			currentEpisode.phase = episodeTerminalPhase;
			release.complete();
			await advanceRecovery(manager);
			expect(spawn).toHaveBeenCalledTimes(phase === "hosted_spawn" ? 1 : 0);
			if (phase === "hosted_spawn") expect(spawnedProcesses[0].stop).toHaveBeenCalledOnce();
			expect(cleanup).toHaveBeenCalledOnce();
			expect(manager.getSummary(summary.taskId)?.pid).toBeNull();
			expect(manager.getSummary(summary.taskId)?.automaticAgentFailureContinuation).toMatchObject({
				episodeId: episode.episodeId,
				phase: episodeTerminalPhase,
				attemptCount: episode.attemptCount,
			});
		},
	);

	it.each(["y\r", "1\r", "\r"])("确认按键 %j 不剥夺空会话等待身份后续跑的资格", async (rawInput) => {
		const summary = createAwaitingIdentitySummary();
		const { manager, spawn } = createManager(summary);
		const liveSummary = await manager.startTaskSession({
			...resumeRequest(summary),
			prompt: "",
			startInPlanMode: undefined,
			resumePriorAgentConversationWithoutResendingPrompt: false,
		});
		manager.writeInput(summary.taskId, Buffer.from(rawInput));
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionMetadata?.latestUserMessagePreview).toBeNull();
		await manager.refreshTaskTerminal(resumeRequest(liveSummary));
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledOnce();
		expect(manager.getSummary(summary.taskId)?.warningMessage).toContain("无需发送占位消息");
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(prepareLaunch).toHaveBeenLastCalledWith(
			expect.objectContaining({
				prompt: "",
				startInPlanMode: undefined,
				taskConversationSessionContextForkSourceNativeSessionId: undefined,
				observedAgentNativeConversationSessionResumeAddressing: expect.objectContaining({
					sourceSessionId: childId,
				}),
			}),
		);
	});

	it("真实人工输入取消旧恢复执行意图，身份仍可补证且真实接受才更新预览", async () => {
		const summary = createAwaitingIdentitySummary();
		const { manager, spawn } = createManager(summary);
		const liveSummary = await manager.startTaskSession({
			...resumeRequest(summary),
			prompt: "",
			startInPlanMode: undefined,
			resumePriorAgentConversationWithoutResendingPrompt: false,
		});
		await manager.refreshTaskTerminal(resumeRequest(liveSummary));
		await advanceRecovery(manager);
		expect(
			manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs,
		).not.toBeNull();
		manager.writeInput(summary.taskId, Buffer.from("  首次真实消息  \r"));
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionMetadata?.latestUserMessagePreview).toBeNull();
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery).toMatchObject({
			resumeRequestedAtMs: null,
		});
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledOnce();
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery).toBeNull();
		if (!liveSummary.runtimeSessionIncarnationId) throw new Error("缺少假 PTY 会话的进程代际");
		manager.confirmAcceptedAgentConversationInput(summary.taskId, {
			observedAtMs: Date.now(),
			eventId: "first-real-user-input",
			nativeSessionId: childId,
			runtimeSessionIncarnationId: liveSummary.runtimeSessionIncarnationId,
			submittedPromptText: "  首次真实消息  ",
		});
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionMetadata?.latestUserMessagePreview).toBe(
			"首次真实消息",
		);
	});

	it("原生转录预检拒绝时保留旧活体，转录迟到后重新解锁并按子身份续接一次", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const summary = { ...createAwaitingIdentitySummary(), agentId: "codex" as const };
		const { manager, spawn, spawnedProcesses } = createManager(summary);
		const request = {
			...resumeRequest(summary),
			env: { CODEX_HOME: join(isolatedHome, ".codex") },
		};
		await manager.startTaskSession({
			...request,
			prompt: "",
			resumePriorAgentConversationWithoutResendingPrompt: undefined,
		});
		await manager.refreshTaskTerminal(request);
		await advanceRecovery(manager);
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "codex",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(spawnedProcesses[0]?.stop).not.toHaveBeenCalled();
		expect(manager.getSummary(summary.taskId)?.pid).toBe(101);
		expect(spawn).toHaveBeenCalledOnce();
		for (let attempt = 0; attempt < 3; attempt++) {
			vi.setSystemTime(Date.now() + 15_000);
			await advanceRecovery(manager);
		}
		expect(
			manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery
				?.consecutiveUnchangedProbeCount,
		).toBe(3);
		const sessionsDirectory = join(isolatedHome, ".codex", "sessions", "2026", "10", "26");
		await mkdir(sessionsDirectory, { recursive: true });
		await writeFile(
			join(sessionsDirectory, `rollout-${childId}.jsonl`),
			`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
		);
		await advanceRecovery(manager);
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(spawnedProcesses[0]?.stop).toHaveBeenCalledOnce();
		expect(prepareLaunch.mock.calls.at(-1)?.[0]).toMatchObject({
			prompt: "",
			taskAgentPermissionMode: "ask_for_every_tool_use",
			observedAgentNativeConversationSessionResumeAddressing: { sourceSessionId: childId },
		});
	});

	it.each(
		(["missing_codex_home", "user_codex_home", "old_configuration_codex_home"] as const).flatMap(
			(storedEnvironmentKind) => [false, true].map((compressed) => ({ storedEnvironmentKind, compressed })),
		),
	)(
		"旧恢复请求环境为 $storedEnvironmentKind，压缩=$compressed：托管转录迟到仍解锁预算且只恢复一次",
		async ({ storedEnvironmentKind, compressed }) => {
			vi.useFakeTimers();
			vi.setSystemTime(1_000_000);
			// 身份恢复使用可读的隔离程序；插件能力替身选择完整独立目录，不启动原生插件命令。
			const isolatedCodexNativeIdentityRecoveryExecutable = join(isolatedHome, "codex-native-identity-recovery");
			await writeFile(
				isolatedCodexNativeIdentityRecoveryExecutable,
				`#!${process.execPath}\nif (process.argv[2] === '--version') process.stdout.write('codex-cli identity-recovery-fixture'); else process.exitCode = 1;\n`,
				{ mode: 0o700 },
			);
			vi.spyOn(
				CodexNativePluginInstallationCapabilityVerification,
				"verifyCodexNativeSharedPluginInstallationCapability",
			).mockResolvedValue({ status: "unsupported", reason: "身份恢复测试替身不提供插件安装能力" });
			const userCodexHome = join(isolatedHome, ".codex");
			const managedStorageHome = await prepareManagedCodexConversationStorageHome(userCodexHome);
			const childNativeSessionId = compressed ? compressedCodexTranscriptFixtureNativeSessionId : childId;
			const transcriptPath = join(managedStorageHome, "sessions", `rollout-${childNativeSessionId}.jsonl`);
			const summary: RuntimeTaskSessionSummary = {
				...createAwaitingIdentitySummary(),
				agentId: "codex",
				codexConversationStorageHomeDirectoryPath: managedStorageHome,
			};
			const { manager, spawn } = createManager(summary, undefined, {
				enableManagedCodexConversationStorageForNewSessions: true,
			});
			const request: StartTaskSessionRequest = {
				...resumeRequest(summary),
				binary: isolatedCodexNativeIdentityRecoveryExecutable,
				workspaceId: "isolated-managed-storage-workspace",
				terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "retained-side-session-model" },
				env:
					storedEnvironmentKind === "missing_codex_home"
						? undefined
						: {
								CODEX_HOME:
									storedEnvironmentKind === "user_codex_home"
										? userCodexHome
										: join(isolatedHome, "old-configuration-home"),
							},
			};
			await manager.refreshTaskTerminal(request);
			await advanceRecovery(manager);
			const waitingSummary = manager.getSummary(summary.taskId);
			if (!waitingSummary) throw new Error("缺少等待托管转录的会话摘要");
			const storedRequest = await readTaskSessionResumeRequestWaitingForNativeConversationIdentity(waitingSummary);
			expect(storedRequest?.env).toEqual(request.env);
			manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
				sourceAgentId: "codex",
				nativeSessionId: childNativeSessionId,
				transcriptPath,
				observedAt: Date.now(),
			});
			await advanceRecovery(manager);
			for (let attempt = 0; attempt < 3; attempt++) {
				vi.setSystemTime(Date.now() + 15_000);
				await advanceRecovery(manager);
			}
			expect(
				manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery
					?.consecutiveUnchangedProbeCount,
			).toBe(3);
			expect(spawn).not.toHaveBeenCalled();
			await mkdir(join(managedStorageHome, "sessions"), { recursive: true });
			await writeFile(
				compressed ? `${transcriptPath}.zst` : transcriptPath,
				compressed
					? compressedCodexTranscriptFixtureBytes()
					: `${JSON.stringify({ type: "session_meta", payload: { id: childNativeSessionId, source: "cli" } })}\n`,
			);
			await advanceRecovery(manager);
			await advanceRecovery(manager);
			expect(spawn).toHaveBeenCalledOnce();
			expect(prepareLaunch).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					prompt: "",
					startInPlanMode: undefined,
					taskConversationSessionContextForkSourceNativeSessionId: undefined,
					taskAgentPermissionMode: "ask_for_every_tool_use",
					terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "retained-side-session-model" },
					observedAgentNativeConversationSessionResumeAddressing: expect.objectContaining({
						sourceSessionId: childNativeSessionId,
					}),
				}),
			);
			expect(manager.getSummary(summary.taskId)?.codexConversationStorageHomeDirectoryPath).toBe(managedStorageHome);
			expect(manager.getSummary(summary.taskId)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
				childNativeSessionId,
			);
		},
	);

	it.each(
		(["prepare", "control_host", "hosted_spawn"] as const).flatMap((phase) =>
			(["stop", "force_stop", "responsibility_changed", "runtime_shutdown", "dispose"] as const).map(
				(cancellation) => ({ phase, cancellation }),
			),
		),
	)("$phase 等待期间发生 $cancellation，迟到启动不得装载或遗留进程", async ({ phase, cancellation }) => {
		const entered = deferredCompletion();
		const release = deferredCompletion();
		const cleanup = vi.fn(async () => {});
		const controlHostCleanup = vi.fn(async () => {});
		const waitForRelease = async () => {
			entered.complete();
			await release.promise;
		};
		prepareLaunch.mockImplementation(async (input: AgentAdapters.AgentAdapterLaunchInput) => {
			if (phase === "prepare") await waitForRelease();
			return { args: input.args, env: {}, resumesPriorAgentConversation: true, cleanup };
		});
		const agentId = phase === "control_host" ? "codex" : "claude";
		const summary: RuntimeTaskSessionSummary = { ...createAwaitingIdentitySummary(), agentId };
		const metadata = summary.taskConversationSessionMetadata;
		if (!metadata) throw new Error("缺少隔离侧会话 metadata");
		const { manager, spawn, spawnedProcesses } = createManager(
			summary,
			phase === "hosted_spawn" ? waitForRelease : undefined,
			{
				prepareCodexNativeSessionControlHostLaunch: async (input) => {
					await waitForRelease();
					return {
						binary: input.binary,
						args: [...input.arguments],
						endpoint: {
							workspaceId: input.workspaceId,
							conversationSessionId: input.conversationSessionId,
							runtimeSessionIncarnationId: input.runtimeSessionIncarnationId,
							socketPath: join(isolatedHome, "owned-codex-control.sock"),
						},
						cleanup: controlHostCleanup,
					};
				},
			},
		);
		if (phase === "control_host") {
			const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
			await mkdir(sessionsDirectory, { recursive: true });
			await writeFile(
				join(sessionsDirectory, `rollout-${childId}.jsonl`),
				`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
			);
		}
		await manager.refreshTaskTerminal({ ...resumeRequest(summary), workspaceId: "isolated-workspace" });
		await advanceRecovery(manager);
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: agentId,
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await entered.promise;
		switch (cancellation) {
			case "stop":
				manager.stopTaskSession(summary.taskId);
				break;
			case "force_stop":
				await manager.forceStopTaskSession(summary.taskId);
				break;
			case "responsibility_changed":
				manager.applyTaskConversationSessionMetadata(summary.taskId, {
					...metadata,
					taskConversationSessionHasHeldMainResponsibility: true,
				});
				break;
			case "runtime_shutdown":
				manager.markInterruptedAndStopAll();
				break;
			case "dispose":
				manager.dispose();
				break;
		}
		release.complete();
		await advanceRecovery(manager);
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledTimes(phase === "hosted_spawn" ? 1 : 0);
		if (phase === "hosted_spawn") {
			expect(spawnedProcesses[0]?.stop).toHaveBeenCalledOnce();
			expect(spawnedProcesses[0]?.hasExited()).toBe(true);
		}
		expect(cleanup).toHaveBeenCalledOnce();
		expect(controlHostCleanup).toHaveBeenCalledTimes(phase === "control_host" ? 1 : 0);
		expect(manager.getSummary(summary.taskId)?.pid).toBeNull();
		expect(manager.getSummary(summary.taskId)?.runtimeSessionIncarnationId).toBe(incarnation);
	});

	it("只暂停依赖身份的恢复，迟到子身份自动续接一次，原生 Rewind 后继续使用新身份", async () => {
		const summary = createAwaitingIdentitySummary();
		const { manager, spawn } = createManager(summary);
		await manager.refreshTaskTerminal({
			...resumeRequest(summary),
			terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "retained-side-session-model" },
		});
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		expect(manager.getSummary(summary.taskId)?.warningMessage).toContain("无需发送占位消息");
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledOnce();
		expect(prepareLaunch).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "",
				startInPlanMode: undefined,
				taskConversationSessionContextForkSourceNativeSessionId: undefined,
				taskAgentPermissionMode: "ask_for_every_tool_use",
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "retained-side-session-model" },
				observedAgentNativeConversationSessionResumeAddressing: expect.objectContaining({
					sourceSessionId: childId,
				}),
			}),
		);
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa",
			transcriptPath: null,
			observedAt: Date.now() + 1,
		});
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledOnce();
		expect(manager.getSummary(summary.taskId)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
			"cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa",
		);
	});

	it("同一证据最多三次，运行时重启保留预算；新证据自动解锁已保存的恢复请求", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const summary = createAwaitingIdentitySummary();
		const first = createManager(summary);
		await first.manager.refreshTaskTerminal(resumeRequest(summary));
		await advanceRecovery(first.manager);
		for (let attempt = 0; attempt < 3; attempt++) {
			vi.setSystemTime(Date.now() + 15_000);
			await advanceRecovery(first.manager);
		}
		expect(readOwnedIdentity).toHaveBeenCalledTimes(3);
		const persisted = first.manager.getSummary(summary.taskId) as RuntimeTaskSessionSummary;
		first.manager.dispose();
		const restarted = createManager(persisted);
		await advanceRecovery(restarted.manager);
		expect(readOwnedIdentity).toHaveBeenCalledTimes(3);
		// 其他 agent 的补证预算不能被无关的 Codex 转录目录变化解锁。
		const unrelatedCodexSessionsDirectory = join(isolatedHome, ".codex", "sessions");
		await mkdir(unrelatedCodexSessionsDirectory, { recursive: true });
		await writeFile(join(unrelatedCodexSessionsDirectory, "unrelated-transcript.jsonl"), "\n");
		await advanceRecovery(restarted.manager);
		expect(readOwnedIdentity).toHaveBeenCalledTimes(3);
		restarted.manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(restarted.manager);
		expect(restarted.spawn).toHaveBeenCalledOnce();
	});

	it.each(
		(["claude", "codex"] as const).flatMap((agentId) =>
			(["task_collaborator", "by_the_way"] as const).map((role) => ({ agentId, role })),
		),
	)("$agentId 的 $role 等待身份期间改名，保留宿主归属并只按子身份恢复一次", async ({ agentId, role }) => {
		const summary = { ...createAwaitingIdentitySummary(), agentId };
		const metadata = summary.taskConversationSessionMetadata;
		if (!metadata) throw new Error("缺少隔离侧会话 metadata");
		summary.taskConversationSessionMetadata = { ...metadata, taskConversationSessionRole: role };
		const { manager, spawn } = createManager(summary);
		await manager.refreshTaskTerminal({ ...resumeRequest(summary), workspaceTaskId: undefined });
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		const renamedMetadata = {
			...summary.taskConversationSessionMetadata,
			conversationSessionName: "排查创建设置",
			conversationSessionNameVersion: 1,
			conversationSessionNameSource: "automatic" as const,
		};
		manager.applyTaskConversationSessionMetadata(summary.taskId, renamedMetadata);
		const renamedSummary = manager.getSummary(summary.taskId);
		if (!renamedSummary) throw new Error("缺少改名后的侧会话摘要");
		const durableResume = await readTaskSessionResumeRequestWaitingForNativeConversationIdentity(renamedSummary);
		expect(durableResume).toEqual(
			expect.objectContaining({
				workspaceTaskId: "host-task",
				taskConversationSessionMetadata: renamedMetadata,
				prompt: "",
				resumePriorAgentConversationWithoutResendingPrompt: true,
			}),
		);
		expect(
			(
				await readTaskSessionResumeRequestWaitingForNativeConversationIdentity(renamedSummary, {
					rebuildAutomaticRecoveryMetadataForWorkspaceTaskId: "host-task",
				})
			)?.taskConversationSessionMetadata,
		).toEqual(renamedMetadata);
		expect(
			await readTaskSessionResumeRequestWaitingForNativeConversationIdentity({
				...renamedSummary,
				taskConversationSessionMetadata: { ...renamedMetadata, workspaceTaskId: "another-host" },
			}),
		).toBeNull();
		expect(
			await readTaskSessionResumeRequestWaitingForNativeConversationIdentity({
				...renamedSummary,
				taskConversationSessionMetadata: { ...renamedMetadata, latestUserMessagePreview: "已接受的新输入" },
			}),
		).toBeNull();
		let transcriptPath: string | null = null;
		if (agentId === "codex") {
			const sessionsDirectory = join(isolatedHome, ".codex", "sessions");
			await mkdir(sessionsDirectory, { recursive: true });
			transcriptPath = join(sessionsDirectory, `rollout-${childId}.jsonl`);
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
			);
		}
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: agentId,
			nativeSessionId: childId,
			transcriptPath,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		await advanceRecovery(manager);
		expect(spawn).toHaveBeenCalledOnce();
		expect(prepareLaunch).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "",
				startInPlanMode: undefined,
				taskConversationSessionMetadata: renamedMetadata,
				observedAgentNativeConversationSessionResumeAddressing: expect.objectContaining({
					sourceSessionId: childId,
				}),
			}),
		);
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionMetadata).toEqual(renamedMetadata);
		expect(spawn.mock.calls[0]?.[0].env.KANBAN_TASK_ID).toBe("host-task");
	});

	it("会话责任或启动快照变化后，迟到身份只补证，不执行旧恢复请求", async () => {
		const summary = createAwaitingIdentitySummary();
		const { manager, spawn } = createManager(summary);
		await manager.refreshTaskTerminal(resumeRequest(summary));
		await advanceRecovery(manager);
		const metadata = summary.taskConversationSessionMetadata;
		if (!metadata) throw new Error("缺少隔离侧会话 metadata");
		manager.applyTaskConversationSessionMetadata(summary.taskId, {
			...metadata,
			taskConversationSessionHasHeldMainResponsibility: true,
		});
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		expect(
			manager.getSummary(summary.taskId)?.taskConversationSessionMetadata
				?.taskConversationSessionHasHeldMainResponsibility,
		).toBe(true);
	});

	it("Stop 后迟到身份不得恢复，父身份也不能充当独立子身份", async () => {
		const summary = createAwaitingIdentitySummary();
		const { manager, spawn } = createManager(summary);
		await manager.refreshTaskTerminal(resumeRequest(summary));
		await advanceRecovery(manager);
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: parentId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		manager.stopTaskSession(summary.taskId);
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now() + 1,
		});
		await advanceRecovery(manager);
		expect(spawn).not.toHaveBeenCalled();
		expect(manager.getSummary(summary.taskId)?.taskConversationSessionNativeIdentityRecovery).toBeNull();
	});
});
