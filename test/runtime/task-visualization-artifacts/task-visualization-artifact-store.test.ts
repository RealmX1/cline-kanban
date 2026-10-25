import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type StageTaskVisualizationPublicationInput,
	stagedTaskVisualizationPublicationSchema,
	stageTaskVisualizationPublication,
} from "../../../src/task-visualization-artifacts/stage-task-visualization-publication";
import { TaskVisualizationArtifactStore } from "../../../src/task-visualization-artifacts/task-visualization-artifact-store";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "../../integration/runtime-integration-test-spawned-child-process-lifecycle";

let testRootDirectoryPath: string;
let runtimeHomeDirectoryPath: string;
let sourceDirectoryPath: string;
const spawnedStagingProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

beforeEach(async () => {
	testRootDirectoryPath = await mkdtemp(join(tmpdir(), "task-visualization-artifacts-"));
	runtimeHomeDirectoryPath = join(testRootDirectoryPath, "isolated-runtime-home");
	sourceDirectoryPath = join(testRootDirectoryPath, "source-with-中文 空格");
	await mkdir(sourceDirectoryPath);
	await writeFile(join(sourceDirectoryPath, "图表.html"), '<script src="assets/chart.js"></script>');
	await mkdir(join(sourceDirectoryPath, "assets"));
	await writeFile(join(sourceDirectoryPath, "assets/chart.js"), "window.chartLoaded = true;");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await spawnedStagingProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
	await rm(testRootDirectoryPath, { recursive: true, force: true });
});

function stagePublication(
	workspaceId = "workspace-a",
	taskId = "same-task-id",
	previewRequestMode: StageTaskVisualizationPublicationInput["previewRequestMode"] = "on_first_publication",
) {
	return stageTaskVisualizationPublication({
		runtimeHomeDirectoryPath,
		workspaceId,
		workspaceRepositoryPath: sourceDirectoryPath,
		taskId,
		title: "交互图表",
		sourceHtmlFilePath: join(sourceDirectoryPath, "图表.html"),
		previewRequestMode,
		resourceMappings: [{ bundleRelativePath: "assets", sourcePath: join(sourceDirectoryPath, "assets") }],
	});
}

