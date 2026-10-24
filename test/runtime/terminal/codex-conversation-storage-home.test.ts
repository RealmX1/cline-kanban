import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
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

let fixture: ReturnType<typeof createTempDir>;
beforeEach(() => {
	fixture = createTempDir("kanban-codex-storage-home-");
	vi.stubEnv("HOME", fixture.path);
});
afterEach(() => {
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
