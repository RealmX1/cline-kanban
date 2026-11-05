import { ExpandedForegroundViewSurface } from "../src/expanded-foreground-view/expanded-foreground-view-surface";
import { useExpandedForegroundViewSurface } from "../src/expanded-foreground-view/use-expanded-foreground-view-surface";
import * as Select from "@radix-ui/react-select";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SaveFindingDialog } from "../src/components/findings/save-finding-dialog";
import { hostNonModalFloatingForm } from "../src/components/host-non-modal-floating-form";
import { NonModalFloatingFormWindowHostProvider } from "../src/components/non-modal-floating-form-window-host-provider";
import { TaskEditorDialog } from "../src/components/task-editor-dialog";
import { Button } from "../src/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../src/components/ui/dialog";
import { NonModalFormDialog } from "../src/components/ui/non-modal-form-dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useFormPrimaryActionSubmitKeyboardShortcut } from "../src/hooks/use-form-primary-action-submit-keyboard-shortcut";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

function Form({ workspaceId, onClose }: { workspaceId: string; onClose: () => void; open: boolean; requestSequence: number }) {
	const [text, setText] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const [choice, setChoice] = useState("第一项");
	const [confirmationOpen, setConfirmationOpen] = useState(false);
	const [saved, setSaved] = useState(0);
	const submit = () => setSaved((value) => value + 1);
	const onKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({ onSubmit: submit });
	return <>
		<NonModalFormDialog open onOpenChange={(open) => { if (!open) onClose(); }} onKeyDown={onKeyDown} contentClassName="max-w-2xl">
			<DialogHeader title="填写表单" />
			<DialogBody className="space-y-4" >
				<textarea aria-label={`草稿 ${workspaceId}`} value={text} onChange={(event) => setText(event.target.value)} className="w-full border bg-surface-2 p-2" rows={5} />
				<label className="block">添加附件<input type="file" aria-label={`附件 ${workspaceId}`} onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /></label>
				<output>附件：{files.map((file) => file.name).join(",")}</output>
				<Select.Root value={choice} onValueChange={setChoice}>
					<Select.Trigger className="block rounded bg-surface-3 p-2" aria-label="嵌套选项"><Select.Value /></Select.Trigger>
					<Select.Portal><Select.Content className="z-50 rounded bg-surface-2 p-3"><Select.Viewport>
						{["第一项", "第二项"].map((value) => <Select.Item key={value} value={value}><Select.ItemText>{value}</Select.ItemText></Select.Item>)}
					</Select.Viewport></Select.Content></Select.Portal>
				</Select.Root>
				<Button onClick={() => setConfirmationOpen(true)}>确认操作</Button>
				<output aria-label={`保存次数 ${workspaceId}`}>{saved}</output>
				{Array.from({ length: 30 }, (_, index) => <p key={index} className="py-2">可滚动的填写说明 {index + 1}</p>)}
			</DialogBody>
			<DialogFooter><Button onClick={submit}>保存表单</Button></DialogFooter>
		</NonModalFormDialog>
		<Dialog open={confirmationOpen} onOpenChange={setConfirmationOpen}><DialogHeader title="确认操作" /><DialogBody>需要明确确认的操作仍使用模态窗口。</DialogBody><DialogFooter><Button onClick={() => setConfirmationOpen(false)}>返回填写</Button></DialogFooter></Dialog>
	</>;
}

const FormEntry = hostNonModalFloatingForm(Form, {
	formKind: "browser-form",
	isOpen: (props) => props.open,
	instanceIdentity: (props) => props.workspaceId,
	openingRequestIdentity: (props) => props.requestSequence,
	ownership: (props) => ({ workspaceId: props.workspaceId, taskId: props.workspaceId === "project-a" ? "a1b2c" : "d3e4f", taskIncarnationCreatedAtEpochMs: 100 }),
	withClose: (props, close) => ({ ...props, onClose: close }),
	onClosed: (props) => props.onClose(),
});

function Entrypoints({ workspaceId }: { workspaceId: string }) {
	const [open, setOpen] = useState(false);
	const [requestSequence, setRequestSequence] = useState(0);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editorRequest, setEditorRequest] = useState<symbol>();
	const [findingOpen, setFindingOpen] = useState(false);
	const card: BoardCard = { id: workspaceId === "project-a" ? "a1b2c" : "d3e4f", title: `${workspaceId}的任务`, prompt: `${workspaceId}的原始需求`, createdAt: workspaceId === "project-a" ? 100 : 200, updatedAt: 100, startInPlanMode: true, baseRef: "main" };
	return <>
		<div className="fixed bottom-12 left-2 z-10 flex gap-1 text-xs">
			<Button onClick={() => { setOpen(true); setRequestSequence((sequence) => sequence + 1); }}>打开填写表单</Button>
			<Button onClick={() => { setEditorOpen(true); setEditorRequest(Symbol()); }}>编辑任务</Button>
			<Button onClick={() => setFindingOpen(true)}>保存 Finding</Button>
		</div>
		<FormEntry workspaceId={workspaceId} open={open} requestSequence={requestSequence} onClose={() => setOpen(false)} />
		{findingOpen && <SaveFindingDialog workspaceId={workspaceId} conversationSessionTaskId={card.id} anchor={null} initialBodyMarkdown={`${workspaceId} 的发现`} existingFindings={[]} onClose={() => setFindingOpen(false)} />}
		<TaskEditorDialog open={editorOpen} openingRequestIdentity={editorRequest} onOpenChange={setEditorOpen}
			taskEditorMode="edit" editingTaskId={card.id} editingTaskSnapshot={card} editingTaskName={card.title}
			workspaceId={workspaceId} editorSessionWorkspaceId={workspaceId} prompt={card.prompt} onPromptChange={() => {}} images={[]} onImagesChange={() => {}}
			onCreate={() => null} onCreateMultiple={() => []} startInPlanMode onStartInPlanModeChange={() => {}}
			taskAgentPermissionMode="ask_for_every_tool_use" onTaskAgentPermissionModeChange={() => {}}
			taskConversationMode="operational" onTaskConversationModeChange={() => {}} autoReviewEnabled={false} onAutoReviewEnabledChange={() => {}} autoReviewMode="commit" onAutoReviewModeChange={() => {}}
			branchRef="main" branchOptions={[{ value: "main", label: "main" }]} onBranchRefChange={() => {}} worktreeMode="branch" onWorktreeModeChange={() => {}}
			agentId="codex" defaultAgentId="codex" agents={[]} onAgentIdChange={() => {}}
		/>
	</>;
}

function Harness() {
	const surface = useExpandedForegroundViewSurface(null);
	const [workspaceId, setWorkspaceId] = useState("project-a");
	return <TooltipProvider><NonModalFloatingFormWindowHostProvider>
		<ExpandedForegroundViewSurface controller={surface} title="背景展开视图"><main className="min-h-[2000px] bg-surface-0 text-text-primary">
			<Button className="fixed bottom-0 right-2 z-10" onClick={surface.open}>展开背景视图</Button>
			<p className="p-3">当前背景：{workspaceId}</p>
			<div className="fixed bottom-0 left-2 z-10 flex gap-2 p-1 text-xs">
				<Button onClick={() => setWorkspaceId((current) => current === "project-a" ? "project-b" : "project-a")}>切换背景项目</Button>
				<input aria-label="背景可编辑输入" className="w-28 bg-surface-3 p-2" />
			</div>
			<Entrypoints key={workspaceId} workspaceId={workspaceId} />
		</main></ExpandedForegroundViewSurface>
	</NonModalFloatingFormWindowHostProvider></TooltipProvider>;
}

createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
