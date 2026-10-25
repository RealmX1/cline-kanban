import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type RvfAutomaticCloseoutExecutionResultReportRequest,
	type RvfAutomaticCloseoutRecord,
	rvfAutomaticCloseoutExecutionResultReportRequestSchema,
} from "../core/rvf-automatic-closeout-contract";
import type {
	RvfCloseoutSkillEvidenceReference,
	rvfCloseoutStageClaimRequestSchema,
	rvfCloseoutStageClaimResponseSchema,
} from "../core/rvf-automatic-closeout-recovery-contract";
import { MODAL_USER_DECISION_TURN_KINDS, resolveSessionFacets } from "../core/session-activity";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { inspectRvfCompletionEvidence } from "./inspect-rvf-completion-evidence";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
} from "./rvf-automatic-closeout-store";
import {
	appendRvfCloseoutSkillEvidence,
	captureRvfCloseoutAcceptedSkillSnapshot,
} from "./rvf-closeout-skill-attachment-snapshot-store";
import { readRvfCloseoutWorkspaceStateDigest } from "./rvf-closeout-workspace-state-digest";
import {
	RvfAutomaticCloseoutExecutionResultDeliveryPendingError,
	validateRvfAutomaticCloseoutExecutionResult,
} from "./validate-rvf-automatic-closeout-execution-result";
import { verifyRvfCloseoutContinuationNativeAcceptance } from "./verify-rvf-closeout-continuation-native-acceptance";

