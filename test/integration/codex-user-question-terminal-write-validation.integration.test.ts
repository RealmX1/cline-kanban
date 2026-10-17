import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractCodexUserQuestionPayload } from "../../src/commands/codex-user-question-payload-extraction";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import {
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
} from "../../src/state/agent-raised-pending-user-decision-store";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createTerminalInputBoxOccupancyTrackerState } from "../../src/terminal/terminal-input-box-occupancy";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../src/trpc/runtime-api";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const nativeSessionId = "01a147e5-2f4c-77c2-834d-a1f23008f27e";
const toolInput = {
	questions: [{ id: "storage", question: "采用哪种存储方案？", options: [{ label: "SQLite" }, { label: "文件" }] }],
};
const callLine = (callId: string) =>
	JSON.stringify({
		type: "response_item",
		timestamp: new Date(2000).toISOString(),
		payload: {
			type: "function_call",
			name: "request_user_input",
			call_id: callId,
			arguments: JSON.stringify(toolInput),
		},
	});
const resultLine = (output: string) =>
	JSON.stringify({
		type: "response_item",
		timestamp: new Date(2500).toISOString(),
		payload: { type: "function_call_output", call_id: "old-call", output },
	});

async function withSyntheticCodexConversation(
	run: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>,
) {
	await withIsolatedWorkspaceHome(async (register) => {
		const { workspaceId, path } = await register("codex-prewrite-validation");
		const previousCodexHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = join(homedir(), ".codex");
		try {
			await run(await createHarness(workspaceId, path));
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = previousCodexHome;
		}
	});
}

