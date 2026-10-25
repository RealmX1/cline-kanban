import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { expect, it, vi } from "vitest";
import { type RuntimeBoardData, runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	withTaskMessageInjectionLedgerLock,
} from "../../src/core/task-message-injection-ledger";
import { createDailyWorkProgressStatisticsCollector } from "../../src/daily-work-progress-statistics/daily-work-progress-statistics-collector";
import { createDailyWorkProgressStatisticsService } from "../../src/daily-work-progress-statistics/daily-work-progress-statistics-service";
import { createEmptyDailyWorkProgressStatisticsStore } from "../../src/daily-work-progress-statistics/daily-work-progress-statistics-store";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	getWorkspaceDirectoryPath,
	loadWorkspaceContext,
	mutateWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { type RuntimeAppRouter, type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

it("程序化回执按任务卡与实际目标会话过滤，同文人工输入及其它会话仍计数", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	try {
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "programmatic-prompt-targets" });
		await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: { columns: [{ id: "backlog", title: "Backlog", cards: [] }] },
			sessions: {},
		});
		const workspace = await loadWorkspaceContext(repository.repositoryPath);
		const timestamp = Date.parse("2026-10-23T12:00:00Z");
		const prompt = "继续执行已授权步骤";
		const state = createEmptyDailyWorkProgressStatisticsStore(timestamp);
		const targets = [
			{ taskId: "owning-card", sessionId: "collaboration-session", expectedCount: 1 },
			{ taskId: "owning-card", sessionId: "independent-main-session", expectedCount: 1 },
			{ taskId: "owning-card", sessionId: "other-session", expectedCount: 2 },
			{ taskId: "legacy-card", sessionId: "legacy-card", expectedCount: 1 },
			{ taskId: "different-card", sessionId: "collaboration-session", expectedCount: 2 },
		];
		for (const [index, target] of targets.entries()) {
			const nativeSessionId = `native-session-${index}`;
			const transcriptPath = join(fixture.isolatedHomeDirectoryPath, `${nativeSessionId}.jsonl`);
			await writeFile(
				transcriptPath,
				`${[timestamp, timestamp + 60_000]
					.map((submittedAt) =>
						JSON.stringify({
							type: "event_msg",
							id: `${nativeSessionId}:${submittedAt}`,
							timestamp: new Date(submittedAt).toISOString(),
							payload: { type: "user_message", message: prompt },
						}),
					)
					.join("\n")}\n`,
			);
			state.nativeSourcesByIdentityKey[JSON.stringify([workspace.workspaceId, "codex", nativeSessionId])] = {
				workspaceId: workspace.workspaceId,
				taskId: target.taskId,
				taskTitle: "投递目标验证",
				taskIncarnationCreatedAtEpochMs: timestamp - 1_000,
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath,
				kanbanConversationSessionId: target.sessionId,
			};
		}
		const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspace.workspaceId));
		await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({
			records: targets
				.filter((target) => target.sessionId !== "other-session" && target.taskId !== "different-card")
				.map((target) => ({
					...createPendingTaskMessageInjectionRecord({
						taskId: target.taskId,
						...(target.taskId !== "legacy-card" ? { attemptId: target.sessionId } : {}),
						source: "automated-test",
						idempotencyKey: target.sessionId,
						promptSha256: createHash("sha256").update(prompt).digest("hex"),
						nowIso: new Date(timestamp).toISOString(),
					}),
					terminal_delivery_status: "delivered_and_submit_confirmed" as const,
				})),
			result: null,
		}));
		await createDailyWorkProgressStatisticsCollector({ now: () => timestamp + 120_000 })(state);
		for (const [index, target] of targets.entries()) {
			const transcriptPath = join(fixture.isolatedHomeDirectoryPath, `native-session-${index}.jsonl`);
			const cursorKey = JSON.stringify([workspace.workspaceId, "codex", `native-session-${index}`]);
			expect(state.transcriptCursorsByIdentityKey[cursorKey]?.firstPromptAtEpochMs).toBe(
				timestamp + (target.expectedCount === 1 ? 60_000 : 0),
			);
			expect(
				Object.values(state.factsByEventId).filter(
					(fact) => "transcriptPath" in fact && fact.transcriptPath === transcriptPath,
				),
			).toHaveLength(target.expectedCount);
		}
	} finally {
		vi.unstubAllEnvs();
		fixture.cleanup();
	}
});

