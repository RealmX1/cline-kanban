// 任务级门面：runtime-api 唯一的 ACP 入口。编排「连接运行时 + 会话账本 + SessionUpdate 适配器」
// 三者，对位 src/cline-sdk/cline-task-session-service.ts。
import { randomUUID } from "node:crypto";
import {
	describeRefusedAmbiguousExecutionWorkingDirectoryResumeAddressing,
	resolveAgentConversationSessionResumeAddressing,
	type TaskConversationSessionSharingExecutionWorkingDirectory,
} from "../core/agent-conversation-session-resume-addressing";
import type {
	RuntimeAgentCurrentWorkPhaseGoal,
	RuntimeAgentId,
	RuntimeAgentNativeConversationSessionIdentity,
	RuntimeAgentSessionReclamationOutcome,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskConversationMode,
	RuntimeTaskConversationSessionMetadata,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import {
	renderTaskCollaborationSessionResponsibilityGuidance,
	resolveHomeAgentAppendSystemPrompt,
	resolveTaskSessionAppendSystemPrompt,
} from "../prompts/append-system-prompt";
import { buildKanbanTaskAgentSessionWorkUnitIdentityEnvironment } from "../terminal/kanban-task-agent-session-work-unit-identity-environment";
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
	clearAcpStreamingGrouping,
	cloneAcpSummary,
	createAcpMessage,
	deriveAcpFacetPatch,
	finishAcpStreamedReasoningMessages,
	now,
	replaceAcpMessage,
	updateAcpSummary,
} from "./acp-session-state";
import {
	type AcpSessionUpdateContext,
	applyAcpConnectionClosed,
	applyAcpPromptTurnCompletion,
	applyAcpSessionUpdate,
} from "./acp-session-update-adapter";
import {
	ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
	type AcpTaskSessionParkAwaitingDispatchedBackgroundWorkResult,
	describeAcpTaskSessionAwaitingDispatchedBackgroundWork,
	parkAcpTaskSessionEntryAwaitingDispatchedBackgroundWork,
	unparkAcpTaskSessionEntry,
} from "./acp-task-session-park-awaiting-dispatched-background-work";
import { AcpTaskSessionRegistry } from "./acp-task-session-registry";

export interface StartAcpTaskSessionRequest {
	taskId: string;
	workspaceTaskId?: string;
	taskConversationSessionMetadata?: RuntimeTaskConversationSessionMetadata;
	agentId: RuntimeAgentId;
	cwd: string;
	prompt: string;
	taskTitle?: string;
	images?: RuntimeTaskImage[];
	permissionMode: RuntimeTaskAgentPermissionMode;
	startInPlanMode?: boolean;
	// 卡片声明的会话模式快照（蓝图 §A.1）：每次建会话时盖章进 summary.taskConversationMode；
	// 缺省不写字段 = operational。ACP 通道没有 system prompt 机制，exploratory 指令注入不经这里。
	taskConversationMode?: RuntimeTaskConversationMode;
	// 「续跑既有对话、不重投 prompt」。通道切换后重开会话走它：用户已在对话中途，重投一次原始
	// prompt 等于凭空多一轮。置位时 prompt / images 一律被忽略（不落乐观 user 消息、不发 session/prompt），
	// 会话内容改由 session/load 的历史重播补齐。
	// **同时不重放 startInPlanMode**：omp 的 loadSession 会返回该会话当前的 modes，
	// 重新按 plan 起步会把用户在对话中途已经切走的模式按回去。
	resumePriorAgentConversationWithoutResendingPrompt?: boolean;
	taskConversationSessionMainContextForkSourceNativeSessionId?: string;
	revalidateTaskConversationSessionMainContextForkSource?: () => Promise<void>;
	observedAgentNativeConversationSessionIdentity?: RuntimeAgentNativeConversationSessionIdentity | null;
	taskConversationSessionsSharingExecutionWorkingDirectory?: TaskConversationSessionSharingExecutionWorkingDirectory[];
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
	private userPromptSubmittedListener: ((taskId: string, text: string) => void) | null = null;
	setUserPromptSubmittedListener(listener: (taskId: string, text: string) => void): void {
		this.userPromptSubmittedListener = listener;
	}
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
				updateAcpSummary(entry, {
					...deriveAcpFacetPatch(
						"awaiting_review",
						"hook",
						{ pid: entry.summary.pid, agentId: entry.summary.agentId ?? "omp" },
						decision.kind === "elicitation_form" ? "plan_review" : "permission",
					),
					reviewReason: "hook",
				}),
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

