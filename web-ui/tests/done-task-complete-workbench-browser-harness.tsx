import { DragDropContext } from "@hello-pangea/dnd";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardColumn } from "../src/components/board-column";
import { CardDetailView } from "../src/components/card-detail-view";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { buildStandardRelationNeighborhoodSummaryResponseForTest } from "../src/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";
import { LayoutCustomizationsProvider } from "../src/resize/layout-customizations";
import type { RuntimeExploratoryFindingEntry, RuntimeQueuedTaskPromptDeliveryProjection, RuntimeTaskSessionSummary } from "../src/runtime/types";
import { replaceQueuedTaskPromptDeliveryProjections, resetQueuedTaskPromptDeliveryProjectionsForWorkspace } from "../src/stores/queued-task-prompt-delivery-projection-store";
import type { BoardCard, BoardColumn as BoardColumnModel, CardSelection } from "../src/types";
import "../src/styles/globals.css";

const workspaceId = "workspace-current-project";
const card: BoardCard = { id: "abc12", title: "已完成任务工作台", prompt: "原始任务需求仍可查看", agentId: "codex", mainTaskConversationSessionId: "main-after-handover", startInPlanMode: false, baseRef: "main", createdAt: 1_000, updatedAt: 2_000 };
const otherCard: BoardCard = { ...card, id: "second-done-task", title: "记录缺失的完成任务", mainTaskConversationSessionId: undefined };
const column: BoardColumnModel = { id: "trash", title: "Done", cards: [card, otherCard] };
const findings: RuntimeExploratoryFindingEntry[] = ["main-after-handover", "side-session"].map((sessionId) => ({
	findingId: `finding-${sessionId}`, findingTitle: `${sessionId} 保存的结论`, findingBodyMarkdown: "已完成会话保留的结论正文",
	findingStatus: "active", supersededByFindingId: null, findingGenerationSource: "user_saved",
	provenanceLinks: [{ linkKind: "turn_anchor", conversationSessionTaskId: sessionId, turnNumber: 1, turnCheckpointCommit: null }],
	originConversationSessionTaskId: sessionId, createdAt: 1, updatedAt: 1,
}));
function summary(taskId: string, workspaceTaskId: string, role: "main" | "by_the_way"): RuntimeTaskSessionSummary {
	return { taskId, agentId: "codex", state: "awaiting_review", turnOwner: "user", liveness: "exited", userTurnKind: "review",
		workspacePath: "/isolated/deleted-task-worktree", pid: null, startedAt: 1, updatedAt: 2, lastOutputAt: 2,
		reviewReason: null, exitCode: 0, lastHookAt: null, latestHookActivity: null,
		taskConversationSessionMetadata: { workspaceTaskId, taskConversationSessionRole: role,
			taskConversationSessionContextSource: role === "main" ? "main" : "started_from_scratch",
			parentTaskConversationSessionId: role === "main" ? null : "main-after-handover", mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null, latestUserMessagePreview: role === "main" ? "主会话" : "侧会话历史" } };
}
const sessions = {
	"main-after-handover": summary("main-after-handover", card.id, "main"),
	"side-session": summary("side-session", card.id, "by_the_way"),
	"second-done-task": summary(otherCard.id, otherCard.id, "main"),
};
const queued: RuntimeQueuedTaskPromptDeliveryProjection = {
	queueEntryId: "done-prompt", taskId: "main-after-handover", deliveryState: "queued", textPreview: "完成任务保留的队列正文",
	textLength: 14, deliverTogetherWithNextQueuedEntry: false, dispatchBlockReason: "awaiting_human_reconfirmation_after_runtime_restart",
	awaitsHumanReconfirmationAfterRuntimeRestart: true, deliveryAttemptCount: 0, lastDeliveryFailureNote: null,
	sourcePromptLibraryEntryId: null, sourcePromptLibraryEntryTextChangedSinceEnqueue: null, enqueuedAt: 1, expiresAt: 9999999999999, settledAt: null,
};
resetQueuedTaskPromptDeliveryProjectionsForWorkspace(workspaceId);
replaceQueuedTaskPromptDeliveryProjections(workspaceId, { "main-after-handover": [queued] });
Object.assign(window, { doneWorkbenchReadResponses: {
	"runtime.getWorkspacePromptLibrary": { ok: true, library: { globalScopedPrompts: [], repoScopedPrompts: [
		{ id: "command", text: "已保存的 Commands 内容", scope: "repo", entryKind: "reusable_command", createdAt: 1, updatedAt: 1 },
	], taskScopedPromptsByTaskId: {
		"main-after-handover": [{ id: "prompt", text: "主会话保存的 Prompt 正文", scope: "task", createdAt: 1, updatedAt: 1 }],
		"side-session": [{ id: "side-prompt", text: "侧会话保存的 Prompt 正文", scope: "task", createdAt: 1, updatedAt: 1 }],
		"second-done-task": [{ id: "other-prompt", text: "日志缺失也保留工作台资产", scope: "task", createdAt: 1, updatedAt: 1 }],
	} } },
	"workUnit.getRelationNeighborhoodSummary": buildStandardRelationNeighborhoodSummaryResponseForTest(),
	"runtime.getTaskPromptDeliveryQueue": { ok: true, queue: { entriesByTaskId: { "main-after-handover": [{ ...queued, text: queued.textPreview }] } } },
} });

function Harness() {
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(new URLSearchParams(location.search).get("task"));
	const selected = column.cards.find((entry) => entry.id === selectedTaskId);
	const selection: CardSelection | null = selected ? { card: selected, column, allColumns: [column] } : null;
	return <main className="flex h-dvh flex-col overflow-hidden bg-surface-0 text-text-primary">
		{selection ? <>
			<header className="flex h-10 shrink-0 gap-3 px-3"><button type="button" onClick={() => setSelectedTaskId(null)}>返回 Done 看板</button></header>
			<CardDetailView selection={selection} currentProjectId={workspaceId} workspacePath="/isolated/main-repository"
				selectedAgentId="codex" sessionSummary={sessions[(selected.mainTaskConversationSessionId ?? selected.id) as keyof typeof sessions]}
				exploratoryFindings={findings} explorationThreadGraph={{ queryPhase: "ready", view: null, turnSourceUnavailableSessionIds: [] }}
				taskSessions={sessions} taskIdsOnBoard={new Set(column.cards.map((entry) => entry.id))}
				onSessionSummary={() => {}} onCardSelect={setSelectedTaskId} onTaskDragEnd={() => {}} onMoveToTrash={() => {}}
				bottomTerminalOpen={false} bottomTerminalTaskId={null} bottomTerminalSummary={null} onBottomTerminalClose={() => {}}
			/> </> : <DragDropContext onDragEnd={() => {}}><BoardColumn column={column} taskSessions={sessions} onCardClick={(entry) => setSelectedTaskId(entry.id)} /></DragDropContext>}
	</main>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(
	<TooltipProvider><LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={() => {}}>
		<TaskCommentsDialogProvider currentWorkspaceId={workspaceId}><Harness /></TaskCommentsDialogProvider>
	</LayoutCustomizationsProvider></TooltipProvider>,
);
