import { createHash, randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFile, realpath, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { isSameAgentNativeConversationSessionIdentity } from "../commands/hook-events/agent-native-conversation-session-identity-extraction";
import { preservePersistedAgentWorkProgressEntriesAgainstStaleSnapshot } from "../core/agent-work-progress";
import {
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeGitBranch,
	type RuntimeGitRepositoryInfo,
	type RuntimeTaskSessionSummary,
	type RuntimeWorkspaceStateResponse,
	type RuntimeWorkspaceStateSaveRequest,
	runtimeBoardDataSchema,
	runtimeTaskSessionSummarySchema,
	runtimeWorkspaceStateSaveRequestSchema,
} from "../core/api-contract";
import { preserveRuntimeOnlySessionFieldsFromSameGeneration } from "../core/browser-task-session-summary-projection";
import {
	applySessionFacets,
	isNeverStartedPlaceholderTaskSessionSummary,
	mergeSummaryWithFacets,
	resolveSessionFacets,
} from "../core/session-activity";
import { getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import { preserveRuntimeOwnedTaskClosureState } from "../core/task-closure-protected-board-state";
import {
	preserveRuntimeOwnedMainSessionBindings,
	projectTaskConversationSessionsForMainSessionBinding,
} from "../core/task-main-conversation-session-binding";
import { preserveTaskNameVersionsAgainstIncomingBoardSnapshot } from "../core/task-name-version";
import { preservePersistedTaskShelvingAgainstIncomingBoardSnapshot } from "../core/task-shelving-state";
import { preservePersistedTaskStickerEntriesAgainstIncomingBoardSnapshot } from "../core/task-sticker-entry-mutation";
import {
	measureDailyWorkProgressSynchronousStage,
	readUtf8FileWithDailyWorkProgressCostObservation,
} from "../diagnostics/daily-work-progress-collection-cost-recorder";
import { logFileLockError, logFileLockWarning } from "../fs/lock-diagnostics-logger";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { workspaceMetadataGitSpawnConcurrencyLimiter } from "../workspace/git-concurrency";
import { runGit } from "../workspace/git-utils";
import {
	assertNoTransferredTaskIsReintroducedByStaleBoardSnapshot,
	hasBoardSnapshotRemovedTaskTransferredIntoWorkspace,
} from "./backlog-task-project-transfer";
import {
	findConsolidatedRepositoryPath,
	readDuplicateProjectConsolidationStatus,
	resolveConsolidatedWorkspaceId,
} from "./duplicate-project-consolidation-status";
import { createParsedPersistedJsonFileReadCache } from "./parsed-persisted-json-file-read-cache";

import { getRuntimeHomePath } from "./runtime-home-path";
import {
	logTaskSessionSummariesOwnedByOtherWorkspacesRemovedBeforeWrite,
	removeTaskSessionSummariesOwnedByOtherWorkspaces,
	type TaskSessionSummariesOwnedByOtherWorkspacesRemoval,
} from "./task-session-summaries-owned-by-other-workspaces-removal";
import {
	getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	type TaskMutationIntentWithResolvedActor,
} from "./workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	logWorkspaceStatePostDeployVerificationDoneEntryGuardRevertedCards,
	revertCardsNewlyEnteringDoneWithoutPostDeployVerificationClosure,
} from "./workspace-board-save-state-post-deploy-verification-done-entry-guard-port";

import {
	createWorkspaceStateSnapshotCommit,
	projectWorkspaceStateSnapshotCommitWithinLock,
	readWorkspaceSnapshotFileText,
	readWorkspaceStateSnapshotCommit,
	readWorkspaceStateSnapshotReadFingerprint,
	WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME,
	type WorkspaceStateSnapshotCommit,
	type WorkspaceStateSnapshotMeta,
	workspaceStateSnapshotMetaSchema,
	writeWorkspaceStateSnapshotCommitDurably,
} from "./workspace-state-snapshot-storage";

const RUNTIME_HOME_PARENT_DIR = ".cline";

const RUNTIME_WORKTREES_DIR = "worktrees";
const WORKSPACES_DIR = "workspaces";
const INDEX_FILENAME = "index.json";
const BOARD_FILENAME = "board.json";
const SESSIONS_FILENAME = "sessions.json";
const META_FILENAME = "meta.json";
const INDEX_VERSION = 1;
const WORKSPACE_ID_COLLISION_SUFFIX_LENGTH = 4;

const BOARD_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "validation", title: "Validation" },
	{ id: "trash", title: "已结案" },
];

interface WorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

export interface RuntimeWorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

export interface PersistedWorkspaceStateById {
	workspaceId: string;
	statePath: string;
	board: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	revision: number;
}

interface WorkspaceIndexFile {
	version: number;
	entries: Record<string, WorkspaceIndexEntry>;
	repoPathToId: Record<string, string>;
}

type WorkspaceStateMeta = WorkspaceStateSnapshotMeta;
const workspaceStateMetaSchema = workspaceStateSnapshotMetaSchema;

const workspaceIndexEntrySchema = z.object({
	workspaceId: z.string().min(1, "Workspace ID cannot be empty."),
	repoPath: z.string().min(1, "Workspace repository path cannot be empty."),
});

const workspaceIndexFileSchema = z
	.object({
		version: z.literal(INDEX_VERSION),
		entries: z.record(z.string(), workspaceIndexEntrySchema),
		repoPathToId: z.record(z.string(), z.string().min(1, "Workspace ID cannot be empty.")),
	})
	.superRefine((index, context) => {
		for (const [workspaceId, entry] of Object.entries(index.entries)) {
			if (entry.workspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "workspaceId"],
					message: `Workspace ID must match entry key "${workspaceId}".`,
				});
			}
			const mappedWorkspaceId = index.repoPathToId[entry.repoPath];
			if (mappedWorkspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "repoPath"],
					message: `Missing repoPathToId mapping for "${entry.repoPath}" to "${workspaceId}".`,
				});
			}
		}

		for (const [repoPath, workspaceId] of Object.entries(index.repoPathToId)) {
			const entry = index.entries[workspaceId];
			if (!entry) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped workspace "${workspaceId}" does not exist in entries.`,
				});
				continue;
			}
			if (entry.repoPath !== repoPath) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped repoPath does not match workspace entry path "${entry.repoPath}".`,
				});
			}
		}
	});

const workspaceSessionsSchema = z
	.record(z.string(), runtimeTaskSessionSummarySchema)
	.superRefine((sessions, context) => {
		for (const [taskId, session] of Object.entries(sessions)) {
			if (session.taskId !== taskId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [taskId, "taskId"],
					message: `Session taskId must match record key "${taskId}".`,
				});
			}
		}
	});

export interface RuntimeWorkspaceContext {
	repoPath: string;
	workspaceId: string;
	statePath: string;
	git: RuntimeGitRepositoryInfo;
}

export interface LoadWorkspaceContextOptions {
	autoCreateIfMissing?: boolean;
}

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: BOARD_COLUMNS.map((column) => ({
			id: column.id,
			title: column.title,
			cards: [],
		})),
	};
}

// Backfills/reorders board columns to match the canonical BOARD_COLUMNS list so that
// legacy persisted boards (e.g. the pre-Validation 4-column layout) gain any newly
// introduced column as an empty column without losing existing cards. The board schema
// only admits known column ids, so mapping over BOARD_COLUMNS captures every existing
// column; missing ones are inserted empty and column order is normalized.
function reconcileBoardColumns(board: RuntimeBoardData): RuntimeBoardData {
	const existingColumnsById = new Map(board.columns.map((column) => [column.id, column]));
	let columnsChanged = board.columns.length !== BOARD_COLUMNS.length;
	const reconciledColumns = BOARD_COLUMNS.map((expectedColumn, expectedIndex) => {
		const existingColumn = existingColumnsById.get(expectedColumn.id);
		if (!existingColumn) {
			columnsChanged = true;
			return { id: expectedColumn.id, title: expectedColumn.title, cards: [] };
		}
		if (board.columns[expectedIndex]?.id !== expectedColumn.id) {
			columnsChanged = true;
		}
		if (existingColumn.id === "trash" && existingColumn.title !== "已结案") {
			columnsChanged = true;
			return { ...existingColumn, title: "已结案" };
		}
		return existingColumn;
	});
	if (!columnsChanged) {
		return board;
	}
	return { ...board, columns: reconciledColumns };
}

function createEmptyWorkspaceIndex(): WorkspaceIndexFile {
	return {
		version: INDEX_VERSION,
		entries: {},
		repoPathToId: {},
	};
}

export { getRuntimeHomePath } from "./runtime-home-path";

export function getTaskWorktreesHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_WORKTREES_DIR);
}

export function getWorkspacesRootPath(): string {
	return join(getRuntimeHomePath(), WORKSPACES_DIR);
}

function getWorkspaceIndexPath(): string {
	return join(getWorkspacesRootPath(), INDEX_FILENAME);
}

export function getWorkspaceDirectoryPath(workspaceId: string): string {
	return join(getWorkspacesRootPath(), workspaceId);
}

export function getPersistedWorkspaceBoardFilePathById(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), BOARD_FILENAME);
}

function getWorkspaceSessionsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), SESSIONS_FILENAME);
}

function getWorkspaceMetaPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), META_FILENAME);
}

