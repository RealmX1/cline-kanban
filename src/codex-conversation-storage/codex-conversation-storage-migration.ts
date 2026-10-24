import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { parse } from "smol-toml";
import { z } from "zod";
import { withCodexAppServerRequestConnection } from "../rvf-automatic-closeout/codex-app-server-request-connection";
import { readCodexConversationTurns } from "../rvf-automatic-closeout/codex-native-conversation-prefix";
import {
	assertCodexStorageWritablePathInsideHome,
	getCodexConversationMigrationRecordPath,
	prepareManagedCodexConversationStorageHome,
	withCodexConversationStorageOperationLock,
} from "./codex-conversation-storage-home";
import {
	type CodexNativeConversationFamilyWriterLockGuard,
	withStoppedCodexNativeConversationFamilyWriterLocks,
} from "./codex-native-thread-writer-lock";

import {
	assertCodexNativeTurnsCoverCapturedPaginatedHistory,
	assertCodexReadDependencyCanBecomeOwnedConversation,
	copyCodexPaginatedHistoryReadDependencies,
	getCodexRolloutSegmentIdFromTranscriptPath,
	readBoundedCodexHistoryProjectionRows,
	readCodexPaginatedHistoryLineage,
	retireCodexReadDependencyAfterOwnedConversationCopy,
} from "./codex-paginated-history-lineage";

const runExecutable = promisify(execFile);
const nativeIdSchema = z.string().uuid();
const migrationRecordSchema = z.object({
	schemaVersion: z.literal(1),
	nativeSessionId: nativeIdSchema,
	sourceHomeDirectoryPath: z.string(),
	targetHomeDirectoryPath: z.string(),
	sourceTranscriptPath: z.string(),
	targetTranscriptPath: z.string(),
	backupDirectoryPath: z.string(),
	transcriptSha256: z.string(),
	sourceWasArchived: z.boolean().optional(),
	readDependencyPromotedFromTranscriptPath: z.string().optional(),
	stage: z.enum(["copy_started", "copied", "bound", "source_archived", "rolled_back"]),
	familyNativeSessionIds: z.array(nativeIdSchema).optional(),
	familyRootNativeSessionId: nativeIdSchema.optional(),
	updatedAt: z.number(),
});
type MigrationRecord = z.infer<typeof migrationRecordSchema>;
type SqliteRow = Record<string, unknown>;
const relatedStateTables = new Set([
	"threads",
	"thread_dynamic_tools",
	"thread_attachments",
	"guardian_review_feedback",
	"thread_read_receipts",
]);
const migrationDatabaseNames = ["state_5.sqlite", "thread_history_1.sqlite", "goals_1.sqlite", "queue_1.sqlite"];

async function assertSupportedNativeCodexVersion(binary: string) {
	const version = await runExecutable(binary, ["--version"], { timeout: 5_000 });
	if (version.stdout.trim() !== "codex-cli 0.164.0")
		throw new Error("历史迁移与回退仅验证了 Codex 0.164.0，当前版本未通过兼容校验。");
}

