// 问答记录构建：账本来源（面板作答 / 终端作答含备注 / 放弃 / 被取代，且过滤旧版本一问两记的重复条目）、
// Claude 转录回填（只认结构化 toolUseResult，不从 TUI 文本猜）、两源按 tool_use_id 与正文去重合并。
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts,
	buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger,
	collectToolUseIdsAlreadyRecordedInDecisionLedger,
	listClaudeTranscriptFilesForTaskUserDecisionHistory,
	mergeAgentRaisedUserDecisionHistoryEntries,
} from "../../../src/agent-session-history/agent-raised-user-decision-history-builder";
import type { PersistedAgentRaisedPendingUserDecision } from "../../../src/state/agent-raised-pending-user-decision-store";

const QUESTION_TEXT = "数据访问层用哪种方案？";

function ledgerRecord(
	overrides: Partial<PersistedAgentRaisedPendingUserDecision>,
): PersistedAgentRaisedPendingUserDecision {
	return {
		decisionId: "task-a:toolu_1",
		taskId: "task-a",
		workspaceId: "workspace-1",
		agentId: "claude",
		sessionTransport: "pty_terminal",
		decisionKind: "ordinary_user_question",
		questionMarkdown: QUESTION_TEXT,
		options: [],
		allowsFreeformAnswer: true,
		orderedQuestions: [
			{
				decisionQuestionId: "question-0",
				headerMarkdown: "数据访问",
				questionMarkdown: QUESTION_TEXT,
				selectionMode: "single",
				options: [
					{ optionId: "question-0-option-0", label: "自建 SQL" },
					{ optionId: "question-0-option-1", label: "用 ORM" },
				],
				allowsFreeformAnswer: true,
			},
		],
		askedAt: 1_000,
		graceDeadlineAt: null,
		reclaimedAt: null,
		originRuntimeSessionIncarnationId: "incarnation-1",
		originTurnSequence: 1,
		sourceHarnessSignal: "claude:AskUserQuestion",
		status: "pending",
		supersededByDecisionId: null,
		answer: null,
		answerDeliveryState: "not_answered",
		answerDeliveryIdempotencyKey: "key",
		lastAnswerDeliveryFailureReason: null,
		createdAt: 1_000,
		updatedAt: 1_000,
		payloadSchemaVersion: 2,
		...overrides,
	};
}

function transcriptLine(value: unknown): string {
	return JSON.stringify(value);
}

function askUserQuestionToolUseLine(toolUseId: string, timestamp: string): string {
	return transcriptLine({
		type: "assistant",
		timestamp,
		message: {
			content: [
				{
					type: "tool_use",
					id: toolUseId,
					name: "AskUserQuestion",
					input: {
						questions: [
							{
								header: "数据访问",
								question: QUESTION_TEXT,
								multiSelect: false,
								options: [{ label: "自建 SQL" }, { label: "用 ORM" }],
							},
						],
					},
				},
			],
		},
	});
}

