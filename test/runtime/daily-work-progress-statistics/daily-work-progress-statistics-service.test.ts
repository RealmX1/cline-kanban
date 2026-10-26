import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDailyWorkProgressStatisticsCollector,
	type DailyWorkProgressCollector,
} from "../../../src/daily-work-progress-statistics/daily-work-progress-statistics-collector";
import type { DailyWorkProgressFact } from "../../../src/daily-work-progress-statistics/daily-work-progress-statistics-projection";
import { createDailyWorkProgressStatisticsService } from "../../../src/daily-work-progress-statistics/daily-work-progress-statistics-service";
import {
	createEmptyDailyWorkProgressStatisticsStore,
	dailyWorkProgressStatisticsStoreSchema,
} from "../../../src/daily-work-progress-statistics/daily-work-progress-statistics-store";
import { createEmptyTaskUserPromptStatisticsCursor } from "../../../src/daily-work-progress-statistics/task-user-prompt-statistics-transcript-reader";
import {
	createDailyWorkProgressCollectionCostRecorder,
	type DailyWorkProgressCollectionCostWindow,
} from "../../../src/diagnostics/daily-work-progress-collection-cost-recorder";

const collectorWorkspaceReads = vi.hoisted(() => ({
	getWorkspaceDirectoryPath: vi.fn(),
	listWorkspaceIndexEntries: vi.fn(),
	loadPersistedWorkspaceSessionsById: vi.fn(),
	loadWorkspaceBoardById: vi.fn(),
}));
vi.mock("../../../src/state/workspace-state", () => collectorWorkspaceReads);
vi.mock(
	"../../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation",
	() => ({
		runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture: async (
			operation: (client: { listCommittedEvents: () => Promise<never[]> }) => Promise<void>,
		) => operation({ listCommittedEvents: async () => [] }),
	}),
);

