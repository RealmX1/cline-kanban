import { useCallback, useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	type NonModalFloatingFormWindowHost,
	useNonModalFloatingFormWindowHost,
} from "@/components/non-modal-floating-form-window-host-provider";
import type { CrossProjectTaskOpenResult } from "@/hooks/use-cross-project-task-open-in-project";
import { resolveVisitedTaskNavigationTarget } from "@/runtime/visited-task-navigation-query";
import {
	createEmptyVisitedTaskNavigationHistory,
	findAdjacentAvailableVisitedTaskPathIndex,
	isSameVisitedTaskIdentity,
	parseVisitedTaskNavigationHistory,
	recordVisitedTask,
	refreshedVisitedTaskPathIndex,
	refreshVisitedTaskHistoryEntry,
	setVisitedTaskUnavailable,
	VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY,
	type VisitedTaskHistoryEntry,
	type VisitedTaskNavigationHistory,
	visitTaskAtHistoryPathIndex,
} from "@/state/visited-task-navigation-history";
import { subscribeToTaskVisualizationBrowserEvents } from "@/stores/task-visualization-browser-bridge";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";
import { isMacPlatform } from "@/utils/platform";

interface VisitedTaskNavigationIntent {
	entry: VisitedTaskHistoryEntry;
	pathIndex: number | null;
	direction?: -1 | 1;
	origin: VisitedTaskHistoryEntry | null;
	cancellation: AbortController;
	attemptCount: number;
	awaitingReconnect: boolean;
	reconnectObservedDuringAttempt: boolean;
}

