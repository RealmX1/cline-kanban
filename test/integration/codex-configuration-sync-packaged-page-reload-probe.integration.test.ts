import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeCodexConfigurationSyncDatabase,
	restoreLatestCodexConfigurationSyncLegacyStorage,
} from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { loadWorkspaceContext } from "../../src/state/workspace-state";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	await closeCodexConfigurationSyncDatabase();
	vi.unstubAllEnvs();
});

describe.skipIf(
	!process.env.KANBAN_CODEX_CONFIGURATION_SYNC_BASELINE_CLI_PATH ||
		!process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH,
)("冻结版本与候选打包页刷新对照", { timeout: 210_000 }, () => {
	it.each(["baseline", "candidate"] as const)("%s 初始配置读取和同页刷新", async (variant) => {
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "codex-configuration-page-reload-",
		});
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "configuration-reload-probe" });
		await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离页面刷新对照\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离刷新对照",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const { workspaceId } = await loadWorkspaceContext(repository.repositoryPath);
		const home = join(fixture.isolatedHomeDirectoryPath, ".codex");
		await mkdir(home);
		vi.stubEnv("CODEX_HOME", home);
		vi.stubEnv("CODEX_SQLITE_HOME", home);
		await writeFile(join(home, "config.toml"), 'model = "initial-model"\n');
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: home,
			workspaceId,
			conversationSessionId: "reload-probe",
			runtimeSessionIncarnationId: randomUUID(),
		});
		await writeFile(join(binding.configurationHomeDirectoryPath, "config.toml"), 'model = "updated-model"\n');
		if (variant === "baseline") await restoreLatestCodexConfigurationSyncLegacyStorage();
		await closeCodexConfigurationSyncDatabase();
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
		environment.CODEX_HOME = home;
		environment.CODEX_SQLITE_HOME = home;
		const cli =
			variant === "baseline"
				? process.env.KANBAN_CODEX_CONFIGURATION_SYNC_BASELINE_CLI_PATH
				: process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH;
		if (!cli) throw new Error("对照候选未配置");
		const child = children.register(
			spawn(
				process.execPath,
				[
					"--require",
					resolve("test/integration/shutdown-ipc-hook.cjs"),
					cli,
					"--port",
					"auto",
					"--no-open",
					"--no-passcode",
				],
				{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
			),
		);
		const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(child);
		const { chromium } = createRequire(resolve("web-ui/package.json"))("playwright-core") as {
			chromium: BrowserType;
		};
		const browser = await chromium.launch({ headless: true });
		const evidence =
			process.env.KANBAN_CODEX_CONFIGURATION_SYNC_BROWSER_EVIDENCE_DIRECTORY ?? fixture.fixtureRootDirectoryPath;
		await mkdir(evidence, { recursive: true });
		const observations: unknown[] = [];
		try {
			const page = await browser.newPage({ serviceWorkers: "block" });
			page.on("request", (request) =>
				observations.push({ kind: "request", at: Date.now(), url: request.url().split("?")[0] }),
			);
			page.on("requestfailed", (request) =>
				observations.push({
					kind: "failed",
					url: request.url().split("?")[0],
					error: request.failure()?.errorText,
				}),
			);
			page.on("pageerror", (error) => observations.push({ kind: "pageerror", error: error.message }));
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			await page.route(
				(url) => /^https?:$/.test(url.protocol) && url.origin !== new URL(runtimeUrl).origin,
				(route) => route.abort(),
			);
			page.on("response", (response) => {
				if (response.url().includes("/api/"))
					observations.push({ at: Date.now(), status: response.status(), url: response.url().split("?")[0] });
			});
			await page.goto(new URL(`/${workspaceId}`, runtimeUrl).href, { waitUntil: "commit" });
			const summary = page.locator('[data-verification-anchor="codex-configuration-sync-summary"]');
			await summary.waitFor({ timeout: 90_000 });
			observations.push({ phase: "initial_ready", at: Date.now() });
			await page.reload({ waitUntil: "commit" });
			await summary.waitFor({ timeout: 90_000 });
			observations.push({ phase: "reload_ready", at: Date.now() });
			expect(await summary.isVisible()).toBe(true);
		} finally {
			const page = browser.contexts()[0]?.pages()[0];
			if (page)
				observations.push({ kind: "final_dom", url: page.url(), body: await page.locator("body").innerText() });
			await writeFile(join(evidence, `page-reload-probe-${variant}.json`), JSON.stringify(observations, null, 2));
			await browser.close();
		}
	});
});
