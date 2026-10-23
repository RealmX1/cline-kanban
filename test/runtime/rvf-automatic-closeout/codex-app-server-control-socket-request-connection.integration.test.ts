import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { CodexNativeControlSocketRequestDiagnostic } from "../../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import { withRunningCodexAppServerControlSocketConnection } from "../../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { readCodexConversationTurns } from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";

interface FixtureNativeRequest {
	id?: number;
	method: string;
	params: Record<string, unknown>;
}

// 真实 Unix WebSocket；不读取用户 HOME、Codex 配置或生产会话。
async function createIsolatedControlSocketFixture(
	respond: (request: FixtureNativeRequest, socket: WebSocket) => void,
	initializeAutomatically = true,
) {
	// guarded runner 的 TMPDIR 较长，会超过 macOS Unix socket 路径上限；此处只放本 fixture 的临时 socket。
	const directory = await mkdtemp("/tmp/kanban-rvf-control-socket-test-");
	const socketPath = join(directory, "s");
	const server = createServer();
	const webSockets = new WebSocketServer({ server });
	const requests: FixtureNativeRequest[] = [];
	const diagnostics: CodexNativeControlSocketRequestDiagnostic[] = [];
	webSockets.on("connection", (socket) => {
		socket.on("message", (bytes) => {
			const request = JSON.parse(bytes.toString()) as FixtureNativeRequest;
			requests.push(request);
			if (!request.id) return;
			if (initializeAutomatically && request.method === "initialize")
				socket.send(JSON.stringify({ id: request.id, result: {} }));
			else respond(request, socket);
		});
	});
	onTestFinished(async () => {
		vi.useRealTimers();
		try {
			await vi.waitFor(() => expect(webSockets.clients.size).toBe(0));
		} finally {
			for (const socket of webSockets.clients) socket.terminate();
			await new Promise<void>((resolve) => webSockets.close(() => resolve()));
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.once("listening", resolve);
		server.listen(socketPath);
	});
	return {
		requests,
		diagnostics,
		input: {
			socketPath,
			onDiagnostic: (event: CodexNativeControlSocketRequestDiagnostic) => void diagnostics.push(event),
		},
	};
}

function expectConnectionResourcesReleased(diagnostics: CodexNativeControlSocketRequestDiagnostic[]) {
	expect(diagnostics.at(-1)).toMatchObject({
		event: "connection_finished",
		pendingRequestCount: 0,
		pendingTimerCount: 0,
		ownedSocketListenersRemoved: true,
		abortListenerRemoved: true,
		socketClosed: true,
	});
}

afterEach(() => vi.useRealTimers());

describe("Codex 原生控制 socket 请求与脱敏诊断", () => {
	it.each(["invalid_json", "invalid_error", "both_result_error", "missing_result_error"])(
		"%s 立即拒绝全部 pending，不吞成超时或泄露正文",
		async (scenario) => {
			const fixture = await createIsolatedControlSocketFixture((request, socket) => {
				if (request.method !== "thread/turns/list") return;
				const frame =
					scenario === "invalid_json"
						? `{"id":${request.id},"result":"SECRET_UNTERMINATED`
						: JSON.stringify({
								id: request.id,
								...(scenario === "invalid_error" ? { error: { message: 42 } } : {}),
								...(scenario === "both_result_error" ? { result: {}, error: { message: "SECRET_BOTH" } } : {}),
								private: "SECRET_PRIVATE",
							});
				socket.send(frame);
			});
			await withRunningCodexAppServerControlSocketConnection(async (port) => {
				const results = await Promise.allSettled([
					port.request("thread/turns/list", {}),
					port.request("thread/read", {}),
				]);
				for (const result of results) {
					expect(result.status).toBe("rejected");
					if (result.status !== "rejected") throw new Error("损坏响应意外完成。");
					expect(result.reason).toMatchObject({ outcome: "protocol_error" });
					expect(result.reason.message).toContain("协议错误");
					expect(result.reason.message).not.toContain("SECRET");
				}
				await expect(port.request("thread/read", {})).rejects.toMatchObject({ outcome: "protocol_error" });
			}, fixture.input);
			expect(fixture.diagnostics.filter((event) => event.outcome === "request_timeout")).toEqual([]);
			expect(fixture.diagnostics.filter((event) => event.outcome === "protocol_error")).toHaveLength(2);
			expect(JSON.stringify(fixture.diagnostics)).not.toContain("SECRET");
			expectConnectionResourcesReleased(fixture.diagnostics);
		},
	);

	it("大响应分片保留 Unicode 与分页，通知和同 id 服务端请求不误完成查询", async () => {
		const text = `中文😀前\u2028中\u2029后${"输出".repeat(180_000)}`;
		const fixture = await createIsolatedControlSocketFixture((request, socket) => {
			const secondPage = request.params.cursor === "SECRET_CURSOR";
			socket.send(JSON.stringify({ method: "fixture/SECRET_NOTICE", params: { text } }));
			socket.send(JSON.stringify({ id: request.id, method: "fixture/server-request", params: {} }));
			socket.send(JSON.stringify({ id: 99999, result: "SECRET_UNMATCHED" }));
			const frame = Buffer.from(
				JSON.stringify({
					id: request.id,
					result: {
						data: [
							{
								id: secondPage ? "turn-2" : "turn-1",
								status: "completed",
								items: [{ id: "tool", type: "commandExecution", aggregatedOutput: text }],
							},
						],
						nextCursor: secondPage ? null : "SECRET_CURSOR",
					},
				}),
			);
			socket.send(frame.subarray(0, 31), { fin: false });
			socket.send(frame.subarray(31), { fin: true });
		});
		const turns = await withRunningCodexAppServerControlSocketConnection(
			(port) => readCodexConversationTurns(port, "SECRET_THREAD"),
			fixture.input,
		);
		expect(turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2"]);
		expect(turns[0]?.items[0]?.aggregatedOutput).toBe(text);
		expect(
			fixture.requests.filter((request) => request.method === "thread/turns/list").map((request) => request.params),
		).toEqual([
			{ threadId: "SECRET_THREAD", cursor: null, limit: 100, sortDirection: "asc", itemsView: "full" },
			{ threadId: "SECRET_THREAD", cursor: "SECRET_CURSOR", limit: 100, sortDirection: "asc", itemsView: "full" },
		]);
		expect(fixture.diagnostics.some((event) => (event.frameByteCount ?? 0) > 1_000_000)).toBe(true);
		for (const classification of ["notification", "server_request", "unmatched_response", "matched_response"])
			expect(fixture.diagnostics.some((event) => event.responseClassification === classification)).toBe(true);
		expect(JSON.stringify(fixture.diagnostics)).not.toContain("SECRET");
		expect(JSON.stringify(fixture.diagnostics)).not.toContain(fixture.input.socketPath);
		expectConnectionResourcesReleased(fixture.diagnostics);
	});

	it("合法原生错误与乱序响应分别结算，诊断不保存原生错误消息", async () => {
		let first: FixtureNativeRequest | undefined;
		const fixture = await createIsolatedControlSocketFixture((request, socket) => {
			if (request.method === "thread/read")
				socket.send(JSON.stringify({ id: request.id, error: { message: "SECRET_NATIVE_ERROR" } }));
			else if (request.params.sequence === "first") first = request;
			else {
				socket.send(JSON.stringify({ id: request.id, result: "second" }));
				socket.send(JSON.stringify({ id: first?.id, result: "first" }));
			}
		});
		await withRunningCodexAppServerControlSocketConnection(async (port) => {
			await expect(port.request("thread/read", {})).rejects.toMatchObject({
				outcome: "native_error",
				message: "Codex 原生请求失败。",
			});
			expect(
				await Promise.all([
					port.request("thread/turns/list", { sequence: "first" }),
					port.request("thread/turns/list", { sequence: "second" }),
				]),
			).toEqual(["first", "second"]);
		}, fixture.input);
		expect(JSON.stringify(fixture.diagnostics)).not.toContain("SECRET");
		expectConnectionResourcesReleased(fixture.diagnostics);
	});

	it("默认预算仍为 2000ms，迟到响应不完成另一请求", async () => {
		let requestReceived!: () => void;
		const received = new Promise<void>((resolve) => {
			requestReceived = resolve;
		});
		let lateResponse: (() => void) | undefined;
		const fixture = await createIsolatedControlSocketFixture((request, socket) => {
			if (request.params.wait) {
				lateResponse = () => socket.send(JSON.stringify({ id: request.id, result: "late" }));
				requestReceived();
			} else {
				lateResponse?.();
				socket.send(JSON.stringify({ id: request.id, result: "current" }));
			}
		});
		await withRunningCodexAppServerControlSocketConnection(async (port) => {
			vi.useFakeTimers();
			const pending = port.request("thread/turns/list", { wait: true });
			const assertion = expect(pending).rejects.toMatchObject({ outcome: "request_timeout" });
			await received;
			await vi.advanceTimersByTimeAsync(1999);
			expect(fixture.diagnostics.some((event) => event.outcome === "request_timeout")).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await assertion;
			expect(vi.getTimerCount()).toBe(0);
			vi.useRealTimers();
			expect(await port.request("thread/turns/list", {})).toBe("current");
		}, fixture.input);
		expect(fixture.diagnostics.filter((event) => event.outcome === "request_timeout")).toHaveLength(1);
		expect(fixture.diagnostics.every((event) => event.requestTimeoutMs === 2000)).toBe(true);
		expect(fixture.diagnostics.some((event) => event.responseClassification === "unmatched_response")).toBe(true);
		expectConnectionResourcesReleased(fixture.diagnostics);
	});

	it.each(["abort_before_open", "abort_initialize", "abort_request", "close_request", "operation_throws"])(
		"%s 拒绝并释放本次连接",
		async (scenario) => {
			const cancellation = new AbortController();
			const fixture = await createIsolatedControlSocketFixture((request, socket) => {
				if (scenario === "abort_initialize" || scenario === "abort_request") cancellation.abort();
				else if (scenario === "close_request") socket.close();
				else socket.send(JSON.stringify({ id: request.id, result: {} }));
			}, scenario !== "abort_initialize");
			if (scenario === "abort_before_open") cancellation.abort();
			const result = withRunningCodexAppServerControlSocketConnection(
				async (port) => {
					if (scenario === "operation_throws") throw new Error("operation failure");
					return port.request("thread/turns/list", {});
				},
				{ ...fixture.input, signal: cancellation.signal },
			);
			if (scenario === "operation_throws") await expect(result).rejects.toThrow("operation failure");
			else
				await expect(result).rejects.toMatchObject({
					outcome: scenario === "close_request" ? "connection_closed" : "cancelled",
				});
			expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
			expectConnectionResourcesReleased(fixture.diagnostics);
		},
	);

	it.each(["sync", "async"])("%s 诊断回调失败不改变请求结果", async (failureKind) => {
		const fixture = await createIsolatedControlSocketFixture((request, socket) =>
			socket.send(JSON.stringify({ id: request.id, result: "ok" })),
		);
		await expect(
			withRunningCodexAppServerControlSocketConnection((port) => port.request("thread/read", {}), {
				...fixture.input,
				onDiagnostic: () => {
					if (failureKind === "sync") throw new Error("diagnostic failure");
					return Promise.reject(new Error("diagnostic failure"));
				},
			}),
		).resolves.toBe("ok");
	});
});
