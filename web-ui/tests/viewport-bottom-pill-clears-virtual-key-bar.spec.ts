import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

import {
	measureTerminalVirtualKeyBarViewportBottomInsetPx,
	TERMINAL_VIRTUAL_KEY_BAR_VIEWPORT_BOTTOM_INSET_CSS_VARIABLE_NAME,
} from "../src/terminal/terminal-virtual-key-bar-viewport-bottom-inset";

/**
 * 「Report bug / Post-Deploy Verification 两枚浮动 pill 必须让开移动端虚拟按键条」的真实浏览器验证。
 *
 * 为什么非得进真浏览器：让位靠的是 `bottom: calc(1rem + var(--…, 0px))` —— CSS 变量继承 +
 * calc 求值 + fixed 定位三者叠加的最终几何，jsdom 只会把它当字符串存下来，算不出实际位置，
 * 断言不到「pill 是不是真的抬到了按键条上方」。
 *
 * 不连接 runtime：用 page.setContent 复刻，并从 globals.css **逐字**取出生效规则，保证同源。
 * 让位量同样不在这里另抄一份，而是把 `measureTerminalVirtualKeyBarViewportBottomInsetPx`
 * 整段序列化进页面执行 —— 测的是生产代码的取值口径本身，口径若退回「按键条自身高度」，
 * 下面「按键条下方还有兄弟内容」的用例会立刻红。
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const globalsCssPath = resolve(currentDir, "../src/styles/globals.css");

function extractCssRule(css: string, selectorAnchor: string): string {
	const start = css.indexOf(selectorAnchor);
	if (start === -1) {
		throw new Error(`Could not find CSS anchor "${selectorAnchor}" in globals.css`);
	}
	const open = css.indexOf("{", start);
	const close = css.indexOf("}", open);
	if (open === -1 || close === -1) {
		throw new Error(`Malformed CSS block for anchor "${selectorAnchor}"`);
	}
	return css.slice(start, close + 1);
}

const globalsCss = readFileSync(globalsCssPath, "utf-8");
const primaryPillRule = extractCssRule(globalsCss, ".kb-viewport-bottom-pill-primary {");
const stackedPillRule = extractCssRule(globalsCss, ".kb-viewport-bottom-pill-stacked {");

const VIEWPORT_HEIGHT_PX = 844;
const VIRTUAL_KEY_BAR_HEIGHT_PX = 86;

/**
 * 复刻 `agent-terminal-panel.tsx` 底部那一摞：按键条永远在，其下方按列不同还会挂 lastError
 * 横幅与 review 动作块。`contentBelowKeyBarHeightPx` 就是那些兄弟节点的合计高度。
 */
function buildSyntheticPage(contentBelowKeyBarHeightPx: number): string {
	return `
		<style>
			body { margin: 0; height: 100vh; }
			.pill { position: fixed; right: 16px; height: 40px; width: 40px; }
			${primaryPillRule}
			${stackedPillRule}
			.bottom-stack { position: fixed; left: 0; right: 0; bottom: 0; }
			.virtual-key-bar { height: ${VIRTUAL_KEY_BAR_HEIGHT_PX}px; }
			.content-below-key-bar { height: ${contentBelowKeyBarHeightPx}px; }
		</style>
		<div class="bottom-stack">
			<div class="virtual-key-bar" data-testid="virtual-key-bar"></div>
			<div class="content-below-key-bar" data-testid="content-below-key-bar"></div>
		</div>
		<div class="pill kb-viewport-bottom-pill-primary" data-testid="bug-report-pill"></div>
		<div class="pill kb-viewport-bottom-pill-stacked" data-testid="verification-pill"></div>
	`;
}

/** 没有按键条的视图（桌面端、合成 shell 会话）：变量根本不会被写上去。 */
function buildSyntheticPageWithoutVirtualKeyBar(): string {
	return `
		<style>
			body { margin: 0; height: 100vh; }
			.pill { position: fixed; right: 16px; height: 40px; width: 40px; }
			${primaryPillRule}
			${stackedPillRule}
		</style>
		<div class="pill kb-viewport-bottom-pill-primary" data-testid="bug-report-pill"></div>
		<div class="pill kb-viewport-bottom-pill-stacked" data-testid="verification-pill"></div>
	`;
}

