import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stageTaskVisualizationPublication } from "../../../src/task-visualization-artifacts/stage-task-visualization-publication";
import { TaskVisualizationArtifactService } from "../../../src/task-visualization-artifacts/task-visualization-artifact-service";
import { TaskVisualizationArtifactStore } from "../../../src/task-visualization-artifacts/task-visualization-artifact-store";
import {
	applyTaskAttributionToHtmlFile,
	renderHtmlWithTaskAttribution,
} from "../../../src/task-visualization-artifacts/task-visualization-html-task-attribution";
import { taskVisualizationPublicationMaximumFileSizeBytes } from "../../../src/task-visualization-artifacts/task-visualization-publication-resource-limits";

// 生产限额保持 50MiB；以相同控制路径的小限额覆盖逐字节边界，避免每个用例解析大文件。
vi.mock(
	"../../../src/task-visualization-artifacts/task-visualization-publication-resource-limits",
	async (original) => ({
		...(await original<Record<string, unknown>>()),
		taskVisualizationPublicationMaximumFileSizeBytes: 2048,
	}),
);

const taskAttribution = { workspaceId: "workspace-a", taskId: "491af", taskTitle: "边界任务" };
const originalPageSuffix = "<main>KEEP</main><script>globalThis.ready=true</script></body>";
let isolatedTestRootDirectoryPath: string;
let sourceHtmlFilePath: string;
let isolatedRuntimeHomeDirectoryPath: string;
beforeEach(async () => {
	isolatedTestRootDirectoryPath = await mkdtemp(join(tmpdir(), "task-visualization-attribution-size-boundaries-"));
	sourceHtmlFilePath = join(isolatedTestRootDirectoryPath, "chart.html");
	isolatedRuntimeHomeDirectoryPath = join(isolatedTestRootDirectoryPath, "isolated-runtime-home");
});
afterEach(async () => {
	await rm(isolatedTestRootDirectoryPath, { recursive: true, force: true });
});

