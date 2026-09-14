import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	boardColumnAnchorKey,
	boardTaskCardAnchorKey,
	spotlightAnchor,
	taskDetailAnchorKey,
	VERIFICATION_ANCHOR_ATTR,
	VERIFICATION_SPOTLIGHT_CLASS,
	verificationPanelTaskAnchorKey,
} from "./verification-anchor-registry";

describe("verification-anchor-registry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// jsdom 未实现 scrollIntoView，spotlightAnchor 会调用它 → 打桩避免抛错。
		Element.prototype.scrollIntoView = vi.fn();
		document.body.innerHTML = "";
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	it("key 构造器产出稳定、可区分的命名", () => {
		expect(boardTaskCardAnchorKey("t1")).toBe("board-task-card:t1");
		expect(boardColumnAnchorKey("review")).toBe("board-column:review");
		expect(taskDetailAnchorKey("t1")).toBe("task-detail:t1");
		expect(verificationPanelTaskAnchorKey("t1")).toBe("verification-panel-task:t1");
	});

	it("spotlightAnchor 命中：滚入视野 + 临时挂高亮类，超时后摘除", () => {
		const key = boardTaskCardAnchorKey("t1");
		const el = document.createElement("div");
		el.setAttribute(VERIFICATION_ANCHOR_ATTR, key);
		document.body.appendChild(el);

		const hit = spotlightAnchor(key, { durationMs: 1000 });

		expect(hit).toBe(true);
		expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(el.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);

		vi.advanceTimersByTime(1000);
		expect(el.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(false);
	});

	it("spotlightAnchor 对同一元素连点：重播脉冲动画，并按最后一次调用重新计时", () => {
		const key = boardTaskCardAnchorKey("t1");
		const el = document.createElement("div");
		el.setAttribute(VERIFICATION_ANCHOR_ATTR, key);
		document.body.appendChild(el);
		const classAttributeMutations = new MutationObserver(() => {});
		classAttributeMutations.observe(el, { attributes: true, attributeFilter: ["class"] });

		spotlightAnchor(key, { durationMs: 1000 });
		classAttributeMutations.takeRecords();

		// 第一次高亮还没熄灭时再来一次：必须摘掉高亮类再挂回去，否则 CSS 动画不会从头重播。
		vi.advanceTimersByTime(400);
		expect(spotlightAnchor(key, { durationMs: 1000 })).toBe(true);
		expect(classAttributeMutations.takeRecords().length).toBeGreaterThanOrEqual(2);
		expect(el.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);

		// 第一次留下的旧计时器本会在此刻掐灭高亮，撤掉它之后高亮应活满第二次的完整时长。
		vi.advanceTimersByTime(600);
		expect(el.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);

		vi.advanceTimersByTime(400);
		expect(el.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(false);
	});

	it("spotlightAnchor 未命中：返回 false，不抛错", () => {
		expect(spotlightAnchor("does-not-exist")).toBe(false);
	});

	it("spotlightAnchor 按 anchorKey 精确匹配（含特殊字符 key 也不误伤 CSS 选择器）", () => {
		const trickyKey = 'task-detail:weird"id[0]';
		const el = document.createElement("div");
		el.setAttribute(VERIFICATION_ANCHOR_ATTR, trickyKey);
		document.body.appendChild(el);

		expect(spotlightAnchor(trickyKey)).toBe(true);
		expect(el.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);
	});
});
