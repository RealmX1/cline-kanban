import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForPendingDiagnosticEventJournalWrites } from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
let database: Database.Database;
const snapshot = { taskCardSnapshotEntriesByTaskId: {} };

async function recordPendingBatch(pendingBatchId: string) {
	await ledgerClient.recordPendingTaskMutationEventBatch({
		workspaceId: "isolated-workspace",
		pendingBatchId,
		expectedBoardFileSha256AfterWrite: "persisted-board-sha256",
		expectedBoardRevisionAfterWrite: 2,
		nextWorkspaceBoardSnapshot: snapshot,
		eventDrafts: [],
		retainedFieldContents: [],
		createdTaskCardIdentities: [],
	});
}
function readBatch(pendingBatchId: string) {
	return database
		.prepare(`SELECT pending_batch_status, next_workspace_board_snapshot_json,
	 expected_board_file_sha256_after_write, expected_board_revision_after_write, resolved_at
	 FROM pending_board_file_write_task_mutation_event_batches WHERE pending_board_file_write_batch_id = ?`)
		.get(pendingBatchId) as {
		pending_batch_status: string;
		next_workspace_board_snapshot_json: string;
		resolved_at: number | null;
	};
}
async function restartLedgerWorker() {
	await ledgerClient.close();
	ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(fixture.path);
	await ledgerClient.readWorkspaceTaskMutationCaptureState("isolated-workspace", null);
}
function remainingHistoricalSnapshotCount() {
	return (
		database
			.prepare(`SELECT count(*) AS count FROM pending_board_file_write_task_mutation_event_batches
	 WHERE pending_batch_status IN ('committed', 'abandoned') AND next_workspace_board_snapshot_json <> ''`)
			.get() as {
			count: number;
		}
	).count;
}

