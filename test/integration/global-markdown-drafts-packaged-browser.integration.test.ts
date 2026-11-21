import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import { KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME } from "../../src/core/kanban-web-ui-page-load-request-origin-nonce";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Locator, Page } from "../../web-ui/node_modules/playwright-core";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";
import { createTaskEditorPackagedRuntimeBrowserTestFixture } from "./task-editor-packaged-runtime-browser-test-fixture";

const packagedCliPath = process.env.KANBAN_GLOBAL_MARKDOWN_DRAFT_BROWSER_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

const draftWindow = (page: Page) => page.getByRole("dialog", { name: "草稿", exact: true });
const draftEditor = (page: Page) => page.getByRole("textbox", { name: "草稿正文", exact: true });
const draftEntry = (page: Page) => page.getByRole("button", { name: "草稿", exact: true });
const draftSelector = (page: Page) => page.getByRole("combobox", { name: "选择草稿", exact: true });
const draftSaveStatus = (page: Page) => draftWindow(page).getByRole("status");

async function drag(page: Page, handle: Locator, offsetX: number, offsetY: number) {
	const bounds = await visibleBounds(handle);
	const x = bounds.x + bounds.width / 2;
	const y = bounds.y + bounds.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + offsetX, y + offsetY, { steps: 5 });
	await page.mouse.up();
}

async function visibleBounds(locator: Locator) {
	const bounds = await locator.boundingBox();
	if (!bounds) throw new Error("浮窗或控件不可见");
	return bounds;
}

