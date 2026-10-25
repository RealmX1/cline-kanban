import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	configurationDigest,
	readCodexHookDefinitionDigest,
	setConfigurationField,
} from "../../../src/codex-configuration-sync/codex-configuration-field-projection";
import {
	type CodexConfigurationSyncService,
	createCodexConfigurationSyncService,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import { readCodexConfigurationSyncStore } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let storageHome: string;
let services: CodexConfigurationSyncService[];
const definition = { Stop: [{ hooks: [{ type: "command", command: "printf hook-definition" }] }] };
const pluginId = "example@fixture-marketplace";
beforeEach(async () => {
	fixture = createTempDir("codex-hook-source-observation-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	sourceHome = join(fixture.path, ".codex");
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), 'model="initial-model"\n');
	storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
	services = [];
});
afterEach(async () => {
	await Promise.all(services.map((instance) => instance.close()));
	vi.useRealTimers();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
interface HookSelection {
	fileName: string;
	keyPath: string[];
	sourceKey: string;
	definitionFilePath: string;
}
async function configureHookSource(kind: string): Promise<HookSelection> {
	const fileName = kind === "external_profile" ? "review.config.toml" : "config.toml";
	const tablePath = kind === "inline_profile" ? ["profiles", "review", "hooks"] : ["hooks"];
	const definitionFileName = kind === "user_file" ? "hooks.json" : fileName;
	const sourceKey =
		kind === "plugin" ? `${pluginId}:hooks/hooks.json:stop:0:0` : `${sourceHome}/${definitionFileName}:stop:0:0`;
	let definitionFilePath = join(sourceHome, definitionFileName);
	const configuration = fileName === "config.toml" ? parse(await readFile(join(sourceHome, fileName), "utf8")) : {};
	if (kind === "plugin") {
		const pluginRoot = join(sourceHome, "plugins", "cache", "fixture-marketplace", "example", "1.0.0");
		await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
		await mkdir(join(pluginRoot, "hooks"));
		await writeFile(
			join(pluginRoot, ".codex-plugin", "plugin.json"),
			JSON.stringify({ name: "example", version: "1.0.0" }),
		);
		definitionFilePath = join(pluginRoot, "hooks", "hooks.json");
		await writeFile(definitionFilePath, JSON.stringify({ hooks: definition }));
	} else if (kind === "user_file") await writeFile(definitionFilePath, JSON.stringify({ hooks: definition }));
	else setConfigurationField(configuration, tablePath, { value: definition });
	const keyPath = [...tablePath, "state", sourceKey];
	setConfigurationField(configuration, keyPath, { value: { enabled: true, trusted_hash: "initial-hash" } });
	await writeFile(join(sourceHome, fileName), stringify(configuration));
	return { fileName, keyPath, sourceKey, definitionFilePath };
}
const fieldKey = (selection: HookSelection) => JSON.stringify([selection.fileName, ...selection.keyPath]);
async function writer() {
	return prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		workspaceId: "fixture-workspace",
		conversationSessionId: randomUUID(),
		runtimeSessionIncarnationId: randomUUID(),
	});
}
async function decideHook(
	binding: CodexConfigurationWriterBinding,
	selection: HookSelection,
	decision: TomlTable | undefined,
) {
	const filePath = join(binding.configurationHomeDirectoryPath, selection.fileName);
	const configuration = parse(await readFile(filePath, "utf8"));
	const keys = selection.keyPath.map((key) =>
		key.replace(`${sourceHome}/`, `${binding.configurationHomeDirectoryPath}/`),
	);
	setConfigurationField(configuration, keys, decision === undefined ? undefined : { value: decision });
	await writeFile(filePath, stringify(configuration));
}
function service() {
	const instance = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
	services.push(instance);
	return instance;
}
describe("Codex hook 来源身份与未知定义的恢复", () => {
	it("原所有者版本夹取期间定义变为未知时不提交，恢复后沿用版本与来源门禁继续", async () => {
		const selection = await configureHookSource("user_file");
		const origin = await writer();
		const target = await writer();
		const nativeSessionId = randomUUID();
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: target.conversationSessionId,
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			agentId: "codex",
			workspacePath: fixture.path,
			pid: 100,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			runtimeSessionIncarnationId: target.runtimeSessionIncarnationId,
			codexConfigurationWriterBinding: target,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath: join(storageHome, "sessions", "target.jsonl"),
				observedAt: Date.now(),
			},
			codexNativeSessionControlEndpoint: {
				socketPath: join(fixture.path, "target-owner-socket"),
				workspaceId: "fixture-workspace",
				conversationSessionId: target.conversationSessionId,
				runtimeSessionIncarnationId: target.runtimeSessionIncarnationId,
			},
		});
		const definitionPath = join(target.configurationHomeDirectoryPath, "hooks.json");
		const configurationPath = join(target.configurationHomeDirectoryPath, "config.toml");
		let invalidateDefinitionDuringNextOwnerRead = true;
		let batchWriteCount = 0;
		const instance = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "fixture-workspace", summary }],
			onUpdated: () => {},
			withOwnerConnection: async (_summary, operation) =>
				operation({
					request: async (method, parameters) => {
						if (method === "thread/loaded/list") return { data: [nativeSessionId] };
						const text = await readFile(configurationPath, "utf8");
						if (method === "config/read") {
							if (invalidateDefinitionDuringNextOwnerRead) {
								invalidateDefinitionDuringNextOwnerRead = false;
								await writeFile(definitionPath, "{broken-json");
							}
							return {
								config: parse(text),
								layers: [
									{ name: { type: "user", file: configurationPath }, version: configurationDigest(text) },
								],
							};
						}
						if (method !== "config/batchWrite") throw new Error(`意外原生请求 ${method}`);
						batchWriteCount++;
						expect(parameters.expectedVersion).toBe(configurationDigest(text));
						const configuration = parse(text);
						for (const edit of parameters.edits as Array<{ keyPath: string; value: unknown }>) {
							const keys = [...edit.keyPath.matchAll(/"(?:\\.|[^"\\])*"/g)].map(
								([key]) => JSON.parse(key) as string,
							);
							setConfigurationField(
								configuration,
								keys,
								edit.value === null ? undefined : { value: edit.value },
							);
						}
						await writeFile(configurationPath, stringify(configuration));
						return { status: "ok", filePath: configurationPath, version: configurationDigest(configuration) };
					},
				}),
		});
		services.push(instance);
		await decideHook(origin, selection, { enabled: false });
		const change = (await instance.getState()).changes.find((item) => item.sourceWriterId === origin.writerId);
		if (!change) throw new Error("缺少测试中的 hook 变化");
		const unknown = await instance.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: "version-bound-definition-recovery",
			synchronizeExistingSessions: true,
		});
		expect(batchWriteCount).toBe(0);
		expect(unknown.observationProblem).toBeTruthy();
		expect(unknown.changes.find((item) => item.changeId === change.changeId)?.targets[0]).toMatchObject({
			status: "pending_reload",
			diskSavedAt: null,
			ownerReloadedAt: null,
		});
		await writeFile(definitionPath, JSON.stringify({ hooks: definition }));
		const recovered = await instance.getState();
		expect(recovered.observationProblem).toBeNull();
		expect(batchWriteCount).toBe(1);
		expect(recovered.changes).toHaveLength(1);
		expect(recovered.changes[0].targets[0]).toMatchObject({
			status: "pending_next_start",
			diskSavedAt: expect.any(Number),
		});
	});
	it("传播目标定义未知时保留待恢复状态，同一定义恢复后重置已耗尽的有界重试", async () => {
		const selection = await configureHookSource("user_file");
		const origin = await writer();
		const target = await writer();
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: target.conversationSessionId,
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			agentId: "codex",
			workspacePath: fixture.path,
			pid: 100,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			runtimeSessionIncarnationId: target.runtimeSessionIncarnationId,
			codexConfigurationWriterBinding: target,
			codexNativeSessionControlEndpoint: {
				socketPath: join(fixture.path, "target-owner-socket"),
				workspaceId: "fixture-workspace",
				conversationSessionId: target.conversationSessionId,
				runtimeSessionIncarnationId: target.runtimeSessionIncarnationId,
			},
		});
		let ownerConnectionAttempts = 0;
		const instance = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "fixture-workspace", summary }],
			onUpdated: () => {},
			withOwnerConnection: async () => {
				ownerConnectionAttempts++;
				throw new Error("原所有者暂不可达");
			},
		});
		services.push(instance);
		await decideHook(origin, selection, { enabled: false });
		const change = (await instance.getState()).changes.find((item) => item.sourceWriterId === origin.writerId);
		if (!change) throw new Error("缺少测试中的 hook 变化");
		await instance.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: "target-definition-recovery",
			synchronizeExistingSessions: true,
		});
		for (let index = 0; index < 4; index++) await instance.getState();
		expect(ownerConnectionAttempts).toBe(3);
		const path = join(target.configurationHomeDirectoryPath, "hooks.json");
		await writeFile(path, "{broken-json");
		const unknown = await instance.getState();
		expect(unknown.observationProblem).toBeTruthy();
		expect(unknown.changes.find((item) => item.changeId === change.changeId)?.targets[0]).toMatchObject({
			status: "pending_reload",
			attemptCount: 0,
		});
		expect(ownerConnectionAttempts).toBe(3);
		await writeFile(path, JSON.stringify({ hooks: definition }));
		const recovered = await instance.getState();
		expect(recovered.observationProblem).toBeNull();
		expect(ownerConnectionAttempts).toBeGreaterThan(3);
		expect(recovered.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe(
			"pending_reload",
		);
		const beforeDefinitionMismatch = ownerConnectionAttempts;
		await writeFile(
			path,
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "different-definition" }] }] } }),
		);
		const mismatch = await instance.getState();
		expect(mismatch.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe(
			"not_applicable",
		);
		expect(ownerConnectionAttempts).toBe(beforeDefinitionMismatch);
	});
	it.each(["user_file", "main_configuration", "inline_profile", "external_profile", "plugin"])(
		"%s 的禁用、撤销、删除与重新信任进入默认且供后续 writer 采用",
		async (kind) => {
			const selection = await configureHookSource(kind);
			const origin = await writer();
			const instance = service();
			const decisions: Array<TomlTable | undefined> = [
				{ enabled: false, trusted_hash: "initial-hash" },
				{ enabled: true },
				undefined,
				{ enabled: true, trusted_hash: "renewed-hash" },
			];
			for (const decision of decisions) {
				await decideHook(origin, selection, decision);
				expect((await instance.getState()).observationProblem).toBeNull();
				const stored = await readCodexConfigurationSyncStore();
				expect(stored.sources[origin.sourceIdentity].fields[fieldKey(selection)]?.value).toEqual(decision);
				expect(stored.changes.at(-1)?.fieldKey).toBe(fieldKey(selection));
				const future = await writer();
				const configuration = parse(
					await readFile(join(future.configurationHomeDirectoryPath, selection.fileName), "utf8"),
				);
				const keys = selection.keyPath.map((key) =>
					key.replace(`${sourceHome}/`, `${future.configurationHomeDirectoryPath}/`),
				);
				let value: unknown = configuration;
				for (const key of keys) value = (value as TomlTable | undefined)?.[key];
				expect(value).toEqual(decision);
			}
		},
	);
	it("来源 JSON 损坏时保留 hook 决定并继续吸收独立字段，恢复后清除问题", async () => {
		const selection = await configureHookSource("user_file");
		const origin = await writer();
		const instance = service();
		const initial = (await readCodexConfigurationSyncStore()).sources[origin.sourceIdentity].fields[
			fieldKey(selection)
		];
		await writeFile(selection.definitionFilePath, "{broken-json");
		const configuration = parse(await readFile(join(sourceHome, "config.toml"), "utf8"));
		configuration.model = "independently-updated-model";
		await writeFile(join(sourceHome, "config.toml"), stringify(configuration));
		expect((await instance.getState()).observationProblem).toBeTruthy();
		const stored = await readCodexConfigurationSyncStore();
		expect(stored.sources[origin.sourceIdentity].fields[fieldKey(selection)]).toEqual(initial);
		expect(stored.sources[origin.sourceIdentity].fields[JSON.stringify(["config.toml", "model"])].value).toBe(
			"independently-updated-model",
		);
		expect(stored.changes.filter((change) => change.fieldKey === fieldKey(selection))).toHaveLength(0);
		await writeFile(selection.definitionFilePath, JSON.stringify({ hooks: definition }));
		expect((await instance.getState()).observationProblem).toBeNull();
	});
	it.each(["missing", "broken_json"])(
		"writer 定义 %s 时不传播未知决定，周期补扫在恢复后吸收真实变化",
		async (failure) => {
			const selection = await configureHookSource("user_file");
			const origin = await writer();
			const instance = service();
			const path = join(origin.configurationHomeDirectoryPath, "hooks.json");
			const initial = (await readCodexConfigurationSyncStore()).sources[origin.sourceIdentity].fields[
				fieldKey(selection)
			];
			if (failure === "missing") await rm(path);
			else await writeFile(path, "{broken-json");
			await decideHook(origin, selection, { enabled: false });
			expect((await instance.getState()).observationProblem).toBeTruthy();
			let stored = await readCodexConfigurationSyncStore();
			expect(stored.sources[origin.sourceIdentity].fields[fieldKey(selection)]).toEqual(initial);
			expect(stored.writers[origin.writerId].lastObservedFields[fieldKey(selection)]).toEqual(initial);
			expect(stored.changes.filter((change) => change.fieldKey === fieldKey(selection))).toHaveLength(0);
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			instance.start();
			await instance.scan();
			await writeFile(path, JSON.stringify({ hooks: definition }));
			await vi.advanceTimersByTimeAsync(5_000);
			await instance.scan();
			stored = await readCodexConfigurationSyncStore();
			expect(stored.observationProblem).toBeNull();
			expect(stored.sources[origin.sourceIdentity].fields[fieldKey(selection)]?.value).toEqual({ enabled: false });
			expect(stored.changes.filter((change) => change.fieldKey === fieldKey(selection))).toHaveLength(1);
		},
	);
	it("插件安装来源有歧义时保留原决定，恢复后仍核对定义与路径归属", async () => {
		const selection = await configureHookSource("plugin");
		const origin = await writer();
		const initial = (await readCodexConfigurationSyncStore()).sources[origin.sourceIdentity].fields[
			fieldKey(selection)
		];
		expect(initial?.definitionDigest).toBeTruthy();
		const conflictingRoot = join(sourceHome, "plugins", "cache", "fixture-marketplace", "example", "2.0.0");
		await mkdir(conflictingRoot);
		const instance = service();
		expect((await instance.getState()).observationProblem).toBeTruthy();
		expect(
			(await readCodexConfigurationSyncStore()).sources[origin.sourceIdentity].fields[fieldKey(selection)],
		).toEqual(initial);
		await rm(conflictingRoot, { recursive: true });
		await writeFile(
			selection.definitionFilePath,
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "changed" }] }] } }),
		);
		expect(await readCodexHookDefinitionDigest(sourceHome, sourceHome, selection.sourceKey)).not.toBe(
			initial.definitionDigest,
		);
		expect(
			await readCodexHookDefinitionDigest(sourceHome, sourceHome, `${pluginId}:../../outside.json:stop:0:0`),
		).toBeUndefined();
		expect((await instance.getState()).observationProblem).toBeNull();
	});
});
