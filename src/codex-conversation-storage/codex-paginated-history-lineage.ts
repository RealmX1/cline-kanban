import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { CodexNativeConversationTurn } from "../rvf-automatic-closeout/codex-native-conversation-prefix";
import { assertCodexStorageWritablePathInsideHome } from "./codex-conversation-storage-home";
import type { CodexNativeConversationFamilyWriterLockGuard } from "./codex-native-thread-writer-lock";

const historyBaseSchema = z.object({
	thread_id: z.string().uuid(),
	end_ordinal_exclusive: z.number().int().nonnegative().safe(),
	end_byte_offset: z.number().int().positive().safe(),
});
const rolloutMetadataSchema = z.object({
	type: z.literal("session_meta"),
	ordinal: z.number().int().nonnegative().safe().optional(),
	payload: z.object({
		id: z.string().uuid(),
		history_mode: z.string().optional(),
		history_base: historyBaseSchema.nullish(),
	}),
});
export interface CodexPaginatedHistoryRolloutSnapshot {
	transcriptPath: string;
	rolloutSegmentId: string;
	nativeSessionId: string;
	byteLength: number;
	sha256: string;
	endOrdinalExclusive?: number;
	historyBase?: z.infer<typeof historyBaseSchema>;
	historyMode?: string;
	startedTurnIds: string[];
	projectedItemIds: string[];
}
// EXPERIMENT_NODE: lineage 的 512 MiB 与 256 分片上限需结合长会话迁移耗时校准，超限保持原绑定。
const readDependencyRecordSchema = z.object({
	schemaVersion: z.literal(1),
	stage: z.enum(["copy_started", "copied"]),
	sourceHomeDirectoryPath: z.string(),
	nativeSessionId: z.string().uuid(),
	rolloutSegmentId: z.string().uuid(),
	copiedPrefixByteLength: z.number().int().positive().safe(),
	copiedPrefixSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const readDependencyRecordSuffix = ".kanban-history-base-read-dependency.json";
const readDependencyDirectoryName = "kanban-history-base-read-dependencies";

const maximumLineageBytes = 512 * 1024 * 1024;
const maximumLineageSegments = 256;
const maximumScannedRolloutEntries = 100_000;

export function getCodexRolloutSegmentIdFromTranscriptPath(path: string) {
	const match = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/iu.exec(basename(path));
	if (!match) throw new Error("无法确认 Codex rollout 分片身份，未转移历史。");
	return z.string().uuid().parse(match[1]);
}

async function indexRolloutSegmentPaths(home: string) {
	const paths = new Map<string, string[]>();
	const directories = [join(home, "sessions"), join(home, "archived_sessions")];
	let scanned = 0;
	while (directories.length) {
		const directory = directories.pop();
		if (!directory) break;
		await assertCodexStorageWritablePathInsideHome(home, directory);
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (++scanned > maximumScannedRolloutEntries) throw new Error("Codex lineage 扫描超过有界预算，保留原目录。");
			const path = join(directory, entry.name);
			if (entry.isDirectory()) directories.push(path);
			else if (entry.isFile()) {
				const match = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/iu.exec(entry.name);
				if (match) paths.set(match[1], [...(paths.get(match[1]) ?? []), path]);
			}
		}
	}
	return paths;
}

async function readRolloutSnapshot(home: string, path: string, byteLength: number) {
	await assertCodexStorageWritablePathInsideHome(home, path);
	if (!path.endsWith(".jsonl")) throw new Error("分页 lineage 含未验证的压缩分片，保留原目录。");
	if (byteLength <= 0 || byteLength > (await stat(path)).size)
		throw new Error("分页 lineage 字节边界无效，保留原目录。");
	const hash = createHash("sha256");
	let bytesRead = 0;
	let pending = Buffer.alloc(0);
	let metadata: z.infer<typeof rolloutMetadataSchema> | undefined;
	let nextOrdinal: number | undefined;
	const startedTurnIds = new Set<string>();
	const projectedItemIds = new Set<string>();
	const acceptRecord = (line: Buffer) => {
		let record: unknown;
		try {
			record = JSON.parse(line.toString("utf8"));
		} catch {
			throw new Error("分页 lineage 含无法解析的 JSONL 记录，保留原目录。");
		}
		if (
			record &&
			typeof record === "object" &&
			"type" in record &&
			record.type === "event_msg" &&
			"payload" in record &&
			record.payload &&
			typeof record.payload === "object"
		) {
			const event = record.payload;
			if (
				"type" in event &&
				event.type === "task_started" &&
				"turn_id" in event &&
				typeof event.turn_id === "string"
			)
				startedTurnIds.add(event.turn_id);
			if (
				"item" in event &&
				event.item &&
				typeof event.item === "object" &&
				"id" in event.item &&
				typeof event.item.id === "string"
			)
				projectedItemIds.add(event.item.id);
		}
		if (!metadata) {
			metadata = rolloutMetadataSchema.parse(record);
			nextOrdinal = metadata.ordinal;
		}
		if (nextOrdinal !== undefined) {
			if (!record || typeof record !== "object" || !("ordinal" in record) || record.ordinal !== nextOrdinal)
				throw new Error("分页 lineage 的 ordinal 不连续，保留原目录。");
			nextOrdinal++;
		}
	};
	for await (const chunk of createReadStream(path, { start: 0, end: byteLength - 1 })) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytesRead += bytes.length;
		hash.update(bytes);
		pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
		let start = 0;
		for (let newline = pending.indexOf(0x0a); newline !== -1; newline = pending.indexOf(0x0a, start)) {
			acceptRecord(pending.subarray(start, newline));
			start = newline + 1;
		}
		pending = pending.subarray(start);
		if (pending.length > 4 * 1024 * 1024) throw new Error("分页 lineage 单条记录超过读取预算，保留原目录。");
	}
	if (bytesRead !== byteLength || pending.length || !metadata)
		throw new Error("分页 lineage 未截止于完整 JSONL 记录，保留原目录。");
	if (metadata.payload.history_base && metadata.ordinal !== metadata.payload.history_base.end_ordinal_exclusive)
		throw new Error("分页 lineage 的继承 ordinal 与当前分片不符，保留原目录。");
	return {
		transcriptPath: path,
		rolloutSegmentId: getCodexRolloutSegmentIdFromTranscriptPath(path),
		nativeSessionId: metadata.payload.id,
		byteLength,
		sha256: hash.digest("hex"),
		endOrdinalExclusive: nextOrdinal,
		historyBase: metadata.payload.history_base ?? undefined,
		historyMode: metadata.payload.history_mode,
		startedTurnIds: [...startedTurnIds],
		projectedItemIds: [...projectedItemIds],
	} satisfies CodexPaginatedHistoryRolloutSnapshot;
}

