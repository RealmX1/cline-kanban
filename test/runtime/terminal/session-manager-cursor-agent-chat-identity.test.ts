// Cursor 会话在启动漏斗里的身份与续跑预检（kanban task 203f3）。守的不变量：
//  1. 全新开局：kanban 在 spawn **之前**分配 chat id、写进 summary 并落盘，再交给 adapter 以 `--resume <id> <prompt>` 开局；
//  2. 续跑：能按记录的 id 接上就按 id；没记录 id 时，桶里唯一一段已建立的对话被钉成身份；
//  3. 接不上任何已建立的对话 ⇒ 拒绝且**不 spawn、不动活会话**，状态如实标成「从未建立对话」；
//  4. 首轮落盘看门狗：prompt 迟迟没进 chat store 时当场标出（能认出信任对话框就写明），对话建立后撤销告警；
//  5. Cursor 恢复后，终端里的 Enter 解除续跑守卫（它没有可靠的 UserPromptSubmit hook）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory } from "../../../src/terminal/cursor-agent-chat-store-location-and-conversation-inspection";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	const session = {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(() => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode: 0 });
		}),
		wasInterrupted: vi.fn(() => false),
		hasExited: vi.fn(() => session.exitedFlag),
		exitedFlag: false,
		emitOutput: (text: string) => request.onData?.(Buffer.from(text, "utf8")),
		triggerExit: (exitCode: number | null) => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode });
		},
	};
	return session;
}

const TASK_ID = "8ef28";
let temporaryDirectoryPath: string;
let cursorConfigDirectoryPath: string;
let taskWorkingDirectoryPath: string;

function createManager(options: {
	persistedSummaries?: Array<{ taskId: string; summary: RuntimeTaskSessionSummary }>;
}) {
	const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		const session = createMockPtySession(100 + spawnedSessions.length, request);
		spawnedSessions.push(session);
		return session;
	});
	const manager = new TerminalSessionManager({
		persistAgentNativeConversationSessionIdentityImmediately: async (taskId, readCurrentSessionSummary) => {
			const summary = readCurrentSessionSummary();
			if (summary) {
				options.persistedSummaries?.push({ taskId, summary });
			}
		},
	});
	return { manager, spawnedSessions };
}

function cursorStartRequest(overrides: Record<string, unknown> = {}) {
	return {
		taskId: TASK_ID,
		agentId: "cursor" as const,
		binary: "cursor-agent",
		args: [],
		cwd: taskWorkingDirectoryPath,
		prompt: "Implement the feature",
		env: { CURSOR_CONFIG_DIR: cursorConfigDirectoryPath },
		...overrides,
	};
}

function cursorRefreshRequest() {
	return cursorStartRequest({ prompt: "", resumeFromTrash: true });
}

async function writeCursorChat(chatId: string, meta: Record<string, unknown> | null): Promise<void> {
	const bucketDirectoryPath = await resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
		taskWorkingDirectoryPath,
		{ CURSOR_CONFIG_DIR: cursorConfigDirectoryPath },
	);
	mkdirSync(join(bucketDirectoryPath, chatId), { recursive: true });
	writeFileSync(join(bucketDirectoryPath, chatId, "store.db"), "sqlite");
	if (meta) {
		writeFileSync(join(bucketDirectoryPath, chatId, "meta.json"), JSON.stringify(meta));
	}
}

function lastPrepareAgentLaunchInput(): Record<string, unknown> | undefined {
	const calls = prepareAgentLaunchMock.mock.calls;
	return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

function hydratedCursorSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: TASK_ID,
		state: "awaiting_review",
		agentId: "cursor",
		workspacePath: taskWorkingDirectoryPath,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: "exit",
		exitCode: 1,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: "会话连续 5 次启动后都在 30 秒内退出，已停止自动重启。请手动刷新终端。",
		...overrides,
	} as RuntimeTaskSessionSummary;
}

