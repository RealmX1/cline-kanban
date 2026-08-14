import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeClaudeProjectDirectoryName } from "../../../src/agent-session-history/bounded-agent-transcript-reader";
import {
	salvageLatestUnansweredClaudeUserQuestionForTask,
	salvageLatestUnansweredClaudeUserQuestionFromTranscriptLines,
	salvageLatestUnansweredCodexUserQuestionFromTranscriptLines,
} from "../../../src/agent-session-history/pending-user-decision-transcript-salvage";

function line(value: unknown): string {
	return JSON.stringify(value);
}

const CLAUDE_QUESTION = {
	questions: [
		{
			header: "恢复语义",
			question: "恢复时怎么处理？",
			multiSelect: false,
			options: [
				{ label: "只恢复", description: "不开始生成" },
				{ label: "恢复并继续", description: "立即继续" },
			],
		},
	],
};

describe("pending user decision transcript salvage", () => {
	it("补录 Claude 尾部未配 tool_result、且之后无人类输入的 AskUserQuestion", () => {
		const result = salvageLatestUnansweredClaudeUserQuestionFromTranscriptLines([
			line({
				type: "assistant",
				timestamp: "2026-08-12T15:33:34.120Z",
				message: {
					content: [{ type: "tool_use", id: "toolu-question", name: "AskUserQuestion", input: CLAUDE_QUESTION }],
				},
			}),
		]);

		expect(result?.payload.decisionSourceId).toBe("toolu-question");
		expect(result?.payload.orderedQuestions[0]?.questionMarkdown).toBe("恢复时怎么处理？");
		expect(result?.sourceHarnessSignal).toBe("claude:AskUserQuestion:transcript_salvage");
	});

	it("Claude 有配对 tool_result 时不补录", () => {
		expect(
			salvageLatestUnansweredClaudeUserQuestionFromTranscriptLines([
				line({
					type: "assistant",
					timestamp: "2026-08-12T15:33:34.120Z",
					message: {
						content: [
							{ type: "tool_use", id: "toolu-question", name: "AskUserQuestion", input: CLAUDE_QUESTION },
						],
					},
				}),
				line({
					type: "user",
					message: { content: [{ type: "tool_result", tool_use_id: "toolu-question", content: "chosen" }] },
				}),
			]),
		).toBeNull();
	});

	it("Claude 提问后出现普通人类输入时保守不补录", () => {
		expect(
			salvageLatestUnansweredClaudeUserQuestionFromTranscriptLines([
				line({
					type: "assistant",
					timestamp: "2026-08-12T15:33:34.120Z",
					message: {
						content: [
							{ type: "tool_use", id: "toolu-question", name: "AskUserQuestion", input: CLAUDE_QUESTION },
						],
					},
				}),
				line({
					type: "user",
					message: { content: "先别回答这个问题，继续调查" },
					origin: { kind: "human" },
				}),
			]),
		).toBeNull();
	});

	it("Claude 提问后的系统 task-notification 不算人类回答，仍可补录", () => {
		const result = salvageLatestUnansweredClaudeUserQuestionFromTranscriptLines([
			line({
				type: "assistant",
				timestamp: "2026-08-12T15:33:34.120Z",
				message: {
					content: [{ type: "tool_use", id: "toolu-question", name: "AskUserQuestion", input: CLAUDE_QUESTION }],
				},
			}),
			line({
				type: "user",
				message: { content: "<task-notification>system</task-notification>" },
				origin: { kind: "task-notification" },
				promptSource: "system",
			}),
		]);

		expect(result?.payload.decisionSourceId).toBe("toolu-question");
	});

	it("同 cwd 存在多个 Claude 会话时，无已知 session id 不猜最新文件；已知 id 只读精确会话", async () => {
		const homeDirectoryPath = await mkdtemp(join(tmpdir(), "kanban-claude-pending-decision-salvage-"));
		try {
			const workspacePath = "/tmp/shared-task-worktree";
			const projectDirectory = join(
				homeDirectoryPath,
				".claude",
				"projects",
				encodeClaudeProjectDirectoryName(workspacePath),
			);
			await mkdir(projectDirectory, { recursive: true });
			const intendedSessionPath = join(projectDirectory, "intended-session.jsonl");
			const unrelatedNewerSessionPath = join(projectDirectory, "unrelated-newer-session.jsonl");
			await writeFile(
				intendedSessionPath,
				`${line({
					type: "assistant",
					timestamp: "2026-08-12T15:33:34.120Z",
					message: {
						content: [
							{
								type: "tool_use",
								id: "toolu-intended-task-question",
								name: "AskUserQuestion",
								input: CLAUDE_QUESTION,
							},
						],
					},
				})}\n`,
				"utf8",
			);
			await writeFile(
				unrelatedNewerSessionPath,
				`${line({
					type: "assistant",
					timestamp: "2026-08-12T16:33:34.120Z",
					message: {
						content: [
							{
								type: "tool_use",
								id: "toolu-unrelated-task-question",
								name: "AskUserQuestion",
								input: CLAUDE_QUESTION,
							},
						],
					},
				})}\n`,
				"utf8",
			);
			await utimes(intendedSessionPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
			await utimes(unrelatedNewerSessionPath, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

			expect(
				await salvageLatestUnansweredClaudeUserQuestionForTask({ workspacePath, homeDirectoryPath }),
			).toBeNull();
			const exactSessionResult = await salvageLatestUnansweredClaudeUserQuestionForTask({
				workspacePath,
				homeDirectoryPath,
				knownSessionId: "intended-session",
			});
			expect(exactSessionResult?.payload.decisionSourceId).toBe("toolu-intended-task-question");
		} finally {
			await rm(homeDirectoryPath, { recursive: true, force: true });
		}
	});

	it("补录已知 Codex rollout 里的未配对 request_user_input", () => {
		const result = salvageLatestUnansweredCodexUserQuestionFromTranscriptLines([
			line({
				timestamp: "2026-08-12T15:07:24.728Z",
				type: "response_item",
				payload: {
					type: "function_call",
					name: "request_user_input",
					call_id: "call-question",
					arguments: JSON.stringify(CLAUDE_QUESTION),
				},
			}),
		]);

		expect(result?.payload.decisionSourceId).toBe("call-question");
		expect(result?.sourceHarnessSignal).toBe("codex:request_user_input:transcript_salvage");
	});

	it("Codex 有 function_call_output 或之后有 user_message 时不补录", () => {
		const question = line({
			timestamp: "2026-08-12T15:07:24.728Z",
			type: "response_item",
			payload: {
				type: "function_call",
				name: "request_user_input",
				call_id: "call-question",
				arguments: JSON.stringify(CLAUDE_QUESTION),
			},
		});
		expect(
			salvageLatestUnansweredCodexUserQuestionFromTranscriptLines([
				question,
				line({
					type: "response_item",
					payload: { type: "function_call_output", call_id: "call-question", output: "selected" },
				}),
			]),
		).toBeNull();
		expect(
			salvageLatestUnansweredCodexUserQuestionFromTranscriptLines([
				question,
				line({ type: "event_msg", payload: { type: "user_message", message: "continue" } }),
			]),
		).toBeNull();
	});
});