async function assertCodexSqliteStorageIsInsideRecordedHome(home: string) {
	let configuration: Record<string, unknown> = {};
	try {
		configuration = parse(await readFile(join(home, "config.toml"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const inspect = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (key === "sqlite_home" && typeof child === "string" && resolve(home, child) !== resolve(home))
				throw new Error("Codex 配置使用独立 sqlite_home，无法确认历史数据库归属，未自动迁移。");
			inspect(child);
		}
	};
	inspect(configuration);
	if (process.env.CODEX_SQLITE_HOME?.trim() && resolve(process.env.CODEX_SQLITE_HOME.trim()) !== resolve(home))
		throw new Error("运行环境使用独立 CODEX_SQLITE_HOME，无法确认历史数据库归属，未自动迁移。");
}

async function assertDatabasePathsAreNotSharedLinks(home: string) {
	for (const name of migrationDatabaseNames)
		for (const suffix of ["", "-wal", "-shm"])
			await assertCodexStorageWritablePathInsideHome(home, join(home, `${name}${suffix}`));
}

async function assertFileIsPrefixOfSource(targetPath: string, sourcePath: string) {
	const target = await open(targetPath, "r");
	const source = await open(sourcePath, "r");
	try {
		if ((await target.stat()).size > (await source.stat()).size)
			throw new Error("目标转录含有来源没有的历史，拒绝覆盖重试。");
		const left = Buffer.alloc(64 * 1024);
		const right = Buffer.alloc(left.length);
		let position = 0;
		while (true) {
			const { bytesRead } = await target.read(left, 0, left.length, position);
			if (!bytesRead) return;
			const next = await source.read(right, 0, bytesRead, position);
			if (next.bytesRead !== bytesRead || !left.subarray(0, bytesRead).equals(right.subarray(0, bytesRead)))
				throw new Error("目标转录含有来源没有的历史，拒绝覆盖重试。");
			position += bytesRead;
		}
	} finally {
		await target.close();
		await source.close();
	}
}

function quoteSqliteIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`;
}
async function hashFile(path: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
function serializeSqliteRow(row: SqliteRow) {
	return JSON.stringify(row, (_key, value) => (Buffer.isBuffer(value) ? value.toString("hex") : value));
}

async function writeMigrationRecord(
	path: string,
	record: MigrationRecord,
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard,
) {
	writerLockGuard.assertWriterLocksStillValid();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const pendingPath = `${path}.${randomUUID()}.pending-write`;
	writerLockGuard.assertWriterLocksStillValid();
	await writeFile(pendingPath, JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
	writerLockGuard.assertWriterLocksStillValid();
	await rename(pendingPath, path);
	writerLockGuard.assertWriterLocksStillValid();
}

export async function readCodexConversationStorageMigrationRecord(home: string, nativeSessionId: string) {
	try {
		const record = migrationRecordSchema.parse(
			JSON.parse(await readFile(getCodexConversationMigrationRecordPath(home, nativeSessionId), "utf8")),
		);
		if (record.nativeSessionId !== nativeSessionId || resolve(record.sourceHomeDirectoryPath) !== resolve(home))
			throw new Error("迁移记录的原生身份或来源目录不符，已保留现场。");
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function readNativeThreadRow(home: string, nativeSessionId: string) {
	const database = new Database(join(home, "state_5.sqlite"), { readonly: true, fileMustExist: true });
	try {
		const row = database.prepare("SELECT * FROM threads WHERE id = ?").get(nativeSessionId) as SqliteRow | undefined;
		if (!row || typeof row.rollout_path !== "string") throw new Error("未找到身份匹配的 Codex 会话记录。");
		return row;
	} finally {
		database.close();
	}
}

async function readExistingUncommittedCodexConversationTranscriptPath(home: string, nativeSessionId: string) {
	try {
		await stat(join(home, "state_5.sqlite"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const database = new Database(join(home, "state_5.sqlite"), { readonly: true, fileMustExist: true });
	try {
		const row = database.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(nativeSessionId) as
			| SqliteRow
			| undefined;
		if (!row) return undefined;
		if (typeof row.rollout_path !== "string") throw new Error("未提交目标的 rollout 路径未知，保留现场。");
		assertTranscriptInsideCodexHome(home, row.rollout_path);
		await assertCodexStorageWritablePathInsideHome(home, row.rollout_path);
		return row.rollout_path;
	} finally {
		database.close();
	}
}

function assertTranscriptInsideCodexHome(home: string, path: string) {
	const child = relative(resolve(home), resolve(path));
	if (
		isAbsolute(child) ||
		child.startsWith(`..${sep}`) ||
		child === ".." ||
		!["sessions", "archived_sessions"].includes(child.split(sep)[0] ?? "")
	)
		throw new Error("原生转录不在已绑定的 Codex 存储目录中，未迁移。");
	return child;
}

function selectConversationTableRows(
	source: Database.Database,
	databaseName: string,
	tableName: string,
	nativeSessionId: string,
) {
	const identifier = quoteSqliteIdentifier(tableName);
	const migrations = tableName === "_sqlx_migrations";
	const edges = tableName === "thread_spawn_edges";
	const key = tableName === "threads" ? "id" : "thread_id";
	const columns = source.prepare(`PRAGMA table_info(${identifier})`).all() as { name: string; pk: number }[];
	if (
		!migrations &&
		!edges &&
		(!columns.some((column) => column.name === key) ||
			(databaseName === "state_5.sqlite" && !relatedStateTables.has(tableName)))
	)
		return null;
	const predicate = migrations
		? ""
		: edges
			? " WHERE parent_thread_id = ? OR child_thread_id = ?"
			: ` WHERE ${quoteSqliteIdentifier(key)} = ?`;
	const parameters = migrations ? [] : edges ? [nativeSessionId, nativeSessionId] : [nativeSessionId];
	return {
		identifier,
		predicate,
		parameters,
		columns,
		rows: source.prepare(`SELECT * FROM ${identifier}${predicate}`).all(...parameters) as SqliteRow[],
	};
}

async function assertUnboundTargetHasNoIndependentHistory(record: MigrationRecord) {
	let targetLineage: Awaited<ReturnType<typeof readCodexPaginatedHistoryLineage>> = [];
	try {
		await assertFileIsPrefixOfSource(record.targetTranscriptPath, record.sourceTranscriptPath);
		targetLineage = await readCodexPaginatedHistoryLineage(
			record.targetHomeDirectoryPath,
			record.targetTranscriptPath,
			record.nativeSessionId,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const name of migrationDatabaseNames) {
		try {
			await stat(join(record.targetHomeDirectoryPath, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const target = new Database(join(record.targetHomeDirectoryPath, name), { readonly: true });
		let source: Database.Database | undefined;
		let backup: Database.Database | undefined;
		try {
			source = new Database(join(record.sourceHomeDirectoryPath, name), { readonly: true, fileMustExist: true });
			try {
				backup = new Database(join(record.backupDirectoryPath, name), { readonly: true, fileMustExist: true });
			} catch {
				// 尚未写过该数据库时可能没有快照；此时目标只能是来源的完整子集。
			}
			const tables = target.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[];
			for (const table of tables) {
				if (["threads", "_sqlx_migrations", "sqlite_sequence"].includes(table.name)) continue;
				if (name === "thread_history_1.sqlite" && targetLineage[0]?.historyMode === "paginated") {
					for (const snapshot of targetLineage) {
						const targetRows = readBoundedCodexHistoryProjectionRows(target, table.name, snapshot);
						const allowedRows = new Set(
							[
								...readBoundedCodexHistoryProjectionRows(source, table.name, snapshot),
								...(backup ? readBoundedCodexHistoryProjectionRows(backup, table.name, snapshot) : []),
							].map(serializeSqliteRow),
						);
						if (targetRows.some((row) => !allowedRows.has(serializeSqliteRow(row))))
							throw new Error("目标数据库含有来源和迁移快照没有的历史，拒绝覆盖重试。");
					}
					continue;
				}
				const historyId =
					name === "thread_history_1.sqlite"
						? getCodexRolloutSegmentIdFromTranscriptPath(record.sourceTranscriptPath)
						: record.nativeSessionId;
				const selection = selectConversationTableRows(target, name, table.name, historyId);
				if (!selection || !selection.rows.length) continue;
				const originalRows = selectConversationTableRows(source, name, table.name, historyId)?.rows ?? [];
				const backedUpRows = backup
					? (selectConversationTableRows(backup, name, table.name, historyId)?.rows ?? [])
					: [];
				const allowedRows = new Set([...originalRows, ...backedUpRows].map(serializeSqliteRow));
				if (selection.rows.some((row) => !allowedRows.has(serializeSqliteRow(row))))
					throw new Error("目标数据库含有来源和迁移快照没有的历史，拒绝覆盖重试。");
			}
		} finally {
			source?.close();
			backup?.close();
			target.close();
		}
	}
}

async function assertCopiedHistoryMatchesSource(record: MigrationRecord) {
	const currentPath = String(readNativeThreadRow(record.sourceHomeDirectoryPath, record.nativeSessionId).rollout_path);
	if ((await hashFile(currentPath)) !== (await hashFile(record.targetTranscriptPath)))
		throw new Error("原生归档交接期间来源产生了新历史，未切换绑定；请停止全部写入后重试。");
	for (const name of migrationDatabaseNames) {
		try {
			await stat(join(record.sourceHomeDirectoryPath, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const source = new Database(join(record.sourceHomeDirectoryPath, name), { readonly: true });
		const target = new Database(join(record.targetHomeDirectoryPath, name), { readonly: true, fileMustExist: true });
		try {
			const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[];
			for (const table of tables) {
				if (["threads", "_sqlx_migrations", "sqlite_sequence"].includes(table.name)) continue;
				const historyId =
					name === "thread_history_1.sqlite"
						? getCodexRolloutSegmentIdFromTranscriptPath(currentPath)
						: record.nativeSessionId;
				const original = selectConversationTableRows(source, name, table.name, historyId);
				if (!original) continue;
				const copied = selectConversationTableRows(target, name, table.name, historyId);
				if (
					JSON.stringify(original.rows.map(serializeSqliteRow).sort()) !==
					JSON.stringify(copied?.rows.map(serializeSqliteRow).sort())
				)
					throw new Error("原生归档交接期间数据库历史有变化，未切换绑定；请停止全部写入后重试。");
			}
		} finally {
			source.close();
			target.close();
		}
	}
}

async function transferConversationDatabases(input: {
	sourceHome: string;
	targetHome: string;
	nativeSessionId: string;
	targetTranscriptPath: string;
	backupDirectoryPath: string;
	replaceExisting: boolean;
	historyRolloutSegmentId?: string;
	archiveRestoredConversation?: boolean;
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard;
}) {
	input.writerLockGuard.assertWriterLocksStillValid();
	await mkdir(input.backupDirectoryPath, { recursive: true, mode: 0o700 });
	for (const name of migrationDatabaseNames) {
		const sourcePath = join(input.sourceHome, name);
		const historyId =
			name === "thread_history_1.sqlite"
				? (input.historyRolloutSegmentId ?? input.nativeSessionId)
				: input.nativeSessionId;
		try {
			await stat(sourcePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && name !== "state_5.sqlite") continue;
			throw error;
		}
		input.writerLockGuard.assertWriterLocksStillValid();
		const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
		const target = new Database(join(input.targetHome, name));
		try {
			source.exec("BEGIN");
			const tables = source
				.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'")
				.all() as { name: string; sql: string }[];
			const backupPath = join(input.backupDirectoryPath, name);
			try {
				await stat(backupPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				// 从 SQLite 一致快照导出本会话，包含 WAL，不复制其他任务历史。
				input.writerLockGuard.assertWriterLocksStillValid();
				const backup = new Database(backupPath);
				try {
					backup.pragma("foreign_keys = OFF");
					backup.transaction(() => {
						for (const table of tables) backup.exec(table.sql);
						for (const table of tables) {
							const selection = selectConversationTableRows(source, name, table.name, historyId);
							if (!selection) continue;
							for (const row of selection.rows)
								backup
									.prepare(
										`INSERT INTO ${selection.identifier} VALUES (${Object.keys(row)
											.map(() => "?")
											.join(",")})`,
									)
									.run(...Object.values(row));
						}
					})();
				} finally {
					backup.close();
				}
			}
			input.writerLockGuard.assertWriterLocksStillValid();
			target.transaction(() => {
				for (const table of tables) {
					const existing = target
						.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
						.get(table.name) as { sql: string } | undefined;
					if (!existing) target.exec(table.sql);
					else if (existing.sql !== table.sql) throw new Error(`Codex 数据库结构不一致：${name}/${table.name}`);
				}
				for (const index of source
					.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL")
					.all() as { name: string; sql: string }[])
					if (!target.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(index.name))
						target.exec(index.sql);
				const sourceMigrations = source
					.prepare("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
					.all() as SqliteRow[];
				const targetMigrations = target
					.prepare("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
					.all() as SqliteRow[];
				if (
					targetMigrations.length &&
					JSON.stringify(sourceMigrations.map(serializeSqliteRow)) !==
						JSON.stringify(targetMigrations.map(serializeSqliteRow))
				)
					throw new Error(`Codex 数据库迁移版本不一致：${name}`);
				const previousAppMetadata =
					name === "state_5.sqlite" && input.replaceExisting
						? (target.prepare("SELECT * FROM threads WHERE id = ?").get(input.nativeSessionId) as
								| SqliteRow
								| undefined)
						: undefined;
				for (const table of tables) {
					if (table.name === "_sqlx_migrations" && targetMigrations.length) continue;
					const selection = selectConversationTableRows(source, name, table.name, historyId);
					if (!selection) continue;
					const { identifier, predicate, parameters, columns, rows } = selection;
					if (input.replaceExisting && predicate)
						target.prepare(`DELETE FROM ${identifier}${predicate}`).run(...parameters);
					for (const original of rows) {
						const row = { ...original };
						if (table.name === "threads") {
							row.rollout_path = input.targetTranscriptPath;
							row.archived = input.archiveRestoredConversation ? 1 : 0;
							row.archived_at = null;
							for (const key of ["project_id", "thread_section_id", "section_position", "section_entered_at_ms"])
								if (key in row) row[key] = previousAppMetadata?.[key] ?? null;
						}
						const keys = Object.keys(row);
						const inserted = target
							.prepare(
								`INSERT OR IGNORE INTO ${identifier} (${keys.map(quoteSqliteIdentifier).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
							)
							.run(...keys.map((column) => row[column]));
						if (!inserted.changes) {
							const primaryKeys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
							const saved = target
								.prepare(
									`SELECT * FROM ${identifier} WHERE ${primaryKeys.map((column) => `${quoteSqliteIdentifier(column.name)} = ?`).join(" AND ")}`,
								)
								.get(...primaryKeys.map((column) => row[column.name])) as SqliteRow | undefined;
							if (!saved || serializeSqliteRow(saved) !== serializeSqliteRow(row))
								throw new Error("目标会话已有不同内容，拒绝覆盖。");
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
}

function listNativeConversationFamily(home: string, nativeSessionId: string) {
	const database = new Database(join(home, "state_5.sqlite"), { readonly: true, fileMustExist: true });
	try {
		if (database.prepare("SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = ?").get(nativeSessionId))
			throw new Error("此会话属于另一原生主会话族，请从主会话迁移，避免切断父子关系。");
		const family = [nativeSessionId];
		const visited = new Set(family);
		for (let index = 0; index < family.length; index++) {
			const children = database
				.prepare("SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?")
				.all(family[index]) as { child_thread_id: string }[];
			for (const child of children) {
				nativeIdSchema.parse(child.child_thread_id);
				if (visited.has(child.child_thread_id)) throw new Error("原生父子图出现循环，未迁移。");
				visited.add(child.child_thread_id);
				family.push(child.child_thread_id);
				if (family.length > 1000) throw new Error("原生会话族过大，未自动迁移。");
			}
		}
		return family;
	} finally {
		database.close();
	}
}

async function withConversationFamilyLocks<T>(
	home: string,
	ids: string[],
	operation: (writerLockGuard: CodexNativeConversationFamilyWriterLockGuard) => Promise<T>,
): Promise<T> {
	return withStoppedCodexNativeConversationFamilyWriterLocks(home, ids, operation);
}

function combineCodexNativeWriterLockGuards(
	...writerLockGuards: readonly CodexNativeConversationFamilyWriterLockGuard[]
): CodexNativeConversationFamilyWriterLockGuard {
	return {
		assertWriterLocksStillValid() {
			for (const writerLockGuard of writerLockGuards) writerLockGuard.assertWriterLocksStillValid();
		},
	};
}

async function withFamilyOperationLocks<T>(home: string, ids: string[], operation: () => Promise<T>): Promise<T> {
	const visit = (index: number): Promise<T> =>
		index === ids.length
			? operation()
			: withCodexConversationStorageOperationLock(home, ids[index], () => visit(index + 1));
	return visit(0);
}

async function verifyCopiedNativeConversation(
	binary: string,
	home: string,
	record: MigrationRecord,
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard,
	expectedHome = record.sourceHomeDirectoryPath,
) {
	writerLockGuard.assertWriterLocksStillValid();
	const connectionArguments = (storageHome: string) => ({
		binary,
		workingDirectory: storageHome,
		codexConversationStorageHomeDirectoryPath: storageHome,
		argumentsBeforeSubcommand: ["--disable", "memories", "--disable", "background_paginated_rollout_migration"],
	});
	const expectedLineage = await readCodexPaginatedHistoryLineage(
		expectedHome,
		String(readNativeThreadRow(expectedHome, record.nativeSessionId).rollout_path),
		record.nativeSessionId,
	);
	const expectedTurns = await withCodexAppServerRequestConnection(connectionArguments(expectedHome), (port) =>
		readCodexConversationTurns(port, record.nativeSessionId),
	);
	assertCodexNativeTurnsCoverCapturedPaginatedHistory(expectedLineage, expectedTurns);
	await withCodexAppServerRequestConnection(connectionArguments(home), async (port) => {
		const response = z
			.object({ thread: z.object({ id: z.string(), path: z.string().nullish() }) })
			.parse(await port.request("thread/read", { threadId: record.nativeSessionId }));
		if (
			response.thread.id !== record.nativeSessionId ||
			!response.thread.path ||
			(await realpath(response.thread.path)) !== (await realpath(record.targetTranscriptPath))
		)
			throw new Error("原生接口返回的会话身份或转录目录不符，未切换绑定。");
		writerLockGuard.assertWriterLocksStillValid();
		const actualTurns = await readCodexConversationTurns(port, record.nativeSessionId);
		// 原生完整历史包含 history_base 继承前缀；本线程局部数据库行数不是完整性基准。
		if (JSON.stringify(actualTurns) !== JSON.stringify(expectedTurns))
			throw new Error("分页回合或历史项核验不完整，保留原目录。");
	});
	writerLockGuard.assertWriterLocksStillValid();
}

async function changeNativeConversationArchiveState(
	binary: string,
	home: string,
	nativeSessionIds: string[],
	method: "thread/archive" | "thread/unarchive",
	writerLockGuard: CodexNativeConversationFamilyWriterLockGuard,
) {
	writerLockGuard.assertWriterLocksStillValid();
	await withCodexAppServerRequestConnection(
		{
			binary,
			workingDirectory: home,
			codexConversationStorageHomeDirectoryPath: home,
			argumentsBeforeSubcommand: ["--disable", "memories", "--disable", "background_paginated_rollout_migration"],
		},
		async (port) => {
			for (const nativeSessionId of nativeSessionIds) {
				writerLockGuard.assertWriterLocksStillValid();
				await port.request(method, { threadId: nativeSessionId });
			}
		},
	);
	writerLockGuard.assertWriterLocksStillValid();
}

export interface StoppedCodexConversationStorageMigrationInput {
	sourceHomeDirectoryPath: string;
	nativeSessionId: string;
	workingDirectoryPath: string;
	assertSessionStillStopped: () => void | Promise<void>;
	binary?: string;
	taskCardCreatedAtMs?: number;
}

export async function migrateStoppedCodexConversationStorage(input: StoppedCodexConversationStorageMigrationInput) {
	nativeIdSchema.parse(input.nativeSessionId);
	await input.assertSessionStillStopped();
	const binary = input.binary ?? "codex";
	await assertSupportedNativeCodexVersion(binary);
	const sourceHome = resolve(input.sourceHomeDirectoryPath);
	await assertCodexSqliteStorageIsInsideRecordedHome(sourceHome);
	const targetHome = await prepareManagedCodexConversationStorageHome(sourceHome);
	if (sourceHome === targetHome) return { stage: "bound" as const, targetHomeDirectoryPath: targetHome };
	const previous = await readCodexConversationStorageMigrationRecord(sourceHome, input.nativeSessionId);
	if (previous?.familyRootNativeSessionId && previous.familyRootNativeSessionId !== input.nativeSessionId)
		return migrateStoppedCodexConversationStorage({ ...input, nativeSessionId: previous.familyRootNativeSessionId });
	if (!previous) {
		const row = readNativeThreadRow(sourceHome, input.nativeSessionId);
		if (["Codex Desktop", "codex_work_desktop", "codex_chatgpt_desktop"].includes(String(row.originator)))
			throw new Error("原生记录带有 App 创建来源，无法确认只属于看板；保留来源对话，未自动迁移。");
		if (input.taskCardCreatedAtMs !== undefined) {
			if (typeof row.cwd !== "string" || resolve(row.cwd) !== resolve(input.workingDirectoryPath))
				throw new Error("原生会话工作目录与 Task 执行目录不一致或未知，保留可能共享的来源对话。");
			const createdAtMs =
				typeof row.created_at_ms === "number"
					? row.created_at_ms
					: typeof row.created_at === "number"
						? row.created_at * 1000 + 999
						: null;
			if (createdAtMs === null || createdAtMs < input.taskCardCreatedAtMs)
				throw new Error("原生对话早于 Task 创建或创建时间未知，保留可能被复用的来源对话。");
		}
	}
	const family =
		previous && (previous.stage === "bound" || previous.stage === "source_archived")
			? (previous.familyNativeSessionIds ?? [input.nativeSessionId])
			: listNativeConversationFamily(sourceHome, input.nativeSessionId);
	return withFamilyOperationLocks(sourceHome, [...family].sort(), async () => {
		const existing = await readCodexConversationStorageMigrationRecord(sourceHome, input.nativeSessionId);
		if (existing?.stage === "source_archived") return existing;
		return withConversationFamilyLocks(targetHome, [...family].sort(), async (targetWriterLockGuard) => {
			await withConversationFamilyLocks(sourceHome, [...family].sort(), async (sourceWriterLockGuard) => {
				const writerLockGuard = combineCodexNativeWriterLockGuards(sourceWriterLockGuard, targetWriterLockGuard);
				await input.assertSessionStillStopped();
				writerLockGuard.assertWriterLocksStillValid();
				await assertDatabasePathsAreNotSharedLinks(sourceHome);
				await assertDatabasePathsAreNotSharedLinks(targetHome);
				if (existing?.stage !== "bound") {
					if (
						JSON.stringify(listNativeConversationFamily(sourceHome, input.nativeSessionId)) !==
						JSON.stringify(family)
					)
						throw new Error("原生会话族已变化，未切换存储。");
					const copied: MigrationRecord[] = [];
					for (const member of family) {
						const row = readNativeThreadRow(sourceHome, member);
						const sourceTranscriptPath = String(row.rollout_path);
						const child = assertTranscriptInsideCodexHome(sourceHome, sourceTranscriptPath);
						assertTranscriptInsideCodexHome(await realpath(sourceHome), await realpath(sourceTranscriptPath));
						const targetTranscriptPath = join(
							targetHome,
							child.replace(/^archived_sessions(?=[/\\])/u, "sessions"),
						);
						await assertCodexStorageWritablePathInsideHome(targetHome, targetTranscriptPath);
						const recordPath = getCodexConversationMigrationRecordPath(sourceHome, member);
						const prior = await readCodexConversationStorageMigrationRecord(sourceHome, member);
						const item: MigrationRecord = {
							schemaVersion: 1,
							nativeSessionId: member,
							sourceHomeDirectoryPath: sourceHome,
							targetHomeDirectoryPath: targetHome,
							sourceTranscriptPath,
							targetTranscriptPath,
							backupDirectoryPath: prior?.backupDirectoryPath ?? `${recordPath}.backup`,
							transcriptSha256: await hashFile(sourceTranscriptPath),
							sourceWasArchived: prior?.sourceWasArchived ?? row.archived === 1,
							readDependencyPromotedFromTranscriptPath: prior?.readDependencyPromotedFromTranscriptPath,
							familyNativeSessionIds: family,
							familyRootNativeSessionId: input.nativeSessionId,
							stage: "copy_started",
							updatedAt: Date.now(),
						};
						if (prior) {
							const currentTargetPath =
								(await readExistingUncommittedCodexConversationTranscriptPath(targetHome, member)) ??
								prior.targetTranscriptPath;
							let comparableSourcePath = item.sourceTranscriptPath;
							if (
								getCodexRolloutSegmentIdFromTranscriptPath(currentTargetPath) !==
								getCodexRolloutSegmentIdFromTranscriptPath(comparableSourcePath)
							) {
								const lineage = await readCodexPaginatedHistoryLineage(
									sourceHome,
									item.sourceTranscriptPath,
									member,
								);
								const matchingSource = lineage.find(
									(segment) =>
										segment.rolloutSegmentId ===
										getCodexRolloutSegmentIdFromTranscriptPath(currentTargetPath),
								);
								if (!matchingSource) throw new Error("未提交副本不属于来源的当前 lineage，拒绝覆盖重试。");
								comparableSourcePath = matchingSource.transcriptPath;
							}
							await assertUnboundTargetHasNoIndependentHistory({
								...item,
								sourceTranscriptPath: comparableSourcePath,
								targetTranscriptPath: currentTargetPath,
							});
						} else {
							try {
								await stat(targetTranscriptPath);
								throw new Error("目标已有同 ID 转录且没有迁移记录，拒绝覆盖。");
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							}
							if (await readExistingUncommittedCodexConversationTranscriptPath(targetHome, member))
								item.readDependencyPromotedFromTranscriptPath =
									await assertCodexReadDependencyCanBecomeOwnedConversation({
										sourceHome,
										targetHome,
										nativeSessionId: member,
										targetThreadRow: readNativeThreadRow(targetHome, member),
									});
						}
						copied.push(item);
					}
					// 先持久记录整族复制意图。进程崩溃时，选择器与续接仍认原目录。
					for (const item of copied)
						await writeMigrationRecord(
							getCodexConversationMigrationRecordPath(sourceHome, item.nativeSessionId),
							item,
							writerLockGuard,
						);
					for (const item of copied) {
						writerLockGuard.assertWriterLocksStillValid();
						await mkdir(item.backupDirectoryPath, { recursive: true, mode: 0o700 });
						try {
							writerLockGuard.assertWriterLocksStillValid();
							await copyFile(
								item.sourceTranscriptPath,
								join(item.backupDirectoryPath, "native-transcript.jsonl"),
								constants.COPYFILE_EXCL,
							);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						}
						writerLockGuard.assertWriterLocksStillValid();
						await mkdir(dirname(item.targetTranscriptPath), { recursive: true, mode: 0o700 });
						const lineage = await readCodexPaginatedHistoryLineage(
							sourceHome,
							item.sourceTranscriptPath,
							item.nativeSessionId,
						);
						await transferConversationDatabases({
							sourceHome,
							targetHome,
							historyRolloutSegmentId: lineage[0].rolloutSegmentId,
							nativeSessionId: item.nativeSessionId,
							targetTranscriptPath: item.targetTranscriptPath,
							backupDirectoryPath: item.backupDirectoryPath,
							replaceExisting: true,
							writerLockGuard,
						});
						await copyCodexPaginatedHistoryReadDependencies({
							sourceHome,
							targetHome,
							lineage,
							ownedNativeSessionIds: family,
							writerLockGuard,
						});
						const pendingTranscriptPath = `${item.targetTranscriptPath}.${randomUUID()}.pending-write`;
						writerLockGuard.assertWriterLocksStillValid();
						await copyFile(item.sourceTranscriptPath, pendingTranscriptPath, constants.COPYFILE_EXCL);
						writerLockGuard.assertWriterLocksStillValid();
						await rename(pendingTranscriptPath, item.targetTranscriptPath);
						if (item.readDependencyPromotedFromTranscriptPath)
							await retireCodexReadDependencyAfterOwnedConversationCopy({
								targetHome,
								promotedTranscriptPath: item.readDependencyPromotedFromTranscriptPath,
								backupDirectoryPath: item.backupDirectoryPath,
								writerLockGuard,
							});
						await writeMigrationRecord(
							getCodexConversationMigrationRecordPath(sourceHome, item.nativeSessionId),
							{ ...item, stage: "copied" },
							writerLockGuard,
						);
					}
					for (const item of copied)
						await verifyCopiedNativeConversation(binary, targetHome, item, writerLockGuard);
					await input.assertSessionStillStopped();
				}
			});
			await input.assertSessionStillStopped();
			targetWriterLockGuard.assertWriterLocksStillValid();
			try {
				await changeNativeConversationArchiveState(
					binary,
					sourceHome,
					[input.nativeSessionId],
					"thread/archive",
					targetWriterLockGuard,
				);
				return await withConversationFamilyLocks(sourceHome, [...family].sort(), async (sourceWriterLockGuard) => {
					const writerLockGuard = combineCodexNativeWriterLockGuards(sourceWriterLockGuard, targetWriterLockGuard);
					await input.assertSessionStillStopped();
					writerLockGuard.assertWriterLocksStillValid();
					if (
						JSON.stringify(listNativeConversationFamily(sourceHome, input.nativeSessionId).sort()) !==
						JSON.stringify([...family].sort())
					)
						throw new Error("归档交接期间原生会话族发生变化，未切换绑定；停止全部写入后可重试。");
					const finalized: MigrationRecord[] = [];
					for (const member of family) {
						const item = await readCodexConversationStorageMigrationRecord(sourceHome, member);
						if (!item) throw new Error("迁移记录丢失，未切换绑定。");
						await assertCopiedHistoryMatchesSource(item);
						await verifyCopiedNativeConversation(binary, targetHome, item, writerLockGuard);
						finalized.push(item);
					}
					// 原生归档自行取得写锁；重取内核锁并确认没有遗漏历史后，以 root 最后写入提交整族绑定。
					for (const item of finalized.sort(
						(a, b) =>
							Number(a.nativeSessionId === input.nativeSessionId) -
							Number(b.nativeSessionId === input.nativeSessionId),
					))
						await writeMigrationRecord(
							getCodexConversationMigrationRecordPath(sourceHome, item.nativeSessionId),
							{
								...item,
								stage: "source_archived",
							},
							writerLockGuard,
						);
					const record = await readCodexConversationStorageMigrationRecord(sourceHome, input.nativeSessionId);
					if (!record) throw new Error("迁移记录丢失。");
					return record;
				});
			} catch (error) {
				const rootRecord = await readCodexConversationStorageMigrationRecord(sourceHome, input.nativeSessionId);
				if (rootRecord?.stage === "copied" || rootRecord?.stage === "copy_started") {
					const records = await Promise.all(
						family.map((id) => readCodexConversationStorageMigrationRecord(sourceHome, id)),
					);
					const originallyVisibleIds = records
						.filter((item): item is MigrationRecord => item !== null && !item.sourceWasArchived)
						.map((item) => item.nativeSessionId);
					try {
						await changeNativeConversationArchiveState(
							binary,
							sourceHome,
							originallyVisibleIds,
							"thread/unarchive",
							targetWriterLockGuard,
						);
					} catch {
						throw new Error(
							`${error instanceof Error ? error.message : String(error)}；原生恢复可见性未完成，原目录仍是主记录，请停止全部写入后重试迁移。`,
						);
					}
				}
				throw error;
			}
		});
	});
}

export async function rollbackStoppedCodexConversationStorage(input: StoppedCodexConversationStorageMigrationInput) {
	nativeIdSchema.parse(input.nativeSessionId);
	await input.assertSessionStillStopped();
	await assertSupportedNativeCodexVersion(input.binary ?? "codex");
	await assertCodexSqliteStorageIsInsideRecordedHome(input.sourceHomeDirectoryPath);
	const record = await readCodexConversationStorageMigrationRecord(
		input.sourceHomeDirectoryPath,
		input.nativeSessionId,
	);
	if (record?.familyRootNativeSessionId && record.familyRootNativeSessionId !== input.nativeSessionId)
		return rollbackStoppedCodexConversationStorage({ ...input, nativeSessionId: record.familyRootNativeSessionId });
	if (!record || record.stage === "rolled_back") throw new Error("没有可回退的迁移记录。");
	if (record.stage === "copy_started" || record.stage === "copied")
		throw new Error("迁移尚未切换绑定，原目录仍是主记录；请修复原因后重试迁移。");
	const family = record.familyNativeSessionIds ?? [input.nativeSessionId];
	return withFamilyOperationLocks(record.sourceHomeDirectoryPath, [...family].sort(), async () => {
		const records = await Promise.all(
			family.map((member) => readCodexConversationStorageMigrationRecord(record.sourceHomeDirectoryPath, member)),
		);
		if (records.some((item) => !item)) throw new Error("会话族迁移记录不完整，未回退。");
		let verifiedRecords = records.filter((item): item is MigrationRecord => item !== null);
		return withConversationFamilyLocks(
			record.targetHomeDirectoryPath,
			[...family].sort(),
			async (targetWriterLockGuard) => {
				if (
					JSON.stringify(
						listNativeConversationFamily(record.targetHomeDirectoryPath, record.nativeSessionId).sort(),
					) !== JSON.stringify([...family].sort())
				)
					throw new Error("专用目录的原生会话族已变化，当前自动回退无法完整覆盖；保留专用目录及其全部历史。");
				await withConversationFamilyLocks(
					record.sourceHomeDirectoryPath,
					[...family].sort(),
					async (sourceWriterLockGuard) => {
						const writerLockGuard = combineCodexNativeWriterLockGuards(
							sourceWriterLockGuard,
							targetWriterLockGuard,
						);
						await input.assertSessionStillStopped();
						writerLockGuard.assertWriterLocksStillValid();
						await assertDatabasePathsAreNotSharedLinks(record.sourceHomeDirectoryPath);
						await assertDatabasePathsAreNotSharedLinks(record.targetHomeDirectoryPath);
						// 同 ID 的 native revert 会更换当前分片；只在两侧写锁都有效时读取当前指针。
						verifiedRecords = verifiedRecords.map((item) => ({
							...item,
							targetTranscriptPath: String(
								readNativeThreadRow(item.targetHomeDirectoryPath, item.nativeSessionId).rollout_path,
							),
						}));
						for (const item of verifiedRecords) {
							const originalPath = String(
								readNativeThreadRow(item.sourceHomeDirectoryPath, item.nativeSessionId).rollout_path,
							);
							const originalHash = await hashFile(originalPath);
							await assertCodexStorageWritablePathInsideHome(item.sourceHomeDirectoryPath, originalPath);
							await assertCodexStorageWritablePathInsideHome(
								item.targetHomeDirectoryPath,
								item.targetTranscriptPath,
							);
							const latestHash = await hashFile(item.targetTranscriptPath);
							if (originalHash !== item.transcriptSha256 && originalHash !== latestHash)
								throw new Error("原目录历史在迁移后又有变化，拒绝覆盖回退。");
							assertTranscriptInsideCodexHome(item.targetHomeDirectoryPath, item.targetTranscriptPath);
							const lineage = await readCodexPaginatedHistoryLineage(
								item.targetHomeDirectoryPath,
								item.targetTranscriptPath,
								item.nativeSessionId,
							);
							const originalSegment = lineage.find(
								(segment) =>
									segment.rolloutSegmentId === getCodexRolloutSegmentIdFromTranscriptPath(originalPath),
							);
							if (!originalSegment) throw new Error("原目录的 rollout 不属于当前私有 lineage，拒绝覆盖回退。");
							await assertUnboundTargetHasNoIndependentHistory({
								...item,
								sourceHomeDirectoryPath: item.targetHomeDirectoryPath,
								targetHomeDirectoryPath: item.sourceHomeDirectoryPath,
								sourceTranscriptPath: originalSegment.transcriptPath,
								targetTranscriptPath: originalPath,
							});
						}
						for (const item of verifiedRecords) {
							const originalArchivedPath = String(
								readNativeThreadRow(item.sourceHomeDirectoryPath, item.nativeSessionId).rollout_path,
							);
							const lineage = await readCodexPaginatedHistoryLineage(
								item.targetHomeDirectoryPath,
								item.targetTranscriptPath,
								item.nativeSessionId,
							);
							const archivedPath =
								getCodexRolloutSegmentIdFromTranscriptPath(originalArchivedPath) === lineage[0].rolloutSegmentId
									? originalArchivedPath
									: join(
											item.sourceHomeDirectoryPath,
											"archived_sessions",
											basename(item.targetTranscriptPath),
										);
							await assertCodexStorageWritablePathInsideHome(item.sourceHomeDirectoryPath, archivedPath);
							try {
								await assertFileIsPrefixOfSource(archivedPath, item.targetTranscriptPath);
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							}
							await transferConversationDatabases({
								sourceHome: item.targetHomeDirectoryPath,
								historyRolloutSegmentId: lineage[0].rolloutSegmentId,
								targetHome: item.sourceHomeDirectoryPath,
								nativeSessionId: item.nativeSessionId,
								targetTranscriptPath: archivedPath,
								backupDirectoryPath: join(item.backupDirectoryPath, `rollback-${Date.now()}`),
								replaceExisting: true,
								archiveRestoredConversation: true,
								writerLockGuard,
							});
							writerLockGuard.assertWriterLocksStillValid();
							await copyCodexPaginatedHistoryReadDependencies({
								sourceHome: item.targetHomeDirectoryPath,
								targetHome: item.sourceHomeDirectoryPath,
								lineage,
								ownedNativeSessionIds: family,
								writerLockGuard,
							});
							const pendingTranscriptPath = `${archivedPath}.${randomUUID()}.pending-write`;
							writerLockGuard.assertWriterLocksStillValid();
							await copyFile(item.targetTranscriptPath, pendingTranscriptPath, constants.COPYFILE_EXCL);
							writerLockGuard.assertWriterLocksStillValid();
							await rename(pendingTranscriptPath, archivedPath);
							writerLockGuard.assertWriterLocksStillValid();
						}
					},
				);
				// 原生 unarchive 恢复正确的目录布局；完成前绑定仍留在私有库，崩溃不会接回旧历史。
				await changeNativeConversationArchiveState(
					input.binary ?? "codex",
					record.sourceHomeDirectoryPath,
					verifiedRecords.map((item) => item.nativeSessionId),
					"thread/unarchive",
					targetWriterLockGuard,
				);
				return withConversationFamilyLocks(
					record.sourceHomeDirectoryPath,
					[...family].sort(),
					async (sourceWriterLockGuard) => {
						const writerLockGuard = combineCodexNativeWriterLockGuards(
							sourceWriterLockGuard,
							targetWriterLockGuard,
						);
						await input.assertSessionStillStopped();
						writerLockGuard.assertWriterLocksStillValid();
						for (const item of verifiedRecords) {
							const restoredPath = String(
								readNativeThreadRow(item.sourceHomeDirectoryPath, item.nativeSessionId).rollout_path,
							);
							await assertCopiedHistoryMatchesSource({ ...item, sourceTranscriptPath: restoredPath });
							await verifyCopiedNativeConversation(
								input.binary ?? "codex",
								item.sourceHomeDirectoryPath,
								{
									...item,
									targetTranscriptPath: restoredPath,
								},
								writerLockGuard,
								item.targetHomeDirectoryPath,
							);
						}
						for (const item of [...verifiedRecords].sort(
							(a, b) =>
								Number(a.nativeSessionId === (record.familyRootNativeSessionId ?? record.nativeSessionId)) -
								Number(b.nativeSessionId === (record.familyRootNativeSessionId ?? record.nativeSessionId)),
						))
							await writeMigrationRecord(
								getCodexConversationMigrationRecordPath(item.sourceHomeDirectoryPath, item.nativeSessionId),
								{ ...item, stage: "rolled_back" },
								writerLockGuard,
							);
						return { ...record, stage: "rolled_back" as const };
					},
				);
			},
		);
	});
}