function getWorkspaceIndexLockRequest(): LockRequest {
	return {
		path: getWorkspaceIndexPath(),
		type: "file",
	};
}

export function getWorkspaceDirectoryLockRequest(workspaceId: string): LockRequest {
	return {
		path: getWorkspaceDirectoryPath(workspaceId),
		type: "directory",
		lockfilePath: join(getWorkspacesRootPath(), `${workspaceId}.lock`),
	};
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function readJsonFile(path: string, options: { requireCompleteRead?: boolean } = {}): Promise<unknown | null> {
	try {
		const raw = await readUtf8FileWithDailyWorkProgressCostObservation(path);
		let parsed: unknown;
		try {
			parsed = measureDailyWorkProgressSynchronousStage("workspace_json_parse", () => JSON.parse(raw) as unknown);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
		// 严格查询必须区分已存在的 null 正文与尚未建立的文件；宽松读取保留旧版空值兼容。
		if (options.requireCompleteRead && parsed === null) {
			throw new Error(`JSON 文件 ${path} 的正文不能为 null。`);
		}
		return parsed;
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read JSON file at ${path}. ${message}`);
	}
}

function formatSchemaIssuePath(pathSegments: PropertyKey[]): string {
	if (pathSegments.length === 0) {
		return "root";
	}
	return pathSegments
		.map((segment) => {
			if (typeof segment === "number") {
				return `[${segment}]`;
			}
			return String(segment);
		})
		.join(".");
}

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${formatSchemaIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

function parsePersistedStateFile<T>(
	filePath: string,
	fileLabel: string,
	raw: unknown | null,
	schema: z.ZodType<T>,
	defaultValue: T,
): T {
	if (raw === null) {
		return defaultValue;
	}
	const parsed = measureDailyWorkProgressSynchronousStage("workspace_schema_validation", () => schema.safeParse(raw));
	if (!parsed.success) {
		throw new Error(
			`Invalid ${fileLabel} file at ${filePath}. ` +
				`Fix or remove the file. Validation errors: ${formatSchemaIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

function parseWorkspaceIndex(rawIndex: unknown | null): WorkspaceIndexFile {
	const indexPath = getWorkspaceIndexPath();
	return parsePersistedStateFile(
		indexPath,
		INDEX_FILENAME,
		rawIndex,
		workspaceIndexFileSchema,
		createEmptyWorkspaceIndex(),
	);
}

function parseWorkspaceStateSavePayload(payload: RuntimeWorkspaceStateSaveRequest): RuntimeWorkspaceStateSaveRequest {
	const parsed = runtimeWorkspaceStateSaveRequestSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`Invalid workspace state save payload. ${formatSchemaIssues(parsed.error)}`);
	}
	return parsed.data;
}

function reconcileIncomingBoardToPreventStartedTasksFromReenteringBacklog(
	persistedBoard: RuntimeBoardData,
	incomingBoard: RuntimeBoardData,
	reconciledSessions: Record<string, RuntimeTaskSessionSummary>,
): RuntimeBoardData {
	let reconciledBoard = reconcileBoardColumns(incomingBoard);
	const incomingBacklogTaskIds =
		reconciledBoard.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];

	for (const taskId of incomingBacklogTaskIds) {
		const persistedColumnId = getTaskColumnId(persistedBoard, taskId);
		const taskHasStartedSession = reconciledSessions[taskId]?.startedAt != null;
		const targetColumnId =
			persistedColumnId && persistedColumnId !== "backlog"
				? persistedColumnId
				: taskHasStartedSession
					? "in_progress"
					: null;
		if (!targetColumnId) {
			continue;
		}
		const moved = moveTaskToColumn(reconciledBoard, taskId, targetColumnId);
		if (moved.moved) {
			reconciledBoard = moved.board;
		}
	}

	return reconciledBoard;
}

function preservePersistedStartedTaskSessionsMissingFromIncomingSnapshot(
	incomingBoard: RuntimeBoardData,
	persistedSessions: Record<string, RuntimeTaskSessionSummary>,
	incomingSessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	let reconciledSessions = incomingSessions;
	for (const column of incomingBoard.columns) {
		for (const card of column.cards) {
			for (const persistedSession of Object.values(persistedSessions)) {
				const sessionId = persistedSession.taskId;
				const belongs =
					sessionId === card.id || persistedSession.taskConversationSessionMetadata?.workspaceTaskId === card.id;
				const isBoundMain = sessionId === card.mainTaskConversationSessionId;
				if (!belongs || incomingSessions[sessionId] || (persistedSession.startedAt == null && !isBoundMain))
					continue;
				if (reconciledSessions === incomingSessions) reconciledSessions = { ...incomingSessions };
				reconciledSessions[sessionId] = persistedSession;
			}
		}
	}
	return reconciledSessions;
}

// 上面那条守卫只挡「incoming 里整条不见了」；本条挡的是更隐蔽的一种——**incoming 里在，但是一条空壳**。
//
// 硬中断后前端一聚焦卡片，服务端就会就地造出一条全 null 的默认 summary（session-manager 的
// `ensureEntry` → `createDefaultSummary`）。它带着最新的 updatedAt 一路广播、并被下一次 saveState 并进
// 落盘 payload；没有这条守卫，它就会把盘上那条记着 agentId / startedAt 的真实记录整条盖掉，把一次
// 「本来重启就能自愈」的中断变成永久损坏。
//
// 只在「persisted 不是空壳」时保留——两边都是空壳时留谁都一样，放行 incoming 免得把陈旧 updatedAt 钉住。
function preservePersistedTaskSessionFactsAgainstStaleSnapshots(
	persistedSessions: Record<string, RuntimeTaskSessionSummary>,
	incomingSessions: Record<string, RuntimeTaskSessionSummary>,
	preserveRuntimeOwnedSessionControlFactsAgainstIncomingSnapshot = false,
): Record<string, RuntimeTaskSessionSummary> {
	let reconciledSessions = incomingSessions;
	for (const [taskId, incomingSummary] of Object.entries(incomingSessions)) {
		const persistedSummary = persistedSessions[taskId];
		if (!persistedSummary) continue;
		let reconciledSummary = preserveRuntimeOwnedSessionControlFactsAgainstIncomingSnapshot
			? preserveRuntimeOnlySessionFieldsFromSameGeneration(persistedSummary, incomingSummary)
			: incomingSummary;
		const persistedReviewReceipt = persistedSummary.lastAppliedHookReviewLifecycleEventDelivery;
		const incomingReviewReceipt = incomingSummary.lastAppliedHookReviewLifecycleEventDelivery;
		if (
			persistedSummary.runtimeSessionIncarnationId === incomingSummary.runtimeSessionIncarnationId &&
			persistedReviewReceipt &&
			(preserveRuntimeOwnedSessionControlFactsAgainstIncomingSnapshot ||
				!incomingReviewReceipt ||
				persistedReviewReceipt.capturedAtEpochMs > incomingReviewReceipt.capturedAtEpochMs ||
				(persistedSummary.agentResponseGenerationTurnSequence ?? 0) >
					(incomingSummary.agentResponseGenerationTurnSequence ?? 0))
		) {
			reconciledSummary = {
				...reconciledSummary,
				lastAppliedHookReviewLifecycleEventDelivery: persistedReviewReceipt,
			};
			if (
				incomingReviewReceipt?.deliveryIdempotencyKey !== persistedReviewReceipt.deliveryIdempotencyKey &&
				(incomingSummary.agentResponseGenerationTurnSequence ?? 0) <=
					(persistedSummary.agentResponseGenerationTurnSequence ?? 0) &&
				(incomingSummary.agentConversationPromptSubmissionAcceptance?.attemptedAtMs ?? 0) <=
					persistedReviewReceipt.capturedAtEpochMs
			) {
				reconciledSummary = mergeSummaryWithFacets(reconciledSummary, {
					...resolveSessionFacets(persistedSummary),
					reviewReason: persistedSummary.reviewReason,
					lastAgentConversationUserHandoffObservation:
						persistedSummary.lastAgentConversationUserHandoffObservation,
					currentAgentProcessUserTurnIdleRetentionStarted:
						persistedSummary.currentAgentProcessUserTurnIdleRetentionStarted,
				});
			}
		}
		if (
			isNeverStartedPlaceholderTaskSessionSummary(incomingSummary) &&
			!isNeverStartedPlaceholderTaskSessionSummary(persistedSummary)
		) {
			reconciledSummary = persistedSummary;
		} else {
			// hook 已确认落盘后，延迟到达的整份 UI 快照不能撤销较新的原生身份。
			const persistedIdentity = persistedSummary.agentNativeConversationSessionIdentity;
			const incomingIdentity = incomingSummary.agentNativeConversationSessionIdentity;
			if (
				persistedIdentity &&
				incomingSummary.agentId === persistedSummary.agentId &&
				(!incomingIdentity || persistedIdentity.observedAt > incomingIdentity.observedAt)
			) {
				reconciledSummary = { ...reconciledSummary, agentNativeConversationSessionIdentity: persistedIdentity };
			}
		}
		if (
			preserveRuntimeOwnedSessionControlFactsAgainstIncomingSnapshot &&
			persistedSummary.codexNativeDirectInputReadinessReconciliation !== undefined &&
			persistedSummary.agentId === reconciledSummary.agentId &&
			persistedSummary.runtimeSessionIncarnationId === reconciledSummary.runtimeSessionIncarnationId
		) {
			// 补证预算属于运行时；旧 bundle 的整板保存不能删除预算或复活已清除的预算。
			reconciledSummary = {
				...reconciledSummary,
				codexNativeDirectInputReadinessReconciliation:
					persistedSummary.codexNativeDirectInputReadinessReconciliation,
			};
		}
		if (
			preserveRuntimeOwnedSessionControlFactsAgainstIncomingSnapshot &&
			persistedSummary.taskConversationSessionMetadata?.taskConversationSessionRoleAtCreation
		) {
			// 旧 bundle 不认识新的角色与恢复快照；整板保存不能删除运行时已经确认的会话归属。
			reconciledSummary = {
				...reconciledSummary,
				taskConversationSessionMetadata: persistedSummary.taskConversationSessionMetadata,
			};
		}
		const persistedName = persistedSummary.taskConversationSessionMetadata;
		if (
			persistedName &&
			(persistedName.conversationSessionNameVersion ?? 0) >
				(reconciledSummary.taskConversationSessionMetadata?.conversationSessionNameVersion ?? 0)
		)
			reconciledSummary = {
				...reconciledSummary,
				taskConversationSessionMetadata: {
					...(reconciledSummary.taskConversationSessionMetadata ?? persistedName),
					conversationSessionName: persistedName.conversationSessionName,
					conversationSessionNameVersion: persistedName.conversationSessionNameVersion,
					conversationSessionNameSource: persistedName.conversationSessionNameSource,
				},
			};
		if (persistedSummary.agentWorkProgressEntries?.length)
			reconciledSummary = {
				...reconciledSummary,
				agentWorkProgressEntries: preservePersistedAgentWorkProgressEntriesAgainstStaleSnapshot(
					persistedSummary.agentWorkProgressEntries,
					reconciledSummary.agentWorkProgressEntries,
				),
			};
		if (reconciledSummary === incomingSummary) continue;
		if (reconciledSessions === incomingSessions) reconciledSessions = { ...incomingSessions };
		reconciledSessions[taskId] = reconciledSummary;
	}
	return reconciledSessions;
}

async function readWorkspaceBoard(
	workspaceId: string,
	options: { requireCompleteRead?: boolean } = {},
): Promise<RuntimeBoardData> {
	const boardPath = getPersistedWorkspaceBoardFilePathById(workspaceId);
	const rawBoard = await readJsonFile(boardPath, options);
	// 旧盘里已退役的 `dependencies` 键由 runtimeBoardDataSchema（非 strict）在解析时静默剥离。
	return reconcileBoardColumns(
		parsePersistedStateFile(boardPath, BOARD_FILENAME, rawBoard, runtimeBoardDataSchema, createEmptyBoard()),
	);
}

export async function loadWorkspaceBoardById(
	workspaceId: string,
	options: { requireCompleteRead?: boolean } = {},
): Promise<RuntimeBoardData> {
	return await readConsistentWorkspaceStateProjection(
		workspaceId,
		() => readWorkspaceBoard(workspaceId, options),
		(snapshot) => parseWorkspaceSnapshotBoard(workspaceId, snapshot, options),
	);
}

// Stage 2 读时回填：对「三 facet 全缺」的旧盘 per-session 即时经 applySessionFacets 从 legacy
// state 派生自洽 facet + 盖 schemaVersion；已带 facet 的 session 原样保留（绝不 clobber——未来源头
// 权威信号如 starting/userTurnKind 细分须保真）。纯内存变换、读路径无副作用：回填结果随下一次正常
// save 落盘（比照 reconcileBoardColumns 的 backfill-on-read / persist-on-next-save 模式，不在读时触发
// 写盘 / 抬 revision）。superRefine 在加载边界已保证：facet 若存在必三者共生，故仅判 turnOwner 即可。
function backfillSessionFacets(
	sessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	let changed = false;
	const next: Record<string, RuntimeTaskSessionSummary> = {};
	for (const [taskId, summary] of Object.entries(sessions)) {
		const hasFacets =
			summary.turnOwner !== undefined && summary.liveness !== undefined && summary.userTurnKind !== undefined;
		if (hasFacets) {
			next[taskId] = summary;
			continue;
		}
		next[taskId] = applySessionFacets(summary);
		changed = true;
	}
	return changed ? next : sessions;
}

async function readWorkspaceSessions(
	workspaceId: string,
	options: { requireCompleteRead?: boolean } = {},
): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const sessionsPath = getWorkspaceSessionsPath(workspaceId);
	const rawSessions = await readJsonFile(sessionsPath, options);
	const parsed = parsePersistedStateFile(sessionsPath, SESSIONS_FILENAME, rawSessions, workspaceSessionsSchema, {});
	return backfillSessionFacets(parsed);
}

async function readWorkspaceMeta(workspaceId: string): Promise<WorkspaceStateMeta> {
	const metaPath = getWorkspaceMetaPath(workspaceId);
	const rawMeta = await readJsonFile(metaPath);
	return parsePersistedStateFile(metaPath, META_FILENAME, rawMeta, workspaceStateMetaSchema, {
		revision: 0,
		updatedAt: 0,
	});
}

async function readWorkspaceIndex(options: { requireCompleteRead?: boolean } = {}): Promise<WorkspaceIndexFile> {
	const raw = await readJsonFile(getWorkspaceIndexPath(), options);
	return parseWorkspaceIndex(raw);
}

async function writeWorkspaceIndex(index: WorkspaceIndexFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceIndexPath(), index, {
		lock: null,
	});
}

