import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { submitTaskLookupTurnRequestSchema } from "../../src/core/task-lookup-conversation-contract";
import { getRuntimeHomePath } from "../../src/state/runtime-home-path";
import {
	readRuntimeProcessInstanceLiveness,
	startRuntimeProcessInstanceHeartbeat,
} from "../../src/state/runtime-process-instance-heartbeat-registry";
import { createTaskLookupConversationService } from "../../src/task-indexing-support/task-lookup-conversation-service";

const heartbeat = await startRuntimeProcessInstanceHeartbeat();
const runtimeHome = getRuntimeHomePath();
const service = createTaskLookupConversationService({
	storageDirectoryPath: join(runtimeHome, "task-lookup-conversations"),
	runtimeProcessInstanceId: heartbeat.runtimeProcessInstanceId,
	readRuntimeOwnerLiveness: readRuntimeProcessInstanceLiveness,
	collectMaterials: async () => ({ materials: [], missingContextParts: [] }),
	getExecutorSettings: async () => ({ agentId: "codex", modelId: null }),
	getContext: async () => ({
		schemaVersion: 1,
		workspaceId: "isolated-project",
		levelOneBoardTaskIndexText: "",
		levelTwoProjectTaskRecapsText: "",
		levelThreeAppendedChangesText: "",
		snapshotFingerprint: "isolated",
		contextCompleteness: [],
		asOf: 1,
		rebuildReason: null,
	}),
	executeAgent: async (request) => {
		if (request.stage === "candidate_recall")
			process.send?.({
				event: "task_lookup_recall_model_execution_started",
				operationId: request.operationId,
			});
		for (;;) {
			request.abortSignal?.throwIfAborted();
			try {
				await access(join(runtimeHome, "allow-task-lookup-model-execution-to-complete"));
				break;
			} catch {
				await delay(10);
			}
		}
		return {
			value:
				JSON.parse(request.queryText).phase === "recall"
					? { candidateTaskReferences: [] }
					: { answerText: "隔离查询完成", candidates: [] },
			usage: { resolvedModelId: null },
			stablePromptPrefixSha256: "isolated",
			elapsedMs: 1,
			diagnosticWarnings: [],
		};
	},
});
service.start();
process.on("message", async (raw: { requestId: number; operation: string; input: unknown }) => {
	try {
		const value =
			raw.operation === "create"
				? await service.createConversation({
						contextWorkspaceId: "isolated-project",
						scope: { projectIds: [], columnIds: [] },
					})
				: raw.operation === "submit"
					? await service.submitTurn(submitTaskLookupTurnRequestSchema.parse(raw.input))
					: await service.getConversation(String(raw.input));
		process.send?.({ requestId: raw.requestId, value });
	} catch (error) {
		process.send?.({ requestId: raw.requestId, error: String(error) });
	}
});
process.on("disconnect", () => {
	void service.close().finally(() => heartbeat.stop());
});
process.send?.({ event: "ready", ownerId: heartbeat.runtimeProcessInstanceId });
