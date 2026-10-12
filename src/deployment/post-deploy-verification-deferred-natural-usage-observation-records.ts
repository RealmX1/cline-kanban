import { createHash } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
	type RuntimePostDeployVerificationDeferredNaturalUsageObservationRecord,
	type RuntimePostDeployVerificationDeferredNaturalUsageObservationRecordsFile,
	runtimePostDeployVerificationDeferredNaturalUsageObservationRecordsFileSchema,
} from "../core/api-contract";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

// ~/.cline/kanban/post-deploy-verification-deferred-natural-usage-observation-records.json：
// 以「触发时机随机 / 罕见，转为在自然使用中观察」结案的未勾项。独立于部署组文件——部署组只保留最近 20 个折叠组，
// 待观察记录要一直留到将来的「自然使用中程序化捕捉 + 多模态 agent 判定」pipeline 消费它为止。
// 本期只写入与只读列出（pipeline 设计见 docs/post-deploy-verification-natural-usage-observation-pipeline-design.md）。
const POST_DEPLOY_VERIFICATION_DEFERRED_NATURAL_USAGE_OBSERVATION_RECORDS_FILENAME =
	"post-deploy-verification-deferred-natural-usage-observation-records.json";

export function getPostDeployVerificationDeferredNaturalUsageObservationRecordsPath(): string {
	return join(getRuntimeHomePath(), POST_DEPLOY_VERIFICATION_DEFERRED_NATURAL_USAGE_OBSERVATION_RECORDS_FILENAME);
}

/** 同一次结案（workspace、task、结案时刻、核对项）重复写入得到同一个 id，写入因此幂等。 */
export function buildDeferredNaturalUsageObservationRecordId(input: {
	workspaceId: string;
	taskId: string;
	closedAtIso: string;
	sourceChecklistItemId: string;
}): string {
	return createHash("sha256")
		.update([input.workspaceId, input.taskId, input.closedAtIso, input.sourceChecklistItemId].join("\0"))
		.digest("hex")
		.slice(0, 32);
}

// 损坏不抛：隔离改名后按空集处理（与部署组状态文件同策略），下一次写入重建。
async function readDeferredNaturalUsageObservationRecordsFileCorruptionTolerant(
	corruptIsolationTimestamp: string,
): Promise<RuntimePostDeployVerificationDeferredNaturalUsageObservationRecordsFile> {
	const path = getPostDeployVerificationDeferredNaturalUsageObservationRecordsPath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { deferredNaturalUsageObservationRecords: [] };
		}
		throw error;
	}
	const parsed = (() => {
		try {
			return runtimePostDeployVerificationDeferredNaturalUsageObservationRecordsFileSchema.safeParse(
				JSON.parse(raw),
			);
		} catch {
			return null;
		}
	})();
	if (parsed?.success) {
		return parsed.data;
	}
	const isolatedPath = `${path}.corrupt-${corruptIsolationTimestamp}`;
	try {
		await rename(path, isolatedPath);
	} catch {
		// 隔离失败不阻塞：下一次写入会覆盖损坏内容。
	}
	logDeploymentDiagnosticWarning(
		`[post-deploy-verification-deferred-natural-usage-observation-records] 文件损坏，已隔离为 ${isolatedPath}，按空集处理`,
	);
	return { deferredNaturalUsageObservationRecords: [] };
}

/** 按 id upsert（已有则保留原记录不覆盖——同一次结案的重放不该改写首次写下的内容）。 */
export async function appendPostDeployVerificationDeferredNaturalUsageObservationRecords(
	records: readonly RuntimePostDeployVerificationDeferredNaturalUsageObservationRecord[],
	nowIso: string,
): Promise<void> {
	if (records.length === 0) {
		return;
	}
	await mkdir(getRuntimeHomePath(), { recursive: true });
	const path = getPostDeployVerificationDeferredNaturalUsageObservationRecordsPath();
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const file = await readDeferredNaturalUsageObservationRecordsFileCorruptionTolerant(nowIso);
		const existingRecordIds = new Set(
			file.deferredNaturalUsageObservationRecords.map((record) => record.deferredNaturalUsageObservationRecordId),
		);
		for (const record of records) {
			if (!existingRecordIds.has(record.deferredNaturalUsageObservationRecordId)) {
				file.deferredNaturalUsageObservationRecords.push(record);
				existingRecordIds.add(record.deferredNaturalUsageObservationRecordId);
			}
		}
		await lockedFileSystem.writeJsonFileAtomic(path, file, { lock: null });
	});
}

/** 纯只读（不加锁：写盘是原子 rename，不会读到半写内容）。 */
export async function listPostDeployVerificationDeferredNaturalUsageObservationRecords(
	filter: { workspaceId?: string },
	nowIso: string,
): Promise<RuntimePostDeployVerificationDeferredNaturalUsageObservationRecord[]> {
	const file = await readDeferredNaturalUsageObservationRecordsFileCorruptionTolerant(nowIso);
	return file.deferredNaturalUsageObservationRecords.filter(
		(record) => filter.workspaceId === undefined || record.workspaceId === filter.workspaceId,
	);
}
