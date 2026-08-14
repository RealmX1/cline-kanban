// 编辑任务对话框顶部的草稿通知栏。
//
// 它兑现两件在此之前**数据都在、用户却看不到**的事：
//
// ① 打开编辑对话框时，表单会被这张卡片的未保存草稿静默覆盖每一个字段。用户看到的是草稿，却以为看到
//    的是任务本体，界面上没有任何提示，也没有改回去的退路。
// ② 两个 origin（换端口、换浏览器）的同一份草稿在服务端合并时，savedAt 旧的那份不丢，会转存为
//    `supersededDraftCopies`。服务端一直在如实留存，但前端零消费——数据没丢，用户不知道它存在，
//    效果等同于丢。
//
// 为什么入口是这里、不新开面板或设置页：副本天然按 taskId 归属，而「用户此刻正关心这个任务的文本」
// 唯一确定的时刻就是他打开了这张卡片的编辑框。做成独立抽屉只会变成第二个没人点开的地方。
//
// 不可让步的语义（服务端那半边见 src/state/task-edit-draft-store.ts）：
//   - 「Discard」是副本唯一的删除路径，且必须由用户显式点击。副本绝不因为超时、因为任务被编辑过、
//     因为它「看起来旧」而自动过期。
//   - 「Use this one」不是丢弃：被换下来的那份当前草稿由服务端按同一规则再进副本。
//   - 展开的对照是**只读**的，不做三方合并——两个 origin 的时钟本来就不可比，这里没有可信的自动
//     合并判据，正文只能靠人眼比。

import { AlertTriangle, ChevronDown, ChevronUp, FileClock } from "lucide-react";
import { type ReactElement, useRef, useState, useSyncExternalStore } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import type { TaskEditDraft } from "@/hooks/task-edit-drafts";
import {
	discardSupersededTaskEditDraftCopy,
	promoteSupersededTaskEditDraftCopyToCurrentDraft,
	readSupersededTaskEditDraftCopiesFromStore,
	saveTaskEditDraftToStoreWaitingForServerAcknowledgement,
	subscribeToTaskEditDraftStore,
} from "@/runtime/task-edit-draft-store";
import type { RuntimeSupersededTaskEditDraftCopy } from "@/runtime/types";

/** 表单此刻的值，用来给只读对照标出「这份副本与你眼前这份差在哪」。 */
export type TaskEditDraftComparableValues = Omit<TaskEditDraft, "taskId" | "savedAt">;

// useSyncExternalStore 的 getSnapshot 必须在无变化时返回引用相等的值，否则直接进渲染死循环。
const NO_SUPERSEDED_DRAFT_COPIES: RuntimeSupersededTaskEditDraftCopy[] = [];

// 绝对时间而不是「3 分钟前」：用户要用它回答的是「这份草稿是不是我刚才写的那一份」，而相对时间一旦
// 渲染出来就不再刷新，停留几分钟后自己就成了一条错误信息。
function formatDraftTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) {
		return "unknown time";
	}
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function areFormValuesEqual(left: TaskEditDraftComparableValues, right: TaskEditDraftComparableValues): boolean {
	return (
		left.prompt === right.prompt &&
		JSON.stringify(left.images) === JSON.stringify(right.images) &&
		areSettingsEqual(left, right)
	);
}

function areSettingsEqual(left: TaskEditDraftComparableValues, right: TaskEditDraftComparableValues): boolean {
	return (
		left.startInPlanMode === right.startInPlanMode &&
		left.taskAgentPermissionMode === right.taskAgentPermissionMode &&
		left.autoReviewEnabled === right.autoReviewEnabled &&
		left.autoReviewMode === right.autoReviewMode &&
		left.branchRef === right.branchRef &&
		left.worktreeMode === right.worktreeMode &&
		left.agentId === right.agentId &&
		JSON.stringify(left.clineSettings ?? null) === JSON.stringify(right.clineSettings ?? null) &&
		JSON.stringify(left.terminalAgentModelOverrideSettings ?? null) ===
			JSON.stringify(right.terminalAgentModelOverrideSettings ?? null) &&
		JSON.stringify(left.taskAgentSessionInitialization ?? null) ===
			JSON.stringify(right.taskAgentSessionInitialization ?? null)
	);
}

