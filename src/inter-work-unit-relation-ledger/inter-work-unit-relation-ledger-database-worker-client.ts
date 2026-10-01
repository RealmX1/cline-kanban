import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
	type CommittedInterWorkUnitRelationLedgerEvent,
	committedInterWorkUnitRelationLedgerEventSchema,
	type InterWorkUnitRelationLedgerEventDraft,
} from "../core/inter-work-unit-relation-ledger-event-contract";
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

export interface PendingBoardFileWriteTaskMutationEventBatchResolution {
	pendingBatchId: string;
	pendingBatchResolution: "commit" | "abandon";
}

// 账本 worker 打不开（例如 better-sqlite3 ABI 不符）时抛出；持久化漏斗据此让该实例的 board 只读（Y-EVENT-1）。
export class InterWorkUnitRelationLedgerUnavailableError extends Error {
	constructor(readonly ledgerUnavailableReason: string) {
		super(
			`Inter-work-unit relation ledger is unavailable, so this Kanban runtime keeps the board read-only: ${ledgerUnavailableReason}`,
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

	async close(): Promise<void> {
		if (!this.worker) return;
		const worker = this.worker;
		await this.request("close", {}).catch(() => null);
		if (this.worker === worker) this.worker = null;
		await worker.terminate();
	}
}
