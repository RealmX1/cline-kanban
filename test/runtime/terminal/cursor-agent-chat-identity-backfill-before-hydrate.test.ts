import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate } from "../../../src/terminal/cursor-agent-chat-identity-backfill-before-hydrate";
import { resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory } from "../../../src/terminal/cursor-agent-chat-store-location-and-conversation-inspection";

let temporaryDirectoryPath: string;
let environmentOverrides: { CURSOR_CONFIG_DIR: string };

function workingDirectory(name: string): string {
	const path = join(temporaryDirectoryPath, name);
	mkdirSync(path, { recursive: true });
	return path;
}

async function writeCursorChat(workingDirectoryPath: string, chatId: string, hasConversation: boolean): Promise<void> {
	const bucketDirectoryPath = await resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
		workingDirectoryPath,
		environmentOverrides,
	);
	mkdirSync(join(bucketDirectoryPath, chatId), { recursive: true });
	writeFileSync(join(bucketDirectoryPath, chatId, "store.db"), "sqlite");
	writeFileSync(join(bucketDirectoryPath, chatId, "meta.json"), JSON.stringify({ hasConversation }));
}

function cursorSession(
	taskId: string,
	workingDirectoryPath: string | null,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "cursor",
		workspacePath: workingDirectoryPath,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: "exit",
		exitCode: 1,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: "会话连续 5 次启动后都在 30 秒内退出，已停止自动重启。请手动刷新终端。",
		...overrides,
	} as RuntimeTaskSessionSummary;
}

beforeEach(() => {
	temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-cursor-identity-backfill-"));
	environmentOverrides = { CURSOR_CONFIG_DIR: join(temporaryDirectoryPath, "cursor-config") };
});

afterEach(() => {
	rmSync(temporaryDirectoryPath, { recursive: true, force: true });
});

describe("backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate", () => {
	it("pins only an unambiguous chat, marks empty buckets as never established, and leaves every ambiguous case alone", async () => {
		const uniqueWorkingDirectory = workingDirectory("unique");
		const emptyWorkingDirectory = workingDirectory("empty");
		const ambiguousWorkingDirectory = workingDirectory("ambiguous");
		const sharedWorkingDirectory = workingDirectory("shared-by-two-cursor-sessions");
		const ghostWorkingDirectory = workingDirectory("ghost-copy-from-another-board");
		await writeCursorChat(uniqueWorkingDirectory, "4debf190-1111-4222-8333-944444444444", true);
		await writeCursorChat(uniqueWorkingDirectory, "aaaaaaaa-1111-4222-8333-944444444444", false);
		await writeCursorChat(ambiguousWorkingDirectory, "11111111-1111-4222-8333-944444444444", true);
		await writeCursorChat(ambiguousWorkingDirectory, "22222222-1111-4222-8333-944444444444", true);
		await writeCursorChat(sharedWorkingDirectory, "33333333-1111-4222-8333-944444444444", true);
		await writeCursorChat(ghostWorkingDirectory, "44444444-1111-4222-8333-944444444444", true);
		const sessions: Record<string, RuntimeTaskSessionSummary> = {
			unique: cursorSession("unique", uniqueWorkingDirectory),
			"8ef28": cursorSession("8ef28", emptyWorkingDirectory),
			ambiguous: cursorSession("ambiguous", ambiguousWorkingDirectory),
			"shared-a": cursorSession("shared-a", sharedWorkingDirectory),
			"shared-b": cursorSession("shared-b", sharedWorkingDirectory),
			ghost: cursorSession("ghost", ghostWorkingDirectory),
			"never-started": cursorSession("never-started", null),
			"claude-task": cursorSession("claude-task", emptyWorkingDirectory, { agentId: "claude" }),
		};
		const untouched = structuredClone(sessions);

		const outcome = await backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate({
			sessions,
			taskIdsOnWorkspaceBoard: new Set([
				"unique",
				"8ef28",
				"ambiguous",
				"shared-a",
				"shared-b",
				"never-started",
				"claude-task",
			]),
			currentTimeEpochMs: 1_790_000_000_000,
			environmentOverrides,
		});

		expect(outcome).toEqual({
			pinnedTaskConversationSessionIds: ["unique"],
			markedConversationNeverEstablishedTaskConversationSessionIds: ["8ef28"],
		});
		expect(sessions.unique?.agentNativeConversationSessionIdentity).toEqual({
			sourceAgentId: "cursor",
			nativeSessionId: "4debf190-1111-4222-8333-944444444444",
			transcriptPath: null,
			observedAt: 1_790_000_000_000,
			identityEstablishmentMethod: "unique_established_chat_in_working_directory_bucket_backfill",
		});
		expect(sessions["8ef28"]?.agentNativeConversationPersistenceObservation).toMatchObject({
			persistenceStatus: "conversation_never_established_in_agent_native_store",
			nativeSessionId: null,
			workingDirectoryPath: emptyWorkingDirectory,
		});
		// 熔断留下的「请手动刷新终端」被换成如实的说明。
		expect(sessions["8ef28"]?.warningMessage).toContain("没有可续接的 Cursor 对话");
		for (const leftAlone of ["ambiguous", "shared-a", "shared-b", "ghost", "never-started", "claude-task"]) {
			expect(sessions[leftAlone], leftAlone).toEqual(untouched[leftAlone]);
		}
	});

	it("marks a session whose recorded chat id never reached an established conversation", async () => {
		const workingDirectoryPath = workingDirectory("recorded-but-killed-before-first-checkpoint");
		await writeCursorChat(workingDirectoryPath, "55555555-1111-4222-8333-944444444444", false);
		const sessions: Record<string, RuntimeTaskSessionSummary> = {
			recorded: cursorSession("recorded", workingDirectoryPath, {
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "cursor",
					nativeSessionId: "55555555-1111-4222-8333-944444444444",
					transcriptPath: null,
					observedAt: 1,
					identityEstablishmentMethod: "kanban_assigned_before_agent_launch",
				},
			}),
		};

		const outcome = await backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate({
			sessions,
			taskIdsOnWorkspaceBoard: new Set(["recorded"]),
			currentTimeEpochMs: 2,
			environmentOverrides,
		});

		expect(outcome.markedConversationNeverEstablishedTaskConversationSessionIds).toEqual(["recorded"]);
		expect(sessions.recorded?.agentNativeConversationPersistenceObservation?.nativeSessionId).toBe(
			"55555555-1111-4222-8333-944444444444",
		);
		// 身份本身不动：它仍是这条会话的 id，只是对话没建立起来。
		expect(sessions.recorded?.agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
			"55555555-1111-4222-8333-944444444444",
		);
	});
});
