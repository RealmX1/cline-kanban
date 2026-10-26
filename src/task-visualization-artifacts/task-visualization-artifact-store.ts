import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	type TaskVisualizationArtifact,
	taskVisualizationArtifactSchema,
	taskVisualizationPreviewRequestSchema,
	taskVisualizationPublicationRejectionCodeSchema,
	taskVisualizationPublicationRequestIdSchema,
	taskVisualizationRelativePathSchema,
} from "../core/task-visualization-artifact-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	type StagedTaskVisualizationPublication,
	stagedTaskVisualizationPublicationSchema,
} from "./stage-task-visualization-publication";
import {
	hashTaskVisualizationIdentity,
	pendingTaskVisualizationPublicationDirectory,
	taskVisualizationTaskStorageDirectory,
} from "./task-visualization-artifact-storage-paths";
import { renderHtmlWithTaskAttribution } from "./task-visualization-html-task-attribution";
import { TaskVisualizationPublicationFileSizeLimitError } from "./task-visualization-publication-resource-limits";

const taskVisualizationRegistrySchema = z.object({
	artifacts: z.array(taskVisualizationArtifactSchema),
	previewRequests: z.array(taskVisualizationPreviewRequestSchema),
});
const acceptedArtifactReceiptSchema = taskVisualizationArtifactSchema.extend({
	wasSupersededByNewerPublication: z.boolean().default(false),
});
const taskVisualizationPublicationRejectionSchema = z.object({
	publicationRequestId: taskVisualizationPublicationRequestIdSchema,
	failureCode: taskVisualizationPublicationRejectionCodeSchema,
	failure: z.string(),
	observedAtMs: z.number(),
});
type TaskVisualizationPublicationRejection = z.infer<typeof taskVisualizationPublicationRejectionSchema>;
export type TaskVisualizationRegistry = z.infer<typeof taskVisualizationRegistrySchema>;
const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
	".csv": "text/csv; charset=utf-8",
};

function appendPublicationPreviewRequestIfNeeded(
	registry: TaskVisualizationRegistry,
	publication: StagedTaskVisualizationPublication,
	artifact: TaskVisualizationArtifact,
	isFirstPublication: boolean,
): void {
	if (
		(publication.previewRequestMode === "always" ||
			(isFirstPublication && publication.previewRequestMode === "on_first_publication")) &&
		!registry.previewRequests.some((request) => request.previewRequestId === publication.publicationRequestId)
	) {
		registry.previewRequests.push({
			// 发布 ID 同时承担预览幂等键，覆盖清单已写入但接受回执尚未写入的中断窗口。
			previewRequestId: publication.publicationRequestId,
			visualizationArtifactId: artifact.visualizationArtifactId,
			revisionId: artifact.revisionId,
			requestedAtMs: Date.now(),
			displayedAtMs: null,
		});
	}
}

export class TaskVisualizationArtifactStore {
	constructor(readonly runtimeHomeDirectoryPath: string = getRuntimeHomePath()) {}

	private registryPath(workspaceId: string, taskId: string): string {
		return join(
			taskVisualizationTaskStorageDirectory(this.runtimeHomeDirectoryPath, workspaceId, taskId),
			"task-visualization-registry.json",
		);
	}

