import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

import {
	measureTerminalVirtualKeyBarViewportBottomInsetPx,
	TERMINAL_VIRTUAL_KEY_BAR_VIEWPORT_BOTTOM_INSET_CSS_VARIABLE_NAME,
} from "../src/terminal/terminal-virtual-key-bar-viewport-bottom-inset";

/** 验证面板与引导浮层的实际 fixed 定位必须避开虚拟按键条及其下方兄弟内容。
 * 使用生产 CSS 与同源测量函数，不连接运行时、不改用户任务。
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
const verificationFloatingPanelRule = extractCssRule(globalsCss, ".kb-viewport-bottom-verification-floating-panel {");

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
			.verification-floating-panel { position: fixed; right: 16px; height: 40px; width: 40px; }
			${verificationFloatingPanelRule}
			.bottom-stack { position: fixed; left: 0; right: 0; bottom: 0; }
			.virtual-key-bar { height: ${VIRTUAL_KEY_BAR_HEIGHT_PX}px; }
			.content-below-key-bar { height: ${contentBelowKeyBarHeightPx}px; }
		</style>
		<div class="bottom-stack">
			<div class="virtual-key-bar" data-testid="virtual-key-bar"></div>
			<div class="content-below-key-bar" data-testid="content-below-key-bar"></div>
		</div>
		<div class="verification-floating-panel kb-viewport-bottom-verification-floating-panel" data-testid="verification-floating-panel"></div>
	`;
}

/** 没有按键条的视图（桌面端、合成 shell 会话）：变量根本不会被写上去。 */
function buildSyntheticPageWithoutVirtualKeyBar(): string {
	return `
		<style>
			body { margin: 0; height: 100vh; }
			.verification-floating-panel { position: fixed; right: 16px; height: 40px; width: 40px; }
			${verificationFloatingPanelRule}
		</style>
		<div class="verification-floating-panel kb-viewport-bottom-verification-floating-panel" data-testid="verification-floating-panel"></div>
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

async function expectVerificationFloatingPanelToClearTheVirtualKeyBar(page: Page): Promise<void> {
	const verificationFloatingPanel = await readBoundingBox(page, "verification-floating-panel");
	const virtualKeyBar = await readBoundingBox(page, "virtual-key-bar");
	expect(verificationFloatingPanel.y + verificationFloatingPanel.height).toBeLessThanOrEqual(virtualKeyBar.y);
}

test.describe("verification floating panels vs the terminal virtual key bar", () => {
	test.use({ viewport: { width: 390, height: VIEWPORT_HEIGHT_PX } });

	test("verification floating panels sit entirely above the key bar when it is flush with the viewport bottom", async ({
		page,
	}) => {
		await page.setContent(buildSyntheticPage(0));

		const publishedInsetPx = await publishViewportBottomInsetTheWayTheHookDoes(page);

		expect(publishedInsetPx).toBe(VIRTUAL_KEY_BAR_HEIGHT_PX);
		await expectVerificationFloatingPanelToClearTheVirtualKeyBar(page);
	});

	// review / validation 在按键条下方还有错误横幅与动作块，测量必须包含这些兄弟节点。
	for (const contentBelowKeyBarHeightPx of [48, 124]) {
		test(`verification floating panels clear the key bar with ${contentBelowKeyBarHeightPx}px of siblings stacked below it`, async ({
			page,
		}) => {
			await page.setContent(buildSyntheticPage(contentBelowKeyBarHeightPx));

			const publishedInsetPx = await publishViewportBottomInsetTheWayTheHookDoes(page);

			// 发布的是「视口底 → 按键条顶边」的距离，不是按键条自身高度。
			expect(publishedInsetPx).toBe(VIRTUAL_KEY_BAR_HEIGHT_PX + contentBelowKeyBarHeightPx);
			await expectVerificationFloatingPanelToClearTheVirtualKeyBar(page);
		});
	}

	test("falls back to the original position when no key bar is mounted", async ({ page }) => {
		// 桌面端与任何没有按键条的视图不该因为这条规则而移位，故变量缺省必须等价于旧的 bottom-20。
		await page.setContent(buildSyntheticPageWithoutVirtualKeyBar());

		const verificationFloatingPanel = await readBoundingBox(page, "verification-floating-panel");

		expect(verificationFloatingPanel.y + verificationFloatingPanel.height).toBe(VIEWPORT_HEIGHT_PX - 80);
	});
});

// 只替换 App，保留 main.tsx 中的真实 Toaster 配置、Sonner CSS 和按键条实测 hook。
const toastAndVirtualKeyBarFixtureApp = `
import React from '/node_modules/.vite/deps/react.js';
import { TerminalVirtualKeyInputBar } from '/src/components/detail-panels/terminal-virtual-key-input-bar.tsx';
import { showAppToast } from '/src/components/app-toaster.ts';
import { useIsMobile } from '/src/hooks/use-is-mobile.ts';
const h = React.createElement;
export default function FixtureApp() {
 const isMobile = useIsMobile();
 const [showVirtualKeyBar, setShowVirtualKeyBar] = React.useState(true);
 return h(React.Fragment, null,
  h('button', { onClick: () => showAppToast({ message: '真实 toast 定位回归', timeout: 60000 }) }, '显示定位验证 toast'),
  h('button', { onClick: () => setShowVirtualKeyBar(false) }, '卸载虚拟按键条'),
  isMobile && showVirtualKeyBar ? h('div', { style: { position: 'fixed', left: 0, right: 0, bottom: 0 } },
   h(TerminalVirtualKeyInputBar, { taskId: 'isolated-toast-layout-fixture' }),
   h('div', { style: { height: 48 } })) : null);
}
`;

for (const viewportWidthPx of [390, 700, 1440]) {
	test(`真实 toast 在 ${viewportWidthPx}px 视口避让按键条，卸载后恢复 Sonner 默认间距`, async ({ page }) => {
		await page.setViewportSize({ width: viewportWidthPx, height: VIEWPORT_HEIGHT_PX });
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.route("**/api/**", (route) => route.fulfill({ json: { required: false, authenticated: true } }));
		await page.route("**/src/telemetry/sentry.ts*", (route) =>
			route.fulfill({ contentType: "text/javascript", body: "export function initializeSentry() {}" }),
		);
		await page.route("**/src/App.tsx*", (route) =>
			route.fulfill({ contentType: "text/javascript", body: toastAndVirtualKeyBarFixtureApp }),
		);
		await page.goto("/");
		await page.getByRole("button", { name: "显示定位验证 toast" }).click();
		const toast = page.locator("[data-sonner-toast]").filter({ hasText: "真实 toast 定位回归" });
		await expect(toast).toHaveAttribute("data-mounted", "true");
		const defaultBottomOffsetPx = viewportWidthPx <= 600 ? 16 : 24;
		const toaster = page.locator("[data-sonner-toaster]");

		if (viewportWidthPx !== 1440) {
			const virtualKeyBar = page
				.getByRole("button", { name: "Submit the current selection or input", exact: true })
				.locator("../..");
			await expect(virtualKeyBar).toBeVisible();
			const expectedInsetPx = await virtualKeyBar.evaluate(measureTerminalVirtualKeyBarViewportBottomInsetPx);
			await expect(toaster).toHaveCSS("bottom", `${expectedInsetPx + defaultBottomOffsetPx}px`);
			const toastBottomPx = await toast.evaluate((element) => element.getBoundingClientRect().bottom);
			const keyBarTopPx = await virtualKeyBar.evaluate((element) => element.getBoundingClientRect().top);
			expect(toastBottomPx).toBeLessThanOrEqual(keyBarTopPx);
			expect(keyBarTopPx - toastBottomPx).toBeCloseTo(defaultBottomOffsetPx);
			await page.getByRole("button", { name: "卸载虚拟按键条" }).click();
			await expect(virtualKeyBar).toHaveCount(0);
		}

		await expect(toaster).toHaveCSS("bottom", `${defaultBottomOffsetPx}px`);
		const toastBottomPx = await toast.evaluate((element) => element.getBoundingClientRect().bottom);
		expect(VIEWPORT_HEIGHT_PX - toastBottomPx).toBeCloseTo(defaultBottomOffsetPx);
	});
}
