import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RvfAutomaticCloseoutPauseError } from "./rvf-automatic-closeout-coordinator";

// 当前后继版本协议授予普通审查资格；父版本的原生 receipt 不能为新版本背书。
export async function assertRvfCurrentCandidateNativeCloseoutQualification(runDirectory: string): Promise<void> {
	let raw: string;
	try {
		raw = await readFile(join(runDirectory, "artifacts", "inputs", "scope.contract.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const contract = z
		.object({
			review_candidate_snapshot_version_id: z.string().nullish(),
			review_candidate_snapshot: z.object({ review_candidate_snapshot_version_id: z.string().nullish() }).nullish(),
		})
		.parse(JSON.parse(raw));
	if (
		contract.review_candidate_snapshot_version_id ||
		contract.review_candidate_snapshot?.review_candidate_snapshot_version_id
	) {
		throw new RvfAutomaticCloseoutPauseError("后继候选版本尚未取得独立原生回退与自动收尾资格；普通审查继续。");
	}
}