describe("buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger", () => {
	it("按来源区分作答方式；终端备注进入 notesText；面板作答带投递状态；pending 不进记录", () => {
		const entries = buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(
			[
				ledgerRecord({
					decisionId: "task-a:toolu_terminal",
					status: "answered",
					answerDeliveryState: "delivered",
					answer: {
						selectedOptionIds: ["question-0-option-1"],
						freeformText: null,
						orderedQuestionAnswers: [
							{
								decisionQuestionId: "question-0",
								selectedOptionIds: ["question-0-option-1"],
								freeformText: null,
							},
						],
						answeredAt: 2_000,
						answerSource: "agent_terminal",
						agentTerminalAnswersForQuestions: [
							{ questionText: QUESTION_TEXT, answerText: "用 ORM", notesText: "先别做迁移" },
						],
					},
				}),
				ledgerRecord({
					decisionId: "task-a:toolu_panel",
					askedAt: 3_000,
					status: "answered",
					answerDeliveryState: "delivery_failed",
					answer: {
						selectedOptionIds: [],
						freeformText: "手写回答",
						answeredAt: 4_000,
						answerSource: "kanban_panel",
					},
				}),
				ledgerRecord({ decisionId: "task-a:toolu_pending", status: "pending" }),
				ledgerRecord({ decisionId: "task-b:toolu_other_task", taskId: "task-b", status: "dismissed" }),
			],
			"task-a",
		);
		expect(entries.map((entry) => entry.resolution)).toEqual([
			"answered_in_agent_terminal",
			"answered_in_kanban_panel",
		]);
		expect(entries[0]?.questionAnswers).toEqual([
			{
				decisionQuestionId: "question-0",
				selectedOptionLabels: ["用 ORM"],
				freeformAnswerText: null,
				notesText: "先别做迁移",
			},
		]);
		expect(entries[0]?.answerDeliveryState).toBeNull();
		expect(entries[1]?.questionAnswers[0]?.freeformAnswerText).toBe("手写回答");
		expect(entries[1]?.answerDeliveryState).toBe("delivery_failed");
	});

	it("终端作答记录按落盘原文重新解析：旧版本已拆碎的含逗号标签在问答记录里也显示正确", () => {
		const [entry] = buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(
			[
				ledgerRecord({
					decisionId: "task-a:toolu_comma",
					status: "answered",
					answerDeliveryState: "delivered",
					orderedQuestions: [
						{
							decisionQuestionId: "question-0",
							headerMarkdown: null,
							questionMarkdown: QUESTION_TEXT,
							selectionMode: "multiple",
							options: [
								{ optionId: "question-0-option-0", label: "读写分离, 带缓存" },
								{ optionId: "question-0-option-1", label: "用 ORM" },
							],
							allowsFreeformAnswer: true,
						},
					],
					answer: {
						// 旧版本的切分结果：标签被拆碎，只识别出「用 ORM」，其余落进自由回答。
						selectedOptionIds: ["question-0-option-1"],
						freeformText: "读写分离, 带缓存",
						orderedQuestionAnswers: [
							{
								decisionQuestionId: "question-0",
								selectedOptionIds: ["question-0-option-1"],
								freeformText: "读写分离, 带缓存",
							},
						],
						answeredAt: 2_000,
						answerSource: "agent_terminal",
						agentTerminalAnswersForQuestions: [
							{ questionText: QUESTION_TEXT, answerText: "读写分离, 带缓存, 用 ORM", notesText: "备注" },
						],
					},
				}),
			],
			"task-a",
		);
		expect(entry?.questionAnswers).toEqual([
			{
				decisionQuestionId: "question-0",
				selectedOptionLabels: ["读写分离, 带缓存", "用 ORM"],
				freeformAnswerText: null,
				notesText: "备注",
			},
		]);
	});

	it("旧版本一问两记：被同正文后继顶掉的重复条目不作为「未作答」出现；正文不同的真·被取代仍保留", () => {
		const entries = buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(
			[
				ledgerRecord({
					decisionId: "task-a:toolu_dup",
					status: "superseded",
					supersededByDecisionId: "task-a:ask-user-question:dup",
				}),
				ledgerRecord({ decisionId: "task-a:ask-user-question:dup", status: "dismissed" }),
				ledgerRecord({
					decisionId: "task-a:toolu_old",
					questionMarkdown: "更早的另一个问题",
					status: "superseded",
					supersededByDecisionId: "task-a:ask-user-question:dup",
				}),
			],
			"task-a",
		);
		expect(entries.map((entry) => [entry.historyEntryId, entry.resolution])).toEqual([
			["ledger:task-a:ask-user-question:dup", "dismissed_in_kanban_panel"],
			["ledger:task-a:toolu_old", "superseded_by_later_question_without_answer"],
		]);
	});

	it("取消来源如实区分：面板取消 / 终端拒答 / 切换 agent 通道时自动取消（用户没做过任何取消动作）", () => {
		const entries = buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(
			[
				ledgerRecord({ decisionId: "task-a:toolu_panel", status: "dismissed", dismissalSource: "kanban_panel" }),
				ledgerRecord({
					decisionId: "task-a:toolu_terminal",
					status: "dismissed",
					dismissalSource: "agent_terminal",
				}),
				ledgerRecord({
					decisionId: "task-a:toolu_transport_switch",
					status: "dismissed",
					dismissalSource: "agent_session_transport_switch",
				}),
				ledgerRecord({ decisionId: "task-a:toolu_legacy_without_source", status: "dismissed" }),
			],
			"task-a",
		);
		expect(entries.map((entry) => [entry.historyEntryId, entry.resolution])).toEqual([
			["ledger:task-a:toolu_panel", "dismissed_in_kanban_panel"],
			["ledger:task-a:toolu_terminal", "declined_in_agent_terminal"],
			["ledger:task-a:toolu_transport_switch", "cancelled_by_agent_session_transport_switch"],
			["ledger:task-a:toolu_legacy_without_source", "dismissed_in_kanban_panel"],
		]);
	});
});

