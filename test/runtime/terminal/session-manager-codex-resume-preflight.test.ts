import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({ prepareAgentLaunch: prepareAgentLaunchMock }));
vi.mock("../../../src/terminal/pty-session.js", () => ({ PtySession: { spawn: ptySessionSpawnMock } }));

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
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

	it("刷新遇到坏 ID 时不停止现有 PTY，也不创建下一代", async () => {
		const instance = manager();
		await instance.startTaskSession(request());
		instance.applyAgentNativeConversationSessionIdentity(request().taskId, {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: null,
			observedAt: 1,
		});
		const process = ptySessionSpawnMock.mock.results[0]?.value;
		await expect(instance.refreshTaskTerminal({ ...request(), resumeFromTrash: true })).rejects.toThrow(
			nativeSessionId,
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
