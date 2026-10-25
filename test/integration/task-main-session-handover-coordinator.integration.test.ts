import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AcpTaskSessionService } from "../../src/acp-client-session/acp-task-session-service";
import { loadRuntimeConfig } from "../../src/config/runtime-config";
import {
	type RuntimeBoardData,
	type RuntimeTaskChatSendRequest,
	type RuntimeTaskChatSendResponse,
	type RuntimeTaskSessionStartRequest,
	type RuntimeTaskSessionStartResponse,
	type RuntimeTaskSessionSummary,
	runtimeTaskSessionSummarySchema,
} from "../../src/core/api-contract";
import { mergeSummaryWithFacets, resolveSessionFacets } from "../../src/core/session-activity";
import { taskMainSessionHandoverRequestSchema } from "../../src/core/task-main-session-handover-contract";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../../src/core/task-message-injection-ledger";
import type {
	prepareCodexMainSessionHandoverNativeFork,
	prepareCodexMainSessionHandoverRecoveryNativeFork,
} from "../../src/server/codex-main-session-handover-native-fork";
import {
	createTaskMainSessionHandoverCoordinator,
	renderTaskMainSessionHandoverReportPrompt,
} from "../../src/server/task-main-session-handover-coordinator";
import type { prepareTaskMainSessionHandoverTranscriptNativeFork } from "../../src/server/task-main-session-handover-native-fork";
import type { queryCodexMainSessionHandoverReportAcceptance } from "../../src/server/task-main-session-handover-report-acceptance";
import { captureTaskMainSessionHandoverReportNativeIdentity } from "../../src/state/capture-task-main-session-handover-report-native-identity";
import { completeTaskMainSessionHandoverAfterUserMessage } from "../../src/state/complete-task-main-session-handover-after-user-message";
import { confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks } from "../../src/state/confirm-task-main-session-handover-input-after-correlated-processing-hooks";
import {
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
	savePersistedWorkspaceSessionsById,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import * as commandDiscovery from "../../src/terminal/command-discovery";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";
import type { RuntimeTrpcWorkspaceScope } from "../../src/trpc/app-router";
import { createRuntimeApi } from "../../src/trpc/runtime-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { createWorkspaceApi } from "../../src/trpc/workspace-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

describe.sequential("主会话交接的持久控制与会话身份", () => {
	async function fixture(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
		const root = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		process.env.HOME = root.isolatedHomeDirectoryPath;
		process.env.USERPROFILE = root.isolatedHomeDirectoryPath;
		let context: Awaited<ReturnType<typeof setup>> | undefined;
		try {
			context = await setup(root);
			await run(context);
		} finally {
			if (context) for (const coordinator of context.coordinators) await coordinator.close();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousProfile;
			root.cleanup();
		}
	}
	async function setup(root: ReturnType<typeof createIsolatedGitTestWorkspaceFixture>) {
		const repositoryPath = join(root.ownedIntegrationProjectsDirectoryPath, "handover-project");
		mkdirSync(repositoryPath, { recursive: true });
		const repository = root.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
		writeFileSync(join(repositoryPath, "implementation.txt"), "已经实现的内容\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "交接基线",
			authorAndCommitterIsoDate: "2026-10-18T00:00:00Z",
		});
		const planDirectory = join(repositoryPath, ".plan");
		mkdirSync(planDirectory, { recursive: true });
		const planPath = join(planDirectory, "approved-capability.md");
		writeFileSync(planPath, "计划：实现能力并验证\n");
		const transcriptPath = join(root.isolatedHomeDirectoryPath, "claude-task-history.jsonl");
		writeFileSync(
			transcriptPath,
			[
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: `已完成第一部分，计划位于 ${planPath}` }] },
				}),
				"",
			].join("\n"),
		);
		const source = runtimeTaskSessionSummarySchema.parse({
			taskId: "task-1",
			state: "awaiting_review",
			agentId: "claude",
			workspacePath: repositoryPath,
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: 1,
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "11111111-1111-4111-8111-111111111111",
				transcriptPath,
				observedAt: 1,
			},
		});
		const live: Record<string, RuntimeTaskSessionSummary> = { "task-1": source };
		const board: RuntimeBoardData = {
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task-1",
							title: "旧 Claude 任务",
							prompt: `完成计划 ${planPath}`,
							baseRef: "main",
							startInPlanMode: false,
							taskAgentPermissionMode: "bypass_all_permission_prompts",
							autoReviewEnabled: true,
							worktreeMode: "inplace",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
		};
		await loadWorkspaceContext(repositoryPath);
		await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, { board, sessions: live });
		const scope = {
			workspaceId: (await loadWorkspaceContext(repositoryPath)).workspaceId,
			workspacePath: repositoryPath,
		};
		const liveProcessSessionIds = new Set<string>();
		const manager = {
			hasLiveTaskSession: vi.fn((id: string) => liveProcessSessionIds.has(id)),
			hydrateFromRecord: (summaries: Record<string, RuntimeTaskSessionSummary>) => Object.assign(live, summaries),
			listSummaries: () => Object.values(live),
			getSummary: (id: string) => live[id] ?? null,
			applyTaskConversationSessionMetadata: (
				id: string,
				metadata: RuntimeTaskSessionSummary["taskConversationSessionMetadata"],
			) => {
				if (live[id]) live[id] = { ...live[id], taskConversationSessionMetadata: metadata };
				return live[id] ?? null;
			},
			stopTaskSession: vi.fn((id: string) => live[id] ?? null),
		} as unknown as TerminalSessionManager;
		const startTaskSession = vi.fn(
			async (
				_scope: RuntimeTrpcWorkspaceScope,
				input: RuntimeTaskSessionStartRequest,
			): Promise<RuntimeTaskSessionStartResponse> => {
				const reserved = (await loadWorkspaceState(repositoryPath)).sessions[input.taskId];
				const summary = runtimeTaskSessionSummarySchema.parse({
					...source,
					taskId: input.taskId,
					agentId: input.agentId ?? "codex",
					sessionTransport: input.requestedAgentSessionTransport ?? "pty_terminal",
					taskConversationMode: input.taskConversationMode,
					taskConversationSessionMetadata: input.taskConversationSessionMetadata,
					codexConversationStorageHomeDirectoryPath: reserved?.codexConversationStorageHomeDirectoryPath,
					agentNativeConversationSessionIdentity: reserved?.agentNativeConversationSessionIdentity ?? {
						sourceAgentId: input.agentId ?? "codex",
						nativeSessionId: "22222222-2222-4222-8222-222222222222",
						transcriptPath: null,
						observedAt: 2,
					},
				});
				live[input.taskId] = summary;
				liveProcessSessionIds.add(input.taskId);
				await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: state.board,
					sessions: { ...state.sessions, [input.taskId]: summary },
					value: null,
				}));
				return { ok: true, summary };
			},
		);
		const sendTaskChatMessage = vi.fn(
			async (
				_scope: RuntimeTrpcWorkspaceScope,
				_input: RuntimeTaskChatSendRequest,
			): Promise<RuntimeTaskChatSendResponse> => ({
				ok: true,
				summary: null,
				terminalDelivery: { status: "delivered_and_submit_confirmed" as const, reason: null },
			}),
		);
		const coordinators: ReturnType<typeof createTaskMainSessionHandoverCoordinator>[] = [];
		const serializer = createTaskCardActionPerTaskCommandSerializer();
		const beforeLoadingScopedRuntimeConfig = vi.fn(async () => {});
		const broadcastState = vi.fn(async () => {});
		let recoveryClock = Date.now();
		const queryReportAcceptance = vi.fn(
			async (input: Parameters<typeof queryCodexMainSessionHandoverReportAcceptance>[0]) => input.probe,
		);
		const prepareNativeFork = vi.fn(
			async (_input: Parameters<typeof prepareCodexMainSessionHandoverNativeFork>[0]) => ({
				nativeSessionId: "88888888-8888-4888-8888-888888888888",
				transcriptPath: join(root.isolatedHomeDirectoryPath, "bound-codex-home", "sessions", "forked.jsonl"),
				codexConversationStorageHomeDirectoryPath: join(root.isolatedHomeDirectoryPath, "bound-codex-home"),
				sourceCompletedTurnCount: 3,
			}),
		);
		const prepareRecoveryNativeFork = vi.fn(
			async (_input: Parameters<typeof prepareCodexMainSessionHandoverRecoveryNativeFork>[0]) => ({
				nativeSessionId: "99999999-9999-4999-8999-999999999999",
				transcriptPath: join(root.isolatedHomeDirectoryPath, "bound-codex-home", "sessions", "recovery.jsonl"),
				codexConversationStorageHomeDirectoryPath: join(root.isolatedHomeDirectoryPath, "bound-codex-home"),
				sourceCompletedTurnCount: 3,
			}),
		);
		const prepareTranscriptNativeFork = vi.fn(
			async (_input: Parameters<typeof prepareTaskMainSessionHandoverTranscriptNativeFork>[0]) => ({
				nativeSessionId: "88888888-8888-4888-8888-888888888888",
				transcriptPath: join(root.isolatedHomeDirectoryPath, "prepared-fork.jsonl"),
				sourceCompletedTurnCount: null,
				codexConversationStorageHomeDirectoryPath: undefined,
			}),
		);
		const acp = {
			hasLiveTaskSession: vi.fn((id: string) => liveProcessSessionIds.has(id)),
			getSummary: (id: string) => (live[id]?.sessionTransport === "acp_stdio_subprocess" ? live[id] : null),
			listSummaries: () =>
				Object.values(live).filter((summary) => summary.sessionTransport === "acp_stdio_subprocess"),
			listMessages: () => [],
			applyTaskConversationSessionMetadata: manager.applyTaskConversationSessionMetadata,
			stopTaskSession: vi.fn(async (id: string) => live[id] ?? null),
		} as unknown as AcpTaskSessionService;
		const create = (agentAutonomousModeEnabled = true) => {
			const coordinator = createTaskMainSessionHandoverCoordinator({
				getAcpTaskSessionService: async () => acp,
				prepareTranscriptNativeFork,
				queryReportAcceptance,
				prepareNativeFork,
				prepareRecoveryNativeFork,
				now: () => recoveryClock,
				getTerminalManager: async () => manager,
				loadScopedRuntimeConfig: async () => {
					await beforeLoadingScopedRuntimeConfig();
					return { agentAutonomousModeEnabled };
				},
				startTaskSession,
				sendTaskChatMessage,
				serializer,
				runCommand: async () => ({
					exitCode: 0,
					stdout: "现场工作区状态",
					stderr: "",
					combinedOutput: "",
					durationMs: 1,
				}),
				broadcastState,
				warn: vi.fn(),
			});
			coordinators.push(coordinator);
			return coordinator;
		};
		return {
			scope,
			liveProcessSessionIds,
			live,
			source,
			board,
			repository,
			manager,
			startTaskSession,
			sendTaskChatMessage,
			create,
			coordinators,
			beforeLoadingScopedRuntimeConfig,
			broadcastState,
			queryReportAcceptance,
			prepareNativeFork,
			prepareRecoveryNativeFork,
			prepareTranscriptNativeFork,
			acp,
			advanceRecoveryClock: (milliseconds: number) => {
				recoveryClock += milliseconds;
			},
		};
	}
	const request = {
		taskId: "task-1",
		expectedMainTaskConversationSessionId: "task-1",
		requestId: "33333333-3333-4333-8333-333333333333",
		destination: { kind: "new_codex_session" as const },
		userContextNotes: "先检查真实实现",
		additionalPlanReferencePaths: [],
	};

	const maintainedHandoverAgentIds = ["claude", "codex", "cursor", "droid", "kiro", "kimi", "omp"] as const;
	it("Cursor 等待真人时跨重启继续读取精确原生导出，机器报告不能解除等待", async () =>
		fixture(async (f) => {
			const previousConfig = process.env.CURSOR_CONFIG_DIR;
			const previousData = process.env.CURSOR_DATA_DIR;
			const home = process.env.HOME;
			assert(home);
			process.env.CURSOR_CONFIG_DIR = join(home, ".cursor");
			process.env.CURSOR_DATA_DIR = join(home, ".cursor");
			try {
				const coordinator = f.create();
				await coordinator.request(
					f.scope,
					taskMainSessionHandoverRequestSchema.parse({
						...request,
						destination: { kind: "new_agent_session", agentId: "cursor" },
					}),
				);
				await coordinator.sweep();
				const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
				assert(record);
				const target = f.live[record.targetTaskConversationSessionId];
				assert(target?.workspacePath);
				assert(target.agentNativeConversationSessionIdentity);
				const nativeId = target.agentNativeConversationSessionIdentity.nativeSessionId;
				const cwd = await realpath(target.workspacePath);
				const chatDirectory = join(home, ".cursor", "chats", createHash("md5").update(cwd).digest("hex"), nativeId);
				mkdirSync(chatDirectory, { recursive: true });
				writeFileSync(join(chatDirectory, "store.db"), "不打开原始 sqlite");
				writeFileSync(
					join(chatDirectory, "meta.json"),
					JSON.stringify({ hasConversation: true, isSubagent: false }),
				);
				const slug = cwd
					.replace(/[^a-zA-Z0-9]/gu, "-")
					.replace(/-+/gu, "-")
					.replace(/^-+|-+$/gu, "");
				const directory = join(home, ".cursor", "projects", slug, "agent-transcripts", nativeId);
				mkdirSync(directory, { recursive: true });
				const path = join(directory, `${nativeId}.jsonl`);
				const report = `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: renderTaskMainSessionHandoverReportPrompt(record) }] } })}\n`;
				writeFileSync(path, report);
				await coordinator.sweep();
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
					"awaiting_user_message",
				);
				await coordinator.close();
				writeFileSync(
					path,
					report +
						`${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "现在继续原主线" }] } })}\n`,
				);
				const restarted = f.create();
				restarted.start();
				await expect
					.poll(async () => (await restarted.getStatus(f.scope, { taskId: "task-1" })).record?.status)
					.toBe("completed");
				expect(
					f.live[target.taskId].taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover,
				).toBe(false);
				expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
			} finally {
				if (previousConfig === undefined) delete process.env.CURSOR_CONFIG_DIR;
				else process.env.CURSOR_CONFIG_DIR = previousConfig;
				if (previousData === undefined) delete process.env.CURSOR_DATA_DIR;
				else process.env.CURSOR_DATA_DIR = previousData;
			}
		}));
	it.each(
		maintainedHandoverAgentIds.flatMap((sourceAgentId) =>
			maintainedHandoverAgentIds.map((targetAgentId) => [sourceAgentId, targetAgentId] as const),
		),
	)("材料交接 %s → %s 复用同一流程并保留原主", async (sourceAgentId, targetAgentId) =>
		fixture(async (f) => {
			assert(f.source.agentNativeConversationSessionIdentity);
			f.live["task-1"] = {
				...f.source,
				agentId: sourceAgentId,
				agentNativeConversationSessionIdentity: {
					...f.source.agentNativeConversationSessionIdentity,
					sourceAgentId,
				},
			};
			await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				sessions: f.live,
				value: null,
			}));
			const coordinator = f.create();
			const prepared = await coordinator.prepare(f.scope, { taskId: "task-1" });
			expect(prepared.material.sourceAgentId).toBe(sourceAgentId);
			expect(prepared.material.userIntentContext).toMatchObject({
				providerAvailability: "unavailable",
				workUnitReference: { taskId: "task-1", workspaceId: f.scope.workspaceId },
			});
			await coordinator.request(
				f.scope,
				taskMainSessionHandoverRequestSchema.parse({
					...request,
					destination: { kind: "new_agent_session", agentId: targetAgentId },
				}),
			);
			await coordinator.sweep();
			await coordinator.sweep();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			const record = findFixtureTaskCard(state.board).taskMainSessionHandover;
			assert(record);
			expect(record?.status).toBe("awaiting_user_message");
			expect(state.sessions[record.targetTaskConversationSessionId]?.agentId).toBe(targetAgentId);
			expect(state.sessions["task-1"]?.agentId).toBe(sourceAgentId);
			expect(state.sessions["task-1"]?.taskConversationSessionMetadata?.taskConversationSessionRole).toBe(
				"task_collaborator",
			);
			const report = f.sendTaskChatMessage.mock.calls[0]?.[1].text ?? "";
			expect(report.startsWith("/plan ")).toBe(targetAgentId === "codex");
			expect(f.startTaskSession.mock.calls[0]?.[1].agentId).toBe(targetAgentId);
			expect(f.prepareNativeFork).not.toHaveBeenCalled();
		}),
	);

	it("跨 harness 的完整复刻在创建任何目标前拒绝，不降级成材料交接", async () =>
		fixture(async (f) => {
			const coordinator = f.create();
			await expect(
				coordinator.request(
					f.scope,
					taskMainSessionHandoverRequestSchema.parse({
						...request,
						destination: {
							kind: "new_agent_session",
							agentId: "omp",
							contextInheritanceMode: "fork_complete_native_conversation",
						},
					}),
				),
			).rejects.toThrow("同一 Agent");
			expect(f.startTaskSession).not.toHaveBeenCalled();
			expect(
				findFixtureTaskCard((await loadWorkspaceState(f.scope.workspacePath)).board).mainTaskConversationSessionId,
			).toBeUndefined();
		}));

	it.each(["claude", "omp", "codex"] as const)("%s 缺少转录路径时预览与请求门禁一致", async (agentId) =>
		fixture(async (f) => {
			assert(f.source.agentNativeConversationSessionIdentity);
			f.live["task-1"] = {
				...f.source,
				agentId,
				agentNativeConversationSessionIdentity: {
					...f.source.agentNativeConversationSessionIdentity,
					sourceAgentId: agentId,
					transcriptPath: null,
				},
			};
			const coordinator = f.create();
			const preview = await coordinator.prepare(f.scope, { taskId: "task-1" });
			const availability = preview.targetAgentCapabilities?.find(
				(entry) => entry.agentId === agentId,
			)?.completeNativeConversationForkAvailability;
			const forkRequest = taskMainSessionHandoverRequestSchema.parse({
				...request,
				destination: {
					kind: "new_agent_session",
					agentId,
					contextInheritanceMode: "fork_complete_native_conversation",
				},
			});
			if (agentId === "codex") {
				expect(availability).toEqual({ available: true, unavailableReason: null });
				await coordinator.request(f.scope, forkRequest);
				await coordinator.sweep();
				expect(f.prepareNativeFork).toHaveBeenCalledOnce();
			} else {
				expect(availability?.available).toBe(false);
				expect(availability?.unavailableReason).toContain("原生转录路径");
				await expect(coordinator.request(f.scope, forkRequest)).rejects.toMatchObject({ code: "BAD_REQUEST" });
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record).toBeNull();
				expect(f.startTaskSession).not.toHaveBeenCalled();
				await coordinator.request(f.scope, request);
				await coordinator.sweep();
				expect(f.prepareNativeFork).not.toHaveBeenCalled();
			}
			expect(f.startTaskSession).toHaveBeenCalledOnce();
			expect(f.prepareTranscriptNativeFork).not.toHaveBeenCalled();
		}),
	);

	it.each([
		{ agentId: "claude", transport: "pty_terminal" },
		{ agentId: "omp", transport: "pty_terminal" },
		{ agentId: "omp", transport: "acp_stdio_subprocess" },
	] as const)("$agentId/$transport 原生 fork 接任按独立子身份启动，保留来源通道", async ({ agentId, transport }) =>
		fixture(async (f) => {
			assert(f.source.agentNativeConversationSessionIdentity);
			f.live["task-1"] = {
				...f.source,
				agentId,
				sessionTransport: transport,
				agentNativeConversationSessionIdentity: {
					...f.source.agentNativeConversationSessionIdentity,
					sourceAgentId: agentId,
				},
			};
			await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				sessions: f.live,
				value: null,
			}));
			const coordinator = f.create();
			const preview = await coordinator.prepare(f.scope, { taskId: "task-1" });
			expect(
				preview.targetAgentCapabilities?.find((entry) => entry.agentId === agentId)
					?.completeNativeConversationForkAvailability,
			).toEqual({ available: true, unavailableReason: null });
			await coordinator.request(
				f.scope,
				taskMainSessionHandoverRequestSchema.parse({
					...request,
					destination: {
						kind: "new_agent_session",
						agentId,
						contextInheritanceMode: "fork_complete_native_conversation",
					},
				}),
			);
			await coordinator.sweep();
			await coordinator.sweep();
			const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(record?.status).toBe("awaiting_user_message");
			assert(record);
			expect(f.prepareTranscriptNativeFork).toHaveBeenCalledTimes(1);
			expect(f.prepareNativeFork).not.toHaveBeenCalled();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			expect(
				state.sessions[record.targetTaskConversationSessionId]?.agentNativeConversationSessionIdentity,
			).toMatchObject({ sourceAgentId: agentId, nativeSessionId: "88888888-8888-4888-8888-888888888888" });
			expect(f.startTaskSession.mock.calls[0]?.[1]).toMatchObject({
				resumePriorAgentConversationWithoutResendingPrompt: true,
				requestedAgentSessionTransport: transport,
				startInPlanMode: true,
			});
		}),
	);

	it("非 Codex 失败交接按原目标和原材料恢复，旧 Codex 入口不能改变它", async () =>
		fixture(async (f) => {
			f.sendTaskChatMessage.mockRejectedValueOnce(new Error("发送回执未知"));
			const coordinator = f.create();
			await coordinator.request(
				f.scope,
				taskMainSessionHandoverRequestSchema.parse({
					...request,
					destination: { kind: "new_agent_session", agentId: "kimi" },
				}),
			);
			await coordinator.sweep();
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(failed);
			expect(failed.status).toBe("failed");
			const recovery = {
				taskId: "task-1",
				expectedHandoverId: failed.handoverId,
				expectedReportDeliveryAttempt: failed.reportDeliveryAttempt,
				requestId: "77777777-7777-4777-8777-777777777777",
				acknowledgePossibleDuplicateReport: true as const,
			};
			await expect(coordinator.recoverWithNewCodexSession(f.scope, recovery)).rejects.toThrow("旧 Codex");
			await coordinator.recoverWithNewAgentSession(f.scope, recovery);
			await coordinator.sweep();
			await coordinator.sweep();
			const restored = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(restored);
			expect(restored.status).toBe("awaiting_user_message");
			expect(restored?.materialDirectoryPath).toBe(failed.materialDirectoryPath);
			expect(restored?.targetTaskConversationSessionId).not.toBe(failed.targetTaskConversationSessionId);
			const state = await loadWorkspaceState(f.scope.workspacePath);
			expect(state.sessions[restored.targetTaskConversationSessionId]?.agentId).toBe("kimi");
			expect(state.sessions[failed.targetTaskConversationSessionId]?.agentId).toBe("kimi");
		}));

	it.each(["droid", "kiro"] as const)(
		"%s 缺原生身份时，输入前置 hook 不算接受，关联处理证据跨状态持久生效",
		async (agentId) =>
			fixture(async (f) => {
				const originalStart = f.startTaskSession.getMockImplementation();
				assert(originalStart);
				f.startTaskSession.mockImplementationOnce(async (...args) => {
					const result = await originalStart(...args);
					assert(result.summary);
					const summary = {
						...result.summary,
						agentNativeConversationSessionIdentity: undefined,
						runtimeSessionIncarnationId: "66666666-6666-4666-8666-666666666666",
					};
					f.live[summary.taskId] = summary;
					await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
						board: state.board,
						sessions: { ...state.sessions, [summary.taskId]: summary },
						value: null,
					}));
					return { ...result, summary };
				});
				f.sendTaskChatMessage.mockResolvedValue({
					ok: true,
					summary: null,
					terminalDelivery: { status: "accepted_pending_submit_confirmation", reason: null },
				});
				const coordinator = f.create();
				await coordinator.request(
					f.scope,
					taskMainSessionHandoverRequestSchema.parse({
						...request,
						destination: { kind: "new_agent_session", agentId },
					}),
				);
				await coordinator.sweep();
				const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
				assert(record);
				const summary = f.live[record.targetTaskConversationSessionId];
				assert(summary);
				assert(summary.runtimeSessionIncarnationId);
				const runtimeSessionIncarnationId = summary.runtimeSessionIncarnationId;
				expect(record.reportAcceptanceProbe).toBeUndefined();
				const capturedAt = Date.now();
				const hook = {
					workspaceId: f.scope.workspaceId,
					taskId: summary.taskId,
					event: "to_in_progress" as const,
					metadata: { source: agentId, hookEventName: "UserPromptSubmit" },
					submittedPromptText: renderTaskMainSessionHandoverReportPrompt(record),
					hookRuntimeSessionIncarnationId: runtimeSessionIncarnationId,
					hookEventDeliveryIdempotencyKey: "report-submission",
					hookEventCapturedAtEpochMs: capturedAt,
				};
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook,
				});
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).not.toBe(
					"awaiting_user_message",
				);
				const processing = {
					...hook,
					submittedPromptText: undefined,
					hookEventDeliveryIdempotencyKey: "report-processing",
					hookEventCapturedAtEpochMs: capturedAt + 1,
					metadata: { source: agentId, hookEventName: "PreToolUse" },
				};
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook: { ...processing, hookRuntimeSessionIncarnationId: "obsolete-incarnation" },
				});
				expect(
					(await coordinator.getStatus(f.scope, { taskId: "task-1" })).record
						?.reportCorrelatedProcessingAcceptanceEvidence,
				).toBeUndefined();
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook: {
						...hook,
						submittedPromptText: "<task-notification>机器消息</task-notification>",
						hookEventDeliveryIdempotencyKey: "machine-submission",
						hookEventCapturedAtEpochMs: capturedAt + 1,
					},
				});
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook: { ...processing, hookEventCapturedAtEpochMs: capturedAt + 2 },
				});
				expect(
					(await coordinator.getStatus(f.scope, { taskId: "task-1" })).record
						?.reportCorrelatedProcessingAcceptanceEvidence,
				).toBeUndefined();
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook: { ...hook, hookEventCapturedAtEpochMs: capturedAt + 3 },
				});
				processing.hookEventCapturedAtEpochMs = capturedAt + 4;
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook: processing,
				});
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record).toMatchObject({
					status: "awaiting_user_message",
					reportCorrelatedProcessingAcceptanceEvidence: {
						submittedHookEventId: "report-submission",
						processingHookEventId: "report-processing",
					},
				});
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook: {
						...hook,
						submittedPromptText: "现在继续主线",
						hookEventDeliveryIdempotencyKey: "human-submission",
						hookEventCapturedAtEpochMs: capturedAt + 5,
					},
				});
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
					"awaiting_user_message",
				);
				await confirmTaskMainSessionHandoverInputAfterCorrelatedProcessingHooks({
					workspacePath: f.scope.workspacePath,
					summary,
					hook: {
						...processing,
						hookEventDeliveryIdempotencyKey: "human-processing",
						hookEventCapturedAtEpochMs: capturedAt + 6,
					},
				});
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe("completed");
			}),
	);

	it("Codex 连续切主时保留两任前主会话及各自的创建角色", async () =>
		fixture(async (f) => {
			f.live["task-1"] = { ...f.source, agentId: "codex", agentNativeConversationSessionIdentity: undefined };
			await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				sessions: f.live,
				value: null,
			}));
			const coordinator = f.create();
			const preview = await coordinator.prepare(f.scope, { taskId: "task-1" });
			expect(preview.material.sourceAgentId).toBe("codex");
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.sweep();
			const first = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(first?.status).toBe("awaiting_user_message");
			if (!first) throw new Error("缺少首次交接记录");
			await completeTaskMainSessionHandoverAfterUserMessage({
				...f.scope,
				taskConversationSessionId: first.targetTaskConversationSessionId,
				promptText: "继续主线",
			});
			await coordinator.request(f.scope, {
				...request,
				expectedMainTaskConversationSessionId: first.targetTaskConversationSessionId,
				requestId: "55555555-5555-4555-8555-555555555555",
			});
			await coordinator.sweep();
			await coordinator.sweep();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			const second = findFixtureTaskCard(state.board).taskMainSessionHandover;
			expect(second?.status).toBe("awaiting_user_message");
			expect(second?.targetTaskConversationSessionId).not.toBe(first.targetTaskConversationSessionId);
			for (const id of ["task-1", first.targetTaskConversationSessionId]) {
				expect(state.sessions[id]?.taskConversationSessionMetadata).toMatchObject({
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionHasHeldMainResponsibility: true,
				});
			}
			expect(state.sessions[first.targetTaskConversationSessionId]?.taskConversationSessionMetadata).toHaveProperty(
				"taskConversationSessionRoleAtCreation",
				"task_collaborator",
			);
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(2);
		}));

	it("空白 Codex 先固定代际再提交，可信首条 hook 固定身份且迟到旧代际不能覆盖", async () =>
		fixture(async (f) => {
			const originalStart = f.startTaskSession.getMockImplementation();
			assert(originalStart);
			f.startTaskSession.mockImplementationOnce(async (...args) => {
				const started = await originalStart(...args);
				assert(started.summary);
				const summary = {
					...started.summary,
					runtimeSessionIncarnationId: "fresh-incarnation",
					agentNativeConversationSessionIdentity: undefined,
				};
				f.live[summary.taskId] = summary;
				await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: state.board,
					sessions: f.live,
					value: null,
				}));
				return { ...started, summary };
			});
			f.sendTaskChatMessage.mockImplementationOnce(async (_scope, input) => {
				const before = findFixtureTaskCard(
					(await loadWorkspaceState(f.scope.workspacePath)).board,
				).taskMainSessionHandover;
				assert(before);
				expect(before.reportNativeIdentityCaptureBinding?.runtimeSessionIncarnationId).toBe("fresh-incarnation");
				expect(before.reportAcceptanceProbe).toBeUndefined();
				const identity = {
					sourceAgentId: "codex" as const,
					nativeSessionId: "99999999-9999-4999-8999-999999999999",
					transcriptPath: null,
					observedAt: Date.now(),
				};
				const summary = { ...f.live[input.taskId], agentNativeConversationSessionIdentity: identity };
				await captureTaskMainSessionHandoverReportNativeIdentity({
					workspacePath: f.scope.workspacePath,
					summary,
					identity,
					hookRuntimeSessionIncarnationId: "stale-incarnation",
				});
				expect(
					findFixtureTaskCard((await loadWorkspaceState(f.scope.workspacePath)).board).taskMainSessionHandover
						?.reportAcceptanceProbe,
				).toBeUndefined();
				f.live[input.taskId] = summary;
				await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: state.board,
					sessions: f.live,
					value: null,
				}));
				await captureTaskMainSessionHandoverReportNativeIdentity({
					workspacePath: f.scope.workspacePath,
					summary,
					identity,
					hookRuntimeSessionIncarnationId: "fresh-incarnation",
				});
				await captureTaskMainSessionHandoverReportNativeIdentity({
					workspacePath: f.scope.workspacePath,
					summary,
					identity: { ...identity, nativeSessionId: "must-not-overwrite-first-identity" },
					hookRuntimeSessionIncarnationId: "fresh-incarnation",
				});
				return {
					ok: true,
					summary,
					terminalDelivery: { status: "accepted_pending_submit_confirmation", reason: null },
				};
			});
			f.queryReportAcceptance.mockImplementationOnce(async (input) => ({
				...input.probe,
				historicalAcceptanceEvidence: { sourceReference: "native-history:first-input", observedAt: Date.now() },
			}));
			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.sweep();
			const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(record);
			expect(record.status).toBe("awaiting_user_message");
			expect(record.reportAcceptanceProbe?.nativeSessionId).toBe("99999999-9999-4999-8999-999999999999");
			expect(f.startTaskSession).toHaveBeenCalledOnce();
			expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
		}));

	it("启动后身份准备暂缺会自动复用同一活体，补证后提交且不再次启动", async () =>
		fixture(async (f) => {
			const originalStart = f.startTaskSession.getMockImplementation();
			assert(originalStart);
			f.startTaskSession.mockImplementationOnce(async (...args) => {
				const result = await originalStart(...args);
				assert(result.summary);
				const summary = mergeSummaryWithFacets(
					{
						...result.summary,
						agentNativeConversationSessionIdentity: undefined,
						runtimeSessionIncarnationId: undefined,
					},
					{ turnOwner: "agent", liveness: "live", userTurnKind: null },
				);
				f.live[summary.taskId] = summary;
				await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: state.board,
					sessions: f.live,
					value: null,
				}));
				return { ...result, summary };
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(failed);
			expect(failed.status).toBe("failed");
			expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
			f.live[failed.targetTaskConversationSessionId] = {
				...f.live[failed.targetTaskConversationSessionId],
				runtimeSessionIncarnationId: "trusted-startup-incarnation",
			};
			f.advanceRecoveryClock(15_000);
			await coordinator.sweep();
			await coordinator.sweep();
			expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
				"awaiting_user_message",
			);
			expect(f.startTaskSession).toHaveBeenCalledOnce();
			expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
		}));

	it("完整复刻先验证独立子身份再切主，首次启动和冷恢复均按子身份寻址", async () =>
		fixture(async (f) => {
			assert(f.source.agentNativeConversationSessionIdentity);
			f.live["task-1"] = {
				...f.source,
				agentId: "codex",
				agentNativeConversationSessionIdentity: {
					...f.source.agentNativeConversationSessionIdentity,
					sourceAgentId: "codex",
				},
			};
			await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				sessions: f.live,
				value: null,
			}));
			const implementation = f.prepareNativeFork.getMockImplementation();
			f.prepareNativeFork.mockImplementationOnce(async (input) => {
				const state = await loadWorkspaceState(f.scope.workspacePath);
				expect(findFixtureTaskCard(state.board).mainTaskConversationSessionId).toBeUndefined();
				expect(f.startTaskSession).not.toHaveBeenCalled();
				if (!implementation) throw new Error("缺少原生准备 fixture");
				return await implementation(input);
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: {
					kind: "new_codex_session",
					contextInheritanceMode: "fork_complete_native_conversation",
				},
			});
			await coordinator.sweep();
			await coordinator.sweep();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			const record = findFixtureTaskCard(state.board).taskMainSessionHandover;
			assert(record);
			expect(record.status).toBe("awaiting_user_message");
			expect(state.sessions[record.targetTaskConversationSessionId]).toMatchObject({
				agentNativeConversationSessionIdentity: { nativeSessionId: "88888888-8888-4888-8888-888888888888" },
				taskConversationSessionMetadata: {
					taskConversationSessionContextSource: "forked_from_main_current_turn",
					parentTaskConversationSessionId: "task-1",
				},
			});
			expect(f.startTaskSession.mock.calls[0][1].resumePriorAgentConversationWithoutResendingPrompt).toBe(true);
			expect(f.startTaskSession.mock.calls[0][1].terminalAgentModelOverrideSettings).toBeUndefined();
			expect(f.prepareNativeFork).toHaveBeenCalledOnce();
		}));

	it("完整复刻的显式恢复保留上下文方式与原固定凭据，旧目标仍可读取", async () =>
		fixture(async (f) => {
			assert(f.source.agentNativeConversationSessionIdentity);
			f.live["task-1"] = {
				...f.source,
				agentId: "codex",
				agentNativeConversationSessionIdentity: {
					...f.source.agentNativeConversationSessionIdentity,
					sourceAgentId: "codex",
				},
			};
			await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				sessions: f.live,
				value: null,
			}));
			f.sendTaskChatMessage.mockResolvedValueOnce({
				ok: true,
				summary: null,
				terminalDelivery: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "new_codex_session", contextInheritanceMode: "fork_complete_native_conversation" },
			});
			await coordinator.sweep();
			await coordinator.sweep();
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(failed);
			expect(failed.status).toBe("failed");
			await coordinator.recoverWithNewCodexSession(f.scope, {
				taskId: "task-1",
				expectedHandoverId: failed.handoverId,
				expectedReportDeliveryAttempt: failed.reportDeliveryAttempt,
				requestId: "66666666-6666-4666-8666-666666666666",
				acknowledgePossibleDuplicateReport: true,
			});
			await coordinator.sweep();
			await coordinator.sweep();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			const recovered = findFixtureTaskCard(state.board).taskMainSessionHandover;
			assert(recovered);
			expect(recovered.destination).toMatchObject({ contextInheritanceMode: "fork_complete_native_conversation" });
			expect(recovered.status).toBe("awaiting_user_message");
			expect(f.prepareRecoveryNativeFork).toHaveBeenCalledWith(
				expect.objectContaining({
					frozenReceiptFilePath: failed.nativeForkPreparationReceiptPath,
					sourceSummary: expect.objectContaining({ taskId: failed.targetTaskConversationSessionId }),
				}),
			);
			expect(
				state.sessions[failed.targetTaskConversationSessionId].agentNativeConversationSessionIdentity
					?.nativeSessionId,
			).toBe("88888888-8888-4888-8888-888888888888");
			expect(
				state.sessions[recovered.targetTaskConversationSessionId].agentNativeConversationSessionIdentity
					?.nativeSessionId,
			).toBe("99999999-9999-4999-8999-999999999999");
		}));

	it.each(["用户 Stop", "主绑定变化"] as const)("报告提交前 %s 时结算为确定未投递，重启不再发送", async (gate) =>
		fixture(async (f) => {
			const coordinator = f.create();
			let executionProhibited = false;
			f.broadcastState.mockImplementation(async () => {
				const card = findFixtureTaskCard((await loadWorkspaceState(f.scope.workspacePath)).board);
				if (executionProhibited || !card.taskMainSessionHandover?.reportAcceptanceProbe) return;
				executionProhibited = true;
				if (gate === "用户 Stop") await coordinator.pauseForExplicitStop(f.scope.workspaceId, "task-1");
				else
					await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
						board: {
							...state.board,
							columns: state.board.columns.map((column) => ({
								...column,
								cards: column.cards.map((entry) =>
									entry.id === "task-1" ? { ...entry, mainTaskConversationSessionId: "task-1" } : entry,
								),
							})),
						},
						value: null,
					}));
			});
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			expect(executionProhibited).toBe(true);
			expect((await readReportDeliveryLedger(f))[0]).toMatchObject({
				terminal_delivery_status: "delivery_failed",
				terminal_delivery_failure_reason: "cancelled_before_delivery",
			});
			expect(
				(await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.automaticRecovery?.classification,
			).toBe("execution_prohibited");
			await coordinator.close();
			f.advanceRecoveryClock(60_000);
			const resumed = f.create();
			resumed.start();
			await expect(resumed.retry(f.scope, { taskId: "task-1" })).rejects.toThrow();
			await resumed.close();
			expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
		}),
	);

	it("真实 runtime 交接发送前门禁拒绝返回明确未提交证明，不触及 transport", async () =>
		fixture(async (f) => {
			const unexpectedTransportAccess = vi.fn(async (): Promise<never> => {
				throw new Error("发送前门禁拒绝后不应访问 transport");
			});
			const api = createRuntimeApi({
				getActiveWorkspaceId: () => f.scope.workspaceId,
				loadScopedRuntimeConfig: unexpectedTransportAccess,
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: unexpectedTransportAccess,
				getScopedClineTaskSessionService: unexpectedTransportAccess,
				getScopedAcpTaskSessionService: unexpectedTransportAccess,
				resolveInteractiveShellCommand: () => {
					throw new Error("发送前门禁拒绝后不应启动 shell");
				},
				runCommand: unexpectedTransportAccess,
				getUpdateStatus: vi.fn(),
				runUpdateNow: unexpectedTransportAccess,
			});
			const rejected = await api.sendTaskChatMessage(
				f.scope,
				{
					taskId: "task-1",
					text: "尚未请求交接，不应发送报告",
					source: "task_main_session_handover",
					idempotencyKey: `${request.requestId}:report:0`,
				},
				{ decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" } },
			);
			expect(rejected).toMatchObject({
				ok: false,
				terminalDelivery: { status: "delivery_failed", reason: "cancelled_before_delivery" },
			});
			expect(unexpectedTransportAccess).not.toHaveBeenCalled();
		}));

	it.each([false, true])(
		"明确未提交回执允许保留失败账本并安全重试（重启=%s）",
		async (restart) =>
			fixture(async (f) => {
				f.sendTaskChatMessage.mockResolvedValueOnce({
					ok: false,
					summary: null,
					error: "尚未提交即被拒绝",
					terminalDelivery: { status: "delivery_failed", reason: "cancelled_before_delivery" },
				});
				const coordinator = f.create();
				await coordinator.request(f.scope, request);
				await coordinator.sweep();
				const firstFailure = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(firstFailure?.status).toBe("failed");
				expect((await readReportDeliveryLedger(f))[0]).toMatchObject({
					terminal_delivery_status: "delivery_failed",
					terminal_delivery_failure_reason: "cancelled_before_delivery",
				});
				f.advanceRecoveryClock(15_000);
				const resumed = restart ? f.create() : coordinator;
				if (restart) {
					await coordinator.close();
					resumed.start();
				}
				// 15 秒重验冷却由注入时钟控制；这里仅等待多次持久化后的终态可见，保留全部投递语义断言。
				try {
					await vi.waitFor(
						async () => {
							await resumed.sweep();
							expect((await resumed.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
								"awaiting_user_message",
							);
						},
						{ timeout: 10_000 },
					);
				} catch (error) {
					const record = (await resumed.getStatus(f.scope, { taskId: "task-1" })).record;
					throw new Error(
						`交接重试终态：${JSON.stringify({ status: record?.status, errorMessage: record?.errorMessage, automaticRecovery: record?.automaticRecovery, sendCalls: f.sendTaskChatMessage.mock.calls.length })}`,
						{ cause: error },
					);
				}
				const recovered = (await resumed.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(recovered?.failureHistory).toEqual(firstFailure?.failureHistory);
				expect(recovered?.reportDeliveryAttempt).toBe(1);
				expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(2);
				expect(f.sendTaskChatMessage.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
					`${request.requestId}:report:0`,
					`${request.requestId}:report:1`,
				]);
				expect((await readReportDeliveryLedger(f)).map((entry) => entry.terminal_delivery_status)).toEqual([
					"delivery_failed",
					"delivered_and_submit_confirmed",
				]);
			}),
		20_000,
	);

	it.each(["抛出异常", "没有回执", "无回执的失败响应", "确认尚未完成"] as const)(
		"投递%s只读补证，结束请求后不假装仍在投递也不重发",
		async (outcome) =>
			fixture(async (f) => {
				if (outcome === "抛出异常") f.sendTaskChatMessage.mockRejectedValueOnce(new Error("提交结果未知"));
				else
					f.sendTaskChatMessage.mockResolvedValueOnce({
						ok: outcome !== "无回执的失败响应",
						summary: null,
						...(outcome === "确认尚未完成"
							? { terminalDelivery: { status: "accepted_pending_submit_confirmation" as const, reason: null } }
							: {}),
					});
				const coordinator = f.create();
				await coordinator.request(f.scope, request);
				await coordinator.sweep();
				await coordinator.sweep();
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe("failed");
				f.advanceRecoveryClock(15_000);
				await coordinator.sweep();
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe("failed");
				await expect(coordinator.retry(f.scope, { taskId: "task-1" })).rejects.toThrow("上次投递可能已经发生");
				expect((await readReportDeliveryLedger(f))[0]?.terminal_delivery_status).toBe(
					"accepted_pending_submit_confirmation",
				);
				await coordinator.close();
				f.advanceRecoveryClock(15_000);
				f.queryReportAcceptance.mockImplementationOnce(async (input) => ({
					...input.probe,
					historicalAcceptanceEvidence: {
						sourceReference: "native-history:late-unknown-acceptance",
						observedAt: Date.now(),
					},
				}));
				const resumed = f.create();
				resumed.start();
				await vi.waitFor(async () =>
					expect((await resumed.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
						"awaiting_user_message",
					),
				);
				expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
			}),
	);

	it.each([false, true])("排队回执等待完整报告接受证明，迟到证明接续且不重发（重启=%s）", async (restart) =>
		fixture(async (f) => {
			f.sendTaskChatMessage.mockResolvedValueOnce({
				ok: true,
				summary: null,
				terminalDelivery: { status: "delivered_queued_behind_active_agent_turn", reason: null },
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.sweep();
			expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
				"report_delivery_pending",
			);
			expect(f.queryReportAcceptance).toHaveBeenCalledOnce();
			if (restart) await coordinator.close();
			f.advanceRecoveryClock(15_000);
			f.queryReportAcceptance.mockImplementationOnce(async (input) => ({
				...input.probe,
				historicalAcceptanceEvidence: {
					sourceReference: "native-history:late-queued-acceptance",
					observedAt: Date.now(),
				},
			}));
			const resumed = restart ? f.create() : coordinator;
			if (restart) resumed.start();
			await vi.waitFor(async () => {
				await resumed.sweep();
				expect((await resumed.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
					"awaiting_user_message",
				);
			});
			expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
			expect((await readReportDeliveryLedger(f))[0]?.terminal_delivery_status).toBe(
				"delivered_queued_behind_active_agent_turn",
			);
		}),
	);

	async function readReportDeliveryLedger(f: Awaited<ReturnType<typeof setup>>) {
		const state = await loadWorkspaceState(f.scope.workspacePath);
		return await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath));
	}

	it("迟到的原生接受证明跨重启自动接续，原失败账本保留且不重发", async () =>
		fixture(async (f) => {
			const { coordinator, failed } = await failFirstReport(f);
			expect(f.queryReportAcceptance).toHaveBeenCalledOnce();
			f.advanceRecoveryClock(14_999);
			await coordinator.sweep();
			expect(f.queryReportAcceptance).toHaveBeenCalledOnce();
			await coordinator.close();
			f.advanceRecoveryClock(1);
			f.queryReportAcceptance.mockImplementationOnce(async (input) => ({
				...input.probe,
				historicalAcceptanceEvidence: { sourceReference: "native-history:late-acceptance", observedAt: Date.now() },
			}));
			const resumed = f.create();
			resumed.start();
			await vi.waitFor(async () =>
				expect((await resumed.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
					"awaiting_user_message",
				),
			);
			const recovered = (await resumed.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(recovered);
			expect(recovered.failureHistory?.length).toBeGreaterThan(0);
			expect(recovered.errorMessage).toBeNull();
			expect(recovered.reportAcceptanceProbe?.historicalAcceptanceEvidence?.sourceReference).toBe(
				"native-history:late-acceptance",
			);
			expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			expect(
				(await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath))).find(
					(entry) => entry.task_id === failed.targetTaskConversationSessionId,
				)?.terminal_delivery_status,
			).toBe("delivery_failed");
		}));

	it("历史接受虽已确认，当前目录归属变化仍禁止接续并保留接受事实", async () =>
		fixture(async (f) => {
			const { coordinator, failed } = await failFirstReport(f);
			f.live[failed.targetTaskConversationSessionId] = {
				...f.live[failed.targetTaskConversationSessionId],
				workspacePath: "/other-task-working-directory",
			};
			f.queryReportAcceptance.mockImplementationOnce(async (input) => ({
				...input.probe,
				historicalAcceptanceEvidence: {
					sourceReference: "historical-acceptance-before-ownership-drift",
					observedAt: Date.now(),
				},
			}));
			f.advanceRecoveryClock(15_000);
			await coordinator.sweep();
			const result = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(result?.status).toBe("failed");
			expect(result?.automaticRecovery?.classification).toBe("execution_prohibited");
			expect(result?.reportAcceptanceProbe?.historicalAcceptanceEvidence?.sourceReference).toBe(
				"historical-acceptance-before-ownership-drift",
			);
			expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
		}));

	it.each(["nativeHistoryCursor", "transcriptHistoryCursor"] as const)(
		"分页扫描跨重启继续，页尾仅完成一轮预算且外部变化后恢复：%s",
		async (cursorField) =>
			fixture(async (f) => {
				f.queryReportAcceptance.mockImplementation(async ({ probe }) => {
					const page = Number(probe[cursorField] ?? 0);
					return { ...probe, [cursorField]: page < 3 ? String(page + 1) : null };
				});
				const { coordinator, failed } = await failFirstReport(f);
				await coordinator.close();
				f.advanceRecoveryClock(15_000);
				const resumed = f.create();
				resumed.start();
				await vi.waitFor(() => expect(f.queryReportAcceptance).toHaveBeenCalledTimes(2));
				await resumed.sweep();
				for (let page = 2; page < 12; page += 1) {
					f.advanceRecoveryClock(14_999);
					await resumed.sweep();
					expect(f.queryReportAcceptance).toHaveBeenCalledTimes(page);
					f.advanceRecoveryClock(1);
					await resumed.sweep();
				}
				expect(f.queryReportAcceptance).toHaveBeenCalledTimes(12);
				const exhausted = (await resumed.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(exhausted?.automaticRecovery?.attemptCount).toBe(3);
				expect(exhausted?.automaticRecovery?.nextAttemptAt).toBeNull();
				f.advanceRecoveryClock(60_000);
				await resumed.sweep();
				expect(f.queryReportAcceptance).toHaveBeenCalledTimes(12);
				f.live[failed.targetTaskConversationSessionId] = {
					...f.live[failed.targetTaskConversationSessionId],
					runtimeSessionIncarnationId: "changed-native-control-generation",
				};
				f.queryReportAcceptance.mockImplementationOnce(async ({ probe }) => ({
					...probe,
					historicalAcceptanceEvidence: { sourceReference: "native-history:new-evidence", observedAt: Date.now() },
				}));
				await resumed.sweep();
				expect(f.queryReportAcceptance).toHaveBeenCalledTimes(13);
				expect((await resumed.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
					"awaiting_user_message",
				);
				expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
			}),
	);

	it.each(["重复游标", "循环游标", "读取错误"] as const)(
		"分页进度异常不得无限续期，跨重启保留预算和循环历史：%s",
		async (scenario) =>
			fixture(async (f) => {
				f.queryReportAcceptance.mockImplementation(async ({ probe }) => {
					if (scenario === "读取错误") throw new Error("原生历史暂不可读");
					return {
						...probe,
						transcriptHistoryCursor: scenario === "循环游标" && probe.transcriptHistoryCursor === "a" ? "b" : "a",
					};
				});
				const { coordinator } = await failFirstReport(f);
				await coordinator.close();
				f.advanceRecoveryClock(15_000);
				const resumed = f.create();
				resumed.start();
				await vi.waitFor(() => expect(f.queryReportAcceptance).toHaveBeenCalledTimes(2));
				await resumed.sweep();
				for (let retry = 0; retry < 10; retry += 1) {
					f.advanceRecoveryClock(15_000);
					await resumed.sweep();
				}
				const exhausted = (await resumed.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(exhausted?.automaticRecovery?.attemptCount).toBe(3);
				expect(exhausted?.automaticRecovery?.nextAttemptAt).toBeNull();
				expect(f.queryReportAcceptance).toHaveBeenCalledTimes(
					scenario === "循环游标" ? 7 : scenario === "重复游标" ? 4 : 3,
				);
				expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
			}),
	);

	it("同一证据最多补查三次，预算跨重启保留；证据变化后自动恢复", async () =>
		fixture(async (f) => {
			const { coordinator, failed } = await failFirstReport(f);
			for (let index = 0; index < 2; index++) {
				f.advanceRecoveryClock(15_000);
				await coordinator.sweep();
			}
			expect(f.queryReportAcceptance).toHaveBeenCalledTimes(3);
			await coordinator.close();
			f.advanceRecoveryClock(60_000);
			const resumed = f.create();
			resumed.start();
			await vi.waitFor(async () =>
				expect(
					(await resumed.getStatus(f.scope, { taskId: "task-1" })).record?.automaticRecovery?.attemptCount,
				).toBe(3),
			);
			await resumed.sweep();
			expect(f.queryReportAcceptance).toHaveBeenCalledTimes(3);
			f.live[failed.targetTaskConversationSessionId] = {
				...f.live[failed.targetTaskConversationSessionId],
				runtimeSessionIncarnationId: "new-native-control-generation",
			};
			await vi.waitFor(async () => {
				await resumed.sweep();
				expect(
					f.queryReportAcceptance,
					JSON.stringify((await resumed.getStatus(f.scope, { taskId: "task-1" })).record),
				).toHaveBeenCalledTimes(4);
			});
			expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
		}));

	it("用户 Stop 可中断切主前的异步准备，重启或重试都不能自行接续", async () =>
		fixture(async (f) => {
			const coordinator = f.create();
			f.beforeLoadingScopedRuntimeConfig.mockImplementationOnce(
				async () => await coordinator.pauseForExplicitStop(f.scope.workspaceId, "task-1"),
			);
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			const stopped = await coordinator.getStatus(f.scope, { taskId: "task-1" });
			expect(stopped.record?.automaticRecovery?.classification).toBe("execution_prohibited");
			f.advanceRecoveryClock(60_000);
			await coordinator.sweep();
			expect(f.startTaskSession).not.toHaveBeenCalled();
			await expect(coordinator.retry(f.scope, { taskId: "task-1" })).rejects.toThrow("Stop");
		}));

	function findFixtureTaskCard(board: RuntimeBoardData) {
		const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === "task-1");
		if (!card) throw new Error("隔离任务卡缺失");
		return card;
	}

	async function failFirstReport(f: Awaited<ReturnType<typeof setup>>) {
		f.sendTaskChatMessage.mockResolvedValueOnce({
			ok: true,
			summary: null,
			terminalDelivery: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
		});
		const coordinator = f.create();
		await coordinator.request(f.scope, request);
		await coordinator.sweep();
		await coordinator.sweep();
		const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
		if (!failed || failed.status !== "failed") throw new Error("应保留首次交接失败现场");
		return {
			coordinator,
			failed,
			recoveryInput: {
				taskId: "task-1",
				expectedHandoverId: failed.handoverId,
				expectedReportDeliveryAttempt: failed.reportDeliveryAttempt,
				requestId: "44444444-4444-4444-8444-444444444444",
				acknowledgePossibleDuplicateReport: true as const,
			},
		};
	}

	it("显式恢复新建接任会话，重复确认幂等，原会话、材料与失败账本均保留", async () =>
		fixture(async (f) => {
			const { coordinator, failed, recoveryInput } = await failFirstReport(f);
			await expect(coordinator.retry(f.scope, { taskId: "task-1" })).rejects.toThrow("上次投递可能已经发生");
			const originalState = await loadWorkspaceState(f.scope.workspacePath);
			const first = await coordinator.recoverWithNewCodexSession(f.scope, recoveryInput);
			const duplicate = await coordinator.recoverWithNewCodexSession(f.scope, recoveryInput);
			expect(duplicate.record?.targetTaskConversationSessionId).toBe(first.record?.targetTaskConversationSessionId);
			await coordinator.sweep();
			await coordinator.sweep();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			const card = findFixtureTaskCard(state.board);
			expect(card.mainTaskConversationSessionId).not.toBe(failed.targetTaskConversationSessionId);
			expect(card.taskMainSessionHandover?.status).toBe("awaiting_user_message");
			expect(card.taskMainSessionHandover?.reportDeliveryAttempt).toBe(1);
			expect(card.taskMainSessionHandover?.materialDirectoryPath).toBe(failed.materialDirectoryPath);
			expect(state.sessions["task-1"].agentNativeConversationSessionIdentity).toEqual(
				originalState.sessions["task-1"].agentNativeConversationSessionIdentity,
			);
			expect(state.sessions[failed.targetTaskConversationSessionId].agentNativeConversationSessionIdentity).toEqual(
				originalState.sessions[failed.targetTaskConversationSessionId].agentNativeConversationSessionIdentity,
			);
			const recovery = card.taskMainSessionHandover?.recoveryReceipts?.[0];
			expect(recovery?.requestId).toBe(recoveryInput.requestId);
			const receipt = JSON.parse(await readFile(recovery?.receiptFilePath as string, "utf8"));
			expect(receipt.previousHandoverRecord).toEqual(failed);
			const ledger = await readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(state.statePath));
			expect(ledger.find((entry) => entry.task_id === failed.targetTaskConversationSessionId)).toMatchObject({
				terminal_delivery_status: "delivery_failed",
				terminal_delivery_failure_reason: "submit_confirmation_budget_exhausted",
			});
			expect(f.startTaskSession).toHaveBeenCalledTimes(2);
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(2);
		}));

	it("不同恢复请求并发时仅一个取得主绑定，过期确认不创建额外会话", async () =>
		fixture(async (f) => {
			const { coordinator, recoveryInput } = await failFirstReport(f);
			const outcomes = await Promise.allSettled([
				coordinator.recoverWithNewCodexSession(f.scope, recoveryInput),
				f.create().recoverWithNewCodexSession(f.scope, {
					...recoveryInput,
					requestId: "55555555-5555-4555-8555-555555555555",
				}),
			]);
			expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
			expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
			await coordinator.sweep();
			expect(f.startTaskSession).toHaveBeenCalledTimes(2);
		}));

	it("切主前收到迟到身份 hook 时保留最新旧会话身份，不写回先前快照", async () =>
		fixture(async (f) => {
			const { coordinator, failed, recoveryInput } = await failFirstReport(f);
			const targetId = failed.targetTaskConversationSessionId;
			const latestNativeId = "77777777-7777-4777-8777-777777777777";
			f.beforeLoadingScopedRuntimeConfig.mockImplementationOnce(async () => {
				f.live[targetId] = {
					...f.live[targetId],
					lastOutputAt: 123,
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: latestNativeId,
						transcriptPath: null,
						observedAt: 123,
					},
				};
			});
			await coordinator.recoverWithNewCodexSession(f.scope, recoveryInput);
			await coordinator.sweep();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			expect(state.sessions[targetId].agentNativeConversationSessionIdentity?.nativeSessionId).toBe(latestNativeId);
			expect(state.sessions[targetId].lastOutputAt).toBe(123);
		}));

	it("恢复凭据已落盘但主绑定尚未切换时，重启后复用预留目标", async () =>
		fixture(async (f) => {
			const { coordinator, failed, recoveryInput } = await failFirstReport(f);
			await coordinator.close();
			const reservedTarget = "task-conversation-session-66666666-6666-4666-8666-666666666666";
			const directory = join(failed.materialDirectoryPath as string, "recovery-attempts");
			mkdirSync(directory, { recursive: true });
			const receiptFilePath = join(directory, `${recoveryInput.requestId}.json`);
			writeFileSync(
				receiptFilePath,
				JSON.stringify({
					taskId: "task-1",
					requestId: recoveryInput.requestId,
					replacedTargetTaskConversationSessionId: failed.targetTaskConversationSessionId,
					replacementTargetTaskConversationSessionId: reservedTarget,
					previousReportDeliveryAttempt: 0,
					receiptFilePath,
					createdAt: Date.now(),
					previousHandoverRecord: failed,
				}),
			);
			const recovered = f.create();
			await recovered.recoverWithNewCodexSession(f.scope, recoveryInput);
			await recovered.sweep();
			expect(
				(await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.targetTaskConversationSessionId,
			).toBe(reservedTarget);
			expect(f.startTaskSession.mock.calls[1][1].taskId).toBe(reservedTarget);
		}));

	it("重建绑定后首次启动失败，重启不重放旧汇报，确定未投递的新目标可重试", async () =>
		fixture(async (f) => {
			const { coordinator, recoveryInput } = await failFirstReport(f);
			f.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "模拟重建后首次启动失败" });
			await coordinator.recoverWithNewCodexSession(f.scope, recoveryInput);
			await coordinator.sweep();
			const beforeRestart = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(beforeRestart?.status).toBe("failed");
			await coordinator.close();
			const recovered = f.create();
			await recovered.sweep();
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
			const duplicate = await recovered.recoverWithNewCodexSession(f.scope, recoveryInput);
			expect(duplicate.record?.targetTaskConversationSessionId).toBe(beforeRestart?.targetTaskConversationSessionId);
			await recovered.retry(f.scope, { taskId: "task-1" });
			await recovered.sweep();
			await recovered.sweep();
			expect(f.startTaskSession.mock.calls[2][1].taskId).toBe(beforeRestart?.targetTaskConversationSessionId);
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(2);
		}));

	it("旧接任会话仍在生成时拒绝重建，保持主绑定和会话历史", async () =>
		fixture(async (f) => {
			const { coordinator, failed, recoveryInput } = await failFirstReport(f);
			f.live[failed.targetTaskConversationSessionId] = mergeSummaryWithFacets(
				f.live[failed.targetTaskConversationSessionId],
				{ turnOwner: "agent", liveness: "live", userTurnKind: null },
			);
			await expect(coordinator.recoverWithNewCodexSession(f.scope, recoveryInput)).rejects.toThrow("仍在生成");
			const state = await loadWorkspaceState(f.scope.workspacePath);
			expect(findFixtureTaskCard(state.board).mainTaskConversationSessionId).toBe(
				failed.targetTaskConversationSessionId,
			);
			expect(f.startTaskSession).toHaveBeenCalledTimes(1);
		}));

	it("默认新建 Codex，保留 Claude 历史与权限，报告后等待；旧整板保存不能夺回主绑定", async () =>
		fixture(async (f) => {
			const coordinator = f.create();
			const preview = await coordinator.prepare(f.scope, { taskId: "task-1" });
			expect(preview.material.lastAgentMessage?.text).toContain("已完成第一部分");
			expect(preview.material.planReferences).toHaveLength(1);
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.sweep();
			let state = await loadWorkspaceState(f.scope.workspacePath);
			const card = state.board.columns.flatMap((column) => column.cards)[0];
			expect(card.mainTaskConversationSessionId).toMatch(/^task-conversation-session-/u);
			expect(card.taskMainSessionHandover?.status).toBe("awaiting_user_message");
			expect(state.sessions["task-1"].agentId).toBe("claude");
			expect(state.sessions["task-1"].agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
				f.source.agentNativeConversationSessionIdentity?.nativeSessionId,
			);
			expect(state.sessions[card.mainTaskConversationSessionId as string].agentId).toBe("codex");
			expect(f.startTaskSession).toHaveBeenCalledTimes(1);
			expect(f.startTaskSession.mock.calls[0][1]).toMatchObject({
				taskAgentPermissionMode: "bypass_all_permission_prompts",
				prompt: "",
			});
			expect(f.sendTaskChatMessage.mock.calls[0][1].text).toContain("/plan KANBAN_MAIN_SESSION_HANDOVER_REPORT:");
			expect(
				await readFile(join(card.taskMainSessionHandover?.materialDirectoryPath as string, "HANDOVER.md"), "utf8"),
			).toContain("先检查真实实现");
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			expect(f.startTaskSession).toHaveBeenCalledTimes(1);
			await saveWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: f.board,
				sessions: { "task-1": f.source },
			});
			state = await loadWorkspaceState(f.scope.workspacePath);
			expect(state.board.columns.flatMap((column) => column.cards)[0].mainTaskConversationSessionId).toBe(
				card.mainTaskConversationSessionId,
			);
			expect(state.sessions[card.mainTaskConversationSessionId as string]).toBeDefined();
			const targetSession = state.sessions[card.mainTaskConversationSessionId as string];
			await saveWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: f.board,
				sessions: {
					"task-1": f.source,
					[targetSession.taskId]: { ...targetSession, taskConversationSessionMetadata: undefined },
				},
			});
			const afterLegacyMetadataSave = await loadWorkspaceState(f.scope.workspacePath);
			expect(afterLegacyMetadataSave.sessions[targetSession.taskId].taskConversationSessionMetadata).toMatchObject({
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "main",
				taskConversationSessionRoleAtCreation: "task_collaborator",
			});

			await completeTaskMainSessionHandoverAfterUserMessage({
				...f.scope,
				taskConversationSessionId: card.mainTaskConversationSessionId as string,
				promptText: "KANBAN_MAIN_SESSION_HANDOVER_REPORT:首轮材料",
			});
			expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
				"awaiting_user_message",
			);
			await completeTaskMainSessionHandoverAfterUserMessage({
				...f.scope,
				taskConversationSessionId: card.mainTaskConversationSessionId as string,
				promptText: "继续检查下一部分",
			});
			expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe("completed");
		}));

	it("Last turn 真实差异跟随持久主绑定，兼容旧卡并且不回退到前主 checkpoint", async () =>
		fixture(async (f) => {
			const api = createWorkspaceApi({
				ensureTerminalManagerForWorkspace: async () => f.manager,
				getScopedClineTaskSessionService: async () => ({ getSummary: () => null }) as never,
				loadScopedRuntimeConfig: vi.fn(),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
				listProjectRuntimeSessionSummaries: () => Object.values(f.live),
			});
			const changePath = join(f.scope.workspacePath, "last-turn-implementation.txt");
			const checkpoint = (sessionId: string, turn: number, text: string) => {
				writeFileSync(changePath, text);
				const commit = f.repository.commitAllRepositoryFilesAtDate({
					message: `${sessionId} 第 ${turn} 轮`,
					authorAndCommitterIsoDate: "2026-10-18T00:00:00Z",
				});
				return { turn, ref: `refs/kanban/checkpoints/${sessionId}/turn/${turn}`, commit, createdAt: turn };
			};
			f.live["task-1"] = {
				...f.source,
				previousTurnCheckpoint: checkpoint("task-1", 1, "Claude 前一轮"),
				latestTurnCheckpoint: checkpoint("task-1", 2, "Claude 最新轮"),
			};
			const loadLastTurn = () =>
				api.loadChanges(f.scope, { taskId: "task-1", baseRef: "main", worktreeMode: "inplace", mode: "last_turn" });
			const legacyDiff = await loadLastTurn();
			expect(legacyDiff.repoRoot).toBe(f.scope.workspacePath);
			expect(legacyDiff.files).toMatchObject([
				{ path: "last-turn-implementation.txt", oldText: "Claude 前一轮", newText: "Claude 最新轮" },
			]);

			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.sweep();
			const state = await loadWorkspaceState(f.scope.workspacePath);
			const card = state.board.columns.flatMap((column) => column.cards)[0];
			const mainSessionId = card.mainTaskConversationSessionId as string;
			expect(mainSessionId).not.toBe("task-1");
			f.live[mainSessionId] = {
				...f.live[mainSessionId],
				previousTurnCheckpoint: checkpoint(mainSessionId, 1, "Codex 前一轮"),
				latestTurnCheckpoint: checkpoint(mainSessionId, 2, "Codex 最新轮"),
			};
			const handedOverDiff = await loadLastTurn();
			expect(handedOverDiff.repoRoot).toBe(f.scope.workspacePath);
			expect(handedOverDiff.files).toMatchObject([
				{ path: "last-turn-implementation.txt", oldText: "Codex 前一轮", newText: "Codex 最新轮" },
			]);

			f.live[mainSessionId] = mergeSummaryWithFacets(f.live[mainSessionId], {
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
			});
			writeFileSync(changePath, "Codex 正在实现");
			expect((await loadLastTurn()).files).toMatchObject([
				{ path: "last-turn-implementation.txt", oldText: "Codex 最新轮", newText: "Codex 正在实现" },
			]);

			f.live[mainSessionId] = {
				...f.live[mainSessionId],
				previousTurnCheckpoint: null,
				latestTurnCheckpoint: null,
			};
			expect((await loadLastTurn()).files).toEqual([]);
		}));

	it("等待源会话结束生成，关闭协调器并重建后仍会自动交接", async () =>
		fixture(async (f) => {
			f.live["task-1"] = mergeSummaryWithFacets(f.source, {
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			expect(f.startTaskSession).not.toHaveBeenCalled();
			expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
				"waiting_for_sessions_to_stop",
			);
			await coordinator.close();
			f.live["task-1"] = mergeSummaryWithFacets(f.live["task-1"], {
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "review",
			});
			const recovered = f.create();
			recovered.start();
			await vi.waitFor(() => expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1), { timeout: 15_000 });
			await vi.waitFor(async () => {
				await recovered.sweep();
				expect((await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
					"awaiting_user_message",
				);
			});
		}));

	it("忙碌时取消不会启动 Codex，原主会话保持绑定", async () =>
		fixture(async (f) => {
			f.live["task-1"] = mergeSummaryWithFacets(f.source, {
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.cancel(f.scope, { taskId: "task-1" });
			await coordinator.sweep();
			expect(f.startTaskSession).not.toHaveBeenCalled();
			expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe("cancelled");
			expect(resolveSessionFacets(f.live["task-1"]).turnOwner).toBe("agent");
		}));
	const existingPeerAgentIds = ["claude", "codex", "cursor", "kimi", "omp"] as const;
	function installExistingPeer(
		f: Awaited<ReturnType<typeof setup>>,
		agentId: (typeof existingPeerAgentIds)[number],
		sessionTransport: "pty_terminal" | "acp_stdio_subprocess" = "pty_terminal",
	) {
		const peer = runtimeTaskSessionSummarySchema.parse({
			...f.source,
			taskId: "selected-peer",
			agentId,
			sessionTransport,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: agentId,
				nativeSessionId: "selected-exact-native-id",
				transcriptPath: null,
				observedAt: 2,
			},
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "task_collaborator",
				taskConversationSessionRoleAtCreation: "task_collaborator",
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: `既有 ${agentId}`,
				taskConversationSessionLaunchSettings: {
					taskAgentPermissionMode: "ask_for_every_tool_use",
					startInPlanMode: false,
					sessionTransport,
					terminalAgentModelOverrideSettings:
						agentId === "omp"
							? undefined
							: {
									agentId,
									modelId: agentId === "cursor" ? "auto" : "peer-own-model",
								},
				},
			},
		});
		f.live[peer.taskId] = peer;
		return peer;
	}
	const existingTargetCases = existingPeerAgentIds.flatMap((agentId) =>
		(agentId === "omp" ? (["pty_terminal", "acp_stdio_subprocess"] as const) : (["pty_terminal"] as const)).flatMap(
			(sessionTransport) => [true, false].map((live) => ({ agentId, sessionTransport, live })),
		),
	);
	it.each(
		existingPeerAgentIds.flatMap((sourceAgentId) =>
			existingTargetCases.map((target) => ({ sourceAgentId, ...target })),
		),
	)(
		"$sourceAgentId → 既有 $agentId/$sessionTransport（活体=$live）保留身份与独立设置，不再次 fork",
		async ({ sourceAgentId, agentId, sessionTransport, live }) =>
			fixture(async (f) => {
				f.live["task-1"] = {
					...f.source,
					agentId: sourceAgentId,
					agentNativeConversationSessionIdentity: {
						sourceAgentId,
						nativeSessionId: "source-native-id",
						transcriptPath: null,
						observedAt: 1,
					},
				};
				const peer = installExistingPeer(f, agentId, sessionTransport);
				if (live) f.liveProcessSessionIds.add(peer.taskId);
				const coordinator = f.create();
				const input = {
					...request,
					destination: {
						kind: "existing_agent_session" as const,
						agentId,
						taskConversationSessionId: peer.taskId,
					},
				};
				await coordinator.request(f.scope, input);
				await coordinator.request(f.scope, input);
				await coordinator.sweep();
				await coordinator.sweep();
				const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(record?.status, record?.errorMessage ?? undefined).toBe("awaiting_user_message");
				expect(record?.existingTargetSessionBinding).toMatchObject({
					agentId,
					nativeSessionId: "selected-exact-native-id",
					sessionTransport,
					launchSettingsSnapshot: JSON.parse(
						JSON.stringify(peer.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings),
					),
				});
				expect(f.startTaskSession).toHaveBeenCalledTimes(live ? 0 : 1);
				if (!live)
					expect(f.startTaskSession.mock.calls[0][1]).toMatchObject({
						taskId: peer.taskId,
						agentId,
						resumePriorAgentConversationWithoutResendingPrompt: true,
						expectedExistingMainSessionHandoverTargetBinding: record?.existingTargetSessionBinding,
						requestedAgentSessionTransport: sessionTransport,
						startInPlanMode: false,
						taskAgentPermissionMode: "ask_for_every_tool_use",
						terminalAgentModelOverrideSettings:
							peer.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings
								?.terminalAgentModelOverrideSettings,
					});
				expect(f.manager.stopTaskSession).not.toHaveBeenCalled();
				expect(f.acp.stopTaskSession).not.toHaveBeenCalled();
				expect(f.prepareNativeFork).not.toHaveBeenCalled();
				expect(f.prepareTranscriptNativeFork).not.toHaveBeenCalled();
				expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
				expect(f.sendTaskChatMessage.mock.calls[0][1].taskId).toBe(peer.taskId);
				expect(f.live[peer.taskId].taskConversationSessionMetadata?.taskConversationSessionLaunchSettings).toEqual(
					peer.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings,
				);
			}),
	);
	it.each(
		(["pty_terminal", "acp_stdio_subprocess"] as const).flatMap((sessionTransport) =>
			(["exploratory", "operational", undefined] as const).map((taskConversationMode) => ({
				sessionTransport,
				taskConversationMode,
			})),
		),
	)(
		"冷恢复 $sessionTransport peer 保留 $taskConversationMode 会话模式与固定绑定",
		async ({ sessionTransport, taskConversationMode }) =>
			fixture(async (f) => {
				const peer = installExistingPeer(f, "omp", sessionTransport);
				f.live[peer.taskId] = { ...peer, taskConversationMode };
				f.live["task-1"] = mergeSummaryWithFacets(f.source, {
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
				});
				const coordinator = f.create();
				await coordinator.request(f.scope, {
					...request,
					destination: { kind: "existing_agent_session", agentId: "omp", taskConversationSessionId: peer.taskId },
				});
				await coordinator.close();
				// 模拟跨运行时恢复：服务注册表为空，只保留接单时持久化的 peer。
				delete f.live[peer.taskId];
				f.live["task-1"] = f.source;
				const recovered = f.create();
				recovered.start();
				await vi.waitFor(
					async () => {
						await recovered.sweep();
						expect((await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
							"awaiting_user_message",
						);
					},
					{ timeout: 10_000 },
				);
				const expectedMode = taskConversationMode ?? "operational";
				expect(f.live[peer.taskId]?.taskConversationMode ?? "operational").toBe(expectedMode);
				const record = (await recovered.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(record?.status, record?.errorMessage ?? undefined).toBe("awaiting_user_message");
				expect(record?.existingTargetSessionBinding).toMatchObject({ taskConversationMode: expectedMode });
				expect(f.startTaskSession).toHaveBeenCalledOnce();
				expect(f.startTaskSession.mock.calls[0][1]).toMatchObject({
					taskId: peer.taskId,
					taskConversationMode: expectedMode,
					requestedAgentSessionTransport: sessionTransport,
					resumePriorAgentConversationWithoutResendingPrompt: true,
				});
				expect(f.live[peer.taskId]?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
					"selected-exact-native-id",
				);
				expect(f.sendTaskChatMessage).toHaveBeenCalledOnce();
			}),
	);
	it.each(["pty_terminal", "acp_stdio_subprocess"] as const)(
		"旧 %s peer 绑定缺少会话模式时仍按自身 exploratory 模式冷恢复",
		async (sessionTransport) =>
			fixture(async (f) => {
				const peer = installExistingPeer(f, "omp", sessionTransport);
				f.live[peer.taskId] = { ...peer, taskConversationMode: "exploratory" };
				f.live["task-1"] = mergeSummaryWithFacets(f.source, {
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
				});
				const coordinator = f.create();
				await coordinator.request(f.scope, {
					...request,
					destination: { kind: "existing_agent_session", agentId: "omp", taskConversationSessionId: peer.taskId },
				});
				await coordinator.close();
				await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards: column.cards.map((card) => {
								const record = card.taskMainSessionHandover;
								const binding = record?.existingTargetSessionBinding;
								assert(record && binding);
								const legacyBinding = { ...binding };
								delete legacyBinding.taskConversationMode;
								return {
									...card,
									taskMainSessionHandover: {
										...record,
										existingTargetSessionBinding: legacyBinding,
									},
								};
							}),
						})),
					},
					value: null,
				}));
				delete f.live[peer.taskId];
				f.live["task-1"] = f.source;
				const recovered = f.create();
				recovered.start();
				await vi.waitFor(
					async () => {
						await recovered.sweep();
						expect((await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
							"awaiting_user_message",
						);
					},
					{ timeout: 10_000 },
				);
				const record = (await recovered.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(record?.status, record?.errorMessage ?? undefined).toBe("awaiting_user_message");
				expect(f.live[peer.taskId]?.taskConversationMode).toBe("exploratory");
				expect(f.startTaskSession.mock.calls[0][1].taskConversationMode).toBe("exploratory");
			}),
	);
	it.each(["pty_terminal", "acp_stdio_subprocess"] as const)(
		"%s peer 切主后、启动前会话模式漂移时禁止启动与报告投递",
		async (sessionTransport) =>
			fixture(async (f) => {
				const peer = installExistingPeer(f, "omp", sessionTransport);
				f.live[peer.taskId] = { ...peer, taskConversationMode: "exploratory" };
				let modeChanged = false;
				f.broadcastState.mockImplementation(async () => {
					const card = findFixtureTaskCard((await loadWorkspaceState(f.scope.workspacePath)).board);
					if (modeChanged || card.taskMainSessionHandover?.status !== "report_delivery_pending") return;
					modeChanged = true;
					f.live[peer.taskId] = { ...f.live[peer.taskId], taskConversationMode: "operational" };
				});
				const coordinator = f.create();
				await coordinator.request(f.scope, {
					...request,
					destination: { kind: "existing_agent_session", agentId: "omp", taskConversationSessionId: peer.taskId },
				});
				await coordinator.sweep();
				expect(modeChanged).toBe(true);
				const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(record?.automaticRecovery?.classification).toBe("execution_prohibited");
				expect(f.startTaskSession).not.toHaveBeenCalled();
				expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
			}),
	);
	it.each(
		(["pty_terminal", "acp_stdio_subprocess"] as const).flatMap((sessionTransport) =>
			(["request_mode", "summary_mode_before_spawn"] as const).map((driftStage) => ({
				sessionTransport,
				driftStage,
			})),
		),
	)("真实 runtime 在 $sessionTransport 的 $driftStage 模式漂移时阻止启动", async ({ sessionTransport, driftStage }) =>
		fixture(async (f) => {
			// 只检查启动门禁接线，不依赖宿主装有 Agent；transport 在进程启动点前被替换。
			const binaryAvailability = vi.spyOn(commandDiscovery, "isBinaryAvailableOnPath").mockReturnValue(true);
			onTestFinished(() => binaryAvailability.mockRestore());
			const peer = installExistingPeer(f, "omp", sessionTransport);
			f.live[peer.taskId] = { ...peer, taskConversationMode: "exploratory" };
			const spawnedProcess = vi.fn();
			let runtimeStartResponse: RuntimeTaskSessionStartResponse | undefined;
			const revalidateBeforeSpawning = async (input: {
				revalidateExistingMainSessionHandoverTargetBeforeLaunch?: () => Promise<void>;
			}): Promise<never> => {
				f.live[peer.taskId] = { ...f.live[peer.taskId], taskConversationMode: "operational" };
				assert(input.revalidateExistingMainSessionHandoverTargetBeforeLaunch);
				await input.revalidateExistingMainSessionHandoverTargetBeforeLaunch();
				spawnedProcess();
				throw new Error("会话模式漂移后不应到达进程启动点");
			};
			const terminalStart = vi.fn(revalidateBeforeSpawning);
			const acpStart = vi.fn(revalidateBeforeSpawning);
			const unexpectedServiceAccess = async (): Promise<never> => {
				throw new Error("既有 peer 恢复不应访问其他 Agent 服务");
			};
			const api = createRuntimeApi({
				getActiveWorkspaceId: () => f.scope.workspaceId,
				loadScopedRuntimeConfig: async () => await loadRuntimeConfig(f.scope.workspacePath),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: async () =>
					({ ...f.manager, startTaskSession: terminalStart }) as unknown as TerminalSessionManager,
				getScopedClineTaskSessionService: unexpectedServiceAccess,
				getScopedAcpTaskSessionService: async () =>
					({ ...f.acp, startTaskSession: acpStart }) as unknown as AcpTaskSessionService,
				resolveInteractiveShellCommand: () => {
					throw new Error("既有 peer 恢复不应启动交互 shell");
				},
				runCommand: unexpectedServiceAccess,
				getUpdateStatus: vi.fn(),
				runUpdateNow: unexpectedServiceAccess,
			});
			f.startTaskSession.mockImplementationOnce(async (scope, input) => {
				runtimeStartResponse = await api.startTaskSession(scope, {
					...input,
					taskConversationMode: driftStage === "request_mode" ? "operational" : "exploratory",
				});
				return runtimeStartResponse;
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "existing_agent_session", agentId: "omp", taskConversationSessionId: peer.taskId },
			});
			await coordinator.sweep();
			expect(f.startTaskSession).toHaveBeenCalledOnce();
			expect(runtimeStartResponse?.ok).toBe(false);
			expect(runtimeStartResponse?.error).toContain(
				driftStage === "request_mode" ? "固定身份、主绑定或执行资格已改变" : "会话模式或启动设置已改变",
			);
			expect(terminalStart).toHaveBeenCalledTimes(
				driftStage === "summary_mode_before_spawn" && sessionTransport === "pty_terminal" ? 1 : 0,
			);
			expect(acpStart).toHaveBeenCalledTimes(
				driftStage === "summary_mode_before_spawn" && sessionTransport === "acp_stdio_subprocess" ? 1 : 0,
			);
			expect(spawnedProcess).not.toHaveBeenCalled();
			expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
		}),
	);
	it.each(["question", "permission", "plan_review", "needs_input"] as const)(
		"既有 peer 的未决 %s 持久等待，解除后原活体接任",
		async (userTurnKind) =>
			fixture(async (f) => {
				const peer = installExistingPeer(f, "claude");
				f.liveProcessSessionIds.add(peer.taskId);
				f.live[peer.taskId] = mergeSummaryWithFacets(peer, { turnOwner: "user", liveness: "live", userTurnKind });
				const coordinator = f.create();
				await coordinator.request(f.scope, {
					...request,
					destination: {
						kind: "existing_agent_session",
						agentId: "claude",
						taskConversationSessionId: peer.taskId,
					},
				});
				await coordinator.sweep();
				expect((await coordinator.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
					"waiting_for_sessions_to_stop",
				);
				expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
				await coordinator.close();
				f.live[peer.taskId] = mergeSummaryWithFacets(peer, {
					turnOwner: "user",
					liveness: "live",
					userTurnKind: "review",
				});
				const recovered = f.create();
				recovered.start();
				await vi.waitFor(
					async () => {
						await recovered.sweep();
						expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
					},
					{ timeout: 5000 },
				);
				expect(f.startTaskSession).not.toHaveBeenCalled();
			}),
	);
	const existingMainSessionHandoverPeerBindingFieldsRevalidatedDuringMaterialPreparation = [
		"nativeSessionId",
		"workspacePath",
		"sessionTransport",
		"settings",
		"ownership",
		"taskConversationMode",
	] as const;
	it.each(existingMainSessionHandoverPeerBindingFieldsRevalidatedDuringMaterialPreparation)(
		"材料准备期间 peer 的 %s 改变会禁止切主和投递",
		async (change) =>
			fixture(async (f) => {
				const peer = installExistingPeer(f, "omp");
				f.beforeLoadingScopedRuntimeConfig.mockImplementationOnce(async () => {
					const current = f.live[peer.taskId];
					const metadata = current.taskConversationSessionMetadata;
					const identity = current.agentNativeConversationSessionIdentity;
					const launchSettings = metadata?.taskConversationSessionLaunchSettings;
					if (!metadata || !identity || !launchSettings) throw new Error("测试 peer 缺少固定身份或设置");
					if (change === "nativeSessionId")
						f.live[peer.taskId] = {
							...current,
							agentNativeConversationSessionIdentity: {
								...identity,
								nativeSessionId: "changed-native-id",
							},
						};
					else if (change === "workspacePath")
						f.live[peer.taskId] = { ...current, workspacePath: `${f.scope.workspacePath}/changed` };
					else if (change === "sessionTransport")
						f.live[peer.taskId] = { ...current, sessionTransport: "acp_stdio_subprocess" };
					else if (change === "taskConversationMode")
						f.live[peer.taskId] = { ...current, taskConversationMode: "exploratory" };
					else
						f.live[peer.taskId] = {
							...current,
							taskConversationSessionMetadata: {
								...metadata,
								...(change === "ownership"
									? { workspaceTaskId: "other-task" }
									: {
											taskConversationSessionLaunchSettings: {
												...launchSettings,
												startInPlanMode: true,
											},
										}),
							},
						};
				});
				const coordinator = f.create();
				await coordinator.request(f.scope, {
					...request,
					destination: { kind: "existing_agent_session", agentId: "omp", taskConversationSessionId: peer.taskId },
				});
				await coordinator.sweep();
				const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
				expect(record?.automaticRecovery?.classification).toBe("execution_prohibited");
				expect(
					findFixtureTaskCard((await loadWorkspaceState(f.scope.workspacePath)).board)
						.mainTaskConversationSessionId,
				).toBeUndefined();
				expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
				expect(f.startTaskSession).not.toHaveBeenCalled();
			}),
	);

	it("A → B → A 允许前主会话按自身原生身份回任", async () =>
		fixture(async (f) => {
			const peer = installExistingPeer(f, "codex");
			f.liveProcessSessionIds.add("task-1");
			f.liveProcessSessionIds.add(peer.taskId);
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "existing_agent_session", agentId: "codex", taskConversationSessionId: peer.taskId },
			});
			await coordinator.sweep();
			await coordinator.sweep();
			await completeTaskMainSessionHandoverAfterUserMessage({
				...f.scope,
				taskConversationSessionId: peer.taskId,
				promptText: "返回原主线",
			});
			const originalSettings =
				f.live["task-1"].taskConversationSessionMetadata?.taskConversationSessionLaunchSettings;
			await coordinator.request(f.scope, {
				...request,
				expectedMainTaskConversationSessionId: peer.taskId,
				requestId: "55555555-5555-4555-8555-555555555555",
				destination: { kind: "existing_agent_session", agentId: "claude", taskConversationSessionId: "task-1" },
			});
			await coordinator.sweep();
			await coordinator.sweep();
			const record = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(record?.status, record?.errorMessage ?? undefined).toBe("awaiting_user_message");
			expect(record?.targetTaskConversationSessionId).toBe("task-1");
			expect(f.live["task-1"].taskConversationSessionMetadata?.taskConversationSessionRoleAtCreation).toBe("main");
			expect(f.live["task-1"].taskConversationSessionMetadata?.taskConversationSessionLaunchSettings).toEqual(
				originalSettings,
			);
			expect(f.startTaskSession).not.toHaveBeenCalled();
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(2);
		}));
	it("五种候选显示可用性，排除当前主线、By the way 与其他 Task", async () =>
		fixture(async (f) => {
			for (const agentId of existingPeerAgentIds) {
				const peer = installExistingPeer(f, agentId);
				f.live[`peer-${agentId}`] = { ...peer, taskId: `peer-${agentId}` };
			}
			delete f.live["selected-peer"];
			f.live["peer-kimi"] = { ...f.live["peer-kimi"], agentNativeConversationSessionIdentity: undefined };
			const valid = f.live["peer-claude"];
			if (!valid.taskConversationSessionMetadata) throw new Error("测试 peer 缺少归属");
			f.live["by-the-way"] = {
				...valid,
				taskId: "by-the-way",
				taskConversationSessionMetadata: {
					...valid.taskConversationSessionMetadata,
					taskConversationSessionRole: "by_the_way",
				},
			};
			f.live["other-task"] = {
				...valid,
				taskId: "other-task",
				taskConversationSessionMetadata: {
					...valid.taskConversationSessionMetadata,
					workspaceTaskId: "other-task",
				},
			};
			const coordinator = f.create();
			const preview = await coordinator.prepare(f.scope, { taskId: "task-1" });
			expect(preview.existingPeerCandidates?.map((entry) => entry.agentId)).toEqual(existingPeerAgentIds);
			expect(preview.existingPeerCandidates?.find((entry) => entry.agentId === "kimi")).toMatchObject({
				available: false,
				unavailableReason: "等待可靠的原生会话身份。",
			});
			await expect(
				coordinator.request(f.scope, {
					...request,
					destination: {
						kind: "existing_agent_session",
						agentId: "codex",
						taskConversationSessionId: valid.taskId,
					},
				}),
			).rejects.toThrow("Agent 与请求不符");
		}));

	it("既有 peer 的显式新建恢复保留 Agent、清除旧绑定并保存旧现场", async () =>
		fixture(async (f) => {
			const peer = installExistingPeer(f, "kimi");
			f.liveProcessSessionIds.add(peer.taskId);
			f.sendTaskChatMessage.mockRejectedValueOnce(new Error("原报告提交结果未知"));
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "existing_agent_session", agentId: "kimi", taskConversationSessionId: peer.taskId },
			});
			await coordinator.sweep();
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(failed);
			expect(failed.status).toBe("failed");
			await coordinator.recoverWithNewAgentSession(f.scope, {
				taskId: "task-1",
				expectedHandoverId: failed.handoverId,
				expectedReportDeliveryAttempt: failed.reportDeliveryAttempt,
				requestId: "77777777-7777-4777-8777-777777777777",
				acknowledgePossibleDuplicateReport: true,
			});
			await coordinator.sweep();
			await coordinator.sweep();
			const restored = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(restored);
			expect(restored.status, restored.errorMessage ?? undefined).toBe("awaiting_user_message");
			expect(restored.destination).toEqual({ kind: "new_agent_session", agentId: "kimi" });
			expect(restored.existingTargetSessionBinding).toBeUndefined();
			expect(restored.targetTaskConversationSessionId).not.toBe(peer.taskId);
			const receipt = restored.recoveryReceipts?.[0];
			assert(receipt);
			expect(
				JSON.parse(await readFile(receipt.receiptFilePath, "utf8")).previousHandoverRecord
					.existingTargetSessionBinding,
			).toEqual(failed.existingTargetSessionBinding);
			expect(f.live[peer.taskId].agentNativeConversationSessionIdentity).toEqual(
				peer.agentNativeConversationSessionIdentity,
			);
			expect(f.prepareNativeFork).not.toHaveBeenCalled();
			expect(f.prepareTranscriptNativeFork).not.toHaveBeenCalled();
		}));
	it("既有 peer 的未知投递跨重启只补证，不重发或再次启动", async () =>
		fixture(async (f) => {
			const peer = installExistingPeer(f, "claude");
			f.liveProcessSessionIds.add(peer.taskId);
			f.sendTaskChatMessage.mockRejectedValueOnce(new Error("报告回执未知"));
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "existing_agent_session", agentId: "claude", taskConversationSessionId: peer.taskId },
			});
			await coordinator.sweep();
			await coordinator.close();
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(failed);
			f.queryReportAcceptance.mockImplementation(async (input) => ({
				...input.probe,
				historicalAcceptanceEvidence: { sourceReference: "原 peer 的可信原生用户记录", observedAt: Date.now() },
			}));
			f.advanceRecoveryClock(15_000);
			const recovered = f.create();
			recovered.start();
			await vi.waitFor(
				async () => {
					await recovered.sweep();
					expect((await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
						"awaiting_user_message",
					);
				},
				{ timeout: 10_000 },
			);
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
			expect(f.startTaskSession).not.toHaveBeenCalled();
			expect(
				(await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.existingTargetSessionBinding,
			).toEqual(failed.existingTargetSessionBinding);
		}));
	it("既有 peer 切主后启动失败，重启仍只恢复同一原生 ID", async () =>
		fixture(async (f) => {
			const peer = installExistingPeer(f, "omp", "acp_stdio_subprocess");
			f.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "模拟连接暂不可用" });
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "existing_agent_session", agentId: "omp", taskConversationSessionId: peer.taskId },
			});
			await coordinator.sweep();
			await coordinator.close();
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			assert(failed);
			expect(failed.status).toBe("failed");
			expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
			f.advanceRecoveryClock(15_000);
			const recovered = f.create();
			recovered.start();
			await vi.waitFor(
				async () => {
					await recovered.sweep();
					expect((await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe(
						"awaiting_user_message",
					);
				},
				{ timeout: 10_000 },
			);
			expect(f.startTaskSession).toHaveBeenCalledTimes(2);
			for (const [, input] of f.startTaskSession.mock.calls)
				expect(input).toMatchObject({
					taskId: peer.taskId,
					agentId: "omp",
					resumePriorAgentConversationWithoutResendingPrompt: true,
					expectedExistingMainSessionHandoverTargetBinding: failed.existingTargetSessionBinding,
				});
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
			expect(f.prepareTranscriptNativeFork).not.toHaveBeenCalled();
		}));
	it("既有 peer 的显式 Stop 跨协调器重启仍阻止自动接任", async () =>
		fixture(async (f) => {
			const peer = installExistingPeer(f, "claude");
			f.liveProcessSessionIds.add(peer.taskId);
			f.live[peer.taskId] = mergeSummaryWithFacets(peer, {
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "existing_agent_session", agentId: "claude", taskConversationSessionId: peer.taskId },
			});
			await coordinator.sweep();
			await coordinator.pauseForExplicitStop(f.scope.workspaceId, peer.taskId);
			await coordinator.close();
			f.live[peer.taskId] = mergeSummaryWithFacets(peer, {
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "review",
			});
			f.advanceRecoveryClock(60_000);
			const recovered = f.create();
			recovered.start();
			await recovered.sweep();
			await recovered.close();
			const record = (await recovered.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(record?.status).toBe("failed");
			expect(record?.automaticRecovery?.classification).toBe("execution_prohibited");
			expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
			expect(f.startTaskSession).not.toHaveBeenCalled();
		}));

	it("已有 Codex 仍在生成时等待，随后精确续跑该 peer 而不再创建会话", async () =>
		fixture(async (f) => {
			f.live["task-1"] = {
				...f.source,
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "main",
					taskConversationSessionContextSource: "main",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
					taskConversationSessionLaunchSettings: {
						taskAgentPermissionMode: "ask_for_every_tool_use",
						sessionTransport: "pty_terminal",
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "own-source-model" },
					},
				},
			};
			const peer = runtimeTaskSessionSummarySchema.parse({
				...f.source,
				taskId: "codex-peer",
				agentId: "codex",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: "peer-native-identity",
					transcriptPath: null,
					observedAt: 2,
				},
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
					taskConversationSessionLaunchSettings: {
						taskAgentPermissionMode: "ask_for_every_tool_use",
						sessionTransport: "pty_terminal",
						terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "own-peer-model" },
					},
				},
			});
			f.live[peer.taskId] = mergeSummaryWithFacets(peer, {
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, {
				...request,
				destination: { kind: "existing_codex_session", taskConversationSessionId: peer.taskId },
			});
			await coordinator.sweep();
			expect(f.startTaskSession).not.toHaveBeenCalled();
			f.live[peer.taskId] = mergeSummaryWithFacets(f.live[peer.taskId], {
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "review",
			});
			await coordinator.sweep();
			await coordinator.sweep();
			expect(f.startTaskSession.mock.calls[0][1]).toMatchObject({
				taskId: peer.taskId,
				resumePriorAgentConversationWithoutResendingPrompt: true,
				taskAgentPermissionMode: "ask_for_every_tool_use",
				terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "own-peer-model" },
			});
			const card = (await loadWorkspaceState(f.scope.workspacePath)).board.columns.flatMap(
				(column) => column.cards,
			)[0];
			expect(card.mainTaskConversationSessionId).toBe(peer.taskId);
			expect(f.live["task-1"].taskConversationSessionMetadata?.taskConversationSessionRole).toBe(
				"task_collaborator",
			);
			expect(f.live["task-1"].taskConversationSessionMetadata?.taskConversationSessionLaunchSettings).toMatchObject({
				taskAgentPermissionMode: "ask_for_every_tool_use",
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "own-source-model" },
			});
			expect(f.live[peer.taskId].taskConversationSessionMetadata?.taskConversationSessionRoleAtCreation).toBe(
				"task_collaborator",
			);
		}));

	it.each([false, true])("首次启动前已原子保存双方快照，旧卡权限跟随有效全局值=%s", async (autonomousMode) =>
		fixture(async (f) => {
			await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((card) => ({
							...card,
							taskAgentPermissionMode: undefined,
							terminalAgentModelOverrideSettings: { agentId: "claude" as const, modelId: "source-claude-model" },
						})),
					})),
				},
				value: null,
			}));
			const expectedPermission = autonomousMode ? "bypass_all_permission_prompts" : "ask_for_every_tool_use";
			f.startTaskSession.mockImplementationOnce(async (_scope, input) => {
				// 直接检查首次 start 入口之前的落盘态，模拟切主后、写 launch settings 前的崩溃窗口。
				const persisted = await loadWorkspaceState(f.scope.workspacePath);
				const card = persisted.board.columns.flatMap((column) => column.cards)[0];
				expect(card.mainTaskConversationSessionId).toBe(input.taskId);
				expect(persisted.sessions[input.taskId]).toMatchObject({
					startedAt: null,
					agentId: "codex",
					taskConversationSessionMetadata: {
						taskConversationSessionRole: "main",
						taskConversationSessionRoleAtCreation: "task_collaborator",
						taskConversationSessionLaunchSettings: {
							taskAgentPermissionMode: expectedPermission,
							sessionTransport: "pty_terminal",
						},
					},
				});
				expect(persisted.sessions["task-1"].taskConversationSessionMetadata).toMatchObject({
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionRoleAtCreation: "main",
					taskConversationSessionLaunchSettings: {
						taskAgentPermissionMode: expectedPermission,
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "source-claude-model" },
					},
				});
				expect(f.live["task-1"].taskConversationSessionMetadata?.taskConversationSessionLaunchSettings).toEqual(
					persisted.sessions["task-1"].taskConversationSessionMetadata?.taskConversationSessionLaunchSettings,
				);
				return { ok: false, summary: null, error: "模拟首次 spawn 前中断" };
			});
			const coordinator = f.create(autonomousMode);
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			expect(f.startTaskSession).toHaveBeenCalledTimes(1);
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(failed?.status).toBe("failed");
			expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
			await coordinator.retry(f.scope, { taskId: "task-1" });
			await coordinator.sweep();
			expect(f.startTaskSession.mock.calls[1][1]).toMatchObject({
				taskId: failed?.targetTaskConversationSessionId,
				taskAgentPermissionMode: expectedPermission,
			});
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
		}),
	);

	it("启动失败后重试复用已保留的目标 session，只投递一次汇报", async () =>
		fixture(async (f) => {
			f.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "模拟 Codex 启动失败" });
			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			const failed = (await coordinator.getStatus(f.scope, { taskId: "task-1" })).record;
			expect(failed?.status).toBe("failed");
			expect(f.sendTaskChatMessage).not.toHaveBeenCalled();
			await coordinator.retry(f.scope, { taskId: "task-1" });
			await coordinator.sweep();
			await coordinator.sweep();
			expect(f.startTaskSession).toHaveBeenCalledTimes(2);
			expect(f.startTaskSession.mock.calls[1][1].taskId).toBe(failed?.targetTaskConversationSessionId);
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
		}));

	it("投递回执跨重启仍不确定时停止自动重放，并允许用户直接接续", async () =>
		fixture(async (f) => {
			f.sendTaskChatMessage.mockResolvedValueOnce({
				ok: true,
				summary: null,
				terminalDelivery: { status: "accepted_pending_submit_confirmation", reason: null },
			});
			const coordinator = f.create();
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.close();
			const recovered = f.create();
			recovered.start();
			await vi.waitFor(async () =>
				expect((await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe("failed"),
			);
			await expect(recovered.retry(f.scope, { taskId: "task-1" })).rejects.toThrow("上次投递可能已经发生");
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
			const record = (await recovered.getStatus(f.scope, { taskId: "task-1" })).record;
			await completeTaskMainSessionHandoverAfterUserMessage({
				...f.scope,
				taskConversationSessionId: record?.targetTaskConversationSessionId as string,
				promptText: "检查交接材料后汇报",
			});
			expect((await recovered.getStatus(f.scope, { taskId: "task-1" })).record?.status).toBe("completed");
		}));

	it("并发的不同交接请求只有一个获得主绑定，不重复创建", async () =>
		fixture(async (f) => {
			const coordinator = f.create();
			const outcomes = await Promise.allSettled([
				coordinator.request(f.scope, request),
				coordinator.request(f.scope, { ...request, requestId: "44444444-4444-4444-8444-444444444444" }),
			]);
			expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			await coordinator.sweep();
			await coordinator.sweep();
			expect(f.startTaskSession).toHaveBeenCalledTimes(1);
		}));

	it("尚无原生身份的旧 Claude 空壳仍能交接，并明确列出材料缺失", async () =>
		fixture(async (f) => {
			f.live["task-1"] = { ...f.source, agentNativeConversationSessionIdentity: undefined };
			const coordinator = f.create();
			const preview = await coordinator.prepare(f.scope, { taskId: "task-1" });
			expect(preview.material.transcriptReferences).toEqual([]);
			expect(preview.material.missingMaterialDescriptions.join("\n")).toContain("原生身份");
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.sweep();
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
		}));

	it("只把与成功 ExitPlanMode 回执正文逐字一致的计划标为已批准", async () =>
		fixture(async (f) => {
			const transcript = f.source.agentNativeConversationSessionIdentity?.transcriptPath as string;
			const planPath = (await f.create().prepare(f.scope, { taskId: "task-1" })).material.planReferences[0]
				.absolutePath;
			const plan = await readFile(planPath, "utf8");
			writeFileSync(
				transcript,
				[
					JSON.stringify({
						type: "assistant",
						message: {
							content: [{ type: "tool_use", name: "ExitPlanMode", id: "approved-plan", input: { plan } }],
						},
					}),
					JSON.stringify({
						type: "user",
						message: {
							content: [
								{ type: "tool_result", tool_use_id: "approved-plan", content: "User has approved your plan." },
							],
						},
					}),
				].join("\n"),
			);
			const preview = await f.create().prepare(f.scope, { taskId: "task-1" });
			expect(preview.material.planReferences[0]).toMatchObject({ approvalStatus: "approved" });
			writeFileSync(planPath, `${plan}新增未批准的内容`);
			expect(
				(await f.create().prepare(f.scope, { taskId: "task-1" })).material.planReferences[0].approvalStatus,
			).toBe("unconfirmed");
		}));
	it("旧会话 summary 已缺失时，保留主卡确切 Claude 声明并允许缺失材料交接", async () =>
		fixture(async (f) => {
			delete f.live["task-1"];
			await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((card) => ({ ...card, agentId: "claude" as const })),
					})),
				},
				sessions: {},
				value: null,
			}));
			const stateWithoutSource = await loadWorkspaceState(f.scope.workspacePath);
			await savePersistedWorkspaceSessionsById(f.scope.workspaceId, {}, stateWithoutSource.revision);
			const coordinator = f.create();
			const preview = await coordinator.prepare(f.scope, { taskId: "task-1" });
			expect(preview.material.sourceTaskConversationSessionId).toBe("task-1");
			expect(preview.material.missingMaterialDescriptions.length).toBeGreaterThan(0);
			await coordinator.request(f.scope, request);
			await coordinator.sweep();
			await coordinator.sweep();
			expect(f.sendTaskChatMessage).toHaveBeenCalledTimes(1);
		}));
});
