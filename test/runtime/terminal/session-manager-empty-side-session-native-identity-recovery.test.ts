import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type * as AgentAdapters from "../../../src/terminal/agent-session-adapters";
import {
	type StartTaskSessionRequest,
	TerminalSessionManager,
	type TerminalSessionManagerOptions,
} from "../../../src/terminal/session-manager";
import type * as IdentityRecovery from "../../../src/terminal/side-session-native-identity-recovery";
import { readSideSessionResumeRequestWaitingForNativeIdentity } from "../../../src/terminal/side-session-native-identity-recovery";
import type { HostedTerminalPtyProcessSpawnRequest } from "../../../src/terminal/terminal-pty-process-handle";

const prepareLaunch = vi.hoisted(() => vi.fn());
const readOwnedIdentity = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentAdapters>()),
	prepareAgentLaunch: prepareLaunch,
}));
vi.mock("../../../src/terminal/side-session-native-identity-recovery", async (importOriginal) => ({
	...(await importOriginal<typeof IdentityRecovery>()),
	readSideSessionNativeIdentityFromOwnedCodexControl: readOwnedIdentity,
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
	const spawnedProcesses: Array<{ stop: ReturnType<typeof vi.fn>; hasExited: () => boolean }> = [];
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
		taskConversationSessionMainContextForkSourceNativeSessionId: parentId,
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
		advanceSideSessionNativeIdentityRecovery(entry: unknown): Promise<void>;
	};
	await internals.advanceSideSessionNativeIdentityRecovery(internals.entries.get("empty-side-session"));
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
	vi.unstubAllEnvs();
	await rm(isolatedHome, { recursive: true, force: true });
});

describe("空侧会话的原生身份补证恢复", () => {
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
				taskConversationSessionMainContextForkSourceNativeSessionId: undefined,
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

	it.each(["missing_codex_home", "user_codex_home", "old_configuration_codex_home"] as const)(
		"旧恢复请求环境为 %s，托管转录迟到仍解锁预算并只按子身份恢复一次",
		async (storedEnvironmentKind) => {
			vi.useFakeTimers();
			vi.setSystemTime(1_000_000);
			const userCodexHome = join(isolatedHome, ".codex");
			const managedStorageHome = await prepareManagedCodexConversationStorageHome(userCodexHome);
			const transcriptPath = join(managedStorageHome, "sessions", `rollout-${childId}.jsonl`);
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
			const storedRequest = await readSideSessionResumeRequestWaitingForNativeIdentity(waitingSummary);
			expect(storedRequest?.env).toEqual(request.env);
			manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
				sourceAgentId: "codex",
				nativeSessionId: childId,
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
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: childId, source: "cli" } })}\n`,
			);
			await advanceRecovery(manager);
			await advanceRecovery(manager);
			expect(spawn).toHaveBeenCalledOnce();
			expect(prepareLaunch).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					prompt: "",
					startInPlanMode: undefined,
					taskConversationSessionMainContextForkSourceNativeSessionId: undefined,
					taskAgentPermissionMode: "ask_for_every_tool_use",
					terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "retained-side-session-model" },
					observedAgentNativeConversationSessionResumeAddressing: expect.objectContaining({
						sourceSessionId: childId,
					}),
				}),
			);
			expect(manager.getSummary(summary.taskId)?.codexConversationStorageHomeDirectoryPath).toBe(managedStorageHome);
			expect(manager.getSummary(summary.taskId)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
				childId,
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
				taskConversationSessionMainContextForkSourceNativeSessionId: undefined,
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
		restarted.manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "claude",
			nativeSessionId: childId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
		await advanceRecovery(restarted.manager);
		expect(restarted.spawn).toHaveBeenCalledOnce();
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
