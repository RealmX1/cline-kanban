// 拥有 ACP 子进程与协议连接：每个任务一个 agent 进程（与终端 agent 同构——杀掉一个任务就是
// 杀掉它自己的进程，pid 也就能如实喂给 summary 的存活度判定）。
//
// 这层只管「连接生命周期与协议调用」，不认识 Kanban 的看板状态；SessionUpdate 到 facet /
// 聊天消息的翻译在 acp-session-update-adapter.ts。
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import treeKill from "tree-kill";
import type { RuntimeAgentId, RuntimeTaskAgentPermissionMode } from "../core/api-contract";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import { requireAcpAgentLaunchDefinition } from "./acp-agent-launch-catalog";
import {
	ACP_AGENT_METHODS,
	ACP_PROTOCOL_VERSION,
	type AcpClientConnection,
	type AcpContentBlock,
	type AcpCreateElicitationRequest,
	type AcpCreateElicitationResponse,
	type AcpInitializeResponse,
	type AcpPromptResponse,
	type AcpRequestPermissionRequest,
	type AcpRequestPermissionResponse,
	type AcpSessionId,
	type AcpSessionNotification,
	buildKanbanAcpClientCapabilities,
	connectKanbanAcpClient,
	createAcpNdJsonStreamOverChildProcessStdio,
	isAcpAuthenticationRequiredError,
} from "./acp-protocol-boundary";

// agent 进程写到 stderr 的诊断信息保留最近这么多字符，用于把启动失败的真实原因带回给用户。
const AGENT_STDERR_DIAGNOSTIC_BUFFER_CHARACTER_LIMIT = 8_000;

// session/list 返回的 `updatedAt` 是 ISO 8601 字符串（omp 的 #toSessionInfo 写的是
// `session.modified.toISOString()`）。解析不出来的一律当成「最旧」，好让格式变化只会让排序退化，
// 而不是让整个挑选逻辑抛异常。
function readAgentSessionUpdatedAtMs(session: { updatedAt?: unknown }): number {
	if (typeof session.updatedAt !== "string") {
		return Number.NEGATIVE_INFINITY;
	}
	const parsedMs = Date.parse(session.updatedAt);
	return Number.isNaN(parsedMs) ? Number.NEGATIVE_INFINITY : parsedMs;
}

export interface AcpTaskConnectionStartInput {
	taskId: string;
	agentId: RuntimeAgentId;
	// 必须是绝对路径：ACP 的 session/new 要求绝对 cwd，omp 会直接拒收相对路径。
	cwd: string;
	permissionMode: RuntimeTaskAgentPermissionMode;
	startInPlanMode?: boolean;
	// 续跑既有对话而不是开新会话：用 session/list({cwd}) 找到该 worktree 下最近的一条 omp 会话，
	// 再 session/load 把它接上（omp 声明 loadSession: true 并实现了这两个方法）。
	// 找不到或加载失败一律**抛错**，绝不静默回落到 session/new：静默开一个空会话会让用户以为
	// 上下文接上了，而且这条新会话会顶掉「最近一条」，令之后切回 TUI 的 --continue 也接错。
	resumePriorAgentConversationWithoutResendingPrompt?: boolean;
	env?: Record<string, string | undefined>;
}

// 连接是怎么没的：Kanban 主动拆的（stop / clear / 关服），还是 agent 进程自己退的。
// 这个区分是承重的：主动拆连接时的终态已经由发起方写定（interrupted，或 clear 后的全新空会话），
// 退出回调再写一次就会把它改写回「回合正常收束」，甚至把旧消息复活到刚重建的会话上。
export type AcpConnectionCloseIntent = "disposed_by_kanban" | "exited_on_its_own";

export interface AcpConnectionClosedDetail {
	// 正常退出给退出码；被信号杀死时 exitCode 为 null，信号名落在 terminationSignal 上。
	exitCode: number | null;
	terminationSignal: NodeJS.Signals | null;
	closeIntent: AcpConnectionCloseIntent;
	stderrDiagnostics: string;
}

