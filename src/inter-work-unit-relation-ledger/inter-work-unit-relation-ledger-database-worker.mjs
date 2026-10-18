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
 CREATE INDEX IF NOT EXISTS ledger_events_by_idempotency_key
  ON inter_work_unit_relation_ledger_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
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
 -- 全局 task 身份登记簿的 id 占用表（Y-EVENT-12）：id 只由 runtime 分配，删卡后 id 永不复用。
 -- 身份内容（标题史、墓碑等）是 1b 从事件日志重建的投影；这里只保证锁内校验「这个 id 有没有被占用」够快。
 CREATE TABLE IF NOT EXISTS global_task_identity_registry_registered_task_ids (
  task_id TEXT PRIMARY KEY,
  task_id_registration_source TEXT NOT NULL,
  registered_workspace_id TEXT,
  registered_task_incarnation_created_at_epoch_ms INTEGER,
  first_registered_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL
 );
 -- dd2db 阶段 2：断言型关系的当前态（写侧并发守卫）。真相是族 4 事件；这张表只是可从事件重建的缓存，
 -- 让「同自然键至多一条生效」由部分唯一索引兜底、让合并 / 撤销按版本 CAS。读侧投影不读它（读时从事件推导）。
 -- 阶段 2 起加表一律 CREATE TABLE IF NOT EXISTS、不升 user_version：旧 runtime 遇到更高的 user_version 会拒绝打开账本。
 CREATE TABLE IF NOT EXISTS inter_work_unit_asserted_relation_current_state (
  relation_id TEXT PRIMARY KEY,
  relation_assertion_natural_key TEXT NOT NULL,
  relation_kind TEXT NOT NULL,
  assertion_effectiveness_state TEXT NOT NULL,
  asserted_relation_state_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS asserted_relation_single_effective_per_natural_key
  ON inter_work_unit_asserted_relation_current_state(relation_assertion_natural_key)
  WHERE assertion_effectiveness_state = 'applied_and_effective';
 -- Y-CONF-9 拒绝后的抑制墓碑（所有提议方共用）。四字段同样写在撤销生效事件里，这里是可重建的缓存。
 CREATE TABLE IF NOT EXISTS user_rejection_suppression_tombstones (
  tombstone_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  relation_assertion_natural_key TEXT NOT NULL,
  user_rejection_suppression_tombstone_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS user_rejection_suppression_tombstones_by_natural_key
  ON user_rejection_suppression_tombstones(relation_assertion_natural_key);
 PRAGMA user_version = ${INTER_WORK_UNIT_RELATION_LEDGER_SCHEMA_VERSION};
`);

const TASK_ID_ALREADY_REGISTERED_ERROR_CODE = "task_id_already_registered_in_global_task_identity_registry";
const TASK_ID_REGISTRATION_SOURCE_ALLOCATED_FOR_PENDING_CARD_CREATION =
	"allocated_by_runtime_for_pending_task_card_creation";
const TASK_ID_REGISTRATION_SOURCE_TASK_CARD_OBSERVED_ON_BOARD = "task_card_observed_on_board_by_live_capture";
const TASK_ID_REGISTRATION_SOURCE_SEEDED_FROM_EXISTING_LOCAL_TRACE = "seeded_from_existing_local_trace_at_activation";

const readRegisteredTaskIdStatement = database.prepare(
	"SELECT task_id_registration_source, registered_workspace_id, registered_task_incarnation_created_at_epoch_ms FROM global_task_identity_registry_registered_task_ids WHERE task_id = ?",
);
const insertRegisteredTaskIdIfAbsentStatement = database.prepare(`INSERT OR IGNORE INTO global_task_identity_registry_registered_task_ids(
 task_id, task_id_registration_source, registered_workspace_id, registered_task_incarnation_created_at_epoch_ms, first_registered_at, last_updated_at
) VALUES (?, ?, ?, ?, ?, ?)`);
const bindRegisteredTaskIdToTaskCardStatement = database.prepare(`UPDATE global_task_identity_registry_registered_task_ids
 SET task_id_registration_source = ?, registered_workspace_id = ?, registered_task_incarnation_created_at_epoch_ms = ?, last_updated_at = ?
 WHERE task_id = ?`);

// 盘上已经存在的卡（基线、漏斗外检出）：只登记，不拒绝——事实已经发生，拒绝也挡不住。
// 已被占位（分配未用 / 痕迹播种）的 id 绑定到这张卡；已绑定到别的卡的保持原样（跨 workspace 撞号由 1b 诊断）。
function registerTaskCardsObservedOnBoard(workspaceId, observedTaskCardIdentities) {
	const now = Date.now();
	for (const identity of observedTaskCardIdentities ?? []) {
		const row = readRegisteredTaskIdStatement.get(identity.taskId);
		if (!row) {
			insertRegisteredTaskIdIfAbsentStatement.run(
				identity.taskId,
				TASK_ID_REGISTRATION_SOURCE_TASK_CARD_OBSERVED_ON_BOARD,
				workspaceId,
				identity.taskIncarnationCreatedAtEpochMs,
				now,
				now,
			);
		} else if (row.registered_task_incarnation_created_at_epoch_ms === null) {
			bindRegisteredTaskIdToTaskCardStatement.run(
				TASK_ID_REGISTRATION_SOURCE_TASK_CARD_OBSERVED_ON_BOARD,
				workspaceId,
				identity.taskIncarnationCreatedAtEpochMs,
				now,
				identity.taskId,
			);
		}
	}
}

// 漏斗内的新建卡（写盘之前）：id 必须是 runtime 分配给本 workspace 且尚未使用的、从未登记过的，或者就是同一张卡
// （同 workspace、同 incarnation，如悬挂批次被放弃后的重试）。其余一律拒绝，整个 pending 批次随事务回滚，board 不写盘。
function claimRegisteredTaskIdsForTaskCardsCreatedWithinFunnel(workspaceId, createdTaskCardIdentities) {
	const now = Date.now();
	for (const identity of createdTaskCardIdentities ?? []) {
		const row = readRegisteredTaskIdStatement.get(identity.taskId);
		if (!row) {
			insertRegisteredTaskIdIfAbsentStatement.run(
				identity.taskId,
				TASK_ID_REGISTRATION_SOURCE_TASK_CARD_OBSERVED_ON_BOARD,
				workspaceId,
				identity.taskIncarnationCreatedAtEpochMs,
				now,
				now,
			);
			continue;
		}
		const isUnusedAllocationForThisWorkspace =
			row.task_id_registration_source === TASK_ID_REGISTRATION_SOURCE_ALLOCATED_FOR_PENDING_CARD_CREATION &&
			row.registered_task_incarnation_created_at_epoch_ms === null &&
			(row.registered_workspace_id === null || row.registered_workspace_id === workspaceId);
		const isSameTaskCard =
			row.registered_workspace_id === workspaceId &&
			row.registered_task_incarnation_created_at_epoch_ms === identity.taskIncarnationCreatedAtEpochMs;
		if (!isUnusedAllocationForThisWorkspace && !isSameTaskCard) {
			throw new Error(
				`${TASK_ID_ALREADY_REGISTERED_ERROR_CODE}: task id ${identity.taskId} is already registered (${row.task_id_registration_source}${row.registered_workspace_id ? ` in workspace ${row.registered_workspace_id}` : ""})`,
			);
		}
		bindRegisteredTaskIdToTaskCardStatement.run(
			TASK_ID_REGISTRATION_SOURCE_TASK_CARD_OBSERVED_ON_BOARD,
			workspaceId,
			identity.taskIncarnationCreatedAtEpochMs,
			now,
			identity.taskId,
		);
	}
}

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
	({
		workspaceId,
		pendingBatchResolutions,
		detectedEventDrafts,
		retainedFieldContents,
		currentSnapshot,
		observedTaskCardIdentities,
	}) => {
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
		registerTaskCardsObservedOnBoard(workspaceId, observedTaskCardIdentities);
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
		createdTaskCardIdentities,
	}) => {
		claimRegisteredTaskIdsForTaskCardsCreatedWithinFunnel(workspaceId, createdTaskCardIdentities);
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

const readEventWithIdempotencyKeyNotAbandonedStatement = database.prepare(
	"SELECT 1 FROM inter_work_unit_relation_ledger_events WHERE idempotency_key = ? AND event_commit_status != 'abandoned' LIMIT 1",
);

// 「同一事实只记一条」的原子追加（dd2db 1c 起）：幂等键已记过（committed 或仍 pending）的草稿跳过，同批内重复的也只记第一条。
// 查与插在同一个事务里，worker 单线程串行执行——并发上报的同一观测不会各记一条。没有幂等键的草稿照常追加。
const appendCommittedEventsSkippingDraftsWhoseIdempotencyKeyIsAlreadyRecorded = database.transaction(
	({ eventDrafts }) => {
		const idempotencyKeysAppendedInThisBatch = new Set();
		const appendedIdempotencyKeys = [];
		const skippedIdempotencyKeysAlreadyRecorded = [];
		for (const eventDraft of eventDrafts) {
			const idempotencyKey = eventDraft.idempotencyKey ?? null;
			if (idempotencyKey !== null) {
				if (
					idempotencyKeysAppendedInThisBatch.has(idempotencyKey) ||
					readEventWithIdempotencyKeyNotAbandonedStatement.get(idempotencyKey)
				) {
					skippedIdempotencyKeysAlreadyRecorded.push(idempotencyKey);
					continue;
				}
				idempotencyKeysAppendedInThisBatch.add(idempotencyKey);
				appendedIdempotencyKeys.push(idempotencyKey);
			}
			insertEventDraft(eventDraft, "committed", null);
		}
		return { appendedIdempotencyKeys, skippedIdempotencyKeysAlreadyRecorded };
	},
);

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

// 从候选里挑第一个未被占用的 id 占位（候选由 TS 侧生成，id 形状的唯一声明点仍是 src/core/task-id.ts）。
const allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry = database.transaction(
	({ candidateTaskIds, requestingWorkspaceId }) => {
		const now = Date.now();
		for (const candidateTaskId of candidateTaskIds) {
			const insertion = insertRegisteredTaskIdIfAbsentStatement.run(
				candidateTaskId,
				TASK_ID_REGISTRATION_SOURCE_ALLOCATED_FOR_PENDING_CARD_CREATION,
				requestingWorkspaceId ?? null,
				null,
				now,
				now,
			);
			if (insertion.changes === 1) return { allocatedTaskId: candidateTaskId };
		}
		return { allocatedTaskId: null };
	},
);

// 激活时把本机已有痕迹里出现过的 id 一次性占住（只占 id，不主张身份内容）；只有确实新增了占位时才写族 3 事件。
const seedTaskIdReservationsFromExistingLocalTraces = database.transaction(({ seededTaskIdEntries, seedingEventDraft }) => {
	const now = Date.now();
	const newlyReservedTaskIdEntries = [];
	for (const entry of seededTaskIdEntries) {
		const insertion = insertRegisteredTaskIdIfAbsentStatement.run(
			entry.taskId,
			TASK_ID_REGISTRATION_SOURCE_SEEDED_FROM_EXISTING_LOCAL_TRACE,
			null,
			null,
			now,
			now,
		);
		if (insertion.changes === 1) newlyReservedTaskIdEntries.push(entry);
	}
	if (newlyReservedTaskIdEntries.length === 0) return { newlyReservedTaskIdCount: 0 };
	insertEventDraft(
		{ ...seedingEventDraft, eventPayload: { ...seedingEventDraft.eventPayload, newlyReservedTaskIdEntries } },
		"committed",
		null,
	);
	return { newlyReservedTaskIdCount: newlyReservedTaskIdEntries.length };
});

const readEffectiveAssertedRelationOfNaturalKeyStatement = database.prepare(
	"SELECT relation_id, asserted_relation_state_version FROM inter_work_unit_asserted_relation_current_state WHERE relation_assertion_natural_key = ? AND assertion_effectiveness_state = 'applied_and_effective'",
);
const readAssertedRelationStateStatement = database.prepare(
	"SELECT relation_id, relation_assertion_natural_key, relation_kind, assertion_effectiveness_state, asserted_relation_state_version FROM inter_work_unit_asserted_relation_current_state WHERE relation_id = ?",
);
const readUserRejectionSuppressionTombstonesOfNaturalKeyStatement = database.prepare(
	"SELECT user_rejection_suppression_tombstone_json FROM user_rejection_suppression_tombstones WHERE relation_assertion_natural_key = ? ORDER BY tombstone_row_id",
);
const insertAssertedRelationStateStatement = database.prepare(`INSERT INTO inter_work_unit_asserted_relation_current_state(
 relation_id, relation_assertion_natural_key, relation_kind, assertion_effectiveness_state, asserted_relation_state_version, updated_at
) VALUES (?, ?, ?, 'applied_and_effective', 1, ?)`);
const updateAssertedRelationStateWithVersionCheckStatement =
	database.prepare(`UPDATE inter_work_unit_asserted_relation_current_state
 SET assertion_effectiveness_state = ?, asserted_relation_state_version = asserted_relation_state_version + 1, updated_at = ?
 WHERE relation_id = ? AND assertion_effectiveness_state = 'applied_and_effective' AND asserted_relation_state_version = ?`);
const insertUserRejectionSuppressionTombstoneStatement = database.prepare(
	"INSERT INTO user_rejection_suppression_tombstones(relation_assertion_natural_key, user_rejection_suppression_tombstone_json, recorded_at) VALUES (?, ?, ?)",
);
const listAssertedRelationCurrentStateRowsStatement = database.prepare(
	"SELECT relation_id, relation_assertion_natural_key, relation_kind, assertion_effectiveness_state, asserted_relation_state_version FROM inter_work_unit_asserted_relation_current_state ORDER BY relation_id",
);

function toAssertedRelationStateRow(row) {
	return row
		? {
				relationId: row.relation_id,
				relationAssertionNaturalKey: row.relation_assertion_natural_key,
				relationKind: row.relation_kind,
				assertionEffectivenessState: row.assertion_effectiveness_state,
				assertedRelationStateVersion: row.asserted_relation_state_version,
			}
		: null;
}

function readUserRejectionSuppressionTombstonesOfNaturalKey(relationAssertionNaturalKey) {
	return readUserRejectionSuppressionTombstonesOfNaturalKeyStatement
		.all(relationAssertionNaturalKey)
		.map((row) => JSON.parse(row.user_rejection_suppression_tombstone_json));
}

// 写侧守卫读：TS 侧据此决定「新建 / 合并 / 被墓碑抑制 / 撤销」，再带着读到的值走 CAS 提交。
function readInterWorkUnitRelationAssertionWriteGuardState({ relationAssertionNaturalKey, relationId }) {
	const effectiveRow = relationAssertionNaturalKey
		? readEffectiveAssertedRelationOfNaturalKeyStatement.get(relationAssertionNaturalKey)
		: undefined;
	return {
		effectiveAssertedRelationOfNaturalKey: effectiveRow
			? { relationId: effectiveRow.relation_id, assertedRelationStateVersion: effectiveRow.asserted_relation_state_version }
			: null,
		assertedRelationStateOfRelationId: relationId
			? toAssertedRelationStateRow(readAssertedRelationStateStatement.get(relationId))
			: null,
		userRejectionSuppressionTombstonesOfNaturalKey: relationAssertionNaturalKey
			? readUserRejectionSuppressionTombstonesOfNaturalKey(relationAssertionNaturalKey)
			: [],
	};
}

// 断言型关系状态迁移的唯一写入口：读到的守卫状态没变（CAS）才在同一个事务里改当前态、插墓碑、追加族 4 事件；
// 变了就整体不写，返回 compareAndSetSucceeded=false，由 TS 侧重读重判。多个 runtime 共用同一个库时也串行正确。
const commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet = database.transaction(
	({ compareAndSetExpectations, assertedRelationStateWrite, userRejectionSuppressionTombstoneInsert, eventDrafts }) => {
		const now = Date.now();
		const expectations = compareAndSetExpectations;
		const currentEffectiveRow = readEffectiveAssertedRelationOfNaturalKeyStatement.get(
			expectations.relationAssertionNaturalKey,
		);
		const currentEffectiveRelationId = currentEffectiveRow ? currentEffectiveRow.relation_id : null;
		if (
			currentEffectiveRelationId !== expectations.expectedEffectiveRelationIdOfNaturalKey ||
			readUserRejectionSuppressionTombstonesOfNaturalKey(expectations.relationAssertionNaturalKey).length !==
				expectations.expectedUserRejectionSuppressionTombstoneCountOfNaturalKey
		) {
			return { compareAndSetSucceeded: false };
		}
		if (assertedRelationStateWrite.assertedRelationStateWriteKind === "insert_newly_effective_asserted_relation") {
			insertAssertedRelationStateStatement.run(
				assertedRelationStateWrite.relationId,
				expectations.relationAssertionNaturalKey,
				assertedRelationStateWrite.relationKind,
				now,
			);
		} else {
			const nextEffectivenessState =
				assertedRelationStateWrite.assertedRelationStateWriteKind === "mark_effective_asserted_relation_revoked"
					? "revoked"
					: "applied_and_effective";
			const update = updateAssertedRelationStateWithVersionCheckStatement.run(
				nextEffectivenessState,
				now,
				assertedRelationStateWrite.relationId,
				assertedRelationStateWrite.expectedAssertedRelationStateVersion,
			);
			if (update.changes !== 1) {
				return { compareAndSetSucceeded: false };
			}
		}
		if (userRejectionSuppressionTombstoneInsert) {
			insertUserRejectionSuppressionTombstoneStatement.run(
				expectations.relationAssertionNaturalKey,
				JSON.stringify(userRejectionSuppressionTombstoneInsert),
				now,
			);
		}
		const committedEvents = eventDrafts.map((eventDraft) => insertEventDraft(eventDraft, "committed", null));
		return { compareAndSetSucceeded: true, committedEvents };
	},
);

const readRelationModelingSubmissionEventStatement = database.prepare(
	"SELECT event_json FROM inter_work_unit_relation_ledger_events WHERE idempotency_key = ? AND event_commit_status = 'committed' LIMIT 1",
);
function readReferenceRelationModelingSubmissionFingerprint({ idempotencyKey }) {
	const row = readRelationModelingSubmissionEventStatement.get(idempotencyKey);
	return row ? JSON.parse(row.event_json).eventPayload.modelingSubmissionFingerprint : null;
}

// 先检查整批版本，再统一撤销和插入；事务中任何错误都回滚，避免改类型时只撤销未重建。
const commitReferenceRelationModelingChanges = database.transaction(
	({ expectations, relationsAfterChange, eventDraft }) => {
		const previousFingerprint = readReferenceRelationModelingSubmissionFingerprint({
			idempotencyKey: eventDraft.idempotencyKey,
		});
		if (previousFingerprint !== null)
			return previousFingerprint === eventDraft.eventPayload.modelingSubmissionFingerprint ? "already_applied" : "conflict";
		const revokedIds = new Set(expectations.map((entry) => entry.relationId));
		for (const expectation of expectations) {
			const row = readAssertedRelationStateStatement.get(expectation.relationId);
			if (
				!row ||
				row.assertion_effectiveness_state !== "applied_and_effective" ||
				row.asserted_relation_state_version !== expectation.assertedRelationStateVersion
			) return "conflict";
		}
		const effectiveRelationsAfterChange = relationsAfterChange.filter(
			(entry) => entry.assertionEffectivenessState === "applied_and_effective",
		);
		for (const relation of effectiveRelationsAfterChange) {
			const row = readEffectiveAssertedRelationOfNaturalKeyStatement.get(relation.relationAssertionNaturalKey);
			if (row && !revokedIds.has(row.relation_id)) return "conflict";
		}
		for (const expectation of expectations)
			updateAssertedRelationStateWithVersionCheckStatement.run(
				"revoked", eventDraft.occurredAt, expectation.relationId, expectation.assertedRelationStateVersion,
			);
		for (const relation of effectiveRelationsAfterChange)
			insertAssertedRelationStateStatement.run(
				relation.relationId, relation.relationAssertionNaturalKey, relation.relationKind, eventDraft.occurredAt,
			);
		for (const tombstone of eventDraft.eventPayload.userRejectionSuppressionTombstones ?? [])
			insertUserRejectionSuppressionTombstoneStatement.run(
				tombstone.relationAssertionNaturalKey, JSON.stringify(tombstone), eventDraft.occurredAt,
			);
		insertEventDraft(eventDraft, "committed", null);
		return "applied";
	},
);

function readRetainedFieldContents({ fieldValueSha256s }) {
	return fieldValueSha256s
		.map((sha256) => readContentStatement.get(sha256))
		.filter(Boolean)
		.map((row) => ({ fieldValueSha256: row.content_sha256, fieldValueCanonicalJson: row.content_canonical_json }));
}

// 全文匹配留在 worker：逐字段解析，不把未命中的长正文传回主线程或常驻正文缓存。
// 沿用 JS 的 Unicode 大小写规则；SQLite lower/LIKE 的 ASCII 规则会改变既有搜索结果。
function findRetainedTaskCardFieldKeywordMatches({ fieldValueSha256s, normalizedQueryTokens }) {
	const matches = [];
	for (const fieldValueSha256 of fieldValueSha256s) {
		const row = readContentStatement.get(fieldValueSha256);
		if (!row) continue;
		let value;
		try {
			value = JSON.parse(row.content_canonical_json);
		} catch {
			continue;
		}
		if (typeof value !== "string") continue;
		const normalizedText = value.toLocaleLowerCase();
		const matchedQueryTokenIndexes = normalizedQueryTokens.flatMap((token, index) =>
			normalizedText.includes(token) ? [index] : [],
		);
		if (matchedQueryTokenIndexes.length) matches.push({ fieldValueSha256, matchedQueryTokenIndexes });
	}
	return matches;
}

const commands = {
	readWorkspaceTaskMutationCaptureState,
	resolvePendingBatchesAndRecordDetectedEvents: (input) => resolvePendingBatchesAndRecordDetectedEvents.immediate(input),
	recordPendingTaskMutationEventBatch: (input) => recordPendingTaskMutationEventBatch.immediate(input),
	commitPendingTaskMutationEventBatch: (input) => commitPendingTaskMutationEventBatch.immediate(input),
	appendCommittedEvents: (input) => appendCommittedEvents.immediate(input),
	appendCommittedEventsSkippingDraftsWhoseIdempotencyKeyIsAlreadyRecorded: (input) =>
		appendCommittedEventsSkippingDraftsWhoseIdempotencyKeyIsAlreadyRecorded.immediate(input),
	allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry: (input) =>
		allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry.immediate(input),
	seedTaskIdReservationsFromExistingLocalTraces: (input) => seedTaskIdReservationsFromExistingLocalTraces.immediate(input),
	readInterWorkUnitRelationAssertionWriteGuardState,
	readReferenceRelationModelingSubmissionFingerprint,
	commitReferenceRelationModelingChanges: (input) => commitReferenceRelationModelingChanges.immediate(input),
	commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet: (input) =>
		commitInterWorkUnitRelationAssertionStateTransitionWithCompareAndSet.immediate(input),
	listInterWorkUnitAssertedRelationCurrentStateRows: () =>
		listAssertedRelationCurrentStateRowsStatement.all().map(toAssertedRelationStateRow),
	listCommittedEvents,
	readRetainedFieldContents,
	findRetainedTaskCardFieldKeywordMatches,
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
