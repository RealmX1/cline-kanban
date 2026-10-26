import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKanbanRuntimePort, setKanbanRuntimePort } from "../../../src/core/runtime-endpoint";
import type { TaskVisualizationPreviewRequestedMessage } from "../../../src/core/task-visualization-artifact-contract";
import { stageTaskVisualizationPublication } from "../../../src/task-visualization-artifacts/stage-task-visualization-publication";
import { TaskVisualizationArtifactService } from "../../../src/task-visualization-artifacts/task-visualization-artifact-service";
import { TaskVisualizationArtifactStore } from "../../../src/task-visualization-artifacts/task-visualization-artifact-store";
import { handleTaskVisualizationContentHttpRequest } from "../../../src/task-visualization-artifacts/task-visualization-content-http-handler";

let rootDirectory: string;
let runtimeHome: string;
let sourceDirectory: string;
const scope = { workspaceId: "workspace-a", workspacePath: "/registered-project" };
let observedTime: number;
const service = () =>
	new TaskVisualizationArtifactService({
		store: new TaskVisualizationArtifactStore(runtimeHome),
		resolveWorkspaceScope: async (workspaceId) => (workspaceId === scope.workspaceId ? scope : null),
		assertTaskMayPublish: async () => {},
		resolveTaskTitle: async () => "任务名",
		onArtifactsUpdated: () => {},
		warn: () => {},
		now: () => observedTime,
	});

beforeEach(async () => {
	rootDirectory = await mkdtemp(join(tmpdir(), "task-visualization-service-"));
	runtimeHome = join(rootDirectory, "runtime-home");
	sourceDirectory = join(rootDirectory, "source");
	await mkdir(sourceDirectory);
	await writeFile(join(sourceDirectory, "chart.html"), "<h1>可视化</h1>");
	observedTime = Date.now();
});
afterEach(async () => {
	await rm(rootDirectory, { recursive: true, force: true });
});

async function publish(runtimeService: TaskVisualizationArtifactService) {
	const pending = await stageTaskVisualizationPublication({
		runtimeHomeDirectoryPath: runtimeHome,
		workspaceId: scope.workspaceId,
		workspaceRepositoryPath: scope.workspacePath,
		taskId: "task-a",
		title: "可视化",
		sourceHtmlFilePath: join(sourceDirectory, "chart.html"),
	});
	return await runtimeService.publish(scope, { taskId: "task-a", publicationRequestId: pending.publicationRequestId });
}

async function acknowledge(
	runtimeService: TaskVisualizationArtifactService,
	connection: string,
	message: TaskVisualizationPreviewRequestedMessage,
	outcome: "accepted" | "displayed" | "declined" | "dismissed" | "failed",
) {
	await runtimeService.acknowledgePreview(connection, message.workspaceId, {
		type: "acknowledge_task_visualization_preview",
		browserPageId: message.browserPageId,
		taskId: message.taskId,
		previewRequestId: message.previewRequest.previewRequestId,
		deliveryAttemptId: message.deliveryAttemptId,
		outcome,
	});
}
async function registerPages(runtimeService: TaskVisualizationArtifactService, count: number) {
	const pages: {
		connection: string;
		declaration: {
			type: "declare_task_visualization_browser_context";
			previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1";
			browserPageId: string;
			taskId: string;
			isForeground: boolean;
			interactionSequence: number;
		};
		messages: TaskVisualizationPreviewRequestedMessage[];
	}[] = [];
	for (let index = 0; index < count; index++) {
		const page = {
			connection: `page-${index}`,
			declaration: {
				type: "declare_task_visualization_browser_context" as const,
				previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1" as const,
				browserPageId: randomUUID(),
				taskId: "task-a",
				isForeground: true,
				interactionSequence: 1,
			},
			messages: [] as TaskVisualizationPreviewRequestedMessage[],
		};
		pages.push(page);
		await runtimeService.observeBrowserContext(page.connection, scope.workspaceId, page.declaration, (message) =>
			page.messages.push(message),
		);
	}
	return pages;
}

