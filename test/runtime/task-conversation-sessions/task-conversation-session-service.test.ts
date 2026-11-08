import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type RuntimeBoardCard,
	type RuntimeBoardData,
	type RuntimeTaskChatMessage,
	type RuntimeTaskSessionSummary,
	runtimeTaskConversationSessionCreateRequestSchema,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import type { KanbanRequestOriginActorEvidence } from "../../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { createTaskConversationSessionOperationStore } from "../../../src/task-conversation-sessions/task-conversation-session-operation-store";
import {
	createTaskConversationSessionService,
	type TaskConversationSessionServiceDependencies,
} from "../../../src/task-conversation-sessions/task-conversation-session-service";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const scope = { workspaceId: "workspace", workspacePath: "/repo" };
const human: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
};
function summary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return runtimeTaskSessionSummarySchema.parse({
		taskId,
		state: "awaiting_review",
		turnOwner: "user",
		userTurnKind: "review",
		liveness: "live",
		agentId: "codex",
		workspacePath: "/repo",
		pid: 42,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: `${taskId}-native`,
			transcriptPath: null,
			observedAt: 1,
		},
		...overrides,
	});
}
function actor(source: RuntimeTaskSessionSummary): KanbanRequestOriginActorEvidence {
	return {
		decodedCliActorClaimsRequestHeader: {
			cliActorClaimsRequestHeaderStatus: "present",
			claims: {
				claimedEnvironmentVariableValuesByName: {
					KANBAN_TASK_ID: "host-task",
					KANBAN_TASK_CONVERSATION_SESSION_ID: source.taskId,
					CODEX_THREAD_ID: source.agentNativeConversationSessionIdentity?.nativeSessionId ?? "",
				},
				invokingKanbanCliCodeVersion: "test",
				invokingProcessWorkingDirectory: "/repo",
			},
		},
	};
}
async function fixture() {
	const storageRootDirectoryPath = await mkdtemp(join(tmpdir(), "task-conversation-operations-test-"));
	directories.push(storageRootDirectoryPath);
	const card = {
		id: "host-task",
		title: "宿主",
		prompt: "主线",
		createdAt: 1,
		updatedAt: 1,
		baseRef: "main",
		startInPlanMode: false,
		taskAgentPermissionMode: "ask_for_every_tool_use",
	} as RuntimeBoardCard;
	const state = {
		board: { columns: [{ id: "in_progress", cards: [card] }] } as RuntimeBoardData,
		sessions: {
			"host-task": summary("host-task", { state: "running", turnOwner: "agent", userTurnKind: null }),
		} as Record<string, RuntimeTaskSessionSummary>,
	};
	let clock = 1000;
	let messages: RuntimeTaskChatMessage[] = [];
	const startSession = vi.fn<TaskConversationSessionServiceDependencies["startSession"]>(
		async (_scope, request, beforeLaunch) => {
			await beforeLaunch();
			const created = summary(request.taskId, {
				agentId: request.agentId,
				taskConversationSessionMetadata: request.taskConversationSessionMetadata,
				startedAt: clock,
				updatedAt: clock,
			});
			state.sessions[created.taskId] = created;
			return { ok: true, summary: created };
		},
	);
	const enqueueReport = vi.fn<TaskConversationSessionServiceDependencies["enqueueReport"]>(async () => ({
		ok: true,
		injectionLedgerRecordDisposition: "created",
	}));
	const resumeSession = vi.fn<TaskConversationSessionServiceDependencies["resumeSession"]>(
		async (_scope, target, beforeLaunch) => {
			await beforeLaunch({ ...target, runtimeSessionIncarnationId: "resumed-generation" });
			state.sessions[target.taskId] = { ...target, liveness: "live", pid: 43 };
			return { ok: true, summary: state.sessions[target.taskId] };
		},
	);
	const dependencies: TaskConversationSessionServiceDependencies = {
		storageRootDirectoryPath,
		verifyAssistantReportOrigin: async () => ({ status: "verified", nextCursor: null }),
		cancelReport: async () => undefined,
		now: () => clock,
		readState: async () => state,
		startSession,
		resumeSession,
		stopResumedSession: async () => ({ cancellationRequested: false, processExitConfirmed: false }),
		enqueueReport,
		readHistory: async () => ({ availability: "available", messages, nextCursor: null, notice: null }),
		readReportAcceptance: async (_scope, _taskId, key) =>
			enqueueReport.mock.calls.some((call) => call[1].idempotencyKey === key) ? "pending" : null,
	};
	return {
		state,
		card,
		dependencies,
		startSession,
		enqueueReport,
		resumeSession,
		service: createTaskConversationSessionService(dependencies),
		setMessages: (next: RuntimeTaskChatMessage[]) => {
			messages = next;
		},
		advance: (ms: number) => {
			clock += ms;
		},
	};
}
function request(overrides: Record<string, unknown> = {}) {
	return runtimeTaskConversationSessionCreateRequestSchema.parse({
		taskId: "host-task",
		startInPlanMode: false,
		sessionRole: "task_collaborator",
		creationReason: "独立检查",
		idempotencyKey: "same-creation",
		initialMessage: "检查边界",
		...overrides,
	});
}

