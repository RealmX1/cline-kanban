// 任务级门面：runtime-api 唯一的 ACP 入口。编排「连接运行时 + 会话账本 + SessionUpdate 适配器」
// 三者，对位 src/cline-sdk/cline-task-session-service.ts。
import { randomUUID } from "node:crypto";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionReclamationOutcome,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import {
	AcpClientConnectionRuntime,
	type AcpConnectionClosedDetail,
	type AcpTaskConnection,
} from "./acp-client-connection-runtime";
import { AcpPendingUserDecisionBroker, type AcpUserDecisionResolution } from "./acp-pending-user-decision-broker";
import type {
	AcpContentBlock,
	AcpCreateElicitationRequest,
	AcpCreateElicitationResponse,
	AcpRequestPermissionRequest,
	AcpRequestPermissionResponse,
} from "./acp-protocol-boundary";
import {
	type AcpTaskMessage,
	type AcpTaskSessionEntry,
	appendAcpMessage,
	cloneAcpSummary,
	createAcpMessage,
	deriveAcpFacetPatch,
	now,
	replaceAcpMessage,
	updateAcpSummary,
	withCurrentSubstantiveOutputTimestamp,
} from "./acp-session-state";
import {
	type AcpSessionUpdateContext,
	applyAcpConnectionClosed,
	applyAcpPromptTurnCompletion,
	applyAcpSessionUpdate,
} from "./acp-session-update-adapter";
import { AcpTaskSessionRegistry } from "./acp-task-session-registry";

export interface StartAcpTaskSessionRequest {
	taskId: string;
	agentId: RuntimeAgentId;
	cwd: string;
	prompt: string;
	taskTitle?: string;
	images?: RuntimeTaskImage[];
	permissionMode: RuntimeTaskAgentPermissionMode;
	startInPlanMode?: boolean;
}

// 等待用户决策的双向通道由外部注入（见 S5 的 broker）。默认实现保守拒绝，
// 这样即便接线漏了也不会变成「静默自动批准」。
export interface AcpUserDecisionBroker {
	requestToolPermission(taskId: string, request: AcpRequestPermissionRequest): Promise<AcpRequestPermissionResponse>;
	requestElicitation(taskId: string, request: AcpCreateElicitationRequest): Promise<AcpCreateElicitationResponse>;
	cancelPendingDecisions(taskId: string): void;
}

const DENY_ALL_USER_DECISION_BROKER: AcpUserDecisionBroker = {
	async requestToolPermission() {
		return { outcome: { outcome: "cancelled" } };
	},
	async requestElicitation() {
		return { action: "cancel" };
	},
	cancelPendingDecisions() {
		// no-op
	},
};

export class AcpTaskSessionService {
	private readonly registry = new AcpTaskSessionRegistry();
	private readonly connectionRuntime: AcpClientConnectionRuntime;
	// 决策以聊天消息承载：presentDecision 落一条带 meta.userDecision 的消息，
	// settleDecision 回写同一条，使前端把按钮换成「已选 X」。
	private readonly pendingUserDecisionBroker = new AcpPendingUserDecisionBroker({
		presentDecision: ({ taskId, decision, promptMarkdown }) => {
			const entry = this.registry.getEntry(taskId);
			if (!entry) {
				return;
			}
			const message = appendAcpMessage(
				entry,
				createAcpMessage(taskId, "status", promptMarkdown, {
					messageKind: decision.kind === "tool_permission" ? "acp_permission_request" : "acp_elicitation_request",
					source: "acp",
					userDecision: decision,
				}),
			);
			this.decisionMessageIdByDecisionId.set(decision.decisionId, message.id);
			this.emitMessage(taskId, message);
			// agent 停下来等人了：把卡片翻成「等你处理」，人轴按决策类型区分
			// （plan 审批 → plan_review，工具授权 → permission）。
			this.emitSummary(
				updateAcpSummary(
					entry,
					withCurrentSubstantiveOutputTimestamp(entry, {
						...deriveAcpFacetPatch(
							"awaiting_review",
							"hook",
							{ pid: entry.summary.pid, agentId: entry.summary.agentId ?? "omp" },
							decision.kind === "elicitation_form" ? "plan_review" : "permission",
						),
						reviewReason: "hook",
					}),
				),
			);
		},
		settleDecision: (taskId, decisionId, resolution) => {
			const entry = this.registry.getEntry(taskId);
			const messageId = this.decisionMessageIdByDecisionId.get(decisionId);
			this.decisionMessageIdByDecisionId.delete(decisionId);
			if (!entry || !messageId) {
				return;
			}
			const updated = replaceAcpMessage(entry, messageId, (message) => ({
				...message,
				meta: {
					...(message.meta ?? {}),
					userDecision: message.meta?.userDecision
						? {
								...message.meta.userDecision,
								resolvedOutcome: resolution.outcome,
								resolvedOptionId: resolution.optionId,
							}
						: null,
				},
			}));
			if (updated) {
				this.emitMessage(taskId, updated);
			}
		},
	});
	private readonly decisionMessageIdByDecisionId = new Map<string, string>();
	// 最近一次启动该任务 ACP 会话时用的完整参数。会话被回收后要重新拉起连接，必须复用同一套
	// （cwd / 权限档 / plan 起步），否则等于拿默认档悄悄换了一个语义不同的会话跑下去。
	// 与终端侧的 entry.restartRequest 对位：纯内存，Kanban 进程重启后不复存在（届时如实报「起不来」）。
	private readonly latestStartRequestByTaskId = new Map<string, StartAcpTaskSessionRequest>();
	private userDecisionBroker: AcpUserDecisionBroker = DENY_ALL_USER_DECISION_BROKER;

