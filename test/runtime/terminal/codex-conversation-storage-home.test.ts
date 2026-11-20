import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCodexConversationStorageEnvironment,
	getManagedCodexConversationStorageHomeDirectoryPath,
	prepareManagedCodexConversationStorageHome,
	resolveManagedCodexNativeConfigurationArguments,
	resolveVerifiedSeparateCodexSqliteHomeForAuxiliaryProcess,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { prepareCodexPersistentDirectoryIdentity } from "../../../src/codex-conversation-storage/codex-persistent-directory-identity";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(async () => {
	fixture = createTempDir("kanban-codex-storage-home-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("Codex 会话独立目录", () => {
	it("后续启动读取原生配置的最新内容，且不创建配置同步目录", async () => {
		const source = join(fixture.path, ".codex");
		await mkdir(source);
		await writeFile(join(source, "config.toml"), 'model="first"\n');
		const managed = await prepareManagedCodexConversationStorageHome(source);
		await writeFile(join(source, "config.toml"), 'model="second"\n');
		await expect(prepareManagedCodexConversationStorageHome(source)).resolves.toBe(managed);
		expect(await readFile(join(managed, "config.toml"), "utf8")).toBe('model="second"\n');
		await expect(lstat(join(dirname(managed), "codex-configuration-writer-bindings-and-sync"))).rejects.toMatchObject(
			{
				code: "ENOENT",
			},
		);
	});
	it("主配置和原生 profile 共享原文件并保留相对路径基址，SQLite 留在专用目录", async () => {
		const source = join(fixture.path, ".codex");
		await mkdir(join(source, "skills"), { recursive: true });
		const original = 'model_instructions_file="instructions.md"\nsqlite_home="/must-not-inherit"\n';
		await writeFile(join(source, "config.toml"), original);
		await writeFile(join(source, "review.config.toml"), '[agents."worker.role"]\nconfig_file="agents/worker.toml"\n');
		await writeFile(join(source, "instructions.md"), "用户说明");
		await mkdir(join(source, "agents"));
		await writeFile(join(source, "agents", "worker.toml"), 'model="worker-model"');
		await writeFile(join(source, "auth.json"), '{"synthetic":true}');
		const managed = await prepareManagedCodexConversationStorageHome(source);
		expect(await readlink(join(managed, "review.config.toml"))).toBe(join(source, "review.config.toml"));
		expect(await readlink(join(managed, "auth.json"))).toBe(join(source, "auth.json"));
		expect(await readlink(join(managed, "skills"))).toBe(join(source, "skills"));
		expect(await readlink(join(managed, "plugins"))).toBe(join(source, "plugins"));
		expect(await readlink(join(managed, ".tmp", "marketplaces"))).toBe(join(source, ".tmp", "marketplaces"));
		expect(await resolveManagedCodexNativeConfigurationArguments(managed, ["--profile", "review"])).toEqual([
			"-c",
			`sqlite_home="${managed}"`,
		]);
		expect(await readFile(join(managed, "instructions.md"), "utf8")).toBe("用户说明");
		expect(await readFile(join(managed, "agents", "worker.toml"), "utf8")).toBe('model="worker-model"');
		expect(buildCodexConversationStorageEnvironment(managed)).toMatchObject({
			CODEX_HOME: managed,
			CODEX_SQLITE_HOME: managed,
		});
		expect(await readFile(join(source, "config.toml"), "utf8")).toBe(original);
	});

	it("转换前保留旧快照，重试不重复归档，也不覆盖后来新增的普通配置文件", async () => {
		const source = join(fixture.path, ".codex");
		const managed = getManagedCodexConversationStorageHomeDirectoryPath();
		await mkdir(source);
		await mkdir(managed, { recursive: true });
		await writeFile(
			join(managed, "canonical-user-codex-home.json"),
			JSON.stringify({ sourceHomeDirectoryPath: source }),
		);
		await writeFile(join(source, "config.toml"), 'model="native"');
		await writeFile(join(managed, "config.toml"), 'model="unmerged"');
		await writeFile(join(managed, "retired.config.toml"), 'model="retired"');
		await mkdir(join(managed, ".tmp", "marketplaces"), { recursive: true });
		await writeFile(join(managed, ".tmp", "marketplaces", "fixture"), "旧原生 marketplace");
		await prepareManagedCodexConversationStorageHome(source);
		await prepareManagedCodexConversationStorageHome(source);
		const archiveDirectory = join(managed, "retired-configuration-snapshots");
		const archiveEntries = await readdir(archiveDirectory);
		expect(archiveEntries).toHaveLength(3);
		const retiredProfileArchive = archiveEntries.find((name) => name.endsWith("-retired.config.toml"));
		expect(await readFile(join(archiveDirectory, retiredProfileArchive ?? ""), "utf8")).toBe('model="retired"');
		await expect(lstat(join(managed, "retired.config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
		const archiveName = archiveEntries.find((name) => name.endsWith("-config.toml"));
		expect(await readFile(join(archiveDirectory, archiveName ?? ""), "utf8")).toBe('model="unmerged"');
		expect(await readFile(join(archiveDirectory, "native-marketplaces", "fixture"), "utf8")).toBe(
			"旧原生 marketplace",
		);
		await unlink(join(managed, "config.toml"));
		await writeFile(join(managed, "config.toml"), 'model="unexpected"');
		await expect(prepareManagedCodexConversationStorageHome(source)).rejects.toThrow(/归属不明/);
		expect(await readFile(join(managed, "config.toml"), "utf8")).toBe('model="unexpected"');
	});

	it("辅助进程只使用归属核验通过的独立 SQLite 目录", async () => {
		const sqliteHomeDirectoryPath = join(fixture.path, "sqlite");
		await mkdir(sqliteHomeDirectoryPath);
		const sqliteDirectoryIdentity = await prepareCodexPersistentDirectoryIdentity(sqliteHomeDirectoryPath);
		const binding = { sqliteHomeDirectoryPath, sqliteDirectoryIdentity };
		await expect(
			resolveVerifiedSeparateCodexSqliteHomeForAuxiliaryProcess(fixture.path, undefined),
		).resolves.toBeUndefined();
		await expect(
			resolveVerifiedSeparateCodexSqliteHomeForAuxiliaryProcess(sqliteHomeDirectoryPath, binding),
		).resolves.toBeUndefined();
		await expect(resolveVerifiedSeparateCodexSqliteHomeForAuxiliaryProcess(fixture.path, binding)).resolves.toBe(
			sqliteHomeDirectoryPath,
		);
		await expect(
			resolveVerifiedSeparateCodexSqliteHomeForAuxiliaryProcess(fixture.path, {
				...binding,
				sqliteDirectoryIdentity: "0".repeat(64),
			}),
		).rejects.toThrow(/绑定/);
	});

	it("用户目录软链被改指后拒绝绑定第二个账号", async () => {
		const source = join(fixture.path, ".codex");
		const original = join(fixture.path, "original-source");
		const replacement = join(fixture.path, "replacement-source");
		await mkdir(original);
		await mkdir(replacement);
		await symlink(original, source, "junction");
		await prepareManagedCodexConversationStorageHome(source);
		await unlink(source);
		await symlink(replacement, source, "junction");
		await expect(prepareManagedCodexConversationStorageHome(source)).rejects.toThrow(/不能混用账号/);
	});
});
