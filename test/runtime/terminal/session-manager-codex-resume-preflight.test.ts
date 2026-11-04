import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({ prepareAgentLaunch: prepareAgentLaunchMock }));
vi.mock("../../../src/terminal/pty-session.js", () => ({ PtySession: { spawn: ptySessionSpawnMock } }));

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { compressedCodexTranscriptFixtureBytes } from "../../utilities/codex-native-resume-compressed-transcript-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

let directory: ReturnType<typeof createTempDir>;
const managers: TerminalSessionManager[] = [];
const nativeSessionId = "01a15120-4476-78b0-8c56-5a7321338e0b";

function request() {
	return {
		taskId: "codex-resume-preflight",
		agentId: "codex" as const,
		binary: "codex",
		args: [],
		cwd: directory.path,
		prompt: "",
		env: { CODEX_HOME: directory.path },
	};
}

function hydrate(manager: TerminalSessionManager) {
	manager.hydrateFromRecord({
		[request().taskId]: {
			taskId: request().taskId,
			state: "awaiting_review",
			agentId: "codex",
			workspacePath: directory.path,
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: "error",
			exitCode: 1,
			lastHookAt: null,
			latestHookActivity: null,
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "error",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath: null,
				observedAt: 1,
			},
		} as RuntimeTaskSessionSummary,
	});
}

function manager() {
	const instance = new TerminalSessionManager();
	managers.push(instance);
	return instance;
}

beforeEach(() => {
	directory = createTempDir("kanban-codex-resume-preflight-");
	prepareAgentLaunchMock.mockReset();
	prepareAgentLaunchMock.mockImplementation(async (input) => ({ binary: input.binary, args: input.args, env: {} }));
	ptySessionSpawnMock.mockReset();
	ptySessionSpawnMock.mockImplementation((input) => {
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
				input.onExit?.({ exitCode: 0 });
			}),
			wasInterrupted: () => false,
		};
	});
});
afterEach(() => {
	for (const instance of managers.splice(0)) instance.dispose();
	directory.cleanup();
});

