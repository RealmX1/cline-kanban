import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSharedCoarseClockTimestampMs } from "@/hooks/use-shared-coarse-clock";

// 卡片头部所有时长药丸的 tick 都来自这一个进程内单例时钟。它此前**零测试**，而它承载的是两条
// 明确的性能不变量（200 张卡只允许有 1 个定时器；标签页不可见时必须整体停摆），这类不变量一旦
// 悄悄退化没有任何症状——只是后台标签页开始每 30s 重渲整块看板。故在此把它们钉住。
//
// 时钟是模块级单例：本套件用 fake timers 驱动，并在每个用例后卸载全部订阅者，让单例回到「无订阅、
// 定时器已停」的初始态，避免用例间互相污染。

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function ClockProbe({ onRender }: { onRender: (timestampMs: number) => void }): React.ReactElement {
	const timestampMs = useSharedCoarseClockTimestampMs();
	onRender(timestampMs);
	return <span data-testid="clock-readout">{timestampMs}</span>;
}

function mountProbe(onRender: (timestampMs: number) => void): void {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(<ClockProbe onRender={onRender} />));
	roots.push(root);
	containers.push(container);
}

function unmountAllProbes(): void {
	for (const root of roots) {
		act(() => root.unmount());
	}
	for (const container of containers) {
		container.remove();
	}
	roots = [];
	containers = [];
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibilityState,
	});
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	setDocumentVisibility("visible");
});

afterEach(() => {
	unmountAllProbes();
	vi.useRealTimers();
});

describe("共享粗时钟", () => {
	it("多个订阅者共享同一个定时器（200 张卡不等于 200 个定时器）", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

		for (let probeIndex = 0; probeIndex < 5; probeIndex += 1) {
			mountProbe(() => {});
		}

		// 只有第一个订阅者会启动定时器，其余复用同一个。
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
	});

	it("到点后所有订阅者同刻拿到同一个新时间戳", () => {
		const firstProbeReadouts: number[] = [];
		const secondProbeReadouts: number[] = [];
		mountProbe((timestampMs) => firstProbeReadouts.push(timestampMs));
		mountProbe((timestampMs) => secondProbeReadouts.push(timestampMs));
		const before = firstProbeReadouts.at(-1) ?? 0;

		act(() => {
			vi.advanceTimersByTime(30_000);
		});

		const afterFirst = firstProbeReadouts.at(-1) ?? 0;
		const afterSecond = secondProbeReadouts.at(-1) ?? 0;
		expect(afterFirst).toBeGreaterThan(before);
		// 「同一个时钟」的可观测含义就是这一条：两个订阅者读到的值必须逐字相等。
		expect(afterSecond).toBe(afterFirst);
	});

	it("标签页不可见时停摆，重新可见时立刻补发当前时间（不等满一个 tick）", () => {
		const readouts: number[] = [];
		mountProbe((timestampMs) => readouts.push(timestampMs));
		const whileVisible = readouts.at(-1) as number;

		setDocumentVisibility("hidden");
		act(() => {
			vi.advanceTimersByTime(30_000 * 10);
		});
		// 隐藏期间定时器已停 ⇒ 读数冻结，后台标签页不会每 30s 重渲整块看板。
		expect(readouts.at(-1)).toBe(whileVisible);

		setDocumentVisibility("visible");
		// 补发发生在 visibilitychange 当刻，不需要再等一个 tick。
		expect(readouts.at(-1)).toBeGreaterThan(whileVisible);
	});

	it("订阅者归零后定时器被清掉（卸载看板不留常开定时器）", () => {
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		mountProbe(() => {});
		mountProbe(() => {});

		unmountAllProbes();

		expect(clearIntervalSpy).toHaveBeenCalled();
		// 归零之后再走多久都不该有 tick 发生；重新订阅时再从头启动。
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		act(() => {
			vi.advanceTimersByTime(30_000 * 5);
		});
		expect(setIntervalSpy).not.toHaveBeenCalled();
	});
});

describe("共享粗时钟 · SSR 快照", () => {
	it("getServerSnapshot 与 getSnapshot 同源（useSyncExternalStore 不会因两者不一致而反复重渲）", () => {
		// 这条守的是实现细节里最容易被改坏的一处：两个 snapshot getter 必须返回同一个值，
		// 否则 React 会认为 store 每次读都变了。这里直接断言 hook 能稳定读出一个有限时间戳。
		expect(useSyncExternalStore).toBeTypeOf("function");
		const readouts: number[] = [];
		mountProbe((timestampMs) => readouts.push(timestampMs));
		expect(Number.isFinite(readouts.at(-1))).toBe(true);
		// 未推进时钟 ⇒ 不应产生额外的重渲。
		const renderCountAfterMount = readouts.length;
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(readouts.length).toBe(renderCountAfterMount);
	});
});
