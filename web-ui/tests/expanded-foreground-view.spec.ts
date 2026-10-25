import { expect, type Page, test } from "@playwright/test";

const artifact = {
	workspaceId: "isolated-project",
	taskId: "source-task",
	visualizationArtifactId: "a".repeat(64),
	revisionId: "b".repeat(64),
	versionNumber: 1,
	title: "交互图",
	entryHtmlRelativePath: "index.html",
	publishedAtMs: 1,
	sourceConversationSessionId: null,
};
const confirmationId = "11111111-1111-4111-8111-111111111111";
function entry(workspaceId: string, taskId: string, incarnation: number) {
	const reference = {
		workUnitType: "kanban_board_card",
		workspaceId,
		taskId,
		taskIncarnationCreatedAtEpochMs: incarnation,
	};
	return {
		workUnitKey: `kanban_board_card:${workspaceId}:${taskId}:${incarnation}`,
		workUnit: reference,
		workUnitDisplayLabel: `${workspaceId}/${taskId}`,
		kanbanBoardCardIdentity: {
			kanbanBoardCard: reference,
			workspaceRepositoryPath: null,
			currentTitle: workspaceId === "other-project" ? "另一项目任务" : "来源任务",
			promptFirstParagraph: "隔离测试任务",
			lastKnownBoardColumnId: "in_progress",
			movedToTrashColumnAt: null,
			permanentlyRemovedFromBoardAt: null,
			creationActorKind: null,
			kanbanBoardCardFirstObservationRoute: "task_card_created_on_board_within_live_capture",
		},
	};
}

