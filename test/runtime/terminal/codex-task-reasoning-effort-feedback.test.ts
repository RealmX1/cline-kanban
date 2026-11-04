import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateCodexConfigurationProfileFields } from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
const effortFieldKey = JSON.stringify(["config.toml", "model_reasoning_effort"]);
beforeEach(async () => {
	fixture = createTempDir("codex-task-reasoning-effort-");
	fixture.path = await realpath(fixture.path);
	sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	await mkdir(sourceHome);
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({ model: "fixture-model", model_reasoning_effort: "medium" }),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

const prepareWriter = (effort?: string, previousBinding?: CodexConfigurationWriterBinding, allowFeedback = true) =>
	prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		workspaceId: "effort-fixture",
		conversationSessionId: "abcde",
		runtimeSessionIncarnationId: randomUUID(),
		previousBinding,
		sessionReasoningEffortOverride: effort,
		allowTaskReasoningEffortFeedback: allowFeedback,
	});
async function successfulLaunchSummary(binding: CodexConfigurationWriterBinding, startedAtMs = Date.now()) {
	const writer = (await readCodexConfigurationSyncStore()).writers[binding.writerId];
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "abcde",
		agentId: "codex",
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		workspacePath: fixture.path,
		pid: 10,
		startedAt: startedAtMs,
		updatedAt: startedAtMs,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		codexConfigurationWriterBinding: binding,
		codexConfigurationProfileId: writer.codexConfigurationProfileId,
		codexTaskReasoningEffortFeedbackLaunch: writer.taskReasoningEffortFeedbackSelection
			? { selectionId: writer.taskReasoningEffortFeedbackSelection.selectionId, startedAtMs }
			: undefined,
	});
}