describe("精确侧会话的持久Stop只读事实", () => {
	it("启动准备悬而未决且无摘要时，持久撤销阻断原创建的实际启动", async () => {
		const f = await fixture();
		let releasePreparation: () => void = () => undefined;
		const preparation = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let processLaunches = 0;
		f.startSession.mockImplementationOnce(async (_scope, launchRequest, beforeLaunch) => {
			await preparation;
			await beforeLaunch();
			processLaunches++;
			return { ok: true, summary: summary(launchRequest.taskId) };
		});
		const creationRequest = request({ expectedTaskIncarnationCreatedAtEpochMs: 1 });
		const pendingCreation = f.service.create(scope, creationRequest, human);
		try {
			await vi.waitFor(() => expect(f.startSession).toHaveBeenCalledTimes(1));
			const reserved = await f.service.lookupCreation(scope, creationRequest);
			const sessionId = reserved?.creation?.taskConversationSessionId;
			if (!sessionId) throw new Error("缺少持久预留side身份");
			expect(reserved?.summary).toBeNull();
			await f.service.recordExplicitStop(scope, sessionId);
			expect(await f.service.get(scope, { taskId: f.card.id, taskConversationSessionId: sessionId })).toMatchObject({
				summary: null,
				taskConversationSessionExplicitlyStopped: true,
			});
		} finally {
			releasePreparation();
		}
		expect(await pendingCreation).toMatchObject({
			ok: true,
			creation: { status: "execution_prohibited" },
			summary: null,
		});
		expect(processLaunches).toBe(0);
	});
	it("自然退出及单独宿主或创建者marker不冒充该side已停止", async () => {
		const f = await fixture();
		const created = await f.service.create(scope, request(), human);
		const sessionId = created.creation?.taskConversationSessionId;
		if (!sessionId) throw new Error("未创建侧会话");
		f.state.sessions[sessionId].pid = null;
		f.state.sessions[sessionId].liveness = "exited";
		const store = createTaskConversationSessionOperationStore(f.dependencies.storageRootDirectoryPath);
		await store.recordExplicitStopMarkers(scope, [f.card.id, "different-creator-session"]);
		expect(await f.service.get(scope, { taskId: f.card.id, taskConversationSessionId: sessionId })).toMatchObject({
			taskConversationSessionExplicitlyStopped: false,
		});
	});
	it("读取该side持久marker，重建服务保留，只有显式启动清除后变false", async () => {
		const f = await fixture();
		const created = await f.service.create(scope, request(), human);
		const sessionId = created.creation?.taskConversationSessionId;
		if (!sessionId) throw new Error("未创建侧会话");
		await f.service.recordExplicitStop(scope, sessionId);
		const restored = createTaskConversationSessionService(f.dependencies);
		expect(await restored.get(scope, { taskId: f.card.id, taskConversationSessionId: sessionId })).toMatchObject({
			taskConversationSessionExplicitlyStopped: true,
		});
		await restored.recordExplicitSessionStart(scope, sessionId);
		expect(await restored.get(scope, { taskId: f.card.id, taskConversationSessionId: sessionId })).toMatchObject({
			taskConversationSessionExplicitlyStopped: false,
		});
	});
});

describe("精确侧会话的受限接续", () => {
	async function resumableFixture() {
		const f = await fixture();
		const created = await f.service.create(scope, request({ expectedTaskIncarnationCreatedAtEpochMs: 1 }), human);
		expect(created.ok, JSON.stringify(created)).toBe(true);
		const sessionId = created.creation?.taskConversationSessionId;
		if (!sessionId) throw new Error("未预留侧会话");
		const target = f.state.sessions[sessionId];
		target.liveness = "interrupted";
		target.pid = null;
		const binding = {
			taskId: f.card.id,
			expectedTaskIncarnationCreatedAtEpochMs: 1,
			taskConversationSessionId: sessionId,
			expectedNativeConversationSessionId: target.agentNativeConversationSessionIdentity?.nativeSessionId ?? "",
		};
		return { ...f, target, binding };
	}
	it("程序化接续核对实际调用者原生身份，不冒用其他会话", async () => {
		const f = await resumableFixture();
		const evidence = actor(f.state.sessions["host-task"]);
		if (evidence.decodedCliActorClaimsRequestHeader.cliActorClaimsRequestHeaderStatus === "present")
			evidence.decodedCliActorClaimsRequestHeader.claims.claimedEnvironmentVariableValuesByName.CODEX_THREAD_ID =
				"different-caller-native";
		expect(await f.service.resume(scope, f.binding, evidence)).toMatchObject({ ok: false });
		expect(f.resumeSession).not.toHaveBeenCalled();
	});

	it("复用原生身份与已有恢复动作，不重开创建请求", async () => {
		const f = await resumableFixture();
		const result = await f.service.resume(scope, f.binding, human);
		expect(result).toMatchObject({ ok: true, status: "resumed" });
		expect(f.resumeSession).toHaveBeenCalledTimes(1);
		expect(f.resumeSession.mock.calls[0]?.[1].taskId).toBe(f.binding.taskConversationSessionId);
		expect(f.startSession).toHaveBeenCalledTimes(1);
	});

	it("显式Stop跨服务重建保持禁止，不因程序化接续清除", async () => {
		const f = await resumableFixture();
		await f.service.recordExplicitStop(scope, f.binding.taskConversationSessionId);
		const restored = createTaskConversationSessionService(f.dependencies);
		expect(await restored.resume(scope, f.binding, human)).toMatchObject({
			ok: false,
			status: "execution_prohibited",
		});
		expect(await restored.resume(scope, f.binding, human)).toMatchObject({
			ok: false,
			status: "execution_prohibited",
		});
		expect(f.resumeSession).not.toHaveBeenCalled();
	});

	it("准备期间到达的Stop在真正启动前阻断", async () => {
		const f = await resumableFixture();
		let processLaunches = 0;
		f.resumeSession.mockImplementationOnce(async (_scope, target, beforeLaunch) => {
			await f.service.recordExplicitStop(scope, target.taskId);
			await beforeLaunch({ ...target, runtimeSessionIncarnationId: "resumed-generation" });
			processLaunches++;
			return { ok: true, summary: target };
		});
		expect(await f.service.resume(scope, f.binding, human)).toMatchObject({
			ok: false,
			status: "execution_prohibited",
		});
		expect(processLaunches).toBe(0);
	});

	it.each(["task", "native", "directory"])("准备期间%s身份变化不启动替代会话", async (changedIdentity) => {
		const f = await resumableFixture();
		let processLaunches = 0;
		f.resumeSession.mockImplementationOnce(async (_scope, target, beforeLaunch) => {
			if (changedIdentity === "task") f.card.createdAt = 2;
			else if (changedIdentity === "directory") target.workspacePath = "/changed-directory";
			else if (target.agentNativeConversationSessionIdentity)
				target.agentNativeConversationSessionIdentity.nativeSessionId = "different-native";
			await beforeLaunch({ ...target, runtimeSessionIncarnationId: "resumed-generation" });
			processLaunches++;
			return { ok: true, summary: target };
		});
		expect(await f.service.resume(scope, f.binding, human)).toMatchObject({ ok: false, status: "identity_mismatch" });
		expect(processLaunches).toBe(0);
	});
});

