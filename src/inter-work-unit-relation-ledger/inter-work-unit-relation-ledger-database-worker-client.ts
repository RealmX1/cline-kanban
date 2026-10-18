import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AssertedInterWorkUnitRelationEffectivenessState } from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { UserRejectionSuppressionTombstone } from "../core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import {
	type CommittedInterWorkUnitRelationLedgerEvent,
	committedInterWorkUnitRelationLedgerEventSchema,
	type InterWorkUnitRelationLedgerEventDraft,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import type { ReferenceRelationModelingLedgerCommit } from "../core/work-unit-relation-modeling-api-contract";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import type {
	TaskCardFieldValueRetainedContent,
	WorkspaceBoardSnapshotForTaskMutationDiff,
} from "./workspace-board-task-mutation-occurrence-diff";

// 存储根只有一个变量（Y-EVENT-3）。vitest setup 与 dev:full 默认设置它，避免 dev/测试代码污染只追加的真实账本。
export const INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT_ENVIRONMENT_VARIABLE_NAME =
	"KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT";

export function resolveInterWorkUnitRelationLedgerStorageRootDirectory(): string {
	const configuredStorageRoot =
		process.env[INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT_ENVIRONMENT_VARIABLE_NAME]?.trim();
	return configuredStorageRoot ? configuredStorageRoot : join(getRuntimeHomePath(), "inter-work-unit-relation-ledger");
}

export interface WorkspaceBoardCommittedTaskMutationCaptureSnapshot {
	boardFileSha256: string | null;
	boardRevision: number | null;
	workspaceBoardSnapshot: WorkspaceBoardSnapshotForTaskMutationDiff;
}

export interface RetainedTaskCardFieldKeywordMatch {
	fieldValueSha256: string;
	matchedQueryTokenIndexes: number[];
}

export interface PendingBoardFileWriteTaskMutationEventBatch {
	pendingBatchId: string;
	expectedBoardFileSha256AfterWrite: string;
	expectedBoardRevisionAfterWrite: number;
	nextWorkspaceBoardSnapshot: WorkspaceBoardSnapshotForTaskMutationDiff;
}

export type WorkspaceTaskMutationCaptureState =
	| { lastCommittedSnapshotMatchesPersistedBoardFileWithoutPendingBatches: true }
	| {
			lastCommittedSnapshotMatchesPersistedBoardFileWithoutPendingBatches: false;
			lastCommittedSnapshot: WorkspaceBoardCommittedTaskMutationCaptureSnapshot | null;
			pendingBatches: PendingBoardFileWriteTaskMutationEventBatch[];
	  };

// 卡片限定引用去掉 workspace 后的身份：登记簿按 id 全局唯一，incarnation 区分「同一张卡」与「复用了 id 的另一张卡」。
export interface TaskCardIdentityForGlobalTaskIdentityRegistry {
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
}

export interface TaskIdReservationSeedEntryFromExistingLocalTrace {
	taskId: string;
	observedInExistingLocalTraceSourceKinds: string[];
}

export const TASK_ID_ALREADY_REGISTERED_IN_GLOBAL_TASK_IDENTITY_REGISTRY_ERROR_CODE =
	"task_id_already_registered_in_global_task_identity_registry";

export interface PendingBoardFileWriteTaskMutationEventBatchResolution {
	pendingBatchId: string;
	pendingBatchResolution: "commit" | "abandon";
}

// dd2db 阶段 2 断言型关系的写侧守卫（worker 里的当前态表与墓碑表，都是可从族 4 事件重建的缓存）。
export interface InterWorkUnitAssertedRelationCurrentStateRow {
	relationId: string;
	relationAssertionNaturalKey: string;
	relationKind: string;
	assertionEffectivenessState: AssertedInterWorkUnitRelationEffectivenessState;
	assertedRelationStateVersion: number;
}

export interface InterWorkUnitRelationAssertionWriteGuardState {
	effectiveAssertedRelationOfNaturalKey: { relationId: string; assertedRelationStateVersion: number } | null;
	assertedRelationStateOfRelationId: InterWorkUnitAssertedRelationCurrentStateRow | null;
	userRejectionSuppressionTombstonesOfNaturalKey: UserRejectionSuppressionTombstone[];
}