export interface AcpConnectionRuntimeHandlers {
	// 已按 sessionId 反查到 taskId 的 session/update。
	onSessionUpdate(taskId: string, notification: AcpSessionNotification): void;
	onPermissionRequest(taskId: string, request: AcpRequestPermissionRequest): Promise<AcpRequestPermissionResponse>;
	onElicitationRequest(taskId: string, request: AcpCreateElicitationRequest): Promise<AcpCreateElicitationResponse>;
	// 子进程退出或连接断开。
	onConnectionClosed(taskId: string, detail: AcpConnectionClosedDetail): void;
}

export interface AcpTaskConnection {
	readonly taskId: string;
	readonly agentId: RuntimeAgentId;
	readonly sessionId: AcpSessionId;
	readonly pid: number | null;
	readonly initializeResponse: AcpInitializeResponse;
	prompt(promptBlocks: AcpContentBlock[]): Promise<AcpPromptResponse>;
	cancel(): Promise<void>;
	setSessionMode(sessionModeId: string): Promise<void>;
	close(): void;
}

interface AcpTaskConnectionRecord extends AcpTaskConnection {
	child: ChildProcessByStdio<Writable, Readable, Readable>;
	connection: AcpClientConnection;
	// dispose 与子进程 exit 事件之间隔着一次事件循环，必须先记下意图，退出回调才认得出
	// 「这是我自己拆的」而不是「agent 崩了」。
	disposedByKanban: boolean;
}

export class AcpClientConnectionRuntime {
	private readonly connectionsByTaskId = new Map<string, AcpTaskConnectionRecord>();
	private readonly taskIdBySessionId = new Map<string, string>();
	// 正在跑 session/load 的 task。协议层分不出「历史重播」与「agent 此刻在产出」——两者都是
	// agent_message_chunk / tool_call，唯一的区分事实就是「我们正处在 session/load 之中」。
	// session/load 的 await 期间同步到达的每一条 update 都落在这个窗口里（omp 在返回响应前
	// 就把历史推完），于是 add/delete 这对括号足以覆盖整段重播。
	private readonly replayingHistoryTaskIds = new Set<string>();

	constructor(private readonly handlers: AcpConnectionRuntimeHandlers) {}

	getConnection(taskId: string): AcpTaskConnection | null {
		return this.connectionsByTaskId.get(taskId) ?? null;
	}

	// 该 task 此刻是否正在重播 session/load 的历史。会话服务据此挂重播守卫
	// （见 AcpSessionUpdateContext.isReplayingPersistedConversationHistory）。
	isReplayingPersistedConversationHistory(taskId: string): boolean {
		return this.replayingHistoryTaskIds.has(taskId);
	}

