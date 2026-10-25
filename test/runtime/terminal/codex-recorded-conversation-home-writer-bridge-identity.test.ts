import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexConfigurationSyncDirectory } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	prepareManagedCodexConversationStorageHome,
	resolveRecordedCodexConversationHome,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let storageHomeDirectoryPath: string;
let lexicalConfigurationHomeDirectoryPath: string;
let binding: CodexConfigurationWriterBinding;

beforeEach(async () => {
	fixture = createTempDir("codex-recorded-history-bridge-identity-");
	fixture.path = await realpath(fixture.path);
	const physicalUserHomeDirectoryPath = join(fixture.path, "physical-user-home");
	const linkedUserHomeDirectoryPath = join(fixture.path, "linked-user-home");
	await mkdir(physicalUserHomeDirectoryPath);
	await symlink(physicalUserHomeDirectoryPath, linkedUserHomeDirectoryPath, "junction");
	vi.stubEnv("HOME", linkedUserHomeDirectoryPath);
	const sourceHomeDirectoryPath = join(linkedUserHomeDirectoryPath, ".codex");
	await mkdir(sourceHomeDirectoryPath);
	await writeFile(join(sourceHomeDirectoryPath, "config.toml"), 'model="fixture-model"\n');
	storageHomeDirectoryPath = await prepareManagedCodexConversationStorageHome(sourceHomeDirectoryPath);
	binding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: storageHomeDirectoryPath,
		workspaceId: "fixture-workspace",
		conversationSessionId: "fixture-conversation",
		runtimeSessionIncarnationId: randomUUID(),
	});
	lexicalConfigurationHomeDirectoryPath = join(
		getCodexConfigurationSyncDirectory(),
		"writers",
		binding.writerId,
		"configuration-home",
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

function recordedHomeInput(configurationHomeDirectoryPath = binding.configurationHomeDirectoryPath) {
	return {
		codexConversationStorageHomeDirectoryPath: storageHomeDirectoryPath,
		transcriptPath: join(configurationHomeDirectoryPath, "sessions", "2026", "rollout.jsonl"),
	};
}

describe("Codex 已记录历史 home 的 writer 桥接身份", () => {
	it.each(["sessions", "archived_sessions"])("HOME 软链下 %s 的物理配置路径仍归属原历史 home", (directoryName) => {
		expect(binding.configurationHomeDirectoryPath).not.toBe(lexicalConfigurationHomeDirectoryPath);
		expect(
			resolveRecordedCodexConversationHome({
				codexConversationStorageHomeDirectoryPath: storageHomeDirectoryPath,
				transcriptPath: join(binding.configurationHomeDirectoryPath, directoryName, "2026", "rollout.jsonl"),
			}),
		).toBe(storageHomeDirectoryPath);
	});

	it("同一物理配置目录的另一条软链别名也能核验原历史归属", async () => {
		const aliasedConfigurationHomeDirectoryPath = join(fixture.path, "configuration-home-alias");
		await symlink(binding.configurationHomeDirectoryPath, aliasedConfigurationHomeDirectoryPath, "junction");
		expect(resolveRecordedCodexConversationHome(recordedHomeInput(aliasedConfigurationHomeDirectoryPath))).toBe(
			storageHomeDirectoryPath,
		);
	});

	it("缺少 summary 历史字段时，通过持久绑定恢复原历史 home", () => {
		expect(
			resolveRecordedCodexConversationHome({
				transcriptPath: recordedHomeInput(lexicalConfigurationHomeDirectoryPath).transcriptPath,
			}),
		).toBe(storageHomeDirectoryPath);
	});

	it("只有 writers 目录形状而没有持久绑定的目录不取得桥接资格", async () => {
		const unboundConfigurationHomeDirectoryPath = join(
			getCodexConfigurationSyncDirectory(),
			"writers",
			randomUUID(),
			"configuration-home",
		);
		await mkdir(unboundConfigurationHomeDirectoryPath, { recursive: true });
		expect(() =>
			resolveRecordedCodexConversationHome(recordedHomeInput(unboundConfigurationHomeDirectoryPath)),
		).toThrow();
	});

	it("历史目录被替换后拒绝沿用旧目录身份", async () => {
		await rename(storageHomeDirectoryPath, `${storageHomeDirectoryPath}-preserved-original`);
		await mkdir(storageHomeDirectoryPath);
		expect(() =>
			resolveRecordedCodexConversationHome(recordedHomeInput(lexicalConfigurationHomeDirectoryPath)),
		).toThrow(/身份|归属/);
	});

	it("历史桥接被改指另一目录时拒绝继续使用原绑定", async () => {
		const unrelatedSessionsDirectoryPath = join(fixture.path, "unrelated-session-history");
		await mkdir(unrelatedSessionsDirectoryPath);
		const sessionsBridgePath = join(binding.configurationHomeDirectoryPath, "sessions");
		await unlink(sessionsBridgePath);
		await symlink(unrelatedSessionsDirectoryPath, sessionsBridgePath, "junction");
		expect(() =>
			resolveRecordedCodexConversationHome(recordedHomeInput(lexicalConfigurationHomeDirectoryPath)),
		).toThrow(/身份|归属|桥接/);
	});

	it("配置目录被替换为指向受管根之外的软链时拒绝历史桥接", async () => {
		const unrelatedConfigurationHomeDirectoryPath = join(fixture.path, "unrelated-configuration-home");
		await mkdir(unrelatedConfigurationHomeDirectoryPath);
		await rename(
			binding.configurationHomeDirectoryPath,
			`${binding.configurationHomeDirectoryPath}-preserved-original`,
		);
		await symlink(unrelatedConfigurationHomeDirectoryPath, binding.configurationHomeDirectoryPath, "junction");
		expect(() =>
			resolveRecordedCodexConversationHome(recordedHomeInput(lexicalConfigurationHomeDirectoryPath)),
		).toThrow(/身份|归属/);
	});

	it("保存的历史 home 与持久 writer 绑定不一致时拒绝借路径前缀改归属", async () => {
		const unrelatedHomeDirectoryPath = join(fixture.path, "unrelated-history-home");
		await mkdir(unrelatedHomeDirectoryPath);
		expect(() =>
			resolveRecordedCodexConversationHome({
				...recordedHomeInput(lexicalConfigurationHomeDirectoryPath),
				codexConversationStorageHomeDirectoryPath: unrelatedHomeDirectoryPath,
			}),
		).toThrow(/身份|归属/);
	});

	it("writer 清单中的目录身份不属于当前配置目录时拒绝桥接", async () => {
		const manifestPath = join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		await writeFile(manifestPath, JSON.stringify({ ...manifest, writerId: randomUUID() }));
		expect(() =>
			resolveRecordedCodexConversationHome(recordedHomeInput(lexicalConfigurationHomeDirectoryPath)),
		).toThrow(/身份|归属/);
	});

	it("受管根目录之外的同形目录仍按普通历史读取，不借内部清单改写归属", async () => {
		const unrelatedConfigurationHomeDirectoryPath = join(
			fixture.path,
			"writers",
			binding.writerId,
			"configuration-home",
		);
		await mkdir(unrelatedConfigurationHomeDirectoryPath, { recursive: true });
		await writeFile(
			join(dirname(unrelatedConfigurationHomeDirectoryPath), "writer-binding.json"),
			JSON.stringify({ ...binding, configurationHomeDirectoryPath: unrelatedConfigurationHomeDirectoryPath }),
		);
		expect(resolveRecordedCodexConversationHome(recordedHomeInput(unrelatedConfigurationHomeDirectoryPath))).toBe(
			unrelatedConfigurationHomeDirectoryPath,
		);
	});
});
