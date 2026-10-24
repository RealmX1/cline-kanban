import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type {
	HostedTerminalPtyProcessSpawnRequest,
	TerminalPtyProcessHandle,
} from "../../../src/terminal/terminal-pty-process-handle";
import { parseTerminalSessionAdoptionRecord } from "../../../src/terminal/terminal-session-adoption-record-for-runtime-restart";
import { createTempDir } from "../../utilities/temp-dir";

const taskId = "isolated-kimi-initial-prompt";
const initialPromptText = "首条中文任务正文\n第二行与特殊字符 $ ` < > 必须原样保留";
const composerText =
	"╭─────────────────────────────────╮\r\n│ >                               │\r\n╰─────────────────────────────────╯";
const trustScreen = `\u001b[2J\u001b[HTrust this folder?\r\nTrust and continue\r\n${composerText}`;
const readyScreen = `\u001b[2J\u001b[HWelcome to Kimi Code!\r\nNo session yet\r\n${composerText}`;
const narrowReadyScreen = readyScreen.replace("Welcome to Kimi Code!", "Welcome to Kim…");
const managers: TerminalSessionManager[] = [];
let isolatedHome: ReturnType<typeof createTempDir>;

async function startIsolatedKimiSession(
	input: { managedWorktree?: boolean; env?: Record<string, string>; terminalColumns?: number } = {},
) {
	let spawnRequest: HostedTerminalPtyProcessSpawnRequest | undefined;
	let adoptionRecord: unknown;
	const handle: TerminalPtyProcessHandle & { write: ReturnType<typeof vi.fn<(data: string | Buffer) => void>> } = {
		pid: 45678,
		write: vi.fn<(data: string | Buffer) => void>(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		hasExited: () => false,
		wasInterrupted: () => false,
		publishTerminalSessionAdoptionRecordForRuntimeRestart: (record) => {
			adoptionRecord = record;
		},
	};
	const manager = new TerminalSessionManager({
		hostedTerminalPtyProcessSpawner: {
			async spawnHostedTerminalPtyProcess(request) {
				spawnRequest = request;
				return handle;
			},
		},
	});
	managers.push(manager);
	await manager.startTaskSession({
		taskId,
		agentId: "kimi",
		binary: "kimi",
		args: ["--model", "isolated-model"],
		cwd: input.managedWorktree
			? join(isolatedHome.path, ".cline", "worktrees", "isolated-task", "isolated-repository")
			: join(isolatedHome.path, "user-selected-working-directory"),
		prompt: initialPromptText,
		cols: input.terminalColumns ?? 90,
		rows: 24,
		env: input.env,
		autoContinueOnConnectionDropEnabled: false,
	});
	return {
		manager,
		handle,
		emitOutput: (text: string | Buffer) => spawnRequest?.onData(Buffer.from(text)),
		readAdoptionRecord: () => adoptionRecord,
		readSpawnEnvironment: () => spawnRequest?.env,
		promptWrites: () => handle.write.mock.calls.filter(([text]) => String(text).includes(initialPromptText)),
	};
}

beforeEach(() => {
	isolatedHome = createTempDir("kimi-initial-prompt-isolated-home-");
	vi.stubEnv("HOME", isolatedHome.path);
	vi.stubEnv("KIMI_CODE_TRUST_WORKSPACE", undefined);
	vi.useFakeTimers();
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	isolatedHome.cleanup();
});

describe("Kimi 初始提示词投递", () => {
	it("信任模态的底层输入框与 5 秒超时均不能触发正文或回车", async () => {
		const session = await startIsolatedKimiSession();
		session.emitOutput(trustScreen);
		await vi.advanceTimersByTimeAsync(7_000);
		expect(session.handle.write).not.toHaveBeenCalled();
		expect(session.manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance).toBeNull();
	});

	it("慢启动超过 5 秒时保留正文，完整就绪后只投递一次", async () => {
		const session = await startIsolatedKimiSession();
		session.emitOutput("Loading configuration...\r\n");
		await vi.advanceTimersByTimeAsync(7_000);
		expect(session.handle.write).not.toHaveBeenCalled();
		session.emitOutput(readyScreen);
		session.emitOutput(readyScreen);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(session.promptWrites()).toHaveLength(1);
		expect(session.handle.write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
		expect(session.manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance?.status).toBe("pending");
	});

	it("30 列终端裁剪启动横幅后仍唯一首发完整正文", async () => {
		const session = await startIsolatedKimiSession({ managedWorktree: true, terminalColumns: 30 });
		session.emitOutput(narrowReadyScreen);
		session.emitOutput(narrowReadyScreen);
		await vi.advanceTimersByTimeAsync(7_000);
		expect(session.promptWrites()).toHaveLength(1);
		expect(session.handle.write.mock.calls.filter(([text]) => text === "\r")).toHaveLength(1);
	});

	it.each(["Welcome to Kim", "Welcome to Other…"])("不把未完成或其他横幅误认成启动完成：%s", async (bannerText) => {
		const session = await startIsolatedKimiSession({ terminalColumns: 30 });
		session.emitOutput(narrowReadyScreen.replace("Welcome to Kim…", bannerText));
		await vi.advanceTimersByTimeAsync(7_000);
		expect(session.handle.write).not.toHaveBeenCalled();
	});

	it("窄终端的旧裁剪横幅不能放过后来的信任模态，确认后继续唯一首发", async () => {
		const session = await startIsolatedKimiSession({ terminalColumns: 30 });
		session.emitOutput("Welcome to Kim…\r\n");
		session.emitOutput(trustScreen);
		await vi.advanceTimersByTimeAsync(7_000);
		expect(session.handle.write).not.toHaveBeenCalled();
		session.manager.writeInput(taskId, Buffer.from("\r"));
		expect(session.promptWrites()).toHaveLength(0);
		expect(session.manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance).toBeNull();
		for (const byte of Buffer.from(narrowReadyScreen)) session.emitOutput(Buffer.from([byte]));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(session.promptWrites()).toHaveLength(1);
	});

	it("只出现启动横幅时继续等待当前可输入的 composer", async () => {
		const session = await startIsolatedKimiSession();
		session.emitOutput("Welcome to Kimi Code!\r\nLoading...");
		await vi.advanceTimersByTimeAsync(100);
		expect(session.handle.write).not.toHaveBeenCalled();
		session.emitOutput(composerText);
		await vi.advanceTimersByTimeAsync(100);
		expect(session.promptWrites()).toHaveLength(1);
	});

	it("PTY 将横幅、信任提示及输入框的 UTF-8 字节拆开时仍可恢复首发", async () => {
		const session = await startIsolatedKimiSession();
		for (const text of ["Trust this fol", "der?\r\n", composerText]) session.emitOutput(text);
		await vi.advanceTimersByTimeAsync(100);
		expect(session.handle.write).not.toHaveBeenCalled();
		for (const byte of Buffer.from(readyScreen)) session.emitOutput(Buffer.from([byte]));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(session.promptWrites()).toHaveLength(1);
	});

	it.each(["\u001b[B\u001b[A\r", "\u001bOB\u001bOA\r"])(
		"用户经 writeInput 导航并确认信任后自动首发：%j",
		async (input) => {
			const session = await startIsolatedKimiSession();
			session.emitOutput(trustScreen);
			await vi.advanceTimersByTimeAsync(100);
			session.manager.writeInput(taskId, Buffer.from(input));
			expect(session.promptWrites()).toHaveLength(0);
			expect(session.manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance).toBeNull();
			session.emitOutput(readyScreen);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(session.promptWrites()).toHaveLength(1);
		},
	);

	it("普通人工文本依旧接管输入框，不在稍后抢先投递启动正文", async () => {
		const session = await startIsolatedKimiSession();
		session.emitOutput(trustScreen);
		await vi.advanceTimersByTimeAsync(100);
		session.manager.writeInput(taskId, Buffer.from("人工正在输入的替代正文"));
		session.emitOutput(readyScreen);
		await vi.advanceTimersByTimeAsync(7_000);
		expect(session.promptWrites()).toHaveLength(0);
	});

	it.each([
		{ terminalColumns: 90, startupReadyScreen: readyScreen },
		{ terminalColumns: 30, startupReadyScreen: narrowReadyScreen },
	])(
		"$terminalColumns 列热接管追赶到信任模态后继续等待，确认后唯一首发",
		async ({ terminalColumns, startupReadyScreen }) => {
			const session = await startIsolatedKimiSession({ terminalColumns });
			await vi.advanceTimersByTimeAsync(100);
			const summary = session.manager.getSummary(taskId);
			if (!summary?.pid || !summary.startedAt) throw new Error("缺少隔离接管身份");
			expect(parseTerminalSessionAdoptionRecord(session.readAdoptionRecord()).kind).toBe("usable_adoption_record");
			const adoptedManager = new TerminalSessionManager();
			managers.push(adoptedManager);
			adoptedManager.hydrateFromRecord({ [taskId]: summary }, new Set([taskId]));
			let emitLiveOutput: ((data: Buffer) => void) | undefined;
			const adoption = adoptedManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
				{
					taskId,
					hostedSessionKind: "task_agent_session",
					pid: summary.pid,
					spawnedAtEpochMs: summary.startedAt,
					cols: terminalColumns,
					rows: 24,
					exitedWhileRuntimeWasAbsent: false,
					terminalSessionAdoptionRecord: session.readAdoptionRecord(),
					async adoptHostedTerminalPtyProcess(callbacks) {
						emitLiveOutput = callbacks.onData;
						callbacks.onCatchUpOutput(Buffer.from(trustScreen));
						return session.handle;
					},
					terminateHostedTerminalPtyProcessAfterRefusedAdoption: () => session.handle.stop({ force: true }),
				},
			]);
			await vi.advanceTimersByTimeAsync(100);
			await adoption;
			session.manager.dispose();
			await vi.advanceTimersByTimeAsync(7_000);
			expect(session.handle.write).not.toHaveBeenCalled();
			adoptedManager.writeInput(taskId, Buffer.from("\r"));
			emitLiveOutput?.(Buffer.from(startupReadyScreen));
			await vi.advanceTimersByTimeAsync(2_000);
			expect(session.promptWrites()).toHaveLength(1);
		},
	);

	it("裁剪横幅的省略号横跨热接管追赶与实时输出时继续唯一首发", async () => {
		const session = await startIsolatedKimiSession({ terminalColumns: 30 });
		await vi.advanceTimersByTimeAsync(100);
		const summary = session.manager.getSummary(taskId);
		if (!summary?.pid || !summary.startedAt) throw new Error("缺少隔离接管身份");
		const adoptedManager = new TerminalSessionManager();
		managers.push(adoptedManager);
		adoptedManager.hydrateFromRecord({ [taskId]: summary }, new Set([taskId]));
		const replayOutputBytes = Buffer.from(`${trustScreen}${narrowReadyScreen}`);
		const replayLiveBoundary = replayOutputBytes.indexOf(Buffer.from("…")) + 1;
		let emitLiveOutput: ((data: Buffer) => void) | undefined;
		const adoption = adoptedManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			{
				taskId,
				hostedSessionKind: "task_agent_session",
				pid: summary.pid,
				spawnedAtEpochMs: summary.startedAt,
				cols: 30,
				rows: 24,
				exitedWhileRuntimeWasAbsent: false,
				terminalSessionAdoptionRecord: session.readAdoptionRecord(),
				async adoptHostedTerminalPtyProcess(callbacks) {
					emitLiveOutput = callbacks.onData;
					for (const byte of replayOutputBytes.subarray(0, replayLiveBoundary))
						callbacks.onCatchUpOutput(Buffer.from([byte]));
					return session.handle;
				},
				terminateHostedTerminalPtyProcessAfterRefusedAdoption: () => session.handle.stop({ force: true }),
			},
		]);
		await vi.advanceTimersByTimeAsync(2_000);
		await adoption;
		session.manager.dispose();
		expect(session.handle.write).not.toHaveBeenCalled();
		for (const byte of replayOutputBytes.subarray(replayLiveBoundary)) emitLiveOutput?.(Buffer.from([byte]));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(session.promptWrites()).toHaveLength(1);
	});

	it("仅 Kanban 管理的任务工作树获得原生进程级信任", async () => {
		const managed = await startIsolatedKimiSession({ managedWorktree: true });
		expect(managed.readSpawnEnvironment()?.KIMI_CODE_TRUST_WORKSPACE).toBe("1");
		const arbitrary = await startIsolatedKimiSession();
		expect(arbitrary.readSpawnEnvironment()?.KIMI_CODE_TRUST_WORKSPACE).toBeUndefined();
	});

	it.each(["0", "1"])("保留显式 KIMI_CODE_TRUST_WORKSPACE=%s", async (value) => {
		const session = await startIsolatedKimiSession({
			managedWorktree: true,
			env: { KIMI_CODE_TRUST_WORKSPACE: value },
		});
		expect(session.readSpawnEnvironment()?.KIMI_CODE_TRUST_WORKSPACE).toBe(value);
	});
});
