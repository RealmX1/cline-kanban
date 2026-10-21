import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RvfIndependentUserTurnBoundaryReceipt } from "../../../src/core/rvf-automatic-closeout-contract";
import { captureRvfReviewStartBoundary } from "../../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { computeRvfCandidateFilesystemIdentitySha256 } from "../../../src/rvf-automatic-closeout/rvf-candidate-filesystem-identity";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

async function createBoundaryFixture(manualText?: string) {
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
	const timestamp = new Date().toISOString();
	const candidates = [
		{
			path: "implementation.txt",
			included_in_candidate_set: true,
			content_sha256: createHash("sha256").update("unstaged\n").digest("hex"),
		},
	];
	const payload = {
		token,
		session_id: "native",
		worktree: repo.repositoryPath,
		candidate_fingerprint: "candidate",
		state: "injected",
		minted_at: timestamp,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		initiated_by_explicit_user_request: manualText !== undefined,
		explicit_user_request_provenance:
			manualText !== undefined ? "developer_manual_trigger_via_user_prompt_submit" : null,
		candidate_summary: {
			kanban_task_id: "task",
			candidates,
			committed_round_baseline: head,
			committed_round_base_ref: "main",
		},
	};
	await writeFile(join(directory, `${token}.json`), JSON.stringify(payload));
	const text = manualText ?? `RVF 发起决策点 · RVF_DECISION_TOKEN=${token}`;
	const turns = [
		{ id: "implementation", status: "completed", items: [] },
		{
			id: "boundary",
			status: "inProgress",
			items: [{ id: "native-boundary-message", type: "userMessage", content: [{ type: "text", text }] }],
		},
	];
	const transcriptPath = join(fixture.fixtureRootDirectoryPath, "native.jsonl");
	const records = [
		{
			type: "session_meta",
			payload: { id: "native", originator: "codex-tui", cli_version: "0.163.0", source: "cli" },
		},
		{
			type: "event_msg",
			payload: { type: "task_started", turn_id: "boundary", turn_attribution: { turn_trigger: "user" } },
		},
		{
			type: "event_msg",
			timestamp,
			payload: {
				type: "item_completed",
				turn_id: "boundary",
				item: { id: "native-boundary-message", type: "UserMessage", content: [{ type: "text", text }] },
			},
		},
	];
	await writeFile(transcriptPath, records.map((record) => JSON.stringify(record)).join("\n"));
	const input = {
		decisionToken: token,
		taskId: "task",
		nativeSessionId: "native",
		transcriptPath,
		workingDirectory: repo.repositoryPath,
		rvfHome,
		port: { request: async () => ({ data: turns, nextCursor: null }) },
	};
	return { fixture, repo, head, staged, payload, directory, token, candidates, records, turns, input };
}

function runActualRvfBoundaryConsumerWithFixture(
	f: Awaited<ReturnType<typeof createBoundaryFixture>>,
	receipt: RvfIndependentUserTurnBoundaryReceipt,
) {
	return spawnSync(
		"python3",
		[
			"-c",
			`import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom core.review_start_boundary.review_start_boundary_verification import verify_independent_user_turn_boundary\nfrom adapters.codex.review_start_independent_user_turn_evidence import read_independent_user_turn_boundary_evidence\nv=json.load(sys.stdin)\nverify_independent_user_turn_boundary(v['receipt'],token_payload=v['token'],repo=v['token']['worktree'],session_id='native',native_boundary_reader=read_independent_user_turn_boundary_evidence,candidate_summary_builder=lambda:v['token']['candidate_summary']|{'candidate_fingerprint':'candidate'})\nprint('RVF_CONSUMER_BOUNDARY_VERIFIED')`,
			process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY ?? "",
		],
		{
			input: JSON.stringify({ receipt, token: f.payload }),
			encoding: "utf8",
			env: f.fixture.createIsolatedChildProcessEnvironment({
				PYTHONDONTWRITEBYTECODE: "1",
				RVF_HOME: f.input.rvfHome,
			}),
		},
	);
}

