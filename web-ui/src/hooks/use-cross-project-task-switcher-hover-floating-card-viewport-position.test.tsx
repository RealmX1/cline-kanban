import { act, memo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCrossProjectTaskSwitcherHoverFloatingCardViewportPosition } from "./use-cross-project-task-switcher-hover-floating-card-viewport-position";

let rowTop = 330;
let rowRenderCount = 0;
let observerCallback: IntersectionObserverCallback | undefined;
let observerDisconnect = vi.fn();

class LayoutShiftObserver {
	constructor(callback: IntersectionObserverCallback) {
		observerCallback = callback;
	}
	observe() {}
	disconnect() {
		observerDisconnect();
	}
	unobserve() {}
	takeRecords() {
		return [];
	}
	readonly root = null;
	readonly rootMargin = "";
	readonly thresholds = [];
}

const Row = memo(function Row({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
	rowRenderCount += 1;
	const { rowElementRef, fullTaskCardContentElementRef, floatingCardViewportStyle } =
		useCrossProjectTaskSwitcherHoverFloatingCardViewportPosition({
			isFloatingCardVisible: true,
			hostingScrollContainerRef: host,
		});
	return (
		<div ref={rowElementRef} data-kind="row">
			<div style={floatingCardViewportStyle} data-kind="floating">
				<div ref={fullTaskCardContentElementRef} data-kind="card">
					<button type="button">动作</button>
				</div>
			</div>
		</div>
	);
});
function Harness({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
	const [siblings, setSiblings] = useState(["上方任务"]);
	return (
		<div>
			<button type="button" onClick={() => setSiblings([])}>
				删除上方任务
			</button>
			{siblings.map((sibling) => (
				<div key={sibling}>{sibling}</div>
			))}
			<Row host={host} />
		</div>
	);
}

describe("悬浮卡片跟随行的布局位移", () => {
	let root: Root | undefined;
	let container: HTMLDivElement | undefined;
	afterEach(() => {
		if (root) act(() => root?.unmount());
		container?.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		observerCallback = undefined;
	});
	it("上方任务异步增高和删除时，即使当前行不重渲染也重新夹取并保留焦点", () => {
		rowTop = 330;
		rowRenderCount = 0;
		observerDisconnect = vi.fn();
		vi.stubGlobal("IntersectionObserver", LayoutShiftObserver);
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
				unobserve() {}
			},
		);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const kind = this.dataset.kind;
			const top = kind === "row" ? rowTop : kind === "host" ? 100 : 0;
			const height = kind === "row" ? 30 : kind === "card" ? 233 : 300;
			return { top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top, toJSON() {} };
		});
		container = document.createElement("div");
		container.dataset.kind = "host";
		document.body.append(container);
		root = createRoot(container);
		container.scrollTop = 37;
		const host = { current: container };
		act(() => root?.render(<Harness host={host} />));
		const floating = container.querySelector<HTMLElement>('[data-kind="floating"]')!;
		const action = container.querySelector<HTMLButtonElement>('[data-kind="card"] button')!;
		action.focus();
		expect(Number.parseFloat(floating.style.top)).toBe(-180);
		// 模拟独立兄弟节点异步增高，只有锚点 top 改变。
		rowTop = 350;
		act(() =>
			observerCallback?.([{ intersectionRatio: 1 } as IntersectionObserverEntry], {} as IntersectionObserver),
		);
		expect(Number.parseFloat(floating.style.top)).toBe(-200);
		const countBeforeSiblingDeletion = rowRenderCount;
		// 删除上方节点导致纯位移，memo 行没有重新渲染。
		rowTop = 250;
		act(() => {
			container?.querySelector<HTMLButtonElement>("button")?.click();
		});
		act(() =>
			observerCallback?.([{ intersectionRatio: 1 } as IntersectionObserverEntry], {} as IntersectionObserver),
		);
		expect(Number.parseFloat(floating.style.top)).toBe(-100);
		expect(rowRenderCount).toBe(countBeforeSiblingDeletion + 1);
		expect(document.activeElement).toBe(action);
		expect(container.scrollTop).toBe(37);
		expect(container.scrollHeight).toBe(900);
		act(() => root?.unmount());
		root = undefined;
		expect(observerDisconnect).toHaveBeenCalled();
	});
});