	constructor() {
		this.userDecisionBroker = this.pendingUserDecisionBroker;
		this.connectionRuntime = new AcpClientConnectionRuntime({
			onSessionUpdate: (taskId, notification) => {
				const context = this.buildUpdateContext(taskId);
				if (!context) {
					return;
				}
				applyAcpSessionUpdate(context, notification);
			},
			onPermissionRequest: async (taskId, request) =>
				await this.userDecisionBroker.requestToolPermission(taskId, request),
			onElicitationRequest: async (taskId, request) =>
				await this.userDecisionBroker.requestElicitation(taskId, request),
			onConnectionClosed: (taskId, detail) => {
				this.userDecisionBroker.cancelPendingDecisions(taskId);
				if (detail.closeIntent === "disposed_by_kanban") {
					// stop / clear / 关服拆掉的连接：终态（interrupted，或 clear 后的全新空会话）已由
					// 发起方写定。这里再写一次会把 Stop 改写成「回合正常收束」，或把消息与 summary
					// 复活到刚重建的空会话上。
					return;
				}
				const context = this.buildUpdateContext(taskId);
				if (!context) {
					return;
				}
				this.registry.emitSummary(
					applyAcpConnectionClosed(context, {
						exitCode: detail.exitCode,
						errorMessage: buildAgentTerminationDiagnostic(detail),
					}),
				);
			},
		});
	}

	// 测试可以换掉决策通道；生产路径用内建的 pendingUserDecisionBroker。
	setUserDecisionBroker(broker: AcpUserDecisionBroker): void {
		this.userDecisionBroker = broker;
	}

	// 用户在会话面板上点了某个决策按钮。返回 false 表示该决策已不在等待中（重复点击或已取消）。
	resolveUserDecision(taskId: string, decisionId: string, resolution: AcpUserDecisionResolution): boolean {
		const resolved = this.pendingUserDecisionBroker.resolvePendingDecision(taskId, decisionId, resolution);
		if (!resolved) {
			return false;
		}
		const entry = this.registry.getEntry(taskId);
		const connection = this.connectionRuntime.getConnection(taskId);
		if (entry && connection) {
			// 决策已回给 agent，回合重新归 agent。
			this.emitSummary(
				updateAcpSummary(
					entry,
					withCurrentSubstantiveOutputTimestamp(entry, {
						...deriveAcpFacetPatch("running", null, { pid: connection.pid, agentId: connection.agentId }),
						reviewReason: null,
					}),
				),
			);
		}
		return true;
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		return this.registry.getSummary(taskId);
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return this.registry.listSummaries();
	}

	listMessages(taskId: string): AcpTaskMessage[] {
		return this.registry.listMessages(taskId);
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		return this.registry.onSummary(listener);
	}

	onMessage(listener: (taskId: string, message: AcpTaskMessage) => void): () => void {
		return this.registry.onMessage(listener);
	}

