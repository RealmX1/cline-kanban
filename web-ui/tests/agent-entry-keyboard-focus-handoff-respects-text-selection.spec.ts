import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

import { extractConstantSource, extractFunctionSource, stripTypeAnnotations } from "./production-source-extraction";

/**
 * 「选中新卡后自动把键盘焦点交给 agent 输入入口，但不得因此让卡片上的文字选不了」的真实浏览器验证。
 *
 * 为什么非得进真浏览器：这条约束的成立与否取决于真实的鼠标拖选——按下、拖动、松开三步产生的
 * `window.getSelection()` 状态，以及 `element.focus()` 是否真的把它 collapse 掉。jsdom 的 Selection
 * 是手工 addRange 出来的近似物，既没有拖选路径，focus 也不会真的清选区，测不到这条约束。
 *
 * 不连接 runtime：合成页复刻「一张带文字的卡片 + 一个 agent 输入框」，守卫函数取生产源码原文。
 */

const currentDir = dirname(fileURLToPath(import.meta.url));

const focusHandoffSource = readFileSync(
	resolve(currentDir, "../src/utils/keyboard-focus-handoff-to-agent-entry.ts"),
	"utf-8",
);
const mobileViewportSource = readFileSync(resolve(currentDir, "../src/utils/mobile-viewport-breakpoint.ts"), "utf-8");

const productionFocusHandoffGuard = [
	extractConstantSource(mobileViewportSource, "MOBILE_VIEWPORT_MAX_WIDTH_PX"),
	extractConstantSource(mobileViewportSource, "MOBILE_VIEWPORT_MEDIA_QUERY"),
	stripTypeAnnotations(extractFunctionSource(mobileViewportSource, "matchesMobileViewportNow")),
	stripTypeAnnotations(extractFunctionSource(focusHandoffSource, "isEditableElement")),
	stripTypeAnnotations(extractFunctionSource(focusHandoffSource, "hasLiveUserTextSelection")),
	stripTypeAnnotations(extractFunctionSource(focusHandoffSource, "shouldHandOffKeyboardFocusToAgentEntryNow")),
].join("\n\n");

const CARD_TITLE_TEXT = "Refactor the persistent terminal manager";

// 合成页：一张带标题文字的 task card + 一个 agent 输入框。`handOffKeyboardFocusToAgentEntry` 复刻
// 详情视图切卡后的那次交接——先过守卫，通过才 focus。
const syntheticCardPageScript = `
${productionFocusHandoffGuard}

window.agentEntryKeyboardFocusHandoffProbe = {
	handOffKeyboardFocusToAgentEntry() {
		if (!shouldHandOffKeyboardFocusToAgentEntryNow()) {
			return false;
		}
		document.getElementById("agent-entry").focus();
		return true;
	},
	readSelectedText() {
		return window.getSelection()?.toString() ?? "";
	},
	isAgentEntryFocused() {
		return document.activeElement === document.getElementById("agent-entry");
	},
};
`;

type AgentEntryKeyboardFocusHandoffProbeMethod =
	| "handOffKeyboardFocusToAgentEntry"
	| "readSelectedText"
	| "isAgentEntryFocused";

async function callProbe(page: Page, method: AgentEntryKeyboardFocusHandoffProbeMethod): Promise<unknown> {
	return await page.evaluate((probeMethod) => {
		const probe = (window as unknown as { agentEntryKeyboardFocusHandoffProbe: Record<string, () => unknown> })
			.agentEntryKeyboardFocusHandoffProbe;
		return probe[probeMethod]?.();
	}, method);
}

async function openSyntheticCardPage(page: Page): Promise<void> {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.setContent(
		`<div style="font:16px/1.5 system-ui;padding:24px">` +
			`<div id="card-title" style="width:520px;padding:12px;border:1px solid #ccc">${CARD_TITLE_TEXT}</div>` +
			`<textarea id="agent-entry" style="margin-top:24px;width:520px;height:80px"></textarea>` +
			`</div>`,
	);
	await page.addScriptTag({ content: syntheticCardPageScript });
}

async function dragSelectCardTitle(page: Page): Promise<void> {
	const titleBox = await page.locator("#card-title").boundingBox();
	if (!titleBox) {
		throw new Error("Missing card title box.");
	}
	const centerY = titleBox.y + titleBox.height / 2;
	await page.mouse.move(titleBox.x + 14, centerY);
	await page.mouse.down();
	await page.mouse.move(titleBox.x + titleBox.width - 14, centerY, { steps: 12 });
	await page.mouse.up();
}

test("用户拖选卡片文字时不抢焦点，选区原样保留", async ({ page }) => {
	await openSyntheticCardPage(page);
	await dragSelectCardTitle(page);
	expect(await callProbe(page, "readSelectedText")).not.toBe("");

	const didHandOff = await callProbe(page, "handOffKeyboardFocusToAgentEntry");

	expect(didHandOff).toBe(false);
	expect(await callProbe(page, "isAgentEntryFocused")).toBe(false);
	// 抢了焦点就会 collapse 掉选区——这里必须还选得好好的。
	expect(await callProbe(page, "readSelectedText")).not.toBe("");
});

test("没有选区时照常把焦点交给 agent 输入入口", async ({ page }) => {
	await openSyntheticCardPage(page);

	const didHandOff = await callProbe(page, "handOffKeyboardFocusToAgentEntry");

	expect(didHandOff).toBe(true);
	expect(await callProbe(page, "isAgentEntryFocused")).toBe(true);
});

test("拖选后再单击清掉选区，焦点交接随即恢复", async ({ page }) => {
	await openSyntheticCardPage(page);
	await dragSelectCardTitle(page);
	await page.locator("#card-title").click({ position: { x: 4, y: 4 } });

	const didHandOff = await callProbe(page, "handOffKeyboardFocusToAgentEntry");

	expect(didHandOff).toBe(true);
	expect(await callProbe(page, "isAgentEntryFocused")).toBe(true);
});