	constructor(
		// 所在 workspace 的身份，用于给 omp 进程注入工作单元身份变量（dd2db 1a）；缺省时不注入（单测）。
		private readonly kanbanWorkspaceIdentityForTaskAgentSessionEnvironment: {
			workspaceId: string;
			workspaceRepositoryPath: string;
		} | null = null,
	) {
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
				updateAcpSummary(entry, {
					...deriveAcpFacetPatch("running", null, { pid: connection.pid, agentId: connection.agentId }),
					reviewReason: null,
				}),
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
		if (this.connectionRuntime.getConnection(request.taskId)) return cloneAcpSummary(entry.summary);
		this.latestStartRequestByTaskId.set(request.taskId, { ...request });
		const startedAt = now();
		const runtimeSessionIncarnationId = randomUUID();
		const shouldResumeWithoutResendingPrompt = Boolean(request.resumePriorAgentConversationWithoutResendingPrompt);
		const isForkingMainContext =
			!shouldResumeWithoutResendingPrompt &&
			Boolean(request.taskConversationSessionMainContextForkSourceNativeSessionId);

		// 乐观 UI：先落 user 消息并把卡片推成 running，再去起进程——与 Cline 侧一致，
		// 免得进程冷启动那几秒里卡片看起来毫无反应。
		// 续跑重开不走这条：没有新的用户输入可落，卡片也不该被推成 running（会话很可能正停在 Review）。
		const promptText = shouldResumeWithoutResendingPrompt ? "" : request.prompt.trim();
		if (
			!isForkingMainContext &&
			(promptText || (!shouldResumeWithoutResendingPrompt && (request.images?.length ?? 0) > 0))
		) {
			this.emitMessage(
				request.taskId,
				appendAcpMessage(
					entry,
					createAcpMessage(request.taskId, "user", request.prompt, { source: "acp" }, request.images),
				),
			);
		}
		// 开局 facet 必须跟着同一个分支走，否则「不落乐观 user 消息」只做了一半：续跑重开在 session/load
		// 期间**没有任何 agent 产出**，把卡片推成 running 等于让它假装进 In Progress，直到重播结束才翻回
		// Review——一次没有任何 agent 产出的假 running。回合从开局起就归用户。
		// 成因取 "hook"（agent 只是把回合交回来了，没有任何东西在等你拍板），与 PTY 侧同一场景的
		// startWithoutPromptReviewReason 同款；换成 "attention" 会派生出 userTurnKind=needs_input，
		// 落进 MODAL_USER_DECISION_TURN_KINDS，让后台程序化投递一直让位到超时。
		// 连接还没起，pid 只能如实写 null（liveness 因此是 exited，而不是撒谎说有个活进程）。
		// 失败路径不受影响：起不来时 catch 里的 recordTaskFailure 会用 failed/error 覆写，绝不会停在这里。
		const sessionStateWhileConnectionIsBeingEstablished = shouldResumeWithoutResendingPrompt
			? "awaiting_review"
			: "running";
		const reviewReasonWhileConnectionIsBeingEstablished = shouldResumeWithoutResendingPrompt ? "hook" : null;
		this.emitSummary(
			updateAcpSummary(entry, {
				...deriveAcpFacetPatch(
					sessionStateWhileConnectionIsBeingEstablished,
					reviewReasonWhileConnectionIsBeingEstablished,
					{ pid: null, agentId: request.agentId },
				),
				// 新活体不继承上一个活体的 park（park 只描述某次回合在等什么）。
				...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
				agentId: request.agentId,
				workspacePath: request.cwd,
				...(request.taskConversationSessionMetadata
					? { taskConversationSessionMetadata: request.taskConversationSessionMetadata }
					: {}),
				reviewReason: reviewReasonWhileConnectionIsBeingEstablished,
				startedAt,
				runtimeSessionIncarnationId,
				exitCode: null,
				warningMessage: null,
				// 会话模式盖章：每次建会话（含续跑重开 / 回收后重建）都从启动请求快照一次；缺省不物化。
				...(request.taskConversationMode !== undefined
					? { taskConversationMode: request.taskConversationMode }
					: {}),
			}),
		);

		try {
			const resumeAddressing = resolveAgentConversationSessionResumeAddressing({
				resumesPriorAgentConversation: shouldResumeWithoutResendingPrompt,
				launchAgentId: request.agentId,
				observedAgentNativeConversationSessionIdentity:
					request.observedAgentNativeConversationSessionIdentity ??
					entry.summary.agentNativeConversationSessionIdentity,
				taskConversationSessionsSharingExecutionWorkingDirectory:
					request.taskConversationSessionsSharingExecutionWorkingDirectory ?? [],
			});
			if (resumeAddressing.kind === "refused_ambiguous_execution_working_directory") {
				throw new Error(
					describeRefusedAmbiguousExecutionWorkingDirectoryResumeAddressing({
						launchAgentId: request.agentId,
						competingTaskConversationSessions: resumeAddressing.competingTaskConversationSessions,
					}),
				);
			}
			const connection = await this.connectionRuntime.startTaskConnection({
				isRuntimeSessionIncarnationCurrent: () =>
					this.registry.getEntry(request.taskId) === entry &&
					entry.summary.runtimeSessionIncarnationId === runtimeSessionIncarnationId,
				taskId: request.taskId,
				agentId: request.agentId,
				cwd: request.cwd,
				permissionMode: request.permissionMode,
				observedAgentNativeSessionId:
					resumeAddressing.kind === "addressed_by_observed_agent_native_session_id"
						? resumeAddressing.taskAgentSessionInitialization.sourceSessionId
						: undefined,
				// 续跑重开一律不重放 plan 起步（理由见 StartAcpTaskSessionRequest 的字段注释）。
				startInPlanMode: shouldResumeWithoutResendingPrompt ? false : request.startInPlanMode,
				resumePriorAgentConversationWithoutResendingPrompt: shouldResumeWithoutResendingPrompt,
				taskConversationSessionMainContextForkSourceNativeSessionId: isForkingMainContext
					? request.taskConversationSessionMainContextForkSourceNativeSessionId
					: undefined,
				revalidateTaskConversationSessionMainContextForkSource: isForkingMainContext
					? request.revalidateTaskConversationSessionMainContextForkSource
					: undefined,
				// 工作单元身份写进每条会话的进程 env，工具 shell 中的 kanban CLI 才能声明宿主与行动者。
				// 宿主任务与会话分别寻址：协作会话共用任务目录，但 hook 与原生身份归各自会话。
				env: this.kanbanWorkspaceIdentityForTaskAgentSessionEnvironment
					? buildKanbanTaskAgentSessionWorkUnitIdentityEnvironment({
							workspaceTaskId: request.workspaceTaskId ?? request.taskId,
							kanbanTaskConversationSessionId: request.taskId,
							workspaceId: this.kanbanWorkspaceIdentityForTaskAgentSessionEnvironment.workspaceId,
							workspaceRepositoryPath:
								this.kanbanWorkspaceIdentityForTaskAgentSessionEnvironment.workspaceRepositoryPath,
						})
					: undefined,
			});
			if (
				this.registry.getEntry(request.taskId) !== entry ||
				entry.summary.runtimeSessionIncarnationId !== runtimeSessionIncarnationId
			) {
				connection.close();
				return this.getSummary(request.taskId) ?? cloneAcpSummary(entry.summary);
			}

			this.emitSummary(
				updateAcpSummary(entry, {
					...deriveAcpFacetPatch("running", null, { pid: connection.pid, agentId: request.agentId }),
					pid: connection.pid,
					// 新活体：ACP 侧的活体就是这个刚 spawn 出来的子进程 + 握手完成的连接。回收调度器据此
					// 判断「已落盘的期限说的还是不是同一个活体」，重连出来的新会话不会被陈旧期限误杀。
					runtimeSessionIncarnationId,
					agentNativeConversationSessionIdentity: {
						sourceAgentId: request.agentId,
						nativeSessionId: connection.sessionId,
						transcriptPath: null,
						observedAt: now(),
					},
				}),
			);
			if (isForkingMainContext) {
				for (const message of finishAcpStreamedReasoningMessages(entry)) this.emitMessage(request.taskId, message);
				clearAcpStreamingGrouping(entry);
				if (promptText || (request.images?.length ?? 0) > 0) {
					this.emitMessage(
						request.taskId,
						appendAcpMessage(
							entry,
							createAcpMessage(request.taskId, "user", request.prompt, { source: "acp" }, request.images),
						),
					);
				}
			}
			if (shouldResumeWithoutResendingPrompt) {
				// session/load 的历史在 startTaskConnection 返回前就已推完，所以这里是这条分支唯一的**回合边界**
				// ——它不发 session/prompt，永远走不到 applyAcpPromptTurnCompletion 那个收尾点。不收尾会留下两笔
				// 烂账：重播回来的 reasoning 永远停在「仍在流」（面板据此保持自动展开一段早就写完的思考），
				// 且分组表里残留的历史 messageId 会把这条会话下一回合的 chunk 追加到历史消息上而不是新建消息。
				// 顺序承重：先 finish（读的正是分组表）再 clear，与 applyAcpPromptTurnCompletion 同构。
				for (const finishedReasoningMessage of finishAcpStreamedReasoningMessages(entry)) {
					this.emitMessage(request.taskId, finishedReasoningMessage);
				}
				clearAcpStreamingGrouping(entry);
				// 续跑重开没有要发的 prompt：回合归用户，卡片停在「等你说话」而不是假装 agent 在跑。
				// 重播出来的历史已由重播守卫挡在时间戳与回合归属之外，这里是唯一给出终态的地方。
				this.emitSummary(
					updateAcpSummary(entry, {
						...deriveAcpFacetPatch("awaiting_review", "hook", { pid: connection.pid, agentId: request.agentId }),
						reviewReason: "hook",
					}),
				);
			} else if (promptText || (request.images?.length ?? 0) > 0) {
				void this.runPromptTurn(
					request.taskId,
					connection,
					buildAcpPromptBlocks(
						`${resolveTaskSessionAppendSystemPrompt(request.workspaceTaskId ?? request.taskId, request.cwd) ?? resolveHomeAgentAppendSystemPrompt(request.taskId) ?? ""}\n\n${request.taskConversationSessionMetadata?.taskConversationSessionRole === "task_collaborator" ? renderTaskCollaborationSessionResponsibilityGuidance(request.workspaceTaskId ?? request.taskId, request.taskId) : ""}\n\n${request.prompt}`,
						request.images,
					),
					request.prompt,
				);
			}
		} catch (error) {
			if (
				this.registry.getEntry(request.taskId) !== entry ||
				entry.summary.runtimeSessionIncarnationId !== runtimeSessionIncarnationId
			)
				return this.getSummary(request.taskId) ?? cloneAcpSummary(entry.summary);
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
			// 新 prompt 到达 = 编排方回来恢复（或用户亲自接手），等同 PTY 的 UserPromptSubmit 清 park。
			...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
			reviewReason: null,
		});
		this.emitSummary(summary);
		void this.runPromptTurn(taskId, connection, buildAcpPromptBlocks(text, images), text);
		return summary;
	}

	// dd2db 2x：与 TerminalSessionManager 同名同义的 park 三件套（见 acp-task-session-park-awaiting-dispatched-background-work.ts）。
	// 编排方须 await park 成功再让 agent 结束这一轮：回合收束读的是此刻内存里的 summary。
	parkTaskSessionAwaitingDispatchedBackgroundWork(
		taskId: string,
		options: { label?: string } = {},
	): AcpTaskSessionParkAwaitingDispatchedBackgroundWorkResult {
		const result = parkAcpTaskSessionEntryAwaitingDispatchedBackgroundWork({
			taskId,
			entry: this.registry.getEntry(taskId),
			hasLiveAcpConnection: this.connectionRuntime.getConnection(taskId) !== null,
			label: options.label,
		});
		if (result.ok) {
			this.emitSummary(result.summary);
		}
		return result;
	}

	unparkTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.registry.getEntry(taskId);
		if (!entry) {
			return null;
		}
		const unparkedSummary = unparkAcpTaskSessionEntry(entry);
		if (unparkedSummary) {
			this.emitSummary(unparkedSummary);
			return unparkedSummary;
		}
		return cloneAcpSummary(entry.summary);
	}

	getAwaitingDispatchedBackgroundWork(
		taskId: string,
	): ReturnType<typeof describeAcpTaskSessionAwaitingDispatchedBackgroundWork> {
		return describeAcpTaskSessionAwaitingDispatchedBackgroundWork(this.registry.getEntry(taskId));
	}

	// 会话被回收之后，registry 里的 entry / summary 仍在（回收只拆连接与子进程、不删账本），
	// 但 connectionRuntime 里那条连接已经没了——此时 sendTaskSessionInput 只会返回 null。
	// 「agent 提问 → 会话被回收 → 用户回来作答」这条 carry-forward 闭环要成立，必须先真的重建连接。
	// 新建连接并按 summary 中的原生身份 session/load；不能为一次答复凭空创建新对话。
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
		await this.startTaskSession({
			...latestStartRequest,
			prompt: "",
			images: undefined,
			resumePriorAgentConversationWithoutResendingPrompt: true,
			observedAgentNativeConversationSessionIdentity:
				this.getSummary(taskId)?.agentNativeConversationSessionIdentity,
		});
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
		const summary = updateAcpSummary(entry, {
			...deriveAcpFacetPatch("idle", null, { pid: connection.pid, agentId: connection.agentId }),
			...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
			reviewReason: null,
		});
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
		const summary = updateAcpSummary(entry, {
			...deriveAcpFacetPatch("interrupted", null, { pid: connection.pid, agentId: connection.agentId }),
			...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
			reviewReason: null,
		});
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
		const summary = updateAcpSummary(entry, {
			...deriveAcpFacetPatch("interrupted", null, { pid: null, agentId: entry.summary.agentId ?? "omp" }),
			...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
			pid: null,
			runtimeSessionIncarnationId: null,
			reviewReason: null,
		});
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
				updateAcpSummary(entry, {
					...deriveAcpFacetPatch("interrupted", null, { pid: null, agentId: entry.summary.agentId ?? "omp" }),
					...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
					pid: null,
					reviewReason: null,
				}),
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
		const summary = updateAcpSummary(entry, { agentSessionRuntimeReclamationOutcome: outcome });
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
		// 重建一条空 entry：`/clear` 只是清空对话，这**仍然是一条 ACP 会话**，下一条消息还得走 ACP。
		// 不重建的话 getSummary 变 null，聊天端点会回落到 Cline，给一个 omp 任务起 Cline 会话。
		//
		// 代价是「账本里有 entry」不等于「这个 task 现在归 ACP 管」——通道切换必须**显式**把条目弃置，
		// 见 discardTaskSessionLedgerEntry。历史上正是漏了那一步，才让一个跑过 ACP 的 task
		// 被永久劫持 getTaskChatMessages / sendTaskChatMessage 两个端点。
		const freshEntry = this.registry.ensureEntry(taskId, agentId);
		const summary = cloneAcpSummary(freshEntry.summary);
		this.emitSummary(summary);
		return summary;
	}

	// 把这条 task 从 ACP 账本里彻底摘掉。**只**该在会话已经不归 ACP 管的时候调用——目前唯一的
	// 调用方是通道切换（omp 从 ACP 切到 TUI）。与 clearTaskSession 的区别是承重的：
	// clear 后这仍是一条 ACP 会话（重建空 entry），而切换之后它已经是一条 PTY 会话了，
	// 账本里再留着条目就会让 chat 端点继续把它当 ACP 任务分派。
	discardTaskSessionLedgerEntry(taskId: string): void {
		this.userDecisionBroker.cancelPendingDecisions(taskId);
		this.connectionRuntime.disposeTaskConnection(taskId);
		this.latestStartRequestByTaskId.delete(taskId);
		this.registry.deleteEntry(taskId);
	}

	applyCurrentWorkPhaseGoal(
		taskId: string,
		goal: RuntimeAgentCurrentWorkPhaseGoal | null,
	): RuntimeTaskSessionSummary | null {
		const entry = this.registry.getEntry(taskId);
		if (!entry) return null;
		if (
			goal &&
			(goal.owningKanbanTaskConversationSessionId !== taskId ||
				(goal.owningRuntimeSessionIncarnationId != null &&
					goal.owningRuntimeSessionIncarnationId !== entry.summary.runtimeSessionIncarnationId) ||
				(goal.owningNativeConversationSessionId !== null &&
					goal.owningNativeConversationSessionId !==
						entry.summary.agentNativeConversationSessionIdentity?.nativeSessionId))
		)
			return null;
		const summary = updateAcpSummary(entry, { agentCurrentWorkPhaseGoal: goal });
		this.emitSummary(summary);
		return summary;
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.registry.getEntry(taskId);
		if (!entry) {
			return null;
		}
		const summary = updateAcpSummary(entry, {
			previousTurnCheckpoint: entry.summary.latestTurnCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
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
		originalSubmittedPromptText: string,
	): Promise<void> {
		try {
			const promptTurn = connection.prompt(promptBlocks);
			this.userPromptSubmittedListener?.(taskId, originalSubmittedPromptText);
			const liveEntry = this.registry.getEntry(taskId);
			if (liveEntry && this.connectionRuntime.getConnection(taskId) === connection) {
				this.emitSummary(updateAcpSummary(liveEntry, { agentCurrentWorkPhaseGoalInvalidatedAt: now() }));
			}
			const response = await promptTurn;
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
			...ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK,
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
			isReplayingPersistedConversationHistory:
				this.connectionRuntime.isReplayingPersistedConversationHistory(taskId),
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

export function createAcpTaskSessionService(
	kanbanWorkspaceIdentityForTaskAgentSessionEnvironment: {
		workspaceId: string;
		workspaceRepositoryPath: string;
	} | null = null,
): AcpTaskSessionService {
	return new AcpTaskSessionService(kanbanWorkspaceIdentityForTaskAgentSessionEnvironment);
}

export type { AcpTaskSessionEntry };
