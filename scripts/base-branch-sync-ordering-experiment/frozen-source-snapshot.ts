import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
	assertSourceGitWorkingStateMatchesSnapshot,
	captureSourceGitWorkingState,
	readSourceGitWorkingStateSnapshot,
} from "../../src/independent-task-creation/git-working-state-snapshot";
import {
	experimentInputSchema,
	fingerprint,
	frozenNativeHistorySchema,
	inspectCompletedNativeHistory,
} from "./experiment-contract";
import {
	assertIndependentGitRepository,
	assertOwnedExperimentRoot,
	createOwnedExperimentRoot,
	createPrivateDirectory,
	executeGit,
	fingerprintFile,
	readJson,
	safeEntryPath,
	writeDurableJson,
} from "./persistent-experiment-storage";

const metadataTaskSchema = z.object({ id: z.string(), createdAt: z.number(), prompt: z.string() }).passthrough();
const boardSchema = z.object({ columns: z.array(z.object({ id: z.string(), cards: z.array(metadataTaskSchema) })) });
const sessionSchema = z
	.object({
		agentId: z.string(),
		turnOwner: z.string().nullable().optional(),
		liveness: z.string().optional(),
		agentNativeConversationSessionIdentity: z.object({
			sourceAgentId: z.literal("codex"),
			nativeSessionId: z.string().uuid(),
			transcriptPath: z.string(),
		}),
	})
	.passthrough();
const sessionsSchema = z.record(z.string(), z.unknown());
const evidenceFileSchema = z.object({ sourcePath: z.string(), relativePath: z.string(), sha256: z.string() });
export const batchManifestSchema = z.object({
	schemaVersion: z.literal(1),
	experimentId: z.string(),
	createdAt: z.number(),
	input: experimentInputSchema,
	baseCommit: z.string(),
	evidence: z.array(evidenceFileSchema),
	tasks: z.array(
		z.object({
			taskId: z.string(),
			readyAt: z.number(),
			codeChangedLines: z.number(),
			dependsOn: z.array(z.string()),
			headCommit: z.string(),
			snapshotRelativePath: z.string(),
			nativeHistory: frozenNativeHistorySchema,
			review: experimentInputSchema.shape.tasks.element.shape.review,
		}),
	),
});
export type FrozenBatch = z.infer<typeof batchManifestSchema>;

async function copyEvidenceFile(root: string, sourcePath: string, relativePath: string) {
	const target = await safeEntryPath(root, relativePath);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const content = await readFile(sourcePath);
	await writeFile(target, content, { mode: 0o600, flag: "wx" });
	return { sourcePath, relativePath, sha256: fingerprint(content) };
}