it("隔离 HTTP、真实移列账本与原生转录贯通，重复流转及重启不重复统计或庆祝", { timeout: 60_000 }, async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	try {
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "daily-work-progress-runtime" });
		const transcriptDirectory = join(fixture.isolatedHomeDirectoryPath, "confirmed-native-transcripts");
		await mkdir(transcriptDirectory, { recursive: true });
		const transcriptPath = join(transcriptDirectory, "confirmed-native-session.jsonl");
		const start = Date.now();
		const initialPrompt = "隔离环境中的真实人工需求";
		const promptRecord = (text: string, timestamp: number) =>
			JSON.stringify({
				type: "event_msg",
				timestamp: new Date(timestamp).toISOString(),
				payload: { type: "user_message", message: text },
			});
		await writeFile(
			transcriptPath,
			`${JSON.stringify({ type: "session_meta", timestamp: new Date(start - 2_000).toISOString(), payload: { id: "statistics-native-session", source: "cli", thread_source: "user" } })}\n${promptRecord(initialPrompt, start - 1_000)}\n`,
		);
		const card = {
			id: "m0t11",
			title: "可回看的隔离任务成果",
			prompt: "统计测试",
			createdAt: start - 10_000,
			updatedAt: start,
			baseRef: "main",
			startInPlanMode: false,
		};
		const board: RuntimeBoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [card] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		};
		await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board,
			sessions: {
				[card.id]: runtimeTaskSessionSummarySchema.parse({
					taskId: card.id,
					workspacePath: repository.repositoryPath,
					state: "idle",
					turnOwner: null,
					liveness: "none",
					userTurnKind: null,
					agentId: "codex",
					pid: null,
					startedAt: start,
					updatedAt: start,
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: "statistics-native-session",
						transcriptPath,
						observedAt: start,
					},
				}),
			},
		});
		const workspace = await loadWorkspaceContext(repository.repositoryPath);
		const capture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
		const storageFilePath = join(
			fixture.isolatedHomeDirectoryPath,
			"daily-work-progress-statistics",
			"statistics.json",
		);
		const revisions: number[] = [];
		const dependencies = () => ({
			storageFilePath,
			collect: createDailyWorkProgressStatisticsCollector(),
			onUpdated: (revision: number) => revisions.push(revision),
			warn: () => {},
		});
		let service = createDailyWorkProgressStatisticsService(dependencies());
		const server = createServer(
			createHTTPHandler({
				basePath: "/api/trpc/",
				router: runtimeAppRouter,
				createContext: () =>
					({
						dailyWorkProgressStatisticsApi: {
							getSummary: service.getSummary,
							claimCelebrations: service.claimCelebrations,
						},
						kanbanRequestOriginActorEvidence: {
							decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
						},
					}) as RuntimeTrpcContext,
			}),
		);
		try {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("隔离 HTTP 没有分配端口");
			const client = createTRPCProxyClient<RuntimeAppRouter>({
				links: [httpBatchLink({ url: `http://127.0.0.1:${address.port}/api/trpc` })],
			});
			const request = {
				workspaceId: workspace.workspaceId,
				dateKey: new Date(start).toISOString().slice(0, 10),
				timeZone: "UTC",
			};
			const first = await client.dailyWorkProgressStatistics.getSummary.query(request);
			expect(first.metrics.map((metric) => metric.value)).toEqual([0, 0, 1]);
			expect(first.celebrationEligibleAchievementIds).toEqual([]);
			const move = async (target: string) => {
				await mutateWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: {
						columns: state.board.columns.map((column) => ({
							...column,
							cards:
								column.id === target ? [card] : column.cards.filter((candidate) => candidate.id !== card.id),
						})),
					},
					value: null,
				}));
				await service.refresh();
			};
			await move("validation");
			await move("review");
			await move("validation");
			await move("trash");
			await appendFile(transcriptPath, `${promptRecord("新的人工指令", Date.now())}\n`);
			await service.refresh();
			const updated = await client.dailyWorkProgressStatistics.getSummary.query(request);
			expect(updated.metrics.map((metric) => metric.value)).toEqual([1, 1, 2]);
			expect(updated.recentAccomplishments[0]?.taskTitle).toBe(card.title);
			expect(updated.celebrationEligibleAchievementIds.length).toBeGreaterThan(0);
			const claim = { ...request, achievementIds: updated.celebrationEligibleAchievementIds };
			const claimed = await Promise.all([
				client.dailyWorkProgressStatistics.claimCelebrations.mutate(claim),
				client.dailyWorkProgressStatistics.claimCelebrations.mutate(claim),
			]);
			expect(claimed.flatMap((result) => result.achievements).length).toBe(
				updated.celebrationEligibleAchievementIds.length,
			);
			expect(revisions.length).toBeGreaterThan(1);
			expect(await readFile(storageFilePath, "utf8")).not.toContain(initialPrompt);
			await service.close();
			service = createDailyWorkProgressStatisticsService(dependencies());
			const restored = await client.dailyWorkProgressStatistics.getSummary.query(request);
			expect(restored.metrics.map((metric) => metric.value)).toEqual([1, 1, 2]);
			expect((await client.dailyWorkProgressStatistics.claimCelebrations.mutate(claim)).achievements).toEqual([]);
		} finally {
			await service.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await capture.deactivate();
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		}
	} finally {
		vi.unstubAllEnvs();
		fixture.cleanup();
	}
});
