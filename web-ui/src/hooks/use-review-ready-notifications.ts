import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
} from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardData } from "@/types";
import {
	broadcastNotificationBadgeClear,
	createNotificationBadgeSyncSourceId,
	subscribeToNotificationBadgeClear,
} from "@/utils/notification-badge-sync";
import { getBrowserNotificationPermission } from "@/utils/notification-permission";
import { playReviewReadyNotificationSound } from "@/utils/notification-sound";
import { useDocumentTitle, useInterval, useUnmount, useWindowEvent } from "@/utils/react-use";
import {
	createTabPresenceId,
	hasVisibleKanbanTabForWorkspace,
	markTabHidden,
	markTabVisible,
} from "@/utils/tab-visibility-presence";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

interface UseReviewReadyNotificationsOptions {
	activeWorkspaceId: string | null;
	board: BoardData;
	isDocumentVisible: boolean;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	readyForReviewNotificationsEnabled: boolean;
	notificationSoundEnabled: boolean;
	workspacePath: string | null;
}

const MAX_HANDLED_READY_EVENT_KEYS = 200;
const TAB_VISIBILITY_HEARTBEAT_INTERVAL_MS = 5000;

function canShowBrowserNotifications(): boolean {
	return getBrowserNotificationPermission() === "granted";
}

function isDocumentCurrentlyVisible(fallbackValue: boolean): boolean {
	if (typeof document === "undefined") {
		return fallbackValue;
	}
	return document.visibilityState === "visible";
}

// 正文多行：第 1 行 repo / 工作区目录名、第 2 行任务标题、第 3 行 agent 最终消息（若有）。
// 缺省行（无 workspace、空白 finalMessage）被过滤掉，OS 通知会优雅截断过长行。taskTitle 由调用点保证非空。
export function resolveReviewReadyNotificationBody(
	workspaceTitle: string | null,
	taskTitle: string,
	finalMessage: string | null | undefined,
): string {
	const lines = [workspaceTitle?.trim() || null, taskTitle, finalMessage?.trim() || null].filter(
		(line): line is string => Boolean(line && line.length > 0),
	);
	return lines.join("\n");
}

// 通知标题随「人轴」userTurnKind 措辞，与卡片 channel C 文案对齐。userTurnKind 取自一次性 ready 事件
// payload（见 runtimeStateStreamTaskReadyForReviewMessageSchema），不回读延迟 150ms 批处理的 summary 流
// ——这正是上次 ③(b) 命中竞态后的重做要点。Stage 4 采集增强后可出现 error / needs_input / question /
// plan_review / permission；review / interrupted / null / undefined 一律落到 "ready for review" 兜底。
const REVIEW_READY_TITLE_PHRASE_BY_USER_TURN_KIND: Partial<
	Record<NonNullable<RuntimeTaskSessionUserTurnKind>, string>
> = {
	error: "encountered an error",
	needs_input: "needs your input",
	question: "needs your answer",
	plan_review: "has a plan to review",
	permission: "needs permission",
};
const DEFAULT_REVIEW_READY_TITLE_PHRASE = "ready for review";

// 标题 = userTurnKind 措辞本身（首字母大写、独立成句），不再前缀项目名——项目名改放正文第一行，
// 任务标题放第二行（见 resolveReviewReadyNotificationBody），让标题第一眼就回答「是什么种类的事」。
export function resolveReviewReadyNotificationTitle(userTurnKind: RuntimeTaskSessionUserTurnKind | undefined): string {
	const phrase =
		(userTurnKind ? REVIEW_READY_TITLE_PHRASE_BY_USER_TURN_KIND[userTurnKind] : undefined) ??
		DEFAULT_REVIEW_READY_TITLE_PHRASE;
	return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}

