import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { buildProjectPathname } from "@/hooks/app-utils";
import { notificationIntelligenceClient } from "@/runtime/notification-intelligence-query";
import type {
	RuntimeProjectSummary,
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
import { playNotificationSummarySpeech } from "@/utils/notification-summary-speech";
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
	taskReadyForReviewEvents?: RuntimeStateStreamTaskReadyForReviewMessage[];
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	readyForReviewNotificationsEnabled: boolean;
	notificationSoundEnabled: boolean;
	workspacePath: string | null;
	// 就绪通知跨项目投递：别的项目的任务不在本地 board 上，正文第一行的项目名从这里取。
	projects: readonly RuntimeProjectSummary[];
}

const TAB_VISIBILITY_HEARTBEAT_INTERVAL_MS = 5000;
const SERVICE_WORKER_READY_TIMEOUT_MS = 1500;

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

// 返回值 = 本次是否真的展示了 OS 通知横幅：权限非 granted（default/denied/unsupported）早返回 false；
// 优先交给 service worker 承载通知，失败时回退到页面上下文 Notification。调用点据此让提示音与「通知确实
// 弹出」严格绑定（无横幅则不发声），落实 use 端注释声明的「声音与通知共享门控」不变量。
async function showReadyForReviewNotification(input: {
	taskId: string;
	workspaceId: string;
	title: string;
	body: string;
}): Promise<boolean> {
	if (!canShowBrowserNotifications()) {
		return false;
	}
	// taskId 只在一个看板内唯一、跨项目会撞号：tag 带上 workspaceId，免得别的项目的同号任务通知互相替换。
	const notificationTag = `task-ready-for-review-${input.workspaceId}-${input.taskId}`;
	const notificationIcon = "/assets/icon-notification.png";
	const data = {
		taskId: input.taskId,
		workspaceId: input.workspaceId,
		// 目标项目的路径，而不是弹出通知的这个标签页自己的路径：就绪通知跨项目投递（任一标签页都可能替别的项目弹），
		// SW 据此聚焦已经开着目标项目的标签页，而不是把弹通知的标签页原地切走（cf427）。
		workspacePathname: buildProjectPathname(input.workspaceId),
	};
	if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
		try {
			const registration = await Promise.race([
				navigator.serviceWorker.ready,
				new Promise<null>((resolve) => {
					setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS);
				}),
			]);
			if (registration) {
				await registration.showNotification(input.title, {
					body: input.body,
					tag: notificationTag,
					icon: notificationIcon,
					data,
				});
				return true;
			}
			// ready 超时未就绪：落到下方页面回退路径，确保通知与声音仍会触发。
		} catch {
			// SW 通知失败时降级到页面上下文通知，保留旧浏览器路径。
		}
	}
	try {
		const notification = new Notification(input.title, {
			body: input.body,
			tag: notificationTag,
			icon: notificationIcon,
		});
		notification.onclick = () => {
			if (typeof window !== "undefined") {
				window.focus();
			}
			notification.close();
		};
		return true;
	} catch {
		// 浏览器通知失败时静默降级，由角标继续提示。
		return false;
	}
}