export interface InterWorkUnitRelationAssertionWriteCompareAndSetExpectations {
	relationAssertionNaturalKey: string;
	expectedEffectiveRelationIdOfNaturalKey: string | null;
	expectedUserRejectionSuppressionTombstoneCountOfNaturalKey: number;
}

export type InterWorkUnitAssertedRelationCurrentStateWrite =
	| {
			assertedRelationStateWriteKind: "insert_newly_effective_asserted_relation";
			relationId: string;
			relationKind: string;
	  }
	| {
			assertedRelationStateWriteKind:
				| "bump_version_of_effective_asserted_relation"
				| "mark_effective_asserted_relation_revoked";
			relationId: string;
			expectedAssertedRelationStateVersion: number;
	  };

// better-sqlite3 是原生模块，只能被编译它的那个 Node ABI 加载。`dev:full` / `dogfood` 按 PATH 取 node，
// 与安装 node_modules 时的 Node 不同就会打不开账本、board 只读——原始报错只说 NODE_MODULE_VERSION 不符，
// 这里补上怎么办。task worktree 的 node_modules 软链到主 checkout，`npm rebuild` 会改掉正在服务的 runtime 用的那份。
function appendNativeModuleNodeAbiMismatchGuidanceToLedgerUnavailableReason(ledgerUnavailableReason: string): string {
	if (!ledgerUnavailableReason.includes("NODE_MODULE_VERSION")) {
		return ledgerUnavailableReason;
	}
	return `${ledgerUnavailableReason} — this runtime runs on Node ${process.version}, but better-sqlite3 in node_modules was built for another Node version. Start Kanban with the Node version that installed node_modules (for example \`nvm use <that version>\`). Do not run \`npm rebuild\` from a task worktree: its node_modules is shared with the main checkout and with any Kanban runtime already serving from it.`;
}

// 账本 worker 打不开（例如 better-sqlite3 ABI 不符）时抛出；持久化漏斗据此让该实例的 board 只读（Y-EVENT-1）。
export class InterWorkUnitRelationLedgerUnavailableError extends Error {
	constructor(readonly ledgerUnavailableReason: string) {
		super(
			`Inter-work-unit relation ledger is unavailable, so this Kanban runtime keeps the board read-only: ${appendNativeModuleNodeAbiMismatchGuidanceToLedgerUnavailableReason(ledgerUnavailableReason)}`,
		);
		this.name = "InterWorkUnitRelationLedgerUnavailableError";
	}
}

export class InterWorkUnitRelationLedgerDatabaseWorkerClient {
	private worker: Worker | null = null;
	private readonly pendingRequestsByRequestId = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(readonly ledgerStorageRootDirectory: string) {}

	private async request(command: string, input: unknown): Promise<unknown> {
		if (!this.worker) {
			const worker = new Worker(new URL("./inter-work-unit-relation-ledger-database-worker.mjs", import.meta.url), {
				workerData: { directory: this.ledgerStorageRootDirectory },
			});
			this.worker = worker;
			worker.on("message", (message: { requestId: string; result?: unknown; error?: string }) => {
				const pendingRequest = this.pendingRequestsByRequestId.get(message.requestId);
				this.pendingRequestsByRequestId.delete(message.requestId);
				if (message.error !== undefined) pendingRequest?.reject(new Error(message.error));
				else pendingRequest?.resolve(message.result);
				if (this.pendingRequestsByRequestId.size === 0) worker.unref();
			});
			const failAllPendingRequests = (error: Error) => {
				if (this.worker !== worker) return;
				const unavailableError = new InterWorkUnitRelationLedgerUnavailableError(error.message);
				for (const pendingRequest of this.pendingRequestsByRequestId.values())
					pendingRequest.reject(unavailableError);
				this.pendingRequestsByRequestId.clear();
				this.worker = null;
			};
			worker.on("error", failAllPendingRequests);
			worker.on("exit", () => failAllPendingRequests(new Error("Inter-work-unit relation ledger worker exited")));
		}
		const requestId = randomUUID();
		this.worker.ref();
		return await new Promise((resolve, reject) => {
			this.pendingRequestsByRequestId.set(requestId, { resolve, reject });
			this.worker?.postMessage({ requestId, command, input });
		});
	}

