import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexConfigurationSyncStore } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import type { CodexConfigurationChange } from "../../src/core/codex-configuration-sync-contract";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});
describe.skipIf(!process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH)(
	"打包态运行时的真实审批接口",
	{ timeout: 60_000 },
	() => {
		it("审批前默认不变，批量逐项处理，拒绝与稍后分开，进程重启后重放幂等回执", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-configuration-approval-api-",
			});
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "isolated-configuration-approval",
			});
			await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离 API 验证\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始化隔离审批测试",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const sourceHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
			await mkdir(sourceHome);
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", sourceHome);
			vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
			const initialSourceText = 'model="initial-model"\n';
			await writeFile(join(sourceHome, "config.toml"), initialSourceText);
			const storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
			const binding = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome,
				workspaceId: "approval-api",
				conversationSessionId: "source-observation-location",
				runtimeSessionIncarnationId: randomUUID(),
			});
			const localPath = join(binding.configurationHomeDirectoryPath, "config.toml");
			const localConfiguration = parse(await readFile(localPath, "utf8"));
			Object.assign(localConfiguration, {
				model: "approved-model",
				model_reasoning_effort: "high",
				approval_policy: "on-request",
				sandbox_mode: "workspace-write",
			});
			await writeFile(localPath, stringify(localConfiguration));
			const environment = fixture.createIsolatedChildProcessEnvironment();
			for (const key of Object.keys(environment))
				if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
			environment.CODEX_HOME = sourceHome;
			environment.CODEX_SQLITE_HOME = sourceHome;
			const start = async () => {
				const child = children.register(
					spawn(
						process.execPath,
						[
							"--require",
							resolve("test/integration/shutdown-ipc-hook.cjs"),
							process.env.KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH ?? "",
							"--port",
							"auto",
							"--no-open",
							"--no-passcode",
						],
						{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
					),
				);
				const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(child);
				return {
					child,
					runtimeUrl,
					api: createTRPCProxyClient<RuntimeAppRouter>({
						links: [httpBatchLink({ url: `${new URL(runtimeUrl).origin}/api/trpc` })],
					}),
				};
			};
			const { child, api } = await start();
			let observed = await api.runtime.getCodexConfigurationSyncState.query();
			await vi.waitFor(
				async () => {
					observed = await api.runtime.getCodexConfigurationSyncState.query();
					expect(observed.changes.filter((change) => change.approvalStatus === "pending")).toHaveLength(3);
				},
				{ timeout: 15_000 },
			);
			expect(
				(await readCodexConfigurationSyncStore()).sources[binding.sourceIdentity].fields[
					JSON.stringify(["config.toml", "model"])
				].value,
			).toBe("initial-model");
			const findChange = (field: string) => {
				const change = observed.changes.find((entry) => entry.fieldLabel.endsWith(` · ${field}`));
				if (!change) throw new Error(`缺少提案 ${field}`);
				return change;
			};
			const item = (change: CodexConfigurationChange) => ({
				entryKind: "settings_proposal" as const,
				changeId: change.changeId,
				expectedVersion: change.version,
				idempotencyKey: randomUUID(),
			});
			const model = findChange("model"),
				effort = findChange("model_reasoning_effort"),
				permissionSuggestion = findChange("approval_policy");
			await expect(
				api.runtime.synchronizeCodexConfigurationChange.mutate({
					...item(model),
					synchronizeExistingSessions: true,
				}),
			).rejects.toThrow();
			const approval = {
				action: "approve" as const,
				items: [{ ...item(effort), expectedVersion: 999999 }, item(model)],
			};
			expect(
				(await api.runtime.batchCodexConfigurationAction.mutate(approval)).results.map((result) => result.status),
			).toEqual(["stale_version", "applied"]);
			await api.runtime.batchCodexConfigurationAction.mutate({
				action: "reject",
				items: [item(permissionSuggestion)],
			});
			const deferred = await api.runtime.batchCodexConfigurationAction.mutate({
				action: "defer",
				items: [item(effort)],
			});
			expect(deferred.state.changes.find((change) => change.changeId === effort.changeId)).toMatchObject({
				approvalStatus: "pending",
				acknowledgedAt: expect.any(Number),
			});
			expect(deferred.state.diagnosticCoverage?.systemWriterEvidence).toBe("not_collected_by_runtime");
			await sigkillChildProcessAndWaitForExit(child);
			const restarted = await start();
			expect(
				(await restarted.api.runtime.batchCodexConfigurationAction.mutate(approval)).results.map(
					(result) => result.status,
				),
			).toEqual(["stale_version", "replayed"]);
			const future = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome,
				workspaceId: "approval-api",
				conversationSessionId: "future-after-approval",
				runtimeSessionIncarnationId: randomUUID(),
			});
			expect(parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
				"approved-model",
			);
			expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe(initialSourceText);
			expect(parse(await readFile(localPath, "utf8"))).toMatchObject({
				model: "approved-model",
				model_reasoning_effort: "high",
				approval_policy: "on-request",
				sandbox_mode: "workspace-write",
			});
			await vi.waitFor(
				async () => {
					expect(
						(await restarted.api.runtime.getCodexConfigurationSyncState.query()).diagnosticCoverage
							?.fileObservation,
					).toBe("active");
				},
				{ timeout: 5_000 },
			);
			const evidenceDirectory = process.env.KANBAN_CODEX_CONFIGURATION_SYNC_API_EVIDENCE_DIRECTORY;
			if (evidenceDirectory) {
				await mkdir(evidenceDirectory, { recursive: true });
				await writeFile(
					join(evidenceDirectory, "packaged-approval-api-result.json"),
					JSON.stringify(
						{
							status: "passed",
							checks: [
								"审批前默认不变",
								"未审批设置不能同步",
								"批量部分失败继续",
								"拒绝不修改默认",
								"稍后保留待审批",
								"真实进程重启幂等重放",
								"未来 writer 采用已通过设置",
								"来源本地及全局配置不被回写",
								"诊断系统写入者覆盖明确未知",
							],
						},
						null,
						2,
					),
				);
			}
		});
	},
);
