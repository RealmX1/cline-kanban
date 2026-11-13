import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	focusTaskCardKeyboardEntryIncludingPortalledActionToolbars,
	TaskCardActionToolbar,
} from "./task-card-action-toolbar";

const positioning = vi.hoisted(() => ({
	resolvePendingPositions: [] as Array<(position: { x: number; y: number; middlewareData: object }) => void>,
	stopObserving: vi.fn(),
}));
const inputDevice = vi.hoisted(() => ({ usesTouchActionToolbar: false }));
vi.mock("@/utils/react-use", () => ({ useMedia: () => inputDevice.usesTouchActionToolbar }));
vi.mock("@floating-ui/dom", () => ({
	autoUpdate: (_anchor: HTMLElement, _toolbar: HTMLElement, update: () => void) => {
		update();
		return positioning.stopObserving;
	},
	computePosition: () => new Promise((resolve) => positioning.resolvePendingPositions.push(resolve)),
	offset: () => ({}),
	shift: () => ({}),
	hide: () => ({}),
}));

function Harness({ isSourceCardInteractionActive = false, onCardClick = () => {} } = {}) {
	const anchorRef = useRef<HTMLDivElement>(null);
	return (
		<>
			<button type="button" data-testid="before">
				前一个控件
			</button>
			<div ref={anchorRef} data-testid="source" onClick={onCardClick}>
				<TaskCardActionToolbar
					sourceCardAnchorElementRef={anchorRef}
					isSourceCardInteractionActive={isSourceCardInteractionActive}
				>
					<button type="button">第一个动作</button>
					<button type="button" data-testid="expansion-toggle">
						保持展开
					</button>
				</TaskCardActionToolbar>
			</div>
			<button type="button" data-testid="outside">
				其他控件
			</button>
		</>
	);
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	positioning.resolvePendingPositions.length = 0;
	positioning.stopObserving.mockClear();
	inputDevice.usesTouchActionToolbar = false;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root.render(<Harness />));
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it("隐藏动作组位于 body Portal，卡内只留无布局占位的键盘入口", () => {
	const toolbar = document.querySelector<HTMLElement>("[data-task-card-primary-actions]")!;
	expect(toolbar.parentElement).toBe(document.body);
	expect(toolbar.hasAttribute("inert")).toBe(true);
	expect(container.querySelector("[data-task-card-primary-actions]")).toBeNull();
	expect(container.querySelector("[data-task-card-action-toolbar-placeholder]")?.className).toBe("sr-only");
});

it("异步定位完成后才交接指定按钮的键盘焦点", async () => {
	const source = container.querySelector<HTMLElement>('[data-testid="source"]')!;
	act(() => focusTaskCardKeyboardEntryIncludingPortalledActionToolbars(source, '[data-testid="expansion-toggle"]'));
	expect(document.activeElement?.hasAttribute("data-task-card-action-toolbar-placeholder")).toBe(true);
	await act(async () => {
		positioning.resolvePendingPositions.shift()?.({ x: 10, y: 20, middlewareData: {} });
	});
	expect(document.activeElement).toBe(document.querySelector('[data-testid="expansion-toggle"]'));
});

it.each([false, true])("反向进入工具栏时聚焦最后动作，已定位=%s", async (isAlreadyPositioned) => {
	const source = container.querySelector<HTMLElement>('[data-testid="source"]')!;
	if (isAlreadyPositioned) {
		act(() => source.dispatchEvent(new Event("pointerenter")));
		await act(async () => {
			positioning.resolvePendingPositions.shift()?.({ x: 10, y: 20, middlewareData: {} });
		});
	}
	act(() => container.querySelector<HTMLElement>('[data-testid="outside"]')?.focus());
	act(() => container.querySelector<HTMLElement>("[data-task-card-action-toolbar-placeholder]")?.focus());
	await act(async () => {
		positioning.resolvePendingPositions.shift()?.({ x: 10, y: 20, middlewareData: {} });
	});
	expect(document.activeElement).toBe(document.querySelector('[data-testid="expansion-toggle"]'));
});

it("正向进入工具栏仍聚焦第一动作", async () => {
	act(() => container.querySelector<HTMLElement>('[data-testid="before"]')?.focus());
	act(() => container.querySelector<HTMLElement>("[data-task-card-action-toolbar-placeholder]")?.focus());
	await act(async () => {
		positioning.resolvePendingPositions.shift()?.({ x: 10, y: 20, middlewareData: {} });
	});
	expect(document.activeElement?.textContent).toBe("第一个动作");
});

it("指定动作的程序化交接优先于反向来源位置", async () => {
	const source = container.querySelector<HTMLElement>('[data-testid="source"]')!;
	act(() => container.querySelector<HTMLElement>('[data-testid="outside"]')?.focus());
	act(() => focusTaskCardKeyboardEntryIncludingPortalledActionToolbars(source, "button"));
	await act(async () => {
		positioning.resolvePendingPositions.shift()?.({ x: 10, y: 20, middlewareData: {} });
	});
	expect(document.activeElement?.textContent).toBe("第一个动作");
});