interface ExecutionRecoveryDependencies {
	workspaceId: string;
	rvfHome: string;
	getMainSummary: () => Promise<RuntimeTaskSessionSummary>;
	isStopped: (record: RvfAutomaticCloseoutRecord) => boolean;
	verifyLateAcceptance: (record: RvfAutomaticCloseoutRecord) => Promise<unknown>;
}
function sameBinding(
	record: RvfAutomaticCloseoutRecord,
	input: { taskId: string; decisionToken: string; runId: string; handoffSha256: string },
) {
	return (
		record.taskId === input.taskId &&
		record.receipt.decision_token === input.decisionToken &&
		record.runId === input.runId &&
		record.handoffSha256 === input.handoffSha256
	);
}
export function resolveRvfCloseoutActiveDelivery(record: RvfAutomaticCloseoutRecord) {
	const continuation = record.promptDeliveryAttempts?.[0];
	return {
		deliveryAttemptId: continuation?.deliveryAttemptId ?? `initial-${record.receipt.decision_token}`,
		idempotencyKey: continuation?.idempotencyKey ?? record.promptDeliveryIdempotencyKey,
		nativeSessionId: continuation?.nativeSessionId ?? record.restoredNativeSessionId,
		conversationSessionId: continuation?.conversationSessionId ?? record.conversationSessionId,
		continuation,
	};
}
export async function readBoundRvfLandExecutionResult(record: RvfAutomaticCloseoutRecord) {
	if (!record.runDirectory) throw new Error("缺少已绑定的 RVF run。");
	const path = join(record.runDirectory, "artifacts", "rvf-land-commit-result.json");
	if ((await lstat(path)).isSymbolicLink()) throw new Error("Land 规范执行结果不能是符号链接。");
	const bytes = await readFile(path);
	const raw: unknown = JSON.parse(bytes.toString("utf8"));
	// 该格式是已安装 RVF writer 的规范输出，不能由 CLI 报告中的 completed 自我授证。
	const result = raw as {
		run_id?: string;
		run_dir?: string;
		repo_root?: string;
		head_oid_after_commit?: string;
		result?: {
			exit_code?: number;
			commit_oid?: string | null;
			candidate_evidence?: { status?: string; candidate_evidence_sha256?: string };
			round_baseline_seal?: { sealed?: boolean };
		};
	};
	const commitSha = result.result?.commit_oid ?? result.head_oid_after_commit;
	if (
		result.run_id !== record.runId ||
		!result.run_dir ||
		!result.repo_root ||
		!commitSha ||
		(await realpath(result.run_dir)) !== (await realpath(record.runDirectory)) ||
		(await realpath(result.repo_root)) !== (await realpath(record.receipt.worktree)) ||
		result.result?.exit_code !== 0 ||
		!["written", "reused"].includes(result.result.candidate_evidence?.status ?? "") ||
		result.result.round_baseline_seal?.sealed !== true
	)
		throw new Error("Land 规范结果与 run、工作区、提交或封窗不符。");
	const digest = computeRvfTextSha256(bytes);
	const immutablePath = join(record.runDirectory, "artifacts", "rvf-land-commit-execution-results", `${digest}.json`);
	if ((await lstat(immutablePath)).isSymbolicLink() || !(await readFile(immutablePath)).equals(bytes))
		throw new Error("Land 不可变执行结果缺失或摘要不符。");
	const candidateDigest = result.result.candidate_evidence?.candidate_evidence_sha256;
	if (!candidateDigest || !/^[a-f0-9]{64}$/u.test(candidateDigest)) throw new Error("Land 规范结果缺少候选证据摘要。");
	const candidatePath = await getGitStdout(
		["rev-parse", "--path-format=absolute", "--git-path", "rvf/evidence/reviewed-task-candidate-evidence.json"],
		record.receipt.worktree,
	);
	if (
		(await lstat(candidatePath)).isSymbolicLink() ||
		computeRvfTextSha256(await readFile(candidatePath)) !== candidateDigest
	)
		throw new Error("Land 规范结果与实际候选证据摘要不符。");
	return { commitSha, executionResultSha256: digest };
}
export async function observeExistingRvfLandExecutionResultOnce(
	deps: ExecutionRecoveryDependencies,
	original: RvfAutomaticCloseoutRecord,
) {
	if (
		original.landExecutionResult?.outcome === "completed" ||
		!original.runDirectory ||
		original.automaticCloseoutIneligibleReason ||
		!["submitting_closeout_prompt", "closeout_prompt_submitted", "paused"].includes(original.status)
	)
		return original;
	let record = original;
	try {
		const canonicalPath = join(original.runDirectory, "artifacts", "rvf-land-commit-result.json");
		if ((await lstat(canonicalPath)).isSymbolicLink()) return record;
		const canonicalSha256 = computeRvfTextSha256(await readFile(canonicalPath));
		const [candidatePath, currentHead] = await Promise.all([
			getGitStdout(
				["rev-parse", "--path-format=absolute", "--git-path", "rvf/evidence/reviewed-task-candidate-evidence.json"],
				record.receipt.worktree,
			),
			getGitStdout(["rev-parse", "HEAD"], record.receipt.worktree),
		]);
		const candidate = await readFile(candidatePath).catch(() => null);
		const [candidateDigestSidecar, candidateDigestSidecarFile] = await Promise.all([
			readFile(`${candidatePath}.sha256`).catch(() => null),
			lstat(`${candidatePath}.sha256`).catch(() => null),
		]);
		const immutable = await lstat(
			join(original.runDirectory, "artifacts", "rvf-land-commit-execution-results", `${canonicalSha256}.json`),
		).catch(() => null);
		const handoff = await lstat(record.handoffPath ?? "").catch(() => null);
		const fingerprint = JSON.stringify([
			record.runId,
			record.handoffSha256,
			canonicalSha256,
			candidate ? computeRvfTextSha256(candidate) : null,
			candidateDigestSidecar && candidateDigestSidecarFile
				? [candidateDigestSidecarFile.isSymbolicLink(), computeRvfTextSha256(candidateDigestSidecar)]
				: null,
			currentHead,
			immutable ? [immutable.ino, immutable.size, immutable.mtimeMs] : null,
			handoff ? [handoff.ino, handoff.size, handoff.mtimeMs] : null,
		]);
		const reservation = await updateRvfAutomaticCloseoutRecords(
			getRvfAutomaticCloseoutStorePath(deps.workspaceId),
			(records) => {
				const current = records.find((entry) =>
					sameBinding(entry, {
						taskId: original.taskId,
						decisionToken: original.receipt.decision_token,
						runId: original.runId ?? "",
						handoffSha256: original.handoffSha256 ?? "",
					}),
				);
				if (!current) return { records, value: { record, verify: false } };
				const previous = current.independentLandResultObservationBudget;
				const same = previous?.fingerprint === fingerprint;
				if (
					current.landExecutionResult?.outcome === "completed" ||
					(same && (previous.count >= 3 || previous.nextAttemptAtMs > Date.now()))
				)
					return { records, value: { record: current, verify: false } };
				const updated = {
					...current,
					independentLandResultObservationBudget: {
						fingerprint,
						count: same ? previous.count + 1 : 1,
						nextAttemptAtMs: Date.now() + 15_000,
					},
				};
				return {
					records: records.map((entry) => (entry === current ? updated : entry)),
					value: { record: updated, verify: true },
				};
			},
		);
		record = reservation.record;
		if (!reservation.verify) return record;
		const actual = await readBoundRvfLandExecutionResult(record);
		return (
			await reportRvfCloseoutExecutionResultWithIndependentEvidence(deps, {
				taskId: record.taskId,
				decisionToken: record.receipt.decision_token,
				runId: record.runId ?? "",
				handoffSha256: record.handoffSha256 ?? "",
				stage: "land",
				outcome: "completed",
				commitSha: actual.commitSha,
			})
		).record;
	} catch {
		return record;
	}
}
async function assertActivatedCompletion(deps: ExecutionRecoveryDependencies, record: RvfAutomaticCloseoutRecord) {
	if (["captured_review_start_boundary", "awaiting_rvf_completion"].includes(record.status))
		throw new Error("本轮尚未激活完成的自动收尾。");
	const completion = await inspectRvfCompletionEvidence(record, deps.rvfHome);
	if (!completion || completion.runId !== record.runId || completion.handoffSha256 !== record.handoffSha256)
		throw new Error("缺少已激活且精确绑定的 RVF 完成证据。");
}
function sameReportedResult(
	record: RvfAutomaticCloseoutRecord,
	input: RvfAutomaticCloseoutExecutionResultReportRequest,
) {
	const matchesReportedAttempt = (entry: { deliveryAttemptId?: string; stageExecutionClaimId?: string }) =>
		(input.deliveryAttemptId === undefined || entry.deliveryAttemptId === input.deliveryAttemptId) &&
		(input.stageExecutionClaimId === undefined || entry.stageExecutionClaimId === input.stageExecutionClaimId);
	if (
		record.executionResultReportHistory?.some(
			(entry) =>
				entry.stage === input.stage &&
				entry.outcome === input.outcome &&
				entry.commitSha === input.commitSha &&
				entry.baseRef === input.baseRef &&
				entry.reason === input.reason &&
				entry.blockedReasonKind === input.blockedReasonKind &&
				entry.baseBranchSyncReassessmentCondition === input.baseBranchSyncReassessmentCondition &&
				matchesReportedAttempt(entry),
		)
	)
		return true;
	const prior = input.stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
	if (!prior) return false;
	if (prior.outcome === "completed") {
		if (input.outcome === "completed" && prior.commitSha === input.commitSha && prior.baseRef === input.baseRef)
			return true;
		throw new Error("已确认的执行结果不能被另一份报告覆盖。");
	}
	return (
		prior.outcome === input.outcome &&
		prior.commitSha === input.commitSha &&
		prior.baseRef === input.baseRef &&
		prior.reason === input.reason &&
		prior.blockedReasonKind === input.blockedReasonKind &&
		prior.baseBranchSyncReassessmentCondition === input.baseBranchSyncReassessmentCondition &&
		matchesReportedAttempt(prior)
	);
}
export function hasRvfCloseoutStageResultBlockingAutomaticExecution(
	result: RvfAutomaticCloseoutRecord["landExecutionResult"],
) {
	return (
		result?.blockedReasonKind === "user_restriction" ||
		result?.blockedReasonKind === "evidence_conflict" ||
		(result?.outcome === "blocked" && result.blockedReasonKind !== "machine_precondition")
	);
}
export async function reportRvfCloseoutExecutionResultWithIndependentEvidence(
	deps: ExecutionRecoveryDependencies,
	input: RvfAutomaticCloseoutExecutionResultReportRequest,
) {
	const report = rvfAutomaticCloseoutExecutionResultReportRequestSchema.parse(input);
	const storePath = getRvfAutomaticCloseoutStorePath(deps.workspaceId);
	const record = (await readRvfAutomaticCloseoutRecords(storePath)).find((entry) => sameBinding(entry, report));
	if (!record || record.workspaceId !== deps.workspaceId)
		throw new Error("执行报告与 task/token/run/handoff 绑定不一致。");
	if (sameReportedResult(record, report)) return { record };
	if (!["submitting_closeout_prompt", "closeout_prompt_submitted", "completed", "paused"].includes(record.status))
		throw new Error("本轮尚未进入收尾，不能登记执行结果。");
	const delivery = resolveRvfCloseoutActiveDelivery(record);
	if (report.deliveryAttemptId && report.deliveryAttemptId !== delivery.deliveryAttemptId)
		throw new Error("执行报告属于其它投递尝试。");
	const claim = record.stageExecutionClaims?.find(
		(entry) => entry.stageExecutionClaimId === report.stageExecutionClaimId,
	);
	if (
		report.stageExecutionClaimId &&
		(!claim || claim.stage !== report.stage || claim.deliveryAttemptId !== delivery.deliveryAttemptId)
	)
		throw new Error("执行报告的阶段认领不符。");
	let verificationBasis: "native_prompt_acceptance" | "verified_stage_execution" | undefined;
	let executionEvidenceSha256: string | undefined;
	if (report.outcome === "completed") {
		await assertActivatedCompletion(deps, record);
		let existing: Awaited<ReturnType<typeof readBoundRvfLandExecutionResult>> | undefined;
		try {
			existing = await readBoundRvfLandExecutionResult(record);
		} catch {
			/* 仍可使用严格原生接受路径。 */
		}
		if (existing) {
			if (
				(report.stage === "land" && existing.commitSha !== report.commitSha) ||
				(report.stage === "base_branch_sync" && existing.commitSha !== record.landExecutionResult?.commitSha)
			)
				throw new Error("报告中的 Land 提交与规范执行结果不符。");
			verificationBasis = "verified_stage_execution";
			executionEvidenceSha256 = existing.executionResultSha256;
		}
		const ledger = verificationBasis
			? []
			: await readTaskMessageInjectionLedger(
					getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(deps.workspaceId)),
				);
		const injected = findTaskMessageInjectionRecord(ledger, delivery.conversationSessionId, delivery.idempotencyKey);
		let acceptanceError: unknown;
		if (!verificationBasis) {
			if (injected?.terminal_delivery_status === "delivered_and_submit_confirmed" && !deps.isStopped(record)) {
				try {
					const summary = await deps.getMainSummary();
					if (
						summary.taskId !== delivery.conversationSessionId ||
						summary.agentNativeConversationSessionIdentity?.nativeSessionId !== delivery.nativeSessionId ||
						(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
					)
						throw new Error("执行报告的恢复会话或工作区绑定已改变。");
					verificationBasis = "native_prompt_acceptance";
				} catch (error) {
					acceptanceError = error;
				}
			} else if (delivery.continuation?.status === "confirmed" && !deps.isStopped(record)) {
				try {
					await verifyRvfCloseoutContinuationNativeAcceptance({
						record,
						attempt: delivery.continuation,
						summary: await deps.getMainSummary(),
						getMainSummary: deps.getMainSummary,
					});
					verificationBasis = "native_prompt_acceptance";
				} catch (error) {
					acceptanceError = error;
				}
			} else if (record.lateNativePromptAcceptanceRecoveryReceipt && !delivery.continuation) {
				try {
					await deps.verifyLateAcceptance(record);
					verificationBasis = "native_prompt_acceptance";
				} catch (error) {
					acceptanceError = error;
				}
			}
		}
		if (!verificationBasis) {
			try {
				const actual = await readBoundRvfLandExecutionResult(record);
				if (report.stage === "land" && actual.commitSha !== report.commitSha)
					throw new Error("Land 提交与规范执行结果不符。");
				if (report.stage === "base_branch_sync" && actual.commitSha !== record.landExecutionResult?.commitSha)
					throw new Error("base 同步前的 Land 提交与规范执行结果不符。");
				verificationBasis = "verified_stage_execution";
				executionEvidenceSha256 = actual.executionResultSha256;
			} catch (error) {
				if (acceptanceError) throw acceptanceError;
				if (injected?.terminal_delivery_status === "accepted_pending_submit_confirmation")
					throw new RvfAutomaticCloseoutExecutionResultDeliveryPendingError(
						"自动收尾指令尚在等待真实提交确认，请重试同一份执行报告。",
					);
				throw error;
			}
		}
	} else {
		const summary = await deps.getMainSummary();
		if (claim && claim.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId)
			throw new Error("旧执行代际的未决认领不能由新代自述报告释放，须先核验真实执行结果。");
		if (
			summary.taskId !== delivery.conversationSessionId ||
			summary.agentNativeConversationSessionIdentity?.nativeSessionId !== delivery.nativeSessionId ||
			(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
		)
			throw new Error("执行报告的恢复会话或工作区绑定已改变。");
	}
	await validateRvfAutomaticCloseoutExecutionResult(record, report);
	const result = {
		outcome: report.outcome,
		...(report.commitSha ? { commitSha: report.commitSha } : {}),
		...(report.baseRef ? { baseRef: report.baseRef } : {}),
		...(report.reason ? { reason: report.reason } : {}),
		...(report.blockedReasonKind ? { blockedReasonKind: report.blockedReasonKind } : {}),
		...(report.baseBranchSyncReassessmentCondition
			? { baseBranchSyncReassessmentCondition: report.baseBranchSyncReassessmentCondition }
			: {}),
		...(report.deliveryAttemptId ? { deliveryAttemptId: report.deliveryAttemptId } : {}),
		...(report.stageExecutionClaimId ? { stageExecutionClaimId: report.stageExecutionClaimId } : {}),
		...(verificationBasis ? { verificationBasis } : {}),
		...(executionEvidenceSha256 ? { executionEvidenceSha256 } : {}),
		reportedAt: Date.now(),
	};
	const saved = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
		const current = records.find((entry) => sameBinding(entry, report));
		if (
			!current ||
			current.conversationSessionId !== record.conversationSessionId ||
			current.restoredNativeSessionId !== record.restoredNativeSessionId ||
			current.handoffPath !== record.handoffPath
		)
			throw new Error("报告期间运行绑定已改变。");
		if (sameReportedResult(current, report)) return { records, value: current };
		if (
			verificationBasis === "native_prompt_acceptance" &&
			(deps.isStopped(current) ||
				JSON.stringify(current.lateNativePromptAcceptanceRecoveryReceipt) !==
					JSON.stringify(record.lateNativePromptAcceptanceRecoveryReceipt))
		)
			throw new Error("报告期间自动收尾被停止或接受凭据已改变。");
		const history = current.executionResultReportHistory ?? [
			...(current.landExecutionResult ? [{ stage: "land" as const, ...current.landExecutionResult }] : []),
			...(current.baseBranchSyncExecutionResult
				? [{ stage: "base_branch_sync" as const, ...current.baseBranchSyncExecutionResult }]
				: []),
		];
		const updated: RvfAutomaticCloseoutRecord = {
			...current,
			[report.stage === "land" ? "landExecutionResult" : "baseBranchSyncExecutionResult"]: result,
			executionResultReportHistory: [...history, { stage: report.stage, ...result }],
			stageExecutionClaims: current.stageExecutionClaims?.map((entry) =>
				(report.outcome === "completed" && entry.stage === report.stage) ||
				entry.stageExecutionClaimId === report.stageExecutionClaimId
					? { ...entry, status: report.outcome === "completed" ? ("completed" as const) : ("released" as const) }
					: entry,
			),
			updatedAt: result.reportedAt,
		};
		if (
			updated.landExecutionResult?.outcome === "completed" &&
			updated.baseBranchSyncExecutionResult?.outcome === "completed" &&
			!deps.isStopped(current)
		) {
			updated.status = "completed";
			if (updated.automaticRecoveryProgress)
				updated.automaticRecoveryProgress = {
					...updated.automaticRecoveryProgress,
					kind: "settled",
					nextAutomaticAction: "none",
					reasonCode: "all_closeout_stages_completed",
				};
		}
		return { records: records.map((entry) => (entry === current ? updated : entry)), value: updated };
	});
	return { record: saved };
}
export async function claimRvfCloseoutExecutionStage(
	deps: ExecutionRecoveryDependencies,
	input: z.infer<typeof rvfCloseoutStageClaimRequestSchema>,
): Promise<z.infer<typeof rvfCloseoutStageClaimResponseSchema>> {
	const storePath = getRvfAutomaticCloseoutStorePath(deps.workspaceId);
	const record = (await readRvfAutomaticCloseoutRecords(storePath)).find((entry) => sameBinding(entry, input));
	if (!record) return { status: "blocked", reason: "阶段认领与 run 绑定不一致。" };
	if (record.automaticCloseoutIneligibleReason)
		return { status: "blocked", reason: record.automaticCloseoutIneligibleReason };
	if (deps.isStopped(record)) return { status: "blocked", reason: "用户已明确停止本轮收尾。" };
	await assertActivatedCompletion(deps, record);
	const delivery = resolveRvfCloseoutActiveDelivery(record);
	if (input.deliveryAttemptId && input.deliveryAttemptId !== delivery.deliveryAttemptId)
		return { status: "blocked", reason: "投递尝试已改变。" };
	const waitForNativeAcceptanceEvidence = async (
		reason: string,
		requireReadOnlyInspection = false,
	): Promise<z.infer<typeof rvfCloseoutStageClaimResponseSchema>> => {
		await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
			records: records.map((current) =>
				sameBinding(current, input) && !deps.isStopped(current) && current.status !== "completed"
					? {
							...current,
							automaticRecoveryProgress: {
								evidenceFingerprint: "",
								verificationAttemptCount: 0,
								nextVerificationAtMs: 0,
								...current.automaticRecoveryProgress,
								kind: "machine_waiting" as const,
								reasonCode: "native_prompt_acceptance_not_proven",
								nextAutomaticAction: "collect_native_acceptance_evidence" as const,
							},
							...(requireReadOnlyInspection
								? {
										promptDeliveryAttempts: current.promptDeliveryAttempts?.map((attempt) =>
											attempt.deliveryAttemptId === delivery.deliveryAttemptId
												? { ...attempt, executionRequiresReadOnlyInspection: true }
												: attempt,
										),
									}
								: {}),
						}
					: current,
			),
			value: undefined,
		}));
		return { status: "waiting", reason };
	};
	if (
		(delivery.continuation?.purpose === "inspect_existing_state" ||
			delivery.continuation?.executionRequiresReadOnlyInspection) &&
		record.landExecutionResult?.outcome !== "completed"
	) {
		if (!record.lateNativePromptAcceptanceRecoveryReceipt)
			return waitForNativeAcceptanceEvidence("先补齐原生接受证据或核验规范结果，不能直接执行。");
		try {
			await deps.verifyLateAcceptance(record);
		} catch {
			return waitForNativeAcceptanceEvidence("原接受证据暂不可重验，系统继续补证。");
		}
	}
	const prior = input.stage === "land" ? record.landExecutionResult : record.baseBranchSyncExecutionResult;
	if (prior?.outcome === "completed" && prior.commitSha)
		return { status: "already_completed", commitSha: prior.commitSha };
	if (hasRvfCloseoutStageResultBlockingAutomaticExecution(prior))
		return { status: "blocked", reason: "该阶段已有用户限制或尚未分类的阻塞，不能自动重做。" };
	if (input.stage === "base_branch_sync" && record.landExecutionResult?.outcome !== "completed")
		return { status: "waiting", reason: "先核验 Land 实际完成。" };
	const summary = await deps.getMainSummary();
	if (
		summary.taskId !== delivery.conversationSessionId ||
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !== delivery.nativeSessionId ||
		(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
	)
		return { status: "blocked", reason: "当前主会话、原生身份或工作区不符。" };
	if (!summary.runtimeSessionIncarnationId || resolveSessionFacets(summary).liveness !== "live")
		return { status: "waiting", reason: "等待本代执行会话恢复。" };
	const turnKind = resolveSessionFacets(summary).userTurnKind;
	if (turnKind && MODAL_USER_DECISION_TURN_KINDS.has(turnKind))
		return { status: "waiting", reason: "当前存在真实用户决策，阶段认领等待该决策完成。" };
	const ledger = await readTaskMessageInjectionLedger(
		getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(deps.workspaceId)),
	);
	const injected = findTaskMessageInjectionRecord(ledger, delivery.conversationSessionId, delivery.idempotencyKey);
	let acceptedContinuationSnapshot: RvfCloseoutSkillEvidenceReference | undefined;
	let verifiedContinuation = false;
	if (injected?.terminal_delivery_status !== "delivered_and_submit_confirmed") {
		try {
			if (delivery.continuation) {
				await verifyRvfCloseoutContinuationNativeAcceptance({
					record,
					attempt: delivery.continuation,
					summary,
					getMainSummary: deps.getMainSummary,
				});
				verifiedContinuation = true;
				if (
					!record.skillAttachmentEvidenceHistory?.some(
						(entry) =>
							entry.phase === "accepted_native_expansion" &&
							entry.promptDeliveryIdempotencyKey === delivery.idempotencyKey,
					)
				) {
					try {
						acceptedContinuationSnapshot = await captureRvfCloseoutAcceptedSkillSnapshot(record, {
							idempotencyKey: delivery.idempotencyKey,
							promptSha256: delivery.continuation.promptSha256,
							createdAt: new Date(delivery.continuation.createdAt).toISOString(),
						});
					} catch {
						/* 快照暂不可写不撤销已核验的原生事实，后台继续有界采集。 */
					}
				}
			} else if (record.lateNativePromptAcceptanceRecoveryReceipt) await deps.verifyLateAcceptance(record);
			else return waitForNativeAcceptanceEvidence("原接受尚未确认，等待自动补证或受控续验；不能直接认领写入。");
		} catch {
			return waitForNativeAcceptanceEvidence("接受证据暂不能完整重验，系统继续补证并保留已有结果。");
		}
	}
	if (
		delivery.continuation?.purpose === "execute_remaining_stages" &&
		record.landExecutionResult?.outcome !== "completed" &&
		(!record.restoreWorkspaceStateSha256 ||
			(await readRvfCloseoutWorkspaceStateDigest(record.receipt.worktree)) !== record.restoreWorkspaceStateSha256)
	) {
		if (!record.lateNativePromptAcceptanceRecoveryReceipt)
			return waitForNativeAcceptanceEvidence("续验排队后冻结工作区已改变，先只读补证原资格或规范结果。", true);
		try {
			await deps.verifyLateAcceptance(record);
		} catch {
			return waitForNativeAcceptanceEvidence("冻结工作区已改变且原资格暂不能重验，先只读补证。", true);
		}
	}
	return updateRvfAutomaticCloseoutRecords<z.infer<typeof rvfCloseoutStageClaimResponseSchema>>(
		storePath,
		async (records) => {
			const current = records.find((entry) => sameBinding(entry, input));
			const latestSummary = await deps.getMainSummary();
			if (
				!current ||
				deps.isStopped(current) ||
				latestSummary.taskId !== summary.taskId ||
				latestSummary.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
				latestSummary.agentNativeConversationSessionIdentity?.nativeSessionId !== delivery.nativeSessionId ||
				latestSummary.workspacePath !== summary.workspacePath ||
				resolveSessionFacets(latestSummary).liveness !== "live" ||
				resolveRvfCloseoutActiveDelivery(current).idempotencyKey !== delivery.idempotencyKey
			)
				return { records, value: { status: "blocked" as const, reason: "认领期间收尾被停止或绑定改变。" } };
			const latestTurnKind = resolveSessionFacets(latestSummary).userTurnKind;
			if (latestTurnKind && MODAL_USER_DECISION_TURN_KINDS.has(latestTurnKind))
				return {
					records,
					value: { status: "waiting" as const, reason: "当前存在真实用户决策，阶段认领等待该决策完成。" },
				};
			const currentResult =
				input.stage === "land" ? current.landExecutionResult : current.baseBranchSyncExecutionResult;
			if (currentResult?.outcome === "completed" && currentResult.commitSha)
				return { records, value: { status: "already_completed" as const, commitSha: currentResult.commitSha } };
			if (hasRvfCloseoutStageResultBlockingAutomaticExecution(currentResult))
				return { records, value: { status: "blocked" as const, reason: "认领前已登记用户限制或未分类阻塞。" } };
			const active = current.stageExecutionClaims?.find(
				(entry) => entry.stage === input.stage && entry.status === "claimed",
			);
			if (active)
				return {
					records,
					value:
						active.nativeSessionId === delivery.nativeSessionId &&
						active.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
						active.deliveryAttemptId === delivery.deliveryAttemptId
							? { status: "claimed" as const, claim: active }
							: { status: "waiting" as const, reason: "已有执行认领；不得凭超时接管，先核验其实际结果。" },
				};
			const claim = {
				stageExecutionClaimId: randomUUID(),
				stage: input.stage,
				deliveryAttemptId: delivery.deliveryAttemptId,
				nativeSessionId: delivery.nativeSessionId ?? "",
				runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? "",
				claimedAt: Date.now(),
				status: "claimed" as const,
			};
			return {
				records: records.map((entry) =>
					entry === current
						? {
								...current,
								stageExecutionClaims: [...(current.stageExecutionClaims ?? []), claim],
								...(verifiedContinuation
									? {
											status: "closeout_prompt_submitted" as const,
											promptDeliveryAttempts: current.promptDeliveryAttempts?.map((attempt) => ({
												...attempt,
												status: "confirmed" as const,
											})),
										}
									: {}),
								...(acceptedContinuationSnapshot
									? {
											skillAttachmentEvidenceHistory: appendRvfCloseoutSkillEvidence(
												current,
												acceptedContinuationSnapshot,
											),
										}
									: {}),
							}
						: entry,
				),
				value: { status: "claimed" as const, claim },
			};
		},
	);
}
