import { expect, test } from "@playwright/test";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary } from "../src/runtime/types";

for (const width of [1280, 390]) {
	test(`All Projects 首页和 Focus View 在 ${width}px 共用后台等待归属`, async ({ page }) => {
		const observedAtMs = Date.now();
		await page.clock.setFixedTime(observedAtMs);
		await page.setViewportSize({ width, height: 1100 });
		const entry: RuntimeCrossProjectTaskSwitcherEntry = {
			taskId: "waiting",
			title: "等待后台验证的任务",
			createdAt: observedAtMs - 60_000,
			taskDescriptionLastUpdatedAt: observedAtMs - 60_000,
			agentId: "codex",
			columnId: "in_progress",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			isParkedAwaitingDispatchedBackgroundWork: true,
			lastOutputAt: null,
			lastSubstantiveOutputAt: null,
			lastOpenedByUserAt: null,
			lastConversationProgressObservation: null,
			agentResponseGenerationStopped: null,
			pinnedToTaskPinboardAt: null,
			taskPinboardPinReason: null,
		};
		const project: RuntimeProjectSummary = {
			id: "isolated-grouping",
			name: "隔离分组项目",
			path: "/isolated/grouping",
			availability: { status: "available" },
			taskCounts: { backlog: 0, in_progress: 2, review: 0, validation: 0, trash: 0 },
			inProgressTaskDetails: [],
			crossProjectTaskSwitcherEntries: [
				{ ...entry, ownedBackgroundWorkWaitingStatus: "waiting_for_machine_evidence" },
				{ ...entry, taskId: "generating", title: "仍在执行的主回合" },
			],
		};
		await page.route("**/api/**", (route) => route.abort());
		await page.routeWebSocket("**/isolated-owned-background-work-stream", (socket) => {
			socket.send(JSON.stringify({ type: "snapshot", projects: [project] }));
		});
		await page.route("**/isolated-owned-background-work-page?*", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><body></body>",
			}),
		);
		await page.goto("/isolated-owned-background-work-page?stream=/isolated-owned-background-work-stream");
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({
			type: "module",
			url: "/tests/automatic-agent-failure-continuation-native-stream-browser-harness.tsx",
		});
		await page
			.locator('[data-native-capacity-browser-host="focus"]')
			.getByRole("button", { name: "展开 Running", exact: true })
			.first()
			.click();
		for (const hostName of ["home", "focus"]) {
			const host = page.locator(`[data-native-capacity-browser-host="${hostName}"]`);
			const rows = (section: string) => host.locator(`[data-cross-project-task-switcher-section="${section}"]`);
			await expect(rows("waiting_owned_background_work")).toHaveCount(1);
			await expect(rows("waiting_owned_background_work")).toContainText("等待机器证据");
			await expect(rows("running")).toHaveCount(1);
			await expect(rows("running")).toHaveAttribute("data-cross-project-task-switcher-task-id", "generating");
		}
	});
}