it("定位期间用户已移走焦点时不抢回焦点，并停止位置监听", async () => {
	act(() => container.querySelector<HTMLElement>("[data-task-card-action-toolbar-placeholder]")?.focus());
	const outside = container.querySelector<HTMLElement>('[data-testid="outside"]')!;
	act(() => outside.focus());
	await act(async () => {
		positioning.resolvePendingPositions.shift()?.({ x: 10, y: 20, middlewareData: {} });
	});
	expect(document.activeElement).toBe(outside);
	expect(positioning.stopObserving).toHaveBeenCalled();
	expect(
		document.querySelector("[data-task-card-primary-actions]")?.getAttribute("data-task-card-action-toolbar-state"),
	).toBe("hidden");
});

it("触屏默认收起业务动作，显式展开和收起不会触发来源卡导航", () => {
	inputDevice.usesTouchActionToolbar = true;
	const onCardClick = vi.fn();
	act(() => root.render(<Harness onCardClick={onCardClick} />));
	const toolbar = document.querySelector<HTMLElement>("[data-task-card-primary-actions]")!;
	const actions = toolbar.querySelector<HTMLElement>("[data-task-card-action-toolbar-expanded-actions]")!;
	const disclosure = toolbar.querySelector<HTMLButtonElement>("[data-task-card-touch-actions-disclosure]")!;
	expect(actions.hidden).toBe(true);
	expect(toolbar.hasAttribute("inert")).toBe(false);
	expect(disclosure.getAttribute("aria-expanded")).toBe("false");
	act(() => disclosure.click());
	expect(actions.hidden).toBe(false);
	expect(disclosure.getAttribute("aria-expanded")).toBe("true");
	act(() => disclosure.click());
	expect(actions.hidden).toBe(true);
	expect(onCardClick).not.toHaveBeenCalled();
});

it("触屏显式收起后仍可按指定动作接入键盘，Escape 归还触屏入口", async () => {
	inputDevice.usesTouchActionToolbar = true;
	act(() => root.render(<Harness />));
	const source = container.querySelector<HTMLElement>('[data-testid="source"]')!;
	const disclosure = document.querySelector<HTMLButtonElement>("[data-task-card-touch-actions-disclosure]")!;
	act(() => disclosure.click());
	act(() => disclosure.click());
	act(() => focusTaskCardKeyboardEntryIncludingPortalledActionToolbars(source, '[data-testid="expansion-toggle"]'));
	expect(document.activeElement?.hasAttribute("data-task-card-action-toolbar-placeholder")).toBe(true);
	await act(async () => {
		for (const resolvePosition of positioning.resolvePendingPositions.splice(0)) {
			resolvePosition({ x: 10, y: 20, middlewareData: {} });
		}
	});
	const action = document.querySelector<HTMLButtonElement>('[data-testid="expansion-toggle"]')!;
	expect(document.activeElement).toBe(action);
	act(() => action.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(document.activeElement).toBe(disclosure);
	expect(disclosure.getAttribute("aria-expanded")).toBe("false");
	act(() => disclosure.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
	expect(document.activeElement?.hasAttribute("data-task-card-action-toolbar-placeholder")).toBe(true);
	expect(disclosure.getAttribute("aria-expanded")).toBe("false");
});

it("触屏外部点按收起动作，但来源子浮层交互期间保留入口", () => {
	inputDevice.usesTouchActionToolbar = true;
	act(() => root.render(<Harness />));
	const disclosure = document.querySelector<HTMLButtonElement>("[data-task-card-touch-actions-disclosure]")!;
	const action = document.querySelector<HTMLButtonElement>('[data-testid="expansion-toggle"]')!;
	const outside = container.querySelector<HTMLElement>('[data-testid="outside"]')!;
	act(() => disclosure.click());
	act(() => action.focus());
	act(() => root.render(<Harness isSourceCardInteractionActive />));
	act(() => outside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
	expect(disclosure.getAttribute("aria-expanded")).toBe("true");
	act(() => root.render(<Harness />));
	act(() => outside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
	expect(disclosure.getAttribute("aria-expanded")).toBe("false");
	expect(document.activeElement).not.toBe(action);
});

it("触屏在外置对话框内点按或关闭对话框时保留工具栏，原按钮仍可接回焦点", () => {
	inputDevice.usesTouchActionToolbar = true;
	act(() => root.render(<Harness />));
	const disclosure = document.querySelector<HTMLButtonElement>("[data-task-card-touch-actions-disclosure]")!;
	const action = document.querySelector<HTMLButtonElement>('[data-testid="expansion-toggle"]')!;
	const dialog = container.appendChild(document.createElement("div"));
	dialog.setAttribute("role", "dialog");
	const editor = dialog.appendChild(document.createElement("input"));
	act(() => disclosure.click());
	act(() => editor.dispatchEvent(new Event("pointerdown", { bubbles: true })));
	expect(disclosure.getAttribute("aria-expanded")).toBe("true");
	act(() => editor.focus());
	act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
	expect(disclosure.getAttribute("aria-expanded")).toBe("true");
	dialog.remove();
	act(() => action.focus());
	expect(document.activeElement).toBe(action);
});
