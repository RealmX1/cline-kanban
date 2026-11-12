import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeExternalWorkflowRunBinding } from "../../src/core/api-contract";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Browser, BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_EXTERNAL_WORKFLOW_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

it.skipIf(!packagedCliPath)(
	"打包 CLI 与浏览器保存原 Run，重启找回，失联显示 unknown",
	{ timeout: 180_000 },
	async () => {
		if (!packagedCliPath) throw new Error("缺少隔离构建 CLI");
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "external-workflow-binding-",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "workflow-project",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "README.md"), "隔离外部流程绑定验收\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离流程项目",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const initial = await loadWorkspaceState(repository.repositoryPath);
		await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: {
				...initial.board,
				columns: initial.board.columns.map((column) => ({
					...column,
					cards:
						column.id === "review"
							? [
									{
										id: "flow1",
										title: "外部流程绑定验收",
										prompt: "验证原 Run",
										baseRef: "main",
										startInPlanMode: false,
										createdAt: 1,
										updatedAt: 1,
									},
								]
							: [],
				})),
			},
			sessions: {},
		});
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("未分配隔离端口");
		const port = address.port;
		await new Promise<void>((done) => reservation.close(() => done()));
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|RVF_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		const binaryDirectory = join(fixture.fixtureRootDirectoryPath, "fixture-harness-version-binaries");
		mkdirSync(binaryDirectory);
		writeFileSync(
			join(binaryDirectory, "claude"),
			`#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--help') ? '--settings --session-id --model' : '2.1.0 (Claude Code)\\n');\n`,
			{ mode: 0o700 },
		);
		Object.assign(environment, {
			PATH: `${binaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			KANBAN_RUNTIME_PORT: String(port),
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-config"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"),
		});
		const sourcePath = resolve(import.meta.dirname, "../..");
		const origin = `http://127.0.0.1:${port}`;
		let browser: Browser | undefined;
		let runtimeOutput = "";
		const startRuntime = () => {
			const runtime = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						join(sourcePath, "test/integration/shutdown-ipc-hook.cjs"),
						packagedCliPath,
						"--port",
						String(port),
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
			runtime.stdout?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			runtime.stderr?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			return runtime;
		};
		const runCli = async (arguments_: string[]) => {
			const cli = children.register(
				spawn(
					process.execPath,
					[
						packagedCliPath,
						"task",
						"external-workflow",
						...arguments_,
						"--project-path",
						repository.repositoryPath,
					],
					{
						cwd: repository.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe"],
					},
				),
			);
			let stdout = "";
			let stderr = "";
			cli.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			cli.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			await new Promise<void>((done, reject) => {
				cli.once("error", reject);
				cli.once("exit", () => done());
			});
			expect(cli.exitCode, stderr + stdout).toBe(0);
			return JSON.parse(stdout) as {
				externalWorkflowRunBinding: RuntimeExternalWorkflowRunBinding;
				bindingAvailability: string;
			};
		};
		try {
			let runtime = startRuntime();
			await waitForRuntimeServerStartupBannerOrSigkillChild(runtime);
			const globalClient = createTRPCProxyClient<RuntimeAppRouter>({
				links: [httpLink({ url: `${origin}/api/trpc` })],
			});
			const workspaceId = (await globalClient.projects.add.mutate({ path: repository.repositoryPath })).project?.id;
			if (!workspaceId) throw new Error("隔离项目未注册");
			const scopedClient = createTRPCProxyClient<RuntimeAppRouter>({
				links: [httpLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": workspaceId } })],
			});
			await scopedClient.runtime.saveConfig.mutate({ selectedAgentId: "claude" });
			const reference = {
				workflowProviderId: "software-factory",
				workflowKind: "delivery_planning",
				workItemId: "item-1",
				runId: "run-1",
				workflowDatabasePath: join(fixture.fixtureRootDirectoryPath, "workflows.sqlite"),
				artifactDirectoryPath: fixture.fixtureRootDirectoryPath,
				lastObservedState: {
					observedAtEpochMs: 10,
					availability: "observed",
					businessStage: "planning",
					executionQualification: "stage_work_required",
					waitingReason: "等待计划材料",
					materialFilePaths: [join(fixture.fixtureRootDirectoryPath, "plan.md")],
				},
			};
			const requestFile = join(fixture.fixtureRootDirectoryPath, "binding.json");
			const publishReference = async () => {
				writeFileSync(
					requestFile,
					JSON.stringify({
						taskId: "flow1",
						expectedTaskIncarnationCreatedAtEpochMs: 1,
						externalWorkflowRunBinding: reference,
					}),
				);
				return await runCli(["bind", "--request-file", requestFile]);
			};
			const created = await publishReference();
			expect(created.externalWorkflowRunBinding).toMatchObject({
				owningWorkspaceId: workspaceId,
				owningTaskId: "flow1",
				owningTaskIncarnationCreatedAtEpochMs: 1,
			});
			const { chromium } = createRequire(join(sourcePath, "web-ui/package.json"))("playwright-core") as {
				chromium: BrowserType;
			};
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
			page.setDefaultTimeout(15_000);
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.goto(`${origin}/${workspaceId}`);
			const panel = () => page.locator('[data-verification-anchor="task-external-workflow:flow1"]').first();
			await panel().locator("summary").waitFor();
			await panel().locator("summary").click();
			expect(await panel().innerText()).toContain("最近阶段：planning");
			expect(await panel().innerText()).toContain("等待计划材料");
			await panel().getByRole("button", { name: "复制原 Run 引用" }).click();
			expect(JSON.parse(await page.evaluate<string>("navigator.clipboard.readText()"))).toEqual(
				created.externalWorkflowRunBinding,
			);
			const evidenceDirectory = process.env.KANBAN_EXTERNAL_WORKFLOW_BROWSER_EVIDENCE_DIRECTORY;
			if (evidenceDirectory) {
				mkdirSync(evidenceDirectory, { recursive: true });
				await page.screenshot({ path: join(evidenceDirectory, "workflow-reference-desktop.png") });
			}
			reference.lastObservedState = {
				...reference.lastObservedState,
				observedAtEpochMs: 11,
				businessStage: "plan_evaluation",
			};
			const updated = await publishReference();
			await panel().locator("summary").filter({ hasText: "最近阶段：plan_evaluation" }).waitFor();
			runtime.kill("SIGKILL");
			await new Promise<void>((done) => runtime.once("exit", () => done()));
			runtime = startRuntime();
			await waitForRuntimeServerStartupBannerOrSigkillChild(runtime);
			const revisionBeforeRead = (await loadWorkspaceState(repository.repositoryPath)).revision;
			const restored = await runCli(["get", "--task-id", "flow1"]);
			expect((await loadWorkspaceState(repository.repositoryPath)).revision).toBe(revisionBeforeRead);
			expect(restored.externalWorkflowRunBinding).toEqual(updated.externalWorkflowRunBinding);
			reference.lastObservedState = {
				...reference.lastObservedState,
				observedAtEpochMs: 12,
				availability: "unavailable",
			};
			await publishReference();
			await page.reload();
			await panel().locator("summary").waitFor();
			await panel().locator("summary").click();
			expect(await panel().innerText()).toContain("状态 unknown");
			expect(await panel().innerText()).not.toContain("最近阶段：planning");
			await page.setViewportSize({ width: 390, height: 844 });
			await panel().scrollIntoViewIfNeeded();
			if (evidenceDirectory) {
				await page.screenshot({ path: join(evidenceDirectory, "workflow-reference-mobile-unknown.png") });
				writeFileSync(
					join(evidenceDirectory, "verified-browser-and-restart-observations.json"),
					JSON.stringify(
						{
							workspaceId,
							restoredBinding: restored.externalWorkflowRunBinding,
							unavailableProjection: await panel().innerText(),
							pageErrors,
							homeIsolated: true,
							codexHomesIsolated: true,
							agentSessionsCreated: (await loadWorkspaceState(repository.repositoryPath)).sessions,
						},
						null,
						2,
					),
				);
			}
			expect(pageErrors).toEqual([]);
		} catch (error) {
			throw new Error(`${String(error)}\n${runtimeOutput}`);
		} finally {
			await browser?.close();
		}
	},
);
