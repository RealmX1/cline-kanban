import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { type Browser, chromium } from "../../web-ui/node_modules/playwright";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const checkout = resolve(process.cwd());
const browserExecutablePath = process.env.KANBAN_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
// 浏览器检查复用已安装的 Web UI Playwright；CI 未安装 Chromium 时仍运行同文件夹的 API/PTY 覆盖。
it.skipIf(!existsSync(browserExecutablePath) || !existsSync(join(checkout, "dist/cli.js")))(
	"发布包独立任务的浏览器建卡与刷新",
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const portServer = createServer();
		await new Promise<void>((r) => portServer.listen(0, "127.0.0.1", r));
		const portAddress = portServer.address();
		if (!portAddress || typeof portAddress === "string") throw new Error("no port");
		const port = portAddress.port;
		await new Promise<void>((r) => portServer.close(() => r()));
		const server = spawn(
			process.execPath,
			[
				"--require",
				join(checkout, "test/integration/shutdown-ipc-hook.cjs"),
				join(checkout, "dist/cli.js"),
				"--no-open",
			],
			{
				cwd: fixture.ownedIntegrationProjectsDirectoryPath,
				env: fixture.createIsolatedChildProcessEnvironment({ KANBAN_RUNTIME_PORT: String(port) }),
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		let serverLog = "";
		server.stdout?.on("data", (chunk) => {
			serverLog += chunk;
		});
		server.stderr?.on("data", (chunk) => {
			serverLog += chunk;
		});
		let browser: Browser | null = null;
		try {
			browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath });
			const baseUrl = `http://127.0.0.1:${port}`;
			for (let attempt = 0; attempt < 150; attempt++) {
				try {
					if ((await fetch(baseUrl)).status === 200) break;
				} catch {}
				await new Promise((r) => setTimeout(r, 100));
			}
			const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const pageErrors: string[] = [];
			page.on("pageerror", (e) => pageErrors.push(e.message));
			const response = await page.goto(`${baseUrl}/kanban_independent_tasks`);
			assert.equal(response?.status(), 200, serverLog);
			await page.locator('[data-column-id="backlog"]').first().waitFor({ state: "visible", timeout: 15000 });
			await page.locator('[data-column-id="backlog"]').first().getByRole("button", { name: "Create task" }).click();
			await page.getByText("此任务使用独立目录，完成后保留文件。").waitFor({ state: "visible" });
			const prompt = page.getByPlaceholder("Describe the task");
			await prompt.fill("独立任务浏览器研究验证");
			await page.screenshot({
				path: "/tmp/kanban-independent-task-create-dialog.png",
				fullPage: true,
				animations: "disabled",
			});
			await page.getByRole("button", { name: "Create", exact: true }).click();
			const boardPath = join(
				fixture.isolatedHomeDirectoryPath,
				".cline",
				"kanban",
				"workspaces",
				"kanban_independent_tasks",
				"board.json",
			);
			await expect
				.poll(
					() => {
						try {
							return readFileSync(boardPath, "utf8").includes("独立任务浏览器研究验证");
						} catch {
							return false;
						}
					},
					{ timeout: 10000 },
				)
				.toBe(true);
			const card = page.locator("[data-task-id]").filter({ hasText: "独立任务浏览器研究验证" }).first();
			await card.waitFor({ state: "visible" });
			const taskId = await card.getAttribute("data-task-id");
			assert.ok(taskId);
			const taskDirectory = join(
				fixture.isolatedHomeDirectoryPath,
				".cline",
				"kanban",
				"independent-task-workspaces",
				taskId,
			);
			assert.ok(existsSync(taskDirectory));
			writeFileSync(join(taskDirectory, "研究成果.md"), "保留浏览器创建任务的成果");
			await page.reload();
			await card.waitFor({ state: "visible" });
			await card.click();
			await page.getByText("此任务使用独立目录，完成后保留文件。").waitFor({ state: "visible" });
			assert.equal(await page.getByPlaceholder("Describe the task").inputValue(), "独立任务浏览器研究验证");
			assert.equal(await page.getByText("Create worktree from", { exact: true }).count(), 0);
			assert.equal(readFileSync(join(taskDirectory, "研究成果.md"), "utf8"), "保留浏览器创建任务的成果");
			await page.screenshot({
				path: "/tmp/kanban-independent-task-edit-dialog.png",
				fullPage: true,
				animations: "disabled",
			});
			await page.keyboard.press("Escape");
			let immediateStartDirectoryExists = false;
			await page.route("**/api/trpc/runtime.startTaskSession*", async (route) => {
				const requestPayload = route.request().postDataJSON();
				const request = requestPayload["0"]?.json ?? requestPayload["0"] ?? requestPayload;
				immediateStartDirectoryExists = existsSync(
					join(
						fixture.isolatedHomeDirectoryPath,
						".cline",
						"kanban",
						"independent-task-workspaces",
						request.taskId,
					),
				);
				await route.fulfill({
					contentType: "application/json",
					body: JSON.stringify([
						{ result: { data: { ok: false, summary: null, error: "浏览器验证已拦截外部 Agent 启动" } } },
					]),
				});
			});
			await page.locator('[data-column-id="backlog"]').first().getByRole("button", { name: "Create task" }).click();
			await page.getByPlaceholder("Describe the task").fill("立即开始的独立任务");
			await page.getByRole("button", { name: "Start task", exact: true }).click();
			await expect.poll(() => immediateStartDirectoryExists, { timeout: 10000 }).toBe(true);
			assert.deepEqual(pageErrors, []);
		} finally {
			await browser?.close();
			server.send({ type: "kanban.shutdown" });
			const exited = once(server, "exit");
			const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(timer);
			fixture.cleanup();
		}
	},
	45000,
);
