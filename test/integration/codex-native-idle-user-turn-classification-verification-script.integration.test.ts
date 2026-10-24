import { spawn } from "node:child_process";
import { once } from "node:events";
import { symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

interface IsolatedNativeConversation {
	conversationSessionId: string;
	nativeState: string;
	userTurnKind: "review" | "needs_input";
}

interface VerificationReport {
	idleVerified: number;
	observations: { conversationSessionId: string; nativeState: string; userTurnKind: string }[];
	failures: { conversationSessionId: string; reason: string }[];
}

const spawnedScriptProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const ownedHttpServers: Server[] = [];
const ownedWebSocketServers: WebSocketServer[] = [];

afterEach(async () => {
	await spawnedScriptProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
	for (const server of ownedWebSocketServers.splice(0)) {
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
	for (const server of ownedHttpServers.splice(0)) {
		await new Promise<void>((resolveClose, rejectClose) =>
			server.close((error) => (error ? rejectClose(error) : resolveClose())),
		);
	}
	vi.unstubAllEnvs();
});

async function runVerificationScriptAgainstIsolatedEndpoints(
	test: TestContext,
	conversations: IsolatedNativeConversation[],
) {
	// 缩短 UDS 路径；所有端点与 HOME 都属于本用例，不访问真实 Kanban 或 Codex。
	vi.stubEnv("TMPDIR", "/tmp");
	const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kanban-pdv-" });
	const socketPath = join(fixture.fixtureRootDirectoryPath, "native-control.sock");
	const workspaceId = "isolated-verification-workspace";
	const nativeRequests: string[] = [];
	const nativeHttpServer = createServer();
	ownedHttpServers.push(nativeHttpServer);
	const nativeWebSocketServer = new WebSocketServer({ server: nativeHttpServer });
	ownedWebSocketServers.push(nativeWebSocketServer);
	nativeWebSocketServer.on("connection", (socket) => {
		socket.on("message", (bytes) => {
			const frame = JSON.parse(String(bytes)) as {
				id?: number;
				method: string;
				params?: { threadId?: string };
			};
			nativeRequests.push(frame.method);
			if (frame.id === undefined) return;
			let result: unknown;
			if (frame.method === "initialize") result = {};
			else if (frame.method === "thread/loaded/list")
				result = { data: conversations.map((conversation) => conversation.conversationSessionId) };
			else if (frame.method === "thread/read") {
				const conversation = conversations.find(
					(conversation) => conversation.conversationSessionId === frame.params?.threadId,
				);
				if (conversation)
					result = {
						thread: {
							id: conversation.conversationSessionId,
							status: { type: conversation.nativeState },
							canAcceptDirectInput: true,
						},
					};
			}
			if (result === undefined)
				socket.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: "隔离端点拒绝非只读请求" } }));
			else socket.send(JSON.stringify({ id: frame.id, result }));
		});
	});
	nativeHttpServer.listen(socketPath);
	await once(nativeHttpServer, "listening");

	const sessions = Object.fromEntries(
		conversations.map((conversation) => [
			conversation.conversationSessionId,
			{
				taskId: conversation.conversationSessionId,
				agentId: "codex",
				turnOwner: "user",
				liveness: "live",
				userTurnKind: conversation.userTurnKind,
				runtimeSessionIncarnationId: "isolated-incarnation",
				agentNativeConversationSessionIdentity: { nativeSessionId: conversation.conversationSessionId },
				codexNativeSessionControlEndpoint: {
					workspaceId,
					conversationSessionId: conversation.conversationSessionId,
					runtimeSessionIncarnationId: "isolated-incarnation",
					socketPath,
				},
			},
		]),
	);
	const runtimeRequests: { method: string | undefined; path: string | undefined }[] = [];
	const runtimeHttpServer = createServer((request, response) => {
		runtimeRequests.push({ method: request.method, path: request.url });
		const result =
			request.url === "/api/trpc/projects.list"
				? { projects: [{ id: workspaceId, availability: { status: "available" } }] }
				: request.url === "/api/trpc/workspace.getState"
					? { sessions }
					: undefined;
		response.writeHead(result ? 200 : 404, { "Content-Type": "application/json" });
		response.end(JSON.stringify(result ? { result: { data: result } } : { error: "隔离端点拒绝未知请求" }));
	});
	ownedHttpServers.push(runtimeHttpServer);
	runtimeHttpServer.listen(0, "127.0.0.1");
	await once(runtimeHttpServer, "listening");
	const address = runtimeHttpServer.address();
	if (!address || typeof address === "string") throw new Error("隔离 HTTP 端口分配失败");

	// 只给脚本提供定位本仓 ws 依赖的入口；不会执行 Kanban CLI 或读取全局安装。
	await symlink(resolve("package.json"), join(fixture.fixtureRootDirectoryPath, "kanban"));
	const child = spawnedScriptProcesses.register(
		spawn(process.execPath, [resolve("scripts/verify-codex-native-idle-user-turn-classification.mjs")], {
			cwd: fixture.fixtureRootDirectoryPath,
			env: fixture.createIsolatedChildProcessEnvironment({
				PATH: fixture.fixtureRootDirectoryPath,
				NODE_OPTIONS: undefined,
				KANBAN_RUNTIME_HOST: "127.0.0.1",
				KANBAN_RUNTIME_PORT: String(address.port),
				KANBAN_RUNTIME_HTTPS: "0",
			}),
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	const closed = once(child, "close");
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (bytes) => {
		stdout += String(bytes);
	});
	child.stderr?.on("data", (bytes) => {
		stderr += String(bytes);
	});
	await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
		test,
		child,
		{
			waitedForDescription: "隔离 PDV 脚本完成原生状态核验",
			softDeadlineMsExpectedOnUncontendedHost: 5_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
		},
		{ describeChildProcessOutputForFailureMessage: () => stdout + stderr },
	);
	await closed;
	expect(runtimeRequests.every((request) => request.method === "GET")).toBe(true);
	expect(
		nativeRequests.every((method) =>
			["initialize", "initialized", "thread/loaded/list", "thread/read"].includes(method),
		),
	).toBe(true);
	return { exitCode: child.exitCode, stderr, report: JSON.parse(stdout) as VerificationReport };
}

