import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type {
	ExistingCloseoutGoalCompletionReconciliation,
	RvfCloseoutGoalCompletedStage,
} from "../core/rvf-closeout-goal-completion-contract";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { readNormalRvfCloseoutSuppression } from "./independent-backup-route-ownership";
import {
	CloseoutCompletionEvidenceConflict,
	type CloseoutGoalCompletionSourceFile,
	discoverCloseoutGoalCompletionEvidencePaths,
	readCloseoutCompletionRegularFile,
	readCloseoutGoalCommitFacts,
	readIndependentBackupCompletionFromSource,
	verifyCloseoutGoalOriginalRunBinding,
	verifyHistoricalManualCloseoutEvidence,
	verifyImmutableCloseoutLandGoalEvidence,
} from "./read-existing-closeout-goal-completion-evidence";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
	withRvfAutomaticCloseoutRecordOperationLock,
} from "./rvf-automatic-closeout-store";
import type { ExecutionRecoveryDependencies } from "./rvf-closeout-execution-stage-recovery";
import {
	boundRvfCloseoutGoalCompletion,
	completedRvfCloseoutStage,
	rvfCloseoutReceiptSha256,
	sameRvfCloseoutObservationBinding,
} from "./rvf-closeout-scheduling-decision";
import { readBoundRvfLocalBaseRef } from "./validate-rvf-automatic-closeout-execution-result";

