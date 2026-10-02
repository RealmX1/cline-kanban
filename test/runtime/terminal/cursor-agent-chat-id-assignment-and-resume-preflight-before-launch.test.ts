import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { hasClaudeWorkspaceTrustPrompt } from "../../../src/terminal/claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt } from "../../../src/terminal/codex-workspace-trust";
import {
	assignCursorAgentChatIdBeforeLaunch,
	decideCursorAgentChatResumeTargetBeforeLaunch,
	describeCursorAgentConversationNeverEstablishedResumeRefusal,
} from "../../../src/terminal/cursor-agent-chat-id-assignment-and-resume-preflight-before-launch";
import type { CursorAgentChatConversationInspection } from "../../../src/terminal/cursor-agent-chat-store-location-and-conversation-inspection";
import { hasCursorWorkspaceTrustPrompt } from "../../../src/terminal/cursor-workspace-trust";

function inspection(
	chatId: string,
	overrides: Partial<CursorAgentChatConversationInspection> = {},
): CursorAgentChatConversationInspection {
	return {
		chatId,
		chatDirectoryPath: `/chats/bucket/${chatId}`,
		storeDatabaseFileExists: true,
		hasConversation: true,
		isSubagent: false,
		updatedAtMs: 1,
		...overrides,
	};
}

describe("assignCursorAgentChatIdBeforeLaunch", () => {
	it("hands out a fresh UUID every time (cursor-agent --resume requires a UUID)", () => {
		const first = assignCursorAgentChatIdBeforeLaunch();
		const second = assignCursorAgentChatIdBeforeLaunch();
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
		expect(second).not.toBe(first);
	});
});

describe("decideCursorAgentChatResumeTargetBeforeLaunch", () => {
	const noCompetitor = { hasCompetingCursorSessionInWorkingDirectory: false };

	it("resumes by the recorded id only when that chat holds an established conversation in this working directory", () => {
		expect(
			decideCursorAgentChatResumeTargetBeforeLaunch({
				recordedCursorChatId: "recorded",
				recordedChatInspection: inspection("recorded"),
				chatsInWorkingDirectoryBucket: [],
				...noCompetitor,
			}),
		).toEqual({ kind: "resume_by_recorded_chat_id", chatId: "recorded" });
	});

	it.each([
		[
			"the chat store is missing (killed before the first checkpoint, or the chat lives in another bucket)",
			{ storeDatabaseFileExists: false, hasConversation: null },
		],
		["the first checkpoint never happened", { hasConversation: false }],
	])("refuses a recorded id when %s, instead of letting --resume open a silently empty chat", (_label, overrides) => {
		expect(
			decideCursorAgentChatResumeTargetBeforeLaunch({
				recordedCursorChatId: "recorded",
				recordedChatInspection: inspection("recorded", overrides),
				// 桶里别的已建立对话不能拿来顶替：那是别人的对话。
				chatsInWorkingDirectoryBucket: [inspection("someone-else")],
				...noCompetitor,
			}),
		).toEqual({
			kind: "refuse_conversation_never_established_in_working_directory",
			recordedChatId: "recorded",
			refusalCause: "recorded_chat_has_no_established_conversation_in_working_directory",
		});
	});

	it("pins the unique established chat of a legacy session that never recorded an id", () => {
		expect(
			decideCursorAgentChatResumeTargetBeforeLaunch({
				recordedCursorChatId: null,
				recordedChatInspection: null,
				chatsInWorkingDirectoryBucket: [
					inspection("unique"),
					inspection("never-established", { hasConversation: false }),
					inspection("subagent", { isSubagent: true }),
				],
				...noCompetitor,
			}),
		).toEqual({ kind: "pin_unique_established_chat_then_resume_by_id", chatId: "unique" });
	});

	it("does not pin when another cursor session shares the working directory, and keeps --continue", () => {
		expect(
			decideCursorAgentChatResumeTargetBeforeLaunch({
				recordedCursorChatId: null,
				recordedChatInspection: null,
				chatsInWorkingDirectoryBucket: [inspection("unique")],
				hasCompetingCursorSessionInWorkingDirectory: true,
			}),
		).toEqual({ kind: "resume_latest_established_chat_in_working_directory_bucket", establishedChatCount: 1 });
	});

	it("keeps --continue without pinning when the bucket is ambiguous", () => {
		expect(
			decideCursorAgentChatResumeTargetBeforeLaunch({
				recordedCursorChatId: null,
				recordedChatInspection: null,
				chatsInWorkingDirectoryBucket: [inspection("first"), inspection("second")],
				...noCompetitor,
			}),
		).toEqual({ kind: "resume_latest_established_chat_in_working_directory_bucket", establishedChatCount: 2 });
	});

	it("refuses a legacy resume whose working directory has no established conversation (the 8ef28 / aa23d loop)", () => {
		const decision = decideCursorAgentChatResumeTargetBeforeLaunch({
			recordedCursorChatId: null,
			recordedChatInspection: null,
			chatsInWorkingDirectoryBucket: [],
			...noCompetitor,
		});
		expect(decision).toEqual({
			kind: "refuse_conversation_never_established_in_working_directory",
			recordedChatId: null,
			refusalCause: "working_directory_bucket_has_no_established_conversation",
		});
		const message = describeCursorAgentConversationNeverEstablishedResumeRefusal({
			refusalCause: "working_directory_bucket_has_no_established_conversation",
			recordedChatId: null,
			workingDirectoryPath: "/Users/example/.cline/worktrees/8ef28/review-validate-fix",
		});
		// 文案必须给出能走通的出路，并说清刷新为什么没用。
		expect(message).toContain("刷新也一样");
		expect(message).toContain("用原 prompt 全新开局");
		expect(message).toContain("从既有 Cursor 对话迁入");
	});
});

describe("hasCursorWorkspaceTrustPrompt", () => {
	const recordedCursorTrustDialogRawPtyOutput = readFileSync(
		join(__dirname, "fixtures", "cursor-agent-2026.10.01-workspace-trust-dialog-raw-pty-output.txt"),
		"utf8",
	);

	it("recognizes the dialog recorded from a real cursor-agent 2026.10.01 PTY", () => {
		expect(hasCursorWorkspaceTrustPrompt(recordedCursorTrustDialogRawPtyOutput)).toBe(true);
	});

	it("does not collide with Claude's trust prompt; Codex shares the exact sentence, so matchers are only consulted per agent", () => {
		expect(hasClaudeWorkspaceTrustPrompt(recordedCursorTrustDialogRawPtyOutput)).toBe(false);
		expect(hasCursorWorkspaceTrustPrompt("Yes, I trust this folder")).toBe(false);
		// Codex 与 Cursor 的对话框都问 "Do you trust the contents of this directory?"——这是事实上的重叠，所以
		// Cursor 的 matcher 只用于 Cursor 会话的状态标注，不参与任何自动应答。
		expect(hasCodexWorkspaceTrustPrompt(recordedCursorTrustDialogRawPtyOutput)).toBe(true);
	});
});