	async startTaskConnection(input: AcpTaskConnectionStartInput): Promise<AcpTaskConnection> {
		const existing = this.connectionsByTaskId.get(input.taskId);
		if (existing) {
			return existing;
		}

		const launchDefinition = requireAcpAgentLaunchDefinition(input.agentId);
		const spawnCommand = launchDefinition.buildSpawnCommand({ permissionMode: input.permissionMode });
		if (!isBinaryAvailableOnPath(spawnCommand.binary)) {
			throw new Error(
				`"${spawnCommand.binary}" was not found on PATH, so the ${input.agentId} ACP session cannot start. ` +
					`Install it and restart Kanban so the new PATH entry is inherited.`,
			);
		}

		const child = spawn(spawnCommand.binary, spawnCommand.args, {
			cwd: input.cwd,
			env: { ...process.env, ...input.env, ...spawnCommand.env },
			stdio: ["pipe", "pipe", "pipe"],
			// 独立进程组（POSIX）：agent 自己还会派生子进程（工具执行、语言服务器…），只对直接 child
			// 发信号会把这些后代留成孤儿。有了独立 pgid 就能像 PTY 侧一样 `process.kill(-pid, …)` 覆盖整棵树。
			// 之所以安全：stdio 是 pipe 而非 inherit，故脱离进程组不改变本进程的终端信号语义；Kanban 退出时
			// 由 disposeAllTaskConnections 显式拆连接，不依赖信号沿进程组传播。Windows 上 detached 语义不同
			// （新建控制台），且该平台的树杀由 tree-kill 负责，故不开。
			detached: process.platform !== "win32",
		}) as ChildProcessByStdio<Writable, Readable, Readable>;

		// stdout 是 JSON-RPC 通道，诊断信息只可能出现在 stderr；留一段环形缓冲，
		// 好在握手失败时把 agent 自己的报错原文带回给用户，而不是只报一句 "connection closed"。
		let stderrDiagnostics = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderrDiagnostics = (stderrDiagnostics + chunk).slice(-AGENT_STDERR_DIAGNOSTIC_BUFFER_CHARACTER_LIMIT);
		});

		const connection = connectKanbanAcpClient(createAcpNdJsonStreamOverChildProcessStdio(child), {
			handleSessionUpdate: (notification) => {
				const taskId = this.taskIdBySessionId.get(notification.sessionId);
				if (!taskId) {
					// session/new 的响应还没回来就先到的通知（omp 对此有 50ms 的 bootstrap 竞态保护），
					// 或者会话已经关闭。丢弃比崩掉整条连接好。
					return;
				}
				this.handlers.onSessionUpdate(taskId, notification);
			},
			handlePermissionRequest: async (request) => {
				const taskId = this.taskIdBySessionId.get(request.sessionId);
				if (!taskId) {
					return { outcome: { outcome: "cancelled" } };
				}
				return await this.handlers.onPermissionRequest(taskId, request);
			},
			handleElicitationRequest: async (request) => {
				const taskId = this.resolveTaskIdForElicitation(request, input.taskId);
				if (!taskId) {
					return { action: "cancel" };
				}
				return await this.handlers.onElicitationRequest(taskId, request);
			},
		});

		try {
			const initializeResponse = await connection.agent.request(ACP_AGENT_METHODS.initialize, {
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: buildKanbanAcpClientCapabilities(),
			});
			const newSessionResponse = await this.openAgentSession(connection, {
				cwd: input.cwd,
				initializeResponse,
				agentId: input.agentId,
				resumePriorAgentConversationWithoutResendingPrompt: Boolean(
					input.resumePriorAgentConversationWithoutResendingPrompt,
				),
				taskId: input.taskId,
			});

			const record: AcpTaskConnectionRecord = {
				taskId: input.taskId,
				agentId: input.agentId,
				sessionId: newSessionResponse.sessionId,
				pid: typeof child.pid === "number" ? child.pid : null,
				initializeResponse,
				child,
				connection,
				prompt: async (promptBlocks) =>
					await connection.agent.request(ACP_AGENT_METHODS.session_prompt, {
						sessionId: newSessionResponse.sessionId,
						prompt: promptBlocks,
					}),
				cancel: async () => {
					await connection.agent.notify(ACP_AGENT_METHODS.session_cancel, {
						sessionId: newSessionResponse.sessionId,
					});
				},
				setSessionMode: async (sessionModeId) => {
					await connection.agent.request(ACP_AGENT_METHODS.session_set_mode, {
						sessionId: newSessionResponse.sessionId,
						modeId: sessionModeId,
					});
				},
				close: () => {
					this.disposeTaskConnection(input.taskId);
				},
				disposedByKanban: false,
			};

			if (input.startInPlanMode && launchDefinition.planModeSessionModeId) {
				// plan 起步与权限档正交：这里只切开局的 session mode，权限档已经由启动旗标独立表达。
				// 切换失败一律让启动失败，绝不静默降级：用户勾了「先只读规划」却按默认 act 模式收到首个
				// prompt 的话，agent 立刻就能改文件——那是权限语义被悄悄放宽，不是可以退化的装饰。
				// 放在登记连接与注册退出回调之前，是为了让失败直接落进下面的 catch：连接被拆干净、
				// 账本里不会留下半启动的记录，调用方也就不可能拿到连接去投递 prompt。
				try {
					await record.setSessionMode(launchDefinition.planModeSessionModeId);
				} catch (planModeError) {
					const planModeFailureReason =
						planModeError instanceof Error ? planModeError.message : String(planModeError);
					throw new Error(
						`the agent refused to start in plan mode (session mode "${launchDefinition.planModeSessionModeId}"): ${planModeFailureReason}`,
					);
				}
			}

			this.connectionsByTaskId.set(input.taskId, record);
			this.taskIdBySessionId.set(newSessionResponse.sessionId, input.taskId);

			child.on("exit", (exitCode, terminationSignal) => {
				this.forgetTaskConnection(record);
				this.handlers.onConnectionClosed(input.taskId, {
					exitCode,
					terminationSignal,
					closeIntent: record.disposedByKanban ? "disposed_by_kanban" : "exited_on_its_own",
					stderrDiagnostics,
				});
			});

			return record;
		} catch (error) {
			connection.close();
			child.kill("SIGTERM");
			throw enrichAcpStartupError(error, spawnCommand.binary, stderrDiagnostics);
		}
	}

	private async openAgentSession(
		connection: AcpClientConnection,
		input: {
			cwd: string;
			initializeResponse: AcpInitializeResponse;
			agentId: RuntimeAgentId;
			taskId: string;
			resumePriorAgentConversationWithoutResendingPrompt: boolean;
		},
	) {
		try {
			if (input.resumePriorAgentConversationWithoutResendingPrompt) {
				return await this.loadMostRecentAgentSessionForWorkingDirectory(connection, input);
			}
			return await connection.agent.request(ACP_AGENT_METHODS.session_new, {
				cwd: input.cwd,
				mcpServers: [],
			});
		} catch (error) {
			if (!isAcpAuthenticationRequiredError(error)) {
				throw error;
			}
			// agent 要求先认证。挑第一个它声明的方法走一遍——对 omp 而言 "agent" 方法是个 no-op，
			// 只是确认「用它已配置好的本地凭据」；真的没有凭据时 session/new 会再次失败，
			// 那时把原始错误原样抛出，好让用户看到是要去终端里登录。
			const authMethodId = input.initializeResponse.authMethods?.[0]?.id;
			if (!authMethodId) {
				throw error;
			}
			await connection.agent.request(ACP_AGENT_METHODS.authenticate, { methodId: authMethodId });
			if (input.resumePriorAgentConversationWithoutResendingPrompt) {
				return await this.loadMostRecentAgentSessionForWorkingDirectory(connection, input);
			}
			return await connection.agent.request(ACP_AGENT_METHODS.session_new, {
				cwd: input.cwd,
				mcpServers: [],
			});
		}
	}

	// 接上该 worktree 下最近的一条 agent 会话。
	//
	// 为什么「最近一条」就够精确：Kanban 每个 task 一个 worktree，而 omp 的会话库按 cwd 建，
	// 于是 `cwd == 该任务的 worktree` 这一条件本身就把候选集收敛到了这个任务的对话。
	// 它与 TUI 侧 `--continue` 的语义完全一致（omp 的 terminal breadcrumb 在新 PTY 上必然失配，
	// 从而回落到同一个「该 cwd 下最近的 session」规则），所以两条通道来回切换接的是同一段对话。
	//
	// session/load 会把整段历史当成普通 SessionUpdate 重播回来（omp 的 #replaySessionHistory）。
	// 重播期间必须挂上重播守卫，否则会把卡片刷成 running、把「agent 上次响应」刷成刚刚——
	// 守卫在 handleSessionUpdate 一侧按 taskId 判定，见 replayingHistoryTaskIds。
	private async loadMostRecentAgentSessionForWorkingDirectory(
		connection: AcpClientConnection,
		input: { cwd: string; taskId: string },
	) {
		const listResponse = await connection.agent.request(ACP_AGENT_METHODS.session_list, { cwd: input.cwd });
		const sessions = Array.isArray(listResponse?.sessions) ? listResponse.sessions : [];
		const mostRecentSession = sessions.reduce<(typeof sessions)[number] | null>((mostRecent, candidate) => {
			if (!mostRecent) {
				return candidate;
			}
			return readAgentSessionUpdatedAtMs(candidate) >= readAgentSessionUpdatedAtMs(mostRecent)
				? candidate
				: mostRecent;
		}, null);
		if (!mostRecentSession) {
			throw new Error(
				"The agent reported no previous conversation in this task worktree, so there is nothing to continue. " +
					"Start a fresh session instead.",
			);
		}
		// sessionId → taskId 必须**在** session/load 之前登记：重播的 update 在该请求 await 期间就已到达，
		// 而 handleSessionUpdate 靠这张表反查 taskId，晚登记会让整段历史被静默丢弃（走 taskId 未知的丢弃分支）。
		// 正常路径上这一行稍后会被 startTaskConnection 用同样的键值再写一次，是幂等的。
		this.taskIdBySessionId.set(mostRecentSession.sessionId, input.taskId);
		this.replayingHistoryTaskIds.add(input.taskId);
		try {
			await connection.agent.request(ACP_AGENT_METHODS.session_load, {
				sessionId: mostRecentSession.sessionId,
				cwd: input.cwd,
				mcpServers: [],
			});
		} catch (error) {
			// 加载失败 ⇒ 这条连接不会被登记，提前写进去的反查项必须撤掉，否则会一直挂着一条
			// 指向不存在连接的映射，把后续同 sessionId 的通知错投给这个 task。
			this.taskIdBySessionId.delete(mostRecentSession.sessionId);
			throw error;
		} finally {
			this.replayingHistoryTaskIds.delete(input.taskId);
		}
		return { sessionId: mostRecentSession.sessionId };
	}

	// elicitation 的作用域可能是 session 级也可能是 request 级；session 级带 sessionId，
	// request 级（连接刚建立、还没有会话时）落回发起本次启动的任务。
	private resolveTaskIdForElicitation(
		request: AcpCreateElicitationRequest,
		fallbackTaskId: string,
	): string | undefined {
		const sessionId = (request as { sessionId?: unknown }).sessionId;
		if (typeof sessionId === "string") {
			return this.taskIdBySessionId.get(sessionId) ?? fallbackTaskId;
		}
		return fallbackTaskId;
	}

	// 只在账本仍指向同一条连接时才摘除：任务被 stop 之后立刻重启的话，旧子进程迟到的 exit 事件
	// 不能把已经登记好的新连接从账本里抹掉。
	private forgetTaskConnection(record: AcpTaskConnectionRecord): void {
		if (this.connectionsByTaskId.get(record.taskId) !== record) {
			return;
		}
		this.connectionsByTaskId.delete(record.taskId);
		this.taskIdBySessionId.delete(record.sessionId);
	}

	disposeTaskConnection(taskId: string): void {
		const record = this.connectionsByTaskId.get(taskId);
		if (!record) {
			return;
		}
		// 先落意图再拆连接：exit 事件是下一轮事件循环才到的，标记晚了就会被当成「agent 自己没的」。
		record.disposedByKanban = true;
		this.forgetTaskConnection(record);
		record.connection.close();
		terminateAcpChildProcessTree(record.child, { force: false });
	}

	// 回收专用的「拆连接并确认真的退出了」路径。与 disposeTaskConnection 的差别只在于**等待与升级**：
	//   SIGTERM（整个进程组）→ 轮询到 gracefulTimeoutMs → SIGKILL（整个进程组）→ 再轮询一小段。
	// 返回根进程是否已确认退出，供回收审计结果如实填写（而不是发完信号就宣称成功）。
	async stopTaskConnectionAndConfirmExit(
		taskId: string,
		options: { gracefulTimeoutMs?: number; forcefulTimeoutMs?: number } = {},
	): Promise<{ rootPid: number | null; rootProcessExitConfirmed: boolean; usedForcefulEscalation: boolean }> {
		const record = this.connectionsByTaskId.get(taskId);
		if (!record) {
			return { rootPid: null, rootProcessExitConfirmed: true, usedForcefulEscalation: false };
		}
		const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
		const forcefulTimeoutMs = options.forcefulTimeoutMs ?? 500;
		const child = record.child;
		const rootPid = typeof child.pid === "number" ? child.pid : null;

		record.disposedByKanban = true;
		this.forgetTaskConnection(record);
		record.connection.close();
		terminateAcpChildProcessTree(child, { force: false });

		const hasExited = () => child.exitCode !== null || child.signalCode !== null;
		await waitUntil(hasExited, gracefulTimeoutMs);
		if (hasExited()) {
			return { rootPid, rootProcessExitConfirmed: true, usedForcefulEscalation: false };
		}
		terminateAcpChildProcessTree(child, { force: true });
		await waitUntil(hasExited, forcefulTimeoutMs);
		return { rootPid, rootProcessExitConfirmed: hasExited(), usedForcefulEscalation: true };
	}

	disposeAllTaskConnections(): void {
		for (const taskId of [...this.connectionsByTaskId.keys()]) {
			this.disposeTaskConnection(taskId);
		}
	}
}

