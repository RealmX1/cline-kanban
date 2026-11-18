import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traceCodexConfigurationAndPluginCacheChangeInitiators } from "../../../scripts/trace-codex-configuration-and-plugin-cache-change-initiators";
import { codexConfigurationInitiatorTraceChannel } from "../../../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { createTempDir } from "../../utilities/temp-dir";

const controlledSystemCollector = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: controlledSystemCollector.spawn,
}));

let fixture: ReturnType<typeof createTempDir>;
let observedHome: string;
let evidenceDirectory: string;
const originalPlatform = process.platform;
const createControlledCollector = (pid: number) =>
	Object.assign(new EventEmitter(), { pid, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
type ControlledCollector = ReturnType<typeof createControlledCollector>;
let collectors: ControlledCollector[];
let collectorsWithCloseScheduled: WeakSet<ControlledCollector>;

function finishCollectorStdoutBeforeProcessClose(collector: ControlledCollector, signal: string | null) {
	if (collectorsWithCloseScheduled.has(collector)) return;
	collectorsWithCloseScheduled.add(collector);
	collector.stdout.once("end", () => setImmediate(() => collector.emit("close", 0, signal)));
	collector.stdout.end();
}

beforeEach(async () => {
	fixture = createTempDir("codex-system-intentional-shutdown-eof-");
	fixture.path = await realpath(fixture.path);
	observedHome = join(fixture.path, "observed-codex-home");
	evidenceDirectory = join(fixture.path, "persistent-trace-evidence");
	await mkdir(observedHome);
	for (const key of ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, fixture.path);
	vi.stubEnv("KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR", join(fixture.path, "isolated-initial-journal"));
	Object.defineProperty(process, "platform", { value: "darwin" });
	vi.spyOn(process, "getuid").mockReturnValue(0);
	collectors = [];
	collectorsWithCloseScheduled = new WeakSet();
	controlledSystemCollector.spawn.mockReset();
	controlledSystemCollector.spawn.mockImplementation((binary: string) => {
		if (binary !== "/usr/bin/eslogger") throw new Error("受控测试不允许启动其他进程");
		const collector = createControlledCollector(987654321 + collectors.length);
		collectors.push(collector);
		return collector;
	});
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		const collector = collectors.find((candidate) => pid === -candidate.pid);
		if (!collector) throw new Error("受控测试不允许向其他进程发送信号");
		finishCollectorStdoutBeforeProcessClose(collector, String(signal));
		return true;
	});
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

const runTrace = (durationMs = "1000") =>
	traceCodexConfigurationAndPluginCacheChangeInitiators([
		"--target-home",
		observedHome,
		"--evidence-directory",
		evidenceDirectory,
		"--macos-write-events",
		"--duration-ms",
		durationMs,
	]);
const readEvents = async () =>
	(
		await readFile(
			join(evidenceDirectory, "diagnostic-event-journals", `${codexConfigurationInitiatorTraceChannel}.jsonl`),
			"utf8",
		)
	)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
const readCheckpoint = async () =>
	JSON.parse(await readFile(join(evidenceDirectory, "trace-checkpoint.json"), "utf8")) as {
		systemEvidenceAttempts: number;
	};

async function waitForControlledSubscriptionReady(collectorIndex: number, existingEventCount: number) {
	await vi.waitFor(
		async () => {
			expect(collectors).toHaveLength(collectorIndex + 1);
			const probeName = (await readdir(evidenceDirectory)).find((name) =>
				name.startsWith("system-event-listener-ready-probe-"),
			);
			if (!probeName) throw new Error("等待受控监听的就绪探针");
			collectors[collectorIndex]?.stdout.write(
				`${JSON.stringify({ event: { write: { target: { path: join(evidenceDirectory, probeName) } } } })}\n`,
			);
		},
		{ timeout: 5000 },
	);
	await vi.waitFor(
		async () => {
			expect(
				(await readEvents())
					.slice(existingEventCount)
					.some((event) => event.event === "system_writer_listener_ready"),
			).toBe(true);
		},
		{ timeout: 5000 },
	);
	const collector = collectors[collectorIndex];
	if (!collector) throw new Error("缺少受控系统采集器");
	return collector;
}

describe("系统采集正常关闭与活动期损坏分别处理 EOF", { timeout: 60_000 }, () => {
	it("正常关闭的半条 JSON EOF 保留覆盖缺口，连续四次仍可重新订阅", async () => {
		for (let index = 0; index < 4; index++) {
			const existingEventCount = index === 0 ? 0 : (await readEvents()).length;
			const trace = runTrace();
			try {
				const collector = await waitForControlledSubscriptionReady(index, existingEventCount);
				collector.stdout.write('{"event":{"write":');
			} finally {
				await trace;
			}
			const events = (await readEvents()).slice(existingEventCount);
			expect(events).toContainEqual(
				expect.objectContaining({
					event: "system_writer_coverage_gap",
					reason: "system_event_stream_truncated_during_intentional_shutdown",
				}),
			);
			expect(events.filter((event) => event.event === "system_writer_listener_stopped")).toHaveLength(1);
			expect(events.some((event) => event.reason === "eslogger_process_exited")).toBe(false);
			expect(events.some((event) => event.reason === "system_evidence_attempt_budget_exhausted")).toBe(false);
			expect((await readCheckpoint()).systemEvidenceAttempts).toBe(0);
		}
		expect(collectors).toHaveLength(4);
	});

	it.each(["malformed_active_stream", "unexpected_partial_json_eof"] as const)(
		"活动期 %s 继续累计失败预算，耗尽后保留缺口与基础采集",
		async (failureMode) => {
			for (let index = 0; index < 3; index++) {
				const existingEventCount = index === 0 ? 0 : (await readEvents()).length;
				const trace = runTrace();
				try {
					const collector = await waitForControlledSubscriptionReady(index, existingEventCount);
					if (failureMode === "malformed_active_stream")
						collector.stdout.write(`${"非法的系统事件流".repeat(4)}\n`);
					else {
						collector.stdout.write('{"event":{"write":');
						finishCollectorStdoutBeforeProcessClose(collector, null);
					}
				} finally {
					await trace;
				}
				const events = (await readEvents()).slice(existingEventCount);
				expect(events.some((event) => event.reason === "system_event_stream_invalid_or_lost")).toBe(true);
				expect(
					events.some((event) => event.reason === "system_event_stream_truncated_during_intentional_shutdown"),
				).toBe(false);
				expect((await readCheckpoint()).systemEvidenceAttempts).toBe(index + 1);
			}
			const existingEventCount = (await readEvents()).length;
			await runTrace("10");
			const resumedEvents = (await readEvents()).slice(existingEventCount);
			expect(collectors).toHaveLength(3);
			expect(resumedEvents.some((event) => event.reason === "system_evidence_attempt_budget_exhausted")).toBe(true);
			expect(resumedEvents.some((event) => event.event === "target_listener_ready")).toBe(true);
		},
	);
});
