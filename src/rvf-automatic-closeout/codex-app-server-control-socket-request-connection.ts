import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type RawData, WebSocket } from "ws";
import { z } from "zod";
import type { CodexAppServerRequestPort } from "./codex-native-conversation-prefix";

type ControlSocketRequestOutcome =
	| "resolved"
	| "native_error"
	| "protocol_error"
	| "request_timeout"
	| "connection_timeout"
	| "connection_error"
	| "connection_closed"
	| "cancelled"
	| "operation_completed"
	| "operation_failed";

export interface CodexNativeControlSocketRequestDiagnostic {
	event:
		| "connection_opened"
		| "request_started"
		| "request_sent"
		| "frame_received"
		| "request_finished"
		| "connection_finished";
	connectionId: string;
	endpointSha256: string;
	connectionElapsedMs: number;
	requestTimeoutMs: number;
	pendingRequestCount: number;
	receivedFrameCount: number;
	receivedByteCount: number;
	requestId?: number;
	method?: string;
	requestElapsedMs?: number;
	requestParameters?: {
		threadIdSha256?: string;
		cursorSha256?: string | null;
		limit?: number;
		sortDirection?: "asc" | "desc";
		itemsView?: "full" | "summary";
	};
	frameByteCount?: number;
	jsonParseElapsedMs?: number;
	envelopeValidationElapsedMs?: number;
	responseClassification?:
		| "matched_response"
		| "unmatched_response"
		| "notification"
		| "server_request"
		| "invalid_json"
		| "invalid_envelope";
	outcome?: ControlSocketRequestOutcome;
	pendingTimerCount?: number;
	ownedSocketListenersRemoved?: boolean;
	abortListenerRemoved?: boolean;
	socketClosed?: boolean;
}

export interface CodexAppServerControlSocketConnectionInput {
	socketPath: string;
	clientName?: string;
	requestTimeoutMs?: number;
	signal?: AbortSignal;
	onDiagnostic?: (diagnostic: CodexNativeControlSocketRequestDiagnostic) => void | Promise<void>;
}

export class CodexAppServerControlSocketRequestError extends Error {
	constructor(
		public readonly outcome: ControlSocketRequestOutcome,
		message: string,
	) {
		super(message);
	}
}

const responseSchema = z.object({
	id: z.number(),
	result: z.unknown().optional(),
	error: z.object({ message: z.string() }).optional(),
});
const diagnosticRequestMethods = new Set([
	"initialize",
	"thread/loaded/list",
	"thread/turns/list",
	"thread/read",
	"thread/resume",
	"thread/start",
	"thread/fork",
]);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function summarizeRequestParameters(parameters: Record<string, unknown>) {
	const summary: NonNullable<CodexNativeControlSocketRequestDiagnostic["requestParameters"]> = {};
	if (typeof parameters.threadId === "string") summary.threadIdSha256 = sha256(parameters.threadId);
	if (parameters.cursor === null) summary.cursorSha256 = null;
	else if (typeof parameters.cursor === "string") summary.cursorSha256 = sha256(parameters.cursor);
	if (typeof parameters.limit === "number" && Number.isFinite(parameters.limit)) summary.limit = parameters.limit;
	if (parameters.sortDirection === "asc" || parameters.sortDirection === "desc")
		summary.sortDirection = parameters.sortDirection;
	if (parameters.itemsView === "full" || parameters.itemsView === "summary") summary.itemsView = parameters.itemsView;
	return summary;
}