const directories: string[] = [];
beforeEach(() => {
	vi.resetAllMocks();
	collectorWorkspaceReads.listWorkspaceIndexEntries.mockResolvedValue([
		{ workspaceId: "project", repoPath: "/isolated/project" },
	]);
	collectorWorkspaceReads.loadWorkspaceBoardById.mockResolvedValue({ columns: [] });
	collectorWorkspaceReads.loadPersistedWorkspaceSessionsById.mockResolvedValue({});
});
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("人工 prompt 历史覆盖证据", () => {
	const timestamp = Date.parse("2026-10-23T12:00:00Z");
	const request = { workspaceId: "project", dateKey: "2026-10-23", timeZone: "UTC" };
	it.each([false, true])("末批人工输入和发现轮次持久化稳定，独立回退为 %s", async (disabled) => {
		vi.stubEnv("KANBAN_DAILY_WORK_PROGRESS_CANONICAL_RECORD_PERSISTENCE_DISABLED", disabled ? "1" : undefined);
		const directory = await mkdtemp(join(tmpdir(), "daily-progress-persisted-fact-convergence-"));
		directories.push(directory);
		collectorWorkspaceReads.getWorkspaceDirectoryPath.mockReturnValue(directory);
		const transcriptPath = join(directory, "native.jsonl");
		await writeFile(
			transcriptPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: "native" } })}\n${JSON.stringify({
				type: "event_msg",
				timestamp: new Date(timestamp).toISOString(),
				payload: { type: "user_message", message: "最后一批确认的人工输入" },
			})}\n`,
		);
		collectorWorkspaceReads.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ cards: [{ id: "task", createdAt: timestamp - 1, title: "持久事实" }] }],
		});
		collectorWorkspaceReads.loadPersistedWorkspaceSessionsById.mockResolvedValue({
			task: {
				taskId: "task",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: "native",
					transcriptPath,
				},
			},
		});
		let observationTime = timestamp;
		const windows: DailyWorkProgressCollectionCostWindow[] = [];
		const recorder = createDailyWorkProgressCollectionCostRecorder({ writeWindow: (window) => windows.push(window) });
		const storageFilePath = join(directory, "statistics.json");
		const service = createDailyWorkProgressStatisticsService({
			storageFilePath,
			costRecorder: recorder,
			now: () => observationTime,
			warn: () => {},
			collect: createDailyWorkProgressStatisticsCollector({ now: () => observationTime }),
		});
		try {
			await service.getSummary(request);
			await appendFile(
				transcriptPath,
				`${JSON.stringify({
					type: "event_msg",
					timestamp: new Date(timestamp + 1_000).toISOString(),
					payload: { type: "user_message", message: "项目发现之间追加的最后一批人工输入" },
				})}\n`,
			);
			observationTime += 1_000;
			await service.refresh();
			const persisted = await readFile(storageFilePath, "utf8");
			const raw = JSON.parse(persisted);
			expect(Object.keys(raw.factsByEventId)).toHaveLength(2);
			if (!disabled)
				expect(raw.factsByEventId).toEqual(dailyWorkProgressStatisticsStoreSchema.parse(raw).factsByEventId);
			recorder.flush();
			for (let round = 0; round < 3; round++) {
				observationTime += 10_000;
				await service.refresh();
			}
			recorder.flush();
			expect(windows[1]?.stages.statistics_write?.writeOperations ?? 0).toBe(disabled ? 1 : 0);
			if (!disabled) expect(await readFile(storageFilePath, "utf8")).toBe(persisted);
		} finally {
			await service.close();
			vi.unstubAllEnvs();
		}
	});
	it("主会话交接给 peer 和接受水位补证不重复产生人工输入事实", async () => {
		const directory = await mkdtemp(join(tmpdir(), "daily-progress-main-peer-handover-"));
		directories.push(directory);
		collectorWorkspaceReads.getWorkspaceDirectoryPath.mockReturnValue(directory);
		const transcriptPath = join(directory, "native.jsonl");
		await writeFile(
			transcriptPath,
			`${[
				{ type: "session_meta", payload: { id: "native", thread_source: "user" } },
				{
					type: "event_msg",
					timestamp: new Date(timestamp).toISOString(),
					payload: { type: "user_message", message: "原生接受的需求" },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		let observationTime = timestamp;
		const collector = createDailyWorkProgressStatisticsCollector({ now: () => observationTime });
		const state = createEmptyDailyWorkProgressStatisticsStore(timestamp);
		const card = {
			id: "owning-task",
			createdAt: timestamp - 1,
			title: "交接后的同一任务",
			mainTaskConversationSessionId: "original-main",
		};
		const summary = {
			taskId: "original-main",
			taskConversationSessionMetadata: { workspaceTaskId: card.id },
			agentNativeConversationSessionIdentity: { sourceAgentId: "codex", nativeSessionId: "native", transcriptPath },
		};
		collectorWorkspaceReads.loadWorkspaceBoardById.mockResolvedValue({ columns: [{ cards: [card] }] });
		collectorWorkspaceReads.loadPersistedWorkspaceSessionsById.mockResolvedValue({ "original-main": summary });
		await collector(state);
		const before = Object.keys(state.factsByEventId);
		expect(before).toHaveLength(1);
		observationTime += 10_000;
		collectorWorkspaceReads.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ cards: [{ ...card, mainTaskConversationSessionId: "peer-main" }] }],
		});
		collectorWorkspaceReads.loadPersistedWorkspaceSessionsById.mockResolvedValue({
			"peer-main": {
				...summary,
				taskId: "peer-main",
				agentConversationPromptSubmissionAcceptance: {
					status: "accepted",
					eventId: "historical-acceptance-reconciliation",
					nativeSessionId: "native",
					attemptedAtMs: timestamp,
					confirmedAtMs: observationTime,
				},
			},
		});
		await collector(state);
		expect(Object.keys(state.factsByEventId)).toEqual(before);
		expect(Object.values(state.nativeSourcesByIdentityKey)[0]?.kanbanConversationSessionId).toBe("peer-main");
	});
	async function createCoverageService(collect: DailyWorkProgressCollector) {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-coverage-evidence-"));
		directories.push(directory);
		collectorWorkspaceReads.getWorkspaceDirectoryPath.mockReturnValue(directory);
		return createDailyWorkProgressStatisticsService({
			storageFilePath: join(directory, "statistics.json"),
			now: () => timestamp,
			warn: () => {},
			collect: async (state) => {
				state.ledgerCaughtUp = true;
				state.workspaceCaptureStartedAtEpochMs.project = Date.parse("2026-10-01T00:00:00Z");
				return collect(state);
			},
		});
	}
	const collectedProject = {
		projects: [{ workspaceId: "project", projectName: "隔离项目" }],
		liveFactEventIds: [],
		hasPendingHistoricalReads: false,
	};
	it.each([false, true])("空来源清单不能单独证明历史完整，发现完成状态为 %s", async (discovered) => {
		const service = await createCoverageService(async (state) => {
			state.workspacePromptSourceInventoryDiscoveryCompleted.project = discovered;
			state.factsByEventId.confirmed = {
				eventId: "confirmed",
				workspaceId: "project",
				taskId: "task",
				taskTitle: "已确认的输入",
				taskIncarnationCreatedAtEpochMs: 1,
				metric: "human_prompt",
				occurredAtEpochMs: timestamp,
			};
			return collectedProject;
		});
		try {
			const summary = await service.getSummary(request);
			expect(summary.metrics[2]?.sevenDayAverage).toBeNull();
			expect(summary.coverage.status).toBe("partial");
			expect(summary.coverage.warnings.length).toBeGreaterThan(0);
			expect(summary.achievements.filter((achievement) => achievement.metric === "human_prompt")).toEqual([]);
		} finally {
			await service.close();
		}
	});
	it.each([
		{ sourceAgentId: "codex", transcriptContents: "分身", expectedCoverage: "complete" },
		{ sourceAgentId: "codex", transcriptContents: "零活动", expectedCoverage: "complete" },
		{ sourceAgentId: "codex", transcriptContents: "不可识别", expectedCoverage: "partial" },
		{ sourceAgentId: "unsupported-agent", transcriptContents: "不支持", expectedCoverage: "partial" },
	])("有证据的 $transcriptContents 来源按实际状态决定覆盖", async (testCase) => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-source-classification-"));
		directories.push(directory);
		const transcriptPath = join(directory, "native-session.jsonl");
		await writeFile(
			transcriptPath,
			testCase.transcriptContents === "不可识别"
				? "无法识别的 JSON 记录\n"
				: `${JSON.stringify({
						type: "session_meta",
						payload: {
							id: "native-session",
							thread_source: testCase.transcriptContents === "分身" ? "subagent" : "user",
						},
					})}\n`,
		);
		const collector = createDailyWorkProgressStatisticsCollector({ now: () => timestamp });
		const service = await createCoverageService(async (state) => {
			state.nativeSourcesByIdentityKey.source = {
				workspaceId: "project",
				taskId: "task",
				taskTitle: "历史覆盖",
				taskIncarnationCreatedAtEpochMs: 1,
				sourceAgentId: testCase.sourceAgentId,
				nativeSessionId: "native-session",
				transcriptPath,
			};
			return collector(state);
		});
		try {
			const summary = await service.getSummary(request);
			expect(summary.coverage.status).toBe(testCase.expectedCoverage);
			expect(summary.metrics[2]?.value).toBe(0);
			expect(summary.metrics[2]?.sevenDayAverage).toBe(testCase.expectedCoverage === "complete" ? 0 : null);
		} finally {
			await service.close();
		}
	});
	it("发现成功但已启动卡片的会话缺失时告警，恢复后自动重新核验", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-restored-history-"));
		directories.push(directory);
		const transcriptPath = join(directory, "restored-native-session.jsonl");
		await writeFile(
			transcriptPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: "restored", thread_source: "user" } })}\n`,
		);
		collectorWorkspaceReads.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{
					cards: [
						{
							id: "started-task",
							title: "曾启动的任务",
							createdAt: 1,
							mostRecentlyLaunchedAgentSessionAgentId: "codex",
						},
					],
				},
			],
		});
		let now = timestamp;
		const collector = createDailyWorkProgressStatisticsCollector({ now: () => now });
		const service = await createCoverageService(collector);
		try {
			const missing = await service.getSummary(request);
			expect(missing.coverage.status).toBe("partial");
			expect(missing.coverage.warnings).toContain("部分已启动任务缺少可确认的原生转录");
			expect(missing.metrics[2]?.sevenDayAverage).toBeNull();
			collectorWorkspaceReads.loadPersistedWorkspaceSessionsById.mockResolvedValue({
				"started-task": {
					taskId: "started-task",
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: "restored",
						transcriptPath,
					},
				},
			});
			now += 10_000;
			await service.refresh();
			const restored = await service.getSummary(request);
			expect(restored.coverage.status).toBe("complete");
			expect(restored.metrics[2]?.sevenDayAverage).toBe(0);
		} finally {
			await service.close();
		}
	});
	it("明确排除证据的新到达会使缓存与版本失效，旧持久记录不能补造清单证据", async () => {
		let rejectedDescendantSession = false;
		const service = await createCoverageService(async (state) => {
			state.workspacePromptSourceInventoryDiscoveryCompleted.project = true;
			state.nativeSourcesByIdentityKey.source = {
				workspaceId: "project",
				taskId: "task",
				taskTitle: "排除证据",
				taskIncarnationCreatedAtEpochMs: 1,
				sourceAgentId: "codex",
				nativeSessionId: "native",
				transcriptPath: "/isolated/native.jsonl",
			};
			state.transcriptCursorsByIdentityKey.source = {
				...createEmptyTaskUserPromptStatisticsCursor(),
				rejectedDescendantSession,
			};
			return collectedProject;
		});
		try {
			const missing = await service.getSummary(request);
			expect(missing.metrics[2]?.sevenDayAverage).toBeNull();
			rejectedDescendantSession = true;
			await service.refresh();
			const excluded = await service.getSummary(request);
			expect(excluded.revision).toBeGreaterThan(missing.revision);
			expect(excluded.metrics[2]?.sevenDayAverage).toBe(0);
		} finally {
			await service.close();
		}
		const legacyStoreValue = createEmptyDailyWorkProgressStatisticsStore(timestamp);
		Reflect.deleteProperty(legacyStoreValue, "workspacePromptSourceInventoryDiscoveryCompleted");
		const oldState = dailyWorkProgressStatisticsStoreSchema.parse(legacyStoreValue);
		expect(oldState.workspacePromptSourceInventoryDiscoveryCompleted).toEqual({});
		oldState.nativeSourcesByIdentityKey.source = {
			workspaceId: "project",
			taskId: "task",
			taskTitle: "旧记录中的完整来源",
			taskIncarnationCreatedAtEpochMs: 1,
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath: "/isolated/native.jsonl",
		};
		oldState.transcriptCursorsByIdentityKey.source = {
			...createEmptyTaskUserPromptStatisticsCursor(),
			complete: true,
		};
		const legacyService = await createCoverageService(async (state) => {
			state.nativeSourcesByIdentityKey = oldState.nativeSourcesByIdentityKey;
			state.transcriptCursorsByIdentityKey = oldState.transcriptCursorsByIdentityKey;
			return collectedProject;
		});
		try {
			expect((await legacyService.getSummary(request)).metrics[2]?.sevenDayAverage).toBeNull();
		} finally {
			await legacyService.close();
		}
	});
});
describe("统计持久化与庆祝领取", () => {
	it("静默回填，实时新增触发庆祝，多个页面与重启只领取一次", async () => {
		const directory = await mkdtemp(join(tmpdir(), "daily-work-progress-statistics-test-"));
		directories.push(directory);
		const timestamp = Date.parse("2026-10-23T12:00:00Z");
		let entries: DailyWorkProgressFact[] = [];
		let live = false;
		const dependencies = {
			storageFilePath: join(directory, "statistics.json"),
			now: () => timestamp,
			warn: () => {},
			collect: async (state: { factsByEventId: Record<string, DailyWorkProgressFact> }) => {
				const newFactIds: string[] = [];
				for (const entry of entries)
					if (!state.factsByEventId[entry.eventId]) {
						state.factsByEventId[entry.eventId] = entry;
						if (live) newFactIds.push(entry.eventId);
					}
				return {
					projects: [{ workspaceId: "project", projectName: "隔离项目" }],
					liveFactEventIds: newFactIds,
					hasPendingHistoricalReads: false,
				};
			},
		};
		const service = createDailyWorkProgressStatisticsService(dependencies);
		const request = { workspaceId: null, dateKey: "2026-10-23", timeZone: "UTC" };
		await service.getSummary(request);
		entries = [
			{
				eventId: "validation",
				workspaceId: "project",
				taskId: "one",
				taskIncarnationCreatedAtEpochMs: 1,
				taskTitle: "任务一",
				metric: "entered_validation",
				occurredAtEpochMs: timestamp,
			},
		];
		await service.refresh();
		expect((await service.getSummary(request)).celebrationEligibleAchievementIds).toEqual([]);
		live = true;
		const validation = entries[0];
		if (!validation) throw new Error("缺少验证阶段事实");
		entries.push({ ...validation, eventId: "done", metric: "entered_done" });
		await service.refresh();
		const summary = await service.getSummary(request);
		expect(summary.celebrationEligibleAchievementIds).toHaveLength(1);
		const claim = { ...request, achievementIds: summary.celebrationEligibleAchievementIds };
		const claims = await Promise.all([service.claimCelebrations(claim), service.claimCelebrations(claim)]);
		expect(claims.flatMap((result) => result.achievements)).toHaveLength(1);
		await service.close();
		const resumed = createDailyWorkProgressStatisticsService(dependencies);
		expect((await resumed.getSummary(request)).metrics[1]?.value).toBe(1);
		expect((await resumed.claimCelebrations(claim)).achievements).toEqual([]);
		await resumed.close();
	});
	it("历史回填和实时输入同时到达时不把历史里程碑变成新庆祝", async () => {
		const directory = await mkdtemp(join(tmpdir(), "daily-work-progress-statistics-test-"));
		directories.push(directory);
		const timestamp = Date.parse("2026-10-23T12:00:00Z");
		let entries: DailyWorkProgressFact[] = [];
		let liveIds: string[] = [];
		const service = createDailyWorkProgressStatisticsService({
			storageFilePath: join(directory, "statistics.json"),
			now: () => timestamp,
			warn: () => {},
			collect: async (state) => {
				for (const entry of entries) state.factsByEventId[entry.eventId] = entry;
				return {
					projects: [{ workspaceId: "project", projectName: "项目" }],
					liveFactEventIds: liveIds,
					hasPendingHistoricalReads: false,
				};
			},
		});
		try {
			const request = { workspaceId: null, dateKey: "2026-10-23", timeZone: "UTC" };
			await service.getSummary(request);
			const entry = (index: number): DailyWorkProgressFact => ({
				eventId: String(index),
				workspaceId: "project",
				taskId: String(index),
				taskIncarnationCreatedAtEpochMs: 1,
				taskTitle: "任务",
				metric: "entered_done",
				occurredAtEpochMs: timestamp,
			});
			entries = [1, 2, 3, 4].map(entry);
			liveIds = ["4"];
			await service.refresh();
			expect((await service.getSummary(request)).celebrationEligibleAchievementIds).toEqual([]);
			entries.push(entry(5));
			liveIds = ["5"];
			await service.refresh();
			expect((await service.getSummary(request)).celebrationEligibleAchievementIds).toHaveLength(1);
		} finally {
			await service.close();
		}
	});
	it("持久文件损坏时明确报错，恢复后可继续读取且不覆盖坏文件", async () => {
		const directory = await mkdtemp(join(tmpdir(), "daily-work-progress-statistics-test-"));
		directories.push(directory);
		const storageFilePath = join(directory, "statistics.json");
		const service = createDailyWorkProgressStatisticsService({
			storageFilePath,
			warn: () => {},
			collect: async () => ({
				projects: [{ workspaceId: "project", projectName: "项目" }],
				liveFactEventIds: [],
				hasPendingHistoricalReads: false,
			}),
		});
		try {
			const request = { workspaceId: null, dateKey: "2026-10-23", timeZone: "UTC" };
			await service.getSummary(request);
			const original = await readFile(storageFilePath, "utf8");
			await writeFile(storageFilePath, "{不可解析的持久记录");
			await expect(service.refresh()).rejects.toThrow();
			await expect(service.getSummary(request)).rejects.toThrow();
			expect(await readFile(storageFilePath, "utf8")).toBe("{不可解析的持久记录");
			await writeFile(storageFilePath, original);
			await service.refresh();
			expect((await service.getSummary(request)).metrics[0]?.value).toBe(0);
		} finally {
			await service.close();
		}
	});
});