// 返回值 = 本次是否真的展示了 OS 通知横幅：权限非 granted（default/denied/unsupported）早返回 false，
// 构造 Notification 抛错时 catch 后也返回 false，仅在成功构造时返回 true。调用点据此让提示音与「通知确实
// 弹出」严格绑定（无横幅则不发声），落实 use 端注释声明的「声音与通知共享门控」不变量。
function showReadyForReviewNotification(taskId: string, notificationTitle: string, notificationBody: string): boolean {
	if (!canShowBrowserNotifications()) {
		return false;
	}
	try {
		const notification = new Notification(notificationTitle, {
			body: notificationBody,
			tag: `task-ready-for-review-${taskId}`,
			icon: "/assets/icon-notification.png",
		});
		notification.onclick = () => {
			if (typeof window !== "undefined") {
				window.focus();
			}
			notification.close();
		};
		return true;
	} catch {
		// Ignore browser notification failures.
		return false;
	}
}

export function useReviewReadyNotifications({
	activeWorkspaceId,
	board,
	isDocumentVisible,
	latestTaskReadyForReview,
	taskSessions,
	readyForReviewNotificationsEnabled,
	notificationSoundEnabled,
	workspacePath,
}: UseReviewReadyNotificationsOptions): void {
	const notificationPresenceTabIdRef = useRef<string>(createTabPresenceId());
	const notificationBadgeSyncSourceIdRef = useRef<string>(createNotificationBadgeSyncSourceId());
	const handledReadyForReviewEventKeysRef = useRef<Set<string>>(new Set());
	const handledReadyForReviewEventKeyQueueRef = useRef<string[]>([]);
	const [pendingReviewReadyNotificationCount, setPendingReviewReadyNotificationCount] = useState(0);
	const [isWindowFocused, setIsWindowFocused] = useState(() => {
		if (typeof document === "undefined") {
			return true;
		}
		return document.hasFocus();
	});
	const workspaceTitle = useMemo(() => {
		if (!workspacePath) {
			return null;
		}
		const segments = workspacePath
			.replaceAll("\\", "/")
			.split("/")
			.filter((segment) => segment.length > 0);
		if (segments.length === 0) {
			return workspacePath;
		}
		return segments[segments.length - 1] ?? workspacePath;
	}, [workspacePath]);
	const isAppActive = isDocumentVisible && isWindowFocused;

	useWindowEvent("focus", () => {
		setIsWindowFocused(true);
	});
	useWindowEvent("blur", () => {
		setIsWindowFocused(false);
	});

	useEffect(() => {
		const tabId = notificationPresenceTabIdRef.current;
		const syncSourceId = notificationBadgeSyncSourceIdRef.current;
		const presenceWorkspaceId = activeWorkspaceId;
		if (isAppActive) {
			if (presenceWorkspaceId) {
				markTabVisible(tabId, presenceWorkspaceId);
			} else {
				markTabHidden(tabId);
			}
			setPendingReviewReadyNotificationCount(0);
			broadcastNotificationBadgeClear(syncSourceId, presenceWorkspaceId);
		} else {
			markTabHidden(tabId);
		}
	}, [activeWorkspaceId, isAppActive]);

	useEffect(() => {
		if (activeWorkspaceId && isAppActive) {
			markTabVisible(notificationPresenceTabIdRef.current, activeWorkspaceId);
		}
	}, [activeWorkspaceId, isAppActive]);

	useInterval(
		() => {
			if (!activeWorkspaceId || !isAppActive) {
				return;
			}
			markTabVisible(notificationPresenceTabIdRef.current, activeWorkspaceId);
		},
		activeWorkspaceId && isAppActive ? TAB_VISIBILITY_HEARTBEAT_INTERVAL_MS : null,
	);

	useEffect(() => {
		if (!latestTaskReadyForReview) {
			return;
		}
		if (!activeWorkspaceId || latestTaskReadyForReview.workspaceId !== activeWorkspaceId) {
			return;
		}
		const eventKey = `${latestTaskReadyForReview.workspaceId}:${latestTaskReadyForReview.taskId}:${latestTaskReadyForReview.triggeredAt}`;
		if (handledReadyForReviewEventKeysRef.current.has(eventKey)) {
			return;
		}
		handledReadyForReviewEventKeysRef.current.add(eventKey);
		handledReadyForReviewEventKeyQueueRef.current.push(eventKey);
		if (handledReadyForReviewEventKeyQueueRef.current.length > MAX_HANDLED_READY_EVENT_KEYS) {
			const oldestKey = handledReadyForReviewEventKeyQueueRef.current.shift();
			if (oldestKey) {
				handledReadyForReviewEventKeysRef.current.delete(oldestKey);
			}
		}
		const isVisibleNow = isDocumentCurrentlyVisible(isDocumentVisible);
		const isWindowFocusedNow = typeof document === "undefined" ? isWindowFocused : document.hasFocus();
		const hasVisiblePeerTabForWorkspace = hasVisibleKanbanTabForWorkspace(
			latestTaskReadyForReview.workspaceId,
			notificationPresenceTabIdRef.current,
		);
		if (
			!readyForReviewNotificationsEnabled ||
			(isVisibleNow && isWindowFocusedNow) ||
			hasVisiblePeerTabForWorkspace
		) {
			return;
		}
		const selection = findCardSelection(board, latestTaskReadyForReview.taskId);
		const taskTitle = selection
			? truncateTaskPromptLabel(selection.card.prompt) || `Task ${latestTaskReadyForReview.taskId}`
			: `Task ${latestTaskReadyForReview.taskId}`;
		const finalMessage = taskSessions[latestTaskReadyForReview.taskId]?.latestHookActivity?.finalMessage;
		const notificationBody = resolveReviewReadyNotificationBody(workspaceTitle, taskTitle, finalMessage);
		setPendingReviewReadyNotificationCount((current) => current + 1);
		const notificationTitle = resolveReviewReadyNotificationTitle(latestTaskReadyForReview.userTurnKind);
		const didShowNotification = showReadyForReviewNotification(
			latestTaskReadyForReview.taskId,
			notificationTitle,
			notificationBody,
		);
		// 提示音与通知共享同一套门控（开关 / 可见性 / peer tab），并额外绑定「OS 通知确实弹出」：
		// 仅当 didShowNotification 为真（浏览器权限 granted 且 Notification 构造未抛错）时才发声，
		// 杜绝「权限未授予 → 无通知横幅却照样响声」的不一致路径（角标计数已在上方无条件更新，作为降级视觉提示）。
		// 设置里关「Play a sound」时同样被跳过——出通知不出声。
		if (didShowNotification && notificationSoundEnabled) {
			playReviewReadyNotificationSound(latestTaskReadyForReview.userTurnKind);
		}
	}, [
		activeWorkspaceId,
		board,
		isDocumentVisible,
		isWindowFocused,
		latestTaskReadyForReview,
		readyForReviewNotificationsEnabled,
		notificationSoundEnabled,
		taskSessions,
		workspaceTitle,
	]);

	const handlePageHide = useCallback(() => {
		markTabHidden(notificationPresenceTabIdRef.current);
	}, []);
	useWindowEvent("pagehide", handlePageHide);
	useUnmount(() => {
		markTabHidden(notificationPresenceTabIdRef.current);
	});

	useEffect(() => {
		const syncSourceId = notificationBadgeSyncSourceIdRef.current;
		return subscribeToNotificationBadgeClear(syncSourceId, (workspaceId) => {
			if (workspaceId === activeWorkspaceId) {
				setPendingReviewReadyNotificationCount(0);
			}
		});
	}, [activeWorkspaceId]);

	useEffect(() => {
		if (!readyForReviewNotificationsEnabled) {
			setPendingReviewReadyNotificationCount(0);
			broadcastNotificationBadgeClear(notificationBadgeSyncSourceIdRef.current, activeWorkspaceId);
		}
	}, [activeWorkspaceId, readyForReviewNotificationsEnabled]);

	useEffect(() => {
		handledReadyForReviewEventKeysRef.current.clear();
		handledReadyForReviewEventKeyQueueRef.current = [];
		setPendingReviewReadyNotificationCount(0);
	}, [activeWorkspaceId]);

	const baseTitle = workspaceTitle || "Kanban";
	const documentTitle =
		pendingReviewReadyNotificationCount > 0 ? `(${pendingReviewReadyNotificationCount}) ${baseTitle}` : baseTitle;
	useDocumentTitle(documentTitle);
}