	async readWorkspaceTaskMutationCaptureState(
		workspaceId: string,
		persistedBoardFileSha256: string | null,
	): Promise<WorkspaceTaskMutationCaptureState> {
		return (await this.request("readWorkspaceTaskMutationCaptureState", {
			workspaceId,
			persistedBoardFileSha256,
		})) as WorkspaceTaskMutationCaptureState;
	}

	async resolvePendingBatchesAndRecordDetectedEvents(input: {
		workspaceId: string;
		pendingBatchResolutions: PendingBoardFileWriteTaskMutationEventBatchResolution[];
		detectedEventDrafts: InterWorkUnitRelationLedgerEventDraft[];
		retainedFieldContents: TaskCardFieldValueRetainedContent[];
		currentSnapshot: WorkspaceBoardCommittedTaskMutationCaptureSnapshot;
		observedTaskCardIdentities: TaskCardIdentityForGlobalTaskIdentityRegistry[];
	}): Promise<void> {
		await this.request("resolvePendingBatchesAndRecordDetectedEvents", input);
	}

	async recordPendingTaskMutationEventBatch(input: {
		workspaceId: string;
		pendingBatchId: string;
		expectedBoardFileSha256AfterWrite: string;
		expectedBoardRevisionAfterWrite: number;
		nextWorkspaceBoardSnapshot: WorkspaceBoardSnapshotForTaskMutationDiff;
		eventDrafts: InterWorkUnitRelationLedgerEventDraft[];
		retainedFieldContents: TaskCardFieldValueRetainedContent[];
		// 漏斗内新建的卡：worker 在同一事务里校验 id 未被别的卡占用，冲突则整批回滚并抛错（board 不写盘）。
		createdTaskCardIdentities: TaskCardIdentityForGlobalTaskIdentityRegistry[];
	}): Promise<void> {
		await this.request("recordPendingTaskMutationEventBatch", input);
	}

	async commitPendingTaskMutationEventBatch(input: {
		pendingBatchId: string;
		boardFileSha256: string;
		boardRevision: number;
	}): Promise<boolean> {
		const result = (await this.request("commitPendingTaskMutationEventBatch", input)) as { committed: boolean };
		return result.committed;
	}

	async appendCommittedEvents(input: {
		eventDrafts: InterWorkUnitRelationLedgerEventDraft[];
		retainedFieldContents?: TaskCardFieldValueRetainedContent[];
	}): Promise<void> {
		await this.request("appendCommittedEvents", input);
	}

	// 幂等键已记过的草稿原子跳过（同一事实只记一条）；返回实际追加与跳过的幂等键。
	async appendCommittedEventsSkippingDraftsWhoseIdempotencyKeyIsAlreadyRecorded(input: {
		eventDrafts: InterWorkUnitRelationLedgerEventDraft[];
	}): Promise<{ appendedIdempotencyKeys: string[]; skippedIdempotencyKeysAlreadyRecorded: string[] }> {
		return (await this.request("appendCommittedEventsSkippingDraftsWhoseIdempotencyKeyIsAlreadyRecorded", input)) as {
			appendedIdempotencyKeys: string[];
			skippedIdempotencyKeysAlreadyRecorded: string[];
		};
	}

	// 返回 null 表示候选全部已被占用（调用方换一批候选重试）。
	async allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry(input: {
		candidateTaskIds: string[];
		requestingWorkspaceId: string | null;
	}): Promise<string | null> {
		const result = (await this.request("allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry", input)) as {
			allocatedTaskId: string | null;
		};
		return result.allocatedTaskId;
	}

