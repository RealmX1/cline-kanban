import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexConfigurationSyncStore } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
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
			vi.stubEnv("CODEX_HOME", sourceHome);
			vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
			await writeFile(
				join(sourceHome, "hooks.json"),
				JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "printf original" }] }] } }),
			);
			await writeFile(
				join(sourceHome, "config.toml"),
				stringify({
					model: "fixture-initial",
					hooks: {
						state: { [`${sourceHome}/hooks.json:stop:0:0`]: { enabled: false, trusted_hash: "fixture-trust" } },
					},
				}),
			);
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
			configuration.model_reasoning_effort = "high";
			await writeFile(writerConfigurationPath, stringify(configuration));
			const evidenceDirectory =
				process.env.KANBAN_CODEX_CONFIGURATION_SYNC_BROWSER_EVIDENCE_DIRECTORY ??
				join(fixture.fixtureRootDirectoryPath, "browser-evidence");
			await mkdir(evidenceDirectory, { recursive: true });
			const environment = fixture.createIsolatedChildProcessEnvironment();
			for (const key of Object.keys(environment))
				if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
			environment.CODEX_HOME = sourceHome;
			environment.CODEX_SQLITE_HOME = sourceHome;
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
					if (request.url().includes("runtime.batchCodexConfigurationAction"))
						synchronizationRequests.push(request.postData() ?? "");
				});
				await page.goto(origin);
				const onboarding = page.getByRole("dialog", { name: "Get started" });
				await onboarding.waitFor({ timeout: 15_000 });
				await onboarding.getByRole("button", { name: "Close", exact: true }).click();
				await onboarding.waitFor({ state: "detached" });
				const notice = page.locator('[data-verification-anchor="codex-configuration-sync-notice"]');
				await notice.waitFor({ timeout: 30_000 });
				expect(await notice.textContent()).toContain("待审批 2 项");
				expect(await notice.getByRole("switch").count()).toBe(0);
				expect(
					(await readCodexConfigurationSyncStore()).sources[binding.sourceIdentity].fields[
						JSON.stringify(["config.toml", "model"])
					].value,
				).toBe("fixture-initial");
				await notice.getByRole("button", { name: "收起", exact: true }).focus();
				await page.keyboard.press("Space");
				await page.reload();
				await notice.getByRole("button", { name: "展开", exact: true }).waitFor();
				configuration.hide_agent_reasoning = true;
				await writeFile(writerConfigurationPath, stringify(configuration));
				await vi.waitFor(async () => expect(await notice.textContent()).toContain("待审批 3 项"), {
					timeout: 15_000,
				});
				expect(await notice.getByRole("button", { name: "展开", exact: true }).getAttribute("aria-expanded")).toBe(
					"false",
				);
				await page.screenshot({ path: join(evidenceDirectory, "desktop-configuration-notice-collapsed.png") });
				checks.push("键盘收起后，跨刷新与新条目保持收起；审批前默认值未变化");
				await notice.getByRole("button", { name: "展开", exact: true }).click();
				await notice.getByRole("checkbox", { name: "全选当前筛选结果中的设置", exact: true }).check();
				const selectedCount = await notice
					.getByRole("checkbox")
					.evaluateAll(
						(elements) => elements.filter((element) => (element as { checked: boolean }).checked).length,
					);
				const readingContainer = notice.locator(".overflow-y-auto");
				const previousReadingPosition = await readingContainer.evaluate((element) => {
					element.scrollTop = 120;
					return element.scrollTop;
				});
				expect(previousReadingPosition).toBeGreaterThan(0);
				await notice.getByRole("button", { name: "收起", exact: true }).click();
				await notice.getByRole("button", { name: "展开", exact: true }).click();
				expect(await readingContainer.evaluate((element) => element.scrollTop)).toBe(previousReadingPosition);
				expect(
					await notice
						.getByRole("checkbox")
						.evaluateAll(
							(elements) => elements.filter((element) => (element as { checked: boolean }).checked).length,
						),
				).toBe(selectedCount);
				await readingContainer.evaluate((element) => {
					element.scrollTop = 0;
				});
				await page.screenshot({ path: join(evidenceDirectory, "desktop-configuration-approval.png") });
				await notice.getByRole("button", { name: "批量通过", exact: true }).evaluate((element) => {
					(element as { click: () => void }).click();
					(element as { click: () => void }).click();
				});
				await notice.waitFor({ state: "detached", timeout: 15_000 });
				expect(synchronizationRequests).toHaveLength(1);
				expect(synchronizationRequests[0]).toContain('"action":"approve"');
				const future = await prepareCodexConfigurationWriterBinding({
					purpose: "native_session",
					storageHome,
					workspaceId: "isolated-browser",
					conversationSessionId: "future-after-approval",
					runtimeSessionIncarnationId: randomUUID(),
				});
				expect(
					parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).model,
				).toBe("fixture-updated");
				checks.push("选择与阅读位置在折叠后保留；重复点击只提交一次批量审批，通过后未来 writer 采用默认");
				await writeFile(
					join(sourceHome, "hooks.json"),
					JSON.stringify({
						hooks: { Stop: [{ hooks: [{ type: "command", command: "printf updated-definition" }] }] },
					}),
				);
				await notice.waitFor({ timeout: 15_000 });
				await notice.getByRole("button", { name: "确认", exact: true }).waitFor();
				expect(await notice.textContent()).toContain("待审批 0 项 · 来源更新 1 条");
				expect(await notice.getByRole("button", { name: "通过", exact: true }).count()).toBe(0);
				await notice.getByRole("button", { name: "确认", exact: true }).click();
				await notice.waitFor({ state: "detached", timeout: 15_000 });
				checks.push("来源定义变更独立提示，不计设置审批，只有确认和稍后");
				await page.setViewportSize({ width: 390, height: 844 });
				configuration.model = "fixture-next-decision";
				await writeFile(writerConfigurationPath, stringify(configuration));
				await notice.waitFor({ timeout: 15_000 });
				expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
				await page.screenshot({ path: join(evidenceDirectory, "mobile-configuration-approval.png") });
				await notice.getByRole("button", { name: "配置同步设置", exact: true }).click();
				const settings = page.locator('[data-verification-anchor="codex-configuration-sync-settings"]');
				await settings.waitFor({ timeout: 15_000 });
				expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
				await settings
					.locator('[aria-label="设置待审批"]')
					.getByRole("button", { name: "稍后处理", exact: true })
					.click();
				await vi.waitFor(async () =>
					expect(await settings.getByRole("button", { name: "通过", exact: true }).isEnabled()).toBe(true),
				);
				await page.screenshot({ path: join(evidenceDirectory, "mobile-configuration-approval-settings.png") });
				await page.keyboard.press("Escape");
				await notice.waitFor({ state: "detached", timeout: 15_000 });
				await page.reload();
				await page.waitForLoadState("networkidle");
				expect(await notice.count()).toBe(0);
				checks.push("手机管理页无横向溢出，稍后仅撤下提醒，刷新不重弹");
				await writeFile(
					join(evidenceDirectory, "browser-configuration-sync-result.json"),
					JSON.stringify({ status: "passed", checks }, null, 2),
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
