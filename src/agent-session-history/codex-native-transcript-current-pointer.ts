import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { z } from "zod";

const requireNodeModule = createRequire(import.meta.url);

function isBetterSqliteNativeAbiMismatch(error: unknown): boolean {
	return error instanceof Error && error.message.includes("NODE_MODULE_VERSION");
}

function isBuiltinSqliteDatabaseUnavailable(error: unknown): boolean {
	return error instanceof Error && error.message.includes("unable to open database file");
}

// 共享安装的 better-sqlite3 可能只对应另一个 Node ABI。打不开时改读运行时自带 sqlite 的同一只读指针；库文件缺失仍交给唯一历史入口回退。
export function readCodexThreadRolloutPath(databasePath: string, nativeSessionId: string): string | undefined {
	let nativeCodexStateDatabase: Database.Database | null = null;
	try {
		nativeCodexStateDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
		const row = nativeCodexStateDatabase
			.prepare("SELECT rollout_path FROM threads WHERE id = ?")
			.get(nativeSessionId);
		if (!row) return undefined;
		return z.object({ rollout_path: z.string() }).parse(row).rollout_path;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "SQLITE_CANTOPEN") return undefined;
		if (!isBetterSqliteNativeAbiMismatch(error)) throw error;
		return readCodexThreadRolloutPathWithBuiltinSqlite(databasePath, nativeSessionId);
	} finally {
		nativeCodexStateDatabase?.close();
	}
}

function readCodexThreadRolloutPathWithBuiltinSqlite(
	databasePath: string,
	nativeSessionId: string,
): string | undefined {
	let database: DatabaseSync | null = null;
	try {
		const { DatabaseSync: BuiltinDatabaseSync } = requireNodeModule("node:sqlite") as {
			DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
		};
		database = new BuiltinDatabaseSync(databasePath, { readOnly: true });
		const row = database.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(nativeSessionId);
		if (!row) return undefined;
		return z.object({ rollout_path: z.string() }).parse(row).rollout_path;
	} catch (error) {
		if (isBuiltinSqliteDatabaseUnavailable(error)) return undefined;
		throw error;
	} finally {
		database?.close();
	}
}