function toWorkspaceIdBase(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folderName = basename(trimmed) || "project";
	const normalized = folderName
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "project";
}

function createWorkspaceIdCollisionSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	while (suffix.length < length) {
		const bytes = randomBytes(length);
		for (const byte of bytes) {
			suffix += alphabet[byte % alphabet.length] ?? "";
			if (suffix.length === length) {
				break;
			}
		}
	}
	return suffix;
}

function createWorkspaceId(index: WorkspaceIndexFile, repoPath: string): string {
	const baseId = toWorkspaceIdBase(repoPath);
	if (!index.entries[baseId] || index.entries[baseId]?.repoPath === repoPath) {
		return baseId;
	}

	for (let attempt = 0; attempt < 256; attempt += 1) {
		const candidate = `${baseId}-${createWorkspaceIdCollisionSuffix(WORKSPACE_ID_COLLISION_SUFFIX_LENGTH)}`;
		if (!index.entries[candidate] || index.entries[candidate]?.repoPath === repoPath) {
			return candidate;
		}
	}

	throw new Error(`Could not generate a unique workspace ID for ${repoPath}.`);
}

function ensureWorkspaceEntry(
	index: WorkspaceIndexFile,
	repoPath: string,
): { index: WorkspaceIndexFile; entry: WorkspaceIndexEntry; changed: boolean } {
	const existingWorkspaceId = index.repoPathToId[repoPath];
	if (existingWorkspaceId) {
		const existingEntry = index.entries[existingWorkspaceId];
		if (existingEntry && existingEntry.repoPath === repoPath) {
			return {
				index,
				entry: existingEntry,
				changed: false,
			};
		}
	}

	const workspaceId = createWorkspaceId(index, repoPath);

	const entry: WorkspaceIndexEntry = {
		workspaceId,
		repoPath,
	};

	return {
		index: {
			version: INDEX_VERSION,
			entries: {
				...index.entries,
				[workspaceId]: entry,
			},
			repoPathToId: {
				...index.repoPathToId,
				[repoPath]: workspaceId,
			},
		},
		entry,
		changed: true,
	};
}

function findWorkspaceEntry(index: WorkspaceIndexFile, repoPath: string): WorkspaceIndexEntry | null {
	const workspaceId = index.repoPathToId[repoPath];
	if (!workspaceId) {
		return null;
	}
	const entry = index.entries[workspaceId];
	if (!entry || entry.repoPath !== repoPath) {
		return null;
	}
	return entry;
}

