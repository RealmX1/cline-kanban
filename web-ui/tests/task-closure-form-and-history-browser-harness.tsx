import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskCardBody } from "../src/components/task-card-body";
import { buildTaskCardBusinessProps } from "../src/components/task-card-business-props";
import { TaskCommentBeforeMoveIntoDoneDialog } from "../src/components/task-comment-before-move-into-done-dialog";
import { PostDeployVerificationTaskClosureFormHost } from "../src/components/post-deploy-verification-task-closure-form-host";
import { requestPostDeployVerificationTaskClosureForm } from "../src/state/post-deploy-verification-task-closure-form-request";
import { TaskClosureSummaryAndHistory } from "../src/components/task-closure-summary-and-history";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useTaskCommentBeforeMoveIntoDone } from "../src/hooks/use-task-comment-before-move-into-done";
import type { BoardCard } from "../src/types";
import type { TaskClosureRecord } from "../../src/core/task-closure-contract";
import "../src/styles/globals.css";

function Harness() {
	const controller = useTaskCommentBeforeMoveIntoDone();
	const [result, setResult] = useState("");
	const [record, setRecord] = useState<TaskClosureRecord | undefined>();
	const card: BoardCard = { id: "abc12", title: "结案成果保全测试", prompt: "保留已接受部分", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1, taskClosureSummary: record };
	const props = buildTaskCardBusinessProps({ card, columnId: "validation", handlers: { onMoveToTrashTask: () => controller.open("isolated-closure-workspace", card) }, sessionSummary: undefined, workspacePath: null, defaultAgentId: null, defaultClineModelId: null, onActivateCard: () => {} });
	return <TooltipProvider><main className="min-h-dvh bg-surface-0 p-4 text-text-primary">
		<PostDeployVerificationTaskClosureFormHost />
		<button type="button" onClick={() => { void requestPostDeployVerificationTaskClosureForm("other-project", "abc12", 1).then((comment) => setResult(JSON.stringify(comment?.closure ?? null))); }}>PDV 面板结案其他项目</button>
		<div className="flex max-w-3xl flex-col gap-6 sm:flex-row">
			<section aria-label="主看板宿主" className="min-w-0 flex-1"><TaskCardBody {...props} /></section>
			<section aria-label="Focus View 宿主" className="min-w-0 flex-1"><TaskCardBody {...props} renderRole="focused_card_copy_under_sticky_stage_header" /></section>
		</div>
		{record ? <TaskClosureSummaryAndHistory card={card} workspaceId="isolated-closure-workspace" isClosed /> : null}
		<output aria-label="提交的结案结果" className="block break-all">{result}</output>
		<TaskCommentBeforeMoveIntoDoneDialog controller={controller} onSubmit={(comment, closure) => {
			const prepared = controller.prepareSubmission(comment, closure);
			if (!prepared || !closure) return;
			setResult(JSON.stringify(closure));
			setRecord({ closureRequestId: closure.closureRequestId, taskIdentity: { workspaceId: "isolated-closure-workspace", taskId: "abc12", taskIncarnationCreatedAtEpochMs: 1 }, details: closure.details, recordedAtEpochMs: 2, actor: { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" }, eventKind: "closed", isCurrentlyClosed: true, previousClosureRequestId: null, archiveManifest: { archiveDirectory: "/durable/archive", headCommit: "abc", persistentHeadReference: "refs/kanban/retained", availability: "verified_recoverable", verifiedAtEpochMs: 2, preservedFileCount: 3, selectedArtifactRelativePaths: closure.selectedArtifactRelativePaths } });
			controller.complete("abc12");
		}} />
	</main></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
