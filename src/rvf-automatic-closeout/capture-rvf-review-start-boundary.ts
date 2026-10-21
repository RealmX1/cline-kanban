import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	type RvfIndependentUserTurnBoundaryReceipt,
	rvfIndependentUserTurnBoundaryReceiptSchema,
} from "../core/rvf-automatic-closeout-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getGitStdout } from "../workspace/git-utils";
import { captureRvfReviewStartBoundaryCheckpoint } from "../workspace/turn-checkpoints";
import { type CodexAppServerRequestPort, readCodexConversationTurns } from "./codex-native-conversation-prefix";
import {
	isExplicitRvfManualCommand,
	readCodexNativeReviewStartMessageEvidence,
} from "./codex-native-review-start-message-evidence";
import { boundaryCaptureError } from "./review-start-boundary-capture-diagnostic";
import {
	assertRvfCandidateContentsMatchToken,
	computeRvfCandidateFilesystemIdentitySha256,
} from "./rvf-candidate-filesystem-identity";

export const computeRvfTextSha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const tokenSchema = z.looseObject({
	token: z.string(),
	session_id: z.string(),
	worktree: z.string(),
	candidate_fingerprint: z.string(),
	initiated_by_explicit_user_request: z.boolean(),
	explicit_user_request_provenance: z.string().nullable().optional(),
	state: z.string(),
	minted_at: z.string(),
	expires_at: z.string(),
	candidate_summary: z.looseObject({
		kanban_task_id: z.string(),
		candidates: z.array(
			z.looseObject({ path: z.string(), included_in_candidate_set: z.boolean(), content_sha256: z.string() }),
		),
		committed_round_baseline: z.string().nullable().optional(),
		committed_round_base_ref: z.string().nullable().optional(),
	}),
});

