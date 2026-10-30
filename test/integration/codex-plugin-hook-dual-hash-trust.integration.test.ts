import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCodexConfigurationProfile } from "../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../src/codex-configuration-sync/codex-configuration-sync-service";
import { mutateCodexConfigurationSyncStore } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { withCodexAppServerRequestConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { withExplicitApprovalOfObservedCodexConfigurationProposals } from "../utilities/explicitly-approve-observed-codex-configuration-proposals";
import { requireDefinedTestFixtureValue } from "../utilities/require-defined-test-fixture-value";

const nativeHookResponseSchema = z.object({
	data: z.array(
		z.object({
			errors: z.array(z.unknown()),
			hooks: z.array(
				z.object({ key: z.string(), currentHash: z.string(), trustStatus: z.string(), enabled: z.boolean() }),
			),
		}),
	),
});

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY)(
	"真实 Codex 插件 hook 双哈希信任（不启动模型回合）",
	{ timeout: 120_000 },
	() => {
		it("确认和仅内容重新确认跨 profile、新会话、同步服务重启保留；脚本变化、禁用和撤销保持原生门禁", async () => {
			const isolatedGitWorkspaceFixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-plugin-hook-dual-hash-",
			});
			vi.stubEnv("HOME", isolatedGitWorkspaceFixture.isolatedHomeDirectoryPath);
			const sourceCodexConfigurationHomeDirectoryPath = join(
				isolatedGitWorkspaceFixture.isolatedHomeDirectoryPath,
				".codex",
			);
			vi.stubEnv("CODEX_HOME", sourceCodexConfigurationHomeDirectoryPath);
			vi.stubEnv("CODEX_SQLITE_HOME", sourceCodexConfigurationHomeDirectoryPath);
			const pluginInstallationDirectoryPath = join(
				sourceCodexConfigurationHomeDirectoryPath,
				"plugins",
				"cache",
				"hook-trust-fixture-marketplace",
				"example",
				"1.0.0",
			);
			await mkdir(join(pluginInstallationDirectoryPath, ".codex-plugin"), { recursive: true });
			await mkdir(join(pluginInstallationDirectoryPath, "hooks"));
			await writeFile(
				join(pluginInstallationDirectoryPath, ".codex-plugin", "plugin.json"),
				JSON.stringify({ name: "example", version: "1.0.0" }),
			);
			await writeFile(
				join(pluginInstallationDirectoryPath, "hooks", "hooks.json"),
				JSON.stringify({
					hooks: {
						UserPromptSubmit: [
							{ hooks: [{ type: "command", command: `python3 "\${PLUGIN_ROOT}/record-hook.py"` }] },
						],
					},
				}),
			);
			const pluginHookScriptFilePath = join(pluginInstallationDirectoryPath, "record-hook.py");
			await writeFile(pluginHookScriptFilePath, 'print("initial-hook-trust-fixture")\n');
			const localPluginMarketplaceDirectoryPath = join(
				isolatedGitWorkspaceFixture.fixtureRootDirectoryPath,
				"hook-trust-fixture-marketplace",
			);
			await mkdir(join(localPluginMarketplaceDirectoryPath, ".agents", "plugins"), { recursive: true });
			await writeFile(
				join(localPluginMarketplaceDirectoryPath, ".agents", "plugins", "marketplace.json"),
				JSON.stringify({
					name: "hook-trust-fixture-marketplace",
					plugins: [{ name: "example", source: { source: "local", path: "./plugins/example" } }],
				}),
			);
			await writeFile(
				join(sourceCodexConfigurationHomeDirectoryPath, "config.toml"),
				stringify({
					check_for_update_on_startup: false,
					features: { hooks: true },
					plugins: { "example@hook-trust-fixture-marketplace": { enabled: true } },
					marketplaces: {
						"hook-trust-fixture-marketplace": {
							source_type: "local",
							source: localPluginMarketplaceDirectoryPath,
						},
					},
				}),
			);
			const readNativePluginHook = async (configurationHomeDirectoryPath: string) =>
				withCodexAppServerRequestConnection(
					{
						binary: process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY,
						workingDirectory: isolatedGitWorkspaceFixture.fixtureRootDirectoryPath,
						environment: isolatedGitWorkspaceFixture.createIsolatedChildProcessEnvironment({
							CODEX_HOME: configurationHomeDirectoryPath,
							CODEX_SQLITE_HOME: configurationHomeDirectoryPath,
						}),
						experimentalApi: true,
					},
					async (codexAppServerRequestPort) => {
						const nativePluginHookListResponse = nativeHookResponseSchema.parse(
							await codexAppServerRequestPort.request("hooks/list", {
								cwds: [isolatedGitWorkspaceFixture.fixtureRootDirectoryPath],
							}),
						);
						expect(nativePluginHookListResponse.data).toHaveLength(1);
						expect(nativePluginHookListResponse.data[0].errors).toEqual([]);
						expect(nativePluginHookListResponse.data[0].hooks).toHaveLength(1);
						return nativePluginHookListResponse.data[0].hooks[0];
					},
				);
			const createConfigurationWriterBinding = (codexConfigurationProfileId?: string) =>
				prepareCodexConfigurationWriterBinding({
					purpose: "native_session",
					storageHome: sourceCodexConfigurationHomeDirectoryPath,
					workspaceId: "hook-dual-hash-fixture",
					conversationSessionId: randomUUID(),
					runtimeSessionIncarnationId: randomUUID(),
					codexConfigurationProfileId,
				});
			const originConfigurationWriterBinding = await createConfigurationWriterBinding();
			const otherConfigurationProfile = await mutateCodexConfigurationSyncStore((store) =>
				createCodexConfigurationProfile(store, {
					name: "跨 profile 双哈希验证",
					copyFromProfileId: requireDefinedTestFixtureValue(
						store.writers[originConfigurationWriterBinding.writerId].codexConfigurationProfileId,
					),
				}),
			);
			const readNewWriterPluginHook = async (codexConfigurationProfileId?: string) =>
				readNativePluginHook(
					(await createConfigurationWriterBinding(codexConfigurationProfileId)).configurationHomeDirectoryPath,
				);
			const originConfigurationFilePath = join(
				originConfigurationWriterBinding.configurationHomeDirectoryPath,
				"config.toml",
			);
			const initialNativePluginHook = await readNativePluginHook(
				originConfigurationWriterBinding.configurationHomeDirectoryPath,
			);
			expect(initialNativePluginHook.trustStatus).toBe("untrusted");
			const writeOriginHookTrustDecision = async (hookTrustDecision: TomlTable) => {
				const originConfigurationTable = parse(await readFile(originConfigurationFilePath, "utf8"));
				originConfigurationTable.hooks = { state: { [initialNativePluginHook.key]: hookTrustDecision } };
				await writeFile(originConfigurationFilePath, stringify(originConfigurationTable));
			};
			const buildConfirmedHookStateFromNativeFingerprint = (nativeHookFingerprint: string) => {
				const [trusted_hash, trusted_content_hash] = nativeHookFingerprint.split("/");
				expect(trusted_hash).toMatch(/^sha256:/);
				expect(trusted_content_hash).toMatch(/^sha256:/);
				return { trusted_hash, trusted_content_hash };
			};
			const createConfigurationSynchronizationService = () =>
				withExplicitApprovalOfObservedCodexConfigurationProposals(
					createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} }),
				);
			let configurationSynchronizationService = createConfigurationSynchronizationService();
			try {
				await writeOriginHookTrustDecision(
					buildConfirmedHookStateFromNativeFingerprint(initialNativePluginHook.currentHash),
				);
				await configurationSynchronizationService.scan();
				expect(
					(await readNativePluginHook((await createConfigurationWriterBinding()).configurationHomeDirectoryPath))
						.trustStatus,
				).toBe("trusted");
				expect(await readNewWriterPluginHook(otherConfigurationProfile.profileId)).toMatchObject({
					trustStatus: "trusted",
					enabled: true,
				});
				await configurationSynchronizationService.close();
				configurationSynchronizationService = createConfigurationSynchronizationService();
				expect(
					(await readNativePluginHook((await createConfigurationWriterBinding()).configurationHomeDirectoryPath))
						.trustStatus,
				).toBe("trusted");
				expect((await readNewWriterPluginHook(otherConfigurationProfile.profileId)).trustStatus).toBe("trusted");
				await writeFile(pluginHookScriptFilePath, 'print("changed-hook-trust-fixture")\n');
				const modifiedNativePluginHook = await readNativePluginHook(
					originConfigurationWriterBinding.configurationHomeDirectoryPath,
				);
				expect(modifiedNativePluginHook.trustStatus).toBe("modified");
				expect(modifiedNativePluginHook.currentHash.split("/")[0]).toBe(
					initialNativePluginHook.currentHash.split("/")[0],
				);
				expect(modifiedNativePluginHook.currentHash.split("/")[1]).not.toBe(
					initialNativePluginHook.currentHash.split("/")[1],
				);
				await writeOriginHookTrustDecision({
					...buildConfirmedHookStateFromNativeFingerprint(initialNativePluginHook.currentHash),
					enabled: false,
				});
				await configurationSynchronizationService.scan();
				expect(
					await readNativePluginHook((await createConfigurationWriterBinding()).configurationHomeDirectoryPath),
				).toMatchObject({ enabled: false, trustStatus: "modified" });
				expect(await readNewWriterPluginHook(otherConfigurationProfile.profileId)).toMatchObject({
					enabled: true,
					trustStatus: "modified",
				});
				await writeOriginHookTrustDecision(
					buildConfirmedHookStateFromNativeFingerprint(modifiedNativePluginHook.currentHash),
				);
				await configurationSynchronizationService.scan();
				expect(
					(await readNativePluginHook((await createConfigurationWriterBinding()).configurationHomeDirectoryPath))
						.trustStatus,
				).toBe("trusted");
				expect((await readNewWriterPluginHook(otherConfigurationProfile.profileId)).trustStatus).toBe("trusted");
				await writeOriginHookTrustDecision({
					...buildConfirmedHookStateFromNativeFingerprint(modifiedNativePluginHook.currentHash),
					enabled: false,
				});
				await configurationSynchronizationService.scan();
				expect(
					await readNativePluginHook((await createConfigurationWriterBinding()).configurationHomeDirectoryPath),
				).toMatchObject({
					enabled: false,
					trustStatus: "trusted",
				});
				expect(await readNewWriterPluginHook(otherConfigurationProfile.profileId)).toMatchObject({
					enabled: true,
					trustStatus: "trusted",
				});
				await writeOriginHookTrustDecision({});
				await configurationSynchronizationService.scan();
				expect(
					(await readNativePluginHook((await createConfigurationWriterBinding()).configurationHomeDirectoryPath))
						.trustStatus,
				).toBe("untrusted");
				expect((await readNewWriterPluginHook(otherConfigurationProfile.profileId)).trustStatus).toBe("untrusted");
			} finally {
				await configurationSynchronizationService.close();
			}
		});
	},
);
