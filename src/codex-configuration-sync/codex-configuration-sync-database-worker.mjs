import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const databasePath = join(workerData.directory, "codex-configuration-sync.sqlite");
try {
 const file = lstatSync(databasePath);
 if (!file.isFile() || file.isSymbolicLink()) throw new Error("配置同步数据库不是可信普通文件。");
} catch (error) { if (error.code !== "ENOENT" || !workerData.allowCreate) throw error; }
const database = new Database(databasePath, { fileMustExist: !workerData.allowCreate, timeout: 5000 });
const existingMetadataTable = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='configuration_storage_metadata'").get();
let existingStorageMetadata;
if (existingMetadataTable) {
 const existing = database.prepare("SELECT payload_json FROM configuration_storage_metadata WHERE singleton=1").get();
 existingStorageMetadata = existing && JSON.parse(existing.payload_json);
 if (existingStorageMetadata && existingStorageMetadata.storageIdentity !== workerData.storageIdentity) throw new Error("数据库与权威凭证身份不符，未修改数据库。");
} else if (!workerData.allowCreate) throw new Error("权威数据库缺少身份记录，禁止初始化。");
chmodSync(databasePath, 0o600);
const databaseFileIdentity = lstatSync(databasePath, { bigint: true });
database.pragma("journal_mode = WAL");
database.pragma("synchronous = FULL");
database.pragma("foreign_keys = ON");
if (database.pragma("user_version", { simple: true }) > 1) throw new Error("配置同步数据库版本高于当前运行时。");
const collectionTables = {
 sources: "configuration_sources", profiles: "configuration_profiles", writers: "configuration_writers",
 hookTrustDecisions: "configuration_hook_trust_decisions", mutationReceipts: "configuration_mutation_receipts",
};
if (!existingStorageMetadata?.migrationCompleted) {
database.exec(`
 CREATE TABLE IF NOT EXISTS configuration_storage_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS configuration_changes (
  change_id TEXT PRIMARY KEY, insertion_sequence INTEGER NOT NULL UNIQUE, source_identity TEXT NOT NULL,
  profile_id TEXT, field_key TEXT NOT NULL, accepted_field_version INTEGER, requires_processing INTEGER NOT NULL,
  payload_json TEXT NOT NULL, propagation_target_total_count INTEGER NOT NULL DEFAULT 0, active_propagation_target_count INTEGER NOT NULL DEFAULT 0,
 approval_status TEXT NOT NULL DEFAULT 'historical', required_profile_field_version INTEGER, current_field_value_digest TEXT NOT NULL, requires_legacy_target_observation INTEGER NOT NULL, search_text TEXT NOT NULL, is_accepted_field_origin INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS configuration_changes_processing ON configuration_changes(requires_processing, insertion_sequence);
 CREATE INDEX IF NOT EXISTS configuration_changes_accepted_field ON configuration_changes(profile_id,field_key,accepted_field_version);
 CREATE INDEX IF NOT EXISTS configuration_changes_accepted_field_origin ON configuration_changes(profile_id,field_key,accepted_field_version,current_field_value_digest,insertion_sequence) WHERE is_accepted_field_origin=1;
 CREATE TABLE IF NOT EXISTS configuration_profile_current_fields (
  profile_id TEXT NOT NULL, field_key TEXT NOT NULL, field_version INTEGER NOT NULL, value_digest TEXT NOT NULL,
  PRIMARY KEY(profile_id,field_key)
 );
 CREATE INDEX IF NOT EXISTS configuration_changes_current_profile_value ON configuration_changes(profile_id,field_key,current_field_value_digest,required_profile_field_version) WHERE active_propagation_target_count>0;
 CREATE INDEX IF NOT EXISTS configuration_changes_legacy_target_observation ON configuration_changes(requires_legacy_target_observation,change_id);
 CREATE TABLE IF NOT EXISTS configuration_propagation_targets (
  change_id TEXT NOT NULL, writer_id TEXT NOT NULL, insertion_sequence INTEGER NOT NULL,
  status TEXT NOT NULL, payload_json TEXT NOT NULL, requires_legacy_observation INTEGER NOT NULL, PRIMARY KEY(change_id,writer_id)
 );
 CREATE INDEX IF NOT EXISTS configuration_targets_processing ON configuration_propagation_targets(status,change_id,writer_id);
 CREATE INDEX IF NOT EXISTS configuration_targets_by_change_status ON configuration_propagation_targets(change_id,status,writer_id);
 CREATE INDEX IF NOT EXISTS configuration_targets_legacy_processing ON configuration_propagation_targets(requires_legacy_observation,status,change_id,writer_id);
 CREATE TABLE IF NOT EXISTS configuration_target_conflict_history (
  change_id TEXT NOT NULL, writer_id TEXT NOT NULL, conflict_sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL, PRIMARY KEY(change_id,writer_id,conflict_sequence)
 );
 CREATE TABLE IF NOT EXISTS configuration_source_observations (
  observation_id TEXT PRIMARY KEY, insertion_sequence INTEGER NOT NULL UNIQUE, is_unread INTEGER NOT NULL, payload_json TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS configuration_observations_unread ON configuration_source_observations(is_unread,insertion_sequence);
 CREATE TABLE IF NOT EXISTS configuration_source_observation_change_references (
  reference_sequence INTEGER PRIMARY KEY AUTOINCREMENT, observation_id TEXT NOT NULL, change_id TEXT NOT NULL,
  UNIQUE(observation_id,change_id)
 );
 CREATE TABLE IF NOT EXISTS configuration_source_observation_writer_references (
  reference_sequence INTEGER PRIMARY KEY AUTOINCREMENT, observation_id TEXT NOT NULL, writer_id TEXT NOT NULL,
  UNIQUE(observation_id,writer_id)
 );
 CREATE TABLE IF NOT EXISTS configuration_source_observation_current_field_references (
  observation_id TEXT NOT NULL, field_key TEXT NOT NULL, change_id TEXT NOT NULL, PRIMARY KEY(observation_id,field_key)
 );
 CREATE TABLE IF NOT EXISTS configuration_history_entries (
  history_sequence INTEGER PRIMARY KEY AUTOINCREMENT, entry_kind TEXT NOT NULL, entry_id TEXT NOT NULL,
  entry_version INTEGER NOT NULL, search_text TEXT NOT NULL, content_fingerprint TEXT NOT NULL, UNIQUE(entry_kind,entry_id)
 );
 CREATE INDEX IF NOT EXISTS configuration_history_kind_sequence ON configuration_history_entries(entry_kind,history_sequence);
 PRAGMA user_version = 1;
`);
for (const table of Object.values(collectionTables)) database.exec(`
 CREATE TABLE IF NOT EXISTS ${table} (
  record_id TEXT PRIMARY KEY, requires_observation INTEGER NOT NULL DEFAULT 0,
  requires_pending_configuration_recovery INTEGER NOT NULL DEFAULT 0, configuration_home TEXT, source_identity TEXT, payload_json TEXT NOT NULL
 );
`);
database.exec(`
 CREATE INDEX IF NOT EXISTS configuration_writers_observation ON configuration_writers(requires_observation,record_id);
 CREATE INDEX IF NOT EXISTS configuration_writers_recovery ON configuration_writers(requires_pending_configuration_recovery,record_id);
 CREATE INDEX IF NOT EXISTS configuration_writers_home ON configuration_writers(configuration_home);
 CREATE INDEX IF NOT EXISTS configuration_writers_legacy_marketplace_source ON configuration_writers(source_identity)
  WHERE json_extract(payload_json,'$.binding.sourceSharedPluginInstallationDirectoriesBinding') IS NULL;
`);
}
const reader = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
reader.pragma("query_only = ON");
let queryMetrics = { decodedRows: 0, decodedBytes: 0 };
function decode(row) {
 if (!row) return undefined;
 queryMetrics.decodedRows++;
 queryMetrics.decodedBytes += Buffer.byteLength(row.payload_json);
 return JSON.parse(row.payload_json);
}
function metadata(connection = database) {
 return decode(connection.prepare("SELECT payload_json FROM configuration_storage_metadata WHERE singleton=1").get());
}
function writeMetadata(value) {
 database.prepare("INSERT INTO configuration_storage_metadata VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET payload_json=excluded.payload_json").run(JSON.stringify(value));
}
function assertStorageIdentity() {
 const current = lstatSync(databasePath, { bigint: true });
 if (current.dev !== databaseFileIdentity.dev || current.ino !== databaseFileIdentity.ino)
  throw Object.assign(new Error("配置同步数据库物理身份已变化，已停止访问旧连接。"), {code: "CONFIGURATION_STORAGE_PHYSICAL_IDENTITY_CHANGED"});
 const stored = metadata();
 if (stored && stored.storageIdentity !== workerData.storageIdentity) throw new Error("配置同步数据库归属与权威切换凭证不符。");
 return stored;
}
const activeTargetStatuses = ["accepted", "pending_reload", "pending_next_start", "conflict"];
const placeholders = (values) => values.map(() => "?").join(",");
function rowsByIds(connection, table, column, ids) {
 const values = [...new Set(ids)];
 const rows = [];
 for (let offset = 0; offset < values.length; offset += 400) {
  const chunk = values.slice(offset, offset + 400);
  rows.push(...connection.prepare(`SELECT rowid AS storage_record_sequence,* FROM ${table} WHERE ${column} IN (${placeholders(chunk)})`).all(...chunk));
 }
 return rows;
}
function readCurrentlyRelevantTargetRows(connection, explain = false) {
 const rows = [];
 for (const versionPredicate of ["c.required_profile_field_version=f.field_version", "c.required_profile_field_version IS NULL"]) {
  rows.push(...connection.prepare(`${explain ? "EXPLAIN QUERY PLAN " : ""}SELECT t.* FROM configuration_profile_current_fields AS f
   CROSS JOIN configuration_changes AS c INDEXED BY configuration_changes_current_profile_value
   CROSS JOIN configuration_propagation_targets AS t INDEXED BY configuration_targets_by_change_status
   WHERE c.profile_id=f.profile_id AND c.field_key=f.field_key AND c.current_field_value_digest=f.value_digest
   AND ${versionPredicate} AND c.approval_status='approved' AND c.active_propagation_target_count>0 AND t.change_id=c.change_id
   AND t.status IN (${placeholders(activeTargetStatuses)})`).all(...activeTargetStatuses));
 }
 rows.push(...connection.prepare(`${explain ? "EXPLAIN QUERY PLAN " : ""}SELECT t.* FROM configuration_propagation_targets AS t INDEXED BY configuration_targets_legacy_processing
  WHERE t.requires_legacy_observation=1 AND t.status IN (${placeholders(activeTargetStatuses)})`).all(...activeTargetStatuses));
 return rows;
}
function readSnapshot(input = {}, connection = reader) {
 return connection.transaction(() => {
  const stored = metadata(connection);
  if (!stored?.migrationCompleted) throw new Error("配置同步迁移尚未完成。");
  const scope = input.scope ?? "full";
  const full = scope === "full";
  const observe = scope === "active";
  const result = { ...stored.storeHeader, storageIdentity: stored.storageIdentity, storageGeneration: stored.storageGeneration,
   sourceDecisionGenerations: stored.sourceDecisionGenerations, historyTotalCount: stored.historyTotalCount,
   historyMaximumSequence: stored.historyMaximumSequence, historyProjectionGeneration: stored.historyProjectionGeneration,
   sources: {}, profiles: {}, writers: {}, hookTrustDecisions: {}, mutationReceipts: {}, changes: [], sourceObservations: [] };
  for (const collection of ["sources", "profiles"])
   for (const row of connection.prepare(`SELECT * FROM ${collectionTables[collection]}`).all()) result[collection][row.record_id] = decode(row);
  const writerRows = new Map();
  if (full) for (const row of connection.prepare("SELECT rowid AS storage_record_sequence,* FROM configuration_writers").all()) writerRows.set(row.record_id,row);
  else if (observe) for (const row of connection.prepare(`SELECT rowid AS storage_record_sequence,* FROM configuration_writers WHERE requires_observation=1
   UNION SELECT rowid AS storage_record_sequence,* FROM configuration_writers WHERE requires_pending_configuration_recovery=1`).all()) writerRows.set(row.record_id,row);
  for (const home of input.writerHomePaths ?? [])
   for (const row of connection.prepare("SELECT rowid AS storage_record_sequence,* FROM configuration_writers WHERE configuration_home=?").all(home)) writerRows.set(row.record_id,row);
  for (const source of input.legacyMarketplaceInstallationSourceIdentities ?? [])
   for (const row of connection.prepare("SELECT rowid AS storage_record_sequence,* FROM configuration_writers WHERE source_identity=? AND json_extract(payload_json,'$.binding.sourceSharedPluginInstallationDirectoriesBinding') IS NULL").all(source)) writerRows.set(row.record_id,row);
  const targetRows = full ? connection.prepare("SELECT * FROM configuration_propagation_targets ORDER BY insertion_sequence").all()
   : observe ? readCurrentlyRelevantTargetRows(connection) : [];
  for (const id of input.includeActiveTargets === false && !input.includeTerminalTargets ? [] : input.changeIds ?? [])
   for (const row of connection.prepare(`SELECT * FROM configuration_propagation_targets WHERE change_id=? ${input.includeTerminalTargets ? "" : "AND status IN ('accepted','pending_reload','pending_next_start','conflict')"} ORDER BY insertion_sequence`).all(id)) {
    if (!targetRows.some((target) => target.change_id === row.change_id && target.writer_id === row.writer_id)) targetRows.push(row);
   }
  for (const changeId of input.changeIds ?? []) for (const writerId of input.targetWriterIds ?? []) {
   const row = connection.prepare("SELECT * FROM configuration_propagation_targets WHERE change_id=? AND writer_id=?").get(changeId,writerId);
   if (row && !targetRows.some((target) => target.change_id === changeId && target.writer_id === writerId)) targetRows.push(row);
  }
  const observationRows = new Map();
  if (full || observe) for (const row of connection.prepare(`SELECT * FROM configuration_source_observations${full ? "" : " WHERE is_unread=1"}`).all()) observationRows.set(row.observation_id,row);
  for (const row of rowsByIds(connection,"configuration_source_observations","observation_id",input.observationIds ?? [])) observationRows.set(row.observation_id,row);
  const changeIds = new Set([...(input.changeIds ?? []), ...targetRows.map((row) => row.change_id)]);
  for (const row of observationRows.values()) {
   const observation = decode(row);
   observation.rawChangeIds = connection.prepare(full
    ? "SELECT change_id FROM configuration_source_observation_change_references WHERE observation_id=? ORDER BY reference_sequence"
    : "SELECT change_id FROM configuration_source_observation_current_field_references WHERE observation_id=?").all(row.observation_id).map((entry) => entry.change_id);
   observation.detectedWriterIds = full ? connection.prepare("SELECT writer_id FROM configuration_source_observation_writer_references WHERE observation_id=? ORDER BY reference_sequence").all(row.observation_id).map((entry) => entry.writer_id) : [];
   for (const id of observation.rawChangeIds) changeIds.add(id);
   result.sourceObservations.push(observation);
  }
  if (!full) {
   for (const source of Object.values(result.sources)) for (const id of Object.values(source.fieldChangeIds ?? {})) changeIds.add(id);
   for (const profile of Object.values(result.profiles)) for (const [fieldKey,version] of Object.entries(profile.fieldVersions ?? {})) {
    const row = connection.prepare("SELECT change_id FROM configuration_changes WHERE profile_id=? AND field_key=? AND accepted_field_version=? AND current_field_value_digest=? AND is_accepted_field_origin=1 ORDER BY insertion_sequence ASC LIMIT 1").get(profile.profileId,fieldKey,version,canonicalContentDigest(profile.fields[fieldKey] ?? null));
    if (row) changeIds.add(row.change_id);
   }
  }
  const changeRows = new Map();
  if (full || observe) for (const row of connection.prepare(`SELECT * FROM configuration_changes${full ? "" : " WHERE requires_processing=1"}`).all()) changeRows.set(row.change_id,row);
  for (const row of rowsByIds(connection,"configuration_changes","change_id",[...changeIds])) changeRows.set(row.change_id,row);
  const changes = [...changeRows.values()].map((row) => ({ row, change: decode(row) }));
  const dependencyIds = new Set();
  for (const { change } of changes) {
   for (const references of [change.sharedChangeIdsAtObservation,change.sharedConflictEvidence?.changeIds])
    for (const id of Object.values(references ?? {})) if (!changeRows.has(id)) dependencyIds.add(id);
  }
  for (const row of rowsByIds(connection,"configuration_changes","change_id",[...dependencyIds])) changes.push({ row, change: decode(row) });
  const targetsByChange = new Map();
  for (const row of targetRows) {
   const target = decode(row);
   const conflictRows = connection.prepare(`SELECT * FROM configuration_target_conflict_history WHERE change_id=? AND writer_id=? ORDER BY conflict_sequence ${full ? "ASC" : "DESC LIMIT 1"}`).all(row.change_id,row.writer_id);
   if (conflictRows.length) target.conflictHistory = conflictRows.map(decode);
   if (!targetsByChange.has(row.change_id)) targetsByChange.set(row.change_id,[]);
   targetsByChange.get(row.change_id).push(target);
  }
  for (const {row,change} of changes.sort((left,right) => left.row.insertion_sequence-right.row.insertion_sequence)) {
   change.targets = targetsByChange.get(row.change_id) ?? [];
   if (!full) change.propagationTargetTotalCount = row.propagation_target_total_count;
   result.changes.push(change);
  }
  if (!full) for (const observation of result.sourceObservations) observation.detectedWriterIds = [...new Set(result.changes.filter((change) => observation.rawChangeIds.includes(change.changeId)).map((change) => change.sourceWriterId))];
  const neededWriters = [...(input.writerIds ?? []), ...result.changes.map((change) => change.sourceWriterId), ...targetRows.map((row) => row.writer_id), ...result.sourceObservations.flatMap((observation) => observation.detectedWriterIds)];
  for (const row of rowsByIds(connection,"configuration_writers","record_id",neededWriters)) writerRows.set(row.record_id,row);
  for (const row of [...writerRows.values()].sort((left,right) => left.storage_record_sequence-right.storage_record_sequence)) result.writers[row.record_id] = decode(row);
  if (full) {
   for (const row of connection.prepare("SELECT * FROM configuration_hook_trust_decisions").all()) result.hookTrustDecisions[row.record_id] = decode(row);
  } else {
   const decisionIds = new Set(input.hookTrustDecisionIds ?? []);
   const fieldSets = [
    ...Object.values(result.profiles).map((profile) => [profile.sourceIdentity,profile.fields]),
    ...Object.values(result.writers).map((writer) => [writer.binding.sourceIdentity,writer.lastObservedFields]),
    ...Object.entries(result.sources).map(([identity,source]) => [identity,source.fields]),
   ];
   for (const [sourceIdentity,fields] of fieldSets) for (const [fieldKey,field] of Object.entries(fields)) {
    if (!field.definitionDigest) continue;
    const [, ...keyPath] = JSON.parse(fieldKey);
    if (!keyPath.includes("state")) continue;
    decisionIds.add(createHash("sha256").update(JSON.stringify([sourceIdentity,keyPath.at(-1) ?? "",field.definitionDigest])).digest("hex"));
   }
   for (const row of rowsByIds(connection,"configuration_hook_trust_decisions","record_id",[...decisionIds])) result.hookTrustDecisions[row.record_id] = decode(row);
  }
  for (const row of full ? connection.prepare("SELECT * FROM configuration_mutation_receipts").all() : rowsByIds(connection,"configuration_mutation_receipts","record_id",input.receiptKeys ?? [])) result.mutationReceipts[row.record_id] = decode(row);
  return result;
 })();
}
function storeHeader(store) {
 const { sources,profiles,writers,changes,sourceObservations,mutationReceipts,hookTrustDecisions,
  storageIdentity,storageGeneration,sourceDecisionGenerations,historyTotalCount,historyMaximumSequence,historyProjectionGeneration,...header } = store;
 return header;
}
function updateHistory(kind,id,entry,eligible,meta,indexedSearchText) {
 const previous = database.prepare("SELECT * FROM configuration_history_entries WHERE entry_kind=? AND entry_id=?").get(kind,id);
 if (!eligible) {
  if (previous) {
   database.prepare("DELETE FROM configuration_history_entries WHERE entry_kind=? AND entry_id=?").run(kind,id);
   meta.historyTotalCount--; meta.historyProjectionGeneration++;
  }
  return;
 }
 const searchText = indexedSearchText ?? JSON.stringify([entry.sourceLabel,entry.sourceIdentity]).toLocaleLowerCase();
 const contentFingerprint = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
 if (previous) {
  if (previous.entry_version !== entry.version || previous.search_text !== searchText || previous.content_fingerprint !== contentFingerprint) {
   database.prepare("UPDATE configuration_history_entries SET entry_version=?,search_text=?,content_fingerprint=? WHERE entry_kind=? AND entry_id=?").run(entry.version,searchText,contentFingerprint,kind,id);
   meta.historyProjectionGeneration++;
  }
 } else {
  const inserted = database.prepare("INSERT INTO configuration_history_entries(entry_kind,entry_id,entry_version,search_text,content_fingerprint) VALUES (?,?,?,?,?)").run(kind,id,entry.version,searchText,contentFingerprint);
  meta.historyMaximumSequence = Number(inserted.lastInsertRowid); meta.historyTotalCount++;
 }
}
function writeCollectionEntry(collection,id,value) {
 if (collection === "profiles") {
  database.prepare("DELETE FROM configuration_profile_current_fields WHERE profile_id=?").run(id);
  for (const fieldKey of new Set([...Object.keys(value.fields),...Object.keys(value.fieldVersions)]))
   database.prepare("INSERT INTO configuration_profile_current_fields VALUES (?,?,?,?)").run(id,fieldKey,value.fieldVersions[fieldKey] ?? 0,canonicalContentDigest(value.fields[fieldKey] ?? null));
 }
 const writer = collection === "writers" ? value : undefined;
 database.prepare(`INSERT INTO ${collectionTables[collection]}(record_id,requires_observation,requires_pending_configuration_recovery,configuration_home,source_identity,payload_json)
  VALUES (?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET requires_observation=excluded.requires_observation,
  requires_pending_configuration_recovery=excluded.requires_pending_configuration_recovery,configuration_home=excluded.configuration_home,source_identity=excluded.source_identity,payload_json=excluded.payload_json`)
  .run(id,writer?.binding.purpose === "native_session" && !writer.retiredAt ? 1 : 0,(writer?.pendingSessionProfileBinding || Object.keys(writer?.pendingSourceSharedPluginInstallationPreparations ?? {}).length) ? 1 : 0,writer?.binding.configurationHomeDirectoryPath ?? null,value.sourceIdentity ?? writer?.binding.sourceIdentity ?? null,JSON.stringify(value));
}
function writeChange(change,meta,searchText) {
 const { targets,propagationTargetTotalCount,...head } = change;
 const previous = database.prepare("SELECT insertion_sequence FROM configuration_changes WHERE change_id=?").get(change.changeId);
 const sequence = previous?.insertion_sequence ?? ++meta.maximumChangeInsertionSequence;
 database.prepare(`INSERT INTO configuration_changes(change_id,insertion_sequence,source_identity,profile_id,field_key,accepted_field_version,requires_processing,payload_json,approval_status,required_profile_field_version,current_field_value_digest,requires_legacy_target_observation,search_text,is_accepted_field_origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(change_id) DO UPDATE SET
  source_identity=excluded.source_identity,profile_id=excluded.profile_id,field_key=excluded.field_key,accepted_field_version=excluded.accepted_field_version,
  requires_processing=excluded.requires_processing,payload_json=excluded.payload_json,approval_status=excluded.approval_status,required_profile_field_version=excluded.required_profile_field_version,current_field_value_digest=excluded.current_field_value_digest,requires_legacy_target_observation=excluded.requires_legacy_target_observation,search_text=excluded.search_text,is_accepted_field_origin=excluded.is_accepted_field_origin`).run(change.changeId,sequence,change.sourceIdentity,
  change.codexConfigurationProfileId ?? null,change.fieldKey,change.acceptedProfileFieldVersion ?? change.version,
  change.approvalStatus === "pending" || change.mergeStatus === "conflict" ? 1 : 0,JSON.stringify(head),change.approvalStatus ?? "historical",change.acceptedProfileFieldVersion ?? null,canonicalContentDigest(change.value ?? null),change.codexConfigurationProfileId && change.approvalStatus === "approved" ? 0 : 1,searchText,change.approvalStatus === "approved" || (change.approvalStatus === "historical" && change.mergeStatus === "shared_default_updated") ? 1 : 0);
 database.prepare("UPDATE configuration_propagation_targets SET requires_legacy_observation=? WHERE change_id=? AND requires_legacy_observation<>?").run(change.codexConfigurationProfileId && change.approvalStatus === "approved" ? 0 : 1,change.changeId,change.codexConfigurationProfileId && change.approvalStatus === "approved" ? 0 : 1);
 updateHistory("settings",change.changeId,change,change.recordKind !== "source_observation" && change.approvalStatus !== "pending",meta,searchText);
}
function writeTarget(changeId,target,previous,full) {
 const {conflictHistory,...head} = target;
 const existing = database.prepare("SELECT insertion_sequence,status FROM configuration_propagation_targets WHERE change_id=? AND writer_id=?").get(changeId,target.writerId);
 const sequence = existing?.insertion_sequence ?? database.prepare("SELECT coalesce(max(insertion_sequence),0)+1 AS sequence FROM configuration_propagation_targets WHERE change_id=?").get(changeId).sequence;
 const legacyObservation = database.prepare("SELECT requires_legacy_target_observation AS required FROM configuration_changes WHERE change_id=?").get(changeId).required;
 database.prepare(`INSERT INTO configuration_propagation_targets VALUES (?,?,?,?,?,?) ON CONFLICT(change_id,writer_id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,requires_legacy_observation=excluded.requires_legacy_observation`).run(changeId,target.writerId,sequence,target.status,JSON.stringify(head),legacyObservation);
 if (!existing) database.prepare("UPDATE configuration_changes SET propagation_target_total_count=propagation_target_total_count+1 WHERE change_id=?").run(changeId);
 const activeDelta = Number(activeTargetStatuses.includes(target.status))-Number(Boolean(existing && activeTargetStatuses.includes(existing.status)));
 if (activeDelta) database.prepare("UPDATE configuration_changes SET active_propagation_target_count=active_propagation_target_count+? WHERE change_id=?").run(activeDelta,changeId);
 if (JSON.stringify(conflictHistory) === JSON.stringify(previous?.conflictHistory)) return;
 if (full || !previous) {
  database.prepare("DELETE FROM configuration_target_conflict_history WHERE change_id=? AND writer_id=?").run(changeId,target.writerId);
  for (const [index,entry] of (conflictHistory ?? []).entries()) database.prepare("INSERT INTO configuration_target_conflict_history VALUES (?,?,?,?)").run(changeId,target.writerId,index,JSON.stringify(entry));
 } else {
  const last = database.prepare("SELECT max(conflict_sequence) AS sequence FROM configuration_target_conflict_history WHERE change_id=? AND writer_id=?").get(changeId,target.writerId).sequence;
  let offset = 0;
  if (previous.conflictHistory?.length && conflictHistory?.length && previous.conflictHistory[0].observedAt === conflictHistory[0].observedAt) {
   database.prepare("UPDATE configuration_target_conflict_history SET payload_json=? WHERE change_id=? AND writer_id=? AND conflict_sequence=?").run(JSON.stringify(conflictHistory[0]),changeId,target.writerId,last);
   offset = 1;
  }
  for (const [index,entry] of (conflictHistory ?? []).slice(offset).entries()) database.prepare("INSERT INTO configuration_target_conflict_history VALUES (?,?,?,?)").run(changeId,target.writerId,(last ?? -1)+1+index,JSON.stringify(entry));
 }
}
function writeObservation(observation,previous,meta,full) {
 const {rawChangeIds,detectedWriterIds,...head} = observation;
 const existing = database.prepare("SELECT insertion_sequence FROM configuration_source_observations WHERE observation_id=?").get(observation.observationId);
 const sequence = existing?.insertion_sequence ?? ++meta.maximumObservationInsertionSequence;
 for (const id of rawChangeIds) {
  database.prepare("INSERT OR IGNORE INTO configuration_source_observation_change_references(observation_id,change_id) VALUES (?,?)").run(observation.observationId,id);
  const change = database.prepare("SELECT field_key FROM configuration_changes WHERE change_id=?").get(id);
  if (change) database.prepare(`INSERT INTO configuration_source_observation_current_field_references VALUES (?,?,?) ON CONFLICT(observation_id,field_key) DO UPDATE SET change_id=excluded.change_id`).run(observation.observationId,change.field_key,id);
 }
 let addedWriterCount = 0;
 for (const id of detectedWriterIds) addedWriterCount += database.prepare("INSERT OR IGNORE INTO configuration_source_observation_writer_references(observation_id,writer_id) VALUES (?,?)").run(observation.observationId,id).changes;
 if (!full && previous) {
  const addedChangeCount = rawChangeIds.filter((id) => !previous.rawChangeIds.includes(id)).length;
  head.observationCount = previous.observationCount + addedChangeCount;
  head.detectedLocationCount = previous.detectedLocationCount + addedWriterCount;
 }
 database.prepare(`INSERT INTO configuration_source_observations VALUES (?,?,?,?) ON CONFLICT(observation_id) DO UPDATE SET is_unread=excluded.is_unread,payload_json=excluded.payload_json`).run(observation.observationId,sequence,observation.acknowledgedAt === null ? 1 : 0,JSON.stringify(head));
 updateHistory("sources",observation.observationId,observation,observation.acknowledgedAt !== null,meta);
}
function commit(input) {
 return database.transaction(() => {
  const meta = assertStorageIdentity();
  if (!meta?.migrationCompleted || meta.writeGateClosed) throw new Error("配置同步存储尚未取得写入资格。");
  if (meta.storageGeneration !== input.expectedStorageGeneration) throw new Error("配置同步提交代数已变化，请重新读取后重试。");
  const before = input.before, after = input.after;
  const touchedSources = new Set();
  let changed = JSON.stringify(storeHeader(before)) !== JSON.stringify(storeHeader(after));
  for (const collection of Object.keys(collectionTables)) {
   for (const [id,value] of Object.entries(after[collection])) if (JSON.stringify(value) !== JSON.stringify(before[collection][id])) {
    writeCollectionEntry(collection,id,value); changed = true;
    const sourceIdentity = value.sourceIdentity ?? value.binding?.sourceIdentity;
    if (sourceIdentity) touchedSources.add(sourceIdentity);
   }
   for (const id of Object.keys(before[collection])) if (!(id in after[collection])) {
    database.prepare(`DELETE FROM ${collectionTables[collection]} WHERE record_id=?`).run(id); changed = true;
    if (collection === "profiles") database.prepare("DELETE FROM configuration_profile_current_fields WHERE profile_id=?").run(id);
   }
  }
  const previousChanges = new Map(before.changes.map((change) => [change.changeId,change]));
  const nextChangeIds = new Set(after.changes.map((change) => change.changeId));
  const nextObservationIds = new Set(after.sourceObservations.map((entry) => entry.observationId));
  for (const change of after.changes) {
   const previous = previousChanges.get(change.changeId);
   if (JSON.stringify(change) === JSON.stringify(previous)) continue;
   changed = true; touchedSources.add(change.sourceIdentity);
   writeChange(change,meta,input.historySearchTexts[change.changeId]);
   const previousTargets = new Map((previous?.targets ?? []).map((target) => [target.writerId,target]));
   for (const target of change.targets) if (JSON.stringify(target) !== JSON.stringify(previousTargets.get(target.writerId))) writeTarget(change.changeId,target,previousTargets.get(target.writerId),input.scope === "full");
   const nextTargetIds = new Set(change.targets.map((target) => target.writerId));
   for (const target of previous?.targets ?? []) if (!nextTargetIds.has(target.writerId)) {
    database.prepare("DELETE FROM configuration_propagation_targets WHERE change_id=? AND writer_id=?").run(change.changeId,target.writerId);
    database.prepare("DELETE FROM configuration_target_conflict_history WHERE change_id=? AND writer_id=?").run(change.changeId,target.writerId);
    database.prepare("UPDATE configuration_changes SET propagation_target_total_count=propagation_target_total_count-1,active_propagation_target_count=active_propagation_target_count-? WHERE change_id=?").run(Number(activeTargetStatuses.includes(target.status)),change.changeId);
   }
  }
  for (const previous of before.changes) if (!nextChangeIds.has(previous.changeId)) {
   changed = true; touchedSources.add(previous.sourceIdentity);
   database.prepare("DELETE FROM configuration_changes WHERE change_id=?").run(previous.changeId);
   database.prepare("DELETE FROM configuration_propagation_targets WHERE change_id=?").run(previous.changeId);
   database.prepare("DELETE FROM configuration_target_conflict_history WHERE change_id=?").run(previous.changeId);
   updateHistory("settings",previous.changeId,previous,false,meta);
  }
  const previousObservations = new Map(before.sourceObservations.map((entry) => [entry.observationId,entry]));
  for (const observation of after.sourceObservations) if (JSON.stringify(observation) !== JSON.stringify(previousObservations.get(observation.observationId))) {
   changed = true; touchedSources.add(observation.sourceIdentity);
   writeObservation(observation,previousObservations.get(observation.observationId),meta,input.scope === "full");
  }
  for (const previous of before.sourceObservations) if (!nextObservationIds.has(previous.observationId)) {
   changed = true;
   for (const table of ["configuration_source_observations","configuration_source_observation_change_references","configuration_source_observation_writer_references","configuration_source_observation_current_field_references"]) database.prepare(`DELETE FROM ${table} WHERE observation_id=?`).run(previous.observationId);
   updateHistory("sources",previous.observationId,previous,false,meta);
  }
  if (changed) {
   meta.storeHeader = storeHeader(after); meta.storageGeneration++;
   for (const source of touchedSources) meta.sourceDecisionGenerations[source] = (meta.sourceDecisionGenerations[source] ?? 0)+1;
   writeMetadata(meta);
  }
  return { storageGeneration: meta.storageGeneration };
 }).immediate();
}
function canonicalContentDigest(value) {
 const canonicalize = (entry) => Array.isArray(entry) ? entry.map(canonicalize) : entry && typeof entry === "object"
  ? Object.fromEntries(Object.entries(entry).sort(([left],[right]) => left.localeCompare(right)).map(([key,item]) => [key,canonicalize(item)])) : entry;
 return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}
