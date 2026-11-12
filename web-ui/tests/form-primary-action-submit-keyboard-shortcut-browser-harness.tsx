import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AddProjectDialog } from "../src/components/add-project-dialog";
import { DiffViewerPanel } from "../src/components/detail-panels/diff-viewer-panel";
import { ReferenceRelationModelingEditor } from "../src/components/detail-panels/reference-relation-modeling-editor";
import { WorkUnitRelationAddReferenceRelationDialog } from "../src/components/detail-panels/work-unit-relation-add-reference-relation-dialog";
import { DirectoryAutocomplete } from "../src/components/directory-autocomplete";
import { PasscodeGate } from "../src/components/passcode-gate";
import { TaskPromptComposer } from "../src/components/task-prompt-composer";
import { Dialog, DialogBody, DialogHeader } from "../src/components/ui/dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useFormPrimaryActionSubmitKeyboardShortcut } from "../src/hooks/use-form-primary-action-submit-keyboard-shortcut";
import { useReferenceRelationModelingEditor } from "../src/hooks/use-reference-relation-modeling-editor";
import "../src/styles/globals.css";

function NestedRelationEditor() {
	const controller = useReferenceRelationModelingEditor({ workspaceId: "isolated-shortcut-workspace", taskId: "source-task" });
	return <ReferenceRelationModelingEditor controller={controller} workspaceId="isolated-shortcut-workspace" taskId="source-task" presentation="task_editor" />;
}

function Harness() {
	const [outerSubmissions, setOuterSubmissions] = useState(0);
	const [innerSubmissions, setInnerSubmissions] = useState(0);
	const [diffActions, setDiffActions] = useState(0);
	const [value, setValue] = useState("");
	const [innerValue, setInnerValue] = useState("");
	const [path, setPath] = useState("/project");
	const [disabled, setDisabled] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(true);
	const [assertionOpen, setAssertionOpen] = useState(true);
	const [assertions, setAssertions] = useState(0);
	const handleOuterKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({ onSubmit: () => setOuterSubmissions((count) => count + 1), disabled });
	const handleInnerKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({ onSubmit: () => setInnerSubmissions((count) => count + 1), disabled });
	const view = new URLSearchParams(location.search).get("view");
	return <TooltipProvider><main className="min-h-dvh bg-surface-0 p-4 text-text-primary">
		<output aria-label="宿主提交次数">{outerSubmissions}</output>
		<output aria-label="子表单提交次数">{innerSubmissions}</output>
		<output aria-label="Diff 动作次数">{diffActions}</output>
		<output aria-label="关系写入次数">{assertions}</output>
		{view === "unlock" ? <PasscodeGate onAuthenticated={() => setOuterSubmissions((count) => count + 1)} /> : view === "projects" ?
			<AddProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} onProjectAdded={() => setOuterSubmissions((count) => count + 1)} currentProjectId="isolated-shortcut-workspace" registeredProjectPaths={new URLSearchParams(location.search).has("prefill") ? ["/isolated/projects/one", "/elsewhere/other", "/isolated/projects/two"] : undefined} /> : view === "assertion" ?
			<div onKeyDown={handleOuterKeyDown}><WorkUnitRelationAddReferenceRelationDialog isAddReferenceRelationDialogOpen={assertionOpen} onAddReferenceRelationDialogOpenChange={setAssertionOpen} subjectKanbanBoardCardWorkspaceId="isolated-shortcut-workspace" subjectKanbanBoardCardTaskId="source-task" onReferenceRelationAssertionWriteSucceeded={() => { setAssertions((count) => count + 1); setAssertionOpen(false); }} /></div> : <>
			<div tabIndex={-1} aria-label="Diff 快捷键目标">
				<DiffViewerPanel workspaceFiles={[]} selectedPath={null} onSelectedPathChange={() => {}} onAddToTerminal={() => setDiffActions((count) => count + 1)} onCommentsChange={() => {}} comments={new Map([["example.ts:added:1", { filePath: "example.ts", lineNumber: 1, lineText: "const value = 1;", variant: "added", comment: "核验 Diff 快捷键" }]])} />
			</div>
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen} onKeyDown={handleOuterKeyDown} contentClassName="max-w-3xl">
				<DialogHeader title="宿主表单" />
				<DialogBody>
					{view === "relations" ? <NestedRelationEditor /> : <>
						<label><input type="checkbox" checked={disabled} onChange={(event) => setDisabled(event.target.checked)} />禁用提交</label>
						<TaskPromptComposer value={value} onValueChange={setValue} aria-label="宿主表单正文" showAttachImageButton={false} showPseudoHtmlBlockInsertButton={false} />
						<DirectoryAutocomplete value={path} onChange={setPath} workspaceId="isolated-shortcut-workspace" id="shortcut-directory" ariaLabel="目录补全" />
						<div onKeyDown={handleInnerKeyDown}>
							<TaskPromptComposer value={innerValue} onValueChange={setInnerValue} aria-label="子表单正文" showAttachImageButton={false} showPseudoHtmlBlockInsertButton={false} />
						</div>
						<Popover.Root><Popover.Trigger>打开 Portal 选择器</Popover.Trigger><Popover.Portal><Popover.Content className="z-[60] bg-surface-2 p-4"><input aria-label="Portal 选择器输入" /></Popover.Content></Popover.Portal></Popover.Root>
					</>}
				</DialogBody>
			</Dialog>
		</>}
	</main></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
