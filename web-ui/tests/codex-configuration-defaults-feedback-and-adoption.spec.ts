import { expect, type Page, test } from "@playwright/test";
import type {
	CodexConfigurationBatchActionRequest,
	CodexConfigurationProfileMutationRequest,
	CodexConfigurationSyncState,
} from "../src/runtime/types";

const effortFieldKey = JSON.stringify(["config.toml", "model_reasoning_effort"]);
const modelFieldKey = JSON.stringify(["config.toml", "model"]);
async function openConfigurationFixture(page: Page) {
	const observedAtMs = await page.evaluate(() => Date.now());
	const requests: Array<CodexConfigurationBatchActionRequest | CodexConfigurationProfileMutationRequest> = [];
	const queriedProcedures: string[] = [];
	let state: CodexConfigurationSyncState = {
		stateResponseScope: "overview",
		storageIdentity: "isolated-configuration-preview",
		revision: 1,
		sourceObservations: [],
		observationProblem: null,
		defaultCodexConfigurationProfileId: "default-profile",
		profiles: [
			{
				profileId: "default-profile",
				name: "默认配置",
				sourceIdentity: "source",
				version: 1,
				fieldVersions: { [modelFieldKey]: 1, [effortFieldKey]: 1 },
				fields: [
					{
						fieldKey: modelFieldKey,
						fieldLabel: "model",
						value: "native-model",
						valueSummary: "native-model",
						version: 1,
						exceptionGroup: "model",
					},
					{
						fieldKey: effortFieldKey,
						fieldLabel: "model_reasoning_effort",
						value: "max",
						valueSummary: "max",
						version: 1,
						exceptionGroup: "reasoning_effort",
					},
				],
			},
		],
		observationHealth: {
			status: "healthy",
			impact: "正在观察配置变化，默认保持不变。",
			checkedAtMs: observedAtMs,
			recoveryCondition: null,
		},
		adoptionCounts: [
			{
				profileId: "default-profile",
				total: 53,
				adopted: 20,
				local_selection: 10,
				saved: 3,
				pending: 15,
				conflict: 0,
				unverified: 5,
			},
		],
		changes: [
			{
				changeId: "effort-choice",
				version: 1,
				fieldKey: effortFieldKey,
				sourceWriterId: "source-writer",
				sourceWorkspaceId: "isolated-defaults-feedback",
				sourceConversationSessionId: "修复模型目录",
				codexConfigurationProfileId: "default-profile",
				profileName: "默认配置",
				fieldLabel: "model_reasoning_effort",
				exceptionGroup: "reasoning_effort",
				candidateFieldGroupKey: "default-profile:reasoning",
				completeCandidateValueDigest: "effort-xhigh",
				previousValueSummary: "max",
				valueSummary: "xhigh",
				observedAt: observedAtMs,
				feedbackExpiresAtMs: observedAtMs + 600_000,
				recordKind: "settings_proposal",
				approvalStatus: "pending",
				decidedAt: null,
				mergeStatus: "pending_approval",
				acknowledgedAt: null,
				eligibleTargetCount: 53,
				targets: [],
				settingDifferences: [],
				comparison: {
					expectedSharedValueDigest: "default-max",
					rows: [
						{
							fieldKey: effortFieldKey,
							label: "推理强度",
							changeKind: "modified",
							previous: { state: "present", text: "max" },
							detected: { state: "present", text: "xhigh" },
							sharedCurrent: { state: "present", text: "max" },
						},
					],
				},
			},
		],
	};
	await page.route("**/api/**", (route) => route.abort());
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = (url.pathname.split("/api/trpc/")[1] ?? "").split(",");
		const batched = url.searchParams.has("batch");
		const input =
			route.request().method() === "POST"
				? route.request().postDataJSON()
				: JSON.parse(url.searchParams.get("input") ?? "{}");
		const responses = procedures.map((procedure, index) => {
			queriedProcedures.push(procedure);
			const value = batched ? input[String(index)] : input;
			let response: unknown;
			if (procedure === "runtime.getCodexConfigurationSyncOverview") response = state;
			else if (procedure === "runtime.getTerminalAgentModelSelectionOptions")
				response = {
					agentId: "codex",
					defaultModelId: "native-model",
					defaultLabel: "原生默认",
					options: [
						{
							modelId: "native-model",
							label: "原生模型",
							modelSelectionGroup: "latest_tracking_alias",
							supportedReasoningEfforts: [
								{ effort: "max" },
								{ effort: "xhigh" },
								{ effort: "ultra" },
								{ effort: "future-effort" },
							],
							defaultReasoningEffort: "max",
						},
					],
				};
			else if (procedure === "runtime.listCodexConfigurationSessionAdoptionProgress") {
				const start = value?.cursor ? 50 : 0;
				response = {
					storageIdentity: state.storageIdentity,
					totalCount: 53,
					nextCursor: start === 0 ? "next-page" : null,
					entries: Array.from({ length: start === 0 ? 50 : 3 }, (_, offset) => ({
						workspaceId: "preview",
						conversationSessionId: `session-${start + offset}`,
						runtimeSessionIncarnationId: "00000000-0000-4000-8000-000000000001",
						writerId: `writer-${start + offset}`,
						profileId: "default-profile",
						status: "pending",
						localExceptionGroups: [],
						recoveryCondition: "会话达到安全采用条件后自动接续。",
					})),
				};
			} else if (procedure === "runtime.batchCodexConfigurationAction") {
				requests.push(value);
				state = {
					...state,
					revision: state.revision + 1,
					changes: state.changes.filter(
						(change) => !value.items.some((item: { changeId: string }) => item.changeId === change.changeId),
					),
				};
				response = {
					state,
					results: value.items.map((item: { changeId: string }) => ({
						changeId: item.changeId,
						status: "applied",
						message: "已保存选择",
					})),
				};
			} else if (procedure === "runtime.mutateCodexConfigurationProfile") {
				requests.push(value);
				response = state;
			} else if (procedure === "runtime.getCodexConfigurationMutationReceipt") response = null;
			else if (procedure === "runtime.listCodexConfigurationSyncHistory")
				response = {
					changes: [],
					sourceObservations: [],
					totalCount: 0,
					nextCursor: null,
					storageIdentity: state.storageIdentity,
					storageGeneration: 1,
					historyMaximumSequence: 0,
					historyProjectionGeneration: 0,
				};
			else throw new Error(`意外 procedure：${procedure}`);
			return { result: { data: response } };
		});
		await route.fulfill({ json: batched ? responses : responses[0] });
	});
	await page.route("**/isolated-defaults-feedback", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/tests/codex-configuration-defaults-feedback-browser-harness.tsx");</script></body></html>',
		}),
	);
	await page.goto("/isolated-defaults-feedback");
	await expect(page.getByText("观察正常", { exact: true })).toBeVisible();
	return {
		requests,
		queriedProcedures,
		update: (next: CodexConfigurationSyncState) => {
			state = next;
		},
		getState: () => state,
	};
}
for (const width of [390, 1280])
	test(`配置默认、反馈浮层和采用分页在 ${width}px 下可用`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await page.clock.install({ time: new Date() });
		// 首次编译不能提前消耗稳定期，否则提醒会在输入框聚焦前展开并关闭。
		await page.clock.pauseAt(new Date(Date.now() + 60_000));
		const fixture = await openConfigurationFixture(page);
		const notice = page.getByRole("dialog", { name: "Codex 配置变更提示" });
		await page.getByRole("textbox", { name: "Agent 输入", exact: true }).focus();
		await page.clock.fastForward(9_999);
		await expect(notice).not.toBeVisible();
		await page.clock.fastForward(2);
		await expect(notice).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Agent 输入", exact: true })).toBeFocused();
		await expect(notice.getByRole("heading", { name: "推理强度：max → xhigh" })).toBeVisible();
		await page.clock.resume();
		await page.screenshot({ path: testInfo.outputPath(`feedback-${width}.png`) });
		await notice.getByRole("button", { name: "保持默认", exact: true }).focus();
		await page.keyboard.press("Enter");
		await expect
			.poll(() => fixture.requests[0])
			.toMatchObject({
				action: "reject",
				stateResponseScope: "overview",
				items: [{ changeId: "effort-choice", expectedVersion: 1 }],
			});
		await page.keyboard.press("Escape");
		await expect(page.locator('[data-verification-anchor="codex-configuration-sync-summary"]')).toBeFocused();
		await page.getByText("编辑默认", { exact: false }).click();
		const effort = page.locator(
			'[data-verification-anchor="codex-configuration-default-editor"] [data-verification-anchor="codex-task-reasoning-effort-select"] select',
		);
		await expect(effort.locator('option[value="ultra"]')).toHaveCount(1);
		await effort.selectOption("ultra");
		const previous = fixture.getState();
		fixture.update({
			...previous,
			revision: 2,
			profiles: previous.profiles?.map((profile) => ({
				...profile,
				version: 2,
				fieldVersions: { ...profile.fieldVersions, '["config.toml","other_preference"]': 2 },
			})),
		});
		await page.getByRole("button", { name: "读取最新概览" }).click();
		await expect(effort).toHaveValue("ultra");
		await page.getByRole("button", { name: "保存默认并同步", exact: true }).click();
		await expect
			.poll(() => fixture.requests.at(-1))
			.toMatchObject({
				action: "update",
				fields: [{ fieldKey: effortFieldKey, value: "ultra" }],
				expectedFieldVersions: { [modelFieldKey]: 1, [effortFieldKey]: 1 },
				stateResponseScope: "overview",
			});
		await page.getByRole("tab", { name: "自动采用", exact: true }).click();
		await expect(page.getByText("53 个会话", { exact: false })).toBeVisible();
		await page.getByRole("button", { name: "加载更多会话" }).click();
		await expect(page.getByText("preview · session-52", { exact: true })).toBeVisible();
		expect(fixture.queriedProcedures).not.toContain("runtime.getCodexConfigurationSyncActiveState");
		expect(fixture.queriedProcedures).not.toContain("runtime.getCodexConfigurationSyncState");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath(`configuration-${width}.png`), fullPage: false });
	});
