import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
	type RuntimeTaskSessionSummary,
	runtimeBoardDataSchema,
	runtimeTaskSessionSummarySchema,
} from "../core/api-contract";
import {
	duplicateProjectConsolidationControlSchema,
	type duplicateProjectConsolidationPreviewRequestSchema,
	duplicateProjectConsolidationPreviewSchema,
	type duplicateProjectConsolidationRequestSchema,
} from "../core/duplicate-project-consolidation-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	mergeTransferredAgentRaisedPendingUserDecisionsWithinPausedWrites,
	withAgentRaisedPendingUserDecisionWritesPaused,
} from "../state/agent-raised-pending-user-decision-store";
import {
	mergeTransferredAgentSessionReclamationHistoryWithinPausedWrites,
	readAgentSessionReclamationDeadlineRecords,
	withAgentSessionReclamationDeadlineWritesPaused,
} from "../state/agent-session-reclamation-deadline-store";
import {
	assertProjectIsNotInPendingConsolidation,
	clearRejectedDuplicateProjectConsolidationControl,
	duplicateProjectConsolidationDirectory,
	duplicateProjectConsolidationReceiptPath,
	readDuplicateProjectConsolidationControlRecord,
	readDuplicateProjectConsolidationStatus,
	writeDuplicateProjectConsolidationControl,
} from "../state/duplicate-project-consolidation-status";
import { mergeTransferredSettledQueuedTaskPromptDeliveries } from "../state/queued-task-prompt-delivery-store";
import { resolveGitCommonDirectory } from "../state/registered-workspace-invocation-context";
import {
	mergeTransferredTaskLastOpenedByUserRecordsWithinPausedWrites,
	withTaskLastOpenedByUserRecordWritesPaused,
} from "../state/task-last-opened-by-user-record-store";
import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	detectGitRepositoryInfo,
	getWorkspaceDirectoryLockRequest,
	getWorkspaceDirectoryPath,
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceStateById,
	prepareWorkspaceStateSnapshotForWriteWithinLock,
	reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock,
	removeWorkspaceIndexEntry,
	writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents,
} from "../state/workspace-state";
import {
	WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME,
	WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME,
} from "../state/workspace-state-snapshot-storage";
import { createTaskConversationSessionOperationStore } from "../task-conversation-sessions/task-conversation-session-operation-store";
import { mergeTransferredTaskCommitIntegrationProvenance } from "../workspace/task-commit-integration-provenance";
import type { ActiveRuntimeSessionShutdownResult } from "./active-runtime-session-shutdown";
import { projectStoppedRuntimeSessionForSafePersistence } from "./safely-stopped-runtime-session-persistence";

