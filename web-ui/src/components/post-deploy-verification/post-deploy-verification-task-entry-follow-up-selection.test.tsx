import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PostDeployVerificationTaskEntryChecklistAndClosureSection } from "./post-deploy-verification-task-entry-checklist-and-closure-section";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

type Props = ComponentProps<typeof PostDeployVerificationTaskEntryChecklistAndClosureSection>;
let container: HTMLDivElement;
let root: Root;
const item = (id: string, checked = false) => ({
	id,
	label: `断言 ${id}`,
	checked,
	source: "custom" as const,
	kind: "guided_manual" as const,
	guidance: null,
	script: null,
	run: null,
	cleanup: null,
});
function props(): Props {
	return {
		postDeployVerificationTask: createPostDeployVerificationTaskReadModelTestFixture({
			checklist: [item("a"), item("b"), item("passed", true)],
		}),
		currentBoardColumnIdOfTaskCard: "validation",
		retainedDeploymentGroupsByDeploymentId: new Map(),
		interactive: true,
		checklistInitiallyExpanded: true,
		isCompleting: false,
		onToggleChecklistItem: vi.fn(),
		onAddCustomChecklistItem: vi.fn(),
		onRemoveCustomChecklistItem: vi.fn(),
		onRunVerificationItem: vi.fn(),
		onRequestComplete: vi.fn(),
		onLocateChecklistItem: vi.fn(),
		onCreateFollowUpTaskFromSelectedChecklistItems: vi.fn(),
	};
}
function render(input: Props) {
	act(() =>
		root.render(
			<TooltipProvider>
				<PostDeployVerificationTaskEntryChecklistAndClosureSection {...input} />
			</TooltipProvider>,
		),
	);
}
function button(label: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(b) => b.getAttribute("aria-label") === label || b.textContent === label,
	);
	if (!button) throw new Error(`找不到按钮 ${label}`);
	return button;
}
function click(label: string) {
	act(() => button(label).click());
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("PDV 紧凑入口与后续任务选择", () => {
	it("自定义输入默认隐藏，点击加号展开且 Escape 收起", () => {
		render(props());
		expect(container.querySelector("input[type=text]")).toBeNull();
		click("添加自定义核对项");
		const input = container.querySelector<HTMLInputElement>("input[type=text]");
		expect(input).not.toBeNull();
		act(() => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector("input[type=text]")).toBeNull();
	});
	it("多选只提交上下文，不勾选、运行或结案原项目", () => {
		const input = props();
		render(input);
		click("创建关联续接任务");
		expect(button("下一步").disabled).toBe(false);
		click("选择核对项：断言 a");
		click("选择核对项：断言 b");
		click("下一步");
		expect(input.onCreateFollowUpTaskFromSelectedChecklistItems).toHaveBeenCalledWith(["a", "b"]);
		expect(input.onToggleChecklistItem).not.toHaveBeenCalled();
		expect(input.onRunVerificationItem).not.toHaveBeenCalled();
		expect(input.onRequestComplete).not.toHaveBeenCalled();
	});
	it("自定义输入的 Enter 避让输入法组字，正常提交修剪后的内容", () => {
		const inputProps = props();
		render(inputProps);
		click("添加自定义核对项");
		const input = container.querySelector<HTMLInputElement>("input[type=text]");
		if (!input) throw new Error("自定义项输入框缺失");
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "  新核对项  ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
		expect(inputProps.onAddCustomChecklistItem).not.toHaveBeenCalled();
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(inputProps.onAddCustomChecklistItem).toHaveBeenCalledWith("新核对项");
		expect(container.querySelector("input[type=text]")).toBeNull();
	});
	it("取消上下文选择不创建任务且恢复正常核对入口", () => {
		const inputProps = props();
		render(inputProps);
		click("创建关联续接任务");
		click("选择核对项：断言 a");
		click("取消");
		expect(inputProps.onCreateFollowUpTaskFromSelectedChecklistItems).not.toHaveBeenCalled();
		expect(button("创建关联续接任务")).toBeDefined();
	});
	it("已核对项可选，核对状态变化不丢失上下文选择", () => {
		const input = props();
		render(input);
		click("创建关联续接任务");
		click("选择核对项：断言 a");
		click("选择核对项：断言 passed");
		render({
			...input,
			postDeployVerificationTask: {
				...input.postDeployVerificationTask,
				checklist: [item("a", true), item("b"), item("passed", true)],
			},
		});
		click("下一步");
		expect(input.onCreateFollowUpTaskFromSelectedChecklistItems).toHaveBeenCalledWith(["a", "passed"]);
	});
	it("历史、Done 和已删除来源仍可发起续接，不改变验证的只读状态", () => {
		for (const override of [
			{ interactive: false },
			{ currentBoardColumnIdOfTaskCard: null },
			{ currentBoardColumnIdOfTaskCard: "trash" as const },
		]) {
			const input = { ...props(), ...override };
			render(input);
			click("创建关联续接任务");
			click("下一步");
			expect(input.onCreateFollowUpTaskFromSelectedChecklistItems).toHaveBeenCalledWith([]);
			expect(input.onToggleChecklistItem).not.toHaveBeenCalled();
		}
	});
	it("完成途中禁用后续任务入口", () => {
		for (const override of [{ isCompleting: true }]) {
			render({ ...props(), ...override });
			const entry = container.querySelector<HTMLButtonElement>('[aria-label="创建关联续接任务"]');
			expect(entry === null || entry.disabled).toBe(true);
		}
	});
	it("全部所选项被删除时要求明确重置，不静默改为仅携带背景", () => {
		const input = props();
		render(input);
		click("创建关联续接任务");
		click("选择核对项：断言 a");
		render({ ...input, postDeployVerificationTask: { ...input.postDeployVerificationTask, checklist: [item("b")] } });
		expect(button("下一步").disabled).toBe(true);
		expect(container.textContent).toContain("有已选核对项被移除");
		click("重置选择");
		click("下一步");
		expect(input.onCreateFollowUpTaskFromSelectedChecklistItems).toHaveBeenCalledWith([]);
	});
});