export function useReviewReadyNotifications({
	activeWorkspaceId,
	board,
	isDocumentVisible,
	latestTaskReadyForReview,
	taskReadyForReviewEvents,
	taskSessions,
	readyForReviewNotificationsEnabled,
	notificationSoundEnabled,
	workspacePath,
	projects,
}: UseReviewReadyNotificationsOptions): void {
	const notificationPresenceTabIdRef = useRef<string>(createTabPresenceId());
	const notificationBadgeSyncSourceIdRef = useRef<string>(createNotificationBadgeSyncSourceId());
	const handledReadyForReviewEventKeysRef = useRef<Map<string, number>>(new Map());
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

	// 切项目只清标题角标；已处理事件键**不**清——就绪通知跨项目投递，切项目后的重放（服务端按全部项目重放
	// 最近 60 秒）不该让同一条通知在本标签页再弹一次。
	useEffect(() => {
		setPendingReviewReadyNotificationCount(0);
	}, [activeWorkspaceId]);

	useEffect(() => {
		const processEvent = (latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null) => {
			if (!latestTaskReadyForReview) {
				return;
			}
			// 不再按当前项目过滤：一个标签页可以经跨项目切换面板管全部项目（单标签页时别的项目的完成通知
			// 只能由它来弹）。多标签页之间靠下方 claimDelivery 领取 + 「有可见标签页正开着该项目」让位去重。
			const isEventForActiveWorkspace = latestTaskReadyForReview.workspaceId === activeWorkspaceId;
			const eventKey =
				latestTaskReadyForReview.candidateId ??
				`${latestTaskReadyForReview.workspaceId}:${latestTaskReadyForReview.taskId}:${latestTaskReadyForReview.triggeredAt}`;
			if (handledReadyForReviewEventKeysRef.current.has(eventKey)) {
				return;
			}
			handledReadyForReviewEventKeysRef.current.set(eventKey, Date.now());
			for (const [key, handledAt] of handledReadyForReviewEventKeysRef.current) {
				if (Date.now() - handledAt > 120_000) handledReadyForReviewEventKeysRef.current.delete(key);
			}
			const isVisibleNow = isDocumentCurrentlyVisible(isDocumentVisible);
			const isWindowFocusedNow = typeof document === "undefined" ? isWindowFocused : document.hasFocus();
			if (latestTaskReadyForReview.archiveIncomplete) toast.error("通知留档不完整，请检查运行时和磁盘状态。");
			const hasVisiblePeerTabForWorkspace = hasVisibleKanbanTabForWorkspace(
				latestTaskReadyForReview.workspaceId,
				notificationPresenceTabIdRef.current,
			);
			if (latestTaskReadyForReview.candidateId)
				void notificationIntelligenceClient()
					.recordClientFilter.mutate({
						candidateId: latestTaskReadyForReview.candidateId,
						clientId: notificationPresenceTabIdRef.current,
						reason: !readyForReviewNotificationsEnabled
							? "notifications_disabled"
							: isEventForActiveWorkspace && isVisibleNow && isWindowFocusedNow
								? "foreground_visible"
								: hasVisiblePeerTabForWorkspace
									? "visible_peer_tab"
									: Date.now() - latestTaskReadyForReview.triggeredAt > 60_000
										? "stale"
										: "eligible",
					})
					.catch(() => undefined);
			// 前台可见只压住**当前项目**的通知：人正看着别的项目时，这个项目的任务完成了照样要弹。
			if (
				!readyForReviewNotificationsEnabled ||
				(isEventForActiveWorkspace && isVisibleNow && isWindowFocusedNow) ||
				hasVisiblePeerTabForWorkspace
			) {
				return;
			}
			// 本地 board / session 只有当前项目的；别的项目用 ready 事件里的标题快照与项目名。
			const selection = isEventForActiveWorkspace ? findCardSelection(board, latestTaskReadyForReview.taskId) : null;
			const taskTitle =
				(selection ? truncateTaskPromptLabel(selection.card.prompt) : null) ||
				latestTaskReadyForReview.taskTitleSnapshot ||
				`Task ${latestTaskReadyForReview.taskId}`;
			const finalMessage = isEventForActiveWorkspace
				? taskSessions[latestTaskReadyForReview.taskId]?.latestHookActivity?.finalMessage
				: undefined;
			const notificationWorkspaceTitle = isEventForActiveWorkspace
				? workspaceTitle
				: (projects.find((project) => project.id === latestTaskReadyForReview.workspaceId)?.name ?? null);
			const notificationBody = resolveReviewReadyNotificationBody(
				notificationWorkspaceTitle,
				taskTitle,
				latestTaskReadyForReview.summaryText ?? finalMessage,
			);
			const notificationTitle = resolveReviewReadyNotificationTitle(latestTaskReadyForReview.userTurnKind);
			void (async () => {
				const candidateId = latestTaskReadyForReview.candidateId;
				const clientId = notificationPresenceTabIdRef.current;
				if (Date.now() - latestTaskReadyForReview.triggeredAt > 60_000) return;
				if (candidateId) {
					try {
						if (!(await notificationIntelligenceClient().claimDelivery.mutate({ candidateId, clientId })).claimed)
							return;
					} catch {
						// 仅领取失败允许后续事件重放；领取完成后的通知和付费语音不得重复执行。
						handledReadyForReviewEventKeysRef.current.delete(eventKey);
						return;
					}
				}
				setPendingReviewReadyNotificationCount((current) => current + 1);
				const didShowNotification = await showReadyForReviewNotification({
					taskId: latestTaskReadyForReview.taskId,
					workspaceId: latestTaskReadyForReview.workspaceId,
					title: notificationTitle,
					body: notificationBody,
				});
				// 提示音与通知共享同一套门控（开关 / 可见性 / peer tab），并额外绑定「OS 通知确实弹出」：
				// 仅当 didShowNotification 为真（浏览器权限 granted 且通知创建成功）时才发声，
				// 杜绝「权限未授予 → 无通知横幅却照样响声」的不一致路径（角标计数已在上方无条件更新，作为降级视觉提示）。
				// 设置里关「Play a sound」时同样被跳过——出通知不出声。
				if (candidateId)
					await notificationIntelligenceClient()
						.recordClientObservation.mutate({
							candidateId,
							clientId,
							observation: didShowNotification ? "desktop_accepted" : "desktop_blocked",
						})
						.catch(() => toast.error("通知投递结果未能留档"));
				const recordSoundDisposition = (
					observation: "sound_disabled" | "chime_requested" | "speech_chime_fallback_requested",
					detail?: string,
				) => {
					if (candidateId)
						void notificationIntelligenceClient()
							.recordClientObservation.mutate({ candidateId, clientId, observation, detail })
							.catch(() => toast.error("声音投递结果未能留档"));
				};
				if (didShowNotification && !notificationSoundEnabled)
					recordSoundDisposition("sound_disabled", "browser_sound_setting");
				if (didShowNotification && notificationSoundEnabled) {
					const settings = candidateId
						? await notificationIntelligenceClient()
								.getSettings.query()
								.then((result) => result.settings)
								.catch(() => null)
						: null;
					if (settings?.speechMode === "off") {
						recordSoundDisposition("sound_disabled", "runtime_speech_mode");
						return;
					}
					if (
						settings?.speechMode === "summary" &&
						(latestTaskReadyForReview.userTurnKind ?? "review") === "review"
					) {
						try {
							await playNotificationSummarySpeech({
								settings: {
									...settings,
									summaryLanguage: latestTaskReadyForReview.summaryLanguage ?? settings.summaryLanguage,
								},
								text: latestTaskReadyForReview.summaryText ?? notificationBody,
								candidateId,
								clientId,
								triggeredAt: latestTaskReadyForReview.triggeredAt,
							});
						} catch {
							recordSoundDisposition("speech_chime_fallback_requested");
							playReviewReadyNotificationSound(latestTaskReadyForReview.userTurnKind);
						}
					} else {
						recordSoundDisposition("chime_requested");
						playReviewReadyNotificationSound(latestTaskReadyForReview.userTurnKind);
					}
				}
			})().catch(() => undefined);
		};
		for (const event of taskReadyForReviewEvents ?? [latestTaskReadyForReview]) processEvent(event);
	}, [
		activeWorkspaceId,
		board,
		isDocumentVisible,
		isWindowFocused,
		latestTaskReadyForReview,
		taskReadyForReviewEvents,
		readyForReviewNotificationsEnabled,
		notificationSoundEnabled,
		projects,
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

	const baseTitle = workspaceTitle || "Kanban";
	const documentTitle =
		pendingReviewReadyNotificationCount > 0 ? `(${pendingReviewReadyNotificationCount}) ${baseTitle}` : baseTitle;
	useDocumentTitle(documentTitle);
}
