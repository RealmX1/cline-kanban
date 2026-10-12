import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp,
	SESSION_ACTIVITY_DOT_BREATHING_DIMMED_PHASE_OPACITY,
	useSessionActivityDotBreathingOpacityOnSharedFineClock,
} from "@/hooks/use-session-activity-dot-breathing-opacity-on-shared-fine-clock";

// 「agent 正在产出」状态点的 1Hz 呼吸：按共享细时钟的秒数奇偶在两档不透明度之间离散切换（替代 animate-pulse，
// 后者让看板页可见期间逐帧合成）。这里钉住两条：亮暗相随秒数交替；不呼吸的点不订阅时钟、不设 opacity。

describe("resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp", () => {
	it("偶数秒亮相、奇数秒暗相，同一秒内不变", () => {
		expect(resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp(10_000)).toBe(1);
		expect(resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp(10_999)).toBe(1);
		expect(resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp(11_000)).toBe(
			SESSION_ACTIVITY_DOT_BREATHING_DIMMED_PHASE_OPACITY,
		);
		expect(resolveSessionActivityDotBreathingOpacityAtSharedFineClockTimestamp(12_001)).toBe(1);
	});
});

describe("useSessionActivityDotBreathingOpacityOnSharedFineClock", () => {
	let container: HTMLDivElement;
	let root: Root;

	function BreathingDotProbe({ isBreathing }: { isBreathing: boolean }): React.ReactElement {
		const opacity = useSessionActivityDotBreathingOpacityOnSharedFineClock(isBreathing);
		return <span data-testid="breathing-dot" style={{ opacity }} />;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(20_000));
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	it("呼吸时随共享细时钟每秒切换一次亮暗", () => {
		act(() => root.render(<BreathingDotProbe isBreathing />));
		const dot = () => container.querySelector<HTMLSpanElement>('[data-testid="breathing-dot"]');
		expect(dot()?.style.opacity).toBe("1");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(dot()?.style.opacity).toBe(String(SESSION_ACTIVITY_DOT_BREATHING_DIMMED_PHASE_OPACITY));
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(dot()?.style.opacity).toBe("1");
	});

	it("不呼吸时不设 opacity", () => {
		act(() => root.render(<BreathingDotProbe isBreathing={false} />));
		expect(container.querySelector<HTMLSpanElement>('[data-testid="breathing-dot"]')?.style.opacity).toBe("");
	});
});
