import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type RuntimeAutomaticAgentFailureContinuation,
	runtimeAutomaticAgentFailureContinuationSchema,
} from "../core/api-contract";
import { logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

export function getAutomaticAgentFailureContinuationDirectory(workspaceId: string) {
	return join(getWorkspaceDirectoryPath(workspaceId), "automatic-agent-failure-continuation-episodes");
}
export async function persistAutomaticAgentFailureContinuation(
	record: RuntimeAutomaticAgentFailureContinuation,
): Promise<void> {
	const name = createHash("sha256").update(record.conversationSessionId).digest("hex");
	const path = join(getAutomaticAgentFailureContinuationDirectory(record.workspaceId), `${name}.json`);
	await lockedFileSystem.writeJsonFileAtomic(path, runtimeAutomaticAgentFailureContinuationSchema.parse(record), {
		durable: true,
	});
}
export async function readAutomaticAgentFailureContinuations(
	workspaceId: string,
	onUnreadableRecord?: () => void,
): Promise<RuntimeAutomaticAgentFailureContinuation[]> {
	const directory = getAutomaticAgentFailureContinuationDirectory(workspaceId);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: RuntimeAutomaticAgentFailureContinuation[] = [];
	for (const name of names.filter((name) => name.endsWith(".json"))) {
		try {
			const parsed = runtimeAutomaticAgentFailureContinuationSchema.parse(
				JSON.parse(await readFile(join(directory, name), "utf8")),
			);
			if (parsed.workspaceId !== workspaceId) throw new Error("自动恢复记录的 workspace 身份不匹配。");
			records.push(parsed);
		} catch (error) {
			onUnreadableRecord?.();
			logTuiFreezeWarning(`自动恢复记录暂不可读，保留原文件并继续其它会话 file=${name} reason=${String(error)}`);
		}
	}
	return records;
}
