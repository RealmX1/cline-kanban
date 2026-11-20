import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	isManagedCodexConversationStorageHome,
	prepareManagedCodexConversationStorageHome,
	resolveManagedCodexNativeConfigurationArguments,
} from "../../src/codex-conversation-storage/codex-conversation-storage-home";
import { withCodexAppServerRequestConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import { configureCodexHooks } from "../../src/terminal/codex-hook-config";
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
		it("项目层保留相对引用优先级，辅助 app-server 的 SQLite 固定于选定存储", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-native-config-layers-",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "trusted-project" });
			const source = join(fixture.isolatedHomeDirectoryPath, "native-home");
			const unrelatedSqlite = join(fixture.isolatedHomeDirectoryPath, "unrelated-sqlite");
			await mkdir(unrelatedSqlite);
			await mkdir(source);
			await mkdir(join(repo.repositoryPath, ".codex"));
			await writeFile(join(source, "base.md"), "用户层");
			await writeFile(join(repo.repositoryPath, ".codex", "project.md"), "项目层");
			await writeFile(join(repo.repositoryPath, ".codex", "config.toml"), 'model_instructions_file="project.md"');
			await writeFile(
				join(source, "config.toml"),
				stringify({
					model_instructions_file: "base.md",
					sqlite_home: unrelatedSqlite,
					projects: { [await realpath(repo.repositoryPath)]: { trust_level: "trusted" } },
				}),
			);
			const managed = await prepareManagedCodexConversationStorageHome(source);
			const readConfig = async (home: string, codexSqliteHomeDirectoryPath?: string) =>
				withCodexAppServerRequestConnection(
					{
						binary: process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY,
						workingDirectory: repo.repositoryPath,
						codexConversationStorageHomeDirectoryPath: home,
						codexSqliteHomeDirectoryPath,
						environment: fixture.createIsolatedChildProcessEnvironment({ CODEX_HOME: home }),
					},
					(connection) => connection.request("config/read", { includeLayers: false, cwd: repo.repositoryPath }),
				);
			const separatelyBoundSqlite = join(fixture.isolatedHomeDirectoryPath, "legacy-sqlite");
			await mkdir(separatelyBoundSqlite);
			for (const [home, sqliteHome] of [
				[source, undefined],
				[managed, undefined],
				[managed, separatelyBoundSqlite],
			] as const) {
				const configRead = z
					.object({
						config: z.looseObject({
							model_instructions_file: z.string(),
							sqlite_home: z.string(),
						}),
					})
					.parse(await readConfig(home, sqliteHome));
				expect(configRead.config.model_instructions_file).toMatch(/project\.md$/);
				expect(await realpath(configRead.config.sqlite_home)).toBe(await realpath(sqliteHome ?? home));
			}
			expect(await readdir(unrelatedSqlite)).toEqual([]);
		});

		it("原生进程仍用旧专用目录时保留旧配置，退出后下次启动再转换", async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "codex-live-home-conversion-",
			});
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const source = join(fixture.isolatedHomeDirectoryPath, "source-home");
			const legacyHome = join(
				fixture.isolatedHomeDirectoryPath,
				".cline",
				"kanban",
				"codex-conversation-storage-home",
			);
			await mkdir(source);
			await mkdir(legacyHome, { recursive: true });
			await writeFile(join(source, "config.toml"), 'model="source"');
			await writeFile(join(legacyHome, "config.toml"), 'model="legacy"');
			await writeFile(
				join(legacyHome, "canonical-user-codex-home.json"),
				JSON.stringify({ sourceHomeDirectoryPath: source }),
			);
			await withCodexAppServerRequestConnection(
				{
					binary: process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY,
					workingDirectory: fixture.fixtureRootDirectoryPath,
					environment: fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: legacyHome,
						CODEX_SQLITE_HOME: legacyHome,
					}),
				},
				async () => {
					await expect(prepareManagedCodexConversationStorageHome(source)).rejects.toThrow(/仍使用旧专用目录/);
					expect(await readFile(join(legacyHome, "config.toml"), "utf8")).toBe('model="legacy"');
				},
			);
			expect(await realpath(await prepareManagedCodexConversationStorageHome(source))).toBe(
				await realpath(legacyHome),
			);
			expect(await readFile(join(legacyHome, "config.toml"), "utf8")).toBe('model="source"');
		});

		it.for(["direct_home", "home_symlink", "home_parent_symlink", "runtime_home_parent_symlink"] as const)(
			"%s：共享文件与内联 hooks 继承信任，原生确认和禁用跨启动保留，新增与修改仍待审查",
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
				const readNativeHooks = async (homeDirectoryPath: string, argumentsBeforeSubcommand?: string[]) =>
					withCodexAppServerRequestConnection(
						{
							binary: process.env.KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY,
							workingDirectory: fixture.fixtureRootDirectoryPath,
							argumentsBeforeSubcommand,
							codexConversationStorageHomeDirectoryPath: isManagedCodexConversationStorageHome(homeDirectoryPath)
								? homeDirectoryPath
								: undefined,
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
				const hooksArguments = await resolveManagedCodexNativeConfigurationArguments(managed, []);
				configureCodexHooks(hooksArguments);
				const mergedHooks = await readNativeHooks(managed, hooksArguments);
				const kanbanHook = mergedHooks.find(
					(hook) => hook.key.includes("<session-flags>") && hook.key.endsWith(":session_start:0:0"),
				);
				expect(kanbanHook?.trustStatus).toBe("trusted");

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
				// 模拟在隔离目录中保存的原生确认。链接指向同一份原生配置。
				const managedTrustStates = Object.fromEntries(
					withNewHook.map((hook) => [
						hook.key,
						{ trusted_hash: hook.currentHash, ...(hook.key === disabledHook?.key ? { enabled: false } : {}) },
					]),
				);
				await writeFile(
					join(managed, "config.toml"),
					stringify({
						...configuration,
						hooks: { ...(configuration.hooks as TomlTable), state: managedTrustStates },
					}),
				);
				const originalConfigurationText = await readFile(join(original, "config.toml"), "utf8");
				await prepareManagedCodexConversationStorageHome(original);
				await prepareManagedCodexConversationStorageHome(original);
				const afterRepeatedStarts = await readNativeHooks(managed);
				expect(afterRepeatedStarts).toHaveLength(3);
				expect(afterRepeatedStarts.every((hook) => hook.trustStatus === "trusted")).toBe(true);
				expect(afterRepeatedStarts.find((hook) => hook.key === disabledHook?.key)?.enabled).toBe(false);
				expect(await readFile(join(managed, "config.toml"), "utf8")).toBe(originalConfigurationText);

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