export async function readCodexPaginatedHistoryLineage(home: string, transcriptPath: string, nativeSessionId: string) {
	const currentSize = (await stat(transcriptPath)).size;
	if (currentSize > maximumLineageBytes) throw new Error("分页 lineage 超过字节预算，保留原目录。");
	const current = await readRolloutSnapshot(home, transcriptPath, currentSize);
	if (current.nativeSessionId !== nativeSessionId) throw new Error("当前 rollout 的原生身份不符，未转移历史。");
	const lineage: CodexPaginatedHistoryRolloutSnapshot[] = [current];
	const visited = new Set([current.rolloutSegmentId]);
	const paths = current.historyBase ? await indexRolloutSegmentPaths(home) : new Map<string, string[]>();
	let bytes = current.byteLength;
	let segment = current;
	while (segment.historyBase) {
		const base = segment.historyBase;
		const candidates = paths.get(base.thread_id) ?? [];
		bytes += base.end_byte_offset;
		if (visited.has(base.thread_id) || lineage.length >= maximumLineageSegments || bytes > maximumLineageBytes)
			throw new Error("分页 lineage 循环或超过有界预算，保留原目录。");
		if (candidates.length !== 1) throw new Error("分页 lineage 的来源分片缺失或不唯一，保留原目录。");
		visited.add(base.thread_id);
		segment = await readRolloutSnapshot(home, candidates[0], base.end_byte_offset);
		if (segment.endOrdinalExclusive !== base.end_ordinal_exclusive)
			throw new Error("分页 lineage 的字节与 ordinal 边界不一致，保留原目录。");
		lineage.push(segment);
	}
	return lineage;
}

