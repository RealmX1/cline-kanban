import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Browser } from "../../web-ui/node_modules/playwright-core";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

import { createTaskEditorPackagedRuntimeBrowserTestFixture } from "./task-editor-packaged-runtime-browser-test-fixture";

const packagedCliPath = process.env.KANBAN_TASK_EDITOR_CREATION_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!packagedCliPath)(
	"打包浏览器：普通附件拦截提交、保留最新正文并在运行时重启后可读",
	async () => {
		if (!packagedCliPath) throw new Error("缺少任务隔离构建的 CLI");
		const browserFixture = await createTaskEditorPackagedRuntimeBrowserTestFixture(packagedCliPath, children);
		const { fixture, evidenceDirectory, client, origin } = browserFixture;
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "file-attachment-project",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "initial.txt"), "普通文件附件浏览器验收\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "建立隔离附件项目",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const startRuntime = () => browserFixture.startRuntime(repository.repositoryPath);
		let runtime = await startRuntime();
		let browser: Browser | undefined;
		let releaseUpload = () => {};
		const uploadReleased = new Promise<void>((done) => {
			releaseUpload = done;
		});
		try {
			const added = await client().projects.add.mutate({ path: repository.repositoryPath });
			const workspaceId = added.project?.id;
			if (!workspaceId) throw new Error("隔离项目注册失败");
			const workspaceClient = client(workspaceId);
			await workspaceClient.runtime.saveConfig.mutate({ selectedAgentId: "codex" });
			browser = await browserFixture.launchBrowser();
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			page.setDefaultTimeout(15_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const configurationLoaded = page.waitForResponse(
				(response) =>
					response.url().includes("runtime.getConfig") &&
					response.request().headers()["x-kanban-workspace-id"] === workspaceId &&
					response.ok(),
			);
			await page.goto(`${origin}/${workspaceId}`);
			await (await configurationLoaded).finished();
			await page.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))");
			await page.getByRole("button", { name: "Create task", exact: true }).first().click();
			const editor = page.locator('[data-verification-anchor="task-editor-floating-window"]');
			const prompt = editor.getByRole("textbox", { name: "任务正文", exact: true });
			await prompt.fill("上传前正文");
			await editor.getByRole("textbox", { name: "任务名称（可选）", exact: true }).fill("[TEST]普通文件附件");
			let uploadRequested = false;
			await page.route("**/api/trpc/**", async (route) => {
				if (route.request().url().includes("support.saveAgentPromptFileAttachment")) {
					uploadRequested = true;
					await uploadReleased;
				}
				await route.continue();
			});
			const fileBytes = Buffer.from([0, 255, 13, 10, 128]);
			await editor
				.locator('input[type="file"]')
				.setInputFiles({ name: "参考 文件.bin", mimeType: "application/octet-stream", buffer: fileBytes });
			await expect.poll(() => uploadRequested).toBe(true);
			expect(await editor.getByRole("button", { name: "创建任务", exact: true }).isDisabled()).toBe(true);
			await prompt.fill("上传期间的最新正文");
			await prompt.press("Control+Enter");
			expect(
				(await workspaceClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards),
			).toHaveLength(0);
			releaseUpload();
			await expect.poll(() => prompt.inputValue()).toContain("persistent-agent-prompt-file-attachments");
			const promptWithAttachment = await prompt.inputValue();
			expect(promptWithAttachment.startsWith("上传期间的最新正文\n\n")).toBe(true);
			const attachmentFilePath: string = JSON.parse(promptWithAttachment.split("持久路径：")[1] ?? "null");
			expect(attachmentFilePath.startsWith(fixture.isolatedHomeDirectoryPath)).toBe(true);
			expect(readFileSync(attachmentFilePath).equals(fileBytes)).toBe(true);
			const rejectedNonceStatus = await page.evaluate(
				async () =>
					(
						await fetch("/api/trpc/support.saveAgentPromptFileAttachment", {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"x-kanban-web-ui-page-load-request-origin-nonce": "unknown-file-attachment-page",
							},
							body: JSON.stringify({ fileName: "nonce-rejected.bin", fileContentBase64: "" }),
						})
					).status,
			);
			expect(rejectedNonceStatus).toBe(412);
			await page.screenshot({ path: join(evidenceDirectory, "file-attachment-before-task-creation.png") });
			await editor.getByRole("button", { name: "创建任务", exact: true }).click();
			await expect
				.poll(
					async () =>
						(await workspaceClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards)
							.length,
				)
				.toBe(1);
			const card = (await workspaceClient.workspace.getState.query()).board.columns.flatMap(
				(column) => column.cards,
			)[0];
			expect(card?.prompt).toBe(promptWithAttachment);
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 30_000)).toBe(true);
			runtime = await startRuntime();
			const restored = (await workspaceClient.workspace.getState.query()).board.columns.flatMap(
				(column) => column.cards,
			)[0];
			expect(restored?.prompt).toBe(promptWithAttachment);
			expect(readFileSync(attachmentFilePath).equals(fileBytes)).toBe(true);
			await page.reload();
			await page.getByText("[TEST]普通文件附件", { exact: true }).first().waitFor({ state: "visible" });
			await page.screenshot({ path: join(evidenceDirectory, "file-attachment-task-after-runtime-restart.png") });
			expect(pageErrors).toEqual([]);
			writeFileSync(
				join(evidenceDirectory, "browser-verification.json"),
				JSON.stringify(
					{
						workspaceId,
						taskId: card?.id,
						promptWithAttachment,
						fileBytesHex: fileBytes.toString("hex"),
						rejectedNonceStatus,
						runtimeRestartVerified: true,
						pageErrors,
					},
					null,
					2,
				),
			);
		} catch (error) {
			const page = browser?.contexts()[0]?.pages()[0];
			if (page) {
				writeFileSync(join(evidenceDirectory, "failed-page.txt"), await page.locator("body").innerText());
				await page.screenshot({ path: join(evidenceDirectory, "failed-page.png") });
			}
			throw error;
		} finally {
			releaseUpload();
			await browser?.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 30_000);
			browserFixture.writeRuntimeOutput();
		}
	},
	120_000,
);
