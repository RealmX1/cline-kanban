import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCodexUserQuestionTranscriptHistoryEntries,
	projectCodexUserQuestionTranscriptLines,
	recoverCodexUserQuestionsFromKnownConversation,
} from "../../../src/agent-session-history/codex-user-question-transcript-recovery";
import {
	extractCodexUserQuestionPayload,
	extractCodexUserQuestionResolution,
	resolveCodexUserQuestionHookEvent,
} from "../../../src/commands/codex-user-question-payload-extraction";
import { buildAgentRaisedDecisionPayloads } from "../../../src/commands/hooks";
import { classifyHookUserTurnKind } from "../../../src/core/harness-user-turn-kind-collection";

const sessionId = "01a147e5-2f4c-77c2-834d-a1f23008f27e";
const toolInput = {
	questions: [
		{
			id: "reclaimed_session_recovery_gesture",
			header: "恢复方式",
			question: "如何恢复？",
			options: [{ label: "打开、聚焦和重启按钮", description: "保留已有触发方式" }, { label: "鼠标停留恢复" }],
		},
	],
};
const question = (callId = "call-old", timestamp = "2026-10-17T03:32:52.378Z") =>
	JSON.stringify({
		timestamp,
		type: "response_item",
		payload: {
			type: "function_call",
			status: "completed",
			name: "request_user_input",
			call_id: callId,
			arguments: JSON.stringify(toolInput),
		},
	});
const output = (value: unknown, callId = "call-old") =>
	JSON.stringify({
		timestamp: "2026-10-17T20:33:59.806Z",
		type: "response_item",
		payload: { type: "function_call_output", call_id: callId, output: value },
	});
const answer = JSON.stringify({
	answers: { reclaimed_session_recovery_gesture: { answers: ["打开、聚焦和重启按钮"] } },
});