describe("TerminalSessionManager Cursor chat identity", () => {
	beforeEach(() => {
		temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-session-manager-cursor-identity-"));
		cursorConfigDirectoryPath = join(temporaryDirectoryPath, "cursor-config");
		taskWorkingDirectoryPath = join(temporaryDirectoryPath, "task-worktree");
		mkdirSync(taskWorkingDirectoryPath, { recursive: true });
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	});

	it("assigns and persists a fresh chat id before spawning, then hands it to the adapter as a fresh start", async () => {
		const persistedSummaries: Array<{ taskId: string; summary: RuntimeTaskSessionSummary }> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => createMockPtySession(100, request));
		let spawnCountWhenPersisted: number | null = null;
		const managerWithSpy = new TerminalSessionManager({
			persistAgentNativeConversationSessionIdentityImmediately: async (taskId, readCurrentSessionSummary) => {
				spawnCountWhenPersisted = ptySessionSpawnMock.mock.calls.length;
				const summary = readCurrentSessionSummary();
				if (summary) persistedSummaries.push({ taskId, summary });
			},
		});

		await managerWithSpy.startTaskSession(cursorStartRequest());

		const identity = managerWithSpy.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity;
		expect(identity).toMatchObject({
			sourceAgentId: "cursor",
			identityEstablishmentMethod: "kanban_assigned_before_agent_launch",
		});
		// 落盘发生在 spawn 之前，且落下的就是同一个 id。
		expect(spawnCountWhenPersisted).toBe(0);
		expect(persistedSummaries[0]?.summary.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
			identity?.nativeSessionId,
		);
		expect(lastPrepareAgentLaunchInput()?.kanbanAssignedAgentNativeConversationSessionIdForFreshStart).toBe(
			identity?.nativeSessionId,
		);
		expect(lastPrepareAgentLaunchInput()?.observedAgentNativeConversationSessionResumeAddressing).toBeUndefined();
	});

	it("gives every fresh start its own chat id, including the crash auto-restart that replays the original prompt", async () => {
		const { manager, spawnedSessions } = createManager({});
		manager.attach(TASK_ID, { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(cursorStartRequest());
		const firstChatId = manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId;

		// 崩溃后的自动重启拿原始 prompt 全新重跑（首次退避 0ms）。
		spawnedSessions[0]?.triggerExit(1);
		await vi.waitFor(() => expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2));

		const secondChatId = manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId;
		expect(firstChatId).toBeTruthy();
		expect(secondChatId).toBeTruthy();
		expect(secondChatId).not.toBe(firstChatId);
		expect(lastPrepareAgentLaunchInput()?.kanbanAssignedAgentNativeConversationSessionIdForFreshStart).toBe(
			secondChatId,
		);
	});

	it("resumes a restarted session by the chat id it was started with", async () => {
		const { manager } = createManager({});
		await manager.startTaskSession(cursorStartRequest());
		const chatId = manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId ?? "";
		await writeCursorChat(chatId, { hasConversation: true });

		await manager.refreshTaskTerminal(cursorRefreshRequest());

		expect(lastPrepareAgentLaunchInput()?.observedAgentNativeConversationSessionResumeAddressing).toEqual({
			sourceAgentId: "cursor",
			sourceSessionId: chatId,
			sourceSessionReuseMode: "resume_existing_session",
		});
		// 续跑不是开局：不再分配新 id。
		expect(
			lastPrepareAgentLaunchInput()?.kanbanAssignedAgentNativeConversationSessionIdForFreshStart,
		).toBeUndefined();
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(chatId);
	});

	it("refuses to resume a chat that was never established, without spawning or disturbing the live session", async () => {
		const { manager, spawnedSessions } = createManager({});
		await manager.startTaskSession(cursorStartRequest());
		const liveSession = spawnedSessions[0];
		// 首轮从未落盘（停在信任对话框）：chat 目录根本不存在。

		await expect(manager.refreshTaskTerminal(cursorRefreshRequest())).rejects.toThrow("没有可续接的 Cursor 对话");

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(liveSession?.stop).not.toHaveBeenCalled();
		const summary = manager.getSummary(TASK_ID);
		expect(summary?.pid).toBe(100);
		expect(summary?.agentNativeConversationPersistenceObservation).toMatchObject({
			persistenceStatus: "conversation_never_established_in_agent_native_store",
			nativeSessionId: summary?.agentNativeConversationSessionIdentity?.nativeSessionId,
		});
	});

	it("refuses a legacy resume with an empty bucket after a runtime restart, and explains it on a restorable screen", async () => {
		const { manager } = createManager({});
		manager.hydrateFromRecord({ [TASK_ID]: hydratedCursorSummary() });

		await expect(manager.refreshTaskTerminal(cursorRefreshRequest())).rejects.toThrow("刷新也一样");

		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		const summary = manager.getSummary(TASK_ID);
		expect(summary?.warningMessage).toContain("没有可续接的 Cursor 对话");
		expect(summary?.agentNativeConversationPersistenceObservation?.persistenceStatus).toBe(
			"conversation_never_established_in_agent_native_store",
		);
		// 空快照会被前端当成「镜像丢了」去自动续跑——拒绝时必须留下一份写着原因的快照。
		const restoreSnapshot = await manager.getRestoreSnapshot(TASK_ID);
		expect(restoreSnapshot?.snapshot).toContain("Cursor");
	});

	it("pins the unique established chat of a legacy session and resumes it by id", async () => {
		const persistedSummaries: Array<{ taskId: string; summary: RuntimeTaskSessionSummary }> = [];
		const { manager } = createManager({ persistedSummaries });
		manager.hydrateFromRecord({ [TASK_ID]: hydratedCursorSummary() });
		await writeCursorChat("4debf190-1111-4222-8333-944444444444", { hasConversation: true });
		await writeCursorChat("aaaaaaaa-1111-4222-8333-944444444444", { hasConversation: false });

		await manager.refreshTaskTerminal(cursorRefreshRequest());

		expect(lastPrepareAgentLaunchInput()?.observedAgentNativeConversationSessionResumeAddressing).toMatchObject({
			sourceSessionId: "4debf190-1111-4222-8333-944444444444",
		});
		expect(persistedSummaries.at(-1)?.summary.agentNativeConversationSessionIdentity).toMatchObject({
			nativeSessionId: "4debf190-1111-4222-8333-944444444444",
			identityEstablishmentMethod: "unique_established_chat_in_working_directory_bucket_backfill",
		});
	});

	it("keeps the legacy --continue path without pinning when the bucket holds several established chats", async () => {
		const { manager } = createManager({});
		manager.hydrateFromRecord({ [TASK_ID]: hydratedCursorSummary() });
		await writeCursorChat("11111111-1111-4222-8333-944444444444", { hasConversation: true });
		await writeCursorChat("22222222-1111-4222-8333-944444444444", { hasConversation: true });

		await manager.refreshTaskTerminal(cursorRefreshRequest());

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(lastPrepareAgentLaunchInput()?.observedAgentNativeConversationSessionResumeAddressing).toBeUndefined();
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity ?? null).toBeNull();
	});

	it("flags a first prompt that never reached the chat store, names the trust dialog, and clears once established", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
		const { manager, spawnedSessions } = createManager({});
		await manager.startTaskSession(cursorStartRequest());
		const chatId = manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId ?? "";
		spawnedSessions[0]?.emitOutput("Workspace Trust Required\r\nDo you trust the contents of this directory?\r\n");
		const scanForStalls = () =>
			(manager as unknown as { scanForStalls: () => Promise<void> }).scanForStalls.call(manager);

		await scanForStalls();
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationPersistenceObservation ?? null).toBeNull();

		vi.setSystemTime(new Date("2026-10-02T10:01:00Z"));
		await scanForStalls();
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationPersistenceObservation).toMatchObject({
			persistenceStatus: "first_prompt_not_persisted_within_startup_window",
			nativeSessionId: chatId,
			suspectedBlockingCause: "agent_workspace_trust_prompt_awaiting_answer",
		});

		// 用户在终端里应答了信任对话框：prompt 进了 store，首个检查点后对话建立。
		await writeCursorChat(chatId, { hasConversation: false });
		await scanForStalls();
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationPersistenceObservation ?? null).toBeNull();
		await writeCursorChat(chatId, { hasConversation: true });
		await scanForStalls();
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationPersistenceObservation?.persistenceStatus).toBe(
			"conversation_established_in_agent_native_store",
		);
	});

	it("marks the session as never established the moment its process exits before the first checkpoint", async () => {
		const { manager, spawnedSessions } = createManager({});
		await manager.startTaskSession(cursorStartRequest());

		spawnedSessions[0]?.triggerExit(0);

		await vi.waitFor(() => {
			expect(manager.getSummary(TASK_ID)?.agentNativeConversationPersistenceObservation?.persistenceStatus).toBe(
				"conversation_never_established_in_agent_native_store",
			);
		});
	});

	it("adopts an orphan chat from another worktree into a never-established session and resumes it by id", async () => {
		const persistedSummaries: Array<{ taskId: string; summary: RuntimeTaskSessionSummary }> = [];
		const { manager } = createManager({ persistedSummaries });
		manager.hydrateFromRecord({
			[TASK_ID]: hydratedCursorSummary({
				agentNativeConversationPersistenceObservation: {
					persistenceStatus: "conversation_never_established_in_agent_native_store",
					nativeSessionId: null,
					workingDirectoryPath: taskWorkingDirectoryPath,
					suspectedBlockingCause: null,
					observedAt: 1,
				},
			}),
		});
		// 另一张卡（c2555）的 worktree 里留下的同 prompt 对话。
		const sourceWorkingDirectoryPath = join(temporaryDirectoryPath, "c2555-worktree");
		mkdirSync(sourceWorkingDirectoryPath, { recursive: true });
		const sourceBucketDirectoryPath = await resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
			sourceWorkingDirectoryPath,
			{ CURSOR_CONFIG_DIR: cursorConfigDirectoryPath },
		);
		const orphanChatId = "4debf190-1111-4222-8333-944444444444";
		mkdirSync(join(sourceBucketDirectoryPath, orphanChatId), { recursive: true });
		writeFileSync(join(sourceBucketDirectoryPath, orphanChatId, "store.db"), "sqlite");
		writeFileSync(join(sourceBucketDirectoryPath, orphanChatId, "meta.json"), '{"hasConversation":true}');

		await manager.refreshTaskTerminal(cursorRefreshRequest(), "refresh_task_terminal", {
			adoptExistingAgentConversationAsTaskSessionIdentity: {
				sourceAgentId: "cursor",
				sourceSessionId: orphanChatId,
				sourceSessionReuseMode: "resume_existing_session",
				sourceSessionWorkingDirectoryPath: sourceWorkingDirectoryPath,
			},
		});

		expect(lastPrepareAgentLaunchInput()?.observedAgentNativeConversationSessionResumeAddressing).toMatchObject({
			sourceSessionId: orphanChatId,
		});
		const summary = manager.getSummary(TASK_ID);
		expect(summary?.agentNativeConversationSessionIdentity).toMatchObject({
			nativeSessionId: orphanChatId,
			identityEstablishmentMethod: "task_agent_session_initialization_seed_materialized_into_working_directory",
		});
		expect(summary?.agentNativeConversationPersistenceObservation ?? null).toBeNull();
		expect(persistedSummaries.at(-1)?.summary.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
			orphanChatId,
		);
	});

	it("refuses to adopt a conversation that belongs to a different agent", async () => {
		const { manager } = createManager({});
		manager.hydrateFromRecord({ [TASK_ID]: hydratedCursorSummary() });
		await expect(
			manager.refreshTaskTerminal(cursorRefreshRequest(), "refresh_task_terminal", {
				adoptExistingAgentConversationAsTaskSessionIdentity: {
					sourceAgentId: "claude",
					sourceSessionId: "4debf190-1111-4222-8333-944444444444",
					sourceSessionReuseMode: "resume_existing_session",
				},
			}),
		).rejects.toThrow("only supported for agents whose session id Kanban assigns");
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
	});

	it("disarms the restoration guard of a resumed Cursor session on Enter, since Cursor has no reliable submit hook", async () => {
		const { manager } = createManager({});
		await manager.startTaskSession(cursorStartRequest());
		const chatId = manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId ?? "";
		await writeCursorChat(chatId, { hasConversation: true });
		await manager.refreshTaskTerminal(cursorRefreshRequest());
		expect(manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe(
			"restored_agent_conversation_waiting_for_explicit_user_input",
		);

		manager.writeInput(TASK_ID, Buffer.from("continue please\r", "utf8"));

		expect(manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe("inactive");
	});

	// 2026-10-11 a768a 形态：首个真人提交晚于恢复启动 30 分钟。解除漏斗曾先判带 30 分钟兜底的谓词，超时后
	// 直接返回，声明态永久残留，排队投递被门控 5 挡到过期。
	it("still disarms on Enter when the first continuation comes after the guard's maximum armed duration", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-11T16:28:16Z"));
		const { manager } = createManager({});
		await manager.startTaskSession(cursorStartRequest());
		const chatId = manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity?.nativeSessionId ?? "";
		await writeCursorChat(chatId, { hasConversation: true });
		await manager.refreshTaskTerminal(cursorRefreshRequest());
		expect(manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe(
			"restored_agent_conversation_waiting_for_explicit_user_input",
		);

		vi.setSystemTime(new Date("2026-10-11T17:16:12Z"));
		manager.writeInput(TASK_ID, Buffer.from("continue please\r", "utf8"));

		expect(manager.getSummary(TASK_ID)?.restorationContinuationGuardState).toBe("inactive");
	});
});