	async startTaskSession(request: StartAcpTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.registry.ensureEntry(request.taskId, request.agentId);
		this.latestStartRequestByTaskId.set(request.taskId, { ...request });
		const startedAt = now();

		// 乐观 UI：先落 user 消息并把卡片推成 running，再去起进程——与 Cline 侧一致，
		// 免得进程冷启动那几秒里卡片看起来毫无反应。
		const promptText = request.prompt.trim();
		if (promptText || (request.images?.length ?? 0) > 0) {
			this.emitMessage(
				request.taskId,
				appendAcpMessage(
					entry,
					createAcpMessage(request.taskId, "user", request.prompt, { source: "acp" }, request.images),
				),
			);
		}
		this.emitSummary(
			updateAcpSummary(entry, {
				...deriveAcpFacetPatch("running", null, { pid: null, agentId: request.agentId }),
				agentId: request.agentId,
				workspacePath: request.cwd,
				reviewReason: null,
				startedAt,
				exitCode: null,
				warningMessage: null,
			}),
		);

		try {
			const connection = await this.connectionRuntime.startTaskConnection({
				taskId: request.taskId,
				agentId: request.agentId,
				cwd: request.cwd,
				permissionMode: request.permissionMode,
				startInPlanMode: request.startInPlanMode,
			});
			this.emitSummary(
				updateAcpSummary(
					entry,
					withCurrentSubstantiveOutputTimestamp(entry, {
						...deriveAcpFacetPatch("running", null, { pid: connection.pid, agentId: request.agentId }),
						pid: connection.pid,
						// 新活体：ACP 侧的活体就是这个刚 spawn 出来的子进程 + 握手完成的连接。回收调度器据此
						// 判断「已落盘的期限说的还是不是同一个活体」，重连出来的新会话不会被陈旧期限误杀。
						runtimeSessionIncarnationId: randomUUID(),
					}),
				),
			);
			if (promptText || (request.images?.length ?? 0) > 0) {
				void this.runPromptTurn(request.taskId, connection, buildAcpPromptBlocks(request.prompt, request.images));
			}
		} catch (error) {
			this.emitSummary(this.recordTaskFailure(request.taskId, request.agentId, error));
		}

		return cloneAcpSummary(entry.summary);
	}

	async sendTaskSessionInput(
		taskId: string,
		text: string,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.registry.getEntry(taskId);
		const connection = this.connectionRuntime.getConnection(taskId);
		if (!entry || !connection) {
			return null;
		}
		this.emitMessage(
			taskId,
			appendAcpMessage(entry, createAcpMessage(taskId, "user", text, { source: "acp" }, images)),
		);
		const summary = updateAcpSummary(entry, {
			...deriveAcpFacetPatch("running", null, { pid: connection.pid, agentId: connection.agentId }),
			reviewReason: null,
		});
		this.emitSummary(summary);
		void this.runPromptTurn(taskId, connection, buildAcpPromptBlocks(text, images));
		return summary;
	}