describe("任务可视化持久发布", () => {
	it("发布包独立于源目录，接受与重启重读幂等，资源保持相对路径", async () => {
		const pending = await stagePublication();
		await rm(sourceDirectoryPath, { recursive: true });
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		const accepted = await store.acceptPublication("workspace-a", sourceDirectoryPath, pending.publicationRequestId);
		expect(accepted.artifact.title).toBe("交互图表");
		expect(accepted.artifact.versionNumber).toBe(1);
		expect(accepted.isNewRevision).toBe(true);
		const restarted = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		expect(await restarted.list("workspace-a", "same-task-id")).toEqual([accepted.artifact]);
		expect(
			(await restarted.acceptPublication("workspace-a", sourceDirectoryPath, pending.publicationRequestId))
				.isNewRevision,
		).toBe(false);
		expect((await restarted.readRevisionFile(accepted.artifact, "assets/chart.js")).content.toString()).toContain(
			"chartLoaded",
		);
		expect(await restarted.list("workspace-b", "same-task-id")).toEqual([]);
	});

	it("新版本只在完整发布后替换，旧版本仍可读取", async () => {
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		const first = await stagePublication();
		const previous = (await store.acceptPublication("workspace-a", sourceDirectoryPath, first.publicationRequestId))
			.artifact;
		await writeFile(join(sourceDirectoryPath, "图表.html"), "<h1>第二版</h1>");
		const second = await stagePublication();
		expect((await store.list("workspace-a", "same-task-id"))[0].revisionId).toBe(previous.revisionId);
		const current = (await store.acceptPublication("workspace-a", sourceDirectoryPath, second.publicationRequestId))
			.artifact;
		expect(current.versionNumber).toBe(2);
		expect((await store.readRevisionFile(previous, previous.entryHtmlRelativePath)).content.toString()).toContain(
			"chart.js",
		);
		expect((await store.readRevisionFile(current, current.entryHtmlRelativePath)).content.toString()).toContain(
			"第二版",
		);
	});

	it("较早固化的离线包迟到时不会回滚已经接受的新内容", async () => {
		const older = await stagePublication();
		const olderManifestPath = join(older.pendingPublicationDirectoryPath, "publication.json");
		const olderManifest = JSON.parse(await readFile(olderManifestPath, "utf8"));
		olderManifest.stagedAtMs -= 60_000;
		await writeFile(olderManifestPath, JSON.stringify(olderManifest));
		await writeFile(join(sourceDirectoryPath, "图表.html"), "<h1>较新的内容</h1>");
		const newer = await stagePublication();
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		const current = (await store.acceptPublication("workspace-a", sourceDirectoryPath, newer.publicationRequestId))
			.artifact;
		const late = await store.acceptPublication("workspace-a", sourceDirectoryPath, older.publicationRequestId);
		expect(late.wasSupersededByNewerPublication).toBe(true);
		expect((await store.list("workspace-a", "same-task-id"))[0].revisionId).toBe(current.revisionId);
		expect(
			(await store.acceptPublication("workspace-a", sourceDirectoryPath, older.publicationRequestId))
				.wasSupersededByNewerPublication,
		).toBe(true);
	});

	it("同毫秒先后固化的包反序接受，重启后也不会回滚", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const older = await stagePublication();
		await writeFile(join(sourceDirectoryPath, "图表.html"), "<h1>同毫秒的新内容</h1>");
		const newer = await stagePublication();
		expect(older.stagedAtMs).toBe(newer.stagedAtMs);
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		const accepted = await store.acceptPublication("workspace-a", sourceDirectoryPath, newer.publicationRequestId);
		const restarted = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		const late = await restarted.acceptPublication("workspace-a", sourceDirectoryPath, older.publicationRequestId);
		expect(late.wasSupersededByNewerPublication).toBe(true);
		expect(await restarted.list("workspace-a", "same-task-id")).toEqual([accepted.artifact]);
	});

	it("未变化内容的每个新 always 请求都生成预览，同请求重试不重复", async () => {
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		const first = await stagePublication("workspace-a", "same-task-id", "always");
		const initial = await store.acceptPublication("workspace-a", sourceDirectoryPath, first.publicationRequestId);
		const second = await stagePublication("workspace-a", "same-task-id", "always");
		const unchanged = await store.acceptPublication("workspace-a", sourceDirectoryPath, second.publicationRequestId);
		expect(unchanged.isNewRevision).toBe(false);
		expect(unchanged.artifact.versionNumber).toBe(initial.artifact.versionNumber);
		expect((await store.readRegistry("workspace-a", "same-task-id")).previewRequests).toHaveLength(2);
		const restarted = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		await restarted.acceptPublication("workspace-a", sourceDirectoryPath, first.publicationRequestId);
		await restarted.acceptPublication("workspace-a", sourceDirectoryPath, second.publicationRequestId);
		expect((await restarted.readRegistry("workspace-a", "same-task-id")).previewRequests).toHaveLength(2);
		await rm(join(second.pendingPublicationDirectoryPath, "accepted-artifact.json"));
		await restarted.acceptPublication("workspace-a", sourceDirectoryPath, second.publicationRequestId);
		expect((await restarted.readRegistry("workspace-a", "same-task-id")).previewRequests).toHaveLength(2);
	});

	it.each(["on_first_publication", "never"] as const)(
		"%s 在内容未变化或后续版本发布时保持原有预览语义",
		async (previewRequestMode) => {
			const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
			for (let publicationIndex = 0; publicationIndex < 3; publicationIndex += 1) {
				if (publicationIndex === 2) await writeFile(join(sourceDirectoryPath, "图表.html"), "<h1>后续版本</h1>");
				const pending = await stagePublication("workspace-a", "same-task-id", previewRequestMode);
				await store.acceptPublication("workspace-a", sourceDirectoryPath, pending.publicationRequestId);
			}
			expect((await store.readRegistry("workspace-a", "same-task-id")).previewRequests).toHaveLength(
				previewRequestMode === "on_first_publication" ? 1 : 0,
			);
		},
	);

	it.each([
		[999, true],
		[1000, true],
		[1001, false],
	])("旧 schema 包的时间戳 %d 按兼容规则处理且回执可重读", async (stagedAtMs, wasSuperseded) => {
		const current = await stagePublication();
		const currentManifestPath = join(current.pendingPublicationDirectoryPath, "publication.json");
		const currentManifest = JSON.parse(await readFile(currentManifestPath, "utf8"));
		delete currentManifest.publicationStagingSequence;
		currentManifest.stagedAtMs = 1000;
		await writeFile(currentManifestPath, JSON.stringify(currentManifest));
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		await store.acceptPublication("workspace-a", sourceDirectoryPath, current.publicationRequestId);
		await writeFile(join(sourceDirectoryPath, "图表.html"), "<h1>旧 schema 的其他内容</h1>");
		const incoming = await stagePublication();
		const incomingManifestPath = join(incoming.pendingPublicationDirectoryPath, "publication.json");
		const incomingManifest = JSON.parse(await readFile(incomingManifestPath, "utf8"));
		delete incomingManifest.publicationStagingSequence;
		incomingManifest.stagedAtMs = stagedAtMs;
		await writeFile(incomingManifestPath, JSON.stringify(incomingManifest));
		const restarted = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		const result = await restarted.acceptPublication(
			"workspace-a",
			sourceDirectoryPath,
			incoming.publicationRequestId,
		);
		expect(result.wasSupersededByNewerPublication).toBe(wasSuperseded);
		expect((await restarted.list("workspace-a", "same-task-id"))[0].revisionId).toBe(
			wasSuperseded ? current.revisionId : incoming.revisionId,
		);
		expect(
			(await restarted.acceptPublication("workspace-a", sourceDirectoryPath, incoming.publicationRequestId))
				.wasSupersededByNewerPublication,
		).toBe(wasSuperseded);
	});

	it("独立发布进程并发固化时共享全序，后续进程重启不复用序号", async (testContext) => {
		const publicationModuleUrl = new URL(
			"../../../src/task-visualization-artifacts/stage-task-visualization-publication.ts",
			import.meta.url,
		);
		async function stageInIndependentProcess(sourceHtmlFilePath: string) {
			const input: StageTaskVisualizationPublicationInput = {
				runtimeHomeDirectoryPath,
				workspaceId: "workspace-a",
				workspaceRepositoryPath: sourceDirectoryPath,
				taskId: "same-task-id",
				title: "独立进程发布",
				sourceHtmlFilePath,
				visualizationArtifactKey: "shared-concurrent-visualization",
			};
			const childSource = `
import { stageTaskVisualizationPublication } from ${JSON.stringify(publicationModuleUrl.href)};
Date.now = () => 1700000000000;
const publication = await stageTaskVisualizationPublication(${JSON.stringify(input)});
process.stdout.write(JSON.stringify(publication));
`;
			const child = spawnedStagingProcesses.register(
				spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
					cwd: fileURLToPath(new URL("../../../", import.meta.url)),
					env: { PATH: process.env.PATH, HOME: testRootDirectoryPath },
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const closed = new Promise<void>((resolveClosed, rejectClosed) => {
				child.once("close", () => resolveClosed());
				child.once("error", rejectClosed);
			});
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, {
				waitedForDescription: "独立发布进程持久固化后退出",
				softDeadlineMsExpectedOnUncontendedHost: 5_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
			});
			await closed;
			expect(child.exitCode, stderr).toBe(0);
			return stagedTaskVisualizationPublicationSchema.parse(JSON.parse(stdout));
		}
		const first = await stageInIndependentProcess(join(sourceDirectoryPath, "图表.html"));
		expect(first.publicationStagingSequence).toBe(1);
		const concurrentPublications = await Promise.all(
			Array.from({ length: 4 }, async (_, index) => {
				const sourceHtmlFilePath = join(sourceDirectoryPath, `并发-${index}.html`);
				await writeFile(sourceHtmlFilePath, `<h1>独立内容 ${index}</h1>`);
				return await stageInIndependentProcess(sourceHtmlFilePath);
			}),
		);
		expect(concurrentPublications.map((publication) => publication.publicationStagingSequence).sort()).toEqual([
			2, 3, 4, 5,
		]);
		const last = await stageInIndependentProcess(join(sourceDirectoryPath, "图表.html"));
		expect(last.publicationStagingSequence).toBe(6);
		expect([first, ...concurrentPublications, last].map((publication) => publication.stagedAtMs)).toEqual(
			Array(6).fill(first.stagedAtMs),
		);
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		await store.acceptPublication("workspace-a", sourceDirectoryPath, last.publicationRequestId);
		for (const pending of [...concurrentPublications, first]) {
			expect(
				(await store.acceptPublication("workspace-a", sourceDirectoryPath, pending.publicationRequestId))
					.wasSupersededByNewerPublication,
			).toBe(true);
		}
		expect((await store.list("workspace-a", "same-task-id"))[0].latestSourcePublicationStagingSequence).toBe(6);
	}, 110_000);

	it("拒绝跨项目接受和资源路径穿越", async () => {
		const pending = await stagePublication();
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		await expect(
			store.acceptPublication("workspace-b", sourceDirectoryPath, pending.publicationRequestId),
		).rejects.toThrow("归属");
		const artifact = (await store.acceptPublication("workspace-a", sourceDirectoryPath, pending.publicationRequestId))
			.artifact;
		await expect(store.readRevisionFile(artifact, "../manifest.json")).rejects.toThrow();
		await expect(store.readRevisionFile(artifact, "/etc/passwd")).rejects.toThrow();
	});

	it("显式 vendor 软链根可打包，根内部逃逸的软链被拒绝", async () => {
		const vendorDirectory = join(testRootDirectoryPath, "vendor-source");
		await mkdir(vendorDirectory);
		await writeFile(join(vendorDirectory, "library.js"), "window.libraryLoaded = true;");
		await symlink(vendorDirectory, join(sourceDirectoryPath, "vendor"));
		const request = {
			runtimeHomeDirectoryPath,
			workspaceId: "workspace-a",
			workspaceRepositoryPath: sourceDirectoryPath,
			taskId: "task-a",
			title: "vendor",
			sourceHtmlFilePath: join(sourceDirectoryPath, "图表.html"),
			resourceMappings: [{ bundleRelativePath: "vendor", sourcePath: join(sourceDirectoryPath, "vendor") }],
		};
		const pending = await stageTaskVisualizationPublication(request);
		expect(pending.files.some((file) => file.bundleRelativePath === "vendor/library.js")).toBe(true);
		await symlink(join(sourceDirectoryPath, "图表.html"), join(vendorDirectory, "escaped.html"));
		await expect(stageTaskVisualizationPublication(request)).rejects.toThrow("软链");
	});

	it("被篡改的发布包不能覆盖当前版本", async () => {
		const pending = await stagePublication();
		await writeFile(
			join(pending.pendingPublicationDirectoryPath, "files", pending.entryHtmlRelativePath),
			"tampered",
		);
		const store = new TaskVisualizationArtifactStore(runtimeHomeDirectoryPath);
		await expect(
			store.acceptPublication("workspace-a", sourceDirectoryPath, pending.publicationRequestId),
		).rejects.toThrow("校验");
		expect(await store.list("workspace-a", "same-task-id")).toEqual([]);
		expect(await readFile(join(pending.pendingPublicationDirectoryPath, "publication.json"), "utf8")).toContain(
			pending.publicationRequestId,
		);
	});
});
