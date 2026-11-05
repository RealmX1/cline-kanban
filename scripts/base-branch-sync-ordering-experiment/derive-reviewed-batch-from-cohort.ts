import { constants } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
	experimentInputSchema,
	experimentWorkloadTaskIdSchema,
	fingerprint,
	inspectCompletedNativeHistory,
	taskIdSchema,
} from "./experiment-contract";
import { type FrozenBatch, inspectSnapshotCandidateTree } from "./frozen-source-snapshot";
import {
	createOwnedExperimentRoot,
	createPrivateDirectory,
	executeGit,
	fingerprintFile,
	readJson,
	safeEntryPath,
	writeDurableJson,
} from "./persistent-experiment-storage";

export const cohortEligibilityInputSchema = z.object({
	schemaVersion: z.literal(1),
	decisions: z.array(
		z.object({
			taskId: taskIdSchema,
			status: z.enum(["inspect-exact-rvf", "coverage-pending", "covered-by-parent"]),
			reason: z.string().min(1),
			coveredByTaskId: taskIdSchema.optional(),
			runRelativePath: z.string().optional(),
			validationRelativePath: z.string().optional(),
			stageEventsRelativePath: z.string().optional(),
		}),
	),
});

const cohortSchema = z.object({
	experimentId: z.string(),
	baseCommit: z.string(),
	input: z.object({ projectPath: z.string(), baseRef: z.string(), requestArrivedAt: z.number() }),
	taskResults: z.array(z.object({ taskId: taskIdSchema, headCommit: z.string(), restoredTree: z.string() })),
});

