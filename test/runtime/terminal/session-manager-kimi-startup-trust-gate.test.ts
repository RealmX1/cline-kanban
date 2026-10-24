import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type {
	HostedTerminalPtyProcessSpawnRequest,
	TerminalPtyProcessHandle,
} from "../../../src/terminal/terminal-pty-process-handle";
import { createTempDir } from "../../utilities/temp-dir";

const managers: TerminalSessionManager[] = [];
const isolatedHomeDirectories: ReturnType<typeof createTempDir>[] = [];
const startupText = "首条中文任务文本\n保持正文完整且只投递一次";
const interactivePrompt =
	"╭──────────────────────────────╮\r\n│ >                            │\r\n╰──────────────────────────────╯";
const trustPromptWithUnderlyingComposer = `Trust this folder?\r\nTrust and continue\r\n${interactivePrompt}`;
const readyScreen = `\u001b[2J\u001b[HWelcome to Kimi Code!\r\nNo session yet\r\n${interactivePrompt}`;

async function startIsolatedHostedKimiSession() {
	let spawnRequest: HostedTerminalPtyProcessSpawnRequest | undefined;
	let adoptionRecord: unknown;
	const handle: TerminalPtyProcessHandle = {
		pid: 34567,
		write: vi.fn(),
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
		taskId: "isolated-kimi-startup-trust",
		agentId: "kimi",
		binary: "kimi",
		args: ["--model", "isolated-model"],
		cwd: "/isolated-user-selected-directory",
		prompt: startupText,
		cols: 80,
		rows: 24,
		autoContinueOnConnectionDropEnabled: false,
	});
	return {
		manager,
		handle,
		emitOutput: (text: string) => spawnRequest?.onData(Buffer.from(text)),
		readAdoptionRecord: () => adoptionRecord,
		async tryStartupSubmission() {
			return await (
				manager as unknown as { trySubmitDeferredStartupPrompt: (taskId: string) => Promise<boolean> }
			).trySubmitDeferredStartupPrompt("isolated-kimi-startup-trust");
		},
	};
}

beforeEach(() => {
	const directory = createTempDir("kimi-startup-trust-isolated-home-");
	isolatedHomeDirectories.push(directory);
	vi.stubEnv("HOME", directory.path);
	vi.stubEnv("KIMI_CODE_TRUST_WORKSPACE", undefined);
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.unstubAllEnvs();
	for (const directory of isolatedHomeDirectories.splice(0)) directory.cleanup();
});

