import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertCodexNativeTurnsCoverCapturedPaginatedHistory,
	assertCodexReadDependencyCanBecomeOwnedConversation,
	copyCodexPaginatedHistoryReadDependencies,
	readCodexPaginatedHistoryLineage,
} from "../../../src/codex-conversation-storage/codex-paginated-history-lineage";
import { createTempDir } from "../../utilities/temp-dir";

const parentId = "01a15120-4476-78b0-8c56-5a7321338e0b";
const branchId = "01a15120-4476-78b0-8c56-5a7321338e0c";
const firstTurnId = "parent-frozen-turn";
const laterTurnId = "parent-unrelated-later-turn";
let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let targetHome: string;
let sourceParentPath: string;
let sourceBranchPath: string;
let parentPrefix: string;
let parentFullTranscript: string;

function metadata(id: string, ordinal: number, base?: Record<string, unknown>) {
	return `${JSON.stringify({
		type: "session_meta",
		ordinal,
		payload: {
			id,
			history_mode: "paginated",
			history_base: base,
		},
	})}\n`;
}
function startedTurn(turnId: string, ordinal: number) {
	return `${JSON.stringify({ type: "event_msg", ordinal, payload: { type: "task_started", turn_id: turnId, message: "中文祖先 🧭" } })}\n`;
}
function createHistoryDatabase(home: string, includeParentRows: boolean) {
	const database = new Database(join(home, "thread_history_1.sqlite"));
	database.exec(`
		CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, PRIMARY KEY(thread_id, turn_id));
		CREATE TABLE thread_items (thread_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_json TEXT, PRIMARY KEY(thread_id, item_id));
		CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
	`);
	if (includeParentRows) {
		database
			.prepare("INSERT INTO thread_turns VALUES (?, ?, 1), (?, ?, 2)")
			.run(parentId, firstTurnId, parentId, laterTurnId);
		database
			.prepare(
				"INSERT INTO thread_items VALUES (?, 'frozen-item', 1, 'frozen'), (?, 'unrelated-later-item', 2, 'later')",
			)
			.run(parentId, parentId);
		database
			.prepare("INSERT INTO thread_history_projection_state VALUES (?, ?, 3)")
			.run(parentId, Buffer.byteLength(parentFullTranscript));
	}
	database.close();
}
async function readSourceLineage() {
	return readCodexPaginatedHistoryLineage(sourceHome, sourceBranchPath, branchId);
}
async function copyDependencies(assertWriterLocksStillValid = () => {}) {
	return copyCodexPaginatedHistoryReadDependencies({
		sourceHome,
		targetHome,
		lineage: await readSourceLineage(),
		ownedNativeSessionIds: [branchId],
		writerLockGuard: { assertWriterLocksStillValid },
	});
}

beforeEach(async () => {
	fixture = createTempDir("codex-paginated-lineage-boundaries-");
	sourceHome = join(fixture.path, "source-codex-home");
	targetHome = join(fixture.path, "target-codex-home");
	await mkdir(join(sourceHome, "sessions"), { recursive: true });
	await mkdir(join(targetHome, "sessions"), { recursive: true });
	sourceParentPath = join(sourceHome, "sessions", `rollout-${parentId}.jsonl`);
	sourceBranchPath = join(sourceHome, "sessions", `rollout-${branchId}.jsonl`);
	parentPrefix = metadata(parentId, 0) + startedTurn(firstTurnId, 1);
	parentFullTranscript = parentPrefix + startedTurn(laterTurnId, 2);
	await writeFile(sourceParentPath, parentFullTranscript);
	await writeFile(
		sourceBranchPath,
		metadata(branchId, 2, {
			thread_id: parentId,
			end_ordinal_exclusive: 2,
			end_byte_offset: Buffer.byteLength(parentPrefix),
		}) + startedTurn("branch-local-turn", 3),
	);
	createHistoryDatabase(sourceHome, true);
	createHistoryDatabase(targetHome, false);
});
afterEach(() => fixture.cleanup());