async function persistContentAddressedCompletionOriginal(directory: string, bytes: Buffer) {
	const sha256 = computeRvfTextSha256(bytes);
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${sha256}.json`);
	const existing = await readFile(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (existing?.equals(bytes)) return { path, sha256 };
	const writingPath = join(directory, `.${sha256}.${randomUUID()}.writing`);
	try {
		const handle = await open(writingPath, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (existing) {
			// 旧版本或断电留下的未完整原件保留取证，再用仍可核验的来源自动恢复同一内容地址。
			const incompleteDirectory = join(directory, "incomplete-originals");
			await mkdir(incompleteDirectory, { recursive: true });
			await rename(path, join(incompleteDirectory, `${sha256}-${computeRvfTextSha256(existing)}.json`)).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				},
			);
		}
		await rename(writingPath, path);
		const parent = await open(directory, "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		await unlink(writingPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
	return { path, sha256 };
}

export async function reconcileExistingCloseoutGoalCompletionOnce(
	deps: Pick<ExecutionRecoveryDependencies, "workspaceId" | "isStopped">,
	original: RvfAutomaticCloseoutRecord,
	assertObservationStillOwned?: () => void,
): Promise<RvfAutomaticCloseoutRecord> {
	if (
		original.workspaceId !== deps.workspaceId ||
		!original.runId ||
		!original.runDirectory ||
		!original.handoffSha256 ||
		["captured_review_start_boundary", "awaiting_rvf_completion"].includes(original.status) ||
		deps.isStopped(original)
	)
		return original;
	const storePath = getRvfAutomaticCloseoutStorePath(deps.workspaceId);
	let observed = original;
	const observe = async (assertOwned: () => void) => {
		const record = (await readRvfAutomaticCloseoutRecords(storePath)).find((entry) =>
			sameRvfCloseoutObservationBinding(entry, original),
		);
		if (!record || deps.isStopped(record)) return;
		observed = record;
		const previous = boundRvfCloseoutGoalCompletion(record);
		if (previous?.verdict === "completed") return;
		const now = Date.now();
		const newlyAcceptedStage = (["land", "base_branch_sync"] as const).some((stage) => {
			const accepted = stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
			return accepted?.outcome === "completed" && !previous?.verifiedStages.some((prior) => prior.stage === stage);
		});
		if (
			previous &&
			!newlyAcceptedStage &&
			!assertObservationStillOwned &&
			(previous.recovery.verificationAttemptCount >= 3
				? previous.recovery.nextCapabilityProbeAtMs
				: previous.recovery.nextVerificationAtMs) > now
		)
			return;
		const git = (args: string[]) =>
			getGitStdout(["-c", "core.hooksPath=/dev/null", ...args], record.receipt.worktree);
		const probeGit = (args: string[]) => git(args).catch(() => "unavailable");
		const gitDirectory = await probeGit(["rev-parse", "--absolute-git-dir"]);
		const baseRef = await readBoundRvfLocalBaseRef(record)
			.then((entry) => entry.baseRef)
			.catch(() => record.receipt.comparison_base_ref);
		const localBaseRef =
			baseRef && (!baseRef.startsWith("refs/") || baseRef.startsWith("refs/heads/"))
				? baseRef.startsWith("refs/heads/")
					? baseRef
					: `refs/heads/${baseRef}`
				: null;
		const gitInputs = await Promise.all([
			probeGit(["rev-parse", "HEAD"]),
			localBaseRef ? probeGit(["rev-parse", "--verify", localBaseRef]) : "missing_base",
			probeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		]);
		const completionOriginalsDirectory = join(dirname(storePath), "rvf-closeout-goal-completion-originals");
		const originalStorageMetadata = await stat(completionOriginalsDirectory).catch(() => null);
		let paths: string[] = [];
		let discoveryFailure = false;
		try {
			paths = await discoverCloseoutGoalCompletionEvidencePaths(record, gitDirectory);
		} catch {
			discoveryFailure = true;
		}
		const metadataPaths = [
			...paths,
			record.handoffPath ?? "",
			join(record.runDirectory ?? "", "inputs", "automatic-closeout-review-start-receipt.json"),
			join(record.runDirectory ?? "", "artifacts", "inputs", "scope.contract.json"),
			join(record.runDirectory ?? "", "artifacts", "after-workspace-snapshot.json"),
			join(record.runDirectory ?? "", "artifacts", "final-source-manifest.json"),
		];
		// 对象数据库元数据涵盖松散对象补回；已发现目标另外探测可读性，预算跨重启保留。
		metadataPaths.push(
			join(gitInputs[2], "objects"),
			join(gitInputs[2], "objects", "pack"),
			...(previous?.recovery.evidenceDependencyPaths ?? []),
		);
		// 缺失阶段原件也要进入探测集合；恢复原件而 stage-fact 未改字节时仍能重开预算。
		for (const dependencyPath of previous?.recovery.evidenceDependencyPaths ?? []) {
			if (basename(dirname(dependencyPath)) !== "stage-facts") continue;
			try {
				const file = await readCloseoutCompletionRegularFile(dependencyPath);
				const locator = z
					.object({ evidence: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }) })
					.parse(JSON.parse(file.bytes.toString("utf8")));
				if (
					dirname(resolve(locator.evidence.path)) === resolve(dirname(dirname(dependencyPath)), "raw-evidence") &&
					basename(locator.evidence.path).startsWith(locator.evidence.sha256)
				)
					metadataPaths.push(locator.evidence.path);
			} catch {
				/* 定位材料的变化已由其元数据触发完整核验，不从未知定位读取任意原件。 */
			}
		}
		const metadata = await Promise.all(
			metadataPaths.map(async (path) => {
				const entry = await stat(path).catch(() => null);
				return [path, entry ? [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs] : null];
			}),
		);
		const targetAvailability = await Promise.all(
			[
				...new Set([
					record.receipt.checkpoint_commit,
					...(previous?.verifiedStages ?? []).map((stage) => stage.commitSha),
					...(previous?.recovery.discoveredTargetCommitShas ?? []),
				]),
			]
				.sort()
				.map(async (target) => [target, await probeGit(["cat-file", "-e", `${target}^{commit}`])]),
		);
		const fingerprint = computeRvfTextSha256(
			JSON.stringify([
				"goal-completion-reader/v1",
				record.runId,
				record.handoffSha256,
				rvfCloseoutReceiptSha256(record),
				record.landExecutionResult,
				record.baseBranchSyncExecutionResult,
				gitInputs,
				metadata,
				targetAvailability,
				discoveryFailure,
				originalStorageMetadata
					? [originalStorageMetadata.dev, originalStorageMetadata.ino, originalStorageMetadata.mode]
					: null,
			]),
		);
		const sameInput = previous?.recovery.fingerprint === fingerprint;
		if (
			sameInput &&
			(previous.recovery.verificationAttemptCount >= 3
				? previous.recovery.nextCapabilityProbeAtMs
				: previous.recovery.nextVerificationAtMs) > now
		)
			return;
		if (sameInput && previous.recovery.verificationAttemptCount >= 3) {
			observed = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
				assertOwned();
				const current = records.find((entry) => sameRvfCloseoutObservationBinding(entry, record));
				if (!current || deps.isStopped(current) || boundRvfCloseoutGoalCompletion(current)?.verdict === "completed")
					return { records, value: current ?? record };
				const updated = {
					...current,
					existingCloseoutGoalCompletionReconciliation: {
						...previous,
						recovery: { ...previous.recovery, nextCapabilityProbeAtMs: now + 60_000 },
					},
				};
				return { records: records.map((entry) => (entry === current ? updated : entry)), value: updated };
			});
			return;
		}
		const snapshotDirectory = completionOriginalsDirectory;
		const references = sameInput ? [...(previous?.evidenceReferences ?? [])] : [];
		const discoveredTargetCommitShas = new Set(previous?.recovery.discoveredTargetCommitShas ?? []);
		const evidenceDependencyPaths = new Set(previous?.recovery.evidenceDependencyPaths ?? []);
		const sourceFiles: CloseoutGoalCompletionSourceFile[] = [];
		const capture = async (file: CloseoutGoalCompletionSourceFile) => {
			const snapshot = await persistContentAddressedCompletionOriginal(snapshotDirectory, file.bytes);
			if (!references.some((entry) => entry.sourcePath === file.path && entry.sha256 === snapshot.sha256))
				references.push({ sourcePath: file.path, sha256: snapshot.sha256, snapshotPath: snapshot.path });
			try {
				const value: Record<string, unknown> = JSON.parse(file.bytes.toString("utf8"));
				for (const key of [
					"commitSha",
					"landCommitSha",
					"taskTip",
					"expectedBaseTip",
					"baseTipAfterLanding",
					"fixedBaseTip",
					"final_head",
					"commit",
					"task_head",
					"base_tip",
				])
					if (typeof value[key] === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value[key]))
						discoveredTargetCommitShas.add(value[key]);
				if (typeof value.artifacts_directory === "string" && value.artifacts_directory.startsWith("/")) {
					for (const suffix of [
						"backup-route-delivery-result.json",
						"stage-facts/land.json",
						"stage-facts/base_sync.json",
					])
						evidenceDependencyPaths.add(join(value.artifacts_directory, suffix));
				}
			} catch {
				/* 正文原件只保留摘要，不从自然语言推断完成。 */
			}
		};
		const stages = [...(previous?.verifiedStages ?? [])];
		let externalConsumption = previous?.externalConsumption;
		// 前页无法保存为原件的冲突也随同一输入延续；材料变化后从头核验，避免永久粘住。
		const gaps: ExistingCloseoutGoalCompletionReconciliation["verificationGaps"] = sameInput
			? (previous?.verificationGaps ?? []).filter((gap) => gap.reasonCode === "completion_evidence_conflict")
			: [];
		let conflict = gaps.length > 0;
		const recordGap = (error: unknown, evidenceSourcePath?: string) => {
			const evidenceConflict = error instanceof CloseoutCompletionEvidenceConflict || error instanceof z.ZodError;
			conflict ||= evidenceConflict;
			const gap = {
				reasonCode: evidenceConflict ? "completion_evidence_conflict" : "completion_evidence_unavailable",
				reason:
					error instanceof CloseoutCompletionEvidenceConflict
						? error.message
						: evidenceConflict
							? "完成材料结构不符合已知协议。"
							: "原件、Git 对象或核验能力暂不可用。",
				recoveryCondition:
					"原 run 的持久材料、目标 Git 对象或本地 base 状态变化后自动重验；保留原失败，不唤醒 Agent。",
				...(evidenceSourcePath ? { evidenceSourcePath } : {}),
			};
			if (
				!gaps.some(
					(prior) =>
						prior.reasonCode === gap.reasonCode &&
						prior.reason === gap.reason &&
						prior.evidenceSourcePath === gap.evidenceSourcePath,
				)
			)
				gaps.push(gap);
		};
		const acceptStage = (stage: RvfCloseoutGoalCompletedStage) => {
			const prior = stages.find((entry) => entry.stage === stage.stage);
			if (prior && prior.commitSha !== stage.commitSha)
				throw new CloseoutCompletionEvidenceConflict("同一阶段存在多个无法唯一关联的完成目标。");
			if (!prior) stages.push(stage);
		};
		// 服务端曾接受的阶段事实无需重新依赖可替换的当前候选指针。
		for (const stage of ["land", "base_branch_sync"] as const) {
			const accepted = stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
			if (accepted?.outcome === "completed" && accepted.commitSha)
				acceptStage({
					stage,
					commitSha: accepted.commitSha,
					...(accepted.baseRef ? { baseRef: accepted.baseRef } : {}),
					source: "server_accepted_stage_result",
					evidenceSha256s: [],
					observedAt: accepted.reportedAt,
				});
		}
		const stagesAcceptedBeforeCurrentVerification = [...stages];
		const expectedCommonDirectory =
			previous?.binding.gitCommonDirectoryRealpath ??
			record.landExecutionResult?.supplementalLandCompletionVerification?.gitCommonDirectoryRealpath ??
			record.baseBranchSyncExecutionResult?.baseIntegrationObservation?.gitCommonDirectoryRealpath;
		const repositoryIdentityAvailable = gitInputs[2] !== "unavailable";
		if (expectedCommonDirectory && repositoryIdentityAvailable && expectedCommonDirectory !== gitInputs[2])
			recordGap(new CloseoutCompletionEvidenceConflict("Git common directory 与已接受的历史归属不符。"));
		let originalBindingVerified = false;
		try {
			for (const file of await verifyCloseoutGoalOriginalRunBinding(record)) await capture(file);
			originalBindingVerified = true;
		} catch (error) {
			recordGap(error);
		}
		const afterPath = sameInput ? previous?.recovery.discoveryAfterPath : null;
		const unvisited = paths.filter((path) => !afterPath || path > afterPath);
		const page = unvisited.slice(0, 64);
		const discoveryComplete = !discoveryFailure && unvisited.length <= page.length;
		for (const path of page) {
			try {
				const file = await readCloseoutCompletionRegularFile(path);
				if (path.includes("rvf-independent-backup-route")) {
					const binding = z
						.object({ original_run_directory: z.string().nullish() })
						.parse(JSON.parse(file.bytes.toString("utf8")));
					if (binding.original_run_directory !== record.runDirectory) continue;
				}
				await capture(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") recordGap(error, path);
			}
		}
		for (const reference of references) {
			if (!paths.includes(reference.sourcePath)) continue;
			try {
				const bytes = await readFile(reference.snapshotPath);
				if (computeRvfTextSha256(bytes) !== reference.sha256)
					throw new CloseoutCompletionEvidenceConflict("已保存的原件摘要不符。");
				sourceFiles.push({ path: reference.sourcePath, bytes });
			} catch (error) {
				recordGap(error, reference.sourcePath);
			}
		}
		if (!discoveryComplete)
			gaps.push({
				reasonCode: "completion_discovery_incomplete",
				reason: "完成材料尚未扫描完毕。",
				recoveryCondition: "后台沿持久游标继续读取下一页，不将未查完视为未完成。",
			});
		if (originalBindingVerified && repositoryIdentityAvailable && discoveryComplete && !conflict) {
			try {
				const immutable = await verifyImmutableCloseoutLandGoalEvidence(record, sourceFiles);
				for (const file of immutable.additionalFiles) await capture(file);
				for (const stage of immutable.stages) acceptStage(stage);
			} catch (error) {
				recordGap(error);
			}
			try {
				const manual = await verifyHistoricalManualCloseoutEvidence(
					record,
					sourceFiles,
					completedRvfCloseoutStage(record, "land")?.commitSha,
				);
				for (const file of manual.additionalFiles) await capture(file);
				for (const stage of manual.stages) acceptStage(stage);
			} catch (error) {
				recordGap(error);
			}
			for (const file of sourceFiles.filter((entry) => entry.path.includes("rvf-independent-backup-route"))) {
				try {
					const backup = await readIndependentBackupCompletionFromSource(record, file, gitDirectory);
					if (!backup) continue;
					if (externalConsumption && externalConsumption.operationId !== backup.externalConsumption.operationId)
						throw new CloseoutCompletionEvidenceConflict("原 run 存在多个备用消费 operation。");
					externalConsumption ??= backup.externalConsumption;
					for (const additional of backup.additionalFiles) await capture(additional);
					for (const stage of backup.stages) acceptStage(stage);
					for (const error of backup.stageVerificationErrors) recordGap(error);
				} catch (error) {
					recordGap(error);
				}
			}
		}
		const land = stages.find((stage) => stage.stage === "land");
		if (
			land &&
			!stages.some((stage) => stage.stage === "base_branch_sync") &&
			localBaseRef &&
			repositoryIdentityAvailable &&
			!conflict
		) {
			try {
				await git(["merge-base", "--is-ancestor", land.commitSha, gitInputs[1]]);
				await git(["merge-base", "--is-ancestor", gitInputs[1], localBaseRef]);
				const facts = await readCloseoutGoalCommitFacts(record, gitInputs[1]);
				acceptStage({
					stage: "base_branch_sync",
					...facts,
					baseRef: localBaseRef,
					landCommitSha: land.commitSha,
					source: "observed_local_base_ancestry",
					evidenceSha256s: land.evidenceSha256s,
					observedAt: now,
				});
			} catch (error) {
				recordGap(error);
			}
		}
		if (!stages.length && !gaps.length)
			gaps.push({
				reasonCode: "completion_not_yet_proven",
				reason: "尚无独立核验的完成目标。",
				recoveryCondition: "等待绑定原 run 的规范结果、补充证明或兼容手动原件自动出现。",
			});
		// 本轮所有来源核验结束后才接受新阶段；迟到的冲突不能把先取得的候选固化成完成事实。
		const verifiedStages = conflict ? stagesAcceptedBeforeCurrentVerification : stages;
		const completed =
			verifiedStages.some((stage) => stage.stage === "land") &&
			verifiedStages.some((stage) => stage.stage === "base_branch_sync");
		const observation: ExistingCloseoutGoalCompletionReconciliation = {
			schema: "kanban-existing-closeout-goal-completion/v1",
			binding: {
				workspaceId: record.workspaceId,
				taskId: record.taskId,
				decisionToken: record.receipt.decision_token,
				runId: record.runId ?? "",
				runDirectory: record.runDirectory ?? "",
				handoffSha256: record.handoffSha256 ?? "",
				receiptSha256: rvfCloseoutReceiptSha256(record),
				worktreeRealpath:
					previous?.binding.worktreeRealpath ?? (await realpath(record.receipt.worktree).catch(() => undefined)),
				gitCommonDirectoryRealpath:
					expectedCommonDirectory ?? (gitInputs[2] === "unavailable" ? undefined : gitInputs[2]),
			},
			verdict: completed
				? "completed"
				: conflict
					? "evidence_conflict"
					: externalConsumption
						? "externally_consumed"
						: verifiedStages.length
							? "partially_completed"
							: "machine_waiting",
			verifiedStages,
			...(externalConsumption ? { externalConsumption } : {}),
			evidenceReferences: references,
			verificationGaps: gaps,
			observedAt: now,
			recovery: {
				fingerprint,
				verificationAttemptCount: discoveryComplete
					? sameInput
						? Math.min(3, (previous?.recovery.verificationAttemptCount ?? 0) + 1)
						: 1
					: 0,
				nextVerificationAtMs: discoveryComplete ? now + 15_000 : now,
				nextCapabilityProbeAtMs: now + 60_000,
				discoveryAfterPath: discoveryComplete ? null : (page.at(-1) ?? afterPath ?? null),
				discoveryComplete,
				discoveredTargetCommitShas: [...discoveredTargetCommitShas].sort(),
				evidenceDependencyPaths: [...evidenceDependencyPaths].sort(),
			},
		};
		try {
			observation.observationSnapshot = await persistContentAddressedCompletionOriginal(
				snapshotDirectory,
				Buffer.from(JSON.stringify(observation)),
			);
		} catch {
			// 原件存储故障仍落到可写的记录账本，保留预算；不接受没有持久原件的新完成事实。
			observation.verifiedStages = previous?.verifiedStages ?? [];
			observation.externalConsumption = previous?.externalConsumption;
			observation.verdict = conflict
				? "evidence_conflict"
				: previous?.externalConsumption
					? "externally_consumed"
					: observation.verifiedStages.length
						? "partially_completed"
						: "machine_waiting";
			observation.verificationGaps.push({
				reasonCode: "completion_original_storage_unavailable",
				reason: "内容寻址原件暂不能持久保存。",
				recoveryCondition: "原件目录写入能力恢复后自动重验；原失败和已接受事实继续保留。",
			});
		}
		if (
			(await readNormalRvfCloseoutSuppression(record.receipt.worktree, record.runDirectory))?.reason ===
			"active_backup_route_ownership"
		)
			return;
		assertOwned();
		observed = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
			assertOwned();
			const current = records.find((entry) => sameRvfCloseoutObservationBinding(entry, record));
			if (!current || deps.isStopped(current) || boundRvfCloseoutGoalCompletion(current)?.verdict === "completed")
				return { records, value: current ?? record };
			const updated = { ...current, existingCloseoutGoalCompletionReconciliation: observation };
			return { records: records.map((entry) => (entry === current ? updated : entry)), value: updated };
		});
	};
	if (assertObservationStillOwned) await observe(assertObservationStillOwned);
	else await withRvfAutomaticCloseoutRecordOperationLock(storePath, original.receipt.decision_token, observe);
	return observed;
}
