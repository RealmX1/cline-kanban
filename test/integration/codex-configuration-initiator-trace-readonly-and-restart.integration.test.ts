import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { traceCodexConfigurationAndPluginCacheChangeInitiators } from "../../scripts/trace-codex-configuration-and-plugin-cache-change-initiators";
import { createTempDir } from "../utilities/temp-dir";

const executeFile = promisify(execFile);
describe("追踪脚本的隔离运行与重启恢复", () => {
	it("只读观察、权限不足明确降级，监听先就绪，重启不重跑短命命令", async () => {
		expect(typeof traceCodexConfigurationAndPluginCacheChangeInitiators).toBe("function");
		const fixture = createTempDir("codex-trace-readonly-restart-");
		fixture.path = await realpath(fixture.path);
		try {
			const home = join(fixture.path, "isolated-codex-home");
			await mkdir(home);
			const configurationPath = join(home, "config.toml");
			const initialText = 'model="fixture"\napi_key="secret-not-for-evidence"\n';
			await writeFile(configurationPath, initialText);
			const evidence = join(fixture.path, "evidence");
			const counter = join(fixture.path, "command-execution-count.txt");
			const command = [
				process.execPath,
				"-e",
				`require('node:fs').appendFileSync(${JSON.stringify(counter)},'executed\\n')`,
			];
			const arguments_ = [
				"--import",
				"tsx",
				resolve("scripts/trace-codex-configuration-and-plugin-cache-change-initiators.ts"),
				"--target-home",
				home,
				"--evidence-directory",
				evidence,
				"--macos-write-events",
				"--duration-ms",
				"300",
				"--",
				...command,
			];
			const environment = {
				...process.env,
				HOME: fixture.path,
				CODEX_HOME: home,
				CODEX_SQLITE_HOME: home,
				KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR: join(fixture.path, "isolated-runtime-journal"),
			};
			const cache = join(home, "plugins", "cache");
			await mkdir(cache, { recursive: true });
			const invalidEvidence = join(cache, "diagnostic-evidence-must-not-be-created");
			const invalidArguments = arguments_.map((argument) => (argument === evidence ? invalidEvidence : argument));
			await expect(
				executeFile(process.execPath, invalidArguments, { env: environment, timeout: 15000 }),
			).rejects.toThrow("被观察目标之外");
			await expect(lstat(invalidEvidence)).rejects.toMatchObject({ code: "ENOENT" });
			const [first] = await Promise.all([
				executeFile(process.execPath, arguments_, { env: environment, timeout: 15_000 }),
				executeFile(process.execPath, arguments_, { env: environment, timeout: 15_000 }),
			]);
			expect(first.stdout).toContain("追踪已就绪");
			const updatedText = initialText.replace("fixture", "updated-between-restarts");
			await writeFile(configurationPath, updatedText);
			await executeFile(process.execPath, arguments_, { env: environment, timeout: 15_000 });
			expect(await readFile(counter, "utf8")).toBe("executed\n");
			expect(await readFile(configurationPath, "utf8")).toBe(updatedText);
			const journalText = await readFile(
				join(evidence, "diagnostic-event-journals", "codex-configuration-and-plugin-cache-initiator-trace.jsonl"),
				"utf8",
			);
			expect(journalText).not.toContain("secret-not-for-evidence");
			expect(journalText).toContain("target_snapshot_changed");
			const events = journalText
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.findIndex((event) => event.event === "target_listener_ready")).toBeLessThan(
				events.findIndex((event) => event.event === "diagnostic_command_started_after_listeners_and_snapshot"),
			);
			expect(events.some((event) => event.event === "diagnostic_command_not_reexecuted_on_resume")).toBe(true);
			if (process.getuid?.() !== 0)
				expect(events.some((event) => event.event === "system_writer_coverage_gap")).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});
