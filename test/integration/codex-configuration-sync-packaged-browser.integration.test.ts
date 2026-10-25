import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexConfigurationWriterBinding } from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

describe.skipIf(!process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH)(
	"打包态配置同步真实浏览器",
	{ timeout: 120_000 },
	() => {
		it("隔离运行时通过推流显示新决定，默认关闭同步，支持键盘、手机布局和稍后处理", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-config-browser-",
			});
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "configuration-sync-ui" });
			await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离浏览器验证\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始化隔离配置同步浏览器仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
			await mkdir(sourceHome);
			await writeFile(join(sourceHome, "config.toml"), 'model="fixture-initial"\n');
			const storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
			const binding = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome,
				workspaceId: "isolated-browser",
				conversationSessionId: "浏览器来源会话",
				runtimeSessionIncarnationId: randomUUID(),
			});
			const writerConfigurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
			const configuration = parse(await readFile(writerConfigurationPath, "utf8"));
			configuration.model = "fixture-updated";
			await writeFile(writerConfigurationPath, stringify(configuration));
			const evidenceDirectory =
				process.env.KANBAN_CODEX_CONFIGURATION_SYNC_BROWSER_EVIDENCE_DIRECTORY ??
				join(fixture.fixtureRootDirectoryPath, "browser-evidence");
			await mkdir(evidenceDirectory, { recursive: true });
			const environment = fixture.createIsolatedChildProcessEnvironment();
			for (const key of Object.keys(environment))
				if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
			environment.CODEX_HOME = sourceHome;
			const cliPath = process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH ?? "";
			const child = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						resolve("test/integration/shutdown-ipc-hook.cjs"),
						cliPath,
						"--port",
						"auto",
						"--no-open",
						"--no-passcode",
					],
					{
						cwd: repository.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				),
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			const { runtimeUrl: origin } = await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			const requireFromWebUi = createRequire(resolve("web-ui/package.json"));
			const { chromium } = requireFromWebUi("playwright-core") as { chromium: BrowserType };
			const browser = await chromium.launch({ headless: true });
			const checks: string[] = [];
			try {
				const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
				const synchronizationRequests: string[] = [];
				page.on("request", (request) => {
					if (request.url().includes("runtime.synchronizeCodexConfigurationChange"))
						synchronizationRequests.push(request.postData() ?? "");
				});
				await page.goto(origin);
				const onboarding = page.getByRole("dialog", { name: "Get started" });
				await onboarding.waitFor({ timeout: 15_000 });
				await onboarding.getByRole("button", { name: "Close", exact: true }).click();
				await onboarding.waitFor({ state: "detached" });
				const notice = page.locator('[data-verification-anchor="codex-configuration-sync-notice"]');
				await notice.waitFor({ timeout: 30_000 });
				expect(await notice.getByRole("switch").getAttribute("aria-checked")).toBe("false");
				expect(await notice.textContent()).toContain("浏览器来源会话");
				checks.push("非模态提示从真实运行时读取来源与变更，默认开关关闭");
				await notice.getByRole("switch").focus();
				await page.keyboard.press("Space");
				await vi.waitFor(
					async () => expect(await notice.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
					{ timeout: 5_000 },
				);
				checks.push("键盘 Space 可以开启同步");
				await page.screenshot({ path: join(evidenceDirectory, "desktop-configuration-sync.png") });
				await notice.getByRole("button", { name: "同步设置", exact: true }).evaluate((element) => {
					(element as { click: () => void }).click();
					(element as { click: () => void }).click();
				});
				await notice.waitFor({ state: "detached", timeout: 15_000 });
				expect(synchronizationRequests).toHaveLength(1);
				expect(synchronizationRequests[0]).toContain('"synchronizeExistingSessions":true');
				checks.push("重复点击仅发出一个带版本和幂等键的同步请求");
				await page.setViewportSize({ width: 390, height: 844 });
				configuration.model = "fixture-next-decision";
				await writeFile(writerConfigurationPath, stringify(configuration));
				await notice.waitFor({ timeout: 15_000 });
				expect(await notice.getByRole("switch").getAttribute("aria-checked")).toBe("false");
				checks.push("文件监听经 WebSocket 显示后续变更，新变更开关重新关闭");
				expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
				await page.screenshot({ path: join(evidenceDirectory, "mobile-configuration-sync.png") });
				await notice.getByRole("button", { name: "配置同步设置" }).click();
				const settings = page.locator('[data-verification-anchor="codex-configuration-sync-settings"]');
				await settings.waitFor({ timeout: 15_000 });
				await vi.waitFor(
					async () => {
						const bounds = await settings.boundingBox();
						expect(bounds?.y).toBeGreaterThanOrEqual(0);
						expect(bounds?.y).toBeLessThan(844);
					},
					{ timeout: 5_000 },
				);
				expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
				checks.push("手机设置入口定位正确，内容无横向溢出");
				await page.screenshot({ path: join(evidenceDirectory, "mobile-configuration-sync-settings.png") });
				await settings.getByRole("button", { name: "稍后处理", exact: true }).click();
				await page.keyboard.press("Escape");
				await notice.waitFor({ state: "detached", timeout: 15_000 });
				await page.reload();
				await page.waitForLoadState("networkidle");
				expect(await notice.count()).toBe(0);
				checks.push("稍后处理保留条目，浏览器重连不重复提醒");
				await writeFile(
					join(evidenceDirectory, "browser-configuration-sync-result.json"),
					JSON.stringify(
						{ status: "passed", checks, synchronizationRequestCount: synchronizationRequests.length },
						null,
						2,
					),
				);
			} catch (error) {
				const page = browser.contexts()[0]?.pages()[0];
				if (page) {
					await page.screenshot({ path: join(evidenceDirectory, "failed-browser-state.png") });
					await writeFile(
						join(evidenceDirectory, "failed-browser-state.txt"),
						await page.locator("body").innerText(),
					);
				}
				throw error;
			} finally {
				await browser.close();
				await writeFile(join(evidenceDirectory, "isolated-runtime.log"), output);
			}
		});
	},
);
