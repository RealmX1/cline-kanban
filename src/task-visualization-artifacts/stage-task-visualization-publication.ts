import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	taskVisualizationArtifactIdentifierSchema,
	taskVisualizationPublicationStagingSequenceSchema,
	taskVisualizationRelativePathSchema,
} from "../core/task-visualization-artifact-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	hashTaskVisualizationIdentity,
	pendingTaskVisualizationPublicationDirectory,
	taskVisualizationPublicationStagingSequencePath,
} from "./task-visualization-artifact-storage-paths";
import { taskVisualizationPublicationMaximumFileSizeBytes } from "./task-visualization-publication-resource-limits";

export const stagedTaskVisualizationPublicationSchema = z.object({
	publicationRequestId: z.string().uuid(),
	workspaceId: z.string().min(1),
	workspaceRepositoryPath: z.string().min(1),
	taskId: z.string().min(1),
	title: z.string().min(1).max(200),
	taskTitleAtPublication: z.string().min(1).optional(),
	visualizationArtifactId: taskVisualizationArtifactIdentifierSchema,
	entryHtmlRelativePath: taskVisualizationRelativePathSchema,
	revisionId: taskVisualizationArtifactIdentifierSchema,
	sourceConversationSessionId: z.string().nullable(),
	previewRequestMode: z.enum(["on_first_publication", "always", "never"]),
	stagedAtMs: z.number(),
	publicationStagingSequence: taskVisualizationPublicationStagingSequenceSchema.optional(),
	files: z
		.array(
			z.object({
				bundleRelativePath: taskVisualizationRelativePathSchema,
				sha256: taskVisualizationArtifactIdentifierSchema,
				sizeBytes: z.number().int().nonnegative(),
			}),
		)
		.min(1)
		.max(10_000),
});
export type StagedTaskVisualizationPublication = z.infer<typeof stagedTaskVisualizationPublicationSchema>;
export interface StageTaskVisualizationPublicationInput {
	runtimeHomeDirectoryPath?: string;
	workspaceId: string;
	workspaceRepositoryPath: string;
	taskId: string;
	title: string;
	taskTitleAtPublication?: string;
	sourceHtmlFilePath: string;
	sourceRootDirectoryPath?: string;
	visualizationArtifactKey?: string;
	sourceConversationSessionId?: string | null;
	previewRequestMode?: StagedTaskVisualizationPublication["previewRequestMode"];
	resourceMappings?: { bundleRelativePath: string; sourcePath: string }[];
}

