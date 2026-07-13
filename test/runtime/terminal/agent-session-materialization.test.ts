import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeTaskAgentSessionForExecutionWorkingDirectory } from "../../../src/terminal/agent-session-materialization";

const originalHome = process.env.HOME;
let temporaryHomeDirectoryPath: string | null = null;

function createTemporaryHomeDirectory(): string {
	temporaryHomeDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-agent-session-materialization-"));
	process.env.HOME = temporaryHomeDirectoryPath;
	return temporaryHomeDirectoryPath;
}

function encodeClaudeProjectWorkingDirectoryPath(workingDirectoryPath: string): string {
	return resolve(workingDirectoryPath).replace(/[^a-zA-Z0-9]/gu, "-");
}

function hashCursorChatWorkingDirectoryPath(workingDirectoryPath: string): string {
	return createHash("md5").update(resolve(workingDirectoryPath)).digest("hex");
}

afterEach(() => {
	if (temporaryHomeDirectoryPath) rmSync(temporaryHomeDirectoryPath, { recursive: true, force: true });
	temporaryHomeDirectoryPath = null;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});

describe("materializeTaskAgentSessionForExecutionWorkingDirectory", () => {
	it("links a Claude transcript into a different execution worktree while preserving the original session", async () => {
		const homeDirectoryPath = createTemporaryHomeDirectory();
		const sourceWorkingDirectoryPath = join(homeDirectoryPath, "source-checkout");
		const executionWorkingDirectoryPath = join(homeDirectoryPath, "task-worktree");
		const sessionId = "11111111-2222-4333-8444-555555555555";
		const sourceTranscriptPath = join(
			homeDirectoryPath,
			".claude",
			"projects",
			encodeClaudeProjectWorkingDirectoryPath(sourceWorkingDirectoryPath),
			`${sessionId}.jsonl`,
		);
		mkdirSync(resolve(sourceTranscriptPath, ".."), { recursive: true });
		writeFileSync(sourceTranscriptPath, `${JSON.stringify({ sessionId, cwd: sourceWorkingDirectoryPath })}\n`);

		await Promise.all(
			Array.from({ length: 2 }, () =>
				materializeTaskAgentSessionForExecutionWorkingDirectory({
					initialization: {
						sourceAgentId: "claude",
						sourceSessionId: sessionId,
						sourceSessionReuseMode: "resume_existing_session",
						sourceSessionWorkingDirectoryPath: sourceWorkingDirectoryPath,
					},
					executionWorkingDirectoryPath,
				}),
			),
		);

		const targetTranscriptPath = join(
			homeDirectoryPath,
			".claude",
			"projects",
			encodeClaudeProjectWorkingDirectoryPath(executionWorkingDirectoryPath),
			`${sessionId}.jsonl`,
		);
		expect(lstatSync(targetTranscriptPath).isFile()).toBe(true);
		expect(lstatSync(targetTranscriptPath).ino).toBe(lstatSync(sourceTranscriptPath).ino);
	});

	it("links a Cursor chat store into the execution worktree hash", async () => {
		const homeDirectoryPath = createTemporaryHomeDirectory();
		const sourceWorkingDirectoryPath = join(homeDirectoryPath, "source-checkout");
		const executionWorkingDirectoryPath = join(homeDirectoryPath, "task-worktree");
		const sessionId = "21111111-2222-4333-8444-555555555555";
		const sourceChatDirectoryPath = join(
			homeDirectoryPath,
			".cursor",
			"chats",
			hashCursorChatWorkingDirectoryPath(sourceWorkingDirectoryPath),
			sessionId,
		);
		mkdirSync(sourceChatDirectoryPath, { recursive: true });
		writeFileSync(join(sourceChatDirectoryPath, "store.db"), "sqlite");
		writeFileSync(join(sourceChatDirectoryPath, "meta.json"), "{}");

		await materializeTaskAgentSessionForExecutionWorkingDirectory({
			initialization: {
				sourceAgentId: "cursor",
				sourceSessionId: sessionId,
				sourceSessionReuseMode: "resume_existing_session",
				sourceSessionWorkingDirectoryPath: sourceWorkingDirectoryPath,
			},
			executionWorkingDirectoryPath,
		});

		const targetChatDirectoryPath = join(
			homeDirectoryPath,
			".cursor",
			"chats",
			hashCursorChatWorkingDirectoryPath(executionWorkingDirectoryPath),
			sessionId,
		);
		expect(lstatSync(targetChatDirectoryPath).isSymbolicLink()).toBe(true);
		expect(realpathSync(targetChatDirectoryPath)).toBe(realpathSync(sourceChatDirectoryPath));
	});

	it("rejects an existing Claude transcript that references a different session source", async () => {
		const homeDirectoryPath = createTemporaryHomeDirectory();
		const sourceWorkingDirectoryPath = join(homeDirectoryPath, "source-checkout");
		const executionWorkingDirectoryPath = join(homeDirectoryPath, "task-worktree");
		const sessionId = "71111111-2222-4333-8444-555555555555";
		const sourceTranscriptPath = join(
			homeDirectoryPath,
			".claude",
			"projects",
			encodeClaudeProjectWorkingDirectoryPath(sourceWorkingDirectoryPath),
			`${sessionId}.jsonl`,
		);
		const targetTranscriptPath = join(
			homeDirectoryPath,
			".claude",
			"projects",
			encodeClaudeProjectWorkingDirectoryPath(executionWorkingDirectoryPath),
			`${sessionId}.jsonl`,
		);
		mkdirSync(resolve(sourceTranscriptPath, ".."), { recursive: true });
		mkdirSync(resolve(targetTranscriptPath, ".."), { recursive: true });
		writeFileSync(sourceTranscriptPath, "source transcript\n");
		writeFileSync(targetTranscriptPath, "different transcript\n");

		await expect(
			materializeTaskAgentSessionForExecutionWorkingDirectory({
				initialization: {
					sourceAgentId: "claude",
					sourceSessionId: sessionId,
					sourceSessionReuseMode: "resume_existing_session",
					sourceSessionWorkingDirectoryPath: sourceWorkingDirectoryPath,
				},
				executionWorkingDirectoryPath,
			}),
		).rejects.toThrow(
			`Session storage already exists at ${targetTranscriptPath} and points to a different session source.`,
		);
	});

	it("reports a broken Cursor target symbolic link as a conflicting session source", async () => {
		const homeDirectoryPath = createTemporaryHomeDirectory();
		const sourceWorkingDirectoryPath = join(homeDirectoryPath, "source-checkout");
		const executionWorkingDirectoryPath = join(homeDirectoryPath, "task-worktree");
		const sessionId = "81111111-2222-4333-8444-555555555555";
		const sourceChatDirectoryPath = join(
			homeDirectoryPath,
			".cursor",
			"chats",
			hashCursorChatWorkingDirectoryPath(sourceWorkingDirectoryPath),
			sessionId,
		);
		const targetChatDirectoryPath = join(
			homeDirectoryPath,
			".cursor",
			"chats",
			hashCursorChatWorkingDirectoryPath(executionWorkingDirectoryPath),
			sessionId,
		);
		mkdirSync(sourceChatDirectoryPath, { recursive: true });
		writeFileSync(join(sourceChatDirectoryPath, "store.db"), "sqlite");
		mkdirSync(resolve(targetChatDirectoryPath, ".."), { recursive: true });
		symlinkSync(join(homeDirectoryPath, "missing-cursor-chat"), targetChatDirectoryPath, "dir");

		await expect(
			materializeTaskAgentSessionForExecutionWorkingDirectory({
				initialization: {
					sourceAgentId: "cursor",
					sourceSessionId: sessionId,
					sourceSessionReuseMode: "resume_existing_session",
					sourceSessionWorkingDirectoryPath: sourceWorkingDirectoryPath,
				},
				executionWorkingDirectoryPath,
			}),
		).rejects.toThrow(
			`Session storage already exists at ${targetChatDirectoryPath} and points to a different session source.`,
		);
		expect(lstatSync(targetChatDirectoryPath).isSymbolicLink()).toBe(true);
	});

	it("discovers a manually entered session ID when no source working directory was persisted", async () => {
		const homeDirectoryPath = createTemporaryHomeDirectory();
		const executionWorkingDirectoryPath = join(homeDirectoryPath, "task-worktree");
		const sessionId = "31111111-2222-4333-8444-555555555555";
		const sourceTranscriptPath = join(
			homeDirectoryPath,
			".claude",
			"projects",
			"-unknown-source",
			`${sessionId}.jsonl`,
		);
		mkdirSync(resolve(sourceTranscriptPath, ".."), { recursive: true });
		writeFileSync(sourceTranscriptPath, "{}\n");

		await materializeTaskAgentSessionForExecutionWorkingDirectory({
			initialization: {
				sourceAgentId: "claude",
				sourceSessionId: sessionId,
				sourceSessionReuseMode: "fork_existing_session",
			},
			executionWorkingDirectoryPath,
		});

		const targetTranscriptPath = join(
			homeDirectoryPath,
			".claude",
			"projects",
			encodeClaudeProjectWorkingDirectoryPath(executionWorkingDirectoryPath),
			`${sessionId}.jsonl`,
		);
		expect(lstatSync(targetTranscriptPath).ino).toBe(lstatSync(sourceTranscriptPath).ino);
	});

	it("ignores newer incomplete Cursor directories when discovering a manually entered session ID", async () => {
		const homeDirectoryPath = createTemporaryHomeDirectory();
		const executionWorkingDirectoryPath = join(homeDirectoryPath, "task-worktree");
		const sessionId = "41111111-2222-4333-8444-555555555555";
		const cursorChatsDirectoryPath = join(homeDirectoryPath, ".cursor", "chats");
		const validSourceChatDirectoryPath = join(cursorChatsDirectoryPath, "valid-workspace", sessionId);
		const incompleteSourceChatDirectoryPath = join(cursorChatsDirectoryPath, "incomplete-workspace", sessionId);
		mkdirSync(validSourceChatDirectoryPath, { recursive: true });
		writeFileSync(join(validSourceChatDirectoryPath, "store.db"), "sqlite");
		mkdirSync(incompleteSourceChatDirectoryPath, { recursive: true });
		writeFileSync(join(incompleteSourceChatDirectoryPath, "meta.json"), "{}");
		utimesSync(validSourceChatDirectoryPath, new Date(1_000), new Date(1_000));
		utimesSync(incompleteSourceChatDirectoryPath, new Date(2_000), new Date(2_000));

		await materializeTaskAgentSessionForExecutionWorkingDirectory({
			initialization: {
				sourceAgentId: "cursor",
				sourceSessionId: sessionId,
				sourceSessionReuseMode: "resume_existing_session",
			},
			executionWorkingDirectoryPath,
		});

		const targetChatDirectoryPath = join(
			cursorChatsDirectoryPath,
			hashCursorChatWorkingDirectoryPath(executionWorkingDirectoryPath),
			sessionId,
		);
		expect(realpathSync(targetChatDirectoryPath)).toBe(realpathSync(validSourceChatDirectoryPath));
	});

	it("fails with an actionable error when local source storage is missing", async () => {
		createTemporaryHomeDirectory();
		await expect(
			materializeTaskAgentSessionForExecutionWorkingDirectory({
				initialization: {
					sourceAgentId: "cursor",
					sourceSessionId: "51111111-2222-4333-8444-555555555555",
					sourceSessionReuseMode: "resume_existing_session",
				},
				executionWorkingDirectoryPath: "/missing-target",
			}),
		).rejects.toThrow("was not found in local chat storage");
	});

	it("does nothing for Codex because its session store is already worktree-independent", async () => {
		createTemporaryHomeDirectory();
		await expect(
			materializeTaskAgentSessionForExecutionWorkingDirectory({
				initialization: {
					sourceAgentId: "codex",
					sourceSessionId: "61111111-2222-4333-8444-555555555555",
					sourceSessionReuseMode: "fork_existing_session",
				},
				executionWorkingDirectoryPath: "/any-target",
			}),
		).resolves.toBeUndefined();
	});
});
