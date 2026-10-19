import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { RvfIndependentUserTurnBoundaryReceipt } from "../core/rvf-automatic-closeout-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getGitStdout } from "../workspace/git-utils";
import { captureRvfReviewStartBoundaryCheckpoint } from "../workspace/turn-checkpoints";
import { type CodexAppServerRequestPort, readCodexConversationTurns } from "./codex-native-conversation-prefix";

export const computeRvfTextSha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const tokenSchema = z.looseObject({
	token: z.string(),
	session_id: z.string(),
	worktree: z.string(),
	candidate_fingerprint: z.string(),
	state: z.enum(["minted", "injected", "acknowledged", "dispatched"]),
	minted_at: z.string(),
	expires_at: z.string(),
	candidate_summary: z.looseObject({
		committed_round_baseline: z.string().nullable().optional(),
		committed_round_base_ref: z.string().nullable().optional(),
	}),
});

export async function captureRvfReviewStartBoundary(input: {
	decisionToken: string;
	taskId: string;
	nativeSessionId: string;
	transcriptPath: string;
	workingDirectory: string;
	rvfHome: string;
	port: CodexAppServerRequestPort;
	captureCheckpoint?: typeof captureRvfReviewStartBoundaryCheckpoint;
}): Promise<{ receipt: RvfIndependentUserTurnBoundaryReceipt; preReviewTurnIds: string[] }> {
	if (!/^[a-f0-9]{16}$/u.test(input.decisionToken)) throw new Error("非法 RVF 决策 token。");
	const token = tokenSchema.parse(
		JSON.parse(
			await readFile(
				join(input.rvfHome, "agentic-initiation-decision-tokens", `${input.decisionToken}.json`),
				"utf8",
			),
		),
	);
	if (
		token.token !== input.decisionToken ||
		token.session_id !== input.nativeSessionId ||
		resolve(token.worktree) !== resolve(input.workingDirectory)
	)
		throw new Error("RVF token 与当前主会话或工作目录不一致。");
	if (!Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) <= Date.now())
		throw new Error("RVF token 已到期。");
	const turns = await readCodexConversationTurns(input.port, input.nativeSessionId);
	const boundary = turns.at(-1);
	const messages = boundary?.items.filter((item) => item.type === "userMessage") ?? [];
	const item = messages[0];
	const text = item?.content?.map((part) => part.text ?? "").join("") ?? "";
	if (
		turns.length < 2 ||
		messages.length !== 1 ||
		!text.startsWith("RVF 发起决策点 · ") ||
		text.trim().includes("\n") ||
		text.split(`RVF_DECISION_TOKEN=${token.token}`).length !== 2
	)
		throw new Error("当前回合没有独立的 RVF 开审分界。");
	if (!boundary || turns.at(-2)?.status !== "completed") throw new Error("开审前没有已完成的原生回合。");
	const git = (arguments_: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...arguments_], input.workingDirectory);
	const head = await git(["rev-parse", "HEAD"]);
	const baseRef = token.candidate_summary.committed_round_base_ref ?? null;
	const binding = {
		schema: "rvf-independent-user-turn-boundary/v1" as const,
		decision_token: token.token,
		session_id: token.session_id,
		native_user_message_id: item?.id ?? "",
		native_turn_id: boundary.id,
		boundary_message_sha256: computeRvfTextSha256(text),
		candidate_fingerprint: token.candidate_fingerprint,
		worktree_head_commit_sha: head,
		comparison_base_tip: token.candidate_summary.committed_round_baseline ?? null,
		comparison_base_ref: baseRef,
		comparison_base_ref_tip: baseRef ? await git(["rev-parse", "--verify", baseRef]) : null,
	};
	const checkpoint = await (input.captureCheckpoint ?? captureRvfReviewStartBoundaryCheckpoint)({
		cwd: input.workingDirectory,
		taskId: input.taskId,
		decisionToken: token.token,
		binding,
	});
	if ((await git(["rev-parse", "HEAD"])) !== head) throw new Error("捕获分界期间 HEAD 改变。");
	const receipt: RvfIndependentUserTurnBoundaryReceipt = {
		...binding,
		worktree: resolve(input.workingDirectory),
		transcript_path: input.transcriptPath,
		checkpoint_commit: checkpoint.commit,
		checkpoint_tree: checkpoint.tree,
		source: "rvf_automatic_decision_message",
		kanban_task_id: input.taskId,
		idempotency_key: `rvf-decision-point-${token.token}`,
	};
	await lockedFileSystem.writeJsonFileAtomic(
		join(input.rvfHome, "review-start-independent-user-turn-boundary-receipts", `${token.token}.json`),
		receipt,
	);
	return { receipt, preReviewTurnIds: turns.slice(0, -1).map((turn) => turn.id) };
}
