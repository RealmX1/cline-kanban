import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	rvfIndependentUserTurnBoundaryReceiptSchema,
	rvfReviewStartBoundaryObservationResponseSchema,
} from "../../src/core/rvf-automatic-closeout-contract";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => vi.unstubAllEnvs());
describe("真实 Codex TUI 独立开审与实时活动分支", { timeout: 90_000 }, () => {
	it.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
		"UI rewind 保留旧 JSONL 时，本次 nonce 观测排除旧消息；不调用真实模型",
		async () => {
			// Unix socket 有路径长度上限；配置直接放 fixture 根目录，所有 Git 仍只经统一 fixture。
			vi.stubEnv("TMPDIR", "/tmp");
			const fixture = createIsolatedGitTestWorkspaceFixture({
				fixtureRootDirectoryNamePrefix: "kanban-native-rvf-",
			});
			const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "native-boundary" });
			await writeFile(join(repo.repositoryPath, "implementation.txt"), "初始实现\n");
			repo.commitAllRepositoryFilesAtDate({
				message: "初始实现",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			await writeFile(join(repo.repositoryPath, "implementation.txt"), "待审实现\n");
			const result = spawnSync(
				"python3",
				[
					resolve("test/integration/fixtures/codex-native-review-start-boundary-and-rewind.py"),
					fixture.fixtureRootDirectoryPath,
					repo.repositoryPath,
					process.cwd(),
					process.execPath,
					process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
				],
				{
					encoding: "utf8",
					timeout: 75_000,
					maxBuffer: 2 * 1024 * 1024,
					env: fixture.createIsolatedChildProcessEnvironment(),
				},
			);
			const evidenceDirectory = process.env.KANBAN_CODEX_RVF_NATIVE_BOUNDARY_EVIDENCE_DIRECTORY;
			if (evidenceDirectory) {
				await mkdir(evidenceDirectory, { recursive: true });
				await writeFile(
					join(evidenceDirectory, "native-tui-boundary-rewind.log"),
					`${result.stdout}\n${result.stderr}`,
				);
			}
			expect(result.status, result.stdout + result.stderr).toBe(0);
			const schema = z.object({
				afterRewind: z.boolean(),
				receipt: rvfIndependentUserTurnBoundaryReceiptSchema,
				observation:
					rvfReviewStartBoundaryObservationResponseSchema.shape.review_start_boundary_active_branch_observation.unwrap(),
				staticEvidence: z.object({ receivedAt: z.string() }),
			});
			const observations = result.stdout
				.split("\n")
				.filter((line) => line.includes("NATIVE_BRANCH_PROBE_RESULT "))
				.map((line) =>
					schema.parse(
						JSON.parse(
							line.slice(line.indexOf("NATIVE_BRANCH_PROBE_RESULT ") + "NATIVE_BRANCH_PROBE_RESULT ".length),
						),
					),
				);
			expect(observations).toHaveLength(2);
			const before = observations[0];
			const after = observations[1];
			expect(before?.afterRewind).toBe(false);
			expect(after?.afterRewind).toBe(true);
			expect(before?.observation.native_active_branch_user_message_ids).toContain(
				before?.receipt.native_user_message_id,
			);
			expect(after?.observation.native_active_branch_user_message_ids).not.toContain(
				after?.receipt.native_user_message_id,
			);
			expect(after?.observation.request_nonce).not.toBe(before?.observation.request_nonce);
			expect(after?.receipt).toEqual(before?.receipt);
			expect(result.stdout).toContain("Conversation reverted to this point. File changes are unchanged.");
			expect(repo.runGit(["show", `${before?.receipt.checkpoint_commit}:implementation.txt`]).stdout).toBe(
				"待审实现\n",
			);
		},
	);
});
