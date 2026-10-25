import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../src/config/user-interface-preferences-shared-across-browser-origins";
import type { RuntimeConfigResponse } from "../src/runtime/types";

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
function workspaceState(workspaceId: string) {
	return {
		repoPath: `/isolated/${workspaceId}`,
		statePath: `/isolated/${workspaceId}/state.json`,
		revision: 1,
		git: { currentBranch: "main", defaultBranch: "main", branches: [{ name: "main", isCurrent: true }] },
		sessions: {},
		board: {
			columns: ["backlog", "in_progress", "review", "validation", "trash"].map((id) => ({
				id,
				title: id,
				cards: id === "backlog" && workspaceId === sourceProjectId ? [task] : [],
			})),
		},
	};
}
async function openRealApp(page: Page) {
	const errors: string[] = [];
	const requests: Array<{ procedure: string; workspaceId: string; input: unknown }> = [];
	page.on("pageerror", (error) => {
		errors.push(error.message);
		console.error("隔离 App 页面错误：", error.stack);
	});
	page.on("console", (message) => {
		if (message.type() === "error") console.error("隔离 App 控制台：", message.text());
	});
	await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
	const sockets: WebSocketRoute[] = [];
	const projects = [sourceProjectId, backgroundProjectId].map((id) => ({
		id,
		name: id === sourceProjectId ? "编辑来源项目" : "背景导航项目",
		path: `/isolated/${id}`,
		availability: { status: "available" },
		taskCounts: { backlog: id === sourceProjectId ? 1 : 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: [],
	}));
	await page.routeWebSocket("**/api/runtime/ws*", (socket) => {
		sockets.push(socket);
		const workspaceId = new URL(socket.url()).searchParams.get("workspaceId") ?? sourceProjectId;
		socket.send(
			JSON.stringify({
				type: "snapshot",
				currentProjectId: workspaceId,
				projects,
				workspaceState: workspaceState(workspaceId),
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
			let value: unknown = {};
			if (procedure === "runtime.getConfig" || procedure === "runtime.saveConfig")
				value = runtimeConfig(workspaceId);
			else if (procedure === "workspace.getState" || procedure === "workspace.saveState")
				value = workspaceState(workspaceId);
			else if (procedure === "runtime.issueKanbanWebUiPageLoadRequestOriginNonce")
				value = { kanbanWebUiPageLoadIssuedRequestOriginNonce: "isolated-page-nonce" };
			else if (procedure === "runtime.getClineKanbanAccess") value = { enabled: true };
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
					options: [
						{ value: "source-codex-model", label: "来源模型", description: "来源模型" },
						{ value: "wrong-background-model", label: "错误背景模型", description: "错误背景模型" },
					],
				};
			else if (procedure === "workUnit.getRelationModelingPreview")
				value = {
					rootWorkUnitKey: "draft-root",
					workUnits: [],
					relations: [],
					depthsByWorkUnitKey: {},
					truncated: false,
				};
			else if (procedure === "workUnit.readRelationModelingEditorDraft") value = null;
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
			return { result: { data: value } };
		});
		await route.fulfill({ json: url.searchParams.get("batch") === "1" ? results : results[0] });
	});
	await page.goto(`/${sourceProjectId}`);
	try {
		await expect(page.locator('[data-task-id="editor-navigation-task"]').first()).toBeVisible();
	} catch (failure) {
		throw new Error(
			JSON.stringify({ errors, requests, body: await page.locator("body").innerText() }) + String(failure),
		);
	}
	return {
		errors,
		requests,
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
			await dialog.getByRole("textbox", { name: "Task name", exact: true }).fill("切换后保留的名称");
			await dialog.locator("textarea").first().fill("切换后台项目时不能丢失的正文");
			await dialog.getByRole("textbox", { name: "Task name", exact: true }).focus();
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
			await expect(dialog.getByRole("textbox", { name: "Task name", exact: true })).toHaveValue("切换后保留的名称");
			await expect(dialog.locator('[data-testid="task-creation-target-project-field"]')).toContainText(
				"编辑来源项目",
			);
			await expect(
				dialog.getByRole("button", { name: "OpenAI Codex (default agent)", exact: true }),
			).toHaveAttribute("aria-pressed", "true");
			if (kind === "create")
				await expect(dialog.getByRole("button", { name: "source-codex-model", exact: true })).toHaveAttribute(
					"aria-pressed",
					"true",
				);
			expect(fixture.errors).toEqual([]);
		});
	}
}