/** 独立物化只接受实验所有权内的空仓；生产的同 common-dir 恢复函数保持不变。 */
export async function materializeIndependentWorkingState(root: string, archive: string, target: string) {
	await assertOwnedExperimentRoot(root, target);
	const snapshot = await readSourceGitWorkingStateSnapshot(archive);
	if (
		!snapshot.objectPackHash ||
		(await fingerprintFile(join(archive, "source-git-objects.pack"))) !== snapshot.objectPackHash
	)
		throw new Error("对象包缺失或校验失败");
	await mkdir(target, { recursive: true });
	const contents = await readdir(target);
	if (contents.some((name) => name !== ".git")) throw new Error("恢复目标必须是空的独立仓库");
	if (!contents.includes(".git")) await executeGit(target, ["init", "--quiet", "--initial-branch=experiment-base"]);
	const common = await assertIndependentGitRepository(root, target);
	if ((await executeGit(target, ["ls-files", "-z"])).length) throw new Error("恢复目标已包含文件");
	await executeGit(target, ["index-pack", "--stdin"], { inputPath: join(archive, "source-git-objects.pack") });
	await executeGit(target, ["update-ref", "HEAD", snapshot.headCommit]);
	const paths = new Set<string>();
	for (const entry of snapshot.entries) {
		if (paths.has(entry.path)) throw new Error("快照路径重复");
		paths.add(entry.path);
		const destination = await safeEntryPath(target, entry.path);
		if (entry.kind === "absent") continue;
		const content = await readFile(await safeEntryPath(join(archive, "working-files"), entry.path));
		if (fingerprint(content) !== entry.hash) throw new Error(`文件快照损坏：${entry.path}`);
		await mkdir(dirname(destination), { recursive: true });
		if (entry.kind === "symlink") await symlink(content.toString(), destination);
		else {
			await writeFile(destination, content);
			await chmod(destination, entry.mode & 0o777);
		}
	}
	const index = await readFile(join(archive, "source-git-index"));
	if (fingerprint(index) !== snapshot.indexHash) throw new Error("原始 index 损坏");
	if (snapshot.sharedIndexName) {
		if (
			basename(snapshot.sharedIndexName) !== snapshot.sharedIndexName ||
			!snapshot.sharedIndexName.startsWith("sharedindex.")
		)
			throw new Error("shared index 文件名不安全");
		await copyFile(join(archive, "source-git-shared-index"), join(common, snapshot.sharedIndexName));
	}
	await writeFile(join(common, "index"), index);
	for (const entry of snapshot.entries) {
		const path = await safeEntryPath(target, entry.path);
		if (entry.kind === "absent") {
			try {
				if (!(await lstat(path)).isDirectory()) throw new Error(`删除状态恢复失败：${entry.path}`);
			} catch (error) {
				if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
		} else {
			const content = entry.kind === "symlink" ? await readlink(path) : await readFile(path);
			if (
				fingerprint(content) !== entry.hash ||
				(entry.kind === "file" && ((await lstat(path)).mode & 0o777) !== (entry.mode & 0o777))
			)
				throw new Error(`恢复比对失败：${entry.path}`);
		}
	}
	if (fingerprint(await readFile(join(common, "index"))) !== snapshot.indexHash)
		throw new Error("index 未能逐字节恢复");
	return snapshot;
}

export async function verifyMaterializedIndependentWorkingState(root: string, archive: string, target: string) {
	const snapshot = await readSourceGitWorkingStateSnapshot(archive);
	const common = await assertIndependentGitRepository(root, target);
	if (
		(await executeGit(target, ["rev-parse", "HEAD"])).toString().trim() !== snapshot.headCommit ||
		fingerprint(await readFile(join(common, "index"))) !== snapshot.indexHash
	)
		throw new Error("独立恢复的 HEAD 或原始 index 不一致");
	for (const entry of snapshot.entries) {
		const path = await safeEntryPath(target, entry.path);
		if (entry.kind === "absent") {
			try {
				if (!(await lstat(path)).isDirectory()) throw new Error("恢复的删除状态不一致");
			} catch (error) {
				if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
		} else {
			const info = await lstat(path);
			if (entry.kind === "symlink" ? !info.isSymbolicLink() : !info.isFile())
				throw new Error("恢复文件的种类不一致");
			const content = entry.kind === "symlink" ? await readlink(path) : await readFile(path);
			if (
				fingerprint(content) !== entry.hash ||
				(entry.kind === "file" && (info.mode & 0o777) !== (entry.mode & 0o777))
			)
				throw new Error(`恢复文件不一致：${entry.path}`);
		}
	}
	return snapshot;
}

export async function inspectSnapshotCandidateTree(root: string, archive: string, target: string) {
	const snapshot = await materializeIndependentWorkingState(root, archive, target);
	await executeGit(target, ["add", "--all", "--", "."]);
	const tree = (await executeGit(target, ["write-tree"])).toString().trim();
	const candidate = (await executeGit(target, ["commit-tree", tree, "-p", snapshot.headCommit, "-m", "实验输入快照"]))
		.toString()
		.trim();
	await executeGit(target, ["update-ref", "refs/heads/frozen-task-input", candidate]);
	const numstat = (await executeGit(target, ["diff", "--numstat", snapshot.headCommit, candidate])).toString();
	// EXPERIMENT_NODE: 本轮以源码扩展名识别规模，后续可比较生成文件与测试权重。
	const codeChangedLines = numstat.split("\n").reduce((sum, line) => {
		const [added, deleted, path] = line.split("\t");
		return /\.(?:[cm]?[jt]sx?|py|rs|go|c|h|cpp|java|sh|css)$/u.test(path ?? "")
			? sum + (Number(added) || 0) + (Number(deleted) || 0)
			: sum;
	}, 0);
	await executeGit(target, ["reset", "--mixed", snapshot.headCommit]);
	const common = await assertIndependentGitRepository(root, target);
	await copyFile(join(archive, "source-git-index"), join(common, "index"));
	return { tree, candidate, codeChangedLines };
}

export async function captureFrozenBatch(inputPath: string, root: string) {
	const input = experimentInputSchema.parse(await readJson(inputPath));
	const common = (await executeGit(input.projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
		.toString()
		.trim();
	const marker = await createOwnedExperimentRoot(root, common);
	const baseCommit = (await executeGit(input.projectPath, ["rev-parse", "--verify", `${input.baseRef}^{commit}`]))
		.toString()
		.trim();
	const initialBoard = boardSchema.parse(await readJson(input.boardPath));
	const initialSessions = sessionsSchema.parse(await readJson(input.sessionsPath));
	const evidence = [];
	for (const [index, path] of [
		inputPath,
		input.boardPath,
		input.sessionsPath,
		...input.workflowEvidencePaths,
	].entries())
		evidence.push(await copyEvidenceFile(root, path, `source-evidence/shared-${index}-${basename(path)}`));
	const batch: FrozenBatch = {
		schemaVersion: 1,
		experimentId: marker.experimentId,
		createdAt: Date.now(),
		input,
		baseCommit,
		evidence,
		tasks: [],
	};
	await writeDurableJson(join(root, "capture-progress.json"), { status: "capturing", input, baseCommit, tasks: [] });
	const baseArchive = join(root, "frozen-base-working-state");
	await captureSourceGitWorkingState(input.projectPath, baseArchive);
	await writeFile(join(root, "source-refs.txt"), await executeGit(input.projectPath, ["show-ref"]), { mode: 0o600 });
	await executeGit(input.projectPath, ["pack-objects", "--stdout", "--revs", "--threads=1"], {
		input: `${baseCommit}\n`,
		outputPath: join(root, "frozen-base-objects.pack"),
	});
	await writeDurableJson(join(root, "frozen-base-object-pack.json"), {
		baseCommit,
		sha256: await fingerprintFile(join(root, "frozen-base-objects.pack")),
	});
	for (const task of input.tasks) {
		const card = initialBoard.columns.flatMap((column) => column.cards).find((entry) => entry.id === task.taskId);
		const column = initialBoard.columns.find((entry) => entry.cards.some((entry) => entry.id === task.taskId))?.id;
		if (!card || card.createdAt !== task.taskIncarnationCreatedAt || column !== "review")
			throw new Error(`${task.taskId} 卡片身份或阶段不满足准入`);
		const session = sessionSchema.parse(initialSessions[task.taskId]);
		if (session.agentId !== "codex" || (session.turnOwner === "agent" && session.liveness === "live"))
			throw new Error(`${task.taskId} 来源仍在执行或暂不支持此原生 Agent`);
		const identity = session.agentNativeConversationSessionIdentity;
		const nativeText = await readFile(identity.transcriptPath, "utf8");
		const nativeHistory = inspectCompletedNativeHistory(nativeText, identity.nativeSessionId);
		const directory = join(root, "frozen-tasks", task.taskId);
		await createPrivateDirectory(directory);
		await writeFile(join(directory, "parent-native-history.jsonl"), nativeText, { mode: 0o600 });
		await writeDurableJson(join(directory, "source-card-and-session.json"), { column, card, session });
		for (const [index, path] of task.review.evidencePaths.entries())
			evidence.push(await copyEvidenceFile(root, path, `source-evidence/${task.taskId}-${index}-${basename(path)}`));
		if (task.originalCohortEvidencePath)
			evidence.push(
				await copyEvidenceFile(
					root,
					task.originalCohortEvidencePath,
					`source-evidence/${task.taskId}-original-cohort.md`,
				),
			);
		const archive = join(directory, "git-working-state");
		const snapshot = await captureSourceGitWorkingState(task.worktreePath, archive);
		if (snapshot.gitCommonDirectory !== common) throw new Error("候选不属于冻结项目");
		const inspected = await inspectSnapshotCandidateTree(
			root,
			archive,
			join(root, "restoration-checks", task.taskId),
		);
		if (inspected.tree !== task.review.candidateTree)
			throw new Error(`${task.taskId} 当前完整工作树与精确 RVF 候选不一致：${inspected.tree}`);
		if (
			(await executeGit(input.projectPath, ["rev-parse", `${task.review.candidateCommit}^{tree}`]))
				.toString()
				.trim() !== inspected.tree
		)
			throw new Error("RVF commit 与 tree 的绑定不一致");
		await executeGit(join(root, "restoration-checks", task.taskId), ["index-pack", "--stdin"], {
			inputPath: join(root, "frozen-base-objects.pack"),
		});
		const changed = (
			await executeGit(join(root, "restoration-checks", task.taskId), [
				"diff",
				baseCommit,
				inspected.candidate,
				"--stat",
			])
		).length;
		if (!changed) throw new Error(`${task.taskId} 已完整包含在冻结 base，不是独立实验输入`);
		await assertSourceGitWorkingStateMatchesSnapshot(task.worktreePath, archive);
		if (fingerprint(await readFile(identity.transcriptPath)) !== nativeHistory.sha256)
			throw new Error("采集期间来源原生历史变化");
		const currentBoard = boardSchema.parse(await readJson(input.boardPath));
		const currentCard = currentBoard.columns
			.flatMap((column) => column.cards)
			.find((entry) => entry.id === task.taskId);
		const currentSession = sessionsSchema.parse(await readJson(input.sessionsPath))[task.taskId];
		if (
			JSON.stringify(currentCard) !== JSON.stringify(card) ||
			JSON.stringify(currentSession) !== JSON.stringify(initialSessions[task.taskId])
		)
			throw new Error("采集期间来源任务归属或元数据变化");
		batch.tasks.push({
			taskId: task.taskId,
			readyAt: task.review.completedAt,
			dependsOn: task.dependsOn,
			codeChangedLines: inspected.codeChangedLines,
			headCommit: snapshot.headCommit,
			snapshotRelativePath: `frozen-tasks/${task.taskId}/git-working-state`,
			nativeHistory,
			review: task.review,
		});
		await writeDurableJson(join(root, "capture-progress.json"), {
			status: "capturing",
			baseCommit,
			completedTaskIds: batch.tasks.map((entry) => entry.taskId),
		});
	}
	await assertSourceGitWorkingStateMatchesSnapshot(input.projectPath, baseArchive);
	await writeDurableJson(join(root, "frozen-batch-manifest.json"), batch);
	await writeDurableJson(join(root, "capture-progress.json"), { status: "completed", completedAt: Date.now() });
	return batch;
}

export async function verifyFrozenBatch(root: string) {
	const batch = batchManifestSchema.parse(await readJson(join(root, "frozen-batch-manifest.json")));
	await assertOwnedExperimentRoot(root, join(root, "verification"));
	for (const file of batch.evidence)
		if ((await fingerprintFile(await safeEntryPath(root, file.relativePath))) !== file.sha256)
			throw new Error("冻结的来源原件已变化");
	for (const task of batch.tasks) {
		const history = await readFile(join(root, "frozen-tasks", task.taskId, "parent-native-history.jsonl"), "utf8");
		if (
			JSON.stringify(inspectCompletedNativeHistory(history, task.nativeHistory.parentSessionId)) !==
			JSON.stringify(task.nativeHistory)
		)
			throw new Error("冻结原生历史不一致");
		const snapshot = await readSourceGitWorkingStateSnapshot(await safeEntryPath(root, task.snapshotRelativePath));
		if (
			(await fingerprintFile(join(root, task.snapshotRelativePath, "source-git-objects.pack"))) !==
			snapshot.objectPackHash
		)
			throw new Error("任务对象包变化");
	}
	return batch;
}
