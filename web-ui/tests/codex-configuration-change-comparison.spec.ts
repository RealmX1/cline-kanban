import { expect, type Page, test } from "@playwright/test";
import type { CodexConfigurationChangeDetails, CodexConfigurationSyncState } from "../src/runtime/types";

test.setTimeout(90_000);

async function openConfigurationComparisonFixture(page: Page) {
	const changes: CodexConfigurationSyncState["changes"] = ["subagent_start", "user_prompt_submit"].map(
		(event, index) => ({
			changeId: `ponytail-${event}`,
			version: 1,
			sourceWriterId: index ? "writer-side" : "user-source:isolated",
			sourceWorkspaceId: index ? "isolated-source-workspace" : "",
			sourceConversationSessionId: index ? "side-session" : "用户全局配置",
			fieldKey: JSON.stringify(["config.toml", "hooks", "state", `ponytail@ponytail:hooks/hooks.json:${event}:0:0`]),
			fieldLabel: `config.toml · ponytail@ponytail:hooks/hooks.json · Hook ${event}:0:0 · Hook 内容信任更新`,
			previousValueSummary: "旧信任",
			valueSummary: "新信任",
			observedAt: 1,
			recordKind: "settings_proposal",
			approvalStatus: "pending",
			decidedAt: null,
			mergeStatus: "conflict",
			acknowledgedAt: null,
			eligibleTargetCount: 0,
			targets: [],
			settingDifferences: [],
			sourceEvidence: {
				initiator: { status: "unknown", description: "缺少原生修改者记录" },
				detectedOwner: {
					writerId: "writer-side",
					workspaceId: "isolated-source-workspace",
					conversationSessionId: "side-session",
					description: index ? "持久 writer 绑定" : "用户全局配置",
					...(index
						? {
								task: {
									workspaceId: "isolated-source-workspace",
									projectPath: "/projects/kanban",
									taskId: "9c8d6",
									taskTitle: "配置来源回归任务",
									taskIncarnationCreatedAtEpochMs: 1,
									conversationSessionId: "side-session",
									runtimeSessionIncarnationId: "same-incarnation",
								},
								currentTaskLink: {
									workspaceId: "isolated-source-workspace",
									taskId: "9c8d6",
									taskIncarnationCreatedAtEpochMs: 1,
								},
							}
						: { unavailableReason: "全局配置无法证明由哪个任务修改。" }),
				},
				recoveryCondition: "绑定恢复后自动重验",
			},
			hookExplanation: "Hook 内容信任更新；历史 Hook 代码正文未采集，保持未知。",
			comparison: {
				expectedSharedValueDigest: `shared-digest-${index}`,
				rows: [
					{
						fieldKey: `hook-${index}`,
						label: "trusted_content_hash",
						changeKind: "modified",
						previous: { state: "present", text: "已保存信任指纹 c72948c12d…" },
						detected: { state: "present", text: "已保存信任指纹 4e1eb2a3d3…" },
						sharedAtConflict: { state: "present", text: "冲突时的共享信任" },
						sharedCurrent: { state: "present", text: "共享方当前的信任" },
						sharedOrigin: { description: "共享初始值来源未知" },
					},
				],
			},
		}),
	);
	let state: CodexConfigurationSyncState = { revision: 1, changes, sourceObservations: [], observationProblem: null };
	const detailRequests: unknown[] = [];
	const resolutions: Array<{ expectedSharedValueDigest?: string }> = [];
	let failNextDetails = false;
	await page.route("**/api/**", (route) => route.abort());
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedure = url.pathname.split("/api/trpc/")[1];
		const batched = url.searchParams.has("batch");
		const rawInput =
			route.request().method() === "GET"
				? JSON.parse(url.searchParams.get("input") ?? "{}")
				: route.request().postDataJSON();
		const input = batched ? rawInput["0"] : rawInput;
		let data: unknown;
		if (procedure === "runtime.getCodexConfigurationSyncOverview") data = state;
		else if (procedure === "runtime.getCodexConfigurationChangeDetails") {
			detailRequests.push(input);
			if (failNextDetails) {
				failNextDetails = false;
				return route.abort("failed");
			}
			const change = state.changes.find((entry) => entry.changeId === input.changeId);
			if (!change?.comparison || !change.sourceEvidence) throw new Error("缺少完整比较 fixture");
			data = {
				...change.comparison,
				changeId: change.changeId,
				version: change.version,
				fieldLabel: change.fieldLabel,
				sourceEvidence: change.sourceEvidence,
				hookExplanation: change.hookExplanation ?? null,
				rows: change.comparison.rows.map((row) => ({
					...row,
					previous: { state: "present", text: "c72948c12d-previous-full-fingerprint" },
					detected: { state: "present", text: "4e1eb2a3d3-detected-full-fingerprint" },
				})),
			} satisfies CodexConfigurationChangeDetails;
		} else if (procedure === "runtime.resolveCodexConfigurationConflict") {
			resolutions.push(input);
			return route.fulfill({
				status: 409,
				json: batched
					? [{ error: { message: "共享值已有更新", code: -32600, data: { code: "CONFLICT", httpStatus: 409 } } }]
					: { error: { message: "共享值已有更新", code: -32600, data: { code: "CONFLICT", httpStatus: 409 } } },
			});
		} else throw new Error(`意外 procedure ${procedure}`);
		return route.fulfill({ json: batched ? [{ result: { data } }] : { result: { data } } });
	});
	await page.route("**/isolated-configuration-comparison", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import('/tests/codex-configuration-source-observation-recovery-browser-harness.tsx');</script></body></html>`,
		}),
	);
	await page.goto("/isolated-configuration-comparison");
	await page.getByRole("region", { name: "隔离配置设置页" }).waitFor({ timeout: 30_000 });
	const settings = page.getByRole("region", { name: "隔离配置设置页" });
	await expect(settings.getByRole("heading", { name: "设置待反馈 · 2", exact: true })).toBeVisible();
	return {
		settings,
		detailRequests,
		resolutions,
		failDetailsOnce: () => {
			failNextDetails = true;
		},
		updateState: () => {
			state = { ...state, revision: state.revision + 1 };
		},
	};
}

for (const width of [390, 1280])
	test(`配置来源与双方值在 ${width}px 的设置页和通知中共用展示`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		const fixture = await openConfigurationComparisonFixture(page);
		const notice = page.getByRole("region", { name: "Codex 配置变更提示" });
		for (const surface of [fixture.settings, notice]) {
			await expect(surface.getByText(/ponytail@ponytail:hooks\/hooks.json/).first()).toBeVisible();
			await expect(surface.getByText("共享方当前的信任", { exact: true }).first()).toBeVisible();
			await expect(surface.getByText(/配置来源回归任务/)).toBeVisible();
			await expect(surface.getByText(/全局配置无法证明/)).toBeVisible();
		}
		const first = fixture.settings.getByRole("article").first();
		const columns = await first.locator("dl > div").evaluateAll((elements) =>
			elements.slice(0, 2).map((element) => {
				const box = element.getBoundingClientRect();
				return { x: box.x, y: box.y };
			}),
		);
		if (width < 640) expect(columns[1]?.y).toBeGreaterThan(columns[0]?.y);
		else expect(columns[1]?.y).toBe(columns[0]?.y);
		const expand = first.getByRole("button", { name: "展开完整比较", exact: true });
		expect(fixture.detailRequests).toHaveLength(0);
		fixture.failDetailsOnce();
		await expand.focus();
		await page.keyboard.press("Enter");
		await expect(first.getByText(/完整比较暂不可读/)).toBeVisible();
		await first.getByRole("button", { name: "重试加载完整比较" }).click();
		await expect(first.getByText("4e1eb2a3d3-detected-full-fingerprint", { exact: true })).toBeVisible();
		await first.getByRole("button", { name: "采用检测到的新值，更新共享默认" }).click();
		await expect(fixture.settings.getByRole("alert")).toContainText("操作未确认");
		expect(fixture.resolutions).toHaveLength(1);
		expect(fixture.resolutions[0]?.expectedSharedValueDigest).toBe("shared-digest-0");
		await expect(first.getByText("4e1eb2a3d3-detected-full-fingerprint", { exact: true })).toBeVisible();
		const search = fixture.settings.getByRole("searchbox", { name: "筛选配置记录" });
		for (const query of ["配置来源回归任务", "9c8d6", "ponytail", "trusted_content_hash"]) {
			await search.fill(query);
			await expect(fixture.settings.getByRole("article").first()).toBeVisible();
		}
		await search.fill("");
		await expect(page.locator("body")).toHaveJSProperty(
			"scrollWidth",
			await page.locator("body").evaluate((element) => element.clientWidth),
		);
		await first.screenshot({ path: testInfo.outputPath(`configuration-comparison-${width}.png`) });
	});

test("通知折叠与恢复保留比较内容、键盘焦点和阅读位置", async ({ page }) => {
	const fixture = await openConfigurationComparisonFixture(page);
	const summary = page.locator('[data-verification-anchor="codex-configuration-sync-summary"]');
	if ((await summary.getAttribute("aria-expanded")) === "false") await summary.click();
	const notice = page.getByRole("region", { name: "Codex 配置变更提示" });
	await notice.getByRole("button", { name: "展开完整比较" }).first().click();
	await expect(notice.getByText("4e1eb2a3d3-detected-full-fingerprint", { exact: true })).toBeVisible();
	const scroller = notice.locator('[data-verification-anchor="codex-configuration-sync-scroll-container"]');
	const scrollContainer = (await scroller.count()) ? scroller : notice.locator(".overflow-y-auto");
	await scrollContainer.evaluate((element) => {
		element.scrollTop = 120;
		element.dispatchEvent(new Event("scroll"));
	});
	const before = await scrollContainer.evaluate((element) => element.scrollTop);
	fixture.updateState();
	await notice.press("Escape");
	await expect(summary).toBeFocused();
	await summary.press("Enter");
	await expect(notice.getByRole("button", { name: "收起完整比较" })).toBeVisible();
	expect(Math.abs((await scrollContainer.evaluate((element) => element.scrollTop)) - before)).toBeLessThanOrEqual(1);
});