export async function deriveReviewedBatchFromCohort(
	source: string,
	destination: string,
	decisionsPath: string,
	currentRepositoryBackupDirectory?: string,
) {
	const seal = z
		.object({
			status: z.literal("backup-complete-and-offline-restoration-verified"),
			files: z.record(z.string(), z.string()),
		})
		.parse(await readJson(join(source, "backup-acceptance-record.json")));
	const manifestPath = join(source, "reusable-cohort-backup-manifest.json");
	if ((await fingerprintFile(manifestPath)) !== seal.files["reusable-cohort-backup-manifest.json"])
		throw new Error("总备份清单不匹配验收封存");
	const cohort = cohortSchema.parse(await readJson(manifestPath));
	let baseCommit = cohort.baseCommit;
	let basePackSource = join(source, "base-and-reviewed-candidate-objects.pack");
	let currentRepositoryManifestSha256: string | null = null;
	if (currentRepositoryBackupDirectory) {
		const currentPath = join(currentRepositoryBackupDirectory, "current-repository-state-backup-manifest.json");
		const current = z
			.object({
				status: z.literal("current-repository-state-backed-up-and-restored"),
				baseCommit: z.string(),
				objectPackSha256: z.string(),
				candidateDrift: z.array(z.object({ taskId: z.string(), unchangedSinceCohortBackup: z.boolean() })),
			})
			.parse(await readJson(currentPath));
		if (current.candidateDrift.some((task) => !task.unchangedSinceCohortBackup))
			throw new Error("候选已有漂移，先核验新候选，不能套用旧评审资格");
		basePackSource = join(currentRepositoryBackupDirectory, "all-recorded-refs-and-worktree-heads.pack");
		if ((await fingerprintFile(basePackSource)) !== current.objectPackSha256)
			throw new Error("实验实际 base 的对象包不匹配仓库快照");
		baseCommit = current.baseCommit;
		currentRepositoryManifestSha256 = await fingerprintFile(currentPath);
	}
	const decisions = cohortEligibilityInputSchema.parse(await readJson(decisionsPath));
	if (
		decisions.decisions.length !== cohort.taskResults.length ||
		new Set(decisions.decisions.map((item) => item.taskId)).size !== cohort.taskResults.length ||
		decisions.decisions.some((item) => !cohort.taskResults.some((task) => task.taskId === item.taskId))
	)
		throw new Error("资格判断必须覆盖全部备份任务，不能默默丢弃候选");
	const sourceOwner = z
		.object({ sourceCommonDirectory: z.string() })
		.parse(await readJson(join(source, "experiment-ownership.json")));
	const owner = await createOwnedExperimentRoot(destination, sourceOwner.sourceCommonDirectory);
	const evidence = [];
	const inputTasks = [];
	const tasks: FrozenBatch["tasks"] = [];
	const audit: {
		taskId: string;
		status: string;
		reason: string;
		frozenTree: string;
		reviewedTree?: string;
		coveredByTaskId?: string;
	}[] = [];
	await cp(basePackSource, join(destination, "frozen-base-objects.pack"), {
		mode: constants.COPYFILE_FICLONE,
	});
	await writeDurableJson(join(destination, "frozen-base-object-pack.json"), {
		baseCommit,
		sha256: await fingerprintFile(join(destination, "frozen-base-objects.pack")),
	});
	await cp(
		join(source, "base-and-reviewed-candidate-objects.pack"),
		join(destination, "reviewed-candidate-objects.pack"),
		{ mode: constants.COPYFILE_FICLONE },
	);
	for (const [path, origin] of [
		["frozen-base-objects.pack", basePackSource],
		["reviewed-candidate-objects.pack", join(source, "base-and-reviewed-candidate-objects.pack")],
	])
		evidence.push({ sourcePath: origin, relativePath: path, sha256: await fingerprintFile(join(destination, path)) });
	for (const decision of decisions.decisions) {
		const frozen = cohort.taskResults.find((task) => task.taskId === decision.taskId);
		if (!frozen) throw new Error("资格判断引用了未备份任务");
		if (!experimentWorkloadTaskIdSchema.safeParse(frozen.taskId).success) {
			audit.push({
				taskId: frozen.taskId,
				status: "excluded-from-experiment-workload",
				reason: "任务已明确排除实验工作负载；原始备份和历史资格决定保持不变",
				frozenTree: frozen.restoredTree,
			});
			continue;
		}
		if (decision.status !== "inspect-exact-rvf") {
			if (
				decision.status === "covered-by-parent" &&
				(!decision.coveredByTaskId || !cohort.taskResults.some((task) => task.taskId === decision.coveredByTaskId))
			)
				throw new Error("父子去重缺少同批次父交付身份");
			audit.push({
				taskId: frozen.taskId,
				status: decision.status,
				reason: decision.reason,
				frozenTree: frozen.restoredTree,
				coveredByTaskId: decision.coveredByTaskId,
			});
			continue;
		}
		if (!decision.runRelativePath || !decision.validationRelativePath || !decision.stageEventsRelativePath)
			throw new Error("缺少精确 RVF 原件定位");
		const run = z
			.object({
				status: z.string(),
				candidate_commit: z.string(),
				validated_candidate_commit: z.string().optional(),
			})
			.parse(await readJson(await safeEntryPath(source, decision.runRelativePath)));
		const validation = z
			.object({ status: z.string(), tested_tree: z.string() })
			.parse(await readJson(await safeEntryPath(source, decision.validationRelativePath)));
		const events = z
			.object({
				events: z.array(z.object({ observed_at: z.number(), status: z.string().optional() }).passthrough()),
			})
			.parse(await readJson(await safeEntryPath(source, decision.stageEventsRelativePath)));
		const completedAt = Math.max(
			...events.events
				.filter((event) => event.status === "ready_to_commit")
				.map((event) => Math.floor(event.observed_at * 1000)),
		);
		if (
			run.status !== "ready_to_commit" ||
			validation.status !== "passed" ||
			validation.tested_tree !== frozen.restoredTree ||
			!Number.isFinite(completedAt)
		) {
			audit.push({
				taskId: frozen.taskId,
				status: "coverage-pending",
				reason: "原 run、最终验证或当前完整树不满足精确准入",
				frozenTree: frozen.restoredTree,
				reviewedTree: validation.tested_tree,
			});
			continue;
		}
		const taskDirectory = join(destination, "frozen-tasks", frozen.taskId);
		await createPrivateDirectory(taskDirectory);
		const metadata = z
			.object({
				board: z.object({
					columns: z.array(
						z.object({
							id: z.string(),
							cards: z.array(
								z.object({ id: z.string(), createdAt: z.number(), prompt: z.string() }).passthrough(),
							),
						}),
					),
				}),
				sessions: z.record(z.string(), z.unknown()),
			})
			.parse(await readJson(join(source, "tasks", frozen.taskId, "source-task-metadata.json")));
		const card = metadata.board.columns.flatMap((column) => column.cards).find((card) => card.id === frozen.taskId);
		if (!card) throw new Error("冻结看板中缺少原卡片 incarnation");
		const session = z
			.object({
				agentNativeConversationSessionIdentity: z.object({
					nativeSessionId: z.string(),
					transcriptPath: z.string(),
				}),
			})
			.passthrough()
			.parse(metadata.sessions[frozen.taskId]);
		const identity = session.agentNativeConversationSessionIdentity;
		const parentPath = join(
			source,
			"tasks",
			frozen.taskId,
			"native-conversations",
			identity.nativeSessionId,
			basename(identity.transcriptPath),
		);
		const parentText = await readFile(parentPath, "utf8");
		const history = inspectCompletedNativeHistory(parentText, identity.nativeSessionId);
		const activityTimes = parentText
			.split("\n")
			.filter(Boolean)
			.map((line) => z.object({ type: z.string(), timestamp: z.string().optional() }).parse(JSON.parse(line)))
			.filter((row) => row.type === "turn_context" && row.timestamp)
			.map((row) => Date.parse(row.timestamp ?? ""))
			.filter(Number.isFinite);
		if (!activityTimes.length) throw new Error("缺少原生实施活动时间证据");
		const timesInWindow = activityTimes.filter(
			(time) => time <= cohort.input.requestArrivedAt && time >= cohort.input.requestArrivedAt - 86_400_000,
		);
		const implementationActivityAt = timesInWindow.length ? Math.max(...timesInWindow) : Math.min(...activityTimes);
		await writeFile(join(taskDirectory, "parent-native-history.jsonl"), parentText, { mode: 0o600 });
		await writeDurableJson(join(taskDirectory, "source-card-and-session.json"), { card, session });
		await cp(join(source, "tasks", frozen.taskId, "git-working-state"), join(taskDirectory, "git-working-state"), {
			recursive: true,
			mode: constants.COPYFILE_FICLONE,
		});
		const inspected = await inspectSnapshotCandidateTree(
			destination,
			join(taskDirectory, "git-working-state"),
			join(destination, "restoration-checks", frozen.taskId),
		);
		if (inspected.tree !== frozen.restoredTree) throw new Error("派生输入的完整树与总备份不一致");
		const candidateCommit = run.validated_candidate_commit ?? run.candidate_commit;
		await executeGit(join(destination, "restoration-checks", frozen.taskId), ["index-pack", "--stdin"], {
			inputPath: join(destination, "reviewed-candidate-objects.pack"),
		});
		await executeGit(join(destination, "restoration-checks", frozen.taskId), ["index-pack", "--stdin"], {
			inputPath: join(destination, "frozen-base-objects.pack"),
		});
		if (
			(
				await executeGit(join(destination, "restoration-checks", frozen.taskId), [
					"rev-parse",
					`${candidateCommit}^{tree}`,
				])
			)
				.toString()
				.trim() !== inspected.tree
		)
			throw new Error("RVF 候选 commit 与当前树绑定不一致");
		const evidencePaths = [];
		for (const relativePath of [
			decision.runRelativePath,
			decision.validationRelativePath,
			decision.stageEventsRelativePath,
		]) {
			const path = `source-evidence/${frozen.taskId}-${basename(relativePath)}`;
			await createPrivateDirectory(join(destination, "source-evidence"));
			await cp(await safeEntryPath(source, relativePath), join(destination, path), {
				mode: constants.COPYFILE_FICLONE,
			});
			evidence.push({
				sourcePath: join(source, relativePath),
				relativePath: path,
				sha256: await fingerprintFile(join(destination, path)),
			});
			evidencePaths.push(join(destination, path));
		}
		const review = { candidateCommit, candidateTree: inspected.tree, completedAt, evidencePaths };
		inputTasks.push({
			taskId: frozen.taskId,
			taskIncarnationCreatedAt: card.createdAt,
			worktreePath: join(destination, "restoration-checks", frozen.taskId),
			implementationActivityAt,
			originalCohortEvidencePath: join(source, "backup-acceptance-record.json"),
			dependsOn: [],
			review,
		});
		tasks.push({
			taskId: frozen.taskId,
			readyAt: completedAt,
			codeChangedLines: inspected.codeChangedLines,
			dependsOn: [],
			headCommit: frozen.headCommit,
			snapshotRelativePath: `frozen-tasks/${frozen.taskId}/git-working-state`,
			nativeHistory: history,
			review,
		});
		audit.push({
			taskId: frozen.taskId,
			status: "exact-rvf-eligible",
			reason: decision.reason,
			frozenTree: inspected.tree,
			reviewedTree: inspected.tree,
		});
	}
	await writeDurableJson(join(destination, "cohort-eligibility-and-delivery-deduplication.json"), {
		cohortExperimentId: cohort.experimentId,
		sourceAcceptanceSha256: await fingerprintFile(join(source, "backup-acceptance-record.json")),
		currentRepositoryBackupDirectory,
		currentRepositoryManifestSha256,
		originalCohortBaseCommit: cohort.baseCommit,
		actualExperimentBaseCommit: baseCommit,
		backedUpTaskCount: cohort.taskResults.length,
		decisions: audit,
		assessedAt: Date.now(),
	});
	if (!tasks.length) throw new Error("尚无精确准入任务；全部原始备份和判断均保留");
	const batch: FrozenBatch = {
		schemaVersion: 1,
		experimentId: owner.experimentId,
		createdAt: Date.now(),
		baseCommit,
		evidence,
		tasks,
		input: experimentInputSchema.parse({
			schemaVersion: 1,
			workspaceId: "cline-kanban",
			requestArrivedAt: cohort.input.requestArrivedAt,
			projectPath: cohort.input.projectPath,
			baseRef: cohort.input.baseRef,
			boardPath: join(source, "workspace-state-at-capture/board.json"),
			sessionsPath: join(source, "workspace-state-at-capture/sessions.json"),
			workflowEvidencePaths: [],
			tasks: inputTasks,
		}),
	};
	await writeDurableJson(join(destination, "frozen-batch-manifest.json"), batch);
	await writeDurableJson(join(destination, "frozen-input-identity.json"), {
		batchSha256: fingerprint(JSON.stringify(batch)),
		sourceCohortDirectory: source,
	});
	return batch;
}
