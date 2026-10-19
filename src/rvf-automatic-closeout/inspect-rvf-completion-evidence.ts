import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";

const completionSchema = z.object({
	schema: z.literal("rvf-automatic-closeout-completion/v1"),
	decision_token: z.string(),
	session_id: z.string(),
	worktree: z.string(),
	run_id: z.string().min(1),
	run_dir: z.string(),
	handoff_path: z.string(),
	handoff_sha256: z.string(),
});
const finalizeSchema = z.object({
	run_id: z.string(),
	run_dir: z.string(),
	repo: z.string(),
	decision_kind: z.enum(["handoff", "handoff-advisory"]),
	completed_at: z.string().min(1),
	errors: z.array(z.unknown()).length(0),
});
export async function inspectRvfCompletionEvidence(record: RvfAutomaticCloseoutRecord, rvfHome: string) {
	const path = join(rvfHome, "automatic-closeout-completion-notifications", `${record.receipt.decision_token}.json`);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			try {
				const binding = z
					.object({ run_dir: z.string() })
					.parse(
						JSON.parse(
							await readFile(
								join(
									rvfHome,
									"review-start-independent-user-turn-boundary-receipts",
									`${record.receipt.decision_token}.run-binding.json`,
								),
								"utf8",
							),
						),
					);
				const finalized = z
					.object({ errors: z.array(z.unknown()), decision_kind: z.string() })
					.parse(JSON.parse(await readFile(join(binding.run_dir, "artifacts", ".finalize.lock"), "utf8")));
				if (finalized.errors.length || !["handoff", "handoff-advisory"].includes(finalized.decision_kind))
					throw new Error("绑定的 RVF run 未成功完成，自动收尾已暂停。");
			} catch (failure) {
				if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
			}
			return null;
		}
		throw error;
	}
	const completion = completionSchema.parse(JSON.parse(raw));
	if (
		completion.decision_token !== record.receipt.decision_token ||
		completion.session_id !== record.receipt.session_id ||
		resolve(completion.worktree) !== record.receipt.worktree
	)
		throw new Error("RVF 完成凭据与开审身份不一致。");
	const runDirectory = await realpath(completion.run_dir);
	const expectedHandoff = join(runDirectory, "artifacts", "handoff.md");
	if (
		completion.run_id !== runDirectory.split(/[\\/]/u).at(-1) ||
		(await realpath(completion.handoff_path)) !== expectedHandoff
	)
		throw new Error("RVF 完成凭据的 run 或 handoff 路径错误。");
	const binding = z
		.object({ run_id: z.string(), run_dir: z.string(), receipt_sha256: z.string() })
		.parse(
			JSON.parse(
				await readFile(
					join(
						rvfHome,
						"review-start-independent-user-turn-boundary-receipts",
						`${record.receipt.decision_token}.run-binding.json`,
					),
					"utf8",
				),
			),
		);
	// 与 Python sort_keys/separators/ensure_ascii=False 的 receipt 摘要保持相同。
	const ordered = Object.fromEntries(
		Object.entries(record.receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
	if (
		binding.run_id !== completion.run_id ||
		(await realpath(binding.run_dir)) !== runDirectory ||
		binding.receipt_sha256 !== computeRvfTextSha256(JSON.stringify(ordered))
	)
		throw new Error("RVF run 未绑定这份独立开审凭据。");
	const finalized = finalizeSchema.parse(
		JSON.parse(await readFile(join(runDirectory, "artifacts", ".finalize.lock"), "utf8")),
	);
	if (
		finalized.run_id !== completion.run_id ||
		(await realpath(finalized.run_dir)) !== runDirectory ||
		resolve(finalized.repo) !== record.receipt.worktree
	)
		throw new Error("RVF finalization 身份不一致。");
	const handoff = await readFile(expectedHandoff);
	if (!handoff.length || computeRvfTextSha256(handoff) !== completion.handoff_sha256)
		throw new Error("RVF handoff 内容已改变。");
	if (dirname(expectedHandoff) !== join(runDirectory, "artifacts")) throw new Error("非法 RVF artifacts 目录。");
	return {
		runId: completion.run_id,
		runDirectory,
		handoffPath: expectedHandoff,
		handoffSha256: completion.handoff_sha256,
	};
}
