import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR } from "../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT_ENVIRONMENT_VARIABLE_NAME } from "../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import { closeDefaultNotificationLifecycleArchive } from "../src/notifications/notification-lifecycle-archive";

// 测试进程绝不能往用户真实的 ~/.cline 运行目录写诊断事件。诊断 journal 正是排障时要读的数据，
// 混进测试产生的伪记录（cwd=/repo 之类的假仓库路径）会直接误导事后分析。
// 固定路径而非 mkdtemp：journal 自带轮转与保留上限，复用同一目录不会无限增长，也不会在
// /tmp 下堆出成百上千个空目录。
process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR] = join(tmpdir(), "kanban-test-diagnostic-event-journals");

// 永久档案不轮转，每个测试文件独占目录，完成后关闭 worker 再清理。
const notificationArchiveTestRoot = mkdtempSync(join(tmpdir(), "kanban-notification-archive-test-process-"));
process.env.KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT = notificationArchiveTestRoot;
// 关系账本只追加，被测试写进真实 HOME 后不可逆（dd2db §R3 Y-EVENT-3）。每个测试文件独占存储根。
const interWorkUnitRelationLedgerTestStorageRoot = mkdtempSync(
	join(tmpdir(), "kanban-inter-work-unit-relation-ledger-test-process-"),
);
process.env[INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT_ENVIRONMENT_VARIABLE_NAME] =
	interWorkUnitRelationLedgerTestStorageRoot;
afterAll(async () => {
	await closeDefaultNotificationLifecycleArchive();
	rmSync(notificationArchiveTestRoot, { recursive: true, force: true });
	rmSync(interWorkUnitRelationLedgerTestStorageRoot, { recursive: true, force: true });
});
