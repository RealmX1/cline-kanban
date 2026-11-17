import { expect, type Page, test } from "@playwright/test";
import { createPostDeployVerificationTaskReadModelTestFixture } from "../src/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";

// 挂载真实顶栏、报告入口和验证 controller / hook；部署响应隔离，绝不修改用户任务。
const fixtureHtml = `<!doctype html><html><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script><script type="module">
import React from '/node_modules/.vite/deps/react.js';
import ReactDOMClient from '/node_modules/.vite/deps/react-dom_client.js';
import { TopBar } from '/src/components/top-bar.tsx';
import { CodexConfigurationSyncSummaryButton } from '/src/components/codex-configuration-sync.tsx';
import { BugReportTriggerButton } from '/src/components/bug-report/bug-report-trigger-button.tsx';
import { PostDeployVerificationController } from '/src/components/post-deploy-verification/post-deploy-verification-controller.tsx';
import { usePostDeployVerification } from '/src/hooks/use-post-deploy-verification.ts';
import { Button } from '/src/components/ui/button.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import { createInitialBoardData } from '/src/data/board-data.ts';
import '/src/styles/globals.css';
const h = React.createElement;
function Fixture() {
 const verification = usePostDeployVerification('isolated-browser-fixture');
 const [isExpanded, setIsExpanded] = React.useState(false);
 const configurationNotice = { hasReminders: true, pendingApprovalCount: 2, sourceUpdateCount: 1, isExpanded, summaryButtonRef: React.useRef(null), contentId: 'isolated-configuration-notice', toggleExpanded: () => setIsExpanded(value => !value), controller: { state: null } };
 return h(TooltipProvider, null,
  h(TopBar, { openTargetOptions: [], selectedOpenTargetId:'vscode', onSelectOpenTarget() {}, onOpenWorkspace() {}, canOpenWorkspace:false, isOpeningWorkspace:false,
   onToggleSidebar() {}, onBack() {}, workspacePath:'/fixture/cline-kanban', onOpenTaskSpotlightSearch() {}, onToggleTerminal() {},
   onToggleTaskChangesSidebar() {}, onToggleFindings() {}, onToggleBetweenBoardScopeAllProjectsAndSingleProjectScope() {},
   codexConfigurationNoticeSummaryControl:h(CodexConfigurationSyncSummaryButton, { notice:configurationNotice }),
   postDeployVerificationPendingCount:verification.pendingVerificationTaskCount, onOpenPostDeployVerification:()=>verification.setCollapsed(false),
   bugReportTriggerButton:h(BugReportTriggerButton, { projects:[], currentProjectId:null, activeView:'task:fixture' }),
   notificationCenter:h(Button, { 'aria-label':'Notifications', className:'min-w-[44px] min-h-[44px]', icon:h('span', null, 'N') }) }),
  h('div', { style:{position:'fixed',right:16,bottom:16,width:280} }, h('textarea', { 'aria-label':'Prompts' }), h('textarea', { 'aria-label':'Comments' }), h('button', { type:'button' }, 'Save')),
  h(PostDeployVerificationController, { verification, board:createInitialBoardData(), completePostDeployVerificationMoveToDone:async()=>({ok:true}), onSelectTask() {}, onNavigateToBoard() {} }));
}
ReactDOMClient.createRoot(document.getElementById('root')).render(h(Fixture));
</script></body></html>`;

