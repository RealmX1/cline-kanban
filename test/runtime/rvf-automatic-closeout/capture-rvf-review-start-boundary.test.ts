import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureRvfReviewStartBoundary } from "../../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("RVF 独立开审分界捕获", () => {
	it("绑定真实回合与 Git 快照，同时保留 HEAD、真实 index 和未暂存修复", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "rvf-review-start-boundary" });
		await writeFile(join(repo.repositoryPath, "implementation.txt"), "initial\n");
		const head = repo.commitAllRepositoryFilesAtDate({
			message: "初始实现",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		await writeFile(join(repo.repositoryPath, "implementation.txt"), "staged\n");
		repo.runGit(["add", "implementation.txt"]);
		const staged = repo.runGit(["diff", "--cached", "--binary"]).stdout;
		await writeFile(join(repo.repositoryPath, "implementation.txt"), "unstaged\n");
		const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-home");
		const directory = join(rvfHome, "agentic-initiation-decision-tokens");
		await mkdir(directory, { recursive: true });
		const token = "0123456789abcdef";
		const payload = {
			token,
			session_id: "native",
			worktree: repo.repositoryPath,
			candidate_fingerprint: "candidate",
			state: "injected",
			minted_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			candidate_summary: { committed_round_baseline: head, committed_round_base_ref: "main" },
		};
		await writeFile(join(directory, `${token}.json`), JSON.stringify(payload));
		const request = vi.fn(async () => ({
			data: [
				{ id: "implementation", status: "completed", items: [] },
				{
					id: "boundary",
					status: "inProgress",
					items: [
						{
							id: "native-boundary-message",
							type: "userMessage",
							content: [{ type: "text", text: `RVF 发起决策点 · RVF_DECISION_TOKEN=${token}` }],
						},
					],
				},
			],
			nextCursor: null,
		}));
		const input = {
			decisionToken: token,
			taskId: "task",
			nativeSessionId: "native",
			transcriptPath: "/native.jsonl",
			workingDirectory: repo.repositoryPath,
			rvfHome,
			port: { request },
		};
		const captured = await captureRvfReviewStartBoundary(input);
		expect(captured.preReviewTurnIds).toEqual(["implementation"]);
		expect(captured.receipt.native_user_message_id).toBe("native-boundary-message");
		expect(repo.runGit(["show", `${captured.receipt.checkpoint_commit}:implementation.txt`]).stdout).toBe(
			"unstaged\n",
		);
		expect(repo.runGit(["log", "-1", "--format=%B", captured.receipt.checkpoint_commit]).stdout).toContain(
			"RVF_REVIEW_START_BOUNDARY_BINDING=",
		);
		expect(repo.runGit(["rev-parse", "HEAD"]).stdout.trim()).toBe(head);
		expect(repo.runGit(["diff", "--cached", "--binary"]).stdout).toBe(staged);
		expect(await readFile(join(repo.repositoryPath, "implementation.txt"), "utf8")).toBe("unstaged\n");
		await writeFile(join(directory, `${token}.json`), JSON.stringify({ ...payload, expires_at: "invalid" }));
		await expect(captureRvfReviewStartBoundary(input)).rejects.toThrow("到期");
	});
});
