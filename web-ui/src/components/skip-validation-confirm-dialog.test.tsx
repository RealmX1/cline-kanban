import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkipValidationConfirmDialog } from "@/components/skip-validation-confirm-dialog";

describe("SkipValidationConfirmDialog 的真实 Radix 关闭行为", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it.each(["确认", "取消", "Escape"])("%s 只调用对应回调一次", async (action) => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		await act(async () => {
			root.render(<SkipValidationConfirmDialog open onConfirm={onConfirm} onCancel={onCancel} />);
		});

		await act(async () => {
			if (action === "Escape") {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
				return;
			}
			const label = action === "确认" ? "结案任务" : "Cancel";
			const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
			if (!button) throw new Error(`找不到按钮：${label}`);
			button.click();
		});

		expect(onConfirm).toHaveBeenCalledTimes(action === "确认" ? 1 : 0);
		expect(onCancel).toHaveBeenCalledTimes(action === "确认" ? 0 : 1);
		if (action === "确认") {
			expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
			await act(async () => {
				root.render(<SkipValidationConfirmDialog open={false} onConfirm={onConfirm} onCancel={onCancel} />);
			});
			expect(document.querySelector('[role="alertdialog"]')).toBeNull();
			expect(onCancel).not.toHaveBeenCalled();
		}
	});
});
