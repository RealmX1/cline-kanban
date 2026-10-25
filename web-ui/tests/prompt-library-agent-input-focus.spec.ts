import { expect, type Page, test } from "@playwright/test";

async function openShortcutInputFocusHarness(page: Page, transport: "pty" | "acp", isMobile: boolean) {
	await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
	await page.route("**/api/**", async (route) => {
		const procedureNames = new URL(route.request().url()).pathname.split("/").at(-1)?.split(",") ?? [];
		await route.fulfill({
			json: procedureNames.map((procedure) =>
				procedure === "runtime.getWorkspacePromptLibrary"
					? {
							result: {
								data: {
									ok: true,
									library: {
										globalScopedPrompts: [
											{
												id: "focus-prompt",
												text: "快捷提示词",
												scope: "global",
												createdAt: 1,
												updatedAt: 1,
											},
											{
												id: "focus-command",
												text: "快捷命令",
												scope: "global",
												entryKind: "reusable_command",
												createdAt: 1,
												updatedAt: 1,
											},
										],
										repoScopedPrompts: [],
										taskScopedPromptsByTaskId: {},
									},
								},
							},
						}
					: { error: { message: "隔离验证不访问运行实例", code: -32601, data: { code: "NOT_FOUND" } } },
			),
		});
	});
	await page.routeWebSocket("**/*", (socket) => {
		if (new URL(socket.url()).pathname === "/api/terminal/control") {
			socket.send(
				JSON.stringify({
					type: "restore",
					cols: 60,
					rows: 24,
					snapshot: "\x1b[?2004h隔离终端正文\r\n> ",
				}),
			);
		}
	});
	await page.route("**/isolated-shortcut-input-focus?*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-shortcut-input-focus?transport=${transport}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/prompt-library-agent-input-focus-browser-harness.tsx" });
	const agentInput = transport === "pty" ? page.locator(".xterm-helper-textarea") : page.locator("textarea").first();
	await expect(agentInput).toBeVisible();
	return agentInput;
}

for (const transport of ["pty", "acp"] as const) {
	for (const isMobile of [false, true]) {
		test(`${transport} ${isMobile ? "手机" : "桌面"}填入 Prompt 和 Command 后可立即继续输入`, async ({ page }) => {
			const agentInput = await openShortcutInputFocusHarness(page, transport, isMobile);
			if (transport === "acp") await agentInput.fill("已有草稿");
			if (transport === "pty" && !isMobile) {
				await page.getByRole("button", { name: "Read the transcript as a document", exact: true }).click();
				await expect(page.getByRole("textbox", { name: "Filter transcript lines", exact: true })).toBeVisible();
			}
			for (const [tab, text] of [
				["Prompts", "快捷提示词"],
				["Commands", "快捷命令"],
			] as const) {
				if (isMobile) {
					const expandNavigation = page.getByRole("button", { name: "展开上方导航与工具", exact: true });
					if (await expandNavigation.isVisible()) await expandNavigation.click();
				}
				await page.getByRole(isMobile ? "button" : "tab", { name: tab, exact: true }).click();
				const fillButton = page.getByRole("button", { name: "Fill prompt into input", exact: true });
				await expect(fillButton).toHaveCount(1);
				await page.locator("[data-prompt-library-entry-id]").hover();
				await fillButton.click();
				await expect(agentInput).toBeVisible();
				await expect(agentInput).toBeFocused();
				if (transport === "pty") {
					await expect(page.getByRole("textbox", { name: "Filter transcript lines", exact: true })).toHaveCount(0);
				}
				await page.keyboard.type("继续输入");
				if (transport === "acp") {
					await expect(agentInput).toHaveValue(
						tab === "Prompts"
							? `已有草稿\n${text}\n继续输入`
							: `已有草稿\n快捷提示词\n继续输入\n${text}\n继续输入`,
					);
				}
			}
			const observations = await page.evaluate(() =>
				(
					window as unknown as {
						readShortcutInputFocusObservations: () => {
							terminalInputFrames: string[];
							sentConversationMessages: string[];
						};
					}
				).readShortcutInputFocusObservations(),
			);
			expect(observations.sentConversationMessages).toEqual([]);
			if (transport === "pty") {
				expect(observations.terminalInputFrames.filter((frame) => frame.startsWith("\x1b[200~"))).toEqual([
					"\x1b[200~\r快捷提示词\r\x1b[201~",
					"\x1b[200~\r快捷命令\r\x1b[201~",
				]);
				expect(observations.terminalInputFrames.filter((frame) => !frame.startsWith("\x1b[200~")).join("")).toBe(
					"继续输入继续输入",
				);
			}
			await page.screenshot({ path: test.info().outputPath(`shortcut-input-focus-${transport}-${isMobile}.png`) });
			const otherButton = page.getByRole("button", { name: "焦点保护验证按钮", exact: true });
			await otherButton.focus();
			await expect(otherButton).toBeFocused();
		});
	}
}

test.describe("手机触摸填入", () => {
	test.use({ hasTouch: true, isMobile: true });
	for (const transport of ["pty", "acp"] as const) {
		test(`${transport} 触摸填入后切回 Chat 并聚焦 agent`, async ({ page }) => {
			const agentInput = await openShortcutInputFocusHarness(page, transport, true);
			await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).tap();
			await page.getByRole("button", { name: "Prompts", exact: true }).tap();
			await page.getByRole("textbox", { name: "Prompt text…", exact: true }).tap();
			await page.getByRole("button", { name: "Fill prompt into input", exact: true }).tap();
			await expect(agentInput).toBeVisible();
			await expect(agentInput).toBeFocused();
		});
	}
});

for (const transport of ["pty", "acp"] as const) {
	test(`${transport} 键盘启用快捷输入后聚焦 agent 且不提交`, async ({ page }) => {
		const agentInput = await openShortcutInputFocusHarness(page, transport, false);
		const fillButton = page.getByRole("button", { name: "Fill prompt into input", exact: true });
		await fillButton.focus();
		await fillButton.press("Enter");
		await expect(agentInput).toBeFocused();
		if (transport === "acp") await expect(agentInput).toHaveValue("\n快捷提示词\n");
		else {
			expect(
				await page.evaluate(
					() =>
						(
							window as unknown as {
								readShortcutInputFocusObservations: () => { terminalInputFrames: string[] };
							}
						).readShortcutInputFocusObservations().terminalInputFrames,
				),
			).toEqual(["\x1b[200~\r快捷提示词\r\x1b[201~"]);
		}
	});
}
