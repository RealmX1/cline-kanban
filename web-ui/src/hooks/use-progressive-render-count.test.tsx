import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type UseProgressiveRenderCountOptions,
	type UseProgressiveRenderCountResult,
	useProgressiveRenderCount,
} from "@/hooks/use-progressive-render-count";

// 把 hook 渲染进一个探针组件，把每次渲染的结果暴露出来供断言。
function renderProgressiveRenderCountHook() {
	const results: UseProgressiveRenderCountResult[] = [];
	let setOptions: ((next: UseProgressiveRenderCountOptions) => void) | null = null;

	function Probe({ initialOptions }: { initialOptions: UseProgressiveRenderCountOptions }): null {
		const [options, updateOptions] = useState(initialOptions);
		setOptions = updateOptions;
		results.push(useProgressiveRenderCount(options));
		return null;
	}

	return { results, Probe, setOptions: (next: UseProgressiveRenderCountOptions) => setOptions?.(next) };
}

const neverScrollRoot = (): HTMLElement | null => null;

describe("useProgressiveRenderCount", () => {
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
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("caps the initial visible count at initialCount and reports the remainder", async () => {
		const { results, Probe } = renderProgressiveRenderCountHook();
		await act(async () => {
			root.render(<Probe initialOptions={{ totalCount: 15, getScrollRoot: neverScrollRoot }} />);
		});

		const latest = results.at(-1);
		expect(latest?.visibleCount).toBe(10);
		expect(latest?.hasMore).toBe(true);
		expect(latest?.remainingCount).toBe(5);
	});

	it("does not cap when the list is shorter than initialCount", async () => {
		const { results, Probe } = renderProgressiveRenderCountHook();
		await act(async () => {
			root.render(<Probe initialOptions={{ totalCount: 3, getScrollRoot: neverScrollRoot }} />);
		});

		const latest = results.at(-1);
		expect(latest?.visibleCount).toBe(3);
		expect(latest?.hasMore).toBe(false);
		expect(latest?.remainingCount).toBe(0);
	});

	it("reveals an additional batch when revealMore is called", async () => {
		const { results, Probe } = renderProgressiveRenderCountHook();
		await act(async () => {
			root.render(<Probe initialOptions={{ totalCount: 25, getScrollRoot: neverScrollRoot }} />);
		});
		expect(results.at(-1)?.visibleCount).toBe(10);

		await act(async () => {
			results.at(-1)?.revealMore();
		});
		expect(results.at(-1)?.visibleCount).toBe(20);

		await act(async () => {
			results.at(-1)?.revealMore();
		});
		// clamp 到 totalCount，不会超过 25。
		expect(results.at(-1)?.visibleCount).toBe(25);
		expect(results.at(-1)?.hasMore).toBe(false);
	});

	it("expands the initial window to include ensureVisibleIndex", async () => {
		const { results, Probe } = renderProgressiveRenderCountHook();
		await act(async () => {
			root.render(
				<Probe initialOptions={{ totalCount: 30, getScrollRoot: neverScrollRoot, ensureVisibleIndex: 12 }} />,
			);
		});

		const latest = results.at(-1);
		// index 12 → 至少渲染 13 张。
		expect(latest?.visibleCount).toBe(13);
		expect(latest?.hasMore).toBe(true);
		expect(latest?.remainingCount).toBe(17);
	});

	it("clamps visibleCount down when totalCount shrinks below the revealed count", async () => {
		const { results, Probe, setOptions } = renderProgressiveRenderCountHook();
		await act(async () => {
			root.render(<Probe initialOptions={{ totalCount: 25, getScrollRoot: neverScrollRoot }} />);
		});
		await act(async () => {
			results.at(-1)?.revealMore();
		});
		expect(results.at(-1)?.visibleCount).toBe(20);

		await act(async () => {
			setOptions({ totalCount: 4, getScrollRoot: neverScrollRoot });
		});
		expect(results.at(-1)?.visibleCount).toBe(4);
		expect(results.at(-1)?.hasMore).toBe(false);
	});
});
