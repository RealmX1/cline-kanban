// Frontend facade for task-scoped runtime actions.
// It owns how the board and detail view start, stop, resize, and route task
// sessions across native Cline and PTY-backed agents.
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useRef } from "react";

import { notifyError } from "@/components/app-toaster";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { type ClineChatActionResult, useClineChatRuntimeActions } from "@/hooks/use-cline-chat-runtime-actions";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentId,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeTaskWorktreeMode,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "@/runtime/types";
import { trackTaskResumedFromTrash } from "@/telemetry/events";
import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard } from "@/types";

interface UseTaskSessionsInput {
	currentProjectId: string | null;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
}

interface EnsureTaskWorkspaceResult {
	ok: boolean;
	message?: string;
	response?: Extract<RuntimeWorktreeEnsureResponse, { ok: true }>;
}

interface SendTaskSessionInputOptions extends SendTerminalInputOptions {
	requireTerminalPasteSuccess?: boolean;
}

interface SendTaskSessionInputResult {
	ok: boolean;
	message?: string;
}

interface StartTaskSessionResult {
	ok: boolean;
	message?: string;
	taskConversationSessionId?: string;
}

export interface CreateByTheWayTaskConversationSessionInput {
	task: BoardCard;
	agentId: RuntimeAgentId;
	initialUserQuestion: string;
	contextSource: "started_from_scratch" | "forked_from_main_current_turn";
	mainSessionOriginTurnNumber: number;
	mainSessionOriginUserMessagePreview: string | null;
}

interface StartTaskSessionOptions {
	resumeFromTrash?: boolean;
}

function logTaskSessionStartClientFailure(input: {
	workspaceId: string;
	taskId: string;
	elapsedMs: number;
	error: string;
}): void {
	console.error(
		[
			"[task-session-start-client]",
			`workspaceId=${input.workspaceId}`,
			`taskId=${input.taskId}`,
			`elapsedMs=${input.elapsedMs}`,
			`error=${JSON.stringify(input.error)}`,
		].join(" "),
	);
}

export interface UseTaskSessionsResult {
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;
	ensureTaskWorkspace: (task: BoardCard) => Promise<EnsureTaskWorkspaceResult>;
	startTaskSession: (task: BoardCard, options?: StartTaskSessionOptions) => Promise<StartTaskSessionResult>;
	createByTheWayTaskConversationSession: (
		input: CreateByTheWayTaskConversationSessionInput,
	) => Promise<StartTaskSessionResult>;
	stopTaskSession: (taskId: string) => Promise<void>;
	// 手动「移至 Review」：把一个停在 agent 回合的终端 agent 任务翻入「等人审查」回合（不杀进程）。
	// 成功时即时 upsert 返回的 summary（携 turnOwner=user）→ 由 use-board-interactions 的 Rule A 自动落位
	// Review 列、且 review-bounce 不再触发。返回是否成功（供调用方失败时提示）。
	transitionTaskToReview: (taskId: string) => Promise<boolean>;
	// 手动「立即续跑」：对一组正在连接重试的任务各注入一次续跑。返回实际触发的任务 id。
	continueConnectionRetrySessions: (taskIds: string[]) => Promise<string[]>;
	// 手动「移出列表 / 停止重试」：把一组任务从自动续跑重试列表里移出。返回实际移出的任务 id。
	dismissConnectionRetrySessions: (taskIds: string[]) => Promise<string[]>;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTaskSessionInputOptions,
	) => Promise<SendTaskSessionInputResult>;
	sendTaskChatMessage: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode },
	) => Promise<ClineChatActionResult>;
	abortTaskChatTurn: (taskId: string) => Promise<ClineChatActionResult>;
	cancelTaskChatTurn: (taskId: string) => Promise<ClineChatActionResult>;
	resolveTaskAgentUserDecision: (
		taskId: string,
		decisionId: string,
		optionId: string | null,
	) => Promise<ClineChatActionResult>;
	fetchTaskChatMessages: (taskId: string) => Promise<RuntimeTaskChatMessage[] | null>;
	cleanupTaskWorkspace: (
		taskId: string,
		worktreeMode?: RuntimeTaskWorktreeMode,
	) => Promise<RuntimeWorktreeDeleteResponse | null>;
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
}

