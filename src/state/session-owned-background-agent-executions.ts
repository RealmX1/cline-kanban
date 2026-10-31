// 后台分身的执行归属独立于主会话的闲置时间；重启后依据原生进程证据继续核验。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ForkedWorkBranchExecutor,
	ForkedWorkBranchProcessObservation,
	ForkedWorkBranchResult,
} from "agent-conversation-exploration-thread-graph/core";
import {
	compareNativeProcessStartIdentities,
	confirmOwnedProcessCancellation,
	observeExecutionOwnedProcesses,
	readNativeProcessOwnershipSnapshot,
	readNativeSystemBootIdentity,
	signalMatchingOwnedProcesses,
} from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

const activeCancellationRefreshersByGenerationPath = new Map<string, Set<() => void>>();

const executionRecordSchema = z.object({
	executionOwnershipToken: z.string().uuid(),
	admissionCancellationGeneration: z.string().uuid().nullable(),
	controllerProcessPid: z.number().int().positive(),
	controllerProcessStartIdentity: z.string().nullable(),
	systemBootIdentity: z.string().nullable(),
	launchState: z.enum(["registered", "dispatch_intent", "started", "not_started"]),
	taskId: z.string(),
	runtimeSessionIncarnationId: z.string().nullable(),
	parentNativeSessionId: z.string(),
	purpose: z.enum(["source_agent_draft_generation", "exploration_thread_graph_maintenance"]),
	status: z.enum(["running", "finished", "exit_unknown"]),
	startedAtEpochMs: z.number(),
	finishedAtEpochMs: z.number().nullable(),
	processObservation: z
		.object({
			executionOwnershipToken: z.string(),
			processPid: z.number(),
			processStartIdentity: z.string().nullable(),
			ownedDescendantStartIdentities: z.record(z.string(), z.string()),
			observedAtEpochMs: z.number(),
			lastOutputActivityAtEpochMs: z.number().nullable(),
		})
		.nullable(),
	waitingReason: z.string().nullable(),
	recoveryCondition: z.string(),
	result: z.unknown().optional(),
});
type ExecutionRecord = z.infer<typeof executionRecordSchema>;

function executionDirectory(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), "session-owned-background-agent-executions");
}

function taskExecutionCancellationGenerationPath(workspaceId: string, taskId: string): string {
	const taskIdentityDigest = createHash("sha256").update(taskId).digest("hex");
	return join(executionDirectory(workspaceId), `task-${taskIdentityDigest}.admission-cancellation-generation.json`);
}