	// 会话被回收之后，registry 里的 entry / summary 仍在（回收只拆连接与子进程、不删账本），
	// 但 connectionRuntime 里那条连接已经没了——此时 sendTaskSessionInput 只会返回 null。
	// 「agent 提问 → 会话被回收 → 用户回来作答」这条 carry-forward 闭环要成立，必须先真的重建连接。
	// ACP 侧没有 session/load 续跑（见 acp-task-session-registry 注释），故这里就是计划 §7.4 说的
	// 「ACP：新连接」——agent 不必重新发问，因为答案正文本身就带着原问题。
	// prompt / images 清空：只重建连接，答案随后由调用方经 sendTaskSessionInput 投递。
	// 没有账本条目、或没有可复用的启动参数时如实返回 false，绝不假装就绪。
	async resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery(taskId: string): Promise<boolean> {
		if (!this.registry.getEntry(taskId)) {
			return false;
		}
		if (this.connectionRuntime.getConnection(taskId)) {
			return true;
		}
		const latestStartRequest = this.latestStartRequestByTaskId.get(taskId);
		if (!latestStartRequest) {
			return false;
		}
		await this.startTaskSession({ ...latestStartRequest, prompt: "", images: undefined });
		return this.connectionRuntime.getConnection(taskId) !== null;
	}

	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.registry.getEntry(taskId);
		const connection = this.connectionRuntime.getConnection(taskId);
		if (!entry || !connection) {
			return null;
		}
		// 铁律（ACP 规范）：发出 session/cancel 后必须把所有 pending 的 requestPermission
		// 用 cancelled outcome 回掉，否则 agent 侧会一直挂着等回复。
		this.userDecisionBroker.cancelPendingDecisions(taskId);
		await connection.cancel().catch(() => null);
		const summary = updateAcpSummary(
			entry,
			withCurrentSubstantiveOutputTimestamp(entry, {
				...deriveAcpFacetPatch("idle", null, { pid: connection.pid, agentId: connection.agentId }),
				reviewReason: null,
			}),
		);
		this.emitSummary(summary);
		return summary;
	}

	async abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.registry.getEntry(taskId);
		const connection = this.connectionRuntime.getConnection(taskId);
		if (!entry || !connection) {
			return null;
		}
		this.userDecisionBroker.cancelPendingDecisions(taskId);
		await connection.cancel().catch(() => null);
		const summary = updateAcpSummary(
			entry,
			withCurrentSubstantiveOutputTimestamp(entry, {
				...deriveAcpFacetPatch("interrupted", null, { pid: connection.pid, agentId: connection.agentId }),
				reviewReason: null,
			}),
		);
		this.emitSummary(summary);
		return summary;
	}

	async stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.registry.getEntry(taskId);
		if (!entry) {
			return null;
		}
		this.userDecisionBroker.cancelPendingDecisions(taskId);
		this.connectionRuntime.disposeTaskConnection(taskId);
		const summary = updateAcpSummary(
			entry,
			withCurrentSubstantiveOutputTimestamp(entry, {
				...deriveAcpFacetPatch("interrupted", null, { pid: null, agentId: entry.summary.agentId ?? "omp" }),
				pid: null,
				reviewReason: null,
			}),
		);
		this.emitSummary(summary);
		return summary;
	}

	// 会话回收专用的停止路径。与 stopTaskSession 的差别有三处，缺一不可：
	//   ① 先发 session/cancel 让 agent 有机会自己收束（stopTaskSession 直接拆连接）；
	//   ② 等待子进程真的退出并在超时后升级到 SIGKILL（整个进程组），而不是发完 SIGTERM 就返回；
	//   ③ 返回退出确认，供回收审计结果如实填写。
	// 「发出 cancel 后必须把 pending 的 requestPermission 用 cancelled 回掉」是 ACP 规范的硬要求，
	// 漏掉会让 agent 侧永远挂着等回复——故 cancelPendingDecisions 放在最前面。
	async stopTaskSessionForReclamation(
		taskId: string,
		options: { gracefulTimeoutMs?: number; forcefulTimeoutMs?: number } = {},
	): Promise<{ rootPid: number | null; rootProcessExitConfirmed: boolean; usedForcefulEscalation: boolean }> {
		const entry = this.registry.getEntry(taskId);
		this.userDecisionBroker.cancelPendingDecisions(taskId);
		const connection = this.connectionRuntime.getConnection(taskId);
		if (connection) {
			await connection.cancel().catch(() => null);
		}
		const exitConfirmation = await this.connectionRuntime.stopTaskConnectionAndConfirmExit(taskId, options);
		if (entry) {
			this.emitSummary(
				updateAcpSummary(
					entry,
					withCurrentSubstantiveOutputTimestamp(entry, {
						...deriveAcpFacetPatch("interrupted", null, { pid: null, agentId: entry.summary.agentId ?? "omp" }),
						pid: null,
						reviewReason: null,
					}),
				),
			);
		}
		return exitConfirmation;
	}

	// 把一次会话回收的可审计结果写回 summary sidecar（与终端 / Cline 侧同名同义）。
	applyAgentSessionReclamationOutcome(
		taskId: string,
		outcome: RuntimeAgentSessionReclamationOutcome,
	): RuntimeTaskSessionSummary | null {
		const entry = this.registry.getEntry(taskId);
		if (!entry) {
			return null;
		}
		const summary = updateAcpSummary(
			entry,
			withCurrentSubstantiveOutputTimestamp(entry, { agentSessionRuntimeReclamationOutcome: outcome }),
		);
		this.emitSummary(summary);
		return summary;
	}

	async clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.registry.getEntry(taskId);
		if (!entry) {
			return null;
		}
		const agentId = entry.summary.agentId ?? "omp";
		// 与 stop 同理：清空会话前先把等人拍板的决策回掉，免得 agent 侧挂着等一个永远不会来的答复。
		this.userDecisionBroker.cancelPendingDecisions(taskId);
		this.connectionRuntime.disposeTaskConnection(taskId);
		// 会话被清空 ⇒ 旧启动参数连同旧对话一起作废，绝不能被后续的「恢复投递」拿去复活。
		this.latestStartRequestByTaskId.delete(taskId);
		this.registry.deleteEntry(taskId);
		const freshEntry = this.registry.ensureEntry(taskId, agentId);
		const summary = cloneAcpSummary(freshEntry.summary);
		this.emitSummary(summary);
		return summary;
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.registry.getEntry(taskId);
		if (!entry) {
			return null;
		}
		const summary = updateAcpSummary(
			entry,
			withCurrentSubstantiveOutputTimestamp(entry, {
				previousTurnCheckpoint: entry.summary.latestTurnCheckpoint,
				latestTurnCheckpoint: checkpoint,
			}),
		);
		this.emitSummary(summary);
		return summary;
	}

	disposeAllTaskSessions(): void {
		this.connectionRuntime.disposeAllTaskConnections();
	}

	private async runPromptTurn(
		taskId: string,
		connection: AcpTaskConnection,
		promptBlocks: AcpContentBlock[],
	): Promise<void> {
		try {
			const response = await connection.prompt(promptBlocks);
			// 上下文必须在 await 之后重新取：这段时间里会话可能已被 stop 掉或被 clear 换成新的，
			// 那时旧回合的结果一律丢弃，否则会把 interrupted 改写回 awaiting_review，
			// 或者把结果写到刚重建的空会话上。
			const context = this.buildUpdateContextForStillLiveConnection(taskId, connection);
			if (!context) {
				return;
			}
			this.emitSummary(applyAcpPromptTurnCompletion(context, response.stopReason));
		} catch (error) {
			// 同理：连接是被我们自己拆掉的话，这条 rejection 只是 stop / clear 的副产物，不是任务失败。
			if (!this.buildUpdateContextForStillLiveConnection(taskId, connection)) {
				return;
			}
			this.emitSummary(this.recordTaskFailure(taskId, connection.agentId, error));
		}
	}

	// 仅当账本里那条连接仍是发起本回合的同一条时才给出上下文。
	private buildUpdateContextForStillLiveConnection(
		taskId: string,
		connection: AcpTaskConnection,
	): AcpSessionUpdateContext | null {
		if (this.connectionRuntime.getConnection(taskId) !== connection) {
			return null;
		}
		return this.buildUpdateContext(taskId);
	}

	private recordTaskFailure(taskId: string, agentId: RuntimeAgentId, error: unknown): RuntimeTaskSessionSummary {
		const entry = this.registry.ensureEntry(taskId, agentId);
		const message = error instanceof Error ? error.message : String(error);
		this.emitMessage(
			taskId,
			appendAcpMessage(entry, createAcpMessage(taskId, "system", message, { messageKind: "error", source: "acp" })),
		);
		return updateAcpSummary(entry, {
			...deriveAcpFacetPatch("failed", "error", { pid: null, agentId }),
			pid: null,
			reviewReason: "error",
			warningMessage: message,
		});
	}

	private buildUpdateContext(taskId: string): AcpSessionUpdateContext | null {
		const entry = this.registry.getEntry(taskId);
		if (!entry) {
			return null;
		}
		const connection = this.connectionRuntime.getConnection(taskId);
		return {
			taskId,
			agentId: connection?.agentId ?? entry.summary.agentId ?? "omp",
			pid: connection?.pid ?? entry.summary.pid,
			entry,
			emitSummary: (summary) => {
				this.emitSummary(summary);
			},
			emitMessage: (message) => {
				this.emitMessage(taskId, message);
			},
		};
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		this.registry.emitSummary(summary);
	}

	private emitMessage(taskId: string, message: AcpTaskMessage): void {
		this.registry.emitMessage(taskId, message);
	}
}

