import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * 回归：PDV 核对项的断言 label 里常有不可断行的长标识符（真实案例 7cb70：
 * 「跨项目任务搜索索引对每个任务都投影 agentConversationProgressObservedAt，…」）。
 * 文本 span 缺 `min-w-0` 时，flex 子项最小宽度 = 最长不可断片段，于是状态徽标被挤出卡片右边、
 * 运行按钮被挤出面板的 overflow 裁剪区（看不见也点不到）。jsdom 不做布局，只能在真实浏览器里量。
 *
 * 只替换 App：保留 main.tsx 的真实 TooltipProvider 与全局 CSS，渲染生产的核对项组件。
 */

const LONG_UNBREAKABLE_IDENTIFIER_LABEL =
	"跨项目任务搜索索引对每个任务都投影 agentConversationProgressObservedAt，且与盘上 sessions.json 的推进时刻一致（相等或更新；更早/无值只容许罕见的内存回纠）";

const checklistItemFixtureApp = `
import React from '/node_modules/.vite/deps/react.js';
import { PostDeployVerificationChecklistItem } from '/src/components/post-deploy-verification/post-deploy-verification-checklist-item.tsx';
const h = React.createElement;
const label = ${JSON.stringify(LONG_UNBREAKABLE_IDENTIFIER_LABEL)};
const noop = () => {};
const automatedScriptItem = {
 id: 'authored:automated', label, checked: false, source: 'authored', kind: 'automated_script',
 guidance: null, script: { entrypoint: 'run.js', interpreter: 'node', timeoutMs: 60000 }, run: null,
 cleanup: { mode: 'automatic', assetsDir: '/tmp/verification-assets', manualSteps: [] },
};
const guidedManualItem = {
 id: 'authored:guided', label, checked: false, source: 'authored', kind: 'guided_manual',
 guidance: { steps: ['打开看板'], expectedObservation: '看到预期', failureSignature: '没看到', anchor: { view: 'board' } },
 script: null, run: null, cleanup: null,
};
function Slot({ testId, widthPx, item }) {
 return h('div', { 'data-testid': testId, style: { width: widthPx, overflow: 'hidden', border: '1px solid transparent' } },
  h(PostDeployVerificationChecklistItem, {
   item, interactive: true, isCompleting: false, taskVerified: false,
   onToggle: noop, onRun: noop, onRemoveCustom: noop, onLocate: noop,
  }));
}
export default function FixtureApp() {
 return h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 16 } },
  h(Slot, { testId: 'automated-script-item-slot-200', widthPx: 200, item: automatedScriptItem }),
  h(Slot, { testId: 'automated-script-item-slot-300', widthPx: 300, item: automatedScriptItem }),
  h(Slot, { testId: 'guided-manual-item-slot-200', widthPx: 200, item: guidedManualItem }));
}
`;

async function mountChecklistItemFixture(page: Page): Promise<void> {
	await page.route("**/api/**", (route) => route.fulfill({ json: { required: false, authenticated: true } }));
	await page.route("**/src/telemetry/sentry.ts*", (route) =>
		route.fulfill({ contentType: "text/javascript", body: "export function initializeSentry() {}" }),
	);
	await page.route("**/src/App.tsx*", (route) =>
		route.fulfill({ contentType: "text/javascript", body: checklistItemFixtureApp }),
	);
	await page.goto("/");
}

async function readRightEdgePx(locator: Locator): Promise<number> {
	const box = await locator.boundingBox();
	if (!box) {
		throw new Error("element has no layout box");
	}
	return box.x + box.width;
}

async function expectElementRightEdgeInsideSlot(slot: Locator, element: Locator): Promise<void> {
	await expect(element).toBeVisible();
	const slotRightEdgePx = await readRightEdgePx(slot);
	const elementRightEdgePx = await readRightEdgePx(element);
	// 允许亚像素舍入。
	expect(elementRightEdgePx).toBeLessThanOrEqual(slotRightEdgePx + 0.5);
}

test.describe("PDV 核对项：长不可断标识符不把控件挤出卡片", () => {
	for (const slotWidthPx of [200, 300]) {
		test(`脚本项在 ${slotWidthPx}px 宽时，运行按钮与「未运行」徽标都留在卡片内且可点`, async ({ page }) => {
			await mountChecklistItemFixture(page);
			const slot = page.getByTestId(`automated-script-item-slot-${slotWidthPx}`);
			const runButton = slot.getByRole("button", { name: "运行验证脚本" });
			const notRunStatusBadge = slot.getByText("未运行", { exact: true });

			await expectElementRightEdgeInsideSlot(slot, runButton);
			await expectElementRightEdgeInsideSlot(slot, notRunStatusBadge);
			await expectElementRightEdgeInsideSlot(slot, slot.getByText(LONG_UNBREAKABLE_IDENTIFIER_LABEL));
			// 被 overflow 裁掉时 boundingBox 仍可能在盒内，再用命中测试确认按钮中心点真的落在按钮自己身上。
			await runButton.click({ trial: true });
		});
	}

	test("引导项在 200px 宽时，「定位并核对」按钮留在卡片内且可点", async ({ page }) => {
		await mountChecklistItemFixture(page);
		const slot = page.getByTestId("guided-manual-item-slot-200");
		const locateButton = slot.getByRole("button", { name: "定位并核对" });

		await expectElementRightEdgeInsideSlot(slot, locateButton);
		await locateButton.click({ trial: true });
	});
});