const workspaceContextGitProbeConcurrencyWaitObservationChannel = channel(
	"cline-kanban.workspace-context-git-probe-concurrency-wait",
);
async function runGitCapture(cwd: string, args: string[]): Promise<string | null> {
	const queuedAtMs = workspaceContextGitProbeConcurrencyWaitObservationChannel.hasSubscribers
		? performance.now()
		: null;
	const result = await workspaceMetadataGitSpawnConcurrencyLimiter(() => {
		if (queuedAtMs !== null)
			workspaceContextGitProbeConcurrencyWaitObservationChannel.publish({
				waitDurationMs: performance.now() - queuedAtMs,
			});
		return runGit(cwd, args);
	});
	if (!result.ok) {
		return null;
	}
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

async function detectGitRoot(cwd: string): Promise<string | null> {
	return await runGitCapture(cwd, ["rev-parse", "--show-toplevel"]);
}

async function detectGitCurrentBranch(repoPath: string): Promise<string | null> {
	return await runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

async function detectGitBranches(repoPath: string): Promise<RuntimeGitBranch[]> {
	// TODO: support showing remote branches again once worktree creation can safely fetch/pull
	// and resolve missing local tracking branches automatically.
	const output = await runGitCapture(repoPath, [
		"for-each-ref",
		"--sort=-committerdate",
		"--format=%(refname:short)%09%(committerdate:iso-strict)",
		"refs/heads",
	]);
	if (!output) {
		return [];
	}

	const unique = new Set<string>();
	const branches: RuntimeGitBranch[] = [];
	for (const line of output.split("\n")) {
		const [rawName, rawLastCommitDate] = line.split("\t");
		const name = rawName?.trim() ?? "";
		if (!name || name === "HEAD" || unique.has(name)) {
			continue;
		}
		unique.add(name);
		const lastCommitDate = rawLastCommitDate?.trim();
		branches.push(lastCommitDate ? { name, lastCommitDate } : { name });
	}
	return branches;
}

async function detectGitDefaultBranch(repoPath: string, branchNames: string[]): Promise<string | null> {
	const remoteHead = await runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remoteHead) {
		const normalized = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
		if (normalized) {
			return normalized;
		}
	}
	if (branchNames.includes("main")) {
		return "main";
	}
	if (branchNames.includes("master")) {
		return "master";
	}
	return branchNames[0] ?? null;
}

// 导出是给 `kanban task create --preview` 用的：预览必须在**不注册项目**的前提下也能说清 base ref
// 会怎么解析，而 loadWorkspaceContext 的 autoCreateIfMissing 路径会写工作区索引。
export async function detectGitRepositoryInfo(repoPath: string): Promise<RuntimeGitRepositoryInfo> {
	const gitRoot = await detectGitRoot(repoPath);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${repoPath}`);
	}

	const currentBranch = await detectGitCurrentBranch(repoPath);
	const branches = await detectGitBranches(repoPath);
	const branchNames = branches.map((branch) => branch.name);
	const orderedBranches =
		currentBranch && !branchNames.includes(currentBranch) ? [{ name: currentBranch }, ...branches] : branches;
	const defaultBranch = await detectGitDefaultBranch(
		repoPath,
		orderedBranches.map((branch) => branch.name),
	);

	return {
		currentBranch,
		defaultBranch,
		branches: orderedBranches,
	};
}

// 同 detectGitRepositoryInfo：只读预览要先把「哪个目录是仓库根」解析出来，且不能顺带注册项目。
export async function resolveWorkspacePath(cwd: string): Promise<string> {
	const resolvedCwd = resolve(cwd);
	let canonicalCwd = resolvedCwd;
	try {
		canonicalCwd = await realpath(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	const gitRoot = await detectGitRoot(canonicalCwd);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${canonicalCwd}`);
	}

	const resolvedGitRoot = resolve(gitRoot);
	try {
		return await realpath(resolvedGitRoot);
	} catch {
		return resolvedGitRoot;
	}
}

function toWorkspaceStateResponse(
	context: RuntimeWorkspaceContext,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	revision: number,
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: context.repoPath,
		statePath: context.statePath,
		git: context.git,
		board,
		sessions: projectTaskConversationSessionsForMainSessionBinding(board, sessions),
		revision,
	};
}

export class WorkspaceStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(expectedRevision: number | undefined, currentRevision: number) {
		super(
			expectedRevision === undefined
				? "未携带看板版本的整板快照不能删除迁入任务，请刷新看板后重试。"
				: `Workspace state revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`,
		);
		this.name = "WorkspaceStateConflictError";
		this.currentRevision = currentRevision;
	}
}

export async function loadWorkspaceContext(
	cwd: string,
	options: LoadWorkspaceContextOptions = {},
): Promise<RuntimeWorkspaceContext> {
	const repoPath = await resolveWorkspacePath(cwd);
	const retiredRepository = await findConsolidatedRepositoryPath(repoPath);
	if (retiredRepository) {
		if (retiredRepository.status !== "completed") throw new Error("来源项目正在合并，写入已冻结。");
		const target = await loadWorkspaceContextById(retiredRepository.targetWorkspaceId);
		if (!target) throw new Error("合并目标尚不可用，请等待恢复。");
		return target;
	}
	const autoCreateIfMissing = options.autoCreateIfMissing ?? true;
	const registeredEntry = findWorkspaceEntry(await readWorkspaceIndex(), repoPath);
	if (registeredEntry || !autoCreateIfMissing) {
		const existingEntry = registeredEntry;
		if (!existingEntry) {
			throw new Error(`Project ${repoPath} is not added to Kanban yet.`);
		}
		return {
			repoPath,
			workspaceId: existingEntry.workspaceId,
			statePath: getWorkspaceDirectoryPath(existingEntry.workspaceId),
			git: await detectGitRepositoryInfo(repoPath),
		};
	}

	const ensuredWorkspaceId = await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		let index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		const ensured = existingEntry
			? { index, entry: existingEntry, changed: false }
			: ensureWorkspaceEntry(index, repoPath);
		index = ensured.index;
		if (ensured.changed) {
			await writeWorkspaceIndex(index);
		}
		return ensured.entry.workspaceId;
	});

	// git 探测刻意放在全局 index 锁**之外**：它与 index 无关；放在锁里会把
	// 高负载下被放大的 git 耗时整段算进持锁时间，所有项目的
	// ensureWorktree / startTaskSession / saveState 都在这把锁上排队，等太久就抛 ELOCKED。
	// 抛错时机不变：index 条目照旧先写入，再因非 git 目录抛出。
	return {
		repoPath,
		workspaceId: ensuredWorkspaceId,
		statePath: getWorkspaceDirectoryPath(ensuredWorkspaceId),
		git: await detectGitRepositoryInfo(repoPath),
	};
}

const registeredWorkspaceIndexReadCache = createParsedPersistedJsonFileReadCache<WorkspaceIndexFile>();

// 请求路由只需要已登记身份与路径；分支和提交信息由真正的 Git 操作显式读取。
// .git 可以是主仓目录或 worktree 指针文件；索引写入和持锁校验不使用缓存。
export async function resolveRegisteredWorkspaceScopeByIdWithoutGitProbe(
	workspaceId: string,
): Promise<RuntimeWorkspaceIndexEntry | null> {
	const index = await registeredWorkspaceIndexReadCache.read(getWorkspaceIndexPath(), readWorkspaceIndex);
	const entry = index.entries[await resolveConsolidatedWorkspaceId(workspaceId)];
	if (!entry) return null;
	try {
		const directory = await stat(entry.repoPath);
		if (!directory.isDirectory()) return null;
		await stat(join(entry.repoPath, ".git"));
	} catch {
		return null;
	}
	return { workspaceId: entry.workspaceId, repoPath: entry.repoPath };
}

export async function loadWorkspaceContextById(workspaceId: string): Promise<RuntimeWorkspaceContext | null> {
	workspaceId = await resolveConsolidatedWorkspaceId(workspaceId);
	const index = await readWorkspaceIndex();
	const entry = index.entries[workspaceId];
	if (!entry) {
		return null;
	}
	try {
		return await loadWorkspaceContext(entry.repoPath);
	} catch {
		return null;
	}
}

export async function listWorkspaceIndexEntries(
	options: { requireCompleteRead?: boolean } = {},
): Promise<RuntimeWorkspaceIndexEntry[]> {
	const index = await readWorkspaceIndex(options);
	return Object.values(index.entries)
		.map((entry) => ({
			workspaceId: entry.workspaceId,
			repoPath: entry.repoPath,
		}))
		.sort((left, right) => left.repoPath.localeCompare(right.repoPath));
}

export async function removeWorkspaceIndexEntry(workspaceId: string): Promise<boolean> {
	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();
		const entry = index.entries[workspaceId];
		if (!entry) {
			return false;
		}
		delete index.entries[workspaceId];
		delete index.repoPathToId[entry.repoPath];
		await writeWorkspaceIndex(index);
		return true;
	});
}

/** 只读操作与 board 写入共用锁；回调完成前不释放，避免校验后到外部持久提交之间被改写。 */
export async function readWorkspaceBoardByIdAndRunWithBoardLockHeld<T>(
	workspaceId: string,
	readAndRunWithBoardLockHeld: (board: RuntimeBoardData) => Promise<T>,
): Promise<T> {
	const context = await loadWorkspaceContextById(workspaceId);
	if (!context) throw new Error(`找不到项目 ${workspaceId}。`);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(workspaceId), async () => {
		const { board, sessions, meta } = await prepareWorkspaceStateSnapshotForWriteWithinLock(workspaceId);
		await reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(context, board, sessions, meta.revision);
		return await readAndRunWithBoardLockHeld(board);
	});
}

export async function loadPersistedWorkspaceStateById(workspaceId: string): Promise<PersistedWorkspaceStateById> {
	const { board, sessions, meta } = await readConsistentWorkspaceStateSnapshot(workspaceId);
	return {
		workspaceId,
		statePath: getWorkspaceDirectoryPath(workspaceId),
		board,
		sessions: projectTaskConversationSessionsForMainSessionBinding(board, sessions),
		revision: meta.revision,
	};
}

export function getPersistedWorkspaceSessionsFilePathById(workspaceId: string): string {
	return getWorkspaceSessionsPath(workspaceId);
}

export async function getWorkspaceStateSnapshotReadFingerprintById(workspaceId: string): Promise<string> {
	return await readWorkspaceStateSnapshotReadFingerprint(getWorkspaceDirectoryPath(workspaceId));
}

