import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TaskTerminalActionsMenu } from "./task-terminal-actions-menu";

it("失去操作资格即关闭菜单，恢复资格不会重开旧菜单", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const moveToTrash = vi.fn();
	const renderMenu = (eligible: boolean) => (
		<TaskTerminalActionsMenu
			taskId="menu-test-task"
			taskColumnId="validation"
			onMoveToTrash={eligible ? moveToTrash : undefined}
			isCommitLoading={false}
			isOpenPrLoading={false}
			isMoveToTrashLoading={false}
			isMoveToValidationLoading={false}
		/>
	);
	try {
		await act(async () => root.render(renderMenu(true)));
		await act(async () =>
			container
				.querySelector("button")!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
		);
		expect(document.querySelector('[role="menu"]')).not.toBeNull();
		await act(async () => root.render(renderMenu(false)));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(container.querySelector("button")).toBeNull();
		await act(async () => root.render(renderMenu(true)));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(moveToTrash).not.toHaveBeenCalled();
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
