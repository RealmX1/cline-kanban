import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSystemLoadAndRuntimeStatus } from "@/components/runtime-system-load-and-runtime-status";
import type { RuntimeSystemLoadAndRuntimeStatusSnapshot } from "@/runtime/types";
import {
	observeRuntimeSystemLoadAndRuntimeStatusSnapshot,
	updateRuntimeSystemStatusStreamConnectionState,
} from "@/stores/runtime-system-load-and-runtime-status-store";

const snapshot: RuntimeSystemLoadAndRuntimeStatusSnapshot = {
	sampledAtEpochMs: 1,
	cpuUsagePercent: 24,
	memory: { usedBytes: 18 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 },
	disk: { availableBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
	runtimeUptimeSeconds: 3661,
	liveAgentSessionCount: 7,
};

describe("全局系统概况入口", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		vi.useFakeTimers();
		snapshot.sampledAtEpochMs = Date.now();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	it("桌面概况独立订阅，无需重绘父工作台，15 秒后过期且收样后恢复", () => {
		let parentRenderCount = 0;
		function Workbench() {
			parentRenderCount += 1;
			return <RuntimeSystemLoadAndRuntimeStatus isMobile={false} />;
		}
		act(() => {
			observeRuntimeSystemLoadAndRuntimeStatusSnapshot(snapshot);
			root.render(<Workbench />);
		});
		expect(container.textContent).toContain("CPU 24%");
		expect(container.textContent).toContain("18/32 GB");
		act(() => {
			observeRuntimeSystemLoadAndRuntimeStatusSnapshot({ ...snapshot, cpuUsagePercent: 50 });
		});
		expect(container.textContent).toContain("CPU 50%");
		expect(parentRenderCount).toBe(1);
		act(() => vi.advanceTimersByTime(15_001));
		expect(container.textContent).toContain("数据已过期");
		act(() => observeRuntimeSystemLoadAndRuntimeStatusSnapshot({ ...snapshot, sampledAtEpochMs: Date.now() }));
		expect(container.textContent).not.toContain("数据已过期");
	});

	it("手机保持有可访问名称的图标入口，展开后展示完整指标与连接状态", () => {
		act(() => {
			observeRuntimeSystemLoadAndRuntimeStatusSnapshot(snapshot);
			updateRuntimeSystemStatusStreamConnectionState("reconnecting");
			root.render(<RuntimeSystemLoadAndRuntimeStatus isMobile />);
		});
		const button = container.querySelector("button");
		expect(button?.getAttribute("aria-label")).toBe("查看系统负载与运行状态");
		expect(button?.textContent).toBe("");
		act(() => button?.click());
		expect(document.body.textContent).toContain("重连中");
		expect(document.body.textContent).toContain("含缓存");
		expect(document.body.textContent).toContain("100 GB");
		expect(document.body.textContent).toContain("1 小时 1 分钟");
		expect(document.body.textContent).toContain("7");
		act(() => updateRuntimeSystemStatusStreamConnectionState("connected"));
		expect(document.body.textContent).toContain("已连接");
	});

	it("失败指标显示暂不可用，合法的零 CPU 仍显示 0%", () => {
		act(() => {
			observeRuntimeSystemLoadAndRuntimeStatusSnapshot({
				...snapshot,
				cpuUsagePercent: 0,
				memory: null,
				disk: null,
				liveAgentSessionCount: null,
			});
			root.render(<RuntimeSystemLoadAndRuntimeStatus isMobile={false} />);
		});
		expect(container.textContent).toContain("CPU 0%");
		act(() => container.querySelector("button")?.click());
		expect(document.body.textContent).toContain("暂不可用");
	});
});
