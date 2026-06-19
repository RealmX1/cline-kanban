import { describe, expect, it } from "vitest";

import { isSafariUserAgent } from "@/utils/platform";

describe("isSafariUserAgent", () => {
	// 真实 Safari（macOS / iOS / iPadOS 桌面级 UA）应判定为 Safari → 走 DOM 渲染器。
	it.each([
		[
			"macOS Safari",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
		],
		[
			"iOS Safari (iPhone)",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
		],
		[
			"iPadOS Safari (desktop-class UA)",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
		],
	])("returns true for %s", (_label, userAgent) => {
		expect(isSafariUserAgent(userAgent)).toBe(true);
	});

	// 其它浏览器（含 UA 里也带 "Safari" 字样的 Chromium 系，以及 iOS 上的非 Safari 浏览器）
	// 必须判定为非 Safari → 保留 WebGL 渲染器。
	it.each([
		[
			"Chrome on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
		],
		[
			"Chromium Edge on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
		],
		[
			"Chrome on iOS (CriOS)",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1",
		],
		[
			"Firefox on iOS (FxiOS)",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15",
		],
		["Firefox on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0"],
		[
			"Opera on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0",
		],
		["empty user agent", ""],
	])("returns false for %s", (_label, userAgent) => {
		expect(isSafariUserAgent(userAgent)).toBe(false);
	});
});