function SupersededDraftCopyComparison({
	copy,
	currentFormValues,
}: {
	copy: RuntimeSupersededTaskEditDraftCopy;
	currentFormValues: TaskEditDraftComparableValues;
}): ReactElement {
	const imagesDiffer = JSON.stringify(copy.draft.images) !== JSON.stringify(currentFormValues.images);
	const settingsDiffer = !areSettingsEqual(copy.draft, currentFormValues);
	return (
		<div className="mt-2 space-y-2 rounded border border-border-bright bg-surface-1 p-2">
			<div className="text-[11px] text-text-tertiary">
				Superseded on {formatDraftTimestamp(copy.supersededAt)} by a draft saved{" "}
				{formatDraftTimestamp(copy.supersededBySavedAt)}
			</div>
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 text-xs text-text-primary">
				{copy.draft.prompt === "" ? "(empty prompt)" : copy.draft.prompt}
			</pre>
			<div className="flex flex-wrap gap-3 text-[11px] text-text-secondary">
				<span>
					Images: {copy.draft.images.length}
					{imagesDiffer ? " · differs from current" : " · same as current"}
				</span>
				<span>Settings: {settingsDiffer ? "differ from current" : "same as current"}</span>
			</div>
		</div>
	);
}

export function TaskEditDraftRecoveryNotice({
	workspaceId,
	taskId,
	seededFromSavedDraftAt,
	currentFormValues,
	onRevertToSavedTaskContent,
	onSupersededCopyPromotedToCurrentDraft,
}: {
	workspaceId: string | null;
	taskId: string;
	seededFromSavedDraftAt: number | null;
	currentFormValues: TaskEditDraftComparableValues;
	onRevertToSavedTaskContent: () => void;
	/** 提升成功后把表单重铺成这份草稿。不接这一条，用户点完按钮眼前一切照旧。 */
	onSupersededCopyPromotedToCurrentDraft: (promotedDraft: TaskEditDraft) => void;
}): ReactElement | null {
	const supersededDraftCopies = useSyncExternalStore(subscribeToTaskEditDraftStore, () =>
		workspaceId === null
			? NO_SUPERSEDED_DRAFT_COPIES
			: readSupersededTaskEditDraftCopiesFromStore(workspaceId, taskId),
	);
	const [expandedCopySavedAt, setExpandedCopySavedAt] = useState<number | null>(null);
	const [copySavedAtWithActionInFlight, setCopySavedAtWithActionInFlight] = useState<number | null>(null);

	// 这张卡片被打开编辑那一刻，表单里是什么。用来回答「用户在这之后动过表单没有」：
	// 动过 = 表单里有一份服务端此刻可能还没收到的原创内容（草稿写盘去抖 400ms，prompt 还要等失焦才
	// 上抛到父层），而「Use this one」会当场把它换掉。没动过则不必写：那份内容要么已经是服务端的当前
	// 草稿，要么就是任务本体本身——凭空存一份反而会给用户造出一条得手动清掉的假副本。
	const formValuesWhenEditingThisTaskStartedRef = useRef(currentFormValues);
	const taskIdWithFormValuesBaselineCapturedRef = useRef(taskId);
	if (taskIdWithFormValuesBaselineCapturedRef.current !== taskId) {
		taskIdWithFormValuesBaselineCapturedRef.current = taskId;
		formValuesWhenEditingThisTaskStartedRef.current = currentFormValues;
	}

	if (seededFromSavedDraftAt === null && supersededDraftCopies.length === 0) {
		return null;
	}

	// 一次只允许一个动作在途：两条意图都会整体替换服务端快照，并排点两下的结果由响应到达顺序说了算。
	const runCopyAction = async (
		copySavedAt: number,
		action: () => Promise<boolean>,
		failureMessage: string,
	): Promise<void> => {
		if (workspaceId === null || copySavedAtWithActionInFlight !== null) {
			return;
		}
		setCopySavedAtWithActionInFlight(copySavedAt);
		try {
			if (!(await action())) {
				// 静默失败正是这条工作流要根除的东西：副本还在，但用户以为他刚处理掉了。
				showAppToast({ intent: "danger", message: failureMessage }, `task-edit-draft-copy:${taskId}`);
			}
		} finally {
			setCopySavedAtWithActionInFlight(null);
		}
	};

	/**
	 * 把表单此刻的内容先落成「当前草稿」，再发 promote。
	 *
	 * 缺了这一步，「Use this one」就是它自己契约的反例：服务端转存成副本的是**它手上那份**，而用户
	 * 最后敲下的字还停在去抖窗口里（prompt 更是要等失焦才上抛）。promote 成功后表单被重铺成提升上来
	 * 的那份，那些字既不在当前草稿、也不在副本里——静默丢掉。
	 *
	 * 意图在 store 里是按发起顺序串行送达的，所以这一条一定先于 promote 抵达服务端。
	 */
	const persistCurrentFormValuesBeforeTheyAreReplaced = async (): Promise<boolean> => {
		if (workspaceId === null) {
			return false;
		}
		if (areFormValuesEqual(currentFormValues, formValuesWhenEditingThisTaskStartedRef.current)) {
			return true;
		}
		return await saveTaskEditDraftToStoreWaitingForServerAcknowledgement(workspaceId, {
			taskId,
			...currentFormValues,
			savedAt: Date.now(),
		});
	};

	const promoteCopy = async (copySavedAt: number): Promise<boolean> => {
		// 没落定就不要往下走：此时表单还没被重铺，用户敲的字仍在眼前，报一次失败远好过换完才发现丢了。
		if (!(await persistCurrentFormValuesBeforeTheyAreReplaced())) {
			return false;
		}
		const promotedDraft = await promoteSupersededTaskEditDraftCopyToCurrentDraft(
			workspaceId ?? "",
			taskId,
			copySavedAt,
		);
		if (promotedDraft === null) {
			return false;
		}
		formValuesWhenEditingThisTaskStartedRef.current = promotedDraft;
		onSupersededCopyPromotedToCurrentDraft(promotedDraft);
		return true;
	};

	return (
		<div className="mb-3 space-y-2 rounded-md border border-border-bright bg-surface-2 px-3 py-2 text-xs text-text-secondary">
			{seededFromSavedDraftAt !== null ? (
				<div className="flex flex-wrap items-center gap-2">
					<FileClock size={14} className="shrink-0 text-text-tertiary" />
					<span className="flex-1">
						Showing an unsaved draft (saved {formatDraftTimestamp(seededFromSavedDraftAt)}), not the task's saved
						content.
					</span>
					<Button type="button" variant="ghost" size="sm" onClick={onRevertToSavedTaskContent}>
						Revert to saved content
					</Button>
				</div>
			) : null}

			{supersededDraftCopies.map((copy) => {
				const isExpanded = expandedCopySavedAt === copy.draft.savedAt;
				const isActionInFlight = copySavedAtWithActionInFlight === copy.draft.savedAt;
				return (
					<div key={copy.draft.savedAt}>
						<div className="flex flex-wrap items-center gap-2">
							<AlertTriangle size={14} className="shrink-0 text-text-tertiary" />
							<span className="flex-1">
								A draft saved {formatDraftTimestamp(copy.draft.savedAt)} on another browser or port lost the
								merge and was kept aside.
							</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setExpandedCopySavedAt(isExpanded ? null : copy.draft.savedAt)}
							>
								{isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
								{isExpanded ? "Hide" : "View"}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={copySavedAtWithActionInFlight !== null}
								onClick={() =>
									void runCopyAction(
										copy.draft.savedAt,
										async () => await promoteCopy(copy.draft.savedAt),
										"Could not switch to that draft — it is still kept aside, nothing was lost.",
									)
								}
							>
								{isActionInFlight ? "Working…" : "Use this one"}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={copySavedAtWithActionInFlight !== null}
								onClick={() =>
									void runCopyAction(
										copy.draft.savedAt,
										async () =>
											await discardSupersededTaskEditDraftCopy(
												workspaceId ?? "",
												taskId,
												copy.draft.savedAt,
											),
										"Could not discard that draft — it is still kept aside.",
									)
								}
							>
								Discard
							</Button>
						</div>
						{isExpanded ? (
							<SupersededDraftCopyComparison copy={copy} currentFormValues={currentFormValues} />
						) : null}
					</div>
				);
			})}
		</div>
	);
}
