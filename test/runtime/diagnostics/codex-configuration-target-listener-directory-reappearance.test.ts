import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexConfigurationTargetObservationMonitor } from "../../../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
const monitors: ReturnType<typeof createCodexConfigurationTargetObservationMonitor>[] = [];
beforeEach(async () => {
	fixture = createTempDir("codex-target-listener-directory-reappearance-");
	fixture.path = await realpath(fixture.path);
	for (const key of ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, fixture.path);
});
afterEach(async () => {
	for (const monitor of monitors.splice(0)) await monitor.close();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("配置目标目录出现或替换后的监听恢复", () => {
	it.each(["首次创建", "原目录被替换"])("%s 后重建递归监听，采集快照之间短暂出现的内部文件", async (scenario) => {
		const plugins = join(fixture.path, "plugins");
		const cache = join(plugins, "cache");
		await mkdir(plugins);
		if (scenario === "原目录被替换") await mkdir(cache);
		const events: Record<string, unknown>[] = [];
		const monitor = createCodexConfigurationTargetObservationMonitor({
			listTargetPaths: async () => [cache],
			emit: (event) => events.push(event),
			// 此用例只靠原生通知证明采集，不让周期快照掩盖失效监听。
			pollIntervalMs: 60_000,
		});
		monitors.push(monitor);
		await monitor.start();
		if (scenario === "原目录被替换") await rename(cache, join(plugins, "previous-cache"));
		await mkdir(cache);
		await monitor.scan();
		const beforeTransientFile = events.length;
		const transientFile = join(cache, "short-lived-cache-entry.txt");
		await writeFile(transientFile, "只在两次快照之间存在");
		await rm(transientFile);
		await vi.waitFor(
			() =>
				expect(
					events
						.slice(beforeTransientFile)
						.some(
							(event) =>
								event.event === "target_filesystem_notification" &&
								event.relativePath === "short-lived-cache-entry.txt",
						),
				).toBe(true),
			{ timeout: 5000 },
		);
		expect(monitor.getCoverage().fileObservation).toBe("active");
		expect(events.some((event) => event.event === "target_listener_coverage_gap")).toBe(true);
	});
});
