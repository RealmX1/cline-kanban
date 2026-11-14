import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
	AcpConnectionRuntimeHandlers,
	AcpTaskConnectionStartInput,
} from "../acp-client-session/acp-client-connection-runtime";
import type {
	AcpContentBlock,
	AcpPromptResponse,
	AcpSessionNotification,
} from "../acp-client-session/acp-protocol-boundary";
import { withRunningCodexAppServerControlSocketConnection } from "../codex-native-session-protocol/codex-app-server-control-socket-request-connection";
import {
	type CodexAppServerRequestPort,
	readCodexConversationTurns,
} from "../codex-native-session-protocol/codex-native-conversation-history";
import { projectCodexNativeNotification, readNativeProtocolRecord } from "./codex-native-conversation-event-projection";
import type {
	StructuredAgentConversationConnectionRuntime,
	StructuredAgentConversationTaskConnection,
} from "./structured-agent-conversation-connection-runtime";

const openedThreadSchema = z.object({
	thread: z.object({ id: z.string().min(1), cwd: z.string() }),
	model: z.string(),
});
interface NativeActiveTurn {
	id: string | null;
	cancelRequested: boolean;
	resolve(value: AcpPromptResponse): void;
	reject(error: Error): void;
}
interface NativeConnectionRecord extends StructuredAgentConversationTaskConnection {
	child: ChildProcessByStdio<Writable, Readable, Readable>;
	port: CodexAppServerRequestPort;
	cancellation: AbortController;
	finished: Promise<void>;
	release(): void;
	active: NativeActiveTurn | null;
	disposed: boolean;
}

export interface CodexNativeConversationRuntimeOptions {
	binary: string;
	environment: NodeJS.ProcessEnv;
	onProtocolEvent?: (event: {
		direction: "request" | "notification" | "server_request";
		method: string;
		parameters: Record<string, unknown>;
	}) => void;
}

// 与现有 ACP 服务共用投递、facet、历史重播与人机交互；执行只经过原生 App Server。
export class CodexNativeConversationConnectionRuntime implements StructuredAgentConversationConnectionRuntime {
	private readonly records = new Map<string, NativeConnectionRecord>();
	private readonly replaying = new Set<string>();
	constructor(
		private readonly handlers: AcpConnectionRuntimeHandlers,
		private readonly options: CodexNativeConversationRuntimeOptions,
	) {}
	getConnection(taskId: string) {
		return this.records.get(taskId) ?? null;
	}
	isReplayingPersistedConversationHistory(taskId: string) {
		return this.replaying.has(taskId);
	}