async function hashRolloutPrefix(path: string, byteLength: number) {
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(path, { start: 0, end: byteLength - 1 })) {
		bytes += chunk.length;
		hash.update(chunk);
	}
	if (bytes !== byteLength) throw new Error("分页 lineage 来源发生截断，未切换绑定。");
	return hash.digest("hex");
}

async function copyRolloutPrefix(
	snapshot: CodexPaginatedHistoryRolloutSnapshot,
	destination: string,
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard,
) {
	writerLockGuard.assertWriterLocksStillValid();
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const pending = `${destination}.${randomUUID()}.pending-write`;
	writerLockGuard.assertWriterLocksStillValid();
	const target = await open(pending, "wx", 0o600);
	try {
		for await (const chunk of createReadStream(snapshot.transcriptPath, { start: 0, end: snapshot.byteLength - 1 })) {
			writerLockGuard.assertWriterLocksStillValid();
			await target.writeFile(chunk);
		}
	} finally {
		await target.close();
	}
	if (
		(await hashRolloutPrefix(pending, snapshot.byteLength)) !== snapshot.sha256 ||
		(await hashRolloutPrefix(snapshot.transcriptPath, snapshot.byteLength)) !== snapshot.sha256
	)
		throw new Error("分页 lineage 前缀在复制期间发生变化，未切换绑定。");
	writerLockGuard.assertWriterLocksStillValid();
	await rename(pending, destination);
	writerLockGuard.assertWriterLocksStillValid();
}

function quoteIdentifier(value: string) {
	return `"${value.replaceAll('"', '""')}"`;
}
function serializeRow(row: Record<string, unknown>) {
	return JSON.stringify(row);
}

export function readBoundedCodexHistoryProjectionRows(
	database: Database.Database,
	tableName: string,
	snapshot: CodexPaginatedHistoryRolloutSnapshot,
) {
	if (snapshot.endOrdinalExclusive === undefined) throw new Error("分页读取依赖缺少 ordinal 边界。");
	const name = quoteIdentifier(tableName);
	const columns = database.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
	if (!columns.some((column) => column.name === "thread_id")) return [];
	const projectionState = tableName === "thread_history_projection_state";
	if (!projectionState && !columns.some((column) => column.name === "rollout_ordinal"))
		throw new Error("分页历史投影缺少有界读取所需的 ordinal，保留原目录。");
	const rows = database
		.prepare(`SELECT * FROM ${name} WHERE thread_id = ?${projectionState ? "" : " AND rollout_ordinal < ?"}`)
		.all(
			...(projectionState ? [snapshot.rolloutSegmentId] : [snapshot.rolloutSegmentId, snapshot.endOrdinalExclusive]),
		) as Record<string, unknown>[];
	return rows.map((row) =>
		projectionState
			? { ...row, next_rollout_byte_offset: snapshot.byteLength, next_rollout_ordinal: snapshot.endOrdinalExclusive }
			: row,
	);
}

