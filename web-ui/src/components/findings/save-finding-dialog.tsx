// 「存为 finding」表单对话框（蓝图 §D.2.1，v1 人工保存主路径）。
// 由聊天面板按消息打开：正文已按「选区优先、否则消息摘录」预填并截断到契约上限；
// 锚三元由调用方经位置性映射 + 投影解析（不可锚 = null → freeform 降级，绝不伪造锚）。
// 查重提示（§D.3）：规范化标题相等/前缀包含即警告，只提示不阻断（合并入口属 M5）。

import { BookmarkPlus } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	buildSaveFindingProvenance,
	EXPLORATORY_FINDING_BODY_MAX_LENGTH,
	EXPLORATORY_FINDING_TITLE_MAX_LENGTH,
	findSimilarExploratoryFindings,
	type SaveFindingTurnAnchor,
} from "@/components/findings/findings-model";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { saveExploratoryFinding } from "@/runtime/findings-query";
import type { RuntimeExploratoryFindingEntry } from "@/runtime/types";

function createFindingId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return Math.random().toString(36).slice(2, 12);
}

const FINDING_FIELD_CLASS_NAME =
	"w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60";

export function SaveFindingDialog({
	workspaceId,
	conversationSessionTaskId,
	anchor,
	initialBodyMarkdown,
	existingFindings,
	onClose,
}: {
	workspaceId: string;
	conversationSessionTaskId: string;
	// 调用方经 resolveSaveFindingTurnAnchor 解析的结果；null → user_authored_freeform 降级。
	anchor: SaveFindingTurnAnchor | null;
	initialBodyMarkdown: string;
	// 查重比较对象（workspace 级活集合）；未加载到时传空数组（不比较）。
	existingFindings: RuntimeExploratoryFindingEntry[];
	onClose: () => void;
}): ReactElement {
	const [title, setTitle] = useState("");
	const [bodyMarkdown, setBodyMarkdown] = useState(initialBodyMarkdown);
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	// findingId = UI 生成 uuid，作稳定 dedup 键（§D.1）：同一 dialog/draft 生命周期只生成
	// 一次（挂载即 draft 初始化），保存失败后重试必须复用同一 id——服务端 saveFinding
	// 按 id 幂等回现状，首次 mutation 已落盘但响应丢失时换新 id 会落成重复 finding。
	// 组件随 dialog 关闭卸载，重开自然换新 id。
	const [findingId] = useState(() => createFindingId());
	// 首个 save 请求一旦发出即定格载荷快照：此后字段只读、重试恒用首次载荷。「响应
	// 丢失」与「真失败」在 UI 侧不可区分，而服务端幂等是「同 id 已存在 → 忽略新
	// title/body、回旧条目」，成功路径又不读返回内容——若失败后还能改内容再重试，
	// 改动会被服务端幂等吞掉、UI 却提示成功，用户刚改的内容静默丢失。想改内容只能
	// 关掉重开（重开生成新 findingId，即新 draft）。
	const [submissionSnapshot, setSubmissionSnapshot] = useState<{
		findingTitle: string;
		findingBodyMarkdown: string;
	} | null>(null);

	// §D.3 查重：只提示不阻断。随标题输入即时重算（纯函数，集合恒小）。
	const similarFindings = useMemo(
		() => findSimilarExploratoryFindings(existingFindings, title),
		[existingFindings, title],
	);

	const trimmedTitle = title.trim();
	const trimmedBody = bodyMarkdown.trim();
	// 快照已定格后重试只受 isSaving 约束（载荷合法性在首次提交时已校验）。
	const canSave =
		!isSaving &&
		(submissionSnapshot !== null ||
			(trimmedTitle.length > 0 &&
				trimmedTitle.length <= EXPLORATORY_FINDING_TITLE_MAX_LENGTH &&
				trimmedBody.length > 0 &&
				bodyMarkdown.length <= EXPLORATORY_FINDING_BODY_MAX_LENGTH));

	const handleSave = async () => {
		if (!canSave) {
			return;
		}
		// 重试恒用首次快照；首次提交同时定格快照（此后字段只读，理由见 state 注释）。
		const payload = submissionSnapshot ?? {
			findingTitle: trimmedTitle,
			findingBodyMarkdown: trimmedBody,
		};
		if (submissionSnapshot === null) {
			setSubmissionSnapshot(payload);
		}
		setIsSaving(true);
		setSaveError(null);
		try {
			await saveExploratoryFinding(workspaceId, {
				// findingId 复用挂载时生成的稳定值（重试同 id 同载荷）；provenance 自动携带锚三元。
				findingId,
				findingTitle: payload.findingTitle,
				findingBodyMarkdown: payload.findingBodyMarkdown,
				...buildSaveFindingProvenance({ conversationSessionTaskId, anchor }),
			});
			showAppToast({ intent: "success", message: "Finding saved" });
			onClose();
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : String(error));
			setIsSaving(false);
		}
	};

	// 快照定格后字段只读（保存中自然也只读）。
	const fieldsDisabled = isSaving || submissionSnapshot !== null;

	return (
		<Dialog
			open
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !isSaving) {
					onClose();
				}
			}}
		>
			<DialogHeader title="Save as finding" icon={<BookmarkPlus size={15} />} />
			<DialogBody className="flex flex-col gap-3">
				<div className="text-[11px] text-text-tertiary">
					{anchor
						? `Anchored to turn T${anchor.turnNumber} of this session.`
						: "No resolvable turn anchor — saved as a freeform note."}
				</div>
				<div>
					<label htmlFor="save-finding-title" className="mb-1 block text-xs text-text-secondary">
						Title
					</label>
					<input
						id="save-finding-title"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						placeholder="What was learned?"
						maxLength={EXPLORATORY_FINDING_TITLE_MAX_LENGTH}
						disabled={fieldsDisabled}
						className={`${FINDING_FIELD_CLASS_NAME} h-8`}
					/>
				</div>
				<div className="flex min-h-0 flex-1 flex-col">
					<label htmlFor="save-finding-body" className="mb-1 block text-xs text-text-secondary">
						Finding (markdown)
					</label>
					<textarea
						id="save-finding-body"
						value={bodyMarkdown}
						onChange={(event) => setBodyMarkdown(event.target.value)}
						maxLength={EXPLORATORY_FINDING_BODY_MAX_LENGTH}
						disabled={fieldsDisabled}
						rows={8}
						className={`${FINDING_FIELD_CLASS_NAME} min-h-32 resize-y py-1.5`}
					/>
				</div>
				{similarFindings.length > 0 ? (
					<div className="rounded-md border border-status-orange/40 bg-status-orange/10 px-2 py-1.5 text-xs text-status-orange">
						A similar finding already exists: {similarFindings[0]?.findingTitle}
					</div>
				) : null}
				{saveError ? (
					<div className="text-xs text-status-red">
						{saveError}
						{submissionSnapshot !== null ? (
							<div className="mt-1 text-text-tertiary">
								Retry re-sends the original text. Close and reopen the dialog to edit it.
							</div>
						) : null}
					</div>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button onClick={onClose} disabled={isSaving}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={() => {
						void handleSave();
					}}
					disabled={!canSave}
				>
					{isSaving ? (
						<>
							<Spinner size={12} />
							Saving…
						</>
					) : (
						"Save finding"
					)}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