describe("Codex 原生问答的实时捕获与恢复投影", () => {
	it("真实工具名经过 hook 分流，保留原生问题 id，并正确切换问答边界", () => {
		const metadata = { source: "codex", toolName: "request_user_input", hookEventName: "PreToolUse" };
		const captured = buildAgentRaisedDecisionPayloads(
			{ tool_use_id: "call-old", tool_input: toolInput, session_id: sessionId },
			metadata,
		);
		expect(captured.agentRaisedUserQuestion?.orderedQuestions[0]?.decisionQuestionId).toBe(
			"reclaimed_session_recovery_gesture",
		);
		expect(captured.agentRaisedUserQuestion?.nativeConversationSessionId).toBe(sessionId);
		expect(resolveCodexUserQuestionHookEvent("activity", metadata)).toBe("to_review");
		expect(classifyHookUserTurnKind(metadata)).toBe("question");
		const resolved = buildAgentRaisedDecisionPayloads(
			{ tool_use_id: "call-old", tool_input: toolInput, tool_response: answer },
			{ ...metadata, hookEventName: "PostToolUse" },
		);
		expect(resolved.agentRaisedUserQuestionResolvedInAgentTerminal?.resolutionKind).toBe(
			"answered_in_agent_terminal",
		);
		expect(resolveCodexUserQuestionHookEvent("activity", { ...metadata, hookEventName: "PostToolUse" })).toBe(
			"to_in_progress",
		);
		expect(
			buildAgentRaisedDecisionPayloads(
				{ tool_use_id: "call-old", tool_input: toolInput },
				{ ...metadata, toolName: "mcp__other__request_user_input" },
			),
		).toEqual({});
	});

	it.each([
		"aborted",
		"cancelled",
		"interrupted",
		"tool execution failed",
		"{}",
		'{"answers":{}}',
		'{"answers":{"reclaimed_session_recovery_gesture":{"answers":[]}}}',
	])("无真实答案的输出 %s 不了结提问", (response) => {
		const exchanges = projectCodexUserQuestionTranscriptLines([question(), output(response)], sessionId);
		expect(exchanges[0]?.resolution?.resolutionKind).not.toBe("answered_in_agent_terminal");
		expect(exchanges[0]?.resolution?.answersForQuestions[0]?.answerText).toBeNull();
	});

	it("环境注入、恢复请求和普通后续消息均不冒充答案；其它 call 的结果也不配对", () => {
		const exchanges = projectCodexUserQuestionTranscriptLines(
			[
				question(),
				JSON.stringify({
					type: "response_item",
					payload: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "<environment_context/>" }],
					},
				}),
				JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "请恢复刚才的问题" } }),
				output(answer, "call-unrelated"),
			],
			sessionId,
		);
		expect(exchanges[0]?.resolution).toBeNull();
	});

	it("同一问题 id 重新提问产生两次调用；新答案只能归给新调用，重复转录幂等", () => {
		const lines = [
			question(),
			output("aborted"),
			question("call-new", "2026-10-17T20:05:08.213Z"),
			output(answer, "call-new"),
		];
		const exchanges = projectCodexUserQuestionTranscriptLines([...lines, ...lines], sessionId);
		expect(exchanges).toHaveLength(2);
		const history = buildCodexUserQuestionTranscriptHistoryEntries("36156", exchanges);
		expect(history.map((entry) => entry.resolution)).toEqual([
			"superseded_by_later_question_without_answer",
			"answered_in_agent_terminal",
		]);
		expect(history[0]?.questionAnswers[0]?.selectedOptionLabels).toEqual([]);
		expect(history[1]?.questionAnswers[0]?.selectedOptionLabels).toEqual(["打开、聚焦和重启按钮"]);
	});

	it("只有精确配对的 verified_answer 可在工具结果尚未落盘时证明用户已答", () => {
		const verified = (questionText: string) =>
			JSON.stringify({
				type: "retained_context",
				timestamp: "2026-10-17T20:33:58.548Z",
				payload: {
					type: "verified_answer",
					call_id: "call-old",
					questions: [{ question: questionText, answer: "打开、聚焦和重启按钮" }],
				},
			});
		expect(
			projectCodexUserQuestionTranscriptLines(
				[question(), verified("如何恢复？\n打开、聚焦和重启按钮: 保留已有触发方式")],
				sessionId,
			)[0]?.resolution?.resolutionKind,
		).toBe("answered_in_agent_terminal");
		expect(
			projectCodexUserQuestionTranscriptLines([question(), verified("另一个问题")], sessionId)[0]?.resolution,
		).toBeNull();
		expect(projectCodexUserQuestionTranscriptLines([verified("如何恢复？")], sessionId)).toEqual([]);
	});

	it("多问只答一问保留部分答案，不把整组标记已答", () => {
		const payload = extractCodexUserQuestionPayload({
			callId: "multi",
			toolInput: { questions: [...toolInput.questions, { ...toolInput.questions[0], id: "second" }] },
		});
		expect(payload).not.toBeNull();
		if (!payload) return;
		const resolution = extractCodexUserQuestionResolution({ callId: "multi", payload, toolResponse: answer });
		expect(resolution.resolutionKind).toBe("interrupted_without_answer");
		expect(resolution.answersForQuestions.map((entry) => entry.answerText)).toEqual(["打开、聚焦和重启按钮", null]);
	});

	it("读取带后缀的分页恢复文件，服从 history_base 字节边界，排除父分片的分叉尾部", async () => {
		const codexHome = await mkdtemp(join(tmpdir(), "codex-question-segments-"));
		try {
			const directory = join(codexHome, "sessions", "2026", "10", "17");
			await mkdir(directory, { recursive: true });
			const metadata = (timestamp: string, extra = {}) =>
				JSON.stringify({
					type: "session_meta",
					timestamp,
					payload: { id: sessionId, timestamp, history_mode: "paginated", history_base: null, ...extra },
				});
			const parentPrefix = `${metadata("2026-10-17T03:26:04.848Z")}\n${question()}\n`;
			await writeFile(join(directory, `rollout-old-${sessionId}.jsonl`), `${parentPrefix}${output(answer)}\n`);
			const parentRolloutId = "01a14b76-bb96-78d0-b57b-94db3a6a0315";
			const currentPath = join(directory, `rollout-new-${sessionId}_${parentRolloutId}.jsonl`);
			await writeFile(
				currentPath,
				`${metadata("2026-10-17T20:03:54.926Z", {
					history_mode: "paginated",
					history_base: {
						thread_id: sessionId,
						end_ordinal_exclusive: 2,
						end_byte_offset: Buffer.byteLength(parentPrefix),
					},
				})}\n${question("call-new", "2026-10-17T20:05:08.213Z")}\n${output(answer, "call-new")}\n`,
			);
			const recovered = await recoverCodexUserQuestionsFromKnownConversation({
				sessionId,
				homeDirectoryPath: codexHome,
				transcriptPath: currentPath,
			});
			expect(recovered.coverage).toBe("complete");
			expect(recovered.exchanges.map((exchange) => exchange.resolution?.resolutionKind)).toEqual([
				"interrupted_without_answer",
				"answered_in_agent_terminal",
			]);
			const currentText = await readFile(currentPath, "utf8");
			const siblingPath = join(directory, `rollout-sibling-${sessionId}_01a14ba0-0000-7000-8000-000000000000.jsonl`);
			await writeFile(siblingPath, `${metadata("2026-10-17T20:30:00.000Z")}\n${question("call-sibling")}\n`);
			const thirdPath = join(directory, `rollout-third-${sessionId}_01a14bca-21c9-7f62-acab-1bd026daa1ee.jsonl`);
			await writeFile(
				thirdPath,
				`${metadata("2026-10-17T21:00:00.000Z", {
					history_mode: "paginated",
					history_base: {
						thread_id: parentRolloutId,
						end_ordinal_exclusive: 5,
						end_byte_offset: Buffer.byteLength(currentText),
					},
				})}\n`,
			);
			const thirdRecovery = await recoverCodexUserQuestionsFromKnownConversation({
				sessionId,
				transcriptPath: thirdPath,
				homeDirectoryPath: codexHome,
			});
			expect(thirdRecovery.coverage).toBe("complete");
			expect(thirdRecovery.exchanges.map((exchange) => exchange.callId)).toEqual(["call-old", "call-new"]);

			expect(
				(
					await recoverCodexUserQuestionsFromKnownConversation({
						sessionId,
						homeDirectoryPath: codexHome,
						maximumTranscriptBytesToRead: 10,
					})
				).coverage,
			).toBe("incomplete");
			expect(
				(
					await recoverCodexUserQuestionsFromKnownConversation({
						sessionId: "other",
						homeDirectoryPath: codexHome,
						transcriptPath: currentPath,
					})
				).coverage,
			).toBe("unavailable");
		} finally {
			await rm(codexHome, { recursive: true, force: true });
		}
	});

	it("相同 ordinal 和字节数的异父旁支不能冒充明确的父分片", async () => {
		const codexHome = await mkdtemp(join(tmpdir(), "codex-question-parent-identity-"));
		try {
			const directory = join(codexHome, "sessions");
			await mkdir(directory, { recursive: true });
			const metadata = (timestamp: string, historyBase: unknown = null) =>
				JSON.stringify({
					type: "session_meta",
					timestamp,
					payload: { id: sessionId, timestamp, history_mode: "paginated", history_base: historyBase },
				});
			const parentPrefix = `${metadata("2026-10-17T03:00:00.000Z")}\n${question("call-parent")}\n`;
			const siblingPrefix = `${metadata("2026-10-17T04:00:00.000Z")}\n${question("call-branch")}\n`;
			expect(Buffer.byteLength(siblingPrefix)).toBe(Buffer.byteLength(parentPrefix));
			await writeFile(join(directory, `rollout-parent-${sessionId}.jsonl`), parentPrefix);
			await writeFile(
				join(directory, `rollout-branch-${sessionId}_01a14ba0-0000-7000-8000-000000000000.jsonl`),
				siblingPrefix,
			);
			const transcriptPath = join(
				directory,
				`rollout-current-${sessionId}_01a14bca-21c9-7f62-acab-1bd026daa1ee.jsonl`,
			);
			await writeFile(
				transcriptPath,
				`${metadata("2026-10-17T05:00:00.000Z", {
					thread_id: sessionId,
					end_ordinal_exclusive: 2,
					end_byte_offset: Buffer.byteLength(parentPrefix),
				})}\n`,
			);
			const recovered = await recoverCodexUserQuestionsFromKnownConversation({
				sessionId,
				transcriptPath,
				homeDirectoryPath: codexHome,
			});
			expect(recovered.coverage).toBe("complete");
			expect(recovered.exchanges.map((exchange) => exchange.callId)).toEqual(["call-parent"]);
		} finally {
			await rm(codexHome, { recursive: true, force: true });
		}
	});

	it.each(["missing", "ambiguous", "corrupted", "partial_record_boundary", "incorrect_ordinal"] as const)(
		"父分片 %s 时如实返回覆盖不足，且不混入未验证祖先的问题",
		async (scenario) => {
			const codexHome = await mkdtemp(join(tmpdir(), "codex-question-unverified-parent-"));
			try {
				const directory = join(codexHome, "sessions");
				await mkdir(directory, { recursive: true });
				const metadata = (timestamp: string, historyBase: unknown = null) =>
					JSON.stringify({
						type: "session_meta",
						timestamp,
						payload: { id: sessionId, timestamp, history_mode: "paginated", history_base: historyBase },
					});
				const parentPrefix = `${metadata("2026-10-17T03:00:00.000Z")}\n${question("call-parent")}\n`;
				if (scenario !== "missing") {
					await writeFile(
						join(directory, `rollout-parent-${sessionId}.jsonl`),
						scenario === "corrupted"
							? parentPrefix.replace('"status":"completed"', '"status":!completed!')
							: parentPrefix,
					);
				}
				if (scenario === "ambiguous")
					await writeFile(join(directory, `rollout-duplicate-${sessionId}.jsonl`), parentPrefix);
				const transcriptPath = join(
					directory,
					`rollout-current-${sessionId}_01a14bca-21c9-7f62-acab-1bd026daa1ee.jsonl`,
				);
				await writeFile(
					transcriptPath,
					`${metadata("2026-10-17T05:00:00.000Z", {
						thread_id: sessionId,
						end_ordinal_exclusive: scenario === "incorrect_ordinal" ? 3 : 2,
						end_byte_offset: Buffer.byteLength(parentPrefix) - (scenario === "partial_record_boundary" ? 1 : 0),
					})}\n${question("call-current")}\n`,
				);
				const recovered = await recoverCodexUserQuestionsFromKnownConversation({
					sessionId,
					transcriptPath,
					homeDirectoryPath: codexHome,
				});
				expect(recovered.coverage).toBe("incomplete");
				expect(recovered.exchanges.map((exchange) => exchange.callId)).toEqual(["call-current"]);
			} finally {
				await rm(codexHome, { recursive: true, force: true });
			}
		},
	);
});