const verifiedIdleConversation: IsolatedNativeConversation = {
	conversationSessionId: "conversation-idle",
	nativeState: "idle",
	userTurnKind: "review",
};

describe.skipIf(process.platform === "win32")("原生空闲分类 PDV 脚本的未知状态门禁", { timeout: 35_000 }, () => {
	it.for(["unknown", "future_unrecognized_state"])("idle 成功不能掩盖 %s 状态", async (nativeState, test) => {
		const result = await runVerificationScriptAgainstIsolatedEndpoints(test, [
			verifiedIdleConversation,
			{ conversationSessionId: "conversation-unverifiable", nativeState, userTurnKind: "needs_input" },
		]);
		expect(result.exitCode, JSON.stringify(result)).toBe(1);
		expect(result.report.idleVerified).toBe(1);
		expect(result.report.failures).toEqual([
			expect.objectContaining({
				conversationSessionId: "conversation-unverifiable",
				reason: expect.stringContaining("无法核验"),
			}),
		]);
		expect(result.report.failures[0]?.reason).toContain(nativeState);
		expect(result.stderr).toContain("无法核验");
	});

	it("明确 active 会话可以跳过，保留 idle 成功结果", async (test) => {
		const result = await runVerificationScriptAgainstIsolatedEndpoints(test, [
			verifiedIdleConversation,
			{ conversationSessionId: "conversation-active", nativeState: "active", userTurnKind: "needs_input" },
		]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.report.idleVerified).toBe(1);
		expect(result.report.failures).toEqual([]);
		expect(result.report.observations).toEqual([
			expect.objectContaining({
				conversationSessionId: "conversation-idle",
				nativeState: "idle",
				userTurnKind: "review",
			}),
		]);
	});

	it("只有明确 idle 且可直接输入的会话时成功", async (test) => {
		const result = await runVerificationScriptAgainstIsolatedEndpoints(test, [verifiedIdleConversation]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.report.idleVerified).toBe(1);
		expect(result.report.failures).toEqual([]);
	});
});
