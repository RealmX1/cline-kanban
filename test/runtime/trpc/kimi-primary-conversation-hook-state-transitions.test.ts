import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeHookEvent } from "../../../src/core/api-contract";
import { resolveKimiPrimaryConversationHookEvent } from "../../../src/core/kimi-primary-conversation-hook-lifecycle";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";
import { createTempDir } from "../../utilities/temp-dir";

const managers: TerminalSessionManager[] = [];
const temporaryDirectories: ReturnType<typeof createTempDir>[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) directory.cleanup();
});

async function createIsolatedPrimaryConversationHookRuntime(agentId: "kimi" | "claude" = "kimi") {
	const taskId = `isolated-${agentId}-hook-task`;
	const directory = createTempDir(`${agentId}-primary-hook-runtime-`);
	temporaryDirectories.push(directory);
	vi.stubEnv("HOME", directory.path);
	const writeTerminalInput = vi.fn();
	const stopTerminalProcess = vi.fn();
	const manager = new TerminalSessionManager({
		hostedTerminalPtyProcessSpawner: {
			async spawnHostedTerminalPtyProcess() {
				return {
					pid: 45678,
					write: writeTerminalInput,
					resize: vi.fn(),
					pause: vi.fn(),
					resume: vi.fn(),
					stop: stopTerminalProcess,
					hasExited: () => false,
					wasInterrupted: () => false,
					publishTerminalSessionAdoptionRecordForRuntimeRestart: vi.fn(),
				};
			},
		},
	});
	managers.push(manager);
	await manager.startTaskSession({
		taskId,
		agentId,
		binary: agentId,
		args: ["--model", "isolated-model"],
		cwd: directory.path,
		prompt: "",
		autoContinueOnConnectionDropEnabled: false,
	});
	const broadcastTaskReadyForReview = vi.fn();
	const api = createHooksApi({
		getWorkspacePathById: () => directory.path,
		ensureTerminalManagerForWorkspace: async () => manager,
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastTaskReadyForReview,
		captureTaskTurnCheckpoint: async () => {
			throw new Error("隔离测试不捕获 Git checkpoint");
		},
	});
	let deliverySequence = 0;
	return {
		manager,
		taskId,
		writeTerminalInput,
		stopTerminalProcess,
		broadcastTaskReadyForReview,
		summary: () => {
			const summary = manager.getSummary(taskId);
			if (!summary) throw new Error("缺少隔离会话摘要");
			return summary;
		},
		async ingest(
			hookEventName: string,
			toolName: string | null = null,
			payload: Record<string, unknown> = {},
			options: { hookEventCapturedAtEpochMs?: number; originalEvent?: RuntimeHookEvent } = {},
		) {
			const metadata = { source: agentId, hookEventName, toolName };
			return await api.ingest({
				workspaceId: `isolated-${agentId}-workspace`,
				taskId,
				event: resolveKimiPrimaryConversationHookEvent(options.originalEvent ?? "activity", metadata, payload),
				...(options.hookEventCapturedAtEpochMs === undefined
					? {}
					: { hookEventCapturedAtEpochMs: options.hookEventCapturedAtEpochMs }),
				metadata,
				hookEventDeliveryIdempotencyKey: `isolated-kimi-hook-${++deliverySequence}`,
				...(payload.agent_id && payload.agent_id !== "main" ? { hookEventFiredInsideSubagentContext: true } : {}),
			});
		},
	};
}

function confirmIsolatedNativeInputAccepted(
	runtime: Awaited<ReturnType<typeof createIsolatedPrimaryConversationHookRuntime>>,
	eventId: string,
	observedAtMs: number,
) {
	const summary = runtime.summary();
	const agentId = summary.agentId;
	const runtimeSessionIncarnationId = summary.runtimeSessionIncarnationId;
	if (!agentId || !runtimeSessionIncarnationId) throw new Error("隔离测试缺少当前会话归属");
	const nativeSessionId = `${runtime.taskId}-native-conversation`;
	runtime.manager.applyAgentNativeConversationSessionIdentity(runtime.taskId, {
		sourceAgentId: agentId,
		nativeSessionId,
		transcriptPath: null,
		observedAt: summary.startedAt ?? observedAtMs,
	});
	return runtime.manager.confirmAcceptedAgentConversationInput(runtime.taskId, {
		observedAtMs,
		eventId,
		nativeSessionId,
		runtimeSessionIncarnationId,
		acceptedNativeAgentTurnIsInProgress: true,
	});
}

