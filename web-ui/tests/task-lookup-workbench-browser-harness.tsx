import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskLookupWorkbenchView } from "../src/components/task-lookup-workbench-view";
import { TaskSpotlightSearchDialog } from "../src/components/task-spotlight-search-dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useTaskLookupWorkbench } from "../src/hooks/use-task-lookup-workbench";
import { useTaskSpotlightSearchController } from "../src/hooks/use-task-spotlight-search-controller";
import { observeTaskLookupConversationUpdated } from "../src/stores/task-lookup-conversation-update-store";
import "../src/styles/globals.css";

function Harness() {
	const [openedTask, setOpenedTask] = useState<string | null>(null);
	const [streamSnapshotGeneration, setStreamSnapshotGeneration] = useState(1);
	const lookup = useTaskLookupWorkbench({ workspaceId: "isolated-project", includeAllProjectsByDefault: true, streamSnapshotGeneration });
	const openTask = (projectId: string, taskId: string) => setOpenedTask(`${projectId}/${taskId}`);
	const spotlight = useTaskSpotlightSearchController({ board: { columns: [] }, currentProjectId: "isolated-project", currentProjectName: "隔离项目", currentProjectDefaultAgentId: null, taskSessionSummariesByTaskId: {}, canOpen: true, isBoardScopeAllProjectsSelected: true, crossProjectWorkspaceId: "isolated-project", crossProjectExcludeProjectIds: new Set(["isolated-project"]), onOpenTaskInProject: openTask });
	return <main className="flex h-dvh min-w-0 flex-col overflow-hidden bg-surface-0 text-text-primary">
		<div className="flex h-10 shrink-0 gap-3 border-b border-border px-3"><button type="button" onClick={() => lookup.open()}>打开 AI 查卡</button><button type="button" onClick={spotlight.open}>打开 Search</button><button type="button" onClick={() => observeTaskLookupConversationUpdated()}>模拟推流</button><button type="button" onClick={() => setStreamSnapshotGeneration((value) => value + 1)}>模拟重连</button></div>
		<div className="flex min-h-0 flex-1">
			<aside className="hidden w-40 shrink-0 border-r border-border p-3 md:block">当前任务导航</aside>
			{lookup.isOpen ? <TaskLookupWorkbenchView controller={lookup} projects={[{ id: "isolated-project", name: "隔离项目" }]} onOpenTask={openTask} /> : <section className="p-4">原任务 Agent 界面{openedTask ? <p>已打开任务：{openedTask}</p> : null}</section>}
		</div>
		<TaskSpotlightSearchDialog controller={spotlight} onAskTaskLookupAgent={(questionText) => { spotlight.close(); lookup.open({ questionText, scope: { projectIds: [], columnIds: [] } }); }} />
	</main>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<TooltipProvider><Harness /></TooltipProvider>);
