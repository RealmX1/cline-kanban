import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
	InjectionLedgerTerminalDeliveryReceipt,
	RuntimeTaskChatSendResponse,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isAgentAwaitingModalUserDecision, resolveSessionFacets } from "../core/session-activity";
import type { TaskChatDeliveryWriteValidator } from "../core/task-chat-delivery-write-validation";
import {
	type TaskCommandExecutionIdentityRequest,
	type TaskCommandExecutionRecord,
	type TaskCommandExecutionStartRequest,
	taskCommandExecutionStartRequestSchema,
} from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	getThisRuntimeProcessInstanceId,
	readRuntimeProcessInstanceLiveness,
} from "../state/runtime-process-instance-heartbeat-registry";
import { readOnlyTaskCommandExecutionRecoveryEvidenceObservation } from "./read-only-task-command-execution-recovery-evidence-observation";
import {
	mutateTaskCommandExecutions,
	readTaskCommandExecutions,
	taskCommandExecutionArtifactDirectory,
} from "./task-command-execution-store";
import {
	cancelOwnedCommandProcesses,
	inspectOwnedCommandSupervisor,
	launchOwnedCommandSupervisor,
} from "./task-command-execution-supervisor";

export interface TaskCommandExecutionOwner {
	isNativeInputSubmissionBusy?: boolean;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
	conversationSessionId: string;
	nativeSessionId: string | null;
	worktreePath: string;
	summary: RuntimeTaskSessionSummary | null;
}
export interface TaskCommandExecutionDependencies {
	readOwner: (
		workspaceId: string,
		taskId: string,
		execution?: TaskCommandExecutionRecord,
	) => Promise<TaskCommandExecutionOwner | null>;
	park: (record: TaskCommandExecutionRecord) => Promise<boolean>;
	unpark: (record: TaskCommandExecutionRecord) => Promise<void>;
	deliver: (
		record: TaskCommandExecutionRecord,
		validate: TaskChatDeliveryWriteValidator,
		settled: (receipt: InjectionLedgerTerminalDeliveryReceipt) => Promise<void>,
	) => Promise<RuntimeTaskChatSendResponse>;
	reconcileDelivery: (
		record: TaskCommandExecutionRecord,
	) => Promise<"native_accepted" | "known_not_submitted" | "unknown">;
	readDeliveryRecoveryEvidenceSha256?: (record: TaskCommandExecutionRecord) => Promise<string>;
	listWorkspaceIds: () => Promise<string[]>;
	warn: (message: string) => void;
	launch?: (record: TaskCommandExecutionRecord, validate: () => Promise<void>) => Promise<void>;
	cancel?: (record: TaskCommandExecutionRecord) => Promise<Record<string, unknown>>;
	inspectWorker?: (record: TaskCommandExecutionRecord) => Promise<"running" | "exited" | "not_started" | "unknown">;
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function readExecutionRevocationIntent(
	record: TaskCommandExecutionRecord,
): Promise<{ executionId: string; revokedAtEpochMs: number } | null> {
	try {
		const intent: unknown = JSON.parse(await readFile(record.revocationFile, "utf8"));
		if (
			!intent ||
			typeof intent !== "object" ||
			!("executionId" in intent) ||
			intent.executionId !== record.executionId ||
			!("revokedAtEpochMs" in intent) ||
			typeof intent.revokedAtEpochMs !== "number"
		)
			throw new Error("所属执行撤销原件身份不匹配");
		return { executionId: record.executionId, revokedAtEpochMs: intent.revokedAtEpochMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function resolveCanonicalResultFilePath(resultFile: string): Promise<string> {
	try {
		return await realpath(resultFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(resultFile);
		if (parent === resultFile) throw error;
		return join(await resolveCanonicalResultFilePath(parent), basename(resultFile));
	}
}

export function createTaskCommandExecutionService(deps: TaskCommandExecutionDependencies) {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const activeSweeps = new Set<string>();
	const activeReadOnlyRecoveryEvidenceObservationControllers = new Map<string, AbortController>();
	const executionIdsWithInitialDispatchInProgress = new Set<string>();
	const originatingSessionKeysWithExecutionSweepInProgress = new Set<string>();
	const update = async (
		workspaceId: string,
		executionId: string,
		change: (record: TaskCommandExecutionRecord) => TaskCommandExecutionRecord,
	) =>
		mutateTaskCommandExecutions(workspaceId, (records) => {
			const current = records.find((record) => record.executionId === executionId);
			if (!current) throw new Error("所属执行记录不存在");
			const next = { ...change(current), updatedAtEpochMs: Date.now() };
			return { records: records.map((record) => (record === current ? next : record)), result: next };
		});
	const inspect = async (workspaceId: string, identity: TaskCommandExecutionIdentityRequest) => {
		const record = (await readTaskCommandExecutions(workspaceId)).find(
			(item) => item.executionId === identity.executionId && item.taskId === identity.taskId,
		);
		if (!record) throw new Error("所属执行与任务身份不匹配");
		return record;
	};
	const assertOwnership = async (record: TaskCommandExecutionRecord, forDelivery = false) => {
		const current = await inspect(record.workspaceId, record);
		if (await readExecutionRevocationIntent(current)) throw new Error("所属执行已有持久撤销意图");
		if (
			current.revokedAtEpochMs !== null ||
			current.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId()
		)
			throw new Error("所属执行已撤销或托管者已变化");
		const owner = await deps.readOwner(record.workspaceId, record.taskId, record);
		if (!owner || owner.taskIncarnationCreatedAtEpochMs !== record.taskIncarnationCreatedAtEpochMs)
			throw new Error("原任务 incarnation 尚未核实");
		const metadata = await stat(owner.worktreePath);
		if (
			(await realpath(owner.worktreePath)) !== record.worktreeIdentity.realPath ||
			metadata.birthtimeMs !== record.worktreeIdentity.createdAtEpochMs ||
			metadata.ino !== record.worktreeIdentity.inode
		)
			throw new Error("所属工作树实体已变化");
		if (
			forDelivery &&
			(!owner.summary ||
				owner.conversationSessionId !== record.originatingConversationSessionId ||
				owner.nativeSessionId !== record.originatingNativeSessionId)
		)
			throw new Error("原主会话身份尚未核实");
		if (forDelivery && owner.isNativeInputSubmissionBusy)
			throw new Error("原生会话仍有在途输入请求，等待实际可写状态");
		if (
			forDelivery &&
			owner.summary &&
			(isAgentAwaitingModalUserDecision(resolveSessionFacets(owner.summary)) ||
				owner.summary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover)
		)
			throw new Error("原主会话正在等待用户决策");
		if (forDelivery && owner.summary) {
			const park = owner.summary.awaitingDispatchedBackgroundWork;
			if (
				park &&
				(park.hasUnownedBackgroundWorkWait ||
					!park.owningCommandExecutionIds?.includes(record.executionId) ||
					park.owningCommandExecutionIds.some((id) => id !== record.executionId))
			)
				throw new Error("其他执行或人工后台等待尚未解除");
		}
		const latest = await inspect(record.workspaceId, record);
		if (
			latest.revokedAtEpochMs !== null ||
			latest.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId() ||
			(await readExecutionRevocationIntent(latest))
		)
			throw new Error("异步核验期间所属执行已撤销或托管权变化");
		return latest;
	};
	const releaseOwnedWait = async (record: TaskCommandExecutionRecord) => {
		await deps.unpark(record);
		return update(record.workspaceId, record.executionId, (value) => ({ ...value, parkOwned: false }));
	};
	const retainOwnedWait = async (record: TaskCommandExecutionRecord) => {
		const current = await inspect(record.workspaceId, record);
		if (
			stopped ||
			current.revokedAtEpochMs !== null ||
			current.resultDelivery?.state === "native_accepted" ||
			current.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId() ||
			(await readExecutionRevocationIntent(current))
		)
			return;
		const parkOwned = await deps.park(current);
		const latest = await update(record.workspaceId, record.executionId, (value) =>
			value.revokedAtEpochMs !== null ? value : { ...value, parkOwned: parkOwned || value.parkOwned },
		);
		if (latest.revokedAtEpochMs !== null || (await readExecutionRevocationIntent(latest)))
			await releaseOwnedWait(latest);
	};
	const launch = async (
		record: TaskCommandExecutionRecord,
		recoveryAuthorization?: "producer_single_flight",
		recoveryEvidenceSha256?: string,
	) => {
		const expectedLaunchAttemptCount = record.launchAttemptCount;
		await lockedFileSystem.withLock(
			{
				path: join(
					taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId),
					"execution-dispatch",
				),
			},
			async () => {
				record = await assertOwnership(record);
				if (record.launchAttemptCount !== expectedLaunchAttemptCount) return;
				let unprovenSupervisorResume = false;
				if (record.launchState !== "registered") {
					const worker = await (deps.inspectWorker ?? inspectOwnedCommandSupervisor)(record);
					if (worker === "running") return;
					if (worker === "unknown") {
						if (
							recoveryAuthorization !== "producer_single_flight" ||
							!record.specification.resumeCommandPreservesBusinessSingleFlight ||
							record.launchAttemptCount === 0 ||
							(record.unprovenSupervisorRecoveryObservation?.unprovenSingleFlightResumeAttemptCount ?? 0) >= 1
						)
							return;
						unprovenSupervisorResume = true;
					}
				}
				const current = await update(record.workspaceId, record.executionId, (value) => {
					if (
						value.revokedAtEpochMs !== null ||
						value.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId()
					)
						throw new Error("派发前已撤销或托管权变化");
					return {
						...value,
						...(recoveryEvidenceSha256 === undefined
							? {}
							: {
									lastRecoveryEvidenceSha256: recoveryEvidenceSha256,
									unchangedRecoveryAttemptCount:
										value.lastRecoveryEvidenceSha256 !== recoveryEvidenceSha256
											? 0
											: value.unchangedRecoveryAttemptCount + 1,
									nextRecoveryAtEpochMs: Date.now() + 30_000,
								}),
						launchState: "launching",
						launchAttemptCount: value.launchAttemptCount + 1,
						previousLaunchNonces:
							value.launchAttemptCount > 0
								? [...value.previousLaunchNonces, value.launchNonce]
								: value.previousLaunchNonces,
						launchNonce: value.launchAttemptCount > 0 ? randomUUID() : value.launchNonce,
						unprovenSupervisorRecoveryObservation:
							unprovenSupervisorResume && value.unprovenSupervisorRecoveryObservation
								? {
										...value.unprovenSupervisorRecoveryObservation,
										unprovenSingleFlightResumeAttemptCount:
											value.unprovenSupervisorRecoveryObservation.unprovenSingleFlightResumeAttemptCount + 1,
										recoveryAction: "await_process_or_native_evidence",
									}
								: value.unprovenSupervisorRecoveryObservation,
					};
				});
				try {
					await (deps.launch ?? launchOwnedCommandSupervisor)(current, async () => {
						await assertOwnership(current);
					});
				} catch (error) {
					await update(record.workspaceId, record.executionId, (value) =>
						value.launchNonce === current.launchNonce && value.revokedAtEpochMs === null
							? { ...value, launchState: "unknown" }
							: value,
					);
					throw error;
				}
				await update(record.workspaceId, record.executionId, (value) =>
					value.revokedAtEpochMs === null ? { ...value, launchState: "running" } : value,
				);
			},
		);
	};
	const start = async (workspaceId: string, raw: TaskCommandExecutionStartRequest) => {
		const input = taskCommandExecutionStartRequestSchema.parse(raw);
		const owner = await deps.readOwner(workspaceId, input.taskId);
		if (!owner?.summary || !owner.nativeSessionId) throw new Error("无法取得任务及原主会话身份");
		const originatingNativeSessionId = owner.nativeSessionId;
		const originatingRuntimeSessionIncarnationId = owner.summary.runtimeSessionIncarnationId ?? null;
		if (
			!isAbsolute(input.specification.workingDirectory) ||
			!isAbsolute(input.specification.resultFile) ||
			(await realpath(input.specification.workingDirectory)) !== (await realpath(owner.worktreePath))
		)
			throw new Error("命令工作目录必须是所属任务工作树，结果路径须为绝对路径");
		const metadata = await stat(owner.worktreePath);
		const worktreeRealPath = await realpath(owner.worktreePath);
		const materialSha256 = sha256(JSON.stringify(input.specification));
		const registered = await mutateTaskCommandExecutions(workspaceId, async (records) => {
			const existing = records.find(
				(item) => item.taskId === input.taskId && item.idempotencyKey === input.idempotencyKey,
			);
			if (existing) {
				if (
					existing.materialSha256 !== materialSha256 ||
					existing.taskIncarnationCreatedAtEpochMs !== owner.taskIncarnationCreatedAtEpochMs ||
					existing.originatingNativeSessionId !== owner.nativeSessionId
				)
					throw new Error("幂等键已用于不同材料或任务 incarnation");
				return { records, result: { record: existing, newlyRegistered: false } };
			}
			const executionId = randomUUID();
			const canonicalResultFilePath = await resolveCanonicalResultFilePath(input.specification.resultFile);
			const registeredResultFilePaths = await Promise.all(
				records.map((value) => resolveCanonicalResultFilePath(value.specification.resultFile)),
			);
			if (existsSync(canonicalResultFilePath) || registeredResultFilePaths.includes(canonicalResultFilePath))
				throw new Error("新执行必须使用尚未存在且未被其他执行使用的唯一结果路径");
			const record: TaskCommandExecutionRecord = {
				executionId,
				workspaceId,
				taskId: input.taskId,
				taskIncarnationCreatedAtEpochMs: owner.taskIncarnationCreatedAtEpochMs,
				originatingConversationSessionId: owner.conversationSessionId,
				originatingNativeSessionId,
				originatingRuntimeSessionIncarnationId,
				worktreeIdentity: {
					realPath: worktreeRealPath,
					device: metadata.dev,
					inode: metadata.ino,
					createdAtEpochMs: metadata.birthtimeMs,
				},
				idempotencyKey: input.idempotencyKey,
				materialSha256,
				specification: { ...input.specification, resultFile: canonicalResultFilePath },
				custodianRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
				createdAtEpochMs: Date.now(),
				updatedAtEpochMs: Date.now(),
				launchState: "registered",
				launchAttemptCount: 0,
				launchNonce: randomUUID(),
				previousLaunchNonces: [],
				unprovenSupervisorRecoveryObservation: null,
				revocationFile: join(
					taskCommandExecutionArtifactDirectory(workspaceId, executionId),
					"execution-revocation.json",
				),
				revokedAtEpochMs: null,
				revokedLaunchAttemptCount: null,
				revokedResultWriteAttemptCount: null,
				businessDisposition: null,
				progress: null,
				recovery: null,
				lastRecoveryEvidenceSha256: null,
				unchangedRecoveryAttemptCount: 0,
				nextRecoveryAtEpochMs: null,
				parkOwned: false,
				logicalResultCount: 0,
				resultDelivery: null,
				cancellationObservation: null,
			};
			return { records: [...records, record], result: { record, newlyRegistered: true } };
		});
		if (registered.newlyRegistered) {
			executionIdsWithInitialDispatchInProgress.add(registered.record.executionId);
			try {
				await mkdir(taskCommandExecutionArtifactDirectory(workspaceId, registered.record.executionId), {
					recursive: true,
				});
				await retainOwnedWait(registered.record);
				await launch(registered.record);
			} catch (error) {
				await update(workspaceId, registered.record.executionId, (record) =>
					record.revokedAtEpochMs === null ? { ...record, launchState: "unknown" } : record,
				);
				throw error;
			} finally {
				executionIdsWithInitialDispatchInProgress.delete(registered.record.executionId);
			}
		}
		return inspect(workspaceId, registered.record);
	};
	const cancel = async (workspaceId: string, identity: TaskCommandExecutionIdentityRequest) => {
		let record = await inspect(workspaceId, identity);
		const intent = await lockedFileSystem.withLock({ path: record.revocationFile }, async () => {
			const priorIntent = await readExecutionRevocationIntent(record);
			const intent = priorIntent ?? {
				executionId: record.executionId,
				revokedAtEpochMs: record.revokedAtEpochMs ?? Date.now(),
			};
			if (!priorIntent)
				await lockedFileSystem.writeJsonFileAtomic(record.revocationFile, intent, { durable: true, lock: null });
			return intent;
		});
		if (!intent) return record;
		activeReadOnlyRecoveryEvidenceObservationControllers.get(`${workspaceId}/${record.executionId}`)?.abort();
		record = await update(workspaceId, record.executionId, (value) => ({
			...value,
			revokedAtEpochMs: value.revokedAtEpochMs ?? intent.revokedAtEpochMs,
			revokedLaunchAttemptCount: value.revokedLaunchAttemptCount ?? value.launchAttemptCount,
			revokedResultWriteAttemptCount:
				value.revokedResultWriteAttemptCount ?? value.resultDelivery?.attemptCount ?? 0,
			businessDisposition: "cancelled",
		}));
		const observation = await (deps.cancel ?? cancelOwnedCommandProcesses)(record);
		await releaseOwnedWait(record);
		return update(workspaceId, record.executionId, (value) => ({ ...value, cancellationObservation: observation }));
	};
	const sweepExecution = async (workspaceId: string, executionId: string) => {
		const sweepKey = `${workspaceId}/${executionId}`;
		if (stopped || activeSweeps.has(sweepKey)) return;
		activeSweeps.add(sweepKey);
		let acquiredOriginatingSessionSweepKey: string | null = null;
		try {
			let record = (await readTaskCommandExecutions(workspaceId)).find((item) => item.executionId === executionId);
			if (!record) return;
			const originatingConversationSessionSweepKey = `${workspaceId}/${record.originatingConversationSessionId}`;
			if (
				executionIdsWithInitialDispatchInProgress.has(executionId) ||
				originatingSessionKeysWithExecutionSweepInProgress.has(originatingConversationSessionSweepKey)
			)
				return;
			originatingSessionKeysWithExecutionSweepInProgress.add(originatingConversationSessionSweepKey);
			acquiredOriginatingSessionSweepKey = originatingConversationSessionSweepKey;
			if (record.revokedAtEpochMs === null && (await readExecutionRevocationIntent(record))) {
				await cancel(workspaceId, record);
				return;
			}
			if (record.revokedAtEpochMs !== null) {
				if (record.parkOwned) record = await releaseOwnedWait(record);
				if (
					record.cancellationObservation?.nativeCancellationStatus === "unknown" &&
					record.cancellationObservation?.rechecked !== true
				) {
					const observation = await (deps.cancel ?? cancelOwnedCommandProcesses)(record);
					await update(workspaceId, executionId, (value) => ({
						...value,
						cancellationObservation: {
							...observation,
							rechecked: true,
							recoveryTrigger: "native_cancellation_evidence_changed",
						},
					}));
				}
				return;
			}
			if (record.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId()) {
				const priorCustodian = record.custodianRuntimeProcessInstanceId;
				if ((await readRuntimeProcessInstanceLiveness(priorCustodian)) !== "dead") return;
				record = await update(workspaceId, executionId, (value) =>
					value.custodianRuntimeProcessInstanceId !== priorCustodian
						? value
						: {
								...value,
								custodianRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
								launchState:
									value.launchState === "registered" || value.launchState === "launching"
										? "unknown"
										: value.launchState,
								resultDelivery: value.resultDelivery && {
									...value.resultDelivery,
									awaitingTransportReceipt: false,
								},
							},
				);
			}
			try {
				await assertOwnership(record);
			} catch {
				return;
			}
			let result: Record<string, unknown> | null = null;
			try {
				result = JSON.parse(await readFile(record.specification.resultFile, "utf8")) as Record<string, unknown>;
			} catch {
				/* 原件未出现或写入未完成，继续等待机器证据。 */
			}
			const disposition = record.resultDelivery ? record.businessDisposition : result?.disposition;
			if (result?.disposition === "cancelled") {
				await cancel(workspaceId, record);
				return;
			}
			if (disposition !== "agent_review_ready" && disposition !== "agent_judgment_required") {
				if (result && disposition === "machine_evidence_pending") {
					record = await update(workspaceId, executionId, (value) => ({
						...value,
						businessDisposition: disposition,
						progress: result,
						recovery:
							typeof result?.recovery === "object" && result.recovery !== null
								? (result.recovery as Record<string, unknown>)
								: null,
					}));
				}
				const worker = await (deps.inspectWorker ?? inspectOwnedCommandSupervisor)(record);
				if (worker === "running") return;
				if (worker === "unknown") {
					const attempts =
						record.unprovenSupervisorRecoveryObservation?.unprovenSingleFlightResumeAttemptCount ?? 0;
					const mayResumeBusinessSingleFlight =
						record.specification.resumeCommandPreservesBusinessSingleFlight &&
						record.launchAttemptCount > 0 &&
						attempts < 1;
					record = await update(workspaceId, executionId, (value) => ({
						...value,
						unprovenSupervisorRecoveryObservation: {
							launchNonce: value.launchNonce,
							missingEvidence: "supervisor_or_owned_process_exit",
							equivalentEvidenceSources: [
								"supervisor_terminal_progress",
								"native_business_result",
								"boot_identity",
								"producer_registered_business_single_flight",
							],
							recoveryAction: mayResumeBusinessSingleFlight
								? "resume_registered_business_single_flight"
								: "await_process_or_native_evidence",
							unprovenSingleFlightResumeAttemptCount: attempts,
							maximumUnprovenSingleFlightResumeAttempts: 1,
						},
					}));
					if (!mayResumeBusinessSingleFlight) return;
				}
				const recovery = record.recovery;
				if (recovery && recovery.action !== "resume_same_run") return;
				if (record.launchAttemptCount === 0) {
					// 首次派发前只探测 park 依赖，不消耗尚未执行的业务恢复预算。
					if ((record.nextRecoveryAtEpochMs ?? 0) > Date.now()) return;
					record = await update(workspaceId, executionId, (value) => ({
						...value,
						nextRecoveryAtEpochMs: Date.now() + 30_000,
					}));
					await retainOwnedWait(record);
					await launch(record);
					return;
				}
				const observationCommand = record.specification.readOnlyRecoveryEvidenceObservationCommand;
				if (
					observationCommand &&
					record.lastRecoveryEvidenceSha256 !== null &&
					Math.max(
						record.nextRecoveryAtEpochMs ?? 0,
						typeof recovery?.retry_not_before_epoch_ms === "number" ? recovery.retry_not_before_epoch_ms : 0,
					) > Date.now()
				)
					return;
				const evidence = [
					JSON.stringify({
						disposition,
						trigger: recovery?.trigger,
						missingEvidence: recovery?.missing_evidence,
						equivalentSources: recovery?.equivalent_evidence_sources,
					}),
				];
				const producerPaths = Array.isArray(record.recovery?.evidence_paths)
					? record.recovery.evidence_paths.filter((path): path is string => typeof path === "string")
					: [];
				for (const path of [...record.specification.recoveryEvidencePaths, ...producerPaths]) {
					try {
						evidence.push(sha256(await readFile(path, "utf8")));
					} catch {
						try {
							evidence.push(JSON.stringify(await readdir(path)));
						} catch {
							evidence.push("unavailable");
						}
					}
				}
				if (observationCommand) {
					await assertOwnership(record);
					if (stopped) return;
					const controller = new AbortController();
					activeReadOnlyRecoveryEvidenceObservationControllers.set(sweepKey, controller);
					let semanticObservation: string;
					try {
						semanticObservation = await readOnlyTaskCommandExecutionRecoveryEvidenceObservation({
							command: observationCommand,
							workingDirectory: record.specification.workingDirectory,
							signal: controller.signal,
						});
					} finally {
						activeReadOnlyRecoveryEvidenceObservationControllers.delete(sweepKey);
					}
					await assertOwnership(record);
					if (stopped) return;
					evidence.push(semanticObservation);
				}
				const fingerprint = sha256(JSON.stringify(evidence));
				const changed = record.lastRecoveryEvidenceSha256 !== fingerprint;
				const notBefore =
					typeof record.recovery?.retry_not_before_epoch_ms === "number"
						? record.recovery.retry_not_before_epoch_ms
						: null;
				if (result && record.lastRecoveryEvidenceSha256 === null) {
					await update(workspaceId, executionId, (value) => ({
						...value,
						lastRecoveryEvidenceSha256: fingerprint,
						nextRecoveryAtEpochMs: notBefore ?? Date.now() + 30_000,
					}));
					return;
				}
				if ((notBefore ?? record.nextRecoveryAtEpochMs ?? 0) > Date.now()) return;
				const maximumUnchangedRetries =
					typeof recovery?.maximum_unchanged_retries === "number"
						? Math.max(0, Math.min(3, Math.floor(recovery.maximum_unchanged_retries)))
						: 1;
				if (!changed && record.unchangedRecoveryAttemptCount >= maximumUnchangedRetries) {
					if (observationCommand)
						await update(workspaceId, executionId, (value) => ({
							...value,
							nextRecoveryAtEpochMs: Date.now() + 30_000,
						}));
					return;
				}
				await launch(record, worker === "unknown" ? "producer_single_flight" : undefined, fingerprint);
				return;
			}
			if (!record.resultDelivery) {
				const text = `所属命令执行结果：${record.specification.label}\n${JSON.stringify(result)}\n原始结果：${record.specification.resultFile}`;
				record = await update(workspaceId, executionId, (value) =>
					value.resultDelivery
						? value
						: {
								...value,
								businessDisposition: disposition,
								progress: result,
								logicalResultCount: 1,
								resultDelivery: {
									resultId: `command-execution-result-${executionId}`,
									text,
									textSha256: sha256(text),
									state: "known_not_submitted",
									attemptCount: 0,
									attemptId: null,
									nativeReceipt: null,
									awaitingTransportReceipt: false,
									lastPreflightFailureEvidenceSha256: null,
									unchangedPreflightRetryCount: 0,
									retryPreflightNotBeforeEpochMs: null,
									reconciliationAttemptCount: 0,
									lastReconciliationEvidenceSha256: null,
									nextReconciliationAtEpochMs: null,
								},
							},
				);
			}
			if (
				record.resultDelivery?.state === "known_not_submitted" &&
				(await deps.readOwner(record.workspaceId, record.taskId, record))?.isNativeInputSubmissionBusy
			) {
				await retainOwnedWait(record);
				return;
			}
			if (record.parkOwned && record.resultDelivery?.attemptId === null) record = await releaseOwnedWait(record);
			if (record.resultDelivery?.state === "native_accepted") {
				if (record.parkOwned) await releaseOwnedWait(record);
				return;
			}
			if (record.resultDelivery?.awaitingTransportReceipt) return;
			if (record.resultDelivery?.state === "submission_unknown") {
				const fingerprint =
					(await deps.readDeliveryRecoveryEvidenceSha256?.(record)) ?? sha256(record.originatingNativeSessionId);
				const changed = fingerprint !== record.resultDelivery.lastReconciliationEvidenceSha256;
				if (
					!changed &&
					(record.resultDelivery.reconciliationAttemptCount >= 2 ||
						(record.resultDelivery.nextReconciliationAtEpochMs ?? 0) > Date.now())
				)
					return;
				record = await update(workspaceId, executionId, (value) => ({
					...value,
					resultDelivery: value.resultDelivery && {
						...value.resultDelivery,
						reconciliationAttemptCount: changed ? 1 : value.resultDelivery.reconciliationAttemptCount + 1,
						lastReconciliationEvidenceSha256: fingerprint,
						nextReconciliationAtEpochMs: Date.now() + 30_000,
					},
				}));
				const recovered = await deps.reconcileDelivery(record);
				if (recovered === "unknown") return;
				record = await update(workspaceId, executionId, (value) => ({
					...value,
					resultDelivery: value.resultDelivery && { ...value.resultDelivery, state: recovered },
				}));
				if (recovered === "native_accepted") {
					await releaseOwnedWait(record);
					return;
				}
			}
			try {
				await assertOwnership(record, true);
			} catch {
				return;
			}
			const preflightEvidence =
				(await deps.readDeliveryRecoveryEvidenceSha256?.(record)) ?? sha256(record.originatingNativeSessionId);
			const unchangedPreflightFailure =
				record.resultDelivery?.lastPreflightFailureEvidenceSha256 === preflightEvidence;
			if (
				unchangedPreflightFailure &&
				((record.resultDelivery?.unchangedPreflightRetryCount ?? 0) >= 1 ||
					(record.resultDelivery?.retryPreflightNotBeforeEpochMs ?? 0) > Date.now())
			)
				return;
			const attemptId = randomUUID();
			record = await update(workspaceId, executionId, (value) => ({
				...value,
				resultDelivery: value.resultDelivery && {
					...value.resultDelivery,
					attemptId,
					awaitingTransportReceipt: true,
					unchangedPreflightRetryCount: unchangedPreflightFailure
						? value.resultDelivery.unchangedPreflightRetryCount + 1
						: 0,
				},
			}));
			const validate: TaskChatDeliveryWriteValidator = async (phase) => {
				const current = await assertOwnership(record, true);
				if (stopped || current.resultDelivery?.attemptId !== attemptId) throw new Error("旧投递尝试已失去归属");
				if (phase === "before_first_transport_write") {
					await update(workspaceId, executionId, (value) => {
						if (
							value.revokedAtEpochMs !== null ||
							value.resultDelivery?.attemptId !== attemptId ||
							value.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId()
						)
							throw new Error("写前登记时执行已撤销或尝试已变化");
						return {
							...value,
							resultDelivery: value.resultDelivery && {
								...value.resultDelivery,
								state: "submission_unknown",
								attemptCount:
									value.resultDelivery.attemptCount +
									(value.resultDelivery.state === "known_not_submitted" ? 1 : 0),
							},
						};
					});
					await releaseOwnedWait(record);
					await assertOwnership(record, true);
				}
			};
			const settled = async (receipt: InjectionLedgerTerminalDeliveryReceipt) => {
				if (await readExecutionRevocationIntent(record)) return;
				const current = await update(workspaceId, executionId, (value) => {
					if (
						value.revokedAtEpochMs !== null ||
						value.resultDelivery?.attemptId !== attemptId ||
						value.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId()
					)
						return value;
					if (
						value.resultDelivery.state === "native_accepted" ||
						(receipt.status === "accepted_pending_submit_confirmation" &&
							value.resultDelivery.nativeReceipt?.status &&
							value.resultDelivery.nativeReceipt.status !== "accepted_pending_submit_confirmation")
					)
						return value;
					const notStarted = receipt.nativePromptSubmissionNotStartedEvidence;
					const provenNotStarted =
						notStarted?.clientUserMessageId === value.resultDelivery.resultId &&
						notStarted.submissionAttemptId === attemptId &&
						notStarted.nativeSessionId === value.originatingNativeSessionId;
					return {
						...value,
						resultDelivery: {
							...value.resultDelivery,
							nativeReceipt: receipt,
							awaitingTransportReceipt: receipt.status === "accepted_pending_submit_confirmation",
							...(receipt.status === "delivery_failed" &&
							(value.resultDelivery.state === "known_not_submitted" || provenNotStarted)
								? {
										lastPreflightFailureEvidenceSha256: preflightEvidence,
										retryPreflightNotBeforeEpochMs: Date.now() + 30_000,
									}
								: {}),
							state:
								receipt.status === "delivered_and_submit_confirmed" ||
								receipt.status === "delivered_queued_behind_active_agent_turn"
									? "native_accepted"
									: provenNotStarted
										? "known_not_submitted"
										: value.resultDelivery.state,
						},
					};
				});
				if (
					current.resultDelivery?.attemptId !== attemptId ||
					current.custodianRuntimeProcessInstanceId !== getThisRuntimeProcessInstanceId() ||
					current.revokedAtEpochMs !== null
				)
					return;
				if (current.resultDelivery?.state === "native_accepted") await releaseOwnedWait(current);
				else await retainOwnedWait(current);
			};
			try {
				await validate();
				const response = await deps.deliver(record, validate, settled);
				if (response.terminalDelivery) await settled(response.terminalDelivery);
				else if (!response.ok) throw new Error(response.error ?? "投递失败，尚无提交事实");
			} catch (error) {
				await update(workspaceId, executionId, (value) =>
					value.resultDelivery?.attemptId === attemptId
						? {
								...value,
								resultDelivery: {
									...value.resultDelivery,
									awaitingTransportReceipt: false,
									lastPreflightFailureEvidenceSha256: preflightEvidence,
									retryPreflightNotBeforeEpochMs: Date.now() + 30_000,
								},
							}
						: value,
				);
				await retainOwnedWait(record);
				deps.warn(`所属执行结果等待补证 executionId=${executionId} reason=${String(error)}`);
			}
		} finally {
			activeSweeps.delete(sweepKey);
			if (acquiredOriginatingSessionSweepKey)
				originatingSessionKeysWithExecutionSweepInProgress.delete(acquiredOriginatingSessionSweepKey);
		}
	};
	const sweep = async () => {
		for (const workspaceId of await deps.listWorkspaceIds())
			for (const record of await readTaskCommandExecutions(workspaceId)) {
				try {
					await sweepExecution(workspaceId, record.executionId);
				} catch (error) {
					deps.warn(`所属执行恢复待证 executionId=${record.executionId} reason=${String(error)}`);
				}
			}
	};
	return {
		start,
		inspect,
		cancel,
		sweepExecution,
		cancelForTask: async (workspaceId: string, taskId: string) => {
			const records = (await readTaskCommandExecutions(workspaceId)).filter(
				(record) =>
					record.revokedAtEpochMs === null &&
					(record.taskId === taskId || record.originatingConversationSessionId === taskId),
			);
			await Promise.all(
				records.map(async (record) => {
					await lockedFileSystem.withLock({ path: record.revocationFile }, async () => {
						if (!(await readExecutionRevocationIntent(record)))
							await lockedFileSystem.writeJsonFileAtomic(
								record.revocationFile,
								{ executionId: record.executionId, revokedAtEpochMs: Date.now() },
								{ durable: true, lock: null },
							);
					});
				}),
			);
			await Promise.all(records.map((record) => cancel(workspaceId, record)));
		},
		startRecovery: () => {
			stopped = false;
			const tick = async () => {
				try {
					await sweep();
				} catch (error) {
					deps.warn(String(error));
				} finally {
					if (!stopped) {
						timer = setTimeout(tick, 1_000);
						timer.unref();
					}
				}
			};
			void tick();
		},
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			for (const controller of activeReadOnlyRecoveryEvidenceObservationControllers.values()) controller.abort();
		},
	};
}
export type TaskCommandExecutionService = ReturnType<typeof createTaskCommandExecutionService>;