describe("Claude 转录回填与合并", () => {
	it("只认结构化作答结果：answers + annotations.notes；拒答记为终端拒答；仍在等答的不算记录", async () => {
		const transcriptDirectory = await mkdtemp(join(tmpdir(), "kanban-user-decision-history-"));
		try {
			const transcriptFilePath = join(transcriptDirectory, "session-1.jsonl");
			await writeFile(
				transcriptFilePath,
				[
					askUserQuestionToolUseLine("toolu_answered", "2026-09-01T10:00:00.000Z"),
					transcriptLine({
						type: "user",
						timestamp: "2026-09-01T10:01:00.000Z",
						toolUseResult: {
							answers: { [QUESTION_TEXT]: "自建 SQL, 读写分离" },
							annotations: { [QUESTION_TEXT]: { notes: "先做**读路径**" } },
						},
						message: { content: [{ type: "tool_result", tool_use_id: "toolu_answered", content: "answered" }] },
					}),
					askUserQuestionToolUseLine("toolu_rejected", "2026-09-01T11:00:00.000Z"),
					transcriptLine({
						type: "user",
						timestamp: "2026-09-01T11:00:05.000Z",
						toolUseResult: "User rejected tool use",
						message: {
							content: [
								{ type: "tool_result", tool_use_id: "toolu_rejected", is_error: true, content: "rejected" },
							],
						},
					}),
					askUserQuestionToolUseLine("toolu_still_waiting", "2026-09-01T12:00:00.000Z"),
					"这一行不是 JSON，必须被安全跳过",
				].join("\n"),
			);
			const entries = await buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts({
				taskId: "task-a",
				transcriptFilePaths: [transcriptFilePath],
			});
			expect(entries.map((entry) => [entry.historyEntryId, entry.resolution])).toEqual([
				["transcript:toolu_answered", "answered_in_agent_terminal"],
				["transcript:toolu_rejected", "declined_in_agent_terminal"],
			]);
			expect(entries[0]?.questionAnswers).toEqual([
				{
					decisionQuestionId: "question-0",
					selectedOptionLabels: ["自建 SQL"],
					freeformAnswerText: "读写分离",
					notesText: "先做**读路径**",
				},
			]);
			expect(entries[0]?.recordSource).toBe("agent_conversation_transcript");
		} finally {
			await rm(transcriptDirectory, { recursive: true, force: true });
		}
	});

	it("读取有总字节预算：从最新文件的末尾往前读，超出预算的更早内容与更旧文件都不读", async () => {
		const transcriptDirectory = await mkdtemp(join(tmpdir(), "kanban-user-decision-history-budget-"));
		try {
			const answeredExchangeLines = (toolUseId: string, askedAt: string, answeredAt: string) => [
				askUserQuestionToolUseLine(toolUseId, askedAt),
				transcriptLine({
					type: "user",
					timestamp: answeredAt,
					toolUseResult: { answers: { [QUESTION_TEXT]: "用 ORM" } },
					message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "answered" }] },
				}),
			];
			const earlierExchangeText = `${answeredExchangeLines("toolu_early_in_newest", "2026-09-01T10:00:00.000Z", "2026-09-01T10:01:00.000Z").join("\n")}\n`;
			const laterExchangeText = `${answeredExchangeLines("toolu_late_in_newest", "2026-09-02T10:00:00.000Z", "2026-09-02T10:01:00.000Z").join("\n")}\n`;
			const newestTranscriptFilePath = join(transcriptDirectory, "newest.jsonl");
			await writeFile(newestTranscriptFilePath, earlierExchangeText + laterExchangeText);
			const olderTranscriptFilePath = join(transcriptDirectory, "older.jsonl");
			await writeFile(
				olderTranscriptFilePath,
				answeredExchangeLines("toolu_in_older_file", "2026-08-01T10:00:00.000Z", "2026-08-01T10:01:00.000Z").join(
					"\n",
				),
			);
			// 预算 = 较晚那组问答 + 切进前一行的若干字节：被切断的半行必须被丢弃，而不是被当成完整行。
			const entries = await buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts({
				taskId: "task-a",
				transcriptFilePaths: [newestTranscriptFilePath, olderTranscriptFilePath],
				maximumTranscriptBytesToRead: Buffer.byteLength(laterExchangeText) + 20,
			});
			expect(entries.map((entry) => entry.historyEntryId)).toEqual(["transcript:toolu_late_in_newest"]);

			const entriesWithDefaultBudget = await buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts({
				taskId: "task-a",
				transcriptFilePaths: [newestTranscriptFilePath, olderTranscriptFilePath],
			});
			expect(new Set(entriesWithDefaultBudget.map((entry) => entry.historyEntryId))).toEqual(
				new Set([
					"transcript:toolu_early_in_newest",
					"transcript:toolu_late_in_newest",
					"transcript:toolu_in_older_file",
				]),
			);
		} finally {
			await rm(transcriptDirectory, { recursive: true, force: true });
		}
	});

	it("整目录扫描只对 task 独占目录开放；按修改时间取最近的文件，显式文件总会被包含", async () => {
		const root = await mkdtemp(join(tmpdir(), "kanban-user-decision-history-files-"));
		try {
			const exclusiveDirectory = join(root, "task-worktree-project");
			await mkdir(exclusiveDirectory);
			const olderFilePath = join(exclusiveDirectory, "older.jsonl");
			const newerFilePath = join(exclusiveDirectory, "newer.jsonl");
			await writeFile(olderFilePath, "");
			await writeFile(newerFilePath, "");
			await writeFile(join(exclusiveDirectory, "not-a-transcript.txt"), "");
			await utimes(olderFilePath, 1, 1);
			const explicitFilePath = join(root, "current-session.jsonl");
			await writeFile(explicitFilePath, "");

			expect(
				await listClaudeTranscriptFilesForTaskUserDecisionHistory({
					explicitTranscriptFilePaths: [explicitFilePath],
					claudeProjectDirectoryOwnedExclusivelyByTask: null,
				}),
			).toEqual([explicitFilePath]);
			const listed = await listClaudeTranscriptFilesForTaskUserDecisionHistory({
				explicitTranscriptFilePaths: [explicitFilePath, join(root, "already-deleted.jsonl")],
				claudeProjectDirectoryOwnedExclusivelyByTask: exclusiveDirectory,
			});
			expect(new Set(listed)).toEqual(new Set([explicitFilePath, newerFilePath, olderFilePath]));
			expect(listed.at(-1)).toBe(olderFilePath);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("合并：转录中已在账本的问答以账本为准（面板作答在转录里表现为一次拒绝），并按提问时间倒序", () => {
		const records = [
			ledgerRecord({
				decisionId: "task-a:toolu_panel_answered",
				status: "answered",
				answerDeliveryState: "delivered",
				askedAt: 5_000,
				answer: {
					selectedOptionIds: [],
					freeformText: "面板答案",
					answeredAt: 6_000,
					answerSource: "kanban_panel",
				},
			}),
			ledgerRecord({
				decisionId: "task-a:ask-user-question:正文派生",
				questionMarkdown: "正文派生的问题",
				orderedQuestions: [
					{
						decisionQuestionId: "question-0",
						headerMarkdown: null,
						questionMarkdown: "正文派生的问题",
						selectionMode: "single",
						options: [],
						allowsFreeformAnswer: true,
					},
				],
				status: "dismissed",
				askedAt: 2_000,
			}),
		];
		const ledgerEntries = buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(records, "task-a");
		const [templateLedgerEntry] = ledgerEntries;
		const templateQuestion = templateLedgerEntry?.orderedQuestions[0];
		if (!templateLedgerEntry || !templateQuestion) {
			throw new Error("Expected a ledger entry with one question to derive transcript fixtures from.");
		}
		const transcriptEntry = (toolUseId: string, askedAt: number, questionMarkdown: string) => ({
			...templateLedgerEntry,
			historyEntryId: `transcript:${toolUseId}`,
			recordSource: "agent_conversation_transcript" as const,
			askedAt,
			resolution: "declined_in_agent_terminal" as const,
			orderedQuestions: [{ ...templateQuestion, questionMarkdown }],
		});
		const merged = mergeAgentRaisedUserDecisionHistoryEntries({
			ledgerEntries,
			transcriptEntries: [
				transcriptEntry("toolu_panel_answered", 5_000, QUESTION_TEXT),
				transcriptEntry("toolu_same_text_as_ledger", 2_000, "正文派生的问题"),
				transcriptEntry("toolu_only_in_transcript", 9_000, "只在转录里的旧问题"),
			],
			toolUseIdsAlreadyRecordedInDecisionLedger: collectToolUseIdsAlreadyRecordedInDecisionLedger(records, "task-a"),
			ledgerQuestionMarkdownsForTask: new Set([QUESTION_TEXT, "正文派生的问题"]),
		});
		expect(merged.map((entry) => entry.historyEntryId)).toEqual([
			"transcript:toolu_only_in_transcript",
			"ledger:task-a:toolu_panel_answered",
			"ledger:task-a:ask-user-question:正文派生",
		]);
	});

	it("正文去重只吸收一问两记：正文派生账本条目只吞掉时间相近的一条同文转录；用新 tool_use_id 重问、仍在等答的同文问题都不抹掉真实作答", () => {
		const records = [
			// toolu 账本记录：同文重问（不同 tool_use_id、时间远）不能被它按正文吞掉。
			ledgerRecord({
				decisionId: "task-a:toolu_ledger_answered",
				status: "answered",
				answerDeliveryState: "delivered",
				askedAt: 500_000,
				answer: {
					selectedOptionIds: [],
					freeformText: "面板答案",
					answeredAt: 501_000,
					answerSource: "kanban_panel",
				},
			}),
			// 正文派生、已了结：只对应 2 秒前那次 tool_use。
			ledgerRecord({
				decisionId: "task-a:ask-user-question:正文派生",
				questionMarkdown: "正文派生的问题",
				orderedQuestions: [
					{
						decisionQuestionId: "question-0",
						headerMarkdown: null,
						questionMarkdown: "正文派生的问题",
						selectionMode: "single",
						options: [],
						allowsFreeformAnswer: true,
					},
				],
				status: "dismissed",
				askedAt: 1_002_000,
			}),
			// 正文派生、仍在等答：不进记录，也不参与去重。
			ledgerRecord({
				decisionId: "task-a:ask-user-question:仍在等答",
				questionMarkdown: "仍在等答的问题",
				orderedQuestions: [
					{
						decisionQuestionId: "question-0",
						headerMarkdown: null,
						questionMarkdown: "仍在等答的问题",
						selectionMode: "single",
						options: [],
						allowsFreeformAnswer: true,
					},
				],
				status: "pending",
				askedAt: 2_000_000,
			}),
		];
		const ledgerEntries = buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(records, "task-a");
		const [templateLedgerEntry] = ledgerEntries;
		const templateQuestion = templateLedgerEntry?.orderedQuestions[0];
		if (!templateLedgerEntry || !templateQuestion) {
			throw new Error("Expected a ledger entry with one question to derive transcript fixtures from.");
		}
		const transcriptEntry = (toolUseId: string, askedAt: number, questionMarkdown: string) => ({
			...templateLedgerEntry,
			historyEntryId: `transcript:${toolUseId}`,
			recordSource: "agent_conversation_transcript" as const,
			askedAt,
			resolution: "answered_in_agent_terminal" as const,
			orderedQuestions: [{ ...templateQuestion, questionMarkdown }],
		});
		const merged = mergeAgentRaisedUserDecisionHistoryEntries({
			ledgerEntries,
			transcriptEntries: [
				transcriptEntry("toolu_reask_same_text_as_toolu_ledger", 100_000, QUESTION_TEXT),
				// 一问两记：tool_use 比正文派生记录早 1.5 秒 → 被吸收。
				transcriptEntry("toolu_paired_with_derived_ledger", 1_000_500, "正文派生的问题"),
				// 窗口内的同文重问：该账本条目已吸收了更近的那条，不再吞第二条。
				transcriptEntry("toolu_reask_within_window_of_derived_ledger", 1_030_000, "正文派生的问题"),
				transcriptEntry("toolu_asked_long_before_derived_ledger", 10_000, "正文派生的问题"),
				transcriptEntry("toolu_answered_before_same_text_pending", 1_500_000, "仍在等答的问题"),
			],
			toolUseIdsAlreadyRecordedInDecisionLedger: collectToolUseIdsAlreadyRecordedInDecisionLedger(records, "task-a"),
		});
		expect(merged.map((entry) => entry.historyEntryId)).toEqual([
			"transcript:toolu_answered_before_same_text_pending",
			"transcript:toolu_reask_within_window_of_derived_ledger",
			"ledger:task-a:ask-user-question:正文派生",
			"ledger:task-a:toolu_ledger_answered",
			"transcript:toolu_reask_same_text_as_toolu_ledger",
			"transcript:toolu_asked_long_before_derived_ledger",
		]);
	});
});