	async seedTaskIdReservationsFromExistingLocalTraces(input: {
		seededTaskIdEntries: TaskIdReservationSeedEntryFromExistingLocalTrace[];
		seedingEventDraft: InterWorkUnitRelationLedgerEventDraft;
	}): Promise<number> {
		const result = (await this.request("seedTaskIdReservationsFromExistingLocalTraces", input)) as {
			newlyReservedTaskIdCount: number;
		};
		return result.newlyReservedTaskIdCount;
	}

	async readReferenceRelationModelingSubmissionFingerprint(idempotencyKey: string): Promise<string | null> {
		return (await this.request("readReferenceRelationModelingSubmissionFingerprint", { idempotencyKey })) as
			| string
			| null;
	}

	async commitReferenceRelationModelingChanges(
		input: ReferenceRelationModelingLedgerCommit,
	): Promise<"applied" | "already_applied" | "conflict"> {
		return (await this.request("commitReferenceRelationModelingChanges", input)) as
			| "applied"
			| "already_applied"
			| "conflict";
	}

	async readInterWorkUnitRelationAssertionWriteGuardState(input: {
		relationAssertionNaturalKey: string | null;
		relationId: string | null;
	}): Promise<InterWorkUnitRelationAssertionWriteGuardState> {
		return (await this.request(
			"readInterWorkUnitRelationAssertionWriteGuardState",
			input,
		)) as InterWorkUnitRelationAssertionWriteGuardState;
	}

	// CAS 失败（守卫状态在读与写之间变了）返回 null，调用方重读重判；成功返回已提交事件的 id 与全局序号。
	async commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet(input: {
		compareAndSetExpectations: InterWorkUnitRelationAssertionWriteCompareAndSetExpectations;
		assertedRelationStateWrite: InterWorkUnitAssertedRelationCurrentStateWrite;
		userRejectionSuppressionTombstoneInsert: UserRejectionSuppressionTombstone | null;
		eventDrafts: InterWorkUnitRelationLedgerEventDraft[];
	}): Promise<{ eventId: string; globalCommittedEventSequence: number }[] | null> {
		const result = (await this.request(
			"commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet",
			input,
		)) as
			| { compareAndSetSucceeded: false }
			| {
					compareAndSetSucceeded: true;
					committedEvents: { eventId: string; globalCommittedEventSequence: number }[];
			  };
		return result.compareAndSetSucceeded ? result.committedEvents : null;
	}

	// 一致性测试用：可从族 4 事件重建的当前态缓存（「全量重建 = 增量维护」）。
	async listInterWorkUnitAssertedRelationCurrentStateRows(): Promise<InterWorkUnitAssertedRelationCurrentStateRow[]> {
		return (await this.request(
			"listInterWorkUnitAssertedRelationCurrentStateRows",
			{},
		)) as InterWorkUnitAssertedRelationCurrentStateRow[];
	}

	async listCommittedEvents(input: {
		afterGlobalCommittedEventSequence?: number;
		limit?: number;
		subjectWorkspaceId?: string;
		subjectTaskId?: string;
	}): Promise<CommittedInterWorkUnitRelationLedgerEvent[]> {
		const rows = (await this.request("listCommittedEvents", input)) as unknown[];
		return rows.map((row) => committedInterWorkUnitRelationLedgerEventSchema.parse(row));
	}

	async readRetainedFieldContents(fieldValueSha256s: string[]): Promise<TaskCardFieldValueRetainedContent[]> {
		return (await this.request("readRetainedFieldContents", {
			fieldValueSha256s,
		})) as TaskCardFieldValueRetainedContent[];
	}

	async findRetainedTaskCardFieldKeywordMatches(input: {
		fieldValueSha256s: string[];
		normalizedQueryTokens: string[];
	}): Promise<RetainedTaskCardFieldKeywordMatch[]> {
		return (await this.request(
			"findRetainedTaskCardFieldKeywordMatches",
			input,
		)) as RetainedTaskCardFieldKeywordMatch[];
	}

	async close(): Promise<void> {
		if (!this.worker) return;
		const worker = this.worker;
		await this.request("close", {}).catch(() => null);
		if (this.worker === worker) this.worker = null;
		await worker.terminate();
	}
}
