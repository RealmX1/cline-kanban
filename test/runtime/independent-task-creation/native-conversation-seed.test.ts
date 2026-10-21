import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeClaudeCodeProjectDirectoryName } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { freezeIndependentTaskConversationSeed } from "../../../src/independent-task-creation/native-conversation-seed";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withCodexAppServerRequestConnection: async (
		_input: unknown,
		operation: (port: { request: typeof mocked.request }) => Promise<unknown>,
	) => operation({ request: mocked.request }),
}));
afterEach(() => vi.unstubAllEnvs());

describe("固定独立任务的原生历史", () => {
	it("Claude SDK 只复制真实格式的转录，不启动模型，也不修改来源", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "claude-source" });
		const configDirectory = join(fixture.isolatedHomeDirectoryPath, ".claude");
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
		const encodedProjectDirectory = encodeClaudeCodeProjectDirectoryName(repo.repositoryPath);
		const projectDirectory = join(
			configDirectory,
			"projects",
			encodedProjectDirectory.length > 200
				? `${encodedProjectDirectory.slice(0, 200)}-fixture`
				: encodedProjectDirectory,
		);
		mkdirSync(projectDirectory, { recursive: true });
		const nativeSessionId = randomUUID();
		const userId = randomUUID();
		const transcriptPath = join(projectDirectory, `${nativeSessionId}.jsonl`);
		const text = `${[
			{
				type: "user",
				uuid: userId,
				parentUuid: null,
				sessionId: nativeSessionId,
				timestamp: "2026-01-01T00:00:00Z",
				cwd: repo.repositoryPath,
				message: { role: "user", content: "保留全部来源需求" },
			},
			{
				type: "assistant",
				uuid: randomUUID(),
				parentUuid: userId,
				sessionId: nativeSessionId,
				timestamp: "2026-01-01T00:00:01Z",
				cwd: repo.repositoryPath,
				message: { role: "assistant", content: [{ type: "text", text: "来源回答" }], stop_reason: "end_turn" },
			},
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`;
		writeFileSync(transcriptPath, text);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "peer",
			state: "idle",
			agentId: "claude",
			workspacePath: repo.repositoryPath,
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId,
				transcriptPath,
				observedAt: 1,
			},
		});
		const result = await freezeIndependentTaskConversationSeed(summary);
		expect(result.seed?.sourceSessionId).not.toBe(nativeSessionId);
		expect(result.unavailableReason).toBeNull();
		expect(existsSync(join(projectDirectory, `${result.seed?.sourceSessionId}.jsonl`))).toBe(true);
		expect(readFileSync(transcriptPath, "utf8")).toBe(text);
		expect(readFileSync(join(projectDirectory, `${result.seed?.sourceSessionId}.jsonl`), "utf8")).toContain(
			"保留全部来源需求",
		);
	});
	it("从完整回合边界 fork 新身份，不 resume 或启动模型回合", async () => {
		mocked.request.mockImplementation(async (method: string) =>
			method === "thread/fork"
				? { thread: { id: "immutable-seed", path: "/seed.jsonl" } }
				: { data: [{ id: "finished-turn", status: "completed", items: [] }], nextCursor: null },
		);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "peer",
			state: "idle",
			agentId: "codex",
			workspacePath: "/source",
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "original",
				transcriptPath: "/original.jsonl",
				observedAt: 1,
			},
		});
		const result = await freezeIndependentTaskConversationSeed(summary);
		expect(result.seed?.sourceSessionId).toBe("immutable-seed");
		expect(result.seed?.sourceSessionReuseMode).toBe("fork_existing_session");
		expect(mocked.request).toHaveBeenCalledWith("thread/fork", {
			threadId: "original",
			lastTurnId: "finished-turn",
			cwd: "/source",
			excludeTurns: true,
		});
		expect(mocked.request.mock.calls.some(([method]) => ["turn/start", "thread/resume"].includes(method))).toBe(
			false,
		);
		mocked.request.mockClear();
		expect(
			(await freezeIndependentTaskConversationSeed({ ...summary, agentId: "claude" })).unavailableReason,
		).toContain("不一致");
		expect(mocked.request).not.toHaveBeenCalled();
		mocked.request.mockResolvedValue({
			data: [{ id: "running", status: "inProgress", items: [] }],
			nextCursor: null,
		});
		expect((await freezeIndependentTaskConversationSeed(summary)).seed).toBeNull();
		expect(mocked.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
	});
});
