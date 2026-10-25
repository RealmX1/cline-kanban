// 续跑寻址在启动漏斗里的接线。守的四条不变量：
//  1. 有原生会话身份 ⇒ 按 id 续跑，`--continue` 那条 cwd-latest 分支彻底不参与；
//  2. 寻址**每次启动现算**，绝不烘焙进 entry.restartRequest（会话 id 会随 fork / 重开漂移）；
//  3. cwd 被同 agent 的其它会话竞争、又没有 id 可用 ⇒ 如实拒绝，且**一动不动**：不杀活会话、不标 failed；
//  4. 调用方漏传 taskConversationSessionMetadata 时，只读约束按 summary 上一代盖的章兜底（只收紧不放宽）。
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import type { RuntimeTaskAgentSessionInitialization } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
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
		// 真实 PTY 被停掉后会回调 onExit；照做能让 forceStopTaskSession 立刻返回，
		// 而不是每次刷新都干等满 2s 的强杀超时。
		stop: vi.fn(() => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode: 0 });
		}),
		wasInterrupted: vi.fn(() => false),
		hasExited: vi.fn(() => session.exitedFlag),
		exitedFlag: false,
		triggerExit: (exitCode: number | null) => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode });
		},
	};
	return session;
}

const MAIN_TASK_ID = "card-1";
const BY_THE_WAY_TASK_ID = "task-conversation-session-1111";
const SHARED_EXECUTION_WORKING_DIRECTORY = "/tmp/task-worktree";
const MAIN_NATIVE_SESSION_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BY_THE_WAY_NATIVE_SESSION_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const REFRESHED_NATIVE_SESSION_ID = "cccccccc-3333-4333-8333-cccccccccccc";

function readMostRecentResumeAddressing(): RuntimeTaskAgentSessionInitialization | undefined {
	const calls = prepareAgentLaunchMock.mock.calls;
	const lastCall = calls[calls.length - 1]?.[0] as
		| { observedAgentNativeConversationSessionResumeAddressing?: RuntimeTaskAgentSessionInitialization }
		| undefined;
	return lastCall?.observedAgentNativeConversationSessionResumeAddressing;
}

function createManagerWithSpawnedSessions(): {
	manager: TerminalSessionManager;
	spawnedSessions: Array<ReturnType<typeof createMockPtySession>>;
} {
	const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		const session = createMockPtySession(100 + spawnedSessions.length, request);
		spawnedSessions.push(session);
		return session;
	});
	return { manager: new TerminalSessionManager(), spawnedSessions };
}

async function startMainSession(manager: TerminalSessionManager): Promise<void> {
	await manager.startTaskSession({
		taskId: MAIN_TASK_ID,
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
		prompt: "Implement the feature",
	});
}

async function startByTheWaySession(manager: TerminalSessionManager): Promise<void> {
	await manager.startTaskSession({
		taskId: BY_THE_WAY_TASK_ID,
		workspaceTaskId: MAIN_TASK_ID,
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
		prompt: "Explain this module",
		taskConversationSessionMetadata: {
			workspaceTaskId: MAIN_TASK_ID,
			taskConversationSessionRole: "by_the_way",
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
		},
	});
}

// refreshTaskTerminal 重建的启动请求（对照 src/trpc/runtime-api.ts 的 refresh 分支）。
function buildByTheWayRefreshRequest(options: { includeMetadata: boolean }) {
	return {
		taskId: BY_THE_WAY_TASK_ID,
		workspaceTaskId: MAIN_TASK_ID,
		agentId: "claude" as const,
		binary: "claude",
		args: [],
		cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
		prompt: "",
		resumeFromTrash: true,
		...(options.includeMetadata
			? {
					taskConversationSessionMetadata: {
						workspaceTaskId: MAIN_TASK_ID,
						taskConversationSessionRole: "by_the_way" as const,
						taskConversationSessionContextSource: "started_from_scratch" as const,
						parentTaskConversationSessionId: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: null,
					},
				}
			: {}),
	};
}

