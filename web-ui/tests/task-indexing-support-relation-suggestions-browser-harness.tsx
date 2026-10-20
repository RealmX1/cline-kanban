import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReferenceRelationModelingEditor } from "../src/components/detail-panels/reference-relation-modeling-editor";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useReferenceRelationModelingEditor } from "../src/hooks/use-reference-relation-modeling-editor";
import "../src/styles/globals.css";

function Harness() {
	const [existingTask, setExistingTask] = useState(false);
	const [prompt, setPrompt] = useState("完整需求：修复同一问题");
	const taskId = existingTask ? "current-task" : null;
	const controller = useReferenceRelationModelingEditor({ workspaceId: "isolated-project", taskId, draftTaskTitle: "关系建议验收", draftTaskPrompt: prompt });
	return <main className="min-h-dvh bg-surface-0 p-4 text-text-primary">
		<button type="button" onClick={() => setExistingTask((value) => !value)}>切换任务模式</button>
		<label className="block">当前需求<textarea aria-label="当前需求" className="block w-full bg-surface-2" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
		<p role="status">{existingTask ? "已有任务" : "创建中的任务"}，草稿 {controller.draft.referenceRelationDrafts.length} 条</p>
		<ReferenceRelationModelingEditor controller={controller} workspaceId="isolated-project" taskId={taskId} />
	</main>;
}

createRoot(document.body.appendChild(document.createElement("div"))).render(<TooltipProvider><Harness /></TooltipProvider>);
