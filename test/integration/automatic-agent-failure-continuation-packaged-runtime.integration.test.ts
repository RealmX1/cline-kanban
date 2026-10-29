import { execFile, spawn } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const execFileAsync = promisify(execFile);
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit(), 15_000);

it.skipIf(process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_PACKAGED_RUNTIME_CHECK !== "1")(
	"隔离打包实例提供独立容量设置、episode 动作和 CLI 等待分组",
	async (test) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "packaged-capacity-recovery" });
		const sourceCheckout = resolve(import.meta.dirname, "../..");
		const distribution = join(sourceCheckout, "dist");
		expect(await realpath(distribution)).toBe(distribution);
		const reservation = createServer();
		await new Promise<void>((accept) => reservation.listen(0, "127.0.0.1", accept));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("隔离实例端口分配失败");
		await new Promise<void>((accept) => reservation.close(() => accept()));
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const name of Object.keys(environment)) {
			if (/^(KANBAN_|CLINE_KANBAN_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(name)) delete environment[name];
		}
		Object.assign(environment, {
			KANBAN_RUNTIME_HOST: "127.0.0.1",
			KANBAN_RUNTIME_PORT: String(address.port),
			CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-home"),
			CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-home"),
			KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT: join(
				fixture.fixtureRootDirectoryPath,
				"isolated-relations",
			),
		});
		const child = children.register(
			spawn(
				process.execPath,
				[join(distribution, "cli.js"), "--host", "127.0.0.1", "--port", String(address.port), "--no-open"],
				{
					cwd: repository.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
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
		const client = createTRPCProxyClient<RuntimeAppRouter>({
			links: [httpLink({ url: `http://127.0.0.1:${address.port}/api/trpc` })],
		});
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			test,
			{
				waitedForDescription: "隔离打包实例可查询配置",
				softDeadlineMsExpectedOnUncontendedHost: 15_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
			},
			() =>
				client.runtime.getConfig
					.query()
					.then(() => true)
					.catch(() => false),
			{
				describeLastObservedStateForFailureMessage: () => output,
			},
		);
		const initial = await client.runtime.getConfig.query();
		const projects = await client.projects.list.query();
		expect(projects.projects).toHaveLength(1);
		const workspaceId = projects.projects[0]?.id;
		if (!workspaceId) throw new Error("未创建隔离项目归属");
		const scopedClient = createTRPCProxyClient<RuntimeAppRouter>({
			links: [
				httpLink({
					url: `http://127.0.0.1:${address.port}/api/trpc`,
					headers: { "x-kanban-workspace-id": workspaceId },
				}),
			],
		});
		expect(initial.codexModelCapacityErrorAutoContinuationEnabled).toBe(true);
		await client.runtime.saveConfig.mutate({
			autoContinueOnConnectionDropEnabled: false,
			codexModelCapacityErrorAutoContinuationEnabled: true,
		});
		const independent = await client.runtime.getConfig.query();
		expect(independent.autoContinueOnConnectionDropEnabled).toBe(false);
		expect(independent.codexModelCapacityErrorAutoContinuationEnabled).toBe(true);
		await client.runtime.saveConfig.mutate({ codexModelCapacityErrorAutoContinuationEnabled: false });
		expect((await client.runtime.getConfig.query()).codexModelCapacityErrorAutoContinuationEnabled).toBe(false);
		expect(
			await scopedClient.runtime.actOnAutomaticFailureContinuation.mutate({
				taskId: "absent",
				episodeId: "stale",
				action: "cancel",
			}),
		).toEqual({ ok: false });
		const cli = await execFileAsync(
			process.execPath,
			[join(distribution, "cli.js"), "task", "list", "--all-projects", "--group", "waiting_automatic_recovery"],
			{
				cwd: repository.repositoryPath,
				env: environment,
				timeout: 15_000,
			},
		);
		const listed = JSON.parse(cli.stdout);
		expect(listed).toMatchObject({
			ok: true,
			count: 0,
			groups: [{ group: "waiting_automatic_recovery", tasks: [] }],
		});
		const evidenceDirectory = process.env.KANBAN_AUTOMATIC_FAILURE_CONTINUATION_EVIDENCE_DIRECTORY;
		if (evidenceDirectory)
			await writeFile(
				join(evidenceDirectory, "packaged-runtime-check.json"),
				JSON.stringify(
					{
						initialCapacityRecoveryEnabled: initial.codexModelCapacityErrorAutoContinuationEnabled,
						independentConnectionRecoveryEnabled: independent.autoContinueOnConnectionDropEnabled,
						independentCapacityRecoveryEnabled: independent.codexModelCapacityErrorAutoContinuationEnabled,
						staleEpisodeWasRejected: true,
						cliGroups: listed.groups,
					},
					null,
					2,
				),
			);
	},
	60_000,
);
