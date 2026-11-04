import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepared = vi.hoisted(() => vi.fn());
const spawned = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters", () => ({ prepareAgentLaunch: prepared }));
vi.mock("../../../src/terminal/pty-session", () => ({ PtySession: { spawn: spawned } }));

import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	getCodexConversationMigrationRecordPath,
	getManagedCodexConversationStorageHomeDirectoryPath,
	prepareManagedCodexConversationStorageHome,
	withCodexConversationStorageOperationLock,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
const managers: TerminalSessionManager[] = [];
const nativeSessionId = "01a15120-4476-78b0-8c56-5a7321338e0b";
beforeEach(async () => {
	fixture = createTempDir("kanban-codex-storage-launch-");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", join(fixture.path, ".codex"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, ".codex"));
	await mkdir(join(fixture.path, ".codex"));
	prepared.mockReset();
	prepared.mockImplementation(async (request) => ({ args: request.args, env: {} }));
	spawned.mockReset();
	spawned.mockImplementation((request) => {
		let exited = false;
		return {
			pid: 1234,
			write: vi.fn(),
			resize: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			hasExited: () => exited,
			stop: vi.fn(() => {
				exited = true;
				request.onExit?.({ exitCode: 0 });
			}),
			wasInterrupted: () => false,
		};
	});
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	fixture.cleanup();
});
function createManager() {
	const manager = new TerminalSessionManager({ enableManagedCodexConversationStorageForNewSessions: true });
	managers.push(manager);
	return manager;
}
function request() {
	return {
		taskId: "storage-session",
		agentId: "codex" as const,
		binary: "codex",
		args: [],
		cwd: fixture.path,
		prompt: "",
		workspaceId: "storage-workspace",
		env: { CODEX_HOME: join(fixture.path, ".codex") },
	};
}

function hydrateStoppedCodexSession(
	manager: TerminalSessionManager,
	homeDirectoryPath: string,
	transcriptPath: string | null = null,
) {
	manager.hydrateFromRecord({
		"storage-session": {
			taskId: "storage-session",
			state: "awaiting_review",
			agentId: "codex",
			workspacePath: fixture.path,
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: "hook",
			exitCode: 0,
			lastHookAt: null,
			latestHookActivity: null,
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
			codexConversationStorageHomeDirectoryPath: homeDirectoryPath,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath,
				observedAt: 1,
			},
		} as RuntimeTaskSessionSummary,
	});
}

