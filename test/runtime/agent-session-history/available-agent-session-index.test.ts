import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	configureAvailableAgentSessionIndexLimitsForTests,
	getAvailableAgentSessionIndexCacheSizeForTests,
	listAvailableAgentSessions,
	resetAvailableAgentSessionIndexStateForTests,
} from "../../../src/agent-session-history/available-agent-session-index";
import { createGitProcessEnv } from "../../../src/core/git-process-env";

const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
let temporaryRoot: string | null = null;

function createTemporaryRoot(): string {
	temporaryRoot = mkdtempSync(join(tmpdir(), "kanban-agent-session-index-"));
	process.env.HOME = temporaryRoot;
	delete process.env.CODEX_HOME;
	return temporaryRoot;
}

function writeJsonLines(filePath: string, records: unknown[]): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

afterEach(() => {
	resetAvailableAgentSessionIndexStateForTests();
	if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
	temporaryRoot = null;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = originalCodexHome;
});

describe("listAvailableAgentSessions", () => {
	it("indexes Claude sessions and keeps repository scope inside the current Git repository", async () => {
		const root = createTemporaryRoot();
		const workspacePath = join(root, "repository");
		mkdirSync(workspacePath, { recursive: true });
		execFileSync("git", ["init"], { cwd: workspacePath, env: createGitProcessEnv(), stdio: "ignore" });
		const sessionId = "11111111-2222-3333-8444-555555555555";
		writeJsonLines(join(root, ".claude", "projects", "repository", `${sessionId}.jsonl`), [
			{
				type: "user",
				sessionId,
				cwd: workspacePath,
				timestamp: "2026-07-12T01:00:00.000Z",
				message: { content: "Implement search" },
			},
			{
				type: "assistant",
				sessionId,
				cwd: workspacePath,
				timestamp: "2026-07-12T01:01:00.000Z",
				message: { model: "claude-opus", content: "I will inspect the repository." },
			},
		]);

		const result = await listAvailableAgentSessions(workspacePath, {
			agentId: "claude",
			searchScope: "current_repository",
			query: "inspect",
			pageCursor: 0,
			pageSize: 50,
			forceRefresh: true,
		});

		expect(result.totalMatchingSessions).toBe(1);
		expect(result.sessions[0]).toMatchObject({
			sourceAgentId: "claude",
			sourceSessionId: sessionId,
			sessionWorkingDirectoryPath: workspacePath,
			modelId: "claude-opus",
		});
		expect(result.sessions[0]?.previewConversationTurns).toHaveLength(2);
	});

	it("indexes Codex user sessions, excludes workers, and paginates all-local results", async () => {
		const root = createTemporaryRoot();
		const workspacePath = join(root, "repository");
		mkdirSync(workspacePath, { recursive: true });
		execFileSync("git", ["init"], { cwd: workspacePath, env: createGitProcessEnv(), stdio: "ignore" });
		const sessionsDirectory = join(root, ".codex", "sessions", "2026", "07", "12");
		for (const [index, sessionId] of [
			"21111111-2222-3333-8444-555555555555",
			"31111111-2222-3333-8444-555555555555",
		].entries()) {
			writeJsonLines(join(sessionsDirectory, `rollout-${sessionId}.jsonl`), [
				{
					type: "session_meta",
					timestamp: `2026-07-12T0${index + 1}:00:00.000Z`,
					payload: { id: sessionId, cwd: workspacePath, thread_source: "user" },
				},
				{
					type: "event_msg",
					timestamp: `2026-07-12T0${index + 1}:01:00.000Z`,
					payload: { type: "user_message", message: `Task ${index}` },
				},
			]);
		}
		const workerId = "41111111-2222-3333-8444-555555555555";
		writeJsonLines(join(sessionsDirectory, `rollout-${workerId}.jsonl`), [
			{ type: "session_meta", payload: { id: workerId, cwd: workspacePath, thread_source: "subagent" } },
			{ type: "event_msg", payload: { type: "user_message", message: "Worker task" } },
		]);

		const firstPage = await listAvailableAgentSessions(workspacePath, {
			agentId: "codex",
			searchScope: "all_local_sessions",
			query: "",
			pageCursor: 0,
			pageSize: 1,
			forceRefresh: true,
		});
		expect(firstPage.totalMatchingSessions).toBe(2);
		expect(firstPage.sessions).toHaveLength(1);
		expect(firstPage.nextPageCursor).toBe(1);
	});

	it("indexes Cursor agent transcripts and returns their chat UUID", async () => {
		const root = createTemporaryRoot();
		const workspacePath = join(root, "repository");
		mkdirSync(workspacePath, { recursive: true });
		execFileSync("git", ["init"], { cwd: workspacePath, env: createGitProcessEnv(), stdio: "ignore" });
		const sessionId = "51111111-2222-3333-8444-555555555555";
		const encodedWorkspacePath = workspacePath.replace(/[^a-zA-Z0-9]/gu, "-").replace(/^-+/u, "");
		writeJsonLines(
			join(root, ".cursor", "projects", encodedWorkspacePath, "agent-transcripts", sessionId, `${sessionId}.jsonl`),
			[
				{ role: "user", message: { content: "Continue the Cursor task" } },
				{ role: "assistant", message: { content: "Inspecting the files" } },
			],
		);

		const result = await listAvailableAgentSessions(workspacePath, {
			agentId: "cursor",
			searchScope: "current_repository",
			query: "Cursor",
			pageCursor: 0,
			pageSize: 50,
			forceRefresh: true,
		});

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.sourceSessionId).toBe(sessionId);
		expect(result.sessions[0]?.sessionWorkingDirectoryPath).toBe(workspacePath);
	});

	it("reads bounded transcript head and tail while discarding partial JSONL boundary lines", async () => {
		const root = createTemporaryRoot();
		const workspacePath = join(root, "repository");
		mkdirSync(workspacePath, { recursive: true });
		execFileSync("git", ["init"], { cwd: workspacePath, env: createGitProcessEnv(), stdio: "ignore" });
		configureAvailableAgentSessionIndexLimitsForTests({
			maximumTranscriptBytesPerFile: 1_200,
			maximumTranscriptBytesPerScan: 8_000,
			sessionScanDeadlineMilliseconds: 10_000,
		});
		const sessionId = "61111111-2222-3333-8444-555555555555";
		writeJsonLines(join(root, ".claude", "projects", "repository", `${sessionId}.jsonl`), [
			{
				type: "user",
				sessionId,
				cwd: workspacePath,
				timestamp: "2026-07-12T01:00:00.000Z",
				message: { content: "Head message" },
			},
			{ type: "progress", payload: "x".repeat(8_000) },
			{
				type: "assistant",
				sessionId,
				cwd: workspacePath,
				timestamp: "2026-07-12T01:01:00.000Z",
				message: { model: "claude-opus", content: "Tail message" },
			},
		]);

		const result = await listAvailableAgentSessions(workspacePath, {
			agentId: "claude",
			searchScope: "all_local_sessions",
			query: "",
			pageCursor: 0,
			pageSize: 50,
			forceRefresh: true,
		});

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.previewConversationTurns.map((turn) => turn.text)).toEqual([
			"Head message",
			"Tail message",
		]);
		expect(result.scanWarnings).toContain("1 session transcript was previewed from bounded head/tail data.");
	});

	it("stops at the per-request read budget after indexing the newest transcripts", async () => {
		const root = createTemporaryRoot();
		const workspacePath = join(root, "repository");
		mkdirSync(workspacePath, { recursive: true });
		configureAvailableAgentSessionIndexLimitsForTests({
			maximumTranscriptBytesPerFile: 500,
			maximumTranscriptBytesPerScan: 1_000,
			sessionScanDeadlineMilliseconds: 10_000,
		});
		const sessionsDirectory = join(root, ".cursor", "projects", "repository", "agent-transcripts");
		for (const [index, sessionId] of [
			"71111111-2222-3333-8444-555555555555",
			"81111111-2222-3333-8444-555555555555",
			"91111111-2222-3333-8444-555555555555",
		].entries()) {
			const transcriptPath = join(sessionsDirectory, sessionId, `${sessionId}.jsonl`);
			writeJsonLines(transcriptPath, [
				{ role: "user", message: { content: `Newest ordering ${index} ${"x".repeat(360)}` } },
			]);
			const modifiedAt = new Date(`2026-07-12T0${index + 1}:00:00.000Z`);
			utimesSync(transcriptPath, modifiedAt, modifiedAt);
		}

		const result = await listAvailableAgentSessions(workspacePath, {
			agentId: "cursor",
			searchScope: "all_local_sessions",
			query: "",
			pageCursor: 0,
			pageSize: 50,
			forceRefresh: true,
		});

		expect(result.sessions.map((session) => session.sourceSessionId)).toEqual([
			"91111111-2222-3333-8444-555555555555",
			"81111111-2222-3333-8444-555555555555",
		]);
		expect(result.scanWarnings.some((warning) => warning.includes("read budget"))).toBe(true);
	});

	it("evicts least-recently-used parsed sessions when the cache reaches its explicit limit", async () => {
		const root = createTemporaryRoot();
		const workspacePath = join(root, "repository");
		mkdirSync(workspacePath, { recursive: true });
		configureAvailableAgentSessionIndexLimitsForTests({
			parsedSessionCacheMaximumEntries: 2,
			sessionScanDeadlineMilliseconds: 10_000,
		});
		const sessionsDirectory = join(root, ".codex", "sessions", "2026", "07", "12");
		for (const sessionId of [
			"a1111111-2222-3333-8444-555555555555",
			"b1111111-2222-3333-8444-555555555555",
			"c1111111-2222-3333-8444-555555555555",
		]) {
			writeJsonLines(join(sessionsDirectory, `rollout-${sessionId}.jsonl`), [
				{ type: "session_meta", payload: { id: sessionId, cwd: workspacePath, thread_source: "user" } },
				{ type: "event_msg", payload: { type: "user_message", message: sessionId } },
			]);
		}

		await listAvailableAgentSessions(workspacePath, {
			agentId: "codex",
			searchScope: "all_local_sessions",
			query: "",
			pageCursor: 0,
			pageSize: 50,
			forceRefresh: true,
		});

		expect(getAvailableAgentSessionIndexCacheSizeForTests()).toBe(2);
	});

	it("returns a truncation warning when the scan deadline is exhausted", async () => {
		const root = createTemporaryRoot();
		const workspacePath = join(root, "repository");
		mkdirSync(workspacePath, { recursive: true });
		configureAvailableAgentSessionIndexLimitsForTests({ sessionScanDeadlineMilliseconds: 0 });
		const sessionId = "d1111111-2222-3333-8444-555555555555";
		writeJsonLines(
			join(root, ".cursor", "projects", "repository", "agent-transcripts", sessionId, `${sessionId}.jsonl`),
			[{ role: "user", message: { content: "Deadline test" } }],
		);

		const result = await listAvailableAgentSessions(workspacePath, {
			agentId: "cursor",
			searchScope: "all_local_sessions",
			query: "",
			pageCursor: 0,
			pageSize: 50,
			forceRefresh: true,
		});

		expect(result.sessions).toEqual([]);
		expect(result.scanWarnings[0]).toContain("stopped after 0ms");
	});
});
