import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { createTaskMainSessionHandoverCoordinator } from "../../src/server/task-main-session-handover-coordinator";
import { completeTaskMainSessionHandoverAfterUserMessage } from "../../src/state/complete-task-main-session-handover-after-user-message";
import {
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
	savePersistedWorkspaceSessionsById,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";
import type { RuntimeTrpcWorkspaceScope } from "../../src/trpc/app-router";
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
		const manager = {
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
				const summary = runtimeTaskSessionSummarySchema.parse({
					...source,
					taskId: input.taskId,
					agentId: "codex",
					taskConversationSessionMetadata: input.taskConversationSessionMetadata,
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: "22222222-2222-4222-8222-222222222222",
						transcriptPath: null,
						observedAt: 2,
					},
				});
				live[input.taskId] = summary;
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
		const create = (agentAutonomousModeEnabled = true) => {
			const coordinator = createTaskMainSessionHandoverCoordinator({
				getTerminalManager: async () => manager,
				loadScopedRuntimeConfig: async () => ({ agentAutonomousModeEnabled }),
				startTaskSession,
				sendTaskChatMessage,
				serializer: createTaskCardActionPerTaskCommandSerializer(),
				runCommand: async () => ({
					exitCode: 0,
					stdout: "现场工作区状态",
					stderr: "",
					combinedOutput: "",
					durationMs: 1,
				}),
				broadcastState: vi.fn(),
				warn: vi.fn(),
			});
			coordinators.push(coordinator);
			return coordinator;
		};
		return {
			scope,
			live,
			source,
			board,
			repository,
			manager,
			startTaskSession,
			sendTaskChatMessage,
			create,
			coordinators,
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