it.skipIf(!packagedCliPath)(
	"真实运行时和 Playwright：编辑往返、布局和阅读位置、跨项目与浏览器、断线和并发恢复",
	async () => {
		if (!packagedCliPath) throw new Error("缺少任务隔离构建的 CLI");
		const browserFixture = await createTaskEditorPackagedRuntimeBrowserTestFixture(packagedCliPath, children);
		const { fixture, client, origin, evidenceDirectory } = browserFixture;
		const alpha = fixture.createNonBareRepository({ repositoryDirectoryName: "draft-project-alpha" });
		const beta = fixture.createNonBareRepository({ repositoryDirectoryName: "draft-project-beta" });
		for (const project of [alpha, beta]) {
			writeFileSync(join(project.repositoryPath, "README.md"), "隔离草稿项目\n");
			project.commitAllRepositoryFilesAtDate({
				message: "初始化隔离草稿项目",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
		}
		let runtime = await browserFixture.startRuntime(alpha.repositoryPath);
		const browser = await browserFixture.launchBrowser();
		try {
			const api = client();
			const { kanbanWebUiPageLoadIssuedRequestOriginNonce } =
				await api.runtime.issueKanbanWebUiPageLoadRequestOriginNonce.mutate();
			const browserProjectRegistration = createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${origin}/api/trpc`,
						headers: {
							[KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME]:
								kanbanWebUiPageLoadIssuedRequestOriginNonce,
						},
					}),
				],
			});
			const alphaId = (await browserProjectRegistration.projects.add.mutate({ path: alpha.repositoryPath })).project
				?.id;
			const betaId = (await browserProjectRegistration.projects.add.mutate({ path: beta.repositoryPath })).project
				?.id;
			if (!alphaId || !betaId) throw new Error("隔离项目未登记");
			const list = () => api.globalMarkdownDraft.list.query();
			const longDraftId = randomUUID();
			const longMarkdown = [
				"# 排版与滚动",
				"**粗体**、*斜体*、`行内代码`、[链接](https://example.com)",
				"- 无序列表\n- 第二项",
				"1. 有序列表\n2. 第二项",
				"> 引用",
				"~~~~ts\nconst answer = 42;\n```\n~~~\n结束\n~~~~",
				"```~shell\necho test\n```",
				"## 代码块之后",
				"[安全链接](<https://example.org/test)>)",
				"\\# 字面标题符号",
				"1\\. 字面数字序号",
				...Array.from({ length: 100 }, (_, index) => `阅读位置第 ${index + 1} 行`),
			].join("\n\n");
			await api.globalMarkdownDraft.create.mutate({ id: longDraftId, title: "长草稿", markdown: longMarkdown });

			const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
			const mobile = await browser.newPage({
				viewport: { width: 370, height: 740 },
				hasTouch: true,
				isMobile: true,
			});
			const pageErrors: string[] = [];
			for (const page of [desktop, mobile]) {
				page.setDefaultTimeout(10_000);
				page.on("pageerror", (error) => pageErrors.push(error.message));
				await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			}
			await desktop.goto(`${origin}/${alphaId}`);
			await draftEntry(desktop).click();
			const desktopWindow = draftWindow(desktop);
			const initialBounds = await visibleBounds(desktopWindow);
			await drag(desktop, desktopWindow.getByText("草稿", { exact: true }), 100, 100);
			await drag(desktop, desktopWindow.getByRole("button", { name: "调整草稿浮窗大小" }), 120, 90);
			const desktopBounds = await visibleBounds(desktopWindow);
			expect(desktopBounds.x).toBe(initialBounds.x + 100);
			expect(desktopBounds.y).toBe(initialBounds.y + 100);
			expect(desktopBounds.width).toBe(initialBounds.width + 120);
			expect(desktopBounds.height).toBe(initialBounds.height + 90);
			const editor = draftEditor(desktop);
			await editor.getByRole("heading", { name: "排版与滚动" }).waitFor();
			for (const selector of ["strong", "em", "p code", "a[href]", "ul", "ol", "blockquote", "pre code"]) {
				expect(await editor.locator(selector).count(), selector).toBeGreaterThan(0);
			}
			const codeWithFences = "const answer = 42;\n```\n~~~\n结束";
			expect(await editor.locator("pre code").first().textContent()).toBe(codeWithFences);
			const headingToEdit = editor.getByRole("heading", { name: "排版与滚动" });
			await headingToEdit.click();
			await headingToEdit.evaluate((heading) => {
				const selection = heading.ownerDocument.getSelection();
				selection?.selectAllChildren(heading);
				selection?.collapseToEnd();
			});
			await desktop.keyboard.insertText("（已编辑）");
			await editor.getByRole("heading", { name: "排版与滚动（已编辑）" }).waitFor();
			await expect
				.poll(async () => (await list()).find((draft) => draft.id === longDraftId)?.markdown)
				.toMatch(/^# 排版与滚动（已编辑）/);
			expect((await list()).find((draft) => draft.id === longDraftId)?.markdown).toContain(
				`~~~~ ts\n${codeWithFences}\n~~~~`,
			);
			const scroll = desktop.locator('[data-verification-anchor="global-markdown-draft-editor-scroll"]');
			await scroll.evaluate((element) => {
				element.scrollTop = 0;
			});
			await scroll.hover();
			await desktop.mouse.wheel(0, 650);
			await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(650);
			await desktopWindow.getByRole("button", { name: "收起草稿浮窗" }).click();
			await desktop.getByTestId("top-bar-project-switcher-trigger").click();
			await desktop.getByText("draft-project-beta", { exact: true }).last().click();
			await desktop.waitForURL(`**/${betaId}`);
			await draftEntry(desktop).click();
			await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(650);
			await desktopWindow.getByRole("button", { name: "关闭草稿浮窗" }).click();
			await draftEntry(desktop).click();
			await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(650);
			expect(await editor.locator("pre code").first().textContent()).toBe(codeWithFences);
			expect(await editor.locator("pre code").last().getAttribute("class")).toBe("language-~shell");
			expect(await editor.getByRole("heading", { name: "代码块之后" }).count()).toBe(1);
			expect(await editor.getByRole("link", { name: "安全链接" }).getAttribute("href")).toBe(
				"https://example.org/test)",
			);
			expect(await editor.locator("p").filter({ hasText: "# 字面标题符号" }).count()).toBe(1);
			expect(await editor.locator("p").filter({ hasText: "1. 字面数字序号" }).count()).toBe(1);
			expect(await desktopWindow.boundingBox()).toEqual(desktopBounds);

			await desktopWindow.getByRole("button", { name: "新建草稿" }).click();
			await desktopWindow.getByRole("button", { name: "重命名草稿" }).click();
			await desktop.getByRole("textbox", { name: "草稿标题" }).fill("中文编辑");
			await desktopWindow.getByRole("button", { name: "保存标题" }).click();
			await editor.pressSequentially("# ");
			const composition = await desktop.context().newCDPSession(desktop);
			await composition.send("Input.imeSetComposition", { text: "zhongwen", selectionStart: 8, selectionEnd: 8 });
			await editor.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
			await composition.send("Input.insertText", { text: "中文标题" });
			await editor.getByRole("heading", { name: "中文标题" }).waitFor();
			await editor.press("Enter");
			await editor.pressSequentially("**bold** *italic* `inline` [link](https://example.com)");
			await editor.locator("strong").waitFor();
			await editor.locator("em").waitFor();
			await editor.locator("code").waitFor();
			await editor.getByRole("link", { name: "link" }).waitFor();
			await desktopWindow.getByRole("button", { name: "撤销", exact: true }).click();
			await desktopWindow.getByRole("button", { name: "重做", exact: true }).click();
			await expect.poll(() => draftSaveStatus(desktop).textContent()).toBe("已保存");
			const chineseDraftId = await draftSelector(desktop).inputValue();
			expect((await list()).find((draft) => draft.id === chineseDraftId)?.markdown).toContain("# 中文标题");
			await draftSelector(desktop).selectOption(longDraftId);
			await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(650);
			await draftSelector(desktop).selectOption(chineseDraftId);

			await mobile.goto(`${origin}/${alphaId}`);
			await draftEntry(mobile).click();
			await draftSelector(mobile).selectOption(chineseDraftId);
			await draftEditor(mobile).getByRole("heading", { name: "中文标题" }).waitFor();
			const mobileWindow = draftWindow(mobile);
			expect((await visibleBounds(mobileWindow)).width).toBeLessThan(370);
			await mobile.evaluate(`(() => {
				if (!window.visualViewport) throw new Error("浏览器缺少 visualViewport");
				Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 330 });
				Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, value: 120 });
				window.visualViewport.dispatchEvent(new Event("resize"));
			})()`);
			await expect
				.poll(async () => {
					const bounds = await visibleBounds(mobileWindow);
					return bounds.y >= 120 && bounds.y + bounds.height <= 450;
				})
				.toBe(true);
			await mobile.screenshot({ path: join(evidenceDirectory, "mobile-drafts-visual-viewport.png") });

			// 模拟运行时已写入、浏览器收不到确认。刷新后续接同一提交，再保全后续本地修改。
			let committedButUnacknowledged = false;
			await desktop.context().route("**/api/trpc/**", async (route) => {
				if (!route.request().url().includes("globalMarkdownDraft.update")) return route.continue();
				if (!committedButUnacknowledged) {
					const response = await route.fetch();
					committedButUnacknowledged = response.ok();
				}
				return route.abort();
			});
			await editor.fill("已送达但丢失回执");
			await expect.poll(() => committedButUnacknowledged).toBe(true);
			await editor.fill("最新离线修改");
			await desktopWindow.getByRole("button", { name: "关闭草稿浮窗" }).click();
			await desktop.reload();
			await draftEntry(desktop).click();
			await expect.poll(() => editor.textContent()).toBe("最新离线修改");
			await expect.poll(() => draftSaveStatus(desktop).textContent()).toContain("已保留本地副本");
			await desktop.context().unroute("**/api/trpc/**");
			await desktop.evaluate("window.dispatchEvent(new Event('online'))");
			await expect
				.poll(async () => (await list()).find((draft) => draft.id === chineseDraftId)?.markdown)
				.toBe("# 最新离线修改");
			expect(await list()).toHaveLength(2);

			// 手机仍持有旧版本，编辑后应产生且只产生一份恢复草稿。
			await draftEditor(mobile).fill("手机冲突正文");
			await expect.poll(() => draftSaveStatus(mobile).textContent()).toContain("恢复草稿");
			expect(await list()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: chineseDraftId, markdown: "# 最新离线修改" }),
					expect.objectContaining({ title: "恢复草稿 · 中文编辑", markdown: "# 手机冲突正文" }),
				]),
			);
			expect(await list()).toHaveLength(3);

			// 另一设备的刷新版本不会进入旧页面的本地撤销历史。
			await desktopWindow.getByRole("button", { name: "关闭草稿浮窗" }).click();
			const originalBeforeRemoteEdit = (await list()).find((draft) => draft.id === chineseDraftId);
			if (!originalBeforeRemoteEdit) throw new Error("原草稿缺失");
			await api.globalMarkdownDraft.update.mutate({
				id: chineseDraftId,
				title: originalBeforeRemoteEdit.title,
				markdown: "# 另一设备的新正文",
				expectedVersion: originalBeforeRemoteEdit.version,
				saveRequestId: randomUUID(),
				saveWriterId: randomUUID(),
				saveSequence: 1,
			});
			await draftEntry(desktop).click();
			await editor.getByRole("heading", { name: "另一设备的新正文" }).waitFor();
			expect(await desktopWindow.getByRole("button", { name: "撤销" }).isDisabled()).toBe(true);
			await editor.press("ControlOrMeta+z");
			expect(await editor.textContent()).toBe("另一设备的新正文");

			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 30_000)).toBe(true);
			runtime = await browserFixture.startRuntime(alpha.repositoryPath);
			expect(await list()).toHaveLength(3);
			await desktop.reload();
			await draftEntry(desktop).click();
			await expect.poll(() => editor.textContent()).toBe("另一设备的新正文");
			expect(await desktopWindow.boundingBox()).toEqual(desktopBounds);
			await draftSelector(desktop).selectOption(longDraftId);
			await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(650);
			await draftSelector(desktop).selectOption(chineseDraftId);
			await desktopWindow.getByRole("button", { name: "删除草稿" }).click();
			const confirmation = desktop.getByRole("alertdialog", { name: "删除草稿" });
			await confirmation.getByRole("button", { name: "取消" }).click();
			expect(await list()).toHaveLength(3);
			await desktopWindow.getByRole("button", { name: "删除草稿" }).click();
			await confirmation.getByRole("button", { name: "删除草稿" }).click();
			await expect.poll(async () => (await list()).length).toBe(2);
			expect(pageErrors).toEqual([]);
		} finally {
			browserFixture.writeRuntimeOutput();
			await browser.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 30_000);
		}
	},
	120_000,
);
