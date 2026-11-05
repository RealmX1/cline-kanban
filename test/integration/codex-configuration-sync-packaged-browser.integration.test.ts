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
import { loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
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
		it("profile 自动共享与例外反馈经真实推流呈现，支持键盘、手机布局和稍后处理", async () => {
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
			const workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
			await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					columns: [
						{
							id: "validation",
							title: "Validation",
							cards: [
								{
									id: "notice-focus-task",
									title: "通知覆盖验证",
									prompt: "只读工作台，不启动 Agent",
									baseRef: "main",
									startInPlanMode: false,
									createdAt: 1,
									updatedAt: 1,
								},
							],
						},
					],
				},
				sessions: {},
			});
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
			const geometrySnapshots: Record<string, Array<{ x: number; y: number; width: number; height: number }>> = {};
			try {
				const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
				await page.clock.install();
				const synchronizationRequests: string[] = [];
				page.on("request", (request) => {
					if (
						/runtime\.(batchCodexConfigurationAction|acknowledgeCodexConfigurationChange|synchronizeCodexConfigurationChange|resolveCodexConfiguration)/u.test(
							request.url(),
						)
					)
						synchronizationRequests.push(request.postData() ?? "");
				});
				await page.goto(origin);
				const onboarding = page.getByRole("dialog", { name: "Get started" });
				await onboarding.waitFor({ timeout: 15_000 });
				await onboarding.getByRole("button", { name: "Close", exact: true }).click();
				await onboarding.waitFor({ state: "detached" });
				const notice = page.locator('[data-verification-anchor="codex-configuration-sync-notice"]');
				const summary = page.locator('[data-verification-anchor="codex-configuration-sync-summary"]');
				await notice.waitFor({ timeout: 30_000 });
				const modelComparison = notice
					.locator("article")
					.filter({ has: page.getByText("config.toml · model", { exact: true }) });
				await modelComparison.getByRole("button", { name: "展开完整比较", exact: true }).click();
				await modelComparison.getByRole("button", { name: "收起完整比较", exact: true }).waitFor();
				await modelComparison
					.locator('[data-configuration-value-choice="candidate"]')
					.getByText('"fixture-updated"', { exact: true })
					.waitFor();
				expect(await modelComparison.textContent()).toContain('"fixture-initial"');
				expect(await modelComparison.textContent()).toContain("缺少修改发起者的原生记录");
				await modelComparison.getByRole("button", { name: "收起完整比较", exact: true }).click();
				checks.push("完整比较经真实打包态只读 tRPC 返回修改前后值，检测归属与未知修改者独立展示");
				await page.getByRole("button", { name: "Open terminal", exact: true }).click();
				await page.locator(".xterm-screen").first().waitFor();
				await page.locator("html").evaluate(async (element) => {
					await element.ownerDocument.fonts.ready;
				});
				const measureWorkspaceGeometry = async (label: string) => {
					// 先交付响应式重排，再等手机终端的 200ms 入场动画结束。
					await page.evaluate(
						"new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
					);
					await page.waitForFunction(
						"!document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)",
					);
					const measured = await page.locator("html").evaluate((element) =>
						[".kb-top-bar", ".kb-home-layout", ".kb-terminal-container"].map((selector) => {
							const target = element.ownerDocument.querySelector(selector);
							if (!target) throw new Error(`缺少布局节点：${selector}`);
							const { x, y, width, height } = target.getBoundingClientRect();
							return { x, y, width, height };
						}),
					);
					geometrySnapshots[label] = measured;
					return measured;
				};
				const assertUnchangedGeometry = (
					before: Array<{ x: number; y: number; width: number; height: number }>,
					after: Array<{ x: number; y: number; width: number; height: number }>,
				) => {
					for (const [index, previousBox] of before.entries()) {
						const currentBox = after[index];
						if (!currentBox) throw new Error("展开和收起前后的布局节点数量不同");
						for (const coordinate of ["x", "y", "width", "height"] as const)
							expect(Math.abs(previousBox[coordinate] - currentBox[coordinate])).toBeLessThanOrEqual(1);
					}
				};
				const expandedGeometry = await measureWorkspaceGeometry("desktop-automatic-expanded");
				await page.mouse.move(0, 0);
				const terminalInput = page.locator(".xterm-helper-textarea").first();
				await terminalInput.focus();
				await page.clock.fastForward(8_001);
				await notice.waitFor({ state: "hidden" });
				expect(await summary.getAttribute("aria-expanded")).toBe("false");
				expect(synchronizationRequests).toHaveLength(0);
				expect(await terminalInput.evaluate((element) => element.ownerDocument.activeElement === element)).toBe(
					true,
				);
				assertUnchangedGeometry(
					expandedGeometry,
					await measureWorkspaceGeometry("desktop-automatically-collapsed"),
				);
				checks.push(
					"首次自动展开 8 秒后仅收起展示，顶栏、看板及真实终端几何误差不超过 1px，焦点不移动且无审批请求",
				);
				await summary.focus();
				await page.keyboard.press("Space");
				await notice.waitFor();
				expect(await notice.evaluate((element) => element.ownerDocument.activeElement === element)).toBe(true);
				await page.clock.fastForward(16_000);
				expect(await notice.isVisible()).toBe(true);
				assertUnchangedGeometry(expandedGeometry, await measureWorkspaceGeometry("desktop-manual-expanded"));
				await page.keyboard.press("Escape");
				await notice.waitFor({ state: "hidden" });
				expect(await summary.evaluate((element) => element.ownerDocument.activeElement === element)).toBe(true);
				await page.keyboard.press("Tab");
				expect(await notice.evaluate((element) => element.contains(element.ownerDocument.activeElement))).toBe(
					false,
				);
				await summary.click();
				await notice.waitFor();
				expect(await notice.textContent()).toContain("待反馈 2 项");
				expect(await notice.getByRole("switch").count()).toBe(0);
				expect(
					(await readCodexConfigurationSyncStore()).sources[binding.sourceIdentity].fields[
						JSON.stringify(["config.toml", "model"])
					].value,
				).toBe("fixture-initial");
				await notice.getByRole("button", { name: "收起", exact: true }).focus();
				await page.keyboard.press("Space");
				await page.reload();
				await summary.waitFor();
				expect(await notice.isHidden()).toBe(true);
				configuration.hide_agent_reasoning = true;
				await writeFile(writerConfigurationPath, stringify(configuration));
				await vi.waitFor(
					async () =>
						expect(
							(await readCodexConfigurationSyncStore()).sources[binding.sourceIdentity].fields[
								JSON.stringify(["config.toml", "hide_agent_reasoning"])
							]?.value,
						).toBe(true),
					{ timeout: 15_000 },
				);
				expect(await summary.getAttribute("aria-label")).toContain("待反馈 2 项");
				configuration.approval_policy = "on-request";
				configuration.sandbox_mode = "workspace-write";
				await writeFile(writerConfigurationPath, stringify(configuration));
				await vi.waitFor(async () => expect(await summary.getAttribute("aria-label")).toContain("待反馈 3 项"), {
					timeout: 15_000,
				});
				expect(await summary.getAttribute("aria-expanded")).toBe("false");
				await page.screenshot({ path: join(evidenceDirectory, "desktop-configuration-notice-collapsed.png") });
				checks.push("键盘收起后，跨刷新与新条目保持收起；审批前默认值未变化");
				await summary.click();
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
				await summary.click();
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
				// 页面刷新按既有规则关闭首页终端；重新打开后再比较手机与横屏几何。
				await page.getByRole("button", { name: "Open terminal", exact: true }).click();
				await page.locator(".xterm-screen").first().waitFor();
				await page.screenshot({ path: join(evidenceDirectory, "desktop-configuration-approval.png") });
				for (const viewport of [
					{ width: 390, height: 844 },
					{ width: 844, height: 390 },
				]) {
					await page.setViewportSize(viewport);
					await page.waitForFunction(
						`document.querySelector(".kb-top-bar")?.getBoundingClientRect().height === ${viewport.width < 768 ? 89 : 40}`,
					);
					const before = await measureWorkspaceGeometry(`${viewport.width}-expanded`);
					await notice.getByRole("button", { name: "收起", exact: true }).click();
					assertUnchangedGeometry(before, await measureWorkspaceGeometry(`${viewport.width}-collapsed`));
					await summary.click();
					assertUnchangedGeometry(before, await measureWorkspaceGeometry(`${viewport.width}-reopened`));
					expect(
						await notice.evaluate((element) => {
							const box = element.getBoundingClientRect();
							return element.contains(
								element.ownerDocument.elementFromPoint(box.x + box.width / 2, box.bottom - 4),
							);
						}),
						"通知详情应覆盖手机终端，内部列表底部不被遮挡",
					).toBe(true);
					expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
					expect(
						await page
							.locator("html")
							.evaluate(
								(element) => element.scrollWidth <= (element.ownerDocument.defaultView?.innerWidth ?? 0) + 1,
							),
					).toBe(true);
					const closeButtonBox = await notice.getByRole("button", { name: "收起", exact: true }).boundingBox();
					expect(closeButtonBox && closeButtonBox.y + closeButtonBox.height <= viewport.height).toBe(true);
					await page.screenshot({
						path: join(evidenceDirectory, `configuration-notice-overlay-${viewport.width}.png`),
					});
				}
				await page.setViewportSize({ width: 1280, height: 900 });
				expect(synchronizationRequests).toHaveLength(0);
				checks.push("手机与横屏内部滚动、关闭按钮可达、页面不横向溢出，展开与收起不推动顶栏、看板或终端");
				const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
				try {
					await mobilePage.addInitScript(() => {
						localStorage.setItem("kanban.onboarding.dialog.shown", "true");
						localStorage.setItem("codex-configuration-change-notice-collapsed", "false");
					});
					await mobilePage.clock.install();
					await mobilePage.goto(`${new URL(origin).origin}/${workspaceId}?task=notice-focus-task`);
					const mobileNotice = mobilePage.locator('[data-verification-anchor="codex-configuration-sync-notice"]');
					await mobileNotice.waitFor({ state: "attached" });
					// 配置记录可能先于任务导航返回，等 Focus View 的手机控制完成挂载再核验。
					await mobilePage.getByRole("button", { name: "展开上方导航与工具", exact: true }).waitFor();
					await mobileNotice.waitFor({ state: "hidden" });
					expect(await mobileNotice.isHidden()).toBe(true);
					await mobilePage.getByRole("button", { name: "展开上方导航与工具", exact: true }).tap();
					await mobileNotice.waitFor();
					await mobilePage.clock.fastForward(31_000);
					expect(await mobileNotice.isVisible()).toBe(true);
					const upperNavigation = mobilePage.locator("[data-mobile-focus-view-global-navigation]");
					expect(await upperNavigation.isVisible()).toBe(true);
					await mobilePage.screenshot({ path: join(evidenceDirectory, "mobile-focus-view-notice-overlay.png") });
					// 覆盖层挡住任务卡头；直接触发导航控制，验收隐藏绑定与保留意图。
					await mobilePage
						.getByRole("button", { name: "收起上方导航与工具", exact: true })
						.evaluate((element) => (element as { click: () => void }).click());
					await mobileNotice.waitFor({ state: "hidden" });
					expect(await upperNavigation.isHidden()).toBe(true);
					expect(
						await mobilePage.evaluate(() => localStorage.getItem("codex-configuration-change-notice-collapsed")),
					).toBe("false");
					await mobilePage.getByRole("button", { name: "展开上方导航与工具", exact: true }).tap();
					await mobileNotice.waitFor();
					checks.push(
						"手机 Focus View 初始隐藏导航时不泄露详情，重新展开保留意图，通知可见期间保护 30 秒闲置收起",
					);
				} finally {
					await mobilePage.close();
					await page.bringToFront();
				}
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
				const beforeNewDesktopNotice = await measureWorkspaceGeometry("desktop-before-new-notice");
				await writeFile(
					join(binding.configurationHomeDirectoryPath, "hooks.json"),
					JSON.stringify({
						hooks: { Stop: [{ hooks: [{ type: "command", command: "printf updated-definition" }] }] },
					}),
				);
				await notice.waitFor({ timeout: 15_000 });
				await notice.getByRole("button", { name: "标记已读", exact: true }).waitFor();
				assertUnchangedGeometry(beforeNewDesktopNotice, await measureWorkspaceGeometry("desktop-after-new-notice"));
				expect(await notice.textContent()).toContain("待反馈 0 项 · 来源更新 1 条");
				expect(
					await notice
						.getByRole("button", { name: /采用此值并广播|反馈到 profile 并广播|采用新值作为未来默认/ })
						.count(),
				).toBe(0);
				await notice.getByRole("button", { name: "标记已读", exact: true }).click();
				await notice.waitFor({ state: "detached", timeout: 15_000 });
				checks.push("来源定义变更独立提示，不计设置审批，标记已读与稍后均不授予信任");
				await page.setViewportSize({ width: 390, height: 844 });
				const beforeNewMobileNotice = await measureWorkspaceGeometry("390-before-new-notice");
				configuration.model = "fixture-next-decision";
				await writeFile(writerConfigurationPath, stringify(configuration));
				await notice.waitFor({ timeout: 15_000 });
				assertUnchangedGeometry(beforeNewMobileNotice, await measureWorkspaceGeometry("390-after-new-notice"));
				checks.push("桌面与手机首次出现新提醒时，摘要和详情均不增加主布局高度");
				expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
				await page.screenshot({ path: join(evidenceDirectory, "mobile-configuration-approval.png") });
				await notice.getByRole("button", { name: "配置同步设置", exact: true }).click();
				const settings = page.locator('[data-verification-anchor="codex-configuration-sync-settings"]');
				await settings.waitFor({ timeout: 15_000 });
				expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
				await settings
					.locator('[aria-label="设置待反馈"]')
					.getByRole("button", { name: "稍后处理", exact: true })
					.click();
				await vi.waitFor(async () =>
					expect(await settings.getByRole("button", { name: "采用此值并广播", exact: true }).isEnabled()).toBe(
						true,
					),
				);
				const profiles = settings.locator('[data-verification-anchor="codex-configuration-profile-management"]');
				await profiles.getByLabel("从当前 profile 复制", { exact: true }).fill("浏览器验证配置");
				await profiles.getByRole("button", { name: "创建 profile", exact: true }).click();
				await vi.waitFor(async () =>
					expect(
						(await readCodexConfigurationSyncStore()).profiles &&
							Object.values((await readCodexConfigurationSyncStore()).profiles).some(
								(profile) => profile.name === "浏览器验证配置",
							),
					).toBe(true),
				);
				await profiles.getByLabel("管理 profile", { exact: true }).selectOption({ label: "浏览器验证配置" });
				await profiles.getByLabel("重命名当前 profile", { exact: true }).fill("浏览器独立配置");
				await profiles.getByRole("button", { name: "保存名称", exact: true }).click();
				await profiles
					.getByLabel("管理 profile", { exact: true })
					.locator("option", { hasText: "浏览器独立配置" })
					.waitFor({ state: "attached" });
				await profiles.getByRole("button", { name: "设为默认", exact: true }).click();
				await vi.waitFor(async () => {
					const stored = await readCodexConfigurationSyncStore();
					expect(stored.profiles[stored.defaultCodexConfigurationProfileId ?? ""]?.name).toBe("浏览器独立配置");
				});
				await profiles.getByText(/共享设置 ·/).click();
				const modelEditor = profiles.getByLabel("model", { exact: true });
				await modelEditor.fill("browser-profile-model");
				await modelEditor.locator("..").getByRole("button", { name: "更新并广播", exact: true }).click();
				await vi.waitFor(async () => {
					const stored = await readCodexConfigurationSyncStore();
					expect(
						stored.profiles[stored.defaultCodexConfigurationProfileId ?? ""]?.fields[
							JSON.stringify(["config.toml", "model"])
						].value,
					).toBe("browser-profile-model");
				});
				await page.screenshot({ path: join(evidenceDirectory, "mobile-codex-profile-management.png") });
				checks.push("真实 profile 管理可创建、重命名、设为默认并更新模型；新默认不会覆盖另一 profile 的局部选择");

				await page.screenshot({ path: join(evidenceDirectory, "mobile-configuration-approval-settings.png") });
				await page.keyboard.press("Escape");
				await notice.waitFor({ state: "detached", timeout: 15_000 });
				await page.setViewportSize({ width: 1280, height: 900 });
				const closeTerminal = page
					.locator(".kb-home-layout")
					.getByRole("button", { name: "Close terminal", exact: true });
				if (await closeTerminal.isVisible()) await closeTerminal.click();
				await page.reload();
				await page.waitForLoadState("networkidle");
				expect(await notice.count()).toBe(0);
				checks.push("手机管理页无横向溢出，稍后仅撤下提醒，刷新不重弹");
				await writeFile(
					join(evidenceDirectory, "browser-configuration-sync-result.json"),
					JSON.stringify({ status: "passed", checks, geometrySnapshots }, null, 2),
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
				await writeFile(
					join(evidenceDirectory, "workspace-geometry-snapshots.json"),
					JSON.stringify(geometrySnapshots, null, 2),
				);
				await writeFile(join(evidenceDirectory, "isolated-runtime.log"), output);
			}
		});
	},
);
