import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { useRelatedTaskPreviewFocusReturnAfterModalDialog } from "@/hooks/use-related-task-preview-focus-return-after-modal-dialog";

let previewHarnessContainer: HTMLDivElement;
let previewHarnessReactRoot: Root;

function RelatedTaskPreviewModalDialogFocusReturnHarness() {
	const relatedTaskPreviewContainerRef = useRef<HTMLDivElement>(null);
	const rememberRelatedTaskPreviewInteractionTarget = useRelatedTaskPreviewFocusReturnAfterModalDialog(
		true,
		relatedTaskPreviewContainerRef,
	);
	const [isRelatedTaskEditorDialogOpen, setIsRelatedTaskEditorDialogOpen] = useState(false);
	return (
		<>
			<div
				ref={relatedTaskPreviewContainerRef}
				tabIndex={-1}
				data-related-task-preview-focus-return-fixture=""
				onFocusCapture={(event) => rememberRelatedTaskPreviewInteractionTarget(event.target)}
				onPointerDownCapture={(event) => rememberRelatedTaskPreviewInteractionTarget(event.target)}
			>
				<button type="button" onClick={() => setIsRelatedTaskEditorDialogOpen(true)}>
					编辑任务
				</button>
				<button type="button">其他操作</button>
			</div>
			<Dialog open={isRelatedTaskEditorDialogOpen} onOpenChange={setIsRelatedTaskEditorDialogOpen}>
				<DialogHeader title="编辑关联任务" />
				<DialogBody>编辑内容</DialogBody>
			</Dialog>
		</>
	);
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	previewHarnessContainer = document.body.appendChild(document.createElement("div"));
	previewHarnessReactRoot = createRoot(previewHarnessContainer);
	await act(async () => previewHarnessReactRoot.render(<RelatedTaskPreviewModalDialogFocusReturnHarness />));
});

afterEach(async () => {
	await act(async () => previewHarnessReactRoot.unmount());
	previewHarnessContainer.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function openThenCloseRelatedTaskEditorDialog() {
	const originatingEditTaskButton = previewHarnessContainer.querySelector<HTMLButtonElement>("button")!;
	await act(async () => {
		originatingEditTaskButton.focus();
		originatingEditTaskButton.click();
	});
	expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	await act(async () => {
		document.activeElement!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
	});
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	return originatingEditTaskButton;
}

it("弹窗关闭时预览容器先获焦，仍恢复发起操作的按钮", async () => {
	const originatingEditTaskButton = await openThenCloseRelatedTaskEditorDialog();
	// 模拟浏览器卸载模态焦点域后，先将焦点退回可聚焦的预览容器。
	await act(async () =>
		previewHarnessContainer.querySelector<HTMLElement>("[data-related-task-preview-focus-return-fixture]")!.focus(),
	);
	await act(async () => vi.advanceTimersByTime(50));
	expect(document.activeElement).toBe(originatingEditTaskButton);
});

it("弹窗关闭后用户已选择预览内其他控件时不抢焦点", async () => {
	await openThenCloseRelatedTaskEditorDialog();
	const otherPreviewActionButton = previewHarnessContainer.querySelectorAll<HTMLButtonElement>("button")[1]!;
	await act(async () => otherPreviewActionButton.focus());
	await act(async () => vi.advanceTimersByTime(50));
	expect(document.activeElement).toBe(otherPreviewActionButton);
});

it("发起控件不可用时回退到预览容器", async () => {
	const originatingEditTaskButton = await openThenCloseRelatedTaskEditorDialog();
	originatingEditTaskButton.disabled = true;
	await act(async () => vi.advanceTimersByTime(50));
	expect(document.activeElement).toBe(
		previewHarnessContainer.querySelector("[data-related-task-preview-focus-return-fixture]"),
	);
});