describe("Kimi 主会话 hook 驱动真实运行时 facet", () => {
	it.each(["AskUserQuestion", "ExitPlanMode"])("%s 等待期间的其他工具完成不能抢回 agent 回合", async (toolName) => {
		const runtime = await createIsolatedPrimaryConversationHookRuntime();
		expect(await runtime.ingest("PreToolUse", toolName)).toEqual({ ok: true });
		const userTurnKind = toolName === "AskUserQuestion" ? "question" : "plan_review";
		expect(runtime.summary()).toMatchObject({ turnOwner: "user", liveness: "live", userTurnKind });
		await runtime.ingest("PostToolUse", "Bash");
		expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind });
		await runtime.ingest("PostToolUse", toolName);
		expect(runtime.summary()).toMatchObject({ turnOwner: "agent", userTurnKind: null });
	});

	it.each(["Stop", "Interrupt", "StopFailure"])(
		"%s 收口缺少 PostToolUse 的原生提问，不制造新一轮",
		async (hookEventName) => {
			const runtime = await createIsolatedPrimaryConversationHookRuntime();
			await runtime.ingest("PreToolUse", "AskUserQuestion");
			const turnSequence = runtime.summary().agentResponseGenerationTurnSequence;
			await runtime.ingest(hookEventName);
			const userTurnKind =
				hookEventName === "Stop" ? "review" : hookEventName === "Interrupt" ? "interrupted" : "error";
			expect(runtime.summary()).toMatchObject({ turnOwner: "user", liveness: "live", userTurnKind });
			expect(runtime.summary().agentResponseGenerationTurnSequence).toBe(turnSequence);
			expect(runtime.broadcastTaskReadyForReview.mock.calls.at(-1)?.[2]).toBe(userTurnKind);
		},
	);

	it.each([
		["PreToolUse", "AskUserQuestion", "question"],
		["PreToolUse", "ExitPlanMode", "plan_review"],
		["PermissionRequest", "Bash", "permission"],
	] as const)("%s / %s 中断后，下一次提交待确认并由工具活动恢复工作", async (hookName, toolName, userTurnKind) => {
		const runtime = await createIsolatedPrimaryConversationHookRuntime();
		await runtime.ingest(hookName, toolName);
		const waiting = runtime.summary();
		expect(waiting).toMatchObject({ turnOwner: "user", liveness: "live", userTurnKind });

		await runtime.ingest("Interrupt");
		const interrupted = runtime.summary();
		expect(interrupted).toMatchObject({
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "interrupted",
			pid: waiting.pid,
			runtimeSessionIncarnationId: waiting.runtimeSessionIncarnationId,
		});
		expect(interrupted.agentResponseGenerationTurnSequence).toBe(waiting.agentResponseGenerationTurnSequence);
		expect(interrupted.lastAgentConversationUserHandoffObservation).toEqual(
			waiting.lastAgentConversationUserHandoffObservation,
		);
		expect(interrupted.lastEffectiveAgentConversationActivityObservation).toEqual(
			waiting.lastEffectiveAgentConversationActivityObservation,
		);
		expect(interrupted.agentConversationPromptSubmissionAcceptance).toEqual(
			waiting.agentConversationPromptSubmissionAcceptance,
		);

		const nextPromptBytes = Buffer.from("继续隔离测试\r");
		expect(runtime.manager.writeInput(runtime.taskId, nextPromptBytes)).not.toBeNull();
		expect(runtime.writeTerminalInput).toHaveBeenLastCalledWith(nextPromptBytes);
		const pendingSubmission = runtime.summary().agentConversationPromptSubmissionAcceptance;
		expect(pendingSubmission?.status).toBe("pending");
		expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind: "interrupted" });

		await runtime.ingest("UserPromptSubmit");
		const submitted = runtime.summary();
		expect(submitted).toMatchObject({ turnOwner: "user", liveness: "live", userTurnKind: "interrupted" });
		expect(submitted.agentConversationPromptSubmissionAcceptance?.status).toBe("pending");
		expect(submitted.agentResponseGenerationTurnSequence).toBe(interrupted.agentResponseGenerationTurnSequence);
		expect(submitted.lastEffectiveAgentConversationActivityObservation).toEqual(
			interrupted.lastEffectiveAgentConversationActivityObservation,
		);

		await runtime.ingest("PostToolUse", "Bash");
		const resumed = runtime.summary();
		expect(resumed).toMatchObject({
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			reviewReason: null,
			pid: waiting.pid,
			runtimeSessionIncarnationId: waiting.runtimeSessionIncarnationId,
		});
		expect(runtime.stopTerminalProcess).not.toHaveBeenCalled();
		expect(resumed.agentConversationPromptSubmissionAcceptance).toEqual(
			submitted.agentConversationPromptSubmissionAcceptance,
		);
		expect(resumed.lastEffectiveAgentConversationActivityObservation).toEqual(
			interrupted.lastEffectiveAgentConversationActivityObservation,
		);
	});

	it.each(["AskUserQuestion", "ExitPlanMode"])(
		"续轮 %s 的前台模态保留真实交棒，迟到接受不覆盖它，更新的原生输入仍可恢复",
		async (toolName) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const startedAtMs = Date.now();
			const runtime = await createIsolatedPrimaryConversationHookRuntime();
			vi.setSystemTime(startedAtMs + 10);
			await runtime.ingest("Stop");
			const stopped = runtime.summary();
			vi.setSystemTime(startedAtMs + 20);
			await runtime.ingest("UserPromptSubmit");
			expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind: "review" });
			expect(runtime.summary().agentConversationPromptSubmissionAcceptance?.status).toBe("pending");
			expect(runtime.summary().agentResponseGenerationTurnSequence).toBe(
				stopped.agentResponseGenerationTurnSequence,
			);

			const nativeAcceptedAtMs = startedAtMs + 21;
			const modalHookCapturedAtMs = startedAtMs + 30;
			vi.setSystemTime(startedAtMs + 40);
			await runtime.ingest("PreToolUse", toolName, {}, { hookEventCapturedAtEpochMs: modalHookCapturedAtMs });
			const modal = runtime.summary();
			const userTurnKind = toolName === "AskUserQuestion" ? "question" : "plan_review";
			expect(modal).toMatchObject({ turnOwner: "user", liveness: "live", userTurnKind });
			expect(modal.agentConversationPromptSubmissionAcceptance?.status).toBe("pending");
			expect(modal.agentResponseGenerationTurnSequence).toBe((stopped.agentResponseGenerationTurnSequence ?? 0) + 1);
			expect(modal.lastAgentConversationUserHandoffObservation).toMatchObject({
				observedAtMs: modalHookCapturedAtMs,
				turnSequence: modal.agentResponseGenerationTurnSequence,
			});

			vi.setSystemTime(startedAtMs + 50);
			await runtime.ingest("PreToolUse", "AskUserQuestion", { tool_input: { background: true } });
			await runtime.ingest("PreToolUse", "AskUserQuestion", { agent_id: "isolated-subagent" });
			await runtime.ingest("PreToolUse", "Bash");
			await runtime.ingest("PostToolUse", "Bash");
			expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind });
			expect(runtime.summary().agentResponseGenerationTurnSequence).toBe(modal.agentResponseGenerationTurnSequence);
			expect(runtime.summary().lastAgentConversationUserHandoffObservation).toEqual(
				modal.lastAgentConversationUserHandoffObservation,
			);

			vi.setSystemTime(startedAtMs + 60);
			const accepted = confirmIsolatedNativeInputAccepted(runtime, "accepted-before-modal", nativeAcceptedAtMs);
			expect(accepted).toMatchObject({
				turnOwner: "user",
				userTurnKind,
				agentConversationPromptSubmissionAcceptance: {
					status: "accepted",
					eventId: "accepted-before-modal",
					confirmedAtMs: nativeAcceptedAtMs,
				},
			});
			expect(runtime.summary().agentResponseGenerationTurnSequence).toBe(modal.agentResponseGenerationTurnSequence);
			expect(runtime.summary().lastAgentConversationUserHandoffObservation).toEqual(
				modal.lastAgentConversationUserHandoffObservation,
			);

			vi.setSystemTime(startedAtMs + 70);
			await runtime.ingest("UserPromptSubmit");
			expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind });
			const newerAccepted = confirmIsolatedNativeInputAccepted(runtime, "accepted-after-modal", startedAtMs + 70);
			expect(newerAccepted).toMatchObject({
				turnOwner: "agent",
				userTurnKind: null,
				agentConversationPromptSubmissionAcceptance: { status: "accepted", eventId: "accepted-after-modal" },
			});
			expect(runtime.summary().agentResponseGenerationTurnSequence).toBe(
				(modal.agentResponseGenerationTurnSequence ?? 0) + 1,
			);
		},
	);

	it.each(["AskUserQuestion", "ExitPlanMode"])("早于本代提交的 %s 不补造工作回合或模态交棒", async (toolName) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const startedAtMs = Date.now();
		const runtime = await createIsolatedPrimaryConversationHookRuntime();
		vi.setSystemTime(startedAtMs + 10);
		await runtime.ingest("Stop");
		const stopped = runtime.summary();
		vi.setSystemTime(startedAtMs + 20);
		await runtime.ingest("UserPromptSubmit");
		vi.setSystemTime(startedAtMs + 40);
		await runtime.ingest("PreToolUse", toolName, {}, { hookEventCapturedAtEpochMs: startedAtMs + 15 });
		expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind: "review" });
		expect(runtime.summary().agentResponseGenerationTurnSequence).toBe(stopped.agentResponseGenerationTurnSequence);
		expect(runtime.summary().lastAgentConversationUserHandoffObservation).toEqual(
			stopped.lastAgentConversationUserHandoffObservation,
		);
		expect(runtime.summary().agentConversationPromptSubmissionAcceptance?.status).toBe("pending");
	});

	it("Kimi 的前台模态补证不扩张 Claude 的既有前置 hook 状态管线", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const startedAtMs = Date.now();
		const runtime = await createIsolatedPrimaryConversationHookRuntime("claude");
		vi.setSystemTime(startedAtMs + 10);
		await runtime.ingest("Stop", null, {}, { originalEvent: "to_review" });
		const stopped = runtime.summary();
		vi.setSystemTime(startedAtMs + 20);
		await runtime.ingest("UserPromptSubmit", null, {}, { originalEvent: "to_in_progress" });
		vi.setSystemTime(startedAtMs + 30);
		await runtime.ingest("PreToolUse", "AskUserQuestion", {}, { originalEvent: "to_review" });
		expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind: "review" });
		expect(runtime.summary().agentResponseGenerationTurnSequence).toBe(stopped.agentResponseGenerationTurnSequence);
		expect(runtime.summary().lastAgentConversationUserHandoffObservation).toEqual(
			stopped.lastAgentConversationUserHandoffObservation,
		);
		expect(runtime.summary().agentConversationPromptSubmissionAcceptance?.status).toBe("pending");
		vi.setSystemTime(startedAtMs + 40);
		expect(confirmIsolatedNativeInputAccepted(runtime, "claude-current-input", startedAtMs + 21)).toMatchObject({
			turnOwner: "agent",
			userTurnKind: null,
			agentConversationPromptSubmissionAcceptance: { status: "accepted" },
		});
	});

	it("后台问题与子代理 Stop 保留前台的待答问题，用户拒答后才恢复", async () => {
		const runtime = await createIsolatedPrimaryConversationHookRuntime();
		await runtime.ingest("PreToolUse", "AskUserQuestion");
		await runtime.ingest("PostToolUse", "AskUserQuestion", { tool_input: { background: true } });
		await runtime.ingest("Stop", null, { agent_id: "isolated-subagent" });
		expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind: "question" });
		await runtime.ingest("PostToolUseFailure", "AskUserQuestion");
		expect(runtime.summary()).toMatchObject({ turnOwner: "agent", userTurnKind: null });
	});

	it("授权结果结束工具等待，但不冒充原生输入接受", async () => {
		const runtime = await createIsolatedPrimaryConversationHookRuntime();
		await runtime.ingest("PermissionRequest", "Bash");
		expect(runtime.summary()).toMatchObject({ turnOwner: "user", userTurnKind: "permission" });
		await runtime.ingest("PermissionResult", "Bash");
		expect(runtime.summary()).toMatchObject({ turnOwner: "agent", userTurnKind: null });
		expect(runtime.summary().agentConversationPromptSubmissionAcceptance?.status).not.toBe("accepted");
	});
});
