import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	assertSourceGitWorkingStateMatchesSnapshot,
	captureSourceGitWorkingState,
	readSourceGitWorkingStateSnapshot,
} from "../../src/independent-task-creation/git-working-state-snapshot";
import { fingerprint, inspectCompletedNativeHistory, taskIdSchema } from "./experiment-contract";
import { inspectSnapshotCandidateTree } from "./frozen-source-snapshot";
import {
	assertOwnedExperimentRoot,
	createOwnedExperimentRoot,
	createPrivateDirectory,
	executeGit,
	fingerprintFile,
	readJson,
	safeEntryPath,
	writeDurableJson,
} from "./persistent-experiment-storage";

export const cohortBackupInputSchema = z.object({
	schemaVersion: z.literal(1),
	projectPath: z.string(),
	baseRef: z.string(),
	requestArrivedAt: z.number(),
	workspaceStateDirectory: z.string(),
	tasks: z.array(
		z.object({
			taskId: taskIdSchema,
			worktreePath: z.string(),
			artifactDirectories: z.array(z.string()),
			readinessNote: z.string(),
			duplicateDeliveryOfTaskId: taskIdSchema.optional(),
		}),
	),
	screenedTaskIds: z.array(taskIdSchema),
	sharedEvidencePaths: z.array(z.string()),
	workflowArtifactDirectories: z.array(z.string()),
});

interface ArchivedFile {
	sourcePath: string;
	archivedRelativePath: string;
	kind: "file" | "symlink-text";
	sha256: string;
	byteLength: number;
	mode: number;
	observedAt: number;
}

type NativeHistoryBackupEvidence =
	| ({ status: "completed-boundary-verified" } & ReturnType<typeof inspectCompletedNativeHistory>)
	| {
			status: "raw-history-preserved-boundary-unverified";
			parentSessionId: string;
			sha256: string;
			byteLength: number;
			reason: string;
	  };