export async function loadPersistedWorkspaceSessionsJsonTextById(workspaceId: string): Promise<string | null> {
	return await readConsistentWorkspaceStateProjection(
		workspaceId,
		() => readWorkspaceSnapshotFileText(getWorkspaceSessionsPath(workspaceId)),
		(snapshot) => snapshot.sessionsJsonText,
	);
}

export async function loadPersistedWorkspaceSessionsById(
	workspaceId: string,
	options: { requireCompleteRead?: boolean } = {},
): Promise<Record<string, RuntimeTaskSessionSummary>> {
	return await readConsistentWorkspaceStateProjection(
		workspaceId,
		() => readWorkspaceSessions(workspaceId, options),
		(snapshot) => parseWorkspaceSnapshotSessions(workspaceId, snapshot, options),
	);
}

export async function savePersistedWorkspaceSessionsById(
	workspaceId: string,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	expectedRevision: number,
): Promise<number> {
	const parsedSessions = workspaceSessionsSchema.safeParse(sessions);
	if (!parsedSessions.success) {
		throw new Error(`Invalid workspace sessions payload. ${formatSchemaIssues(parsedSessions.error)}`);
	}
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(workspaceId), async () => {
		const consolidation = await readDuplicateProjectConsolidationStatus(workspaceId);
		if (consolidation && consolidation.status !== "quiescing") throw new Error("来源项目的会话写入已冻结。");
		const { board, meta } = await prepareWorkspaceStateSnapshotForWriteWithinLock(workspaceId);
		if (meta.revision !== expectedRevision) throw new WorkspaceStateConflictError(expectedRevision, meta.revision);
		const nextRevision = meta.revision + 1;
		await commitWorkspaceStateSnapshotWithinLock(
			workspaceId,
			board,
			parsedSessions.data,
			{ revision: nextRevision, updatedAt: Date.now() },
			{ boardJsonText: await readWorkspaceBoardFileRawText(workspaceId) },
		);
		return nextRevision;
	});
}

// 只有第一种结果推进了 meta.revision（调用方据此决定是否广播整份 workspace 快照）。
export type AgentNativeConversationSessionIdentityPersistenceOutcome =
	| "persisted_new_identity_and_invalidated_stale_snapshot_revision"
	| "persisted_reconfirmed_identity_observation_time_without_revision_change"
	| "already_persisted_without_write";

export async function persistHookReviewLifecycleApplicationInWorkspaceSnapshot(input: {
	workspaceId: string;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
	deliveryIdempotencyKey: string;
	runtimeSessionIncarnationId: string;
	readCurrentSummary: () => RuntimeTaskSessionSummary | null;
}): Promise<void> {
	await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(input.workspaceId), async () => {
		const { board, sessions, meta } = await prepareWorkspaceStateSnapshotForWriteWithinLock(input.workspaceId);
		const current = input.readCurrentSummary();
		const card = board.columns
			.flatMap((column) => column.cards)
			.find((entry) => entry.id === (current?.taskConversationSessionMetadata?.workspaceTaskId ?? input.taskId));
		if (card?.createdAt !== input.taskIncarnationCreatedAtEpochMs)
			throw new Error("生命周期应用确认的任务代际已变化。");
		const hasReceipt = (summary: RuntimeTaskSessionSummary | null | undefined) =>
			summary?.lastAppliedHookReviewLifecycleEventDelivery?.deliveryIdempotencyKey ===
				input.deliveryIdempotencyKey &&
			summary.lastAppliedHookReviewLifecycleEventDelivery.runtimeSessionIncarnationId ===
				input.runtimeSessionIncarnationId;
		if (hasReceipt(sessions[input.taskId])) return;
		if (
			!current ||
			current.runtimeSessionIncarnationId !== input.runtimeSessionIncarnationId ||
			!hasReceipt(current)
		) {
			throw new Error("生命周期应用结果尚无同一会话的权威确认。");
		}
		// 与领域投影同一次快照提交；重启只恢复投影，不能因回复丢失再次执行领域事件。
		await commitWorkspaceStateSnapshotWithinLock(
			input.workspaceId,
			board,
			{
				...sessions,
				[input.taskId]: runtimeTaskSessionSummarySchema.parse(current),
			},
			{ ...meta, updatedAt: Date.now() },
			{ boardJsonText: await readWorkspaceBoardFileRawText(input.workspaceId) },
		);
	});
}

export async function probeHookReviewLifecycleWorkspaceSnapshotCommitReadiness(workspaceId: string): Promise<string> {
	try {
		await lockedFileSystem.withLock(
			{ ...getWorkspaceDirectoryLockRequest(workspaceId), retries: { retries: 0 } },
			async () => {
				const { board, sessions, meta } = await prepareWorkspaceStateSnapshotForWriteWithinLock(workspaceId);
				// 只核验原失败写链是否恢复；复用当前投影，不执行 hook、不推进业务 revision。
				await commitWorkspaceStateSnapshotWithinLock(workspaceId, board, sessions, meta, {
					boardJsonText: await readWorkspaceBoardFileRawText(workspaceId),
				});
			},
		);
		return "workspace_snapshot_commit_writable";
	} catch (error) {
		const code = String((error as NodeJS.ErrnoException).code ?? "UNKNOWN");
		return `workspace_snapshot_commit_unavailable:${/^[A-Z0-9_]+$/u.test(code) ? code : "UNKNOWN"}`;
	}
}

// 身份是重启寻址所需的会话事实，不能等待浏览器保存 board 或正常关机才落盘。
export async function persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
	workspaceId: string,
	taskId: string,
	readCurrentSessionSummary: () => RuntimeTaskSessionSummary | null,
): Promise<AgentNativeConversationSessionIdentityPersistenceOutcome> {
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(workspaceId), async () => {
		const { board, sessions, meta: currentMeta } = await prepareWorkspaceStateSnapshotForWriteWithinLock(workspaceId);
		// 取锁和读盘期间可能又收到 hook；此处才取当前 summary，不能保存排队前的旧快照。
		const currentSummary = readCurrentSessionSummary();
		if (!currentSummary || currentSummary.taskId !== taskId) {
			throw new Error(`Session "${taskId}" is no longer available in workspace "${workspaceId}".`);
		}
		const parsedSummary = runtimeTaskSessionSummarySchema.parse(currentSummary);
		const identity = parsedSummary.agentNativeConversationSessionIdentity;
		if (!identity || identity.sourceAgentId !== parsedSummary.agentId) {
			throw new Error(`Native conversation identity does not match session "${taskId}".`);
		}
		const savedIdentity = sessions[taskId]?.agentNativeConversationSessionIdentity;
		// 同身份的新确认也要落盘，跨重启保留拒绝迟到旧身份的时间水位。
		if (
			savedIdentity?.sourceAgentId === identity.sourceAgentId &&
			(savedIdentity.observedAt > identity.observedAt ||
				(isSameAgentNativeConversationSessionIdentity(savedIdentity, identity) &&
					savedIdentity.observedAt === identity.observedAt))
		) {
			return "already_persisted_without_write";
		}
		const nextSessions = { ...sessions, [taskId]: parsedSummary };
		// 同一身份的再次确认（每个带 session id 的 hook 都会来一次）只推进 observedAt 水位：不动 revision。
		// 推 revision 会让所有客户端整板重水合、让在途的整板保存冲突，曾把浏览器里尚未落盘的新卡整张抹掉（cf427）。
		// 迟到的陈旧快照仍拿不回旧水位：saveWorkspaceState 在同一把目录锁内按 observedAt 保留较新的盘上身份。
		if (savedIdentity && isSameAgentNativeConversationSessionIdentity(savedIdentity, identity)) {
			await commitWorkspaceStateSnapshotWithinLock(
				workspaceId,
				board,
				nextSessions,
				{ ...currentMeta, updatedAt: Date.now() },
				{ boardJsonText: await readWorkspaceBoardFileRawText(workspaceId) },
			);
			return "persisted_reconfirmed_identity_observation_time_without_revision_change";
		}
		await commitWorkspaceStateSnapshotWithinLock(
			workspaceId,
			board,
			nextSessions,
			{ revision: currentMeta.revision + 1, updatedAt: Date.now() },
			{ boardJsonText: await readWorkspaceBoardFileRawText(workspaceId) },
		);
		getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture()?.recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking(
			{
				workspaceId,
				kanbanTaskConversationSessionId: taskId,
				sessionSummary: parsedSummary,
				previouslyPersistedAgentNativeConversationSessionIdentity: savedIdentity ?? null,
			},
		);
		return "persisted_new_identity_and_invalidated_stale_snapshot_revision";
	});
}

function removeTaskSessionSummariesOwnedByOtherWorkspacesFromWorkspaceSessions(
	context: RuntimeWorkspaceContext,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): TaskSessionSummariesOwnedByOtherWorkspacesRemoval {
	return removeTaskSessionSummariesOwnedByOtherWorkspaces({
		workspaceId: context.workspaceId,
		workspaceRepositoryPath: context.repoPath,
		taskWorktreesHomePath: getTaskWorktreesHomePath(),
		sessions,
	});
}

