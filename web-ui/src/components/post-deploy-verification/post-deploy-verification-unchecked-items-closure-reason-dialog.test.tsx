import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PostDeployVerificationDoneEntryClosureDialogTaskEntry } from "./post-deploy-verification-done-entry-closure-dialog-draft-and-closure-request-resolution";
import {
	type PostDeployVerificationDoneEntryClosureDialogTaskEntrySelectionMode,
	PostDeployVerificationUncheckedItemsClosureReasonDialog,
	type PostDeployVerificationUncheckedItemsClosureReasonDialogProps,
} from "./post-deploy-verification-unchecked-items-closure-reason-dialog";

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

function taskEntry(
	taskId: string,
	uncheckedChecklistItemIds: string[],
	overrides: Partial<PostDeployVerificationDoneEntryClosureDialogTaskEntry> = {},
): PostDeployVerificationDoneEntryClosureDialogTaskEntry {
	return {
		taskId,
		taskTitle: `任务 ${taskId}`,
		boardColumnIdOfTaskCardBeforeMoveIntoDone: "validation",
		uncheckedChecklistItemsRequiringClosureReason: uncheckedChecklistItemIds.map((checklistItemId) => ({
			checklistItemId,
			checklistItemLabel: `核对 ${checklistItemId}`,
			checklistItemKind: "guided_manual",
		})),
		runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel: false,
		agentResponsePreviewShownWithSkipValidationAcknowledgement: null,
		...overrides,
	};
}

function renderDialog(input: {
	taskEntries: PostDeployVerificationDoneEntryClosureDialogTaskEntry[];
	taskEntrySelectionMode?: PostDeployVerificationDoneEntryClosureDialogTaskEntrySelectionMode;
	onConfirmClosureRequestsBySelectedTaskId?: PostDeployVerificationUncheckedItemsClosureReasonDialogProps["onConfirmClosureRequestsBySelectedTaskId"];
}): void {
	act(() => {
		root.render(
			<PostDeployVerificationUncheckedItemsClosureReasonDialog
				dialogTitle="带原因移入 Done"
				taskEntries={input.taskEntries}
				taskEntrySelectionMode={input.taskEntrySelectionMode ?? "single_task_entry_always_included"}
				isSubmittingClosure={false}
				onCancel={vi.fn()}
				onConfirmClosureRequestsBySelectedTaskId={input.onConfirmClosureRequestsBySelectedTaskId ?? vi.fn()}
			/>,
		);
	});
}

function setFormControlValueAsUser(formControl: HTMLInputElement | HTMLSelectElement, value: string): void {
	// 直接赋 .value 会被 React 的 value tracker 吞掉；走原型上的 setter 再派发事件。
	const prototypeWithValueSetter =
		formControl instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
	act(() => {
		Object.getOwnPropertyDescriptor(prototypeWithValueSetter, "value")?.set?.call(formControl, value);
		formControl.dispatchEvent(
			new Event(formControl instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
		);
	});
}

function findByAriaLabel<TElement extends HTMLElement>(ariaLabel: string): TElement {
	const element = document.body.querySelector<TElement>(`[aria-label="${ariaLabel}"]`);
	if (!element) {
		throw new Error(`找不到 aria-label="${ariaLabel}" 的元素`);
	}
	return element;
}

function findButtonByText(text: string): HTMLButtonElement {
	const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(text),
	);
	if (!button) {
		throw new Error(`找不到文字含「${text}」的按钮`);
	}
	return button;
}