interface PendingControlSocketRequest {
	method: string;
	startedAt: number;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

// 只关闭本次客户端；不发送 daemon stop、thread/unsubscribe 或会话变更请求。
export async function withRunningCodexAppServerControlSocketConnection<T>(
	operation: (port: CodexAppServerRequestPort) => Promise<T>,
	input?: CodexAppServerControlSocketConnectionInput,
): Promise<T> {
	const socketPath =
		input?.socketPath ??
		join(
			process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
			"app-server-control",
			"app-server-control.sock",
		);
	const requestTimeoutMs = input?.requestTimeoutMs ?? 2000;
	const connectionId = randomUUID();
	const endpointSha256 = sha256(socketPath);
	const connectionStartedAt = performance.now();
	const pending = new Map<number, PendingControlSocketRequest>();
	let sequence = 0;
	let receivedFrameCount = 0;
	let receivedByteCount = 0;
	let terminalError: CodexAppServerControlSocketRequestError | null = null;
	let completionOutcome: ControlSocketRequestOutcome = "operation_failed";
	const emit = (
		event: CodexNativeControlSocketRequestDiagnostic["event"],
		details: Partial<CodexNativeControlSocketRequestDiagnostic> = {},
	) => {
		if (!input?.onDiagnostic) return;
		try {
			// 诊断回调及其异步失败都不得改变原生请求结果。
			void Promise.resolve(
				input.onDiagnostic({
					...details,
					event,
					connectionId,
					endpointSha256,
					connectionElapsedMs: Math.round(performance.now() - connectionStartedAt),
					requestTimeoutMs,
					pendingRequestCount: pending.size,
					receivedFrameCount,
					receivedByteCount,
				}),
			).catch(() => {});
		} catch {}
	};
	const finishRequest = (id: number, outcome: ControlSocketRequestOutcome, error?: Error, result?: unknown) => {
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timer);
		emit("request_finished", {
			requestId: id,
			method: entry.method,
			requestElapsedMs: Math.round(performance.now() - entry.startedAt),
			outcome,
		});
		if (error) entry.reject(error);
		else entry.resolve(result);
	};
	const socket = new WebSocket(`ws+unix://${socketPath}:/`);
	let resolveOpen!: () => void;
	let rejectOpen!: (error: Error) => void;
	let openSettled = false;
	const opened = new Promise<void>((resolve, reject) => {
		resolveOpen = resolve;
		rejectOpen = reject;
	});
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const failConnection = (error: CodexAppServerControlSocketRequestError) => {
		terminalError ??= error;
		clearTimeout(openTimer);
		if (!openSettled) {
			openSettled = true;
			rejectOpen(terminalError);
		}
		for (const id of pending.keys()) finishRequest(id, terminalError.outcome, terminalError);
	};
	const openTimer = setTimeout(() => {
		failConnection(new CodexAppServerControlSocketRequestError("connection_timeout", "原生控制面连接超时。"));
		socket.terminate();
	}, 2000);
	const acceptOpen = () => {
		clearTimeout(openTimer);
		if (openSettled) return;
		openSettled = true;
		emit("connection_opened");
		resolveOpen();
	};
	const acceptMessage = (bytes: RawData) => {
		if (terminalError) return;
		const buffer = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
		receivedFrameCount++;
		receivedByteCount += buffer.byteLength;
		const parseStartedAt = performance.now();
		const frameDetails = { frameByteCount: buffer.byteLength, jsonParseElapsedMs: 0 };
		let value: unknown;
		try {
			value = JSON.parse(buffer.toString());
		} catch {
			frameDetails.jsonParseElapsedMs = performance.now() - parseStartedAt;
			emit("frame_received", { ...frameDetails, responseClassification: "invalid_json" });
			failConnection(
				new CodexAppServerControlSocketRequestError("protocol_error", "Codex 原生响应协议错误：JSON 无效。"),
			);
			socket.terminate();
			return;
		}
		frameDetails.jsonParseElapsedMs = performance.now() - parseStartedAt;
		const envelope = typeof value === "object" && value !== null ? value : null;
		if (envelope && "method" in envelope && typeof envelope.method === "string") {
			emit("frame_received", {
				...frameDetails,
				responseClassification: "id" in envelope ? "server_request" : "notification",
			});
			return;
		}
		const id = envelope && "id" in envelope && typeof envelope.id === "number" ? envelope.id : undefined;
		const entry = id === undefined ? undefined : pending.get(id);
		if (!entry || id === undefined) {
			emit("frame_received", { ...frameDetails, responseClassification: "unmatched_response" });
			return;
		}
		const validationStartedAt = performance.now();
		const parsed = responseSchema.safeParse(value);
		const envelopeValidationElapsedMs = performance.now() - validationStartedAt;
		if (!parsed.success || !envelope || Object.hasOwn(envelope, "result") === Object.hasOwn(envelope, "error")) {
			emit("frame_received", {
				...frameDetails,
				requestId: id,
				responseClassification: "invalid_envelope",
				envelopeValidationElapsedMs,
			});
			failConnection(
				new CodexAppServerControlSocketRequestError(
					"protocol_error",
					"Codex 原生响应协议错误：响应 envelope 无效。",
				),
			);
			socket.terminate();
			return;
		}
		emit("frame_received", {
			...frameDetails,
			requestId: id,
			responseClassification: "matched_response",
			envelopeValidationElapsedMs,
		});
		if (parsed.data.error) {
			// 原生错误正文不进入跨层错误文案或诊断日志。
			finishRequest(
				id,
				"native_error",
				new CodexAppServerControlSocketRequestError("native_error", "Codex 原生请求失败。"),
			);
		} else finishRequest(id, "resolved", undefined, parsed.data.result);
	};
	const acceptError = () =>
		failConnection(new CodexAppServerControlSocketRequestError("connection_error", "原生控制面连接失败。"));
	const acceptClose = () => {
		failConnection(new CodexAppServerControlSocketRequestError("connection_closed", "原生活动分支控制面已断开。"));
		resolveClosed();
	};
	const abortConnection = () => {
		failConnection(new CodexAppServerControlSocketRequestError("cancelled", "原生控制面连接已取消。"));
		socket.terminate();
	};
	socket.on("open", acceptOpen);
	socket.on("message", acceptMessage);
	socket.on("error", acceptError);
	socket.on("close", acceptClose);
	input?.signal?.addEventListener("abort", abortConnection, { once: true });
	try {
		if (input?.signal?.aborted) abortConnection();
		await opened;
		const port: CodexAppServerRequestPort = {
			request: (method, parameters) =>
				new Promise((resolve, reject) => {
					if (terminalError || socket.readyState !== WebSocket.OPEN) {
						reject(
							terminalError ??
								new CodexAppServerControlSocketRequestError("connection_closed", "原生控制面不在活动状态。"),
						);
						return;
					}
					const id = ++sequence;
					const diagnosticMethod = diagnosticRequestMethods.has(method) ? method : "other";
					const requestStartedAt = performance.now();
					const timer = setTimeout(() => {
						finishRequest(
							id,
							"request_timeout",
							new CodexAppServerControlSocketRequestError(
								"request_timeout",
								`原生实时查询超时：${diagnosticMethod}`,
							),
						);
					}, requestTimeoutMs);
					pending.set(id, { method: diagnosticMethod, startedAt: requestStartedAt, resolve, reject, timer });
					emit("request_started", {
						requestId: id,
						method: diagnosticMethod,
						requestParameters: summarizeRequestParameters(parameters),
					});
					try {
						socket.send(JSON.stringify({ id, method, params: parameters }), (error) => {
							if (error)
								failConnection(
									new CodexAppServerControlSocketRequestError("connection_error", "原生控制面请求发送失败。"),
								);
							else
								emit("request_sent", {
									requestId: id,
									method: diagnosticMethod,
									requestElapsedMs: Math.round(performance.now() - requestStartedAt),
								});
						});
					} catch {
						failConnection(
							new CodexAppServerControlSocketRequestError("connection_error", "原生控制面请求发送失败。"),
						);
					}
				}),
		};
		await port.request("initialize", {
			clientInfo: { name: input?.clientName ?? "kanban_rvf_review_boundary_observer", version: "1" },
			capabilities: { experimentalApi: true },
		});
		socket.send(JSON.stringify({ method: "initialized" }));
		const result = await operation(port);
		completionOutcome = "operation_completed";
		return result;
	} catch (error) {
		completionOutcome = error instanceof CodexAppServerControlSocketRequestError ? error.outcome : "operation_failed";
		throw error;
	} finally {
		input?.signal?.removeEventListener("abort", abortConnection);
		failConnection(new CodexAppServerControlSocketRequestError(completionOutcome, "本次实时观测已结束。"));
		socket.terminate();
		await closed;
		socket.off("open", acceptOpen);
		socket.off("message", acceptMessage);
		socket.off("error", acceptError);
		socket.off("close", acceptClose);
		emit("connection_finished", {
			outcome: completionOutcome,
			pendingTimerCount: pending.size,
			ownedSocketListenersRemoved: true,
			abortListenerRemoved: true,
			socketClosed: socket.readyState === WebSocket.CLOSED,
		});
	}
}