export function buildAcpPromptBlocks(text: string, images?: RuntimeTaskImage[]): AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [];
	const trimmed = text.trim();
	if (trimmed) {
		blocks.push({ type: "text", text });
	}
	for (const image of images ?? []) {
		blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	if (blocks.length === 0) {
		blocks.push({ type: "text", text: "" });
	}
	return blocks;
}

// 只有「退出码 0 且没被信号杀掉」才算正常收场。被信号杀死时退出码是 null，
// 若只看退出码就会把「进程被外部干掉」读成「agent 正常干完了」。
function buildAgentTerminationDiagnostic(detail: AcpConnectionClosedDetail): string | null {
	const trimmedStderrDiagnostics = detail.stderrDiagnostics.trim();
	if (detail.terminationSignal !== null) {
		return appendStderrDiagnostics(
			`The agent process was terminated by signal ${detail.terminationSignal}.`,
			trimmedStderrDiagnostics,
		);
	}
	if (detail.exitCode === 0) {
		return null;
	}
	if (detail.exitCode === null) {
		return appendStderrDiagnostics("The agent process exited unexpectedly.", trimmedStderrDiagnostics);
	}
	return appendStderrDiagnostics(`The agent process exited with code ${detail.exitCode}.`, trimmedStderrDiagnostics);
}

function appendStderrDiagnostics(baseMessage: string, trimmedStderrDiagnostics: string): string {
	return trimmedStderrDiagnostics ? `${baseMessage}\n\n${trimmedStderrDiagnostics}` : baseMessage;
}

export function createAcpTaskSessionService(): AcpTaskSessionService {
	return new AcpTaskSessionService();
}

export type { AcpTaskSessionEntry };
