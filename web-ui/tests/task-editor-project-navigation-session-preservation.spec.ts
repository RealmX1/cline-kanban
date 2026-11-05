import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../src/config/user-interface-preferences-shared-across-browser-origins";
import type { RuntimeConfigResponse, RuntimeTerminalAgentModelSelectionOptionsResponse } from "../src/runtime/types";

const sourceProjectId = "editor-source-project";
const backgroundProjectId = "editor-background-project";
const task = {
	id: "editor-navigation-task",
	title: "来源项目的待办任务",
	prompt: "任务原文",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: 123,
	updatedAt: 123,
};
const focusedTask = { ...task, id: "foc01", title: "始终保留的 Focus 任务" };
const crossProjectBacklogTask = { ...task, title: "跨项目待办任务", createdAt: 456 };
function runtimeConfig(workspaceId: string): RuntimeConfigResponse {
	const selectedAgentId = workspaceId === backgroundProjectId ? "claude" : "codex";
	return {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		newTaskStartInPlanModeByDefault: true,
		ompAgentSessionTransportForNewTasks: "pty_terminal",
		effectiveCommand: selectedAgentId,
		globalConfigPath: "/isolated/config.json",
		projectConfigPath: `/isolated/${workspaceId}/config.json`,
		readyForReviewNotificationsEnabled: false,
		notificationSoundEnabled: false,
		autoContinueOnConnectionDropEnabled: false,
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: false,
		postDeployVerificationForceCompleteEnabled: false,
		detectedCommands: ["codex", "claude"],
		agents: ["codex", "claude"].map((id) => ({
			id: id as "codex" | "claude",
			label: id === "codex" ? "OpenAI Codex" : "Claude Code",
			binary: id,
			command: id,
			defaultArgs: [],
			installed: true,
			configured: true,
		})),
		shortcuts: [],
		clineProviderSettings: {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		commitPromptTemplate: "",
		openPrPromptTemplate: "",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
		userInterfacePreferencesSharedAcrossBrowserOrigins: {
			...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
			taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {
				[JSON.stringify([sourceProjectId, "codex"])]: "source-codex-model",
				[JSON.stringify([sourceProjectId, "claude"])]: "wrong-background-model",
			},
		},
		runtimeHostRemoteEditorAccessIdentity: {
			operatingSystemAccountUsername: "isolated-user",
			operatingSystemHostname: "isolated-host",
		},
	};
}
function workspaceState(workspaceId: string, includesFocusedTask = false) {
	return {
		repoPath: `/isolated/${workspaceId}`,
		statePath: `/isolated/${workspaceId}/state.json`,
		revision: 1,
		git: { currentBranch: "main", defaultBranch: "main", branches: [{ name: "main", isCurrent: true }] },
		sessions:
			includesFocusedTask && workspaceId === sourceProjectId
				? {
						[focusedTask.id]: {
							taskId: focusedTask.id,
							agentId: "codex",
							sessionTransport: "pty_terminal",
							turnOwner: "agent",
							liveness: "live",
							userTurnKind: null,
							workspacePath: `/isolated/${workspaceId}`,
							pid: 1,
							startedAt: Date.now(),
							updatedAt: Date.now(),
							lastOutputAt: Date.now(),
							reviewReason: null,
							exitCode: null,
						},
					}
				: {},
		board: {
			columns: ["backlog", "in_progress", "review", "validation", "trash"].map((id) => ({
				id,
				title: id,
				cards:
					id === "backlog"
						? workspaceId === sourceProjectId
							? [task]
							: includesFocusedTask
								? [crossProjectBacklogTask]
								: []
						: id === "review" && includesFocusedTask && workspaceId === sourceProjectId
							? [focusedTask]
							: [],
			})),
		},
	};
}
async function openRealApp(page: Page, includesFocusedTask = false) {
	const errors: string[] = [];
	const requests: Array<{ procedure: string; workspaceId: string; input: unknown }> = [];
	let savedSettingPresentationPreferences: Record<string, string> = {};
	page.on("pageerror", (error) => {
		errors.push(error.message);
		console.error("隔离 App 页面错误：", error.stack);
	});
	page.on("console", (message) => {
		if (message.type() === "error") console.error("隔离 App 控制台：", message.text());
	});
	await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
	const sockets: WebSocketRoute[] = [];
	let terminalConnectionCount = 0;
	if (includesFocusedTask) {
		await page.addInitScript(() =>
			localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects"),
		);
		await page.routeWebSocket("**/api/terminal/*", (socket) => {
			if (new URL(socket.url()).pathname === "/api/terminal/io") terminalConnectionCount++;
			if (new URL(socket.url()).pathname === "/api/terminal/control")
				socket.send(
					JSON.stringify({ type: "restore", cols: 60, rows: 24, snapshot: "来源 Focus 的隔离终端\r\n> " }),
				);
		});
	}
	const projects = [sourceProjectId, backgroundProjectId].map((id) => ({
		id,
		name: id === sourceProjectId ? "编辑来源项目" : "背景导航项目",
		path: `/isolated/${id}`,
		availability: { status: "available" },
		taskCounts: { backlog: id === sourceProjectId ? 1 : 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: includesFocusedTask
			? [id === sourceProjectId ? task : crossProjectBacklogTask].map((card) => ({
					taskId: card.id,
					title: card.title,
					createdAt: card.createdAt,
					agentId: "codex",
					columnId: "backlog",
					turnOwner: "user",
					liveness: "none",
					userTurnKind: null,
					lastOutputAt: null,
					lastSubstantiveOutputAt: null,
					isParkedAwaitingDispatchedBackgroundWork: false,
					taskDescriptionLastUpdatedAt: Date.now(),
					lastOpenedByUserAt: Date.now(),
					pinnedToTaskPinboardAt: Date.now(),
					taskPinboardPinReason: null,
				}))
			: [],
	}));
	await page.routeWebSocket("**/api/runtime/ws*", (socket) => {
		sockets.push(socket);
		const workspaceId = new URL(socket.url()).searchParams.get("workspaceId") ?? sourceProjectId;
		socket.send(
			JSON.stringify({
				type: "snapshot",
				currentProjectId: workspaceId,
				projects,
				workspaceState: workspaceState(workspaceId, includesFocusedTask),
				workspaceMetadata: { homeGitSummary: null, homeGitStateVersion: 0, taskWorkspaces: [] },
				clineSessionContextVersion: 0,
				notificationLog: [],
			}),
		);
	});
	await page.route("**/api/passcode/status", (route) =>
		route.fulfill({ json: { enabled: false, authenticated: true } }),
	);
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = decodeURIComponent(url.pathname.split("/api/trpc/")[1] ?? "").split(",");
		const payload = route.request().postDataJSON() ?? JSON.parse(url.searchParams.get("input") ?? "{}");
		const workspaceId = route.request().headers()["x-kanban-workspace-id"] ?? sourceProjectId;
		const results = procedures.map((procedure, index) => {
			const input = (url.searchParams.get("batch") === "1" ? payload[index] : payload) ?? {};
			requests.push({ procedure, workspaceId, input });
			let value: unknown;
			if (procedure === "runtime.getConfig" || procedure === "runtime.saveConfig") {
				const preferencePatch =
					input.userInterfacePreferencesSharedAcrossBrowserOrigins?.taskEditorSettingPresentationBySettingKey;
				if (preferencePatch)
					savedSettingPresentationPreferences = { ...savedSettingPresentationPreferences, ...preferencePatch };
				const configuration = runtimeConfig(workspaceId);
				value = {
					...configuration,
					userInterfacePreferencesSharedAcrossBrowserOrigins: {
						...configuration.userInterfacePreferencesSharedAcrossBrowserOrigins,
						taskEditorSettingPresentationBySettingKey: savedSettingPresentationPreferences,
					},
				};
			} else if (procedure === "workspace.getState" || procedure === "workspace.saveState")
				value = workspaceState(workspaceId, includesFocusedTask);
			else if (
				procedure === "taskCardAction.readTaskCardWithBoardColumn" ||
				procedure === "taskCardAction.updateTaskCardFieldValues"
			) {
				const column = workspaceState(workspaceId, includesFocusedTask).board.columns.find((column) =>
					column.cards.some((card) => card.id === input.taskId),
				);
				const card = column?.cards.find((card) => card.id === input.taskId);
				const snapshot = {
					taskCard: { ...card, ...input.taskCardFieldUpdate?.taskCardFieldValuePatch },
					boardColumnIdContainingTaskCard: column?.id,
					taskSessionSummaryLiveInRuntimeProcessMemory: null,
					taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
				};
				value =
					procedure === "taskCardAction.updateTaskCardFieldValues"
						? { taskCardSnapshotAfterAction: snapshot }
						: { taskCardLookupOutcome: "task_card_found_on_workspace_board", taskCardSnapshot: snapshot };
			} else if (procedure === "projects.getAllProjectsTaskSearchIndex")
				value = {
					projects: [
						{
							projectId: backgroundProjectId,
							projectName: "背景导航项目",
							tasks: [
								{
									...crossProjectBacklogTask,
									taskId: crossProjectBacklogTask.id,
									columnId: "backlog",
									agentId: "codex",
									mostRecentlyLaunchedAgentSessionAgentId: null,
									agentConversationProgressObservedAt: null,
								},
							],
						},
					],
				};
			else if (procedure === "runtime.issueKanbanWebUiPageLoadRequestOriginNonce")
				value = { kanbanWebUiPageLoadIssuedRequestOriginNonce: "isolated-page-nonce" };
			else if (procedure === "runtime.getCodexConfigurationSyncState")
				value = { revision: 0, changes: [], sourceObservations: [], observationProblem: null };
			else if (procedure === "runtime.getClineKanbanAccess") value = { enabled: true };
			else if (procedure === "runtime.listAgentRaisedPendingUserDecisions") value = { decisions: [] };
			else if (procedure === "dailyWorkProgressStatistics.getSummary")
				value = {
					projects: [],
					metrics: [],
					achievements: [],
					celebrationEligibleAchievementIds: [],
					workspaceId: null,
					dateKey: "2026-10-25",
					timeZone: "America/New_York",
				};
			else if (procedure === "runtime.getClineProviderCatalog") value = { providers: [] };
			else if (procedure === "runtime.getTaskPromptDeliveryQueue")
				value = { entries: [], projectedEntriesByTaskId: {} };
			else if (procedure === "notificationIntelligence.listPanelTaskGroups") value = { groups: [] };
			else if (procedure === "runtime.getTerminalAgentModelSelectionOptions")
				value = {
					agentId: input.agentId,
					defaultModelId: null,
					defaultLabel: "Default",
					options: [
						{ modelId: "source-codex-model", label: "来源模型", description: "来源模型" },
						{ modelId: "wrong-background-model", label: "错误背景模型", description: "错误背景模型" },
					],
				} satisfies RuntimeTerminalAgentModelSelectionOptionsResponse;
			else if (procedure === "workUnit.getRelationModelingPreview")
				value = {
					rootWorkUnitKey: "draft-root",
					workUnits: [],
					relations: [],
					depthsByWorkUnitKey: {},
					truncated: false,
				};
			else if (procedure === "workUnit.readRelationModelingEditorDraft") value = null;
			else if (procedure === "workUnit.resolveKanbanBoardCardIdentityByBareTaskId")
				value = {
					kanbanBoardCardIdentityCandidates: [sourceProjectId, backgroundProjectId].flatMap((projectId) =>
						workspaceState(projectId, includesFocusedTask).board.columns.flatMap((column) =>
							column.cards
								.filter((card) => card.id === input.bareTaskId)
								.map((card) => ({
									kanbanBoardCard: {
										workUnitType: "kanban_board_card",
										workspaceId: projectId,
										taskId: card.id,
										taskIncarnationCreatedAtEpochMs: card.createdAt,
									},
									workspaceRepositoryPath: `/isolated/${projectId}`,
									currentTitle: card.title,
									promptFirstParagraph: card.prompt,
									lastKnownBoardColumnId: column.id,
									movedToTrashColumnAt: null,
									permanentlyRemovedFromBoardAt: null,
									creationActorKind: null,
									kanbanBoardCardFirstObservationRoute: "isolated_browser_fixture",
								})),
						),
					),
				};
			else if (procedure === "workUnit.applyReferenceRelationModelingChangesDirectlyAsWebUiUser") value = {};
			else if (procedure === "workUnit.saveRelationModelingEditorDraft") value = { saved: true };
			else if (procedure === "workUnit.reserveKanbanBoardCardIds") value = { taskIds: ["fresh-editor-task"] };
			else if (
				procedure === "runtime.getWorkspaceTaskEditDrafts" ||
				procedure === "runtime.mutateWorkspaceTaskEditDrafts"
			)
				value = { ok: true, drafts: { draftsByTaskId: {}, supersededDraftCopies: [] } };
			else if (procedure === "deployment.getPostDeployVerificationState")
				value = { deploymentGroups: [], activeDeploymentId: null };
			else if (procedure.includes("Findings")) value = { findings: [] };
			else if (procedure.includes("QueuedTaskPromptDelivery")) value = { projectionsByTaskId: {} };
			else if (procedure === "support.analyzeTaskProjectAssignment")
				value = {
					operationId: input.operationId,
					currentWorkspaceId: workspaceId,
					inputFingerprint: "isolated",
					suggestedWorkspaceId: null,
					suggestedProjectName: null,
					rationale: "保留当前目标",
					confidence: "high",
					stablePromptPrefixSha256: "isolated",
				};
			if (value === undefined && includesFocusedTask)
				return {
					error: {
						message: `隔离浏览器夹具未提供 ${procedure}`,
						code: -32004,
						data: { code: "NOT_FOUND", httpStatus: 404 },
					},
				};
			return { result: { data: value === undefined ? {} : value } };
		});
		await route.fulfill({ json: url.searchParams.get("batch") === "1" ? results : results[0] });
	});
	await page.goto(`/${sourceProjectId}${includesFocusedTask ? `?task=${focusedTask.id}` : ""}`);
	try {
		if (includesFocusedTask) await expect(page.locator(".xterm-screen")).toBeVisible();
		else await expect(page.locator('[data-task-id="editor-navigation-task"]').first()).toBeVisible();
	} catch (failure) {
		throw new Error(
			JSON.stringify({ errors, requests, body: await page.locator("body").innerText() }) + String(failure),
		);
	}
	return {
		errors,
		requests,
		terminalConnectionCount: () => terminalConnectionCount,
		markBackgroundProjectUnavailable: () => {
			for (const socket of sockets) {
				try {
					socket.send(
						JSON.stringify({
							type: "projects_updated",
							currentProjectId: backgroundProjectId,
							projects: projects.map((project) =>
								project.id === backgroundProjectId
									? { ...project, availability: { status: "unavailable", reason: "project_path_missing" } }
									: project,
							),
						}),
					);
				} catch {
					/* 已结束的连接不再接收广播。 */
				}
			}
		},
	};
}