function isContainedInRoot(root: string, file: string): boolean {
	const child = relative(root, file);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

export async function stageTaskVisualizationPublication(
	input: StageTaskVisualizationPublicationInput,
): Promise<StagedTaskVisualizationPublication & { pendingPublicationDirectoryPath: string }> {
	const sourceHtmlFilePath = await realpath(resolve(input.sourceHtmlFilePath));
	if (![".html", ".htm"].includes(extname(sourceHtmlFilePath).toLowerCase()))
		throw new Error("入口必须是 HTML 文件。");
	const sourceRoot = await realpath(resolve(input.sourceRootDirectoryPath ?? dirname(sourceHtmlFilePath)));
	if (!isContainedInRoot(sourceRoot, sourceHtmlFilePath)) throw new Error("HTML 入口超出声明的源根目录。");
	const entryHtmlRelativePath = taskVisualizationRelativePathSchema.parse(
		relative(sourceRoot, sourceHtmlFilePath).split(sep).join("/"),
	);
	const publicationRequestId = randomUUID();
	const pendingPublicationDirectoryPath = pendingTaskVisualizationPublicationDirectory(
		input.runtimeHomeDirectoryPath ?? getRuntimeHomePath(),
		publicationRequestId,
	);
	const stagingDirectoryPath = `${pendingPublicationDirectoryPath}.being-written`;
	const files: StagedTaskVisualizationPublication["files"] = [];
	const seenPaths = new Set<string>();
	const visitedDirectoryAncestors = new Set<string>();
	let visitedResourceEntryCount = 0;
	let totalBytes = 0;
	await mkdir(join(stagingDirectoryPath, "files"), { recursive: true, mode: 0o700 });
	const copyDeclaredResource = async (
		sourcePath: string,
		bundleRelativePath: string,
		declaredRealRoot: string,
	): Promise<void> => {
		const validPath = taskVisualizationRelativePathSchema.parse(bundleRelativePath);
		if (++visitedResourceEntryCount > 10_000) throw new Error("可视化资源目录超过 10000 项限额。");
		const canonicalSource = await realpath(sourcePath);
		if (!isContainedInRoot(declaredRealRoot, canonicalSource))
			throw new Error(`资源软链超出声明根目录：${validPath}`);
		const sourceStat = await stat(canonicalSource);
		if (sourceStat.isDirectory()) {
			if (visitedDirectoryAncestors.has(canonicalSource)) throw new Error(`资源软链形成目录循环：${validPath}`);
			visitedDirectoryAncestors.add(canonicalSource);
			try {
				for (const child of (await readdir(canonicalSource)).sort())
					await copyDeclaredResource(join(canonicalSource, child), `${validPath}/${child}`, declaredRealRoot);
			} finally {
				visitedDirectoryAncestors.delete(canonicalSource);
			}
			return;
		}
		if (!sourceStat.isFile()) throw new Error(`资源不是普通文件：${validPath}`);
		if (seenPaths.has(validPath)) throw new Error(`资源映射重复：${validPath}`);
		if (
			sourceStat.size > taskVisualizationPublicationMaximumFileSizeBytes ||
			totalBytes + sourceStat.size > 100 * 1024 * 1024 ||
			files.length >= 10_000
		)
			throw new Error("可视化发布包超过资源限额（单文件 50MB、总计 100MB、10000 个文件）。");
		const handle = await open(canonicalSource, constants.O_RDONLY | constants.O_NOFOLLOW);
		let content: Buffer;
		try {
			const before = await handle.stat();
			content = await handle.readFile();
			const after = await handle.stat();
			if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || content.length !== before.size)
				throw new Error(`资源在打包时变化，请重试：${validPath}`);
		} finally {
			await handle.close();
		}
		const destination = join(stagingDirectoryPath, "files", ...validPath.split("/"));
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await writeFile(destination, content, { mode: 0o600, flag: "wx" });
		files.push({
			bundleRelativePath: validPath,
			sha256: hashTaskVisualizationIdentity(content),
			sizeBytes: content.length,
		});
		seenPaths.add(validPath);
		totalBytes += content.length;
	};
	try {
		await copyDeclaredResource(sourceHtmlFilePath, entryHtmlRelativePath, sourceRoot);
		for (const mapping of input.resourceMappings ?? []) {
			const resourceRoot = await realpath(resolve(mapping.sourcePath));
			await copyDeclaredResource(resourceRoot, mapping.bundleRelativePath, resourceRoot);
		}
		files.sort((left, right) => left.bundleRelativePath.localeCompare(right.bundleRelativePath));
		const stagingSequencePath = taskVisualizationPublicationStagingSequencePath(
			input.runtimeHomeDirectoryPath ?? getRuntimeHomePath(),
			input.workspaceId,
			input.taskId,
		);
		return await lockedFileSystem.withLock({ path: stagingSequencePath }, async () => {
			let latestAssignedPublicationStagingSequence = 0;
			try {
				latestAssignedPublicationStagingSequence = taskVisualizationPublicationStagingSequenceSchema.parse(
					JSON.parse(await readFile(stagingSequencePath, "utf8")),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const publication = stagedTaskVisualizationPublicationSchema.parse({
				publicationRequestId,
				workspaceId: input.workspaceId,
				workspaceRepositoryPath: resolve(input.workspaceRepositoryPath),
				taskId: input.taskId,
				title: input.title,
				taskTitleAtPublication: input.taskTitleAtPublication,
				visualizationArtifactId: hashTaskVisualizationIdentity(
					input.visualizationArtifactKey ?? sourceHtmlFilePath,
				),
				entryHtmlRelativePath,
				revisionId: hashTaskVisualizationIdentity(JSON.stringify({ entryHtmlRelativePath, files })),
				sourceConversationSessionId: input.sourceConversationSessionId ?? null,
				previewRequestMode: input.previewRequestMode ?? "on_first_publication",
				stagedAtMs: Date.now(),
				publicationStagingSequence: latestAssignedPublicationStagingSequence + 1,
				files,
			});
			// 先持久占用序号，再在同一把跨进程锁内固化清单；中断只留下空号，重启不会复用顺序。
			await lockedFileSystem.writeJsonFileAtomic(stagingSequencePath, publication.publicationStagingSequence, {
				lock: null,
			});
			await writeFile(join(stagingDirectoryPath, "publication.json"), JSON.stringify(publication), {
				mode: 0o600,
				flag: "wx",
			});
			await rename(stagingDirectoryPath, pendingPublicationDirectoryPath);
			return { ...publication, pendingPublicationDirectoryPath };
		});
	} catch (error) {
		await rm(stagingDirectoryPath, { recursive: true, force: true });
		throw error;
	}
}