async function mountIsolatedFixture(page: Page, historyOnly = false) {
	await page.addInitScript(() => localStorage.setItem("kanban.post-deploy-verification-collapsed", "true"));
	await page.routeWebSocket("**/*", () => {});
	const deploymentGroup = {
		deploymentId: "b16356bd-ec40-4ffb-b438-efdd36e15eac",
		workspaceId: "isolated-browser-fixture",
		deployedSourceCommit: "abcdef1",
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-10-01T00:00:00.000Z",
		foldedAtIso: historyOnly ? "2026-10-01T01:00:00.000Z" : null,
		tasks: Array.from({ length: 12 }, (_, index) =>
			createPostDeployVerificationTaskReadModelTestFixture({
				taskId: `fixture-${index}`,
				columnIdAtMatch: "validation",
				inclusionReason: "validation_column",
			}),
		),
	};
	const { tasks: _tasks, ...groupMetadata } = deploymentGroup;
	const overview = {
		activeDeploymentId: historyOnly ? null : deploymentGroup.deploymentId,
		pendingVerificationTaskCount: historyOnly ? 0 : 12,
		deploymentGroups: [
			{
				...groupMetadata,
				contentVersion: "fixture-version",
				pendingVerificationTaskCount: 12,
				closedTaskCount: 0,
				taskCountRequiringVerification: 12,
				carriedForwardTaskCount: 0,
			},
		],
	};
	await page.route("**/api/trpc/**", (route) => {
		const procedures = new URL(route.request().url()).pathname.split("/").at(-1)!.split(",");
		return route.fulfill({
			json: procedures.map((procedure) => ({
				result: {
					data: procedure.endsWith("getPostDeployVerificationWorkspaceOverview")
						? overview
						: {
								status: "changed",
								deploymentId: deploymentGroup.deploymentId,
								contentVersion: "fixture-version",
								deploymentGroup,
							},
				},
			})),
		});
	});
	await page.route("**/isolated-top-bar-fixture", (route) =>
		route.fulfill({ contentType: "text/html", body: fixtureHtml }),
	);
	await page.goto("/isolated-top-bar-fixture");
	await expect(page.getByTestId("open-post-deploy-verification-button")).toBeVisible();
	await expect(page.getByTestId("open-post-deploy-verification-button")).toHaveText(historyOnly ? "" : "12");
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 375, height: 812 },
]) {
	test(`入口在 ${viewport.width}px 视口不遮挡编辑区，未 hover 时有整体边界`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await mountIsolatedFixture(page);
		const verification = page.getByTestId("open-post-deploy-verification-button");
		await expect(verification.locator("svg.lucide-clipboard-check")).toBeVisible();
		const configuration = page.getByRole("button", { name: "配置提醒，可选反馈 2 项 · 来源更新 1 条", exact: true });
		await expect(configuration.locator("svg.lucide-sliders-horizontal")).toBeVisible();
		await expect(configuration).toContainText("3");
		await configuration.click();
		await expect(configuration).toHaveAttribute("aria-expanded", "true");
		await configuration.click();
		await expect(configuration).toHaveAttribute("aria-expanded", "false");
		await page.screenshot({ path: test.info().outputPath(`top-bar-distinct-icons-${viewport.width}.png`) });
		const appearance = await verification.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				gap: style.columnGap,
				borderWidth: style.borderTopWidth,
				background: style.backgroundColor,
				borderColor: style.borderTopColor,
			};
		});
		expect(appearance.gap).toBe("4px");
		expect(appearance.borderWidth).toBe("1px");
		expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)");
		expect(appearance.borderColor).not.toBe("rgba(0, 0, 0, 0)");
		for (const entry of [verification, page.getByTestId("open-bug-report-button")]) {
			const box = await entry.boundingBox();
			if (!box) throw new Error("顶部入口没有布局区域");
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
			if (viewport.width === 375) {
				expect(box.width).toBeGreaterThanOrEqual(44);
				expect(box.height).toBeGreaterThanOrEqual(44);
			}
			await entry.focus();
			await expect(entry).toBeFocused();
		}
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
		).toBe(false);
		if (viewport.width === 375) {
			const searchBox = await page.getByTestId("open-task-spotlight-search-button").boundingBox();
			const navigationLeftZoneBox = await page.locator("nav.kb-top-bar > div").first().boundingBox();
			if (!searchBox || !navigationLeftZoneBox) throw new Error("搜索入口或顶栏左区没有布局区域");
			expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(
				navigationLeftZoneBox.x + navigationLeftZoneBox.width + 1,
			);
		}
		for (const name of ["Prompts", "Comments"]) {
			await page.getByRole("textbox", { name }).fill("编辑区域可用");
		}
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByLabel("展开 Post-Deploy Verification 面板")).toHaveCount(0);
		await verification.click();
		await expect(page.getByLabel("折叠 Post-Deploy Verification 面板")).toBeVisible();
		await page.getByLabel("折叠 Post-Deploy Verification 面板").click();
		await expect(page.getByLabel("折叠 Post-Deploy Verification 面板")).toHaveCount(0);
		await expect(page.getByLabel("展开 Post-Deploy Verification 面板")).toHaveCount(0);
		await verification.click();
		await expect(page.getByLabel("折叠 Post-Deploy Verification 面板")).toBeVisible();
		await page.getByLabel("折叠 Post-Deploy Verification 面板").click();
		await page.getByTestId("open-bug-report-button").click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	});
}

test("仅历史记录仍能从顶部唯一入口访问", async ({ page }) => {
	await mountIsolatedFixture(page, true);
	await page.getByTestId("open-post-deploy-verification-button").click();
	await expect(page.getByLabel("折叠 Post-Deploy Verification 面板")).toBeVisible();
});
