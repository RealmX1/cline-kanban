import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { prepareManagedCodexConversationStorageHome } from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import { withCodexAppServerRequestConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const nativeHooksListSchema = z.object({
	data: z.array(
		z.object({
			errors: z.array(z.unknown()),
			hooks: z.array(
				z.object({
					key: z.string(),
					currentHash: z.string(),
					enabled: z.boolean(),
					trustStatus: z.enum(["managed", "untrusted", "trusted", "modified"]),
				}),
			),
		}),
	),
});

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY)(
	"真实 Codex hooks 信任跨目录与连续启动（不启动模型回合）",
	{ timeout: 120_000 },
	() => {
		it.for(["direct_home", "home_symlink", "home_parent_symlink", "runtime_home_parent_symlink"] as const)(
			"%s：共享文件与内联 hooks 继承信任，本目录确认和禁用跨刷新保留，新增与修改仍待审查",
			async (homePathLayout) => {
				const fixture = createIsolatedGitTestWorkspaceFixture({
					fixtureRootDirectoryNamePrefix: "codex-hook-trust-native-refresh-",
				});
				vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
				const physicalSourceHomeParentDirectoryPath = join(fixture.isolatedHomeDirectoryPath, "source-home-parent");
				const physicalSourceHomeDirectoryPath = join(physicalSourceHomeParentDirectoryPath, ".codex");
				await mkdir(physicalSourceHomeDirectoryPath, { recursive: true });
				let original = physicalSourceHomeDirectoryPath;
				if (homePathLayout === "home_symlink") {
					original = join(fixture.isolatedHomeDirectoryPath, ".codex");
					await symlink(physicalSourceHomeDirectoryPath, original, "junction");
				} else if (homePathLayout === "home_parent_symlink") {
					const linkedSourceHomeParentDirectoryPath = join(
						fixture.isolatedHomeDirectoryPath,
						"source-home-parent-symlink",
					);
					await symlink(physicalSourceHomeParentDirectoryPath, linkedSourceHomeParentDirectoryPath, "junction");
					original = join(linkedSourceHomeParentDirectoryPath, ".codex");
				} else if (homePathLayout === "runtime_home_parent_symlink") {
					const linkedRuntimeUserHomeDirectoryPath = join(
						fixture.fixtureRootDirectoryPath,
						"runtime-user-home-symlink",
					);
					await symlink(fixture.isolatedHomeDirectoryPath, linkedRuntimeUserHomeDirectoryPath, "junction");
					vi.stubEnv("HOME", linkedRuntimeUserHomeDirectoryPath);
				}
				const configuration: TomlTable = {
					check_for_update_on_startup: false,
					features: { hooks: true },
					hooks: {
						PreToolUse: [
							{ matcher: "^Bash$", hooks: [{ type: "command", command: "printf inline-hook-sentinel" }] },
						],
					},
				};
				const sharedHooks: Record<string, { hooks: { type: string; command: string }[] }[]> = {
					Stop: [{ hooks: [{ type: "command", command: "printf shared-hook-sentinel" }] }],
				};
				await writeFile(join(original, "config.toml"), stringify(configuration));
				await writeFile(join(original, "hooks.json"), JSON.stringify({ hooks: sharedHooks }));
				const readNativeHooks = async (homeDirectoryPath: string) =>
					withCodexAppServerRequestConnection(
						{
							binary: process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY,
							workingDirectory: fixture.fixtureRootDirectoryPath,
							environment: fixture.createIsolatedChildProcessEnvironment({
								CODEX_HOME: homeDirectoryPath,
								CODEX_SQLITE_HOME: homeDirectoryPath,
							}),
							experimentalApi: true,
						},
						async (connection) => {
							const response = nativeHooksListSchema.parse(
								await connection.request("hooks/list", { cwds: [fixture.fixtureRootDirectoryPath] }),
							);
							expect(response.data).toHaveLength(1);
							expect(response.data[0].errors).toEqual([]);
							return response.data[0].hooks;
						},
					);
				const originalHooks = await readNativeHooks(original);
				expect(originalHooks).toHaveLength(2);
				const nativeSourceHomeDirectoryPath = await realpath(original);
				expect(originalHooks.every((hook) => hook.key.startsWith(`${nativeSourceHomeDirectoryPath}/`))).toBe(true);
				(configuration.hooks as TomlTable).state = Object.fromEntries(
					originalHooks.map((hook) => [
						hook.key,
						{ trusted_hash: hook.currentHash, ...(hook.key.endsWith(":stop:0:0") ? { enabled: false } : {}) },
					]),
				);
				await writeFile(join(original, "config.toml"), stringify(configuration));
				expect((await readNativeHooks(original)).every((hook) => hook.trustStatus === "trusted")).toBe(true);
				const managed = await prepareManagedCodexConversationStorageHome(original);
				const inheritedHooks = await readNativeHooks(managed);
				expect(inheritedHooks).toHaveLength(2);
				expect(inheritedHooks.every((hook) => hook.trustStatus === "trusted")).toBe(true);
				expect(inheritedHooks.find((hook) => hook.key.endsWith(":stop:0:0"))?.enabled).toBe(false);

				sharedHooks.UserPromptSubmit = [
					{ hooks: [{ type: "command", command: "printf newly-added-hook-sentinel" }] },
				];
				await writeFile(join(original, "hooks.json"), JSON.stringify({ hooks: sharedHooks }));
				await prepareManagedCodexConversationStorageHome(original);
				const withNewHook = await readNativeHooks(managed);
				const newHook = withNewHook.find((hook) => hook.key.endsWith(":user_prompt_submit:0:0"));
				expect(newHook?.trustStatus).toBe("untrusted");
				const disabledHook = withNewHook.find((hook) => hook.key.endsWith(":stop:0:0"));
				expect(disabledHook).toBeDefined();
				// 模拟原生 /hooks 仅在专用目录保存的决定，原目录始终没有这条新确认。
				const managedTrustStates = Object.fromEntries(
					withNewHook.map((hook) => [
						hook.key,
						{ trusted_hash: hook.currentHash, ...(hook.key === disabledHook?.key ? { enabled: false } : {}) },
					]),
				);
				await writeFile(
					join(managed, "config.toml"),
					stringify({ ...configuration, hooks: { state: managedTrustStates } }),
				);
				configuration.model = "configuration-refresh-sentinel";
				const originalConfigurationText = stringify(configuration);
				await writeFile(join(original, "config.toml"), originalConfigurationText);
				await prepareManagedCodexConversationStorageHome(original);
				await prepareManagedCodexConversationStorageHome(original);
				const afterRepeatedStarts = await readNativeHooks(managed);
				expect(afterRepeatedStarts).toHaveLength(3);
				expect(afterRepeatedStarts.every((hook) => hook.trustStatus === "trusted")).toBe(true);
				expect(afterRepeatedStarts.find((hook) => hook.key === disabledHook?.key)?.enabled).toBe(false);
				expect(await readFile(join(managed, "config.toml"), "utf8")).toContain("configuration-refresh-sentinel");

				sharedHooks.UserPromptSubmit[0].hooks[0].command = "printf modified-hook-sentinel";
				await writeFile(join(original, "hooks.json"), JSON.stringify({ hooks: sharedHooks }));
				await prepareManagedCodexConversationStorageHome(original);
				const afterDefinitionChange = await readNativeHooks(managed);
				expect(afterDefinitionChange.find((hook) => hook.key === newHook?.key)?.trustStatus).toBe("modified");
				expect(afterDefinitionChange.find((hook) => hook.key === disabledHook?.key)?.enabled).toBe(false);
				expect(await readFile(join(original, "config.toml"), "utf8")).toBe(originalConfigurationText);
			},
		);
	},
);
