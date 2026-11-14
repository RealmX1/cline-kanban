import { createRoot } from "react-dom/client";
import { FileTreePanel } from "@/components/detail-panels/file-tree-panel";
import { TaskFilesPanel } from "@/components/detail-panels/task-files-panel";
import { TaskMainSessionPlanDownloadButton } from "@/components/detail-panels/task-main-session-plan-download-button";
import { TaskWorkbench } from "@/components/detail-panels/task-workbench";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startTaskFileDownload } from "@/runtime/task-file-download-query";
import "@/styles/globals.css";

declare global {
	interface Window {
		mountTaskFileDownloadsBrowserHarness(workspaceId: string, taskId: string, createdAt: number): void;
	}
}
const root = createRoot(document.body.appendChild(document.createElement("div")));
window.mountTaskFileDownloadsBrowserHarness = (workspaceId, taskId, createdAt) => {
	root.render(<TooltipProvider><div className="flex h-dvh flex-col bg-surface-0 text-text-primary">
		<div className="flex h-10 items-center px-3"><span className="mr-3 text-xs">当前查看协作会话</span><TaskMainSessionPlanDownloadButton workspaceId={workspaceId} taskId={taskId} taskCreatedAtEpochMs={createdAt} /></div>
		<TaskWorkbench defaultSlots={["task_files", "task_sessions"]} isBelowAgent={false} arrangementPreference="agent_left_workbench_right" onArrangementPreferenceChange={() => {}} slotRatio={0.7} onSlotRatioChange={() => {}} modules={{
			task_files: (headerNavigationContent, headerEndActions) => <TaskFilesPanel workspaceId={workspaceId} taskId={taskId} taskCreatedAtEpochMs={createdAt} headerNavigationContent={headerNavigationContent} headerEndActions={headerEndActions} />,
			task_sessions: <><span className="p-2 text-xs">改动文件</span><FileTreePanel workspaceFiles={[{ path: "tracked.txt", status: "modified", additions: 1, deletions: 1, oldText: "旧版", newText: "Diff 的缩略文本" }]} selectedPath={null} onSelectPath={() => {}} onDownloadFile={(path) => void startTaskFileDownload(workspaceId, { taskId, expectedTaskIncarnationCreatedAtEpochMs: createdAt, source: "task_file", path })} /></>,
			cross_task_relations: null, exploration_map: null, prompt_tools: null, task_visualizations: null,
		}} />
	</div></TooltipProvider>);
};