export async function loadWorkspaceState(
	cwd: string,
	options: LoadWorkspaceContextOptions = {},
): Promise<RuntimeWorkspaceStateResponse> {
	const context = await loadWorkspaceContext(cwd, options);
	const { board, sessions: persistedSessions, meta } = await readConsistentWorkspaceStateSnapshot(context.workspaceId);
	// 别的项目串写进来的会话不交给调用方（重启水合、整板快照、浏览器）；盘上的在下一次写入时自愈。
	const sessions = removeTaskSessionSummariesOwnedByOtherWorkspacesFromWorkspaceSessions(
		context,
		persistedSessions,
	).sessionsWithoutSummariesOwnedByOtherWorkspaces;
	return toWorkspaceStateResponse(context, board, sessions, meta.revision);
}

export async function saveWorkspaceState(
	cwd: string,
	taskMutationIntentWithResolvedActor: TaskMutationIntentWithResolvedActor,
	payload: RuntimeWorkspaceStateSaveRequest,
): Promise<RuntimeWorkspaceStateResponse> {
	const parsedPayload = parseWorkspaceStateSavePayload(payload);
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const {
			board: persistedBoard,
			sessions: persistedSessions,
			meta: currentMeta,
		} = await prepareWorkspaceStateSnapshotForWriteWithinLock(context.workspaceId);
		const expectedRevision = parsedPayload.expectedRevision;
		if (
			typeof expectedRevision === "number" &&
			Number.isInteger(expectedRevision) &&
			expectedRevision >= 0 &&
			expectedRevision !== currentMeta.revision
		) {
			throw new WorkspaceStateConflictError(expectedRevision, currentMeta.revision);
		}
		parsedPayload.board = preserveTaskNameVersionsAgainstIncomingBoardSnapshot(persistedBoard, parsedPayload.board);
		// 简介与外部 Run 引用经显式字段操作写入；整板快照只保留当前代次的服务端事实。
		const persistedTaskCardsById = new Map(
			persistedBoard.columns.flatMap((column) => column.cards).map((card) => [card.id, card]),
		);
		parsedPayload.board = {
			...parsedPayload.board,
			columns: parsedPayload.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => {
					const persistedCard = persistedTaskCardsById.get(card.id);
					return persistedCard?.createdAt === card.createdAt
						? {
								...card,
								taskDescription: persistedCard.taskDescription,
								externalWorkflowRunBinding: persistedCard.externalWorkflowRunBinding,
							}
						: { ...card, externalWorkflowRunBinding: undefined };
				}),
			})),
		};
		// 无版本的旧整板不能把客户端尚未见过的迁入卡当作删除；正式卡片动作在锁内改最新状态，不走此入口。
		if (
			expectedRevision === undefined &&
			(await hasBoardSnapshotRemovedTaskTransferredIntoWorkspace(
				context.workspaceId,
				persistedBoard,
				parsedPayload.board,
			))
		)
			throw new WorkspaceStateConflictError(undefined, currentMeta.revision);
		await reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(
			context,
			persistedBoard,
			persistedSessions,
			currentMeta.revision,
		);
		// 客户端（含没刷新的旧 bundle）发来的整份 sessions 里可能夹着别的项目的会话：只收本项目的（cf427）。
		const incomingSessionsRemoval = removeTaskSessionSummariesOwnedByOtherWorkspacesFromWorkspaceSessions(
			context,
			parsedPayload.sessions,
		);
		logTaskSessionSummariesOwnedByOtherWorkspacesRemovedBeforeWrite({
			workspaceId: context.workspaceId,
			removedTaskSessionIdsOwnedByOtherWorkspaces:
				incomingSessionsRemoval.removedTaskSessionIdsOwnedByOtherWorkspaces,
		});
		const sessions = preservePersistedTaskSessionFactsAgainstStaleSnapshots(
			persistedSessions,
			preservePersistedStartedTaskSessionsMissingFromIncomingSnapshot(
				preserveRuntimeOwnedMainSessionBindings(persistedBoard, parsedPayload.board),
				persistedSessions,
				incomingSessionsRemoval.sessionsWithoutSummariesOwnedByOtherWorkspaces,
			),
			true,
		);
		// 先恢复 runtime 拥有的搁置事实，避免客户端伪造 isShelved 阻挡后续 Stage 回滚。
		const incomingBoardWithPersistedTaskShelvingState = preservePersistedTaskShelvingAgainstIncomingBoardSnapshot(
			persistedBoard,
			parsedPayload.board,
		);
		const boardWithoutStartedTasksReenteringBacklog =
			reconcileIncomingBoardToPreventStartedTasksFromReenteringBacklog(
				persistedBoard,
				incomingBoardWithPersistedTaskShelvingState,
				sessions,
			);
		// Post-Deploy Verification 门禁兜底：整板保存不能把受门禁、未结案的卡带进 Done（正常入口走 taskCardAction 的门禁）。
		const postDeployVerificationDoneEntryGuarded =
			await revertCardsNewlyEnteringDoneWithoutPostDeployVerificationClosure({
				workspaceId: context.workspaceId,
				persistedBoard,
				incomingBoard: boardWithoutStartedTasksReenteringBacklog,
				nowIso: new Date().toISOString(),
			});
		if (postDeployVerificationDoneEntryGuarded.revertedTaskIds.length > 0) {
			logWorkspaceStatePostDeployVerificationDoneEntryGuardRevertedCards({
				workspaceId: context.workspaceId,
				revertedTaskIds: postDeployVerificationDoneEntryGuarded.revertedTaskIds,
			});
		}
		const board = preserveRuntimeOwnedTaskClosureState(
			persistedBoard,
			preservePersistedTaskStickerEntriesAgainstIncomingBoardSnapshot(
				persistedBoard,
				preserveRuntimeOwnedMainSessionBindings(persistedBoard, postDeployVerificationDoneEntryGuarded.board),
			),
		);
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents({
			context,
			previousBoard: persistedBoard,
			previousSessions: persistedSessions,
			nextBoard: board,
			nextSessions: projectTaskConversationSessionsForMainSessionBinding(board, sessions),
			nextMeta,
			taskMutationIntentWithResolvedActor,
		});

		return toWorkspaceStateResponse(context, board, sessions, nextRevision);
	});
}

export interface RuntimeWorkspaceAtomicMutationResult<T> {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	value: T;
	save?: boolean;
}

export interface RuntimeWorkspaceAtomicMutationResponse<T> {
	value: T;
	state: RuntimeWorkspaceStateResponse;
	saved: boolean;
}

export async function mutateWorkspaceState<T>(
	cwd: string,
	taskMutationIntentWithResolvedActor: TaskMutationIntentWithResolvedActor,
	mutate: (
		state: RuntimeWorkspaceStateResponse,
	) => RuntimeWorkspaceAtomicMutationResult<T> | Promise<RuntimeWorkspaceAtomicMutationResult<T>>,
): Promise<RuntimeWorkspaceAtomicMutationResponse<T>> {
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const {
			board: currentBoard,
			sessions: currentSessions,
			meta: currentMeta,
		} = await prepareWorkspaceStateSnapshotForWriteWithinLock(context.workspaceId);
		await reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(
			context,
			currentBoard,
			currentSessions,
			currentMeta.revision,
		);
		// 盘上串写进来的别的项目的会话不交给变更函数，也不随这次写入写回（cf427）。
		const currentSessionsRemoval = removeTaskSessionSummariesOwnedByOtherWorkspacesFromWorkspaceSessions(
			context,
			currentSessions,
		);
		const currentSessionsOwnedByThisWorkspace = currentSessionsRemoval.sessionsWithoutSummariesOwnedByOtherWorkspaces;
		const currentState = toWorkspaceStateResponse(
			context,
			currentBoard,
			currentSessionsOwnedByThisWorkspace,
			currentMeta.revision,
		);

		const mutationResult = mutate(currentState);
		const mutation = mutationResult instanceof Promise ? await mutationResult : mutationResult;
		if (mutation.save === false) {
			return {
				value: mutation.value,
				state: currentState,
				saved: false,
			};
		}

		const mutatedSessionsRemoval = removeTaskSessionSummariesOwnedByOtherWorkspacesFromWorkspaceSessions(
			context,
			mutation.sessions ?? currentSessionsOwnedByThisWorkspace,
		);
		logTaskSessionSummariesOwnedByOtherWorkspacesRemovedBeforeWrite({
			workspaceId: context.workspaceId,
			removedTaskSessionIdsOwnedByOtherWorkspaces: [
				...currentSessionsRemoval.removedTaskSessionIdsOwnedByOtherWorkspaces,
				...mutatedSessionsRemoval.removedTaskSessionIdsOwnedByOtherWorkspaces,
			],
		});
		const nextSessions = preservePersistedTaskSessionFactsAgainstStaleSnapshots(
			currentSessions,
			preservePersistedStartedTaskSessionsMissingFromIncomingSnapshot(
				mutation.board,
				currentSessions,
				mutatedSessionsRemoval.sessionsWithoutSummariesOwnedByOtherWorkspaces,
			),
		);
		const nextBoard = reconcileIncomingBoardToPreventStartedTasksFromReenteringBacklog(
			currentBoard,
			mutation.board,
			nextSessions,
		);
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents({
			context,
			previousBoard: currentBoard,
			previousSessions: currentSessions,
			nextBoard,
			nextSessions: projectTaskConversationSessionsForMainSessionBinding(nextBoard, nextSessions),
			nextMeta,
			taskMutationIntentWithResolvedActor,
		});

		return {
			value: mutation.value,
			state: toWorkspaceStateResponse(context, nextBoard, nextSessions, nextRevision),
			saved: true,
		};
	});
}