for (const kind of ["create", "edit"] as const) {
	for (const backgroundBecomesUnavailable of [false, true]) {
		test(`${kind}：真实 App 跨项目导航${backgroundBecomesUnavailable ? "且后台项目不可用时" : "时"}保留正文、名称、固定项目与默认 Agent`, async ({
			page,
		}) => {
			const fixture = await openRealApp(page);
			if (kind === "create") await page.getByRole("button", { name: "Create task", exact: true }).first().click();
			else await page.locator('[data-task-id="editor-navigation-task"]').first().click();
			const dialog = page
				.getByRole("dialog")
				.filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
			await expect(dialog).toBeVisible();
			if (kind === "create") {
				await dialog.getByRole("button", { name: /^模型与参数：/ }).click();
				await dialog.getByRole("button", { name: "来源模型", exact: true }).click();
			}
			await dialog.getByRole("textbox", { name: "任务名称（可选）", exact: true }).fill("切换后保留的名称");
			await dialog.locator("textarea").first().fill("切换后台项目时不能丢失的正文");
			await dialog.getByRole("textbox", { name: "任务名称（可选）", exact: true }).focus();
			await page.getByRole("button", { name: "收起任务编辑器", exact: true }).click();
			await page
				.getByRole("button", { name: /背景导航项目/ })
				.first()
				.click();
			await expect(page).toHaveURL(new RegExp(`/${backgroundProjectId}`));
			if (backgroundBecomesUnavailable) fixture.markBackgroundProjectUnavailable();
			await expect(page.getByRole("button", { name: "展开任务编辑器", exact: true })).toBeVisible();
			await page.getByRole("button", { name: "展开任务编辑器", exact: true }).click();
			await expect(dialog.locator("textarea").first()).toHaveValue("切换后台项目时不能丢失的正文");
			await expect(dialog.getByRole("textbox", { name: "任务名称（可选）", exact: true })).toHaveValue(
				"切换后保留的名称",
			);
			await expect(dialog.locator('[data-testid="task-creation-target-project-field"]')).toContainText(
				"编辑来源项目",
			);
			await dialog.getByRole("button", { name: /^Agent：/ }).click();
			await expect(
				dialog.getByRole("button", { name: "OpenAI Codex (default agent)", exact: true }),
			).toHaveAttribute("aria-pressed", "true");
			if (kind === "create") {
				const collapsedModelSettings = dialog.getByRole("button", { name: /^模型与参数：/ });
				if (await collapsedModelSettings.isVisible()) await collapsedModelSettings.click();
				await expect(dialog.getByRole("button", { name: "来源模型", exact: true })).toHaveAttribute(
					"aria-pressed",
					"true",
				);
			}
			expect(fixture.errors).toEqual([]);
		});
	}
}