/** 用生产代码的取值口径量出让位量，并像 hook 那样发布到 `<html>` 上。 */
async function publishViewportBottomInsetTheWayTheHookDoes(page: Page): Promise<number> {
	const measuredInsetPx = await page
		.getByTestId("virtual-key-bar")
		.evaluate(measureTerminalVirtualKeyBarViewportBottomInsetPx);
	await page.evaluate(
		({ cssVariableName, insetPx }) => {
			document.documentElement.style.setProperty(cssVariableName, `${insetPx}px`);
		},
		{ cssVariableName: TERMINAL_VIRTUAL_KEY_BAR_VIEWPORT_BOTTOM_INSET_CSS_VARIABLE_NAME, insetPx: measuredInsetPx },
	);
	return measuredInsetPx;
}

async function readBoundingBox(page: Page, testId: string) {
	const box = await page.getByTestId(testId).boundingBox();
	if (!box) {
		throw new Error(`No layout box for "${testId}"`);
	}
	return box;
}

async function expectBothPillsToClearTheVirtualKeyBar(page: Page): Promise<void> {
	const bugReportPill = await readBoundingBox(page, "bug-report-pill");
	const verificationPill = await readBoundingBox(page, "verification-pill");
	const virtualKeyBar = await readBoundingBox(page, "virtual-key-bar");

	// 「整个 pill 都在按键条上方」而不只是「起点更高」：pill 底边不得越过按键条顶边。
	expect(bugReportPill.y + bugReportPill.height).toBeLessThanOrEqual(virtualKeyBar.y);
	expect(verificationPill.y + verificationPill.height).toBeLessThanOrEqual(virtualKeyBar.y);
	// 两枚 pill 仍保持原有的上下堆叠关系，不会重叠成一坨。
	expect(verificationPill.y).toBeLessThan(bugReportPill.y);
}

test.describe("viewport-bottom pills vs the terminal virtual key bar", () => {
	test.use({ viewport: { width: 390, height: VIEWPORT_HEIGHT_PX } });

	test("both pills sit entirely above the key bar when it is flush with the viewport bottom", async ({ page }) => {
		await page.setContent(buildSyntheticPage(0));

		const publishedInsetPx = await publishViewportBottomInsetTheWayTheHookDoes(page);

		expect(publishedInsetPx).toBe(VIRTUAL_KEY_BAR_HEIGHT_PX);
		await expectBothPillsToClearTheVirtualKeyBar(page);
	});

	// review / validation 两列会在按键条下方再渲染 lastError 横幅与 Commit / Open PR /
	// Move Card To Validation / Move Card To Done 动作块，按键条因此并不贴视口底。
	// 48px 与 124px 是实测出「Report bug pill 压住 ← ↓ → 整行」「Post-Deploy Verification pill
	// 也一起压上来」的两档，正是本回归要钉死的用户症状。
	for (const contentBelowKeyBarHeightPx of [48, 124]) {
		test(`both pills clear the key bar with ${contentBelowKeyBarHeightPx}px of siblings stacked below it`, async ({
			page,
		}) => {
			await page.setContent(buildSyntheticPage(contentBelowKeyBarHeightPx));

			const publishedInsetPx = await publishViewportBottomInsetTheWayTheHookDoes(page);

			// 发布的是「视口底 → 按键条顶边」的距离，不是按键条自身高度。
			expect(publishedInsetPx).toBe(VIRTUAL_KEY_BAR_HEIGHT_PX + contentBelowKeyBarHeightPx);
			await expectBothPillsToClearTheVirtualKeyBar(page);
		});
	}

	test("falls back to the original position when no key bar is mounted", async ({ page }) => {
		// 桌面端与任何没有按键条的视图不该因为这条规则而移位，故变量缺省必须等价于旧的 bottom-4 / bottom-20。
		await page.setContent(buildSyntheticPageWithoutVirtualKeyBar());

		const bugReportPill = await readBoundingBox(page, "bug-report-pill");
		const verificationPill = await readBoundingBox(page, "verification-pill");

		expect(bugReportPill.y + bugReportPill.height).toBe(VIEWPORT_HEIGHT_PX - 16);
		expect(verificationPill.y + verificationPill.height).toBe(VIEWPORT_HEIGHT_PX - 80);
	});
});
