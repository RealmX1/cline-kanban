import { expect, type Page, test } from "@playwright/test";

async function openIsolatedDoneWorkbench(page: Page, mobile: boolean, deepLink = false) {
	await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
	const writes: string[] = [];
	const historySessions: string[] = [];
	const terminalConnections: string[] = [];
	await page.routeWebSocket("**/api/terminal/**", (socket) => {
		terminalConnections.push(socket.url());
		socket.close();
	});
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		if (request.method() !== "GET") {
			writes.push(request.url());
			await route.abort();
			return;
		}
		const url = new URL(request.url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(url.searchParams.get("input") ?? "{}");
		const responses = [];
		for (const [index, procedure] of procedures.entries()) {
			if (procedure === "runtime.getTaskConversationHistoryPage") {
				const input = inputs[String(index)];
				historySessions.push(input.taskConversationSessionId);
				const unavailable = input.workspaceTaskId === "second-done-task";
				responses.push({
					result: {
						data: {
							availability: unavailable ? "unavailable" : "available",
							notice: unavailable ? "这条会话的持久记录已经缺失。" : null,
							nextCursor: !unavailable && !input.cursor ? "older-page" : null,
							messages: unavailable
								? []
								: [
										{
											id: input.cursor ? "old" : input.taskConversationSessionId,
											role: "assistant",
											createdAt: 1,
											content: input.cursor
												? "完整的更早历史正文"
												: input.taskConversationSessionId === "side-session"
													? "侧会话的历史回答"
													: "已完成任务的历史回答",
										},
									],
						},
					},
				});
			} else {
				const data = await page.evaluate(
					(name) =>
						(window as unknown as { doneWorkbenchReadResponses?: Record<string, unknown> })
							.doneWorkbenchReadResponses?.[name],
					procedure,
				);
				if (data === undefined) {
					await route.abort();
					return;
				}
				responses.push({ result: { data } });
			}
		}
		await route.fulfill({ json: responses });
	});
	await page.route("**/isolated-done-workbench*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-done-workbench${deepLink ? "?task=abc12" : ""}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/done-task-complete-workbench-browser-harness.tsx" });
	if (!deepLink) await page.locator('[data-task-id="abc12"]').click();
	await expect(page.getByText("已完成任务的历史回答", { exact: true })).toBeVisible();
	return { writes, historySessions, terminalConnections };
}

async function showWorkbenchModule(
	page: Page,
	mobile: boolean,
	module: "sessions" | "prompts" | "commands" | "queue" | "relations" | "exploration",
) {
	if (mobile) {
		const expandTools = page.getByRole("button", { name: "展开上方导航与工具", exact: true });
		if (await expandTools.isVisible()) await expandTools.click();
		await page
			.getByRole("button", {
				name:
					module === "sessions" || module === "relations" || module === "exploration"
						? "Sessions"
						: module === "prompts"
							? "Prompts"
							: module === "commands"
								? "Commands"
								: /^Queue/,
			})
			.click();
	} else {
		await page
			.getByLabel("工作台格位 1", { exact: true })
			.selectOption(
				module === "sessions"
					? "task_sessions"
					: module === "relations"
						? "cross_task_relations"
						: module === "exploration"
							? "exploration_map"
							: "prompt_tools",
			);
		if (["commands", "queue", "prompts"].includes(module))
			await page
				.getByRole("tab", { name: module === "commands" ? "Commands" : module === "queue" ? /^Queue/ : "Prompts" })
				.click();
	}
}

for (const mobile of [false, true]) {
	test(`${mobile ? "手机" : "桌面"} Done 打开完整工作台，浏览不启动进程或投递队列`, async ({ page }) => {
		const evidence = await openIsolatedDoneWorkbench(page, mobile);
		await page.getByRole("button", { name: "加载更早记录", exact: true }).click();
		await expect(page.getByText("完整的更早历史正文", { exact: true })).toBeVisible();
		await showWorkbenchModule(page, mobile, "sessions");
		await expect(page.getByText("Main session", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeDisabled();
		await showWorkbenchModule(page, mobile, "exploration");
		await page.getByRole("button", { name: /^Findings/ }).click();
		await page.getByRole("button", { name: "main-after-handover 保存的结论", exact: true }).click();
		await expect(page.getByText("已完成会话保留的结论正文", { exact: true })).toBeVisible();
		if (mobile) await page.getByRole("button", { name: "探索地图", exact: true }).click();
		await expect(page.getByRole("button", { name: "立即维护", exact: true })).toBeDisabled();
		await showWorkbenchModule(page, mobile, "prompts");
		await expect(page.getByRole("textbox", { name: "Prompt text…", exact: true })).toHaveValue(
			"主会话保存的 Prompt 正文",
		);
		await expect(page.getByRole("button", { name: "Fill prompt into input", exact: true })).toBeDisabled();
		await showWorkbenchModule(page, mobile, "commands");
		await expect(page.getByRole("textbox", { name: "Prompt text…", exact: true })).toHaveValue(
			"已保存的 Commands 内容",
		);
		await showWorkbenchModule(page, mobile, "queue");
		await expect(page.getByText("完成任务保留的队列正文", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Keep", exact: true })).toBeDisabled();
		await showWorkbenchModule(page, mobile, "relations");
		const relations = page.getByRole("region", { name: "Relations", exact: true });
		const toggle = relations.getByRole("button", { expanded: false }).first();
		if (await toggle.count()) await toggle.click();
		await expect(relations.getByText("Child card in Done", { exact: true })).toBeVisible();
		expect(evidence.historySessions).toContain("main-after-handover");
		expect(evidence.writes).toEqual([]);
		expect(evidence.terminalConnections).toEqual([]);
		await expect(page.locator(".xterm-screen")).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1440);
		await page.screenshot({
			path: test.info().outputPath(`done-complete-workbench-${mobile ? "mobile" : "desktop"}.png`),
		});
	});

	test(`${mobile ? "手机" : "桌面"} Done 侧会话切换、日志缺失及深链恢复`, async ({ page }) => {
		const evidence = await openIsolatedDoneWorkbench(page, mobile, true);
		await showWorkbenchModule(page, mobile, "sessions");
		await page.getByRole("button", { name: /By the way.*侧会话历史/s }).click();
		await showWorkbenchModule(page, mobile, "exploration");
		await page.getByRole("button", { name: /^Findings/ }).click();
		await expect(page.getByRole("button", { name: "side-session 保存的结论", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "main-after-handover 保存的结论", exact: true })).toHaveCount(0);
		if (mobile) await page.getByRole("button", { name: "Chat", exact: true }).click();
		await expect(page.getByText("侧会话的历史回答", { exact: true })).toBeVisible();
		await expect(page.getByText("已完成任务的历史回答", { exact: true })).toHaveCount(0);
		await showWorkbenchModule(page, mobile, "prompts");
		await expect(page.getByRole("textbox", { name: "Prompt text…", exact: true })).toHaveValue(
			"侧会话保存的 Prompt 正文",
		);
		await page.getByRole("button", { name: "返回 Done 看板", exact: true }).click();
		await page.locator('[data-task-id="second-done-task"]').click();
		await expect(page.getByText("这条会话的持久记录已经缺失。", { exact: true })).toBeVisible();
		await showWorkbenchModule(page, mobile, "prompts");
		await expect(page.getByRole("textbox", { name: "Prompt text…", exact: true })).toHaveValue(
			"日志缺失也保留工作台资产",
		);
		expect(evidence.writes).toEqual([]);
		expect(evidence.terminalConnections).toEqual([]);
	});
}
