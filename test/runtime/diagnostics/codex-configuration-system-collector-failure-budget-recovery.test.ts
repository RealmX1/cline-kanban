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
	Object.assign(new EventEmitter(), {
		pid,
		exitCode: null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	});
let collectors: ReturnType<typeof createControlledCollector>[];

beforeEach(async () => {
	fixture = createTempDir("codex-system-failure-budget-recovery-");
	fixture.path = await realpath(fixture.path);
	observedHome = join(fixture.path, "observed-codex-home");
	evidenceDirectory = join(fixture.path, "persistent-trace-evidence");
	await mkdir(observedHome);
	for (const key of ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, fixture.path);
	vi.stubEnv("KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR", join(fixture.path, "isolated-initial-journal"));
	Object.defineProperty(process, "platform", { value: "darwin" });
	vi.spyOn(process, "getuid").mockReturnValue(501);
	collectors = [];
	controlledSystemCollector.spawn.mockReset();
	controlledSystemCollector.spawn.mockImplementation(() => {
		const collector = createControlledCollector(987654321 + collectors.length);
		collectors.push(collector);
		return collector;
	});
	vi.spyOn(process, "kill").mockImplementation((pid) => {
		const collector = collectors.find((candidate) => pid === -candidate.pid);
		if (!collector) throw new Error("受控测试不允许向其他进程发送信号");
		queueMicrotask(() => collector.emit("close", 0, "SIGTERM"));
		return true;
	});
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

const runTrace = (durationMs = "10") =>
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

describe("系统写入采集失败预算的明确状态与恢复", () => {
	it("非 root 三次失败后的每次复跑都报告预算耗尽，权限指纹变化后重新探测", async () => {
		for (let index = 0; index < 3; index++) await runTrace();
		const existingEvents = (await readEvents()).length;
		await runTrace();
		const resumedEvents = (await readEvents()).slice(existingEvents);
		expect(resumedEvents).toContainEqual(
			expect.objectContaining({
				event: "system_writer_coverage_gap",
				reason: "system_evidence_attempt_budget_exhausted",
				recoveryCondition: expect.stringContaining("指纹"),
			}),
		);
		expect(resumedEvents.some((event) => event.event === "target_listener_ready")).toBe(true);
		expect(controlledSystemCollector.spawn).not.toHaveBeenCalled();
		expect((await readCheckpoint()).systemEvidenceAttempts).toBe(3);
		vi.spyOn(process, "getuid").mockReturnValue(502);
		await runTrace();
		expect((await readCheckpoint()).systemEvidenceAttempts).toBe(1);
	});

	it("受控订阅成功且正常关闭四次，均保留再次订阅资格并明确记录关闭", async () => {
		vi.spyOn(process, "getuid").mockReturnValue(0);
		for (let index = 0; index < 4; index++) {
			const trace = runTrace();
			try {
				await vi.waitFor(
					async () => {
						expect(collectors).toHaveLength(index + 1);
						const name = (await readdir(evidenceDirectory)).find((path) =>
							path.startsWith("system-event-listener-ready-probe-"),
						);
						if (!name) throw new Error("等待受控监听的就绪探针");
						collectors[index]?.stdout.write(
							`${JSON.stringify({ event: { write: { target: { path: join(evidenceDirectory, name) } } } })}\n`,
						);
					},
					{ timeout: 5000 },
				);
			} finally {
				await trace;
			}
			expect((await readCheckpoint()).systemEvidenceAttempts).toBe(0);
		}
		const events = await readEvents();
		expect(events.filter((event) => event.event === "system_writer_listener_ready")).toHaveLength(4);
		expect(events.filter((event) => event.event === "system_writer_listener_stopped")).toHaveLength(4);
		expect(events.some((event) => event.reason === "eslogger_process_exited")).toBe(false);
	});

	it("就绪后的流损坏仍消耗持久失败预算，三次后停止订阅且保留基础采集", async () => {
		vi.spyOn(process, "getuid").mockReturnValue(0);
		for (let index = 0; index < 3; index++) {
			const trace = runTrace("1000");
			try {
				await vi.waitFor(
					async () => {
						expect(collectors).toHaveLength(index + 1);
						const name = (await readdir(evidenceDirectory)).find((path) =>
							path.startsWith("system-event-listener-ready-probe-"),
						);
						if (!name) throw new Error("等待受控监听的就绪探针");
						collectors[index]?.stdout.write(
							`${JSON.stringify({ event: { write: { target: { path: join(evidenceDirectory, name) } } } })}\n`,
						);
					},
					{ timeout: 5000 },
				);
				await vi.waitFor(
					async () => {
						expect(
							(await readEvents()).filter((event) => event.event === "system_writer_listener_ready"),
						).toHaveLength(index + 1);
					},
					{ timeout: 5000 },
				);
				collectors[index]?.stdout.write(`${"非法的系统事件流".repeat(4)}\n`);
			} finally {
				await trace;
			}
			expect((await readCheckpoint()).systemEvidenceAttempts).toBe(index + 1);
		}
		const existingEvents = (await readEvents()).length;
		await runTrace();
		expect(collectors).toHaveLength(3);
		const resumedEvents = (await readEvents()).slice(existingEvents);
		expect(resumedEvents.some((event) => event.reason === "system_evidence_attempt_budget_exhausted")).toBe(true);
		expect(resumedEvents.some((event) => event.event === "target_listener_ready")).toBe(true);
	});
});