describe("续接预检在任何销毁动作之前", () => {
	it.each(["start", "refresh"])("%s 从已压缩的原始路径续接同一身份，不重投 Prompt", async (operation) => {
		const instance = manager();
		const resumeRequest = { ...request(), prompt: "不得重新投递的原始 Prompt" };
		if (operation === "refresh") await instance.startTaskSession(request());
		else hydrate(instance);
		const sessions = join(directory.path, "sessions");
		mkdirSync(sessions);
		const savedPath = join(sessions, `rollout-${nativeSessionId}.jsonl`);
		writeFileSync(`${savedPath}.zst`, compressedCodexTranscriptFixtureBytes());
		instance.applyAgentNativeConversationSessionIdentity(resumeRequest.taskId, {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: savedPath,
			observedAt: 2,
		});
		if (operation === "refresh") await instance.refreshTaskTerminal({ ...resumeRequest, resumeFromTrash: true });
		else
			await instance.startTaskSession({
				...resumeRequest,
				resumePriorAgentConversationWithoutResendingPrompt: true,
			});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(operation === "refresh" ? 2 : 1);
		expect(prepareAgentLaunchMock.mock.calls.at(-1)?.[0]).toMatchObject({
			...(operation === "refresh"
				? { resumeFromTrash: true }
				: { resumePriorAgentConversationWithoutResendingPrompt: true }),
			observedAgentNativeConversationSessionResumeAddressing: {
				sourceSessionId: nativeSessionId,
				sourceSessionReuseMode: "resume_existing_session",
			},
		});
		expect(ptySessionSpawnMock.mock.results.at(-1)?.value.write).not.toHaveBeenCalled();
	});

	it.each(["wrong-identity", "subagent", "corrupt-compression", "invalid-checksum"] as const)(
		"刷新遇到 %s 压缩转录时等待可信补证，保留旧 PTY 与原身份",
		async (scenario) => {
			const instance = manager();
			await instance.startTaskSession(request());
			const sessions = join(directory.path, "sessions");
			mkdirSync(sessions);
			const transcriptPath = join(sessions, `rollout-${nativeSessionId}.jsonl.zst`);
			writeFileSync(
				transcriptPath,
				scenario === "corrupt-compression"
					? Buffer.from("损坏数据")
					: compressedCodexTranscriptFixtureBytes(scenario),
			);
			const identity = { sourceAgentId: "codex" as const, nativeSessionId, transcriptPath, observedAt: 2 };
			instance.applyAgentNativeConversationSessionIdentity(request().taskId, identity);
			const oldProcess = ptySessionSpawnMock.mock.results[0]?.value;
			const waitingSummary = await instance.refreshTaskTerminal({ ...request(), resumeFromTrash: true });
			expect(waitingSummary.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs).toEqual(
				expect.any(Number),
			);
			expect(oldProcess.stop).not.toHaveBeenCalled();
			expect(oldProcess.write).not.toHaveBeenCalled();
			expect(ptySessionSpawnMock).toHaveBeenCalledOnce();
			expect(instance.getSummary(request().taskId)).toMatchObject({
				pid: 1234,
				agentNativeConversationSessionIdentity: identity,
			});
		},
	);
	it.each([["resume", "explicit-native-id"], ["fork", "explicit-native-id"], ["--last"]])(
		"显式选择 %j 由原生核验，不拿旧本地转录拦截或冒认身份",
		async (...additionalAgentStartupArgumentsForThisRestart) => {
			const instance = manager();
			hydrate(instance);
			await instance.refreshTaskTerminal({
				...request(),
				resumeFromTrash: true,
				additionalAgentStartupArgumentsForThisRestart,
			});
			expect(ptySessionSpawnMock).toHaveBeenCalledOnce();
			expect(
				prepareAgentLaunchMock.mock.calls[0]?.[0].observedAgentNativeConversationSessionResumeAddressing,
			).toBeUndefined();
			expect(instance.getSummary(request().taskId)?.agentNativeConversationSessionIdentity).toBeNull();
		},
	);

	it("显式远程连接保留默认续跑目标，但不要求目标有本地转录", async () => {
		const instance = manager();
		hydrate(instance);
		await instance.refreshTaskTerminal({
			...request(),
			resumeFromTrash: true,
			additionalAgentStartupArgumentsForThisRestart: ["--remote", "unix:///explicit.sock"],
		});
		expect(
			prepareAgentLaunchMock.mock.calls[0]?.[0].observedAgentNativeConversationSessionResumeAddressing,
		).toMatchObject({ sourceSessionId: nativeSessionId });
		expect(instance.getSummary(request().taskId)?.agentNativeConversationSessionIdentity).toBeNull();
	});
	it.each([
		["--future-option", "--last"],
		["--future-option", "--remote", "unix:///tmp/other.sock"],
	])("未知选项后缀不能绕过当前原生会话的本地预检：%j", async (...additional) => {
		const instance = manager();
		hydrate(instance);
		await expect(
			instance.refreshTaskTerminal({
				...request(),
				resumeFromTrash: true,
				additionalAgentStartupArgumentsForThisRestart: additional,
			}),
		).rejects.toThrow(nativeSessionId);
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(instance.getSummary(request().taskId)?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
			nativeSessionId,
		);
	});
	it.each([
		["--model", "--cd", "/path"],
		["--sandbox", "--ask-for-approval", "never"],
	])("已知选项缺值在停止旧 PTY 前拒绝：%j", async (...additional) => {
		const instance = manager();
		await instance.startTaskSession(request());
		const oldProcess = ptySessionSpawnMock.mock.results[0]?.value;
		await expect(
			instance.refreshTaskTerminal({
				...request(),
				additionalAgentStartupArgumentsForThisRestart: additional,
			}),
		).rejects.toThrow("缺少参数值");
		expect(oldProcess.stop).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(instance.getSummary(request().taskId)?.pid).toBe(1234);
	});
	it.each(["start", "refresh"])("%s 对缺失原生身份的交接目标零 spawn，保留现场并指出恢复入口", async (operation) => {
		const instance = manager();
		hydrate(instance);
		const hydratedSummary = instance.getSummary(request().taskId);
		if (!hydratedSummary) throw new Error("缺少已恢复的交接目标");
		instance.hydrateFromRecord({
			[request().taskId]: {
				...hydratedSummary,
				agentNativeConversationSessionIdentity: undefined,
				taskConversationSessionMetadata: {
					workspaceTaskId: "handover-host-task",
					taskConversationSessionRole: "main",
					taskConversationSessionRoleAtCreation: "task_collaborator",
					taskConversationSessionContextSource: "started_from_scratch",
					taskAutomationSuspendedForMainSessionHandover: true,
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
				},
			},
		});
		const resumeRequest = { ...request(), resumePriorAgentConversationWithoutResendingPrompt: true };
		await expect(
			operation === "start" ? instance.startTaskSession(resumeRequest) : instance.refreshTaskTerminal(resumeRequest),
		).rejects.toThrow("新建 Codex 并重新交接");
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(instance.getSummary(request().taskId)?.taskConversationSessionMetadata?.workspaceTaskId).toBe(
			"handover-host-task",
		);
	});

	it.each(["start", "refresh"])("%s 使用 request.cwd 解析相对 CODEX_HOME 后续接指定会话", async (operation) => {
		const instance = manager();
		const resumeRequest = { ...request(), env: { CODEX_HOME: ".store" } };
		const sessions = join(resumeRequest.cwd, ".store", "sessions");
		mkdirSync(sessions, { recursive: true });
		const transcriptPath = join(sessions, `rollout-${nativeSessionId}.jsonl`);
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
		);
		if (operation === "refresh") await instance.startTaskSession(resumeRequest);
		else hydrate(instance);
		instance.applyAgentNativeConversationSessionIdentity(resumeRequest.taskId, {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath,
			observedAt: 2,
		});
		if (operation === "refresh") await instance.refreshTaskTerminal({ ...resumeRequest, resumeFromTrash: true });
		else await instance.startTaskSession({ ...resumeRequest, resumeFromTrash: true });
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(operation === "refresh" ? 2 : 1);
		const finalLaunchRequest = prepareAgentLaunchMock.mock.calls.at(-1)?.[0];
		expect(finalLaunchRequest.cwd).toBe(resumeRequest.cwd);
		expect(finalLaunchRequest.env.CODEX_HOME).toBe(".store");
		expect(finalLaunchRequest.observedAgentNativeConversationSessionResumeAddressing).toMatchObject({
			sourceSessionId: nativeSessionId,
			sourceSessionReuseMode: "resume_existing_session",
		});
	});

	it("stale 启动发现缺失 ID 时零 spawn，并保留身份与状态", async () => {
		const instance = manager();
		hydrate(instance);
		const before = instance.getSummary(request().taskId);
		await expect(
			instance.startTaskSession({ ...request(), resumePriorAgentConversationWithoutResendingPrompt: true }),
		).rejects.toThrow(nativeSessionId);
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(instance.getSummary(request().taskId)).toMatchObject({
			agentNativeConversationSessionIdentity: before?.agentNativeConversationSessionIdentity,
			liveness: before?.liveness,
			turnOwner: before?.turnOwner,
		});
		expect(instance.getSummary(request().taskId)?.warningMessage).toContain("已在启动前停止");
	});

	it("刷新遇到可信 ID 的转录暂缺时等待补证，不停止现有 PTY 或创建下一代", async () => {
		const instance = manager();
		await instance.startTaskSession(request());
		instance.applyAgentNativeConversationSessionIdentity(request().taskId, {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: null,
			observedAt: 1,
		});
		const process = ptySessionSpawnMock.mock.results[0]?.value;
		const waitingSummary = await instance.refreshTaskTerminal({ ...request(), resumeFromTrash: true });
		expect(waitingSummary.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(nativeSessionId);
		expect(waitingSummary.taskConversationSessionNativeIdentityRecovery?.resumeRequestedAtMs).toEqual(
			expect.any(Number),
		);
		expect(process.stop).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(instance.getSummary(request().taskId)?.pid).toBe(1234);
	});

	it("恢复已保存历史时保持显式 ID，不借用其它较新会话", async () => {
		const instance = manager();
		hydrate(instance);
		mkdirSync(join(directory.path, "sessions"));
		writeFileSync(
			join(directory.path, "sessions", `rollout-${nativeSessionId}_resumed.jsonl`),
			`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
		);
		await instance.startTaskSession({ ...request(), resumeFromTrash: true });
		expect(ptySessionSpawnMock).toHaveBeenCalledOnce();
		expect(
			prepareAgentLaunchMock.mock.calls[0]?.[0].observedAgentNativeConversationSessionResumeAddressing,
		).toMatchObject({ sourceSessionId: nativeSessionId, sourceSessionReuseMode: "resume_existing_session" });
	});
});