describe("PostDeployVerificationUncheckedItemsClosureReasonDialog", () => {
	it("每个未勾项都选了原因才能确认，确认时按任务交出结案请求", () => {
		const onConfirmClosureRequestsBySelectedTaskId =
			vi.fn<
				PostDeployVerificationUncheckedItemsClosureReasonDialogProps["onConfirmClosureRequestsBySelectedTaskId"]
			>();
		renderDialog({
			taskEntries: [taskEntry("task-a", ["item-1", "item-2"])],
			onConfirmClosureRequestsBySelectedTaskId,
		});
		const confirmButton = findButtonByText("确认移入 Done");
		expect(confirmButton.disabled).toBe(true);

		setFormControlValueAsUser(
			findByAriaLabel<HTMLSelectElement>("核对 item-1：原因"),
			"manual_reproduction_cost_exceeds_verification_value",
		);
		expect(confirmButton.disabled).toBe(true);
		setFormControlValueAsUser(
			findByAriaLabel<HTMLSelectElement>("核对 item-2：原因"),
			"assertion_already_covered_by_other_verification_evidence",
		);
		expect(confirmButton.disabled).toBe(false);

		act(() => confirmButton.click());
		expect(onConfirmClosureRequestsBySelectedTaskId).toHaveBeenCalledWith({
			"task-a": {
				uncheckedChecklistItemClosureReasons: [
					{
						checklistItemId: "item-1",
						uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
					},
					{
						checklistItemId: "item-2",
						uncheckedChecklistItemClosureReasonCode: "assertion_already_covered_by_other_verification_evidence",
					},
				],
			},
		});
	});

	it("自定义原因不填文本不能确认", () => {
		renderDialog({ taskEntries: [taskEntry("task-a", ["item-1"])] });
		setFormControlValueAsUser(
			findByAriaLabel<HTMLSelectElement>("核对 item-1：原因"),
			"custom_reason_described_in_reason_text",
		);
		const confirmButton = findButtonByText("确认移入 Done");
		expect(confirmButton.disabled).toBe(true);
		expect(document.body.textContent).toContain("没有填写原因文本");
		setFormControlValueAsUser(findByAriaLabel<HTMLInputElement>("核对 item-1：原因文本"), "行为已被重写");
		expect(confirmButton.disabled).toBe(false);
	});

	it("「应用到全部未勾项」一次填满，并提示「转为在自然使用中观察」会生成待观察记录", () => {
		renderDialog({ taskEntries: [taskEntry("task-a", ["item-1", "item-2"])] });
		setFormControlValueAsUser(
			findByAriaLabel<HTMLSelectElement>("应用到全部未勾项：原因"),
			"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
		);
		expect(document.body.textContent).toContain("待在自然使用中观察");
		act(() => findButtonByText("应用到全部未勾项").click());
		expect(findByAriaLabel<HTMLSelectElement>("核对 item-1：原因").value).toBe(
			"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
		);
		expect(findByAriaLabel<HTMLSelectElement>("核对 item-2：原因").value).toBe(
			"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
		);
		expect(findButtonByText("确认移入 Done").disabled).toBe(false);
	});

	it("吸收了跳过 Validation 与 In Progress 两层确认：同一对话框里的条件段落，In Progress 需显式勾选", () => {
		renderDialog({
			taskEntries: [
				taskEntry("task-a", [], {
					boardColumnIdOfTaskCardBeforeMoveIntoDone: "in_progress",
					agentResponsePreviewShownWithSkipValidationAcknowledgement: "最后一条 agent 回复",
				}),
			],
		});
		expect(document.body.textContent).toContain("跳过 Validation 列");
		expect(document.body.textContent).toContain("最后一条 agent 回复");
		const confirmButton = findButtonByText("确认移入 Done");
		expect(confirmButton.disabled).toBe(true);
		act(() => findByAriaLabel<HTMLButtonElement>("我已了解 In Progress 任务的会话可能仍在运行").click());
		expect(confirmButton.disabled).toBe(false);
	});

	it("批量模式：默认一个都不选，勾选后才列出该任务的未勾项", () => {
		renderDialog({
			taskEntries: [taskEntry("task-a", ["item-1"]), taskEntry("task-b", ["item-2"])],
			taskEntrySelectionMode: "multiple_task_entries_selectable_for_batch_closure",
		});
		expect(document.body.querySelector('[aria-label="核对 item-1：原因"]')).toBeNull();
		expect(findButtonByText("结案并移入 Done（0 个任务）").disabled).toBe(true);
		act(() => findByAriaLabel<HTMLButtonElement>("纳入本次结案：任务 task-a").click());
		expect(document.body.querySelector('[aria-label="核对 item-1：原因"]')).not.toBeNull();
		expect(document.body.querySelector('[aria-label="核对 item-2：原因"]')).toBeNull();
		expect(findButtonByText("结案并移入 Done（1 个任务）")).toBeTruthy();
	});
});
