import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	CrossProjectRecentlyActiveTaskSwitcherHostContextProvider,
	type CrossProjectRecentlyActiveTaskSwitcherHostContextValue,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { TaskCardCornerStatusIndicatorsFromRuntimeState } from "@/components/task-card-corner-status-indicators-from-runtime-state";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import type { RuntimeNotificationFeedEntry, RuntimeTaskSessionSummary } from "@/runtime/types";

const nowMs = Date.now();
const runningSummary: RuntimeTaskSessionSummary = {
	taskId: "same-id",
	state: "running",
	turnOwner: "agent",
	liveness: "live",
	userTurnKind: null,
	agentId: "codex",
	workspacePath: "/isolated/project-a",
	pid: 1,
	startedAt: nowMs,
	updatedAt: nowMs,
	lastOutputAt: nowMs,
	lastHookAt: null,
	latestHookActivity: null,
	reviewReason: null,
	exitCode: null,
};

function notification(workspaceId: string, visitedAt: number | null): RuntimeNotificationFeedEntry {
	return {
		id: workspaceId,
		workspaceId,
		taskId: "same-id",
		repoName: workspaceId,
		taskTitle: "跨项目同号任务",
		userTurnKind: "review",
		triggeredAt: nowMs,
		visitedAt,
		isDone: false,
	};
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

function NotificationProjectionHost({
	host,
	usesSectionsModel,
	children,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	usesSectionsModel: boolean;
	children: ReactNode;
}) {
	const model = useCrossProjectRecentlyActiveTaskSwitcherSections({
		projects: host.projects,
		notificationLogByWorkspaceId: host.notificationLogByWorkspaceId,
		currentProjectId: host.currentProjectId,
	});
	return (
		<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider
			value={{ ...host, crossProjectTaskSwitcherSectionsModel: usesSectionsModel ? model : undefined }}
		>
			{children}
		</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
	);
}

function renderNotifications(
	projectAVisitedAt: number | null,
	summary: RuntimeTaskSessionSummary,
	usesSectionsModel: boolean,
) {
	const host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue = {
		projects: [],
		notificationLogByWorkspaceId: {
			"project-a": [notification("project-a", projectAVisitedAt)],
			"project-b": [notification("project-b", null)],
		},
		currentProjectId: "project-a",
		isBoardScopeAllProjectsSelected: false,
		focusedTaskInProject: null,
		onOpenTaskInProject: vi.fn(),
		onRequestPinCurrentProjectTaskToTaskPinboard: vi.fn(),
		onUnpinCurrentProjectTaskFromTaskPinboard: vi.fn(),
		onEditCurrentProjectTaskPinboardPinReason: vi.fn(),
	};
	act(() =>
		root.render(
			<NotificationProjectionHost host={host} usesSectionsModel={usesSectionsModel}>
				<TaskCardCornerStatusIndicatorsFromRuntimeState
					taskId="same-id"
					workspaceId={null}
					columnId="in_progress"
					sessionSummary={summary}
				/>
			</NotificationProjectionHost>,
		),
	);
}

it.each([true, false])("使用通知投影 %s：读完当前项目的通知只撤掉未读角标", (usesSectionsModel) => {
	renderNotifications(null, runningSummary, usesSectionsModel);
	expect(container.querySelectorAll("[data-task-card-corner-status-indicator]")).toHaveLength(2);
	renderNotifications(nowMs, runningSummary, usesSectionsModel);
	expect(container.querySelector('[data-task-card-corner-status-indicator="running"]')).not.toBeNull();
	// 另一个项目仍有同号未读通知，不得污染当前项目。
	expect(container.querySelector('[data-task-card-corner-status-indicator="unread_handoff"]')).toBeNull();
});

it.each([true, false])("使用通知投影 %s：用户接手后移除运行角标，未读通知仍保留", (usesSectionsModel) => {
	renderNotifications(null, runningSummary, usesSectionsModel);
	renderNotifications(
		null,
		{ ...runningSummary, state: "awaiting_review", turnOwner: "user", userTurnKind: "review" },
		usesSectionsModel,
	);
	expect(container.querySelector('[data-task-card-corner-status-indicator="running"]')).toBeNull();
	expect(container.querySelector('[data-task-card-corner-status-indicator="unread_handoff"]')).not.toBeNull();
});
