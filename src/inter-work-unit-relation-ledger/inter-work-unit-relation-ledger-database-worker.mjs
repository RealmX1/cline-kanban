// 此文件原样随运行时发布（scripts/build.mjs 复制到 dist/）：同步 SQLite 只在 worker 线程执行，不阻塞会话事件循环。
// 工作单元间关系账本只由 runtime 写（dd2db §R3 Y-EVENT-1）；本 worker 只做数据层操作，diff 与行动者解析在 TS 侧完成。
import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const INTER_WORK_UNIT_RELATION_LEDGER_SCHEMA_VERSION = 1;

mkdirSync(workerData.directory, { recursive: true, mode: 0o700 });
const databasePath = join(workerData.directory, "inter-work-unit-relation-ledger.sqlite");
const database = new Database(databasePath);
chmodSync(databasePath, 0o600);
if (database.pragma("user_version", { simple: true }) > INTER_WORK_UNIT_RELATION_LEDGER_SCHEMA_VERSION) {
	throw new Error("Inter-work-unit relation ledger schema is newer than this runtime");
}
// 多个 runtime 实例共用同一个库：WAL + busy_timeout + IMMEDIATE 事务串行写。
database.pragma("busy_timeout = 10000");
database.pragma("journal_mode = WAL");
database.pragma("synchronous = FULL");
database.exec(`
 CREATE TABLE IF NOT EXISTS inter_work_unit_relation_ledger_events (
  event_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_commit_status TEXT NOT NULL,
  global_committed_event_sequence INTEGER UNIQUE,
  pending_board_file_write_batch_id TEXT,
  event_family TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  subject_workspace_id TEXT,
  subject_task_id TEXT,
  occurred_at INTEGER NOT NULL,
  recorded_in_source_of_truth_event_log_at INTEGER,
  idempotency_key TEXT,
  event_json TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS ledger_events_by_committed_sequence
  ON inter_work_unit_relation_ledger_events(event_commit_status, global_committed_event_sequence);
 CREATE INDEX IF NOT EXISTS ledger_events_by_subject_task
  ON inter_work_unit_relation_ledger_events(subject_workspace_id, subject_task_id, global_committed_event_sequence);
 CREATE INDEX IF NOT EXISTS ledger_events_by_pending_batch
  ON inter_work_unit_relation_ledger_events(pending_board_file_write_batch_id);
 CREATE TABLE IF NOT EXISTS ledger_global_committed_event_sequence_counter (
  singleton_row_key INTEGER PRIMARY KEY CHECK (singleton_row_key = 1),
  last_assigned_global_committed_event_sequence INTEGER NOT NULL
 );
 INSERT OR IGNORE INTO ledger_global_committed_event_sequence_counter VALUES (1, 0);
 CREATE TABLE IF NOT EXISTS pending_board_file_write_task_mutation_event_batches (
  pending_board_file_write_batch_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  expected_board_file_sha256_after_write TEXT NOT NULL,
  expected_board_revision_after_write INTEGER NOT NULL,
  next_workspace_board_snapshot_json TEXT NOT NULL,
  pending_batch_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
 );
 CREATE INDEX IF NOT EXISTS pending_batches_by_workspace
  ON pending_board_file_write_task_mutation_event_batches(workspace_id, pending_batch_status, created_at);
 CREATE TABLE IF NOT EXISTS workspace_board_last_committed_task_mutation_capture_snapshot (
  workspace_id TEXT PRIMARY KEY,
  board_file_sha256 TEXT,
  board_revision INTEGER,
  workspace_board_snapshot_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS task_card_text_field_content_by_sha256 (
  content_sha256 TEXT PRIMARY KEY,
  content_canonical_json TEXT NOT NULL,
  first_recorded_at INTEGER NOT NULL
 );
 PRAGMA user_version = ${INTER_WORK_UNIT_RELATION_LEDGER_SCHEMA_VERSION};
`);

