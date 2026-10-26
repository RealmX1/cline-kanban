import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TaskEditorDialog } from "../src/components/task-editor-dialog";
import { TaskProjectAssignmentPreflightHost } from "../src/components/task-project-assignment-preflight-host";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins } from "../src/runtime/user-interface-preferences-shared-across-browser-origins-store";
import "../src/styles/globals.css";

startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
function Harness() {
	const [open,setOpen] = useState(true);
	const [prompt,setPrompt] = useState("实现任务编辑器的共享草稿与非模态交互");
	const [plan,setPlan] = useState(true);
	const [backgroundClicks,setBackgroundClicks] = useState(0);
	return <TooltipProvider><main className="min-h-[1800px] p-4 text-text-primary">
		<button type="button" className="fixed bottom-2 left-2 rounded bg-surface-3 p-3" onClick={() => setBackgroundClicks((value) => value+1)}>操作背景 {backgroundClicks}</button>
		<input aria-label="背景输入" className="fixed bottom-2 right-2 w-36 bg-surface-3 p-3" />
		{!open ? <button type="button" onClick={() => setOpen(true)}>重新打开编辑器</button> : null}
		<TaskProjectAssignmentPreflightHost />
		<Toaster />
		<TaskEditorDialog open={open} onOpenChange={setOpen} prompt={prompt} onPromptChange={setPrompt} images={[]} onImagesChange={() => {}} onCreate={() => { document.body.dataset.taskEditorSubmissionCount = String(Number(document.body.dataset.taskEditorSubmissionCount ?? 0) + 1); return null; }} onCreateMultiple={() => []}
			startInPlanMode={plan} onStartInPlanModeChange={setPlan} taskAgentPermissionMode="ask_for_every_tool_use" onTaskAgentPermissionModeChange={() => {}}
			taskConversationMode="operational" onTaskConversationModeChange={() => {}} autoReviewEnabled={false} onAutoReviewEnabledChange={() => {}} autoReviewMode="commit" onAutoReviewModeChange={() => {}}
			workspaceId="isolated-task-editor-project" branchRef="main" branchOptions={[{value:"main",label:"main"}]} onBranchRefChange={() => {}} worktreeMode="branch" onWorktreeModeChange={() => {}}
			agents={[]} defaultAgentId="codex" taskCreationTargetProjectField={{taskCreationTargetProjectFieldPresentation:"target_project_selectable_in_board_scope",selectedTargetWorkspaceId:"isolated-task-editor-project",selectableProjects:[{workspaceId:"isolated-task-editor-project",projectName:"隔离测试项目"}],onSelectTargetWorkspaceId:() => {}}}
		/>
	</main></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