describe("任务创建时的 Codex effort 局部选择与反馈", () => {
	it("profile 未写 effort 且手选值等于模型原生默认档时不登记反馈", async () => {
		await writeFile(join(sourceHome, "config.toml"), stringify({ model: "fixture-model" }));
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			workspaceId: "effort-fixture",
			conversationSessionId: "abcde",
			runtimeSessionIncarnationId: randomUUID(),
			sessionReasoningEffortOverride: "high",
			allowTaskReasoningEffortFeedback: true,
			nativeDefaultReasoningEffort: "high",
		});
		const writer = (await readCodexConfigurationSyncStore()).writers[binding.writerId];
		expect(writer?.taskReasoningEffortFeedbackSelection).toBeUndefined();
		expect(writer?.taskReasoningEffortSelectionAtLaunch).toBe("high");
		const different = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			workspaceId: "effort-fixture",
			conversationSessionId: "abcde",
			runtimeSessionIncarnationId: randomUUID(),
			previousBinding: binding,
			sessionReasoningEffortOverride: "ultra",
			allowTaskReasoningEffortFeedback: true,
			nativeDefaultReasoningEffort: "high",
		});
		expect(
			(await readCodexConfigurationSyncStore()).writers[different.writerId]?.taskReasoningEffortFeedbackSelection
				?.effort,
		).toBe("ultra");
	});
	it("补登记前 profile 已明确更新 effort，不以旧启动选择重新覆盖新默认", async () => {
		const binding = await prepareWriter("ultra");
		const summary = await successfulLaunchSummary(binding);
		await mutateCodexConfigurationSyncStore((store) => {
			const profileId = store.writers[binding.writerId].codexConfigurationProfileId;
			if (!profileId) throw new Error("隔离 profile 缺失");
			updateCodexConfigurationProfileFields(store, profileId, { [effortFieldKey]: { value: "high" } });
		});
		const sync = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "effort-fixture", summary }],
			onUpdated: () => {},
		});
		try {
			await sync.scan();
			const store = await readCodexConfigurationSyncStore();
			expect(store.changes.filter((change) => change.taskReasoningEffortFeedbackSelectionId)).toHaveLength(0);
			expect(store.writers[binding.writerId].localExceptionOverrides?.reasoning_effort).toBeUndefined();
		} finally {
			await sync.close();
		}
	});
	it("登记时 writer 暂不可核验，恢复并重启服务后自动补齐且不延长期限", async () => {
		const binding = await prepareWriter("ultra");
		const summary = await successfulLaunchSummary(binding);
		const dependencies = { listSessions: () => [{ workspaceId: "effort-fixture", summary }], onUpdated: () => {} };
		const unavailableDirectory = `${binding.configurationHomeDirectoryPath}-temporarily-unavailable`;
		await rename(binding.configurationHomeDirectoryPath, unavailableDirectory);
		const unavailable = createCodexConfigurationSyncService(dependencies);
		try {
			await unavailable.scan();
			expect((await readCodexConfigurationSyncStore()).changes).toHaveLength(0);
		} finally {
			await unavailable.close();
			await rename(unavailableDirectory, binding.configurationHomeDirectoryPath);
		}
		const recovered = createCodexConfigurationSyncService(dependencies);
		try {
			await recovered.scan();
			const store = await readCodexConfigurationSyncStore();
			expect(store.changes).toHaveLength(1);
			expect(store.changes[0].feedbackExpiresAtMs).toBe(
				(summary.codexTaskReasoningEffortFeedbackLaunch?.startedAtMs ?? 0) + 600_000,
			);
		} finally {
			await recovered.close();
		}
	});
	it("默认模型独立选择 effort；准备或启动失败不登记，成功后重试与重启只登记一次", async () => {
		const binding = await prepareWriter("ultra");
		expect(parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8"))).toMatchObject({
			model: "fixture-model",
			model_reasoning_effort: "ultra",
		});
		let summary = await successfulLaunchSummary(binding);
		const listSessions = () => [{ workspaceId: "effort-fixture", summary }];
		const failed = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		await failed.scan();
		await failed.close();
		expect((await readCodexConfigurationSyncStore()).changes).toHaveLength(0);
		const sync = createCodexConfigurationSyncService({ listSessions, onUpdated: () => {} });
		await sync.scan();
		await sync.scan();
		await sync.close();
		let store = await readCodexConfigurationSyncStore();
		expect(store.changes).toHaveLength(1);
		const change = store.changes[0];
		expect(change).toMatchObject({
			previous: { value: "medium" },
			value: { value: "ultra" },
			approvalStatus: "pending",
			feedbackExpiresAtMs: (summary.codexTaskReasoningEffortFeedbackLaunch?.startedAtMs ?? 0) + 600_000,
		});
		const firstLaunchTime = summary.codexTaskReasoningEffortFeedbackLaunch?.startedAtMs;
		const resumed = await prepareWriter("ultra", binding);
		summary = await successfulLaunchSummary(resumed, firstLaunchTime);
		const restarted = createCodexConfigurationSyncService({ listSessions, onUpdated: () => {} });
		await restarted.scan();
		await restarted.close();
		store = await readCodexConfigurationSyncStore();
		expect(store.changes).toHaveLength(1);
		expect(store.changes[0].changeId).toBe(change.changeId);
		expect(store.changes[0].feedbackExpiresAtMs).toBe(change.feedbackExpiresAtMs);
	});

	it.each(["approve", "reject"] as const)("反馈 %s 后下一张任务按 profile 继承，局部值保留", async (action) => {
		const binding = await prepareWriter("max");
		const summary = await successfulLaunchSummary(binding);
		const sync = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "effort-fixture", summary }],
			onUpdated: () => {},
		});
		try {
			await sync.scan();
			const change = (await readCodexConfigurationSyncStore()).changes[0];
			const request = {
				action,
				items: [
					{
						entryKind: "settings_proposal" as const,
						changeId: change.changeId,
						expectedVersion: change.version,
						idempotencyKey: randomUUID(),
					},
				],
			};
			expect((await sync.batchAction(request)).results[0].status).toBe("applied");
			expect((await sync.batchAction(request)).results[0].status).toBe("replayed");
			const future = await prepareWriter();
			expect(
				parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8"))
					.model_reasoning_effort,
			).toBe(action === "approve" ? "max" : "medium");
			expect(
				parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8"))
					.model_reasoning_effort,
			).toBe("max");
		} finally {
			await sync.close();
		}
	});

	it("延迟补登记沿用首次成功启动期限，过期后不能反馈或重新提醒", async () => {
		const binding = await prepareWriter("ultra");
		const summary = await successfulLaunchSummary(binding, Date.now() - 601_000);
		const sync = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "effort-fixture", summary }],
			onUpdated: () => {},
		});
		try {
			await sync.scan();
			await sync.scan();
			const store = await readCodexConfigurationSyncStore();
			expect(store.changes).toHaveLength(1);
			expect(store.changes[0].approvalStatus).toBe("expired");
			expect(
				store.profiles[store.writers[binding.writerId].codexConfigurationProfileId ?? ""].fields[effortFieldKey]
					.value,
			).toBe("medium");
		} finally {
			await sync.close();
		}
	});

	it("沿用、与继承相同或侧会话不登记；任务清除覆盖后恢复 profile", async () => {
		for (const [effort, allow] of [
			[undefined, true],
			["medium", true],
			["ultra", false],
		] as const) {
			const binding = await prepareWriter(effort, undefined, allow);
			expect(
				(await readCodexConfigurationSyncStore()).writers[binding.writerId].taskReasoningEffortFeedbackSelection,
			).toBeUndefined();
		}
		const selected = await prepareWriter("ultra");
		const restored = await prepareWriter(undefined, selected);
		expect(
			parse(await readFile(join(restored.configurationHomeDirectoryPath, "config.toml"), "utf8"))
				.model_reasoning_effort,
		).toBe("medium");
	});

	it.each([undefined, "ultra"])("任务选择 %s 重启后保留会话内手动修改的 effort", async (effort) => {
		const selected = await prepareWriter(effort);
		const path = join(selected.configurationHomeDirectoryPath, "config.toml");
		await writeFile(path, stringify({ ...parse(await readFile(path, "utf8")), model_reasoning_effort: "high" }));
		const resumed = await prepareWriter(effort, selected);
		expect(
			parse(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8"))
				.model_reasoning_effort,
		).toBe("high");
	});
});