function copyBoundedHistoryProjectionRows(input: {
	sourceHome: string;
	targetHome: string;
	snapshots: CodexPaginatedHistoryRolloutSnapshot[];
	ownedNativeSessionIds: readonly string[];
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard;
}) {
	if (!input.snapshots.length) return;
	const source = new Database(join(input.sourceHome, "thread_history_1.sqlite"), {
		readonly: true,
		fileMustExist: true,
	});
	const target = new Database(join(input.targetHome, "thread_history_1.sqlite"), { fileMustExist: true });
	try {
		source.exec("BEGIN");
		input.writerLockGuard.assertWriterLocksStillValid();
		target.transaction(() => {
			for (const snapshot of input.snapshots) {
				if (snapshot.endOrdinalExclusive === undefined) throw new Error("分页读取依赖缺少 ordinal 边界。");
				for (const table of [
					"thread_turns",
					"thread_items",
					"thread_realtime_items",
					"thread_history_projection_state",
				]) {
					const name = quoteIdentifier(table);
					const columns = source.prepare(`PRAGMA table_info(${name})`).all() as { name: string; pk: number }[];
					if (!columns.length) continue;
					const projectionState = table === "thread_history_projection_state";
					const rows = readBoundedCodexHistoryProjectionRows(source, table, snapshot);
					for (const original of rows) {
						const row = { ...original };
						if (projectionState) {
							row.next_rollout_byte_offset = snapshot.byteLength;
							row.next_rollout_ordinal = snapshot.endOrdinalExclusive;
						}
						const primaryKeys = columns.filter((column) => column.pk).sort((left, right) => left.pk - right.pk);
						const predicate = primaryKeys.map((column) => `${quoteIdentifier(column.name)} = ?`).join(" AND ");
						const values = primaryKeys.map((column) => row[column.name]);
						const saved = target.prepare(`SELECT * FROM ${name} WHERE ${predicate}`).get(...values) as
							| Record<string, unknown>
							| undefined;
						if (saved) {
							if (
								projectionState &&
								typeof saved.next_rollout_ordinal === "number" &&
								(saved.next_rollout_ordinal > snapshot.endOrdinalExclusive ||
									(saved.next_rollout_ordinal === snapshot.endOrdinalExclusive &&
										saved.next_rollout_byte_offset === snapshot.byteLength))
							)
								continue;
							if (serializeRow(saved) === serializeRow(row)) continue;
							if (projectionState && input.ownedNativeSessionIds.includes(snapshot.nativeSessionId))
								target.prepare(`DELETE FROM ${name} WHERE ${predicate}`).run(...values);
							else throw new Error("目标已有不同的分页读取依赖，拒绝覆盖祖先历史。");
						}
						input.writerLockGuard.assertWriterLocksStillValid();
						const keys = Object.keys(row);
						target
							.prepare(
								`INSERT INTO ${name} (${keys.map(quoteIdentifier).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
							)
							.run(...keys.map((key) => row[key]));
					}
				}
			}
			input.writerLockGuard.assertWriterLocksStillValid();
		})();
	} finally {
		source.close();
		target.close();
	}
}

async function writeCodexReadDependencyProvenanceRecord(input: {
	sourceHome: string;
	targetHome: string;
	snapshot: CodexPaginatedHistoryRolloutSnapshot;
	destination: string;
	stage: "copy_started" | "copied";
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard;
}) {
	const path = `${input.destination}${readDependencyRecordSuffix}`;
	await assertCodexStorageWritablePathInsideHome(input.targetHome, path);
	const record = {
		schemaVersion: 1 as const,
		sourceHomeDirectoryPath: resolve(input.sourceHome),
		nativeSessionId: input.snapshot.nativeSessionId,
		rolloutSegmentId: input.snapshot.rolloutSegmentId,
		copiedPrefixByteLength: input.snapshot.byteLength,
		copiedPrefixSha256: input.snapshot.sha256,
	};
	try {
		const { stage: _stage, ...existing } = readDependencyRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
		if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("读取依赖的来源凭据冲突，保留现场。");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	input.writerLockGuard.assertWriterLocksStillValid();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const pending = `${path}.${randomUUID()}.pending-write`;
	input.writerLockGuard.assertWriterLocksStillValid();
	await writeFile(pending, JSON.stringify({ ...record, stage: input.stage }), { mode: 0o600 });
	input.writerLockGuard.assertWriterLocksStillValid();
	await rename(pending, path);
	input.writerLockGuard.assertWriterLocksStillValid();
}

export async function copyCodexPaginatedHistoryReadDependencies(input: {
	sourceHome: string;
	targetHome: string;
	lineage: CodexPaginatedHistoryRolloutSnapshot[];
	ownedNativeSessionIds: readonly string[];
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard;
}) {
	const dependencies = input.lineage.slice(1);
	if (!dependencies.length) return;
	const existingPaths = await indexRolloutSegmentPaths(input.targetHome);
	const newlyCopiedDependencies: { snapshot: CodexPaginatedHistoryRolloutSnapshot; destination: string }[] = [];
	for (const snapshot of [...dependencies].reverse()) {
		const candidates = existingPaths.get(snapshot.rolloutSegmentId) ?? [];
		if (candidates.length > 1) throw new Error("目标分页读取依赖不唯一，拒绝覆盖。");
		const existing = candidates[0];
		const destination =
			existing ??
			join(input.targetHome, "archived_sessions", readDependencyDirectoryName, basename(snapshot.transcriptPath));
		await assertCodexStorageWritablePathInsideHome(input.targetHome, destination);
		if (
			existing &&
			dirname(resolve(existing)) === resolve(input.targetHome, "archived_sessions", readDependencyDirectoryName)
		) {
			try {
				await assertCodexStorageWritablePathInsideHome(
					input.targetHome,
					`${existing}${readDependencyRecordSuffix}`,
				);
				const marker = readDependencyRecordSchema.parse(
					JSON.parse(await readFile(`${existing}${readDependencyRecordSuffix}`, "utf8")),
				);
				if (
					marker.stage === "copy_started" &&
					marker.sourceHomeDirectoryPath === resolve(input.sourceHome) &&
					marker.nativeSessionId === snapshot.nativeSessionId &&
					marker.rolloutSegmentId === snapshot.rolloutSegmentId &&
					marker.copiedPrefixByteLength === snapshot.byteLength &&
					marker.copiedPrefixSha256 === snapshot.sha256
				)
					newlyCopiedDependencies.push({ snapshot, destination });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (existing) {
			const size = (await stat(existing)).size;
			if (
				(await hashRolloutPrefix(existing, Math.min(size, snapshot.byteLength))) !==
				(await hashRolloutPrefix(snapshot.transcriptPath, Math.min(size, snapshot.byteLength)))
			)
				throw new Error("目标分页读取依赖的冻结前缀不同，拒绝覆盖祖先历史。");
			if (size >= snapshot.byteLength) continue;
			if (!input.ownedNativeSessionIds.includes(snapshot.nativeSessionId))
				throw new Error("目标祖先读取依赖不完整，保留其独立历史，未切换绑定。");
		}
		if (!existing)
			await writeCodexReadDependencyProvenanceRecord({ ...input, snapshot, destination, stage: "copy_started" });
		await copyRolloutPrefix(snapshot, destination, input.writerLockGuard);
		if (!existing) newlyCopiedDependencies.push({ snapshot, destination });
	}
	// 读取依赖只复制历史投影；不携带祖先的 goals、queue、工具或执行关系。
	copyBoundedHistoryProjectionRows({ ...input, snapshots: dependencies });
	for (const { snapshot, destination } of newlyCopiedDependencies)
		await writeCodexReadDependencyProvenanceRecord({ ...input, snapshot, destination, stage: "copied" });
}

export function assertCodexNativeTurnsCoverCapturedPaginatedHistory(
	lineage: CodexPaginatedHistoryRolloutSnapshot[],
	turns: readonly CodexNativeConversationTurn[],
) {
	if (lineage[0]?.historyMode !== "paginated") return;
	const expectedTurnIds = new Set(lineage.flatMap((segment) => segment.startedTurnIds));
	const expectedItemIds = new Set(lineage.flatMap((segment) => segment.projectedItemIds));
	const actualTurnIds = new Set(turns.map((turn) => turn.id));
	const actualItemIds = new Set(turns.flatMap((turn) => turn.items.map((item) => item.id)));
	if (
		turns.length !== expectedTurnIds.size ||
		[...expectedTurnIds].some((id) => !actualTurnIds.has(id)) ||
		[...expectedItemIds].some((id) => !actualItemIds.has(id))
	)
		throw new Error("原生分页读取未覆盖完整 rollout lineage 的回合或历史项，未切换绑定。");
}

export async function assertCodexReadDependencyCanBecomeOwnedConversation(input: {
	sourceHome: string;
	targetHome: string;
	nativeSessionId: string;
	targetThreadRow: Record<string, unknown>;
}) {
	const path = input.targetThreadRow.rollout_path;
	const managedDirectory = join(input.targetHome, "archived_sessions", readDependencyDirectoryName);
	if (
		input.targetThreadRow.archived !== 1 ||
		typeof path !== "string" ||
		dirname(resolve(path)) !== resolve(managedDirectory)
	)
		throw new Error("目标已有同 ID 独立会话且没有迁移记录，拒绝覆盖。");
	const markerPath = `${path}${readDependencyRecordSuffix}`;
	await assertCodexStorageWritablePathInsideHome(input.targetHome, markerPath);
	let marker: z.infer<typeof readDependencyRecordSchema>;
	try {
		marker = readDependencyRecordSchema.parse(JSON.parse(await readFile(markerPath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error("目标同 ID 记录缺少可验证的读取依赖来源凭据，拒绝晋升。");
		throw error;
	}
	if (
		marker.stage !== "copied" ||
		marker.nativeSessionId !== input.nativeSessionId ||
		resolve(marker.sourceHomeDirectoryPath) !== resolve(input.sourceHome) ||
		marker.rolloutSegmentId !== getCodexRolloutSegmentIdFromTranscriptPath(path)
	)
		throw new Error("目标读取依赖的来源身份不符，拒绝晋升。");
	await assertCodexStorageWritablePathInsideHome(input.targetHome, path);
	if (
		(await stat(path)).size !== marker.copiedPrefixByteLength ||
		(await hashRolloutPrefix(path, marker.copiedPrefixByteLength)) !== marker.copiedPrefixSha256
	)
		throw new Error("目标祖先副本已有独有内容，拒绝覆盖晋升。");
	const sourceCandidates = (await indexRolloutSegmentPaths(input.sourceHome)).get(marker.rolloutSegmentId) ?? [];
	if (sourceCandidates.length !== 1) throw new Error("无法证明读取依赖的原始来源，拒绝晋升。");
	const snapshot = await readRolloutSnapshot(input.sourceHome, sourceCandidates[0], marker.copiedPrefixByteLength);
	if (snapshot.nativeSessionId !== input.nativeSessionId || snapshot.sha256 !== marker.copiedPrefixSha256)
		throw new Error("读取依赖与原始来源前缀不同，拒绝晋升。");
	const history = new Database(join(input.targetHome, "thread_history_1.sqlite"), {
		readonly: true,
		fileMustExist: true,
	});
	const source = new Database(join(input.sourceHome, "thread_history_1.sqlite"), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		for (const table of history.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
			name: string;
		}[]) {
			const name = quoteIdentifier(table.name);
			const columns = history.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
			if (!columns.some((column) => column.name === "thread_id")) continue;
			const allowed = new Set(readBoundedCodexHistoryProjectionRows(source, table.name, snapshot).map(serializeRow));
			const rows = history
				.prepare(`SELECT * FROM ${name} WHERE thread_id = ?`)
				.all(marker.rolloutSegmentId) as Record<string, unknown>[];
			if (rows.some((row) => !allowed.has(serializeRow(row))))
				throw new Error("目标读取依赖有独有历史行，拒绝晋升。");
		}
	} finally {
		history.close();
		source.close();
	}
	for (const databaseName of ["state_5.sqlite", "goals_1.sqlite", "queue_1.sqlite"]) {
		try {
			await stat(join(input.targetHome, databaseName));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const database = new Database(join(input.targetHome, databaseName), { readonly: true, fileMustExist: true });
		try {
			for (const table of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]) {
				if (table.name === "threads") continue;
				const name = quoteIdentifier(table.name);
				const columns = database.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
				const keys = columns.filter((column) =>
					["thread_id", "parent_thread_id", "child_thread_id"].includes(column.name),
				);
				if (
					keys.length &&
					database
						.prepare(
							`SELECT 1 FROM ${name} WHERE ${keys.map((key) => `${quoteIdentifier(key.name)} = ?`).join(" OR ")} LIMIT 1`,
						)
						.get(...keys.map(() => input.nativeSessionId))
				)
					throw new Error("目标祖先已有独立运行状态，拒绝覆盖晋升。");
			}
		} finally {
			database.close();
		}
	}
	return path;
}

export async function retireCodexReadDependencyAfterOwnedConversationCopy(input: {
	targetHome: string;
	promotedTranscriptPath: string;
	backupDirectoryPath: string;
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard;
}) {
	const path = input.promotedTranscriptPath;
	if (dirname(resolve(path)) !== resolve(input.targetHome, "archived_sessions", readDependencyDirectoryName))
		throw new Error("待晋升读取依赖不属于受管目录，已保留现场。");
	await assertCodexStorageWritablePathInsideHome(input.targetHome, path);
	const backup = join(input.backupDirectoryPath, "read-dependency-before-promotion", basename(path));
	input.writerLockGuard.assertWriterLocksStillValid();
	await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
	for (const suffix of ["", readDependencyRecordSuffix]) {
		input.writerLockGuard.assertWriterLocksStillValid();
		try {
			await rename(`${path}${suffix}`, `${backup}${suffix}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await stat(`${backup}${suffix}`);
		}
		input.writerLockGuard.assertWriterLocksStillValid();
	}
}
