import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withCodexAppServerRequestConnection } from "../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import {
	forkCodexConversationBeforeReviewTurn,
	readCodexConversationTurns,
} from "../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { readRvfCloseoutWorkspaceStateDigest } from "../../src/rvf-automatic-closeout/rvf-closeout-workspace-state-digest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("真实 Codex 原生 RVF 前缀恢复", { timeout: 60_000 }, () => {
	it.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY)(
		"只保留实现回合，原历史、工作文件和暂存内容不变；不调用模型",
		async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "codex-native-rvf-closeout" });
			const cwd = repo.repositoryPath;
			await writeFile(join(cwd, "implementation.txt"), "原始实现\n");
			repo.commitAllRepositoryFilesAtDate({
				message: "初始实现",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			await writeFile(join(cwd, "implementation.txt"), "已暂存修复\n");
			repo.runGit(["add", "implementation.txt"]);
			await writeFile(join(cwd, "implementation.txt"), "未暂存的 RVF 修复\n");
			await writeFile(join(cwd, "untracked.txt"), "未跟踪文件也保留\n");
			const before = await readRvfCloseoutWorkspaceStateDigest(cwd);
			const codexHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
			const sessionDirectory = join(codexHome, "sessions", "2026", "10", "18");
			await mkdir(sessionDirectory, { recursive: true });
			const threadId = randomUUID();
			const turnIds = [randomUUID(), randomUUID(), randomUUID()];
			const timestamp = new Date().toISOString();
			const records: unknown[] = [];
			const add = (type: string, payload: unknown) => records.push({ type, payload, timestamp });
			add("session_meta", {
				id: threadId,
				timestamp,
				cwd,
				originator: "codex-tui",
				cli_version: "0.163.0",
				source: "cli",
				model_provider: "openai",
				base_instructions: { text: "隔离测试，不请求模型" },
			});
			for (const [index, text] of [
				"实现需求",
				"RVF 发起决策点 · RVF_DECISION_TOKEN=0123456789abcdef",
				"<task-notification>额外通知</task-notification>",
			].entries()) {
				const turnId = turnIds[index];
				add("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 128000 });
				add("turn_context", {
					turn_id: turnId,
					cwd,
					approval_policy: "never",
					sandbox_policy: { type: "danger-full-access" },
					model: "gpt-6.1",
					effort: "low",
					summary: "none",
				});
				add("event_msg", { type: "user_message", message: text, images: [], local_images: [], text_elements: [] });
				add("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
				add("response_item", {
					type: "message",
					role: "assistant",
					phase: "final_answer",
					content: [{ type: "output_text", text: "已完成" }],
				});
				add("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "已完成" });
			}
			const transcript = join(sessionDirectory, `rollout-2026-10-18T23-00-00-${threadId}.jsonl`);
			await writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
			const original = await readFile(transcript);
			await withCodexAppServerRequestConnection(
				{
					workingDirectory: cwd,
					binary: process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY,
					environment: fixture.createIsolatedChildProcessEnvironment({ CODEX_HOME: codexHome }),
				},
				async (port) => {
					const source = await readCodexConversationTurns(port, threadId);
					expect(source.map((turn) => turn.id)).toEqual(turnIds);
					const fork = await forkCodexConversationBeforeReviewTurn(port, {
						sourceThreadId: threadId,
						boundaryTurnId: turnIds[1] ?? "",
						lastPreReviewTurnId: turnIds[0] ?? "",
						workingDirectory: cwd,
					});
					const restored = await readCodexConversationTurns(port, fork.nativeSessionId);
					expect(restored).toHaveLength(1);
					expect(JSON.stringify(restored)).toContain("实现需求");
					expect(JSON.stringify(restored)).not.toContain("RVF_DECISION_TOKEN");
				},
			);
			expect(await readFile(transcript)).toEqual(original);
			expect(await readRvfCloseoutWorkspaceStateDigest(cwd)).toBe(before);
		},
	);
});