function createHtmlDocumentWithExactUtf8ByteSize(sizeBytes: number): string {
	const prefix = "<body><!--";
	const suffix = `-->${originalPageSuffix}`;
	return prefix + "a".repeat(sizeBytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function stageIsolatedHtmlPublication() {
	return stageTaskVisualizationPublication({
		runtimeHomeDirectoryPath: isolatedRuntimeHomeDirectoryPath,
		workspaceId: taskAttribution.workspaceId,
		workspaceRepositoryPath: isolatedTestRootDirectoryPath,
		taskId: taskAttribution.taskId,
		title: "边界图表",
		sourceHtmlFilePath,
	});
}

function renderedTaskAttributionUtf8ByteSize(): number {
	return Buffer.byteLength(renderHtmlWithTaskAttribution("<body></body>", taskAttribution)) - "<body></body>".length;
}

it("含署名恰好达到单文件上限时，本地重复调用和发布重试均成功，正文与脚本不变", async () => {
	const html = createHtmlDocumentWithExactUtf8ByteSize(
		taskVisualizationPublicationMaximumFileSizeBytes - renderedTaskAttributionUtf8ByteSize(),
	);
	await writeFile(sourceHtmlFilePath, html);
	expect(await applyTaskAttributionToHtmlFile(sourceHtmlFilePath, taskAttribution)).toMatchObject({
		didUpdateHtml: true,
	});
	const savedAttributedHtml = await readFile(sourceHtmlFilePath, "utf8");
	expect(Buffer.byteLength(savedAttributedHtml)).toBe(taskVisualizationPublicationMaximumFileSizeBytes);
	expect(savedAttributedHtml).toContain(originalPageSuffix);
	expect(await applyTaskAttributionToHtmlFile(sourceHtmlFilePath, taskAttribution)).toMatchObject({
		didUpdateHtml: false,
	});
	const staged = await stageIsolatedHtmlPublication();
	expect(staged.files[0].sizeBytes).toBe(taskVisualizationPublicationMaximumFileSizeBytes);
	expect(await readFile(join(staged.pendingPublicationDirectoryPath, "files", "chart.html"), "utf8")).toBe(
		savedAttributedHtml,
	);
	const artifactStore = new TaskVisualizationArtifactStore(isolatedRuntimeHomeDirectoryPath);
	const acceptedPublication = await artifactStore.acceptPublication(
		taskAttribution.workspaceId,
		isolatedTestRootDirectoryPath,
		staged.publicationRequestId,
		taskAttribution.taskTitle,
	);
	expect((await artifactStore.readRevisionFile(acceptedPublication.artifact, "chart.html")).content.toString()).toBe(
		savedAttributedHtml,
	);
	expect(
		await artifactStore.acceptPublication(
			taskAttribution.workspaceId,
			isolatedTestRootDirectoryPath,
			staged.publicationRequestId,
			taskAttribution.taskTitle,
		),
	).toMatchObject({ isNewRevision: false });
});

it.each(["署名后超过一个字节", "原文件恰好达到上限", "原文件已超过上限"])(
	"%s 时在写入前拒绝，重复调用仍完整保留原文件",
	async (boundary) => {
		const sizeBytes =
			boundary === "署名后超过一个字节"
				? taskVisualizationPublicationMaximumFileSizeBytes - renderedTaskAttributionUtf8ByteSize() + 1
				: taskVisualizationPublicationMaximumFileSizeBytes + (boundary === "原文件已超过上限" ? 1 : 0);
		const original = createHtmlDocumentWithExactUtf8ByteSize(sizeBytes);
		await writeFile(sourceHtmlFilePath, original, { mode: 0o600 });
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(applyTaskAttributionToHtmlFile(sourceHtmlFilePath, taskAttribution)).rejects.toThrow("50MB");
			expect(await readFile(sourceHtmlFilePath, "utf8")).toBe(original);
			expect((await stat(sourceHtmlFilePath)).mode & 0o777).toBe(0o600);
		}
	},
);

it("改名按 UTF-8 字节计算输出限额，超限时保留上一次完整署名", async () => {
	await writeFile(
		sourceHtmlFilePath,
		createHtmlDocumentWithExactUtf8ByteSize(
			taskVisualizationPublicationMaximumFileSizeBytes - renderedTaskAttributionUtf8ByteSize(),
		),
	);
	await applyTaskAttributionToHtmlFile(sourceHtmlFilePath, taskAttribution);
	const original = await readFile(sourceHtmlFilePath, "utf8");
	await expect(
		applyTaskAttributionToHtmlFile(sourceHtmlFilePath, {
			...taskAttribution,
			taskTitle: `${taskAttribution.taskTitle}新`,
		}),
	).rejects.toThrow("50MB");
	expect(await readFile(sourceHtmlFilePath, "utf8")).toBe(original);
});

it("stage 使用同一单文件限额，超过一个字节时拒绝并保留源文件", async () => {
	const original = createHtmlDocumentWithExactUtf8ByteSize(taskVisualizationPublicationMaximumFileSizeBytes + 1);
	await writeFile(sourceHtmlFilePath, original);
	await expect(stageIsolatedHtmlPublication()).rejects.toThrow("单文件 50MB");
	expect(await readFile(sourceHtmlFilePath, "utf8")).toBe(original);
});

it("离线固化的临界原文件在运行时补署名时明确拒绝，保留包证据与原文", async () => {
	const original = createHtmlDocumentWithExactUtf8ByteSize(taskVisualizationPublicationMaximumFileSizeBytes);
	await writeFile(sourceHtmlFilePath, original);
	const staged = await stageIsolatedHtmlPublication();
	const artifactStore = new TaskVisualizationArtifactStore(isolatedRuntimeHomeDirectoryPath);
	const scope = { workspaceId: taskAttribution.workspaceId, workspacePath: isolatedTestRootDirectoryPath };
	const artifactService = new TaskVisualizationArtifactService({
		store: artifactStore,
		resolveWorkspaceScope: async () => scope,
		assertTaskMayPublish: async () => {},
		resolveTaskTitle: async () => taskAttribution.taskTitle,
		onArtifactsUpdated: () => {},
		warn: () => {},
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		await expect(
			artifactService.publish(scope, {
				taskId: taskAttribution.taskId,
				publicationRequestId: staged.publicationRequestId,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	}
	expect(await artifactStore.readPublicationRejection(staged.publicationRequestId)).toMatchObject({
		failureCode: "BAD_REQUEST",
	});
	expect(await readFile(sourceHtmlFilePath, "utf8")).toBe(original);
	expect(await readFile(join(staged.pendingPublicationDirectoryPath, "files", "chart.html"), "utf8")).toBe(original);
	expect(await artifactStore.list(taskAttribution.workspaceId, taskAttribution.taskId)).toEqual([]);
});
