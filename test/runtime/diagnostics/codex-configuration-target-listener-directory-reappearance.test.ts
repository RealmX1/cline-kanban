import { appendFile, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
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

describe("配置目标目录出现或替换后的监听恢复", { timeout: 30_000 }, () => {
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
		const readinessProbeName = "listener-readiness-probe.txt";
		const receivedFilesystemNotification = (event: Record<string, unknown>, relativePath: string) =>
			event.event === "target_filesystem_notification" && event.relativePath === relativePath;
		// watch() 返回后，等待新的原生监听实际收到事件再写入待断言的短命文件。
		await vi.waitFor(
			async () => {
				if (events.some((event) => receivedFilesystemNotification(event, readinessProbeName))) return;
				await appendFile(join(cache, readinessProbeName), ".");
				expect(events.some((event) => receivedFilesystemNotification(event, readinessProbeName))).toBe(true);
			},
			{ timeout: 10_000, interval: 100 },
		);
		const beforeTransientFile = events.length;
		const transientFileName = "short-lived-cache-entry.txt";
		const transientFile = join(cache, transientFileName);
		await writeFile(transientFile, "只在两次快照之间存在");
		// 原生通知可能合并同轮创建和删除；确认监听收到事件后再移除，期间不触发快照。
		await vi.waitFor(
			() =>
				expect(
					events
						.slice(beforeTransientFile)
						.some((event) => receivedFilesystemNotification(event, transientFileName)),
				).toBe(true),
			{ timeout: 10_000 },
		);
		await rm(transientFile);
		expect(monitor.getCoverage().fileObservation).toBe("active");
		expect(events.some((event) => event.event === "target_listener_coverage_gap")).toBe(true);
	});
});