async function captureRvfReviewStartBoundaryUnderTokenLock(input: {
	decisionToken: string;
	taskId: string;
	nativeSessionId: string;
	transcriptPath: string;
	workingDirectory: string;
	rvfHome: string;
	port: CodexAppServerRequestPort;
	captureCheckpoint?: typeof captureRvfReviewStartBoundaryCheckpoint;
}): Promise<{
	receipt: RvfIndependentUserTurnBoundaryReceipt;
	preReviewTurnIds: string[];
	automaticCloseoutIneligibleReason?: "no_completed_pre_review_conversation_prefix";
}> {
	if (!/^[a-f0-9]{16}$/u.test(input.decisionToken))
		throw boundaryCaptureError("非法 RVF 决策 token。", "review_start_boundary_binding_invalidated");
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
		resolve(token.worktree) !== resolve(input.workingDirectory) ||
		token.candidate_summary.kanban_task_id !== input.taskId
	)
		throw boundaryCaptureError(
			"RVF token 与当前主会话或工作目录不一致。",
			"review_start_boundary_binding_invalidated",
		);
	if (!["minted", "injected", "acknowledged", "dispatched"].includes(token.state))
		throw boundaryCaptureError(
			"RVF token 已进入终态，不能重新捕获或复活。",
			"review_start_boundary_binding_invalidated",
		);
	if (!Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) <= Date.now())
		throw boundaryCaptureError("RVF token 已到期。", "review_start_boundary_token_expired");
	const turns = await readCodexConversationTurns(input.port, input.nativeSessionId);
	const boundary = turns.at(-1);
	const messages = boundary?.items.filter((item) => item.type === "userMessage") ?? [];
	const item = messages[0];
	const text = item?.content?.map((part) => part.text ?? "").join("") ?? "";
	const manual = token.initiated_by_explicit_user_request === true;
	const source = manual ? ("explicit_user_command" as const) : ("rvf_automatic_decision_message" as const);
	const validSource = manual
		? token.explicit_user_request_provenance === "developer_manual_trigger_via_user_prompt_submit" &&
			isExplicitRvfManualCommand(text)
		: !token.explicit_user_request_provenance &&
			text.startsWith("RVF 发起决策点 · ") &&
			!text.trim().includes("\n") &&
			text.split(`RVF_DECISION_TOKEN=${token.token}`).length === 2;
	if (messages.length > 1)
		throw boundaryCaptureError(
			"当前原生回合包含多条 UserMessage，不能捕获独立分界。",
			"native_independent_user_turn_contains_multiple_messages",
		);
	if (
		(!boundary || !item || !validSource) &&
		turns
			.slice(0, -1)
			.some((turn) =>
				turn.items.some(
					(entry) =>
						entry.type === "userMessage" &&
						entry.content?.some((part) => part.text?.includes(`RVF_DECISION_TOKEN=${token.token}`)),
				),
			)
	)
		throw boundaryCaptureError(
			"此 token 的分界之后已进入新原生回合，旧分界不可用。",
			"review_start_boundary_binding_invalidated",
		);
	if (!boundary || !item || !validSource)
		throw boundaryCaptureError(
			"当前回合没有独立的 RVF 开审分界或来源不符。",
			"native_independent_user_turn_boundary_not_yet_observed",
			"pending",
			"retry_capture",
		);
	const native = await readCodexNativeReviewStartMessageEvidence({
		transcriptPath: input.transcriptPath,
		nativeSessionId: input.nativeSessionId,
		nativeTurnId: boundary.id,
		nativeMessageId: item.id,
		text,
	});
	const receivedAt = Date.parse(native.receivedAt);
	const mintedAt = Date.parse(token.minted_at);
	if (
		!Number.isFinite(mintedAt) ||
		receivedAt > Date.parse(token.expires_at) ||
		(receivedAt < mintedAt && (!manual || mintedAt - receivedAt > 120_000))
	)
		throw boundaryCaptureError(
			"原生消息接收时间不在本 token 有效分界窗口。",
			"review_start_boundary_binding_invalidated",
		);
	if (!manual && turns.length > 1 && turns.at(-2)?.status !== "completed")
		throw boundaryCaptureError(
			"开审前存在未完成的原生回合。",
			"native_pre_review_turn_not_completed",
			"pending",
			"wait_for_native_turn_completion",
		);
	const automaticCloseoutEligibility =
		turns.length < 2 || turns.at(-2)?.status !== "completed"
			? { automaticCloseoutIneligibleReason: "no_completed_pre_review_conversation_prefix" as const }
			: {};
	const candidates = token.candidate_summary.candidates;
	const filesystemIdentity = await computeRvfCandidateFilesystemIdentitySha256(input.workingDirectory, candidates);
	await assertRvfCandidateContentsMatchToken(input.workingDirectory, candidates);
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
		candidate_filesystem_state_sha256: filesystemIdentity,
		kanban_task_id: input.taskId,
		idempotency_key: `rvf-decision-point-${token.token}`,
		worktree_head_commit_sha: head,
		comparison_base_tip: token.candidate_summary.committed_round_baseline ?? null,
		comparison_base_ref: baseRef,
		comparison_base_ref_tip: baseRef ? await git(["rev-parse", "--verify", baseRef]) : null,
	};
	const receiptPath = join(
		input.rvfHome,
		"review-start-independent-user-turn-boundary-receipts",
		`${token.token}.json`,
	);
	let existing: RvfIndependentUserTurnBoundaryReceipt | null = null;
	try {
		existing = rvfIndependentUserTurnBoundaryReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (existing) {
		if (
			Object.entries(binding).some(([key, value]) => Reflect.get(existing ?? {}, key) !== value) ||
			existing.source !== source ||
			existing.transcript_path !== input.transcriptPath
		)
			throw boundaryCaptureError(
				"已捕获分界的消息、候选、HEAD 或 base 已改变，不能覆写旧凭据。",
				"review_start_boundary_binding_invalidated",
			);
		return {
			receipt: existing,
			preReviewTurnIds: turns.slice(0, -1).map((turn) => turn.id),
			...automaticCloseoutEligibility,
		};
	}
	const messageBindingPath = join(
		input.rvfHome,
		"kanban-review-start-native-message-token-bindings",
		`${computeRvfTextSha256(JSON.stringify([input.nativeSessionId, item.id]))}.json`,
	);
	await lockedFileSystem.withLock({ path: messageBindingPath }, async () => {
		let boundToken: string | undefined;
		try {
			boundToken = z
				.object({ decisionToken: z.string() })
				.parse(JSON.parse(await readFile(messageBindingPath, "utf8"))).decisionToken;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		if (boundToken && boundToken !== token.token)
			throw boundaryCaptureError("此原生消息已绑定另一 RVF token。", "review_start_boundary_native_message_reused");
		if (!boundToken)
			await lockedFileSystem.writeJsonFileAtomic(messageBindingPath, { decisionToken: token.token }, { lock: null });
	});
	const checkpoint = await (input.captureCheckpoint ?? captureRvfReviewStartBoundaryCheckpoint)({
		cwd: input.workingDirectory,
		taskId: input.taskId,
		decisionToken: token.token,
		binding,
	});
	if (
		(await git(["rev-parse", "HEAD"])) !== head ||
		(baseRef && (await git(["rev-parse", "--verify", baseRef])) !== binding.comparison_base_ref_tip) ||
		(await computeRvfCandidateFilesystemIdentitySha256(input.workingDirectory, candidates)) !== filesystemIdentity
	)
		throw boundaryCaptureError(
			"捕获分界期间候选文件、HEAD 或 base 改变。",
			"review_start_boundary_binding_invalidated",
		);
	const receipt: RvfIndependentUserTurnBoundaryReceipt = {
		...binding,
		worktree: resolve(input.workingDirectory),
		transcript_path: input.transcriptPath,
		checkpoint_commit: checkpoint.commit,
		checkpoint_tree: checkpoint.tree,
		source,
	};
	await lockedFileSystem.writeJsonFileAtomic(
		join(input.rvfHome, "review-start-independent-user-turn-boundary-receipts", `${token.token}.json`),
		receipt,
	);
	return { receipt, preReviewTurnIds: turns.slice(0, -1).map((turn) => turn.id), ...automaticCloseoutEligibility };
}

export async function captureRvfReviewStartBoundary(
	input: Parameters<typeof captureRvfReviewStartBoundaryUnderTokenLock>[0],
) {
	if (!/^[a-f0-9]{16}$/u.test(input.decisionToken))
		throw boundaryCaptureError("非法 RVF 决策 token。", "review_start_boundary_binding_invalidated");
	return lockedFileSystem.withLock(
		{ path: join(input.rvfHome, "kanban-review-start-boundary-capture-locks", `${input.decisionToken}.json`) },
		() => captureRvfReviewStartBoundaryUnderTokenLock(input),
	);
}