async function createHarness(workspaceId: string, workspacePath: string) {
	const transcriptDirectory = join(homedir(), ".codex", "sessions", "2026", "10", "17");
	await mkdir(transcriptDirectory, { recursive: true });
	const transcriptPath = join(transcriptDirectory, `rollout-${nativeSessionId}.jsonl`);
	const transcript = `${JSON.stringify({ type: "session_meta", timestamp: new Date(1000).toISOString(), payload: { id: nativeSessionId } })}\n${callLine("old-call")}\n${resultLine("aborted")}\n`;
	await writeFile(transcriptPath, transcript);
	const question = extractCodexUserQuestionPayload({
		callId: "old-call",
		toolInput,
		nativeConversationSessionId: nativeSessionId,
	});
	if (!question) throw new Error("合成问题无效");
	const decisionId = `guarded-answer:${question.decisionSourceId}`;
	await recordAgentRaisedPendingUserDecision(workspaceId, {
		workspaceId,
		taskId: "guarded-answer",
		agentId: "codex",
		sessionTransport: "pty_terminal",
		decisionId,
		nativeConversationSessionId: nativeSessionId,
		decisionKind: "ordinary_user_question",
		questionMarkdown: question.questionMarkdown,
		options: question.options,
		allowsFreeformAnswer: true,
		orderedQuestions: question.orderedQuestions,
		askedAt: 2000,
		graceDeadlineAt: null,
		originRuntimeSessionIncarnationId: "old-incarnation",
		originTurnSequence: 1,
		sourceHarnessSignal: "codex:request_user_input",
	});
	const manager = new TerminalSessionManager();
	const write = vi.fn();
	const summary: RuntimeTaskSessionSummary = {
		taskId: "guarded-answer",
		agentId: "codex",
		workspacePath,
		state: "idle",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: "resumed-incarnation",
		startedAt: 3000,
		updatedAt: 3000,
		lastOutputAt: null,
		lastHookAt: null,
		latestHookActivity: null,
		pid: 123,
		reviewReason: "hook",
		exitCode: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath,
			observedAt: 3000,
		},
	};
	const entry = {
		summary,
		active: {
			session: { write },
			deferredStartupPromptText: null,
			taskChatInputDeliveryTimer: null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			programmaticDeliveryReceipt: null,
			lastUserInputAt: null,
			outputReactionScanBuffer: null,
			inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			ptyOutputChunkArrivalSequenceNumber: 0,
		},
		terminalStateMirror: null,
	};
	const internals = manager as unknown as {
		entries: Map<string, typeof entry>;
		resolveInteractivePromptReadiness: () => Promise<"prompt">;
		resolveProgrammaticDeliveryInputBoxContentionForTask: () => Promise<null>;
	};
	internals.entries.set("guarded-answer", entry);
	const readiness = vi.spyOn(internals, "resolveInteractivePromptReadiness").mockResolvedValue("prompt");
	const contention = vi
		.spyOn(internals, "resolveProgrammaticDeliveryInputBoxContentionForTask")
		.mockResolvedValue(null);
	vi.spyOn(manager, "resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery").mockResolvedValue(true);
	const submit = vi.spyOn(manager, "submitTaskChatInputWhenReady");
	const runtime = createRuntimeApi({
		getScopedTerminalManager: async () => manager,
		loadScopedRuntimeConfig: async () => ({ selectedAgentId: "codex" }),
	} as unknown as CreateRuntimeApiDependencies);
	const answer = () =>
		runtime.answerAgentRaisedPendingUserDecision(
			{ workspaceId, workspacePath },
			{
				decisionId,
				selectedOptionIds: ["option-0"],
				freeformText: "保留已保存的答案",
				orderedQuestionAnswers: [
					{
						decisionQuestionId: "storage",
						selectedOptionIds: ["question-0-option-0"],
						freeformText: "保留已保存的答案",
					},
				],
			},
		);
	return { workspaceId, transcriptPath, manager, entry, write, readiness, contention, submit, answer };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe.sequential("Codex 面板答题在实际 PTY 写入前重新读取原生转录", () => {
	for (const stage of ["queued", "readiness_wait", "contention_wait", "after_paste", "before_resend"] as const) {
		for (const change of ["real_answer", "successor_call"] as const) {
			it(`${stage} 期间追加 ${change}，拦截旧答案或旧 Enter 并保留 durable 答案`, async () => {
				await withSyntheticCodexConversation(async (harness) => {
					vi.useFakeTimers();
					let releaseGate: () => void = () => undefined;
					if (stage === "readiness_wait")
						harness.readiness.mockImplementation(
							() =>
								new Promise<"prompt">((resolve) => {
									releaseGate = () => resolve("prompt");
								}),
						);
					if (stage === "contention_wait")
						harness.contention.mockImplementation(
							() =>
								new Promise<null>((resolve) => {
									releaseGate = () => resolve(null);
								}),
						);
					const pendingAnswer = harness.answer();
					await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
					if (stage !== "queued") await vi.advanceTimersByTimeAsync(1000);
					if (stage === "after_paste" || stage === "before_resend") {
						await vi.waitFor(() => expect(harness.write).toHaveBeenCalledOnce());
						harness.entry.active.ptyOutputChunkArrivalSequenceNumber++;
						if (stage === "before_resend") {
							await vi.advanceTimersByTimeAsync(60);
							await vi.waitFor(() => expect(harness.write).toHaveBeenCalledTimes(2));
						}
					}
					await appendFile(
						harness.transcriptPath,
						`${change === "real_answer" ? resultLine(JSON.stringify({ answers: { storage: { answers: ["文件"] } } })) : callLine("successor-call")}\n`,
					);
					releaseGate();
					await vi.advanceTimersByTimeAsync(stage === "before_resend" ? 2500 : stage === "queued" ? 1000 : 60);
					const result = await pendingAnswer;
					expect(result.delivered).toBe(false);
					expect(harness.write).toHaveBeenCalledTimes(
						stage === "before_resend" ? 2 : stage === "after_paste" ? 1 : 0,
					);
					const saved = (await readAgentRaisedPendingUserDecisions(harness.workspaceId)).find(
						(decision) =>
							decision.taskId === "guarded-answer" && decision.answer?.answerSource === "kanban_panel",
					);
					expect(saved?.answer?.freeformText).toBe("保留已保存的答案");
					expect(saved?.answerDeliveryState).toBe("delivery_failed");
					expect(saved?.lastAnswerDeliveryFailureReason).toContain(
						change === "real_answer" ? "终端作答" : "新提问取代",
					);
				});
			});
		}
	}

	it.each(["native_conversation", "incarnation", "selector"])(
		"入队后 %s 改变，实际 PTY 不接收旧答案",
		async (change) => {
			await withSyntheticCodexConversation(async (harness) => {
				vi.useFakeTimers();
				const pendingAnswer = harness.answer();
				await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
				if (change === "native_conversation")
					harness.entry.summary.agentNativeConversationSessionIdentity = {
						sourceAgentId: "codex",
						nativeSessionId: "different-conversation",
						transcriptPath: null,
						observedAt: Date.now(),
					};
				if (change === "incarnation") harness.entry.summary.runtimeSessionIncarnationId = "different-incarnation";
				if (change === "selector") harness.entry.summary.userTurnKind = "question";
				await vi.advanceTimersByTimeAsync(1000);
				expect((await pendingAnswer).delivered).toBe(false);
				expect(harness.write).not.toHaveBeenCalled();
			});
		},
	);

	it("正常恢复时只粘贴和提交一次，重复请求不再发送", async () => {
		await withSyntheticCodexConversation(async (harness) => {
			vi.useFakeTimers();
			const pendingAnswer = harness.answer();
			await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(harness.write).toHaveBeenCalledOnce());
			harness.entry.active.ptyOutputChunkArrivalSequenceNumber++;
			await vi.advanceTimersByTimeAsync(60);
			await vi.waitFor(() => expect(harness.write).toHaveBeenCalledTimes(2));
			harness.entry.summary.lastOutputAt = Date.now() + 2500;
			await vi.advanceTimersByTimeAsync(2500);
			expect((await pendingAnswer).delivered).toBe(true);
			expect((await harness.answer()).delivered).toBe(true);
			expect(harness.write).toHaveBeenCalledTimes(2);
		});
	});
});
