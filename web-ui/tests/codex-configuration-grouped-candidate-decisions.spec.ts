import { expect, type Page, test } from "@playwright/test";
import type { CodexConfigurationBatchActionRequest, CodexConfigurationSyncState } from "../src/runtime/types";

async function openGroupedCandidateFixture(page: Page) {
	let state: CodexConfigurationSyncState = {
		revision: 1,
		sourceObservations: [],
		observationProblem: null,
		changes: ["B", "B", "C", "D"].map((value, index) => ({
			changeId: `source-${index}`,
			version: index + 1,
			sourceWriterId: `writer-${index}`,
			sourceWorkspaceId: "isolated-source-workspace",
			sourceConversationSessionId: `来源会话 ${index}`,
			codexConfigurationProfileId: index === 3 ? "profile-b" : "profile-a",
			profileName: index === 3 ? "另一配置" : "工作配置",
			fieldKey: '["config.toml","model"]',
			fieldLabel: "config.toml · model",
			candidateFieldGroupKey: index === 3 ? "profile-b:model" : "profile-a:model",
			completeCandidateValueDigest: `complete-value-${value}`,
			previousValueSummary: "A",
			valueSummary: value,
			observedAt: index + 1,
			recordKind: "settings_proposal",
			approvalStatus: "pending",
			decidedAt: null,
			mergeStatus: "pending_approval",
			acknowledgedAt: null,
			eligibleTargetCount: 0,
			targets: [],
			settingDifferences: [],
			feedbackExpiresAtMs: Date.now() + 600_000,
			comparison: {
				expectedSharedValueDigest: "default-a",
				rows: [
					{
						fieldKey: "model",
						label: "config.toml · model",
						changeKind: "modified",
						previous: { state: "present", text: '"A"' },
						detected: { state: "present", text: `"${value}"` },
						sharedCurrent: { state: "present", text: '"A"' },
						previousMatchesSharedCurrent: true,
					},
				],
			},
		})),
	};
	const requests: CodexConfigurationBatchActionRequest[] = [];
	await page.route("**/api/**", (route) => route.abort());
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedure = url.pathname.split("/api/trpc/")[1];
		const batched = url.searchParams.has("batch");
		let response: unknown;
		if (procedure === "runtime.getCodexConfigurationSyncState") response = state;
		else if (procedure === "runtime.batchCodexConfigurationAction") {
			const body = route.request().postDataJSON();
			const input: CodexConfigurationBatchActionRequest = batched ? body["0"] : body;
			requests.push(input);
			const unavailable = input.action === "approve" && input.items[0]?.changeId === "source-0";
			if (!unavailable)
				state = {
					...state,
					revision: state.revision + 1,
					changes: state.changes.map((change) =>
						change.codexConfigurationProfileId === "profile-a"
							? {
									...change,
									approvalStatus: input.action === "approve" ? "historical" : "rejected",
									mergeStatus: "superseded",
									acknowledgedAt: Date.now(),
									version: change.version + 10,
								}
							: change,
					),
				};
			response = {
				state,
				results: input.items.map((item) => ({
					changeId: item.changeId,
					status: unavailable ? "source_unverifiable" : "applied",
					message: unavailable ? "来源暂不可核验" : "已保存选择",
				})),
			};
		} else throw new Error(`意外 procedure ${procedure}`);
		await route.fulfill({ json: batched ? [{ result: { data: response } }] : { result: { data: response } } });
	});
	await page.route("**/isolated-grouped-configuration", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import('/tests/codex-configuration-source-observation-recovery-browser-harness.tsx');</script></body></html>`,
		}),
	);
	await page.goto("/isolated-grouped-configuration");
	const settings = page.getByRole("region", { name: "隔离配置设置页" });
	await expect(settings.getByRole("heading", { name: "设置待反馈 · 2", exact: true })).toBeVisible();
	return { settings, requests };
}

for (const width of [390, 1280])
	test(`归并候选在 ${width}px 保持值与操作相邻，键盘采用仅重试展示的同值来源并跨刷新恢复`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		const { settings, requests } = await openGroupedCandidateFixture(page);
		const notice = page.getByRole("region", { name: "Codex 配置变更提示" });
		for (const surface of [settings, notice]) {
			const group = surface.getByRole("article", { name: "工作配置 · config.toml · model 的候选值", exact: true });
			await expect(group).toBeVisible();
			await expect(group.locator('[data-configuration-value-choice="current"]')).toContainText('"A"');
			await expect(group.locator('[data-configuration-value-choice="candidate"]')).toHaveCount(2);
			const candidate = group.getByRole("region", { name: "候选值 · 2 个来源", exact: true });
			await expect(candidate).toContainText('"B"');
			await expect(candidate.getByRole("button", { name: "采用此值并广播", exact: true })).toBeVisible();
			for (const decision of await group.locator("[data-configuration-value-choice]").all()) {
				const gap = await decision.evaluate((element) => {
					const value = element.querySelector("[data-configuration-compared-value]")?.getBoundingClientRect();
					const button = element.querySelector("button")?.getBoundingClientRect();
					if (!value || !button) throw new Error("值或按钮缺失");
					return { vertical: button.top - value.bottom, horizontal: button.left - value.right };
				});
				if (width < 640) expect(gap.vertical).toBeLessThanOrEqual(12);
				else {
					expect(gap.horizontal).toBeGreaterThanOrEqual(0);
					expect(gap.horizontal).toBeLessThanOrEqual(16);
				}
			}
		}
		const group = settings.getByRole("article", { name: "工作配置 · config.toml · model 的候选值", exact: true });
		await group.screenshot({ path: testInfo.outputPath(`grouped-candidates-${width}.png`) });
		await group
			.getByRole("region", { name: "候选值 · 2 个来源", exact: true })
			.getByRole("button", { name: "采用此值并广播" })
			.focus();
		await page.keyboard.press("Enter");
		await expect(group).toHaveCount(0);
		expect(requests.map((request) => request.items.map((item) => [item.changeId, item.expectedVersion]))).toEqual([
			[["source-0", 1]],
			[["source-1", 2]],
		]);
		await page.reload();
		await expect(settings.getByRole("heading", { name: "设置待反馈 · 1", exact: true })).toBeVisible();
		await expect(
			settings.getByRole("article", { name: "另一配置 · config.toml · model 的候选值", exact: true }),
		).toBeVisible();
		expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	});

test("保留当前默认只处理本组已展示的全部候选，来源历史将相同的修改前与当前默认合并", async ({ page }) => {
	const { settings, requests } = await openGroupedCandidateFixture(page);
	const group = settings.getByRole("article", { name: "工作配置 · config.toml · model 的候选值", exact: true });
	await group.getByText("来源历史 · 2 条", { exact: true }).click();
	await group.getByText(/来源会话 0 · 记录版本/).click();
	await expect(group.getByText("当前看板默认（同修改前）", { exact: true }).first()).toBeVisible();
	await expect(group.getByText("修改前", { exact: true })).toHaveCount(0);
	await group.getByRole("button", { name: "保留当前默认", exact: true }).click();
	await expect(group).toHaveCount(0);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.action).toBe("reject");
	expect(requests[0]?.items.map((item) => [item.changeId, item.expectedVersion])).toEqual([
		["source-0", 1],
		["source-1", 2],
		["source-2", 3],
	]);
});