export function useTaskSessions({ currentProjectId, setSessions }: UseTaskSessionsInput): UseTaskSessionsResult {
	/*
		This merge needs to stay monotonic.

		We chased a nasty terminal bug where Home and Detail panes would appear to
		clear themselves right after starting a task or shell command. The actual
		sequence was:

		1. A new live session started and the terminal correctly saw a new startedAt.
		2. usePersistentTerminalSession reset the xterm instance for the new session.
		3. A stale summary from an older interrupted session was replayed back into
		   React state from workspace hydration or the persistent terminal cache.
		4. That older summary overwrote the newer running one.
		5. The UI then bounced between old and new session identities, causing extra
		   cleanup, remount, and reset cycles that looked like the terminal output
		   had vanished.

		Because of that, every task/session summary write here must prefer the
		newest summary and ignore older ones. If this ever becomes a plain
		last-write-wins assignment again, the "terminal randomly clears out"
		regression is very likely to come back.
	*/
	const upsertSession = useCallback(
		(summary: RuntimeTaskSessionSummary) => {
			setSessions((current) => {
				const previousSummary = current[summary.taskId] ?? null;
				const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
				if (newestSummary !== summary) {
					return current;
				}
				return {
					...current,
					[summary.taskId]: newestSummary,
				};
			});
		},
		[setSessions],
	);
	// 请求发出后切了项目：响应里的 summary 属于上一个项目，不能并进当前项目的 sessions——
	// 否则它会随下一次整板保存写进当前项目的 sessions.json（cf427 的跨项目串写）。
	const latestCurrentProjectIdRef = useRef(currentProjectId);
	latestCurrentProjectIdRef.current = currentProjectId;
	const upsertSessionUnlessProjectSwitchedSinceRequest = useCallback(
		(requestProjectId: string, summary: RuntimeTaskSessionSummary) => {
			if (latestCurrentProjectIdRef.current !== requestProjectId) {
				return;
			}
			upsertSession(summary);
		},
		[upsertSession],
	);
	const {
		sendTaskChatMessage,
		loadTaskChatMessages: fetchTaskChatMessages,
		abortTaskChatTurn,
		cancelTaskChatTurn,
		resolveTaskAgentUserDecision,
	} = useClineChatRuntimeActions({
		currentProjectId,
		onSessionSummary: upsertSession,
	});

	const ensureTaskWorkspace = useCallback(
		async (task: BoardCard): Promise<EnsureTaskWorkspaceResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.ensureWorktree.mutate({
					taskId: task.id,
					baseRef: task.baseRef,
					...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
				});
				if (!payload.ok) {
					return {
						ok: false,
						message: payload.error ?? "Worktree setup failed.",
					};
				}
				return { ok: true, response: payload };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId],
	);

	const startTaskSession = useCallback(
		async (task: BoardCard, options?: StartTaskSessionOptions): Promise<StartTaskSessionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			const startRequestSentAt = Date.now();
			try {
				const kickoffPrompt = options?.resumeFromTrash ? "" : task.prompt.trim();
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				// 估算口径（实测几何优先、否则按持久化面板宽度并以窗口宽度为上界）见该函数注释；经 taskCardAction
				// 起会话的路径共用同一份。
				const geometry = resolveAgentTerminalGeometryForTaskSessionSpawn(task.id);
				const payload = await trpcClient.runtime.startTaskSession.mutate({
					taskId: task.id,
					prompt: kickoffPrompt,
					taskTitle: task.title,
					images: options?.resumeFromTrash ? undefined : task.images,
					startInPlanMode: options?.resumeFromTrash ? undefined : task.startInPlanMode,
					// 权限档位在续跑时同样适用（与 startInPlanMode 不同：那是「开局」语义，续跑没有开局）。
					taskAgentPermissionMode: task.taskAgentPermissionMode,
					// 会话模式是「下次启动生效」的卡片声明（蓝图 §A.1）：本条就是一次启动，
					// 从卡片原值显式回填；漏传 = 服务端静默掉回 operational 缺省。
					taskConversationMode: task.taskConversationMode,
					resumeFromTrash: options?.resumeFromTrash,
					baseRef: task.baseRef,
					cols: geometry.cols,
					rows: geometry.rows,
					agentId: task.agentId,
					clineSettings: task.clineSettings,
					terminalAgentModelOverrideSettings: task.terminalAgentModelOverrideSettings,
					...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
					...(task.taskAgentSessionInitialization
						? { taskAgentSessionInitialization: task.taskAgentSessionInitialization }
						: {}),
					...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
					...(task.prepFilePath ? { prepFilePath: task.prepFilePath } : {}),
				});
				if (!payload.ok || !payload.summary) {
					const message = payload.error ?? "Task session start failed.";
					logTaskSessionStartClientFailure({
						workspaceId: currentProjectId,
						taskId: task.id,
						elapsedMs: Date.now() - startRequestSentAt,
						error: message,
					});
					return {
						ok: false,
						message,
					};
				}
				upsertSessionUnlessProjectSwitchedSinceRequest(currentProjectId, payload.summary);
				if (options?.resumeFromTrash) {
					trackTaskResumedFromTrash();
				}
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logTaskSessionStartClientFailure({
					workspaceId: currentProjectId,
					taskId: task.id,
					elapsedMs: Date.now() - startRequestSentAt,
					error: message,
				});
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSessionUnlessProjectSwitchedSinceRequest],
	);

	const stopTaskSession = useCallback(
		async (taskId: string): Promise<void> => {
			if (!currentProjectId) {
				return;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				await trpcClient.runtime.stopTaskSession.mutate({ taskId });
			} catch {
				// Ignore stop errors during cleanup.
			}
		},
		[currentProjectId],
	);

	const createByTheWayTaskConversationSession = useCallback(
		async (input: CreateByTheWayTaskConversationSessionInput): Promise<StartTaskSessionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			const initialUserQuestion = input.initialUserQuestion.trim();
			if (!initialUserQuestion) {
				return { ok: false, message: "Enter a question for the new session." };
			}
			const taskConversationSessionId = `task-conversation-session-${crypto.randomUUID()}`;
			try {
				const geometry = resolveAgentTerminalGeometryForTaskSessionSpawn(taskConversationSessionId);
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.startTaskSession.mutate({
					taskId: taskConversationSessionId,
					workspaceTaskId: input.task.id,
					prompt: initialUserQuestion,
					taskTitle: `By the way: ${initialUserQuestion.slice(0, 80)}`,
					baseRef: input.task.baseRef,
					cols: geometry.cols,
					rows: geometry.rows,
					agentId: input.agentId,
					clineSettings: input.task.clineSettings,
					terminalAgentModelOverrideSettings: input.task.terminalAgentModelOverrideSettings,
					// By the way 侧会话刻意不传 taskConversationMode：它被 system prompt/adapter 强制
					// 只读（无命令执行），exploratory 注入的「kanban exploratory CLI 写回 map」维护协议
					// 永远履行不了。省略 = 服务端缺省 operational（api-contract startTaskSession 注释）。
					...(input.task.worktreeMode ? { worktreeMode: input.task.worktreeMode } : {}),
					taskConversationSessionMetadata: {
						workspaceTaskId: input.task.id,
						taskConversationSessionRole: "by_the_way",
						taskConversationSessionContextSource: input.contextSource,
						parentTaskConversationSessionId:
							input.contextSource === "forked_from_main_current_turn" ? input.task.id : null,
						mainSessionOriginTurnNumber: input.mainSessionOriginTurnNumber,
						mainSessionOriginUserMessagePreview: input.mainSessionOriginUserMessagePreview,
						latestUserMessagePreview: initialUserQuestion,
					},
				});
				if (!payload.ok || !payload.summary) {
					return { ok: false, message: payload.error ?? "Could not create the By the way session." };
				}
				upsertSessionUnlessProjectSwitchedSinceRequest(currentProjectId, payload.summary);
				return { ok: true, taskConversationSessionId };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : String(error) };
			}
		},
		[currentProjectId, upsertSessionUnlessProjectSwitchedSinceRequest],
	);

	const transitionTaskToReview = useCallback(
		async (taskId: string): Promise<boolean> => {
			if (!currentProjectId) {
				return false;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.transitionTaskToReview.mutate({ taskId });
				if (payload.ok && payload.summary) {
					// 即时 upsert：不等 WS 广播，直接喂新 summary（turnOwner=user）给 Rule A → 立刻落位 Review。
					upsertSessionUnlessProjectSwitchedSinceRequest(currentProjectId, payload.summary);
				}
				return payload.ok;
			} catch {
				return false;
			}
		},
		[currentProjectId, upsertSessionUnlessProjectSwitchedSinceRequest],
	);

	const continueConnectionRetrySessions = useCallback(
		async (taskIds: string[]): Promise<string[]> => {
			if (!currentProjectId || taskIds.length === 0) {
				return [];
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.continueConnectionRetrySessions.mutate({ taskIds });
				return payload.ok ? payload.triggeredTaskIds : [];
			} catch {
				// 续跑是尽力而为：失败不阻断 UI。
				return [];
			}
		},
		[currentProjectId],
	);

	const dismissConnectionRetrySessions = useCallback(
		async (taskIds: string[]): Promise<string[]> => {
			if (!currentProjectId || taskIds.length === 0) {
				return [];
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.dismissConnectionRetrySessions.mutate({ taskIds });
				return payload.ok ? payload.dismissedTaskIds : [];
			} catch {
				// 移出是尽力而为：失败不阻断 UI（后端广播才是 UI 的真相来源）。
				return [];
			}
		},
		[currentProjectId],
	);

	const sendTaskSessionInput = useCallback(
		async (
			taskId: string,
			text: string,
			options?: SendTaskSessionInputOptions,
		): Promise<SendTaskSessionInputResult> => {
			const appendNewline = options?.appendNewline ?? true;
			const controller = options?.preferTerminal === false ? null : getTerminalController(taskId);
			if (options?.mode === "paste") {
				if (!appendNewline && controller?.paste(text)) {
					return { ok: true };
				}
				// 仅填入时，正文换行不能回落为可能提交的原始 PTY 输入。程序化发送仍保留原有回退。
				if (options.requireTerminalPasteSuccess) {
					return { ok: false, message: "Could not paste into the task input. Open its terminal and try again." };
				}
			}
			if (controller) {
				const sent = controller.input(appendNewline ? `${text}\n` : text);
				if (sent) {
					return { ok: true };
				}
			}
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.sendTaskSessionInput.mutate({
					taskId,
					text,
					appendNewline,
				});
				if (!payload.ok) {
					const errorMessage = payload.error || "Task session input failed.";
					return { ok: false, message: errorMessage };
				}
				if (payload.summary) {
					upsertSessionUnlessProjectSwitchedSinceRequest(currentProjectId, payload.summary);
				}
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSessionUnlessProjectSwitchedSinceRequest],
	);

	const cleanupTaskWorkspace = useCallback(
		async (taskId: string, worktreeMode?: RuntimeTaskWorktreeMode): Promise<RuntimeWorktreeDeleteResponse | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.deleteWorktree.mutate({
					taskId,
					...(worktreeMode ? { worktreeMode } : {}),
				});
				if (!payload.ok) {
					const message = payload.error ?? "Could not clean up task workspace.";
					console.error(`[cleanupTaskWorkspace] ${message}`);
					return null;
				}
				return payload;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[cleanupTaskWorkspace] ${message}`);
				return null;
			}
		},
		[currentProjectId],
	);

	const fetchTaskWorkspaceInfo = useCallback(
		async (task: BoardCard): Promise<RuntimeTaskWorkspaceInfoResponse | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				return await trpcClient.workspace.getTaskContext.query({
					taskId: task.id,
					baseRef: task.baseRef,
					...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return null;
			}
		},
		[currentProjectId],
	);

	return {
		upsertSession,
		ensureTaskWorkspace,
		startTaskSession,
		createByTheWayTaskConversationSession,
		stopTaskSession,
		transitionTaskToReview,
		continueConnectionRetrySessions,
		dismissConnectionRetrySessions,
		sendTaskSessionInput,
		sendTaskChatMessage,
		abortTaskChatTurn,
		cancelTaskChatTurn,
		resolveTaskAgentUserDecision,
		fetchTaskChatMessages,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	};
}
