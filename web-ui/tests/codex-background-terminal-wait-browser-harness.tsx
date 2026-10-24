import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardCard as DraggableBoardCard } from "../src/components/board-card";
import { CrossProjectRecentlyActiveTaskSwitcherTaskRow } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { MobileFocusedTaskCardHeader } from "../src/components/detail-panels/mobile-focused-task-card-header";
import { buildTaskCardBusinessProps } from "../src/components/task-card-business-props";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useMobileFocusViewIdleCollapseController } from "../src/hooks/use-mobile-focus-view-idle-collapse-controller";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeTaskSessionSummary } from "../src/runtime/types";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const initialNowMs = Date.now();
function Harness() {
	const [nowMs, setNowMs] = useState(initialNowMs);
	const [activityAtMs, setActivityAtMs] = useState(initialNowMs - 10 * 60_000);
	const rootRef = useRef<HTMLDivElement>(null);
	const idleCollapseController = useMobileFocusViewIdleCollapseController({ enabled: false, focusedTaskIdentity: "isolated-background", focusViewRootRef: rootRef });
	const card: BoardCard = { id: "isolated-background", title: "Codex 后台终端等待", prompt: "隔离浏览器回归", agentId: "codex", baseRef: "main", startInPlanMode: false, createdAt: initialNowMs - 3_600_000, updatedAt: initialNowMs };
	const summary: RuntimeTaskSessionSummary = {
		taskId: card.id, agentId: "codex", state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null,
		workspacePath: "/isolated/background-wait", pid: 12, startedAt: initialNowMs - 30 * 60_000, updatedAt: initialNowMs, lastOutputAt: initialNowMs - 10 * 60_000, reviewReason: null, exitCode: null, lastHookAt: null, latestHookActivity: null,
		lastEffectiveAgentConversationActivityObservation: { observedAtMs: activityAtMs, activityKind: "tool_activity", evidenceKind: "persisted_agent_transcript" },
		lastAgentConversationUserHandoffObservation: null,
		currentAgentProcessUserTurnIdleRetentionStarted: null,
	};
	const businessProps = buildTaskCardBusinessProps({ card, columnId: "in_progress", sessionSummary: summary, handlers: {}, workspacePath: "/isolated" });
	const entry: RuntimeCrossProjectTaskSwitcherEntry = {
		...summary, taskId: card.id, title: card.title, createdAt: card.createdAt, agentId: "codex", columnId: "in_progress",
		taskDescriptionLastUpdatedAt: initialNowMs, lastOpenedByUserAt: null, pinnedToTaskPinboardAt: null, taskPinboardPinReason: null,
		isParkedAwaitingDispatchedBackgroundWork: false, lastSubstantiveOutputAt: null, agentResponseGenerationStopped: null, lastConversationProgressObservation: null,
	};
	return <TooltipProvider><div ref={rootRef} className="min-h-screen bg-surface-0 p-4 text-text-primary">
		<div className="mb-6 flex gap-4">
			<button type="button" onClick={() => setNowMs(Date.now())}>仅推进等待时间</button>
			<button type="button" onClick={() => { setActivityAtMs(Date.now()); setNowMs(Date.now()); }}>收到真实工具结果</button>
		</div>
		<div className="flex flex-wrap items-start gap-6">
			<section data-background-wait-host="board" className="w-full max-w-sm"><h2>主看板</h2>
				<DragDropContext onDragEnd={() => {}}><Droppable droppableId="isolated-column">{(provided) => <div ref={provided.innerRef} {...provided.droppableProps}><DraggableBoardCard {...businessProps} index={0} />{provided.placeholder}</div>}</Droppable></DragDropContext>
			</section>
			<section data-background-wait-host="focus" className="w-full max-w-sm"><h2>Focus View</h2><MobileFocusedTaskCardHeader cardBusinessProps={businessProps} stageDisplayName="In Progress" idleCollapseController={idleCollapseController} /></section>
			<section data-background-wait-host="all-projects" className="w-full max-w-sm"><h2>All Projects · Running</h2>
				<CrossProjectRecentlyActiveTaskSwitcherTaskRow entryInProject={{ workspaceId: "isolated", projectName: "隔离项目", entry }} section="running" isFocused={false} isUnreadHandoff={false} nowMs={nowMs} showsProjectName currentProjectId="isolated" inPlaceExpansionState="compact_row" onOpen={() => {}} onTogglePinnedToTaskPinboard={() => {}} />
			</section>
		</div>
	</div></TooltipProvider>;
}
createRoot(document.body).render(<Harness />);
