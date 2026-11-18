import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type CodexConfigurationSyncService,
	createCodexConfigurationSyncService,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	closeCodexConfigurationSyncDatabase,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline } from "../../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { prepareCodexConfigurationRecoveryScaleFixture } from "../../utilities/prepare-codex-configuration-recovery-scale-fixture";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let service: CodexConfigurationSyncService | undefined;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-recovery-session-lookup-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", join(fixture.path, "isolated-source-home"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, "isolated-sqlite-home"));
	vi.stubEnv("KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT", join(fixture.path, "isolated-relations"));
});
afterEach(async () => {
	await service?.close();
	service = undefined;
	await closeCodexConfigurationSyncDatabase();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

it("1041 个历史会话、3878 个待启动目标的真实服务扫描保持线性读取并让出事件循环", async (context) => {
	const workspaceLocations = [
		{ workspaceId: "lookup-budget-workspace-0", workspacePath: fixture.path },
		{ workspaceId: "lookup-budget-workspace-1", workspacePath: fixture.path },
	];
	const { sessionCount, targetCount, sessionsByWorkspace } = await prepareCodexConfigurationRecoveryScaleFixture(
		workspaceLocations,
		join(fixture.path, "isolated-source-home"),
	);
	const managers = new Map(
		workspaceLocations.map(({ workspaceId }) => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord(sessionsByWorkspace[workspaceId]);
			return [workspaceId, manager];
		}),
	);
	let enumerationCount = 0;
	let enumeratedSummaryCloneCount = 0;
	let targetedLookupCount = 0;
	let targetedSummaryCloneCount = 0;
	let heartbeatCount = 0;
	let heartbeatCountDuringTargetLookups = 0;
	let mostRecentHeartbeatAt = performance.now();
	let maximumHeartbeatGapMs = 0;
	const targetLookupHeartbeatCounts: number[] = [];
	const dependencies = {
		listSessions: () => {
			enumerationCount++;
			const sessions = [...managers].flatMap(([workspaceId, manager]) =>
				manager.listSummaries().map((summary) => ({ workspaceId, summary })),
			);
			enumeratedSummaryCloneCount += sessions.length;
			return sessions;
		},
		getSessionSummary: (workspaceId: string, conversationSessionId: string): RuntimeTaskSessionSummary | null => {
			targetedLookupCount++;
			targetLookupHeartbeatCounts.push(heartbeatCount);
			const summary = managers.get(workspaceId)?.getSummary(conversationSessionId) ?? null;
			if (summary) targetedSummaryCloneCount++;
			return summary;
		},
		onUpdated: () => {},
		resumeSessionToAdoptProfile: vi.fn(),
	};
	service = createCodexConfigurationSyncService(dependencies);
	const heartbeat = setInterval(() => {
		const currentTime = performance.now();
		maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, currentTime - mostRecentHeartbeatAt);
		mostRecentHeartbeatAt = currentTime;
		heartbeatCount++;
	}, 1);
	const startedAt = performance.now();
	try {
		await service.scan();
		await yieldToEventLoop();
		maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, performance.now() - mostRecentHeartbeatAt);
	} finally {
		clearInterval(heartbeat);
	}
	const elapsedMs = performance.now() - startedAt;
	if (targetLookupHeartbeatCounts.length)
		heartbeatCountDuringTargetLookups =
			Math.max(...targetLookupHeartbeatCounts) - Math.min(...targetLookupHeartbeatCounts);
	const measurement = {
		variant: process.env.KANBAN_CONFIGURATION_RECOVERY_BENCHMARK_VARIANT ?? "candidate",
		sessionCount,
		targetCount,
		enumerationCount,
		enumeratedSummaryCloneCount,
		targetedLookupCount,
		targetedSummaryCloneCount,
		heartbeatCount,
		heartbeatCountDuringTargetLookups,
		maximumHeartbeatGapMs,
		elapsedMs,
	};
	const evidenceDirectory = process.env.KANBAN_CONFIGURATION_RECOVERY_BENCHMARK_EVIDENCE_DIRECTORY;
	if (evidenceDirectory) {
		await mkdir(evidenceDirectory, { recursive: true });
		await writeFile(join(evidenceDirectory, `${measurement.variant}.json`), JSON.stringify(measurement, null, 2));
	}
	expect(dependencies.resumeSessionToAdoptProfile).not.toHaveBeenCalled();
	const storedTargets = (await readCodexConfigurationSyncStore()).changes.find(
		(change) => change.changeId === "synthetic-pending-start-change",
	)?.targets;
	expect(storedTargets).toHaveLength(targetCount);
	expect(storedTargets?.every((target) => target.status === "pending_next_start" && target.attemptCount === 0)).toBe(
		true,
	);
	if (measurement.variant === "baseline") {
		expect(enumeratedSummaryCloneCount).toBeGreaterThanOrEqual(sessionCount * targetCount);
		return;
	}
	expect(enumerationCount).toBeLessThan(10);
	expect(enumeratedSummaryCloneCount).toBeLessThan(sessionCount * 10);
	expect(targetedLookupCount).toBeGreaterThanOrEqual(targetCount * 2);
	expect(targetedLookupCount).toBeLessThan(targetCount * 3);
	expect(heartbeatCountDuringTargetLookups).toBeGreaterThan(0);
	await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
		context,
		{
			waitedForDescription: "真实规模配置恢复期间的最大心跳间隔",
			softDeadlineMsExpectedOnUncontendedHost: 250,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 5000,
			strictAtSoftDeadlineWhenRunningInContinuousIntegration: true,
		},
		maximumHeartbeatGapMs,
	);
}, 60_000);