// 向 ACP agent 子进程发信号。POSIX 下优先打整个进程组（spawn 时 detached 拿到了独立 pgid），
// 这样 agent 派生出来的工具进程 / 语言服务器不会变成孤儿；进程组调用失败时回落到只打根进程。
// Windows 没有进程组概念，交给 tree-kill 展开整棵树。
function terminateAcpChildProcessTree(
	child: ChildProcessByStdio<Writable, Readable, Readable>,
	options: { force: boolean },
): void {
	const signal: NodeJS.Signals = options.force ? "SIGKILL" : "SIGTERM";
	const pid = typeof child.pid === "number" ? child.pid : 0;
	if (process.platform === "win32") {
		try {
			child.kill(signal);
		} catch {
			// Best effort only.
		}
		if (pid > 0) {
			try {
				treeKill(pid, signal, () => {
					// Best effort only.
				});
			} catch {
				// Best effort only.
			}
		}
		return;
	}
	try {
		child.kill(signal);
	} catch {
		// Best effort only.
	}
	if (pid > 0) {
		try {
			process.kill(-pid, signal);
		} catch {
			// 进程组可能已经整体退出（ESRCH），或从未成功 detach（EPERM）——两种都无需处理。
		}
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, pollIntervalMs = 25): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

function enrichAcpStartupError(error: unknown, binary: string, stderrDiagnostics: string): Error {
	const baseMessage = error instanceof Error ? error.message : String(error);
	const trimmedDiagnostics = stderrDiagnostics.trim();
	if (isAcpAuthenticationRequiredError(error)) {
		return new Error(
			`${binary} requires authentication before it can start an ACP session. ` +
				`Run \`${binary}\` in a terminal once to sign in, then start the task again.` +
				(trimmedDiagnostics ? `\n\n${trimmedDiagnostics}` : ""),
		);
	}
	return new Error(
		`Failed to start the ${binary} ACP session: ${baseMessage}` +
			(trimmedDiagnostics ? `\n\n${binary} stderr:\n${trimmedDiagnostics}` : ""),
	);
}
