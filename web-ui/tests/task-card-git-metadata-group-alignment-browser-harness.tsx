import { createRoot } from "react-dom/client";
import { CrossProjectRecentlyActiveTaskSwitcherTaskRow } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { TaskCardBody } from "../src/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "../src/components/task-card-body-visual-density-context";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { RuntimeCrossProjectTaskSwitcherEntry } from "../src/runtime/types";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, ReviewTaskWorkspaceSnapshot } from "../src/types";
import "../src/styles/globals.css";

const nowMs = Date.now();
const cardWidth = Number(new URLSearchParams(location.search).get("cardWidth") ?? 420);
const hostLabels = {
	standard: "标准卡片",
	compact: "Focus View 简洁卡片",
	expanded: "跨项目展开卡片",
	"cross-project": "跨项目简洁行",
};
const cases = [
	{ id: "both", dirty: true, committed: true, projectName: "项目 A", ahead: 2, behind: 3 },
	{ id: "dirty", dirty: true, committed: false, projectName: "项目 B", ahead: 0, behind: 0 },
	{ id: "committed", dirty: false, committed: true, projectName: "项目 C", ahead: 0, behind: 3 },
	{ id: "zero", dirty: false, committed: false, projectName: "项目 D", ahead: 0, behind: 0 },
	{ id: "unavailable", dirty: false, committed: false, projectName: "项目 E", ahead: 0, behind: 0 },
	{
		id: "large",
		dirty: true,
		committed: true,
		projectName: "包含很长名称且没有空格的项目ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		ahead: 1234,
		behind: 5678,
	},
];

for (const fixture of cases) {
	const large = fixture.id === "large";
	const snapshot: ReviewTaskWorkspaceSnapshot = {
		taskId: fixture.id,
		path: `/isolated/${fixture.id}`,
		branch: "task-layout",
		isDetached: false,
		headCommit: "task-head",
		baseCommit: "base-head",
		changedFiles: fixture.dirty ? (large ? 123456 : 2) : 0,
		additions: fixture.dirty ? (large ? 123456789 : 15) : 0,
		deletions: fixture.dirty ? (large ? 987654321 : 4) : 0,
		commitsAheadOfBaseRef: fixture.ahead,
		commitsBehindBaseRef: fixture.behind,
		taskCommitsIntegratedIntoBaseRef: large ? 1234 : 0,
		taskCommitIntegrationTrackingStatus: "complete",
		taskRetainedCommittedLineChangeSummary:
			fixture.id === "unavailable"
				? undefined
				: {
						status: "complete",
						commitCount: 2,
						additions: fixture.committed ? (large ? 123456789 : 10) : 0,
						deletions: fixture.committed ? (large ? 987654321 : 10) : 0,
						historyVersion: "layout-fixture",
						unavailableReason: null,
					},
	};
	setTaskWorkspaceSnapshot(snapshot);
}

function Harness() {
	return (
		<TooltipProvider>
			<main className="flex flex-wrap items-start gap-8 bg-surface-0 p-6 text-text-primary">
				{(["standard", "compact", "expanded", "cross-project"] as const).map((host) => (
					<section
						key={host}
						data-alignment-host={host}
						style={{ width: cardWidth }}
						className="min-w-0 max-w-full"
					>
						<h2 className="mb-6">{hostLabels[host]}</h2>
						{cases.map((fixture) => {
							const card: BoardCard = {
								id: fixture.id,
								title: `布局测试 ${fixture.id}`,
								prompt: "隔离的布局验证",
								agentId: "codex",
								baseRef: "main",
								worktreeMode: "branch",
								startInPlanMode: false,
								createdAt: nowMs,
								updatedAt: nowMs,
							};
							const entry: RuntimeCrossProjectTaskSwitcherEntry = {
								taskId: card.id,
								title: card.title,
								agentId: "codex",
								baseRef: "main",
								worktreeMode: "branch",
								columnId: "in_progress",
								turnOwner: "user",
								liveness: "exited",
								userTurnKind: "review",
								createdAt: nowMs,
								taskDescriptionLastUpdatedAt: nowMs,
								lastOpenedByUserAt: null,
								isParkedAwaitingDispatchedBackgroundWork: false,
								lastOutputAt: nowMs,
								lastSubstantiveOutputAt: null,
								pinnedToTaskPinboardAt: null,
								taskPinboardPinReason: null,
								agentResponseGenerationStopped: null,
								lastConversationProgressObservation: null,
							};
							return (
								<div key={fixture.id} data-alignment-case={fixture.id} className="mb-5 min-w-0">
									{host === "cross-project" ? (
										<CrossProjectRecentlyActiveTaskSwitcherTaskRow
											entryInProject={{ workspaceId: "project-a", projectName: fixture.projectName, entry }}
											section="remaining"
											isFocused={false}
											isUnreadHandoff={false}
											nowMs={nowMs}
											showsProjectName
											currentProjectId="project-a"
											inPlaceExpansionState="compact_row"
											onOpen={() => {}}
											onTogglePinnedToTaskPinboard={() => {}}
										/>
									) : (
										<TaskCardBodyVisualDensityProvider
											value={
												host === "standard"
													? "standard_card_with_floating_capsule"
													: "compact_row_in_focus_view_left_column"
											}
										>
											<TaskCardBody
												card={card}
												columnId="in_progress"
												renderRole={
													host === "expanded"
														? "expanded_card_copy_in_cross_project_task_switcher_row"
														: "task_card_copy_in_post_deploy_verification_panel_entry"
												}
												crossProjectTaskSwitcherRowElementsMergedIntoCardCopy={
													host === "expanded"
														? {
																projectName: fixture.projectName,
																promptCacheWarmthPill: null,
																inListExpansionToggle: null,
																isPresentedAsHoveredFromFirstFrame: false,
															}
														: undefined
												}
											/>
										</TaskCardBodyVisualDensityProvider>
									)}
								</div>
							);
						})}
					</section>
				))}
			</main>
		</TooltipProvider>
	);
}

const mountElement = document.createElement("div");
document.documentElement.style.height = "auto";
document.documentElement.style.overflow = "auto";
document.body.style.height = "auto";
document.body.style.overflow = "visible";
document.body.appendChild(mountElement);
createRoot(mountElement).render(<Harness />);