	async readRegistry(workspaceId: string, taskId: string): Promise<TaskVisualizationRegistry> {
		try {
			return taskVisualizationRegistrySchema.parse(
				JSON.parse(await readFile(this.registryPath(workspaceId, taskId), "utf8")),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { artifacts: [], previewRequests: [] };
			throw error;
		}
	}

	async mutateRegistry(
		workspaceId: string,
		taskId: string,
		mutate: (state: TaskVisualizationRegistry) => TaskVisualizationRegistry,
	): Promise<TaskVisualizationRegistry> {
		const registryPath = this.registryPath(workspaceId, taskId);
		await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
		return await lockedFileSystem.withLock({ path: registryPath }, async () => {
			const next = taskVisualizationRegistrySchema.parse(mutate(await this.readRegistry(workspaceId, taskId)));
			await lockedFileSystem.writeJsonFileAtomic(registryPath, next, { lock: null });
			return next;
		});
	}

	async list(workspaceId: string, taskId: string): Promise<TaskVisualizationArtifact[]> {
		return (await this.readRegistry(workspaceId, taskId)).artifacts.sort(
			(left, right) => right.publishedAtMs - left.publishedAtMs,
		);
	}

	async readPendingPublication(publicationRequestId: string): Promise<StagedTaskVisualizationPublication> {
		return stagedTaskVisualizationPublicationSchema.parse(
			JSON.parse(
				await readFile(
					join(
						pendingTaskVisualizationPublicationDirectory(this.runtimeHomeDirectoryPath, publicationRequestId),
						"publication.json",
					),
					"utf8",
				),
			),
		);
	}

	async readPublicationRejection(publicationRequestId: string): Promise<TaskVisualizationPublicationRejection | null> {
		try {
			const rejection = taskVisualizationPublicationRejectionSchema.parse(
				JSON.parse(
					await readFile(
						join(
							pendingTaskVisualizationPublicationDirectory(this.runtimeHomeDirectoryPath, publicationRequestId),
							"runtime-acceptance-rejection.json",
						),
						"utf8",
					),
				),
			);
			if (rejection.publicationRequestId !== publicationRequestId) throw new Error("可视化拒绝记录归属不匹配。");
			return rejection;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async recordPublicationRejection(
		publicationRequestId: string,
		failure: Pick<TaskVisualizationPublicationRejection, "failureCode" | "failure">,
	): Promise<TaskVisualizationPublicationRejection> {
		const publication = await this.readPendingPublication(publicationRequestId);
		const registryPath = this.registryPath(publication.workspaceId, publication.taskId);
		await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
		return await lockedFileSystem.withLock({ path: registryPath }, async () => {
			const previous = await this.readPublicationRejection(publicationRequestId);
			if (previous) return previous;
			const rejection = taskVisualizationPublicationRejectionSchema.parse({
				publicationRequestId,
				...failure,
				observedAtMs: Date.now(),
			});
			await lockedFileSystem.writeJsonFileAtomic(
				join(
					pendingTaskVisualizationPublicationDirectory(this.runtimeHomeDirectoryPath, publicationRequestId),
					"runtime-acceptance-rejection.json",
				),
				rejection,
				{ lock: null },
			);
			return rejection;
		});
	}

	private revisionDirectory(artifact: TaskVisualizationArtifact): string {
		const validated = taskVisualizationArtifactSchema.parse(artifact);
		return join(
			taskVisualizationTaskStorageDirectory(this.runtimeHomeDirectoryPath, validated.workspaceId, validated.taskId),
			validated.visualizationArtifactId,
			"published-revisions",
			validated.revisionId,
		);
	}

	async acceptPublication(
		workspaceId: string,
		workspaceRepositoryPath: string,
		publicationRequestId: string,
		taskTitleAtPublication?: string,
	): Promise<{
		artifact: TaskVisualizationArtifact;
		isNewRevision: boolean;
		wasSupersededByNewerPublication: boolean;
	}> {
		const stagedPublication = await this.readPendingPublication(publicationRequestId);
		let publication = stagedPublication;
		if (
			publication.publicationRequestId !== publicationRequestId ||
			publication.workspaceId !== workspaceId ||
			resolve(publication.workspaceRepositoryPath) !== resolve(workspaceRepositoryPath)
		)
			throw new TRPCError({ code: "BAD_REQUEST", message: "可视化发布包归属不匹配。" });
		const publicationDirectory = pendingTaskVisualizationPublicationDirectory(
			this.runtimeHomeDirectoryPath,
			publicationRequestId,
		);
		const registryPath = this.registryPath(workspaceId, publication.taskId);
		await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
		return await lockedFileSystem.withLock({ path: registryPath }, async () => {
			const rejection = await this.readPublicationRejection(publicationRequestId);
			if (rejection) throw new TRPCError({ code: rejection.failureCode, message: rejection.failure });
			try {
				const receipt = acceptedArtifactReceiptSchema.parse(
					JSON.parse(await readFile(join(publicationDirectory, "accepted-artifact.json"), "utf8")),
				);
				return {
					artifact: taskVisualizationArtifactSchema.parse(receipt),
					isNewRevision: false,
					wasSupersededByNewerPublication: receipt.wasSupersededByNewerPublication,
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let attributedEntryHtml: Buffer | undefined;
			if (
				hashTaskVisualizationIdentity(
					JSON.stringify({ entryHtmlRelativePath: publication.entryHtmlRelativePath, files: publication.files }),
				) !== publication.revisionId
			)
				throw new Error("发布包目录校验失败。");
			if (taskTitleAtPublication !== undefined) {
				const originalEntry = publication.files.find(
					(file) => file.bundleRelativePath === publication.entryHtmlRelativePath,
				);
				const original = await readFile(
					join(publicationDirectory, "files", ...publication.entryHtmlRelativePath.split("/")),
				);
				if (
					!originalEntry ||
					original.length !== originalEntry.sizeBytes ||
					hashTaskVisualizationIdentity(original) !== originalEntry.sha256
				)
					throw new Error("发布包入口校验失败。");
				let attributedHtml: string;
				try {
					attributedHtml = renderHtmlWithTaskAttribution(original.toString("utf8"), {
						workspaceId,
						taskId: publication.taskId,
						taskTitle: taskTitleAtPublication,
					});
				} catch (error) {
					if (error instanceof TaskVisualizationPublicationFileSizeLimitError)
						throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
					throw error;
				}
				const attributed = Buffer.from(attributedHtml);
				attributedEntryHtml = attributed;
				const files = publication.files.map((file) =>
					file === originalEntry
						? { ...file, sha256: hashTaskVisualizationIdentity(attributed), sizeBytes: attributed.length }
						: file,
				);
				publication = {
					...publication,
					files,
					taskTitleAtPublication,
					revisionId: hashTaskVisualizationIdentity(
						JSON.stringify({ entryHtmlRelativePath: publication.entryHtmlRelativePath, files }),
					),
				};
			}
			const registry = await this.readRegistry(workspaceId, publication.taskId);
			const previous = registry.artifacts.find(
				(artifact) => artifact.visualizationArtifactId === publication.visualizationArtifactId,
			);
			// 新包按锁内持久序号排序；旧 schema 只以源固化时间回退，同毫秒无法证明更晚就保留当前内容。
			const sourcePublicationOrder =
				publication.publicationStagingSequence !== undefined &&
				previous?.latestSourcePublicationStagingSequence !== undefined
					? publication.publicationStagingSequence - previous.latestSourcePublicationStagingSequence
					: publication.stagedAtMs - (previous?.latestSourcePublicationStagedAtMs ?? 0);
			if (
				previous &&
				(sourcePublicationOrder < 0 ||
					(sourcePublicationOrder === 0 && previous.revisionId !== publication.revisionId))
			) {
				await lockedFileSystem.writeJsonFileAtomic(
					join(publicationDirectory, "accepted-artifact.json"),
					{ ...previous, wasSupersededByNewerPublication: true },
					{ lock: null },
				);
				return { artifact: previous, isNewRevision: false, wasSupersededByNewerPublication: true };
			}
			if (previous?.revisionId === publication.revisionId) {
				const current = {
					...previous,
					latestSourcePublicationStagedAtMs: publication.stagedAtMs,
					latestSourcePublicationStagingSequence: publication.publicationStagingSequence,
				};
				const next = {
					...registry,
					artifacts: registry.artifacts.map((entry) =>
						entry.visualizationArtifactId === current.visualizationArtifactId ? current : entry,
					),
				};
				appendPublicationPreviewRequestIfNeeded(next, publication, current, false);
				await lockedFileSystem.writeJsonFileAtomic(registryPath, next, { lock: null });
				await lockedFileSystem.writeJsonFileAtomic(join(publicationDirectory, "accepted-artifact.json"), current, {
					lock: null,
				});
				return { artifact: current, isNewRevision: false, wasSupersededByNewerPublication: false };
			}
			const artifact: TaskVisualizationArtifact = {
				workspaceId,
				taskId: publication.taskId,
				visualizationArtifactId: publication.visualizationArtifactId,
				title: publication.title,
				taskTitleAtPublication: publication.taskTitleAtPublication,
				entryHtmlRelativePath: publication.entryHtmlRelativePath,
				revisionId: publication.revisionId,
				versionNumber: (previous?.versionNumber ?? 0) + 1,
				publishedAtMs: Date.now(),
				latestSourcePublicationStagedAtMs: publication.stagedAtMs,
				latestSourcePublicationStagingSequence: publication.publicationStagingSequence,
				sourceConversationSessionId: publication.sourceConversationSessionId,
			};
			const revisionDirectory = this.revisionDirectory(artifact);
			const computedRevision = hashTaskVisualizationIdentity(
				JSON.stringify({ entryHtmlRelativePath: publication.entryHtmlRelativePath, files: publication.files }),
			);
			if (
				computedRevision !== publication.revisionId ||
				!publication.files.some((file) => file.bundleRelativePath === publication.entryHtmlRelativePath)
			)
				throw new Error("发布包目录校验失败。");
			const acceptingDirectory = `${revisionDirectory}.being-accepted-${publicationRequestId}`;
			await rm(acceptingDirectory, { recursive: true, force: true });
			await mkdir(join(acceptingDirectory, "files"), { recursive: true, mode: 0o700 });
			try {
				for (const file of stagedPublication.files) {
					const content = await readFile(
						join(publicationDirectory, "files", ...file.bundleRelativePath.split("/")),
					);
					if (content.length !== file.sizeBytes || hashTaskVisualizationIdentity(content) !== file.sha256)
						throw new Error(`发布包资源校验失败：${file.bundleRelativePath}`);
					const destination = join(acceptingDirectory, "files", ...file.bundleRelativePath.split("/"));
					await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
					await writeFile(
						destination,
						file.bundleRelativePath === publication.entryHtmlRelativePath
							? (attributedEntryHtml ?? content)
							: content,
						{ mode: 0o600 },
					);
				}
				await lockedFileSystem.writeJsonFileAtomic(join(acceptingDirectory, "publication.json"), publication, {
					lock: null,
				});
				await lockedFileSystem.writeJsonFileAtomic(join(acceptingDirectory, "artifact.json"), artifact, {
					lock: null,
				});
				try {
					await rename(acceptingDirectory, revisionDirectory);
				} catch (error) {
					if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				}
			} finally {
				await rm(acceptingDirectory, { recursive: true, force: true });
			}
			const next = {
				...registry,
				artifacts: [
					artifact,
					...registry.artifacts.filter(
						(entry) => entry.visualizationArtifactId !== artifact.visualizationArtifactId,
					),
				],
			};
			appendPublicationPreviewRequestIfNeeded(next, publication, artifact, !previous);
			await lockedFileSystem.writeJsonFileAtomic(registryPath, next, { lock: null });
			await lockedFileSystem.writeJsonFileAtomic(join(publicationDirectory, "accepted-artifact.json"), artifact, {
				lock: null,
			});
			return { artifact, isNewRevision: true, wasSupersededByNewerPublication: false };
		});
	}

	async readRevisionArtifact(
		artifact: TaskVisualizationArtifact,
		revisionId: string,
	): Promise<TaskVisualizationArtifact> {
		return taskVisualizationArtifactSchema.parse(
			JSON.parse(await readFile(join(this.revisionDirectory({ ...artifact, revisionId }), "artifact.json"), "utf8")),
		);
	}

	async readRevisionFile(
		artifact: TaskVisualizationArtifact,
		relativeFilePath: string,
	): Promise<{ content: Buffer; contentType: string }> {
		const validatedPath = taskVisualizationRelativePathSchema.parse(relativeFilePath);
		const revisionDirectory = this.revisionDirectory(artifact);
		const publication = stagedTaskVisualizationPublicationSchema.parse(
			JSON.parse(await readFile(join(revisionDirectory, "publication.json"), "utf8")),
		);
		const entry = publication.files.find((file) => file.bundleRelativePath === validatedPath);
		if (!entry) throw new Error("可视化资源不存在。");
		const content = await readFile(join(revisionDirectory, "files", ...validatedPath.split("/")));
		if (hashTaskVisualizationIdentity(content) !== entry.sha256) throw new Error("已发布资源校验失败。");
		return { content, contentType: MIME_TYPES[extname(validatedPath).toLowerCase()] ?? "text/plain; charset=utf-8" };
	}
}