describe("Kimi 首发正文等待工作区信任", () => {
	it("信任模态后的输入框不表示就绪，兜底调用也不粘贴或代替用户确认", async () => {
		const session = await startIsolatedHostedKimiSession();
		session.emitOutput(trustPromptWithUnderlyingComposer);
		await session.tryStartupSubmission();
		expect(session.handle.write).not.toHaveBeenCalled();
		expect(
			session.manager.getSummary("isolated-kimi-startup-trust")?.agentConversationPromptSubmissionAcceptance,
		).toBeNull();
	});

	it("真实输入入口确认信任后继续提交且并发就绪回调不重复正文", async () => {
		const session = await startIsolatedHostedKimiSession();
		session.emitOutput(trustPromptWithUnderlyingComposer);
		await session.tryStartupSubmission();
		expect(session.handle.write).not.toHaveBeenCalled();
		session.manager.writeInput("isolated-kimi-startup-trust", Buffer.from("\r"));
		expect(session.handle.write).toHaveBeenCalledExactlyOnceWith(Buffer.from("\r"));
		expect(
			session.manager.getSummary("isolated-kimi-startup-trust")?.agentConversationPromptSubmissionAcceptance,
		).toBeNull();
		session.emitOutput(readyScreen);
		await Promise.all([session.tryStartupSubmission(), session.tryStartupSubmission()]);
		expect(
			vi.mocked(session.handle.write).mock.calls.filter(([text]) => String(text).includes(startupText)),
		).toHaveLength(1);
	});

	it.each([
		["普通草稿输入", trustPromptWithUnderlyingComposer, "用户手动草稿"],
		["信任拒绝键", trustPromptWithUnderlyingComposer, "\u001b"],
		["改变信任选项", trustPromptWithUnderlyingComposer, "\u001b[B"],
		["混入草稿的回车", trustPromptWithUnderlyingComposer, "\r用户手动草稿"],
		["没有信任提示的回车", interactivePrompt, "\r"],
		["已关闭信任提示的回车", `${trustPromptWithUnderlyingComposer}${readyScreen}`, "\r"],
	])("%s 仍接管输入，不保留或自动提交首发", async (_label, screen, inputText) => {
		const session = await startIsolatedHostedKimiSession();
		session.emitOutput(screen);
		session.manager.writeInput("isolated-kimi-startup-trust", Buffer.from(inputText));
		expect(session.handle.write).toHaveBeenCalledExactlyOnceWith(Buffer.from(inputText));
		session.emitOutput(readyScreen);
		await session.tryStartupSubmission();
		expect(
			vi.mocked(session.handle.write).mock.calls.filter(([text]) => String(text).includes(startupText)),
		).toHaveLength(0);
	});

	it("拒绝或改变选项后再按 Enter 不能恢复已取消的自动首发", async () => {
		const session = await startIsolatedHostedKimiSession();
		session.emitOutput(trustPromptWithUnderlyingComposer);
		session.manager.writeInput("isolated-kimi-startup-trust", Buffer.from("\u001b[B"));
		session.manager.writeInput("isolated-kimi-startup-trust", Buffer.from("\r"));
		expect(session.handle.write).toHaveBeenNthCalledWith(1, Buffer.from("\u001b[B"));
		expect(session.handle.write).toHaveBeenNthCalledWith(2, Buffer.from("\r"));
		session.emitOutput(readyScreen);
		await session.tryStartupSubmission();
		expect(
			vi.mocked(session.handle.write).mock.calls.filter(([text]) => String(text).includes(startupText)),
		).toHaveLength(0);
	});

	it("分块拆开的信任提示与启动横幅仍正确门控", async () => {
		const session = await startIsolatedHostedKimiSession();
		for (const chunk of ["Trust this fol", "der?\r\n", interactivePrompt]) session.emitOutput(chunk);
		await session.tryStartupSubmission();
		expect(session.handle.write).not.toHaveBeenCalled();
		for (const chunk of ["\u001b[2J\u001b[HWelcome to Ki", "mi Code!\r\n", interactivePrompt])
			session.emitOutput(chunk);
		await session.tryStartupSubmission();
		expect(
			vi.mocked(session.handle.write).mock.calls.filter(([text]) => String(text).includes(startupText)),
		).toHaveLength(1);
	});

	it("热接管保留待发正文，追赶到信任提示时继续等待", async () => {
		const session = await startIsolatedHostedKimiSession();
		await vi.waitFor(() => expect(session.readAdoptionRecord()).toBeDefined());
		const summary = session.manager.getSummary("isolated-kimi-startup-trust");
		if (!summary?.pid || !summary.startedAt) throw new Error("缺少待接管的会话身份");
		const adoptedManager = new TerminalSessionManager();
		managers.push(adoptedManager);
		adoptedManager.hydrateFromRecord(
			{ "isolated-kimi-startup-trust": summary },
			new Set(["isolated-kimi-startup-trust"]),
		);
		let emitLiveOutput: ((data: Buffer) => void) | undefined;
		await adoptedManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			{
				taskId: "isolated-kimi-startup-trust",
				hostedSessionKind: "task_agent_session",
				pid: summary.pid,
				spawnedAtEpochMs: summary.startedAt,
				cols: 80,
				rows: 24,
				exitedWhileRuntimeWasAbsent: false,
				terminalSessionAdoptionRecord: session.readAdoptionRecord(),
				async adoptHostedTerminalPtyProcess(callbacks) {
					emitLiveOutput = callbacks.onData;
					callbacks.onCatchUpOutput(Buffer.from(trustPromptWithUnderlyingComposer));
					return session.handle;
				},
				terminateHostedTerminalPtyProcessAfterRefusedAdoption: () => session.handle.stop({ force: true }),
			},
		]);
		await adoptedManager.getRestoreSnapshot("isolated-kimi-startup-trust");
		expect(session.handle.write).not.toHaveBeenCalled();
		adoptedManager.writeInput("isolated-kimi-startup-trust", Buffer.from("\r"));
		emitLiveOutput?.(Buffer.from(readyScreen));
		await vi.waitFor(() => {
			expect(
				vi.mocked(session.handle.write).mock.calls.filter(([text]) => String(text).includes(startupText)),
			).toHaveLength(1);
		});
	});
});
