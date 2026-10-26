import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RvfAutomaticCloseoutRecord } from "../../src/core/rvf-automatic-closeout-contract";
import { verifyBoundRvfSupplementalLandCompletionEvidence } from "../../src/rvf-automatic-closeout/verify-rvf-supplemental-land-completion-evidence";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const contractFixturesFile = process.env.KANBAN_RVF_SUPPLEMENTAL_CONSUMER_CONTRACT_FIXTURES_FILE;
const producerRepository = process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY;
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!contractFixturesFile || !producerRepository)(
	"正式 RVF 补充完成契约的八项合成正负夹具经真实 verify 消费，不修改原材料",
	{ timeout: 120_000 },
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const scriptPath = resolve(
			producerRepository ?? "",
			"plugins/review-validate-fix/skills/review-validate-fix/scripts/rvf_land.py",
		);
		const executable = join(fixture.fixtureRootDirectoryPath, "rvf-supplemental-verification-source-entrypoint");
		// 生产方尚未部署时使用正式发布 checkout；不安装插件、不调用 record 或补审。
		await writeFile(executable, `#!/bin/sh\nshift\nexec python3 '${scriptPath.replace(/'/gu, "'\\''")}' "$@"\n`);
		await chmod(executable, 0o700);
		vi.stubEnv("KANBAN_RVF_INSPECTION_EXECUTABLE_PATH", executable);
		const manifest = JSON.parse(await readFile(contractFixturesFile ?? "", "utf8")) as {
			synthetic_fixture_only: boolean;
			samples: Array<{
				synthetic_fixture_only: boolean;
				checks: Array<{ name: string; expected_exit_code: number; rvf_argv: string[] }>;
			}>;
		};
		expect(manifest.synthetic_fixture_only).toBe(true);
		let accepted = 0;
		let rejected = 0;
		for (const sample of manifest.samples) {
			expect(sample.synthetic_fixture_only).toBe(true);
			for (const check of sample.checks) {
				const value = (name: string) => check.rvf_argv[check.rvf_argv.indexOf(name) + 1];
				const evidencePath = value("--evidence");
				const bytes = await readFile(evidencePath);
				const payload = JSON.parse(bytes.toString("utf8")) as { repository_git_common_directory: string };
				const runDirectory = value("--run-dir");
				const record: RvfAutomaticCloseoutRecord = {
					workspaceId: "synthetic-contract-fixture",
					taskId: value("--task-id"),
					conversationSessionId: "synthetic-contract-fixture",
					receipt: {
						schema: "rvf-independent-user-turn-boundary/v1",
						decision_token: value("--decision-token"),
						session_id: "synthetic",
						worktree: value("--repo"),
						native_user_message_id: "synthetic",
						native_turn_id: "synthetic",
						transcript_path: "synthetic",
						boundary_message_sha256: "synthetic",
						candidate_fingerprint: "synthetic",
						worktree_head_commit_sha: value("--target-commit"),
						checkpoint_commit: "synthetic",
						checkpoint_tree: "synthetic",
						comparison_base_tip: null,
						comparison_base_ref: null,
						comparison_base_ref_tip: null,
						source: "explicit_user_command",
						kanban_task_id: value("--task-id"),
						idempotency_key: "synthetic",
					},
					preReviewTurnIds: [],
					status: "paused",
					createdAt: 1,
					updatedAt: 1,
					runId: value("--run-id"),
					runDirectory,
					handoffPath: join(runDirectory, "artifacts", "handoff.md"),
					handoffSha256: value("--handoff-sha256"),
					restoredNativeSessionId: null,
					restoredTranscriptPath: null,
					restoreWorkspaceStateSha256: null,
					nativeIdentitySwitchStartedAt: null,
					nativeForkAttemptStartedAt: null,
					pauseReason: "合成夹具仅作契约验收",
					promptDeliveryIdempotencyKey: "synthetic",
				};
				const verification = verifyBoundRvfSupplementalLandCompletionEvidence(record, value("--target-commit"), {
					evidencePath,
					evidenceSha256: value("--evidence-sha256"),
				});
				if (check.expected_exit_code === 0) {
					expect(await verification, check.name).toMatchObject({
						source: "historical_supplemental_completion",
						gitCommonDirectoryRealpath: payload.repository_git_common_directory,
						doesNotAttestPrecommitReview: true,
						doesNotAuthorizeFollowupExecution: true,
					});
					accepted++;
				} else {
					await expect(verification, check.name).rejects.toThrow();
					rejected++;
				}
				expect(await readFile(evidencePath)).toEqual(bytes);
			}
		}
		expect({ accepted, rejected }).toEqual({ accepted: 2, rejected: 6 });
	},
);