for (const width of [1440, 390]) {
	for (const target of ["current-project", "other-project"] as const) {
		for (const entry of width < 768 ? (["search"] as const) : (["list", "expanded-card", "search"] as const)) {
			test(`${width}px：从 ${entry} 编辑 ${target} Backlog 时保持来源 Focus、URL 和终端`, async ({ page }) => {
				await page.setViewportSize({ width, height: 1000 });
				const fixture = await openRealApp(page, true);
				const sourceUrl = page.url();
				await expect.poll(fixture.terminalConnectionCount).toBe(1);
				const initialConnections = fixture.terminalConnectionCount();
				const terminal = await page.locator(".xterm-screen").elementHandle();
				const workspaceId = target === "current-project" ? sourceProjectId : backgroundProjectId;
				const title = target === "current-project" ? task.title : crossProjectBacklogTask.title;
				const row = page
					.locator(
						`[data-cross-project-task-switcher-workspace-id="${workspaceId}"][data-cross-project-task-switcher-task-id="${task.id}"]`,
					)
					.first();
				const openEditor = async () => {
					if (entry === "search") {
						const expandNavigation = page.getByRole("button", { name: "展开上方导航与工具", exact: true });
						if (await expandNavigation.isVisible()) await expandNavigation.click();
						await page.getByTestId("open-task-spotlight-search-button").click();
						await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill(title);
						await page
							.getByRole("dialog", { name: "Search tasks", exact: true })
							.getByText(title, { exact: true })
							.click();
					} else if (entry === "expanded-card") {
						const keepExpanded = row.getByRole("button", { name: "Keep expanded in list", exact: true });
						if (await keepExpanded.count()) {
							await keepExpanded.focus();
							await keepExpanded.press("Enter");
						}
						await row.getByText(title, { exact: true }).first().click();
					} else await row.getByRole("button", { name: `打开任务：${title}`, exact: true }).click();
				};
				const editor = page
					.getByRole("dialog")
					.filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
				await openEditor();
				await expect(editor).toBeVisible();
				await expect(page).toHaveURL(sourceUrl);
				if (entry === "search" && target === "other-project")
					await page.screenshot({ path: test.info().outputPath(`focus-backlog-floating-editor-${width}.png`) });
				await editor.getByRole("button", { name: "关闭任务编辑器", exact: true }).click();
				await expect(editor).toBeHidden();
				await expect(page).toHaveURL(sourceUrl);
				await openEditor();
				await expect(editor).toBeVisible();
				await editor.getByRole("textbox", { name: "任务名称（可选）", exact: true }).fill("原地编辑保存的名称");
				await editor.getByRole("button", { name: "保存更改", exact: true }).click();
				await expect(editor).toBeHidden();
				await expect(page).toHaveURL(sourceUrl);
				expect(fixture.requests).toContainEqual(
					expect.objectContaining({
						procedure: "taskCardAction.updateTaskCardFieldValues",
						workspaceId,
						input: expect.objectContaining({
							expectedTaskIncarnationCreatedAtEpochMs: target === "current-project" ? 123 : 456,
						}),
					}),
				);
				expect(await terminal?.evaluate((element) => element.isConnected)).toBe(true);
				expect(fixture.terminalConnectionCount()).toBe(initialConnections);
				expect(fixture.errors).toEqual([]);
				await page.screenshot({ path: test.info().outputPath(`focus-backlog-${width}-${target}-${entry}.png`) });
			});
		}
	}
}