it("1041 个摘要与 337 个待重载目标仅定向观察当前 writer，pending 绑定也不枚举历史", async (context) => {
	const workspaceId = "lookup-budget-workspace-0";
	const { sessionsByWorkspace, sessionCount } = await prepareCodexConfigurationRecoveryScaleFixture(
		[{ workspaceId, workspacePath: fixture.path }],
		join(fixture.path, "isolated-source-home"),
	);
	const initialStore = await readCodexConfigurationSyncStore();
	const binding = Object.values(initialStore.writers)[0].binding;
	const pendingReloadTargetCount = 337;
	const profileBindingObserved = vi.fn();
	const summaries = sessionsByWorkspace[workspaceId];
	const conversationSessionId = binding.conversationSessionId ?? "historical-session-0";
	summaries[conversationSessionId] = runtimeTaskSessionSummarySchema.parse({
		...summaries[conversationSessionId],
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		codexConfigurationWriterBinding: binding,
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "synthetic-native-session",
			transcriptPath: join(fixture.path, "isolated-native-transcript.jsonl"),
			observedAt: 1,
		},
		codexNativeSessionControlEndpoint: {
			workspaceId,
			conversationSessionId,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			socketPath: join(fixture.path, "isolated-missing-owner-socket"),
		},
	});
	const manager = new TerminalSessionManager();
	manager.hydrateFromRecord(summaries);
	await mutateCodexConfigurationSyncStore((store) => {
		const writer = store.writers[binding.writerId];
		delete writer.retiredAt;
		if (!writer.codexConfigurationProfileId) throw new Error("缺少真实规模 writer 的 profile");
		writer.pendingSessionProfileBinding = {
			workspaceId,
			conversationSessionId,
			profileId: writer.codexConfigurationProfileId,
		};
		for (let index = 0; index < pendingReloadTargetCount; index++)
			store.changes.push({
				changeId: `synthetic-owner-reload-${index}`,
				version: index + 1,
				sourceWriterId: binding.writerId,
				sourceIdentity: binding.sourceIdentity,
				fieldKey: JSON.stringify(["config.toml", "model"]),
				value: { value: "synthetic-model" },
				observedAt: 1,
				recordKind: "settings_proposal",
				approvalStatus: "approved",
				mergeStatus: "shared_default_updated",
				acknowledgedAt: null,
				targets: [
					{
						writerId: binding.writerId,
						workspaceId,
						conversationSessionId,
						status: "pending_reload",
						reason: "合成失联重载目标",
						recoveryCondition: "原所有者端点恢复",
						acceptedAt: 1,
						diskSavedAt: null,
						ownerReloadedAt: null,
						attemptCount: 0,
					},
				],
			});
	});
	let enumerationCount = 0;
	let targetedLookupCount = 0;
	let persistedSessionParseCount = 0;
	const ownerRequests = vi.fn(async () => {
		throw new Error("合成原所有者暂不可达");
	});
	service = createCodexConfigurationSyncService({
		readTaskSourceContext: async () => {
			persistedSessionParseCount += Object.keys(summaries).length;
			return { writerTasks: {}, taskLinks: {} };
		},
		listSessions: () => {
			enumerationCount++;
			return manager.listSummaries().map((summary) => ({ workspaceId, summary }));
		},
		getSessionSummary: (requestedWorkspaceId, requestedSessionId) => {
			targetedLookupCount++;
			return requestedWorkspaceId === workspaceId ? manager.getSummary(requestedSessionId) : null;
		},
		onUpdated: () => {},
		onSessionProfileBound: profileBindingObserved,
		withOwnerConnection: ownerRequests,
	});
	let mostRecentHeartbeatAt = performance.now();
	let maximumHeartbeatGapMs = 0;
	const heartbeat = setInterval(() => {
		const currentTime = performance.now();
		maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, currentTime - mostRecentHeartbeatAt);
		mostRecentHeartbeatAt = currentTime;
	}, 1);
	const startedAt = performance.now();
	try {
		await service.scan();
	} finally {
		clearInterval(heartbeat);
	}
	const elapsedMs = performance.now() - startedAt;
	const observation = {
		sessionCount,
		pendingReloadTargetCount,
		enumerationCount,
		targetedLookupCount,
		persistedSessionParseCount,
		maximumHeartbeatGapMs,
		elapsedMs,
		ownerRequests: ownerRequests.mock.calls.length,
	};
	const evidenceDirectory = process.env.KANBAN_CONFIGURATION_RECOVERY_BENCHMARK_EVIDENCE_DIRECTORY;
	if (evidenceDirectory) {
		await mkdir(evidenceDirectory, { recursive: true });
		await writeFile(
			join(evidenceDirectory, "pending-reload-and-profile-binding.json"),
			JSON.stringify(observation, null, 2),
		);
	}
	expect(enumerationCount).toBeLessThanOrEqual(4);
	expect(persistedSessionParseCount).toBe(sessionCount);
	expect(ownerRequests).toHaveBeenCalledTimes(pendingReloadTargetCount);
	expect(profileBindingObserved).toHaveBeenCalledTimes(1);
	const stored = await readCodexConfigurationSyncStore();
	expect(stored.writers[binding.writerId].pendingSessionProfileBinding).toBeUndefined();
	expect(stored.changes.filter((change) => change.changeId.startsWith("synthetic-owner-reload-"))).toHaveLength(
		pendingReloadTargetCount,
	);
	expect(
		stored.changes
			.filter((change) => change.changeId.startsWith("synthetic-owner-reload-"))
			.every((change) => change.targets[0].status === "pending_reload" && change.targets[0].attemptCount === 1),
	).toBe(true);
	await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
		context,
		{
			waitedForDescription: "真实规模失联重载恢复期间最大心跳间隔",
			softDeadlineMsExpectedOnUncontendedHost: 500,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 5000,
			strictAtSoftDeadlineWhenRunningInContinuousIntegration: true,
		},
		maximumHeartbeatGapMs,
	);
}, 120_000);