describe("RVF 独立开审分界捕获", () => {
	it.each([
		undefined,
		"now $review-validate-fix:review-validate-fix your own work.",
		"/review-validate-fix",
		"now $rvf:review-validate-fix",
		"now $custom-plugin:review-validate-fix",
	])("绑定真实原生消息与完整 checkpoint：%s", async (text) => {
		const f = await createBoundaryFixture(text);
		const captured = await captureRvfReviewStartBoundary(f.input);
		expect(captured.preReviewTurnIds).toEqual(["implementation"]);
		expect(captured.receipt.source).toBe(text ? "explicit_user_command" : "rvf_automatic_decision_message");
		expect(captured.receipt.candidate_filesystem_state_sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(f.repo.runGit(["show", `${captured.receipt.checkpoint_commit}:implementation.txt`]).stdout).toBe(
			"unstaged\n",
		);
		const message = f.repo.runGit(["show", "-s", "--format=%B", captured.receipt.checkpoint_commit]).stdout;
		const binding = JSON.parse(message.split("RVF_REVIEW_START_BOUNDARY_BINDING=")[1]?.trim() ?? "null");
		expect(binding.kanban_task_id).toBe("task");
		expect(binding.idempotency_key).toBe(`rvf-decision-point-${f.token}`);
		expect(binding.candidate_filesystem_state_sha256).toBe(captured.receipt.candidate_filesystem_state_sha256);
		expect(f.repo.runGit(["rev-parse", "HEAD"]).stdout.trim()).toBe(f.head);
		expect(f.repo.runGit(["diff", "--cached", "--binary"]).stdout).toBe(f.staged);
		expect(await captureRvfReviewStartBoundary(f.input)).toEqual(captured);
		await writeFile(join(f.repo.repositoryPath, "implementation.txt"), "unstaged\n");
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("改变");
	});
	it.each(["运行时已经部署完成", "/review-validate-fix:rvf-land", "<hook_prompt>/review-validate-fix</hook_prompt>"])(
		"拒绝无显式原文的交接或姊妹入口：%s",
		async (text) => {
			const f = await createBoundaryFixture(text);
			await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("来源");
		},
	);
	it("真实手动开审不被可选自动恢复的前一回合完成条件拦下", async () => {
		const f = await createBoundaryFixture("/review-validate-fix");
		if (f.turns[0]) f.turns[0].status = "interrupted";
		const captured = await captureRvfReviewStartBoundary(f.input);
		expect(captured.preReviewTurnIds).toEqual(["implementation"]);
		expect(captured.automaticCloseoutIneligibleReason).toBe("no_completed_pre_review_conversation_prefix");
	});

	it("拒绝 Agent 自述来源、同 turn steering、过期及候选变更", async () => {
		const f = await createBoundaryFixture("/review-validate-fix");
		const tokenFile = join(f.directory, `${f.token}.json`);
		await writeFile(tokenFile, JSON.stringify({ ...f.payload, explicit_user_request_provenance: "agent_reason" }));
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("来源");
		await writeFile(tokenFile, JSON.stringify({ ...f.payload, expires_at: "invalid" }));
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("到期");
		await writeFile(tokenFile, JSON.stringify(f.payload));
		f.turns[1]?.items.push({ id: "steering", type: "userMessage", content: [{ type: "text", text: "继续" }] });
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("独立");
		f.turns[1]?.items.pop();
		await writeFile(join(f.repo.repositoryPath, "implementation.txt"), "changed\n");
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("候选内容");
	});
	it("整数及纳秒身份签名与 Python 同源算法逐字一致", async () => {
		const f = await createBoundaryFixture();
		const result = spawnSync(
			"python3",
			[
				"-c",
				`import hashlib,json,pathlib,sys\np=pathlib.Path(sys.argv[1]).lstat()\nprint(hashlib.sha256(json.dumps([['implementation.txt',[p.st_dev,p.st_ino,p.st_mode,p.st_size,p.st_mtime_ns,p.st_ctime_ns]]],ensure_ascii=False,separators=(',',':')).encode()).hexdigest())`,
				join(f.repo.repositoryPath, "implementation.txt"),
			],
			{ encoding: "utf8", env: f.fixture.createIsolatedChildProcessEnvironment() },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(await computeRvfCandidateFilesystemIdentitySha256(f.repo.repositoryPath, f.candidates)).toBe(
			result.stdout.trim(),
		);
	});
	it("独立消息不能绑定第二枚 token；HEAD/base 改变不能重捕获", async () => {
		const f = await createBoundaryFixture("/review-validate-fix");
		await captureRvfReviewStartBoundary(f.input);
		const other = "fedcba9876543210";
		await writeFile(join(f.directory, `${other}.json`), JSON.stringify({ ...f.payload, token: other }));
		await expect(captureRvfReviewStartBoundary({ ...f.input, decisionToken: other })).rejects.toThrow(
			"另一 RVF token",
		);
		const replacement = f.repo
			.runGit(["commit-tree", `${f.head}^{tree}`, "-p", f.head, "-m", "新比较基线"])
			.stdout.trim();
		f.repo.runGit(["update-ref", "refs/heads/main", replacement]);
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("改变");
	});
	it("拒绝迟到消息以及同 turn 原生合并，候选变动期间不发布 receipt", async () => {
		const f = await createBoundaryFixture();
		const tokenPath = join(f.directory, `${f.token}.json`);
		await writeFile(
			tokenPath,
			JSON.stringify({ ...f.payload, minted_at: new Date(Date.now() + 30_000).toISOString() }),
		);
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("时间");
		await writeFile(tokenPath, JSON.stringify(f.payload));
		f.records.push({
			type: "event_msg",
			timestamp: new Date().toISOString(),
			payload: {
				type: "item_completed",
				turn_id: "boundary",
				item: { id: "merged-user-message", type: "UserMessage", content: [{ type: "text", text: "steering" }] },
			},
		});
		await writeFile(f.input.transcriptPath, f.records.map((record) => JSON.stringify(record)).join("\n"));
		await expect(captureRvfReviewStartBoundary(f.input)).rejects.toThrow("唯一");
	});

	it
		.skipIf(!process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY)
		.each([undefined, "/review-validate-fix", "now $review-validate-fix:review-validate-fix your own work."])(
		"实际 RVF consumer 核验原生消息及 checkpoint：%s",
		async (text) => {
			const f = await createBoundaryFixture(text);
			const { receipt } = await captureRvfReviewStartBoundary(f.input);
			const result = runActualRvfBoundaryConsumerWithFixture(f, receipt);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("RVF_CONSUMER_BOUNDARY_VERIFIED");
			expect(await readFile(f.input.transcriptPath, "utf8")).toContain("native-boundary-message");
		},
	);
	it.skipIf(!process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY).each(["candidate", "head", "base"] as const)(
		"实际 consumer 拒绝分界后的 %s 改变",
		async (mutation) => {
			const f = await createBoundaryFixture();
			f.repo.runGit(["update-ref", "refs/heads/comparison-base", f.head]);
			f.payload.candidate_summary.committed_round_base_ref = "comparison-base";
			await writeFile(join(f.directory, `${f.token}.json`), JSON.stringify(f.payload));
			const { receipt } = await captureRvfReviewStartBoundary(f.input);
			if (mutation === "candidate") await writeFile(join(f.repo.repositoryPath, "implementation.txt"), "unstaged\n");
			else {
				const replacement = f.repo
					.runGit(["commit-tree", `${f.head}^{tree}`, "-p", f.head, "-m", "新提交"])
					.stdout.trim();
				f.repo.runGit([
					"update-ref",
					mutation === "head" ? "refs/heads/main" : "refs/heads/comparison-base",
					replacement,
				]);
			}
			const result = runActualRvfBoundaryConsumerWithFixture(f, receipt);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("review_start_boundary_invalidated");
		},
	);
	it.skipIf(!process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY)(
		"已初始化 gitlink 目录可捕获，实际 consumer 拒绝其未冻结内部修改",
		async () => {
			const f = await createBoundaryFixture("/review-validate-fix");
			const submodule = f.fixture.createNonBareRepository({
				repositoryDirectoryName: "review-start-submodule-source",
			});
			await writeFile(join(submodule.repositoryPath, "reviewed.txt"), "已冻结的子模块内容\n");
			submodule.commitAllRepositoryFilesAtDate({
				message: "子模块初始实现",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			f.repo.runGit(["submodule", "add", submodule.repositoryPath, "reviewed-submodule"]);
			const submoduleFile = join(f.repo.repositoryPath, "reviewed-submodule", "reviewed.txt");
			f.candidates.push({
				path: "reviewed-submodule",
				included_in_candidate_set: true,
				content_sha256: "absent",
			});
			await writeFile(join(f.directory, `${f.token}.json`), JSON.stringify(f.payload));
			const { receipt } = await captureRvfReviewStartBoundary(f.input);
			expect(f.repo.runGit(["ls-tree", receipt.checkpoint_commit, "--", "reviewed-submodule"]).stdout).toMatch(
				/^160000 commit /u,
			);
			const accepted = runActualRvfBoundaryConsumerWithFixture(f, receipt);
			expect(accepted.status, accepted.stderr).toBe(0);
			expect(accepted.stdout).toContain("RVF_CONSUMER_BOUNDARY_VERIFIED");
			await writeFile(submoduleFile, "分界后未冻结的子模块修改\n");
			const invalidated = runActualRvfBoundaryConsumerWithFixture(f, receipt);
			expect(invalidated.status).not.toBe(0);
			expect(invalidated.stderr).toContain("submodule 在分界之后改变或存在未冻结修改");
		},
	);
	it.skipIf(!process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY)(
		"实际 gate 与 bridge 拒绝第二个 run 覆盖首次绑定",
		async () => {
			const f = await createBoundaryFixture();
			const { receipt } = await captureRvfReviewStartBoundary(f.input);
			const result = spawnSync(
				"python3",
				[
					"-c",
					`import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
sys.path.insert(0,str(Path(sys.argv[1])/'plugins/review-validate-fix/skills/review-validate-fix/scripts'))
from review_start_boundary_gate import bind_review_start_boundary_to_one_run
from rvf_automatic_closeout_bridge import bind_run
from core.review_start_boundary.review_start_boundary_verification import ReviewStartBoundaryNotVerified
r=json.load(sys.stdin)
root=Path(sys.argv[2])
bind_review_start_boundary_to_one_run(receipt=r,run_id='run-first',run_dir=root/'run-first')
try:
 bind_run(r,root/'run-second',run_id='run-second')
except ReviewStartBoundaryNotVerified:
 print('SECOND_RUN_REJECTED')
else:
 raise AssertionError('第二个 run 覆盖了不可变绑定')`,
					process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY ?? "",
					f.input.rvfHome,
				],
				{
					encoding: "utf8",
					input: JSON.stringify(receipt),
					env: f.fixture.createIsolatedChildProcessEnvironment({
						RVF_HOME: f.input.rvfHome,
						PYTHONDONTWRITEBYTECODE: "1",
					}),
				},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("SECOND_RUN_REJECTED");
		},
	);
});