for (const entry of ["list", "expanded-card"] as const) {
	test(`普通看板从 ${entry} 编辑跨项目 Backlog 时原地打开浮窗`, async ({ page }) => {
		const fixture = await openRealApp(page, true);
		await page.getByRole("button", { name: "Back to board", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/${sourceProjectId}$`));
		const sourceBoardUrl = page.url();
		const row = page
			.locator(
				`[data-cross-project-task-switcher-workspace-id="${backgroundProjectId}"][data-cross-project-task-switcher-task-id="${task.id}"]`,
			)
			.first();
		if (entry === "expanded-card") {
			const keepExpanded = row.getByRole("button", { name: "Keep expanded in list", exact: true });
			if (await keepExpanded.count()) {
				await keepExpanded.focus();
				await keepExpanded.press("Enter");
			}
			await row.getByText(crossProjectBacklogTask.title, { exact: true }).first().click();
		} else await row.getByRole("button", { name: `打开任务：${crossProjectBacklogTask.title}`, exact: true }).click();
		const editor = page
			.getByRole("dialog")
			.filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
		await expect(editor).toBeVisible();
		await expect(editor.getByRole("textbox", { name: "任务名称（可选）", exact: true })).toHaveValue(
			crossProjectBacklogTask.title,
		);
		await expect(page).toHaveURL(sourceBoardUrl);
		await editor.getByRole("button", { name: "关闭任务编辑器", exact: true }).click();
		await expect(editor).toBeHidden();
		await expect(page).toHaveURL(sourceBoardUrl);
		expect(fixture.errors).toEqual([]);
	});

	for (const navigation of ["back", "current-project-backlog"] as const) {
		test(`从 ${entry} 读取跨项目 Backlog 期间 ${navigation} 后忽略旧响应`, async ({ page }) => {
			const fixture = await openRealApp(page, true);
			const sourceUrl = page.url();
			const crossProjectRow = page
				.locator(
					`[data-cross-project-task-switcher-workspace-id="${backgroundProjectId}"][data-cross-project-task-switcher-task-id="${task.id}"]`,
				)
				.first();
			if (entry === "expanded-card") {
				const keepExpanded = crossProjectRow.getByRole("button", { name: "Keep expanded in list", exact: true });
				if (await keepExpanded.count()) {
					await keepExpanded.focus();
					await keepExpanded.press("Enter");
				}
				await expect(
					crossProjectRow.getByText(crossProjectBacklogTask.title, { exact: true }).first(),
				).toBeVisible();
			}
			let releaseOldRead!: () => void;
			const oldReadBarrier = new Promise<void>((resolve) => {
				releaseOldRead = resolve;
			});
			let acknowledgeReadStarted!: () => void;
			const readStarted = new Promise<void>((resolve) => {
				acknowledgeReadStarted = resolve;
			});
			await page.route("**/api/trpc/**", async (route) => {
				const procedures = decodeURIComponent(new URL(route.request().url()).pathname).split("/api/trpc/")[1];
				if (
					procedures?.split(",").includes("taskCardAction.readTaskCardWithBoardColumn") &&
					route.request().headers()["x-kanban-workspace-id"] === backgroundProjectId
				) {
					acknowledgeReadStarted();
					await oldReadBarrier;
				}
				await route.fallback();
			});
			if (entry === "expanded-card")
				await crossProjectRow.getByText(crossProjectBacklogTask.title, { exact: true }).first().click();
			else
				await crossProjectRow
					.getByRole("button", { name: `打开任务：${crossProjectBacklogTask.title}`, exact: true })
					.click();
			await readStarted;
			const editor = page
				.getByRole("dialog")
				.filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
			if (navigation === "back") {
				await page.getByRole("button", { name: "Back to board", exact: true }).click();
				await expect(page).not.toHaveURL(sourceUrl);
			} else {
				await page
					.locator(
						`[data-cross-project-task-switcher-workspace-id="${sourceProjectId}"][data-cross-project-task-switcher-task-id="${task.id}"]`,
					)
					.first()
					.getByRole("button", { name: `打开任务：${task.title}`, exact: true })
					.click();
				await expect(editor).toBeVisible();
			}
			const oldReadResponse = page.waitForResponse(
				(response) =>
					response.url().includes("taskCardAction.readTaskCardWithBoardColumn") &&
					response.request().headers()["x-kanban-workspace-id"] === backgroundProjectId,
			);
			releaseOldRead();
			await (await oldReadResponse).finished();
			await page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
			);
			if (navigation === "back") await expect(editor).toBeHidden();
			else {
				await expect(editor.getByRole("textbox", { name: "任务名称（可选）", exact: true })).toHaveValue(
					task.title,
				);
				await expect(page).toHaveURL(sourceUrl);
			}
			expect(fixture.errors).toEqual([]);
		});
	}
}
