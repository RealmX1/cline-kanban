import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { getRuntimeFetch } from "../core/runtime-endpoint";
import {
	getWorkspaceStateSnapshotReadFingerprintById,
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceStateById,
	type PersistedWorkspaceStateById,
} from "../state/workspace-state";
import { reuseLocalRedeploymentCheck } from "./local-redeployment-persistent-checks";
import {
	assertLocalRedeploymentNotRevoked,
	executeLocalRedeploymentFile,
	type LocalRedeploymentRequest,
	localRedeploymentSha256,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";

export async function queryLocalRedeploymentRuntime(
	request: LocalRedeploymentRequest,
	procedure: string,
	workspaceId?: string,
	input?: unknown,
): Promise<unknown> {
	const url = new URL(
		`/api/trpc/${procedure}`,
		`http://${request.runtimeIdentity.runtimeHost === "::1" ? "[::1]" : request.runtimeIdentity.runtimeHost}:${request.runtimeIdentity.runtimePort}`,
	);
	if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
	const response = await (await getRuntimeFetch())(url, {
		headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) throw new Error(`${procedure} HTTP ${response.status}`);
	const envelope = (await response.json()) as { result?: { data?: unknown } };
	if (!envelope.result || envelope.result.data === undefined) throw new Error(`${procedure} 缺少原生结果`);
	return envelope.result.data;
}

export async function readLocalRedeploymentWorkspaceState(
	request: LocalRedeploymentRequest,
	directory: string,
	workspaceId: string,
): Promise<PersistedWorkspaceStateById> {
	const fingerprint = await getWorkspaceStateSnapshotReadFingerprintById(workspaceId);
	return reuseLocalRedeploymentCheck({
		directory,
		checkKey: `workspace-state:${workspaceId}`,
		inputFingerprint: fingerprint,
		validate: (value): value is PersistedWorkspaceStateById =>
			!!value &&
			typeof value === "object" &&
			"workspaceId" in value &&
			value.workspaceId === workspaceId &&
			"board" in value &&
			!!value.board &&
			typeof value.board === "object" &&
			"columns" in value.board &&
			Array.isArray(value.board.columns),
		read: async () => {
			try {
				const value = (await queryLocalRedeploymentRuntime(
					request,
					"workspace.getState",
					workspaceId,
				)) as PersistedWorkspaceStateById;
				return { value, evidenceSource: "runtime_workspace_getState" };
			} catch (error) {
				const value = await loadPersistedWorkspaceStateById(workspaceId);
				await writeLocalRedeploymentJson(join(directory, "workspace-api-recovery", `${workspaceId}.json`), {
					workspaceId,
					apiFailure: String(error),
					candidateSourceCommit: request.candidateSourceCommit,
					revision: value.revision,
					fingerprint,
					evidenceSource: "consistent_persisted_workspace_snapshot",
				});
				return { value, evidenceSource: "consistent_persisted_workspace_snapshot" };
			}
		},
	});
}

async function readOnlyWorktreeGit(path: string, arguments_: string[]): Promise<Buffer> {
	return (
		await executeLocalRedeploymentFile(
			"git",
			["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-C", path, ...arguments_],
			{ encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
		)
	).stdout;
}

export async function preserveLocalRedeploymentWorktree(path: string, directory: string, preserveContents: boolean) {
	const gitArguments = [
		["status", "--porcelain=v1", "-z"],
		["diff", "--binary", "--full-index", "HEAD", "--"],
		["diff", "--cached", "--binary", "--full-index", "HEAD", "--"],
		["ls-files", "--others", "--exclude-standard", "-z"],
		["diff", "--name-only", "-z", "HEAD", "--"],
		["rev-parse", "HEAD"],
	];
	const results = await Promise.all(gitArguments.map((arguments_) => readOnlyWorktreeGit(path, arguments_)));
	for (const index of [3, 4])
		if (!Buffer.from(results[index].toString("utf8")).equals(results[index]))
			throw new Error("Git 路径不是可无损表示的 UTF-8，保留原始 NUL 清单，不能虚报保全");
	const names = [
		...new Set(`${results[3].toString("utf8")}${results[4].toString("utf8")}`.split("\0").filter(Boolean)),
	].sort();
	const files: Record<
		string,
		{ sha256: string; sourceFilePermissionMode: number } | { symlinkTarget: string } | { absent: true }
	> = {};
	for (const name of names) {
		const source = resolve(path, name);
		if (relative(path, source).startsWith("..")) throw new Error("Git 文件路径越出所属工作树");
		try {
			const metadata = await lstat(source);
			if (metadata.isSymbolicLink()) files[name] = { symlinkTarget: await readlink(source) };
			else if (metadata.isFile())
				files[name] = {
					sha256: localRedeploymentSha256(await readFile(source)),
					sourceFilePermissionMode: metadata.mode & 0o7777,
				};
			else throw new Error(`WIP 包含无法保全的文件类型：${name}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			files[name] = { absent: true };
		}
	}
	const contentIdentity = {
		path,
		headCommit: results[5].toString("utf8").trim(),
		statusSha256: localRedeploymentSha256(results[0]),
		diffSha256: localRedeploymentSha256(results[1]),
		stagedSha256: localRedeploymentSha256(results[2]),
		files,
	};
	const target = join(
		directory,
		"worktrees",
		localRedeploymentSha256(path),
		localRedeploymentSha256(JSON.stringify({ contentIdentity, preserveContents })),
	);
	const receiptPath = join(target, "worktree-content-snapshot.json");
	const cached = (await readLocalRedeploymentJson(receiptPath)) as
		| (typeof contentIdentity & { concurrentChangeDuringCapture: boolean; preservedDirectory: string | null })
		| null;
	if (cached) return cached;
	await mkdir(target, { recursive: true });
	if (preserveContents) {
		const directoriesToSynchronize = new Set<string>([target]);
		for (const [name, fingerprint] of Object.entries(files)) {
			if ("absent" in fingerprint) continue;
			const destination = join(target, "preserved-working-files", name);
			await mkdir(dirname(destination), { recursive: true });
			for (let parent = dirname(destination); parent.startsWith(target); parent = dirname(parent))
				directoriesToSynchronize.add(parent);
			if ("symlinkTarget" in fingerprint) {
				if (
					!(await lstat(destination).catch((error) => {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
						throw error;
					}))
				)
					await symlink(fingerprint.symlinkTarget, destination);
				if ((await readlink(destination)) !== fingerprint.symlinkTarget)
					throw new Error("已保留符号链接原件与内容摘要不一致");
			} else {
				const bytes = await readFile(join(path, name));
				if (localRedeploymentSha256(bytes) !== fingerprint.sha256)
					throw Object.assign(new Error("文件在保全期间变化，等待逐项重验"), {
						code: "SOURCE_CONTENT_CHANGED_DURING_CAPTURE",
						path: join(path, name),
					});
				if (
					await lstat(destination).catch((error) => {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
						throw error;
					})
				) {
					if (localRedeploymentSha256(await readFile(destination)) !== fingerprint.sha256)
						throw new Error("未完成的保全原件摘要不一致，禁止覆盖");
				} else {
					const file = await open(destination, "wx", 0o600);
					try {
						await file.writeFile(bytes);
						await file.sync();
					} finally {
						await file.close();
					}
				}
			}
		}
		for (const parent of [...directoriesToSynchronize].sort((left, right) => right.length - left.length)) {
			const handle = await open(parent, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		for (const [index, filename] of [
			"status-porcelain-v1.bin",
			"working-tree-vs-head.patch",
			"index-vs-head.patch",
			"untracked-files.bin",
		].entries())
			await lockedWriteBuffer(join(target, filename), results[index]);
	}
	const afterStatus = await readOnlyWorktreeGit(path, ["status", "--porcelain=v1", "-z"]);
	const afterDifference = await readOnlyWorktreeGit(path, ["diff", "--binary", "--full-index", "HEAD", "--"]);
	const snapshot = {
		...contentIdentity,
		concurrentChangeDuringCapture: !results[0].equals(afterStatus) || !results[1].equals(afterDifference),
		preservedDirectory: preserveContents ? target : null,
	};
	await writeLocalRedeploymentJson(receiptPath, snapshot);
	return snapshot;
}

async function lockedWriteBuffer(path: string, value: Buffer): Promise<void> {
	// base64 不改变补丁与 NUL 分隔清单的原始字节，也避免文本编码损失。
	await writeLocalRedeploymentJson(`${path}.base64.json`, { encoding: "base64", content: value.toString("base64") });
}

export async function captureLocalRedeploymentState(
	request: LocalRedeploymentRequest,
	directory: string,
	label: string,
	preserveContents: boolean,
) {
	const target = join(directory, label);
	const projects = await listWorkspaceIndexEntries({ requireCompleteRead: true });
	const worktrees = new Set<string>([request.sourceCheckoutPath, request.originatingTaskWorktreePath]);
	const mappings = [];
	for (const project of projects) {
		assertLocalRedeploymentNotRevoked(directory);
		const state = await readLocalRedeploymentWorkspaceState(request, target, project.workspaceId);
		await writeLocalRedeploymentJson(
			join(target, "consistent-workspace-states", `${project.workspaceId}.json`),
			state,
		);
		mappings.push({
			workspaceId: project.workspaceId,
			revision: state.revision,
			cards: state.board.columns
				.flatMap((column) => column.cards)
				.map((card) => ({ id: card.id, createdAt: card.createdAt })),
			sessions: Object.fromEntries(
				Object.entries(state.sessions).map(([id, summary]) => [
					id,
					{
						workspacePath: summary.workspacePath,
						runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
					},
				]),
			),
		});
		try {
			const registered = (
				await readOnlyWorktreeGit(project.repoPath, ["worktree", "list", "--porcelain", "-z"])
			).toString("utf8");
			for (const field of registered.split("\0")) if (field.startsWith("worktree ")) worktrees.add(field.slice(9));
		} catch (error) {
			// 已删除的项目不等于部署丢失；仍保留其任务快照和不可读来源。
			await writeLocalRedeploymentJson(join(target, "unavailable-projects", `${project.workspaceId}.json`), {
				project,
				error: String(error),
			});
		}
	}
	const snapshots = [];
	for (const path of [...worktrees].sort()) {
		assertLocalRedeploymentNotRevoked(directory);
		try {
			snapshots.push(await preserveLocalRedeploymentWorktree(await realpath(path), target, preserveContents));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			snapshots.push({ path, missing: true });
		}
	}
	const result = { mappings, worktrees: snapshots };
	await writeLocalRedeploymentJson(join(target, "state-and-worktree-inventory.json"), result);
	return result;
}

export async function backupLocalRedeploymentRuntimeState(
	request: LocalRedeploymentRequest,
	directory: string,
): Promise<void> {
	const backupRoot = join(directory, "preserved-runtime-state");
	const preservedInPlace = new Set([
		"cross-task-handoff-artifacts",
		"task-cross-task-handoff-artifacts",
		"task-handoff-artifacts",
		"task-validation-artifacts",
		"task-implementation-evidence",
		"verification-workspaces",
		"task-artifacts",
		"task-closure-preserved-artifacts",
		"filesystem-kernel-write-locks",
	]);
	const skipped: string[] = [];
	const currentEntryBackups: Array<{
		source: string;
		destination: string;
		sourceFingerprint: string;
		preservedFingerprint: string;
	}> = [];
	function isRuntimeWorkspaceCommandExecutionArtifactDirectory(path: string): boolean {
		const runtimeHomeRelativePathSegments = relative(request.runtimeIdentity.runtimeHomeDirectoryPath, path).split(
			sep,
		);
		return (
			runtimeHomeRelativePathSegments.length === 3 &&
			runtimeHomeRelativePathSegments[0] === "workspaces" &&
			runtimeHomeRelativePathSegments[2] === "task-command-executions"
		);
	}
	async function hashRuntimeStateFileContents(path: string): Promise<string> {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		return hash.digest("hex");
	}
	async function fingerprintRuntimeStateEntry(path: string, recordSkipped = false): Promise<string | null> {
		assertLocalRedeploymentNotRevoked(directory);
		// 活跃监督者持续改写这些持久原件；原地保留，不能要求部署自己的进度静止。
		if (isRuntimeWorkspaceCommandExecutionArtifactDirectory(path)) {
			if (recordSkipped) skipped.push(path);
			return null;
		}
		const metadata = await lstat(path);
		if (metadata.isSocket() || path.endsWith("-wal") || path.endsWith("-shm")) {
			if (recordSkipped) skipped.push(path);
			return null;
		}
		if (metadata.isSymbolicLink())
			return localRedeploymentSha256(JSON.stringify({ symbolicLinkTarget: await readlink(path) }));
		const mode = metadata.mode & 0o7777;
		if (metadata.isDirectory()) {
			const children: Array<[string, string]> = [];
			for (const name of (await readdir(path)).sort()) {
				const fingerprint = await fingerprintRuntimeStateEntry(join(path, name), recordSkipped);
				if (fingerprint !== null) children.push([name, fingerprint]);
			}
			return localRedeploymentSha256(JSON.stringify({ mode, children }));
		}
		if (!metadata.isFile()) throw new Error(`运行时状态包含无法保全的文件类型：${path}`);
		const databaseWalContentSha256 = /\.(?:sqlite|sqlite3|db)$/u.test(path)
			? await hashRuntimeStateFileContents(`${path}-wal`).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				})
			: undefined;
		return localRedeploymentSha256(
			JSON.stringify({
				mode,
				contentSha256: await hashRuntimeStateFileContents(path),
				databaseWalContentSha256,
			}),
		);
	}
	async function copyRuntimeStateEntry(source: string, destination: string): Promise<void> {
		assertLocalRedeploymentNotRevoked(directory);
		if (isRuntimeWorkspaceCommandExecutionArtifactDirectory(source)) {
			skipped.push(source);
			return;
		}
		const metadata = await lstat(source);
		if (metadata.isSocket() || source.endsWith("-wal") || source.endsWith("-shm")) {
			skipped.push(source);
			return;
		}
		if (metadata.isDirectory()) {
			await mkdir(destination, { recursive: true });
			for (const name of await readdir(source))
				await copyRuntimeStateEntry(join(source, name), join(destination, name));
			await chmod(destination, metadata.mode & 0o7777);
		} else if (metadata.isFile() && /\.(?:sqlite|sqlite3|db)$/u.test(source)) {
			await mkdir(dirname(destination), { recursive: true });
			const database = new Database(source, { readonly: true, fileMustExist: true });
			try {
				await database.backup(destination);
			} finally {
				database.close();
			}
			await chmod(destination, metadata.mode & 0o7777);
			const preservedDatabase = new Database(destination, { readonly: true, fileMustExist: true });
			try {
				if (preservedDatabase.pragma("quick_check", { simple: true }) !== "ok")
					throw new Error(`运行时数据库备份未通过 SQLite 一致性核验：${source}`);
			} finally {
				preservedDatabase.close();
			}
		} else {
			await cp(source, destination, { dereference: false });
			if ((await fingerprintRuntimeStateEntry(source)) !== (await fingerprintRuntimeStateEntry(destination)))
				throw Object.assign(new Error("运行时文件副本与源内容不一致，等待逐项重验"), {
					code: "SOURCE_CONTENT_CHANGED_DURING_CAPTURE",
					path: source,
				});
		}
		if (!metadata.isSymbolicLink()) {
			const handle = await open(destination, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
	}
	for (const name of await readdir(request.runtimeIdentity.runtimeHomeDirectoryPath)) {
		const source = join(request.runtimeIdentity.runtimeHomeDirectoryPath, name);
		if (
			preservedInPlace.has(name) ||
			resolve(directory) === resolve(source) ||
			resolve(directory).startsWith(`${resolve(source)}/`)
		) {
			skipped.push(source);
			continue;
		}
		const receiptPath = join(directory, "runtime-backup-checkpoints", `${localRedeploymentSha256(name)}.json`);
		const previous = (await readLocalRedeploymentJson(receiptPath)) as {
			destination?: string;
			sourceFingerprint?: string;
			preservedFingerprint?: string;
		} | null;
		const sourceFingerprint = await fingerprintRuntimeStateEntry(source, true);
		if (sourceFingerprint === null) continue;
		if (previous?.sourceFingerprint === sourceFingerprint && previous.destination) {
			const preservedFingerprint = await fingerprintRuntimeStateEntry(previous.destination).catch(
				(error: unknown) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				},
			);
			if (preservedFingerprint !== null && preservedFingerprint === previous.preservedFingerprint) {
				currentEntryBackups.push({
					source,
					destination: previous.destination,
					sourceFingerprint,
					preservedFingerprint,
				});
				continue;
			}
		}
		const initialDestination = join(backupRoot, name);
		const initialBackupExists = await lstat(initialDestination).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		});
		const captureDirectory = join(directory, "runtime-state-backup-capture-attempts", randomUUID());
		const capturedEntry = join(captureDirectory, name);
		await mkdir(captureDirectory, { recursive: true });
		await copyRuntimeStateEntry(source, capturedEntry);
		const preservedFingerprint = await fingerprintRuntimeStateEntry(capturedEntry);
		if (preservedFingerprint === null || (await fingerprintRuntimeStateEntry(source)) !== sourceFingerprint)
			throw Object.assign(new Error("运行时状态在保全期间变化，等待逐项重验"), {
				code: "SOURCE_CONTENT_CHANGED_DURING_CAPTURE",
				path: source,
			});
		const destination = initialBackupExists
			? join(directory, "preserved-runtime-state-versions", localRedeploymentSha256(name), randomUUID(), name)
			: initialDestination;
		await mkdir(dirname(destination), { recursive: true });
		await rename(capturedEntry, destination);
		const destinationParent = await open(dirname(destination), "r");
		try {
			await destinationParent.sync();
		} finally {
			await destinationParent.close();
		}
		const receipt = {
			source,
			destination,
			sourceFingerprint,
			preservedFingerprint,
			copiedAtEpochMs: Date.now(),
		};
		await writeLocalRedeploymentJson(join(captureDirectory, "verified-entry-backup.json"), receipt);
		await writeLocalRedeploymentJson(receiptPath, receipt);
		currentEntryBackups.push({ source, destination, sourceFingerprint, preservedFingerprint });
	}
	const previousBuild = join(directory, "preserved-previous-distribution");
	if (!(await readLocalRedeploymentJson(join(directory, "previous-distribution-backup.json")))) {
		await cp(request.distributionDirectoryPath, previousBuild, { recursive: true, dereference: false });
		await writeLocalRedeploymentJson(join(directory, "previous-distribution-backup.json"), { previousBuild });
	}
	await writeLocalRedeploymentJson(join(directory, "runtime-state-backup-receipt.json"), {
		backupRoot,
		currentEntryBackups,
		preservedInPlaceOrTransientEndpoints: skipped,
	});
}