describe("侧会话启动后的撤销与并发恢复", () => {
	async function resumableFixture() {
		const f = await fixture();
		const created = await f.service.create(scope, request({ expectedTaskIncarnationCreatedAtEpochMs: 1 }), human);
		const sessionId = created.creation?.taskConversationSessionId;
		if (!sessionId) throw new Error("未预留侧会话");
		const target = f.state.sessions[sessionId];
		target.liveness = "interrupted";
		target.pid = null;
		return {
			...f,
			target,
			binding: {
				taskId: f.card.id,
				expectedTaskIncarnationCreatedAtEpochMs: 1,
				taskConversationSessionId: sessionId,
				expectedNativeConversationSessionId: target.agentNativeConversationSessionIdentity?.nativeSessionId ?? "",
			},
		};
	}
	it("真正启动后的Stop取消本代执行，不只返回禁止而留下活体", async () => {
		const f = await resumableFixture();
		let processRunning = false;
		const stopResumedSession = vi.fn(async (_scope, target: RuntimeTaskSessionSummary) => {
			expect(target.runtimeSessionIncarnationId).toBe("resumed-generation");
			processRunning = false;
			return { cancellationRequested: true, processExitConfirmed: true };
		});
		Object.assign(f.dependencies, { stopResumedSession });
		f.resumeSession.mockImplementationOnce(async (_scope, target, beforeLaunch) => {
			await beforeLaunch({ ...target, runtimeSessionIncarnationId: "resumed-generation" });
			processRunning = true;
			const resumed = { ...target, pid: 43, runtimeSessionIncarnationId: "resumed-generation" };
			f.state.sessions[target.taskId] = resumed;
			await f.service.recordExplicitStop(scope, target.taskId);
			return { ok: true, summary: resumed };
		});
		expect(await f.service.resume(scope, f.binding, human)).toMatchObject({
			ok: false,
			status: "execution_prohibited",
			postLaunchCancellation: { cancellationRequested: true, processExitConfirmed: true },
		});
		expect(processRunning).toBe(false);
		expect(stopResumedSession).toHaveBeenCalledTimes(1);
	});
	it("原工作目录缺证时公共恢复在调用transport前拒绝", async () => {
		const f = await resumableFixture();
		f.target.workspacePath = null;
		expect(await f.service.resume(scope, f.binding, human)).toMatchObject({ ok: false, status: "identity_unknown" });
		expect(f.resumeSession).not.toHaveBeenCalled();
	});
	it("实际启动目录与原执行不同，启动边界拒绝且不认领任何活体", async () => {
		const f = await resumableFixture();
		let processLaunches = 0;
		const stopResumedSession = vi.fn(f.dependencies.stopResumedSession);
		f.dependencies.stopResumedSession = stopResumedSession;
		f.resumeSession.mockImplementationOnce(async (_scope, target, beforeLaunch) => {
			await beforeLaunch({
				...target,
				workspacePath: "/different-directory",
				runtimeSessionIncarnationId: "not-launched-generation",
			});
			processLaunches++;
			return { ok: true, summary: target };
		});
		expect(await f.service.resume(scope, f.binding, human)).toMatchObject({
			ok: false,
			status: "identity_mismatch",
			executionMayHaveOccurred: false,
		});
		expect(processLaunches).toBe(0);
		expect(stopResumedSession).not.toHaveBeenCalled();
	});
	it("折叠到既有活体的返回不授予补偿取消归属", async () => {
		const f = await resumableFixture();
		const stopResumedSession = vi.fn(f.dependencies.stopResumedSession);
		f.dependencies.stopResumedSession = stopResumedSession;
		f.resumeSession.mockImplementationOnce(async (_scope, target) => {
			await f.service.recordExplicitStop(scope, f.card.id);
			return { ok: true, summary: target };
		});
		expect(await f.service.resume(scope, f.binding, human)).toMatchObject({
			ok: false,
			status: "execution_prohibited",
		});
		expect(stopResumedSession).not.toHaveBeenCalled();
	});
	it("通用返回被替代代覆盖时只持有启动边界的原代", async () => {
		const f = await resumableFixture();
		const stopResumedSession = vi.fn(f.dependencies.stopResumedSession);
		f.dependencies.stopResumedSession = stopResumedSession;
		f.resumeSession.mockImplementationOnce(async (_scope, target, beforeLaunch) => {
			await beforeLaunch({ ...target, runtimeSessionIncarnationId: "owned-generation" });
			const replacement = structuredClone(target);
			replacement.runtimeSessionIncarnationId = "replacement-generation";
			if (replacement.agentNativeConversationSessionIdentity)
				replacement.agentNativeConversationSessionIdentity.nativeSessionId = "replacement-native";
			f.state.sessions[target.taskId] = replacement;
			return { ok: true, summary: replacement };
		});
		expect(await f.service.resume(scope, f.binding, human)).toMatchObject({ ok: false, status: "identity_mismatch" });
		expect(stopResumedSession).toHaveBeenCalledExactlyOnceWith(
			scope,
			expect.objectContaining({ runtimeSessionIncarnationId: "owned-generation" }),
		);
	});
	it("相同side并发恢复只执行一次原恢复动作", async () => {
		const f = await resumableFixture();
		let release: () => void = () => undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.resumeSession.mockImplementation(async (_scope, target, beforeLaunch) => {
			await beforeLaunch({ ...target, runtimeSessionIncarnationId: "resumed-generation" });
			await barrier;
			return { ok: true, summary: target };
		});
		const first = f.service.resume(scope, f.binding, human);
		const second = f.service.resume(scope, f.binding, human);
		try {
			await vi.waitFor(() => expect(f.resumeSession).toHaveBeenCalled());
		} finally {
			release();
		}
		const results = await Promise.all([first, second]);
		expect(results.every((result) => result.ok)).toBe(true);
		expect(f.resumeSession).toHaveBeenCalledTimes(1);
	});
});

