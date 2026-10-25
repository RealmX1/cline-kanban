import type * as FileSystemPromises from "node:fs/promises";
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCodexConversationStorageEnvironment,
	getManagedCodexConversationStorageHomeDirectoryPath,
	prepareManagedCodexConversationStorageHome,
	resolveRecordedCodexConversationHome,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { createTempDir } from "../../utilities/temp-dir";

const snapshotWriteInterception = vi.hoisted(() => ({
	afterPendingSnapshotWrite: null as ((pendingPath: string) => Promise<void>) | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fileSystem = await importOriginal<typeof FileSystemPromises>();
	return {
		...fileSystem,
		writeFile: async (...arguments_: Parameters<typeof fileSystem.writeFile>) => {
			await fileSystem.writeFile(...arguments_);
			const path = arguments_[0];
			if (typeof path === "string" && path.endsWith(".pending-write"))
				await snapshotWriteInterception.afterPendingSnapshotWrite?.(path);
		},
	};
});

let fixture: ReturnType<typeof createTempDir>;
beforeEach(async () => {
	fixture = createTempDir("kanban-codex-storage-home-");
	// 默认样本采用原生 home 身份；软链布局在对应回归中显式构造。
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
});
afterEach(() => {
	snapshotWriteInterception.afterPendingSnapshotWrite = null;
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("Codex 会话独立目录", () => {
	it("共享现有认证和能力配置，历史与 SQLite 留在专用目录", async () => {
		const original = join(fixture.path, ".codex");
		await mkdir(join(original, "skills"), { recursive: true });
		await writeFile(join(original, "auth.json"), '{"synthetic":true}');
		await writeFile(join(original, ".credentials.json"), '{"syntheticMcpOAuth":true}');
		const configuration =
			'model="sentinel-model"\nsqlite_home="/must-not-inherit"\nmodel_instructions_file="instructions.md"\n[mcp_servers.example]\ncommand="example-mcp"\n';
		await writeFile(join(original, "config.toml"), configuration);
		const managed = await prepareManagedCodexConversationStorageHome(original);
		expect(managed).toBe(getManagedCodexConversationStorageHomeDirectoryPath());
		expect(await readlink(join(managed, "auth.json"))).toBe(join(original, "auth.json"));
		expect(await readlink(join(managed, ".credentials.json"))).toBe(join(original, ".credentials.json"));
		expect((await lstat(join(managed, "skills"))).isSymbolicLink()).toBe(true);
		expect(await readFile(join(original, "config.toml"), "utf8")).toBe(configuration);
		const snapshot = await readFile(join(managed, "config.toml"), "utf8");
		expect(snapshot).toContain("sentinel-model");
		expect(snapshot).toContain(managed);
		expect(snapshot).not.toContain("/must-not-inherit");
		expect(snapshot).toContain(join(original, "instructions.md"));
		expect(snapshot).toContain("example-mcp");
	});
	it.for(["config.toml", "review.config.toml"])(
		"%s 的配置文件引用沿用原目录，角色文件内部相对路径不变",
		async (sourceConfigurationFileName) => {
			const original = join(fixture.path, ".codex");
			await mkdir(join(original, "agents"), { recursive: true });
			await mkdir(join(original, "instructions"));
			for (const name of ["model.md", "legacy.md", "compact.md"])
				await writeFile(join(original, "instructions", name), `隔离指令 ${name}`);
			await writeFile(join(original, "catalog.json"), '{"models":[]}');
			const roleConfiguration = 'model_instructions_file="../instructions/model.md"\n';
			await writeFile(join(original, "agents", "worker.toml"), roleConfiguration);
			const absoluteRoleConfigurationPath = join(original, "agents", "worker.toml");
			const configuration = stringify({
				model_instructions_file: "instructions/model.md",
				experimental_instructions_file: "instructions/legacy.md",
				experimental_compact_prompt_file: "instructions/compact.md",
				model_catalog_json: "catalog.json",
				sqlite_home: "/must-not-inherit",
				agents: {
					max_depth: 3,
					worker: { description: "相对角色", config_file: "agents/worker.toml" },
					reviewer: { description: "绝对角色", config_file: absoluteRoleConfigurationPath },
				},
				mcp_servers: { example: { command: "example-mcp", args: ["relative-argument"] } },
			});
			await writeFile(join(original, sourceConfigurationFileName), configuration);
			const managed = await prepareManagedCodexConversationStorageHome(original);
			const snapshot = parse(await readFile(join(managed, sourceConfigurationFileName), "utf8"));
			expect(snapshot).toMatchObject({
				model_instructions_file: join(original, "instructions", "model.md"),
				experimental_instructions_file: join(original, "instructions", "legacy.md"),
				experimental_compact_prompt_file: join(original, "instructions", "compact.md"),
				model_catalog_json: join(original, "catalog.json"),
				sqlite_home: managed,
				agents: {
					max_depth: 3,
					worker: { description: "相对角色", config_file: absoluteRoleConfigurationPath },
					reviewer: { description: "绝对角色", config_file: absoluteRoleConfigurationPath },
				},
				mcp_servers: { example: { command: "example-mcp", args: ["relative-argument"] } },
			});
			for (const field of [
				"model_instructions_file",
				"experimental_instructions_file",
				"experimental_compact_prompt_file",
				"model_catalog_json",
			])
				expect(await readFile(String(snapshot[field]), "utf8")).not.toBe("");
			expect(await readFile(absoluteRoleConfigurationPath, "utf8")).toBe(roleConfiguration);
			expect(await readFile(join(original, sourceConfigurationFileName), "utf8")).toBe(configuration);
		},
	);
	it("内联 profile 的指令、压缩提示和模型目录引用保留原基址", async () => {
		const original = join(fixture.path, ".codex");
		await mkdir(join(original, "profile-instructions"), { recursive: true });
		await writeFile(join(original, "profile-instructions", "model.md"), "内联 profile 指令");
		await writeFile(join(original, "profile-instructions", "compact.md"), "内联 profile 压缩指令");
		await writeFile(join(original, "catalog.json"), '{"models":[]}');
		const configuration = stringify({
			profiles: {
				review: {
					model_instructions_file: "profile-instructions/model.md",
					experimental_compact_prompt_file: "profile-instructions/compact.md",
					model_catalog_json: "catalog.json",
				},
				legacy: { experimental_instructions_file: "profile-instructions/model.md" },
			},
		});
		await writeFile(join(original, "config.toml"), configuration);
		const managed = await prepareManagedCodexConversationStorageHome(original);
		expect(parse(await readFile(join(managed, "config.toml"), "utf8"))).toMatchObject({
			sqlite_home: managed,
			profiles: {
				review: {
					model_instructions_file: join(original, "profile-instructions", "model.md"),
					experimental_compact_prompt_file: join(original, "profile-instructions", "compact.md"),
					model_catalog_json: join(original, "catalog.json"),
				},
				legacy: { experimental_instructions_file: join(original, "profile-instructions", "model.md") },
			},
		});
		expect(await readFile(join(original, "config.toml"), "utf8")).toBe(configuration);
	});
	it("刷新配置快照，拒绝混用另一套账号目录", async () => {
		const original = join(fixture.path, ".codex");
		await mkdir(original);
		await writeFile(join(original, "config.toml"), 'model="first"');
		const managed = await prepareManagedCodexConversationStorageHome(original);
		await writeFile(join(original, "config.toml"), 'model="second"');
		await prepareManagedCodexConversationStorageHome(original);
		expect(await readFile(join(managed, "config.toml"), "utf8")).toContain("second");
		await expect(prepareManagedCodexConversationStorageHome(join(fixture.path, "another-account"))).rejects.toThrow(
			"不能混用账号",
		);
	});
	it.for(["config.toml", "review.config.toml"])(
		"%s 迁移用户文件信任键，连续刷新保留本目录确认及其他配置更新",
		async (configurationFileName) => {
			const original = join(fixture.path, ".codex");
			await mkdir(original);
			await writeFile(join(original, "hooks.json"), '{"hooks":{}}');
			const originalFileKey = `${join(original, "hooks.json")}:stop:0:0`;
			const originalInlineKey = `${join(original, configurationFileName)}:pre_tool_use:0:0`;
			const pluginKey = "example@marketplace:hooks/hooks.json:stop:0:0";
			const sourceConfiguration = {
				model: "first-model",
				hooks: {
					state: {
						[originalFileKey]: { trusted_hash: "sha256:original-file" },
						[originalInlineKey]: { trusted_hash: "sha256:original-inline" },
						[pluginKey]: { trusted_hash: "sha256:original-plugin" },
					},
				},
			};
			await writeFile(join(original, configurationFileName), stringify(sourceConfiguration));
			const managed = await prepareManagedCodexConversationStorageHome(original);
			const managedConfigurationPath = join(managed, configurationFileName);
			const managedFileKey = `${join(managed, "hooks.json")}:stop:0:0`;
			const managedInlineKey = `${managedConfigurationPath}:pre_tool_use:0:0`;
			const configuration = parse(await readFile(managedConfigurationPath, "utf8"));
			expect(configuration.hooks).toMatchObject({
				state: {
					[managedFileKey]: { trusted_hash: "sha256:original-file" },
					[managedInlineKey]: { trusted_hash: "sha256:original-inline" },
					[pluginKey]: { trusted_hash: "sha256:original-plugin" },
				},
			});
			configuration.hooks = {
				state: {
					[managedFileKey]: { trusted_hash: "sha256:confirmed-in-managed-home" },
					[managedInlineKey]: { enabled: false },
					[pluginKey]: { trusted_hash: "sha256:confirmed-plugin" },
					"only-confirmed-in-managed-home": { trusted_hash: "sha256:local" },
				},
			};
			await writeFile(managedConfigurationPath, stringify(configuration));
			sourceConfiguration.model = "second-model";
			await writeFile(join(original, configurationFileName), stringify(sourceConfiguration));
			await prepareManagedCodexConversationStorageHome(original);
			expect(parse(await readFile(managedConfigurationPath, "utf8"))).toMatchObject({
				model: "second-model",
				hooks: {
					state: {
						[managedFileKey]: { trusted_hash: "sha256:confirmed-in-managed-home" },
						[managedInlineKey]: { enabled: false },
						[pluginKey]: { trusted_hash: "sha256:confirmed-plugin" },
						"only-confirmed-in-managed-home": { trusted_hash: "sha256:local" },
					},
				},
			});
			// 原生保存留下的格式与注释也应保留；无变化的新 Task 不再触碰此配置。
			const before = `${await readFile(managedConfigurationPath, "utf8")}\n# 原生 hooks 确认后保留的注释\n`;
			await writeFile(managedConfigurationPath, before);
			await Promise.all(Array.from({ length: 3 }, () => prepareManagedCodexConversationStorageHome(original)));
			expect(await readFile(managedConfigurationPath, "utf8")).toBe(before);
			expect(await readFile(join(original, configurationFileName), "utf8")).toBe(stringify(sourceConfiguration));
		},
	);
	it.for(
		["home_symlink", "home_parent_symlink", "runtime_home_parent_symlink"].flatMap((homePathLayout) =>
			["config.toml", "review.config.toml"].map((configurationFileName) => ({
				homePathLayout,
				configurationFileName,
			})),
		),
	)(
		"$homePathLayout/$configurationFileName：按原生 home 身份继承信任，保持来源与账号边界",
		async ({ homePathLayout, configurationFileName }) => {
			const physicalSourceHomeParentDirectoryPath = join(fixture.path, "source-home-parent");
			const physicalSourceHomeDirectoryPath = join(physicalSourceHomeParentDirectoryPath, ".codex");
			await mkdir(physicalSourceHomeDirectoryPath, { recursive: true });
			let original = physicalSourceHomeDirectoryPath;
			if (homePathLayout === "home_symlink") {
				original = join(fixture.path, ".codex");
				await symlink(physicalSourceHomeDirectoryPath, original, "junction");
			} else if (homePathLayout === "home_parent_symlink") {
				const linkedSourceHomeParentDirectoryPath = join(fixture.path, "source-home-parent-symlink");
				await symlink(physicalSourceHomeParentDirectoryPath, linkedSourceHomeParentDirectoryPath, "junction");
				original = join(linkedSourceHomeParentDirectoryPath, ".codex");
			} else {
				const linkedRuntimeUserHomeDirectoryPath = join(fixture.path, "runtime-user-home-symlink");
				await symlink(fixture.path, linkedRuntimeUserHomeDirectoryPath, "junction");
				vi.stubEnv("HOME", linkedRuntimeUserHomeDirectoryPath);
			}
			await writeFile(join(original, "hooks.json"), '{"hooks":{}}');
			const nativeSourceHomeDirectoryPath = await realpath(original);
			const sourceTrustStates: Record<string, { trusted_hash: string; enabled?: boolean }> = {
				[`${join(nativeSourceHomeDirectoryPath, "hooks.json")}:stop:0:0`]: {
					trusted_hash: "sha256:shared-hook",
					enabled: false,
				},
				[`${join(nativeSourceHomeDirectoryPath, configurationFileName)}:pre_tool_use:0:0`]: {
					trusted_hash: "sha256:inline-hook",
				},
				[`${join(original, "other-hooks.json")}:post_tool_use:0:0`]: { trusted_hash: "sha256:unrelated-file" },
			};
			if (original !== nativeSourceHomeDirectoryPath)
				sourceTrustStates[`${join(original, configurationFileName)}:post_tool_use:0:0`] = {
					trusted_hash: "sha256:non-native-lexical-alias",
				};
			const sourceConfigurationText = stringify({
				hooks: { state: sourceTrustStates },
				profiles: { review: { hooks: { state: sourceTrustStates } } },
			});
			await writeFile(join(original, configurationFileName), sourceConfigurationText);
			const managed = await prepareManagedCodexConversationStorageHome(original);
			const nativeManagedHomeDirectoryPath = await realpath(managed);
			const expectedTrustStates = {
				...sourceTrustStates,
				[`${join(nativeManagedHomeDirectoryPath, "hooks.json")}:stop:0:0`]: {
					trusted_hash: "sha256:shared-hook",
					enabled: false,
				},
				[`${join(nativeManagedHomeDirectoryPath, configurationFileName)}:pre_tool_use:0:0`]: {
					trusted_hash: "sha256:inline-hook",
				},
			};
			const snapshot = parse(await readFile(join(managed, configurationFileName), "utf8"));
			expect(snapshot.hooks).toEqual({ state: expectedTrustStates });
			expect(snapshot.profiles).toEqual({ review: { hooks: { state: expectedTrustStates } } });
			expect(await readlink(join(managed, "hooks.json"))).toBe(join(original, "hooks.json"));
			expect(await readFile(join(original, configurationFileName), "utf8")).toBe(sourceConfigurationText);
			const otherSourceHomeDirectoryPath =
				original === physicalSourceHomeDirectoryPath
					? join(fixture.path, "another-account")
					: physicalSourceHomeDirectoryPath;
			await expect(prepareManagedCodexConversationStorageHome(otherSourceHomeDirectoryPath)).rejects.toThrow(
				"不能混用账号",
			);
		},
	);
	it("来源明确禁用继续有效，目标的显式未信任记录不被来源信任填满", async () => {
		const original = join(fixture.path, ".codex");
		await mkdir(original);
		await writeFile(join(original, "hooks.json"), '{"hooks":{}}');
		const sourceKey = `${join(original, "hooks.json")}:stop:0:0`;
		await writeFile(
			join(original, "config.toml"),
			stringify({ hooks: { state: { [sourceKey]: { enabled: false, trusted_hash: "sha256:source" } } } }),
		);
		const managed = await prepareManagedCodexConversationStorageHome(original);
		const managedKey = `${join(managed, "hooks.json")}:stop:0:0`;
		const managedConfigurationPath = join(managed, "config.toml");
		await writeFile(
			managedConfigurationPath,
			stringify({ hooks: { state: { [managedKey]: { enabled: true }, "local-untrusted-hook": {} } } }),
		);
		await prepareManagedCodexConversationStorageHome(original);
		const result = parse(await readFile(managedConfigurationPath, "utf8"));
		expect(result.hooks).toMatchObject({ state: { [managedKey]: { enabled: false }, "local-untrusted-hook": {} } });
		expect((result.hooks as { state: Record<string, unknown> }).state[managedKey]).not.toHaveProperty("trusted_hash");
	});
	it("旧内联 profile 的信任确认继续保留，项目路径和插件身份不跨范围映射", async () => {
		const original = join(fixture.path, ".codex");
		await mkdir(original);
		const sourceKey = `${join(original, "config.toml")}:stop:0:0`;
		const projectKey = `${join(fixture.path, "project", ".codex", "hooks.json")}:stop:0:0`;
		await writeFile(
			join(original, "config.toml"),
			stringify({ profiles: { review: { hooks: { state: { [sourceKey]: { trusted_hash: "sha256:profile" } } } } } }),
		);
		const managed = await prepareManagedCodexConversationStorageHome(original);
		const managedKey = `${join(managed, "config.toml")}:stop:0:0`;
		await writeFile(
			join(managed, "config.toml"),
			stringify({
				profiles: {
					review: { hooks: { state: { [managedKey]: { trusted_hash: "sha256:confirmed" }, [projectKey]: {} } } },
				},
			}),
		);
		await prepareManagedCodexConversationStorageHome(original);
		expect(parse(await readFile(join(managed, "config.toml"), "utf8"))).toMatchObject({
			profiles: {
				review: { hooks: { state: { [managedKey]: { trusted_hash: "sha256:confirmed" }, [projectKey]: {} } } },
			},
		});
	});
	it("无法解析的目标信任状态保留现场，不覆盖成来源快照", async () => {
		const original = join(fixture.path, ".codex");
		await mkdir(original);
		await writeFile(join(original, "config.toml"), 'model="first"');
		const managed = await prepareManagedCodexConversationStorageHome(original);
		const invalidTargetConfiguration = 'model="keep"\n[hooks]\nstate="invalid"\n';
		await writeFile(join(managed, "config.toml"), invalidTargetConfiguration);
		await expect(prepareManagedCodexConversationStorageHome(original)).rejects.toThrow("有效的信任记录表");
		expect(await readFile(join(managed, "config.toml"), "utf8")).toBe(invalidTargetConfiguration);
	});
	it.for(["single_conflict", "continuous_conflicts"] as const)(
		"%s：并发原生确认自动补读，持续冲突有界退出且后续启动可恢复",
		async (conflictKind) => {
			const original = join(fixture.path, ".codex");
			await mkdir(original);
			await writeFile(join(original, "config.toml"), 'model="first"');
			const managed = await prepareManagedCodexConversationStorageHome(original);
			const managedConfigurationPath = join(managed, "config.toml");
			await writeFile(join(original, "config.toml"), 'model="second"');
			let conflicts = 0;
			snapshotWriteInterception.afterPendingSnapshotWrite = async () => {
				if (conflictKind === "single_conflict" && conflicts > 0) return;
				conflicts += 1;
				await writeFile(
					managedConfigurationPath,
					stringify({
						model: "first",
						hooks: { state: { "native-confirmation": { trusted_hash: `sha256:${conflicts}` } } },
					}),
				);
			};
			if (conflictKind === "continuous_conflicts") {
				await expect(prepareManagedCodexConversationStorageHome(original)).rejects.toThrow("持续被并发更新");
				expect(conflicts).toBe(3);
				expect(parse(await readFile(managedConfigurationPath, "utf8"))).toMatchObject({ model: "first" });
				expect((await readdir(managed)).filter((name) => name.endsWith(".pending-write"))).toEqual([]);
				snapshotWriteInterception.afterPendingSnapshotWrite = null;
				await prepareManagedCodexConversationStorageHome(original);
			} else {
				await prepareManagedCodexConversationStorageHome(original);
				expect(conflicts).toBe(1);
			}
			expect(parse(await readFile(managedConfigurationPath, "utf8"))).toMatchObject({
				model: "second",
				hooks: { state: { "native-confirmation": { trusted_hash: `sha256:${conflicts}` } } },
			});
		},
	);
	it("旧会话按已保存的转录目录续接，配置中的默认值变化不会把它移走", () => {
		expect(
			resolveRecordedCodexConversationHome({
				codexConversationStorageHomeDirectoryPath: "/outdated-before-native-fork",
				transcriptPath: join(fixture.path, "old-codex-home", "sessions", "2026", "rollout.jsonl"),
				environment: { CODEX_HOME: "new-default" },
			}),
		).toBe(join(fixture.path, "old-codex-home"));
		expect(
			resolveRecordedCodexConversationHome({
				environment: { CODEX_HOME: ".store" },
				workingDirectoryPath: fixture.path,
			}),
		).toBe(join(fixture.path, ".store"));
	});
	it("仅清理子进程的 App 来源变量，父进程环境保持原值", () => {
		vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "codex_work_desktop");
		const managed = getManagedCodexConversationStorageHomeDirectoryPath();
		const environment = buildCodexConversationStorageEnvironment(managed);
		expect(environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
		expect(environment.CODEX_SQLITE_HOME).toBe(managed);
		expect(buildCodexConversationStorageEnvironment("/legacy-home")).not.toHaveProperty("CODEX_SQLITE_HOME");
		expect(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe("codex_work_desktop");
	});
	it("专用目录若被软链回用户目录，拒绝启动且不改写用户配置", async () => {
		const original = join(fixture.path, ".codex");
		await mkdir(original);
		const configuration = 'model="original-preserved"';
		await writeFile(join(original, "config.toml"), configuration);
		const managed = getManagedCodexConversationStorageHomeDirectoryPath();
		await mkdir(join(managed, ".."), { recursive: true });
		await symlink(original, managed, "junction");
		await expect(prepareManagedCodexConversationStorageHome(original)).rejects.toThrow("是软链");
		expect(await readFile(join(original, "config.toml"), "utf8")).toBe(configuration);
	});
});