function importStore(input) {
 return database.transaction(() => {
  const existing = metadata();
  if (existing) {
   if (existing.migrationIdentity !== input.migrationIdentity || existing.normalizedContentDigest !== input.normalizedContentDigest || !existing.migrationCompleted) throw new Error("迁移记录身份不符。");
   return existing;
  }
  const store = input.store;
  const meta = { storageIdentity: workerData.storageIdentity, storageGeneration: 0, migrationIdentity: input.migrationIdentity,
   migrationCompleted: true, normalizedContentDigest: input.normalizedContentDigest, storeHeader: storeHeader(store),
   sourceDecisionGenerations: {}, historyTotalCount: 0, historyMaximumSequence: 0, historyProjectionGeneration: 0,
   maximumChangeInsertionSequence: 0, maximumObservationInsertionSequence: 0 };
  for (const collection of Object.keys(collectionTables)) for (const [id,value] of Object.entries(store[collection])) writeCollectionEntry(collection,id,value);
  for (const change of store.changes) {
   if (database.prepare("SELECT 1 FROM configuration_changes WHERE change_id=?").get(change.changeId)) throw new Error("迁移发现重复 changeId，已回滚。");
   writeChange(change,meta,input.historySearchTexts[change.changeId]); for (const target of change.targets) writeTarget(change.changeId,target,undefined,true);
  }
  for (const observation of store.sourceObservations) writeObservation(observation,undefined,meta,true);
  writeMetadata(meta);
  const { storageIdentity,storageGeneration,sourceDecisionGenerations,historyTotalCount,historyMaximumSequence,historyProjectionGeneration,...exported } = readSnapshot({scope: "full"},database);
  if (canonicalContentDigest(exported) !== input.normalizedContentDigest) throw new Error("事务内完整导入内容核验失败，已回滚。");
  return meta;
 }).immediate();
}
function listHistory(input) {
 return reader.transaction(() => {
 const meta = metadata(reader);
 const filter = { category: input.category ?? "all", search: (input.search ?? "").trim().toLocaleLowerCase() };
 const filterDigest = createHash("sha256").update(JSON.stringify(filter)).digest("hex");
 let cursor;
 if (input.cursor) {
  try { cursor = JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8")); } catch { throw new Error("历史分页游标无效。"); }
  if (cursor.storageIdentity !== meta.storageIdentity || cursor.filterDigest !== filterDigest || cursor.historyProjectionGeneration !== meta.historyProjectionGeneration) throw new Error("CODEX_CONFIGURATION_HISTORY_CURSOR_INVALIDATED");
 }
 const upper = cursor?.upperSequence ?? meta.historyMaximumSequence;
 const before = cursor?.beforeSequence ?? upper+1;
 if (!Number.isSafeInteger(upper) || !Number.isSafeInteger(before) || upper < 0 || upper > meta.historyMaximumSequence || before < 1 || before > upper+1) throw new Error("历史分页游标范围无效。");
 const limit = Math.min(100,Math.max(1,input.limit ?? 50));
 const searchPredicate = `(?='' OR instr(search_text,?)>0 OR (entry_kind='sources' AND EXISTS (
  SELECT 1 FROM configuration_source_observation_change_references AS r
  JOIN configuration_changes AS c ON c.change_id=r.change_id
  WHERE r.observation_id=configuration_history_entries.entry_id AND instr(c.search_text,?)>0)))`;
 const rows = reader.prepare(`SELECT * FROM configuration_history_entries WHERE history_sequence<=? AND history_sequence<?
  AND (?='all' OR entry_kind=?) AND ${searchPredicate} ORDER BY history_sequence DESC LIMIT ?`).all(upper,before,filter.category,filter.category,filter.search,filter.search,filter.search,limit+1);
 const entries = rows.slice(0,limit);
 const matchingTotalCount = filter.category === "all" && !filter.search && upper === meta.historyMaximumSequence ? meta.historyTotalCount
  : reader.prepare(`SELECT count(*) AS count FROM configuration_history_entries WHERE history_sequence<=? AND (?='all' OR entry_kind=?) AND ${searchPredicate}`).get(upper,filter.category,filter.category,filter.search,filter.search,filter.search).count;
 return { entries, totalCount: matchingTotalCount, storageIdentity: meta.storageIdentity, storageGeneration: meta.storageGeneration,
  historyMaximumSequence: upper, historyProjectionGeneration: meta.historyProjectionGeneration,
  nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ storageIdentity: meta.storageIdentity,filterDigest,historyProjectionGeneration: meta.historyProjectionGeneration,upperSequence: upper,beforeSequence: entries.at(-1).history_sequence })).toString("base64url") : null };
 })();
}
parentPort.on("message", ({ requestId,command,input }) => {
 queryMetrics = { decodedRows: 0, decodedBytes: 0 };
 try {
  if (command !== "import" && command !== "close") assertStorageIdentity();
  let result;
  switch (command) {
   case "import": result = importStore(input); break;
   case "snapshot": result = readSnapshot(input); break;
   case "commit": result = commit(input); break;
   case "metadata": result = metadata(); break;
   case "storage_health_probe": result = database.transaction(() => {
    const stored = metadata();
    if (!stored?.migrationCompleted || stored.writeGateClosed) throw new Error("配置同步存储尚未取得写入资格。");
    const checked = {...stored, storageGeneration: stored.storageGeneration + 1};
    writeMetadata(checked);
    return checked;
   }).immediate(); break;
   case "history": result = listHistory(input); break;
   case "active_query_plans": result = readCurrentlyRelevantTargetRows(reader,true); break;
   case "freeze_legacy_rollback": result = database.transaction(() => {
    const meta = assertStorageIdentity();
    if (meta.storageGeneration !== input.expectedStorageGeneration) throw new Error("回退前存储已有新提交，须重新读取完整状态。");
    if (!meta.writeGateClosed) { meta.writeGateClosed = true; meta.storageGeneration++; writeMetadata(meta); }
    return {storageGeneration: meta.storageGeneration};
   }).immediate(); break;
   case "close": reader.close(); database.close(); result = null; break;
   default: throw new Error("未知配置同步数据库操作。");
  }
  parentPort.postMessage({ requestId,result,metrics: queryMetrics });
  if (command === "close") parentPort.close();
 } catch (error) { parentPort.postMessage({ requestId,error: error.message,code: error.code,metrics: queryMetrics }); }
});