describe("Agent 侧会话创建与回报", () => {
	it("核对任务归属后明确拒绝从旧 Cline 会话 fork，不启动其他进程", async () => {
		const f = await fixture();
		f.state.sessions["host-task"] = summary("host-task", {
			agentId: "cline",
			sessionTransport: "in_process_cline_sdk",
		});
		const response = await f.service.create(scope, request({ agentId: "cline" }), human);
		expect(response.ok).toBe(false);
		expect(response.error).toContain("Cline agent 已退役");
		expect(f.startSession).not.toHaveBeenCalled();
	});
	it("新建侧会话沿用自己的默认配置，不继承宿主任务的推理覆盖", async () => {
		const f = await fixture();
		f.card.codexReasoningEffortOverride = "ultra";
		const created = await f.service.create(scope, request(), human);
		expect(created.ok).toBe(true);
		const launch = f.startSession.mock.calls[0]?.[1];
		expect(launch?.codexReasoningEffortOverride).toBeUndefined();
		expect(
			launch?.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings?.codexReasoningEffortOverride,
		).toBeUndefined();
	});
	it("恢复查询核验冻结内容并保留原创建者，不重新解析当前主会话", async () => {
		const f = await fixture();
		const frozen = request({ expectedTaskIncarnationCreatedAtEpochMs: 1 });
		const created = await f.service.create(scope, frozen, human);
		f.card.mainTaskConversationSessionId = "new-main";
		expect((await f.service.lookupCreation(scope, frozen))?.creation?.requestId).toBe(created.creation?.requestId);
		expect(await f.service.lookupCreation(scope, { ...frozen, initialMessage: "另一条正文" })).toMatchObject({
			ok: false,
			idempotencyConflict: true,
		});
		expect(f.startSession).toHaveBeenCalledTimes(1);
	});
	it("命名响应丢失跨重启只核对原结果；手改或 Stop 后不应用迟到结果", async () => {
		const f = await fixture();
		const suggestNames = vi.fn(async () => {
			throw new Error("模型结果未知");
		});
		const compareAndSet = vi.fn(async () => true);
		f.dependencies.suggestNames = suggestNames;
		f.dependencies.compareAndSetSessionName = compareAndSet;
		f.dependencies.readRecordedNameSuggestionResult = vi.fn(async () => null);
		const created = await f.service.create(scope, request(), human);
		await vi.waitFor(() => expect(suggestNames).toHaveBeenCalledTimes(1));
		await f.service.close();
		const restored = createTaskConversationSessionService(f.dependencies);
		await restored.reconcile(scope);
		expect(suggestNames).toHaveBeenCalledTimes(1);
		expect(compareAndSet).not.toHaveBeenCalled();
		const sessionId = created.creation?.taskConversationSessionId;
		if (!sessionId) throw new Error("未取得会话身份");
		await restored.recordExplicitStop(scope, sessionId);
		f.dependencies.readRecordedNameSuggestionResult = async () => ({
			status: "suggested",
			suggestedTaskNames: ["迟到主题"],
		});
		await restored.reconcile(scope);
		expect(compareAndSet).not.toHaveBeenCalled();
		expect(suggestNames).toHaveBeenCalledTimes(1);
	});
	it("新建会话权限默认全部允许，不继承宿主临时选择", async () => {
		const f = await fixture();
		f.card.taskAgentPermissionMode = undefined;
		f.dependencies.readDefaultTaskAgentPermissionMode = async () => "ask_for_every_tool_use";
		const created = await f.service.create(scope, request(), human);
		expect(created.ok).toBe(true);
		expect(f.startSession.mock.calls[0]?.[1].taskAgentPermissionMode).toBe("bypass_all_permission_prompts");
	});
	it("缺少 Plan 的调用在预留身份前失败，显式 false、Agent 默认模型与来源回执贯通 fork", async () => {
		const f = await fixture();
		const missing = request();
		delete (missing as Partial<typeof missing>).startInPlanMode;
		expect(await f.service.create(scope, missing, human)).toMatchObject({
			ok: false,
			creation: null,
			error: expect.stringContaining("--start-in-plan-mode"),
		});
		expect(f.startSession).not.toHaveBeenCalled();
		expect((await f.service.list(scope, "host-task")).creations).toHaveLength(0);
		f.card.startInPlanMode = true;
		f.dependencies.readCreationDefaults = async () => ({ modelId: "new-agent-default" });
		const preview = await f.service.preview(scope, request(), human);
		expect(preview).toMatchObject({
			ok: true,
			resolvedSettings: { modelId: { value: "new-agent-default", source: "agent_default_configuration" } },
		});
		expect(f.startSession).not.toHaveBeenCalled();
		expect((await f.service.list(scope, "host-task")).creations).toHaveLength(0);
		const created = await f.service.create(scope, request(), human);
		expect(f.startSession.mock.calls[0]?.[1]).toMatchObject({
			startInPlanMode: false,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "new-agent-default" },
		});
		f.dependencies.readCreationDefaults = async () => ({ modelId: "changed-later" });
		const restored = createTaskConversationSessionService(f.dependencies);
		const retried = await restored.create(scope, request(), human);
		expect(retried.resolvedSettings).toEqual(created.resolvedSettings);
		expect(f.startSession).toHaveBeenCalledTimes(1);
	});

	it("空会话只在首次真实输入被接受后命名，手改版本保护迟到结果", async () => {
		const f = await fixture();
		const suggestNames = vi.fn(async () => ({ status: "suggested" as const, suggestedTaskNames: ["自动主题"] }));
		f.dependencies.suggestNames = suggestNames;
		f.dependencies.compareAndSetSessionName = async (_scope, input, source) => {
			const session = f.state.sessions[input.taskConversationSessionId];
			const metadata = session?.taskConversationSessionMetadata;
			if (!metadata || (metadata.conversationSessionNameVersion ?? 0) !== input.expectedNameVersion) return false;
			session.taskConversationSessionMetadata = {
				...metadata,
				conversationSessionName: input.conversationSessionName,
				conversationSessionNameVersion: input.expectedNameVersion + 1,
				conversationSessionNameSource: source,
			};
			return true;
		};
		const created = await f.service.create(scope, request({ initialMessage: "" }), human);
		await f.service.reconcile(scope);
		expect(suggestNames).not.toHaveBeenCalled();
		const session = f.state.sessions[created.creation?.taskConversationSessionId ?? ""];
		if (!session?.taskConversationSessionMetadata) throw new Error("缺少侧会话");
		session.taskConversationSessionMetadata.latestUserMessagePreview = "真实问题";
		await f.service.reconcile(scope);
		expect(suggestNames).not.toHaveBeenCalled();
		session.agentConversationPromptSubmissionAcceptance = {
			status: "accepted",
			attemptedAtMs: 1001,
			runtimeSessionIncarnationId: "new-session",
		};
		await f.service.reconcile(scope);
		expect(suggestNames).toHaveBeenCalledTimes(1);
		expect(session.taskConversationSessionMetadata.conversationSessionName).toBe("自动主题");
		const renamed = await f.service.rename(scope, {
			taskId: "host-task",
			expectedTaskIncarnationCreatedAtEpochMs: 1,
			taskConversationSessionId: session.taskId,
			expectedNameVersion: 1,
			conversationSessionName: "人工主题",
		});
		expect(renamed.ok).toBe(true);
		await createTaskConversationSessionService(f.dependencies).reconcile(scope);
		expect(session.taskConversationSessionMetadata.conversationSessionName).toBe("人工主题");
		expect(suggestNames).toHaveBeenCalledTimes(1);
	});

	it("By the way 的只读约束独立于显式全部允许与 Plan", async () => {
		const f = await fixture();
		const result = await f.service.create(
			scope,
			request({
				sessionRole: "by_the_way",
				startInPlanMode: true,
				taskAgentPermissionMode: "bypass_all_permission_prompts",
			}),
			human,
		);
		expect(result.resolvedSettings).toMatchObject({
			startInPlanMode: { value: true },
			roleReadOnlyConstraint: { value: true, source: "session_role_constraint" },
		});
	});

	it("并发相同请求只启动一次，重启后仍返回原会话；同 key 不同正文冲突", async () => {
		const f = await fixture();
		const results = await Promise.all([
			f.service.create(scope, request(), human),
			f.service.create(scope, request(), human),
		]);
		expect(results.every((result) => result.ok)).toBe(true);
		expect(new Set(results.map((result) => result.creation?.taskConversationSessionId)).size).toBe(1);
		expect(f.startSession).toHaveBeenCalledTimes(1);
		const restarted = createTaskConversationSessionService(f.dependencies);
		expect((await restarted.create(scope, request(), human)).creation?.requestId).toBe(
			results[0]?.creation?.requestId,
		);
		expect(
			(await restarted.create(scope, request({ initialMessage: "另一项工作" }), human)).idempotencyConflict,
		).toBe(true);
		expect(f.startSession).toHaveBeenCalledTimes(1);
		expect(f.state.sessions["host-task"]?.turnOwner).toBe("agent");
		expect(f.enqueueReport).not.toHaveBeenCalled();
	});
	it("peer 再创建默认复刻自身，也能选择当前主会话或跨 Agent 全新上下文", async () => {
		const f = await fixture();
		const first = await f.service.create(scope, request(), human);
		const peer = f.state.sessions[first.creation?.taskConversationSessionId ?? ""];
		expect(peer).toBeDefined();
		if (!peer) throw new Error("缺少 peer");
		const child = await f.service.create(scope, request({ idempotencyKey: "peer-child" }), actor(peer));
		expect(child.summary?.taskConversationSessionMetadata).toMatchObject({
			creatorTaskConversationSessionId: peer.taskId,
			contextSourceTaskConversationSessionId: peer.taskId,
			defaultReportTargetTaskConversationSessionId: peer.taskId,
		});
		const fromMain = await f.service.create(
			scope,
			request({ idempotencyKey: "main-child", contextSource: "current_main" }),
			actor(peer),
		);
		expect(fromMain.summary?.taskConversationSessionMetadata?.contextSourceTaskConversationSessionId).toBe(
			"host-task",
		);
		const crossAgent = await f.service.create(
			scope,
			request({ idempotencyKey: "other-agent", contextSource: "fresh", agentId: "claude" }),
			actor(peer),
		);
		expect(crossAgent.summary?.taskConversationSessionMetadata).toMatchObject({
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: null,
		});
		expect(
			(
				await f.service.create(
					scope,
					request({ idempotencyKey: "unsupported-fork", agentId: "claude" }),
					actor(peer),
				)
			).ok,
		).toBe(false);
	});
	it("允许多次只读侧问；继承、工具与代码示例不回报，自身新回答按消息身份去重", async () => {
		const f = await fixture();
		const first = await f.service.create(scope, request({ sessionRole: "by_the_way" }), human);
		const second = await f.service.create(
			scope,
			request({ sessionRole: "by_the_way", idempotencyKey: "second-side-question" }),
			human,
		);
		expect(first.ok && second.ok).toBe(true);
		const block = '<kanban-session-report>\n{"text":"主动结论"}\n</kanban-session-report>';
		f.setMessages([
			{ id: "inherited", role: "assistant", content: block, createdAt: 900 },
			{ id: "tool", role: "tool", content: block, createdAt: 1001 },
		]);
		await f.service.reconcile(scope);
		expect(f.enqueueReport).not.toHaveBeenCalled();
		// 只让一个侧会话有新回答，另一条暂时仍无消息。
		if (first.summary) first.summary.lastHookAt = 1001;
		f.dependencies.readHistory = async (_scope, input) => ({
			availability: "available",
			messages:
				input.taskConversationSessionId === first.summary?.taskId
					? [{ id: "own-message", role: "assistant", content: block, createdAt: 1001 }]
					: [],
			nextCursor: null,
			notice: null,
		});
		await f.service.reconcile(scope);
		await createTaskConversationSessionService(f.dependencies).reconcile(scope);
		expect(
			f.enqueueReport.mock.calls.map((call) => call[1].idempotencyKey).every((key, _i, all) => key === all[0]),
		).toBe(true);
	});
	it("即使字节位置或原生分支身份变化，同一个原生回答也只回报一次", async () => {
		const f = await fixture();
		const created = await f.service.create(scope, request({ sessionRole: "by_the_way" }), human);
		const side = created.summary;
		if (!side) throw new Error("缺少侧问");
		const content = '<kanban-session-report>\n{"text":"稳定结论"}\n</kanban-session-report>';
		f.setMessages([
			{
				id: "old-byte-offset",
				role: "assistant",
				content,
				createdAt: 1001,
				meta: { nativeMessageIdentity: "native-id:own-message", nativeMessagePhase: "final_answer" },
			},
		]);
		await f.service.reconcile(scope);
		expect(f.enqueueReport).toHaveBeenCalledTimes(1);
		side.agentNativeConversationSessionIdentity = {
			sourceAgentId: "codex",
			nativeSessionId: "rewound-native",
			transcriptPath: null,
			observedAt: 1002,
		};
		f.setMessages([
			{
				id: "new-byte-offset",
				role: "assistant",
				content,
				createdAt: 1001,
				meta: { nativeMessageIdentity: "native-id:own-message", nativeMessagePhase: "final_answer" },
			},
		]);
		await createTaskConversationSessionService(f.dependencies).reconcile(scope);
		expect(f.enqueueReport).toHaveBeenCalledTimes(1);
	});
	it("源会话在创建准备期间新增的继承声明不冒充侧会话自己的回报", async () => {
		const f = await fixture();
		await f.service.create(scope, request({ sessionRole: "by_the_way" }), human);
		f.setMessages([
			{
				id: "copied-later-message",
				role: "assistant",
				content: '<kanban-session-report>\n{"text":"原来源的声明"}\n</kanban-session-report>',
				createdAt: 1001,
				meta: { nativeMessageIdentity: "native-id:parent-message" },
			},
		]);
		f.dependencies.verifyAssistantReportOrigin = async () => ({ status: "inherited", nextCursor: null });
		await f.service.reconcile(scope);
		expect(f.enqueueReport).not.toHaveBeenCalled();
	});

	it("peer 可回报创建者、当前主或任意同 Task 会话，拒绝跨 Task 目标和身份冒用", async () => {
		const f = await fixture();
		const created = await f.service.create(scope, request(), human);
		const peer = created.summary;
		if (!peer) throw new Error("缺少 peer");
		const receipt = await f.service.report(
			scope,
			{ taskId: "host-task", text: "结果", idempotencyKey: "report" },
			actor(peer),
		);
		expect(receipt.targetTaskConversationSessionId).toBe("host-task");
		expect(receipt.status).toBe("queued");
		const toCurrentMain = await f.service.report(
			scope,
			{
				taskId: "host-task",
				text: "固定当前主",
				idempotencyKey: "current-main-report",
				targetTaskConversationSessionId: "current_main",
			},
			actor(peer),
		);
		f.card.mainTaskConversationSessionId = peer.taskId;
		const replayed = await f.service.report(
			scope,
			{
				taskId: "host-task",
				text: "固定当前主",
				idempotencyKey: "current-main-report",
				targetTaskConversationSessionId: "current_main",
			},
			actor(peer),
		);
		expect(replayed.reportId).toBe(toCurrentMain.reportId);
		expect(replayed.targetTaskConversationSessionId).toBe("host-task");
		f.state.sessions.outsider = summary("outsider");
		expect(
			(
				await f.service.report(
					scope,
					{
						taskId: "host-task",
						text: "结果",
						idempotencyKey: "cross-task",
						targetTaskConversationSessionId: "outsider",
					},
					actor(peer),
				)
			).ok,
		).toBe(false);
		expect(
			(
				await f.service.create(
					scope,
					request({ idempotencyKey: "spoof", creatorTaskConversationSessionId: "host-task" }),
					actor(peer),
				)
			).ok,
		).toBe(false);
	});
	it("只按回收目标自己的身份和快照恢复；Stop 跨重启阻止唤醒", async () => {
		const f = await fixture();
		const created = await f.service.create(scope, request(), human);
		const peer = created.summary;
		if (!peer) throw new Error("缺少 peer");
		const reclaimed = {
			...peer,
			runtimeSessionIncarnationId: "incarnation",
			liveness: "exited" as const,
			pid: null,
			agentSessionRuntimeReclamationOutcome: {
				runtimeSessionIncarnationId: "incarnation",
				sessionTransport: "pty_terminal" as const,
				reclamationTrigger: "response_generation_grace_period_expired" as const,
				attemptedAt: 1,
				completedAt: 2,
				rootProcessExitConfirmed: true,
				descendantProcessesExitConfirmed: true,
				survivingDescendantPids: [],
				usedForcefulEscalation: false,
				releasedResources: ["pty"],
				failureReason: null,
				nextRetryAt: null,
			},
		};
		f.state.sessions[peer.taskId] = reclaimed;
		await f.service.report(
			scope,
			{
				taskId: "host-task",
				text: "请核对",
				idempotencyKey: "to-peer",
				targetTaskConversationSessionId: peer.taskId,
			},
			human,
		);
		expect(f.resumeSession).toHaveBeenCalledWith(scope, reclaimed, expect.any(Function));
		await f.service.recordExplicitStop(scope, peer.taskId);
		f.state.sessions[peer.taskId] = reclaimed;
		await createTaskConversationSessionService(f.dependencies).report(
			scope,
			{
				taskId: "host-task",
				text: "停止后不恢复",
				idempotencyKey: "stopped-peer",
				targetTaskConversationSessionId: peer.taskId,
			},
			human,
		);
		expect(f.resumeSession).toHaveBeenCalledTimes(1);
	});
	it("操作记录损坏时仍独立保存 Stop，修复记录和重启后不自动投递，只有显式启动解除精确目标", async () => {
		const f = await fixture();
		const created = await f.service.create(scope, request(), human);
		if (!created.summary || !f.dependencies.storageRootDirectoryPath) throw new Error("缺少测试会话");
		const peerId = created.summary.taskId;
		const operationsPath = join(
			f.dependencies.storageRootDirectoryPath,
			`${createHash("sha256").update(scope.workspaceId).digest("hex")}.json`,
		);
		const originalOperations = await readFile(operationsPath, "utf8");
		await writeFile(operationsPath, "损坏的操作记录");
		await expect(f.service.recordExplicitStop(scope, peerId)).rejects.toThrow();
		await writeFile(operationsPath, originalOperations);
		const restarted = createTaskConversationSessionService(f.dependencies);
		const report = await restarted.report(
			scope,
			{
				taskId: "host-task",
				text: "停止后不投递",
				idempotencyKey: "corrupted-stop",
				targetTaskConversationSessionId: peerId,
			},
			human,
		);
		expect(report.status).toBe("execution_prohibited");
		expect(f.enqueueReport).not.toHaveBeenCalled();
		await restarted.recordExplicitSessionStart(scope, "host-task");
		await restarted.reconcile(scope);
		expect(f.enqueueReport).not.toHaveBeenCalled();
		await restarted.recordExplicitSessionStart(scope, peerId);
		await restarted.reconcile(scope);
		expect(f.enqueueReport).toHaveBeenCalledOnce();
	});
	it.each(["done", "shelved", "handover"] as const)(
		"接收方受 %s 限制时不投递，资格恢复后跨重启自动接续",
		async (prohibition) => {
			const f = await fixture();
			const created = await f.service.create(scope, request(), human);
			const peer = created.summary;
			const metadata = peer?.taskConversationSessionMetadata;
			if (!peer || !metadata) throw new Error("缺少测试 peer");
			const column = f.state.board.columns[0];
			if (!column) throw new Error("缺少任务列");
			if (prohibition === "done") column.id = "trash";
			if (prohibition === "shelved") f.card.taskShelvingState = { isShelved: true, lastChangedAt: 1000 };
			if (prohibition === "handover") metadata.taskAutomationSuspendedForMainSessionHandover = true;
			const origin = {
				workspaceTaskId: "host-task",
				taskIncarnationCreatedAt: 1,
				sourceTaskConversationSessionId: "host-task",
				targetTaskConversationSessionId: peer.taskId,
			};
			expect(await f.service.isReportExecutionAllowed(scope, origin)).toBe(false);
			const report = await f.service.report(
				scope,
				{
					taskId: "host-task",
					text: "等待执行资格",
					idempotencyKey: "pending-qualification",
					targetTaskConversationSessionId: peer.taskId,
				},
				human,
			);
			expect(report.status).toBe("execution_prohibited");
			expect(f.enqueueReport).not.toHaveBeenCalled();
			column.id = "in_progress";
			f.card.taskShelvingState = { isShelved: false, lastChangedAt: 1001 };
			metadata.taskAutomationSuspendedForMainSessionHandover = false;
			const restarted = createTaskConversationSessionService(f.dependencies);
			expect(await restarted.isReportExecutionAllowed(scope, origin)).toBe(true);
			await restarted.reconcile(scope);
			expect(f.enqueueReport).toHaveBeenCalledOnce();
		},
	);
	it.each(["question", "plan_review", "permission", "needs_input"] as const)(
		"程序化回报不解除真人 %s 门禁",
		async (userTurnKind) => {
			const f = await fixture();
			const target = summary("host-task", { turnOwner: "user", userTurnKind });
			f.state.sessions[target.taskId] = target;
			const report = await f.service.report(
				scope,
				{
					taskId: "host-task",
					text: "仅登记回报",
					idempotencyKey: "modal-report",
				},
				human,
			);
			expect(report.status).toBe("queued");
			expect(target.userTurnKind).toBe(userTurnKind);
			expect(
				await f.service.isReportExecutionAllowed(scope, {
					workspaceTaskId: "host-task",
					taskIncarnationCreatedAt: 1,
					sourceTaskConversationSessionId: "host-task",
					targetTaskConversationSessionId: "host-task",
				}),
			).toBe(false);
		},
	);
	it("可证明尚未启动的准备故障自动恢复，三次预算跨重启保存，环境变化后重验", async () => {
		const f = await fixture();
		f.dependencies.readStartupEnvironmentFingerprint = async () => "环境版本一";
		f.startSession.mockRejectedValue(new Error("准备环境暂时不可用"));
		expect((await f.service.create(scope, request(), human)).creation?.status).toBe("reserved");
		f.advance(14_999);
		await createTaskConversationSessionService(f.dependencies).reconcile(scope);
		expect(f.startSession).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 4; index++) {
			f.advance(15_000);
			await createTaskConversationSessionService(f.dependencies).reconcile(scope);
		}
		expect(f.startSession).toHaveBeenCalledTimes(3);
		f.dependencies.readStartupEnvironmentFingerprint = async () => "环境版本二";
		await createTaskConversationSessionService(f.dependencies).reconcile(scope);
		expect(f.startSession).toHaveBeenCalledTimes(4);
	});

	it("启动中断保持未知，三次相同证据补查跨重启保存且不再次启动", async () => {
		const f = await fixture();
		f.startSession.mockImplementationOnce(async (_scope, _request, beforeLaunch) => {
			await beforeLaunch();
			throw new Error("启动回执中断");
		});
		const created = await f.service.create(scope, request(), human);
		expect(created.creation?.status).toBe("awaiting_startup_evidence");
		for (let index = 0; index < 5; index++) {
			f.advance(15_000);
			await createTaskConversationSessionService(f.dependencies).reconcile(scope);
		}
		const progress = (await f.service.list(scope, "host-task")).creations[0];
		expect(progress?.unchangedEvidenceProbeCount).toBe(3);
		expect(f.startSession).toHaveBeenCalledTimes(1);
	});

	it("并发穿过创建前检查的不同正文仍返回幂等冲突标志", async () => {
		const f = await fixture();
		f.card.taskAgentPermissionMode = undefined;
		let entered = 0;
		let releaseFirst: (() => void) | undefined;
		f.dependencies.readDefaultTaskAgentPermissionMode = () =>
			new Promise((resolve) => {
				entered += 1;
				if (entered === 1) {
					releaseFirst = () => resolve("ask_for_every_tool_use");
					return;
				}
				releaseFirst?.();
				resolve("ask_for_every_tool_use");
			});
		const results = await Promise.all([
			f.service.create(scope, request({ idempotencyKey: "race", initialMessage: "第一项" }), human),
			f.service.create(scope, request({ idempotencyKey: "race", initialMessage: "第二项" }), human),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.find((result) => !result.ok)).toMatchObject({
			ok: false,
			idempotencyConflict: true,
			error: "相同幂等键已用于不同的会话创建内容。",
		});
		expect(f.startSession).toHaveBeenCalledTimes(1);
	});

	it("显式 Codex profile 采用 profile 权限，未选择时不继承宿主 profile", async () => {
		const f = await fixture();
		f.card.codexConfigurationProfileId = "card-profile";
		f.card.codexConfigurationPermissionSelectionSource = "task_local";
		const explicit = await f.service.create(
			scope,
			request({ idempotencyKey: "explicit-profile", codexConfigurationProfileId: "chosen-profile" }),
			human,
		);
		expect(explicit.ok).toBe(true);
		expect(f.startSession.mock.calls.at(-1)?.[1]).toMatchObject({
			codexConfigurationProfileId: "chosen-profile",
			codexConfigurationPermissionSelectionSource: "profile",
		});
		const inherited = await f.service.create(scope, request({ idempotencyKey: "inherited-profile" }), human);
		expect(inherited.ok).toBe(true);
		expect(f.startSession.mock.calls.at(-1)?.[1]).toMatchObject({
			codexConfigurationProfileId: undefined,
			codexConfigurationPermissionSelectionSource: "task_local",
		});
	});

	it("直接从当前主会话创建时保留主会话轮号，peer 来源保持未知", async () => {
		const f = await fixture();
		f.state.sessions["host-task"] = summary("host-task", {
			state: "running",
			turnOwner: "agent",
			userTurnKind: null,
			latestTurnCheckpoint: { turn: 6, ref: "refs/checkpoints/6", commit: "abc", createdAt: 1 },
		});
		const fromMain = await f.service.create(
			scope,
			request({ idempotencyKey: "from-main", sessionRole: "by_the_way", contextSource: "current_main" }),
			human,
		);
		expect(fromMain.summary?.taskConversationSessionMetadata?.mainSessionOriginTurnNumber).toBe(6);
		const peerCreated = await f.service.create(scope, request({ idempotencyKey: "peer" }), human);
		const peer = peerCreated.summary;
		if (!peer) throw new Error("缺少可写 peer");
		peer.latestTurnCheckpoint = { turn: 2, ref: "refs/checkpoints/2", commit: "def", createdAt: 2 };
		const fromPeer = await f.service.create(
			scope,
			request({ idempotencyKey: "from-peer", sessionRole: "by_the_way" }),
			actor(peer),
		);
		expect(fromPeer.summary?.taskConversationSessionMetadata?.mainSessionOriginTurnNumber).toBeNull();
	});

	it("失败的启动摘要保持失败，不用 startedAt 冒充已启动", async () => {
		const f = await fixture();
		f.startSession.mockImplementationOnce(async (_scope, startRequest, beforeLaunch) => {
			await beforeLaunch();
			const failed = summary(startRequest.taskId, {
				agentId: startRequest.agentId,
				taskConversationSessionMetadata: startRequest.taskConversationSessionMetadata,
				startedAt: 50,
				state: "failed",
				turnOwner: "user",
				liveness: "failed",
				userTurnKind: "error",
				warningMessage: "ACP connection closed",
				agentNativeConversationSessionIdentity: undefined,
			});
			f.state.sessions[failed.taskId] = failed;
			return { ok: false, summary: null, error: "ACP connection closed" };
		});
		const created = await f.service.create(scope, request(), human);
		expect(created.creation?.status).toBe("awaiting_startup_evidence");
		f.advance(15_000);
		await f.service.reconcile(scope);
		const progress = (await f.service.list(scope, "host-task")).creations[0];
		expect(progress?.status).toBe("failed");
		expect(progress?.notice).toContain("ACP connection closed");
	});

	it("未完成的回报扫描在历史游标失效后从头重扫", async () => {
		const f = await fixture();
		const created = await f.service.create(scope, request({ sessionRole: "by_the_way" }), human);
		const sessionId = created.summary?.taskId;
		if (!sessionId || !created.summary) throw new Error("缺少侧会话");
		created.summary.lastHookAt = 2;
		const block = '<kanban-session-report>\n{"text":"后来的结论"}\n</kanban-session-report>';
		const cursors: Array<string | null | undefined> = [];
		f.dependencies.readHistory = async (_scope, input) => {
			cursors.push(input.cursor);
			if (cursors.length === 1)
				return {
					availability: "available",
					messages: [{ id: "later", role: "assistant", content: "还没有回报", createdAt: 5_000 }],
					nextCursor: "stale-cursor",
					notice: null,
				};
			if (input.cursor === "stale-cursor")
				return {
					availability: "unavailable",
					messages: [],
					nextCursor: null,
					notice: "会话记录已变化，请刷新后重新加载历史。",
				};
			return {
				availability: "available",
				messages: [{ id: "report", role: "assistant", content: block, createdAt: 5_000 }],
				nextCursor: null,
				notice: null,
			};
		};
		await f.service.reconcile(scope);
		expect(cursors).toEqual([null, "stale-cursor"]);
		expect(f.enqueueReport).not.toHaveBeenCalled();
		await f.service.reconcile(scope);
		expect(cursors).toEqual([null, "stale-cursor", null]);
		expect(f.enqueueReport).toHaveBeenCalledTimes(1);
	});
});
