import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

const observationSchema = z.object({
	eventId: z.string(),
	source: z.literal("explicit_task_session_stop_request"),
	workspaceId: z.string(),
	workspaceTaskId: z.string(),
	conversationSessionId: z.string(),
	sourceAgentId: z.string(),
	nativeSessionId: z.string(),
	observedAtEpochMs: z.number(),
});
const observationsSchema = z.array(observationSchema);

// 仅由显式 stop procedure 调用。普通 Stop hook、自然退出和闲置回收均不写取消证据。
export async function recordProgrammaticReviewExplicitUserStopObservations(input: {
	workspaceId: string;
	workspaceTaskId: string;
	summaries: readonly RuntimeTaskSessionSummary[];
}): Promise<void> {
	const path = join(
		getWorkspaceDirectoryPath(input.workspaceId),
		"programmatic-review-explicit-user-stop-observations.json",
	);
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const text = await readFile(path, "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "[]";
			throw error;
		});
		const previous = observationsSchema.parse(JSON.parse(text));
		const next = new Map(previous.map((entry) => [`${entry.sourceAgentId}:${entry.nativeSessionId}`, entry]));
		for (const summary of input.summaries) {
			const identity = summary.agentNativeConversationSessionIdentity;
			if (!identity) continue;
			next.set(`${identity.sourceAgentId}:${identity.nativeSessionId}`, {
				eventId: randomUUID(),
				source: "explicit_task_session_stop_request",
				workspaceId: input.workspaceId,
				workspaceTaskId: input.workspaceTaskId,
				conversationSessionId: summary.taskId,
				sourceAgentId: identity.sourceAgentId,
				nativeSessionId: identity.nativeSessionId,
				observedAtEpochMs: Date.now(),
			});
		}
		await lockedFileSystem.writeJsonFileAtomic(path, [...next.values()], { lock: null, durable: true });
	});
}