describe("真实运行时启用 Codex 存储隔离的启动边界", () => {
	it("新会话在专用目录启动，持久摘要记录实际目录且不继承 App 来源", async () => {
		vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "codex_work_desktop");
		const manager = createManager();
		await manager.startTaskSession(request());
		const home = getManagedCodexConversationStorageHomeDirectoryPath();
		expect(spawned.mock.calls[0]?.[0].env.CODEX_HOME).toBe(
			manager.getSummary(request().taskId)?.codexConfigurationWriterBinding?.configurationHomeDirectoryPath,
		);
		expect(spawned.mock.calls[0]?.[0].env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
		expect(manager.getSummary(request().taskId)?.codexConversationStorageHomeDirectoryPath).toBe(home);
	});
	it("配置锁超过旧预算后并发 resume 只启动一次，保持原生身份、目录且不重发 prompt", async () => {
		const manager = createManager();
		const home = join(fixture.path, ".codex");
		const transcriptPath = join(home, "sessions", `${nativeSessionId}.jsonl`);
		await mkdir(dirname(transcriptPath));
		await writeFile(
			transcriptPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
		);
		hydrateStoppedCodexSession(manager, home, transcriptPath);
		let releaseStoreMutation = () => {};
		let markStoreMutationStarted = () => {};
		const storeMutationStarted = new Promise<void>((resolve) => {
			markStoreMutationStarted = resolve;
		});
		const storeMutationMayFinish = new Promise<void>((resolve) => {
			releaseStoreMutation = resolve;
		});
		const heldMutation = mutateCodexConfigurationSyncStore(async () => {
			markStoreMutationStarted();
			await storeMutationMayFinish;
		});
		await storeMutationStarted;
		const acquireLock = lockfile.lock;
		const oldScheduleWaiter = acquireLock(getCodexConfigurationSyncDirectory(), {
			realpath: false,
			retries: { retries: 30, minTimeout: 20, maxTimeout: 150 },
		}).then(
			async (release) => {
				await release();
				return "acquired";
			},
			(error: NodeJS.ErrnoException) => error.code,
		);
		let markResumeWaiting = () => {};
		const resumeWaiting = new Promise<void>((resolve) => {
			markResumeWaiting = resolve;
		});
		vi.spyOn(lockfile, "lock").mockImplementation((path, options) => {
			const waiting = acquireLock(path, options);
			if (path === getCodexConfigurationSyncDirectory()) markResumeWaiting();
			return waiting;
		});
		const resumeRequest = {
			...request(),
			prompt: "原始提示词不得重发",
			resumePriorAgentConversationWithoutResendingPrompt: true,
		};
		const resumes = Promise.all([
			manager.startTaskSession(resumeRequest, "stale_session_client_auto_resume"),
			manager.startTaskSession(resumeRequest, "stale_session_client_auto_resume"),
		]).then(
			(summaries) => ({ summaries }),
			(error: unknown) => ({ error }),
		);
		try {
			await resumeWaiting;
			expect(spawned).not.toHaveBeenCalled();
			expect(await oldScheduleWaiter).toBe("ELOCKED");
			// 旧等待方放弃后仍保持占用，避免用例因调度误差失去对旧预算的区分力。
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 1_000);
			});
			releaseStoreMutation();
			await heldMutation;
			const outcome = await resumes;
			expect(outcome).not.toHaveProperty("error");
			expect(spawned).toHaveBeenCalledOnce();
			expect(prepared).toHaveBeenCalledOnce();
			expect(prepared.mock.calls[0]?.[0].observedAgentNativeConversationSessionResumeAddressing).toMatchObject({
				sourceSessionId: nativeSessionId,
				sourceSessionReuseMode: "resume_existing_session",
			});
			expect(spawned.mock.calls[0]?.[0].cwd).toBe(fixture.path);
			expect(manager.getSummary(request().taskId)?.codexConversationStorageHomeDirectoryPath).toBe(home);
			expect(manager.getSummary(request().taskId)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
				nativeSessionId,
			);
			expect(spawned.mock.results[0]?.value.write).not.toHaveBeenCalled();
		} finally {
			releaseStoreMutation();
			await heldMutation;
			await resumes;
			await oldScheduleWaiter;
		}
	}, 60_000);

	it("新目录启用后，旧会话仍在原目录按原生 ID 续接", async () => {
		const manager = createManager();
		const path = join(fixture.path, ".codex", "sessions", `${nativeSessionId}.jsonl`);
		await mkdir(join(fixture.path, ".codex", "sessions"));
		await writeFile(
			path,
			`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
		);
		manager.hydrateFromRecord({
			"storage-session": {
				taskId: "storage-session",
				state: "awaiting_review",
				agentId: "codex",
				workspacePath: fixture.path,
				pid: null,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: "hook",
				exitCode: 0,
				lastHookAt: null,
				latestHookActivity: null,
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId,
					transcriptPath: path,
					observedAt: 1,
				},
			} as RuntimeTaskSessionSummary,
		});
		await manager.startTaskSession({ ...request(), resumeFromTrash: true });
		expect(spawned.mock.calls[0]?.[0].env.CODEX_HOME).toBe(
			manager.getSummary(request().taskId)?.codexConfigurationWriterBinding?.configurationHomeDirectoryPath,
		);
		expect(manager.getSummary(request().taskId)?.codexConversationStorageHomeDirectoryPath).toBe(
			join(fixture.path, ".codex"),
		);
		expect(prepared.mock.calls[0]?.[0].observedAgentNativeConversationSessionResumeAddressing.sourceSessionId).toBe(
			nativeSessionId,
		);
	});
	it("启动另一条新会话不会停止或改绑已有会话", async () => {
		const manager = createManager();
		await manager.startTaskSession(request());
		const first = spawned.mock.results[0].value;
		await manager.startTaskSession({ ...request(), taskId: "another-storage-session" });
		expect(first.stop).not.toHaveBeenCalled();
		expect(manager.getSummary("storage-session")?.pid).toBe(1234);
		expect(manager.getSummary("storage-session")?.codexConversationStorageHomeDirectoryPath).toBe(
			getManagedCodexConversationStorageHomeDirectoryPath(),
		);
	});
	it.each(["refresh_task_terminal", "stale_session_client_auto_resume"] as const)(
		"%s 在缺少请求 env 和转录路径时按摘要中的专用目录预检并续接",
		async (origin) => {
			const manager = createManager();
			const home = await prepareManagedCodexConversationStorageHome(join(fixture.path, ".codex"));
			await mkdir(join(home, "sessions"));
			await writeFile(
				join(home, "sessions", `rollout-${nativeSessionId}.jsonl`),
				`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
			);
			hydrateStoppedCodexSession(manager, home);
			await manager.refreshTaskTerminal({ ...request(), env: undefined, resumeFromTrash: true }, origin);
			expect(spawned).toHaveBeenCalledOnce();
			expect(spawned.mock.calls[0]?.[0].env.CODEX_HOME).toBe(
				manager.getSummary(request().taskId)?.codexConfigurationWriterBinding?.configurationHomeDirectoryPath,
			);
			expect(
				prepared.mock.calls[0]?.[0].observedAgentNativeConversationSessionResumeAddressing.sourceSessionId,
			).toBe(nativeSessionId);
		},
	);

	it("迁移后的刷新从最早预检起遵循正式目录绑定，并覆盖整个重启的存储互斥", async () => {
		const manager = createManager();
		const sourceHome = join(fixture.path, ".codex");
		const home = await prepareManagedCodexConversationStorageHome(sourceHome);
		await mkdir(join(home, "sessions"));
		await writeFile(
			join(home, "sessions", `rollout-${nativeSessionId}.jsonl`),
			`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
		);
		const migrationRecordPath = getCodexConversationMigrationRecordPath(sourceHome, nativeSessionId);
		await mkdir(dirname(migrationRecordPath), { recursive: true });
		await writeFile(
			migrationRecordPath,
			JSON.stringify({
				nativeSessionId,
				sourceHomeDirectoryPath: sourceHome,
				targetHomeDirectoryPath: home,
				stage: "source_archived",
			}),
		);
		hydrateStoppedCodexSession(manager, sourceHome, join(sourceHome, "sessions", `rollout-${nativeSessionId}.jsonl`));
		prepared.mockImplementationOnce(async (input) => {
			await expect(
				withCodexConversationStorageOperationLock(home, nativeSessionId, async () => undefined),
			).rejects.toThrow();
			return { args: input.args, env: {} };
		});
		await manager.refreshTaskTerminal({ ...request(), env: undefined, resumeFromTrash: true });
		expect(spawned).toHaveBeenCalledOnce();
		expect(spawned.mock.calls[0]?.[0].env.CODEX_HOME).toBe(
			manager.getSummary(request().taskId)?.codexConfigurationWriterBinding?.configurationHomeDirectoryPath,
		);
		// 启动后的原生 hook 尚未刷新转录路径时，活体仍以本代实际目录为准。
		await manager.refreshTaskTerminal({ ...request(), env: undefined, resumeFromTrash: true });
		expect(spawned).toHaveBeenCalledTimes(2);
		expect(spawned.mock.calls[1]?.[0].env.CODEX_HOME).toBe(
			manager.getSummary(request().taskId)?.codexConfigurationWriterBinding?.configurationHomeDirectoryPath,
		);
	});

	it("专用目录转录暂缺时持久等待补证，保留现有活体和原目录绑定", async () => {
		const manager = createManager();
		await manager.startTaskSession(request());
		manager.applyAgentNativeConversationSessionIdentity(request().taskId, {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: null,
			observedAt: 1,
		});
		const activeProcess = spawned.mock.results[0]?.value;
		const waitingSummary = await manager.refreshTaskTerminal({ ...request(), env: undefined, resumeFromTrash: true });
		expect(waitingSummary.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(nativeSessionId);
		expect(waitingSummary.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs).toEqual(
			expect.any(Number),
		);
		expect(activeProcess.stop).not.toHaveBeenCalled();
		expect(spawned).toHaveBeenCalledOnce();
		expect(manager.getSummary(request().taskId)?.codexConversationStorageHomeDirectoryPath).toBe(
			getManagedCodexConversationStorageHomeDirectoryPath(),
		);
	});
});