	async startTaskConnection(input: AcpTaskConnectionStartInput): Promise<StructuredAgentConversationTaskConnection> {
		const existing = this.records.get(input.taskId);
		if (existing) return existing;
		if (input.agentId !== "codex") throw new Error("原生比较后端只支持 Codex。");
		if (input.resumePriorAgentConversationWithoutResendingPrompt && !input.observedAgentNativeSessionId)
			throw new Error("原生恢复必须有确切会话 ID，未按目录猜测或创建空会话。");
		await input.revalidateExistingMainSessionHandoverTargetBeforeLaunch?.();
		await input.beforeAgentProcessLaunch?.();
		if (input.isRuntimeSessionIncarnationCurrent?.() === false) throw new Error("原生启动代际已失效。");
		// 临时目录只持有本代 Unix socket；交接证据由比较宿主另行持久保存。
		const socketDirectory = await mkdtemp("/tmp/kanban-codex-comparison-");
		const socketPath = join(socketDirectory, "s");
		const child = spawn(this.options.binary, ["app-server", "--listen", `unix://${socketPath}`], {
			cwd: input.cwd,
			env: { ...this.options.environment, ...input.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<Writable, Readable, Readable>;
		child.stdout.resume();
		child.stderr.resume();
		let launchError: Error | null = null;
		child.once("error", (error) => {
			launchError = error;
		});
		let exited = false;
		const childClosed = new Promise<void>((accept) =>
			child.once("close", () => {
				exited = true;
				accept();
			}),
		);
		const cancellation = new AbortController();
		let release!: () => void;
		const released = new Promise<void>((accept) => {
			release = accept;
		});
		let acceptReady!: (record: NativeConnectionRecord) => void;
		let rejectReady!: (error: unknown) => void;
		const ready = new Promise<NativeConnectionRecord>((accept, reject) => {
			acceptReady = accept;
			rejectReady = reject;
		});
		let record: NativeConnectionRecord | undefined;
		const lifecycle = (async () => {
			try {
				const deadline = Date.now() + 10_000;
				while (!(await stat(socketPath).catch(() => null))) {
					if (launchError) throw launchError;
					if (exited || Date.now() > deadline) throw new Error("本代原生 App Server 未就绪。");
					await delay(25);
				}
				await withRunningCodexAppServerControlSocketConnection(
					async (rawPort) => {
						const port: CodexAppServerRequestPort = {
							request: async (method, parameters) => {
								this.options.onProtocolEvent?.({ direction: "request", method, parameters });
								return await rawPort.request(method, parameters);
							},
						};
						const settings = {
							cwd: input.cwd,
							model: input.modelId,
							// EXPERIMENT_NODE: 核验新版权限 profile 对逐工具询问的表达，原型暂以只读沙箱收紧。
							approvalPolicy: input.permissionMode === "bypass_all_permission_prompts" ? "never" : "on-request",
							sandbox:
								input.permissionMode === "bypass_all_permission_prompts" ? "danger-full-access" : "read-only",
						};
						const opened = openedThreadSchema.parse(
							await port.request(
								input.resumePriorAgentConversationWithoutResendingPrompt
									? "thread/resume"
									: input.taskConversationSessionContextForkSourceNativeSessionId
										? "thread/fork"
										: "thread/start",
								{
									...settings,
									...(input.observedAgentNativeSessionId
										? { threadId: input.observedAgentNativeSessionId }
										: {}),
									...(input.taskConversationSessionContextForkSourceNativeSessionId
										? { threadId: input.taskConversationSessionContextForkSourceNativeSessionId }
										: {}),
								},
							),
						);
						if ((await realpath(opened.thread.cwd)) !== (await realpath(input.cwd)))
							throw new Error("原生会话目录不匹配。");
						if (input.taskConversationSessionContextForkSourceNativeSessionId === opened.thread.id)
							throw new Error("原生 fork 未创建独立分支。");
						let mode: "plan" | "default" | null = input.resumePriorAgentConversationWithoutResendingPrompt
							? null
							: input.startInPlanMode
								? "plan"
								: "default";
						record = {
							taskId: input.taskId,
							agentId: "codex",
							sessionId: opened.thread.id,
							pid: child.pid ?? null,
							child,
							port,
							cancellation,
							finished: lifecycle,
							release,
							disposed: false,
							active: null,
							prompt: async (blocks) => {
								const owner = record;
								if (
									!owner ||
									owner.active ||
									owner.disposed ||
									this.records.get(input.taskId) !== owner ||
									input.isRuntimeSessionIncarnationCurrent?.() === false
								)
									throw new Error("原生会话正在执行或已关闭。");
								const nativeInput = blocks.map(toNativeUserInput);
								return await new Promise<AcpPromptResponse>((accept, reject) => {
									const active: NativeActiveTurn = {
										id: null,
										cancelRequested: false,
										resolve: accept,
										reject,
									};
									owner.active = active;
									void port
										.request("turn/start", {
											threadId: owner.sessionId,
											input: nativeInput,
											...(mode
												? {
														collaborationMode: {
															mode,
															settings: {
																model: opened.model,
																reasoning_effort: null,
																developer_instructions: null,
															},
														},
													}
												: {}),
										})
										.then(async (response) => {
											if (owner.active !== active) return;
											active.id = z.object({ turn: z.object({ id: z.string() }) }).parse(response).turn.id;
											if (active.cancelRequested) await owner.cancel();
										})
										.catch((error: unknown) => {
											if (owner.active === active) {
												owner.active = null;
												reject(error);
											}
										});
								});
							},
							cancel: async () => {
								if (!record?.active) return;
								record.active.cancelRequested = true;
								if (record.active.id)
									await port.request("turn/interrupt", {
										threadId: record.sessionId,
										turnId: record.active.id,
									});
							},
							setSessionMode: async (requestedMode) => {
								if (requestedMode !== "plan" && requestedMode !== "default") throw new Error("未知原生模式。");
								mode = requestedMode;
							},
							close: () => {
								if (this.records.get(input.taskId) === record) this.disposeTaskConnection(input.taskId);
							},
						};
						this.records.set(input.taskId, record);
						if (
							input.resumePriorAgentConversationWithoutResendingPrompt ||
							input.taskConversationSessionContextForkSourceNativeSessionId
						) {
							this.replaying.add(input.taskId);
							try {
								for (const turn of await readCodexConversationTurns(port, record.sessionId))
									for (const item of turn.items) {
										if (item.type === "agentMessage" && typeof item.text === "string")
											this.deliver(input, {
												sessionId: record.sessionId,
												update: {
													sessionUpdate: "agent_message_chunk",
													messageId: item.id,
													content: { type: "text", text: item.text },
												},
											});
										else
											for (const notification of projectCodexNativeNotification(
												record.sessionId,
												"item/completed",
												{ threadId: record.sessionId, item },
											))
												this.deliver(input, notification);
									}
							} finally {
								this.replaying.delete(input.taskId);
							}
						}
						if (input.isRuntimeSessionIncarnationCurrent?.() === false) throw new Error("原生启动已被替换。");
						acceptReady(record);
						await released;
					},
					{
						socketPath,
						clientName: "kanban_codex_protocol_comparison",
						requestTimeoutMs: 15_000,
						signal: cancellation.signal,
						onNotification: (method, parameters) => {
							this.options.onProtocolEvent?.({ direction: "notification", method, parameters });
							if (
								!record ||
								record.disposed ||
								parameters.threadId !== record.sessionId ||
								input.isRuntimeSessionIncarnationCurrent?.() === false
							)
								return;
							if (method === "turn/completed") {
								const turn = readNativeProtocolRecord(parameters.turn);
								const active = record.active;
								if (!active || (active.id !== null && active.id !== turn.id)) return;
								record.active = null;
								if (turn.status === "completed" || turn.status === "interrupted")
									active.resolve({ stopReason: turn.status === "interrupted" ? "cancelled" : "end_turn" });
								else
									active.reject(
										new Error(String(readNativeProtocolRecord(turn.error).message ?? "原生回合失败。")),
									);
							} else {
								for (const notification of projectCodexNativeNotification(
									record.sessionId,
									method,
									parameters,
								)) {
									if (notification.update.sessionUpdate !== "user_message_chunk")
										this.deliver(input, notification);
								}
							}
						},
						onServerRequest: async (method, parameters) => {
							this.options.onProtocolEvent?.({ direction: "server_request", method, parameters });
							if (
								!record ||
								record.disposed ||
								parameters.threadId !== record.sessionId ||
								input.isRuntimeSessionIncarnationCurrent?.() === false
							)
								throw new Error("原生请求归属失效。");
							if (
								method === "item/commandExecution/requestApproval" ||
								method === "item/fileChange/requestApproval"
							) {
								const response = await this.handlers.onPermissionRequest(input.taskId, {
									sessionId: record.sessionId,
									toolCall: {
										toolCallId: String(parameters.itemId),
										title: String(parameters.command ?? parameters.reason ?? "文件修改"),
									},
									options: [
										{ optionId: "accept", name: "允许本次", kind: "allow_once" },
										{ optionId: "decline", name: "拒绝", kind: "reject_once" },
									],
								});
								return {
									decision:
										response.outcome.outcome === "selected" && response.outcome.optionId === "accept"
											? "accept"
											: "decline",
								};
							}
							if (method === "item/tool/requestUserInput") {
								const answers: Record<string, { answers: string[] }> = {};
								for (const value of Array.isArray(parameters.questions) ? parameters.questions : []) {
									const question = readNativeProtocolRecord(value);
									const labels = (Array.isArray(question.options) ? question.options : []).map((option) =>
										String(readNativeProtocolRecord(option).label),
									);
									if (!labels.length || typeof question.id !== "string") continue;
									const answer = await this.handlers.onElicitationRequest(input.taskId, {
										sessionId: record.sessionId,
										mode: "form",
										message: String(question.question),
										requestedSchema: {
											type: "object",
											properties: { answer: { type: "string", enum: labels } },
											required: ["answer"],
										},
									});
									const content = answer.action === "accept" ? readNativeProtocolRecord(answer.content) : {};
									if (answer.action === "accept" && typeof content.answer === "string")
										answers[question.id] = { answers: [content.answer] };
								}
								return { answers };
							}
							throw new Error("未实现的原生交互请求，未自动批准。");
						},
						onConnectionClosed: () => {
							record?.active?.reject(new Error("原生连接断开，输入接受保持未知，未重发。"));
							release();
						},
					},
				);
			} catch (error) {
				rejectReady(error);
				record?.active?.reject(error instanceof Error ? error : new Error(String(error)));
			} finally {
				if (record && this.records.get(input.taskId) === record) this.records.delete(input.taskId);
				if (!exited) {
					try {
						if (child.pid) process.kill(-child.pid, "SIGTERM");
					} catch {
						/* 进程组已退出。 */
					}
					const escalation = setTimeout(() => {
						try {
							if (child.pid) process.kill(-child.pid, "SIGKILL");
						} catch {
							/* 已退出。 */
						}
					}, 2_000);
					await childClosed;
					clearTimeout(escalation);
				}
				await rm(socketDirectory, { recursive: true, force: true });
				if (record && input.isRuntimeSessionIncarnationCurrent?.() !== false)
					this.handlers.onConnectionClosed(input.taskId, {
						exitCode: child.exitCode,
						terminationSignal: child.signalCode,
						closeIntent: record.disposed ? "disposed_by_kanban" : "exited_on_its_own",
						stderrDiagnostics: "",
					});
			}
		})();
		void lifecycle;
		return await ready;
	}
	private deliver(input: AcpTaskConnectionStartInput, notification: AcpSessionNotification) {
		if (input.isRuntimeSessionIncarnationCurrent?.() !== false)
			this.handlers.onSessionUpdate(input.taskId, notification);
	}
	disposeTaskConnection(taskId: string) {
		const record = this.records.get(taskId);
		if (!record) return;
		record.disposed = true;
		this.records.delete(taskId);
		record.active?.reject(new Error("原生执行已停止，未重发在途输入。"));
		record.release();
		record.cancellation.abort();
	}
	async stopTaskConnectionAndConfirmExit(taskId: string) {
		const record = this.records.get(taskId);
		this.disposeTaskConnection(taskId);
		await record?.finished;
		return {
			rootPid: record?.pid ?? null,
			rootProcessExitConfirmed: true,
			usedForcefulEscalation: record?.child.signalCode === "SIGKILL",
		};
	}
	disposeAllTaskConnections() {
		for (const taskId of this.records.keys()) this.disposeTaskConnection(taskId);
	}
	getNativeRequestPort(taskId: string) {
		return this.records.get(taskId)?.port ?? null;
	}
}

function toNativeUserInput(block: AcpContentBlock) {
	if (block.type === "text") return { type: "text", text: block.text, text_elements: [] };
	if (block.type === "image") return { type: "image", url: `data:${block.mimeType};base64,${block.data}` };
	throw new Error(`原生比较原型暂不支持该输入类型：${block.type}。未丢弃内容或发送半条输入。`);
}
