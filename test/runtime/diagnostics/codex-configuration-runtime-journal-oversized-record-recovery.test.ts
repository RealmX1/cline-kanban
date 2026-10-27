import { appendFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traceCodexConfigurationAndPluginCacheChangeInitiators } from "../../../scripts/trace-codex-configuration-and-plugin-cache-change-initiators";
import { codexConfigurationInitiatorTraceChannel } from "../../../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(async () => {
	fixture = createTempDir("codex-journal-oversized-record-recovery-");
	fixture.path = await realpath(fixture.path);
	for (const key of ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, fixture.path);
	vi.stubEnv("KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR", join(fixture.path, "isolated-initial-journal"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("运行时追踪日志的超预算记录接续", () => {
	it("有界跳过跨窗口大记录，重启接续跳过状态并读取后续请求", async () => {
		const home = join(fixture.path, "observed-codex-home");
		const source = join(fixture.path, "runtime-request-journal");
		const evidence = join(fixture.path, "persistent-trace-evidence");
		await mkdir(home);
		await mkdir(source);
		const journalPath = join(source, `${codexConfigurationInitiatorTraceChannel}.jsonl`);
		await writeFile(journalPath, "");
		const run = () =>
			traceCodexConfigurationAndPluginCacheChangeInitiators([
				"--target-home",
				home,
				"--runtime-journal-directory",
				source,
				"--evidence-directory",
				evidence,
				"--duration-ms",
				"1",
			]);
		await run();
		const oversizedSnapshot = JSON.stringify({
			event: "snapshot",
			text: "故".repeat(Math.ceil((5 * 1024 * 1024) / 3)),
		});
		await appendFile(
			journalPath,
			`${oversizedSnapshot}\n${JSON.stringify({
				channel: codexConfigurationInitiatorTraceChannel,
				event: "known_native_request",
				requestId: "request-after-oversized-snapshot",
				targetRootPath: home,
				recordedAtIso: new Date().toISOString(),
			})}\n`,
		);
		await run();
		const checkpointPath = join(evidence, "trace-checkpoint.json");
		const interruptedCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
		expect(interruptedCheckpoint.journalCursor.byteOffset).toBe(4 * 1024 * 1024);
		expect(interruptedCheckpoint.journalCursor.discardingOversizedRecord).toBe(true);
		await run();
		const completedCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
		expect(completedCheckpoint.journalCursor.byteOffset).toBe((await stat(journalPath)).size);
		expect(completedCheckpoint.journalCursor.discardingOversizedRecord).toBe(false);
		const events = (
			await readFile(
				join(evidence, "diagnostic-event-journals", `${codexConfigurationInitiatorTraceChannel}.jsonl`),
				"utf8",
			)
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(events.filter((event) => event.reason === "record_exceeds_read_budget")).toHaveLength(1);
		expect(
			events.filter((event) => event.nativeRequestEvidence?.requestId === "request-after-oversized-snapshot"),
		).toHaveLength(1);
	});
});
