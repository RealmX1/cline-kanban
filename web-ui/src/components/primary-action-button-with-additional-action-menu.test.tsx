import { act, type ReactNode, useState } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PrimaryActionButtonWithAdditionalActionMenu } from "@/components/primary-action-button-with-additional-action-menu";
import { TooltipProvider } from "@/components/ui/tooltip";

function createRoot(container: HTMLElement) {
	const root = createReactRoot(container);
	return {
		render: (children: ReactNode) => root.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => root.unmount(),
	};
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousReactActEnvironment: boolean | undefined;
beforeAll(() => {
	previousReactActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
	reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
});

function touchPointer(type: string, clientX = 20, clientY = 20) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		pointerType: { value: "touch" },
		pointerId: { value: 1 },
		clientX: { value: clientX },
		clientY: { value: clientY },
	});
	return event;
}

it.each(["release", "movement", "scroll", "cancel", "unmount", "complete", "leave-within-tolerance"] as const)(
	"触屏长按：%s 清理与本次释放点击隔离",
	async (ending) => {
		vi.useFakeTimers();
		const primary = vi.fn();
		const onOpenChange = vi.fn();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		let unmounted = false;
		function Harness() {
			const [open, setOpen] = useState(false);
			return (
				<PrimaryActionButtonWithAdditionalActionMenu
					open={open}
					onOpenChange={(value) => {
						onOpenChange(value);
						setOpen(value);
					}}
					icon={null}
					primaryLabel="结案"
					primaryAccessibleLabel="直接结案"
					onPrimaryAction={primary}
					additionalAction={{ label: "评论后结案", onSelect: () => {} }}
					touchAdditionalActionTrigger="long_press_primary_button"
				/>
			);
		}
		try {
			await act(async () => root.render(<Harness />));
			expect(host.querySelectorAll("button")).toHaveLength(1);
			const trigger = host.querySelector("button")!;
			await act(async () => trigger.dispatchEvent(touchPointer("pointerdown")));
			await act(async () => vi.advanceTimersByTime(499));
			expect(onOpenChange).not.toHaveBeenCalled();
			await act(async () => {
				if (ending === "release") trigger.dispatchEvent(touchPointer("pointerup"));
				if (ending === "movement") trigger.dispatchEvent(touchPointer("pointermove", 29));
				if (ending === "scroll") window.dispatchEvent(new Event("scroll"));
				if (ending === "cancel") trigger.dispatchEvent(touchPointer("pointercancel"));
				if (ending === "leave-within-tolerance") {
					trigger.dispatchEvent(touchPointer("pointermove", 26));
					trigger.dispatchEvent(touchPointer("pointerout", 26));
				}
				if (ending === "unmount") {
					root.unmount();
					unmounted = true;
				}
				vi.advanceTimersByTime(1);
			});
			if (ending !== "complete" && ending !== "leave-within-tolerance") {
				expect(onOpenChange).not.toHaveBeenCalled();
				return;
			}
			expect(trigger.getAttribute("aria-expanded")).toBe("true");
			await act(async () => {
				trigger.dispatchEvent(touchPointer("pointerup"));
				trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
			});
			expect(primary).not.toHaveBeenCalled();
			await act(async () => {
				trigger.dispatchEvent(touchPointer("pointerdown"));
				trigger.dispatchEvent(touchPointer("pointerup"));
				trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
			});
			expect(primary).toHaveBeenCalledOnce();
		} finally {
			if (!unmounted) await act(async () => root.unmount());
			host.remove();
			vi.useRealTimers();
		}
	},
);

it("触屏主按钮直接执行，独立入口仅展开附加动作", async () => {
	const primary = vi.fn();
	const extra = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<PrimaryActionButtonWithAdditionalActionMenu
				open={open}
				onOpenChange={setOpen}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={primary}
				additionalAction={{ label: "评论后完成", onSelect: extra }}
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
		expect(primary).toHaveBeenCalledOnce();
		primary.mockClear();
		const expand = host.querySelector<HTMLButtonElement>('[aria-label="展开直接完成附加操作"]')!;
		await act(async () => expand.click());
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
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
			<PrimaryActionButtonWithAdditionalActionMenu
				open={open}
				onOpenChange={(nextOpen) => {
					onOpenChange(nextOpen);
					setOpen(nextOpen);
				}}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={() => {}}
				additionalAction={{ label: "评论后完成", onSelect: () => {} }}
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

it("附加动作始终向下展开，鼠标、触屏与父级重渲保持一致", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<PrimaryActionButtonWithAdditionalActionMenu
				open={open}
				onOpenChange={setOpen}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={() => {}}
				additionalAction={{ label: "评论后完成", onSelect: () => {} }}
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
			host.querySelector<HTMLButtonElement>('[aria-label="展开直接完成附加操作"]')!.click();
		});
		expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("bottom");
		await act(async () => trigger.dispatchEvent(pointerEvent("pointerover", "mouse")));
		await act(async () => root.render(<Harness />));
		expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("bottom");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		await act(async () => trigger.dispatchEvent(pointerEvent("pointerover", "mouse")));
		expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("bottom");
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
			<PrimaryActionButtonWithAdditionalActionMenu
				open={open}
				onOpenChange={setOpen}
				icon={null}
				primaryLabel="直接完成"
				primaryAccessibleLabel="直接完成"
				onPrimaryAction={() => {}}
				additionalAction={{ label: "评论后完成", onSelect: () => {} }}
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
