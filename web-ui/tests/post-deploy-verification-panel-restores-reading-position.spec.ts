import { expect, type Locator, type Page, test } from "@playwright/test";

// 只替换 App，使用生产面板、真实卡体与全局 CSS；所有 API 都被拦截，不接触用户任务。
const panelReadingPositionFixtureApp = `
import React from '/node_modules/.vite/deps/react.js';
import { PostDeployVerificationPanel } from '/src/components/post-deploy-verification/post-deploy-verification-panel.tsx';
import { createInitialBoardData } from '/src/data/board-data.ts';
import { createPostDeployVerificationTaskReadModelTestFixture } from '/src/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures.ts';
const h = React.createElement;
const noop = () => {};
const workspaceId = 'isolated-pdv-reading-position-project';
const zones = [
 'task_commits_included_in_this_deployment_delta',
 'task_commits_deployed_only_in_earlier_deployments_awaiting_verification',
 'task_commits_not_yet_deployed_or_task_unattributable',
];
function makeTask(taskId, zoneIndex) {
 return createPostDeployVerificationTaskReadModelTestFixture({
  taskId,
  taskDeploymentAttribution: {
   taskDeploymentAttributionZone: zones[zoneIndex],
   matchedDeployedCommitsInThisDeploymentDelta: [], taskDeploymentUnattributableReason: null,
  },
  checklist: Array.from({ length: 4 }, (_, itemIndex) => ({
   id: taskId + '-item-' + itemIndex, label: taskId + ' 核对项 ' + itemIndex,
   checked: false, source: 'custom', kind: 'guided_manual', script: null, run: null, cleanup: null,
   guidance: { steps: ['查看验证内容'], expectedObservation: '显示验证内容', failureSignature: '验证内容缺失', anchor: { view: 'board' } },
  })),
 });
}
const activeTasks = Array.from({ length: 9 }, (_, index) => makeTask('active-task-' + index, Math.floor(index / 3)));
const historyTasks = Array.from({ length: 3 }, (_, index) => makeTask('history-task-' + index, 0));
const group = {
 workspaceId, deploymentId: 'active-deployment', deployedSourceCommit: 'aaaaaaa',
 previousDeployedSourceCommit: null, deployedAtIso: '2026-10-25T00:00:00Z', foldedAtIso: null,
 tasks: activeTasks,
};
const historyGroup = {
 ...group, deploymentId: 'history-deployment', deployedSourceCommit: 'bbbbbbb',
 deployedAtIso: '2026-10-24T00:00:00Z', foldedAtIso: '2026-10-25T00:00:00Z', tasks: historyTasks,
};
const board = createInitialBoardData();
board.columns.find(column => column.id === 'review').cards = [...activeTasks, ...historyTasks].map(task => ({
 id: task.taskId, title: task.taskId, prompt: '阅读位置隔离验证', baseRef: 'main',
 createdAt: 1, updatedAt: 1,
}));
const realTaskCardRenderingInputs = {
 realTaskCardRenderingInputsBoardSourceKind: 'current_project_board_hydrated_in_browser',
 currentProjectTaskSessions: {}, currentProjectTaskCardActionHandlers: {}, currentProjectWorkspacePath: null,
 onActivateTaskCardOpeningTaskDetail: noop, defaultAgentId: null, defaultClineModelId: null,
};
export default function FixtureApp() {
 const [collapsed, setCollapsed] = React.useState(false);
 const [shortened, setShortened] = React.useState(false);
 const [refreshSequence, setRefreshSequence] = React.useState(0);
 const [entryNavigationRequest, setEntryNavigationRequest] = React.useState(null);
 const requestSequence = React.useRef(0);
 function navigateToEntry() {
  setEntryNavigationRequest({
   requestId: ++requestSequence.current,
   target: {
    entry: { workspaceId, deploymentId: group.deploymentId, taskId: 'active-task-8' },
    navigationKind: 'follow_up_origin_entry', availability: 'retained',
    deployedAtIso: group.deployedAtIso, selectedChecklistItemIds: [],
   },
  });
  setCollapsed(false);
 }
 return h(React.Fragment, null,
  h('button', { onClick: () => setCollapsed(false) }, '打开部署后验证'),
  h('button', { onClick: () => setShortened(true) }, '缩短面板内容'),
  h('button', { onClick: () => setRefreshSequence(sequence => sequence + 1) }, '刷新相同数据'),
  h('button', { onClick: navigateToEntry }, '定位另一个验证条目'),
  h('output', { 'data-testid': 'refresh-sequence' }, refreshSequence),
  h(PostDeployVerificationPanel, {
   activeGroup: { ...group, tasks: shortened ? activeTasks.slice(0, 1) : [...activeTasks] },
   historyGroups: shortened ? [] : [{ ...historyGroup, tasks: [...historyTasks] }],
   board, realTaskCardRenderingInputs, hasLoadedOnce: true, loadError: null,
   postDeployVerificationWorkspaceProjectNameShownInPanelHeader: null,
   stayInFront: true, collapsed, loweredForDialog: false,
   isBatchClosureWithReasonsInFlight: false, completingTaskId: null,
   entryNavigationRequest,
   entryNavigationReadModelRequest: entryNavigationRequest ? { workspaceId, requestId: entryNavigationRequest.requestId } : null,
   onEntryNavigationFinished: () => setEntryNavigationRequest(null),
   onToggleCollapsed: () => setCollapsed(value => !value), onToggleStayInFront: noop,
   onRequestBatchClosureWithReasonsOfZoneTasks: noop, onToggleChecklistItem: noop,
   onAddCustomChecklistItem: noop, onRemoveCustomChecklistItem: noop, onRunVerificationItem: noop,
   onRequestComplete: noop, onSelectTask: noop, onNavigateToBoard: noop,
  }));
}
`;

