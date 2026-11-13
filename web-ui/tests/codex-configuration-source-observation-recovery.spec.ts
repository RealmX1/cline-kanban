import { expect, type Page, type Route, test } from "@playwright/test";
import type { CodexConfigurationBatchActionRequest, CodexConfigurationSyncState } from "../src/runtime/types";

test.setTimeout(90_000);

async function openIsolatedSourceObservationFixture(page: Page, initiallyReadCount = 0) {
	let state: CodexConfigurationSyncState = {
		revision: 1,
		changes: [],
		observationProblem: null,
		sourceObservations: Array.from({ length: 6 }, (_, index) => ({
			observationId: `source-${index}`,
			version: 1,
			sourceLabel: `隔离来源 ${index}`,
			firstObservedAt: 1,
			observedAt: 1,
			observationCount: 1,
			detectedLocationCount: 1,
			acknowledgedAt: index < initiallyReadCount ? 42 : null,
			reminderDisposition: index < initiallyReadCount ? "confirmed" : "unread",
		})),
	};
	const actions: CodexConfigurationBatchActionRequest[] = [];
	const heldRoutes: Route[] = [];
	const unexpectedProcedures: string[] = [];
	let holdSourceId: string | null = null;
	let applyHeldMutation = false;
	let readsUnavailable = false;
	await page.route("**/api/**", (route) => route.abort());
	await page.route("**/api/trpc/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const name = url.pathname.split("/api/trpc/")[1];
		expect(request.headers()["x-kanban-workspace-id"]).toBe("isolated-source-workspace");
		expect(url.searchParams.has("batch")).toBe(false);
		if (name === "runtime.getCodexConfigurationSyncOverview") {
			if (readsUnavailable) return route.abort("failed");
			return route.fulfill({ json: { result: { data: state } } });
		}
		if (name !== "runtime.batchCodexConfigurationAction") {
			unexpectedProcedures.push(name ?? "unknown");
			return route.abort();
		}
		const input = request.postDataJSON() as CodexConfigurationBatchActionRequest;
		actions.push(input);
		const item = input.items[0]!;
		if (item.changeId !== holdSourceId || applyHeldMutation)
			state = {
				...state,
				revision: state.revision + 1,
				sourceObservations: state.sourceObservations.map((observation) =>
					observation.observationId === item.changeId
						? {
								...observation,
								version: state.revision + 1,
								acknowledgedAt: 84,
								reminderDisposition: input.action === "defer" ? "deferred" : "confirmed",
							}
						: observation,
				),
			};
		if (item.changeId === holdSourceId) {
			heldRoutes.push(route);
			return;
		}
		return route.fulfill({
			json: {
				result: {
					data: { state, results: [{ changeId: item.changeId, status: "applied", message: "已保存处理状态" }] },
				},
			},
		});
	});
	await page.route("**/isolated-source-observation-recovery", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import('/tests/codex-configuration-source-observation-recovery-browser-harness.tsx');</script></body></html>`,
		}),
	);
	await page.goto("/isolated-source-observation-recovery");
	await page.getByRole("region", { name: "隔离配置设置页" }).waitFor({ timeout: 30_000 });
	const settings = page.getByRole("region", { name: "隔离配置设置页" });
	await expect(
		settings.getByRole("heading", { name: `来源更新 · ${6 - initiallyReadCount}`, exact: true }),
	).toBeVisible();
	return {
		settings,
		actions,
		heldRoutes,
		unexpectedProcedures,
		holdSource: (sourceId: string, apply: boolean) => {
			holdSourceId = sourceId;
			applyHeldMutation = apply;
		},
		setReadsUnavailable: (unavailable: boolean) => {
			readsUnavailable = unavailable;
		},
	};
}

for (const width of [390, 1280])
	test(`来源已读在 ${width}px 下同步两处 6→5，历史保留且无操作按钮`, async ({ page }) => {
		await page.setViewportSize({ width, height: 850 });
		const fixture = await openIsolatedSourceObservationFixture(page);
		const source = fixture.settings.getByRole("article", { name: "来源更新 隔离来源 0", exact: true });
		await source.getByRole("button", { name: "标记已读", exact: true }).click();
		await expect(fixture.settings.getByRole("heading", { name: "来源更新 · 5", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "配置提醒，可选反馈 0 项 · 来源更新 5 条" })).toBeVisible();
		await fixture.settings.getByRole("tab", { name: "历史", exact: true }).click();
		const historical = fixture.settings.getByRole("group", { name: "历史记录", exact: true });
		await expect(historical.getByRole("article")).toHaveCount(1);
		await expect(historical.getByRole("button")).toHaveCount(0);
		expect(await historical.locator("time").getAttribute("datetime")).toBe(new Date(84).toISOString());
		expect(fixture.actions).toHaveLength(1);
		expect(fixture.unexpectedProcedures).toEqual([]);
	});

test("六个来源已有一项已读时，两处首次读取即显示五项", async ({ page }) => {
	const fixture = await openIsolatedSourceObservationFixture(page, 1);
	await expect(page.getByRole("button", { name: "配置提醒，可选反馈 0 项 · 来源更新 5 条" })).toBeVisible();
	await fixture.settings.getByRole("tab", { name: "历史", exact: true }).click();
	await expect(fixture.settings.getByRole("group", { name: "历史记录", exact: true }).getByRole("button")).toHaveCount(
		0,
	);
	expect(fixture.actions).toHaveLength(0);
});

test("单项挂起不禁用其他来源，通知与设置对同项共享等待", async ({ page }) => {
	const fixture = await openIsolatedSourceObservationFixture(page);
	fixture.holdSource("source-0", false);
	await fixture.settings
		.getByRole("article", { name: "来源更新 隔离来源 0", exact: true })
		.getByRole("button", { name: "标记已读" })
		.click();
	await expect.poll(() => fixture.actions.length).toBe(1);
	for (const entry of await page.getByRole("article", { name: "来源更新 隔离来源 0", exact: true }).all())
		await expect(entry.getByRole("button", { name: "标记已读" })).toBeDisabled();
	const another = fixture.settings.getByRole("article", { name: "来源更新 隔离来源 1", exact: true });
	await expect(another.getByRole("button", { name: "标记已读" })).toBeEnabled();
	await another.getByRole("button", { name: "标记已读" }).click();
	await expect(fixture.settings.getByRole("heading", { name: "来源更新 · 5", exact: true })).toBeVisible();
	expect(fixture.actions).toHaveLength(2);
});

test("原回执挂起但已保存时，十五秒补读结束等待且不重复确认", async ({ page }) => {
	await page.clock.install();
	const fixture = await openIsolatedSourceObservationFixture(page);
	fixture.holdSource("source-0", true);
	await fixture.settings
		.getByRole("article", { name: "来源更新 隔离来源 0", exact: true })
		.getByRole("button", { name: "标记已读" })
		.click();
	await expect.poll(() => fixture.actions.length).toBe(1);
	await page.clock.fastForward(15_001);
	await expect(fixture.settings.getByRole("heading", { name: "来源更新 · 5", exact: true })).toBeVisible();
	await fixture.settings.getByRole("tab", { name: "历史", exact: true }).click();
	await expect(fixture.settings.getByText("已通过补读核验处理状态。")).toBeVisible();
	expect(fixture.actions).toHaveLength(1);
});

test("刷新先补读已持久处理事实，运行时重连恢复离线补读，不重放来源确认", async ({ page }) => {
	const fixture = await openIsolatedSourceObservationFixture(page);
	fixture.holdSource("source-0", true);
	await fixture.settings
		.getByRole("article", { name: "来源更新 隔离来源 0", exact: true })
		.getByRole("button", { name: "标记已读" })
		.click();
	await expect.poll(() => fixture.actions.length).toBe(1);
	fixture.setReadsUnavailable(true);
	await page.reload();
	await page.getByRole("region", { name: "隔离配置设置页" }).waitFor({ timeout: 30_000 });
	await expect(page.getByText("暂时无法读取 Codex 配置同步状态，连接恢复后自动重试。").first()).toBeVisible();
	fixture.setReadsUnavailable(false);
	await page.getByRole("button", { name: "模拟运行时重连" }).click();
	await expect(fixture.settings.getByRole("heading", { name: "来源更新 · 5", exact: true })).toBeVisible();
	expect(fixture.actions).toHaveLength(1);
	expect(
		await page.evaluate(() =>
			JSON.parse(
				localStorage.getItem("kanban.codex-configuration-unconfirmed-source-observation-actions.v1") ?? "[]",
			),
		),
	).toEqual([]);
});