async function readWorkspaceBoardFileRawText(workspaceId: string): Promise<string | null> {
	const committed = await readWorkspaceStateSnapshotCommit(getWorkspaceDirectoryPath(workspaceId), workspaceId);
	if (committed) return committed.boardJsonText;
	try {
		return await readFile(getPersistedWorkspaceBoardFilePathById(workspaceId), "utf8");
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		throw error;
	}
}

// Y-EVENT-2 第 1、2 步。账本不可用时抛出 InterWorkUnitRelationLedgerUnavailableError，本次写入随之失败——
// 该实例的 board 只读，宁可拒写也不产生没有事件的 board 变更。
export async function reconcileTaskMutationEventLedgerWithPersistedBoardWithinBoardLock(
	context: RuntimeWorkspaceContext,
	persistedBoard: RuntimeBoardData,
	persistedSessions: Record<string, RuntimeTaskSessionSummary>,
	persistedBoardRevision: number,
): Promise<void> {
	const capture = getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture();
	if (!capture) {
		return;
	}
	const persistedBoardFileRawText = await readWorkspaceBoardFileRawText(context.workspaceId);
	await capture.reconcileLedgerWithPersistedBoardWithinBoardLock({
		workspaceId: context.workspaceId,
		workspaceRepositoryPath: context.repoPath,
		persistedBoard,
		persistedSessions,
		persistedBoardFileSha256:
			persistedBoardFileRawText === null
				? null
				: createHash("sha256").update(persistedBoardFileRawText, "utf8").digest("hex"),
		persistedBoardFileRawText,
		persistedBoardRevision,
	});
}

// Y-EVENT-2 第 4–6 步：事件先记为 pending，再写三个 JSON，最后提交。board 序列化只做一次，
// 期望哈希与落盘字节逐字一致；悬挂批次在下一次漏斗通过时按盘上 board 哈希结算。
export async function writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents(input: {
	context: RuntimeWorkspaceContext;
	previousBoard: RuntimeBoardData;
	previousSessions: Record<string, RuntimeTaskSessionSummary>;
	nextBoard: RuntimeBoardData;
	nextSessions: Record<string, RuntimeTaskSessionSummary>;
	nextMeta: WorkspaceStateMeta;
	taskMutationIntentWithResolvedActor: TaskMutationIntentWithResolvedActor;
}): Promise<void> {
	const { context } = input;
	const consolidation = await readDuplicateProjectConsolidationStatus(context.workspaceId);
	if (
		consolidation &&
		input.taskMutationIntentWithResolvedActor.taskMutationIntentKind !== "duplicate_project_task_transferred"
	)
		throw new Error("来源项目已冻结，不能写入旧项目快照。");
	await recoverWorkspaceStateSnapshotProjectionWithinLock(context.workspaceId);
	if (!input.taskMutationIntentWithResolvedActor.backlogTaskProjectTransfer)
		await assertNoTransferredTaskIsReintroducedByStaleBoardSnapshot(
			context.workspaceId,
			input.previousBoard,
			input.nextBoard,
		);
	const capture = getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture();
	const serializedNextBoard = JSON.stringify(input.nextBoard, null, 2);
	const nextBoardFileSha256 = createHash("sha256").update(serializedNextBoard, "utf8").digest("hex");
	const pendingBatch = capture
		? await capture.recordPendingTaskMutationEventsBeforeBoardFileWrite({
				workspaceId: context.workspaceId,
				workspaceRepositoryPath: context.repoPath,
				previousBoard: input.previousBoard,
				nextBoard: input.nextBoard,
				previousSessions: input.previousSessions,
				nextSessions: input.nextSessions,
				nextBoardFileSha256,
				nextBoardRevision: input.nextMeta.revision,
				taskMutationIntentWithResolvedActor: input.taskMutationIntentWithResolvedActor,
			})
		: null;

	await commitWorkspaceStateSnapshotWithinLock(
		context.workspaceId,
		input.nextBoard,
		input.nextSessions,
		input.nextMeta,
	);

	if (capture && pendingBatch) {
		await capture.commitPendingTaskMutationEventsAfterBoardFileWrite({
			pendingBatchId: pendingBatch.pendingBatchId,
			boardFileSha256: nextBoardFileSha256,
			boardRevision: input.nextMeta.revision,
		});
	}
}

function parseWorkspaceSnapshotBoard(
	workspaceId: string,
	snapshot: WorkspaceStateSnapshotCommit,
	options: { requireCompleteRead?: boolean } = {},
): RuntimeBoardData {
	const rawBoard: unknown = JSON.parse(snapshot.boardJsonText);
	if (options.requireCompleteRead && rawBoard === null)
		throw new Error(`JSON 文件 ${getPersistedWorkspaceBoardFilePathById(workspaceId)} 的正文不能为 null。`);
	return reconcileBoardColumns(
		parsePersistedStateFile(
			getPersistedWorkspaceBoardFilePathById(workspaceId),
			BOARD_FILENAME,
			rawBoard,
			runtimeBoardDataSchema,
			createEmptyBoard(),
		),
	);
}

function parseWorkspaceSnapshotSessions(
	workspaceId: string,
	snapshot: WorkspaceStateSnapshotCommit,
	options: { requireCompleteRead?: boolean } = {},
): Record<string, RuntimeTaskSessionSummary> {
	const rawSessions: unknown = JSON.parse(snapshot.sessionsJsonText);
	if (options.requireCompleteRead && rawSessions === null)
		throw new Error(`JSON 文件 ${getWorkspaceSessionsPath(workspaceId)} 的正文不能为 null。`);
	return backfillSessionFacets(
		parsePersistedStateFile(
			getWorkspaceSessionsPath(workspaceId),
			SESSIONS_FILENAME,
			rawSessions,
			workspaceSessionsSchema,
			{},
		),
	);
}

// 读取前后同时核对日志和 commitId；业务 revision 不变的身份观察也不能穿过这个围栏。
async function readConsistentWorkspaceStateProjection<T>(
	workspaceId: string,
	readProjectionFiles: () => Promise<T>,
	readCommittedProjection: (snapshot: WorkspaceStateSnapshotCommit) => T,
): Promise<T> {
	const directoryPath = getWorkspaceDirectoryPath(workspaceId);
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const committedBefore = await readWorkspaceStateSnapshotCommit(directoryPath, workspaceId);
		if (committedBefore) {
			scheduleWorkspaceStateSnapshotProjectionRecovery(workspaceId, committedBefore);
			return readCommittedProjection(committedBefore);
		}
		const before = await readWorkspaceMeta(workspaceId);
		let projectionResult: { value: T } | { error: unknown };
		try {
			projectionResult = { value: await readProjectionFiles() };
		} catch (error) {
			projectionResult = { error };
		}
		const committedAfter = await readWorkspaceStateSnapshotCommit(directoryPath, workspaceId);
		if (committedAfter) {
			scheduleWorkspaceStateSnapshotProjectionRecovery(workspaceId, committedAfter);
			return readCommittedProjection(committedAfter);
		}
		const after = await readWorkspaceMeta(workspaceId);
		if (
			before.workspaceStateSnapshotCommitId === after.workspaceStateSnapshotCommitId &&
			before.revision === after.revision &&
			before.updatedAt === after.updatedAt
		) {
			if ("error" in projectionResult) throw projectionResult.error;
			return projectionResult.value;
		}
	}
	throw new Error(`项目 ${workspaceId} 的快照持续变化，请重试读取。`);
}

async function readConsistentWorkspaceStateSnapshot(workspaceId: string) {
	return await readConsistentWorkspaceStateProjection(
		workspaceId,
		async () => ({
			board: await readWorkspaceBoard(workspaceId),
			sessions: await readWorkspaceSessions(workspaceId),
			meta: await readWorkspaceMeta(workspaceId),
		}),
		(snapshot) => ({
			board: parseWorkspaceSnapshotBoard(workspaceId, snapshot),
			sessions: parseWorkspaceSnapshotSessions(workspaceId, snapshot),
			meta: snapshot.meta,
		}),
	);
}

const projectionRecoveryByDirectoryPath = new Map<
	string,
	{
		commitId: string;
		attempts: number;
		timer?: NodeJS.Timeout;
		recoveryAttemptPending?: boolean;
		filesystemConditionObserver?: NodeJS.Timeout;
		filesystemConditionProbePending?: boolean;
	}
>();
const PROJECTION_RECOVERY_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

function clearWorkspaceStateSnapshotProjectionRecovery(directoryPath: string): void {
	const recovery = projectionRecoveryByDirectoryPath.get(directoryPath);
	if (recovery?.timer) clearTimeout(recovery.timer);
	if (recovery?.filesystemConditionObserver) clearInterval(recovery.filesystemConditionObserver);
	projectionRecoveryByDirectoryPath.delete(directoryPath);
}