beforeEach(async () => {
	fixture = createTempDir("terminal-board-mutation-snapshot-compaction-");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR", join(fixture.path, "diagnostic-journals"));
	ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(fixture.path);
	await ledgerClient.readWorkspaceTaskMutationCaptureState("isolated-workspace", null);
	database = new Database(join(fixture.path, "inter-work-unit-relation-ledger.sqlite"));
});
afterEach(async () => {
	await ledgerClient.close();
	database.close();
	await waitForPendingDiagnosticEventJournalWrites();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("终态看板恢复快照压缩", () => {
	it("历史尺寸枚举只读取正文长度元数据，并保持非空终态筛选与 UTF-8 字节数", async () => {
		await ledgerClient.close();
		const workerSource = await readFile(
			new URL(
				"../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
				import.meta.url,
			),
			"utf8",
		);
		const snapshotSizeQuery = workerSource.match(
			/const readTerminalBatchSnapshotSizesStatement = database.prepare\(`([\s\S]*?)`\);/,
		)?.[1];
		if (!snapshotSizeQuery) throw new Error("找不到历史快照尺寸查询");
		const insertHistoricalBatch = database.prepare(
			"INSERT INTO pending_board_file_write_task_mutation_event_batches VALUES (?,?,?,?,?,?,?,?)",
		);
		const snapshotBodies = ['{"中文":"🙂"}', "\u0000正文", "", '{"pending":true}', '{"unresolved":true}'];
		for (const [index, body] of snapshotBodies.entries()) {
			insertHistoricalBatch.run(
				`size-query-batch-${index}`,
				"isolated-workspace",
				"historical-sha256",
				index,
				body,
				index === 3 ? "pending" : index === 1 ? "abandoned" : "committed",
				index,
				index === 4 ? null : index + 1,
			);
		}
		expect(database.prepare(snapshotSizeQuery).all(0)).toEqual([
			{ batch_rowid: 1, snapshot_bytes: Buffer.byteLength(snapshotBodies[0]) },
			{ batch_rowid: 2, snapshot_bytes: Buffer.byteLength(snapshotBodies[1]) },
		]);
		expect(database.prepare(snapshotSizeQuery).all(1)).toEqual([
			{ batch_rowid: 2, snapshot_bytes: Buffer.byteLength(snapshotBodies[1]) },
		]);
		const snapshotColumn = database
			.prepare<[], { cid: number; name: string }>(
				"PRAGMA table_info(pending_board_file_write_task_mutation_event_batches)",
			)
			.all()
			.find((column) => column.name === "next_workspace_board_snapshot_json");
		if (!snapshotColumn) throw new Error("找不到历史快照正文列");
		const snapshotColumnOperations = database
			.prepare<[number], { opcode: string; p2: number; p5: number }>(`EXPLAIN ${snapshotSizeQuery}`)
			.all(0)
			.filter((operation) => operation.opcode === "Column" && operation.p2 === snapshotColumn.cid);
		expect(snapshotColumnOperations.length).toBeGreaterThan(0);
		for (const operation of snapshotColumnOperations) {
			// SQLite 的 OPFLAG_LENGTHARG | OPFLAG_TYPEOFARG 允许只读 TEXT 长度，跳过溢出页正文。
			expect(operation.p5 & 0xc0).toBe(0xc0);
		}
	});

	it("历史维护按实际字节限制一轮，并原子处理单条超预算正文", async () => {
		await ledgerClient.close();
		const insertHistoricalBatch = database.prepare(
			"INSERT INTO pending_board_file_write_task_mutation_event_batches VALUES (?,?,?,?,?,?,?,?)",
		);
		const snapshotBodies = ["中".repeat(2 * 1024 * 1024), "中".repeat(1024 * 1024), "中".repeat(1024 * 1024)];
		database.transaction(() => {
			for (const [index, body] of snapshotBodies.entries())
				insertHistoricalBatch.run(
					`byte-budget-batch-${index}`,
					"isolated-workspace",
					"historical-sha256",
					index,
					body,
					"committed",
					index,
					index + 1,
				);
		})();
		await restartLedgerWorker();
		const progressEvents = await vi.waitFor(
			async () => {
				const journal = await readFile(
					join(fixture.path, "diagnostic-journals", "terminal-board-mutation-snapshot-compaction.jsonl"),
					"utf8",
				);
				const events = journal
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter((event) => event.status === "in_progress");
				expect(events).toHaveLength(3);
				return events;
			},
			{ timeout: 10_000 },
		);
		expect(remainingHistoricalSnapshotCount()).toBe(0);
		for (const [index, event] of progressEvents.entries()) {
			expect(event).toMatchObject({
				compactedBatchCount: 1,
				compactedSnapshotBytes: Buffer.byteLength(snapshotBodies[index]),
				lastCompactedBatchRowId: index + 1,
			});
		}
	});

	it("重启仍保留 pending 正文，提交或放弃时只清正文，重复提交不重放", async () => {
		await recordPendingBatch("committed-batch");
		await restartLedgerWorker();
		expect(JSON.parse(readBatch("committed-batch").next_workspace_board_snapshot_json)).toEqual(snapshot);
		const input = { pendingBatchId: "committed-batch", boardFileSha256: "persisted-board-sha256", boardRevision: 2 };
		expect(await ledgerClient.commitPendingTaskMutationEventBatch(input)).toBe(true);
		expect(await ledgerClient.commitPendingTaskMutationEventBatch(input)).toBe(false);
		expect(readBatch(input.pendingBatchId)).toMatchObject({
			pending_batch_status: "committed",
			next_workspace_board_snapshot_json: "",
			expected_board_file_sha256_after_write: input.boardFileSha256,
			expected_board_revision_after_write: 2,
			resolved_at: expect.any(Number),
		});
		await recordPendingBatch("abandoned-batch");
		await ledgerClient.resolvePendingBatchesAndRecordDetectedEvents({
			workspaceId: "isolated-workspace",
			pendingBatchResolutions: [{ pendingBatchId: "abandoned-batch", pendingBatchResolution: "abandon" }],
			detectedEventDrafts: [],
			retainedFieldContents: [],
			observedTaskCardIdentities: [],
			currentSnapshot: {
				boardFileSha256: input.boardFileSha256,
				boardRevision: 2,
				workspaceBoardSnapshot: snapshot,
			},
		});
		expect(readBatch("abandoned-batch")).toMatchObject({
			pending_batch_status: "abandoned",
			next_workspace_board_snapshot_json: "",
		});
		await restartLedgerWorker();
		expect(
			await ledgerClient.readWorkspaceTaskMutationCaptureState("isolated-workspace", "persisted-board-sha256"),
		).toEqual({ lastCommittedSnapshotMatchesPersistedBoardFileWithoutPendingBatches: true });
	});

	it("投影事务失败时正文、事件序号和 pending 状态一起回滚，重试只提交一次", async () => {
		await recordPendingBatch("interrupted-batch");
		database
			.prepare(`INSERT INTO inter_work_unit_relation_ledger_events(event_id,event_commit_status,
		 pending_board_file_write_batch_id,event_family,event_kind,occurred_at,event_json)
		 VALUES ('immutable-event','pending_board_file_write','interrupted-batch','fixture','fixture',1,?)`)
			.run('{"不可变审计":"原文"}');
		database.exec(`CREATE TRIGGER abort_snapshot_projection BEFORE INSERT ON
		 workspace_board_last_committed_task_mutation_capture_snapshot BEGIN SELECT RAISE(ABORT, '隔离投影中断'); END`);
		const input = {
			pendingBatchId: "interrupted-batch",
			boardFileSha256: "persisted-board-sha256",
			boardRevision: 2,
		};
		await expect(ledgerClient.commitPendingTaskMutationEventBatch(input)).rejects.toThrow("隔离投影中断");
		expect(readBatch(input.pendingBatchId)).toMatchObject({ pending_batch_status: "pending", resolved_at: null });
		expect(JSON.parse(readBatch(input.pendingBatchId).next_workspace_board_snapshot_json)).toEqual(snapshot);
		expect(
			database.prepare("SELECT global_committed_event_sequence FROM inter_work_unit_relation_ledger_events").get(),
		).toEqual({ global_committed_event_sequence: null });
		database.exec("DROP TRIGGER abort_snapshot_projection");
		expect(await ledgerClient.commitPendingTaskMutationEventBatch(input)).toBe(true);
		expect(await ledgerClient.commitPendingTaskMutationEventBatch(input)).toBe(false);
		expect(
			database
				.prepare("SELECT global_committed_event_sequence,event_json FROM inter_work_unit_relation_ledger_events")
				.get(),
		).toEqual({ global_committed_event_sequence: 1, event_json: '{"不可变审计":"原文"}' });
	});

	it("历史压缩分批让出 worker，重启接续且保留未决正文和全部批次身份", async () => {
		await recordPendingBatch("still-pending");
		await ledgerClient.close();
		const insert = database.prepare(
			`INSERT INTO pending_board_file_write_task_mutation_event_batches VALUES (?,?,?,?,?,?,?,?)`,
		);
		database.transaction(() => {
			for (let index = 0; index < 100; index++)
				insert.run(
					`historical-batch-${index}`,
					"isolated-workspace",
					"historical-sha256",
					index,
					JSON.stringify(snapshot),
					index % 2 ? "committed" : "abandoned",
					index,
					index + 1,
				);
		})();
		await restartLedgerWorker();
		await vi.waitFor(() => expect(remainingHistoricalSnapshotCount()).toBeLessThan(100), { timeout: 10_000 });
		expect(remainingHistoricalSnapshotCount()).toBeGreaterThanOrEqual(68);
		await restartLedgerWorker();
		await vi.waitFor(() => expect(remainingHistoricalSnapshotCount()).toBe(0), { timeout: 10_000 });
		expect(JSON.parse(readBatch("still-pending").next_workspace_board_snapshot_json)).toEqual(snapshot);
		expect(
			database.prepare("SELECT count(*) AS count FROM pending_board_file_write_task_mutation_event_batches").get(),
		).toEqual({ count: 101 });
	}, 20_000);

	it("空轮后仍自动补扫旧版本稍后结算的低 rowid 批次", async () => {
		await recordPendingBatch("legacy-pending-batch");
		await recordPendingBatch("later-terminal-batch");
		await ledgerClient.close();
		database
			.prepare(`UPDATE pending_board_file_write_task_mutation_event_batches SET pending_batch_status='committed', resolved_at=1
		 WHERE pending_board_file_write_batch_id='later-terminal-batch'`)
			.run();
		await restartLedgerWorker();
		await vi.waitFor(
			async () => {
				const journal = await readFile(
					join(fixture.path, "diagnostic-journals", "terminal-board-mutation-snapshot-compaction.jsonl"),
					"utf8",
				);
				expect(
					journal
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line)),
				).toContainEqual(
					expect.objectContaining({
						status: "completed",
						lastCompactedBatchRowId: 2,
					}),
				);
			},
			{ timeout: 10_000 },
		);
		database
			.prepare(`UPDATE pending_board_file_write_task_mutation_event_batches SET pending_batch_status='committed', resolved_at=1
		 WHERE pending_board_file_write_batch_id='legacy-pending-batch'`)
			.run();
		await vi.waitFor(() => expect(readBatch("legacy-pending-batch").next_workspace_board_snapshot_json).toBe(""), {
			timeout: 75_000,
		});
	}, 90_000);

	it("历史压缩暂时失败时记录重验条件，解除故障后自动继续", async () => {
		await recordPendingBatch("historical-retry-batch");
		await ledgerClient.close();
		database.exec(`UPDATE pending_board_file_write_task_mutation_event_batches SET pending_batch_status='committed', resolved_at=1;
		 CREATE TRIGGER abort_terminal_snapshot_compaction BEFORE UPDATE OF next_workspace_board_snapshot_json ON
		 pending_board_file_write_task_mutation_event_batches BEGIN SELECT RAISE(ABORT, '隔离压缩中断'); END`);
		await restartLedgerWorker();
		await vi.waitFor(
			async () => {
				const journal = await readFile(
					join(fixture.path, "diagnostic-journals", "terminal-board-mutation-snapshot-compaction.jsonl"),
					"utf8",
				);
				expect(journal).toContain('"status":"waiting_retry"');
			},
			{ timeout: 10_000 },
		);
		expect(remainingHistoricalSnapshotCount()).toBe(1);
		database.exec("DROP TRIGGER abort_terminal_snapshot_compaction");
		await vi.waitFor(() => expect(remainingHistoricalSnapshotCount()).toBe(0), { timeout: 10_000 });
	}, 20_000);
});
