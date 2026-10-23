import { expect, type Page, test } from "@playwright/test";

for (const browserAccessContext of ["localhost", "tailnet_plain_http"] as const) {
	test(`${browserAccessContext}：直接查询、Search 转入、多轮留档和响应式布局均可用`, async ({ page, baseURL }) => {
		if (!baseURL) throw new Error("查卡浏览器测试需要配置 Vite 服务的 baseURL。");
		const browserOrigin =
			browserAccessContext === "tailnet_plain_http" ? "http://task-lookup-tailnet-http.test:3485" : baseURL;
		if (browserAccessContext === "tailnet_plain_http") {
			// 保留浏览器的真实 HTTP 安全判定，仅将测试页面资源映射到隔离的 Vite 服务。
			await page.route(`${browserOrigin}/**`, async (route) => {
				const requestUrl = new URL(route.request().url());
				const response = await route.fetch({ url: new URL(requestUrl.pathname + requestUrl.search, baseURL).href });
				await route.fulfill({ response });
			});
		}
		await verifyTaskLookupQueryFlows(page, browserOrigin, browserAccessContext === "localhost");
	});
}

async function verifyTaskLookupQueryFlows(page: Page, browserOrigin: string, isSecureContextExpected: boolean) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const conversationId = "9fe0ae6d-1c0f-4fde-8aca-3bf417ab7b80";
	const taskReference = (taskId: string) => ({
		workUnitType: "kanban_board_card",
		workspaceId: "isolated-project",
		taskId,
		taskIncarnationCreatedAtEpochMs: 1,
	});
	const candidate = (taskId: string) => ({
		taskReference: taskReference(taskId),
		title: `查卡任务 ${taskId}`,
		projectName: "隔离项目",
		columnId: "backlog",
		matchingReason: "要求包含多轮查询与留档",
		evidence: ["当前任务要求"],
		limitations: ["尚未核验实现完成"],
	});
	let conversation: Record<string, unknown> | null = null;
	const submissions: Record<string, unknown>[] = [];
	let answerMode: "candidates" | "empty" | "failure" | "running" = "candidates";
	const savedImages: Record<string, unknown>[] = [];
	let rejectNextSubmission = true;
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
		const responses = procedures.map((procedure, index) => {
			const input = inputs[String(index)] ?? {};
			let response: unknown = {};
			if (procedure === "support.saveAgentPromptImageAttachments") {
				response = input.images.map((image: Record<string, unknown>) => {
					const id = "a".repeat(64);
					savedImages.push({ ...image, id });
					return {
						imageAttachmentId: id,
						imageFilePath: `/isolated-persistent-images/${id}.png`,
						imageMimeType: image.mimeType,
						imageDisplayName: image.name,
					};
				});
			}
			if (procedure === "support.readAgentPromptImageAttachments") response = savedImages;
			if (procedure === "support.getExecutorSettings") response = { agentId: "codex", modelId: null };
			if (procedure === "projects.getAllProjectsTaskSearchIndex") response = { projects: [] };
			if (procedure === "support.listTaskLookupConversations") response = conversation ? [conversation] : [];
			if (procedure === "support.getTaskLookupConversation") response = conversation;
			if (procedure === "support.createTaskLookupConversation") {
				conversation = {
					schemaVersion: 1,
					conversationId,
					contextWorkspaceId: input.contextWorkspaceId,
					title: "新查卡会话",
					scope: input.scope,
					createdAt: 1,
					updatedAt: 1,
					revision: 1,
					turns: [],
				};
				response = conversation;
			}
			if (procedure === "support.submitTaskLookupTurn") {
				if (rejectNextSubmission) {
					rejectNextSubmission = false;
					return {
						error: {
							message: "提交失败，测试确认保留草稿和图片",
							code: -32603,
							data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
						},
					};
				}
				submissions.push(input);
				const turns = (conversation?.turns as unknown[]) ?? [];
				conversation = {
					...conversation,
					title: conversation?.title === "新查卡会话" ? input.questionText : conversation?.title,
					scope: input.scope,
					revision: submissions.length + 1,
					updatedAt: submissions.length + 1,
					turns: [
						...turns,
						{
							turnId: `turn-${submissions.length}`,
							requestId: input.requestId,
							questionText: input.questionText,
							questionImages: String(input.questionText).includes("<attached-reference-images>")
								? savedImages
								: [],
							scope: input.scope,
							status: answerMode === "running" ? "running" : answerMode === "failure" ? "failed" : "completed",
							phase: answerMode === "running" ? "collecting_materials" : "finished",
							startedAt: answerMode === "running" ? Date.now() - 65_000 : 1,
							phaseStartedAt: Date.now() - 65_000,
							lastExecutionActivityAt: Date.now() - 65_000,
							finishedAt: answerMode === "running" ? null : 2,
							executorSettings: { agentId: "codex", modelId: null },
							owningRuntimeProcessInstanceId: "isolated-runtime",
							errorMessage: answerMode === "failure" ? "模型认证已过期" : null,
							executions: [],
							result:
								answerMode === "failure" || answerMode === "running"
									? null
									: {
											answerText: "按当前要求找到以下候选",
											candidates: answerMode === "empty" ? [] : [candidate("abc12"), candidate("def34")],
											contextAsOf: 1,
											contextCompleteness: [],
										},
						},
					],
				};
				response = conversation;
			}
			if (procedure === "support.cancelTaskLookupTurn") {
				const turns = conversation?.turns as Record<string, unknown>[];
				conversation = {
					...conversation,
					revision: Number(conversation?.revision) + 1,
					turns: turns.map((turn, index) =>
						index === turns.length - 1
							? {
									...turn,
									status: "cancelled",
									phase: "finished",
									finishedAt: Date.now(),
									errorMessage: "用户已取消本轮查询。",
								}
							: turn,
					),
				};
				response = conversation;
			}
			if (procedure === "support.readTaskLookupCandidatePreview")
				response = { ...candidate(input.taskReference.taskId), prompt: "完整要求：持久多轮查卡。" };
			return { result: { data: response } };
		});
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(url.searchParams.has("batch") ? responses : responses[0]),
		});
	});
	const openHarness = async () => {
		await page.route("**/isolated-task-lookup-workbench", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
			}),
		);
		await page.goto(new URL("/isolated-task-lookup-workbench", browserOrigin).href);
		expect(await page.evaluate(() => window.isSecureContext)).toBe(isSecureContextExpected);
		expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe(
			isSecureContextExpected ? "function" : "undefined",
		);
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({ type: "module", url: "/tests/task-lookup-workbench-browser-harness.tsx" });
	};
	await openHarness();
	await page.getByRole("button", { name: "打开 AI 查卡", exact: true }).click();
	const questionInput = page.getByRole("textbox", { name: "查卡问题" });
	await questionInput.fill("需要引用的执行轨迹");
	await questionInput.press("ControlOrMeta+A");
	await page.getByRole("button", { name: "Insert block", exact: true }).click();
	await page.getByRole("button", { name: "<trajectory>", exact: true }).click();
	await expect(questionInput).toHaveValue("<trajectory>\n需要引用的执行轨迹\n</trajectory>");
	await expect(questionInput).toBeFocused();
	const longQuestion = `直接发起新的查卡查询\n${"这是需要完整保留的查询条件。\n".repeat(12)}`.trim();
	await questionInput.fill(longQuestion);
	await page.getByRole("button", { name: "扩展编辑区", exact: true }).click();
	await expect(page.getByRole("button", { name: "收起编辑区", exact: true })).toHaveAttribute("aria-expanded", "true");
	await page.locator('[data-agent-prompt-composer] input[type="file"]').setInputFiles({
		name: "参考图.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n2QAAAAASUVORK5CYII=",
			"base64",
		),
	});
	await expect(page.getByRole("button", { name: "Delete 参考图.png", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "查询任务", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("提交失败，测试确认保留草稿和图片");
	await expect(questionInput).toHaveValue(longQuestion);
	await openHarness();
	await page.getByRole("button", { name: "打开 AI 查卡", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "查卡问题" })).toHaveValue(longQuestion);
	await expect(page.getByRole("button", { name: "Delete 参考图.png", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "查询任务", exact: true }).click();
	await expect.poll(() => submissions.length).toBe(1);
	expect(String(submissions[0]?.questionText)).toContain("<attached-reference-images>");
	const firstRound = page.getByRole("article", { name: "第 1 轮查询", exact: true });
	await expect(firstRound.getByRole("button", { name: "展开完整问题", exact: true })).toBeVisible();
	await expect(firstRound.locator("[data-task-lookup-question] p")).toHaveClass(/line-clamp-4/u);
	await firstRound.getByRole("button", { name: "展开完整问题", exact: true }).click();
	await expect(firstRound.getByRole("button", { name: "收起问题", exact: true })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(firstRound.locator("[data-task-lookup-question] p")).not.toHaveClass(/line-clamp-4/u);
	await firstRound.getByRole("button", { name: "收起问题", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "查卡问题" })).toHaveValue("");
	await expect(page.getByRole("button", { name: "Insert block", exact: true })).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "打开 Search", exact: true }).click();
	await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill("查找多轮留档任务");
	await page.getByRole("button", { name: "AI 查卡", exact: true }).click();
	await expect.poll(() => submissions.length).toBe(2);
	await expect(page.getByRole("button", { name: "预览候选 查卡任务 abc12" })).toBeVisible();
	await page.getByRole("button", { name: "预览候选 查卡任务 abc12" }).click();
	await expect(page.getByText("完整要求：持久多轮查卡。")).toBeVisible();
	await expect(page.getByText("已打开任务：isolated-project/abc12")).toHaveCount(0);
	await page.getByRole("textbox", { name: "查卡问题" }).fill("只看计划中的任务");
	await page.getByRole("button", { name: "查询任务", exact: true }).click();
	await expect.poll(() => submissions.length).toBe(3);
	await expect(page.getByRole("log").getByText("只看计划中的任务", { exact: true })).toBeVisible();
	expect(submissions[1]?.conversationId).toBe(submissions[2]?.conversationId);
	await expect(page.getByRole("textbox", { name: "查卡问题" })).toHaveValue("");
	await page.screenshot({ path: test.info().outputPath("task-lookup-desktop.png") });
	await page.getByRole("button", { name: "打开任务", exact: true }).click();
	await expect(page.getByText("已打开任务：isolated-project/abc12")).toBeVisible();
	await page.getByRole("button", { name: "打开 AI 查卡", exact: true }).click();
	await expect(page.getByText("只看计划中的任务", { exact: true })).toBeVisible();
	await page.getByRole("textbox", { name: "查卡问题" }).fill("跨刷新保留的未提交草稿");
	await openHarness();
	await page.getByRole("button", { name: "打开 AI 查卡", exact: true }).click();
	await expect(page.getByText("只看计划中的任务", { exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "查卡问题" })).toHaveValue("跨刷新保留的未提交草稿");
	await page.setViewportSize({ width: 900, height: 1200 });
	await expect(page.locator("[data-task-lookup-workbench] [data-focus-view-panel-arrangement]")).toHaveAttribute(
		"data-focus-view-panel-arrangement",
		"agent_above_workbench_below",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "预览候选 查卡任务 abc12" }).first().click();
	await expect(page.getByText("完整要求：持久多轮查卡。")).toBeVisible();
	await page.getByRole("button", { name: "查卡对话", exact: true }).click();
	answerMode = "empty";
	await page.getByRole("textbox", { name: "查卡问题" }).fill("找不存在的任务");
	await page.getByRole("button", { name: "查询任务", exact: true }).click();
	await expect(page.getByText("当前范围和材料下没有找到候选任务。")).toBeVisible();
	answerMode = "failure";
	await page.getByRole("textbox", { name: "查卡问题" }).fill("模型失败示例");
	await page.getByRole("button", { name: "查询任务", exact: true }).click();
	await expect(page.getByText("模型认证已过期")).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("task-lookup-mobile.png") });
	answerMode = "running";
	await page.getByRole("textbox", { name: "查卡问题" }).fill("查看实时进度与失败诊断");
	await page.getByRole("button", { name: "查询任务", exact: true }).click();
	await expect(page.getByText("读取任务材料…", { exact: true })).toBeVisible();
	await expect(page.getByText("已超过 60 秒没有新的执行活动，仍在等待；可以取消本轮。")).toBeVisible();
	const turns = conversation?.turns as Record<string, unknown>[];
	conversation = {
		...conversation,
		revision: Number(conversation?.revision) + 1,
		turns: turns.map((turn, index) =>
			index === turns.length - 1
				? {
						...turn,
						phase: "explaining_candidates",
						phaseStartedAt: Date.now(),
						lastExecutionActivityAt: Date.now(),
						inputByteCount: 32000,
						modelExecutionTimeoutMs: 180000,
						executionActivityTimeline: [
							{
								occurredAtEpochMs: Date.now(),
								phase: "explaining_candidates",
								eventKind: "agent_response_received",
								message: "收到 Agent 事件：turn.started",
							},
						],
					}
				: turn,
		),
	};
	await page.getByRole("button", { name: "模拟推流", exact: true }).click();
	await expect(page.getByText("解释候选任务…", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "返回任务", exact: true }).click();
	await page.getByRole("button", { name: "打开 AI 查卡", exact: true }).click();
	await expect(page.getByText("解释候选任务…", { exact: true })).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("task-lookup-progress-mobile.png") });
	const currentTurns = conversation?.turns as Record<string, unknown>[];
	conversation = {
		...conversation,
		revision: Number(conversation?.revision) + 1,
		turns: currentTurns.map((turn, index) =>
			index === currentTurns.length - 1
				? {
						...turn,
						status: "failed",
						phase: "finished",
						finishedAt: Date.now(),
						errorMessage: "模型调用已超时",
						executionFailureDiagnostic: {
							reasonCode: "execution_timeout",
							failedPhase: "explaining_candidates",
							detail: "模型调用已超时",
							exitCode: null,
							signal: "SIGKILL",
							stderrTail: null,
						},
					}
				: turn,
		),
	};
	await page.getByRole("button", { name: "模拟重连", exact: true }).click();
	const latestArticle = page.getByRole("log").locator("article").last();
	await expect(latestArticle.getByText("停止阶段：解释候选任务 · 原因：execution_timeout")).toBeVisible();
	await latestArticle.getByText("检索记录与诊断", { exact: true }).click();
	await expect(latestArticle.getByText("收到 Agent 事件：turn.started", { exact: false })).toBeVisible();
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
		document.addEventListener("copy", (event) => {
			document.body.dataset.copiedDiagnostic = event.clipboardData?.getData("text/plain") ?? "";
		});
	});
	await latestArticle.getByRole("button", { name: "复制诊断", exact: true }).click();
	await expect(latestArticle.getByText("诊断已复制", { exact: true })).toBeVisible();
	const copied = await page.locator("body").getAttribute("data-copied-diagnostic");
	expect(copied).toContain("execution_timeout");
	expect(copied).not.toContain("查看实时进度与失败诊断");
	answerMode = "candidates";
	await latestArticle.getByRole("button", { name: "重新查询", exact: true }).click();
	await expect.poll(() => submissions.length).toBe(7);
	expect(submissions[6]?.questionText).toBe(submissions[5]?.questionText);
	expect(submissions[6]?.scope).toEqual(submissions[5]?.scope);
	answerMode = "running";
	await page.getByRole("textbox", { name: "查卡问题" }).fill("取消中的查询");
	await page.getByRole("button", { name: "查询任务", exact: true }).click();
	await page.getByRole("button", { name: "取消本轮", exact: true }).click();
	await expect(page.getByText("用户已取消本轮查询。", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(submissions).toHaveLength(8);
	for (const submission of submissions) {
		expect(submission.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	}
	expect(new Set(submissions.map((submission) => submission.requestId)).size).toBe(submissions.length);
	expect(errors).toEqual([]);
}