/** 字节复制和原件校验共用入口；APFS clone 不共享可写 inode，其他文件系统退回普通复制。 */
async function archiveRegularFile(
	source: string,
	target: string,
	root: string,
	retainExistingCapturedVersion = false,
): Promise<ArchivedFile> {
	const before = await lstat(source);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	let alreadyArchived = false;
	try {
		await lstat(target);
		alreadyArchived = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (alreadyArchived && retainExistingCapturedVersion)
		return {
			sourcePath: source,
			archivedRelativePath: target.slice(root.length + 1),
			kind: "file",
			sha256: await fingerprintFile(target),
			byteLength: (await lstat(target)).size,
			mode: before.mode,
			observedAt: (await lstat(target)).birthtimeMs,
		};
	let kind: ArchivedFile["kind"] = "file";
	let sha256: string;
	if (before.isSymbolicLink()) {
		kind = "symlink-text";
		const text = await readlink(source);
		if (!alreadyArchived) await writeFile(target, text, { mode: 0o600, flag: "wx" });
		else if ((await readFile(target, "utf8")) !== text) throw new Error("既有链接快照与来源不一致，保留旧快照");
		sha256 = fingerprint(text);
	} else {
		if (!before.isFile()) throw new Error(`不支持归档特殊文件：${source}`);
		if (!alreadyArchived) await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
		await chmod(target, 0o600);
		sha256 = await fingerprintFile(target);
		if (sha256 !== (await fingerprintFile(source))) throw new Error(`归档期间文件发生变化：${source}`);
	}
	const after = await lstat(source);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
		throw new Error(`归档期间来源发生变化：${source}`);
	return {
		sourcePath: source,
		archivedRelativePath: target.slice(root.length + 1),
		kind,
		sha256,
		byteLength: (await lstat(target)).size,
		mode: before.mode,
		observedAt: Date.now(),
	};
}

/** 归档评审、计划、结果及配置；可重新物化的安装／构建／评审工作区另记目录身份。 */
async function archiveArtifactDirectory(input: {
	root: string;
	source: string;
	destination: string;
	files: ArchivedFile[];
	excludedReproducibleDirectories: { sourcePath: string; reason: string }[];
}) {
	await createPrivateDirectory(input.destination);
	for (const entry of await readdir(input.source, { withFileTypes: true })) {
		const source = join(input.source, entry.name);
		const destination = join(input.destination, entry.name);
		if (entry.name.endsWith(".lock") || entry.name.endsWith(".sock")) continue;
		if (entry.isDirectory()) {
			let containsGitDirectory = false;
			try {
				await lstat(join(source, ".git"));
				containsGitDirectory = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (["node_modules", ".git", "dist", "isolated-distribution"].includes(entry.name) || containsGitDirectory) {
				input.excludedReproducibleDirectories.push({
					sourcePath: source,
					reason: containsGitDirectory
						? "派生评审工作区，相关候选 Git 对象单独归档"
						: "依赖或生成产物另行归档；不递归复制活工作区",
				});
				continue;
			}
			await archiveArtifactDirectory({ ...input, source, destination });
		} else if (entry.isFile() || entry.isSymbolicLink())
			input.files.push(await archiveRegularFile(source, destination, input.root));
	}
}

export async function backupReusableTaskCohort(inputPath: string, root: string) {
	const input = cohortBackupInputSchema.parse(await readJson(inputPath));
	if (new Set(input.tasks.map((task) => task.taskId)).size !== input.tasks.length) throw new Error("备份候选重复");
	const common = (await executeGit(input.projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
		.toString()
		.trim();
	let ownership: Awaited<ReturnType<typeof assertOwnedExperimentRoot>>;
	try {
		ownership = await createOwnedExperimentRoot(root, common);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		ownership = await assertOwnedExperimentRoot(root, join(root, "tasks"));
		if (
			ownership.sourceCommonDirectory !== common ||
			JSON.stringify(await readJson(join(root, "cohort-backup-input.json"))) !== JSON.stringify(input)
		)
			throw new Error("不能用另一份输入或来源接续既有备份");
	}
	const files: ArchivedFile[] = [];
	const excludedReproducibleDirectories: { sourcePath: string; reason: string }[] = [];
	const taskResults: {
		taskId: string;
		headCommit: string;
		restoredTree: string;
		sourceUnchanged: boolean;
		codeChangedLines: number | null;
		nativeSessions: { conversationSessionId: string; nativeSessionId: string; frozenHistory: unknown }[];
		readinessNote: string;
		duplicateDeliveryOfTaskId?: string;
	}[] = [];
	const startedAt = Date.now();
	const progress = async (status: string) =>
		writeDurableJson(join(root, "cohort-backup-progress.json"), {
			status,
			startedAt,
			observedAt: Date.now(),
			completedTaskIds: taskResults.map((task) => task.taskId),
			requestedTaskIds: input.tasks.map((task) => task.taskId),
		});
	await writeDurableJson(join(root, "cohort-backup-input.json"), input);
	await progress("capturing");
	for (const entry of await readdir(input.workspaceStateDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		files.push(
			await archiveRegularFile(
				join(input.workspaceStateDirectory, entry.name),
				join(root, "workspace-state-at-capture", entry.name),
				root,
				true,
			),
		);
	}
	const sessions = z
		.record(z.string(), z.record(z.string(), z.unknown()))
		.parse(await readJson(join(root, "workspace-state-at-capture", "sessions.json")));
	const board = await readJson(join(root, "workspace-state-at-capture", "board.json"));
	const baseCommit = (await executeGit(input.projectPath, ["rev-parse", "--verify", `${input.baseRef}^{commit}`]))
		.toString()
		.trim();
	try {
		await assertSourceGitWorkingStateMatchesSnapshot(input.projectPath, join(root, "base-working-state"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await captureSourceGitWorkingState(input.projectPath, join(root, "base-working-state"));
	}
	files.push(await archiveRegularFile(join(common, "config"), join(root, "source-git-configuration.txt"), root));
	await writeFile(join(root, "source-refs-at-capture.txt"), await executeGit(input.projectPath, ["show-ref"]), {
		mode: 0o600,
	});
	for (const task of input.tasks) {
		const taskDirectory = join(root, "tasks", task.taskId);
		await createPrivateDirectory(taskDirectory);
		const archive = join(taskDirectory, "git-working-state");
		try {
			await assertSourceGitWorkingStateMatchesSnapshot(task.worktreePath, archive);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await captureSourceGitWorkingState(task.worktreePath, archive);
		}
		const snapshot = await readSourceGitWorkingStateSnapshot(archive);
		if (snapshot.gitCommonDirectory !== common) throw new Error("任务不属于已冻结仓库");
		const restorationPath = join(root, "restoration-checks", task.taskId);
		let restored: { tree: string; codeChangedLines: number | null };
		try {
			await lstat(join(restorationPath, ".git"));
			restored = {
				tree: (await executeGit(restorationPath, ["rev-parse", "refs/heads/frozen-task-input^{tree}"]))
					.toString()
					.trim(),
				codeChangedLines: null,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			restored = await inspectSnapshotCandidateTree(root, archive, restorationPath);
		}
		const nativeSessions = [];
		for (const [sessionId, summary] of Object.entries(sessions)) {
			if (sessionId !== task.taskId && summary.taskId !== task.taskId) continue;
			const identity = z
				.object({
					sourceAgentId: z.literal("codex"),
					nativeSessionId: z.string().uuid(),
					transcriptPath: z.string(),
				})
				.parse(summary.agentNativeConversationSessionIdentity);
			const text = await readFile(identity.transcriptPath, "utf8");
			let frozenHistory: NativeHistoryBackupEvidence;
			try {
				frozenHistory = {
					status: "completed-boundary-verified",
					...inspectCompletedNativeHistory(text, identity.nativeSessionId),
				};
			} catch (error) {
				const metadata = z
					.object({
						type: z.literal("session_meta"),
						payload: z.object({ id: z.literal(identity.nativeSessionId) }),
					})
					.parse(JSON.parse(text.split("\n")[0]));
				frozenHistory = {
					status: "raw-history-preserved-boundary-unverified",
					parentSessionId: metadata.payload.id,
					sha256: fingerprint(text),
					byteLength: Buffer.byteLength(text),
					reason: String(error),
				};
			}
			const nativeDirectory = join(taskDirectory, "native-conversations", identity.nativeSessionId);
			await createPrivateDirectory(nativeDirectory);
			files.push(
				await archiveRegularFile(
					identity.transcriptPath,
					join(nativeDirectory, basename(identity.transcriptPath)),
					root,
				),
			);
			await writeDurableJson(join(nativeDirectory, "native-identity-and-boundary.json"), {
				sessionId,
				identity,
				frozenHistory,
				summary,
			});
			nativeSessions.push({
				conversationSessionId: sessionId,
				nativeSessionId: identity.nativeSessionId,
				frozenHistory,
			});
			const binding = z
				.object({
					configurationHomeDirectoryPath: z.string().optional(),
					sourceHomeDirectoryPath: z.string().optional(),
				})
				.passthrough()
				.optional()
				.parse(summary.codexConfigurationWriterBinding);
			const inferredConfigurationHome = resolve(dirname(identity.transcriptPath), "../../../..");
			const configurationHomes = [
				...new Set([
					binding?.configurationHomeDirectoryPath,
					binding?.sourceHomeDirectoryPath,
					inferredConfigurationHome,
				]),
			].filter((path): path is string => Boolean(path));
			for (const [index, home] of configurationHomes.entries()) {
				for (const name of ["config.toml", "hooks.json", "auth.json", "AGENTS.md"]) {
					const source = join(home, name);
					try {
						await lstat(source);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw error;
					}
					// 配置层可能为符号链接；归档解析后的文件字节，原链接身份另存。
					const resolved = await realpath(source);
					files.push(
						await archiveRegularFile(resolved, join(nativeDirectory, `configuration-layer-${index}`, name), root),
					);
				}
			}
		}
		await writeDurableJson(join(taskDirectory, "source-task-metadata.json"), {
			taskId: task.taskId,
			board,
			sessions: Object.fromEntries(
				Object.entries(sessions).filter(([key, value]) => key === task.taskId || value.taskId === task.taskId),
			),
		});
		for (const [index, source] of task.artifactDirectories.entries())
			await archiveArtifactDirectory({
				root,
				source,
				destination: join(taskDirectory, "review-plan-and-delivery-evidence", `source-${index}`),
				files,
				excludedReproducibleDirectories,
			});
		await assertSourceGitWorkingStateMatchesSnapshot(task.worktreePath, archive);
		taskResults.push({
			taskId: task.taskId,
			headCommit: snapshot.headCommit,
			restoredTree: restored.tree,
			codeChangedLines: restored.codeChangedLines,
			nativeSessions,
			sourceUnchanged: true,
			readinessNote: task.readinessNote,
			duplicateDeliveryOfTaskId: task.duplicateDeliveryOfTaskId,
		});
		await progress("capturing");
	}
	for (const [index, source] of input.sharedEvidencePaths.entries())
		files.push(
			await archiveRegularFile(
				await realpath(source),
				join(root, "shared-environment-evidence", `source-${index}-${basename(source)}`),
				root,
			),
		);
	for (const [index, source] of input.workflowArtifactDirectories.entries())
		await archiveArtifactDirectory({
			root,
			source,
			destination: join(root, "frozen-workflow-artifacts", `source-${index}`),
			files,
			excludedReproducibleDirectories,
		});
	// 所有纳入任务在末尾再次核验；这是一组稳定逻辑输入，不冒称活实例的原子系统快照。
	for (const task of input.tasks)
		await assertSourceGitWorkingStateMatchesSnapshot(
			task.worktreePath,
			join(root, "tasks", task.taskId, "git-working-state"),
		);
	await assertSourceGitWorkingStateMatchesSnapshot(input.projectPath, join(root, "base-working-state"));
	const objectIds = new Set<string>([baseCommit, ...taskResults.map((task) => task.headCommit)]);
	const findObjects = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const entry of value) findObjects(entry);
		} else if (value && typeof value === "object")
			for (const [key, item] of Object.entries(value)) {
				if (
					typeof item === "string" &&
					/(?:commit|head|tree|candidate)$/iu.test(key) &&
					/^[a-f0-9]{40}$/u.test(item)
				)
					objectIds.add(item);
				else if (typeof item === "object") findObjects(item);
			}
	};
	for (const file of files.filter((file) => file.kind === "file" && file.sourcePath.endsWith(".json"))) {
		try {
			findObjects(await readJson(await safeEntryPath(root, file.archivedRelativePath)));
		} catch {
			/* 原样保存非 JSON 附件，不伪造其对象绑定。 */
		}
	}
	const availableObjects: string[] = [];
	const missingObjects: string[] = [];
	for (const oid of objectIds) {
		try {
			await executeGit(input.projectPath, ["cat-file", "-e", oid]);
			availableObjects.push(oid);
		} catch {
			missingObjects.push(oid);
		}
	}
	await executeGit(input.projectPath, ["pack-objects", "--stdout", "--revs", "--threads=1"], {
		input: `${availableObjects.join("\n")}\n`,
		outputPath: join(root, "base-and-reviewed-candidate-objects.pack"),
	});
	const objectPackSha256 = await fingerprintFile(join(root, "base-and-reviewed-candidate-objects.pack"));
	await writeDurableJson(join(root, "reusable-cohort-backup-manifest.json"), {
		schemaVersion: 1,
		experimentId: ownership.experimentId,
		status: "source-state-backed-up",
		startedAt,
		completedAt: Date.now(),
		baseCommit,
		input,
		taskResults,
		files,
		gitObjects: { availableObjects, missingObjects, objectPackSha256 },
		excludedReproducibleDirectories,
		atomicity: "逐文件及逐任务核验的稳定逻辑集合；活运行时元数据保留采集时版本，不恢复 PID、socket 或进行中副作用",
		remainingEnvironmentWork: ["依赖安装目录与执行二进制的独立归档、完整归档校验和离线恢复验收单独记录"],
	});
	await progress("source-state-backed-up");
	return taskResults;
}

export async function backupCohortSupplementalEvidence(root: string, sources: string[]) {
	await assertOwnedExperimentRoot(root, join(root, "supplemental-source-evidence"));
	const files: ArchivedFile[] = [];
	const excludedReproducibleDirectories: { sourcePath: string; reason: string }[] = [];
	const previousSources: string[] = [];
	try {
		const previous = z
			.object({
				sources: z.array(z.string()),
				files: z.array(z.custom<ArchivedFile>()),
				excludedReproducibleDirectories: z.array(z.object({ sourcePath: z.string(), reason: z.string() })),
			})
			.parse(await readJson(join(root, "cohort-supplemental-evidence-manifest.json")));
		previousSources.push(...previous.sources);
		files.push(...previous.files);
		excludedReproducibleDirectories.push(...previous.excludedReproducibleDirectories);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const addedSources = sources.filter((source) => !previousSources.includes(source));
	for (const [index, source] of addedSources.entries())
		await archiveArtifactDirectory({
			root,
			source,
			destination: join(root, "supplemental-source-evidence", `source-${previousSources.length + index}`),
			files,
			excludedReproducibleDirectories,
		});
	await writeDurableJson(join(root, "cohort-supplemental-evidence-manifest.json"), {
		sources: [...previousSources, ...addedSources],
		files,
		excludedReproducibleDirectories,
	});
	return { archivedFileCount: files.length };
}
