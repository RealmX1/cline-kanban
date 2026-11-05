import { useRef, useState } from "react";
import {
	createTaskClosureFormDraft,
	resolveTaskClosureFormDetails,
	TaskClosureFormFields,
} from "@/components/task-closure-form-fields";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NonModalFormDialog } from "@/components/ui/non-modal-form-dialog";
import {
	FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS,
	useFormPrimaryActionSubmitKeyboardShortcut,
} from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";
import { correctTaskClosureOutcomeInWorkspace } from "@/runtime/task-card-action-query";
import type { BoardCard } from "@/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

export function TaskClosureOutcomeCorrectionForm({
	workspaceId,
	card,
	close,
}: {
	workspaceId: string;
	card: BoardCard;
	close: () => void;
}) {
	const [draft, setDraft] = useState(() => createTaskClosureFormDraft(card.taskClosureSummary?.details));
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const payload = useRef<Parameters<typeof correctTaskClosureOutcomeInWorkspace>[1] | null>(null);
	const submit = async () => {
		if (submitting || !draft.outcome) return;
		setSubmitting(true);
		setError(null);
		try {
			payload.current ??= {
				taskId: card.id,
				expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
				expectedPreviousClosureRequestId: card.taskClosureSummary?.closureRequestId ?? null,
				closure: {
					closureRequestId: createRandomUuidV4WithInsecureContextFallback(),
					details: await resolveTaskClosureFormDetails(draft, workspaceId),
					selectedArtifactRelativePaths: [],
				},
			};
			await correctTaskClosureOutcomeInWorkspace(workspaceId, payload.current);
			close();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setSubmitting(false);
		}
	};
	const onKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: submit,
		disabled: submitting || !draft.outcome,
	});
	return (
		<NonModalFormDialog
			open
			onOpenChange={(open) => {
				if (!open && !submitting) close();
			}}
			onKeyDown={onKeyDown}
		>
			<DialogHeader title="补记或更正结案结果" />
			<DialogBody className="space-y-3">
				<p className="text-sm text-text-primary">{card.title}</p>
				<TaskClosureFormFields
					draft={draft}
					onChange={setDraft}
					disabled={submitting || payload.current !== null}
					includeArtifactSelection={false}
				/>
				{error && (
					<p role="alert" className="text-sm text-status-red">
						{error}
						{payload.current && "。重试会提交原记录，关闭后可重新填写。"}
					</p>
				)}
			</DialogBody>
			<DialogFooter>
				<Button disabled={submitting} onClick={close}>
					取消
				</Button>
				<Button
					{...FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS}
					variant="primary"
					disabled={submitting || !draft.outcome}
					onClick={() => void submit()}
				>
					{submitting ? "正在保存…" : "追加更正记录"}
				</Button>
			</DialogFooter>
		</NonModalFormDialog>
	);
}