describe("Codex 分页 lineage 的有界读取依赖", () => {
	it("只复制冻结的 UTF-8 前缀和对应历史行，不携带祖先后续回合或调度库", async () => {
		await copyDependencies();
		const dependencyPath = join(
			targetHome,
			"archived_sessions",
			"kanban-history-base-read-dependencies",
			`rollout-${parentId}.jsonl`,
		);
		expect(await readFile(dependencyPath, "utf8")).toBe(parentPrefix);
		expect(await readFile(sourceParentPath, "utf8")).toBe(parentFullTranscript);
		const database = new Database(join(targetHome, "thread_history_1.sqlite"), { readonly: true });
		try {
			expect(database.prepare("SELECT turn_id FROM thread_turns").all()).toEqual([{ turn_id: firstTurnId }]);
			expect(database.prepare("SELECT item_id FROM thread_items").all()).toEqual([{ item_id: "frozen-item" }]);
			expect(database.prepare("SELECT * FROM thread_history_projection_state").all()).toEqual([
				{ thread_id: parentId, next_rollout_byte_offset: Buffer.byteLength(parentPrefix), next_rollout_ordinal: 2 },
			]);
		} finally {
			database.close();
		}
		for (const name of ["state_5.sqlite", "goals_1.sqlite", "queue_1.sqlite"])
			await expect(stat(join(targetHome, name))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("复用相同祖先的冻结前缀，保留私有祖先已有的新回合、文件与投影游标", async () => {
		const targetParentPath = join(targetHome, "sessions", `rollout-${parentId}.jsonl`);
		const independentlyAdvanced = parentPrefix + startedTurn("private-parent-independent-turn", 2);
		await writeFile(targetParentPath, independentlyAdvanced);
		const database = new Database(join(targetHome, "thread_history_1.sqlite"));
		try {
			database
				.prepare("INSERT INTO thread_turns VALUES (?, ?, 1), (?, 'private-parent-independent-turn', 2)")
				.run(parentId, firstTurnId, parentId);
			database.prepare("INSERT INTO thread_items VALUES (?, 'frozen-item', 1, 'frozen')").run(parentId);
			database
				.prepare("INSERT INTO thread_history_projection_state VALUES (?, ?, 3)")
				.run(parentId, Buffer.byteLength(independentlyAdvanced));
			const before = database.prepare("SELECT * FROM thread_history_projection_state").all();
			await copyDependencies();
			expect(await readFile(targetParentPath, "utf8")).toBe(independentlyAdvanced);
			expect(database.prepare("SELECT * FROM thread_history_projection_state").all()).toEqual(before);
			expect(database.prepare("SELECT turn_id FROM thread_turns ORDER BY rollout_ordinal").all()).toEqual([
				{ turn_id: firstTurnId },
				{ turn_id: "private-parent-independent-turn" },
			]);
		} finally {
			database.close();
		}
	});

	it.for(["different_frozen_prefix", "shorter_existing_prefix"] as const)(
		"%s：拒绝覆盖已有祖先文件及其历史",
		async (scenario) => {
			const path = join(targetHome, "sessions", `rollout-${parentId}.jsonl`);
			const existing =
				scenario === "different_frozen_prefix"
					? parentPrefix.replace(firstTurnId, "conflicting-turn")
					: metadata(parentId, 0);
			await writeFile(path, existing);
			await expect(copyDependencies()).rejects.toThrow(/拒绝覆盖|不完整/u);
			expect(await readFile(path, "utf8")).toBe(existing);
			const database = new Database(join(targetHome, "thread_history_1.sqlite"), { readonly: true });
			try {
				expect(database.prepare("SELECT * FROM thread_turns").all()).toEqual([]);
			} finally {
				database.close();
			}
		},
	);

	it.for(["partial_utf8_boundary", "incorrect_ordinal", "cyclic_segment"] as const)(
		"%s：来源依赖不可证明完整时保守失败",
		async (scenario) => {
			await writeFile(
				sourceBranchPath,
				metadata(branchId, scenario === "incorrect_ordinal" ? 3 : 2, {
					thread_id: scenario === "cyclic_segment" ? branchId : parentId,
					end_ordinal_exclusive: scenario === "incorrect_ordinal" ? 3 : 2,
					end_byte_offset:
						scenario === "partial_utf8_boundary"
							? Buffer.from(parentPrefix).indexOf(Buffer.from("祖")) + 1
							: Buffer.byteLength(parentPrefix),
				}),
			);
			await expect(readSourceLineage()).rejects.toThrow(/lineage/u);
		},
	);

	it("带完整来源凭据的只读依赖允许正式迁移晋升", async () => {
		await copyDependencies();
		const path = join(
			targetHome,
			"archived_sessions",
			"kanban-history-base-read-dependencies",
			`rollout-${parentId}.jsonl`,
		);
		expect(
			await assertCodexReadDependencyCanBecomeOwnedConversation({
				sourceHome,
				targetHome,
				nativeSessionId: parentId,
				targetThreadRow: { archived: 1, rollout_path: path },
			}),
		).toBe(path);
	});

	it.for([
		"active_summary",
		"missing_provenance",
		"pending_provenance",
		"different_source_home",
		"independent_rollout_tail",
		"independent_history_rows",
		"independent_runtime_state",
	] as const)("%s：不能把私有祖先的独立内容晋升覆盖", async (scenario) => {
		await copyDependencies();
		const path = join(
			targetHome,
			"archived_sessions",
			"kanban-history-base-read-dependencies",
			`rollout-${parentId}.jsonl`,
		);
		const markerPath = `${path}.kanban-history-base-read-dependency.json`;
		if (scenario === "missing_provenance") await rm(markerPath);
		if (scenario === "pending_provenance" || scenario === "different_source_home") {
			const marker = JSON.parse(await readFile(markerPath, "utf8"));
			if (scenario === "pending_provenance") marker.stage = "copy_started";
			else marker.sourceHomeDirectoryPath = join(fixture.path, "unrelated-codex-source-home");
			await writeFile(markerPath, JSON.stringify(marker));
		}
		if (scenario === "independent_rollout_tail") await appendFile(path, startedTurn("private-independent-turn", 2));
		if (scenario === "independent_history_rows") {
			const history = new Database(join(targetHome, "thread_history_1.sqlite"));
			history.prepare("INSERT INTO thread_turns VALUES (?, 'private-independent-turn', 2)").run(parentId);
			history.close();
		}
		if (scenario === "independent_runtime_state") {
			const database = new Database(join(targetHome, "queue_1.sqlite"));
			database.exec("CREATE TABLE jobs (thread_id TEXT PRIMARY KEY, payload TEXT)");
			database.prepare("INSERT INTO jobs VALUES (?, 'private-runtime-state')").run(parentId);
			database.close();
		}
		const before = await readFile(path);
		await expect(
			assertCodexReadDependencyCanBecomeOwnedConversation({
				sourceHome,
				targetHome,
				nativeSessionId: parentId,
				targetThreadRow: { archived: scenario === "active_summary" ? 0 : 1, rollout_path: path },
			}),
		).rejects.toThrow(/拒绝|缺少/u);
		expect(await readFile(path)).toEqual(before);
	});

	it("原生读取静默遗漏继承回合时，不能以局部回合数宣布完整", async () => {
		const lineage = await readSourceLineage();
		expect(() =>
			assertCodexNativeTurnsCoverCapturedPaginatedHistory(lineage, [
				{ id: "branch-local-turn", status: "completed", items: [] },
			]),
		).toThrow("未覆盖完整 rollout lineage");
	});

	it("复制依赖期间写锁失效即停止，不写入历史数据库", async () => {
		const guard = vi
			.fn()
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error("隔离注入：写锁失效");
			});
		await expect(copyDependencies(guard)).rejects.toThrow("写锁失效");
		const database = new Database(join(targetHome, "thread_history_1.sqlite"), { readonly: true });
		try {
			expect(database.prepare("SELECT * FROM thread_turns").all()).toEqual([]);
		} finally {
			database.close();
		}
	});
});
