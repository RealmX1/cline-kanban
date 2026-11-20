import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
	prepareManagedCodexConversationStorageHome,
	resolveRecordedCodexConversationHome,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { prepareCodexPersistentDirectoryIdentity } from "../../../src/codex-conversation-storage/codex-persistent-directory-identity";
import {
	getLegacyCodexConfigurationDirectory,
	readLegacyCodexWriterResumeSettings,
} from "../../../src/codex-conversation-storage/legacy-codex-configuration-writer-binding";
import { preserveRetiredCodexWriterInputForSession } from "../../../src/codex-conversation-storage/legacy-codex-retained-terminal-input";
import type { legacyCodexConfigurationWriterBindingSchema } from "../../../src/core/legacy-codex-configuration-writer-binding-schema";
import { readWorkspacePromptLibrarySnapshot } from "../../../src/state/prompt-library-store";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let storageHomeDirectoryPath: string;
let lexicalConfigurationHomeDirectoryPath: string;
let binding: z.infer<typeof legacyCodexConfigurationWriterBindingSchema>;

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
	const writerId = randomUUID();
	const configurationHomeDirectoryPath = join(
		await realpath(linkedUserHomeDirectoryPath),
		".cline",
		"kanban",
		"codex-configuration-writer-bindings-and-sync",
		"writers",
		writerId,
		"configuration-home",
	);
	const physicalStorageHomeDirectoryPath = await realpath(storageHomeDirectoryPath);
	const storageDirectoryIdentity = await prepareCodexPersistentDirectoryIdentity(physicalStorageHomeDirectoryPath);
	binding = {
		schemaVersion: 1,
		purpose: "native_session",
		writerId,
		workspaceId: "fixture-workspace",
		conversationSessionId: "fixture-conversation",
		runtimeSessionIncarnationId: randomUUID(),
		configurationHomeDirectoryPath,
		conversationStorageHomeDirectoryPath: physicalStorageHomeDirectoryPath,
		sqliteHomeDirectoryPath: physicalStorageHomeDirectoryPath,
		sourceHomeDirectoryPath: await realpath(sourceHomeDirectoryPath),
		sourceIdentity: await prepareCodexPersistentDirectoryIdentity(sourceHomeDirectoryPath),
		storageDirectoryIdentity,
		sqliteDirectoryIdentity: storageDirectoryIdentity,
		createdAt: Date.now(),
	};
	await mkdir(configurationHomeDirectoryPath, { recursive: true });
	for (const directoryName of ["sessions", "archived_sessions", "thread-writer-locks"]) {
		await mkdir(join(physicalStorageHomeDirectoryPath, directoryName));
		await symlink(
			join(physicalStorageHomeDirectoryPath, directoryName),
			join(configurationHomeDirectoryPath, directoryName),
			"junction",
		);
	}
	await writeFile(join(dirname(configurationHomeDirectoryPath), "writer-binding.json"), JSON.stringify(binding));
	lexicalConfigurationHomeDirectoryPath = join(
		getLegacyCodexConfigurationDirectory(),
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
		).toBe(binding.conversationStorageHomeDirectoryPath);
	});

	it("只有 writers 目录形状而没有持久绑定的目录不取得桥接资格", async () => {
		const unboundConfigurationHomeDirectoryPath = join(
			getLegacyCodexConfigurationDirectory(),
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

it("续接旧 writer 前核对所属进程并保留明确模型和 SQLite，旧 untrusted 权限回落只读", async () => {
	await writeFile(
		join(lexicalConfigurationHomeDirectoryPath, "config.toml"),
		'model="retired-model"\nmodel_reasoning_effort="high"\napproval_policy="untrusted"\nsandbox_mode="danger-full-access"\n',
	);
	const request = {
		binding,
		workspaceId: binding.workspaceId ?? "",
		conversationSessionId: binding.conversationSessionId ?? "",
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId ?? undefined,
		storageHome: storageHomeDirectoryPath,
		preserveProfilePermissions: true,
	};
	await expect(readLegacyCodexWriterResumeSettings(request)).resolves.toEqual({
		model: "retired-model",
		reasoningEffort: "high",
		permissionArguments: [
			"--sandbox",
			"read-only",
			"--ask-for-approval",
			"on-request",
			"-c",
			'approvals_reviewer="user"',
		],
		sqliteHomeDirectoryPath: binding.sqliteHomeDirectoryPath,
		sqliteDirectoryIdentity: binding.sqliteDirectoryIdentity,
	});
	await expect(
		readLegacyCodexWriterResumeSettings({ ...request, runtimeSessionIncarnationId: randomUUID() }),
	).rejects.toThrow("旧 Codex 配置清单与会话或历史目录不符");
});

it("旧草稿只导出确定未提交的文字，重复续接保持唯一 Prompt 与旧字节", async () => {
	const request = {
		workspaceId: binding.workspaceId ?? "",
		taskId: "fixture-task",
		conversationSessionId: binding.conversationSessionId ?? "",
		nativeSessionId: randomUUID(),
	};
	const retainedInputs = join(
		getLegacyCodexConfigurationDirectory(),
		"retained-terminal-input-during-profile-adoption",
	);
	await mkdir(retainedInputs);
	const capturedDraftText = "保留的旧草稿\n";
	const original = JSON.stringify({
		schemaVersion: 1,
		...request,
		profileId: "retired-profile",
		status: "capturing",
		capturedDraftText,
		capturedDraftRestoreStatus: "pending",
		bytesBase64: "YQ==",
		updatedAtMs: 1,
		unknownHistoricalEvidence: true,
	});
	const retainedRecord = join(retainedInputs, `${randomUUID()}.json`);
	await writeFile(retainedRecord, original);
	await writeFile(
		join(retainedInputs, `${randomUUID()}.json`),
		JSON.stringify({
			...JSON.parse(original),
			capturedDraftText: "可能已提交",
			capturedDraftRestoreStatus: "submission_started",
		}),
	);
	await preserveRetiredCodexWriterInputForSession(request);
	await preserveRetiredCodexWriterInputForSession(request);
	const library = await readWorkspacePromptLibrarySnapshot(request.workspaceId);
	expect(library.taskScopedPromptsByTaskId[request.taskId]).toMatchObject([
		{ text: capturedDraftText, origin: "terminal_stash_from_retired_codex_configuration" },
	]);
	expect(await readFile(retainedRecord, "utf8")).toBe(original);
});
