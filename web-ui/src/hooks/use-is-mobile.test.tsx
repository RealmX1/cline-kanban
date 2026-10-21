import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useIsMobile } from "@/hooks/use-is-mobile";

describe("手机断点首屏判定", () => {
	it.each([true, false])("首帧即采用媒体查询结果 %s，不先渲染桌面默认值", (matches) => {
		const matchMedia = vi.fn(() => ({
			matches,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		}));
		vi.stubGlobal("matchMedia", matchMedia);
		const committedValues: boolean[] = [];
		const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
		environment.IS_REACT_ACT_ENVIRONMENT = true;
		const host = document.createElement("div");
		const root = createRoot(host);
		function Harness() {
			const mobile = useIsMobile();
			useLayoutEffect(() => {
				committedValues.push(mobile);
			});
			return null;
		}
		try {
			act(() => root.render(<Harness />));
			expect(committedValues).toEqual([matches]);
		} finally {
			act(() => root.unmount());
			delete environment.IS_REACT_ACT_ENVIRONMENT;
			vi.unstubAllGlobals();
		}
	});
});
