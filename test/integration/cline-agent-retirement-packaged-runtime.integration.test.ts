import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import { clearKanbanRuntimeTls, getRuntimeFetch, setKanbanRuntimeTls } from "../../src/core/runtime-endpoint";
import { loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	clearKanbanRuntimeTls();
	vi.unstubAllEnvs();
});

it.skipIf(!process.env.KANBAN_CLINE_AGENT_RETIREMENT_PACKAGED_RUNTIME_CLI_PATH)(
	"打包运行时跨重启保留旧 Cline 数据，通过 TLS 拒绝手动、fork 和自动执行",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 90_000,
		}),
	},
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "retired-cline-agent" });
		await writeFile(join(repository.repositoryPath, "README.md"), "旧 Cline 卡和用户数据必须保留\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "建立退役回归隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const preservedUserWorkPath = join(repository.repositoryPath, "preserved-user-work.txt");
		await writeFile(preservedUserWorkPath, "用户尚未提交的内容\n");
		const taskId = "abc12";
		const historicalSettings = { providerId: "historical-provider", modelId: "historical-model" };
		await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: {
				columns: [
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: taskId,
								title: "旧 Cline 卡保留",
								prompt: "保留旧来源",
								agentId: "cline",
								clineSettings: historicalSettings,
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 1,
							},
							{
								id: "acp34",
								title: "ACP 共享聊天保留",
								prompt: "展示 ACP 消息",
								agentId: "omp",
								ompAgentSessionTransport: "acp_stdio_subprocess",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 3,
								updatedAt: 3,
							},
						],
					},
				],
			},
			sessions: {
				acp34: {
					taskId: "acp34",
					agentId: "omp",
					sessionTransport: "acp_stdio_subprocess",
					state: "idle",
					workspacePath: repository.repositoryPath,
					pid: null,
					startedAt: 3,
					updatedAt: 3,
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
				},
				[taskId]: {
					taskId,
					agentId: "cline",
					sessionTransport: "in_process_cline_sdk",
					state: "idle",
					workspacePath: repository.repositoryPath,
					pid: null,
					startedAt: 1,
					updatedAt: 2,
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
				},
			},
		});
		const workspace = await loadWorkspaceContext(repository.repositoryPath, { autoCreateIfMissing: false });
		const historicalSdkDataPath = join(fixture.isolatedHomeDirectoryPath, ".cline/data/preserved-sdk-history.txt");
		await mkdir(dirname(historicalSdkDataPath), { recursive: true });
		await writeFile(historicalSdkDataPath, "旧 SDK 数据不打开、不删除\n");
		const globalConfigPath = join(fixture.isolatedHomeDirectoryPath, ".cline/kanban/config.json");
		await writeFile(globalConfigPath, `${JSON.stringify({ selectedAgentId: "cline" })}\n`);
		const tlsCertificatePath = join(fixture.fixtureRootDirectoryPath, "isolated-runtime-certificate.pem");
		const tlsKeyPath = join(fixture.fixtureRootDirectoryPath, "isolated-runtime-key.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				tlsKeyPath,
				"-out",
				tlsCertificatePath,
				"-days",
				"2",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
			],
			{ env: fixture.createIsolatedChildProcessEnvironment(), stdio: "pipe" },
		);
		const cert = await readFile(tlsCertificatePath, "utf8");
		setKanbanRuntimeTls({ cert, key: await readFile(tlsKeyPath, "utf8"), ca: cert });
		const runtimeFetch = await getRuntimeFetch();
		const cliPath = resolve(process.env.KANBAN_CLINE_AGENT_RETIREMENT_PACKAGED_RUNTIME_CLI_PATH ?? "dist/cli.js");
		const childEnvironment = fixture.createIsolatedChildProcessEnvironment({
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			CODEX_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-configuration"),
			CODEX_SQLITE_HOME: join(fixture.fixtureRootDirectoryPath, "isolated-codex-storage"),
			CLAUDE_CONFIG_DIR: join(fixture.fixtureRootDirectoryPath, "isolated-claude-configuration"),
			PI_CODING_AGENT_DIR: join(fixture.fixtureRootDirectoryPath, "isolated-omp-configuration"),
			KANBAN_RUNTIME_PORT: undefined,
			KANBAN_RUNTIME_HTTPS: undefined,
			KANBAN_RUNTIME_TLS_CA: undefined,
			DO_NOT_TRACK: "1",
		});
		for (let incarnation = 1; incarnation <= 2; incarnation++) {
			const child = children.register(
				spawn(
					process.execPath,
					[
						cliPath,
						"--host",
						"127.0.0.1",
						"--port",
						"auto",
						"--no-open",
						"--skip-shutdown-cleanup",
						"--cert",
						tlsCertificatePath,
						"--key",
						tlsKeyPath,
					],
					{ cwd: repository.repositoryPath, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] },
				),
			);
			const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
			expect(origin).toMatch(/^https:/);
			const client = createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpBatchLink({
						url: `${origin}/api/trpc`,
						fetch: runtimeFetch,
						headers: { "x-kanban-workspace-id": workspace.workspaceId },
					}),
				],
			});
			const config = await client.runtime.getConfig.query();
			expect(config.selectedAgentId).toBe("codex");
			expect(config.agents.every((agent) => agent.id !== "cline" && !agent.installed)).toBe(true);
			expect(config).not.toHaveProperty("clineProviderSettings");
			const state = await client.workspace.getState.query();
			expect(state.board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)).toMatchObject(
				{ agentId: "cline", clineSettings: historicalSettings },
			);
			expect(state.sessions[taskId]?.agentId).toBe("cline");
			for (const response of [
				await client.runtime.startTaskSession.mutate({
					taskId,
					agentId: "cline",
					prompt: "拒绝执行",
					baseRef: "main",
				}),
				await client.runtime.refreshTaskTerminal.mutate({ taskId, cols: 120, rows: 40 }),
				await client.runtime.sendTaskChatMessage.mutate({ taskId, text: "拒绝聊天" }),
				await client.runtime.createTaskConversationSession.mutate({
					taskId,
					agentId: "cline",
					sessionRole: "task_collaborator",
					contextSource: "creator",
					startInPlanMode: false,
					creationReason: "验证旧 Agent 拒绝 fork",
					idempotencyKey: `retired-fork-${incarnation}`,
				}),
				await client.runtime.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mutate({
					taskId,
					text: "拒绝自动消息",
					source: "retirement-regression",
					idempotencyKey: `retired-automatic-${incarnation}`,
					promptSha256: "retired",
					maxWaitForAgentIdleMs: 1000,
				}),
			]) {
				expect(response.ok).toBe(false);
				expect(response.error).toContain("Cline agent 已退役");
			}
			for (const procedure of ["getClineProviderCatalog", "getClineMcpSettings", "getFeaturebaseToken"])
				expect((await runtimeFetch(`${origin}/api/trpc/runtime.${procedure}`)).status).toBe(404);
			const runtimeUrl = new URL(origin);
			const cliEnvironment = {
				...childEnvironment,
				KANBAN_RUNTIME_HOST: runtimeUrl.hostname,
				KANBAN_RUNTIME_PORT: runtimeUrl.port,
				KANBAN_RUNTIME_HTTPS: "1",
				KANBAN_RUNTIME_TLS_CA: cert,
			};
			const cliOutput = execFileSync(
				process.execPath,
				[cliPath, "task", "get", "--task-id", taskId, "--project-path", repository.repositoryPath],
				{ cwd: repository.repositoryPath, env: cliEnvironment, encoding: "utf8", timeout: 20_000 },
			);
			expect(cliOutput).toContain("旧 Cline 卡保留");
			const browserProbePath = process.env.KANBAN_CLINE_AGENT_RETIREMENT_BROWSER_PROBE_SCRIPT_PATH;
			if (browserProbePath && incarnation === 1) {
				await new Promise<void>((accept, reject) => {
					children.register(
						execFile(
							process.execPath,
							[browserProbePath, origin, workspace.workspaceId, taskId],
							{ env: cliEnvironment, timeout: 60_000, maxBuffer: 1024 * 1024 },
							(error, stdout, stderr) =>
								error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : accept(),
						),
					);
				});
			}
			expect(await sigkillChildProcessAndWaitForExit(child)).toBe(true);
			expect(await readFile(historicalSdkDataPath, "utf8")).toBe("旧 SDK 数据不打开、不删除\n");
			expect(await readFile(preservedUserWorkPath, "utf8")).toBe("用户尚未提交的内容\n");
		}
	},
);