function scheduleWorkspaceStateSnapshotProjectionRecovery(
	workspaceId: string,
	snapshot: WorkspaceStateSnapshotCommit,
): void {
	const directoryPath = getWorkspaceDirectoryPath(workspaceId);
	let recovery = projectionRecoveryByDirectoryPath.get(directoryPath);
	if (recovery?.commitId !== snapshot.workspaceStateSnapshotCommitId) {
		clearWorkspaceStateSnapshotProjectionRecovery(directoryPath);
		recovery = { commitId: snapshot.workspaceStateSnapshotCommitId, attempts: 0 };
		projectionRecoveryByDirectoryPath.set(directoryPath, recovery);
	}
	if (
		recovery.timer ||
		recovery.recoveryAttemptPending ||
		recovery.attempts >= PROJECTION_RECOVERY_RETRY_DELAYS_MS.length
	)
		return;
	const lockRequest = getWorkspaceDirectoryLockRequest(workspaceId);
	const currentRecovery = recovery;
	currentRecovery.timer = setTimeout(() => {
		currentRecovery.timer = undefined;
		currentRecovery.attempts += 1;
		currentRecovery.recoveryAttemptPending = true;
		void lockedFileSystem
			.withLock(lockRequest, async () => {
				await recoverWorkspaceStateSnapshotProjectionWithinLock(workspaceId, directoryPath);
			})
			.catch(async (error: unknown) => {
				currentRecovery.recoveryAttemptPending = false;
				logFileLockWarning(
					`snapshot-projection-recovery-deferred workspace=${workspaceId} attempt=${currentRecovery.attempts} error=${String(error)}`,
				);
				if (projectionRecoveryByDirectoryPath.get(directoryPath) !== currentRecovery) return;
				if (currentRecovery.attempts < PROJECTION_RECOVERY_RETRY_DELAYS_MS.length) {
					scheduleWorkspaceStateSnapshotProjectionRecovery(workspaceId, snapshot);
					return;
				}
				const fingerprint = await readWorkspaceProjectionRecoveryFilesystemCondition(directoryPath, error);
				if (projectionRecoveryByDirectoryPath.get(directoryPath) !== currentRecovery) return;
				logFileLockWarning(
					`snapshot-projection-awaiting-filesystem-change workspace=${workspaceId} commitId=${snapshot.workspaceStateSnapshotCommitId}`,
				);
				currentRecovery.filesystemConditionObserver = setInterval(() => {
					if (currentRecovery.filesystemConditionProbePending) return;
					currentRecovery.filesystemConditionProbePending = true;
					void readWorkspaceProjectionRecoveryFilesystemCondition(directoryPath, error)
						.then(async (observed) => {
							if (projectionRecoveryByDirectoryPath.get(directoryPath) !== currentRecovery) return;
							let previousLockContentionCleared = false;
							if (isNodeErrorWithCode(error, "ELOCKED")) {
								try {
									// 内核锁释放不改变 JSON 时间戳；只做无等待资格观察，实际补投仍须重新持锁。
									const release = await lockedFileSystem.acquireLock({ ...lockRequest, retries: 0 });
									await release();
									previousLockContentionCleared = true;
								} catch (probeError) {
									if (!isNodeErrorWithCode(probeError, "ELOCKED"))
										logFileLockWarning(
											`snapshot-projection-lock-observation-unavailable workspace=${workspaceId} error=${String(probeError)}`,
										);
								}
							}
							if (
								projectionRecoveryByDirectoryPath.get(directoryPath) !== currentRecovery ||
								(!previousLockContentionCleared && observed === fingerprint)
							)
								return;
							clearInterval(currentRecovery.filesystemConditionObserver);
							currentRecovery.filesystemConditionObserver = undefined;
							currentRecovery.attempts = 0;
							scheduleWorkspaceStateSnapshotProjectionRecovery(workspaceId, snapshot);
						})
						.finally(() => {
							currentRecovery.filesystemConditionProbePending = false;
						});
				}, 15_000);
				currentRecovery.filesystemConditionObserver.unref();
			});
	}, PROJECTION_RECOVERY_RETRY_DELAYS_MS[currentRecovery.attempts]);
	currentRecovery.timer.unref();
}

// 预算耗尽后只观察条件，不再重复写入；锁可获取、权限、目标身份或（磁盘满时）可用空间变化才恢复重试。
async function readWorkspaceProjectionRecoveryFilesystemCondition(
	directoryPath: string,
	failure: unknown,
): Promise<string> {
	const fingerprints = await Promise.all(
		["", BOARD_FILENAME, SESSIONS_FILENAME, META_FILENAME].map(async (filename) => {
			try {
				const observed = await stat(filename ? join(directoryPath, filename) : directoryPath, { bigint: true });
				return `${observed.dev}:${observed.ino}:${observed.mode}:${observed.ctimeNs}:${observed.mtimeNs}`;
			} catch (error) {
				return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
			}
		}),
	);
	const failureCode = (failure as NodeJS.ErrnoException | null)?.code;
	if (failureCode === "ENOSPC" || failureCode === "EDQUOT") {
		try {
			const filesystem = await statfs(directoryPath, { bigint: true });
			fingerprints.push(`${filesystem.bavail}:${filesystem.ffree}`);
		} catch (error) {
			fingerprints.push(`filesystem-unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
		}
	}
	return JSON.stringify(fingerprints);
}

// 失败仅延后本项目的后续写入；下一次写入会先重试，读到日志也会启动有界后台恢复。
export async function recoverWorkspaceStateSnapshotProjectionWithinLock(
	workspaceId: string,
	directoryPath = getWorkspaceDirectoryPath(workspaceId),
): Promise<void> {
	const committed = await readWorkspaceStateSnapshotCommit(directoryPath, workspaceId);
	if (committed) {
		// 不能用不合法快照覆盖尚可观测的投影。
		parseWorkspaceSnapshotBoard(workspaceId, committed);
		parseWorkspaceSnapshotSessions(workspaceId, committed);
		await projectWorkspaceStateSnapshotCommitWithinLock(directoryPath, committed);
	}
	clearWorkspaceStateSnapshotProjectionRecovery(directoryPath);
}

async function commitWorkspaceStateSnapshotWithinLock(
	workspaceId: string,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	meta: WorkspaceStateMeta,
	preservedProjectionFileTexts?: { boardJsonText?: string | null; sessionsJsonText?: string | null },
): Promise<void> {
	const directoryPath = getWorkspaceDirectoryPath(workspaceId);
	runtimeBoardDataSchema.parse(board);
	workspaceSessionsSchema.parse(sessions);
	const committed = createWorkspaceStateSnapshotCommit({
		workspaceId,
		// 会话写入不能重序列化未编辑的看板，否则会改变关系账本用来核对 pending 批次的字节指纹。
		boardJsonText: preservedProjectionFileTexts?.boardJsonText ?? JSON.stringify(board, null, 2),
		sessionsJsonText: preservedProjectionFileTexts?.sessionsJsonText ?? JSON.stringify(sessions, null, 2),
		meta,
	});
	await writeWorkspaceStateSnapshotCommitDurably(directoryPath, committed);
	try {
		await projectWorkspaceStateSnapshotCommitWithinLock(directoryPath, committed);
		clearWorkspaceStateSnapshotProjectionRecovery(directoryPath);
	} catch (error) {
		logFileLockError(
			`snapshot-committed-projection-deferred workspace=${workspaceId} commitId=${committed.workspaceStateSnapshotCommitId} error=${String(error)}`,
		);
		scheduleWorkspaceStateSnapshotProjectionRecovery(workspaceId, committed);
	}
}

// 首次迁移只记录当前观测，保留原始字节，不推断旧协议下三个文件曾属于同一次提交。
export async function prepareWorkspaceStateSnapshotForWriteWithinLock(workspaceId: string) {
	await recoverWorkspaceStateSnapshotProjectionWithinLock(workspaceId);
	const directoryPath = getWorkspaceDirectoryPath(workspaceId);
	const meta = await readWorkspaceMeta(workspaceId);
	const board = await readWorkspaceBoard(workspaceId);
	const sessions = await readWorkspaceSessions(workspaceId);
	if (!meta.workspaceStateSnapshotCommitId) {
		const [boardJsonText, sessionsJsonText, metaJsonText] = await Promise.all(
			[BOARD_FILENAME, SESSIONS_FILENAME, META_FILENAME].map((filename) =>
				readWorkspaceSnapshotFileText(join(directoryPath, filename)),
			),
		);
		if (boardJsonText !== null || sessionsJsonText !== null || metaJsonText !== null) {
			const observationPath = join(directoryPath, WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME);
			if ((await readWorkspaceSnapshotFileText(observationPath)) === null) {
				await lockedFileSystem.writeJsonFileAtomic(
					observationPath,
					{
						schemaVersion: 1,
						workspaceId,
						observedAtEpochMs: Date.now(),
						historicalSnapshotConsistency: "unverified",
						boardJsonText,
						sessionsJsonText,
						metaJsonText,
					},
					{ lock: null, durable: true },
				);
			}
			await commitWorkspaceStateSnapshotWithinLock(
				workspaceId,
				board,
				sessions,
				{
					revision: meta.revision + 1,
					updatedAt: Date.now(),
				},
				{ boardJsonText: boardJsonText ?? null, sessionsJsonText: sessionsJsonText ?? null },
			);
			await recoverWorkspaceStateSnapshotProjectionWithinLock(workspaceId);
			return { board, sessions, meta: await readWorkspaceMeta(workspaceId) };
		}
	}
	return { board, sessions, meta };
}