function panelScrollContainer(page: Page): Locator {
	return page.locator(".kb-viewport-bottom-verification-floating-panel > .overflow-y-auto");
}

function taskEntry(page: Page, taskId: string): Locator {
	return page.locator(`[data-post-deploy-verification-task-entry="${taskId}"]`);
}

function checklistToggle(page: Page, taskId: string): Locator {
	return taskEntry(page, taskId).getByRole("button", { name: /^核对清单/ });
}

async function scrollPanelTo(page: Page, scrollTop: number): Promise<number> {
	const actualScrollTop = await panelScrollContainer(page).evaluate((element, offset) => {
		element.scrollTop = offset;
		return element.scrollTop;
	}, scrollTop);
	// 等待浏览器投递真实 scroll 事件，不能用手工派发事件掩盖接线缺失。
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
	return actualScrollTop;
}

async function expectPanelScrollTop(page: Page, expectedScrollTop: number): Promise<void> {
	await expect
		.poll(() => panelScrollContainer(page).evaluate((element) => element.scrollTop))
		.toBeCloseTo(expectedScrollTop, 0);
}

async function collapseAndReopenPanel(page: Page): Promise<void> {
	await page.getByRole("button", { name: "折叠 Post-Deploy Verification 面板" }).click();
	await expect(panelScrollContainer(page)).toHaveCount(0);
	await expect(page.locator("[data-post-deploy-verification-task-entry]")).toHaveCount(0);
	await page.getByRole("button", { name: "打开部署后验证" }).click();
	await expect(panelScrollContainer(page)).toBeVisible();
}

