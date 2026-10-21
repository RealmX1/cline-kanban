// 明确启用的真实 TUI 联验：模型内容来自回环服务；reviewer 是受控本地进程，所有分界 gate 均真实执行。
import { spawn, spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { rvfIndependentUserTurnBoundaryReceiptSchema } from "../../src/core/rvf-automatic-closeout-contract";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	sigkillChildProcessAndWaitForExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

function requiredEnvironmentVariable(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`启用原生链路联验时必须提供 ${name}`);
	return resolve(value);
}

const cliExchangeSchema = z.object({ argv: z.array(z.string()), exit: z.number(), stdout: z.string() });

describe("真实 strict 独立回合从队列贯通到 RVF dispatch", { timeout: 480_000 }, () => {
	it.skipIf(process.env.KANBAN_RUN_NATIVE_RVF_STRICT_DELIVERY_THROUGH_DISPATCH !== "1")(
		"summary 已空闲但原生仍运行时不投；下一唯一用户回合经真实 checkpoint、nonce、prepare 和 dispatch",
		async (testContext) => {
			const binary = requiredEnvironmentVariable("KANBAN_RVF_STRICT_DELIVERY_CODEX_BINARY");
			const consumerRepository = requiredEnvironmentVariable("KANBAN_RVF_STRICT_DELIVERY_CONSUMER_REPOSITORY");
			const packagedCliPath = requiredEnvironmentVariable("KANBAN_RVF_STRICT_DELIVERY_PACKAGED_CLI_PATH");
			const evidenceDirectory = requiredEnvironmentVariable("KANBAN_RVF_STRICT_DELIVERY_EVIDENCE_DIRECTORY");
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "knrvf-" });
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "native-rvf-candidate" });
			await writeFile(join(repository.repositoryPath, "implementation.txt"), "初始隔离实现\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "test: 初始化隔离原生候选",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const environment = fixture.createIsolatedChildProcessEnvironment({
				PATH: `${dirname(binary)}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			});
			const version = spawnSync(binary, ["--version"], { env: environment, encoding: "utf8", timeout: 15_000 });
			expect(version.status, version.stderr).toBe(0);
			expect(version.stdout.trim()).toBe("codex-cli 0.163.0");
			const evidenceRoot = join(fixture.fixtureRootDirectoryPath, "native-strict-delivery-through-dispatch");
			const python = children.register(
				spawn(
					"python3",
					[
						resolve("test/integration/fixtures/rvf-native-strict-delivery-through-dispatch.py"),
						JSON.stringify({
							fixtureRoot: fixture.fixtureRootDirectoryPath,
							repositoryPath: repository.repositoryPath,
							nodeBinary: process.execPath,
							packagedCliPath,
							consumerRepository,
						}),
					],
					{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe"] },
				),
			);
			let stdout = "";
			let stderr = "";
			python.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			python.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			try {
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					{
						waitedForDescription: "真实 TUI、strict 队列与 RVF prepare/dispatch 联验退出",
						softDeadlineMsExpectedOnUncontendedHost: 90_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 360_000,
					},
					() => hasChildProcessExited(python),
				);
				expect(python.exitCode, stdout + stderr).toBe(0);
				const verification = JSON.parse(
					await readFile(join(evidenceRoot, "complete-chain-verification.json"), "utf8"),
				);
				expect(verification.status).toBe("passed");
				expect(verification.marker_user_message_count).toBe(1);
				const pendingSummary = JSON.parse(
					await readFile(join(evidenceRoot, "summary-while-stop-not-returned.json"), "utf8"),
				);
				expect([pendingSummary.turnOwner, pendingSummary.userTurnKind]).toEqual(["user", "review"]);
				expect(
					await readFile(join(evidenceRoot, "native-events-while-stop-not-returned.json"), "utf8"),
				).not.toContain('"task_complete"');
				const exchangeDirectory = join(evidenceRoot, "actual-cli-exchanges");
				const exchanges = await Promise.all(
					(await readdir(exchangeDirectory)).map(async (name) =>
						cliExchangeSchema.parse(JSON.parse(await readFile(join(exchangeDirectory, name), "utf8"))),
					),
				);
				const nonceQueries = exchanges.filter((entry) =>
					entry.argv.includes("--review-start-boundary-observation-nonce"),
				);
				const nonces = nonceQueries.map(
					(entry) => entry.argv[entry.argv.indexOf("--review-start-boundary-observation-nonce") + 1],
				);
				expect(nonces.length).toBeGreaterThanOrEqual(5);
				expect(new Set(nonces).size).toBe(nonces.length);
				for (const exchange of nonceQueries) {
					expect(exchange.exit).toBe(0);
					const response = JSON.parse(exchange.stdout);
					expect(response.review_start_boundary_active_branch_observation.request_nonce).toBe(
						exchange.argv[exchange.argv.indexOf("--review-start-boundary-observation-nonce") + 1],
					);
				}
				const capture = exchanges.find((entry) => entry.argv.includes("capture-rvf-review-start-boundary"));
				expect(capture).toBeDefined();
				const receipt = rvfIndependentUserTurnBoundaryReceiptSchema.parse(
					JSON.parse(capture?.stdout ?? "{}").receipt,
				);
				expect(repository.runGit(["show", `${receipt.checkpoint_commit}:implementation.txt`]).stdout).toContain(
					"native reviewed implementation",
				);
				expect(
					JSON.parse(await readFile(join(evidenceRoot, "actual-dispatch-result.json"), "utf8")).token_state,
				).toBe("dispatched");
				expect(JSON.parse(await readFile(join(evidenceRoot, "control-socket-cleanup.json"), "utf8"))).toEqual([
					expect.objectContaining({ exists_after_cleanup: false }),
				]);
			} finally {
				if (!hasChildProcessExited(python)) {
					python.kill("SIGTERM");
					const gracefulExitDeadline = Date.now() + 15_000;
					while (!hasChildProcessExited(python) && Date.now() < gracefulExitDeadline) {
						await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
					}
					await sigkillChildProcessAndWaitForExit(python);
				}
				await mkdir(evidenceDirectory, { recursive: true });
				await writeFile(join(evidenceDirectory, "guarded-native-chain.log"), stdout + stderr);
				await cp(fixture.fixtureRootDirectoryPath, join(evidenceDirectory, "captured-fixture"), {
					recursive: true,
					filter: async (path) => !(await lstat(path)).isSocket(),
				});
				await writeFile(
					join(evidenceDirectory, "original-fixture-to-persistent-archive.json"),
					JSON.stringify(
						{
							originalFixtureRoot: fixture.fixtureRootDirectoryPath,
							persistentArchiveRoot: join(evidenceDirectory, "captured-fixture"),
						},
						null,
						2,
					),
				);
			}
		},
	);
});