const receiptSchema = duplicateProjectConsolidationPreviewSchema.extend({
	operationId: z.string().uuid(),
	status: z.enum(["quiescing", "captured", "tasks_transferred", "completed", "rejected_before_capture"]),
	intent: z.custom<TaskMutationIntentWithResolvedActor>(
		(value) =>
			value !== null &&
			typeof value === "object" &&
			"taskMutationIntentKind" in value &&
			"resolvedKanbanActor" in value,
	),
	sourceBoard: runtimeBoardDataSchema.optional(),
	sourceSessions: z.record(z.string(), runtimeTaskSessionSummarySchema).optional(),
	sourceFiles: z.record(z.string(), z.string()).optional(),
	lastFailure: z.string().optional(),
	nextRecoveryAt: z.number().optional(),
	recoveryEvidenceFingerprint: z.string().optional(),
	recoveryAttemptCount: z.number().optional(),
	// 回执标记只说明复制已经提交；真正的一次边界在目标独立 Stop 文件里。标记可以晚到，不能提前。
	explicitStopMarkersMigrated: z.boolean().optional(),
	// 完成发布之后若活动项目切换失败，恢复只重试切换，不再装入会话。
	activeWorkspaceRetargeted: z.boolean().optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
type PreviewInput = z.infer<typeof duplicateProjectConsolidationPreviewRequestSchema>;
interface Dependencies {
	runtimeProcessInstanceId: string;
	stopAndCollectProjectRuntimeSessionsForSafePersistence: (
		workspaceId: string,
	) => Promise<ActiveRuntimeSessionShutdownResult>;
	listProjectRuntimeSessionSummaries: (workspaceId: string) => RuntimeTaskSessionSummary[];
	disposeProjectRuntime: (workspaceId: string) => Promise<void>;
	hydrateTransferredTaskSessions: (
		workspaceId: string,
		repositoryPath: string,
		sessions: Record<string, RuntimeTaskSessionSummary>,
	) => Promise<void>;
	getActiveWorkspaceId: () => string | null;
	setActiveWorkspace: (workspaceId: string, repositoryPath: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (workspaceId: string | null) => Promise<void> | void;
	warn: (message: string) => void;
	confirmLoadedProjectRuntimeSessionsHaveExited?: (workspaceId: string) => Promise<void>;
	// 只观察目标终端管理器是否已经装入，不执行会话装入。
	observeTransferredTaskSessionHydrationGate?: (
		workspaceId: string,
		repositoryPath: string,
	) => unknown | Promise<unknown>;
}

const supportedSourceFiles = new Set([
	"board.json",
	"sessions.json",
	"meta.json",
	"agent-raised-pending-user-decisions.json",
	"agent-session-reclamation-deadlines.json",
	"queued-task-prompt-deliveries.json",
	"recoverable-hook-lifecycle-event-deliveries.json",
	"task-commit-integration-provenance.json",
	"task-last-opened-by-user-records.json",
]);
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const objectSchema = z.record(z.string(), z.unknown());
const recordsSchema = z.array(objectSchema);
const ignoredSourceBookkeepingFiles = new Set([
	WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME,
	WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME,
]);
const settledReclamationStates = new Set(["reclaimed", "superseded"]);
const activeProcessLiveness = new Set(["starting", "live", "retrying"]);

class ConsolidationAcceptanceRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConsolidationAcceptanceRefused";
	}
}

function isAgentStillWorkingCurrentTurn(summary: RuntimeTaskSessionSummary): boolean {
	const facets = resolveSessionFacets(summary);
	return facets.turnOwner === "agent" && activeProcessLiveness.has(facets.liveness);
}

function recordedProcessPid(summary: { pid?: number | null }): number | null {
	return typeof summary.pid === "number" ? summary.pid : null;
}

function isRecordedProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

async function waitUntilRecordedProcessExits(pid: number): Promise<void> {
	const deadline = performance.now() + 2_500;
	while (isRecordedProcessAlive(pid)) {
		if (performance.now() >= deadline) throw new Error(`来源进程 ${pid} 仍存在，不能迁移。`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function assertRecordedProcessExitIsConfirmed(summary: RuntimeTaskSessionSummary): void {
	const pid = recordedProcessPid(summary);
	if (pid !== null) {
		if (isRecordedProcessAlive(pid)) throw new Error(`来源进程 ${pid} 仍存在，不能迁移。`);
		return;
	}
	if (activeProcessLiveness.has(resolveSessionFacets(summary).liveness))
		throw new Error("来源项目的会话尚未确证停止。");
}

function reclamationDeadlinesAreSettled(files: Record<string, string>): boolean {
	const text = files["agent-session-reclamation-deadlines.json"];
	if (!text) return true;
	return recordsSchema
		.parse(JSON.parse(text))
		.every((record) => settledReclamationStates.has(String(record.reclamationState)));
}

function assertReclamationDeadlinesAreSettled(files: Record<string, string>): void {
	if (!reclamationDeadlinesAreSettled(files)) throw new Error("来源会话的回收期限尚未结算，等待安全停止完成后重试。");
}

function reclamationDeadlineGateProjection(text: string): unknown {
	try {
		const records = recordsSchema.parse(JSON.parse(text));
		return {
			present: true,
			settled: records.every((record) => settledReclamationStates.has(String(record.reclamationState))),
			states: records.map((record) => [String(record.recordId ?? ""), String(record.reclamationState ?? "")]),
		};
	} catch (error) {
		return { present: true, unreadable: error instanceof Error ? error.message : String(error) };
	}
}

async function reclamationDeadlineRecoveryEvidence(workspaceId: string): Promise<unknown> {
	const path = join(getWorkspaceDirectoryPath(workspaceId), "agent-session-reclamation-deadlines.json");
	let text: string | null;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") text = null;
		else return { unreadable: error instanceof Error ? error.message : String(error) };
	}
	let official: unknown;
	try {
		official = await readAgentSessionReclamationDeadlineRecords(workspaceId);
	} catch (error) {
		official = { unreadable: error instanceof Error ? error.message : String(error) };
	}
	return { official, gate: text === null ? { present: false } : reclamationDeadlineGateProjection(text) };
}

async function migrateExplicitStopMarkers(receipt: Receipt): Promise<void> {
	const operations = createTaskConversationSessionOperationStore();
	const stoppedSessionIds = (
		await operations.read({
			workspaceId: receipt.sourceWorkspaceId,
			workspacePath: receipt.sourceRepositoryPath,
		})
	).explicitlyStoppedSessionIds;
	await operations.migrateTransferredExplicitStopMarkers(
		{
			workspaceId: receipt.targetWorkspaceId,
			workspacePath: receipt.targetRepositoryPath,
		},
		{ operationId: receipt.operationId, sourceWorkspaceId: receipt.sourceWorkspaceId },
		stoppedSessionIds,
	);
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
async function sourceFiles(workspaceId: string) {
	const directory = getWorkspaceDirectoryPath(workspaceId);
	const files: Record<string, string> = {};
	for (const name of await readdir(directory)) {
		if (ignoredSourceBookkeepingFiles.has(name)) continue;
		if (!supportedSourceFiles.has(name))
			throw new Error(`来源项目还有未支持迁移的状态 ${name}，保留原项目并拒绝注销。`);
		files[name] = await readFile(join(directory, name), "utf8");
	}
	return files;
}
function assertHistoryCanBeRetainedWithoutReplay(files: Record<string, string>) {
	const queue = files["queued-task-prompt-deliveries.json"];
	if (queue) {
		const tasks = objectSchema.parse(objectSchema.parse(JSON.parse(queue)).entriesByTaskId);
		for (const entries of Object.values(tasks))
			for (const entry of recordsSchema.parse(entries))
				if (!["settled_delivered", "settled_failed", "cancelled", "expired"].includes(String(entry.deliveryState)))
					throw new Error("来源项目仍有未结算的消息投递，等待原投递结算后重试，不能重复发送。");
	}
	const hooks = files["recoverable-hook-lifecycle-event-deliveries.json"];
	if (hooks)
		for (const entry of recordsSchema.parse(objectSchema.parse(JSON.parse(hooks)).deliveries))
			if (!["application_confirmed", "superseded_by_newer_session_state"].includes(String(entry.status)))
				throw new Error("来源项目仍有未结算的生命周期事件，等待恢复完成后重试。");
}

async function withStateStoresPaused<T>(ids: string[], action: () => Promise<T>): Promise<T> {
	return withAgentRaisedPendingUserDecisionWritesPaused(ids, () =>
		withAgentSessionReclamationDeadlineWritesPaused(ids, () =>
			withTaskLastOpenedByUserRecordWritesPaused(ids, action),
		),
	);
}
async function withWorkspaceLocks<T>(ids: string[], action: () => Promise<T>): Promise<T> {
	const [first, ...rest] = ids;
	return first
		? lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(first), () => withWorkspaceLocks(rest, action))
		: action();
}
async function mergeAuxiliaryState(receipt: Receipt) {
	const files = receipt.sourceFiles;
	if (!files) throw new Error("迁移缺少来源状态快照，不能继续写入。");
	const mergers = [
		["agent-raised-pending-user-decisions.json", mergeTransferredAgentRaisedPendingUserDecisionsWithinPausedWrites],
		["agent-session-reclamation-deadlines.json", mergeTransferredAgentSessionReclamationHistoryWithinPausedWrites],
		["queued-task-prompt-deliveries.json", mergeTransferredSettledQueuedTaskPromptDeliveries],
		["task-commit-integration-provenance.json", mergeTransferredTaskCommitIntegrationProvenance],
		["task-last-opened-by-user-records.json", mergeTransferredTaskLastOpenedByUserRecordsWithinPausedWrites],
	] as const;
	for (const [filename, merge] of mergers) {
		const sourceText = files[filename];
		if (sourceText) await merge(receipt.targetWorkspaceId, sourceText);
	}
	// 生命周期投递原件只留在持久回执中，不注入目标恢复扫描器，避免重复应用旧事件。
}

export function createDuplicateProjectConsolidationService(deps: Dependencies) {
	const controlForReceipt = (receipt: Receipt) =>
		duplicateProjectConsolidationControlSchema.parse({
			...receipt,
			status: receipt.status === "rejected_before_capture" ? "quiescing" : receipt.status,
		});
	const saveReceipt = (receipt: Receipt) =>
		lockedFileSystem.writeJsonFileAtomic(
			duplicateProjectConsolidationReceiptPath(receipt.sourceWorkspaceId),
			receipt,
			{ lock: null, durable: true, fileMode: 0o600 },
		);
	const publishCompletedConsolidation = async (receipt: Receipt) => {
		await writeDuplicateProjectConsolidationControl(controlForReceipt({ ...receipt, status: "completed" }));
		await removeWorkspaceIndexEntry(receipt.sourceWorkspaceId);
		receipt.status = "completed";
		await saveReceipt(receipt);
	};
	const retargetActiveWorkspace = async (receipt: Receipt) => {
		if (receipt.activeWorkspaceRetargeted === true) return;
		if (deps.getActiveWorkspaceId() === receipt.sourceWorkspaceId)
			await deps.setActiveWorkspace(receipt.targetWorkspaceId, receipt.targetRepositoryPath);
		receipt.activeWorkspaceRetargeted = true;
		await saveReceipt(receipt);
	};
	const completionPublicationIsDurable = async (receipt: Receipt) => {
		const source = await readDuplicateProjectConsolidationControlRecord(receipt.sourceWorkspaceId);
		const target = await readDuplicateProjectConsolidationControlRecord(
			receipt.targetWorkspaceId,
			receipt.sourceWorkspaceId,
		);
		if (
			source?.operationId !== receipt.operationId ||
			source.status !== "completed" ||
			target?.operationId !== receipt.operationId ||
			target.status !== "completed"
		)
			return false;
		const indexed = await listWorkspaceIndexEntries();
		return indexed.every((entry) => entry.workspaceId !== receipt.sourceWorkspaceId);
	};
	const preview = async (input: PreviewInput) => {
		if (input.sourceWorkspaceId === input.targetWorkspaceId) throw new Error("来源项目与目标项目必须不同。");
		const entries = await listWorkspaceIndexEntries({ requireCompleteRead: true });
		const source = entries.find((entry) => entry.workspaceId === input.sourceWorkspaceId);
		const target = entries.find((entry) => entry.workspaceId === input.targetWorkspaceId);
		if (!source || !target) throw new Error("合并的两个项目都必须已注册。");
		const common = await resolveGitCommonDirectory(source.repoPath);
		if (common !== (await resolveGitCommonDirectory(target.repoPath)))
			throw new Error("只支持同一 Git common-dir 的重复项目合并。");
		if (basename(source.repoPath) !== basename(target.repoPath))
			throw new Error("项目目录名不同，不能保证任务工作树路径不变。");
		const state = await loadPersistedWorkspaceStateById(source.workspaceId);
		const targetState = await loadPersistedWorkspaceStateById(target.workspaceId);
		const sourceTaskIds = new Set(state.board.columns.flatMap((column) => column.cards.map((card) => card.id)));
		if (
			Object.values(state.sessions).some(
				(summary) => !sourceTaskIds.has(summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId),
			)
		)
			throw new Error("来源项目有无法核对所属任务的会话，保留原项目并拒绝迁移。");
		const tasks = state.board.columns.flatMap((column) =>
			column.cards.map((card) => ({
				taskId: card.id,
				title: card.title,
				columnId: column.id,
				createdAt: card.createdAt,
			})),
		);
		const targetIds = new Set(targetState.board.columns.flatMap((column) => column.cards.map((card) => card.id)));
		if (tasks.some((task) => targetIds.has(task.taskId)))
			throw new Error("目标项目已存在相同 task ID，不能猜测归属。");
		if (
			Object.values(state.sessions).some(
				(summary) => summary.sessionTransport && summary.sessionTransport !== "pty_terminal",
			)
		)
			throw new Error("当前保全合并只支持 PTY 会话，其他 transport 保留原项目。");
		if (state.board.columns.some((column) => column.cards.some((card) => card.worktreeMode === "inplace")))
			throw new Error("原地执行的任务不能保全现有执行目录，请先单独处理。");
		assertHistoryCanBeRetainedWithoutReplay(await sourceFiles(source.workspaceId));
		const result = {
			sourceWorkspaceId: input.sourceWorkspaceId,
			targetWorkspaceId: input.targetWorkspaceId,
			sourceRepositoryPath: source.repoPath,
			targetRepositoryPath: target.repoPath,
			gitCommonDirectory: common,
			sourceBoardFingerprint: fingerprint(state.board),
			tasks,
		};
		return { ...result, previewFingerprint: fingerprint(result) };
	};
	const finish = async (receipt: Receipt) => {
		const published = await readDuplicateProjectConsolidationStatus(receipt.sourceWorkspaceId);
		const completionAlreadyPublic =
			published?.operationId === receipt.operationId && published.status === "completed";
		// 来源完成控制已公开时，回执可能仍停在 tasks_transferred。此时只补目标控制和注销，不能因仓库身份变化拒绝收尾。
		const resumePublishedFinish =
			receipt.status === "completed" || (completionAlreadyPublic && receipt.status === "tasks_transferred");
		if (
			!resumePublishedFinish &&
			((await resolveGitCommonDirectory(receipt.sourceRepositoryPath)) !== receipt.gitCommonDirectory ||
				(await resolveGitCommonDirectory(receipt.targetRepositoryPath)) !== receipt.gitCommonDirectory)
		)
			throw new Error("项目的 Git 仓库身份已变化，保留原操作并拒绝写入。");
		const path = duplicateProjectConsolidationReceiptPath(receipt.sourceWorkspaceId);
		const save = async () => {
			await writeDuplicateProjectConsolidationControl(controlForReceipt(receipt));
			await saveReceipt(receipt);
		};
		if (receipt.status === "quiescing") {
			await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(receipt.sourceWorkspaceId), async () => {
				const source = await loadPersistedWorkspaceStateById(receipt.sourceWorkspaceId);
				if (fingerprint(source.board) !== receipt.sourceBoardFingerprint)
					throw new ConsolidationAcceptanceRefused("来源任务身份清单或正文在受理前发生变化，请重新预览。");
				await writeDuplicateProjectConsolidationControl(controlForReceipt(receipt));
			});
			if (deps.listProjectRuntimeSessionSummaries(receipt.sourceWorkspaceId).some(isAgentStillWorkingCurrentTurn))
				throw new Error("来源项目的 Agent 仍在工作，待当前回合自然结束后自动接续。");
			const loadedBeforeStop = deps.listProjectRuntimeSessionSummaries(receipt.sourceWorkspaceId);
			const managedPids = new Set(
				loadedBeforeStop.flatMap((summary) => {
					const pid = recordedProcessPid(summary);
					return pid === null ? [] : [pid];
				}),
			);
			if (deps.confirmLoadedProjectRuntimeSessionsHaveExited)
				await deps.confirmLoadedProjectRuntimeSessionsHaveExited(receipt.sourceWorkspaceId);
			const stopped = await deps.stopAndCollectProjectRuntimeSessionsForSafePersistence(receipt.sourceWorkspaceId);
			for (const summary of [...loadedBeforeStop, ...stopped.runtimeSessionSummariesForSafePersistence]) {
				const pid = recordedProcessPid(summary);
				if (pid !== null) await waitUntilRecordedProcessExits(pid);
			}
			await deps.disposeProjectRuntime(receipt.sourceWorkspaceId);
			await withStateStoresPaused([receipt.sourceWorkspaceId], async () => {
				await lockedFileSystem.withLocks(
					[
						getWorkspaceDirectoryLockRequest(receipt.sourceWorkspaceId),
						...[...supportedSourceFiles]
							.filter((name) => !["board.json", "sessions.json", "meta.json"].includes(name))
							.map((name) => ({
								path: join(getWorkspaceDirectoryPath(receipt.sourceWorkspaceId), name),
								type: "file" as const,
							})),
					],
					async () => {
						await prepareWorkspaceStateSnapshotForWriteWithinLock(receipt.sourceWorkspaceId);
						const state = await loadPersistedWorkspaceStateById(receipt.sourceWorkspaceId);
						const identities = state.board.columns
							.flatMap((column) => column.cards.map((card) => `${card.id}:${card.createdAt}`))
							.sort();
						if (
							fingerprint(identities) !==
							fingerprint(receipt.tasks.map((task) => `${task.taskId}:${task.createdAt}`).sort())
						)
							throw new ConsolidationAcceptanceRefused(
								"来源任务身份清单在预览后发生变化，未扩大已受理的合并范围。",
							);
						for (const summary of Object.values(state.sessions)) {
							const pid = recordedProcessPid(summary);
							if (pid !== null && isRecordedProcessAlive(pid) && !managedPids.has(pid))
								throw new ConsolidationAcceptanceRefused(
									`来源进程 ${pid} 仍存在且当前运行时未托管，未受理合并。`,
								);
							assertRecordedProcessExitIsConfirmed(summary);
						}
						for (const summary of stopped.runtimeSessionSummariesForSafePersistence) {
							const earlier = loadedBeforeStop.find((entry) => entry.taskId === summary.taskId);
							if (recordedProcessPid(summary) === null && earlier && recordedProcessPid(earlier) !== null)
								continue;
							assertRecordedProcessExitIsConfirmed(summary);
						}
						const sessions = { ...state.sessions };
						for (const summary of stopped.runtimeSessionSummariesForSafePersistence)
							sessions[summary.taskId] = projectStoppedRuntimeSessionForSafePersistence(summary);
						const capturedFiles = await sourceFiles(receipt.sourceWorkspaceId);
						assertHistoryCanBeRetainedWithoutReplay(capturedFiles);
						assertReclamationDeadlinesAreSettled(capturedFiles);
						receipt.sourceFiles = capturedFiles;
						receipt.sourceBoard = state.board;
						receipt.sourceSessions = Object.fromEntries(
							Object.entries(sessions).map(([id, summary]) => [
								id,
								{
									...projectStoppedRuntimeSessionForSafePersistence(summary),
									pid: null,
									codexNativeSessionControlEndpoint: null,
									codexConfigurationWriterBinding: null,
								},
							]),
						);
						receipt.status = "captured";
						await save();
					},
				);
			});
		}
		if (receipt.status === "captured") {
			if (receipt.sourceFiles && !reclamationDeadlinesAreSettled(receipt.sourceFiles)) {
				receipt.sourceFiles = undefined;
				receipt.sourceBoard = undefined;
				receipt.sourceSessions = undefined;
				receipt.status = "quiescing";
				await save();
				throw new Error("来源会话的回收期限尚未结算，等待安全停止完成后重试。");
			}
			const sourceBoard = receipt.sourceBoard;
			const sourceSessions = receipt.sourceSessions;
			if (!sourceBoard || !sourceSessions) throw new Error("迁移缺少已核验的任务与会话快照。");
			const ids = [receipt.sourceWorkspaceId, receipt.targetWorkspaceId].sort();
			await withStateStoresPaused(ids, () =>
				withWorkspaceLocks(ids, async () => {
					await mergeAuxiliaryState(receipt);
					for (const task of receipt.tasks) {
						for (const writeSide of ["target", "source"] as const) {
							const workspaceId = writeSide === "source" ? receipt.sourceWorkspaceId : receipt.targetWorkspaceId;
							const repoPath =
								writeSide === "source" ? receipt.sourceRepositoryPath : receipt.targetRepositoryPath;
							await prepareWorkspaceStateSnapshotForWriteWithinLock(workspaceId);
							const state = await loadPersistedWorkspaceStateById(workspaceId);
							const original = sourceBoard.columns
								.flatMap((column) => column.cards)
								.find((card) => card.id === task.taskId);
							if (!original) throw new Error("迁移清单与任务快照不一致。");
							const existing = state.board.columns
								.flatMap((column) => column.cards)
								.find((card) => card.id === task.taskId);
							if (
								existing &&
								(existing.createdAt !== original.createdAt ||
									(writeSide === "source" && fingerprint(existing) !== fingerprint(original)))
							)
								throw new Error("迁移过程中任务被修改，未覆盖新内容。");
							if ((writeSide === "target" && existing) || (writeSide === "source" && !existing)) continue;
							const context = {
								workspaceId,
								repoPath,
								statePath: getWorkspaceDirectoryPath(workspaceId),
								git: await detectGitRepositoryInfo(repoPath),
							};
							await reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(
								context,
								state.board,
								state.sessions,
								state.revision,
							);
							const sessions = { ...state.sessions };
							for (const [id, summary] of Object.entries(sourceSessions)) {
								if (
									(summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId) !== task.taskId
								)
									continue;
								if (writeSide === "source") delete sessions[id];
								else {
									if (sessions[id]) throw new Error("目标存在同名会话，保留原数据并拒绝覆盖。");
									sessions[id] = summary;
								}
							}
							await writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents({
								context,
								previousBoard: state.board,
								previousSessions: state.sessions,
								nextBoard: {
									...state.board,
									columns: state.board.columns.map((column) => ({
										...column,
										cards:
											writeSide === "source"
												? column.cards.filter((card) => card.id !== task.taskId)
												: column.id ===
														sourceBoard.columns.find((entry) =>
															entry.cards.some((card) => card.id === task.taskId),
														)?.id
													? [...column.cards, original]
													: column.cards,
									})),
								},
								nextSessions: sessions,
								nextMeta: { revision: state.revision + 1, updatedAt: Date.now() },
								taskMutationIntentWithResolvedActor: {
									...receipt.intent,
									taskMutationIntentKind: "duplicate_project_task_transferred",
									backlogTaskProjectTransfer: {
										operationId: `${receipt.operationId}:${task.taskId}`,
										sourceWorkspaceId: receipt.sourceWorkspaceId,
										targetWorkspaceId: receipt.targetWorkspaceId,
										taskId: task.taskId,
										taskIncarnationCreatedAtEpochMs: task.createdAt,
										writeSide,
									},
								},
							});
						}
					}
					receipt.status = "tasks_transferred";
					await save();
				}),
			);
		}
		if (receipt.status === "tasks_transferred" && !completionAlreadyPublic) {
			// 先提交目标 Stop 文件里的一次复制，再写回执。回执失败时恢复不得再次并集。
			if (receipt.explicitStopMarkersMigrated !== true) {
				await migrateExplicitStopMarkers(receipt);
				receipt.explicitStopMarkersMigrated = true;
				await saveReceipt(receipt);
			}
			const source = await loadPersistedWorkspaceStateById(receipt.sourceWorkspaceId);
			if (source.board.columns.some((column) => column.cards.length) || Object.keys(source.sessions).length)
				throw new Error("来源仍有任务或会话，拒绝注销项目。");
			await deps.hydrateTransferredTaskSessions(
				receipt.targetWorkspaceId,
				receipt.targetRepositoryPath,
				receipt.sourceSessions ?? {},
			);
		}
		if (receipt.status === "tasks_transferred" || receipt.status === "completed")
			await publishCompletedConsolidation(receipt);
		if (receipt.status === "completed") await retargetActiveWorkspace(receipt);
		await deps.broadcastRuntimeProjectsUpdated(receipt.targetWorkspaceId);
		return {
			ok: true as const,
			operationId: receipt.operationId,
			sourceWorkspaceId: receipt.sourceWorkspaceId,
			targetWorkspaceId: receipt.targetWorkspaceId,
			status: "completed" as const,
			taskIds: receipt.tasks.map((task) => task.taskId),
			receiptPath: path,
		};
	};
	const assertConsolidationCanBeAccepted = async (sourceWorkspaceId: string) => {
		const loaded = deps.listProjectRuntimeSessionSummaries(sourceWorkspaceId);
		if (loaded.some(isAgentStillWorkingCurrentTurn))
			throw new Error("来源 Agent 当前仍在工作，请待当前回合结束后再合并。");
		const persisted = await loadPersistedWorkspaceStateById(sourceWorkspaceId);
		for (const summary of Object.values(persisted.sessions)) {
			const pid = recordedProcessPid(summary);
			if (pid === null || !isRecordedProcessAlive(pid)) continue;
			if (!loaded.some((entry) => entry.taskId === summary.taskId && entry.pid === pid))
				throw new ConsolidationAcceptanceRefused(`来源进程 ${pid} 仍存在且当前运行时未托管，未受理合并。`);
		}
	};
	const rememberConsolidationFailure = async (path: string, receipt: Receipt, error: unknown) => {
		if (error instanceof ConsolidationAcceptanceRefused && receipt.status === "quiescing") {
			receipt.lastFailure = error.message;
			receipt.status = "rejected_before_capture";
			await saveReceipt(receipt);
			await clearRejectedDuplicateProjectConsolidationControl(controlForReceipt(receipt));
			return;
		}
		receipt.lastFailure = error instanceof Error ? error.message : String(error);
		receipt.nextRecoveryAt = Date.now() + 30_000;
		await lockedFileSystem.writeJsonFileAtomic(path, receipt, { lock: null, durable: true, fileMode: 0o600 });
	};
	const recoveryEvidence = async (receipt: Receipt) => {
		let target: unknown;
		try {
			const state = await loadPersistedWorkspaceStateById(receipt.targetWorkspaceId);
			target = {
				revision: state.revision,
				sessionIds: Object.keys(state.sessions).sort(),
				taskIds: state.board.columns.flatMap((column) => column.cards.map((card) => card.id)).sort(),
			};
		} catch (error) {
			target = { unavailable: error instanceof Error ? error.message : String(error) };
		}
		const hydrationGate =
			receipt.status === "tasks_transferred"
				? {
						runtimeGeneration: deps.runtimeProcessInstanceId,
						terminalManager: deps.observeTransferredTaskSessionHydrationGate
							? await deps.observeTransferredTaskSessionHydrationGate(
									receipt.targetWorkspaceId,
									receipt.targetRepositoryPath,
								)
							: null,
					}
				: null;
		return fingerprint({
			status: receipt.status,
			source: await loadPersistedWorkspaceStateById(receipt.sourceWorkspaceId),
			sessions: deps
				.listProjectRuntimeSessionSummaries(receipt.sourceWorkspaceId)
				.map((summary) => ({ taskId: summary.taskId, ...resolveSessionFacets(summary) })),
			target,
			targetSessions: deps
				.listProjectRuntimeSessionSummaries(receipt.targetWorkspaceId)
				.map((summary) => ({ taskId: summary.taskId, ...resolveSessionFacets(summary) })),
			reclamationDeadlines: await reclamationDeadlineRecoveryEvidence(receipt.sourceWorkspaceId),
			hydrationGate,
			completedRecovery:
				receipt.status === "completed" ? { runtimeGeneration: deps.runtimeProcessInstanceId } : null,
		});
	};
	const consolidate = async (
		input: z.infer<typeof duplicateProjectConsolidationRequestSchema>,
		intent: TaskMutationIntentWithResolvedActor,
	) => {
		return lockedFileSystem.withLock(
			{ path: duplicateProjectConsolidationDirectory(), type: "directory" },
			async () => {
				const path = duplicateProjectConsolidationReceiptPath(input.sourceWorkspaceId);
				const previous = await readOptionalJson(path);
				let receipt: Receipt;
				if (previous && receiptSchema.parse(previous).status !== "rejected_before_capture") {
					receipt = receiptSchema.parse(previous);
					if (
						receipt.targetWorkspaceId !== input.targetWorkspaceId ||
						receipt.previewFingerprint !== input.previewFingerprint
					)
						throw new Error("来源已有不同的合并记录，不能改写原操作。");
				} else {
					if (previous) {
						const rejected = receiptSchema.parse(previous);
						await lockedFileSystem.writeJsonFileAtomic(
							join(
								duplicateProjectConsolidationDirectory(),
								"rejected-before-capture",
								`${rejected.operationId}.json`,
							),
							rejected,
							{ durable: true, fileMode: 0o600 },
						);
					}
					await assertProjectIsNotInPendingConsolidation(input.sourceWorkspaceId);
					await assertProjectIsNotInPendingConsolidation(input.targetWorkspaceId);
					const current = await preview(input);
					if (current.previewFingerprint !== input.previewFingerprint)
						throw new Error("预览已过期，请重新预览合并清单。");
					await assertConsolidationCanBeAccepted(input.sourceWorkspaceId);
					receipt = { ...current, operationId: randomUUID(), status: "quiescing", intent };
					await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(input.sourceWorkspaceId), async () => {
						const state = await loadPersistedWorkspaceStateById(input.sourceWorkspaceId);
						if (fingerprint(state.board) !== receipt.sourceBoardFingerprint)
							throw new ConsolidationAcceptanceRefused("来源任务在预览后变化，请重新预览。");
						await saveReceipt(receipt);
						await writeDuplicateProjectConsolidationControl(controlForReceipt(receipt));
					});
				}
				try {
					return await finish(receipt);
				} catch (error) {
					await rememberConsolidationFailure(path, receipt, error);
					throw error;
				}
			},
		);
	};
	const recoverPending = async () => {
		let names: string[];
		try {
			names = await readdir(duplicateProjectConsolidationDirectory());
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const name of names.filter((name) => name.endsWith(".json"))) {
			try {
				await lockedFileSystem.withLock(
					{ path: duplicateProjectConsolidationDirectory(), type: "directory" },
					async () => {
						const path = join(duplicateProjectConsolidationDirectory(), name);
						const receipt = receiptSchema.parse(await readOptionalJson(path));
						if (receipt.status === "rejected_before_capture") {
							await clearRejectedDuplicateProjectConsolidationControl(controlForReceipt(receipt));
							return;
						}
						if (receipt.status === "completed") {
							const publicationDurable = await completionPublicationIsDurable(receipt);
							const activeWorkspaceSwitchPending =
								receipt.activeWorkspaceRetargeted !== true &&
								deps.getActiveWorkspaceId() === receipt.sourceWorkspaceId;
							if (publicationDurable && !activeWorkspaceSwitchPending) {
								if (receipt.activeWorkspaceRetargeted !== true) {
									receipt.activeWorkspaceRetargeted = true;
									await saveReceipt(receipt);
								}
								return;
							}
						}
						if ((receipt.nextRecoveryAt ?? 0) > Date.now()) return;
						const evidence = await recoveryEvidence(receipt);
						// 相同证据一律三次封顶。期限结算、目标存储、本进程代数或管理器装入状态变化后，计数从 1 重新开始。
						if (receipt.recoveryEvidenceFingerprint === evidence && (receipt.recoveryAttemptCount ?? 0) >= 3)
							return;
						receipt.recoveryAttemptCount =
							receipt.recoveryEvidenceFingerprint === evidence ? (receipt.recoveryAttemptCount ?? 0) + 1 : 1;
						receipt.recoveryEvidenceFingerprint = evidence;
						await lockedFileSystem.writeJsonFileAtomic(path, receipt, {
							lock: null,
							durable: true,
							fileMode: 0o600,
						});
						try {
							await finish(receipt);
						} catch (error) {
							await rememberConsolidationFailure(path, receipt, error);
							if (!(error instanceof ConsolidationAcceptanceRefused))
								deps.warn(`重复项目合并保留待恢复状态：${receipt.lastFailure}`);
						}
					},
				);
			} catch (error) {
				deps.warn(
					`保全合并记录 ${name} 暂不可恢复，其他操作继续：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	};
	return { preview, consolidate, recoverPending };
}

export type DuplicateProjectConsolidationService = ReturnType<typeof createDuplicateProjectConsolidationService>;