for (const viewport of [
	{ width: 1440, height: 1000 },
	{ width: 390, height: 844 },
]) {
	test.describe(`PDV 阅读状态恢复（${viewport.width}px）`, () => {
		test.use({ viewport });
		test.beforeEach(async ({ page }) => {
			await page.route("**/api/**", (route) => route.fulfill({ json: { required: false, authenticated: true } }));
			await page.route("**/src/telemetry/sentry.ts*", (route) =>
				route.fulfill({ contentType: "text/javascript", body: "export function initializeSentry() {}" }),
			);
			await page.route("**/src/App.tsx*", (route) =>
				route.fulfill({ contentType: "text/javascript", body: panelReadingPositionFixtureApp }),
			);
			await page.goto("/");
			await expect(panelScrollContainer(page)).toBeVisible();
		});

		test("中部位置及主动收起的清单可反复恢复，回到顶部也被记住", async ({ page }) => {
			await checklistToggle(page, "active-task-0").click();
			await expect(checklistToggle(page, "active-task-0")).toHaveAttribute("aria-expanded", "false");
			const scrollRange = await panelScrollContainer(page).evaluate(
				(element) => element.scrollHeight - element.clientHeight,
			);
			const rememberedScrollTop = await scrollPanelTo(page, scrollRange / 2);
			expect(rememberedScrollTop).toBeGreaterThan(0);
			expect(rememberedScrollTop).toBeLessThan(scrollRange);
			for (let iteration = 0; iteration < 2; iteration++) {
				await collapseAndReopenPanel(page);
				await expectPanelScrollTop(page, rememberedScrollTop);
				await expect(checklistToggle(page, "active-task-0")).toHaveAttribute("aria-expanded", "false");
			}
			await scrollPanelTo(page, 0);
			await collapseAndReopenPanel(page);
			await expectPanelScrollTop(page, 0);
		});

		test("第二、三区与历史清单同步恢复，普通刷新保持当前位置", async ({ page }) => {
			const zoneRoots = page.locator("[data-post-deploy-verification-deployment-attribution-zone]");
			for (const zoneIndex of [1, 2]) {
				await zoneRoots.nth(zoneIndex).getByRole("button", { expanded: false }).first().click();
				await checklistToggle(page, `active-task-${zoneIndex * 3}`).click();
			}
			const historyToggle = page.getByRole("button").filter({ hasText: "bbbbbbb" });
			await historyToggle.click();
			await checklistToggle(page, "history-task-0").click();
			await zoneRoots.nth(0).getByRole("button", { expanded: true }).first().click();
			const rememberedScrollTop = await scrollPanelTo(page, 1800);
			await collapseAndReopenPanel(page);
			await expectPanelScrollTop(page, rememberedScrollTop);
			await expect(zoneRoots.nth(0)).toHaveAttribute("data-state", "closed");
			await expect(taskEntry(page, "active-task-0")).toHaveCount(0);
			for (const zoneIndex of [1, 2]) {
				await expect(zoneRoots.nth(zoneIndex)).toHaveAttribute("data-state", "open");
				await expect(checklistToggle(page, `active-task-${zoneIndex * 3}`)).toHaveAttribute(
					"aria-expanded",
					"true",
				);
			}
			await expect(historyToggle).toHaveAttribute("aria-expanded", "true");
			await expect(checklistToggle(page, "history-task-0")).toHaveAttribute("aria-expanded", "true");
			const refreshedScrollTop = await scrollPanelTo(page, 900);
			await page.getByRole("button", { name: "刷新相同数据" }).click();
			await expect(page.getByTestId("refresh-sequence")).toHaveText("1");
			await expectPanelScrollTop(page, refreshedScrollTop);
			// 单独折叠历史组同样会卸载清单，再展开仍从面板实例读取记忆。
			await historyToggle.click();
			await expect(taskEntry(page, "history-task-0")).toHaveCount(0);
			await historyToggle.click();
			await expect(checklistToggle(page, "history-task-0")).toHaveAttribute("aria-expanded", "true");
		});

		test("折叠期间内容减少时限制到新底部，并记住截断后的位置", async ({ page }) => {
			const rememberedScrollTop = await scrollPanelTo(page, 10000);
			await page.getByRole("button", { name: "折叠 Post-Deploy Verification 面板" }).click();
			await page.getByRole("button", { name: "缩短面板内容" }).click();
			await page.getByRole("button", { name: "打开部署后验证" }).click();
			const scrollRange = await panelScrollContainer(page).evaluate((element) =>
				Math.max(0, element.scrollHeight - element.clientHeight),
			);
			expect(scrollRange).toBeLessThan(rememberedScrollTop);
			await expectPanelScrollTop(page, scrollRange);
			await collapseAndReopenPanel(page);
			await expectPanelScrollTop(page, scrollRange);
		});

		test("显式定位优先展开目标，之后重新打开保留新位置", async ({ page }) => {
			await scrollPanelTo(page, 100);
			await page.getByRole("button", { name: "折叠 Post-Deploy Verification 面板" }).click();
			await page.getByRole("button", { name: "定位另一个验证条目" }).click();
			const target = taskEntry(page, "active-task-8");
			await expect(target).toBeFocused();
			await expect(checklistToggle(page, "active-task-8")).toHaveAttribute("aria-expanded", "true");
			// spotlight 使用浏览器平滑滚动，等目标真正进入滚动区再读取停稳的位置。
			await expect
				.poll(async () => {
					const targetBox = await target.boundingBox();
					const scrollBox = await panelScrollContainer(page).boundingBox();
					return (
						!!targetBox &&
						!!scrollBox &&
						targetBox.y >= scrollBox.y - 1 &&
						targetBox.y < scrollBox.y + scrollBox.height
					);
				})
				.toBe(true);
			await expect
				.poll(() => panelScrollContainer(page).evaluate((element) => element.scrollTop))
				.toBeGreaterThan(500);
			await panelScrollContainer(page).evaluate(
				(element) =>
					new Promise<void>((resolve) => {
						let previousScrollTop = element.scrollTop;
						let lastScrollPositionChangeAt = performance.now();
						function waitForScrollToSettle(frameTimestamp: number) {
							if (element.scrollTop !== previousScrollTop) {
								previousScrollTop = element.scrollTop;
								lastScrollPositionChangeAt = frameTimestamp;
							}
							// 平滑滚动末尾可能连续几帧停在同一像素，不能据单帧不变认定结束。
							if (frameTimestamp - lastScrollPositionChangeAt >= 150) resolve();
							else requestAnimationFrame(waitForScrollToSettle);
						}
						requestAnimationFrame(waitForScrollToSettle);
					}),
			);
			const locatedScrollTop = await panelScrollContainer(page).evaluate((element) => element.scrollTop);
			await collapseAndReopenPanel(page);
			await expectPanelScrollTop(page, locatedScrollTop);
			await expect(checklistToggle(page, "active-task-8")).toHaveAttribute("aria-expanded", "true");
		});
	});
}
