import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCodexConfigurationTargetObservationMonitor,
	normalizeMacosCodexTargetWriteEvent,
	resolvePossibleCodexRequestInitiators,
} from "../../../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(async () => {
	fixture = createTempDir("codex-readonly-initiator-trace-");
	fixture.path = await realpath(fixture.path);
	for (const key of ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, fixture.path);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});
describe("只读配置与插件缓存追踪", () => {
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
