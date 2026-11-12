import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeCodexConfigurationSyncDatabase,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStorageMetrics,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	createCodexConfigurationTargetObservationMonitor,
	listRuntimeCodexConfigurationTraceTargets,
	normalizeMacosCodexTargetWriteEvent,
	readCodexConfigurationTargetSnapshot,
	recordKnownCodexConfigurationNativeRequest,
	resolvePossibleCodexRequestInitiators,
	waitForCodexConfigurationRequestWriterOwnershipVerifications,
} from "../../../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { waitForPendingDiagnosticEventJournalWrites } from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(async () => {
	fixture = createTempDir("codex-readonly-initiator-trace-");
	fixture.path = await realpath(fixture.path);
	for (const key of ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, fixture.path);
});
afterEach(async () => {
	await waitForCodexConfigurationRequestWriterOwnershipVerifications();
	await closeCodexConfigurationSyncDatabase();
	await waitForPendingDiagnosticEventJournalWrites();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
describe("只读配置与插件缓存追踪", () => {
	it("已知 writer 的原生请求归属核验不解码其他活跃 writer", async () => {
		const journalDirectory = join(fixture.path, "known-request-diagnostic-journal");
		vi.stubEnv("KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR", journalDirectory);
		await writeFile(join(fixture.path, "config.toml"), 'model = "isolated-ownership-check"\n');
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: fixture.path,
			workspaceId: "ownership-check",
			conversationSessionId: "known-writer",
			runtimeSessionIncarnationId: crypto.randomUUID(),
		});
		await mutateCodexConfigurationSyncStore((store) => {
			for (let index = 0; index < 50; index++) {
				const writerId = crypto.randomUUID();
				store.writers[writerId] = {
					...structuredClone(store.writers[binding.writerId]),
					binding: { ...binding, writerId },
				};
			}
		});
		const before = (await readCodexConfigurationSyncStorageMetrics()).cumulative.decodedRows;
		recordKnownCodexConfigurationNativeRequest({
			requestId: "known-writer-read-budget",
			method: "config/read",
			purpose: "隔离归属回归",
			writerBinding: binding,
		});
		await waitForCodexConfigurationRequestWriterOwnershipVerifications();
		const after = (await readCodexConfigurationSyncStorageMetrics()).cumulative.decodedRows;
		expect(after - before).toBeLessThan(10);
		await waitForPendingDiagnosticEventJournalWrites();
		expect(
			await readFile(join(journalDirectory, "codex-configuration-and-plugin-cache-initiator-trace.jsonl"), "utf8"),
		).toContain('"event":"native_request_writer_ownership_verified"');
		expect(await listRuntimeCodexConfigurationTraceTargets()).toContain(
			join(binding.configurationHomeDirectoryPath, "config.toml"),
		);
	});
	it.each([1_000, 4_001])("%i 个条目的预算检查不重复枚举已收集条目", async (requestedEntryCount) => {
		const target = join(fixture.path, "bounded-plugin-snapshot");
		await mkdir(target);
		await writeFile(join(target, "__proto__"), "");
		for (let offset = 1; offset < requestedEntryCount; offset += 100) {
			await Promise.all(
				Array.from({ length: Math.min(100, requestedEntryCount - offset) }, (_, index) =>
					writeFile(join(target, `plugin-${String(offset + index).padStart(5, "0")}`), ""),
				),
			);
		}
		const originalObjectKeys = Object.keys;
		let snapshotEntryEnumerationCount = 0;
		const enumerationSpy = vi.spyOn(Object, "keys").mockImplementation((value) => {
			if (Object.hasOwn(value, ".")) snapshotEntryEnumerationCount += 1;
			return originalObjectKeys(value);
		});
		let snapshot: Awaited<ReturnType<typeof readCodexConfigurationTargetSnapshot>>;
		try {
			snapshot = await readCodexConfigurationTargetSnapshot(target);
		} finally {
			enumerationSpy.mockRestore();
		}
		expect(snapshotEntryEnumerationCount).toBeLessThan(10);
		expect(Object.keys(snapshot.entries)).toHaveLength(Math.min(requestedEntryCount, 4_000));
		expect(snapshot.coverageGaps).toEqual(
			requestedEntryCount > 4_000 ? [{ path: ".", code: "bounded_snapshot_budget_exhausted" }] : [],
		);
	});
	it("先监听再快照，保留前后摘要且观察器不改写文件", async () => {
		const target = join(fixture.path, "configuration");
		await mkdir(target);
		const configuration = join(target, "config.toml");
		await writeFile(configuration, 'token="never-record-this-secret"\n');
		const events: Record<string, unknown>[] = [];
		const monitor = createCodexConfigurationTargetObservationMonitor({
			listTargetPaths: async () => [target],
			emit: (event) => events.push(event),
			pollIntervalMs: 20,
		});
		await monitor.start();
		expect(events.findIndex((event) => event.event === "target_listener_ready")).toBeLessThan(
			events.findIndex((event) => event.event === "initial_target_snapshot"),
		);
		await writeFile(configuration, 'token="different-secret"\n');
		await monitor.scan();
		await monitor.close();
		expect(
			events.some(
				(event) => event.event === "target_snapshot_changed" && event.previousSnapshot && event.currentSnapshot,
			),
		).toBe(true);
		expect(JSON.stringify(events)).not.toContain("never-record-this-secret");
		expect(await readFile(configuration, "utf8")).toBe('token="different-secret"\n');
	});
	it("短命进程按系统事件的 audit token 归属，PID 复用不合并，时间相邻请求只称可能", () => {
		const root = join(fixture.path, "plugins");
		const message = (pidversion: number) => ({
			event_type: "ES_EVENT_TYPE_NOTIFY_WRITE",
			time: "2026-10-26T12:00:00Z",
			process: { audit_token: { pid: 123, pidversion }, executable: { path: "/usr/bin/codex" } },
			event: { write: { target: { path: join(root, "cache", "hooks.json") } } },
		});
		const first = normalizeMacosCodexTargetWriteEvent(message(10), [root], "boot-one");
		const reused = normalizeMacosCodexTargetWriteEvent(message(11), [root], "boot-one");
		if (first?.event !== "confirmed_target_file_writer" || reused?.event !== "confirmed_target_file_writer")
			throw new Error("系统写入事件 fixture 未被识别");
		expect(first.actualWriterProcess.processLifetimeIdentityKey).not.toBe(
			reused.actualWriterProcess.processLifetimeIdentityKey,
		);
		expect(
			normalizeMacosCodexTargetWriteEvent(message(10), [join(fixture.path, "unrelated")], "boot-one"),
		).toBeNull();
		const candidates = resolvePossibleCodexRequestInitiators(first, [
			{ requestId: "request-one", recordedAtEpochMs: Date.parse("2026-10-26T11:59:59Z"), targetRootPath: root },
			{
				requestId: "request-other",
				recordedAtEpochMs: Date.parse("2026-10-26T11:59:59Z"),
				targetRootPath: "/unrelated",
			},
		]);
		expect(candidates).toEqual([{ requestId: "request-one", attribution: "possible_initiating_request" }]);
		const incompleteIdentity = { ...message(10), process: { audit_token: { pid: 123 } } };
		expect(normalizeMacosCodexTargetWriteEvent(incompleteIdentity, [root], "boot-one")).toMatchObject({
			event: "system_writer_coverage_gap",
			reason: "targeted_event_identity_or_schema_unavailable",
			actualWriter: "unknown",
		});
		expect(
			normalizeMacosCodexTargetWriteEvent(incompleteIdentity, [join(fixture.path, "unrelated")], "boot-one"),
		).toBeNull();
	});
});
