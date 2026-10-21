import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { TaskCardPrimaryActionWithQuickOptions } from "@/components/task-card-primary-action-with-quick-options";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousReactActEnvironment: boolean | undefined;
beforeAll(() => {
	previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
	reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
});

it("触摸首次点击只展开；附加选项单独执行，鼠标点击保留主操作", async () => {
	const primary = vi.fn();
	const extra = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<TaskCardPrimaryActionWithQuickOptions
				open={open}
				onOpenChange={setOpen}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={primary}
				quickOption={{ label: "评论后完成", onSelect: extra }}
			/>
		);
	}
	try {
		await act(async () => root.render(<Harness />));
		const trigger = host.querySelector("button")!;
		const pointerDown = new Event("pointerdown", { bubbles: true });
		Object.defineProperty(pointerDown, "pointerType", { value: "touch" });
		await act(async () => {
			trigger.dispatchEvent(pointerDown);
			trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		});
		expect(primary).not.toHaveBeenCalled();
		const option = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="评论后完成"]');
		expect(option).not.toBeNull();
		await act(async () => option!.click());
		expect(extra).toHaveBeenCalledOnce();
		const mouseDown = new Event("pointerdown", { bubbles: true });
		Object.defineProperty(mouseDown, "pointerType", { value: "mouse" });
		await act(async () => {
			trigger.dispatchEvent(mouseDown);
			trigger.click();
		});
		expect(primary).toHaveBeenCalledOnce();
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("菜单打开后禁用会通知受控父级关闭，恢复可用不会自动重弹", async () => {
	const onOpenChange = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Harness({ disabled }: { disabled: boolean }) {
		const [open, setOpen] = useState(false);
		return (
			<TaskCardPrimaryActionWithQuickOptions
				open={open}
				onOpenChange={(nextOpen) => {
					onOpenChange(nextOpen);
					setOpen(nextOpen);
				}}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={() => {}}
				quickOption={{ label: "评论后完成", onSelect: () => {} }}
				disabled={disabled}
			/>
		);
	}
	try {
		await act(async () => root.render(<Harness disabled={false} />));
		const trigger = host.querySelector("button")!;
		await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(document.querySelector('[role="menu"]')).not.toBeNull();
		onOpenChange.mockClear();
		await act(async () => root.render(<Harness disabled />));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(onOpenChange).toHaveBeenCalledWith(false);
		await act(async () => root.render(<Harness disabled={false} />));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("触屏打开会话保持向下，鼠标进入与父级重渲不改方向；关闭后的悬停新会话向上", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<TaskCardPrimaryActionWithQuickOptions
				open={open}
				onOpenChange={setOpen}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={() => {}}
				quickOption={{ label: "评论后完成", onSelect: () => {} }}
			/>
		);
	}
	const pointerEvent = (type: string, pointerType: string) => {
		const event = new Event(type, { bubbles: true });
		Object.defineProperty(event, "pointerType", { value: pointerType });
		return event;
	};
	try {
		await act(async () => root.render(<Harness />));
		const trigger = host.querySelector("button")!;
		await act(async () => {
			trigger.dispatchEvent(pointerEvent("pointerdown", "touch"));
			trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		});
		expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("bottom");
		await act(async () => trigger.dispatchEvent(pointerEvent("pointerover", "mouse")));
		await act(async () => root.render(<Harness />));
		expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("bottom");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		await act(async () => trigger.dispatchEvent(pointerEvent("pointerover", "mouse")));
		expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("top");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("首个菜单项获得焦点后立即按 Escape 仍关闭菜单并回焦触发器", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let escapeDispatchedFromFocusedMenuItem = false;
	const pressEscapeOnFirstMenuItemFocus = (event: FocusEvent) => {
		if (escapeDispatchedFromFocusedMenuItem || !(event.target instanceof HTMLElement)) return;
		if (event.target.getAttribute("role") !== "menuitem") return;
		escapeDispatchedFromFocusedMenuItem = true;
		event.target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	};
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<TaskCardPrimaryActionWithQuickOptions
				open={open}
				onOpenChange={setOpen}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={() => {}}
				quickOption={{ label: "评论后完成", onSelect: () => {} }}
			/>
		);
	}
	document.addEventListener("focusin", pressEscapeOnFirstMenuItemFocus);
	try {
		await act(async () => root.render(<Harness />));
		const trigger = host.querySelector("button")!;
		await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(escapeDispatchedFromFocusedMenuItem).toBe(true);
		expect(document.querySelector('[role="menu"]')).toBeNull();
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
	} finally {
		document.removeEventListener("focusin", pressEscapeOnFirstMenuItemFocus);
		await act(async () => root.unmount());
		host.remove();
	}
});
