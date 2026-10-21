import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Browser, BrowserType, Page } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const processes = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => processes.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(process.env.KANBAN_RUN_PROJECT_VISUAL_IDENTITY_PACKAGED_BROWSER_CHECK !== "1")(
	"项目标识打包态：双浏览器同步、上传替换、重启持久性、窄屏与主题",
	async () => {
		const source = resolve(import.meta.dirname, "../..");
		const evidence = process.env.KANBAN_PROJECT_VISUAL_IDENTITY_BROWSER_EVIDENCE_DIRECTORY;
		const packagedBuild = process.env.KANBAN_PROJECT_VISUAL_IDENTITY_PACKAGED_BUILD_DIRECTORY;
		if (!evidence || !packagedBuild) throw new Error("缺少持久证据或独立打包目录");
		const evidenceDirectory = evidence;
		mkdirSync(evidenceDirectory, { recursive: true });
		if (!existsSync(join(packagedBuild, "node_modules")))
			symlinkSync(join(source, "node_modules"), join(packagedBuild, "node_modules"), "dir");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const alpha = fixture.createNonBareRepository({ repositoryDirectoryName: "cline-kanban" });
		const beta = fixture.createNonBareRepository({
			repositoryDirectoryName: "project-with-a-very-long-name-for-mobile-layout-verification",
		});
		for (const project of [alpha, beta]) {
			writeFileSync(join(project.repositoryPath, "initial.txt"), "初始化\n");
			project.commitAllRepositoryFilesAtDate({
				message: "初始化隔离项目",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
		}
		const server = createServer();
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string" || address.port === 3484) throw new Error("隔离端口分配失败");
		const port = address.port;
		await new Promise<void>((done) => server.close(() => done()));
		const origin = `http://127.0.0.1:${port}`;
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/.test(key))
				delete environment[key];
		const node = process.env.KANBAN_PROJECT_VISUAL_IDENTITY_RUNTIME_NODE ?? process.execPath;
		const agentExecutables = join(fixture.fixtureRootDirectoryPath, "isolated-agent-detection-stubs");
		mkdirSync(agentExecutables);
		writeFileSync(
			join(agentExecutables, "claude"),
			'#!/usr/bin/env node\nprocess.stdout.write("2.1.288 (Claude Code)\\n");\n',
			{ mode: 0o755 },
		);
		Object.assign(environment, {
			PATH: `${agentExecutables}:${dirname(node)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
			NODE_ENV: "production",
		});
		const cli = join(packagedBuild, "cli.js");
		let startupNumber = 0;
		function startRuntime() {
			const child = processes.register(
				spawn(
					node,
					[
						"--require",
						join(source, "test/integration/shutdown-ipc-hook.cjs"),
						cli,
						"--port",
						String(port),
						"--no-open",
						"--no-passcode",
					],
					{ cwd: alpha.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			const logPath = join(evidenceDirectory, `runtime-${++startupNumber}.log`);
			child.stdout?.on("data", (bytes) =>
				writeFileSync(logPath, (existsSync(logPath) ? readFileSync(logPath, "utf8") : "") + String(bytes)),
			);
			child.stderr?.on("data", (bytes) =>
				writeFileSync(logPath, (existsSync(logPath) ? readFileSync(logPath, "utf8") : "") + String(bytes)),
			);
			return child;
		}
		const client = createTRPCProxyClient<RuntimeAppRouter>({ links: [httpLink({ url: `${origin}/api/trpc` })] });
		async function waitForRuntime() {
			await expect
				.poll(
					() =>
						fetch(`${origin}/api/trpc/projects.list`)
							.then((response) => response.ok)
							.catch(() => false),
					{ timeout: 60000, interval: 200 },
				)
				.toBe(true);
		}
		const requireFromWeb = createRequire(join(source, "web-ui/package.json"));
		const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
		let browser: Browser | null = null;
		let pageForFailureEvidence: Page | null = null;
		let runtime = startRuntime();
		const checks: string[] = [];
		try {
			await waitForRuntime();
			await client.projects.add.mutate({ path: beta.repositoryPath });
			const { projects } = await client.projects.list.query();
			const alphaId = projects.find((project) => project.path === alpha.repositoryPath)?.id;
			const betaId = projects.find((project) => project.path === beta.repositoryPath)?.id;
			if (!alphaId || !betaId) throw new Error("隔离项目未注册");
			expect(projects.find((project) => project.id === alphaId)?.visualIdentity?.presetIconId).toBe("KanbanSquare");
			browser = await chromium.launch({ headless: true });
			const firstContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
			const secondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
			await firstContext.addInitScript("localStorage.setItem('kanban.onboarding.dialog.shown', 'true')");
			await secondContext.addInitScript("localStorage.setItem('kanban.onboarding.dialog.shown', 'true')");
			const first = await firstContext.newPage();
			pageForFailureEvidence = first;
			const second = await secondContext.newPage();
			const pageErrors: string[] = [];
			first.on("pageerror", (error) => pageErrors.push(error.message));
			second.on("pageerror", (error) => pageErrors.push(error.message));
			await Promise.all([first.goto(origin), second.goto(origin)]);

			const taskDialog = first
				.getByRole("dialog")
				.filter({ has: first.locator('[data-testid="task-creation-target-project-field"]') });
			await expect
				.poll(
					async () => {
						if (await taskDialog.count()) return true;
						await first.getByRole("button", { name: "Create task", exact: true }).click();
						return false;
					},
					{ timeout: 15000 },
				)
				.toBe(true);
			const projectField = taskDialog.locator('[data-testid="task-creation-target-project-field"]');
			expect(await projectField.getByRole("button").count()).toBe(0);
			await taskDialog.locator("input").first().fill("单项目归属检查");
			await taskDialog.getByPlaceholder("Describe the task...").fill("单条创建归属检查");
			await taskDialog.getByRole("button", { name: "Create", exact: true }).click();
			const scopedAlpha = createTRPCProxyClient<RuntimeAppRouter>({
				links: [httpLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": alphaId } })],
			});
			await expect
				.poll(
					async () =>
						(await scopedAlpha.workspace.getState.query()).board.columns
							.flatMap((column) => column.cards)
							.some((card) => card.prompt === "单条创建归属检查"),
					{ timeout: 15000 },
				)
				.toBe(true);
			checks.push("单项目建卡只读显示归属，提交落入正确项目");
			await first.getByText("单项目归属检查", { exact: true }).first().hover();
			await first.getByRole("button", { name: "Edit task title", exact: true }).first().click();
			const editDialog = first.getByRole("dialog").filter({ hasText: "Edit backlog task" });
			await editDialog.locator('[data-testid="task-creation-target-project-field"]').waitFor();
			expect(
				await editDialog.locator('[data-testid="task-creation-target-project-field"]').getByRole("button").count(),
			).toBe(0);
			await editDialog.getByRole("button", { name: "Close", exact: true }).click();
			if (await first.getByRole("button", { name: "Discard", exact: true }).isVisible())
				await first.getByRole("button", { name: "Discard", exact: true }).click();
			await editDialog.waitFor({ state: "hidden" });
			checks.push("编辑已有任务显示只读项目归属");
			await first.getByRole("button", { name: "Project actions", exact: true }).first().click();
			await first.getByRole("menuitem", { name: "编辑项目图标与颜色" }).click();
			const editor = first.getByRole("dialog", { name: "编辑项目图标与颜色" });
			await editor.locator("#project-preset-icon-search").fill("rocket");
			expect(await editor.getByRole("group", { name: "预设图标", exact: true }).getByRole("button").count()).toBe(1);
			await editor.locator("#project-preset-icon-search").fill("火箭");
			expect(await editor.getByRole("group", { name: "预设图标", exact: true }).getByRole("button").count()).toBe(1);
			await editor.locator("#project-preset-icon-search").fill("");
			await editor
				.getByLabel("预设图标", { exact: true })
				.getByRole("button", { name: "火箭 Rocket", exact: true })
				.click();
			await editor.getByRole("button", { name: "紫", exact: true }).click();
			await editor.getByRole("button", { name: "保存", exact: true }).click();
			await expect
				.poll(() => second.locator('[data-project-icon="Rocket"]').count(), { timeout: 15000 })
				.toBeGreaterThan(0);
			checks.push("真实打包 UI 保存预设与颜色，并经 projects_updated 更新另一个独立浏览器");
			await first.getByTestId("top-bar-project-switcher-trigger").click();
			expect(
				await first
					.locator(
						`[data-testid="project-switcher-table-row"][data-project-id="${alphaId}"] [data-project-icon="Rocket"]`,
					)
					.count(),
			).toBe(1);
			await first.keyboard.press("Escape");
			await first.keyboard.press("Meta+k");
			const searchDialog = first.getByRole("dialog", { name: "Search tasks", exact: true });
			await searchDialog.getByLabel("Search tasks", { exact: true }).fill("单项目归属检查");
			await expect
				.poll(() => searchDialog.locator('[data-project-icon="Rocket"]').count(), { timeout: 15000 })
				.toBeGreaterThan(0);
			await first.keyboard.press("Escape");
			const separatorBox = await first
				.getByRole("separator", { name: "Resize sidebar", exact: true })
				.first()
				.boundingBox();
			if (!separatorBox) throw new Error("缺少导航宽度调整入口");
			await first.mouse.move(separatorBox.x + 2, separatorBox.y + 100);
			await first.mouse.down();
			await first.mouse.move(20, separatorBox.y + 100);
			await first.mouse.up();
			expect(await first.locator('aside button[title="cline-kanban"] [data-project-icon="Rocket"]').count()).toBe(1);
			const collapsedSeparator = await first
				.getByRole("separator", { name: "Resize sidebar", exact: true })
				.first()
				.boundingBox();
			if (!collapsedSeparator) throw new Error("缺少折叠导航宽度调整入口");
			await first.mouse.move(collapsedSeparator.x + 2, collapsedSeparator.y + 100);
			await first.mouse.down();
			await first.mouse.move(280, collapsedSeparator.y + 100);
			await first.mouse.up();
			checks.push("图标搜索支持中英文，顶栏表格、展开/折叠导航和搜索结果使用同一标识");
			await first.getByRole("button", { name: "Project actions", exact: true }).first().click();
			await first.getByRole("menuitem", { name: "编辑项目图标与颜色" }).click();
			await editor.getByRole("button", { name: "红", exact: true }).click();
			await editor.getByRole("button", { name: "取消", exact: true }).click();
			expect(
				(await client.projects.list.query()).projects.find((project) => project.id === alphaId)?.visualIdentity
					?.colorId,
			).toBe("purple");
			checks.push("取消保留原配置");
			await first.getByRole("button", { name: "Project actions", exact: true }).first().click();
			await first.getByRole("menuitem", { name: "编辑项目图标与颜色" }).click();
			await editor.getByLabel("预设图标", { exact: true }).locator("button").first().focus();
			await first.keyboard.press("Tab");
			expect(await editor.locator("button:focus").count()).toBe(1);
			await editor
				.getByLabel("预设图标", { exact: true })
				.getByRole("button", { name: "火箭 Rocket", exact: true })
				.click();
			const upload = await sharp({ create: { width: 80, height: 40, channels: 4, background: "#ff0000" } })
				.png()
				.toBuffer();
			await editor
				.locator('input[type="file"]')
				.setInputFiles({ name: "project.png", mimeType: "image/png", buffer: upload });
			await expect.poll(() => editor.getByRole("button", { name: "替换图片", exact: true }).count()).toBe(1);
			await editor.getByRole("button", { name: "保存", exact: true }).click();
			await expect
				.poll(() => second.locator('img[src^="data:image/png"]').count(), { timeout: 15000 })
				.toBeGreaterThan(0);
			const uploadedIdentity = (await client.projects.list.query()).projects.find(
				(project) => project.id === alphaId,
			)?.visualIdentity;
			expect(uploadedIdentity?.imageAssetId).toMatch(/^[a-f0-9]{64}$/);
			if (!uploadedIdentity?.imageAssetId) throw new Error("图片未保存");
			const read = await client.projects.readProjectIconImage.query({
				workspaceId: alphaId,
				imageAssetId: uploadedIdentity.imageAssetId,
			});
			expect(await sharp(Buffer.from(read.base64Content, "base64")).metadata()).toMatchObject({
				width: 128,
				height: 128,
				format: "png",
			});
			checks.push("图片上传、透明补边、按资产请求和双浏览器展示");
			const replacementImage = await sharp({ create: { width: 32, height: 64, channels: 3, background: "blue" } })
				.webp()
				.toBuffer();
			const replacement = await client.projects.setProjectVisualIdentity.mutate({
				workspaceId: alphaId,
				iconSource: "uploaded_image",
				presetIconId: "Rocket",
				colorId: "purple",
				imageAssetId: null,
				imageUpload: { mediaType: "image/webp", base64Content: replacementImage.toString("base64") },
			});
			expect(replacement.imageAssetId).not.toBe(uploadedIdentity.imageAssetId);
			Object.assign(uploadedIdentity, replacement);
			checks.push("替换图片分配新内容 hash，重新载入获取新图片");
			await second.route("**/api/trpc/projects.readProjectIconImage*", (route) =>
				route.fulfill({
					status: 500,
					contentType: "application/json",
					body: '{"error":{"message":"模拟图片读取失败","code":-32603}}',
				}),
			);
			await second.reload();
			await expect
				.poll(
					() =>
						second
							.getByTestId("top-bar-project-switcher-trigger")
							.locator('[data-project-icon="KanbanSquare"]')
							.count(),
					{ timeout: 15000 },
				)
				.toBe(1);
			await second.unroute("**/api/trpc/projects.readProjectIconImage*");
			checks.push("图片读取失败显示默认图标，不改变保存配置");

			await first.reload();
			await expect
				.poll(() => first.locator('img[src^="data:image/png"]').count(), { timeout: 15000 })
				.toBeGreaterThan(0);
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 15000)).toBe(true);
			runtime = startRuntime();
			await waitForRuntime();
			expect(
				(await client.projects.list.query()).projects.find((project) => project.id === alphaId)?.visualIdentity,
			).toEqual(uploadedIdentity);
			await first.reload();
			await expect
				.poll(() => first.locator('img[src^="data:image/png"]').count(), { timeout: 15000 })
				.toBeGreaterThan(0);
			checks.push("刷新和真实 runtime 进程重启后，配置和图片保持");
			await client.projects.resetProjectVisualIdentityToDefault.mutate({ workspaceId: alphaId });
			await expect
				.poll(() => first.locator('[data-project-icon="KanbanSquare"]').count(), { timeout: 15000 })
				.toBeGreaterThan(0);
			await first.getByTestId("top-bar-project-switcher-trigger").click();
			await first.getByTestId("project-switcher-board-scope-all-projects-pseudo-row").click();
			await expect
				.poll(() => first.getByTestId("top-bar-project-switcher-trigger").textContent())
				.toContain("All projects");
			const allProjectsUrlBeforeKeyboardMenu = first.url();
			for (const key of ["Enter", "Space", "ArrowDown"]) {
				const projectActionsTrigger = first.locator("aside .kb-project-row").first().getByRole("button", {
					name: "Project actions",
					exact: true,
				});
				await projectActionsTrigger.focus();
				await projectActionsTrigger.press(key);
				const editVisualIdentityMenuItem = first.getByRole("menuitem", { name: "编辑项目图标与颜色" });
				await editVisualIdentityMenuItem.waitFor();
				expect(first.url(), key).toBe(allProjectsUrlBeforeKeyboardMenu);
				expect(await first.getByTestId("top-bar-project-switcher-trigger").textContent(), key).toContain(
					"All projects",
				);
				await editVisualIdentityMenuItem.focus();
				await editVisualIdentityMenuItem.press("Enter");
				await editor.waitFor();
				expect(first.url(), key).toBe(allProjectsUrlBeforeKeyboardMenu);
				expect(await first.getByTestId("top-bar-project-switcher-trigger").textContent(), key).toContain(
					"All projects",
				);
				await editor.getByRole("button", { name: "取消", exact: true }).click();
			}
			checks.push("全项目视图用 Enter、Space、ArrowDown 打开项目菜单并键盘进入编辑器，始终保留 All projects 范围");
			await first.getByRole("button", { name: "Create task", exact: true }).click();
			const selectableProjectControl = taskDialog
				.locator('[data-testid="task-creation-target-project-field"]')
				.getByRole("button");
			expect(
				await selectableProjectControl
					.locator("span")
					.evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize),
			).toBe("16px");
			expect(
				await selectableProjectControl.evaluate((element) =>
					Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).minHeight ?? "0"),
				),
			).toBeGreaterThanOrEqual(44);
			await selectableProjectControl.click();
			await first
				.getByRole("button", { name: /project-with-a-very-long-name-for-mobile-layout-verification/ })
				.last()
				.click();
			await taskDialog.getByPlaceholder("Describe the task...").fill("- 批量任务一\n- 批量任务二");
			await taskDialog.getByRole("button", { name: /Split into 2 tasks/ }).click();
			await taskDialog.getByRole("button", { name: /Create 2 tasks/ }).click();
			const scopedBeta = createTRPCProxyClient<RuntimeAppRouter>({
				links: [httpLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": betaId } })],
			});
			await expect
				.poll(
					async () =>
						(await scopedBeta.workspace.getState.query()).board.columns
							.flatMap((column) => column.cards)
							.filter((card) => card.prompt.startsWith("批量任务")).length,
					{ timeout: 15000 },
				)
				.toBe(2);
			checks.push("全项目批量建卡可选择目标，两个任务均保存到所选项目");
			await first.setViewportSize({ width: 375, height: 812 });
			await first.screenshot({ path: join(evidence, "mobile-375.png"), fullPage: true });
			expect(
				await first.evaluate(() => {
					const browserWindow = globalThis as unknown as {
						document: { documentElement: { scrollWidth: number } };
						innerWidth: number;
					};
					return browserWindow.document.documentElement.scrollWidth <= browserWindow.innerWidth;
				}),
			).toBe(true);
			const contrastResults = await first.evaluate(() => {
				const browserWindow = globalThis as unknown as {
					document: {
						documentElement: { dataset: Record<string, string> };
						createElement: (name: "canvas") => { getContext: (kind: "2d") => { fillStyle: string } | null };
					};
					getComputedStyle: (element: unknown) => { getPropertyValue: (name: string) => string };
				};
				const themes = [
					"default",
					"graphite",
					"midnight",
					"pitch",
					"solarized-dark",
					"light",
					"overcast",
					"solarized-light",
					"latte",
					"high-contrast-dark",
					"high-contrast-light",
				];
				const colors = [
					"slate",
					"blue",
					"cyan",
					"teal",
					"green",
					"lime",
					"amber",
					"orange",
					"red",
					"rose",
					"purple",
					"indigo",
				];
				function luminance(hex: string) {
					const colorContext = browserWindow.document.createElement("canvas").getContext("2d");
					if (!colorContext) throw new Error("无法解析主题颜色");
					colorContext.fillStyle = hex.trim();
					const digits = colorContext.fillStyle.slice(1);
					const normalizedDigits =
						digits.length === 3
							? digits
									.split("")
									.map((digit) => digit + digit)
									.join("")
							: digits;
					const channels =
						normalizedDigits.match(/.{2}/g)?.map((part) => {
							const value = Number.parseInt(part, 16) / 255;
							return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
						}) ?? [];
					return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
				}
				return themes.map((theme) => {
					browserWindow.document.documentElement.dataset.theme = theme;
					const style = browserWindow.getComputedStyle(browserWindow.document.documentElement);
					return {
						theme,
						minimumContrast: Math.min(
							...colors.flatMap((color) =>
								[0, 1, 2, 3, 4].map((surface) => {
									const a = luminance(style.getPropertyValue(`--color-project-identity-${color}`));
									const b = luminance(style.getPropertyValue(`--color-surface-${surface}`));
									return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
								}),
							),
						),
					};
				});
			});
			writeFileSync(join(evidence, "theme-contrast.json"), JSON.stringify(contrastResults, null, 2));
			for (const result of contrastResults) expect(result.minimumContrast, result.theme).toBeGreaterThanOrEqual(3);
			checks.push("375px 无水平溢出，全部 11 主题的 12 色在五层表面上对比度至少 3:1");
			const projectScopeUrlBeforeEditingIcon = first.url();
			await first.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
			await first.getByRole("button", { name: "Project actions", exact: true }).last().click();
			await first.getByRole("menuitem", { name: "编辑项目图标与颜色" }).click();
			await editor.getByRole("button", { name: "取消", exact: true }).click({ trial: true });
			expect(first.url()).toBe(projectScopeUrlBeforeEditingIcon);
			await expect.poll(() => first.locator("[data-sonner-toast]").count(), { timeout: 15000 }).toBe(0);
			await first.screenshot({ path: join(evidence, "mobile-editor-375.png"), fullPage: true });
			const mobileEditorBox = await editor.boundingBox();
			expect(mobileEditorBox && mobileEditorBox.x >= 0 && mobileEditorBox.x + mobileEditorBox.width <= 375).toBe(
				true,
			);
			await editor.getByRole("button", { name: "取消", exact: true }).click();
			await client.projects.setProjectVisualIdentity.mutate({
				workspaceId: betaId,
				iconSource: "uploaded_image",
				presetIconId: "FolderGit2",
				colorId: "blue",
				imageAssetId: null,
				imageUpload: { mediaType: "image/png", base64Content: upload.toString("base64") },
			});
			const deletionPreview = await client.projects.getPermanentDeletionPreview.query({ projectId: betaId });
			if (!deletionPreview.ok || deletionPreview.preview.workspaceStateRevision === null)
				throw new Error("永久删除预览失败");
			expect(
				existsSync(join(deletionPreview.preview.workspaceStateDirectoryPath, "uploaded-project-icon-images")),
			).toBe(true);
			const deleted = await client.projects.permanentlyDeleteProjectData.mutate({
				projectId: betaId,
				expectedWorkspaceStateRevision: deletionPreview.preview.workspaceStateRevision,
				confirmationProjectName: deletionPreview.preview.requiredConfirmationProjectName,
			});
			expect(deleted.status).toBe("completed");
			expect(existsSync(deletionPreview.preview.workspaceStateDirectoryPath)).toBe(false);
			await expect(
				client.projects.setProjectVisualIdentity.mutate({
					workspaceId: betaId,
					iconSource: "preset",
					presetIconId: "Ship",
					colorId: "blue",
					imageAssetId: null,
				}),
			).rejects.toThrow();
			checks.push("永久删除清理图标配置与资产，之后的保存请求拒绝重建状态目录");
			writeFileSync(join(evidence, "checks.json"), JSON.stringify({ checks, pageErrors }, null, 2));
			expect(pageErrors).toEqual([]);
		} catch (failure) {
			if (pageForFailureEvidence) {
				await pageForFailureEvidence.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
				writeFileSync(join(evidence, "failure-dom.txt"), await pageForFailureEvidence.locator("body").innerText());
			}
			throw failure;
		} finally {
			await browser?.close();
		}
	},
	180000,
);