describe("任务可视化运行时服务", () => {
	it("旧产物取得真实任务名，改名更新查看器而不改写旧修订", async () => {
		const store = new TaskVisualizationArtifactStore(runtimeHome);
		const pending = await stageTaskVisualizationPublication({
			runtimeHomeDirectoryPath: runtimeHome,
			workspaceId: scope.workspaceId,
			workspaceRepositoryPath: scope.workspacePath,
			taskId: "task-a",
			title: "图表标题",
			sourceHtmlFilePath: join(sourceDirectory, "chart.html"),
		});
		const legacy = await store.acceptPublication(
			scope.workspaceId,
			scope.workspacePath,
			pending.publicationRequestId,
		);
		let taskTitle = "原任务名";
		const runtimeService = new TaskVisualizationArtifactService({
			store,
			resolveWorkspaceScope: async () => scope,
			assertTaskMayPublish: async () => {},
			resolveTaskTitle: async (selectedScope) =>
				selectedScope.workspaceId === scope.workspaceId ? taskTitle : "另一个项目",
			onArtifactsUpdated: () => {},
			warn: () => {},
		});
		expect((await runtimeService.list(scope, { taskId: "task-a" })).taskAttribution).toEqual({
			workspaceId: scope.workspaceId,
			taskId: "task-a",
			taskTitle,
		});
		taskTitle = "改名后的任务";
		const preview = await runtimeService.preparePreview(scope, {
			taskId: "task-a",
			visualizationArtifactId: legacy.artifact.visualizationArtifactId,
		});
		expect(preview.taskAttribution.taskTitle).toBe(taskTitle);
		expect(preview.artifact.revisionId).toBe(pending.revisionId);
		expect(await store.readRevisionFile(preview.artifact, "chart.html")).toMatchObject({
			content: Buffer.from("<h1>可视化</h1>"),
		});
		expect(
			(
				await runtimeService.list(
					{ workspaceId: "workspace-b", workspacePath: "/other-project" },
					{ taskId: "task-a" },
				)
			).taskAttribution.taskTitle,
		).toBe("另一个项目");
	});

	it("受理时自动补齐持久包署名；同内容重试不增加版本，任务改名仅影响后续发布", async () => {
		const runtimeService = service();
		const first = await publish(runtimeService);
		expect(first.artifact.taskTitleAtPublication).toBe("任务名");
		const firstHtml = await runtimeService.store.readRevisionFile(first.artifact, "chart.html");
		expect(firstHtml.content.toString()).toContain('data-kanban-task-attribution="v1"');
		expect(firstHtml.content.toString()).toContain("task-a");
		expect((await publish(runtimeService)).artifact.versionNumber).toBe(1);
		expect(await readFile(join(sourceDirectory, "chart.html"), "utf8")).toBe("<h1>可视化</h1>");
	});

	it("任务名暂不可读时保留待恢复包，重启补证后仅发布一次", async () => {
		const resolveTaskTitle = vi
			.fn<() => Promise<string | null>>()
			.mockRejectedValueOnce(new Error("暂时读盘失败"))
			.mockResolvedValue("恢复后的任务名");
		const dependencies = {
			store: new TaskVisualizationArtifactStore(runtimeHome),
			resolveWorkspaceScope: async () => scope,
			assertTaskMayPublish: async () => {},
			resolveTaskTitle,
			onArtifactsUpdated: () => {},
			warn: () => {},
			now: () => observedTime,
		};
		const pending = await stageTaskVisualizationPublication({
			runtimeHomeDirectoryPath: runtimeHome,
			workspaceId: scope.workspaceId,
			workspaceRepositoryPath: scope.workspacePath,
			taskId: "task-a",
			title: "图表",
			sourceHtmlFilePath: join(sourceDirectory, "chart.html"),
		});
		await new TaskVisualizationArtifactService(dependencies).recoverPendingPublications();
		expect(await dependencies.store.list(scope.workspaceId, "task-a")).toHaveLength(0);
		const restarted = new TaskVisualizationArtifactService(dependencies);
		await restarted.recoverPendingPublications();
		await restarted.recoverPendingPublications();
		const artifacts = await dependencies.store.list(scope.workspaceId, "task-a");
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].taskTitleAtPublication).toBe("恢复后的任务名");
		expect(
			await readFile(
				join(pending.pendingPublicationDirectoryPath, "latest-runtime-acceptance-failure.json"),
				"utf8",
			),
		).toContain("暂时读盘失败");
	});

	it("新标签链接固定当前修订，旧链接仍选最新且无效修订不会回退", async () => {
		const runtimeService = service();
		const firstPublication = await publish(runtimeService);
		const firstPreview = await runtimeService.preparePreview(scope, {
			taskId: "task-a",
			visualizationArtifactId: firstPublication.artifact.visualizationArtifactId,
		});
		await writeFile(join(sourceDirectory, "chart.html"), "<h1>最新版本</h1>");
		const latestPublication = await publish(runtimeService);
		expect(latestPublication.artifact.revisionId).not.toBe(firstPublication.artifact.revisionId);
		const viewerQuery = new URL(firstPreview.viewerRelativeUrl, "http://test.invalid").searchParams;
		expect(viewerQuery.get("revisionId")).toBe(firstPublication.artifact.revisionId);
		expect(new URL(firstPublication.viewerRelativeUrl, "http://test.invalid").searchParams.get("revisionId")).toBe(
			firstPublication.artifact.revisionId,
		);
		const pinnedPreview = await runtimeService.preparePreview(scope, {
			taskId: viewerQuery.get("taskId") ?? "",
			visualizationArtifactId: viewerQuery.get("visualizationArtifactId") ?? "",
			revisionId: viewerQuery.get("revisionId") ?? undefined,
		});
		expect(pinnedPreview.artifact).toEqual(firstPublication.artifact);
		const pinnedToken = new URL(pinnedPreview.contentRelativeUrl, "http://test.invalid").pathname.split("/")[3];
		expect((await runtimeService.readContent(pinnedToken, "chart.html")).content.toString()).toContain(
			"<h1>可视化</h1>",
		);
		const latestPreview = await runtimeService.preparePreview(scope, {
			taskId: "task-a",
			visualizationArtifactId: firstPublication.artifact.visualizationArtifactId,
		});
		expect(latestPreview.artifact.revisionId).toBe(latestPublication.artifact.revisionId);
		await expect(
			runtimeService.preparePreview(scope, {
				taskId: "task-a",
				visualizationArtifactId: firstPublication.artifact.visualizationArtifactId,
				revisionId: "0".repeat(64),
			}),
		).rejects.toThrow();
	});

	it("只读内容凭据绑定版本，跨服务重建可用，篡改及过期会被拒绝", async () => {
		const runtimeService = service();
		const published = await publish(runtimeService);
		const prepared = await runtimeService.preparePreview(scope, {
			taskId: "task-a",
			visualizationArtifactId: published.artifact.visualizationArtifactId,
		});
		const contentPath = new URL(prepared.contentRelativeUrl, "http://test.invalid").pathname;
		const token = contentPath.split("/")[3];
		expect((await service().readContent(token, "chart.html")).content.toString()).toContain("可视化");
		await expect(runtimeService.readContent(`${token}x`, "chart.html")).rejects.toThrow();
		await expect(runtimeService.readContent(token, "../task-visualization-registry.json")).rejects.toThrow();
		observedTime = prepared.contentAccessExpiresAtMs + 1;
		await expect(service().readContent(token, "chart.html")).rejects.toThrow("过期");
	});

	it("最近操作的前台同任务页面独占自动预览，收到回执后不重发", async () => {
		const runtimeService = service();
		const firstMessages: TaskVisualizationPreviewRequestedMessage[] = [];
		const secondMessages: TaskVisualizationPreviewRequestedMessage[] = [];
		const firstPage = randomUUID();
		const secondPage = randomUUID();
		await runtimeService.observeBrowserContext(
			"first",
			scope.workspaceId,
			{
				type: "declare_task_visualization_browser_context",
				previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1",
				browserPageId: firstPage,
				taskId: "task-a",
				isForeground: true,
				interactionSequence: 1,
			},
			(message) => firstMessages.push(message),
		);
		observedTime += 1;
		await runtimeService.observeBrowserContext(
			"second",
			scope.workspaceId,
			{
				type: "declare_task_visualization_browser_context",
				previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1",
				browserPageId: secondPage,
				taskId: "task-a",
				isForeground: true,
				interactionSequence: 1,
			},
			(message) => secondMessages.push(message),
		);
		await publish(runtimeService);
		expect(firstMessages).toHaveLength(0);
		expect(secondMessages).toHaveLength(1);
		await acknowledge(runtimeService, "second", secondMessages[0], "accepted");
		await runtimeService.acknowledgePreview("second", scope.workspaceId, {
			type: "acknowledge_task_visualization_preview",
			browserPageId: secondPage,
			taskId: "task-a",
			previewRequestId: secondMessages[0].previewRequest.previewRequestId,
			deliveryAttemptId: secondMessages[0].deliveryAttemptId,
			outcome: "displayed",
		});
		await runtimeService.observeBrowserContext(
			"second",
			scope.workspaceId,
			{
				type: "declare_task_visualization_browser_context",
				previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1",
				browserPageId: secondPage,
				taskId: "task-a",
				isForeground: true,
				interactionSequence: 2,
			},
			(message) => secondMessages.push(message),
		);
		expect(secondMessages).toHaveLength(2);
	});

	it("首个页面尚在慢加载时，超过旧 offer 超时也不会在第二页重复自动打开", async () => {
		const runtimeService = service();
		const firstMessages: TaskVisualizationPreviewRequestedMessage[] = [];
		const secondMessages: TaskVisualizationPreviewRequestedMessage[] = [];
		const firstDeclaration = {
			type: "declare_task_visualization_browser_context" as const,
			previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1" as const,
			browserPageId: randomUUID(),
			taskId: "task-a",
			isForeground: true,
			interactionSequence: 1,
		};
		const secondDeclaration = { ...firstDeclaration, browserPageId: randomUUID() };
		await runtimeService.observeBrowserContext("second", scope.workspaceId, secondDeclaration, (message) =>
			secondMessages.push(message),
		);
		await runtimeService.observeBrowserContext("first", scope.workspaceId, firstDeclaration, (message) =>
			firstMessages.push(message),
		);
		await publish(runtimeService);
		expect(firstMessages).toHaveLength(1);
		await acknowledge(runtimeService, "first", firstMessages[0], "accepted");
		observedTime += 6000;
		await runtimeService.observeBrowserContext(
			"second",
			scope.workspaceId,
			{ ...secondDeclaration, interactionSequence: 2 },
			(message) => secondMessages.push(message),
		);
		expect(secondMessages).toHaveLength(0);
	});

	it("后台页、其他项目同号任务不能接收；无人在线的历史发布不重放", async () => {
		const runtimeService = service();
		const received: TaskVisualizationPreviewRequestedMessage[] = [];
		await publish(runtimeService);
		observedTime = Date.now() + 1000;
		await runtimeService.observeBrowserContext(
			"late",
			scope.workspaceId,
			{
				type: "declare_task_visualization_browser_context",
				previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1",
				browserPageId: randomUUID(),
				taskId: "task-a",
				isForeground: true,
				interactionSequence: 1,
			},
			(message) => received.push(message),
		);
		await runtimeService.observeBrowserContext(
			"foreign",
			"workspace-b",
			{
				type: "declare_task_visualization_browser_context",
				previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1",
				browserPageId: randomUUID(),
				taskId: "task-a",
				isForeground: true,
				interactionSequence: 1,
			},
			(message) => received.push(message),
		);
		await runtimeService.observeBrowserContext(
			"background",
			scope.workspaceId,
			{
				type: "declare_task_visualization_browser_context",
				previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1",
				browserPageId: randomUUID(),
				taskId: "task-a",
				isForeground: false,
				interactionSequence: 1,
			},
			(message) => received.push(message),
		);
		expect(received).toEqual([]);
		expect((await runtimeService.list(scope, { taskId: "task-a" })).artifacts).toHaveLength(1);
	});

	it("用户关闭尚未加载的预览后，心跳不会把它重新打开", async () => {
		const runtimeService = service();
		const received: TaskVisualizationPreviewRequestedMessage[] = [];
		const browserPageId = randomUUID();
		const declaration = {
			type: "declare_task_visualization_browser_context" as const,
			previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1" as const,
			browserPageId,
			taskId: "task-a",
			isForeground: true,
			interactionSequence: 1,
		};
		await runtimeService.observeBrowserContext("page", scope.workspaceId, declaration, (message) =>
			received.push(message),
		);
		await publish(runtimeService);
		expect(received).toHaveLength(1);
		await runtimeService.acknowledgePreview("page", scope.workspaceId, {
			type: "acknowledge_task_visualization_preview",
			browserPageId,
			taskId: "task-a",
			previewRequestId: received[0].previewRequest.previewRequestId,
			deliveryAttemptId: received[0].deliveryAttemptId,
			outcome: "dismissed",
		});
		observedTime += 6000;
		await runtimeService.observeBrowserContext("page", scope.workspaceId, declaration, (message) =>
			received.push(message),
		);
		expect(received).toHaveLength(1);
	});

	it("成功入口响应携带本次修订证明，读取失败的 404 文档不携带证明", async () => {
		const runtimeService = service();
		const published = await publish(runtimeService);
		const prepared = await runtimeService.preparePreview(scope, {
			taskId: "task-a",
			visualizationArtifactId: published.artifact.visualizationArtifactId,
		});
		const server = createServer((request, response) => {
			void handleTaskVisualizationContentHttpRequest(request, response, runtimeService);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const previousRuntimePort = getKanbanRuntimePort();
		const previousRuntimePortEnvironment = process.env.KANBAN_RUNTIME_PORT;
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("隔离内容服务未监听。");
			const contentUrl = `http://127.0.0.1:${address.port}${prepared.contentRelativeUrl}`;
			setKanbanRuntimePort(address.port);
			const success = await fetch(contentUrl);
			expect(success.status).toBe(200);
			expect(success.headers.get("content-security-policy")).not.toContain("allow-same-origin");
			const html = await success.text();
			expect(html).toContain(prepared.contentLoadConfirmationId);
			expect(html).toContain(prepared.artifact.revisionId);
			expect(html).toContain('window.addEventListener("load"');
			expect(html).toContain("kanban_visualization_request_collapse_foreground_view");
			expect(html).toContain('event.key==="Escape"&&!event.defaultPrevented');
			vi.spyOn(runtimeService.store, "readRevisionFile").mockRejectedValueOnce(new Error("模拟读取失败"));
			const failure = await fetch(contentUrl);
			expect(failure.status).toBe(404);
			expect(await failure.text()).not.toContain("kanban_visualization_content_loaded");
		} finally {
			setKanbanRuntimePort(previousRuntimePort);
			if (previousRuntimePortEnvironment === undefined) delete process.env.KANBAN_RUNTIME_PORT;
			else process.env.KANBAN_RUNTIME_PORT = previousRuntimePortEnvironment;
			await new Promise<void>((resolveClose, reject) =>
				server.close((error) => (error ? reject(error) : resolveClose())),
			);
		}
	});

	it("未声明接受协议的旧浏览器不获得自动预览，不能提前挂载后与新页面重复打开", async () => {
		const runtimeService = service();
		const received: TaskVisualizationPreviewRequestedMessage[] = [];
		await runtimeService.observeBrowserContext(
			"legacy",
			scope.workspaceId,
			{
				type: "declare_task_visualization_browser_context",
				browserPageId: randomUUID(),
				taskId: "task-a",
				isForeground: true,
				interactionSequence: 1,
			},
			(message) => received.push(message),
		);
		await publish(runtimeService);
		expect(received).toHaveLength(0);
	});

	it("未接受的旧 offer 可改派，跨请求、错误页面和迟到旧投递回执均无效", async () => {
		const runtimeService = service();
		const pages = await registerPages(runtimeService, 2);
		await publish(runtimeService);
		const stale = pages[1].messages[0];
		observedTime += 6000;
		await runtimeService.observeBrowserContext(
			pages[0].connection,
			scope.workspaceId,
			pages[0].declaration,
			(message) => pages[0].messages.push(message),
		);
		const current = pages[0].messages[0];
		await acknowledge(runtimeService, pages[1].connection, stale, "accepted");
		await acknowledge(
			runtimeService,
			pages[0].connection,
			{ ...current, deliveryAttemptId: stale.deliveryAttemptId },
			"accepted",
		);
		await acknowledge(
			runtimeService,
			pages[0].connection,
			{ ...current, browserPageId: pages[1].declaration.browserPageId },
			"accepted",
		);
		await acknowledge(runtimeService, pages[0].connection, { ...current, workspaceId: "workspace-b" }, "accepted");
		await acknowledge(
			runtimeService,
			pages[0].connection,
			{ ...current, previewRequest: { ...current.previewRequest, previewRequestId: randomUUID() } },
			"accepted",
		);
		expect(pages[0].messages).toHaveLength(1);
		await acknowledge(runtimeService, pages[0].connection, current, "displayed");
		expect(
			(await runtimeService.store.readRegistry(scope.workspaceId, "task-a")).previewRequests[0].displayedAtMs,
		).toBeNull();
		await acknowledge(runtimeService, pages[0].connection, current, "accepted");
		expect(pages[0].messages.at(-1)?.deliveryState).toBe("accepted");
	});

	it("失败释放后仅尝试其他页面，最多三次，持久保留失败原因", async () => {
		const runtimeService = service();
		const pages = await registerPages(runtimeService, 4);
		await publish(runtimeService);
		for (const page of pages.slice(1).reverse()) {
			const offer = page.messages[0];
			expect(offer.deliveryState).toBe("offered");
			await acknowledge(runtimeService, page.connection, offer, "accepted");
			await acknowledge(runtimeService, page.connection, offer, "failed");
		}
		const request = (await runtimeService.store.readRegistry(scope.workspaceId, "task-a")).previewRequests[0];
		expect(request).toMatchObject({ displayedAtMs: null, failedAtMs: observedTime, deliveryAttemptCount: 3 });
		expect(request.deliveryFailureReason).toContain("重试上限");
		expect(pages[0].messages).toHaveLength(0);
		observedTime += 60_000;
		await runtimeService.observeBrowserContext(
			pages[0].connection,
			scope.workspaceId,
			pages[0].declaration,
			(message) => pages[0].messages.push(message),
		);
		expect(pages[0].messages).toHaveLength(0);
	});

	it("接受后的超时先要求取消，未确认卸载时不得改派；迟到成功也不记展示", async () => {
		const runtimeService = service();
		const pages = await registerPages(runtimeService, 2);
		await publish(runtimeService);
		const offer = pages[1].messages[0];
		await acknowledge(runtimeService, pages[1].connection, offer, "accepted");
		observedTime += 45_001;
		await runtimeService.observeBrowserContext(
			pages[0].connection,
			scope.workspaceId,
			pages[0].declaration,
			(message) => pages[0].messages.push(message),
		);
		expect(pages[1].messages.at(-1)?.deliveryState).toBe("cancelled");
		expect(pages[0].messages).toHaveLength(0);
		await acknowledge(runtimeService, pages[1].connection, offer, "displayed");
		observedTime += 10_001;
		await runtimeService.observeBrowserContext(
			pages[0].connection,
			scope.workspaceId,
			pages[0].declaration,
			(message) => pages[0].messages.push(message),
		);
		const request = (await runtimeService.store.readRegistry(scope.workspaceId, "task-a")).previewRequests[0];
		expect(request.displayedAtMs).toBeNull();
		expect(request.failedAtMs).toBe(observedTime);
		expect(request.deliveryFailureReason).toContain("未确认取消");
		expect(pages[0].messages).toHaveLength(0);
	});

	it("接受页断线或运行时重建后保留失败事实，不把未知旧 frame 自动复制到另一页", async () => {
		const runtimeService = service();
		const pages = await registerPages(runtimeService, 2);
		const publication = await publish(runtimeService);
		await acknowledge(runtimeService, pages[1].connection, pages[1].messages[0], "accepted");
		runtimeService.forgetBrowserClient(pages[1].connection);
		await runtimeService.observeBrowserContext(
			pages[0].connection,
			scope.workspaceId,
			pages[0].declaration,
			(message) => pages[0].messages.push(message),
		);
		expect(pages[0].messages).toHaveLength(0);
		expect(
			(await runtimeService.store.readRegistry(scope.workspaceId, "task-a")).previewRequests[0]
				.deliveryFailureReason,
		).toContain("断开连接");
		await runtimeService.requestPreview(scope, {
			taskId: "task-a",
			visualizationArtifactId: publication.artifact.visualizationArtifactId,
		});
		await acknowledge(runtimeService, pages[0].connection, pages[0].messages[0], "accepted");
		const restarted = service();
		const newPages = await registerPages(restarted, 1);
		expect(newPages[0].messages).toHaveLength(0);
		const latest = (await restarted.store.readRegistry(scope.workspaceId, "task-a")).previewRequests.at(-1);
		expect(latest?.displayedAtMs).toBeNull();
		expect(latest?.deliveryFailureReason).toContain("重启");
	});

	it("未投递的持久包由恢复扫描接受，重复扫描不增加版本", async () => {
		await stageTaskVisualizationPublication({
			runtimeHomeDirectoryPath: runtimeHome,
			workspaceId: scope.workspaceId,
			workspaceRepositoryPath: scope.workspacePath,
			taskId: "task-a",
			title: "恢复图表",
			sourceHtmlFilePath: join(sourceDirectory, "chart.html"),
		});
		const restarted = service();
		await restarted.recoverPendingPublications();
		await restarted.recoverPendingPublications();
		expect((await restarted.list(scope, { taskId: "task-a" })).artifacts.map((entry) => entry.versionNumber)).toEqual(
			[1],
		);
	});

	it("确定性拒绝持久保留，跨运行时扫描也不再尝试接受", async () => {
		const pending = await stageTaskVisualizationPublication({
			runtimeHomeDirectoryPath: runtimeHome,
			workspaceId: scope.workspaceId,
			workspaceRepositoryPath: scope.workspacePath,
			taskId: "task-a",
			title: "已结束任务的图表",
			sourceHtmlFilePath: join(sourceDirectory, "chart.html"),
		});
		const assertTaskMayPublish = vi.fn(async () => {
			throw new TRPCError({ code: "FORBIDDEN", message: "Done 任务只允许读取已有可视化。" });
		});
		const createRejectingService = () =>
			new TaskVisualizationArtifactService({
				store: new TaskVisualizationArtifactStore(runtimeHome),
				resolveWorkspaceScope: async () => scope,
				assertTaskMayPublish,
				resolveTaskTitle: async () => "任务名",
				onArtifactsUpdated: () => {},
				warn: () => {},
				now: () => observedTime,
			});
		await createRejectingService().recoverPendingPublications();
		observedTime += 600_000;
		await createRejectingService().recoverPendingPublications();
		expect(assertTaskMayPublish).toHaveBeenCalledTimes(1);
		const rejectionPath = join(pending.pendingPublicationDirectoryPath, "runtime-acceptance-rejection.json");
		const firstRejectionEvidence = await readFile(rejectionPath, "utf8");
		expect(JSON.parse(firstRejectionEvidence)).toMatchObject({
			publicationRequestId: pending.publicationRequestId,
			failureCode: "FORBIDDEN",
			failure: "Done 任务只允许读取已有可视化。",
		});
		await expect(
			readFile(join(pending.pendingPublicationDirectoryPath, "accepted-artifact.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			service().publish(scope, { taskId: "task-a", publicationRequestId: pending.publicationRequestId }),
		).rejects.toThrow("Done 任务");
		await expect(
			new TaskVisualizationArtifactStore(runtimeHome).acceptPublication(
				scope.workspaceId,
				scope.workspacePath,
				pending.publicationRequestId,
			),
		).rejects.toThrow("Done 任务");
		expect(await readFile(rejectionPath, "utf8")).toBe(firstRejectionEvidence);
	});

	it("暂时性错误仍可恢复，恢复成功后保留原失败证据", async () => {
		const pending = await stageTaskVisualizationPublication({
			runtimeHomeDirectoryPath: runtimeHome,
			workspaceId: scope.workspaceId,
			workspaceRepositoryPath: scope.workspacePath,
			taskId: "task-a",
			title: "暂时等待的图表",
			sourceHtmlFilePath: join(sourceDirectory, "chart.html"),
		});
		const store = new TaskVisualizationArtifactStore(runtimeHome);
		const acceptPublication = vi.spyOn(store, "acceptPublication");
		acceptPublication.mockRejectedValueOnce(
			new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "暂时 I/O 失败" }),
		);
		const runtimeService = new TaskVisualizationArtifactService({
			store,
			resolveWorkspaceScope: async () => scope,
			assertTaskMayPublish: async () => {},
			resolveTaskTitle: async () => "任务名",
			onArtifactsUpdated: () => {},
			warn: () => {},
			now: () => observedTime,
		});
		await runtimeService.recoverPendingPublications();
		const failurePath = join(pending.pendingPublicationDirectoryPath, "latest-runtime-acceptance-failure.json");
		expect(await readFile(failurePath, "utf8")).toContain("暂时 I/O 失败");
		await expect(
			readFile(join(pending.pendingPublicationDirectoryPath, "runtime-acceptance-rejection.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
		observedTime += 16_000;
		await runtimeService.recoverPendingPublications();
		expect((await runtimeService.list(scope, { taskId: "task-a" })).artifacts).toHaveLength(1);
		expect(await readFile(failurePath, "utf8")).toContain("暂时 I/O 失败");
	});
});
