// Frontend facade for task-scoped runtime actions.
// It owns how the board and detail view start, stop, resize, and route task
// sessions across native Cline and PTY-backed agents.
import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError } from "@/components/app-toaster";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { type ClineChatActionResult, useClineChatRuntimeActions } from "@/hooks/use-cline-chat-runtime-actions";
import { loadDetailTerminalPanelWidth } from "@/resize/detail-terminal-panel-width";
import { MIN_DETAIL_DIFF_PANEL_WIDTH_PX } from "@/resize/use-card-detail-layout";
import { clampPanelWidthToWindow, estimateTaskAgentTerminalGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskChatMessage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeTaskWorktreeMode,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "@/runtime/types";
import { trackTaskResumedFromTrash } from "@/telemetry/events";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { getTerminalGeometry } from "@/terminal/terminal-geometry-registry";
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

interface SendTaskSessionInputResult {
	ok: boolean;
	message?: string;
}

interface StartTaskSessionResult {
	ok: boolean;
	message?: string;
}

interface StartTaskSessionOptions {
	resumeFromTrash?: boolean;
}

export interface UseTaskSessionsResult {
	upsertSession: (summary: RuntimeTaskSessionSummary) => void;
	ensureTaskWorkspace: (task: BoardCard) => Promise<EnsureTaskWorkspaceResult>;
	startTaskSession: (task: BoardCard, options?: StartTaskSessionOptions) => Promise<StartTaskSessionResult>;
	stopTaskSession: (taskId: string) => Promise<void>;
	// 手动「立即续跑」：对一组正在连接重试的任务各注入一次续跑。返回实际触发的任务 id。
	continueConnectionRetrySessions: (taskIds: string[]) => Promise<string[]>;
	// 手动「移出列表 / 停止重试」：把一组任务从自动续跑重试列表里移出。返回实际移出的任务 id。
	dismissConnectionRetrySessions: (taskIds: string[]) => Promise<string[]>;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<SendTaskSessionInputResult>;
	sendTaskChatMessage: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode },
	) => Promise<ClineChatActionResult>;
	abortTaskChatTurn: (taskId: string) => Promise<ClineChatActionResult>;
	cancelTaskChatTurn: (taskId: string) => Promise<ClineChatActionResult>;
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
	const {
		sendTaskChatMessage,
		loadTaskChatMessages: fetchTaskChatMessages,
		abortTaskChatTurn,
		cancelTaskChatTurn,
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
			try {
				const kickoffPrompt = options?.resumeFromTrash ? "" : task.prompt.trim();
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				// When the task terminal has never been mounted, fall back to the
				// persisted, user-resizable detail terminal panel width so the PTY
				// spawns at the width the agent TUI will actually be viewed at — not
				// a fixed 60-column default. A TUI hard-wraps its history at startup
				// width, so spawning at the wrong width can't be repaired by a later
				// resize. Once mounted, the measured per-task geometry takes priority.
				//
				// The persisted width is clamped to [320, 1400] but not to the
				// CURRENT window: a width persisted in a wide window can exceed what
				// a narrower window can display (the detail view renders the agent
				// panel at min(persisted, container − MIN_DETAIL_DIFF_PANEL_WIDTH_PX)).
				// Upper-bound it by the window before deriving columns so a
				// background-started task in a narrow window doesn't spawn at a column
				// count its visible width can never show. `window.innerWidth` is a
				// loose stand-in for the (still unmounted) detail container width;
				// clampPanelWidthToWindow falls back to the persisted width when the
				// window width is unavailable, so this never narrows below current
				// behavior.
				const windowDisplayableTerminalPanelWidth = clampPanelWidthToWindow(
					loadDetailTerminalPanelWidth(),
					MIN_DETAIL_DIFF_PANEL_WIDTH_PX,
					window.innerWidth,
				);
				const geometry =
					getTerminalGeometry(task.id) ??
					estimateTaskAgentTerminalGeometry(windowDisplayableTerminalPanelWidth, window.innerHeight);
				const payload = await trpcClient.runtime.startTaskSession.mutate({
					taskId: task.id,
					prompt: kickoffPrompt,
					taskTitle: task.title,
					images: options?.resumeFromTrash ? undefined : task.images,
					startInPlanMode: options?.resumeFromTrash ? undefined : task.startInPlanMode,
					resumeFromTrash: options?.resumeFromTrash,
					baseRef: task.baseRef,
					cols: geometry.cols,
					rows: geometry.rows,
					agentId: task.agentId,
					clineSettings: task.clineSettings,
					...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
					...(task.worktreeMode ? { worktreeMode: task.worktreeMode } : {}),
					...(task.prepFilePath ? { prepFilePath: task.prepFilePath } : {}),
				});
				if (!payload.ok || !payload.summary) {
					return {
						ok: false,
						message: payload.error ?? "Task session start failed.",
					};
				}
				upsertSession(payload.summary);
				if (options?.resumeFromTrash) {
					trackTaskResumedFromTrash();
				}
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSession],
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
		async (taskId: string, text: string, options?: SendTerminalInputOptions): Promise<SendTaskSessionInputResult> => {
			const appendNewline = options?.appendNewline ?? true;
			const controller = options?.preferTerminal === false ? null : getTerminalController(taskId);
			if (controller) {
				const sent =
					options?.mode === "paste"
						? !appendNewline && controller.paste(text)
						: controller.input(appendNewline ? `${text}\n` : text);
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
					upsertSession(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, message };
			}
		},
		[currentProjectId, upsertSession],
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
		stopTaskSession,
		continueConnectionRetrySessions,
		dismissConnectionRetrySessions,
		sendTaskSessionInput,
		sendTaskChatMessage,
		abortTaskChatTurn,
		cancelTaskChatTurn,
		fetchTaskChatMessages,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	};
}