describe("TerminalSessionManager resume addressing", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("既有接任启动在 adapter 准备完成后重验，身份改变时不会 spawn", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		const revalidate = vi.fn(async () => {
			throw new Error("固定 peer 身份已改变");
		});
		await expect(
			manager.startTaskSession({
				taskId: MAIN_TASK_ID,
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
				prompt: "",
				revalidateExistingMainSessionHandoverTargetBeforeLaunch: revalidate,
			}),
		).rejects.toThrow("固定 peer 身份已改变");
		expect(prepareAgentLaunchMock).toHaveBeenCalledOnce();
		expect(revalidate).toHaveBeenCalledOnce();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(manager.hasLiveTaskSession(MAIN_TASK_ID)).toBe(false);
	});
	it("交接启动重验只作用于当次启动，不阻止之后按自身身份自动恢复", async () => {
		const { manager, spawnedSessions } = createManagerWithSpawnedSessions();
		const revalidate = vi.fn(async () => {});
		await manager.startTaskSession({
			taskId: MAIN_TASK_ID,
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
			prompt: "开始",
			resumePriorAgentConversationWithoutResendingPrompt: true,
			revalidateExistingMainSessionHandoverTargetBeforeLaunch: revalidate,
		});
		manager.attach(MAIN_TASK_ID, { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		manager.applyAgentNativeConversationSessionIdentity(MAIN_TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: MAIN_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		revalidate.mockRejectedValue(new Error("交接阶段已经结束"));
		spawnedSessions[0]?.triggerExit(130);
		await vi.waitFor(() => expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2));
		expect(revalidate).toHaveBeenCalledOnce();
		expect(readMostRecentResumeAddressing()?.sourceSessionId).toBe(MAIN_NATIVE_SESSION_ID);
	});

	it("addresses a By the way refresh by its own native session id, not the shared working directory", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		await startMainSession(manager);
		await startByTheWaySession(manager);
		manager.applyAgentNativeConversationSessionIdentity(MAIN_TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: MAIN_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		manager.applyAgentNativeConversationSessionIdentity(BY_THE_WAY_TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BY_THE_WAY_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});

		await manager.refreshTaskTerminal(buildByTheWayRefreshRequest({ includeMetadata: true }));

		expect(readMostRecentResumeAddressing()).toEqual({
			sourceAgentId: "claude",
			sourceSessionId: BY_THE_WAY_NATIVE_SESSION_ID,
			sourceSessionReuseMode: "resume_existing_session",
		});
		// 主会话没有被卷进来：它的 pid 与 summary 一动未动。
		expect(manager.getSummary(MAIN_TASK_ID)?.pid).toBe(100);
	});

	// 寻址若被烘焙进 entry.restartRequest，这一条会拿到刷新那一刻的旧 id。
	it("re-resolves the addressing on every replay instead of baking it into the restart request", async () => {
		const { manager, spawnedSessions } = createManagerWithSpawnedSessions();
		await startMainSession(manager);
		await startByTheWaySession(manager);
		manager.attach(BY_THE_WAY_TASK_ID, { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		manager.applyAgentNativeConversationSessionIdentity(BY_THE_WAY_TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BY_THE_WAY_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		await manager.refreshTaskTerminal(buildByTheWayRefreshRequest({ includeMetadata: true }));
		expect(readMostRecentResumeAddressing()?.sourceSessionId).toBe(BY_THE_WAY_NATIVE_SESSION_ID);

		// 新一代会话上报了一个新的原生 id（fork / 重开都会换 id），随后 PTY 崩溃触发自动重启。
		manager.applyAgentNativeConversationSessionIdentity(BY_THE_WAY_TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: REFRESHED_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 2,
		});
		const spawnCountBeforeCrash = ptySessionSpawnMock.mock.calls.length;
		spawnedSessions[spawnedSessions.length - 1]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock.mock.calls.length).toBeGreaterThan(spawnCountBeforeCrash);
		});
		expect(readMostRecentResumeAddressing()?.sourceSessionId).toBe(REFRESHED_NATIVE_SESSION_ID);
	});

	it("refuses to resume when the working directory is contested and no native session id was recorded", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		await startMainSession(manager);
		await startByTheWaySession(manager);
		const spawnCountBeforeRefresh = ptySessionSpawnMock.mock.calls.length;

		const pidBeforeRefusal = manager.getSummary(BY_THE_WAY_TASK_ID)?.pid;
		const stateBeforeRefusal = manager.getSummary(BY_THE_WAY_TASK_ID)?.state;
		const refusal = await manager
			.refreshTaskTerminal(buildByTheWayRefreshRequest({ includeMetadata: true }))
			.catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toContain("no recorded agent session id");
		// 竞争者被点名，用户才知道是谁在抢这个目录。
		expect((refusal as Error).message).toContain(MAIN_TASK_ID);
		// 拒绝就是拒绝：不得偷偷用 `--continue` 起一条。
		expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountBeforeRefresh);
		// **一动不动**：refreshTaskTerminal 是「停掉再起一条」，若拒绝晚于那次 forceStop，用户点一次
		// 重启就会把一条还活着的会话杀掉、还什么都没续上；标 failed 同理会把一条本来只是 idle 的
		// 会话推成失败态（前端的陈旧会话自动续跑打的是同一个入口）。
		expect(manager.getSummary(BY_THE_WAY_TASK_ID)?.pid).toBe(pidBeforeRefusal);
		expect(manager.getSummary(BY_THE_WAY_TASK_ID)?.state).toBe(stateBeforeRefusal);
		expect(manager.getSummary(BY_THE_WAY_TASK_ID)?.state).not.toBe("failed");
		// 但也不能是一块沉默的白板：原因写进 warningMessage，面板据此解释这次为什么没动静。
		expect(manager.getSummary(BY_THE_WAY_TASK_ID)?.warningMessage).toContain("no recorded agent session id");
	});

	// backward compatibility 的落点：没有 sidecar 的老会话，只要独占 cwd，行为与今天一模一样。
	it("keeps the cwd-latest resume for a lone session with no recorded native session id", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		await startMainSession(manager);

		await manager.refreshTaskTerminal({
			taskId: MAIN_TASK_ID,
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
			prompt: "",
			resumeFromTrash: true,
		});

		expect(readMostRecentResumeAddressing()).toBeUndefined();
		expect(manager.getSummary(MAIN_TASK_ID)?.pid).toBe(101);
	});

	// 同一个仓库根目录下并存两个跑不同 agent 的 inplace 任务是完全正常的，各自的续跑互不干扰。
	it("does not treat a session running a different agent in the same directory as a competitor", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		await manager.startTaskSession({
			taskId: "inplace-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
			prompt: "Do the codex work",
		});
		await manager.startTaskSession({
			taskId: "inplace-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
			prompt: "Do the claude work",
		});

		await expect(
			manager.refreshTaskTerminal({
				taskId: "inplace-claude",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
				prompt: "",
				resumeFromTrash: true,
			}),
		).resolves.toBeDefined();
	});

	// 文案可达性回归：这段话已经错过两次（「先发条消息再重启」是死循环；「停掉竞争会话」做不到——
	// manager 没有 entries.delete、stopTaskSession 不动 metadata、也没有删除侧问会话的 procedure）。
	it("only offers escape routes that actually exist in the product", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		await startMainSession(manager);
		await startByTheWaySession(manager);

		const refusal = await manager
			.refreshTaskTerminal(buildByTheWayRefreshRequest({ includeMetadata: true }))
			.catch((error: unknown) => error);
		const message = (refusal as Error).message;

		expect(message).toContain("start a fresh session");
		expect(message).toContain("left untouched");
		// 停掉/删掉竞争会话并不会让它离开竞争集合，绝不能再把它写成出路。
		expect(message).not.toMatch(/stop|delete/iu);
	});

	// 两个跑同一个 agent 的 inplace 任务共用仓库根目录——这不是 By the way，却是同一个 bug 类。
	it("refuses a contested resume between two inplace tasks running the same agent", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		await manager.startTaskSession({
			taskId: "inplace-a",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
			prompt: "Task A",
		});
		await manager.startTaskSession({
			taskId: "inplace-b",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
			prompt: "Task B",
		});

		await expect(
			manager.refreshTaskTerminal({
				taskId: "inplace-b",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: SHARED_EXECUTION_WORKING_DIRECTORY,
				prompt: "",
				resumeFromTrash: true,
			}),
		).rejects.toThrow(/inplace-a/);
	});

	// refreshTaskTerminal 历史上会重建一份不带 metadata 的启动请求，于是重启后 By the way 丢掉只读约束。
	it("falls back to the summary's conversation metadata when the restart request omits it", async () => {
		const { manager } = createManagerWithSpawnedSessions();
		await startByTheWaySession(manager);
		manager.applyAgentNativeConversationSessionIdentity(BY_THE_WAY_TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BY_THE_WAY_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});

		await manager.refreshTaskTerminal(buildByTheWayRefreshRequest({ includeMetadata: false }));

		const lastCall = prepareAgentLaunchMock.mock.calls[prepareAgentLaunchMock.mock.calls.length - 1]?.[0] as {
			readOnlyQuestionSession?: boolean;
		};
		expect(lastCall?.readOnlyQuestionSession).toBe(true);
	});
});
