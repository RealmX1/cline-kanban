// 此文件原样随运行时发布：同步 SQLite 只在 worker 中执行，不阻塞会话事件循环。
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

mkdirSync(workerData.directory, { recursive: true, mode: 0o700 });
const databasePath = join(workerData.directory, "notification-lifecycle.sqlite");
const database = new Database(databasePath);
chmodSync(databasePath, 0o600);
if (database.pragma("user_version", { simple: true }) > 1) throw new Error("Notification archive schema is newer than this runtime");
database.pragma("busy_timeout = 5000");
database.pragma("journal_mode = WAL");
database.pragma("synchronous = FULL");
database.exec(`
 CREATE TABLE IF NOT EXISTS notification_candidates (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL, task_id TEXT NOT NULL, panel_visibility TEXT NOT NULL,
  visited_at INTEGER, processing_status TEXT NOT NULL, fallback_deadline_at INTEGER,
  triggered_at INTEGER NOT NULL, candidate_json TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS notification_candidates_panel ON notification_candidates(panel_visibility, sequence);
 CREATE INDEX IF NOT EXISTS notification_candidates_workspace ON notification_candidates(workspace_id, task_id, sequence);
 CREATE INDEX IF NOT EXISTS notification_candidates_pending ON notification_candidates(processing_status, fallback_deadline_at);
 CREATE TABLE IF NOT EXISTS notification_lifecycle_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL, event_type TEXT NOT NULL, details_json TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS notification_lifecycle_events_candidate ON notification_lifecycle_events(candidate_id, sequence);
 CREATE INDEX IF NOT EXISTS notification_lifecycle_events_event_type_candidate ON notification_lifecycle_events(event_type, candidate_id);
 CREATE TABLE IF NOT EXISTS notification_task_panel_states (workspace_id TEXT NOT NULL, task_id TEXT NOT NULL, is_done INTEGER NOT NULL, PRIMARY KEY(workspace_id, task_id));
 CREATE TABLE IF NOT EXISTS notification_archive_imports (source_path TEXT PRIMARY KEY);
 PRAGMA user_version = 1;
`);
const readCandidateStatement = database.prepare("SELECT sequence, candidate_json FROM notification_candidates WHERE candidate_id = ?");
function readCandidate(candidateId) {
 const row = readCandidateStatement.get(candidateId);
 return row ? { ...JSON.parse(row.candidate_json), sequence: row.sequence } : null;
}
const appendEventStatement = database.prepare("INSERT INTO notification_lifecycle_events(candidate_id, occurred_at, event_type, details_json) VALUES (?, ?, ?, ?)");
function appendEvent(candidateId, eventType, details) {
 appendEventStatement.run(candidateId, Date.now(), eventType, JSON.stringify(details ?? {}));
}
const writeCandidateStatement = database.prepare(`UPDATE notification_candidates SET panel_visibility = ?, visited_at = ?, processing_status = ?, fallback_deadline_at = ?, candidate_json = ? WHERE candidate_id = ?`);
function updateCandidate(candidateId, patch, eventType, details) {
 const previous = readCandidate(candidateId);
 if (!previous) throw new Error("Notification candidate not found");
 const next = { ...previous, ...patch, candidateId: previous.candidateId, sequence: previous.sequence };
 if (next.notificationPanelVisibility !== previous.notificationPanelVisibility) next.notificationPanelVisibilityChangedAt = Date.now();
 writeCandidateStatement.run(next.notificationPanelVisibility, next.notificationVisitedAt, next.notificationProcessingStatus, next.deferredNotificationFallbackDeadlineAt, JSON.stringify(next), candidateId);
 appendEvent(candidateId, eventType, details);
 return next;
}
function capture(input, eventType = "candidate_captured") {
 const previous = readCandidate(input.candidateId);
 if (previous) return previous;
 const candidate = {
  sequence: 0, notificationPanelVisibility: "pending_decision", notificationPanelVisibilityChangedAt: Date.now(),
  notificationVisitedAt: null, notificationProcessingStatus: "captured", deferredNotificationFallbackDeadlineAt: null,
  summaryText: "", summaryLanguage: "zh-CN", taskTitleSnapshot: `Task ${input.taskId}`, repositoryNameSnapshot: input.workspaceId,
  supersededByCandidateId: null, runtimeSessionIncarnationId: null, agentResponseGenerationTurnSequence: null,
  audioSha256: null, deliveryClaimedBy: null, ...input,
 };
 database.prepare(`INSERT INTO notification_candidates(candidate_id, workspace_id, task_id, panel_visibility, visited_at, processing_status, fallback_deadline_at, triggered_at, candidate_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  candidate.candidateId, candidate.workspaceId, candidate.taskId, candidate.notificationPanelVisibility, candidate.notificationVisitedAt,
  candidate.notificationProcessingStatus, candidate.deferredNotificationFallbackDeadlineAt, candidate.triggeredAt, JSON.stringify(candidate),
 );
 appendEvent(candidate.candidateId, eventType, { sourceKind: candidate.sourceKind });
 return readCandidate(candidate.candidateId);
}
function list(input) {
 const conditions = [], parameters = [];
 if (input.workspaceId) { conditions.push("workspace_id = ?"); parameters.push(input.workspaceId); }
 if (input.taskId) { conditions.push("task_id = ?"); parameters.push(input.taskId); }
 if (input.panelOnly) conditions.push("panel_visibility = 'visible' AND NOT EXISTS (SELECT 1 FROM notification_task_panel_states AS task_state WHERE task_state.workspace_id = notification_candidates.workspace_id AND task_state.task_id = notification_candidates.task_id AND task_state.is_done = 1)");
 if (input.triggeredAtOrAfter !== undefined) { conditions.push("triggered_at >= ?"); parameters.push(input.triggeredAtOrAfter); }
 if (input.triggeredAtOrBefore !== undefined) { conditions.push("triggered_at <= ?"); parameters.push(input.triggeredAtOrBefore); }
 if (input.processingStatus) { conditions.push("processing_status = ?"); parameters.push(input.processingStatus); }
 const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
 const totalCount = database.prepare(`SELECT count(*) AS count FROM notification_candidates ${where}`).get(...parameters).count;
 const unreadTaskCount = database.prepare(`SELECT count(*) AS count FROM (SELECT workspace_id, task_id FROM notification_candidates ${where ? `${where} AND` : "WHERE"} panel_visibility = 'visible' AND visited_at IS NULL GROUP BY workspace_id, task_id)`).get(...parameters).count;
 if (input.beforeSequence) { conditions.push("sequence < ?"); parameters.push(input.beforeSequence); }
 const pageWhere = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
 const rows = database.prepare(`SELECT sequence, candidate_json FROM notification_candidates ${pageWhere} ORDER BY sequence DESC LIMIT ?`).all(...parameters, (input.limit ?? 50) + 1);
 const entries = rows.slice(0, input.limit ?? 50).map(row => { const candidate = JSON.parse(row.candidate_json); delete candidate.rawPayload; delete candidate.evidence; return { ...candidate, sequence: row.sequence }; });
 const revision = database.prepare("SELECT coalesce(max(sequence), 0) AS revision FROM notification_lifecycle_events").get().revision;
 return { entries, totalCount, unreadTaskCount, nextBeforeSequence: rows.length > (input.limit ?? 50) ? entries.at(-1).sequence : null, revision };
}
function execute(command, input) {
 switch (command) {
  case "capture": return capture(input);
  case "update": return updateCandidate(input.candidateId, input.patch, input.eventType, input.details);
  case "get": {
   const candidate = readCandidate(input.candidateId);
   if (!candidate) return null;
   const events = database.prepare("SELECT * FROM notification_lifecycle_events WHERE candidate_id = ? ORDER BY sequence").all(input.candidateId).map(row => ({ sequence: row.sequence, candidateId: row.candidate_id, occurredAt: row.occurred_at, eventType: row.event_type, details: JSON.parse(row.details_json) }));
   return { candidate, events };
  }
  case "list": return list(input);
  case "panelGroups": {
   const filter = "panel_visibility = 'visible' AND NOT EXISTS (SELECT 1 FROM notification_task_panel_states AS task_state WHERE task_state.workspace_id = notification_candidates.workspace_id AND task_state.task_id = notification_candidates.task_id AND task_state.is_done = 1)";
   const groups = `SELECT workspace_id, task_id, max(sequence) AS latest_sequence, sum(visited_at IS NULL) AS unread_count, count(*) AS entry_count FROM notification_candidates WHERE ${filter} GROUP BY workspace_id, task_id`;
   const counts = database.prepare(`SELECT count(*) AS totalCount, coalesce(sum(unread_count > 0), 0) AS unreadTaskCount FROM (${groups})`).get();
   const rows = database.prepare(`SELECT candidates.sequence, candidates.candidate_json, grouped.unread_count, grouped.entry_count FROM (${groups}) AS grouped JOIN notification_candidates AS candidates ON candidates.sequence = grouped.latest_sequence WHERE grouped.latest_sequence < ? ORDER BY grouped.latest_sequence DESC LIMIT ?`).all(input.beforeSequence ?? Number.MAX_SAFE_INTEGER, (input.limit ?? 50) + 1);
   const entries = rows.slice(0, input.limit ?? 50).map(row => { const candidate = JSON.parse(row.candidate_json); delete candidate.rawPayload; delete candidate.evidence; return { ...candidate, sequence: row.sequence, notificationVisitedAt: row.unread_count ? null : candidate.notificationVisitedAt }; });
   return { ...counts, entries, nextBeforeSequence: rows.length > (input.limit ?? 50) ? entries.at(-1).sequence : null, revision: database.prepare("SELECT coalesce(max(sequence), 0) AS revision FROM notification_lifecycle_events").get().revision };
  }
  case "taskStates": {
   const statement = database.prepare("INSERT INTO notification_task_panel_states(workspace_id,task_id,is_done) VALUES (?,?,?) ON CONFLICT(workspace_id,task_id) DO UPDATE SET is_done=excluded.is_done");
   for (const task of input.tasks) {
    const previous = database.prepare("SELECT is_done FROM notification_task_panel_states WHERE workspace_id=? AND task_id=?").get(input.workspaceId, task.taskId);
    if (previous?.is_done === (task.isDone ? 1 : 0)) continue;
    statement.run(input.workspaceId, task.taskId, task.isDone ? 1 : 0);
    for (const candidate of database.prepare("SELECT candidate_id FROM notification_candidates WHERE workspace_id=? AND task_id=? AND panel_visibility='visible'").all(input.workspaceId, task.taskId))
     appendEvent(candidate.candidate_id, "panel_task_completion_policy_changed", { isDone: task.isDone });
   }
   return null;
  }
  case "markAllVisited": {
   const conditions = input.includeCompletedTasks ? "" : " AND NOT EXISTS (SELECT 1 FROM notification_task_panel_states s WHERE s.workspace_id=notification_candidates.workspace_id AND s.task_id=notification_candidates.task_id AND s.is_done=1)";
   const rows = database.prepare(`SELECT candidate_id FROM notification_candidates WHERE panel_visibility='visible' AND visited_at IS NULL${conditions}`).all();
   for (const row of rows) updateCandidate(row.candidate_id, { notificationVisitedAt: Date.now() }, "notification_visited", { scope: "all" });
   return rows.length;
  }
  case "clearAll": {
   const rows = database.prepare("SELECT candidate_id FROM notification_candidates WHERE panel_visibility='visible'").all();
   for (const row of rows) updateCandidate(row.candidate_id, { notificationPanelVisibility: "cleared" }, "panel_cleared", { scope: "all" });
   return rows.length;
  }
  case "clear": {
   const rows = database.prepare("SELECT candidate_id FROM notification_candidates WHERE workspace_id = ? AND panel_visibility = 'visible'").all(input.workspaceId);
   for (const row of rows) updateCandidate(row.candidate_id, { notificationPanelVisibility: "cleared" }, "panel_cleared", {});
   return rows.length;
  }
  case "visited": {
   const rows = database.prepare("SELECT candidate_id FROM notification_candidates WHERE workspace_id = ? AND task_id = ? AND visited_at IS NULL AND panel_visibility = 'visible'").all(input.workspaceId, input.taskId);
   for (const row of rows) updateCandidate(row.candidate_id, { notificationVisitedAt: input.visitedAt }, "notification_visited", {});
   return rows.length;
  }
  case "claim": {
   const candidate = readCandidate(input.candidateId);
   if (!candidate) return false;
   const rejection = candidate.deliveryClaimedBy ? "already_claimed" : candidate.notificationPanelVisibility !== "visible" ? "not_visible" : Date.now() - candidate.notificationPanelVisibilityChangedAt > 60_000 ? "stale" : null;
   if (rejection) { appendEvent(input.candidateId, "external_delivery_claim_rejected", {clientId:input.clientId,reason:rejection}); return false; }
   updateCandidate(input.candidateId, { deliveryClaimedBy: input.clientId }, "external_delivery_claimed", { clientId: input.clientId });
   return true;
  }
  case "hasImportedLegacySource": return Boolean(database.prepare("SELECT 1 FROM notification_archive_imports WHERE source_path = ?").get(input.sourcePath));
  case "import": {
   if (database.prepare("SELECT 1 FROM notification_archive_imports WHERE source_path = ?").get(input.sourcePath)) return false;
   for (const candidate of input.candidates) capture(candidate, "legacy_imported");
   database.prepare("INSERT INTO notification_archive_imports(source_path) VALUES (?)").run(input.sourcePath);
   return true;
  }
  case "recentReady": return database.prepare("SELECT candidates.sequence, candidates.candidate_json FROM notification_candidates AS candidates JOIN notification_lifecycle_events AS events ON candidates.candidate_id = events.candidate_id WHERE events.event_type = 'panel_admitted' AND events.occurred_at >= ? AND candidates.workspace_id = ? AND candidates.panel_visibility = 'visible' ORDER BY events.sequence").all(input.since, input.workspaceId).map(row => ({ ...JSON.parse(row.candidate_json), sequence: row.sequence }));
  case "pendingAudioPersistence": return database.prepare("SELECT DISTINCT e.candidate_id FROM notification_lifecycle_events e JOIN notification_candidates c ON c.candidate_id=e.candidate_id WHERE e.event_type='speech_audio_persistence_started' AND json_extract(c.candidate_json,'$.audioSha256') IS NULL").all().map(row => row.candidate_id);
  case "pending": return database.prepare("SELECT sequence, candidate_json FROM notification_candidates WHERE processing_status IN ('eligible', 'evaluating', 'deferred') AND sequence > ? ORDER BY sequence LIMIT 100").all(input.afterSequence ?? 0).map(row => ({ ...JSON.parse(row.candidate_json), sequence: row.sequence }));
  case "close": database.close(); return null;
  default: throw new Error("Unknown notification archive operation");
 }
}
parentPort.on("message", ({ requestId, command, input }) => {
 try {
  const result = command === "close" ? execute(command, input) : database.transaction(() => execute(command, input)).immediate();
  parentPort.postMessage({ requestId, result });
  if (command === "close") parentPort.close();
 } catch (error) { parentPort.postMessage({ requestId, error: error.message }); }
});
