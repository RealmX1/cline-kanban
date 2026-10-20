import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { z } from "zod";
import type { CodexAppServerRequestPort } from "./codex-native-conversation-prefix";

const responseSchema = z.object({
	id: z.number(),
	result: z.unknown().optional(),
	error: z.object({ message: z.string() }).optional(),
});

export async function withCodexAppServerRequestConnection<T>(
	input: {
		workingDirectory: string;
		binary?: string;
		environment?: NodeJS.ProcessEnv;
		argumentsBeforeSubcommand?: string[];
	},
	operation: (connection: CodexAppServerRequestPort) => Promise<T>,
): Promise<T> {
	// 这是本次操作自己的 stdio 子进程，不连接或停止共享 daemon。它只读取/分支原生历史，绝不 turn/start。
	const child = spawn(input.binary ?? "codex", [...(input.argumentsBeforeSubcommand ?? []), "app-server", "--stdio"], {
		cwd: input.workingDirectory,
		env: input.environment ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const reader = createInterface({ input: child.stdout });
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	let sequence = 0;
	let closed = false;
	const rejectPending = (error: Error) => {
		closed = true;
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	};
	let processClosed = false;
	const processClose = new Promise<void>((resolveClose) =>
		child.once("close", () => {
			processClosed = true;
			resolveClose();
		}),
	);
	child.stdin.on("error", rejectPending);
	child.once("error", (error) => rejectPending(error));
	child.once("exit", () => rejectPending(new Error("Codex app-server 在操作完成前退出。")));
	// 持续排空，避免 stderr 管道反压；不把可能含配置细节的原始输出写日志。
	child.stderr.resume();
	reader.on("line", (line) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		const response = responseSchema.safeParse(parsed);
		if (!response.success) return;
		const entry = pending.get(response.data.id);
		if (!entry) return;
		pending.delete(response.data.id);
		clearTimeout(entry.timer);
		if (response.data.error) entry.reject(new Error(`Codex 原生请求失败：${response.data.error.message}`));
		else entry.resolve(response.data.result);
	});
	const connection: CodexAppServerRequestPort = {
		request: (method, parameters) =>
			new Promise((resolveRequest, rejectRequest) => {
				if (closed) {
					rejectRequest(new Error("Codex 原生请求连接已关闭。"));
					return;
				}
				const id = ++sequence;
				const timer = setTimeout(() => {
					pending.delete(id);
					rejectRequest(new Error(`Codex 原生请求超时：${method}`));
				}, 20_000);
				pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
				child.stdin.write(`${JSON.stringify({ id, method, params: parameters })}\n`, (error) => {
					if (error) {
						clearTimeout(timer);
						pending.delete(id);
						rejectRequest(error);
					}
				});
			}),
	};
	try {
		await connection.request("initialize", { clientInfo: { name: "kanban_rvf_automatic_closeout", version: "1" } });
		child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
		return await operation(connection);
	} finally {
		rejectPending(new Error("Codex 原生操作已结束。"));
		reader.close();
		if (!processClosed) {
			const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
			child.kill("SIGTERM");
			await processClose;
			clearTimeout(escalation);
		}
	}
}

// 只连接已在运行的 TUI 宿主。独立 stdio app-server 与 proxy 的原始 WebSocket 字节流均不等于实时 RPC。
export async function withRunningCodexAppServerControlSocketConnection<T>(
	operation: (port: CodexAppServerRequestPort) => Promise<T>,
) {
	const socketPath = join(
		process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
		"app-server-control",
		"app-server-control.sock",
	);
	const socket = new WebSocket(`ws+unix://${socketPath}:/`);
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	let sequence = 0;
	const rejectPending = (error: Error) => {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	};
	socket.on("message", (bytes) => {
		let value: unknown;
		try {
			value = JSON.parse(bytes.toString());
		} catch {
			return;
		}
		const parsed = responseSchema.safeParse(value);
		if (!parsed.success) return;
		const entry = pending.get(parsed.data.id);
		if (!entry) return;
		pending.delete(parsed.data.id);
		clearTimeout(entry.timer);
		if (parsed.data.error) entry.reject(new Error(parsed.data.error.message));
		else entry.resolve(parsed.data.result);
	});
	socket.on("error", (error) => rejectPending(error));
	socket.on("close", () => rejectPending(new Error("原生活动分支控制面已断开。")));
	try {
		await new Promise<void>((resolveOpen, rejectOpen) => {
			const timer = setTimeout(() => rejectOpen(new Error("原生控制面连接超时。")), 2000);
			socket.once("open", () => {
				clearTimeout(timer);
				resolveOpen();
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				rejectOpen(error);
			});
		});
		const port: CodexAppServerRequestPort = {
			request: (method, parameters) =>
				new Promise((resolveRequest, rejectRequest) => {
					if (socket.readyState !== WebSocket.OPEN) {
						rejectRequest(new Error("原生控制面不在活动状态。"));
						return;
					}
					const id = ++sequence;
					const timer = setTimeout(() => {
						pending.delete(id);
						rejectRequest(new Error(`原生实时查询超时：${method}`));
					}, 2000);
					pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
					socket.send(JSON.stringify({ id, method, params: parameters }), (error) => {
						if (error) {
							clearTimeout(timer);
							pending.delete(id);
							rejectRequest(error);
						}
					});
				}),
		};
		await port.request("initialize", {
			clientInfo: { name: "kanban_rvf_review_boundary_observer", version: "1" },
			capabilities: { experimentalApi: true },
		});
		socket.send(JSON.stringify({ method: "initialized" }));
		return await operation(port);
	} finally {
		rejectPending(new Error("本次实时观测已结束。"));
		// terminate 只关闭本次客户端 socket，不发送 daemon stop、thread/unsubscribe 或任何会话变更请求。
		socket.terminate();
	}
}