function readTaskExecutionCancellationGeneration(path: string, expectedTaskId: string): string | null {
	try {
		const stored = z
			.object({ taskId: z.string(), cancellationGeneration: z.string().uuid() })
			.parse(JSON.parse(readFileSync(path, "utf8")));
		if (stored.taskId !== expectedTaskId) throw new Error("后台执行取消代际的任务归属不匹配");
		return stored.cancellationGeneration;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function readExecutionRecords(workspaceId: string): Promise<{ path: string; record: ExecutionRecord }[]> {
	const directory = executionDirectory(workspaceId);
	let filenames: string[];
	try {
		filenames = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return await Promise.all(
		filenames
			.filter((name) => name.endsWith(".execution.json"))
			.map(async (name) => {
				const path = join(directory, name);
				return { path, record: executionRecordSchema.parse(JSON.parse(await readFile(path, "utf8"))) };
			}),
	);
}

function recordedProcessStartIdentities(record: ExecutionRecord): Map<number, string> {
	const observation = record.processObservation;
	const identities = new Map<number, string>(
		Object.entries(observation?.ownedDescendantStartIdentities ?? {}).map(([pid, identity]) => [
			Number(pid),
			identity,
		]),
	);
	if (observation?.processStartIdentity) identities.set(observation.processPid, observation.processStartIdentity);
	return identities;
}

async function inspectExecutionProcessExit(record: ExecutionRecord): Promise<{
	requiresRetention: boolean;
	ownedStartIdentities: Map<number, string>;
	ownershipUnknown: boolean;
	reason: string;
}> {
	const boot = await readNativeSystemBootIdentity();
	if (boot && record.systemBootIdentity && boot !== record.systemBootIdentity) {
		return {
			requiresRetention: false,
			ownedStartIdentities: new Map(),
			ownershipUnknown: false,
			reason: "system_boot_generation_changed",
		};
	}
	if (record.launchState === "not_started")
		return {
			requiresRetention: false,
			ownedStartIdentities: new Map(),
			ownershipUnknown: false,
			reason: "process_spawn_not_started_proven",
		};
	const snapshot = await readNativeProcessOwnershipSnapshot();
	// undefined 观察只来自成功完整的快照；查询抛错继续由调用方保留未知。
	const controllerIdentityComparison = compareNativeProcessStartIdentities(
		snapshot.get(record.controllerProcessPid)?.startIdentity,
		record.controllerProcessStartIdentity ?? undefined,
	);
	const controllerMayStillOwnDispatch = controllerIdentityComparison !== "different";
	const controllerIdentityUnknown = controllerIdentityComparison === "unknown";
	if (record.launchState === "registered") {
		// 内置执行器须先等待持久屏障；registered 阶段的 controller 已退出即能证明未派发。
		return {
			requiresRetention: controllerMayStillOwnDispatch && record.status !== "finished",
			ownedStartIdentities: new Map(),
			ownershipUnknown: controllerIdentityUnknown && record.status !== "finished",
			reason: controllerIdentityUnknown
				? "controller_start_identity_unknown"
				: controllerMayStillOwnDispatch
					? "controller_has_not_crossed_spawn_barrier"
					: "controller_exited_before_spawn_barrier",
		};
	}
	const observed = await observeExecutionOwnedProcesses({
		executionOwnershipToken: record.executionOwnershipToken,
		executionStartedAtEpochMs: record.startedAtEpochMs,
		recordedStartIdentities: recordedProcessStartIdentities(record),
	});
	const active = observed.ownedStartIdentities.size > 0;
	return {
		requiresRetention:
			active ||
			observed.hasUnprovenOrphanOwnership ||
			(record.status === "running" && controllerMayStillOwnDispatch),
		ownedStartIdentities: observed.ownedStartIdentities,
		ownershipUnknown:
			observed.hasUnprovenOrphanOwnership || (record.status === "running" && controllerIdentityUnknown),
		reason: active
			? "owned_processes_running"
			: observed.hasUnprovenOrphanOwnership
				? "native_orphan_ownership_unknown"
				: record.status === "running" && controllerIdentityUnknown
					? "controller_start_identity_unknown"
					: record.status === "running" && controllerMayStillOwnDispatch
						? "controller_result_publication_pending"
						: "native_process_tree_exit_proven",
	};
}

async function executionHasLiveOrUnprovenProcesses(record: ExecutionRecord, path: string): Promise<boolean> {
	const observation = await inspectExecutionProcessExit(record);
	try {
		await lockedFileSystem.writeTextFileAtomic(
			`${path}.exit-reconciliation.json`,
			JSON.stringify({
				status: observation.requiresRetention ? (observation.ownershipUnknown ? "unknown" : "active") : "exited",
				reason: observation.reason,
				ownedStartIdentities: Object.fromEntries(observation.ownedStartIdentities),
				observedAtEpochMs: Date.now(),
				recoveryCondition: "native_process_parent_chain_environment_or_system_boot_evidence_changed",
			}),
		);
	} catch {
		/* 辅助观察写入失败不改变已取得的原生退出事实。 */
	}
	return observation.requiresRetention;
}

export async function hasSessionOwnedBackgroundAgentExecutionRequiringRetention(input: {
	workspaceId: string;
	taskId: string;
}): Promise<boolean> {
	try {
		for (const { record, path } of await readExecutionRecords(input.workspaceId)) {
			if (record.taskId === input.taskId && (await executionHasLiveOrUnprovenProcesses(record, path))) return true;
		}
		return false;
	} catch {
		// 原件或原生查询缺证时保留会话，后续 sweep 自动重新核验。
		return true;
	}
}

async function confirmRegisteredBackgroundAgentCancellation(path: string, record: ExecutionRecord): Promise<void> {
	const inspectCurrentExecution = async () => {
		const current = executionRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
		if (current.executionOwnershipToken !== record.executionOwnershipToken) throw new Error("取消期间执行归属已变化");
		return await inspectExecutionProcessExit(current);
	};
	let confirmation: "confirmed" | "unknown" = "unknown";
	try {
		let observation = await inspectCurrentExecution();
		if (observation.ownedStartIdentities.size > 0) {
			await signalMatchingOwnedProcesses(observation.ownedStartIdentities, "SIGTERM");
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			observation = await inspectCurrentExecution();
			await confirmOwnedProcessCancellation(observation.ownedStartIdentities);
			observation = await inspectCurrentExecution();
		}
		confirmation = observation.requiresRetention ? "unknown" : "confirmed";
	} catch {
		/* 查询缺证时不向未证明归属的进程发信号，后续原生证据变化后重验。 */
	}

	await lockedFileSystem.writeTextFileAtomic(
		`${path}.cancellation-observation.json`,
		JSON.stringify({
			confirmation,
			observedAtEpochMs: Date.now(),
			recoveryCondition: "native_process_identity_or_original_result_available",
		}),
	);
}

async function persistBackgroundAgentCancellationRequests(input: {
	workspaceId: string;
	taskId: string;
}): Promise<{ path: string; record: ExecutionRecord }[]> {
	const directory = executionDirectory(input.workspaceId);
	await mkdir(directory, { recursive: true });
	return await lockedFileSystem.withLock({ path: directory, type: "directory" }, async () => {
		// 同 admission 锁先持久更新代际，覆盖 start 已进入但尚未落盘的请求。
		await lockedFileSystem.writeTextFileAtomic(
			taskExecutionCancellationGenerationPath(input.workspaceId, input.taskId),
			JSON.stringify({ taskId: input.taskId, cancellationGeneration: randomUUID(), requestedAtEpochMs: Date.now() }),
			{ durable: true },
		);
		const cancellationGenerationPath = taskExecutionCancellationGenerationPath(input.workspaceId, input.taskId);
		// 本进程立即观察同一份持久代际，避免依赖轮询才阻止落盘；其他进程继续周期补证。
		for (const refreshCancellation of activeCancellationRefreshersByGenerationPath.get(cancellationGenerationPath) ??
			[]) {
			try {
				refreshCancellation();
			} catch {
				// 即时通知缺证不阻断 marker 持久化；周期观察与落盘前核验继续补证。
			}
		}
		const records = (await readExecutionRecords(input.workspaceId)).filter(
			({ record }) => record.taskId === input.taskId,
		);
		for (const { path } of records) {
			await lockedFileSystem.withLock({ path: `${path}.execution-control`, type: "file" }, async () => {
				await lockedFileSystem.writeTextFileAtomic(
					`${path}.cancellation-request.json`,
					JSON.stringify({ requestedAtEpochMs: Date.now() }),
				);
			});
		}
		return records;
	});
}

export async function requestSessionOwnedBackgroundAgentExecutionCancellation(input: {
	workspaceId: string;
	taskId: string;
}): Promise<{ processCancellationConfirmationCompleted: Promise<PromiseSettledResult<void>[]> }> {
	const records = await persistBackgroundAgentCancellationRequests(input);
	// 用户 Stop 只等待意图持久化，所属后代清理另存确认，不阻塞主 Agent 的停止。
	return {
		processCancellationConfirmationCompleted: Promise.allSettled(
			records.map(({ path, record }) => confirmRegisteredBackgroundAgentCancellation(path, record)),
		),
	};
}

export async function cancelSessionOwnedBackgroundAgentExecutions(input: {
	workspaceId: string;
	taskId: string;
}): Promise<void> {
	const records = await persistBackgroundAgentCancellationRequests(input);
	await Promise.all(records.map(({ path, record }) => confirmRegisteredBackgroundAgentCancellation(path, record)));
}

interface SessionOwnedBackgroundAgentExecutionOwner {
	workspaceId: string;
	taskId: string;
	runtimeSessionIncarnationId: string | null;
	purpose: ExecutionRecord["purpose"];
	executor: ForkedWorkBranchExecutor;
}

function cancelForkResult(result: ForkedWorkBranchResult): ForkedWorkBranchResult {
	const { structured: _cancelledBusinessPayload, ...nativeResult } = result;
	return {
		...nativeResult,
		stopReason: "cancelled",
		cancellationConfirmation:
			result.stopReason === "cancelled"
				? (result.cancellationConfirmation ?? "unknown")
				: result.cancellationConfirmation === "not_started"
					? "not_started"
					: "unknown",
	};
}

// 归属与取消持续到整个业务操作返回，分身结束不能提前释放维护作业的保护。
export async function runSessionOwnedBackgroundAgentOperation<OperationResult>(
	input: SessionOwnedBackgroundAgentExecutionOwner & { parentNativeSessionId: string; signal?: AbortSignal },
	operation: (execution: {
		executor: ForkedWorkBranchExecutor;
		signal: AbortSignal;
		refreshCancellation: () => void;
		acquireCommitPermission: () => Promise<void>;
	}) => Promise<OperationResult>,
	cancelOperationResult: (result: OperationResult) => OperationResult,
): Promise<OperationResult> {
	// 首次 await 前捕获取消代际；登记准备期间发生的 Stop 不能被漏掉。
	const cancellationGenerationPath = taskExecutionCancellationGenerationPath(input.workspaceId, input.taskId);
	const admissionCancellationGeneration = readTaskExecutionCancellationGeneration(
		cancellationGenerationPath,
		input.taskId,
	);
	const requestAcceptedAtEpochMs = Date.now();
	const cancellationGenerationChanged = () => {
		const observed = readTaskExecutionCancellationGeneration(cancellationGenerationPath, input.taskId);
		// 只把新的持久 UUID 视为 Stop；辅助原件缺失不证明用户发起了取消。
		return observed !== null && observed !== admissionCancellationGeneration;
	};
	await mkdir(executionDirectory(input.workspaceId), { recursive: true });
	const path = join(executionDirectory(input.workspaceId), `${randomUUID()}.execution.json`);
	const controllerSnapshot = await readNativeProcessOwnershipSnapshot().catch(() => null);
	const record: ExecutionRecord = {
		executionOwnershipToken: randomUUID(),
		admissionCancellationGeneration,
		controllerProcessPid: process.pid,
		controllerProcessStartIdentity: controllerSnapshot?.get(process.pid)?.startIdentity ?? null,
		systemBootIdentity: await readNativeSystemBootIdentity(),
		launchState: "registered",
		taskId: input.taskId,
		runtimeSessionIncarnationId: input.runtimeSessionIncarnationId,
		parentNativeSessionId: input.parentNativeSessionId,
		purpose: input.purpose,
		status: "running",
		startedAtEpochMs: requestAcceptedAtEpochMs,
		finishedAtEpochMs: null,
		processObservation: null,
		waitingReason: "awaiting_native_process_ownership_observation",
		recoveryCondition: "native_process_identity_or_original_result_available",
	};
	let admissionCancellationResult: ForkedWorkBranchResult | null = null;
	await lockedFileSystem.withLock({ type: "directory", path: executionDirectory(input.workspaceId) }, async () => {
		if (cancellationGenerationChanged()) {
			admissionCancellationResult = {
				outputText: "登记准备期间已被显式 Stop 取消",
				stopReason: "cancelled",
				localProcessLaunchStatus: "not_started",
				cancellationConfirmation: "not_started",
			};
			record.launchState = "not_started";
			record.status = "finished";
			record.finishedAtEpochMs = Date.now();
			record.waitingReason = "explicit_stop_before_execution_admission";
			record.recoveryCondition = "new_request_after_explicit_cancellation";
			record.result = admissionCancellationResult;
			await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(record), { lock: null });
			return;
		}
		// 在途或退出未知的同归属作业不重复派发；已结束记录保留作审计。
		for (const { record, path: previousPath } of await readExecutionRecords(input.workspaceId)) {
			if (
				record.taskId === input.taskId &&
				record.purpose === input.purpose &&
				record.parentNativeSessionId === input.parentNativeSessionId &&
				(await executionHasLiveOrUnprovenProcesses(record, previousPath))
			) {
				throw new Error("同一来源仍有活跃或退出未知的后台 Agent；等待原生退出或结果证据后自动重验。");
			}
		}
		await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(record), { lock: null });
	});
	let observationsSaved = Promise.resolve();
	const controller = new AbortController();
	const forwardAbort = (): void => controller.abort();
	input.signal?.addEventListener("abort", forwardAbort, { once: true });
	if (input.signal?.aborted) controller.abort();
	let cancellationReadPending = false;
	const refreshCancellation = (): void => {
		if (cancellationGenerationChanged()) controller.abort();
	};
	const activeCancellationRefreshers =
		activeCancellationRefreshersByGenerationPath.get(cancellationGenerationPath) ?? new Set<() => void>();
	activeCancellationRefreshers.add(refreshCancellation);
	activeCancellationRefreshersByGenerationPath.set(cancellationGenerationPath, activeCancellationRefreshers);
	const cancellationObserver = setInterval(() => {
		try {
			refreshCancellation();
		} catch {
			/* 辅助读取缺证不视为用户取消，独立 marker 查询仍继续。 */
		}
		if (cancellationReadPending) return;
		cancellationReadPending = true;
		void readFile(`${path}.cancellation-request.json`, "utf8")
			.then(() => controller.abort())
			.catch(() => {})
			.finally(() => {
				cancellationReadPending = false;
			});
	}, 200);
	const saveObservation = (observation: ForkedWorkBranchProcessObservation): void => {
		if (observation.executionOwnershipToken !== record.executionOwnershipToken)
			throw new Error("进程观察的执行归属不匹配");
		record.launchState = "started";
		record.processObservation = observation;
		record.waitingReason = observation.processStartIdentity
			? "owned_background_agent_running"
			: "native_process_identity_unavailable";
		const serialized = JSON.stringify(record);
		observationsSaved = observationsSaved
			.catch(() => {})
			.then(() => lockedFileSystem.writeTextFileAtomic(path, serialized));
		void observationsSaved.catch(() => {});
	};
	const backgroundExecutionProgress: { forkResult: ForkedWorkBranchResult | null } = {
		forkResult: admissionCancellationResult,
	};
	// 核心 store 不接收 signal；锁内最后一次重读后取得提交资格，直到真实写盘和最终发布完成才释放。
	// 与 Stop 写代际共用 admission 锁，不在 fork 或等 store 锁期间持有。
	const commitState: {
		protection: Promise<void> | null;
		permission: Promise<void> | null;
		release?: () => void;
	} = { protection: null, permission: null };
	const acquireCommitPermission = async (): Promise<void> => {
		if (!commitState.permission) {
			let grantPermission!: () => void;
			let rejectPermission!: (reason: unknown) => void;
			commitState.permission = new Promise<void>((resolve, reject) => {
				grantPermission = resolve;
				rejectPermission = reject;
			});
			const released = new Promise<void>((resolve) => {
				commitState.release = resolve;
			});
			commitState.protection = lockedFileSystem.withLock(
				{ type: "directory", path: executionDirectory(input.workspaceId) },
				async () => {
					refreshCancellation();
					grantPermission();
					await released;
				},
			);
			void commitState.protection.catch(rejectPermission);
		}
		await commitState.permission;
		refreshCancellation();
	};
	try {
		refreshCancellation();
		if (admissionCancellationResult) controller.abort();
		const executor: ForkedWorkBranchExecutor = {
			start: async (request) => {
				refreshCancellation();
				if (controller.signal.aborted) {
					backgroundExecutionProgress.forkResult = {
						outputText: "派发前已被显式取消",
						stopReason: "cancelled",
						localProcessLaunchStatus: "not_started",
						cancellationConfirmation: "not_started",
					};
					record.launchState = "not_started";
					return backgroundExecutionProgress.forkResult;
				}
				const forwardRequestAbort = (): void => controller.abort();
				request.signal?.addEventListener("abort", forwardRequestAbort, { once: true });
				if (request.signal?.aborted) controller.abort();
				try {
					let result = await input.executor.start({
						...request,
						signal: controller.signal,
						onProcessObservation: (observation) => {
							saveObservation(observation);
							request.onProcessObservation?.(observation);
						},
						executionOwnershipToken: record.executionOwnershipToken,
						beforeProcessSpawn: async () => {
							await request.beforeProcessSpawn?.();
							if (cancellationGenerationChanged()) controller.abort();
							try {
								await readFile(`${path}.cancellation-request.json`, "utf8");
								controller.abort();
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							}
							if (controller.signal.aborted) return;
							await observationsSaved;
							record.launchState = "dispatch_intent";
							await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(record), { durable: true });
							if (cancellationGenerationChanged()) controller.abort();
						},
					});
					await observationsSaved.catch(() => {});
					await lockedFileSystem.withLock({ path: `${path}.execution-control`, type: "file" }, async () => {
						if (cancellationGenerationChanged()) controller.abort();
						try {
							await readFile(`${path}.cancellation-request.json`, "utf8");
							controller.abort();
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
						if (controller.signal.aborted) result = cancelForkResult(result);
						if (
							result.localProcessLaunchStatus === "not_started" ||
							result.cancellationConfirmation === "not_started"
						)
							record.launchState = "not_started";
						record.result = result;
						record.waitingReason = "background_operation_completion_pending";
						await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(record));
					});
					backgroundExecutionProgress.forkResult = result;
					return result;
				} finally {
					request.signal?.removeEventListener("abort", forwardRequestAbort);
				}
			},
		};
		let operationResult: OperationResult = await operation({
			executor,
			signal: controller.signal,
			refreshCancellation,
			acquireCommitPermission,
		});
		await observationsSaved.catch(() => {});
		const publishResult = async (): Promise<OperationResult> => {
			for (;;) {
				refreshCancellation();
				const cancelled = controller.signal.aborted;
				if (cancelled) {
					if (backgroundExecutionProgress.forkResult)
						backgroundExecutionProgress.forkResult = cancelForkResult(backgroundExecutionProgress.forkResult);
					operationResult = cancelOperationResult(operationResult);
				}
				record.status =
					backgroundExecutionProgress.forkResult?.cancellationConfirmation === "unknown"
						? "exit_unknown"
						: "finished";
				record.waitingReason = record.status === "finished" ? null : "cancellation_confirmation_unavailable";
				record.result = backgroundExecutionProgress.forkResult;
				record.finishedAtEpochMs = Date.now();
				await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(record));
				// 调用方 AbortSignal 不经持久锁；若它在异步写入中取消，重写并撤回业务载荷。
				refreshCancellation();
				if (!cancelled && controller.signal.aborted) continue;
				return operationResult;
			}
		};
		return await (commitState.protection
			? publishResult()
			: lockedFileSystem.withLock(
					{ type: "directory", path: executionDirectory(input.workspaceId) },
					publishResult,
				));
	} catch (error) {
		await observationsSaved.catch(() => {});
		if (record.launchState === "registered") {
			record.launchState = "not_started";
			record.status = "finished";
		} else record.status = "exit_unknown";
		record.waitingReason =
			record.launchState === "not_started"
				? "configuration_or_spawn_preflight_recovery_required"
				: "original_result_or_exit_evidence_required";
		await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(record));
		throw error;
	} finally {
		clearInterval(cancellationObserver);
		commitState.release?.();
		await commitState.protection?.catch(() => {});
		input.signal?.removeEventListener("abort", forwardAbort);
		activeCancellationRefreshers.delete(refreshCancellation);
		if (activeCancellationRefreshers.size === 0)
			activeCancellationRefreshersByGenerationPath.delete(cancellationGenerationPath);
	}
}

export function createSessionOwnedBackgroundAgentExecutor(
	input: SessionOwnedBackgroundAgentExecutionOwner,
): ForkedWorkBranchExecutor {
	return {
		start: (request) =>
			runSessionOwnedBackgroundAgentOperation(
				{ ...input, parentNativeSessionId: request.parentSession.nativeSessionId, signal: request.signal },
				async ({ executor }) => await executor.start(request),
				cancelForkResult,
			),
	};
}