async function installHarness(page: Page, rebuildTaskIdentity = false) {
	const calls: string[] = [];
	const selectors: unknown[] = [];
	let contentLoads = 0;
	await page.route("**/api/trpc/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(request.postData() ?? url.searchParams.get("input") ?? "{}");
		const responses = procedures.map((procedure, index) => {
			calls.push(procedure);
			const input = inputs[String(index)] ?? {};
			let data: unknown;
			if (procedure === "taskVisualizationArtifacts.list") data = { artifacts: [artifact] };
			else if (procedure === "taskVisualizationArtifacts.preparePreview")
				data = {
					artifact: { ...artifact, revisionId: input.revisionId ?? artifact.revisionId },
					contentRelativeUrl: "/isolated-foreground-content",
					viewerRelativeUrl: "/task-visualization-preview",
					contentAccessExpiresAtMs: Date.now() + 60_000,
					contentLoadConfirmationId: confirmationId,
				};
			else if (procedure === "workUnit.readRelationModelingEditorDraft") data = null;
			else if (
				procedure === "workUnit.getRelationModelingPreview" ||
				procedure === "workUnit.getRelationNeighborhoodSummary"
			) {
				selectors.push(input.workUnit);
				const reference = input.workUnit.kanbanBoardCard ?? {
					workspaceId: "isolated-project",
					taskId: "source-task",
					taskIncarnationCreatedAtEpochMs: 10,
				};
				const root = entry(reference.workspaceId, reference.taskId, reference.taskIncarnationCreatedAtEpochMs);
				const neighbor =
					reference.workspaceId === "other-project"
						? entry("isolated-project", "source-task", 10)
						: entry("other-project", "same-id", 20);
				data =
					procedure === "workUnit.getRelationModelingPreview"
						? {
								rootWorkUnitKey: root.workUnitKey,
								workUnits: [root, neighbor],
								relations: [
									{
										relationId: "relation-1",
										subjectKey: root.workUnitKey,
										anchorKey: neighbor.workUnitKey,
										relationKind: "reference_is_generally_related_with",
										relationPresentationState: "saved",
										assertedRelation: null,
									},
								],
								truncated: false,
								projectedThroughGlobalCommittedEventSequence: 1,
							}
						: {
								subjectWorkUnit: root,
								recordedRelations: [],
								assertedRelations: [],
								neighborWorkUnits: [],
								secondHopRecordedRelations: [],
								secondHopNeighborWorkUnits: [],
								conversationSessionOwnershipConflictDiagnostics: [],
								renderedNeighborhoodSummaryText: "",
								hasAnyRelationVisibleByDefault: false,
								recordedInterWorkUnitRelationProjectionTableVersion: 4,
								projectedThroughGlobalCommittedEventSequence: 1,
							};
			} else if (procedure === "workspace.getState")
				data = {
					board: {
						columns: [
							{ id: "in_progress", cards: [{ id: "source-task", createdAt: rebuildTaskIdentity ? 11 : 10 }] },
						],
					},
				};
			else if (procedure === "exploratory.getExplorationThreadGraph")
				data = {
					view: {
						schemaVersion: 1,
						explorationId: "source-task",
						turnRows: [],
						threads: [],
						laneCount: 0,
						staleReason: null,
						unplacedTurnCountBySession: {},
						lastMaintenanceJobCompletedAt: null,
						lastMaintenanceJobUsage: null,
						anyTurnSourceIsTranscriptReconstructed: false,
					},
					turnSourceUnavailableSessionIds: [],
				};
			else
				return {
					error: {
						message: `隔离测试不允许调用 ${procedure}`,
						code: -32601,
						data: { code: "NOT_FOUND", httpStatus: 404 },
					},
				};
			return { result: { data } };
		});
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(url.searchParams.has("batch") ? responses : responses[0]),
		});
	});
	await page.route("**/isolated-foreground-content", async (route) => {
		contentLoads++;
		const proof = JSON.stringify({
			...artifact,
			type: "kanban_visualization_content_loaded",
			contentLoadConfirmationId: confirmationId,
		});
		await route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><body><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><script>window.addEventListener("load",()=>parent.postMessage(${proof},"*"));window.addEventListener("keydown",event=>{if(event.key==="Escape")parent.postMessage({...${proof},type:"kanban_visualization_request_collapse_foreground_view"},"*")});</script></body></html>`,
		});
	});
	await page.route(/\/isolated-expanded-foreground-view(?:\?|$)/u, (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body><script type='module'>import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const harness=document.createElement('script');harness.type='module';harness.src='/tests/expanded-foreground-view-browser-harness.tsx';document.body.append(harness);</script></body></html>",
		}),
	);
	return { calls, selectors, contentLoads: () => contentLoads };
}

test("内层对话框获得焦点并先关闭，随后 Esc 才收回前台", async ({ page }) => {
	await installHarness(page);
	await page.goto("/isolated-expanded-foreground-view?task=source-task");
	await page.getByRole("button", { name: "展开交互验证面板", exact: true }).click();
	await page.getByRole("button", { name: "打开内层对话框", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "内层验证对话框", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "内层验证对话框", exact: true })).toHaveCount(0);
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toHaveCount(0);
});

test("展开返回与浏览器前进保留同一 iframe，内容中的 Esc 可收回", async ({ page }) => {
	const evidence = await installHarness(page);
	await page.goto("/isolated-expanded-foreground-view?task=source-task");
	const counter = page.frameLocator('iframe[title="交互图"]').locator("#counter");
	await counter.click();
	await expect(counter).toHaveText("1");
	await page.evaluate(() =>
		Object.assign(window, { initialForegroundIframe: document.querySelector('iframe[title="交互图"]') }),
	);
	await page.getByRole("button", { name: "全屏预览", exact: true }).click();
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toBeVisible();
	await expect(counter).toHaveText("1");
	await page.getByRole("button", { name: "返回", exact: true }).click();
	await expect(page).not.toHaveURL(/expandedView=/u);
	await page.goForward();
	await expect(page).toHaveURL(/expandedView=task_visualization/u);
	await counter.click();
	await expect(counter).toHaveText("2");
	await counter.press("Escape");
	await expect(page).not.toHaveURL(/expandedView=/u);
	const identical = await page.evaluate(
		() =>
			(window as unknown as { initialForegroundIframe: HTMLIFrameElement }).initialForegroundIframe ===
			document.querySelector('iframe[title="交互图"]'),
	);
	expect(identical).toBe(true);
	expect(evidence.contentLoads()).toBe(1);
	await page.screenshot({ path: test.info().outputPath("visualization-return.png") });
});

for (const initiallyMobile of [true, false]) {
	for (const collapseMethod of ["返回按钮", "浏览器后退"] as const) {
		test(`真实 CardDetailView ${initiallyMobile ? "手机切桌面" : "桌面切手机"}后${collapseMethod}保留浏览上下文`, async ({
			page,
		}) => {
			await page.setViewportSize(initiallyMobile ? { width: 393, height: 852 } : { width: 1440, height: 900 });
			await page.addInitScript(() => {
				Object.assign(window, { responsiveForegroundIframeLoadCount: 0 });
				document.addEventListener(
					"load",
					(event) => {
						if (event.target instanceof HTMLIFrameElement)
							(window as unknown as { responsiveForegroundIframeLoadCount: number })
								.responsiveForegroundIframeLoadCount++;
					},
					true,
				);
			});
			let terminalConnections = 0;
			await page.routeWebSocket("**/*", (socket) => {
				const url = new URL(socket.url());
				if (url.pathname === "/api/terminal/io") terminalConnections++;
				if (url.pathname === "/api/terminal/control")
					socket.send(JSON.stringify({ type: "restore", cols: 60, rows: 24, snapshot: "隔离前台终端\r\n> " }));
			});
			const evidence = await installHarness(page);
			await page.goto("/isolated-expanded-foreground-view?task=source-task&realCardDetail=1");
			await expect(page.locator(".xterm-screen")).toBeVisible();
			await expect.poll(() => terminalConnections).toBe(1);
			if (initiallyMobile) {
				await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).click();
				await page.getByRole("button", { name: "可视化", exact: true }).click();
			} else await page.getByLabel("工作台格位 2", { exact: true }).selectOption("task_visualizations");
			await page.getByLabel("选择可视化", { exact: true }).selectOption(artifact.visualizationArtifactId);
			const counter = page.frameLocator('iframe[title="交互图"]').locator("#counter");
			await counter.click();
			await expect(counter).toHaveText("1");
			await page.evaluate(() => {
				const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="交互图"]')!;
				Object.assign(window, {
					initialResponsiveForegroundIframe: iframe,
					initialResponsiveForegroundContentWindow: iframe.contentWindow,
				});
			});
			await page.getByRole("button", { name: "全屏预览", exact: true }).click();
			await page.setViewportSize(initiallyMobile ? { width: 1440, height: 900 } : { width: 393, height: 852 });
			await expect(page.locator('[data-expanded-foreground-view="active"]')).toBeVisible();
			await expect(counter).toHaveText("1");
			if (collapseMethod === "返回按钮") await page.getByRole("button", { name: "返回", exact: true }).click();
			else await page.goBack();
			await expect(page).not.toHaveURL(/expandedView=/u);
			const continuity = await page.evaluate(() => {
				const observedWindow = window as unknown as {
					initialResponsiveForegroundIframe: HTMLIFrameElement;
					initialResponsiveForegroundContentWindow: Window;
					responsiveForegroundIframeLoadCount: number;
					readResponsiveForegroundTerminalMountCount: () => number;
				};
				const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="交互图"]');
				return {
					sameIframe: iframe === observedWindow.initialResponsiveForegroundIframe,
					sameContentWindow: iframe?.contentWindow === observedWindow.initialResponsiveForegroundContentWindow,
					iframeLoadCount: observedWindow.responsiveForegroundIframeLoadCount,
					terminalMountCount: observedWindow.readResponsiveForegroundTerminalMountCount(),
				};
			});
			expect(continuity).toEqual({
				sameIframe: true,
				sameContentWindow: true,
				iframeLoadCount: 1,
				terminalMountCount: 1,
			});
			await expect(counter).toHaveText("1");
			await expect(page.locator('iframe[title="交互图"]')).toBeVisible();
			await counter.click();
			await expect(counter).toHaveText("2");
			expect(evidence.contentLoads()).toBe(1);
			expect(terminalConnections).toBe(1);
			if (initiallyMobile) await expect(page.getByRole("region", { name: "任务工作台", exact: true })).toBeVisible();
			else await expect(page.locator("[data-mobile-focused-task-card-header]")).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				initiallyMobile ? 1440 : 393,
			);
			await page.screenshot({ path: test.info().outputPath("responsive-foreground-return.png") });
		});
	}
}

test("Relations 保留图谱视口和未暂存表单，跨项目入口以预览任务为根且支持刷新", async ({ page }) => {
	const evidence = await installHarness(page);
	await page.goto("/isolated-expanded-foreground-view?task=source-task");
	await page.getByRole("button", { name: "展开关系图", exact: true }).click();
	await expect(page.getByRole("group", { name: "任务多跳关系图", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "放大关系图", exact: true }).click();
	const transform = await page
		.locator('[data-expanded-foreground-view="active"] .react-flow__viewport')
		.getAttribute("style");
	await page.getByRole("button", { name: "添加关系", exact: true }).click();
	await expect(page.getByRole("group", { name: "新增参照关系", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "返回", exact: true }).click();
	await page.getByRole("button", { name: "展开关系图", exact: true }).click();
	await expect(page.getByRole("group", { name: "新增参照关系", exact: true })).toBeVisible();
	await expect(page.locator('[data-expanded-foreground-view="active"] .react-flow__viewport')).toHaveAttribute(
		"style",
		transform!,
	);
	await page.getByRole("button", { name: "返回", exact: true }).click();
	await page.getByRole("button", { name: "预览关联任务", exact: true }).click();
	await page.getByRole("button", { name: "预览任务的关系图", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "隔离关联预览", exact: true })).toHaveCount(0);
	await expect(page).toHaveURL(/expandedWorkspaceId=other-project/u);
	await expect(
		page.locator('[data-expanded-foreground-view="active"] .react-flow__node').filter({ hasText: "当前任务" }),
	).toContainText("另一项目任务");
	await page.reload();
	await expect(
		page.locator('[data-expanded-foreground-view="active"] .react-flow__node').filter({ hasText: "当前任务" }),
	).toContainText("另一项目任务");
	expect(evidence.selectors).toContainEqual({
		workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
		kanbanBoardCard: {
			workUnitType: "kanban_board_card",
			workspaceId: "other-project",
			taskId: "same-id",
			taskIncarnationCreatedAtEpochMs: 20,
		},
	});
	expect(evidence.calls.some((name) => /applyReference|saveRelation|Maintenance|suggestReference/u.test(name))).toBe(
		false,
	);
	await page.screenshot({ path: test.info().outputPath("relations-foreground.png") });
});

test.describe("触屏前台视图", () => {
	test.use({ isMobile: true, hasTouch: true, viewport: { width: 393, height: 852 } });
	test("手机探索地图展开收回保留轮次与滚动，刷新只走免费读取", async ({ page }) => {
		await page.setViewportSize({ width: 393, height: 852 });
		const evidence = await installHarness(page);
		await page.goto("/isolated-expanded-foreground-view?task=source-task");
		const row = page.getByRole("button", { name: /探索轮次 30/u });
		await row.tap();
		await page.getByRole("button", { name: "展开探索地图", exact: true }).tap();
		await expect(row).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator('[data-expanded-foreground-view="active"]')).toBeInViewport();
		await page.getByRole("button", { name: "返回", exact: true }).tap();
		await expect(row).toHaveAttribute("aria-expanded", "true");
		await page.getByRole("button", { name: "展开探索地图", exact: true }).tap();
		await page.screenshot({ path: test.info().outputPath("exploration-mobile.png") });
		await page.reload();
		await expect(page.locator('[data-expanded-foreground-view="active"]')).toContainText("探索地图");
		await expect
			.poll(() => evidence.calls.filter((name) => name === "exploratory.getExplorationThreadGraph").length)
			.toBeGreaterThan(0);
		expect(evidence.calls.some((name) => /Maintenance/u.test(name))).toBe(false);
	});
});

test("可视化链接刷新保持版本，已重建任务不得读取旧链接内容", async ({ page }) => {
	const evidence = await installHarness(page);
	const url = `/isolated-expanded-foreground-view?expandedView=task_visualization&expandedWorkspaceId=isolated-project&expandedTaskId=source-task&expandedTaskIncarnationCreatedAtEpochMs=10&expandedVisualizationArtifactId=${artifact.visualizationArtifactId}&expandedVisualizationRevisionId=${artifact.revisionId}`;
	await page.goto(url);
	await expect(page.locator('[data-expanded-foreground-view="active"] iframe')).toBeVisible();
	await expect(page).toHaveURL(new RegExp(artifact.revisionId, "u"));
	await page.reload();
	await expect(page.locator('[data-expanded-foreground-view="active"] iframe')).toBeVisible();
	expect(evidence.contentLoads()).toBeGreaterThanOrEqual(2);
	await page.unroute("**/api/trpc/**");
	await installHarness(page, true);
	await page.goto(url);
	await expect(page.getByRole("alert")).toContainText("未找到这一世任务");
	await expect(page.locator('[data-expanded-foreground-view="active"] iframe')).toHaveCount(0);
});
