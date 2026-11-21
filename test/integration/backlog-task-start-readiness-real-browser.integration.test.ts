import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { loadWorkspaceContext } from "../../src/state/workspace-state";
import type { Browser } from "../../web-ui/node_modules/playwright-core";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";
import { createTaskEditorPackagedRuntimeBrowserTestFixture } from "./task-editor-packaged-runtime-browser-test-fixture";

const packagedCliPath = process.env.KANBAN_BACKLOG_START_READINESS_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

it.skipIf(!packagedCliPath)(
	"打包浏览器：共享条件编辑、CLI 评估、未通过保留 Backlog、跨重启和双宿主展示",
	async () => {
		if (!packagedCliPath) throw new Error("缺少隔离构建 CLI");
		const h = await createTaskEditorPackagedRuntimeBrowserTestFixture(packagedCliPath, children);
		const repository = h.fixture.createNonBareRepository({
			repositoryDirectoryName: "backlog-readiness-browser",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "initial.txt"), "隔离浏览器验收\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "建立浏览器基线",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const modelServer = createServer(async (request, response) => {
			if (request.method === "HEAD") {
				response.writeHead(200).end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				messages: Array<{ role: string; content: string }>;
			};
			const input = JSON.parse(body.messages.find((message) => message.role === "user")?.content ?? "{}") as {
				task?: { backlogTaskStartReadinessConditionsText?: string };
			};
			const condition = input.task?.backlogTaskStartReadinessConditionsText ?? "";
			const decision = {
				conclusion: condition.includes("未满足")
					? "conditions_not_met"
					: condition.includes("部分完成")
						? "revise_remaining_work"
						: "ready",
				summary: condition.includes("未满足") ? "隔离依赖未满足，保留 Backlog。" : "隔离证据显示条件满足。",
				evidenceReferences: ["current_repository"],
				remainingWorkRevision: condition.includes("部分完成")
					? {
							title: "[TEST]仅完成剩余边界",
							taskDescription: "保留原目标，仅完成剩余边界",
							currentExecutionInstructions: "只补齐浏览器验收剩余边界。",
						}
					: null,
				readOnlyEvidenceRequests: [],
			};
			response
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
		});
		await new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done));
		const address = modelServer.address();
		if (!address || typeof address === "string") throw new Error("隔离模型端口不可用");
		Object.assign(h.environment, {
			KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT: join(
				h.fixture.isolatedHomeDirectoryPath,
				"isolated-relation-ledger",
			),
			KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: "isolated-model-fixture",
			KANBAN_MODEL_PROVIDER_DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
			KANBAN_MODEL_PROVIDER_DEEPSEEK_MODEL_ID: "fixture-model",
		});
		const fakeAgentDirectory = join(h.fixture.isolatedHomeDirectoryPath, "isolated-agent-executables");
		mkdirSync(fakeAgentDirectory, { recursive: true });
		const launchLog = join(h.evidenceDirectory, "fake-agent-launch-count.log");
		const deliveredInputLog = join(h.evidenceDirectory, "fake-agent-delivered-input.log");
		writeFileSync(deliveredInputLog, "");
		writeFileSync(launchLog, "");
		writeFileSync(
			join(fakeAgentDirectory, "claude"),
			`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--version'))process.stdout.write('2.1.0 (Claude Code)\\n');else if(process.argv.includes('--help'))process.stdout.write('--settings --session-id --model');else{fs.appendFileSync(${JSON.stringify(launchLog)},'launch\\n');fs.appendFileSync(${JSON.stringify(deliveredInputLog)},JSON.stringify(process.argv)+'\\n');process.stdin.on('data',(chunk)=>fs.appendFileSync(${JSON.stringify(deliveredInputLog)},chunk));process.stdout.write('Claude Code v2.1.0\\n> ');process.stdin.resume();setInterval(()=>{},1000);}\n`,
			{ mode: 0o700 },
		);
		h.environment.PATH = `${fakeAgentDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`;
		// 仅向隔离 HOME 预置 fixture 的项目归属，不调用非本任务范围的项目注册流程。
		vi.stubEnv("HOME", h.fixture.isolatedHomeDirectoryPath);
		vi.stubEnv(
			"KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT",
			join(h.fixture.isolatedHomeDirectoryPath, "isolated-relation-ledger"),
		);
		const isolatedWorkspace = await loadWorkspaceContext(repository.repositoryPath);
		let runtime = await h.startRuntime(repository.repositoryPath);
		let browser: Browser | undefined;
		let workspaceId: string | undefined;
		let taskId: string | undefined;
		try {
			workspaceId = isolatedWorkspace.workspaceId;
			if (!workspaceId) throw new Error("隔离项目注册失败");
			const client = h.client(workspaceId);
			await client.runtime.saveConfig.mutate({
				selectedAgentId: "claude",
				userInterfacePreferencesSharedAcrossBrowserOrigins: {
					taskProjectAssignmentAutomaticAnalysisEnabled: false,
				},
			});
			browser = await h.launchBrowser();
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			page.setDefaultTimeout(20000);
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const configurationLoaded = page.waitForResponse(
				(response) => response.url().includes("runtime.getConfig") && response.ok(),
			);
			await page.goto(`${h.origin}/${workspaceId}`);
			await (await configurationLoaded).finished();
			await page.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
			await page.getByRole("button", { name: "Create task", exact: true }).first().click();
			let editor = page
				.getByRole("dialog")
				.filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
			await editor.getByRole("textbox", { name: "任务名称（可选）", exact: true }).fill("[TEST]开启复核浏览器验收");
			await editor.getByRole("textbox", { name: "任务正文", exact: true }).fill("保留原需求及来源，完成隔离验收。");
			await editor.getByRole("textbox", { name: "适合开启的条件", exact: true }).fill("隔离依赖未满足");
			await editor.getByRole("button", { name: "创建任务", exact: true }).click();
			await editor.waitFor({ state: "hidden" });
			const state = await client.workspace.getState.query();
			const card = state.board.columns.find((column) => column.id === "backlog")?.cards[0];
			if (!card) throw new Error("浏览器建卡未保存");
			taskId = card.id;
			expect(card.backlogTaskStartReadinessConditionsText).toBe("隔离依赖未满足");
			expect(card.backlogTaskCreationRepositoryBaseline?.commit).toMatch(/^[0-9a-f]{40}$/u);
			const cli = async (args: string[]) =>
				JSON.parse(
					(
						await promisify(execFile)(
							process.execPath,
							[
								packagedCliPath,
								"task",
								...args,
								"--task-id",
								card.id,
								"--project-path",
								repository.repositoryPath,
							],
							{ env: h.environment, cwd: repository.repositoryPath, timeout: 30000 },
						)
					).stdout,
				) as { started?: boolean; review?: { phase: string } };
			expect((await cli(["assess-backlog-start-readiness"])).review?.phase).toBe("conditions_not_met");
			expect(readFileSync(launchLog, "utf8")).toBe("");
			expect((await cli(["start"])).started).toBe(false);
			expect(
				(await client.workspace.getState.query()).board.columns
					.find((column) => column.id === "backlog")
					?.cards.map((entry) => entry.id),
			).toContain(card.id);
			await page.reload();
			await page.getByText("隔离依赖未满足，保留 Backlog。", { exact: false }).first().waitFor({ state: "visible" });
			await page.screenshot({ path: join(h.evidenceDirectory, "backlog-readiness-held-desktop.png") });
			await page.getByText("[TEST]开启复核浏览器验收", { exact: true }).first().click();
			editor = page
				.getByRole("dialog")
				.filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
			expect(await editor.getByRole("textbox", { name: "适合开启的条件", exact: true }).inputValue()).toBe(
				"隔离依赖未满足",
			);
			await editor.getByRole("textbox", { name: "适合开启的条件", exact: true }).fill("部分完成，当前条件已满足");
			await editor.getByRole("button", { name: /保存更改|Save changes/u }).click();
			await editor.waitFor({ state: "hidden" });
			await expect
				.poll(
					async () =>
						(await client.workspace.getState.query()).board.columns
							.flatMap((column) => column.cards)
							.find((entry) => entry.id === card.id)?.backlogTaskStartReadinessConditionsText,
				)
				.toBe("部分完成，当前条件已满足");
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 15000)).toBe(true);
			runtime = await h.startRuntime(repository.repositoryPath);
			await page.reload();
			await expect
				.poll(() => readFileSync(launchLog, "utf8").split("\n").filter(Boolean).length, { timeout: 45000 })
				.toBe(1);
			await expect
				.poll(() => readFileSync(deliveredInputLog, "utf8"), { timeout: 15000 })
				.toContain("只补齐浏览器验收剩余边界");
			expect(readFileSync(deliveredInputLog, "utf8")).toContain("保留原需求及来源");
			const initialRevisionDeliveryCount =
				readFileSync(deliveredInputLog, "utf8").split("只补齐浏览器验收剩余边界").length - 1;
			await cli(["start"]);
			expect(readFileSync(deliveredInputLog, "utf8").split("只补齐浏览器验收剩余边界").length - 1).toBe(
				initialRevisionDeliveryCount,
			);
			expect(readFileSync(launchLog, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
			await page.getByText("[TEST]仅完成剩余边界", { exact: true }).first().click();
			await page.locator(`[data-verification-anchor="task-detail:${card.id}"]`).waitFor({ state: "visible" });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.reload();
			await page.getByText("[TEST]仅完成剩余边界", { exact: true }).first().waitFor({ state: "visible" });
			await page.locator(`[data-verification-anchor="task-detail:${card.id}"]`).waitFor({ state: "visible" });
			await page.getByRole("button", { name: "展开任务卡", exact: true }).click();
			await page.getByText("部分完成，当前条件已满足", { exact: false }).first().waitFor({ state: "visible" });
			await page.getByRole("button", { name: "查看复核依据", exact: true }).last().click();
			await page.getByText("只补齐浏览器验收剩余边界。", { exact: true }).waitFor({ state: "visible" });
			await page.screenshot({ path: join(h.evidenceDirectory, "backlog-readiness-mobile.png") });
			// 替身记录 PTY 收到的字节，未产生真实 harness 接受回执。
			expect(
				(await client.taskCardAction.readBacklogTaskStartReadinessReport.query({ taskId: card.id })).review.phase,
			).toBe("waiting_for_evidence");
		} finally {
			if (workspaceId && taskId)
				await h
					.client(workspaceId)
					.runtime.stopTaskSession.mutate({ taskId })
					.catch(() => undefined);
			await browser?.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 15000);
			h.writeRuntimeOutput();
			modelServer.closeAllConnections();
			await new Promise<void>((done) => modelServer.close(() => done()));
		}
	},
	180000,
);
