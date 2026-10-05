import { expect, test } from "@playwright/test";

// 原生剪贴板使用本机 Chrome 验证，与部署后验证保持同一浏览器入口。
test.use({ channel: "chrome" });

for (const hasTouch of [false, true]) {
	test(`卡片复制覆盖所有渲染角色，浏览器 hasTouch=${hasTouch}`, async ({ browser, baseURL }) => {
		const context = await browser.newContext({ baseURL, hasTouch });
		try {
			await context.addInitScript(() => {
				let isHandlingTrustedClick = false;
				document.addEventListener(
					"click",
					(event) => {
						isHandlingTrustedClick = event.isTrusted;
						setTimeout(() => {
							isHandlingTrustedClick = false;
						}, 0);
					},
					true,
				);
				Object.defineProperty(navigator, "clipboard", {
					value: {
						writeText: async (path: string) => {
							if (!isHandlingTrustedClick) throw new Error("User gesture expired");
							document.body.dataset.copiedTaskDirectoryPath = path;
						},
						write: async (items: ClipboardItem[]) => {
							if (!isHandlingTrustedClick) throw new Error("User gesture expired");
							const blob = await items[0].getType("text/plain");
							document.body.dataset.copiedTaskDirectoryPath = await blob.text();
						},
					},
				});
			});
			const page = await context.newPage();
			await page.route("**/task-workspace-directory?*", async (route) => {
				await new Promise((resolve) => setTimeout(resolve, 120));
				const taskId = new URL(route.request().url()).searchParams.get("taskId");
				await route.fulfill({ body: `/Users/test/.cline/worktrees/${taskId}/example-project` });
			});
			await page.route("**/task-directory-copy-browser-contract", (route) =>
				route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
			);
			await page.goto("/task-directory-copy-browser-contract");
			await page.addScriptTag({
				type: "module",
				content: `import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;`,
			});
			await page.addScriptTag({ type: "module", url: "/tests/task-directory-copy-browser-harness.tsx" });
			const cards = page.locator("[data-browser-test-card-role]");
			await expect(cards).toHaveCount(4);
			if (hasTouch) {
				expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
			}
			for (let index = 0; index < 4; index += 1) {
				const card = cards.nth(index);
				const copyButton = card.getByRole("button", { name: "Copy directory path" });
				await page.mouse.move(1, 1);
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				const copyActions = card.locator("[data-task-directory-copy-actions]");
				await expect(copyActions).toHaveCSS("opacity", "0");
				const copyButtonBoundsWhenHidden = await copyButton.boundingBox();
				expect(copyButtonBoundsWhenHidden).not.toBeNull();
				if (!copyButtonBoundsWhenHidden) throw new Error("复制按钮缺少几何信息");
				const hiddenCopyButtonCenter = {
					x: copyButtonBoundsWhenHidden.x + copyButtonBoundsWhenHidden.width / 2,
					y: copyButtonBoundsWhenHidden.y + copyButtonBoundsWhenHidden.height / 2,
				};
				expect(
					await page.evaluate(({ x, y }) => {
						return document.elementFromPoint(x, y)?.closest('[aria-label="Copy directory path"]') !== null;
					}, hiddenCopyButtonCenter),
				).toBe(false);
				// 触屏直接点击隐藏区域，不先移入指针；桌面以浏览器命中元素派发点击，保持无 hover 状态。
				if (hasTouch) {
					await page.touchscreen.tap(hiddenCopyButtonCenter.x, hiddenCopyButtonCenter.y);
				} else {
					await page.evaluate(({ x, y }) => {
						(document.elementFromPoint(x, y) as HTMLElement | null)?.click();
					}, hiddenCopyButtonCenter);
				}
				await expect(page.locator("body")).not.toHaveAttribute("data-copied-task-directory-path");
				await expect(page.locator("body")).not.toHaveAttribute("data-edited-task-id");
				await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-task-start");
				if (index === 1) {
					await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-card-activation");
				} else {
					await expect(page.locator("body")).toHaveAttribute("data-unexpected-card-activation", "true");
					await page
						.locator("body")
						.evaluate((element) => element.removeAttribute("data-unexpected-card-activation"));
				}
				await card.hover();
				const editButton = card.getByRole("button", { name: "Edit task title" });
				if (index !== 1) {
					if (index === 0) await editButton.hover();
					const copyBounds = await copyButton.boundingBox();
					const editBounds = await editButton.boundingBox();
					expect(copyBounds).not.toBeNull();
					expect(editBounds).not.toBeNull();
					if (!copyBounds || !editBounds) throw new Error("复制或编辑按钮缺少几何信息");
					expect(
						copyBounds.x >= editBounds.x + editBounds.width ||
							copyBounds.x + copyBounds.width <= editBounds.x ||
							copyBounds.y >= editBounds.y + editBounds.height ||
							copyBounds.y + copyBounds.height <= editBounds.y,
					).toBe(true);
					if (index === 0) {
						await editButton.click();
						await expect(page.locator("body")).toHaveAttribute(
							"data-edited-task-id",
							`complete-task-id-${index}`,
						);
						await page.locator("body").evaluate((element) => element.removeAttribute("data-edited-task-id"));
					}
				}
				const descriptionTimePill = card.locator("[data-backlog-task-description-last-updated-pill]");
				await descriptionTimePill.hover();
				expect(
					await descriptionTimePill.evaluate((element) => {
						const bounds = element.getBoundingClientRect();
						return element.contains(
							document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
						);
					}),
				).toBe(true);
				await expect(page.getByRole("tooltip")).toContainText("Description last updated ·");
				await page.mouse.move(1, 1);
				await expect(page.getByRole("tooltip")).toHaveCount(0);
				await card.hover();
				await expect(card.locator("[data-task-directory-copy-actions]")).toHaveCSS("opacity", "1");
				await expect(card.locator("[data-task-directory]")).toHaveCount(0);
				await copyButton.hover();
				await expect(page.getByRole("tooltip")).toHaveText(`complete-task-id-${index}`);
				await copyButton.click();
				await expect(page.locator("body")).toHaveAttribute(
					"data-copied-task-directory-path",
					`/Users/test/.cline/worktrees/complete-task-id-${index}/example-project`,
				);
				await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-card-activation", "true");
				await expect(page.locator("body")).not.toHaveAttribute("data-edited-task-id");
				await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-task-start");
				await page.mouse.move(1, 1);
				await copyButton.focus();
				await expect(card.locator("[data-task-directory-copy-actions]")).toHaveCSS("opacity", "1");
				await expect(page.getByRole("tooltip")).toHaveText(`complete-task-id-${index}`);
				await page
					.locator("body")
					.evaluate((element) => element.removeAttribute("data-copied-task-directory-path"));
				await copyButton.press("Enter");
				await expect(page.locator("body")).toHaveAttribute(
					"data-copied-task-directory-path",
					`/Users/test/.cline/worktrees/complete-task-id-${index}/example-project`,
				);
				await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-card-activation", "true");
				await expect(page.locator("body")).not.toHaveAttribute("data-edited-task-id");
				await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-task-start");
				await page
					.locator("body")
					.evaluate((element) => element.removeAttribute("data-copied-task-directory-path"));
			}
		} finally {
			await context.close();
		}
	});
}

