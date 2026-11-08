import { SideSessionCreationWorkbench } from "../src/components/side-session-creation-workbench";
import { TaskConversationSessionsPanel } from "../src/components/detail-panels/task-conversation-sessions-panel";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TaskEditorDialog } from "../src/components/task-editor-dialog";
import { TaskProjectAssignmentPreflightHost } from "../src/components/task-project-assignment-preflight-host";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins } from "../src/runtime/user-interface-preferences-shared-across-browser-origins-store";
import type { RuntimeTaskTerminalAgentModelOverrideSettings } from "../src/runtime/types";
import "../src/styles/globals.css";

startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
const hostTask = { id: "abcde", title: "固定宿主任务", prompt: "宿主任务正文", startInPlanMode: true, baseRef: "main", createdAt: 1, updatedAt: 1 };
const mainSession = { taskId: "abcde", agentId: "codex", workspacePath: "/isolated/project-a/task", startedAt: 1, updatedAt: 1, pid: 1, state: "awaiting_review", turnOwner: "user", userTurnKind: "review", liveness: "live", lastOutputAt: null, reviewReason: null, exitCode: null, agentNativeConversationSessionIdentity: { sourceAgentId: "codex", nativeSessionId: "main-native", transcriptPath: null, observedAt: 1 } } as RuntimeTaskSessionSummary;
function Harness() {
	const [open,setOpen] = useState(true);
	const [prompt,setPrompt] = useState("实现任务编辑器的共享草稿与非模态交互");
	const [taskDescription,setTaskDescription] = useState("");
	const [plan,setPlan] = useState(true);
	const [backgroundClicks,setBackgroundClicks] = useState(0);
	const [reasoningEffort, setReasoningEffort] = useState<string | undefined>();
	const [modelOverride, setModelOverride] = useState<RuntimeTaskTerminalAgentModelOverrideSettings | undefined>();
	return <TooltipProvider><main className="min-h-[1800px] p-4 text-text-primary">
		<button type="button" className="fixed bottom-2 left-2 rounded bg-surface-3 p-3" onClick={() => setBackgroundClicks((value) => value+1)}>操作背景 {backgroundClicks}</button>
		<input aria-label="背景输入" className="fixed bottom-2 right-2 w-36 bg-surface-3 p-3" />
		{!open ? <button type="button" onClick={() => setOpen(true)}>重新打开编辑器</button> : null}
		<div className="fixed left-2 top-2 w-64"><TaskConversationSessionsPanel workspaceId="isolated-task-editor-project" taskCard={hostTask} workspaceTaskId="abcde" mainSessionSummary={mainSession} mainSessionUserMessagePreview="宿主任务正文" mainSessionOriginalPromptCard={hostTask} effectiveAgentId="codex" taskSessions={{ abcde: mainSession }} selectedTaskConversationSessionId="abcde" onSelectTaskConversationSession={() => undefined} onCreateTaskConversationSession={async () => ({ ok: true })} /></div>
		<SideSessionCreationWorkbench />
		<TaskProjectAssignmentPreflightHost />
		<Toaster />
		<TaskEditorDialog open={open} onOpenChange={setOpen} prompt={prompt} onPromptChange={setPrompt} images={[]} onImagesChange={() => {}} onCreate={() => { document.body.dataset.taskEditorSubmissionCount = String(Number(document.body.dataset.taskEditorSubmissionCount ?? 0) + 1); return null; }} onCreateAndStart={() => null} onCreateStartAndOpen={() => null} onCreateMultiple={() => []}
			codexReasoningEffortOverride={reasoningEffort} onCodexReasoningEffortOverrideChange={setReasoningEffort}
			taskDescription={taskDescription} onTaskDescriptionChange={setTaskDescription}
			terminalAgentModelOverrideSettings={modelOverride} onTerminalAgentModelOverrideSettingsChange={setModelOverride}
			startInPlanMode={plan} onStartInPlanModeChange={setPlan} taskAgentPermissionMode="ask_for_every_tool_use" onTaskAgentPermissionModeChange={() => {}}
			taskConversationMode="operational" onTaskConversationModeChange={() => {}} autoReviewEnabled={false} onAutoReviewEnabledChange={() => {}} autoReviewMode="commit" onAutoReviewModeChange={() => {}}
			taskEditorMode={new URLSearchParams(location.search).get("mode") === "edit" ? "edit" : "create"} editingTaskId={new URLSearchParams(location.search).get("mode") === "edit" ? "ed150" : null}
 workspaceId="isolated-task-editor-project" branchRef="main" branchOptions={[{value:"main",label:"main"}]} onBranchRefChange={() => {}} worktreeMode="branch" onWorktreeModeChange={() => {}}
			agents={[]} agentId="codex" onAgentIdChange={() => {}} onClineSettingsChange={() => {}} defaultAgentId="codex" taskCreationTargetProjectField={{taskCreationTargetProjectFieldPresentation:"target_project_selectable_in_board_scope",selectedTargetWorkspaceId:"isolated-task-editor-project",selectableProjects:[{workspaceId:"isolated-task-editor-project",projectName:"隔离测试项目"}],onSelectTargetWorkspaceId:() => {}}}
		/>
	</main></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
