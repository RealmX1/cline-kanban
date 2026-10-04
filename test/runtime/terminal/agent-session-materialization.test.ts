import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// 「复制期间源 chat 被写」的模拟：在真实 copyFile 之后往源 store.db 追加字节，等价于一个正在写的 cursor-agent。
const sourceChatStoreMutationDuringCopy = vi.hoisted(() => ({ appendToSourcePathAfterCopy: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
			await actual.copyFile(...args);
			const pathToMutate = sourceChatStoreMutationDuringCopy.appendToSourcePathAfterCopy;
			if (pathToMutate !== null && String(args[0]) === pathToMutate) {
				await actual.appendFile(pathToMutate, "-concurrent-write");
			}
		},
	};
});

import { materializeTaskAgentSessionForExecutionWorkingDirectory } from "../../../src/terminal/agent-session-materialization";

const originalHome = process.env.HOME;
const originalCursorConfigDirectory = process.env.CURSOR_CONFIG_DIR;
let temporaryHomeDirectoryPath: string | null = null;

// cursor 的 chats 根按 CURSOR_CONFIG_DIR ‖ XDG_CONFIG_HOME/cursor ‖ ~/.cursor 解析，而 test:guarded 会把 XDG_CONFIG_HOME
// 指到隔离目录——这里显式钉住 CURSOR_CONFIG_DIR，让 fixture 路径与被测解析结果一致。
function createTemporaryHomeDirectory(): string {
	temporaryHomeDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-agent-session-materialization-"));
	process.env.HOME = temporaryHomeDirectoryPath;
	process.env.CURSOR_CONFIG_DIR = join(temporaryHomeDirectoryPath, ".cursor");
	return temporaryHomeDirectoryPath;
}

function fingerprintFile(filePath: string): { sha256: string; mtimeMs: number } {
	return {
		sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
		mtimeMs: statSync(filePath).mtimeMs,
	};
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
	sourceChatStoreMutationDuringCopy.appendToSourcePathAfterCopy = null;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalCursorConfigDirectory === undefined) delete process.env.CURSOR_CONFIG_DIR;
	else process.env.CURSOR_CONFIG_DIR = originalCursorConfigDirectory;
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

	it("copies a Cursor chat store into the execution worktree bucket without touching the source", async () => {
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
		writeFileSync(join(sourceChatDirectoryPath, "store.db-wal"), "wal");
		writeFileSync(join(sourceChatDirectoryPath, "store.db-shm"), "shm");
		writeFileSync(join(sourceChatDirectoryPath, "meta.json"), `{"cwd":"${sourceWorkingDirectoryPath}"}`);
		const sourceFingerprintsBefore = readdirSync(sourceChatDirectoryPath).map((fileName) =>
			fingerprintFile(join(sourceChatDirectoryPath, fileName)),
		);

		const initialization = {
			sourceAgentId: "cursor" as const,
			sourceSessionId: sessionId,
			sourceSessionReuseMode: "resume_existing_session" as const,
			sourceSessionWorkingDirectoryPath: sourceWorkingDirectoryPath,
		};
		await materializeTaskAgentSessionForExecutionWorkingDirectory({ initialization, executionWorkingDirectoryPath });

		const targetChatDirectoryPath = join(
			homeDirectoryPath,
			".cursor",
			"chats",
			hashCursorChatWorkingDirectoryPath(executionWorkingDirectoryPath),
			sessionId,
		);
		// 一份独立副本：新会话写的是它，而不是源对话的 store。
		expect(lstatSync(targetChatDirectoryPath).isDirectory()).toBe(true);
		expect(lstatSync(targetChatDirectoryPath).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(targetChatDirectoryPath, "store.db"), "utf8")).toBe("sqlite");
		expect(readFileSync(join(targetChatDirectoryPath, "store.db-wal"), "utf8")).toBe("wal");
		expect(readFileSync(join(targetChatDirectoryPath, "store.db-shm"), "utf8")).toBe("shm");
		// meta.json 留给 cursor 按目标 cwd 重建；复制过去会带着源 cwd 的陈旧值。
		expect(existsSync(join(targetChatDirectoryPath, "meta.json"))).toBe(false);
		expect(
			readdirSync(sourceChatDirectoryPath).map((fileName) =>
				fingerprintFile(join(sourceChatDirectoryPath, fileName)),
			),
		).toEqual(sourceFingerprintsBefore);

		// 幂等：已物化就不再复制，副本上的后续写入不会被覆盖回源的内容。
		writeFileSync(join(targetChatDirectoryPath, "store.db"), "sqlite-advanced-by-the-new-session");
		await materializeTaskAgentSessionForExecutionWorkingDirectory({ initialization, executionWorkingDirectoryPath });
		expect(readFileSync(join(targetChatDirectoryPath, "store.db"), "utf8")).toBe(
			"sqlite-advanced-by-the-new-session",
		);
		// 暂存目录不留残骸。
		expect(
			readdirSync(join(homeDirectoryPath, ".cline", "kanban", "cursor-agent-chat-materialization-staging")),
		).toEqual([]);
	});

	it("refuses to seed from a Cursor chat store that is being written while it is copied", async () => {
		const homeDirectoryPath = createTemporaryHomeDirectory();
		const sourceWorkingDirectoryPath = join(homeDirectoryPath, "source-checkout");
		const executionWorkingDirectoryPath = join(homeDirectoryPath, "task-worktree");
		const sessionId = "91111111-2222-4333-8444-555555555555";
		const sourceChatDirectoryPath = join(
			homeDirectoryPath,
			".cursor",
			"chats",
			hashCursorChatWorkingDirectoryPath(sourceWorkingDirectoryPath),
			sessionId,
		);
		mkdirSync(sourceChatDirectoryPath, { recursive: true });
		writeFileSync(join(sourceChatDirectoryPath, "store.db"), "sqlite");
		sourceChatStoreMutationDuringCopy.appendToSourcePathAfterCopy = join(sourceChatDirectoryPath, "store.db");

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
		).rejects.toThrow("is being written right now");
		const targetChatDirectoryPath = join(
			homeDirectoryPath,
			".cursor",
			"chats",
			hashCursorChatWorkingDirectoryPath(executionWorkingDirectoryPath),
			sessionId,
		);
		// 半份副本绝不能落进 cursor 的桶。
		expect(existsSync(targetChatDirectoryPath)).toBe(false);
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
		expect(readFileSync(join(targetChatDirectoryPath, "store.db"), "utf8")).toBe("sqlite");
		expect(lstatSync(targetChatDirectoryPath).isSymbolicLink()).toBe(false);
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