for (const clipboardTransport of ["deferred_clipboard_item", "http_native_copy", "known_path_write_text"] as const) {
	test(`原生剪贴板与延迟 resolver：${clipboardTransport}`, async ({ browser, baseURL }) => {
		const context = await browser.newContext({ baseURL });
		try {
			// 不授予剪贴板权限；额外检查调用必须发生在同一个 trusted click 中，避免 Chrome 的权限宽松掩盖回归。
			await context.addInitScript((transport) => {
				let isHandlingTrustedClick = false;
				document.addEventListener(
					"click",
					(event) => {
						isHandlingTrustedClick = event.isTrusted;
						setTimeout(() => {
							isHandlingTrustedClick = false;
						}, 0);
					},
					true,
				);
				if (transport === "http_native_copy") {
					Object.defineProperty(navigator, "clipboard", { value: undefined });
					const executeNativeCopy = document.execCommand.bind(document);
					document.execCommand = (command) => {
						if (command === "copy" && !isHandlingTrustedClick) throw new Error("User gesture expired");
						return executeNativeCopy(command);
					};
				} else {
					const write = navigator.clipboard.write.bind(navigator.clipboard);
					const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
					navigator.clipboard.write = (items) => {
						if (!isHandlingTrustedClick) return Promise.reject(new Error("User gesture expired"));
						document.body.dataset.nativeClipboardWriteStarted = "true";
						return write(items);
					};
					navigator.clipboard.writeText = (text) => {
						if (!isHandlingTrustedClick) return Promise.reject(new Error("User gesture expired"));
						document.body.dataset.nativeClipboardWriteTextStarted = "true";
						return writeText(text);
					};
				}
			}, clipboardTransport);
			const page = await context.newPage();
			let releaseDirectoryResponse: (() => Promise<void>) | undefined;
			await page.route("**/task-workspace-directory?*", async (route) => {
				await new Promise<void>((resolve) => {
					releaseDirectoryResponse = async () => {
						await route.fulfill({ body: "/Users/test/.cline/worktrees/complete-task-id-0/example-project" });
						resolve();
					};
				});
			});
			await page.route("**/task-directory-copy-browser-contract*", (route) =>
				route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
			);
			await page.goto(
				`/task-directory-copy-browser-contract${clipboardTransport === "known_path_write_text" ? "?known-inplace-path" : ""}`,
			);
			await page.addScriptTag({
				type: "module",
				content: `import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;`,
			});
			await page.addScriptTag({ type: "module", url: "/tests/task-directory-copy-browser-harness.tsx" });
			const card = page.locator("[data-browser-test-card-role]").first();
			const button = card.getByRole("button", { name: "Copy directory path" });
			await button.focus();
			if (clipboardTransport !== "known_path_write_text") {
				await expect.poll(() => Boolean(releaseDirectoryResponse)).toBe(true);
				await button.press("Enter");
				await expect(button.locator("svg.lucide-check")).toHaveCount(0);
				if (clipboardTransport === "deferred_clipboard_item") {
					await expect(page.locator("body")).toHaveAttribute("data-native-clipboard-write-started", "true");
				}
				await releaseDirectoryResponse?.();
				await expect(page.locator("body")).toHaveAttribute(
					"data-resolved-task-directory-path",
					"/Users/test/.cline/worktrees/complete-task-id-0/example-project",
				);
			}
			if (clipboardTransport !== "deferred_clipboard_item") await button.press("Enter");
			await expect(button.locator("svg.lucide-check")).toHaveCount(1);
			if (clipboardTransport === "known_path_write_text") {
				await expect(page.locator("body")).toHaveAttribute("data-native-clipboard-write-text-started", "true");
				expect(releaseDirectoryResponse).toBeUndefined();
			}
			// 通过真实粘贴读取原生剪贴板，不用 read permission 覆盖写入时的权限条件。
			await page.evaluate(() => {
				const pasteTarget = document.createElement("textarea");
				pasteTarget.dataset.nativeClipboardPasteTarget = "";
				document.body.append(pasteTarget);
				pasteTarget.focus();
			});
			await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
			await expect(page.locator("[data-native-clipboard-paste-target]")).toHaveValue(
				clipboardTransport === "known_path_write_text"
					? "/Users/test/example-project"
					: "/Users/test/.cline/worktrees/complete-task-id-0/example-project",
			);
		} finally {
			await context.close();
		}
	});
}
