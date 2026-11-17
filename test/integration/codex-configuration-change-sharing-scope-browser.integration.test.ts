import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, it, vi } from "vitest";
import { closeCodexConfigurationSyncDatabase } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
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

it.skipIf(!process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH)(
	"打包浏览器的单次范围切换支持键盘、窄屏、主题与历史恢复",
	async (test) => {
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "codex-sharing-scope-browser-",
		});
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "sharing-scope-browser" });
		await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离范围切换验证\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离浏览器仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const { workspaceId } = await loadWorkspaceContext(repository.repositoryPath);
		const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
		vi.stubEnv("CODEX_HOME", sourceHome);
		vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
		await mkdir(sourceHome);
		await writeFile(
			join(sourceHome, "config.toml"),
			stringify({ model: "fixture-model", tui: { alternate_screen: "always" } }),
		);
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			workspaceId,
			conversationSessionId: "范围来源会话",
			runtimeSessionIncarnationId: randomUUID(),
		});
		const configurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		configuration.tui = { alternate_screen: "never" };
		await writeFile(configurationPath, stringify(configuration));
		await writeFile(
			join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban", "config.json"),
			JSON.stringify({ selectedAgentId: "codex", agentSessionPtyHostEnablementPreference: "disabled" }),
		);
		await closeCodexConfigurationSyncDatabase();
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
		environment.CODEX_HOME = sourceHome;
		environment.CODEX_SQLITE_HOME = sourceHome;
		environment.KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT = join(
			fixture.fixtureRootDirectoryPath,
			"isolated-relation-ledger",
		);
		const child = children.register(
			spawn(
				process.execPath,
				[
					"--require",
					resolve("test/integration/shutdown-ipc-hook.cjs"),
					process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH ?? "未配置候选 CLI",
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
		test.onTestFinished(() => browser.close());
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
		await page.goto(runtimeUrl, { waitUntil: "domcontentloaded" });
		const notice = page.locator('[data-verification-anchor="codex-configuration-sync-notice"]');
		await notice.waitFor({ state: "visible", timeout: 45_000 });
		const trigger = notice.locator('[aria-label*="本次修改的共享范围"]').first();
		expect(await trigger.textContent()).toContain("共享到配置方案");
		await trigger.focus();
		await page.keyboard.press("ArrowDown");
		await page.getByRole("menuitemradio", { name: "仅本会话", exact: true }).click();
		await vi.waitFor(async () => expect(await trigger.textContent()).toContain("仅本会话"), { timeout: 15_000 });
		const evidenceDirectory = process.env.KANBAN_CODEX_CONFIGURATION_SYNC_EVIDENCE_DIRECTORY;
		const measurements: Array<{ theme: string; width: number; contrast: number; label: string }> = [];
		for (const width of [1280, 390]) {
			await page.setViewportSize({ width, height: 900 });
			for (const theme of ["graphite", "light", "high-contrast-dark", "high-contrast-light"]) {
				await page.locator("html").evaluate((element, value) => {
					element.setAttribute("data-theme", value);
				}, theme);
				const result = await trigger.evaluate((element) => {
					const ownerDocument = element.ownerDocument;
					const ownerWindow = ownerDocument.defaultView;
					if (!ownerWindow) throw new Error("浏览器视窗尚未就绪。");
					const canvas = ownerDocument.createElement("canvas");
					canvas.width = 1;
					canvas.height = 1;
					const context = canvas.getContext("2d");
					if (!context) throw new Error("浏览器未提供颜色采样画布。");
					const ancestors: Array<typeof element> = [];
					let current: typeof element | null = element;
					while (current) {
						ancestors.unshift(current);
						current = current.parentElement;
					}
					context.fillStyle = "white";
					context.fillRect(0, 0, 1, 1);
					for (const ancestor of ancestors) {
						context.fillStyle = ownerWindow.getComputedStyle(ancestor).backgroundColor;
						context.fillRect(0, 0, 1, 1);
					}
					const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
					context.fillStyle = ownerWindow.getComputedStyle(element).color;
					context.fillRect(0, 0, 1, 1);
					const foreground = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
					const luminance = (channels: number[]) =>
						channels
							.map((value) => {
								const normalized = value / 255;
								return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
							})
							.reduce((sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? Number.NaN), 0);
					const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
					return {
						contrast: ((values[1] ?? Number.NaN) + 0.05) / ((values[0] ?? Number.NaN) + 0.05),
						label: element.textContent ?? "",
						overflow: ownerDocument.documentElement.scrollWidth > ownerWindow.innerWidth + 1,
					};
				});
				expect(result.contrast).toBeGreaterThanOrEqual(4.5);
				expect(result.overflow).toBe(false);
				measurements.push({ theme, width, contrast: result.contrast, label: result.label });
				if (evidenceDirectory) {
					await mkdir(evidenceDirectory, { recursive: true });
					await page.screenshot({ path: join(evidenceDirectory, `scope-session-only-${theme}-${width}.png`) });
				}
			}
		}
		await trigger.click();
		await page.getByRole("menuitemradio", { name: "共享到配置方案", exact: true }).click();
		await vi.waitFor(async () => expect(await trigger.textContent()).toContain("共享到配置方案"), {
			timeout: 15_000,
		});
		if (evidenceDirectory) {
			await page.screenshot({ path: join(evidenceDirectory, "scope-shared-390.png") });
			await writeFile(
				join(evidenceDirectory, "browser-sharing-scope-measurements.json"),
				JSON.stringify(measurements, null, 2),
			);
		}
		await notice.getByRole("button", { name: "收起", exact: true }).click();
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator('[data-verification-anchor="codex-configuration-sync-summary"]').waitFor({ timeout: 30_000 });
		expect(await notice.isVisible()).toBe(false);
	},
	120_000,
);