const insertEventStatement = database.prepare(`INSERT INTO inter_work_unit_relation_ledger_events(
 event_id, event_commit_status, global_committed_event_sequence, pending_board_file_write_batch_id, event_family, event_kind,
 subject_workspace_id, subject_task_id, occurred_at, recorded_in_source_of_truth_event_log_at, idempotency_key, event_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const assignNextSequenceStatement = database.prepare(
	"UPDATE ledger_global_committed_event_sequence_counter SET last_assigned_global_committed_event_sequence = last_assigned_global_committed_event_sequence + 1 WHERE singleton_row_key = 1 RETURNING last_assigned_global_committed_event_sequence AS assigned",
);
const insertContentStatement = database.prepare(
	"INSERT OR IGNORE INTO task_card_text_field_content_by_sha256(content_sha256, content_canonical_json, first_recorded_at) VALUES (?, ?, ?)",
);
const readSnapshotStatement = database.prepare(
	"SELECT board_file_sha256, board_revision, workspace_board_snapshot_json FROM workspace_board_last_committed_task_mutation_capture_snapshot WHERE workspace_id = ?",
);
const upsertSnapshotStatement = database.prepare(`INSERT INTO workspace_board_last_committed_task_mutation_capture_snapshot(
 workspace_id, board_file_sha256, board_revision, workspace_board_snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?)
 ON CONFLICT(workspace_id) DO UPDATE SET board_file_sha256 = excluded.board_file_sha256, board_revision = excluded.board_revision,
 workspace_board_snapshot_json = excluded.workspace_board_snapshot_json, updated_at = excluded.updated_at`);
const readPendingBatchesStatement = database.prepare(`SELECT pending_board_file_write_batch_id, expected_board_file_sha256_after_write,
 expected_board_revision_after_write, next_workspace_board_snapshot_json FROM pending_board_file_write_task_mutation_event_batches
 WHERE workspace_id = ? AND pending_batch_status = 'pending' ORDER BY created_at, rowid`);
const readPendingBatchStatement = database.prepare(
	"SELECT workspace_id, next_workspace_board_snapshot_json, pending_batch_status FROM pending_board_file_write_task_mutation_event_batches WHERE pending_board_file_write_batch_id = ?",
);
const insertPendingBatchStatement = database.prepare(`INSERT INTO pending_board_file_write_task_mutation_event_batches(
 pending_board_file_write_batch_id, workspace_id, expected_board_file_sha256_after_write, expected_board_revision_after_write,
 next_workspace_board_snapshot_json, pending_batch_status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`);
const resolvePendingBatchStatement = database.prepare(
	"UPDATE pending_board_file_write_task_mutation_event_batches SET pending_batch_status = ?, resolved_at = ? WHERE pending_board_file_write_batch_id = ? AND pending_batch_status = 'pending'",
);
const readPendingBatchEventRowIdsStatement = database.prepare(
	"SELECT event_row_id FROM inter_work_unit_relation_ledger_events WHERE pending_board_file_write_batch_id = ? AND event_commit_status = 'pending_board_file_write' ORDER BY event_row_id",
);
const commitEventRowStatement = database.prepare(
	"UPDATE inter_work_unit_relation_ledger_events SET event_commit_status = 'committed', global_committed_event_sequence = ?, recorded_in_source_of_truth_event_log_at = ? WHERE event_row_id = ?",
);
const abandonPendingBatchEventsStatement = database.prepare(
	"UPDATE inter_work_unit_relation_ledger_events SET event_commit_status = 'abandoned' WHERE pending_board_file_write_batch_id = ? AND event_commit_status = 'pending_board_file_write'",
);
const readContentStatement = database.prepare(
	"SELECT content_sha256, content_canonical_json FROM task_card_text_field_content_by_sha256 WHERE content_sha256 = ?",
);

function assignNextGlobalCommittedEventSequence() {
	return assignNextSequenceStatement.get().assigned;
}

function insertRetainedFieldContents(retainedFieldContents) {
	const now = Date.now();
	for (const content of retainedFieldContents ?? []) {
		insertContentStatement.run(content.fieldValueSha256, content.fieldValueCanonicalJson, now);
	}
}

function insertEventDraft(eventDraft, eventCommitStatus, pendingBatchId) {
	const eventId = randomUUID();
	const isCommitted = eventCommitStatus === "committed";
	const globalCommittedEventSequence = isCommitted ? assignNextGlobalCommittedEventSequence() : null;
	const recordedAt = isCommitted ? Date.now() : null;
	insertEventStatement.run(
		eventId,
		eventCommitStatus,
		globalCommittedEventSequence,
		pendingBatchId,
		eventDraft.eventFamily,
		eventDraft.eventKind,
		eventDraft.subjectWorkspaceId ?? null,
		eventDraft.subjectTaskId ?? null,
		eventDraft.occurredAt,
		recordedAt,
		eventDraft.idempotencyKey ?? null,
		JSON.stringify({ ...eventDraft, eventId }),
	);
	return { eventId, globalCommittedEventSequence };
}

function commitPendingBatchEvents(pendingBatchId) {
	const recordedAt = Date.now();
	for (const row of readPendingBatchEventRowIdsStatement.all(pendingBatchId)) {
		commitEventRowStatement.run(assignNextGlobalCommittedEventSequence(), recordedAt, row.event_row_id);
	}
}

function writeSnapshot(workspaceId, snapshot) {
	upsertSnapshotStatement.run(
		workspaceId,
		snapshot.boardFileSha256 ?? null,
		snapshot.boardRevision ?? null,
		JSON.stringify(snapshot.workspaceBoardSnapshot),
		Date.now(),
	);
}

const readSnapshotBoardFileSha256Statement = database.prepare(
	"SELECT board_file_sha256 FROM workspace_board_last_committed_task_mutation_capture_snapshot WHERE workspace_id = ?",
);
const hasPendingBatchStatement = database.prepare(
	"SELECT 1 AS has_pending FROM pending_board_file_write_task_mutation_event_batches WHERE workspace_id = ? AND pending_batch_status = 'pending' LIMIT 1",
);

// 常见路径：账本快照与盘上 board 字节哈希一致、没有悬挂批次——只回一个标记，不把整份快照 JSON 搬过线程边界。
const readWorkspaceTaskMutationCaptureState = ({ workspaceId, persistedBoardFileSha256 }) => {
	const snapshotShaRow = readSnapshotBoardFileSha256Statement.get(workspaceId);
	if (
		snapshotShaRow &&
		snapshotShaRow.board_file_sha256 === persistedBoardFileSha256 &&
		!hasPendingBatchStatement.get(workspaceId)
	) {
		return { lastCommittedSnapshotMatchesPersistedBoardFileWithoutPendingBatches: true };
	}
	const snapshotRow = readSnapshotStatement.get(workspaceId);
	return {
		lastCommittedSnapshotMatchesPersistedBoardFileWithoutPendingBatches: false,
		lastCommittedSnapshot: snapshotRow
			? {
					boardFileSha256: snapshotRow.board_file_sha256,
					boardRevision: snapshotRow.board_revision,
					workspaceBoardSnapshot: JSON.parse(snapshotRow.workspace_board_snapshot_json),
				}
			: null,
		pendingBatches: readPendingBatchesStatement.all(workspaceId).map((row) => ({
			pendingBatchId: row.pending_board_file_write_batch_id,
			expectedBoardFileSha256AfterWrite: row.expected_board_file_sha256_after_write,
			expectedBoardRevisionAfterWrite: row.expected_board_revision_after_write,
			nextWorkspaceBoardSnapshot: JSON.parse(row.next_workspace_board_snapshot_json),
		})),
	};
};

const resolvePendingBatchesAndRecordDetectedEvents = database.transaction(
	({ workspaceId, pendingBatchResolutions, detectedEventDrafts, retainedFieldContents, currentSnapshot }) => {
		const now = Date.now();
		// 先按创建顺序结算悬挂批次（它们描述的变更早于本次检测到的漏斗外变更），再追加检测事件。
		for (const resolution of pendingBatchResolutions) {
			if (resolution.pendingBatchResolution === "commit") {
				commitPendingBatchEvents(resolution.pendingBatchId);
			} else {
				abandonPendingBatchEventsStatement.run(resolution.pendingBatchId);
			}
			resolvePendingBatchStatement.run(
				resolution.pendingBatchResolution === "commit" ? "committed" : "abandoned",
				now,
				resolution.pendingBatchId,
			);
		}
		insertRetainedFieldContents(retainedFieldContents);
		const committedEvents = detectedEventDrafts.map((eventDraft) => insertEventDraft(eventDraft, "committed", null));
		writeSnapshot(workspaceId, currentSnapshot);
		return { committedEvents };
	},
);

const recordPendingTaskMutationEventBatch = database.transaction(
	({
		workspaceId,
		pendingBatchId,
		expectedBoardFileSha256AfterWrite,
		expectedBoardRevisionAfterWrite,
		nextWorkspaceBoardSnapshot,
		eventDrafts,
		retainedFieldContents,
	}) => {
		insertPendingBatchStatement.run(
			pendingBatchId,
			workspaceId,
			expectedBoardFileSha256AfterWrite,
			expectedBoardRevisionAfterWrite,
			JSON.stringify(nextWorkspaceBoardSnapshot),
			Date.now(),
		);
		insertRetainedFieldContents(retainedFieldContents);
		for (const eventDraft of eventDrafts) insertEventDraft(eventDraft, "pending_board_file_write", pendingBatchId);
		return { pendingBatchId };
	},
);

const commitPendingTaskMutationEventBatch = database.transaction(
	({ pendingBatchId, boardFileSha256, boardRevision }) => {
		const batch = readPendingBatchStatement.get(pendingBatchId);
		if (!batch || batch.pending_batch_status !== "pending") return { committed: false };
		commitPendingBatchEvents(pendingBatchId);
		resolvePendingBatchStatement.run("committed", Date.now(), pendingBatchId);
		writeSnapshot(batch.workspace_id, {
			boardFileSha256,
			boardRevision,
			workspaceBoardSnapshot: JSON.parse(batch.next_workspace_board_snapshot_json),
		});
		return { committed: true };
	},
);

const appendCommittedEvents = database.transaction(({ eventDrafts, retainedFieldContents }) => {
	insertRetainedFieldContents(retainedFieldContents);
	return { committedEvents: eventDrafts.map((eventDraft) => insertEventDraft(eventDraft, "committed", null)) };
});

function listCommittedEvents({ afterGlobalCommittedEventSequence, limit, subjectWorkspaceId, subjectTaskId }) {
	const conditions = ["event_commit_status = 'committed'", "global_committed_event_sequence > ?"];
	const parameters = [afterGlobalCommittedEventSequence ?? 0];
	if (subjectWorkspaceId) {
		conditions.push("subject_workspace_id = ?");
		parameters.push(subjectWorkspaceId);
	}
	if (subjectTaskId) {
		conditions.push("subject_task_id = ?");
		parameters.push(subjectTaskId);
	}
	parameters.push(Math.max(1, Math.min(limit ?? 500, 5000)));
	return database
		.prepare(
			`SELECT global_committed_event_sequence, recorded_in_source_of_truth_event_log_at, event_json FROM inter_work_unit_relation_ledger_events WHERE ${conditions.join(" AND ")} ORDER BY global_committed_event_sequence LIMIT ?`,
		)
		.all(...parameters)
		.map((row) => ({
			...JSON.parse(row.event_json),
			globalCommittedEventSequence: row.global_committed_event_sequence,
			recordedInSourceOfTruthEventLogAt: row.recorded_in_source_of_truth_event_log_at,
		}));
}

function readRetainedFieldContents({ fieldValueSha256s }) {
	return fieldValueSha256s
		.map((sha256) => readContentStatement.get(sha256))
		.filter(Boolean)
		.map((row) => ({ fieldValueSha256: row.content_sha256, fieldValueCanonicalJson: row.content_canonical_json }));
}

const commands = {
	readWorkspaceTaskMutationCaptureState,
	resolvePendingBatchesAndRecordDetectedEvents: (input) => resolvePendingBatchesAndRecordDetectedEvents.immediate(input),
	recordPendingTaskMutationEventBatch: (input) => recordPendingTaskMutationEventBatch.immediate(input),
	commitPendingTaskMutationEventBatch: (input) => commitPendingTaskMutationEventBatch.immediate(input),
	appendCommittedEvents: (input) => appendCommittedEvents.immediate(input),
	listCommittedEvents,
	readRetainedFieldContents,
	close: () => {
		database.close();
		return true;
	},
};

parentPort.on("message", ({ requestId, command, input }) => {
	try {
		const handler = commands[command];
		if (!handler) throw new Error(`Unknown inter-work-unit relation ledger command: ${command}`);
		parentPort.postMessage({ requestId, result: handler(input) });
	} catch (error) {
		parentPort.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) });
	}
});
