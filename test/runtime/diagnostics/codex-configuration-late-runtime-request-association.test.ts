import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traceCodexConfigurationAndPluginCacheChangeInitiators } from "../../../scripts/trace-codex-configuration-and-plugin-cache-change-initiators";
import { codexConfigurationInitiatorTraceChannel } from "../../../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { waitForPendingDiagnosticEventJournalWrites } from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { createTempDir } from "../../utilities/temp-dir";

const controlledSystemCollector = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: controlledSystemCollector.spawn,
}));

let fixture: ReturnType<typeof createTempDir>;
const originalPlatform = process.platform;
beforeEach(async () => {
	fixture = createTempDir("codex-late-request-bounded-ingest-association-");
	fixture.path = await realpath(fixture.path);
	for (const key of ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, fixture.path);
	vi.stubEnv("KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR", join(fixture.path, "isolated-initial-journal"));
	Object.defineProperty(process, "platform", { value: "darwin" });
	vi.spyOn(process, "getuid").mockReturnValue(0);
	controlledSystemCollector.spawn.mockReset();
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("有界日志读取中的迟到请求补证", () => {
	it.each([
		{ scenario: "下一次读取", oversizedSnapshotBytes: 0 },
		{ scenario: "跨过 5 MiB 记录后的第三次读取", oversizedSnapshotBytes: 5 * 1024 * 1024 },
	])("$scenario 追加可能候选，保持未知因果并去重", async ({ oversizedSnapshotBytes }) => {
		const home = join(fixture.path, "observed-codex-home");
		const source = join(fixture.path, "runtime-request-journal");
		const evidence = join(fixture.path, "persistent-trace-evidence");
		await mkdir(home);
		await mkdir(source);
		const sourcePath = join(source, `${codexConfigurationInitiatorTraceChannel}.jsonl`);
		await writeFile(sourcePath, "");
		const collector = Object.assign(new EventEmitter(), {
			pid: 987654321,
			exitCode: null,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		controlledSystemCollector.spawn.mockReturnValue(collector);
		vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid !== -collector.pid) throw new Error("受控测试不允许向其他进程发送信号");
			collector.stdout.end(() => setImmediate(() => collector.emit("close", 0, "SIGTERM")));
			return true;
		});
		let triggerRuntimeJournalRefresh: () => void = () => {
			throw new Error("运行时刷新周期尚未注册");
		};
		const originalSetInterval = globalThis.setInterval;
		vi.spyOn(globalThis, "setInterval").mockImplementation((handler, intervalMs, ...parameters) => {
			if (intervalMs === 1000) {
				triggerRuntimeJournalRefresh = () => handler(...parameters);
				return originalSetInterval(() => {}, intervalMs);
			}
			return originalSetInterval(handler, intervalMs, ...parameters);
		});
		const trace = traceCodexConfigurationAndPluginCacheChangeInitiators([
			"--target-home",
			home,
			"--runtime-journal-directory",
			source,
			"--evidence-directory",
			evidence,
			"--macos-write-events",
			"--duration-ms",
			"15000",
		]);
		const readEvents = async () => {
			await waitForPendingDiagnosticEventJournalWrites();
			return (
				await readFile(
					join(evidence, "diagnostic-event-journals", `${codexConfigurationInitiatorTraceChannel}.jsonl`),
					"utf8",
				)
			)
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		};
		const readCheckpoint = async () =>
			JSON.parse(await readFile(join(evidence, "trace-checkpoint.json"), "utf8")) as {
				journalCursor: { byteOffset: number; discardingOversizedRecord: boolean } | null;
			};
		try {
			let readyProbePath = "";
			await vi.waitFor(
				async () => {
					const name = (await readdir(evidence)).find((path) =>
						path.startsWith("system-event-listener-ready-probe-"),
					);
					if (!name) throw new Error("等待受控系统监听的就绪探针");
					readyProbePath = join(evidence, name);
				},
				{ timeout: 5000 },
			);
			collector.stdout.write(`${JSON.stringify({ event: { write: { target: { path: readyProbePath } } } })}\n`);
			await vi.waitFor(
				async () => {
					expect((await readCheckpoint()).journalCursor?.byteOffset).toBe(0);
				},
				{ timeout: 5000 },
			);
			const writerTime = Date.now();
			const knownRequest = {
				channel: codexConfigurationInitiatorTraceChannel,
				event: "known_native_request",
				requestId: "request-ingested-after-confirmed-writer",
				targetRootPath: join(home, "config.toml"),
				recordedAtIso: new Date(writerTime - 1).toISOString(),
			};
			const requests = [
				knownRequest,
				{ ...knownRequest, requestId: "unrelated-target", targetRootPath: join(home, "hooks.json") },
				{
					...knownRequest,
					requestId: "outside-time-window",
					recordedAtIso: new Date(writerTime - 10_001).toISOString(),
				},
				{ ...knownRequest, requestId: "after-writer-event", recordedAtIso: new Date(writerTime + 1).toISOString() },
			];
			const snapshotPrefix = oversizedSnapshotBytes
				? `${JSON.stringify({ event: "snapshot", text: "占".repeat(Math.ceil(oversizedSnapshotBytes / 3)) })}\n`
				: "";
			await appendFile(
				sourcePath,
				`${snapshotPrefix}${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
			);
			collector.stdout.write(
				`${JSON.stringify({
					event_type: "ES_EVENT_TYPE_NOTIFY_WRITE",
					time: new Date(writerTime).toISOString(),
					process: { audit_token: { pid: 123, pidversion: 4 }, executable: { path: "/fixture/codex" } },
					event: { write: { target: { path: join(home, "config.toml") } } },
				})}\n`,
			);
			await vi.waitFor(
				async () => {
					expect((await readEvents()).some((event) => event.event === "confirmed_target_file_writer")).toBe(true);
				},
				{ timeout: 5000 },
			);
			const totalSourceBytes = (await stat(sourcePath)).size;
			for (let consumedBytes = 0; consumedBytes < totalSourceBytes; ) {
				const expectedOffset = Math.min(totalSourceBytes, consumedBytes + 2 * 1024 * 1024);
				triggerRuntimeJournalRefresh();
				await vi.waitFor(
					async () => {
						expect((await readCheckpoint()).journalCursor?.byteOffset).toBe(expectedOffset);
					},
					{ timeout: 5000 },
				);
				consumedBytes = expectedOffset;
				if (consumedBytes < totalSourceBytes) {
					expect((await readCheckpoint()).journalCursor?.discardingOversizedRecord).toBe(true);
					expect(
						(await readEvents()).some(
							(event) => event.event === "possible_initiating_request_evidence_supplemented",
						),
					).toBe(false);
				}
			}
			const writer = (await readEvents()).find((event) => event.event === "confirmed_target_file_writer");
			expect(writer).toMatchObject({ initiatingRequest: "unknown", possibleInitiatingRequests: [] });
			expect(
				(await readEvents()).filter((event) => event.event === "possible_initiating_request_evidence_supplemented"),
			).toHaveLength(1);
			expect(writer?.writerEvidenceId).toEqual(expect.any(String));
			expect(
				(await readEvents()).filter((event) => event.event === "possible_initiating_request_evidence_supplemented"),
			).toEqual([
				expect.objectContaining({
					supplementedWriterEvidenceId: writer?.writerEvidenceId,
					initiatingRequest: "unknown",
					possibleInitiatingRequests: [
						{ requestId: knownRequest.requestId, attribution: "possible_initiating_request" },
					],
				}),
			]);
			await appendFile(sourcePath, `${JSON.stringify(knownRequest)}\n`);
			triggerRuntimeJournalRefresh();
			await vi.waitFor(
				async () => {
					expect((await readCheckpoint()).journalCursor?.byteOffset).toBe((await stat(sourcePath)).size);
				},
				{ timeout: 5000 },
			);
			expect(
				(await readEvents()).filter((event) => event.event === "possible_initiating_request_evidence_supplemented"),
			).toHaveLength(1);
		} finally {
			process.emit("SIGTERM");
			await trace;
		}
	});
});
