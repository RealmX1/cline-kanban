import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { existingCloseoutGoalCompletionReconciliationSchema } from "../core/task-rvf-history-closeout-observation-contract";
import { historicalRvfCloseoutExecutionResultSchema } from "../core/task-rvf-history-contract";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "../state/workspace-state";

// 仅保留读历史所需字段；额外投递、失败与接受事实保持原样，不验证现行执行资格。
export const historicalRvfCloseoutRecordSchema = z.looseObject({
	workspaceId: z.string(),
	taskId: z.string(),
	createdAt: z.number(),
	status: z.string(),
	receipt: z.looseObject({
		session_id: z.string(),
		worktree: z.string().optional(),
		kanban_task_id: z.string().optional(),
		decision_token: z.string().optional(),
	}),
	runId: z.string().nullable().optional(),
	runDirectory: z.string().nullable().optional(),
	handoffPath: z.string().nullable().optional(),
	handoffSha256: z.string().nullable().optional(),
	landExecutionResult: historicalRvfCloseoutExecutionResultSchema.optional(),
	baseBranchSyncExecutionResult: historicalRvfCloseoutExecutionResultSchema.optional(),
	existingCloseoutGoalCompletionReconciliation: existingCloseoutGoalCompletionReconciliationSchema.optional(),
});
export type HistoricalRvfCloseoutRecord = z.infer<typeof historicalRvfCloseoutRecordSchema>;

export async function readHistoricalRvfCloseoutRecords(workspaceId: string) {
	const directory = resolve(getWorkspaceDirectoryPath(workspaceId));
	if (dirname(directory) !== resolve(getWorkspacesRootPath())) throw new Error("非法 workspaceId。");
	const path = join(directory, "rvf-automatic-rewind-and-closeout-records.json");
	let records: unknown;
	try {
		records = await readHistoricalRvfJsonArtifact(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], invalidRecordCount: 0 };
		throw error;
	}
	const parsed = z.array(z.unknown()).parse(records);
	const valid: HistoricalRvfCloseoutRecord[] = [];
	let invalidRecordCount = 0;
	for (const record of parsed) {
		const result = historicalRvfCloseoutRecordSchema.safeParse(record);
		if (result.success) valid.push(result.data);
		else invalidRecordCount++;
	}
	return { records: valid, invalidRecordCount };
}

export async function readHistoricalRvfJsonArtifact(path: string): Promise<unknown> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024)
		throw new Error(`历史工件不可安全读取：${path}`);
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export function resolveHistoricalRvfRunLogsRoot(): string {
	const configured = process.env.CODEX_RVF_LOG_ROOT?.trim() || process.env.CODEX_RVF_STATE_DIR?.trim();
	const root =
		configured ||
		join(process.env.RVF_USER_LOCAL_DATA_ROOT?.trim() || join(homedir(), ".rvf", "user-local-data"), "run-logs");
	return resolve(root === "~" ? homedir() : root.startsWith("~/") ? join(homedir(), root.slice(2)) : root);
}

export async function readHistoricalRvfRunEvidence(directories: string[]): Promise<unknown> {
	const runs = await Promise.all(
		directories.map(async (directory) => {
			let raw: Record<string, unknown> = {};
			try {
				raw = z
					.record(z.string(), z.unknown())
					.parse(await readHistoricalRvfJsonArtifact(join(directory, "summary.json")));
			} catch {
				/* 缺损保留未知，已接受记录由查询层独立展示。 */
			}
			const recorded = raw.status;
			const status =
				recorded === "failed" || recorded === "cancelled" || recorded === "advisory"
					? recorded
					: recorded === "running" || recorded === "in_progress"
						? "in_progress"
						: "unknown";
			const finalize = z.object({ decision_kind: z.string().optional() }).safeParse(raw.finalize);
			return {
				run_directory: directory,
				run_id: typeof raw.run_id === "string" ? raw.run_id : null,
				repository_path: typeof raw.repo === "string" ? raw.repo : null,
				review_completion_status: status,
				completion_evidence_source: "historical_run_summary",
				recorded_finalization_kind: finalize.success ? finalize.data.decision_kind : null,
				reason_code: status === "unknown" ? "historical_completion_evidence_unavailable" : "historical_run_status",
				recovery_condition: "已接受的完成记录或不可变历史证据可读后重新查询",
				historical_run_summary: raw,
			};
		}),
	);
	return { schema: "rvf-run-review-evidence/v1", runs };
}