export function useVisitedTaskNavigationHistoryController({
	displayedTask,
	projects,
	isRuntimeConnected,
	openTaskInProjectWithResult,
	floatingFormWindowHost,
}: {
	displayedTask: VisitedTaskHistoryEntry | null;
	projects: readonly { id: string; name: string }[];
	isRuntimeConnected: boolean;
	openTaskInProjectWithResult: (
		workspaceId: string,
		taskId: string,
		createdAt: number,
		signal?: AbortSignal,
		workspaceIdsUsedByTaskIncarnation?: readonly string[],
	) => Promise<CrossProjectTaskOpenResult>;
	floatingFormWindowHost?: NonModalFloatingFormWindowHost | null;
}) {
	const inheritedFloatingFormHost = useNonModalFloatingFormWindowHost();
	const floatingFormHost = floatingFormWindowHost ?? inheritedFloatingFormHost;
	const [restored] = useState(() => {
		try {
			return {
				history: parseVisitedTaskNavigationHistory(
					localStorage.getItem(VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY),
				),
				unavailable: false,
			};
		} catch {
			return { history: createEmptyVisitedTaskNavigationHistory(), unavailable: true };
		}
	});
	const [history, setHistory] = useState(restored.history);
	const historyRef = useRef(history);
	const [isHistoryPersistenceUnavailable, setIsHistoryPersistenceUnavailable] = useState(restored.unavailable);
	const persistenceWarningShownRef = useRef(false);
	const lastPersistedHistorySnapshotRef = useRef<string | null>(null);
	const [pendingIntent, setPendingIntent] = useState<VisitedTaskNavigationIntent | null>(null);
	const intentRef = useRef<VisitedTaskNavigationIntent | null>(null);
	const lastDisplayedTaskRef = useRef<VisitedTaskHistoryEntry | null>(null);
	const displayedTaskIdentityReadRef = useRef<AbortController | null>(null);
	const latestInputRef = useRef({ projects, isRuntimeConnected, openTaskInProjectWithResult, floatingFormHost });
	latestInputRef.current = { projects, isRuntimeConnected, openTaskInProjectWithResult, floatingFormHost };
	const updateHistory = useCallback(
		(
			change: (previous: VisitedTaskNavigationHistory) => VisitedTaskNavigationHistory,
			persistOnlyWhileStoredSnapshotBelongsToThisPage = false,
		) => {
			const next = change(historyRef.current);
			historyRef.current = next;
			setHistory(next);
			try {
				if (
					persistOnlyWhileStoredSnapshotBelongsToThisPage &&
					localStorage.getItem(VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY) !==
						lastPersistedHistorySnapshotRef.current
				)
					return;
				const snapshot = JSON.stringify(next);
				localStorage.setItem(VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY, snapshot);
				lastPersistedHistorySnapshotRef.current = snapshot;
				setIsHistoryPersistenceUnavailable(false);
			} catch {
				setIsHistoryPersistenceUnavailable(true);
				if (!persistenceWarningShownRef.current) {
					persistenceWarningShownRef.current = true;
					showAppToast({ intent: "warning", message: "访问历史暂时无法保存；当前页面内仍可前后导航。" });
				}
			}
		},
		[],
	);
	const cancelNavigation = useCallback(() => {
		intentRef.current?.cancellation.abort();
		intentRef.current = null;
		setPendingIntent(null);
	}, []);
	const recordDisplayedTask = useCallback(
		(entry: VisitedTaskHistoryEntry) => {
			lastDisplayedTaskRef.current = entry;
			const intent = intentRef.current;
			// 目标自己的显示回报只确认打开，不另记一次访问。来源被用户再次展开则是更新的意图。
			if (intent && isSameVisitedTaskIdentity(intent.entry, entry)) return;
			cancelNavigation();
			const visited = { ...entry, lastVisitedAtEpochMs: Date.now(), unavailable: false };
			updateHistory((previous) => recordVisitedTask(previous, visited));
			displayedTaskIdentityReadRef.current?.abort();
			const readCancellation = new AbortController();
			displayedTaskIdentityReadRef.current = readCancellation;
			void resolveVisitedTaskNavigationTarget(
				visited,
				AbortSignal.any([readCancellation.signal, AbortSignal.timeout(15_000)]),
			)
				.then((target) => {
					if (!readCancellation.signal.aborted && target.outcome === "available")
						updateHistory((previous) => refreshVisitedTaskHistoryEntry(previous, visited, target.entry), true);
				})
				.catch(() => undefined);
		},
		[cancelNavigation, updateHistory],
	);
	const displayedTaskKey = displayedTask
		? JSON.stringify([displayedTask.workspaceId, displayedTask.taskId, displayedTask.taskIncarnationCreatedAtEpochMs])
		: null;
	const lastObservedDetailKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (lastObservedDetailKeyRef.current === displayedTaskKey) return;
		lastObservedDetailKeyRef.current = displayedTaskKey;
		if (displayedTask) recordDisplayedTask(displayedTask);
	}, [displayedTaskKey, displayedTask, recordDisplayedTask]);
	useEffect(
		() =>
			floatingFormHost?.subscribeToRevealedTaskEditors((ownership) => {
				if (!ownership.workspaceId || !ownership.taskId || ownership.taskIncarnationCreatedAtEpochMs === undefined)
					return;
				recordDisplayedTask({
					workspaceId: ownership.workspaceId,
					taskId: ownership.taskId,
					taskIncarnationCreatedAtEpochMs: ownership.taskIncarnationCreatedAtEpochMs,
					titleSnapshot: ownership.taskTitleSnapshot ?? ownership.taskId,
					projectNameSnapshot:
						latestInputRef.current.projects.find((project) => project.id === ownership.workspaceId)?.name ??
						ownership.workspaceId,
					lastVisitedAtEpochMs: Date.now(),
					unavailable: false,
				});
			}),
		[floatingFormHost?.subscribeToRevealedTaskEditors, recordDisplayedTask],
	);

	const runIntentRef = useRef<(intent: VisitedTaskNavigationIntent) => Promise<void>>(async () => {});
	runIntentRef.current = async (intent) => {
		if (intentRef.current !== intent) return;
		if (!latestInputRef.current.isRuntimeConnected) {
			intent.awaitingReconnect = true;
			return;
		}
		intent.awaitingReconnect = false;
		intent.reconnectObservedDuringAttempt = false;
		intent.attemptCount++;
		const signal = AbortSignal.any([intent.cancellation.signal, AbortSignal.timeout(30_000)]);
		const continuePastUnavailable = async (failedEntry: VisitedTaskHistoryEntry) => {
			updateHistory((previous) => setVisitedTaskUnavailable(previous, failedEntry));
			const nextIndex =
				intent.direction && intent.pathIndex !== null
					? findAdjacentAvailableVisitedTaskPathIndex(historyRef.current, intent.direction, intent.pathIndex)
					: null;
			const next = nextIndex !== null ? historyRef.current.navigationPath[nextIndex] : undefined;
			if (next && nextIndex !== null) {
				intent.entry = next;
				intent.pathIndex = nextIndex;
				intent.attemptCount--;
				setPendingIntent({ ...intent });
				await runIntentRef.current(intent);
				return;
			}
			showAppToast({ intent: "warning", message: "原任务已删除或重建，访问记录已标记为不可用。" });
			cancelNavigation();
		};
		try {
			const lookupWorkspaceId = latestInputRef.current.projects.some(
				(project) => project.id === intent.entry.workspaceId,
			)
				? intent.entry.workspaceId
				: (latestInputRef.current.projects[0]?.id ?? intent.entry.workspaceId);
			const target = await resolveVisitedTaskNavigationTarget(intent.entry, signal, lookupWorkspaceId);
			if (intentRef.current !== intent) return;
			signal.throwIfAborted();
			if (target.outcome === "unavailable") {
				await continuePastUnavailable(intent.entry);
				return;
			}
			const projectName = latestInputRef.current.projects.find(
				(project) => project.id === target.currentWorkspaceId,
			)?.name;
			const resolvedEntry = {
				...target.entry,
				projectNameSnapshot: projectName ?? target.entry.projectNameSnapshot,
			};
			const workspaceIdsUsedByTaskIncarnation = [
				...new Set(
					[
						intent.entry.workspaceId,
						resolvedEntry.workspaceId,
						target.currentWorkspaceId,
						...(resolvedEntry.workspaceIdsUsedByTaskIncarnation ?? []),
					].filter((workspaceId) => workspaceId.length > 0),
				),
			];
			if (intent.pathIndex !== null)
				intent.pathIndex = refreshedVisitedTaskPathIndex(
					historyRef.current,
					intent.entry,
					resolvedEntry,
					intent.pathIndex,
				);
			updateHistory((previous) => refreshVisitedTaskHistoryEntry(previous, intent.entry, resolvedEntry), true);
			intent.entry = resolvedEntry;
			latestInputRef.current.floatingFormHost?.collapseTaskEditorWindowsExcept({
				workspaceId: target.currentWorkspaceId,
				taskId: resolvedEntry.taskId,
				taskIncarnationCreatedAtEpochMs: resolvedEntry.taskIncarnationCreatedAtEpochMs,
				workspaceIdsUsedByTaskIncarnation,
			});
			const result = await latestInputRef.current.openTaskInProjectWithResult(
				target.currentWorkspaceId,
				resolvedEntry.taskId,
				resolvedEntry.taskIncarnationCreatedAtEpochMs,
				signal,
				workspaceIdsUsedByTaskIncarnation,
			);
			if (intentRef.current !== intent) return;
			signal.throwIfAborted();
			if (result.outcome === "cancelled") {
				cancelNavigation();
				return;
			}
			if (result.outcome === "unavailable") {
				await continuePastUnavailable(resolvedEntry);
				return;
			}
			if (result.outcome === "failed") throw new Error(result.message);
			const visited = { ...resolvedEntry, lastVisitedAtEpochMs: Date.now() };
			updateHistory((previous) =>
				intent.pathIndex === null
					? recordVisitedTask(previous, visited)
					: visitTaskAtHistoryPathIndex(previous, intent.pathIndex, visited),
			);
			cancelNavigation();
		} catch (error) {
			if (intentRef.current !== intent) return;
			if (
				intent.attemptCount < 2 &&
				intent.reconnectObservedDuringAttempt &&
				latestInputRef.current.isRuntimeConnected
			) {
				intent.reconnectObservedDuringAttempt = false;
				void runIntentRef.current(intent);
				return;
			}
			intent.awaitingReconnect = intent.attemptCount < 2;
			showAppToast({
				intent: "warning",
				message: `暂时无法打开任务：${error instanceof Error ? error.message : String(error)}${intent.awaitingReconnect ? "；连接恢复后自动重试一次。" : ""}`,
			});
			if (!intent.awaitingReconnect) cancelNavigation();
		}
	};
	const startNavigation = useCallback(
		(entry: VisitedTaskHistoryEntry, pathIndex: number | null, direction?: -1 | 1) => {
			cancelNavigation();
			displayedTaskIdentityReadRef.current?.abort();
			const intent: VisitedTaskNavigationIntent = {
				entry,
				pathIndex,
				direction,
				origin: lastDisplayedTaskRef.current,
				cancellation: new AbortController(),
				attemptCount: 0,
				awaitingReconnect: false,
				reconnectObservedDuringAttempt: false,
			};
			intentRef.current = intent;
			setPendingIntent(intent);
			void runIntentRef.current(intent);
		},
		[cancelNavigation],
	);
	const navigateAdjacent = useCallback(
		(direction: -1 | 1) => {
			const index = findAdjacentAvailableVisitedTaskPathIndex(
				historyRef.current,
				direction,
				intentRef.current?.pathIndex ?? historyRef.current.cursor,
			);
			const entry = index === null ? undefined : historyRef.current.navigationPath[index];
			if (entry && index !== null) startNavigation(entry, index, direction);
		},
		[startNavigation],
	);
	const noteRuntimeReconnectRef = useRef(() => {});
	noteRuntimeReconnectRef.current = () => {
		const intent = intentRef.current;
		if (!intent) return;
		intent.reconnectObservedDuringAttempt = true;
		if (intent.awaitingReconnect && latestInputRef.current.isRuntimeConnected) void runIntentRef.current(intent);
	};
	useEffect(() => {
		if (!isRuntimeConnected) return;
		noteRuntimeReconnectRef.current();
	}, [isRuntimeConnected]);
	useEffect(() => {
		const retry = () => noteRuntimeReconnectRef.current();
		window.addEventListener("online", retry);
		const unsubscribe = subscribeToTaskVisualizationBrowserEvents((event) => {
			if (event.type === "stream_reconnected") retry();
		});
		return () => {
			window.removeEventListener("online", retry);
			unsubscribe();
		};
	}, []);
	useEffect(
		() => () => {
			intentRef.current?.cancellation.abort();
			displayedTaskIdentityReadRef.current?.abort();
		},
		[],
	);
	useEffect(() => {
		window.addEventListener("popstate", cancelNavigation);
		return () => window.removeEventListener("popstate", cancelNavigation);
	}, [cancelNavigation]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const direction = isMacPlatform
				? event.ctrlKey &&
					!event.metaKey &&
					!event.altKey &&
					(event.code === "Minus" || event.key === "-" || event.key === "_")
					? event.shiftKey
						? 1
						: -1
					: null
				: event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
					? event.key === "ArrowLeft"
						? -1
						: event.key === "ArrowRight"
							? 1
							: null
					: null;
			if (
				direction === null ||
				isKeyboardEventEmittedDuringImeComposition(event) ||
				document.querySelector(
					'[data-state="open"][role="alertdialog"], [data-state="open"][role="dialog"]:not([aria-modal="false"]):not([data-related-tasks-preview-dialog]), dialog[open]',
				)
			)
				return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (!event.repeat) navigateAdjacent(direction);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [navigateAdjacent]);
	const navigationCursor = pendingIntent?.pathIndex ?? history.cursor;
	const backwardIndex = findAdjacentAvailableVisitedTaskPathIndex(history, -1, navigationCursor);
	const forwardIndex = findAdjacentAvailableVisitedTaskPathIndex(history, 1, navigationCursor);
	return {
		history,
		isHistoryPersistenceUnavailable,
		isNavigationPending: pendingIntent !== null,
		backwardTarget: backwardIndex === null ? null : (history.navigationPath[backwardIndex] ?? null),
		forwardTarget: forwardIndex === null ? null : (history.navigationPath[forwardIndex] ?? null),
		navigateBackward: () => navigateAdjacent(-1),
		navigateForward: () => navigateAdjacent(1),
		openRecentTask: (entry: VisitedTaskHistoryEntry) => startNavigation(entry, null),
		cancelNavigation,
	};
}

export type VisitedTaskNavigationHistoryController = ReturnType<typeof useVisitedTaskNavigationHistoryController>;
