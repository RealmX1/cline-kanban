import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard } from "../src/components/board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "../src/hooks/use-cross-project-recently-active-task-switcher-sections";
import { createRecentTaskSwitcherEntryTestFixture, createRecentTaskSwitcherProjectTestFixture } from "./recent-task-worktree-changes-filter-fixtures";
import "../src/styles/globals.css";

const projects = [
	createRecentTaskSwitcherProjectTestFixture("project-a", [
		createRecentTaskSwitcherEntryTestFixture("dirty"),
		createRecentTaskSwitcherEntryTestFixture("ahead"),
		createRecentTaskSwitcherEntryTestFixture("clean", { pinnedToTaskPinboardAt: 1, taskPinboardPinReason: "筛选后仍置顶" }),
		createRecentTaskSwitcherEntryTestFixture("unknown"),
		createRecentTaskSwitcherEntryTestFixture("missing"),
		createRecentTaskSwitcherEntryTestFixture("running", { turnOwner: "agent", liveness: "live" }),
		createRecentTaskSwitcherEntryTestFixture("warm", { agentId: "claude", lastAgentConversationPromptCacheReferenceObservation: { observedAtMs: Date.now(), evidenceKind: "post_tool_use_hook_event" } }),
	]),
	createRecentTaskSwitcherProjectTestFixture("project-b", [createRecentTaskSwitcherEntryTestFixture("dirty")]),
];

function Harness() {
	const [showsBoard, setShowsBoard] = useState(new URLSearchParams(window.location.search).get("view") !== "focus");
	const [presentationMountSequence, setPresentationMountSequence] = useState(0);
	const sectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({ projects, currentProjectId: "project-a", notificationLogByWorkspaceId: {} });
	const host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue = {
		projects,
		notificationLogByWorkspaceId: {},
		currentProjectId: "project-a",
		isBoardScopeAllProjectsSelected: true,
		focusedTaskInProject: null,
		crossProjectTaskSwitcherSectionsModel: sectionsModel,
		onOpenTaskInProject: () => {},
		onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
		onUnpinCurrentProjectTaskFromTaskPinboard: () => {},
		onEditCurrentProjectTaskPinboardPinReason: () => {},
	};
	return (
		<TooltipProvider>
			<div className="flex h-dvh min-w-0 flex-col bg-surface-0 text-text-primary">
				<nav className="flex shrink-0 flex-wrap gap-3 p-2" aria-label="隔离测试视图切换">
					<button type="button" onClick={() => setShowsBoard((previous) => !previous)}>切换看板与 Focus View</button>
					<button type="button" onClick={() => setPresentationMountSequence((previous) => previous + 1)}>重新挂载呈现面</button>
				</nav>
				{showsBoard ? (
					<BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard key={presentationMountSequence} host={host} currentProjectTaskCards={null} defaultAgentId="codex" />
				) : (
					<div className="flex min-h-0 w-full max-w-sm flex-1 flex-col">
						<CrossProjectRecentlyActiveTaskSwitcherPanel key={presentationMountSequence} host={host} />
					</div>
				)}
			</div>
		</TooltipProvider>
	);
}

const mountElement = document.createElement("div");
document.body.appendChild(mountElement);
createRoot(mountElement).render(<Harness />);
